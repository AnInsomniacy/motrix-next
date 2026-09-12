import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, reactive } from 'vue'
import { mount } from '@vue/test-utils'

const listenMock = vi.fn()
const invokeMock = vi.fn()
const routerBeforeEachMock = vi.fn()
const dragDropListenerMock = vi.fn()
const openDialogMock = vi.fn()
const openUrlMock = vi.fn()
const windowApiMock = vi.hoisted(() => ({
  unminimize: vi.fn(),
  show: vi.fn(),
  setFocus: vi.fn(),
  isVisible: vi.fn(),
}))
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}))

let eventUnlisteners: Array<ReturnType<typeof vi.fn>> = []
let eventCallbacks: Record<string, (event: { payload: unknown }) => unknown> = {}

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (...args: unknown[]) => dragDropListenerMock(...args),
  }),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowApiMock,
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => openDialogMock(...args),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    beforeEach: (...args: unknown[]) => routerBeforeEachMock(...args),
    push: vi.fn().mockResolvedValue(undefined),
  }),
  useRoute: () => ({
    path: '/task/all',
  }),
}))

vi.mock('@/api/aria2', () => ({
  isEngineReady: vi.fn(() => true),
}))

vi.mock('@shared/logger', () => ({
  logger: loggerMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

import { useAppEvents } from '../useAppEvents'

type UseAppEventsDeps = Parameters<typeof useAppEvents>[0]

function createDeps() {
  const appStore = reactive({
    showAddTaskDialog: vi.fn(),
    enqueueBatch: vi.fn(() => 0),
    handleDeepLinkUrls: vi.fn(),
    handleExternalInputs: vi.fn(),
    setExternalInputErrorHandler: vi.fn(),
    setExternalInputStartHandler: vi.fn(),
    addTaskVisible: false,
    pendingBatch: [] as unknown[],
    pendingMagnetGids: [] as string[],
    externalInputSubmitting: false,
  })
  const taskStore = reactive({
    taskList: [] as unknown[],
    hasPausedTasks: vi.fn().mockResolvedValue(false),
    hasActiveTasks: vi.fn().mockResolvedValue(false),
    resumeAllTask: vi.fn().mockResolvedValue(undefined),
    pauseAllTask: vi.fn().mockResolvedValue(undefined),
    fetchList: vi.fn().mockResolvedValue(undefined),
  })
  const preferenceStore = reactive({
    pendingChanges: false,
    saveBeforeLeave: null as (() => Promise<void>) | null,
    updatePreference: vi.fn(),
    config: {
      rpcListenPort: 29100,
      rpcSecret: '',
      lightweightMode: false,
    },
  })
  const message = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }
  const navDialog = {
    warning: vi.fn(),
  }

  const deps: UseAppEventsDeps = {
    t: (key) => key,
    appStore,
    taskStore,
    preferenceStore,
    message,
    navDialog: navDialog as never,
    handleExitConfirm: vi.fn().mockResolvedValue(undefined),
    onAbout: vi.fn(),
  }

  return { deps, appStore, taskStore, message }
}

function mountComposable(deps: UseAppEventsDeps) {
  let setupListeners!: ReturnType<typeof useAppEvents>['setupListeners']
  const wrapper = mount(
    defineComponent({
      setup() {
        setupListeners = useAppEvents(deps).setupListeners
        return {}
      },
      template: '<div />',
    }),
  )

  return {
    wrapper,
    setupListeners,
    unmount: () => wrapper.unmount(),
  }
}

describe('useAppEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventUnlisteners = []
    eventCallbacks = {}

    windowApiMock.unminimize.mockResolvedValue(undefined)
    windowApiMock.show.mockResolvedValue(undefined)
    windowApiMock.setFocus.mockResolvedValue(undefined)
    windowApiMock.isVisible.mockResolvedValue(false)

    listenMock.mockImplementation(async (eventName: string, callback?: (event: { payload: unknown }) => unknown) => {
      const unlisten = vi.fn().mockName(`unlisten:${eventName}`)
      eventUnlisteners.push(unlisten)
      if (callback) {
        eventCallbacks[eventName] = callback
      }
      return unlisten
    })
    routerBeforeEachMock.mockImplementation(() => vi.fn().mockName('remove-nav-guard'))
    dragDropListenerMock.mockImplementation(async () => vi.fn().mockName('unlisten:drag-drop'))
    openDialogMock.mockResolvedValue(null)
    openUrlMock.mockResolvedValue(undefined)
    invokeMock.mockResolvedValue([])
  })

  it('returns a teardown that unregisters event listeners and the router guard', async () => {
    const { deps } = createDeps()
    const { setupListeners } = mountComposable(deps)

    const listeners = await setupListeners()
    expect(typeof (listeners as { teardown?: unknown }).teardown).toBe('function')
    ;(listeners as { teardown: () => void }).teardown()
    expect(routerBeforeEachMock).toHaveBeenCalledTimes(1)

    for (const unlisten of eventUnlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1)
    }

    const removeGuard = routerBeforeEachMock.mock.results[0]?.value as (() => void) | undefined
    expect(removeGuard).toBeDefined()
    expect(removeGuard).toHaveBeenCalledTimes(1)
  })

  it('cleans up listeners automatically on component unmount', async () => {
    const { deps } = createDeps()
    const { setupListeners, unmount } = mountComposable(deps)

    await setupListeners()
    unmount()

    for (const unlisten of eventUnlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1)
    }

    const removeGuard = routerBeforeEachMock.mock.results[0]?.value as (() => void) | undefined
    expect(removeGuard).toBeDefined()
    expect(removeGuard).toHaveBeenCalledTimes(1)
  })

  it('keeps task data intact while task route tabs switch', async () => {
    const { deps, taskStore } = createDeps()
    taskStore.taskList = [{ gid: 'old-1' }, { gid: 'old-2' }]
    const { setupListeners } = mountComposable(deps)

    await setupListeners()

    const guard = routerBeforeEachMock.mock.calls[0]?.[0] as
      | ((
          to: { name: string; params: { status: string }; path: string },
          from: { name: string; params: { status: string }; path: string },
        ) => unknown)
      | undefined
    expect(guard).toBeDefined()

    guard?.(
      { name: 'task', params: { status: 'active' }, path: '/task/active' },
      { name: 'task', params: { status: 'all' }, path: '/task/all' },
    )

    expect(taskStore.taskList).toEqual([{ gid: 'old-1' }, { gid: 'old-2' }])
  })

  it('does not process external input when the Rust pending queue is empty', async () => {
    const { deps, appStore } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()

    expect(invokeMock).toHaveBeenCalledWith('take_pending_deep_links')
    expect(appStore.handleDeepLinkUrls).not.toHaveBeenCalled()
  })

  it('processes external input drained from the Rust pending queue once listeners are ready', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'take_pending_deep_links')
        return { urls: ['file:///Users/example/ubuntu.torrent'], silent: false }
      return []
    })
    const { deps, appStore } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()

    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledTimes(1)
    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledWith(['file:///Users/example/ubuntu.torrent'])
  })

  it('routes silent pending input without showing or focusing the window', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'take_pending_deep_links') {
        return {
          urls: ['motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip'],
          silent: true,
        }
      }
      return []
    })
    const { deps, appStore } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()

    expect(windowApiMock.unminimize).not.toHaveBeenCalled()
    expect(windowApiMock.show).not.toHaveBeenCalled()
    expect(windowApiMock.setFocus).not.toHaveBeenCalled()
    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledWith([
      'motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip',
    ])
  })

  it('routes silent live deep-link events without showing or focusing the window', async () => {
    const deepLink = 'motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip'
    const { deps, appStore } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    await eventCallbacks['deep-link-open']?.({ payload: { urls: [deepLink], silent: true } })

    expect(windowApiMock.unminimize).not.toHaveBeenCalled()
    expect(windowApiMock.show).not.toHaveBeenCalled()
    expect(windowApiMock.setFocus).not.toHaveBeenCalled()
    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledWith([deepLink])
  })

  it('shows localized readable text for external input auto-submit errors', async () => {
    const { deps, appStore, message } = createDeps()

    mountComposable(deps)

    const handler = appStore.setExternalInputErrorHandler.mock.calls[0][0] as (error: unknown) => void
    handler({ Aria2: 'aria2 RPC error [1]: Unsupported URI scheme' })

    expect(message.error).toHaveBeenCalledWith('task.error-aria2-next [1]: Unsupported URI scheme', {
      closable: true,
    })
  })

  it('keeps the external input start handler registered after listener setup', async () => {
    const { deps, appStore, message } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    invokeMock.mockClear()
    const lastCall = appStore.setExternalInputStartHandler.mock.lastCall
    const handler = lastCall?.[0] as ((taskNames: string[]) => void) | null | undefined

    expect(typeof handler).toBe('function')

    handler?.(['file.zip'])

    expect(message.info).toHaveBeenCalledWith('task.download-start-message')
  })

  it('keeps the external input error handler registered after listener setup', async () => {
    const { deps, appStore, message } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    const lastCall = appStore.setExternalInputErrorHandler.mock.lastCall
    const handler = lastCall?.[0] as ((error: unknown) => void) | null | undefined

    expect(typeof handler).toBe('function')

    handler?.({ Aria2: 'aria2 RPC error [1]: Unsupported URI scheme' })

    expect(message.error).toHaveBeenCalledWith('task.error-aria2-next [1]: Unsupported URI scheme', {
      closable: true,
    })
  })

  it('shows a toast when local ports are auto-switched', async () => {
    const { deps, message } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    eventCallbacks['port-auto-switched']?.({
      payload: [{ kind: 'bt', oldPort: 29120, newPort: 29800 }],
    })

    expect(message.info).toHaveBeenCalledWith('preferences.port-auto-switched')
    expect(deps.preferenceStore.updatePreference).toHaveBeenCalledWith({
      listenPort: 29800,
    })
  })

  it('updates the ED2K listen port after automatic conflict recovery', async () => {
    const { deps } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    eventCallbacks['port-auto-switched']?.({
      payload: [{ kind: 'ed2k', oldPort: 29140, newPort: 29810 }],
    })

    expect(deps.preferenceStore.updatePreference).toHaveBeenCalledWith({
      ed2kListenPort: 29810,
    })
  })

  it('shows a toast when local port auto-switch recovery fails', async () => {
    const { deps, message } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    eventCallbacks['port-auto-switch-failed']?.({
      payload: {
        kind: 'bt',
        port: 29120,
        reason: 'disabled',
        source: 'bt-runtime',
      },
    })

    expect(message.warning).toHaveBeenCalledWith('preferences.port-auto-switch-disabled')
  })

  it('opens the add-task dialog from a pending tray action after listeners are ready', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'take_pending_frontend_actions') {
        return [{ channel: 'tray-menu-action', action: 'new-task' }]
      }
      return []
    })
    const { deps, appStore } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()

    expect(invokeMock).toHaveBeenCalledWith('take_pending_frontend_actions')
    expect(appStore.showAddTaskDialog).toHaveBeenCalledTimes(1)
  })

  it('continues routing external input when focusing the restored window fails', async () => {
    windowApiMock.setFocus.mockRejectedValueOnce(new Error('focus blocked by OS'))
    const deepLink =
      'motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip&cookie=session%3Dsecret-token&filename=file.zip'
    const { deps, appStore } = createDeps()
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    await eventCallbacks['deep-link-open']?.({ payload: [deepLink] })

    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledTimes(1)
    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledWith([deepLink])
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'ExternalInput',
      'window_stage_failed',
      expect.objectContaining({ stage: 'setFocus', result: 'failed' }),
    )
    expect(loggerMock.info.mock.calls.flat().join(' ')).not.toContain('secret-token')
  })

  it('logs the external input handling result returned by the app store', async () => {
    const deepLink = 'motrixnext:/new?url=https%3A%2F%2Fexample.com%2Ffile.zip'
    const { deps, appStore } = createDeps()
    appStore.handleDeepLinkUrls.mockReturnValueOnce({ received: 1, queued: 1, autoSubmitted: 0, ignored: 0 })
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    await eventCallbacks['deep-link-open']?.({ payload: [deepLink] })

    expect(appStore.handleDeepLinkUrls).toHaveBeenCalledWith([deepLink])
    expect(loggerMock.info).toHaveBeenCalledWith(
      'ExternalInput',
      'download_routing_completed',
      expect.objectContaining({ queued: 1, result: 'ok' }),
    )
  })

  it('attaches the external input trace id before routing structured payloads', async () => {
    const { deps, appStore } = createDeps()
    appStore.handleExternalInputs.mockReturnValueOnce({ received: 1, queued: 1, autoSubmitted: 0, ignored: 0 })
    const { setupListeners } = mountComposable(deps)

    await setupListeners()
    await eventCallbacks['external-input-open']?.({
      payload: {
        inputs: [
          {
            url: 'https://example.com/file.zip?token=secret',
            cookie: 'session=secret',
            userAgent: 'BrowserUA/1.0',
            requestHeaders: [{ name: 'Accept', value: 'application/octet-stream' }],
            source: 'http-api',
          },
        ],
        silent: false,
      },
    })

    expect(appStore.handleExternalInputs).toHaveBeenCalledWith([
      expect.objectContaining({
        url: 'https://example.com/file.zip?token=secret',
        traceId: expect.stringMatching(/^external-input-/),
      }),
    ])
    expect(loggerMock.info.mock.calls.flat().join(' ')).not.toContain('session=secret')
    expect(loggerMock.info.mock.calls.flat().join(' ')).not.toContain('token=secret')
    expect(loggerMock.info.mock.calls.flat().join(' ')).not.toContain('BrowserUA')
  })
})
