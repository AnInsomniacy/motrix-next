<script setup lang="ts">
/** @fileoverview Main application layout with sidebar, subnav, and IPC event handling. */
import { computed, ref, nextTick, watch } from 'vue'
import { useRoute } from 'vue-router'
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useEngineStore } from '@/stores/engine'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { logger } from '@shared/logger'
import { isMetadataTask, updateHistoryFilePath } from '@/composables/useTaskLifecycle'
import { setArchivedPath, resolveTaskFilePath, requestFileRecheck } from '@/composables/useArchivedPaths'
import { handleTaskComplete, handleP2pDownloadComplete, handleTaskError } from '@/composables/useTaskNotifyHandlers'
import { shouldDeleteTorrent, trashTorrentFile } from '@/composables/useDownloadCleanup'
import { getTaskName, resolveOpenTarget, checkTaskIsSharing, getTaskSharingKind } from '@shared/utils'
import type { TaskSharingKind } from '@shared/utils/task'
import type { Aria2Task } from '@shared/types'
import { ARIA2_ERROR_CODES } from '@shared/aria2ErrorCodes'
import { useHistoryStore } from '@/stores/history'
import { useDatabaseStore } from '@/stores/database'
import { useDatabaseReset } from '@/composables/useDatabaseReset'
import { useBtSelection } from '@/composables/useBtSelection'
import aria2Api from '@/api/aria2'
import { usePlatform } from '@/composables/usePlatform'
import { throttledResizeHandler, cancelPendingResize } from '@/layouts/resizeThrottle'
import AsideBar from '@/components/layout/AsideBar.vue'
import TaskSubnav from '@/components/layout/TaskSubnav.vue'
import PreferenceSubnav from '@/components/layout/PreferenceSubnav.vue'
import Speedometer from '@/components/layout/Speedometer.vue'
import WindowControls from '@/components/layout/WindowControls.vue'
import EngineRecoveryDialog from '@/components/layout/EngineRecoveryDialog.vue'
import AboutPanel from '@/components/about/AboutPanel.vue'
import AddTask from '@/components/task/AddTask.vue'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'
import TaskSelectionHost from '@/components/task/TaskSelectionHost.vue'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import { NModal, NButton, NCheckbox, NProgress, NPagination, useDialog } from 'naive-ui'

import { useAppEvents } from '@/composables/useAppEvents'
import { loadAddedAtFromRecords } from '@/composables/useTaskOrder'
import { resolveArchiveAction } from '@shared/utils/autoArchive'

const { t } = useI18n()
const route = useRoute()
const appStore = useAppStore()
const engineStore = useEngineStore()
const taskStore = useTaskStore()
const btSelection = useBtSelection()
const preferenceStore = usePreferenceStore()
const navDialog = useDialog()
const message = useAppMessage()
const database = useDatabaseStore()
const { showDatabaseReset } = useDatabaseReset()
watch(
  () => database.phase,
  (phase) => {
    if (phase === 'failed' && !database.notified) {
      database.notified = true
      showDatabaseReset(true)
    }
  },
  { immediate: true, flush: 'post' },
)
const isTaskPage = computed(() => route.path.startsWith('/task'))
const isPreferencePage = computed(() => route.path.startsWith('/preference'))
const showAbout = ref(false)
const showExitDialog = ref(false)
const isExiting = ref(false)
const rememberChoice = ref(false)
const pendingTrayHide = ref(false)
const isMaximized = ref(false)
const { platform: currentPlatform, isMac } = usePlatform()
const taskPaginationTab = computed(() => taskStore.currentList)
const taskPaginationPage = computed(() => taskStore.taskPagination[taskPaginationTab.value].page)
const taskPaginationPageSize = computed(() => taskStore.taskPagination.pageSize)
const taskPaginationPageCount = computed(() => taskStore.currentTaskPageCount())
const taskPaginationPageSizes = [5, 20, 40, 80, 100]
const showTaskPaginationControl = ref(isTaskPage.value)

watch(
  () => route.path,
  (path, oldPath) => {
    const nextIsTaskPage = path.startsWith('/task')
    const previousIsTaskPage = oldPath?.startsWith('/task') ?? nextIsTaskPage
    if (!nextIsTaskPage) {
      showTaskPaginationControl.value = false
      return
    }
    if (previousIsTaskPage) {
      showTaskPaginationControl.value = true
    } else {
      showTaskPaginationControl.value = false
    }
  },
)

function handleMainContentBeforeEnter() {
  if (isTaskPage.value) {
    showTaskPaginationControl.value = true
  }
}

