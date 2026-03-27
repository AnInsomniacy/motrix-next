/**
 * @fileoverview Composable encapsulating IPC event listeners for MainLayout.
 *
 * Extracted from MainLayout.vue to reduce component script size.
 * Contains handlers for: menu-event, tray-menu-action, deep-link-open,
 * single-instance-triggered, engine-crashed, engine-stopped, and drag-drop.
 */
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useRouter } from 'vue-router'
import { logger } from '@shared/logger'
import { setEngineReady, isEngineReady, reconnectClient } from '@/api/aria2'
import { detectKind, createBatchItem } from '@shared/utils/batchHelpers'
import { watch, type Ref } from 'vue'

interface AppEventsDeps {
  t: (key: string, params?: Record<string, unknown>) => string
  appStore: {
    showAddTaskDialog: () => void
    enqueueBatch: (items: ReturnType<typeof createBatchItem>[]) => number
    handleDeepLinkUrls: (urls: string[]) => void
    engineReady: boolean
    engineInitializing: boolean
  }
  taskStore: {
    taskList: unknown[]
    selectedGidList: string[]
    hasPausedTasks: () => Promise<boolean>
    hasActiveTasks: () => Promise<boolean>
    resumeAllTask: () => Promise<unknown>
    pauseAllTask: () => Promise<unknown>
    fetchList: () => Promise<unknown>
  }
  preferenceStore: {
    pendingChanges: boolean
    saveBeforeLeave: (() => Promise<void>) | null
    config: {
      rpcListenPort?: string | number
      rpcSecret?: string
    }
  }
  message: {
    success: (msg: string) => void
    error: (msg: string, opts?: Record<string, unknown>) => void
    warning: (msg: string) => void
    info: (msg: string, opts?: Record<string, unknown>) => void
  }
  navDialog: ReturnType<typeof import('naive-ui').useDialog>
  showEngineOverlay: Ref<boolean>
  isExiting: Ref<boolean>
  handleExitConfirm: () => Promise<void>
  onAbout: () => void
}

interface AppEventsReturn {
  setupListeners: () => Promise<{
    unlistenDragDrop: (() => void) | null
    unlistenMenuEvent: (() => void) | null
    unlistenTrayMenu: (() => void) | null
    unlistenDeepLink: (() => void) | null
    unlistenSingleInstance: (() => void) | null
  }>
}

