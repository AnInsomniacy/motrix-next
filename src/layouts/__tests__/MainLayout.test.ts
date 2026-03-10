import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive } from 'vue'

const hoisted = vi.hoisted(() => ({
  route: { path: '/task' },
  eventHandlers: new Map<string, (event: unknown) => unknown>(),
  modalVisible: false,
  hideVisibilitySnapshots: [] as boolean[],
  pendingAfterLeave: null as null | (() => Promise<void> | void),
  updateShowHandler: null as null | ((value: boolean) => unknown),
  closeRequestedHandler: null as null | ((event: { preventDefault: () => void }) => unknown),
  onDragDropEventMock: vi.fn(async () => vi.fn()),
  beforeEachMock: vi.fn(),
  pushMock: vi.fn(() => Promise.resolve()),
  invokeMock: vi.fn(async (_command?: string, _args?: Record<string, unknown>) => undefined as unknown),
  hideMock: vi.fn(async () => {
    hoisted.hideVisibilitySnapshots.push(hoisted.modalVisible)
  }),
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
    config: { closeAction: 'ask' | 'minimize' | 'quit'; useNativeTrafficLights: boolean }
    updateAndSave: ReturnType<typeof vi.fn>
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
  const { defineComponent, h, onMounted, onUpdated, onBeforeUnmount, watch } = await import('vue')

  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => h('div', slots.default ? slots.default() : [])
    },
  })

  const NModal = defineComponent({
    props: {
      show: { type: Boolean, default: false },
      onAfterLeave: { type: Function, default: undefined },
      'onUpdate:show': { type: Function, default: undefined },
    },
    setup(props, { slots }) {
      const syncVisibility = () => {
        hoisted.modalVisible = props.show
        hoisted.updateShowHandler = props['onUpdate:show'] as ((value: boolean) => unknown) | null
      }

      onMounted(syncVisibility)
      onUpdated(syncVisibility)
      watch(
        () => props.show,
        (visible, wasVisible) => {
          if (!visible && wasVisible) {
            hoisted.pendingAfterLeave = async () => {
              ;(props.onAfterLeave as (() => void) | undefined)?.()
            }
          }
        },
      )
      onBeforeUnmount(() => {
        hoisted.modalVisible = false
        hoisted.pendingAfterLeave = null
        hoisted.updateShowHandler = null
      })

      return () => {
        if (!props.show) return null
        return h('div', { 'data-test': 'exit-modal' }, [
          slots.default ? slots.default() : null,
          slots.footer ? slots.footer() : null,
        ])
      }
    },
  })

  const NButton = defineComponent({
    emits: ['click'],
    setup(_, { slots, emit }) {
      return () => h('button', { onClick: () => emit('click') }, slots.default ? slots.default() : [])
    },
  })

  const NCheckbox = defineComponent({
    props: {
      checked: { type: Boolean, default: false },
    },
    emits: ['update:checked'],
    setup(props, { slots, emit }) {
      return () =>
        h('label', [
          h('input', {
            type: 'checkbox',
            checked: props.checked,
            onChange: (event: Event) => emit('update:checked', (event.target as HTMLInputElement).checked),
          }),
          slots.default ? slots.default() : null,
        ])
    },
  })

  return {
    NModal,
    NButton,
    NCheckbox,
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

function createStub(name: string) {
  return defineComponent({
    name,
    setup() {
      return () => h('div')
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
        WindowControls: createStub('WindowControlsStub'),
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

describe('MainLayout close action dialog', () => {
  beforeEach(() => {
    hoisted.eventHandlers = new Map()
    hoisted.modalVisible = false
    hoisted.hideVisibilitySnapshots = []
    hoisted.pendingAfterLeave = null
    hoisted.updateShowHandler = null
    hoisted.closeRequestedHandler = null
    hoisted.beforeEachMock.mockReset()
    hoisted.pushMock.mockClear()
    hoisted.invokeMock.mockReset()
    hoisted.invokeMock.mockResolvedValue(undefined)
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
    })

    hoisted.taskStore = {
      resumeAllTask: vi.fn(async () => undefined),
      pauseAllTask: vi.fn(async () => undefined),
    }

    const config = reactive({
      closeAction: 'ask' as const,
      useNativeTrafficLights: false,
    })

    hoisted.preferenceStore = reactive({
      pendingChanges: false,
      saveBeforeLeave: null,
      config,
      updateAndSave: vi.fn(async (patch: Partial<typeof config>) => {
        Object.assign(config, patch)
        return true
      }),
    })
  })

  it('opens the close-action dialog when the window close request is intercepted', async () => {
    const wrapper = await mountLayout()

    expect(hoisted.closeRequestedHandler).toBeTypeOf('function')

    const preventDefault = vi.fn()
    await hoisted.closeRequestedHandler?.({ preventDefault })
    await flushPromises()

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(hoisted.modalVisible).toBe(true)
    expect(wrapper.find('[data-test="exit-modal"]').exists()).toBe(true)
    expect(wrapper.findAll('button')).toHaveLength(2)

    wrapper.unmount()
  }, 10000)

  it('dismisses the dialog before hiding the window when minimizing to tray', async () => {
    const wrapper = await mountLayout()

    await hoisted.closeRequestedHandler?.({ preventDefault: vi.fn() })
    await flushPromises()

    const minimizeButton = wrapper
      .findAll('button')
      .find((buttonWrapper) => buttonWrapper.text().includes('app.close-action-minimize'))

    expect(minimizeButton).toBeDefined()

    await minimizeButton!.trigger('click')
    await flushPromises()

    expect(document.body.classList.contains('close-action-dialog-no-transition')).toBe(true)
    expect(hoisted.hideMock).not.toHaveBeenCalled()
    expect(hoisted.pendingAfterLeave).toBeTypeOf('function')

    await hoisted.pendingAfterLeave?.()
    await flushPromises()

    expect(hoisted.hideVisibilitySnapshots).toEqual([false])
    expect(hoisted.invokeMock).toHaveBeenCalledWith('set_dock_icon_visible', { visible: false })
    expect(hoisted.modalVisible).toBe(false)
    expect(document.body.classList.contains('close-action-dialog-no-transition')).toBe(false)

    wrapper.unmount()
  })

  it('dismisses the dialog without minimizing when the modal requests close', async () => {
    const wrapper = await mountLayout()

    await hoisted.closeRequestedHandler?.({ preventDefault: vi.fn() })
    await flushPromises()

    expect(hoisted.updateShowHandler).toBeTypeOf('function')

    await hoisted.updateShowHandler?.(false)
    await flushPromises()

    expect(document.body.classList.contains('close-action-dialog-no-transition')).toBe(true)
    expect(hoisted.hideMock).not.toHaveBeenCalled()
    expect(hoisted.pendingAfterLeave).toBeTypeOf('function')

    await hoisted.pendingAfterLeave?.()
    await flushPromises()

    expect(hoisted.hideMock).not.toHaveBeenCalled()
    expect(document.body.classList.contains('close-action-dialog-no-transition')).toBe(false)

    wrapper.unmount()
  })

  it('opens the same dialog for the Rust close-requested fallback event', async () => {
    const wrapper = await mountLayout()

    const closeRequestedEventHandler = hoisted.eventHandlers.get('close-requested')

    expect(closeRequestedEventHandler).toBeTypeOf('function')

    await closeRequestedEventHandler?.({})
    await flushPromises()

    expect(hoisted.modalVisible).toBe(true)
    expect(wrapper.text()).toContain('app.close-action-quit')

    wrapper.unmount()
  })

  it('hides directly without showing the dialog when closeAction is minimize', async () => {
    hoisted.preferenceStore!.config.closeAction = 'minimize'

    const wrapper = await mountLayout()

    await hoisted.closeRequestedHandler?.({ preventDefault: vi.fn() })
    await flushPromises()

    expect(hoisted.hideMock).toHaveBeenCalledTimes(1)
    expect(hoisted.modalVisible).toBe(false)

    wrapper.unmount()
  })
})