// ── Auto-shutdown countdown state ──────────────────────────────────
const showShutdownCountdown = ref(false)
const shutdownCountdown = ref(60)
let shutdownTimer: ReturnType<typeof setInterval> | null = null
let unlistenPowerCountdown: (() => void) | null = null

const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

let unlistenDragDrop: (() => void) | null = null
let unlistenMenuEvent: (() => void) | null = null
let unlistenCloseRequested: (() => void) | null = null
let unlistenDeepLink: (() => void) | null = null
let unlistenSingleInstance: (() => void) | null = null
let unlistenTrayMenu: (() => void) | null = null
let unlistenResize: (() => void) | null = null
let unlistenExitDialog: (() => void) | null = null
let unlistenStat: (() => void) | null = null
let unlistenTaskMonitor: Array<() => void> = []
let unlistenAria2DownloadPause: (() => void) | null = null
let unlistenFocusRecheck: (() => void) | null = null
let unlistenAppToast: (() => void) | null = null

// ── Notification action helpers (reuse existing IPC commands) ────────

/**
 * Open the downloaded file with the system's default application.
 *
 * Reuses the same IPC commands as TaskItem's "Open File" context menu:
 *   - `resolveOpenTarget()` for smart path resolution (BT multi-file → subdir)
 *   - `check_path_exists` to guard against deleted files
 *   - `open_path_normalized` to invoke the system opener
 */
async function openFileFromNotification(task: Aria2Task) {
  const { invoke } = await import('@tauri-apps/api/core')
  const target = await resolveOpenTarget(task)
  if (!target) return
  try {
    const fileExists = await invoke<boolean>('check_path_exists', { path: target })
    if (!fileExists) {
      message.warning(t('task.file-not-exist'))
      requestFileRecheck()
      return
    }
    const isDir = await invoke<boolean>('check_path_is_dir', { path: target })
    await invoke('open_path_normalized', { path: target })
    message.success(t(isDir ? 'task.open-file-is-folder' : 'task.open-file-success'))
  } catch (e) {
    logger.warn('Notification.openFile', e instanceof Error ? e.message : String(e))
    message.warning(t('task.file-not-exist'))
    requestFileRecheck()
  }
}

/**
 * Reveal the downloaded file in the system file manager.
 *
 * Reuses the same IPC commands as TaskItem's "Show in Folder" context menu:
 *   - `check_path_exists` to guard against deleted files
 *   - `show_item_in_dir` to invoke the platform-native file reveal
 */
async function showInFolderFromNotification(task: Aria2Task) {
  const { invoke } = await import('@tauri-apps/api/core')

  // Resolve correct path — archived location takes priority over aria2 original
  const filePath = resolveTaskFilePath(task)

  if (!filePath) return
  try {
    const fileExists = await invoke<boolean>('check_path_exists', { path: filePath })
    if (fileExists) {
      await invoke('show_item_in_dir', { path: filePath })
      message.success(t('task.open-folder-success'))
      return
    }
    // Fallback: file missing but BT folder or download dir may still exist
    const fallback = await resolveOpenTarget(task)
    if (fallback) {
      const fallbackExists = await invoke<boolean>('check_path_exists', { path: fallback })
      if (fallbackExists) {
        await invoke('show_item_in_dir', { path: fallback })
        message.success(t('task.open-folder-success'))
        return
      }
    }
    message.warning(t('task.file-not-exist'))
    requestFileRecheck()
  } catch (e) {
    logger.warn('Notification.showInFolder', e instanceof Error ? e.message : String(e))
    message.warning(t('task.file-not-exist'))
    requestFileRecheck()
  }
}

const addTaskClosing = ref(false)
watch(
  () => appStore.addTaskVisible,
  (visible, previous) => {
    if (!visible && previous) addTaskClosing.value = true
  },
)

const { setupListeners } = useAppEvents({
  t,
  appStore,
  taskStore,
  preferenceStore,
  message,
  navDialog,
  handleExitConfirm,
  onAbout: () => {
    showAbout.value = true
  },
})

function startAppToastListener() {
  stopAppToastListener()
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ type?: string; key?: string }>).detail
    if (!detail?.key) return
    const text = t(detail.key)
    if (detail.type === 'error') message.error(text)
    else if (detail.type === 'warning') message.warning(text)
    else if (detail.type === 'info') message.info(text)
    else message.success(text)
  }
  window.addEventListener('app:toast', handler)
  unlistenAppToast = () => window.removeEventListener('app:toast', handler)
}

function stopAppToastListener() {
  unlistenAppToast?.()
  unlistenAppToast = null
}

// ── Stat listener — passive subscription to Rust stat_service events ──
// Replaces the old frontend polling loop. Rust is the sole poller of aria2;
// the frontend simply listens for `stat:update` and updates reactive state.

