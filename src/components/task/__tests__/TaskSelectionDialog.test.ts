import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref, nextTick, defineComponent, watch } from 'vue'
import type { Aria2Task } from '@shared/types'
import { useTaskSelectionStore } from '@/stores/taskSelection'

const mocks = vi.hoisted(() => ({
  fetchTaskStatus: vi.fn(),
  getFiles: vi.fn(),
  getOption: vi.fn(),
  confirmMedia: vi.fn(),
  fetchList: vi.fn(),
  selectFiles: vi.fn(),
  modalShows: vi.fn(),
}))
vi.mock('@/stores/task', () => ({ useTaskStore: () => mocks }))
vi.mock('@/api/aria2', () => mocks)
vi.mock('@/composables/useBtSelection', () => ({ useBtSelection: () => mocks }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en-US') }) }))
import TaskSelectionHost from '../TaskSelectionHost.vue'
import MediaSelectionDialog from '../MediaSelectionDialog.vue'
import BtSelectionDialog from '../BtSelectionDialog.vue'

function mediaTask(gid: string): Aria2Task {
  return {
    gid,
    status: 'paused',
    totalLength: '0',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/tmp',
    files: [],
    media: {
      state: 'awaiting-selection',
      protocol: 'hls',
      live: 'false',
      duration: '1000',
      completedDuration: '0',
      downloadedLength: '0',
      lengthKnown: 'false',
      error: '',
      tracks: [
        {
          id: '0:0',
          type: 'muxed',
          language: '',
          codec: 'avc1',
          width: '640',
          height: '360',
          bandwidth: '1000',
          selected: 'true',
        },
      ],
    },
  }
}

function setup(blocked = false, preopened = false) {
  const selection = useTaskSelectionStore()
  selection.request({ kind: 'media', gid: 'a' })
  selection.request({ kind: 'media', gid: 'b' })
  if (preopened) selection.present()
  const wrapper = mount(TaskSelectionHost, {
    props: { blocked },
    global: {
      stubs: {
        Modal: defineComponent({
          name: 'ModalTestStub',
          props: { show: Boolean },
          emits: ['afterLeave', 'update:show'],
          setup(props) {
            watch(
              () => props.show,
              (value) => mocks.modalShows(value),
              { immediate: true },
            )
          },
          template: '<section v-show="show"><slot /></section>',
        }),
        Card: { template: '<article><slot /><slot name="footer" /></article>' },
        Button: {
          props: ['disabled', 'loading'],
          template: '<button :disabled="disabled || loading"><slot /></button>',
        },
        Space: { template: '<div><slot /></div>' },
        Form: { template: '<form><slot /></form>' },
        Alert: { template: '<aside><slot /></aside>' },
        Spin: true,
        MediaOptions: true,
        BtFileSelector: true,
      },
    },
  })
  return { wrapper, selection }
}

describe('shared task selection dialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    mocks.fetchTaskStatus.mockImplementation(async (gid: string) => mediaTask(gid))
    mocks.getOption.mockResolvedValue({
      media: 'hls',
      mediaFormat: 'mp4',
      mediaVideo: 'best',
      mediaAudio: 'best',
      mediaSubtitles: 'none',
      mediaRecordTime: '0',
    })
    mocks.confirmMedia.mockResolvedValue(undefined)
  })

  it('waits for the previous modal before loading a selection', async () => {
    const { wrapper, selection } = setup(true)
    await flushPromises()
    expect(mocks.fetchTaskStatus).not.toHaveBeenCalled()
    await wrapper.setProps({ blocked: false })
    await flushPromises()
    expect(selection.current?.gid).toBe('a')
    expect(mocks.getOption).toHaveBeenCalledWith({ gid: 'a' })
    wrapper.unmount()
  })

  it('retains the current content while closing, then loads the next task', async () => {
    const { wrapper, selection } = setup()
    await flushPromises()
    const later = wrapper
      .findComponent(MediaSelectionDialog)
      .findAll('button')
      .find((button) => button.text() === 'task.magnet-choose-later')!
    expect(wrapper.html()).toContain('task.magnet-choose-later')
    await later.trigger('click')
    expect(selection.current?.gid).toBe('a')
    expect(selection.visible).toBe(false)
    expect(wrapper.find('media-options-stub').exists()).toBe(true)
    wrapper.findComponent(MediaSelectionDialog).findComponent({ name: 'ModalTestStub' }).vm.$emit('afterLeave')
    await flushPromises()
    expect(selection.current?.gid).toBe('b')
    wrapper.unmount()
  })

  it('keeps failed submissions open and retries the same task', async () => {
    mocks.confirmMedia.mockRejectedValueOnce(new Error('Connection lost'))
    const { wrapper, selection } = setup()
    await flushPromises()
    const start = wrapper
      .findComponent(MediaSelectionDialog)
      .findAll('button')
      .find((button) => button.text() === 'task.magnet-start-download')!
    await start.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Connection lost')
    expect(selection.visible).toBe(true)
    await start.trigger('click')
    await flushPromises()
    expect(mocks.confirmMedia).toHaveBeenCalledTimes(2)
    expect(mocks.confirmMedia.mock.calls[1][0]).toBe('a')
    expect(selection.phase).toBe('closing')
    wrapper.unmount()
  })

  it('discards a late response after dismissal', async () => {
    let resolve!: (value: Record<string, string>) => void
    mocks.getOption.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { wrapper, selection } = setup()
    await flushPromises()
    selection.close()
    await nextTick()
    resolve({ media: 'hls', mediaFormat: 'mp4' })
    await flushPromises()
    expect(wrapper.find('media-options-stub').exists()).toBe(false)
    expect(selection.phase).toBe('closing')
    wrapper.unmount()
  })
  it('uses a separate BT dialog and then presents media after its exit', async () => {
    const bt = {
      ...mediaTask('a'),
      media: undefined,
      bittorrent: { state: 'paused' as const, fileSelectionState: 'awaiting' as const },
    }
    mocks.fetchTaskStatus.mockImplementation(async (gid: string) => (gid === 'a' ? bt : mediaTask(gid)))
    mocks.getFiles.mockResolvedValue([
      { index: '1', path: '/tmp/file.bin', length: '10', completedLength: '0', selected: 'true', uris: [] },
    ])
    const { wrapper, selection } = setup(true)
    selection.queue[0] = { kind: 'bt', gid: 'a' }
    await wrapper.setProps({ blocked: false })
    await flushPromises()
    expect(wrapper.find('bt-file-selector-stub').exists()).toBe(true)
    expect(mocks.getOption).not.toHaveBeenCalled()
    const start = wrapper
      .findComponent(BtSelectionDialog)
      .findAll('button')
      .find((button) => button.text() === 'task.magnet-start-download')!
    await start.trigger('click')
    await flushPromises()
    expect(mocks.selectFiles).toHaveBeenCalledWith(bt, expect.any(Array), [1])
    expect(mocks.confirmMedia).not.toHaveBeenCalled()
    wrapper.findComponent(BtSelectionDialog).findComponent({ name: 'ModalTestStub' }).vm.$emit('afterLeave')
    await flushPromises()
    expect(wrapper.find('media-options-stub').exists()).toBe(true)
    expect(mocks.getOption).toHaveBeenCalledWith({ gid: 'b' })
    wrapper.unmount()
  })

  it('mounts closed modal instances before requesting their native enter transitions', async () => {
    const { wrapper } = setup()
    expect(mocks.modalShows.mock.calls.map(([show]) => show)).toEqual([false, false])
    await flushPromises()
    expect(mocks.modalShows.mock.calls.map(([show]) => show)).toEqual([false, false, true])
    expect(
      wrapper.findComponent(MediaSelectionDialog).findComponent({ name: 'ModalTestStub' }).attributes('transition'),
    ).toBeUndefined()
    wrapper.unmount()
  })
  it('does not let a completed submission close the next media dialog', async () => {
    let finish!: () => void
    mocks.fetchList.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      }),
    )
    const { wrapper, selection } = setup()
    await flushPromises()
    const dialog = wrapper.findComponent(MediaSelectionDialog)
    await dialog
      .findAll('button')
      .find((button) => button.text() === 'task.magnet-start-download')!
      .trigger('click')
    await flushPromises()
    selection.close()
    await nextTick()
    dialog.findComponent({ name: 'ModalTestStub' }).vm.$emit('afterLeave')
    await flushPromises()
    expect(selection.current?.gid).toBe('b')
    finish()
    await flushPromises()
    expect(selection.current?.gid).toBe('b')
    expect(selection.visible).toBe(true)
    wrapper.unmount()
  })
  it('enters natively when the host remounts with an already active request', async () => {
    const { wrapper } = setup(false, true)
    expect(mocks.modalShows.mock.calls.map(([show]) => show)).toEqual([false, false])
    await flushPromises()
    expect(mocks.modalShows.mock.calls.map(([show]) => show)).toEqual([false, false, true])
    wrapper.unmount()
  })
})
