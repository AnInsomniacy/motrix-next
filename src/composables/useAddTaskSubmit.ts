/**
 * @fileoverview Composable encapsulating AddTask submission logic.
 *
 * Extracted from AddTask.vue to make the complex branching testable:
 * - Options building (headers, proxy, user-agent, etc.)
 * - Batch submission routing for torrent files
 * - Manual URI submission with multi-URI rename
 * - Error classification (engine-not-ready, duplicate, generic)
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import { handleTaskStart } from '@/composables/useTaskNotifyHandlers'
import { isEngineReady } from '@/api/aria2'
import {
  normalizeUriLines,
  extractDecodedFilename,
  extractMagnetDisplayName,
  hasExtension,
  sanitizeAria2OutHint,
} from '@shared/utils/batchHelpers'
import { buildOuts } from '@shared/utils/rename'
import { invoke } from '@tauri-apps/api/core'
import { formatLogFields, logger } from '@shared/logger'
import type {
  Aria2EngineOptions,
  BatchItem,
  BrowserRequestHeader,
  ExternalDownloadContext,
  FileCategory,
  ProxyConfig,
} from '@shared/types'
import { isMagnetUri } from '@/composables/useMagnetFlow'
import {
  sanitizeBrowserRequestHeaders,
  sanitizeBrowserRequestHeadersWithDiagnostics,
  sanitizeHttpHeaderOptions,
  sanitizeSingleHeaderValue,
} from '@shared/utils/headerSanitize'
import { summarizeHeaderForwarding } from '@shared/utils/externalInputDiagnostics'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { buildTaskProxyOptions, getDownloadProxy, type TaskProxyMode } from '@shared/utils/proxyPolicy'
import { resolveUserAgentFromContext } from '@shared/utils/userAgentPolicy'

export { getDownloadProxy } from '@shared/utils/proxyPolicy'

export interface AddTaskForm {
  uris: string
  out: string
  dir: string
  split: number
  userAgent: string
  authorization: string
  httpAuthUsername: string
  httpAuthPassword: string
  saveHttpAuth: boolean
  referer: string
  cookie: string
  /** Proxy mode for this task. */
  proxyMode: TaskProxyMode
  /** User-entered proxy address when proxyMode is 'manual'. */
  customProxy: string
  customProxyUsername?: string
  customProxyPassword?: string
  /** Injected from the preference store; used for manual proxy bypass inheritance. */
  appProxy?: ProxyConfig
  defaultUserAgent?: string
  userAgentProfiles?: import('@shared/types').UserAgentProfile[]
  userAgentRules?: import('@shared/types').UserAgentRule[]
  requestHeaders: BrowserRequestHeader[]
  uriRequestContexts?: Record<string, ExternalDownloadContext>
  /** When true, multiple URIs are treated as mirrors for one download. */
  multiSource: boolean
}

export interface UseAddTaskSubmitOptions {
  form: Ref<AddTaskForm>
  onClose: () => void
}

export interface MagnetSubmitFailure {
  uri: string
  error: string
}

export interface ManualUriSubmitResult {
  submittedTaskNames: string[]
  magnetGids: string[]
  magnetFailures: MagnetSubmitFailure[]
}

/**
 * Builds aria2 engine options from the add-task form.
 * Pure function — no side effects, fully testable.
 */
