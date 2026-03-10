import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'

const hoisted = vi.hoisted(() => ({
  route: { path: '/task' },
  eventHandlers: new Map<string, (event: unknown) => unknown>(),
  closeRequestedHandler: null as null | ((event: { preventDefault: () => void }) => unknown),
  windowChromeState: { nativeTrafficLightsVisible: false },
  onDragDropEventMock: vi.fn(async () => vi.fn()),
  beforeEachMock: vi.fn(),
  pushMock: vi.fn(() => Promise.resolve()),
  invokeMock: vi.fn(async (_command?: string, _args?: Record<string, unknown>) => undefined as unknown),
  hideMock: vi.fn(async () => undefined),
  destroyMock: vi.fn(async () => undefined),
  showMock: vi.fn(async () => undefined),
  focusMock: vi.fn(async () => undefined),
  warningDialogMock: vi.fn(),
  notifyErrorMock: vi.fn(),
  messageWarningMock: vi.fn(),
  openUrlMock: vi.fn(async () => undefined),
  preferenceStore: null as null | {
    pendingChanges: boolean
    saveBeforeLeave: null | (() => Promise<void>)
    config: { minimizeToTrayOnClose: boolean; useNativeTrafficLights: boolean }
  },
  appStore: null as null | {
    pendingUpdate: null
    startupErrors: unknown[]
    interval: number
    fetchGlobalStat: ReturnType<typeof vi.fn>
    showAddTaskDialog: ReturnType<typeof vi.fn>
    addTaskVisible: boolean
    hideAddTaskDialog: ReturnType<typeof vi.fn>
    handleDeepLinkUrls: ReturnType<typeof vi.fn>
    enqueueBatch: ReturnType<typeof vi.fn>
  },
  taskStore: null as null | {
    resumeAllTask: ReturnType<typeof vi.fn>
    pauseAllTask: ReturnType<typeof vi.fn>
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => hoisted.route,
  useRouter: () => ({
    push: hoisted.pushMock,
    beforeEach: hoisted.beforeEachMock,
  }),
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => hoisted.appStore,
}))

vi.mock('@/stores/task', () => ({
  useTaskStore: () => hoisted.taskStore,
}))

vi.mock('@/stores/preference', () => ({
  usePreferenceStore: () => hoisted.preferenceStore,
}))

vi.mock('@/composables/useAppMessage', () => ({
  useAppMessage: () => ({
    warning: hoisted.messageWarningMock,
  }),
}))

vi.mock('@/composables/useAppNotification', () => ({
  useAppNotification: () => ({
    notifyError: hoisted.notifyErrorMock,
  }),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/api/aria2', () => ({
  default: {},
  isEngineReady: () => false,
}))

vi.mock('@shared/utils/batchHelpers', () => ({
  detectKind: vi.fn(() => 'uri'),
  createBatchItem: vi.fn((kind: string, source: string) => ({ kind, source })),
}))

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: hoisted.onDragDropEventMock,
  }),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: (event: { preventDefault: () => void }) => unknown) => {
      hoisted.closeRequestedHandler = handler
      return vi.fn()
    },
    hide: hoisted.hideMock,
    destroy: hoisted.destroyMock,
    show: hoisted.showMock,
    setFocus: hoisted.focusMock,
  }),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) =>
    (hoisted.invokeMock as (command: string, args?: Record<string, unknown>) => Promise<unknown>)(command, args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (eventName: string, handler: (event: unknown) => unknown) => {
    hoisted.eventHandlers.set(eventName, handler)
    return vi.fn()
  },
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: () => 'macos',
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => (hoisted.openUrlMock as (url: string) => Promise<undefined>)(url),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')

  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => h('div', slots.default ? slots.default() : [])
    },
  })

  return {
    NModal: passthrough,
    NButton: passthrough,
    NSpace: passthrough,
    NIcon: passthrough,
    useDialog: () => ({
      warning: hoisted.warningDialogMock,
    }),
  }
})

import MainLayout from '@/layouts/MainLayout.vue'

const RouterViewStub = defineComponent({
  name: 'RouterViewStub',
  setup(_, { slots }) {
    const ViewComponent = defineComponent({
      name: 'RouteViewContentStub',
      setup() {
        return () => h('div', 'route-view')
      },
    })

    return () => slots.default?.({ Component: ViewComponent, route: { path: hoisted.route.path } })
  },
})

const TransitionStub = defineComponent({
  name: 'TransitionStub',
  setup(_, { slots }) {
    return () => slots.default?.()
  },
})

const UpdateDialogStub = defineComponent({
  name: 'UpdateDialogStub',
  setup(_, { expose }) {
    expose({ open: vi.fn() })
    return () => h('div')
  },
})

