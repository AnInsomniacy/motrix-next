<script setup lang="ts">
/** @fileoverview Add task dialog: dual-tab layout (URI / Torrent) with AutoAnimate list transitions. */
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceNumericValidation } from '@/composables/usePreferenceNumericValidation'
import { useHttpAuthStore } from '@/stores/httpAuth'
import { ADD_TASK_TYPE } from '@shared/constants'
import { detectResource } from '@shared/utils'
import { mergeRawUriLines, normalizeUriLines, extractMagnetDisplayName } from '@shared/utils/batchHelpers'
import { resolveDownloadCategory, resolveFileSetCategory } from '@shared/utils/fileCategory'
import { buildOuts } from '@shared/utils/rename'
import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
  getDownloadProxy,
} from '@/composables/useAddTaskSubmit'
import type { AddTaskForm, ManualUriSubmitResult } from '@/composables/useAddTaskSubmit'
import { isValidAria2ProxyUrl } from '@shared/utils/proxy'
import { handleTaskStart } from '@/composables/useTaskNotifyHandlers'
import { isMagnetUri } from '@/composables/useMagnetFlow'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'
import {
  getDefaultTaskProxyMode,
  getDefaultTaskProxyPassword,
  getDefaultTaskProxyServer,
  getDefaultTaskProxyUsername,
} from '@shared/utils/proxy'
import { resolveUserVisibleDownloadDir } from '@shared/utils/userVisibleDirectory'
import { findMatchingUserAgentRule, resolveUserAgent } from '@shared/utils/userAgentPolicy'

