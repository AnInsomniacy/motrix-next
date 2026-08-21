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
  parseAria2Input,
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
import { isHlsUri } from '@shared/utils/hls'
import {
  sanitizeBrowserRequestHeaders,
  sanitizeBrowserRequestHeadersWithDiagnostics,
  sanitizeHttpHeaderOptions,
  sanitizeSingleHeaderValue,
} from '@shared/utils/headerSanitize'
import { summarizeHeaderForwarding } from '@shared/utils/externalInputDiagnostics'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { extractHlsErrorCode, hlsErrorI18nKey } from '@shared/utils/hls'
import { buildTaskProxyOptions, getDownloadProxy, type TaskProxyMode } from '@shared/utils/proxy'
import { resolveUserAgentFromContext } from '@shared/utils/userAgentPolicy'

export { getDownloadProxy } from '@shared/utils/proxy'

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

interface ManualRegularEntry {
  uris: string[]
  options: Aria2EngineOptions
  hasInputOptions: boolean
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

function mergeAria2InputOptions(base: Aria2EngineOptions, taskOptions: Aria2EngineOptions): Aria2EngineOptions {
  const merged: Aria2EngineOptions = { ...base }
  for (const [key, value] of Object.entries(taskOptions)) {
    if (value === undefined) continue
    if (key === 'header') {
      const currentHeaders = merged.header
      const nextHeaders = Array.isArray(value) ? value : [value]
      const baseHeaders = Array.isArray(currentHeaders)
        ? currentHeaders
        : typeof currentHeaders === 'string'
          ? [currentHeaders]
          : []
      merged.header = [...baseHeaders, ...nextHeaders]
    } else {
      merged[key] = value
    }
  }
  return merged
}

function getScalarOption(options: Aria2EngineOptions, key: string): string {
  const value = options[key]
  return typeof value === 'string' ? value : ''
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
 * HLS playlist URIs (.m3u8 / .m3u) are peeled out of every entry and submitted
 * via addHls so they never enter an aria2 URI array.
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
  const parsedInput = parseAria2Input(form.uris)
  const allUris = parsedInput.entries.flatMap((entry) => entry.uris)
  logger.info(
    'submitManualUris',
    formatLogFields({
      regular: allUris.filter((u) => !isMagnetUri(u) && !isHlsUri(u)).length,
      magnet: allUris.filter(isMagnetUri).length,
      hls: allUris.filter(isHlsUri).length,
      hasUserAgent: Boolean(form.userAgent),
      hasReferer: Boolean(form.referer),
      hasCookie: Boolean(form.cookie),
      ...summarizeSubmitHeaderForwarding(form),
    }),
  )

  const magnetUris = allUris.filter(isMagnetUri)
  const parsedRegularEntries: ManualRegularEntry[] = parsedInput.entries
    .map((entry) => ({
      uris: entry.uris.filter((uri) => !isMagnetUri(uri)),
      options: mergeAria2InputOptions(options, entry.options),
      hasInputOptions: Object.keys(entry.options).length > 0,
    }))
    .filter((entry) => entry.uris.length > 0)

  const hlsJobs: { uri: string; options: Aria2EngineOptions }[] = []
  const regularEntries: ManualRegularEntry[] = []
  for (const entry of parsedRegularEntries) {
    const otherUris: string[] = []
    for (const uri of entry.uris) {
      if (isHlsUri(uri)) hlsJobs.push({ uri, options: entry.options })
      else otherUris.push(uri)
    }
    if (otherUris.length > 0) {
      regularEntries.push({ ...entry, uris: otherUris })
    }
  }

  const regularUris = regularEntries.flatMap((entry) => entry.uris)
  const fileCategoryWithContexts = fileCategory
    ? { ...fileCategory, contexts: form.uriRequestContexts ?? {} }
    : undefined
  const submittedTaskNames: string[] = []

  for (const job of hlsJobs) {
    await taskStore.addHls({
      uri: job.uri,
      options: job.options,
      fileCategory: fileCategoryWithContexts,
    })
    submittedTaskNames.push(resolveSubmittedTaskName(job.uri, getScalarOption(job.options, 'out')))
  }

  // Submit regular URIs using the existing path
  if (regularUris.length > 0) {
    const canUseGlobalRename = regularEntries.every((entry) => entry.uris.length === 1 && !entry.hasInputOptions)
    if (canUseGlobalRename && regularUris.length > 1 && form.out) {
      const regularOptions = { ...options }
      delete regularOptions.out
      let outs = buildOuts(regularUris, form.out)
      if (outs.length === 0) {
        const dotIdx = form.out.lastIndexOf('.')
        const base = dotIdx > 0 ? form.out.substring(0, dotIdx) : form.out
        const ext = dotIdx > 0 ? form.out.substring(dotIdx) : ''
        outs = regularUris.map((_, i) => `${base}_${i + 1}${ext}`)
      }
      await taskStore.addUri({
        uris: regularUris,
        outs,
        options: regularOptions,
        fileCategory: fileCategoryWithContexts,
      })
      submittedTaskNames.push(...regularUris.map((uri, index) => resolveSubmittedTaskName(uri, outs[index])))
    } else {
      const contextEntries = form.uriRequestContexts ?? {}
      for (const entry of regularEntries) {
        if (entry.uris.length > 1) {
          await taskStore.addUriAtomic({
            uris: entry.uris,
            options: entry.options,
          })
          const out = getScalarOption(entry.options, 'out')
          submittedTaskNames.push(...entry.uris.map((uri) => resolveSubmittedTaskName(uri, out)))
          continue
        }

        const outs = await Promise.all(
          entry.uris.map(async (uri) => {
            const out = getScalarOption(entry.options, 'out')
            if (out) return out
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
              return ''
            }
          }),
        )

        const hasPerUriContext = entry.uris.some((uri) => contextEntries[uri])
        if (hasPerUriContext) {
          const uri = entry.uris[0]
          await taskStore.addUri({
            uris: [uri],
            outs: [outs[0] ?? ''],
            options: mergeAria2InputOptions(buildEngineOptions(form, contextEntries[uri]), entry.options),
            fileCategory: fileCategoryWithContexts,
          })
        } else {
          await taskStore.addUri({
            uris: entry.uris,
            outs,
            options: entry.options,
            fileCategory: fileCategoryWithContexts,
          })
        }
        const out = getScalarOption(entry.options, 'out')
        submittedTaskNames.push(...entry.uris.map((uri, index) => resolveSubmittedTaskName(uri, out || outs[index])))
      }
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
    labels: { Aria2: t('task.error-aria2-next'), Hls: t('task.task-hls-info') },
  }
}

function formatSubmitError(err: unknown, t: (key: string) => string): string {
  const mappedKey = extractHlsErrorCode(err)
  const i18nKey = mappedKey ? hlsErrorI18nKey(mappedKey) : undefined
  return i18nKey ? t(i18nKey) : getErrorMessage(err, buildSubmitErrorLabels(t))
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
      const errMsg = formatSubmitError(e, t)
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
