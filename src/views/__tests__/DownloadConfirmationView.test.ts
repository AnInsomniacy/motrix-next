import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const { closeMock, focusMock, handleExternalInputsMock, hideAddTaskDialogMock, invokeMock, listenMock, showMock } =
  vi.hoisted(() => ({
    closeMock: vi.fn(async () => undefined),
    focusMock: vi.fn(async () => undefined),
    handleExternalInputsMock: vi.fn(),
    hideAddTaskDialogMock: vi.fn(),
    invokeMock: vi.fn(),
    listenMock: vi.fn(async () => vi.fn()),
    showMock: vi.fn(async () => undefined),
  }))

const appStore = {
  addTaskVisible: true,
  handleExternalInputs: handleExternalInputsMock,
  hideAddTaskDialog: hideAddTaskDialogMock,
}

vi.mock('@/stores/app', () => ({
  useAppStore: () => appStore,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: closeMock,
    setFocus: focusMock,
    show: showMock,
  }),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('@/components/task/AddTask.vue', () => ({
  default: {
    name: 'AddTaskStub',
    props: {
      show: Boolean,
      showMask: { type: Boolean, default: true },
    },
    emits: ['close'],
    template: '<button class="close-confirmation" @click="$emit(\'close\')">close</button>',
  },
}))

import DownloadConfirmationView from '../DownloadConfirmationView.vue'

describe('DownloadConfirmationView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appStore.addTaskVisible = true
    invokeMock.mockResolvedValue({
      inputs: [
        {
          url: 'https://example.com/file.zip',
          filename: 'file.zip',
          source: 'http-api',
        },
      ],
      silent: false,
    })
  })

  it('shows only the confirmation window after routing the queued extension request', async () => {
    mount(DownloadConfirmationView)
    await flushPromises()

    expect(listenMock).toHaveBeenCalledWith('external-input-open', expect.any(Function))
    expect(invokeMock).toHaveBeenCalledWith('take_pending_external_inputs')
    expect(handleExternalInputsMock).toHaveBeenCalledWith([
      expect.objectContaining({ url: 'https://example.com/file.zip', filename: 'file.zip' }),
    ])
    expect(showMock).toHaveBeenCalledOnce()
    expect(focusMock).toHaveBeenCalledOnce()
  })

  it('renders the standalone confirmation form without a modal backdrop', async () => {
    const wrapper = mount(DownloadConfirmationView)
    await flushPromises()

    expect(wrapper.getComponent({ name: 'AddTaskStub' }).props('showMask')).toBe(false)
  })

  it('closes the dedicated window when the confirmation form is dismissed', async () => {
    const wrapper = mount(DownloadConfirmationView)
    await flushPromises()

    await wrapper.get('.close-confirmation').trigger('click')

    expect(hideAddTaskDialogMock).toHaveBeenCalledOnce()
    expect(closeMock).toHaveBeenCalledOnce()
  })
})