import {
  resolveUnresolvedItems,
  retryTorrentInspection,
  chooseTorrentFile as chooseTorrentFileImpl,
} from '@/composables/useAddTaskFileOps'
import {
  NModal,
  NCard,
  NTabs,
  NTabPane,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NButton,
  NSpace,
  NIcon,
  NInputGroup,
  NTag,
  NEllipsis,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import type { BatchItem, BatchItemKind, BtFileSelectionItem, UserAgentProfile } from '@shared/types'
import { FolderOpenOutline, CloudUploadOutline } from '@vicons/ionicons5'
import { vMotionAutoAnimate } from '@/directives/motionAutoAnimate'
import AdvancedOptions from './addtask/AdvancedOptions.vue'
import DirectoryPopover from '@/components/common/DirectoryPopover.vue'
import BtFileSelector from '@/components/task/BtFileSelector.vue'

const props = withDefaults(
  defineProps<{
    show: boolean
    showMask?: boolean
  }>(),
  {
    showMask: true,
  },
)
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const appStore = useAppStore()
const taskStore = useTaskStore()
const preferenceStore = usePreferenceStore()
const httpAuthStore = useHttpAuthStore()
const message = useAppMessage()
const { constraint, configFieldProps, areConfigFieldsValid } = usePreferenceNumericValidation()
/** Tracks whether the user manually edited the download directory in this session. */
const dirUserModified = ref(false)

const activeTab = ref<BatchItemKind>(ADD_TASK_TYPE.URI)
const tabsRef = ref<InstanceType<typeof import('naive-ui').NTabs> | null>(null)

/**
 * Switch tab programmatically with correct animation direction.
 *
 * NTabs only computes `animationDirection` inside its internal `activateTab()`
 * handler (user clicks).  Programmatic `:value` changes skip that and always
 * default to `'next'`.  This helper mirrors the direction logic from the NTabs
 * source and sets it on the component instance before updating `activeTab`.
 */
const TAB_ORDER = [ADD_TASK_TYPE.URI, ADD_TASK_TYPE.TORRENT] as const
function switchTab(target: BatchItemKind): void {
  if (activeTab.value === target) return
  const inst = tabsRef.value as Record<string, unknown> | null
  if (inst && 'animationDirection' in inst) {
    const curIdx = TAB_ORDER.indexOf(activeTab.value as (typeof TAB_ORDER)[number])
    const tgtIdx = TAB_ORDER.indexOf(target as (typeof TAB_ORDER)[number])
    ;(inst as { animationDirection: string }).animationDirection = tgtIdx > curIdx ? 'next' : 'prev'
  }
  activeTab.value = target
}

function activateTab(value: string): void {
  if (value === ADD_TASK_TYPE.URI || value === ADD_TASK_TYPE.TORRENT) activeTab.value = value
}
const showAdvanced = ref(false)
const submitting = ref(false)
const selectedBatchIndex = ref(0)
const userAgentManuallyEdited = ref(false)
const defaultTaskProxyMode = () => getDefaultTaskProxyMode(preferenceStore.config.proxy)
const defaultTaskProxyServer = () => getDefaultTaskProxyServer(preferenceStore.config.proxy)
const defaultTaskProxyUsername = () => getDefaultTaskProxyUsername(preferenceStore.config.proxy)
const defaultTaskProxyPassword = () => getDefaultTaskProxyPassword(preferenceStore.config.proxy)

function syncDefaultTaskProxy() {
  form.value.proxyMode = defaultTaskProxyMode()
  form.value.customProxy = defaultTaskProxyServer()
  form.value.customProxyUsername = defaultTaskProxyUsername()
  form.value.customProxyPassword = defaultTaskProxyPassword()
  form.value.appProxy = preferenceStore.config.proxy
}

function syncPendingExternalMetadata() {
  form.value.referer = appStore.pendingReferer
  form.value.cookie = appStore.pendingCookie
  form.value.out = appStore.pendingFilename
  form.value.userAgent = appStore.pendingUserAgent
  form.value.requestHeaders = appStore.pendingRequestHeaders
  applyResolvedUserAgent()
}

const form = ref<AddTaskForm>({
  uris: '',
  out: '',
  dir: preferenceStore.config.dir || '',
  streamMaxConnections: preferenceStore.config.streamMaxConnections,
  userAgent: '',
  authorization: '',
  httpAuthUsername: '',
  httpAuthPassword: '',
  saveHttpAuth: true,
  referer: '',
  cookie: '',
  proxyMode: defaultTaskProxyMode(),
  customProxy: defaultTaskProxyServer(),
  customProxyUsername: defaultTaskProxyUsername(),
  customProxyPassword: defaultTaskProxyPassword(),
  appProxy: preferenceStore.config.proxy,
  requestHeaders: [],
  uriRequestContexts: {},
})

const firstRegularUri = computed(
  () =>
    form.value.uris
      .split(/\r?\n/)
      .map((uri) => uri.trim())
      .find((uri) => uri && !isMagnetUri(uri)) ?? '',
)
const matchedUserAgentRule = computed(() =>
  findMatchingUserAgentRule({
    url: firstRegularUri.value,
    referer: form.value.referer,
    profiles: preferenceStore.config.userAgentProfiles,
    rules: preferenceStore.config.userAgentRules,
  }),
)
const userAgentSourceText = computed(() => {
  if (userAgentManuallyEdited.value) return t('task.ua-source-manual')
  const match = matchedUserAgentRule.value
  if (match && form.value.userAgent === match.profile.value)
    return t('task.ua-source-rule', { host: match.rule.hostPattern })
  if (appStore.pendingUserAgent && form.value.userAgent === appStore.pendingUserAgent)
    return t('task.ua-source-extension')
  return ''
})

function applyResolvedUserAgent() {
  if (userAgentManuallyEdited.value) return
  const resolved = resolveUserAgent({
    manualUserAgent: '',
    pluginUserAgent: appStore.pendingUserAgent,
    defaultUserAgent: preferenceStore.config.userAgent,
    url: firstRegularUri.value,
    referer: form.value.referer,
    profiles: preferenceStore.config.userAgentProfiles,
    rules: preferenceStore.config.userAgentRules,
  })
  form.value.userAgent = resolved.userAgent
}

// ── Computed batch accessors ────────────────────────────────────────

const batch = computed(() => appStore.pendingBatch)
const hasBatch = computed(() => batch.value.length > 0)
const fileItems = computed(() => batch.value.filter((i) => i.kind !== 'uri'))
const selectedItem = computed(() => fileItems.value[selectedBatchIndex.value] ?? null)
const selectedTorrentFiles = computed<BtFileSelectionItem[]>(() =>
  (selectedItem.value?.torrentMeta?.files ?? []).map((file) => {
    const pathParts = file.path.split(/[/\\]/)
    return {
      index: Number(file.index),
      name: pathParts[pathParts.length - 1] || file.path,
      path: file.path,
      length: Number(file.length),
    }
  }),
)
const selectedFileIndices = computed<number[]>({
  get: () => selectedItem.value?.selectedFileIndices ?? [],
  set: (indices) => {
    if (selectedItem.value) selectedItem.value.selectedFileIndices = indices
  },
})
const torrentItemsReady = computed(() =>
  fileItems.value.every((item) => item.inspectionState === 'ready' && Boolean(item.selectedFileIndices?.length)),
)
const uriOptionsValid = computed(
  () => !form.value.uris.trim() || areConfigFieldsValid({ streamMaxConnections: form.value.streamMaxConnections }),
)
const canSubmit = computed(() => uriOptionsValid.value && torrentItemsReady.value)

// Sync download settings with the latest preference every time the dialog
// opens. AddTask is kept mounted (`:show` not `v-if`), so form values would
// otherwise be stale if the user changes defaults in preferences.
watch(
  () => props.show,
  (visible) => {
    if (visible) {
      // When classification is enabled, clear the dir so user sees it's optional;
      // otherwise sync from preferences as usual.
      if (preferenceStore.config.fileCategoryEnabled) {
        form.value.dir = ''
      } else {
        form.value.dir = preferenceStore.config.dir || form.value.dir
      }
      form.value.streamMaxConnections = preferenceStore.config.streamMaxConnections
      syncDefaultTaskProxy()
      // Reset the manual-override flag each time the dialog opens
      dirUserModified.value = false

      syncPendingExternalMetadata()
    }
  },
)

watch(
  () => preferenceStore.config.proxy,
  () => {
    if (props.show) syncDefaultTaskProxy()
  },
  { deep: true },
)

watch(
  [
    firstRegularUri,
    () => form.value.referer,
    () => preferenceStore.config.userAgent,
    () => preferenceStore.config.userAgentProfiles,
    () => preferenceStore.config.userAgentRules,
  ],
  () => {
    if (props.show) applyResolvedUserAgent()
  },
  { deep: true },
)

const submitLabel = computed(() => t('app.submit'))

/** Whether file classification is currently enabled in preferences. */
const categoryEnabled = computed(() => preferenceStore.config.fileCategoryEnabled)

/** Dynamic label: switches between original 'Save to' and 'Custom Path' based on classification state. */
const dirLabel = computed(() => (categoryEnabled.value ? t('task.task-custom-dir') : t('task.task-dir')))

function resolveCategoryMatches(): Map<string, { label: string; directory: string }> {
  const uris = normalizeUriLines(form.value.uris).filter((uri) => !isMagnetUri(uri))
  const outs = uris.length > 1 && form.value.out ? buildOuts(uris, form.value.out) : []
  const matched = new Map<string, { label: string; directory: string }>()

  for (const [index, uri] of uris.entries()) {
    const context = form.value.uriRequestContexts?.[uri]
    const category = resolveDownloadCategory(
      outs[index] || form.value.out || uri,
      preferenceStore.config.fileCategories,
      {
        urls: [uri, context?.finalUrl ?? '', context?.url ?? '', context?.referer ?? ''],
      },
    )
    if (!category) continue
    const label = category.builtIn ? t(`preferences.${category.label}`) : category.label
    matched.set(category.directory, { label, directory: category.directory })
  }

  return matched
}

function resolveSelectedTorrentCategory(): { label: string; directory: string } | undefined {
  const item = selectedItem.value
  if (!item?.torrentMeta) return undefined

  const selectedIndices = new Set(item.selectedFileIndices ?? [])
  const category = resolveFileSetCategory(
    item.torrentMeta.files
      .filter((file) => selectedIndices.has(Number(file.index)) && Number(file.length) > 0)
      .map((file) => ({ path: file.path })),
    preferenceStore.config.fileCategories,
    { urls: [item.source] },
  )
  if (!category) return undefined

  return {
    label: category.builtIn ? t(`preferences.${category.label}`) : category.label,
    directory: category.directory,
  }
}

const categoryMatches = computed(() => {
  if (!categoryEnabled.value || dirUserModified.value) return new Map<string, { label: string; directory: string }>()
  if (activeTab.value === ADD_TASK_TYPE.TORRENT) {
    const category = resolveSelectedTorrentCategory()
    return category ? new Map([[category.directory, category]]) : new Map()
  }
  return resolveCategoryMatches()
})

const categoryMatchPreview = computed(() => {
  const matched = categoryMatches.value
  if (matched.size !== 1) return undefined
  return matched.values().next().value
})

const displayedDir = computed(() => {
  if (dirUserModified.value) return form.value.dir
  return categoryMatchPreview.value?.directory ?? form.value.dir
})

const categoryPreviewText = computed(() => {
  if (!categoryEnabled.value) return ''
  if (dirUserModified.value) return t('task.category-hint-overridden')

  if (activeTab.value === ADD_TASK_TYPE.TORRENT) {
    if (!selectedItem.value) return t('task.category-hint-active')
    const matched = categoryMatchPreview.value
    return matched ? t('task.category-match-single', { category: matched.label }) : t('task.category-match-none')
  }

  const uris = normalizeUriLines(form.value.uris).filter((uri) => !isMagnetUri(uri))
  if (uris.length === 0) return t('task.category-hint-active')

  const matched = categoryMatchPreview.value
  if (matched) return t('task.category-match-single', { category: matched.label })

  const matchedSize = categoryMatches.value.size
  if (matchedSize === 0) return t('task.category-match-none')
  if (matchedSize > 1) return t('task.category-match-multiple')
  return t('task.category-match-none')
})

/** Handles user manually editing the dir field. */
function onDirInput(value: string) {
  form.value.dir = value
  // Empty = user hasn't specified a custom path (auto-classification will handle it).
  // Non-empty = explicit user override, classification rules will be skipped.
  dirUserModified.value = value.trim().length > 0
}

// ── Lifecycle ───────────────────────────────────────────────────────

onMounted(async () => {
  if (!form.value.dir) {
    try {
      const resolvedDir = await resolveUserVisibleDownloadDir({ configuredDir: preferenceStore.config.dir })
      form.value.dir = resolvedDir.path
      logger.info('AddTask.dir', `resolved source=${resolvedDir.source} fallback=${resolvedDir.usedFallback}`)
    } catch (e) {
      logger.debug('AddTask.dir', e)
      form.value.dir = '~/Downloads'
    }
  }
})

// When dialog opens: resolve file items, flush URIs into textarea, auto-select tab
//
// Race-condition guard: the batch.length watcher may fire and drain pendingBatch
// BEFORE this async watcher finishes its clipboard read.  A simple `hasBatch`
// re-check fails because the batch is already empty by that point.  Instead we
// use a flag that the batch.length watcher sets synchronously whenever it writes
// to form.uris — the flag survives the drain and is visible after the await.
let batchDidWrite = false

watch(
  () => props.show,
  async (visible) => {
    if (!visible) {
      batchDidWrite = false
      return
    }
    selectedBatchIndex.value = 0

    if (hasBatch.value) {
      // Resolve file-based items
      await localResolveUnresolvedItems()
      // Flush URI batch items into the editable textarea via normalized merge
      const uriItems = batch.value.filter((i) => i.kind === 'uri')
      if (uriItems.length > 0) {
        form.value.uris = mergeRawUriLines(
          form.value.uris,
          uriItems.map((i) => i.payload),
        )
        form.value.uriRequestContexts = Object.fromEntries(
          uriItems.flatMap((i) => (i.browserContext ? [[i.payload, i.browserContext]] : [])),
        )
        appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
      }
      // Auto-switch to Torrent tab when file items are present
      if (fileItems.value.length > 0) {
        switchTab(ADD_TASK_TYPE.TORRENT)
      } else {
        switchTab(ADD_TASK_TYPE.URI)
      }
    } else {
      // Only reset tab if batchWatcher hasn't already handled a programmatic
      // switch — otherwise we'd cause a rapid URI→TORRENT bounce that
      // confuses NTabs' animation direction.
      if (!batchDidWrite) switchTab(ADD_TASK_TYPE.URI)
      // No batch — check clipboard for URIs
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
        const text = await readText()
        // Re-check: a deep-link/extension batch may have arrived and been
        // processed (and drained) during the async readText() gap.
        // `hasBatch` is unreliable here because batchWatcher drains
        // pendingBatch after writing — use the flag instead.
        if (batchDidWrite) return
        if (text && detectResource(text, preferenceStore.config.clipboard)) {
          form.value.uris = text.trim()
        }
      } catch (e) {
        logger.debug('AddTask.readClipboard', e)
      }
    }
  },
)