function createStub(name: string, attrs: Record<string, string> = {}) {
  return defineComponent({
    name,
    setup() {
      return () => h('div', attrs)
    },
  })
}

async function mountLayout() {
  const wrapper = mount(MainLayout, {
    global: {
      stubs: {
        AsideBar: createStub('AsideBarStub'),
        TaskSubnav: createStub('TaskSubnavStub'),
        PreferenceSubnav: createStub('PreferenceSubnavStub'),
        Speedometer: createStub('SpeedometerStub'),
        WindowControls: createStub('WindowControlsStub', { 'data-test': 'window-controls-stub' }),
        AboutPanel: createStub('AboutPanelStub'),
        AddTask: createStub('AddTaskStub'),
        UpdateDialog: UpdateDialogStub,
        RouterView: RouterViewStub,
        Transition: TransitionStub,
      },
    },
  })

  await flushPromises()

  return wrapper
}

describe('MainLayout macOS window chrome', () => {
  beforeEach(() => {
    hoisted.eventHandlers = new Map()
    hoisted.closeRequestedHandler = null
    hoisted.beforeEachMock.mockReset()
    hoisted.pushMock.mockClear()
    hoisted.invokeMock.mockReset()
    hoisted.invokeMock.mockImplementation(async (command?: string) => {
      if (command === 'get_window_chrome_state') {
        return hoisted.windowChromeState
      }
      return undefined
    })
    hoisted.hideMock.mockClear()
    hoisted.destroyMock.mockClear()
    hoisted.showMock.mockClear()
    hoisted.focusMock.mockClear()
    hoisted.warningDialogMock.mockClear()
    hoisted.notifyErrorMock.mockClear()
    hoisted.messageWarningMock.mockClear()
    hoisted.openUrlMock.mockClear()
    hoisted.onDragDropEventMock.mockClear()

    hoisted.appStore = reactive({
      pendingUpdate: null,
      startupErrors: [],
      interval: 60_000,
      fetchGlobalStat: vi.fn(async () => undefined),
      showAddTaskDialog: vi.fn(),
      addTaskVisible: false,
      hideAddTaskDialog: vi.fn(),
      handleDeepLinkUrls: vi.fn(),
      enqueueBatch: vi.fn(() => 0),
    })

    hoisted.taskStore = {
      resumeAllTask: vi.fn(async () => undefined),
      pauseAllTask: vi.fn(async () => undefined),
    }

    hoisted.preferenceStore = reactive({
      pendingChanges: false,
      saveBeforeLeave: null,
      config: reactive({
        minimizeToTrayOnClose: false,
        useNativeTrafficLights: false,
      }),
    })
  })

  it('keeps custom window controls visible until restart after enabling native traffic lights', async () => {
    hoisted.windowChromeState = { nativeTrafficLightsVisible: false }

    const wrapper = await mountLayout()

    expect(wrapper.find('[data-test="window-controls-stub"]').exists()).toBe(true)
    expect(wrapper.get('#container').classes()).toContain('custom-window-chrome')
    expect(wrapper.get('#container').classes()).not.toContain('native-window-chrome')
    expect(hoisted.invokeMock).toHaveBeenCalledWith('get_window_chrome_state', undefined)

    hoisted.preferenceStore!.config.useNativeTrafficLights = true
    await flushPromises()

    expect(wrapper.find('[data-test="window-controls-stub"]').exists()).toBe(true)
    expect(wrapper.get('#container').classes()).toContain('custom-window-chrome')

    wrapper.unmount()
  })

  it('marks the shell as native-window-chrome when the session starts with traffic lights enabled', async () => {
    hoisted.windowChromeState = { nativeTrafficLightsVisible: true }

    const wrapper = await mountLayout()

    expect(wrapper.find('[data-test="window-controls-stub"]').exists()).toBe(false)
    expect(wrapper.get('#container').classes()).toContain('native-window-chrome')
    expect(wrapper.get('#container').classes()).not.toContain('custom-window-chrome')

    wrapper.unmount()
  })

  it('paints the rounded shell background while using custom window controls', async () => {
    hoisted.windowChromeState = { nativeTrafficLightsVisible: false }

    const wrapper = await mountLayout()
    const inlineStyle = wrapper.get('#container').attributes('style') ?? ''

    expect(inlineStyle).toContain('linear-gradient')
    expect(inlineStyle).toContain('var(--aside-bg)')
    expect(inlineStyle).toContain('var(--subnav-bg)')
    expect(inlineStyle).toContain('var(--main-bg)')

    wrapper.unmount()
  })
})
