import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'

const pushMock = vi.fn(() => Promise.resolve())
const showAddTaskDialogMock = vi.fn()
const routeState = reactive({
  path: '/task/progress',
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
  useRoute: () => routeState,
}))

vi.mock('naive-ui', () => ({
  NIcon: { template: '<span><slot /></span>' },
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => ({
    showAddTaskDialog: showAddTaskDialogMock,
    stat: {
      numActive: 2,
      numWaiting: 1,
    },
  }),
}))

vi.mock('@/stores/task', () => ({
  useTaskStore: () => ({
    taskCounts: { all: 8, progress: 3, failed: 1, completed: 4 },
  }),
}))

vi.mock('@/stores/preference', () => ({
  usePreferenceStore: () => ({
    config: {
      sidebarTaskCounts: true,
    },
  }),
}))

vi.mock('@/components/common/MTooltip.vue', () => ({
  default: {
    template: '<div><slot name="trigger" /><slot /></div>',
  },
}))

vi.mock('@vicons/ionicons5', () => ({
  ListOutline: { template: '<i />' },
  AddOutline: { template: '<i />' },
  SettingsOutline: { template: '<i />' },
  HelpCircleOutline: { template: '<i />' },
  PlayOutline: { template: '<i />' },
  AlertCircleOutline: { template: '<i />' },
  CheckmarkDoneOutline: { template: '<i />' },
  ConstructOutline: { template: '<i />' },
  DownloadOutline: { template: '<i />' },
  MagnetOutline: { template: '<i />' },
  GitNetworkOutline: { template: '<i />' },
  GlobeOutline: { template: '<i />' },
}))

import AsideBar from '../AsideBar.vue'
import TaskSubnav from '../TaskSubnav.vue'
import PreferenceSubnav from '../PreferenceSubnav.vue'

describe('keyboard-accessible navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeState.path = '/task/progress'
  })

  it('renders AsideBar actions as keyboard-focusable buttons', async () => {
    const wrapper = mount(AsideBar)
    const buttons = wrapper.findAll('button')

    expect(buttons).toHaveLength(4)

    await buttons[0].trigger('click')
    expect(pushMock).toHaveBeenCalledWith({ path: '/task/all' })

    await buttons[1].trigger('click')
    expect(showAddTaskDialogMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the sidebar logo visual-only instead of linking to GitHub', () => {
    const wrapper = mount(AsideBar)

    expect(wrapper.find('.logo-mini a').exists()).toBe(false)
    expect(wrapper.find('.logo-mini').text()).toContain('NEXT')
    expect(wrapper.html()).not.toContain('github.com/AnInsomniacy/motrix-next')
  })

  it('renders TaskSubnav routes as buttons and marks the active route', async () => {
    const wrapper = mount(TaskSubnav)
    const buttons = wrapper.findAll('button')

    expect(buttons).toHaveLength(4)
    expect(buttons[1].attributes('aria-current')).toBe('page')

    await buttons[2].trigger('click')
    expect(pushMock).toHaveBeenCalledWith({ path: '/task/failed' })
  })

  it('renders PreferenceSubnav routes as buttons and marks the active route', async () => {
    routeState.path = '/preference/general'
    const wrapper = mount(PreferenceSubnav)
    const buttons = wrapper.findAll('button')

    expect(buttons).toHaveLength(6)
    expect(buttons[0].attributes('aria-current')).toBe('page')

    await buttons[5].trigger('click')
    expect(pushMock).toHaveBeenCalledWith({ path: '/preference/advanced' })
  })
})