async function startStatListener() {
  stopStatListener()
  unlistenStat = await appStore.setupStatListener()
}

function stopStatListener() {
  unlistenStat?.()
  unlistenStat = null
}

// Native pause events refresh the same snapshot used by the selection queue.
async function startAria2DownloadPauseListener() {
  stopAria2DownloadPauseListener()
  unlistenAria2DownloadPause = await listen<{ gid: string }>('aria2-event:download-pause', async ({ payload }) => {
    try {
      await btSelection.classifyPending(payload.gid)
    } catch (error) {
      logger.error('BtSelection.classify', error)
      message.error(t('task.magnet-select-fail'))
    }
    await taskStore.fetchList()
  })
}
function stopAria2DownloadPauseListener() {
  unlistenAria2DownloadPause?.()
  unlistenAria2DownloadPause = null
}

watch(
  () => engineStore.isReady,
  (ready) => {
    if (ready) void taskStore.fetchList()
  },
  { immediate: true },
)

/**
 * Handle the maximize-toggled event from WindowControls.
 * Query isMaximized() after a delay to let the native animation settle.
 * This is safe on all platforms — the bug only triggers inside onResized.
 */
async function onMaximizeToggled() {
  setTimeout(async () => {
    const appWindow = getCurrentWindow()
    isMaximized.value = await appWindow.isMaximized()
  }, 300)
}

watch(
  () => appStore.pendingUpdate,
  (update) => {
    if (update) {
      nextTick(() => updateDialogRef.value?.present(update))
      appStore.pendingUpdate = null
    }
  },
)

watch(
  () => appStore.updateCheckRequestId,
  (requestId) => {
    if (requestId > 0) {
      nextTick(() => updateDialogRef.value?.open())
    }
  },
)

async function handleExitConfirm() {
  // Checkbox means "always minimize to tray from now on" —
  // save the setting even when quitting this time.
  if (rememberChoice.value) {
    preferenceStore.config.minimizeToTrayOnClose = true
    await preferenceStore.savePreference()
  }
  isExiting.value = true
  showExitDialog.value = false
  rememberChoice.value = false

  // Hide the window and let the OS play its native close animation
  // (DWM fade on Windows, AppKit transition on macOS, compositor
  // effect on Linux).  No custom CSS or alpha animation needed.
  const appWindow = getCurrentWindow()
  await appWindow.hide()

  // exit(0) sends an IPC call to Rust — if we destroy() first,
  // the webview is gone and the IPC silently fails.
  const { exit } = await import('@tauri-apps/plugin-process')
  await exit(0)
}

async function handleMinimizeToTray() {
  if (rememberChoice.value) {
    preferenceStore.config.minimizeToTrayOnClose = true
    await preferenceStore.savePreference()
  }
  // Defer window hide until NModal exit animation completes.
  // If we hide immediately, the GPU compositor caches the frame with
  // the dialog still visible, causing a flash when the window re-shows.
  pendingTrayHide.value = true
  showExitDialog.value = false
  rememberChoice.value = false
}

async function onExitDialogAfterLeave() {
  if (pendingTrayHide.value) {
    pendingTrayHide.value = false
    const appWindow = getCurrentWindow()

    // Signal Rust to hide the Dock icon if the user opted in.
    // The Rust command reads the preference from the persistent store.
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_dock_visible', { visible: false })

    await appWindow.hide()
  }
}

function handleExitCancel() {
  showExitDialog.value = false
  rememberChoice.value = false
}

// ── Auto-shutdown countdown ─────────────────────────────────────────

function startShutdownCountdown() {
  if (showShutdownCountdown.value) return
  shutdownCountdown.value = 60
  showShutdownCountdown.value = true

  // Bring window to front so the user sees the countdown
  const countdownWindow = getCurrentWindow()
  countdownWindow.unminimize().catch(() => {})
  countdownWindow.show().catch(() => {})
  countdownWindow.setFocus().catch(() => {})

  shutdownTimer = setInterval(async () => {
    shutdownCountdown.value--
    if (shutdownCountdown.value <= 0) {
      dismissCountdown()
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('system_shutdown')
      } catch (e) {
        logger.error('Power.shutdown', e instanceof Error ? e.message : String(e))
        message.error(t('app.shutdown-failed'))
      }
    }
  }, 1000)
}

/** Shared countdown teardown — stops timer and hides dialog. */
function dismissCountdown() {
  showShutdownCountdown.value = false
  if (shutdownTimer) {
    clearInterval(shutdownTimer)
    shutdownTimer = null
  }
  // Signal Rust safety-net to skip this shutdown cycle.
  import('@tauri-apps/api/core').then(({ invoke }) =>
    invoke('cancel_shutdown').catch((e: unknown) => logger.debug('Power.cancel', String(e))),
  )
}

