/**
 * @fileoverview Pinia store for global application state: engine, tasks, stats, and polling.
 *
 * Global stat (speed / task counts) follows a Backend-as-Source-of-Truth architecture:
 *   Rust stat_service  ──500ms──▶  aria2 getGlobalStat
 *                      ├──▶  tray / dock / progress (direct native API)
 *                      └──▶  emit("stat:update")  ──▶  this store
 *
 * The frontend does NOT poll aria2 for global stats — it passively listens
 * to the Rust event stream. This eliminates double RPC and redundant IPC.
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { formatLogFields, logger } from '@shared/logger'
import { STAT_BASE_INTERVAL, STAT_PER_TASK_INTERVAL, STAT_MIN_INTERVAL, STAT_MAX_INTERVAL } from '@shared/timing'
import {
  detectExternalInputKind,
  detectKind,
  createBatchItem,
  resolveExternalFilenameHint,
} from '@shared/utils/batchHelpers'
import { summarizeExternalInput } from '@shared/utils/externalInputDiagnostics'
import { parseMotrixDeepLink } from '@shared/utils/motrixDeepLink'
import { buildEngineOptions, submitBatchItems, submitManualUris } from '@/composables/useAddTaskSubmit'
import { getDownloadProxy } from '@/composables/useAddTaskSubmit'
import { resolveUnresolvedItems } from '@/composables/useAddTaskFileOps'
import { usePreferenceStore } from '@/stores/preference'
import { useTaskStore } from '@/stores/task'
import type {
  Aria2RawGlobalStat,
  Aria2EngineOptions,
  BrowserRequestHeader,
  ExternalDownloadContext,
  ExternalDownloadInput,
  TauriUpdate,
  AppConfig,
  BatchItem,
} from '@shared/types'
import type { AddTaskForm } from '@/composables/useAddTaskSubmit'
import { getDefaultTaskProxyMode } from '@shared/utils/proxyPolicy'

/** Payload shape emitted by Rust stat_service via `stat:update`. */
interface StatPayload {
  downloadSpeed: number
  uploadSpeed: number
  numActive: number
  numWaiting: number
  numStopped: number
  numStoppedTotal: number
}

export interface DeepLinkHandlingResult {
  received: number
  queued: number
  autoSubmitted: number
  ignored: number
}