// Watch for new batch items added while dialog is already open (drag-drop, deep link).
// Replace (not merge) the textarea — batch content takes priority over any clipboard
// auto-fill that the show watcher may have already written.
watch(
  () => batch.value.length,
  async (newLen, oldLen) => {
    if (!props.show || newLen <= oldLen) return
    // Snapshot newly arrived items before any drain/resolve mutates the batch.
    const newlyArrived = batch.value.slice(oldLen)
    const uriItems = batch.value.filter((i) => i.kind === 'uri')
    if (uriItems.length > 0) {
      batchDidWrite = true
      form.value.uris = mergeRawUriLines(
        '',
        uriItems.map((i) => i.payload),
      )
      form.value.uriRequestContexts = Object.fromEntries(
        uriItems.flatMap((i) => (i.browserContext ? [[i.payload, i.browserContext]] : [])),
      )
      syncPendingExternalMetadata()
      appStore.pendingBatch = batch.value.filter((i) => i.kind !== 'uri')
    }
    // Auto-switch tab SYNCHRONOUSLY (before any await) so NTabs computes
    // the correct slide direction in the same render tick.
    const hasNewFiles = newlyArrived.some((i) => i.kind !== 'uri')
    const hasNewUris = newlyArrived.some((i) => i.kind === 'uri')
    if (hasNewFiles) {
      switchTab(ADD_TASK_TYPE.TORRENT)
    } else if (hasNewUris) {
      switchTab(ADD_TASK_TYPE.URI)
    }
    // Resolve file metadata asynchronously (doesn't affect tab choice).
    await localResolveUnresolvedItems()
  },
)

