/**
 * @fileoverview Composable encapsulating AddTask submission logic.
 *
 * Extracted from AddTask.vue to make the complex branching testable:
 * - Options building (headers, proxy, user-agent, etc.)
 * - Batch submission routing for torrent files
 * - Manual URI submission with multi-URI rename
 * - Error classification (engine-not-ready, duplicate, generic)
 */
import type { useTaskStore } from '@/stores/task'
import { isEngineReady } from '@/api/aria2'
import { parseAria2Input, extractDecodedFilename, hasExtension, sanitizeAria2OutHint } from '@shared/utils/batchHelpers'
import { buildOuts } from '@shared/utils/rename'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'
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
import { buildTaskProxyOptions, type TaskProxyMode } from '@shared/utils/proxy'
import { resolveUserAgentFromContext } from '@shared/utils/userAgentPolicy'
import { resolveDownloadDir, resolveFileSetCategory } from '@shared/utils/fileCategory'

export { getDownloadProxy } from '@shared/utils/proxy'

export interface AddTaskForm {
  uris: string
  out: string
  dir: string
  streamMaxConnections: number
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
  inputOptions: Aria2EngineOptions
  hasInputOptions: boolean
}

export interface FileCategoryPolicy {
  enabled: boolean
  categories: FileCategory[]
}

function buildTorrentTaskOptions(
  item: BatchItem,
  options: Aria2EngineOptions,
  fileCategory?: FileCategoryPolicy,
): Aria2EngineOptions {
  const selectedIndices = new Set(item.selectedFileIndices ?? [])
  const selectedFiles = (item.torrentMeta?.files ?? [])
    .filter((file) => selectedIndices.has(Number(file.index)) && Number(file.length) > 0)
    .map((file) => ({ path: file.path }))
  const category = fileCategory?.enabled
    ? resolveFileSetCategory(selectedFiles, fileCategory.categories, { urls: [item.source] })
    : undefined

  return {
    dir: category?.directory ?? options.dir,
    'select-file': [...selectedIndices].sort((a, b) => a - b).join(','),
  }
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
    'stream-max-connections': String(form.streamMaxConnections),
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
  fileCategory?: FileCategoryPolicy,
): Promise<number> {
  let failures = 0
  for (const item of items) {
    if (item.kind === 'uri') continue
    if (item.status !== 'pending' && item.status !== 'failed') continue
    if (item.inspectionState !== 'ready' || !item.selectedFileIndices?.length) {
      failures++
      continue
    }
    try {
      if (item.kind === 'torrent') {
        const opts = buildTorrentTaskOptions(item, options, fileCategory)
        const gid = await taskStore.addTorrent({ torrent: item.payload, options: opts })
        taskStore.registerTorrentSource(gid, item.source)
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
 * Magnet URIs are separated and submitted through the captured file-selection policy.
 * Returns an array of magnet GIDs for the caller to monitor for file selection.
 */
export async function submitManualUris(
  form: AddTaskForm,
  taskStore: ReturnType<typeof useTaskStore>,
  fileCategory?: FileCategoryPolicy,
  downloadProxy?: string,
): Promise<ManualUriSubmitResult> {
  if (!form.uris.trim()) return { submittedTaskNames: [], magnetGids: [], magnetFailures: [] }
  const parsedInput = parseAria2Input(form.uris)
  const allUris = parsedInput.entries.flatMap((entry) => entry.uris)
  logger.info('submitManualUris', 'manual_uris_submitted', {
    regular: allUris.filter((u) => !isMagnetUri(u)).length,
    magnet: allUris.filter(isMagnetUri).length,
    has_user_agent: Boolean(form.userAgent),
    has_referer: Boolean(form.referer),
    has_cookie: Boolean(form.cookie),
    ...summarizeSubmitHeaderForwarding(form),
  })

  const baseOptions = buildEngineOptions(form)
  const magnetUris = allUris.filter(isMagnetUri)
  const regularEntries: ManualRegularEntry[] = parsedInput.entries
    .map((entry) => ({
      uris: entry.uris.filter((uri) => !isMagnetUri(uri)),
      inputOptions: entry.options,
      hasInputOptions: Object.keys(entry.options).length > 0,
    }))
    .filter((entry) => entry.uris.length > 0)
  const regularUris = regularEntries.flatMap((entry) => entry.uris)
  const fileCategoryWithContexts = fileCategory
    ? { ...fileCategory, contexts: form.uriRequestContexts ?? {} }
    : undefined
  const submittedTaskNames: string[] = []

  // Submit every regular entry through one context-aware option path.
  if (regularUris.length > 0) {
    const canUseGlobalRename = regularEntries.every((entry) => entry.uris.length === 1 && !entry.hasInputOptions)
    let globalOuts = canUseGlobalRename && regularUris.length > 1 && form.out ? buildOuts(regularUris, form.out) : []
    if (canUseGlobalRename && regularUris.length > 1 && form.out && globalOuts.length === 0) {
      const dotIdx = form.out.lastIndexOf('.')
      const base = dotIdx > 0 ? form.out.substring(0, dotIdx) : form.out
      const ext = dotIdx > 0 ? form.out.substring(dotIdx) : ''
      globalOuts = regularUris.map((_, index) => `${base}_${index + 1}${ext}`)
    }

    const contextEntries = form.uriRequestContexts ?? {}
    let globalOutIndex = 0
    for (const entry of regularEntries) {
      const uriContext = entry.uris.length === 1 ? contextEntries[entry.uris[0]] : undefined
      const entryOptions = mergeAria2InputOptions(
        uriContext ? buildEngineOptions(form, uriContext) : baseOptions,
        entry.inputOptions,
      )
      if (globalOuts.length > 0) delete entryOptions.out

      if (entry.uris.length > 1) {
        const atomicOptions = { ...entryOptions }
        if (fileCategory?.enabled) {
          const candidate = getScalarOption(atomicOptions, 'out') || extractDecodedFilename(entry.uris[0])
          atomicOptions.dir = resolveDownloadDir(
            candidate || entry.uris[0],
            getScalarOption(atomicOptions, 'dir'),
            true,
            fileCategory.categories,
            { urls: entry.uris },
          )
        }
        await taskStore.addUriAtomic({
          uris: entry.uris,
          options: atomicOptions,
        })
        const out = getScalarOption(atomicOptions, 'out')
        submittedTaskNames.push(...entry.uris.map((uri) => resolveSubmittedTaskName(uri, out)))
        continue
      }

      const outs = await Promise.all(
        entry.uris.map(async (uri) => {
          const globalOut = globalOuts[globalOutIndex++]
          if (globalOut) return globalOut
          const out = getScalarOption(entryOptions, 'out')
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

      await taskStore.addUri({
        uris: entry.uris,
        outs,
        options: entryOptions,
        fileCategory: fileCategoryWithContexts,
      })
      const out = getScalarOption(entryOptions, 'out')
      submittedTaskNames.push(...entry.uris.map((uri, index) => resolveSubmittedTaskName(uri, out || outs[index])))
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
      const gid = await taskStore.addMagnetUri({ uri, options: baseOptions, fileCategory })
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
