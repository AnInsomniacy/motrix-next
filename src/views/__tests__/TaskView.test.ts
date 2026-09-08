import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const changeCurrentListMock = vi.fn()
const fetchListMock = vi.fn()
const hideTaskDetailMock = vi.fn()
const isEngineReadyMock = vi.fn(() => true)

const taskStore = {
  changeCurrentList: (...args: unknown[]) => changeCurrentListMock(...args),
  fetchList: (...args: unknown[]) => fetchListMock(...args),
  taskDetailVisible: false,
  currentTaskItem: null,
  currentTaskFiles: [],
  hideTaskDetail: () => hideTaskDetailMock(),
}

const appStore = {
  interval: 1000,
}

const preferenceStore = {
  config: {},
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useDialog: () => ({}),
}))

vi.mock('@/stores/task', () => ({
  useTaskStore: () => taskStore,
}))

vi.mock('@/stores/app', () => ({
  useAppStore: () => appStore,
}))

vi.mock('@/stores/preference', () => ({
  usePreferenceStore: () => preferenceStore,
}))

vi.mock('@/composables/useTaskActions', () => ({
  useTaskActions: () => ({
    handlePauseTask: vi.fn(),
    handleResumeTask: vi.fn(),
    handleRetryTask: vi.fn(),
    handleRedownloadTask: vi.fn(),
    handleDeleteTask: vi.fn(),
    handleDeleteRecord: vi.fn(),
    handleCopyLink: vi.fn(),
    handleShowInfo: vi.fn(),
    handleShowInFolder: vi.fn(),
    handleOpenFile: vi.fn(),
    handleFinishSharing: vi.fn(),
    handleSelectFiles: vi.fn(),
  }),
}))

vi.mock('@/composables/useAppMessage', () => ({
  useAppMessage: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

vi.mock('@/api/aria2', () => ({
  isEngineReady: () => isEngineReadyMock(),
}))

vi.mock('@/components/task/TaskList.vue', () => ({
  default: { template: '<div class="task-list-stub" />' },
}))

vi.mock('@/components/task/TaskActions.vue', () => ({
  default: { template: '<div class="task-actions-stub" />' },
}))

vi.mock('@/components/task/TaskDetail.vue', () => ({
  default: { template: '<div class="task-detail-stub" />' },
}))

import TaskView from '../TaskView.vue'

function deferredPromise() {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('TaskView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    appStore.interval = 1000
    isEngineReadyMock.mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not restart polling if changeCurrentList resolves after unmount', async () => {
    const pendingChange = deferredPromise()
    changeCurrentListMock.mockReturnValueOnce(pendingChange.promise)
    fetchListMock.mockResolvedValue(undefined)

    const wrapper = mount(TaskView, {
      props: { status: 'progress' },
    })

    expect(changeCurrentListMock).toHaveBeenCalledWith('progress')

    wrapper.unmount()
    pendingChange.resolve()
    await flushPromises()

    await vi.advanceTimersByTimeAsync(1500)

    expect(fetchListMock).not.toHaveBeenCalled()
  })
})