export function buildEngineOptions(form: AddTaskForm, context?: ExternalDownloadContext): Aria2EngineOptions {
  const resolvedUserAgent = resolveUserAgentFromContext({
    formUserAgent: form.userAgent,
    context,
    url: context?.url ?? form.uris,
    finalUrl: context?.finalUrl,
    defaultUserAgent: form.defaultUserAgent,
    profiles: form.userAgentProfiles ?? [],
    rules: form.userAgentRules ?? [],
  }).userAgent
  const headers = {
    userAgent: sanitizeSingleHeaderValue(resolvedUserAgent),
    referer: sanitizeSingleHeaderValue(context?.referer ?? form.referer),
    cookie: sanitizeSingleHeaderValue(context?.cookie ?? form.cookie),
    authorization: sanitizeSingleHeaderValue(form.authorization),
  }
  const options: Aria2EngineOptions = {
    dir: form.dir,
    split: String(form.split),
    // max-connection-per-server is intentionally NOT set per-task.
    // It uses the global value pushed by on_engine_ready() (Rust), allowing
    // split (segment count) and max-conn (server connection cap) to be
    // controlled independently. See: aria2 download_helper.cc:394-401.
  }
  if (form.out) options.out = form.out
  if (headers.userAgent) options['user-agent'] = headers.userAgent
  if (headers.referer) options.referer = headers.referer

  const browserHeaders = sanitizeBrowserRequestHeaders(context?.requestHeaders ?? form.requestHeaders)
  const headerLines: string[] = browserHeaders.map((header) => `${header.name}: ${header.value}`)
  if (headers.cookie) headerLines.push(`Cookie: ${headers.cookie}`)
  if (headers.authorization) headerLines.push(`Authorization: ${headers.authorization}`)
  if (headerLines.length > 0) options.header = headerLines

  const httpAuthUsername = sanitizeHttpHeaderOptions({ authorization: form.httpAuthUsername }).authorization ?? ''
  const httpAuthPassword = sanitizeHttpHeaderOptions({ authorization: form.httpAuthPassword }).authorization ?? ''
  if (httpAuthUsername) {
    options['http-user'] = httpAuthUsername
    options['http-passwd'] = httpAuthPassword
  }

  Object.assign(
    options,
    buildTaskProxyOptions(
      form.proxyMode,
      form.customProxy,
      form.appProxy,
      form.customProxyUsername,
      form.customProxyPassword,
    ),
  )
  return options
}

function summarizeSubmitHeaderForwarding(form: AddTaskForm, context?: ExternalDownloadContext) {
  return summarizeHeaderForwarding(
    sanitizeBrowserRequestHeadersWithDiagnostics(context?.requestHeaders ?? form.requestHeaders).diagnostics,
  )
}

/**
 * Classifies an error from task submission into a user-friendly category.
 * Pure function — fully testable.
 */
export function classifySubmitError(err: unknown): 'engine-not-ready' | 'duplicate' | 'generic' {
  const msg = getErrorMessage(err)
  if (msg.includes('not initialized') || !isEngineReady()) return 'engine-not-ready'
  if (/duplicate|already/i.test(msg)) return 'duplicate'
  return 'generic'
}

/**
 * Submits file-based torrent batch items to the engine.
 * Mutates item.status in place; returns count of failures.
 */
export async function submitBatchItems(
  items: BatchItem[],
  options: Aria2EngineOptions,
  taskStore: ReturnType<typeof useTaskStore>,
): Promise<number> {
  let failures = 0
  for (const item of items) {
    if (item.kind === 'uri') continue
    if (item.status !== 'pending' && item.status !== 'failed') continue
    try {
      if (item.kind === 'torrent') {
        const opts: Aria2EngineOptions = { ...options }
        delete opts.out
        if (
          item.selectedFileIndices &&
          item.torrentMeta &&
          item.selectedFileIndices.length > 0 &&
          item.selectedFileIndices.length < item.torrentMeta.files.length
        ) {
          opts['select-file'] = item.selectedFileIndices.join(',')
        }
        // Register source path by infoHash BEFORE addTorrent to avoid race:
        // fast downloads enter seeding before addTorrent promise resolves.
        if (item.source && item.torrentMeta?.infoHash) {
          taskStore.registerTorrentSource(item.torrentMeta.infoHash, item.source)
        }
        await taskStore.addTorrent({ torrent: item.payload, options: opts })
      }
      item.status = 'submitted'
      logger.info('submitBatchItems', `${item.kind} submitted: ${item.displayName}`)
    } catch (e) {
      item.status = 'failed'
      item.error = getErrorMessage(e)
      logger.error('submitBatchItems', e)
      failures++
    }
  }
  return failures
}

/**
 * Submits manually entered URIs from the textarea.
 * Handles multi-URI rename with buildOuts.
 *
 * Magnet URIs are separated and submitted via addMagnetUri (metadata-only mode).
 * Returns an array of magnet GIDs for the caller to monitor for file selection.
 */