function normalizeFileUriPath(url: string): string {
  const decodedPath = decodeURIComponent(url.replace(/^file:\/\//i, ''))
  return /^\/[A-Za-z]:[\\/]/.test(decodedPath) ? decodedPath.slice(1) : decodedPath
}

export const useAppStore = defineStore('app', () => {
  const systemTheme = ref('light')
  const trayFocused = ref(false)
  const aboutPanelVisible = ref(false)
  const engineInfo = ref<{ version: string; enabledFeatures: string[] }>({
    version: '',
    enabledFeatures: [],
  })
  const engineOptions = ref<Partial<AppConfig>>({})
  const interval = ref(STAT_BASE_INTERVAL)
  const stat = ref({
    downloadSpeed: 0,
    uploadSpeed: 0,
    numActive: 0,
    numWaiting: 0,
    numStopped: 0,
  })
  const addTaskVisible = ref(false)
  const pendingBatch = ref<BatchItem[]>([])
  const addTaskOptions = ref<Aria2EngineOptions>({})
  /** Referer from the most recent deep-link, pre-filled into AddTask form. */
  const pendingReferer = ref('')
  /** Cookie from the most recent deep-link, forwarded to aria2 as a Cookie header. */
  const pendingCookie = ref('')
  /** Output filename from extension's Content-Disposition extraction. */
  const pendingFilename = ref('')
  /** User-Agent captured by the browser extension for the most recent external input. */
  const pendingUserAgent = ref('')
  /** Browser request headers captured by the extension for the most recent external input. */
  const pendingRequestHeaders = ref<BrowserRequestHeader[]>([])
  const progress = ref(0)
  const pendingUpdate = ref<TauriUpdate | null>(null)
  const engineRestarting = ref(true)
  let engineRestartingSince = Date.now()
  const MIN_BANNER_MS = 1000

  /** Set engine restarting state with minimum display time to prevent flicker. */
  function setEngineRestarting(value: boolean) {
    if (value) {
      engineRestarting.value = true
      engineRestartingSince = Date.now()
    } else {
      const elapsed = Date.now() - engineRestartingSince
      const remaining = MIN_BANNER_MS - elapsed
      if (remaining > 0) {
        setTimeout(() => {
          engineRestarting.value = false
        }, remaining)
      } else {
        engineRestarting.value = false
      }
    }
  }
  const engineReady = ref(false)
  const pendingMagnetGids = ref<string[]>([])
  const externalInputSubmitting = ref(false)
  let externalInputSubmitCount = 0
  let externalInputErrorHandler: ((error: unknown) => void) | null = null
  let externalInputStartHandler: ((taskNames: string[]) => void) | null = null

  function clearPendingExternalMetadata() {
    pendingReferer.value = ''
    pendingCookie.value = ''
    pendingFilename.value = ''
    pendingUserAgent.value = ''
    pendingRequestHeaders.value = []
  }

  function setPendingExternalMetadata(context: ExternalDownloadContext, filenameHint: string) {
    pendingReferer.value = context.referer ?? ''
    pendingCookie.value = context.cookie ?? ''
    pendingUserAgent.value = context.userAgent ?? ''
    pendingRequestHeaders.value = context.requestHeaders ?? []
    pendingFilename.value = filenameHint
  }

  function setExternalInputErrorHandler(handler: ((error: unknown) => void) | null) {
    externalInputErrorHandler = handler
  }

  function setExternalInputStartHandler(handler: ((taskNames: string[]) => void) | null) {
    externalInputStartHandler = handler
  }

  function updateInterval(millisecond: number) {
    let val = millisecond
    if (val > STAT_MAX_INTERVAL) val = STAT_MAX_INTERVAL
    if (val < STAT_MIN_INTERVAL) val = STAT_MIN_INTERVAL
    if (interval.value === val) return
    interval.value = val
  }

  function increaseInterval(millisecond = 100) {
    if (interval.value < STAT_MAX_INTERVAL) interval.value += millisecond
  }

  function decreaseInterval(millisecond = 100) {
    if (interval.value > STAT_MIN_INTERVAL) interval.value -= millisecond
  }

  function resetInterval() {
    interval.value = STAT_BASE_INTERVAL
  }

  /**
   * Unified entry point for all external inputs.
   * Accepts pre-built BatchItems (already resolved) and appends them to
   * the pending batch, then opens the add-task dialog.
   * @returns Number of duplicate items skipped.
   */
  function enqueueBatch(items: BatchItem[]): number {
    if (items.length === 0) return 0
    // Deduplicate against existing batch AND within incoming items
    const seen = new Set(pendingBatch.value.map((i) => i.source))
    const unique: BatchItem[] = []
    for (const item of items) {
      if (!seen.has(item.source)) {
        seen.add(item.source)
        unique.push(item)
      }
    }
    const skipped = items.length - unique.length
    if (unique.length > 0) {
      pendingBatch.value = [...pendingBatch.value, ...unique]
    }
    addTaskVisible.value = true
    return skipped
  }

  /** Opens an empty add-task dialog for manual URI entry. */
  function showAddTaskDialog() {
    clearPendingExternalMetadata()
    addTaskVisible.value = true
  }

  function hideAddTaskDialog() {
    addTaskVisible.value = false
    pendingBatch.value = []
    clearPendingExternalMetadata()
  }

  function updateAddTaskOptions(options: Aria2EngineOptions = {}) {
    addTaskOptions.value = { ...options }
  }

  /**
   * One-shot initializer — called once when the engine becomes ready.
   * Pulls initial stat values so the UI has data before the first Rust
   * event arrives. Does NOT set tray/dock/progress — Rust handles those.
   */
  async function fetchGlobalStat(api: { getGlobalStat: () => Promise<Aria2RawGlobalStat> }) {
    try {
      const data = await api.getGlobalStat()
      const parsed: Record<string, number> = {}
      Object.keys(data).forEach((key) => {
        parsed[key] = Number(data[key])
      })

      const { numActive } = parsed
      if (numActive > 0) {
        updateInterval(STAT_BASE_INTERVAL - STAT_PER_TASK_INTERVAL * numActive)
      } else {
        parsed.downloadSpeed = 0
        increaseInterval()
      }
      stat.value = parsed as typeof stat.value
    } catch (e) {
      logger.warn('AppStore.fetchGlobalStat', (e as Error).message)
    }
  }

  /**
   * Processes a single stat:update event payload from the Rust backend.
   * Updates reactive stat values AND the adaptive polling interval that
   * TaskView and lifecycleService depend on.
   */
  function handleStatEvent(payload: StatPayload) {
    const { numActive } = payload
    stat.value = {
      downloadSpeed: numActive > 0 ? payload.downloadSpeed : 0,
      uploadSpeed: payload.uploadSpeed,
      numActive,
      numWaiting: payload.numWaiting,
      numStopped: payload.numStopped,
    }
    if (numActive > 0) {
      updateInterval(STAT_BASE_INTERVAL - STAT_PER_TASK_INTERVAL * numActive)
    } else {
      increaseInterval()
    }
  }

  /**
   * Subscribes to the Rust stat_service's `stat:update` event stream.
   * Returns an unlisten function for cleanup.
   */
  function setupStatListener(): Promise<() => void> {
    return listen<StatPayload>('stat:update', (event) => {
      handleStatEvent(event.payload)
    })
  }

  async function fetchEngineInfo(api: { getVersion: () => Promise<{ version: string; enabledFeatures: string[] }> }) {
    const data = await api.getVersion()
    engineInfo.value = { ...engineInfo.value, ...data }
  }

  async function fetchEngineOptions(api: { getGlobalOption: () => Promise<Record<string, string>> }) {
    const data = await api.getGlobalOption()
    engineOptions.value = { ...engineOptions.value, ...data }
    return data
  }

  /**
   * Normalizes deep-link / argv URLs into BatchItems and enqueues them.
   * All items land in the same batch for user review before submission.
   */
  function handleDeepLinkUrls(urls: string[]): DeepLinkHandlingResult {
    const result: DeepLinkHandlingResult = {
      received: urls?.length ?? 0,
      queued: 0,
      autoSubmitted: 0,
      ignored: 0,
    }
    if (!urls || urls.length === 0) return result

    const items: BatchItem[] = []
    const FILE_EXTS = ['.torrent']

    for (const url of urls) {
      const lower = url.toLowerCase()
      const motrixDeepLink = parseMotrixDeepLink(url)

      // ── motrixnext:// — extension-to-app communication protocol ───
      // Bare `motrixnext://` is a wake-up signal (window focus handled
      // by the deep-link-open listener in useAppEvents).
      // `motrixnext://new?url=X` creates a download task from the URL.
      if (motrixDeepLink.valid) {
        if (motrixDeepLink.isNewTask) {
          const routed = routeExternalDownloadInput(
            {
              url: motrixDeepLink.downloadUrl,
              referer: motrixDeepLink.referer,
              cookie: motrixDeepLink.cookie,
              filename: motrixDeepLink.filename,
              source: 'deep-link',
            },
            items,
          )
          result.autoSubmitted += routed.autoSubmitted
        } else {
          result.ignored += 1
          const fields = formatLogFields({
            action: motrixDeepLink.action,
            hasUrl: motrixDeepLink.downloadUrl ? 'true' : 'false',
            reason: motrixDeepLink.downloadUrl ? 'unhandled-action' : 'wake-only',
          })
          if (motrixDeepLink.downloadUrl) {
            logger.warn('DeepLink.ignored', fields)
          } else {
            logger.debug('DeepLink.ignored', fields)
          }
        }
        continue
      }
      if (motrixDeepLink.reason === 'malformed') {
        result.ignored += 1
        logger.warn('DeepLink.ignored', formatLogFields({ action: 'unknown', hasUrl: 'false', reason: 'malformed' }))
        continue
      }

      // Determine if this is a local file reference (file:// protocol or raw path)
      const isFileUri = lower.startsWith('file://')
      const isRemoteUri =
        lower.startsWith('http://') ||
        lower.startsWith('https://') ||
        lower.startsWith('ftp://') ||
        lower.startsWith('magnet:') ||
        lower.startsWith('ed2k://') ||
        lower.startsWith('thunder://')
      const isLocalPath = !isRemoteUri && !isFileUri

      // Only treat as a file-based batch item if it's a LOCAL path or file:// URI
      const hasFileExt = FILE_EXTS.some((ext) => lower.endsWith(ext))
      if ((isLocalPath || isFileUri) && hasFileExt) {
        const filePath = isFileUri ? normalizeFileUriPath(url) : url
        const kind = detectKind(filePath)
        items.push(createBatchItem(kind, filePath))
      } else if (lower.startsWith('magnet:')) {
        items.push(createBatchItem('uri', url))
      } else if (lower.startsWith('ed2k://')) {
        items.push(createBatchItem('uri', url))
      } else if (lower.startsWith('thunder://')) {
        items.push(createBatchItem('uri', url))
      } else if (isRemoteUri) {
        const kind = detectExternalInputKind(url)
        items.push(createBatchItem(kind, url))
      }
    }

    if (items.length > 0) {
      const skipped = enqueueBatch(items)
      result.queued += items.length - skipped
    }

    return result
  }

  function handleExternalInputs(inputs: ExternalDownloadInput[]): DeepLinkHandlingResult {
    const result: DeepLinkHandlingResult = {
      received: inputs?.length ?? 0,
      queued: 0,
      autoSubmitted: 0,
      ignored: 0,
    }
    if (!inputs || inputs.length === 0) return result

    const items: BatchItem[] = []
    for (const input of inputs) {
      if (!input.url) {
        result.ignored += 1
        continue
      }
      const routed = routeExternalDownloadInput(input, items)
      result.autoSubmitted += routed.autoSubmitted
      result.ignored += routed.ignored
    }

    if (items.length > 0) {
      const skipped = enqueueBatch(items)
      result.queued += items.length - skipped
    }

    return result
  }

  function buildExternalContext(input: ExternalDownloadInput): ExternalDownloadContext {
    return {
      referer: input.referer ?? '',
      cookie: input.cookie ?? '',
      userAgent: input.userAgent ?? '',
      requestHeaders: input.requestHeaders ?? [],
      url: input.url,
      finalUrl: input.finalUrl,
      traceId: input.traceId,
    }
  }

  function routeExternalDownloadInput(
    input: ExternalDownloadInput,
    items: BatchItem[],
  ): Pick<DeepLinkHandlingResult, 'autoSubmitted' | 'ignored'> {
    const downloadUrl = input.finalUrl || input.url
    const kind = detectExternalInputKind(downloadUrl)
    const resolvedHint = resolveExternalFilenameHint(downloadUrl, input.filename ?? '')
    const context = buildExternalContext(input)

    const preferenceStore = usePreferenceStore()
    const autoSubmit = preferenceStore.config.autoSubmitFromExtension
    const autoSelectAllBt = preferenceStore.config.autoSelectAllBtFilesFromExtension === true
    logger.info(
      'ExternalInput.new',
      formatLogFields({
        url: summarizeExternalInput(downloadUrl),
        kind,
        source: input.source || 'unknown',
        traceId: context.traceId ?? 'none',
        hasUserAgent: context.userAgent ? 'true' : 'false',
        hasCookie: context.cookie ? 'true' : 'false',
        headerCount: context.requestHeaders?.length ?? 0,
        filename: input.filename ? 'present' : 'none',
        resolvedFilename: resolvedHint ? 'present' : 'none',
        autoSubmit,
      }),
    )

    if (autoSubmit && autoSelectAllBt && kind === 'uri' && downloadUrl.toLowerCase().startsWith('magnet:')) {
      void autoSubmitExtensionUrl(downloadUrl, context, resolvedHint, true)
      return { autoSubmitted: 1, ignored: 0 }
    }
    if (autoSubmit && autoSelectAllBt && kind === 'torrent') {
      void autoSubmitExtensionFile(downloadUrl, context)
      return { autoSubmitted: 1, ignored: 0 }
    }
    if (autoSubmit && kind === 'uri') {
      void autoSubmitExtensionUrl(downloadUrl, context, resolvedHint)
      return { autoSubmitted: 1, ignored: 0 }
    }

    setPendingExternalMetadata(context, resolvedHint)
    const item = createBatchItem(kind, downloadUrl)
    item.browserContext = context
    if (resolvedHint) item.displayName = resolvedHint
    items.push(item)
    return { autoSubmitted: 0, ignored: 0 }
  }

  /**
   * Auto-submits a single extension URL using the user's default settings.
   * Equivalent to opening AddTask and clicking Submit without any changes.
   */
  async function autoSubmitExtensionUrl(
    url: string,
    context: ExternalDownloadContext,
    filenameHint: string,
    autoSelectAllFiles = false,
  ): Promise<void> {
    const preferenceStore = usePreferenceStore()
    const taskStore = useTaskStore()

    const form = buildExtensionSubmitForm(url, preferenceStore, context, filenameHint)
    const options = buildEngineOptions(form)
    if (autoSelectAllFiles) {
      options['pause-metadata'] = 'false'
    }
    externalInputSubmitCount += 1
    externalInputSubmitting.value = true
    try {
      const result = await submitManualUris(
        form,
        options,
        taskStore,
        {
          enabled: preferenceStore.config.fileCategoryEnabled,
          categories: preferenceStore.config.fileCategories,
        },
        getDownloadProxy(preferenceStore.config.proxy),
      )
      const taskNames = result.submittedTaskNames.length > 0 ? result.submittedTaskNames : [filenameHint || url]
      externalInputStartHandler?.(taskNames)
      preferenceStore.recordHistoryDirectory(form.dir || preferenceStore.config.dir)
      logger.info(
        'autoSubmit',
        formatLogFields({
          traceId: context.traceId ?? 'none',
          url: summarizeExternalInput(url),
          result: 'submitted',
        }),
      )
    } catch (e) {
      logger.error('autoSubmit', e)
      externalInputErrorHandler?.(e)
    } finally {
      externalInputSubmitCount = Math.max(0, externalInputSubmitCount - 1)
      externalInputSubmitting.value = externalInputSubmitCount > 0
    }
  }

  function buildExtensionSubmitForm(
    url: string,
    preferenceStore: ReturnType<typeof usePreferenceStore>,
    context: ExternalDownloadContext,
    filenameHint: string,
  ): AddTaskForm {
    return {
      uris: url,
      out: filenameHint,
      dir: preferenceStore.config.dir,
      split: preferenceStore.config.split ?? 16,
      userAgent: context.userAgent || preferenceStore.config.userAgent || '',
      defaultUserAgent: preferenceStore.config.userAgent || '',
      userAgentProfiles: preferenceStore.config.userAgentProfiles,
      userAgentRules: preferenceStore.config.userAgentRules,
      authorization: '',
      httpAuthUsername: '',
      httpAuthPassword: '',
      saveHttpAuth: true,
      referer: context.referer ?? '',
      cookie: context.cookie ?? '',
      proxyMode: getDefaultTaskProxyMode(preferenceStore.config.proxy),
      customProxy: '',
      customProxyUsername: '',
      customProxyPassword: '',
      appProxy: preferenceStore.config.proxy,
      requestHeaders: context.requestHeaders ?? [],
      uriRequestContexts: {
        [url]: context,
      },
      multiSource: false,
    }
  }

  async function autoSubmitExtensionFile(url: string, context: ExternalDownloadContext): Promise<void> {
    const preferenceStore = usePreferenceStore()
    const taskStore = useTaskStore()
    const form = buildExtensionSubmitForm(url, preferenceStore, context, '')
    const options = buildEngineOptions(form)
    const item = createBatchItem('torrent', url)
    item.browserContext = context
    externalInputSubmitCount += 1
    externalInputSubmitting.value = true
    try {
      await resolveUnresolvedItems([item], (key) => key, getDownloadProxy(preferenceStore.config.proxy))
      if (item.status === 'failed') throw new Error(item.error || 'Failed to load torrent')
      const failures = await submitBatchItems([item], options, taskStore)
      if (failures > 0) throw new Error(item.error || 'Failed to submit torrent')
      externalInputStartHandler?.([item.displayName])
      preferenceStore.recordHistoryDirectory(form.dir || preferenceStore.config.dir)
      logger.info(
        'autoSubmit',
        formatLogFields({
          traceId: context.traceId ?? 'none',
          url: summarizeExternalInput(url),
          result: 'submitted-file',
        }),
      )
    } catch (e) {
      logger.error('autoSubmit', e)
      externalInputErrorHandler?.(e)
    } finally {
      externalInputSubmitCount = Math.max(0, externalInputSubmitCount - 1)
      externalInputSubmitting.value = externalInputSubmitCount > 0
    }
  }

  return {
    systemTheme,
    trayFocused,
    aboutPanelVisible,
    engineInfo,
    engineOptions,
    interval,
    stat,
    addTaskVisible,
    pendingBatch,
    addTaskOptions,
    pendingReferer,
    pendingCookie,
    pendingUserAgent,
    pendingRequestHeaders,
    progress,
    pendingUpdate,
    engineRestarting,
    setEngineRestarting,
    engineReady,
    pendingMagnetGids,
    updateInterval,
    increaseInterval,
    decreaseInterval,
    resetInterval,
    enqueueBatch,
    showAddTaskDialog,
    hideAddTaskDialog,
    updateAddTaskOptions,
    fetchGlobalStat,
    handleStatEvent,
    setupStatListener,
    fetchEngineInfo,
    fetchEngineOptions,
    handleDeepLinkUrls,
    handleExternalInputs,
    setExternalInputErrorHandler,
    setExternalInputStartHandler,
    pendingFilename,
    externalInputSubmitting,
  }
})