// ── File resolution (delegated to useAddTaskFileOps) ────────────────

async function localResolveUnresolvedItems() {
  await resolveUnresolvedItems(batch.value, t, getDownloadProxy(preferenceStore.config.proxy))
}

async function chooseTorrentFile() {
  await chooseTorrentFileImpl({
    t,
    batch,
    fileItems,
    selectedBatchIndex,
    setPendingBatch: (items) => {
      appStore.pendingBatch = items
    },
    showWarning: (msg) => message.warning(msg),
  })
}

async function retryTorrent(item: BatchItem) {
  await retryTorrentInspection(item, t, getDownloadProxy(preferenceStore.config.proxy))
}

async function chooseDirectory() {
  try {
    const selected = await openDialog({ directory: true })
    if (typeof selected === 'string') {
      form.value.dir = selected
      // Only mark as user-override when classification is active
      dirUserModified.value = categoryEnabled.value && selected.trim().length > 0
    }
  } catch (e) {
    logger.debug('AddTask.chooseDirectory', e)
  }
}

function onDirectorySelect(dir: string) {
  form.value.dir = dir
  dirUserModified.value = categoryEnabled.value && dir.trim().length > 0
}

function onUserAgentInput(value: string) {
  userAgentManuallyEdited.value = true
  form.value.userAgent = value
}