export async function submitManualUris(
  form: AddTaskForm,
  options: Aria2EngineOptions,
  taskStore: ReturnType<typeof useTaskStore>,
  fileCategory?: { enabled: boolean; categories: FileCategory[] },
  downloadProxy?: string,
): Promise<ManualUriSubmitResult> {
  if (!form.uris.trim()) return { submittedTaskNames: [], magnetGids: [], magnetFailures: [] }
  const allUris = normalizeUriLines(form.uris)
  logger.info(
    'submitManualUris',
    formatLogFields({
      regular: allUris.filter((u) => !isMagnetUri(u)).length,
      magnet: allUris.filter(isMagnetUri).length,
      hasUserAgent: Boolean(form.userAgent),
      hasReferer: Boolean(form.referer),
      hasCookie: Boolean(form.cookie),
      ...summarizeSubmitHeaderForwarding(form),
    }),
  )

  const magnetUris = allUris.filter(isMagnetUri)
  const regularUris = allUris.filter((uri) => !isMagnetUri(uri))
  const submittedTaskNames: string[] = []

  // Submit regular URIs using the existing path
  if (regularUris.length > 0) {
    if (form.multiSource && regularUris.length > 1) {
      // Multi-source: all URIs serve as mirrors for a single file download
      const optionsForAtomic = { ...options }
      await taskStore.addUriAtomic({ uris: regularUris, options: optionsForAtomic })
      submittedTaskNames.push(resolveSubmittedTaskName(regularUris[0], options.out as string))
    } else if (regularUris.length > 1 && form.out) {
      const regularOptions = { ...options }
      delete regularOptions.out
      let outs = buildOuts(regularUris, form.out)
      if (outs.length === 0) {
        const dotIdx = form.out.lastIndexOf('.')
        const base = dotIdx > 0 ? form.out.substring(0, dotIdx) : form.out
        const ext = dotIdx > 0 ? form.out.substring(dotIdx) : ''
        outs = regularUris.map((_, i) => `${base}_${i + 1}${ext}`)
      }
      await taskStore.addUri({ uris: regularUris, outs, options: regularOptions, fileCategory })
      submittedTaskNames.push(...regularUris.map((uri, index) => resolveSubmittedTaskName(uri, outs[index])))
    } else {
      // aria2's native filename resolution only uses Content-Disposition
      // and URL path.  CDNs like Twitter/X serve media from extensionless
      // paths (e.g. /media/HCo_0zsbkAEov7s?format=jpg).  For each URL
      // whose path lacks an extension, invoke the Rust-side HEAD request
      // to infer the correct name via Content-Type MIME mapping.
      const outs = await Promise.all(
        regularUris.map(async (uri) => {
          // Extension already provided a filename via options.out — skip HEAD.
          // Without this guard, resolve_filename returns a name derived from
          // the CDN's Content-Type (e.g. .xml), and aria2.ts addUri() L108
          // overwrites options.out with the outs[] entry.
          if (options.out) return ''
          const pathFilename = extractDecodedFilename(uri)
          if (!pathFilename || hasExtension(pathFilename)) return ''
          try {
            const uriContext = form.uriRequestContexts?.[uri]
            const sanitizedHeaders = sanitizeHttpHeaderOptions({
              referer: uriContext?.referer ?? form.referer,
              cookie: uriContext?.cookie ?? form.cookie,
            })
            const args: {
              url: string
              proxy: string | null
              referer?: string
              cookie?: string
            } = {
              url: uri,
              proxy: downloadProxy ?? null,
            }
            if (sanitizedHeaders.referer) args.referer = sanitizedHeaders.referer
            if (sanitizedHeaders.cookie) args.cookie = sanitizedHeaders.cookie
            return (await invoke<string | null>('resolve_filename', args)) ?? ''
          } catch {
            return '' // HEAD failure → graceful degradation
          }
        }),
      )
      const contextEntries = form.uriRequestContexts ?? {}
      const hasPerUriContext = regularUris.some((uri) => contextEntries[uri])
      if (hasPerUriContext) {
        for (let index = 0; index < regularUris.length; index++) {
          const uri = regularUris[index]
          await taskStore.addUri({
            uris: [uri],
            outs: [outs[index] ?? ''],
            options: buildEngineOptions(form, contextEntries[uri]),
            fileCategory,
          })
        }
      } else {
        await taskStore.addUri({ uris: regularUris, outs, options, fileCategory })
      }
      const optionOut = typeof options.out === 'string' ? options.out : ''
      submittedTaskNames.push(
        ...regularUris.map((uri, index) => resolveSubmittedTaskName(uri, optionOut || outs[index])),
      )
    }
  }

  // Submit magnet URIs (normal mode — global pause-metadata controls pausing)
  const result: ManualUriSubmitResult = {
    submittedTaskNames,
    magnetGids: [],
    magnetFailures: [],
  }
  for (const uri of magnetUris) {
    try {
      const gid = await taskStore.addMagnetUri({ uri, options })
      result.magnetGids.push(gid)
    } catch (e) {
      logger.error('submitManualUris.magnet', e)
      result.magnetFailures.push({
        uri,
        error: getErrorMessage(e),
      })
    }
  }

  return result
}