/** "Disable Auto-Shutdown" button — turns off the preference permanently. */
function disableShutdownAndCancel() {
  dismissCountdown()
  preferenceStore.updateAndSave({ shutdownWhenComplete: false })
}

/** "Skip This Time" button — cancels only the current countdown. */
function skipShutdownOnce() {
  dismissCountdown()
}

/**
 * Event-driven shutdown condition check.
 *
 * Called from lifecycle callbacks instead
 * of a stat watcher. Queries aria2 directly for real-time task state,
 * bypassing the stale taskStore.taskList and the unreliable
 * appStore.stat.numActive (which counts seeders as active).
 */
async function checkShutdownCondition() {
  if (!preferenceStore.config.shutdownWhenComplete) return
  if (showShutdownCountdown.value) return

  try {
    const activeTasks = await aria2Api.fetchTaskList({ type: 'active' })
    const activeDownloads = activeTasks.filter((t) => !checkTaskIsSharing(t))
    if (activeDownloads.length > 0) return

    const waitingTasks = await aria2Api.fetchTaskList({ type: 'waiting' })
    if (waitingTasks.length > 0) return

    startShutdownCountdown()
  } catch (e) {
    logger.debug('Power.checkCondition', e instanceof Error ? e.message : String(e))
  }
}

onMounted(async () => {
  startAppToastListener()
  // Platform is initialised by usePlatform() singleton — no per-component call needed.

  // Show the main window now that the frontend has mounted and the
  // webview has renderable content.  This prevents the transparent-frame
  // flash on Windows where DWM renders a native shadow before WebView2
  // finishes initializing.  Follows Tauri official recommendation:
  // visible:false in config → show() from frontend when content is ready.
  //
  // Skip show when the app was launched by OS autostart AND the user has
  // opted into "minimize to tray on autostart" — the window stays hidden.
  //
  // Architecture (two-layer defense-in-depth):
  //   1. PRIMARY: Rust setup_app() force-hides the window synchronously
  //      before the frontend mounts (see lib.rs autostart silent-mode guard).
  //   2. SECONDARY: This frontend check acts as a safety net.  If the
  //      --autostart flag was lost (auto-launch crate #771) or if a
  //      window-state plugin update re-introduces VISIBLE restoration,
  //      this code detects and corrects the state.
  //
  // NOTE: The Rust backend logs the same detection at INFO level in
  // setup_app().  Both logs together provide a full diagnostic trace for
  // autostart bugs (e.g. --autostart flag missing on Windows cold boot).

  {
    const { invoke } = await import('@tauri-apps/api/core')
    const isAutostart: boolean = await invoke('is_autostart_launch')
    const silentPendingDeepLinks = await invoke<boolean>('peek_pending_deep_links_silent')
    const silentPendingExternalInputs = await invoke<boolean>('peek_pending_external_inputs_silent')
    // Read autoHideWindow directly from the same Tauri persistent store
    // used by the Rust setup() guard. This keeps the frontend safety net
    // aligned with the native cold-start decision, including WebView
    // recreation in lightweight mode.
    const { load } = await import('@tauri-apps/plugin-store')
    const tauriStore = await load('config.json')
    const prefs = await tauriStore.get<Record<string, unknown>>('preferences')
    const autoHide = !!(prefs?.autoHideWindow ?? false)
    const silentExternalInput = silentPendingDeepLinks || silentPendingExternalInputs
    const shouldHide = (isAutostart && autoHide) || silentExternalInput
    logger.info(
      'MainLayout.windowVisibility',
      `autostart=${isAutostart} autoHide=${autoHide} silentDeepLinks=${silentPendingDeepLinks} silentExternalInputs=${silentPendingExternalInputs} -> shouldHide=${shouldHide}`,
    )
    if (!shouldHide) {
      const appWindow = getCurrentWindow()
      await appWindow.show()
      await appWindow.setFocus()
    } else {
      // Defense-in-depth: if the window is somehow visible despite the
      // Rust-layer guard (e.g. --autostart flag lost, window-state race),
      // force-hide it now.  Log a warning so the root cause can be
      // investigated from user-submitted logs.
      const appWindow = getCurrentWindow()
      const visible = await appWindow.isVisible()
      if (visible) {
        logger.warn(
          'MainLayout.windowVisibility',
          'window unexpectedly visible during autostart silent mode — forcing hide',
        )
        await appWindow.hide()
      }
    }
  }

  startStatListener()
  await startAria2DownloadPauseListener()

  // ── Auto-shutdown event from Rust monitor (lightweight mode fallback) ──
  unlistenPowerCountdown = await listen('power:countdown', () => {
    startShutdownCountdown()
  })

  // ── Task lifecycle reactions (driven by native Aria2 Next events) ─
  // Rust persists lifecycle records before emitting these UI events. The
  // frontend owns in-app toasts, auto-archive moves, and torrent cleanup.
  const historyStore = useHistoryStore()

  // ── Pre-populate task birth timestamps from DB ──────────────────
  // Ensures position-stable ordering survives app restarts.
  try {
    const birthRecords = await historyStore.loadBirthRecords()
    loadAddedAtFromRecords(birthRecords)
    // Also load from download_history.added_at for completed tasks
    // whose task_birth entry may have been cleaned up.
    const historyRecords = await historyStore.getRecords()
    loadAddedAtFromRecords(historyRecords)
  } catch (e) {
    logger.debug('TaskOrder.loadBirthRecords', e)
  }

  async function fetchTaskForEvent(gid: string): Promise<Aria2Task | null> {
    try {
      return await aria2Api.fetchTaskItem({ gid })
    } catch (e) {
      logger.debug('Lifecycle.fetchTask', e instanceof Error ? e.message : String(e))
      return null
    }
  }

  async function onTaskError(task: Aria2Task): Promise<void> {
    if (isMetadataTask(task)) return
    taskStore.fetchList().catch((e) => logger.debug('Lifecycle.taskCounts.error', e))
    const i18nKey = task.errorCode ? ARIA2_ERROR_CODES[task.errorCode] : undefined
    const errorText = i18nKey ? t(i18nKey) : task.errorMessage || t('task.error-unknown')
    handleTaskError(task, errorText, {
      messageError: message.error,
      t,
    })
  }

  async function onTaskComplete(task: Aria2Task): Promise<void> {
    if (isMetadataTask(task)) return
    taskStore.fetchList().catch((e) => logger.debug('Lifecycle.taskCounts', e))
    handleTaskComplete(task, {
      messageSuccess: message.success,
      messageError: message.error,
      t,
      onOpenFile: openFileFromNotification,
      onShowInFolder: showInFolderFromNotification,
    })

    // ── Auto-archive: move file to category directory if applicable ──
    logger.debug(
      'AutoArchive.input',
      `gid=${task.gid} enabled=${preferenceStore.config.fileCategoryEnabled} ` +
        `categories=${preferenceStore.config.fileCategories?.length ?? 0} ` +
        `baseDir=${preferenceStore.config.dir}`,
    )
    const archiveAction = resolveArchiveAction(
      task,
      preferenceStore.config.fileCategoryEnabled,
      preferenceStore.config.fileCategories,
      preferenceStore.config.dir,
    )
    if (archiveAction) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const newPath = await invoke<string>('move_file', {
          source: archiveAction.source,
          targetDir: archiveAction.targetDir,
        })
        logger.info('AutoArchive.moved', `${archiveAction.source} → ${newPath}`)

        // Persist the new path so all consumers resolve to the archived location.
        // Runtime Map — effective immediately for this session.
        setArchivedPath(task.gid, newPath)
        // History DB — effective after app restart (meta.files path update).
        updateHistoryFilePath(historyStore, task.gid, archiveAction.source, newPath).catch((e) =>
          logger.debug('AutoArchive.historyUpdate', e),
        )
      } catch (e) {
        // Archive failure is non-critical — file remains at download location
        logger.warn('AutoArchive.failed', e instanceof Error ? e.message : String(e))
      }
    } else {
      logger.debug('AutoArchive.result', `gid=${task.gid} action=none`)
    }

    // ── Auto-shutdown: check after task completion ──
    checkShutdownCondition()
  }

  async function onP2pDownloadComplete(task: Aria2Task, kind: TaskSharingKind): Promise<void> {
    if (!isMetadataTask(task)) {
      taskStore.fetchList().catch((e) => logger.debug('Lifecycle.p2pDownloadComplete.taskCounts', e))
    }
    handleP2pDownloadComplete(task, kind, {
      messageSuccess: message.success,
      messageError: message.error,
      t,
      onOpenFile: openFileFromNotification,
      onShowInFolder: showInFolderFromNotification,
    })

    // ── Auto-shutdown: check after P2P download completion ──
    // Must be BEFORE shouldDeleteTorrent early return to avoid being skipped.
    checkShutdownCondition()

    if (kind !== 'bt') return
    if (!shouldDeleteTorrent(preferenceStore.config)) return
    const sourcePath = taskStore.consumeTorrentSource(task.gid)
    if (sourcePath) {
      const ok = await trashTorrentFile(sourcePath)
      if (ok) {
        const taskName = getTaskName(task)
        message.success(t('task.torrent-trashed', { taskName }))
      }
    }
  }

  unlistenTaskMonitor = [
    await listen<{ gid: string }>('task-monitor:error', async ({ payload }) => {
      const task = await fetchTaskForEvent(payload.gid)
      if (task) await onTaskError(task)
    }),
    await listen<{ gid: string }>('task-monitor:complete', async ({ payload }) => {
      const task = await fetchTaskForEvent(payload.gid)
      if (task) await onTaskComplete(task)
    }),
    await listen<{ gid: string; sharingKind?: TaskSharingKind }>(
      'task-monitor:p2p-download-complete',
      async ({ payload }) => {
        const task = await fetchTaskForEvent(payload.gid)
        if (!task) return
        const kind = payload.sharingKind ?? getTaskSharingKind(task)
        if (kind) await onP2pDownloadComplete(task, kind)
      },
    ),
  ]

  // ── Window-focus file-existence recheck ─────────────────────────────
  // When the user switches back from Finder / Explorer after deleting a
  // file, the focus event bumps recheckTrigger so visible TaskItems
  // re-run check_path_exists.  Zero polling overhead.
  unlistenFocusRecheck = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) {
      requestFileRecheck()
      void taskStore.fetchList()
    }
  })

  // Track maximize state for WindowControls icon toggle (maximize ↔ restore).
  // macOS: skipped — native traffic lights handle this; isMaximized() inside
  // onResized triggers an infinite loop (tauri-apps/tauri#5812).
  if (!isMac.value) {
    const appWindow = getCurrentWindow()
    isMaximized.value = await appWindow.isMaximized()
    unlistenResize = await appWindow.onResized(() => {
      throttledResizeHandler(async () => {
        isMaximized.value = await appWindow.isMaximized()
      })
    })
  }

  // Engine-init feedback, navigation guards, IPC listeners, and crash recovery
  // are encapsulated in the useAppEvents composable.
  const listeners = await setupListeners()
  unlistenDragDrop = listeners.unlistenDragDrop
  unlistenMenuEvent = listeners.unlistenMenuEvent
  unlistenTrayMenu = listeners.unlistenTrayMenu
  unlistenDeepLink = listeners.unlistenDeepLink
  unlistenSingleInstance = listeners.unlistenSingleInstance

  const appWindow = getCurrentWindow()
  // Close prevention: both JS event.preventDefault() and Rust
  // api.prevent_close() are needed for reliable interception across
  // all close paths (native traffic light, Cmd+W, taskbar close).
  unlistenCloseRequested = await appWindow.onCloseRequested(async (event) => {
    // With native decorations (macOS overlay), the JS handler MUST call
    // preventDefault() to prevent the native close.  The Rust on_window_event
    // handler calls api.prevent_close() as a parallel safeguard.
    event.preventDefault()
    // Rust on_window_event handles the full close flow:
    // - minimizeToTrayOnClose=true → handle_minimize_to_tray (hide or destroy)
    // - minimizeToTrayOnClose=false → emit("show-exit-dialog")
    // This JS path is a fallback for platforms where the Rust event may
    // not reliably fire (e.g. macOS traffic-light with overlay titlebar).
    if (preferenceStore.config.minimizeToTrayOnClose) return
    if (!isExiting.value) {
      rememberChoice.value = !!preferenceStore.config.minimizeToTrayOnClose
      showExitDialog.value = true
    }
  })

  // Rust emits "show-exit-dialog" when the native close is intercepted
  // and minimize-to-tray is NOT enabled. This is more reliable than the
  // JS onCloseRequested listener on Linux/Wayland with decorations:false,
  // where certain close paths (taskbar close, GNOME overview ×) do not
  // trigger the webview callback.
  unlistenExitDialog = await listen('show-exit-dialog', () => {
    if (!isExiting.value) {
      showExitDialog.value = true
    }
  })

  // Sync native menu labels with current locale
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('update_tray_menu_labels', {
      labels: {
        show: t('app.show'),
        'tray-new-task': t('app.tray-new-task'),
        'tray-resume-all': t('app.tray-resume-all'),
        'tray-pause-all': t('app.tray-pause-all'),
        'tray-quit': t('app.quit'),
      },
    })
    await invoke('update_menu_labels', {
      labels: {
        // Custom menu items (matched by ID)
        about: t('app.menu-about'),
        'new-task': t('app.menu-new-task'),
        'open-torrent': t('app.menu-open-torrent'),
        preferences: t('app.menu-preferences'),
        'release-notes': t('app.menu-release-notes'),
        'report-issue': t('app.menu-report-issue'),
        'minimize-window': t('app.menu-minimize'),
        'zoom-window': t('app.menu-zoom'),
        'close-window': t('app.menu-close-window'),
        // Submenu titles (matched by ID)
        'file-menu': t('app.menu-file'),
        'edit-menu': t('app.menu-edit'),
        'window-menu': t('app.menu-window'),
        'help-menu': t('app.menu-help'),
        // PredefinedMenuItems — keyed by English default text because
        // their IDs are auto-generated UUIDs that cannot be predicted.
        Undo: t('app.menu-undo'),
        Redo: t('app.menu-redo'),
        Cut: t('app.menu-cut'),
        Copy: t('app.menu-copy'),
        Paste: t('app.menu-paste'),
        'Select All': t('app.menu-select-all'),
        'Hide Rayburst': t('app.hide'),
        'Hide Others': t('app.hide-others'),
        'Show All': t('app.unhide'),
        'Quit Rayburst': t('app.quit'),
      },
    })
  } catch (e) {
    logger.debug('MainLayout.trayMenu', e)
  }
})