function selectUserAgentProfile(profile: UserAgentProfile) {
  userAgentManuallyEdited.value = true
  form.value.userAgent = profile.value
  preferenceStore.recordRecentUserAgentProfile(profile.id)
}

function removeBatchItem(item: BatchItem) {
  appStore.pendingBatch = batch.value.filter((i) => i !== item)
  selectedBatchIndex.value = Math.min(selectedBatchIndex.value, Math.max(0, fileItems.value.length - 1))
}

// ── Submit ───────────────────────────────────────────────────────────

function handleClose() {
  emit('close')
  Object.assign(form.value, {
    uris: '',
    out: '',
    userAgent: '',
    authorization: '',
    httpAuthUsername: '',
    httpAuthPassword: '',
    saveHttpAuth: true,
    referer: '',
    cookie: '',
    customProxyUsername: '',
    customProxyPassword: '',
    requestHeaders: [],
    uriRequestContexts: {},
  })
  syncDefaultTaskProxy()
  userAgentManuallyEdited.value = false
  submitting.value = false
  selectedBatchIndex.value = 0
}

async function handleSubmit() {
  if (submitting.value || !canSubmit.value) return
  submitting.value = true

  try {
    // Validate custom proxy before building options
    if (form.value.proxyMode === 'manual' && form.value.customProxy) {
      if (!isValidAria2ProxyUrl(form.value.customProxy)) {
        message.error(t('task.proxy-unsupported-protocol'), { closable: true })
        submitting.value = false
        return
      }
    }

    // When dir field is empty (user left it blank for auto-classification),
    // fall back to the global default dir so aria2 always has a valid path.
    const effectiveForm = {
      ...form.value,
      dir: form.value.dir.trim() || preferenceStore.config.dir,
      appProxy: preferenceStore.config.proxy,
      defaultUserAgent: preferenceStore.config.userAgent,
      userAgentProfiles: preferenceStore.config.userAgentProfiles,
      userAgentRules: preferenceStore.config.userAgentRules,
    }
    const options = buildEngineOptions(effectiveForm)
    const fileCategory = {
      enabled: preferenceStore.config.fileCategoryEnabled && !dirUserModified.value,
      categories: preferenceStore.config.fileCategories,
    }
    let manualResult: ManualUriSubmitResult = { submittedTaskNames: [], magnetGids: [], magnetFailures: [] }

    if (hasBatch.value) {
      await submitBatchItems(batch.value, options, taskStore, fileCategory)
    }
    if (form.value.uris.trim()) {
      manualResult = await submitManualUris(
        effectiveForm,
        taskStore,
        fileCategory,
        getDownloadProxy(preferenceStore.config.proxy),
      )
    }

    const failedCount = batch.value.filter((i) => i.status === 'failed').length + manualResult.magnetFailures.length
    if (failedCount > 0) {
      message.warning(`${failedCount} ${t('task.failed') || 'failed'}`, { closable: true })
    } else {
      // ── Collect task names BEFORE handleClose clears form state ──
      const taskNames: string[] = []
      for (const item of batch.value) {
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

      if (effectiveForm.saveHttpAuth && effectiveForm.httpAuthUsername.trim()) {
        const firstHttpUri = normalizeUriLines(effectiveForm.uris).find((uri) => /^https?:\/\//i.test(uri))
        if (firstHttpUri) {
          try {
            await httpAuthStore.saveCredential({
              url: firstHttpUri,
              username: effectiveForm.httpAuthUsername,
              password: effectiveForm.httpAuthPassword,
            })
            message.success(t('task.task-http-auth-saved'))
          } catch (err) {
            logger.warn('AddTask.httpAuth', `credential save failed: ${err}`)
          }
        }
      }

      handleClose()

      // ── Record directory for the recent-folders popover ────────
      const effectiveDir = form.value.dir.trim() || preferenceStore.config.dir
      if (effectiveDir) {
        preferenceStore.recordHistoryDirectory(effectiveDir)
      }

      // ── Start notification (aggregated) ────────────────────────
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
    const errMsg = getErrorMessage(e, {
      fallback: t('task.error-unknown'),
      labels: { Aria2: t('task.error-aria2-next') },
    })
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
</script>

<template>
  <NModal
    :show="props.show"
    :show-mask="props.showMask"
    :mask-closable="false"
    :close-on-esc="true"
    :auto-focus="false"
    transform-origin="center"
    :transition="{ name: 'fade-scale' }"
    @update:show="
      (v: boolean) => {
        if (!v) handleClose()
      }
    "
  >
    <NCard
      :title="t('task.new-task')"
      closable
      class="add-task-card"
      :style="{
        maxWidth: '680px',
        minWidth: 'min(380px, calc(100vw - 24px))',
        width: '70vw',
        margin: 'auto',
        height: '82vh',
        display: 'flex',
        flexDirection: 'column',
      }"
      :content-style="{ flex: '1', minHeight: '0', overflowY: 'auto', overflowX: 'hidden' }"
      :segmented="{ footer: true }"
      @close="handleClose"
    >
      <NForm label-placement="left" label-width="110px">
        <NTabs ref="tabsRef" :value="activeTab" type="line" animated @update:value="activateTab">
          <!-- ── URI Tab ──────────────────────────────────────── -->
          <NTabPane :name="ADD_TASK_TYPE.URI" :tab="t('task.uri-task') || 'URL'">
            <div class="tab-pane-content">
              <NFormItem :show-label="false" style="margin-bottom: 0">
                <NInput
                  v-model:value="form.uris"
                  class="uri-input"
                  type="textarea"
                  :rows="5"
                  :placeholder="t('task.uri-task-tips') || 'One URL per line'"
                />
              </NFormItem>
            </div>
          </NTabPane>

          <!-- ── Torrent Tab ─────────────────────────────────── -->
          <NTabPane :name="ADD_TASK_TYPE.TORRENT" :tab="t('task.torrent-task') || 'Torrent'">
            <div v-motion-auto-animate="{ duration: 200, easing: 'ease-out' }" class="tab-pane-content">
              <!-- Torrent panel: animated batch list + file detail -->
              <div v-if="fileItems.length > 0" class="torrent-panel">
                <!-- Batch list with AutoAnimate transitions -->
                <div v-motion-auto-animate="{ duration: 200, easing: 'ease-out' }" class="batch-list">
                  <div
                    v-for="(item, idx) in fileItems"
                    :key="item.id"
                    class="batch-item"
                    :class="{ 'batch-item-selected': idx === selectedBatchIndex }"
                    @click="selectedBatchIndex = idx"
                  >
                    <div class="batch-item-main">
                      <NEllipsis :style="{ maxWidth: '400px', flex: 1 }">{{ item.displayName }}</NEllipsis>
                      <NSpace :size="4" align="center" :wrap="false">
                        <NTag type="info" size="small" :bordered="false">
                          {{ t('task.torrent-task') }}
                        </NTag>
                        <NButton quaternary size="tiny" @click.stop="removeBatchItem(item)">✕</NButton>
                      </NSpace>
                    </div>
                  </div>
                </div>

                <!-- Add more files button -->
                <NButton size="small" dashed block style="margin-top: 6px" @click="chooseTorrentFile">
                  <template #icon>
                    <NIcon><CloudUploadOutline /></NIcon>
                  </template>
                  {{ t('task.select-torrent') || 'Select torrent files' }}
                </NButton>

                <Transition name="content-fade" mode="out-in">
                  <div
                    v-if="selectedItem?.inspectionState === 'failed'"
                    :key="`${selectedItem.id}-failed`"
                    class="torrent-inspection-error"
                  >
                    <span>{{ selectedItem.error }}</span>
                    <NButton size="tiny" type="primary" ghost @click="retryTorrent(selectedItem)">
                      {{ t('app.retry') }}
                    </NButton>
                  </div>
                  <div v-else-if="selectedItem?.torrentMeta" :key="selectedItem.id" class="torrent-inspection-result">
                    <BtFileSelector
                      v-model:selected-indices="selectedFileIndices"
                      :files="selectedTorrentFiles"
                      :max-height="200"
                    />
                  </div>
                </Transition>
              </div>

              <!-- Upload zone: shown when no torrents loaded -->
              <div v-if="fileItems.length === 0" class="torrent-upload-zone" @click="chooseTorrentFile">
                <NIcon :size="36" :depth="3"><CloudUploadOutline /></NIcon>
                <span class="torrent-upload-text">
                  {{ t('task.select-torrent') || 'Drag torrent here or click to select' }}
                </span>
              </div>
            </div>
          </NTabPane>
        </NTabs>

        <!-- ── Download settings: always visible ──────────────── -->
        <div class="download-settings">
          <NFormItem :label="t('task.task-out') + ':'">
            <NInput v-model:value="form.out" :placeholder="t('task.task-out-tips')" :autofocus="false" />
          </NFormItem>
          <NFormItem
            :label="t('task.task-connections') + ':'"
            v-bind="configFieldProps('streamMaxConnections', form.streamMaxConnections)"
          >
            <NInputNumber
              v-model:value="form.streamMaxConnections"
              :min="constraint('streamMaxConnections').min"
              :max="constraint('streamMaxConnections').max"
              style="width: 120px"
            />
          </NFormItem>
          <NFormItem :label="dirLabel + ':'">
            <div style="width: 100%">
              <NInputGroup>
                <NInput
                  :value="displayedDir"
                  style="flex: 1"
                  :placeholder="categoryEnabled ? t('task.category-dir-placeholder') : ''"
                  @update:value="onDirInput"
                />
                <NButton @click="chooseDirectory">
                  <template #icon>
                    <NIcon><FolderOpenOutline /></NIcon>
                  </template>
                </NButton>
                <DirectoryPopover @select="onDirectorySelect" />
              </NInputGroup>
              <div class="category-hint-collapse" :class="{ 'category-hint-collapse--open': !!categoryPreviewText }">
                <div class="category-hint-collapse__inner">
                  <Transition name="category-hint" mode="out-in">
                    <div v-if="categoryPreviewText" :key="categoryPreviewText" class="category-hint-text">
                      ⓘ {{ categoryPreviewText }}
                    </div>
                  </Transition>
                </div>
              </div>
            </div>
          </NFormItem>
          <AdvancedOptions
            v-model:show="showAdvanced"
            v-model:authorization="form.authorization"
            v-model:http-auth-username="form.httpAuthUsername"
            v-model:http-auth-password="form.httpAuthPassword"
            v-model:save-http-auth="form.saveHttpAuth"
            v-model:referer="form.referer"
            v-model:cookie="form.cookie"
            v-model:proxy-mode="form.proxyMode"
            v-model:custom-proxy="form.customProxy"
            v-model:custom-proxy-username="form.customProxyUsername"
            v-model:custom-proxy-password="form.customProxyPassword"
            :source-url="firstRegularUri"
            :user-agent="form.userAgent"
            :user-agent-source="userAgentSourceText"
            :user-agent-profiles="preferenceStore.config.userAgentProfiles"
            :user-agent-rules="preferenceStore.config.userAgentRules"
            :recent-user-agent-profile-ids="preferenceStore.config.recentUserAgentProfileIds"
            @update:user-agent="onUserAgentInput"
            @select-user-agent-profile="selectUserAgentProfile"
          />
        </div>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="handleClose">{{ t('app.cancel') }}</NButton>
          <NButton
            data-testid="submit-button"
            type="primary"
            :loading="submitting"
            :disabled="!canSubmit"
            @click="handleSubmit"
          >
            {{ submitLabel }}
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
/* Fixed-height tab panes prevent jitter when switching tabs.
 * URI textarea rows=5 ≈ 138px — keep both panes at same min-height. */
.tab-pane-content {
  min-height: 150px;
}

.uri-input :deep(.n-input__textarea-el) {
  white-space: pre-wrap;
  overflow-wrap: normal;
  word-break: break-all;
  hyphens: none;
}

/* ── Torrent panel ────────────────────────────────────────────────── */
.torrent-panel {
  margin-bottom: 12px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--m3-outline-variant);
  background: var(--m3-surface-container-low);
}

/* ── Batch list ───────────────────────────────────────────────────── */
.batch-list {
  border-radius: 6px;
  border: 1px solid var(--m3-outline-variant);
  overflow: hidden;
}

.torrent-inspection-result,
.torrent-inspection-error {
  margin-top: 8px;
}

.torrent-inspection-error {
  display: flex;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--m3-error);
}

/* ── Upload zone (when no torrents) ───────────────────────────────── */
.torrent-upload-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 138px;
  border: 1px dashed var(--m3-drop-zone-border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.torrent-upload-zone:hover {
  border-color: var(--m3-primary);
}
.torrent-upload-text {
  font-size: 13px;
  opacity: 0.6;
}

/* ── Download settings ────────────────────────────────────────────── */
.download-settings {
  margin-top: 4px;
}
</style>

<!-- Non-scoped: Vue Transition classes must NOT be scoped -->
<style>
/* ── Batch item base styles ───────────────────────────────────────── */
.batch-item {
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.15s;
}
.batch-item:hover {
  background: var(--m3-surface-container-high);
}
.batch-item-selected {
  background: var(--m3-surface-container-highest);
}
.batch-item + .batch-item {
  border-top: 1px solid var(--m3-outline-variant);
}
.batch-item-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

/* ── Content crossfade (file detail switching) ────────────────────── */
.content-fade-enter-active {
  transition: opacity 0.2s cubic-bezier(0.2, 0, 0, 1);
}
.content-fade-leave-active {
  transition: opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.content-fade-enter-from,
.content-fade-leave-to {
  opacity: 0;
}

/* ── Category hint below dir field ────────────────────────────────── */
.category-hint-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.category-hint-collapse--open {
  grid-template-rows: 1fr;
}
.category-hint-collapse__inner {
  overflow: hidden;
}
.category-hint-text {
  font-size: var(--font-size-sm);
  color: var(--n-text-color-3);
  margin-top: 4px;
  padding-left: 2px;
}
.category-hint-enter-active {
  transition:
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1),
    transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.category-hint-leave-active {
  transition:
    opacity 0.15s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.15s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.category-hint-enter-from,
.category-hint-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