function resolveSubmittedTaskName(uri: string, outHint?: string): string {
  const out = outHint ? sanitizeAria2OutHint(outHint) : ''
  return out || extractDecodedFilename(uri) || uri
}

function buildSubmitErrorLabels(t: (key: string) => string): Parameters<typeof getErrorMessage>[1] {
  return {
    fallback: t('task.error-unknown'),
    labels: { Aria2: t('task.error-aria2-next') },
  }
}

export function useAddTaskSubmit({ form, onClose }: UseAddTaskSubmitOptions) {
  const { t } = useI18n()
  const router = useRouter()
  const appStore = useAppStore()
  const taskStore = useTaskStore()
  const preferenceStore = usePreferenceStore()
  const message = useAppMessage()
  const submitting = ref(false)

  async function handleSubmit() {
    if (submitting.value) return
    submitting.value = true

    try {
      const options = buildEngineOptions(form.value)
      const batch = appStore.pendingBatch
      let manualResult: ManualUriSubmitResult = { submittedTaskNames: [], magnetGids: [], magnetFailures: [] }

      if (batch.length > 0) {
        await submitBatchItems(batch, options, taskStore)
      }
      if (form.value.uris.trim()) {
        manualResult = await submitManualUris(
          form.value,
          options,
          taskStore,
          {
            enabled: preferenceStore.config.fileCategoryEnabled,
            categories: preferenceStore.config.fileCategories,
          },
          getDownloadProxy(preferenceStore.config.proxy),
        )
        // pendingMagnetGids is set directly inside addMagnetUri (task store)
      }

      const failedCount = batch.filter((i) => i.status === 'failed').length + manualResult.magnetFailures.length
      logger.info(
        'AddTask.submit',
        `batch=${batch.length} manual=${normalizeUriLines(form.value.uris).length} failed=${failedCount}`,
      )
      if (failedCount > 0) {
        message.warning(`${failedCount} ${t('task.failed') || 'failed'}`, { closable: true })
      } else {
        onClose()

        // ── Start notification (aggregated) ──────────────────────
        const taskNames: string[] = []
        for (const item of batch) {
          if (item.status === 'submitted') {
            taskNames.push(item.displayName)
          }
        }
        taskNames.push(...manualResult.submittedTaskNames)
        const allUris = normalizeUriLines(form.value.uris)
        const magnetUris = allUris.filter(isMagnetUri)
        for (let i = 0; i < manualResult.magnetGids.length; i++) {
          const dn = magnetUris[i] ? extractMagnetDisplayName(magnetUris[i]) : ''
          taskNames.push(dn || t('task.magnet-task'))
        }
        handleTaskStart(taskNames, {
          messageInfo: message.info,
          t,
        })

        if (preferenceStore.config.newTaskShowDownloading !== false) {
          router.push({ path: '/task/all' }).catch(() => {})
        }
      }
    } catch (e: unknown) {
      const category = classifySubmitError(e)
      const errMsg = getErrorMessage(e, buildSubmitErrorLabels(t))
      logger.error('AddTask.submit', e)
      if (category === 'engine-not-ready') {
        message.error(t('app.engine-not-ready'), { closable: true })
      } else if (category === 'duplicate') {
        message.warning(errMsg, { closable: true })
      } else {
        message.error(errMsg, { closable: true })
      }
    } finally {
      submitting.value = false
    }
  }

  return { submitting, handleSubmit }
}