onUnmounted(() => {
  stopStatListener()
  stopAria2DownloadPauseListener()
  unlistenTaskMonitor.forEach((fn) => fn())
  unlistenTaskMonitor = []
  if (unlistenFocusRecheck) unlistenFocusRecheck()
  if (unlistenDragDrop) unlistenDragDrop()
  if (unlistenMenuEvent) unlistenMenuEvent()
  if (unlistenCloseRequested) unlistenCloseRequested()
  if (unlistenDeepLink) unlistenDeepLink()
  if (unlistenSingleInstance) unlistenSingleInstance()
  if (unlistenTrayMenu) unlistenTrayMenu()
  if (unlistenResize) unlistenResize()
  if (unlistenExitDialog) unlistenExitDialog()
  if (unlistenPowerCountdown) unlistenPowerCountdown()
  stopAppToastListener()
  dismissCountdown()
  cancelPendingResize()
})
</script>

<template>
  <div id="container" :class="{ 'native-frame': isMac }">
    <!-- Minimal progress bar during engine initialization / restart -->
    <Transition name="engine-slide">
      <div v-if="engineStore.isBusy" class="engine-banner">
        <div class="engine-progress" />
      </div>
    </Transition>
    <AsideBar @show-about="showAbout = true" />
    <div class="subnav-slot">
      <Transition name="fade" mode="out-in">
        <TaskSubnav v-if="isTaskPage" key="task-subnav" />
        <PreferenceSubnav v-else-if="isPreferencePage" key="pref-subnav" />
      </Transition>
    </div>
    <main class="content">
      <router-view v-slot="{ Component, route: viewRoute }">
        <Transition name="fade" mode="out-in" appear @before-enter="handleMainContentBeforeEnter">
          <component :is="Component" :key="viewRoute.path" />
        </Transition>
      </router-view>
    </main>
    <WindowControls
      class="window-controls"
      :is-maximized="isMaximized"
      :platform="currentPlatform"
      @close="showExitDialog = true"
      @maximize-toggled="onMaximizeToggled"
    />
    <Speedometer />
    <Transition name="bottom-accessory">
      <div v-if="showTaskPaginationControl" class="task-pagination-control">
        <NPagination
          :page="taskPaginationPage"
          :page-size="taskPaginationPageSize"
          :page-count="taskPaginationPageCount"
          :page-sizes="taskPaginationPageSizes"
          size="small"
          show-size-picker
          @update:page="taskStore.setCurrentTaskPage"
          @update:page-size="taskStore.setTaskPageSize"
        />
      </div>
    </Transition>
    <AboutPanel :show="showAbout" @close="showAbout = false" />
    <AddTask
      :show="appStore.addTaskVisible"
      @close="appStore.hideAddTaskDialog()"
      @after-leave="addTaskClosing = false"
    />
    <UpdateDialog ref="updateDialogRef" />
    <EngineRecoveryDialog />
    <TaskSelectionHost
      :blocked="
        appStore.addTaskVisible ||
        addTaskClosing ||
        taskStore.taskDetailVisible ||
        taskStore.taskDetailClosing ||
        showAbout ||
        showExitDialog ||
        engineStore.isBusy
      "
    />

    <!-- Close action dialog: minimize-to-tray / quit / cancel -->
    <NModal
      :show="showExitDialog"
      preset="dialog"
      type="default"
      :title="t('app.close-action-title')"
      :closable="true"
      :mask-closable="true"
      style="width: 480px"
      transform-origin="center"
      @after-leave="onExitDialogAfterLeave"
      @update:show="
        (v: boolean) => {
          if (!v) handleExitCancel()
        }
      "
    >
      <span>{{ t('app.close-action-message') }}</span>
      <div class="remember-choice">
        <NCheckbox v-model:checked="rememberChoice">
          {{ t('app.remember-close-choice') }}
        </NCheckbox>
      </div>
      <template #action>
        <NButton class="exit-btn" @click="handleExitCancel">
          {{ t('app.cancel') }}
        </NButton>
        <NButton class="exit-btn" @click="handleMinimizeToTray">
          {{ t('app.minimize-to-tray') }}
        </NButton>
        <NButton class="exit-btn" type="primary" @click="handleExitConfirm">
          {{ t('app.quit-app') }}
        </NButton>
      </template>
    </NModal>

    <NModal
      :show="showShutdownCountdown"
      preset="dialog"
      type="warning"
      :title="t('app.shutdown-countdown-title')"
      :closable="false"
      :mask-closable="false"
      style="width: 480px"
      transform-origin="center"
      :positive-text="t('app.shutdown-skip-once')"
      :negative-text="t('app.shutdown-disable')"
      @positive-click="skipShutdownOnce"
      @negative-click="disableShutdownAndCancel"
    >
      <span>{{ t('app.shutdown-countdown-message', { seconds: shutdownCountdown }) }}</span>
      <NProgress
        type="line"
        :percentage="(shutdownCountdown / 60) * 100"
        :show-indicator="false"
        style="margin-top: 12px"
      />
    </NModal>
  </div>