export function useAppEvents(deps: AppEventsDeps): AppEventsReturn {
  const {
    t,
    appStore,
    taskStore,
    preferenceStore,
    message,
    navDialog,
    showEngineOverlay,
    isExiting,
    handleExitConfirm,
  } = deps

  const router = useRouter()

  // ─── Engine lifecycle watchers ────────────────────────────────────
  function setupEngineWatchers() {
    listen<{ code: number; signal?: number }>('engine-crashed', (event) => {
      if (isExiting.value) return
      const { code } = event.payload
      logger.error('MainLayout', `engine crashed with code ${code}`)
      appStore.engineReady = false
      setEngineReady(false)
      showEngineOverlay.value = true
    })

    watch(
      () => appStore.engineInitializing,
      (initializing) => {
        if (!initializing) {
          if (appStore.engineReady) {
            message.success(t('app.engine-ready'))
          } else {
            message.error(t('app.engine-failed'), { duration: 8000, closable: true })
          }
        }
      },
    )

    listen<{ source: string }>('engine-recovered', async (event) => {
      logger.info('MainLayout', `engine recovered (source: ${event.payload.source})`)
      const port = Number(preferenceStore.config.rpcListenPort) || 16800
      const secret = preferenceStore.config.rpcSecret || ''

      // Exponential backoff reconnect — same pattern as useEngineRestart.ts.
      // restart_engine() returns after spawn(), before RPC is ready.
      // Allow up to ~5s for aria2 to open its TCP listener.
      const maxRetries = 5
      let lastError: unknown
      for (let i = 0; i < maxRetries; i++) {
        const delay = Math.min(200 * 2 ** i, 2000)
        await new Promise((r) => setTimeout(r, delay))
        try {
          await reconnectClient({ port, secret })
          setEngineReady(true)
          appStore.engineReady = true
          message.success(t('app.engine-recovered'))
          return
        } catch (e) {
          lastError = e
          logger.debug('MainLayout', `engine-recovered reconnect attempt ${i + 1}/${maxRetries} failed: ${e}`)
        }
      }

      // All retries exhausted — engine process may be running but RPC unreachable
      logger.error('MainLayout', `engine-recovered: all ${maxRetries} reconnect attempts failed: ${lastError}`)
      setEngineReady(false)
      appStore.engineReady = false
    })

    listen('engine-stopped', () => {
      message.warning(t('app.engine-stopped'))
    })
  }

  // ─── Navigation guard ─────────────────────────────────────────────
  function setupNavGuard() {
    router.beforeEach((to, from) => {
      if (from.name === 'task' && to.name === 'task' && from.params.status !== to.params.status) {
        taskStore.taskList = []
        taskStore.selectedGidList = []
      }

      const leavingPrefs = from.path.startsWith('/preference') && !to.path.startsWith('/preference')
      const switchingPrefsTab =
        from.path.startsWith('/preference') && to.path.startsWith('/preference') && from.path !== to.path
      if ((leavingPrefs || switchingPrefsTab) && preferenceStore.pendingChanges) {
        return new Promise<boolean>((resolve) => {
          navDialog.warning({
            title: t('preferences.not-saved'),
            content: t('preferences.not-saved-confirm'),
            positiveText: t('preferences.save-and-leave'),
            negativeText: t('preferences.leave-without-saving'),
            onPositiveClick: async () => {
              try {
                if (preferenceStore.saveBeforeLeave) {
                  await preferenceStore.saveBeforeLeave()
                }
                preferenceStore.pendingChanges = false
                resolve(true)
              } catch (e) {
                logger.error('NavGuard', e)
                resolve(false)
              }
            },
            onNegativeClick: () => {
              preferenceStore.pendingChanges = false
              resolve(true)
            },
            onClose: () => {
              resolve(false)
            },
            onMaskClick: () => {
              resolve(false)
            },
          })
        })
      }
      return true
    })
  }

  // ─── Native menu events (macOS menu bar) ──────────────────────────
  async function setupMenuListener() {
    return listen<string>('menu-event', async (event) => {
      const action = event.payload
      switch (action) {
        case 'about':
          deps.onAbout()
          break
        case 'new-task':
          await getCurrentWindow().show()
          await getCurrentWindow().setFocus()
          appStore.showAddTaskDialog()
          break
        case 'open-torrent': {
          const selected = await openDialog({
            multiple: true,
            filters: [{ name: 'Torrent / Metalink', extensions: ['torrent', 'metalink', 'meta4'] }],
          })
          if (typeof selected === 'string') {
            const skipped = appStore.enqueueBatch([createBatchItem(detectKind(selected), selected)])
            if (skipped > 0) message.warning(t('task.duplicate-task'))
          } else if (Array.isArray(selected) && selected.length > 0) {
            const skipped = appStore.enqueueBatch(selected.map((p) => createBatchItem(detectKind(p), p)))
            if (skipped > 0) message.warning(t('task.duplicate-task'))
          }
          break
        }
        case 'preferences':
          router.push('/preference').catch(() => {
            /* duplicate navigation */
          })
          break
        case 'resume-all':
          if (!(await taskStore.hasPausedTasks())) break
          taskStore.resumeAllTask().catch((e) => logger.error('TrayMenu', e))
          break
        case 'pause-all':
          if (!(await taskStore.hasActiveTasks())) break
          taskStore.pauseAllTask().catch((e) => logger.error('TrayMenu', e))
          break
        case 'release-notes':
          openUrl('https://github.com/AnInsomniacy/motrix-next/releases').catch((e) => logger.error('TrayMenu', e))
          break
        case 'report-issue':
          openUrl('https://github.com/AnInsomniacy/motrix-next/issues').catch((e) => logger.error('TrayMenu', e))
          break
      }
    })
  }

  // ─── Tray menu actions (system-tray right-click menu) ──────────────
  async function setupTrayListener() {
    return listen<string>('tray-menu-action', async (event) => {
      const action = event.payload
      const mainWindow = getCurrentWindow()
      switch (action) {
        case 'show':
          await mainWindow.show()
          await mainWindow.setFocus()
          break
        case 'new-task':
          await mainWindow.show()
          await mainWindow.setFocus()
          appStore.showAddTaskDialog()
          break
        case 'resume-all':
          await mainWindow.show()
          await mainWindow.setFocus()
          if (!(await taskStore.hasPausedTasks())) {
            message.info(t('task.no-paused-tasks'))
            break
          }
          if (!isEngineReady()) {
            message.warning(t('app.engine-not-ready'))
          } else {
            navDialog.warning({
              title: t('task.resume-all-task'),
              content: t('task.resume-all-task-confirm') || 'Resume all tasks?',
              positiveText: t('app.yes'),
              negativeText: t('app.no'),
              onPositiveClick: () => {
                taskStore
                  .resumeAllTask()
                  .then(() => message.success(t('task.resume-all-task-success')))
                  .catch(() => message.error(t('task.resume-all-task-fail')))
              },
            })
          }
          break
        case 'pause-all':
          await mainWindow.show()
          await mainWindow.setFocus()
          if (!(await taskStore.hasActiveTasks())) {
            message.info(t('task.no-active-tasks'))
            break
          }
          if (!isEngineReady()) {
            message.warning(t('app.engine-not-ready'))
          } else {
            const d = navDialog.warning({
              title: t('task.pause-all-task'),
              content: t('task.pause-all-task-confirm') || 'Pause all tasks?',
              positiveText: t('app.yes'),
              negativeText: t('app.no'),
              onPositiveClick: () => {
                d.loading = true
                d.negativeButtonProps = { disabled: true }
                d.closable = false
                d.maskClosable = false
                taskStore
                  .pauseAllTask()
                  .then(async () => {
                    await new Promise((r) => setTimeout(r, 500))
                    await taskStore.fetchList()
                    message.success(t('task.pause-all-task-success'))
                    d.destroy()
                  })
                  .catch(() => {
                    message.error(t('task.pause-all-task-fail'))
                    d.destroy()
                  })
                return false
              },
            })
          }
          break
        case 'quit':
          await handleExitConfirm()
          break
      }
    })
  }

  // ─── Drag & drop .torrent / .metalink files ──────────────────────
  async function setupDragDropListener() {
    const webview = getCurrentWebview()
    return webview.onDragDropEvent((event) => {
      if (event.payload.type === 'drop') {
        const paths = event.payload.paths
        const validPaths =
          paths?.filter((p: string) => p.endsWith('.torrent') || p.endsWith('.metalink') || p.endsWith('.meta4')) || []
        if (validPaths.length > 0) {
          const items = validPaths.map((p: string) => createBatchItem(detectKind(p), p))
          const skipped = appStore.enqueueBatch(items)
          if (skipped > 0) message.warning(t('task.duplicate-task'))
        }
      }
    })
  }

  // ─── Deep-link and single-instance listeners ─────────────────────
  async function setupExternalInputListeners() {
    const unlistenDeepLink = await listen<string[]>('deep-link-open', (event) => {
      appStore.handleDeepLinkUrls(event.payload)
    })

    const unlistenSingleInstance = await listen<string[]>('single-instance-triggered', (event) => {
      const argv = event.payload
      const urls = argv.filter(
        (a) =>
          !a.startsWith('-') &&
          (a.includes('://') || a.endsWith('.torrent') || a.endsWith('.metalink') || a.endsWith('.meta4')),
      )
      if (urls.length > 0) appStore.handleDeepLinkUrls(urls)
    })

    return { unlistenDeepLink, unlistenSingleInstance }
  }

  // ─── Orchestrator ─────────────────────────────────────────────────
  async function setupListeners() {
    setupEngineWatchers()
    setupNavGuard()

    const unlistenDragDrop = await setupDragDropListener()
    const unlistenMenuEvent = await setupMenuListener()
    const unlistenTrayMenu = await setupTrayListener()
    const { unlistenDeepLink, unlistenSingleInstance } = await setupExternalInputListeners()

    return { unlistenDragDrop, unlistenMenuEvent, unlistenTrayMenu, unlistenDeepLink, unlistenSingleInstance }
  }

  return { setupListeners }
}