</template>

<style scoped>
#container {
  display: flex;
  height: 100vh;
  position: relative;
  overflow: hidden;
}
.subnav-slot {
  width: var(--subnav-width);
  flex-shrink: 0;
  background-color: var(--subnav-bg);
  transition: width 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background-color: var(--main-bg);
}
.window-controls {
  z-index: 100;
}
.task-pagination-control {
  position: fixed;
  left: calc(var(--aside-width) + var(--subnav-width) + 36px);
  bottom: 16px;
  z-index: 20;
  min-height: 36px;
  padding: 3px 6px;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 12px;
  background: var(--m3-surface-container);
  max-width: calc(100vw - var(--aside-width) - var(--subnav-width) - 280px);
  overflow: hidden;
}
.bottom-accessory-enter-active {
  transition:
    opacity 0.18s cubic-bezier(0.2, 0, 0, 1),
    transform 0.18s cubic-bezier(0.2, 0, 0, 1);
}
.bottom-accessory-leave-active {
  pointer-events: none;
  transition:
    opacity 0.12s cubic-bezier(0.3, 0, 0.8, 0.15),
    transform 0.12s cubic-bezier(0.3, 0, 0.8, 0.15);
}
.bottom-accessory-enter-from,
.bottom-accessory-leave-to {
  opacity: 0;
  transform: scale(0.985);
}

.exit-btn {
  min-width: 88px;
  padding: 0 20px;
}
.remember-choice {
  margin-top: 16px;
  margin-bottom: 8px;
  display: flex;
  justify-content: flex-start;
  font-size: 13px;
  opacity: 0.85;
}

/* Minimal progress bar during engine initialization / restart */
.engine-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  z-index: 200;
  overflow: hidden;
  pointer-events: none;
}
.engine-progress {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  width: 30%;
  background: linear-gradient(90deg, transparent, var(--m3-primary), transparent);
  animation: engine-indeterminate 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  will-change: transform;
  contain: layout style paint;
}
@keyframes engine-indeterminate {
  0% {
    left: -30%;
  }
  100% {
    left: 100%;
  }
}

@media (max-width: 799px) {
  .subnav-slot {
    width: var(--subnav-width-compact);
  }
  .task-pagination-control {
    left: calc(var(--aside-width) + var(--subnav-width-compact) + 36px);
    max-width: calc(100vw - var(--aside-width) - var(--subnav-width-compact) - 280px);
  }
}

@media (max-width: 600px) {
  .subnav-slot {
    display: none;
  }
  .task-pagination-control {
    left: calc(var(--aside-width) + 24px);
    max-width: calc(100vw - var(--aside-width) - 268px);
  }
}

.engine-slide-enter-active {
  transition:
    transform 0.25s cubic-bezier(0, 0, 0, 1),
    opacity 0.2s linear;
}
.engine-slide-leave-active {
  transition:
    transform 0.2s cubic-bezier(0.3, 0, 1, 1),
    opacity 0.15s linear;
}
.engine-slide-enter-from,
.engine-slide-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
</style>
