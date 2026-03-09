import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import AddTask from '@/components/task/AddTask.vue'
import { useAppStore } from '@/stores/app'
import { createBatchItem, resetBatchIdCounter } from '@shared/utils/batchHelpers'

const {
  pushMock,
  successMock,
  warningMock,
  errorMock,
  readFileMock,
  openDialogMock,
  parseTorrentBufferMock,
  uint8ToBase64Mock,
} = vi.hoisted(() => ({
  pushMock: vi.fn(() => Promise.resolve()),
  successMock: vi.fn(),
  warningMock: vi.fn(),
  errorMock: vi.fn(),
  readFileMock: vi.fn(async () => new Uint8Array([1, 2, 3])),
  openDialogMock: vi.fn(),
  parseTorrentBufferMock: vi.fn(async () => ({
    infoHash: 'hash',
    files: [{ idx: 1, path: 'file.bin', length: 1 }],
  })),
  uint8ToBase64Mock: vi.fn(() => 'base64'),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}))

vi.mock('@/composables/useAppMessage', () => ({
  useAppMessage: () => ({
    success: successMock,
    warning: warningMock,
    error: errorMock,
    info: vi.fn(),
  }),
}))

vi.mock('@/api/aria2', () => ({
  isEngineReady: () => true,
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: openDialogMock,
}))

vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: vi.fn(async () => '/Downloads'),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: readFileMock,
}))

vi.mock('@/composables/useTorrentParser', () => ({
  parseTorrentBuffer: parseTorrentBufferMock,
  uint8ToBase64: uint8ToBase64Mock,
}))

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')

  const passthrough = defineComponent({
    setup(_, { slots }) {
      return () => h('div', slots.default ? slots.default() : [])
    },
  })

  const NButton = defineComponent({
    emits: ['click'],
    setup(_, { slots, emit }) {
      return () => h('button', { onClick: () => emit('click') }, slots.default ? slots.default() : [])
    },
  })

  const NInput = defineComponent({
    props: {
      value: { type: String, default: '' },
      type: { type: String, default: 'text' },
      placeholder: { type: String, default: '' },
    },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () =>
        props.type === 'textarea'
          ? h('textarea', {
              value: props.value,
              placeholder: props.placeholder,
              onInput: (e: Event) => emit('update:value', (e.target as HTMLTextAreaElement).value),
            })
          : h('input', {
              value: props.value,
              placeholder: props.placeholder,
              onInput: (e: Event) => emit('update:value', (e.target as HTMLInputElement).value),
            })
    },
  })

  const NInputNumber = defineComponent({
    props: {
      value: { type: Number, default: 0 },
    },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () =>
        h('input', {
          type: 'number',
          value: props.value,
          onInput: (e: Event) => emit('update:value', Number((e.target as HTMLInputElement).value)),
        })
    },
  })

  const NDataTable = defineComponent({
    props: {
      data: { type: Array, default: () => [] },
    },
    setup(props) {
      return () => h('div', { 'data-rows': String((props.data as unknown[]).length) })
    },
  })

  return {
    NModal: passthrough,
    NCard: passthrough,
    NTabs: passthrough,
    NTabPane: passthrough,
    NForm: passthrough,
    NFormItem: passthrough,
    NInput,
    NInputNumber,
    NButton,
    NSpace: passthrough,
    NGrid: passthrough,
    NGridItem: passthrough,
    NIcon: passthrough,
    NInputGroup: passthrough,
    NDataTable,
    NTag: passthrough,
    NEllipsis: passthrough,
    NCheckbox: passthrough,
    NCollapseTransition: passthrough,
    useNotification: () => ({
      error: vi.fn(() => ({ destroy: vi.fn() })),
      warning: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
    }),
  }
})

const TorrentUploadStub = defineComponent({
  name: 'TorrentUpload',
  props: {
    loaded: { type: Boolean, default: false },
  },
  emits: ['choose'],
  setup(props, { slots, emit }) {
    return () =>
      h('div', [
        props.loaded
          ? slots['file-list']
            ? slots['file-list']()
            : []
          : h('button', { onClick: () => emit('choose') }, 'choose-file'),
        slots.placeholder ? slots.placeholder() : [],
      ])
  },
})

const AdvancedOptionsStub = defineComponent({
  name: 'AdvancedOptions',
  setup() {
    return () => h('div')
  },
})

function mountDialog() {
  return mount(AddTask, {
    props: { show: false },
    global: {
      stubs: {
        TorrentUpload: TorrentUploadStub,
        AdvancedOptions: AdvancedOptionsStub,
      },
    },
  })
}

function getTextarea(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('textarea')
}

describe('AddTask batch URI integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
    pushMock.mockClear()
    successMock.mockClear()
    warningMock.mockClear()
    errorMock.mockClear()
    readFileMock.mockClear()
    openDialogMock.mockClear()
    parseTorrentBufferMock.mockClear()
    uint8ToBase64Mock.mockClear()
  })

  it('flushes uri batch items into the textarea and drains uri items from pendingBatch on open', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [
      createBatchItem('uri', 'https://a.example/file'),
      createBatchItem('uri', 'magnet:?xt=urn:btih:abc'),
    ]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      ['https://a.example/file', 'magnet:?xt=urn:btih:abc'].join('\n'),
    )
    expect(appStore.pendingBatch).toEqual([])
  })

  it('appends newly added uri batch items while open and deduplicates multiline payloads per line', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('uri', 'https://a.example/file\nhttps://b.example/file')]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      ['https://a.example/file', 'https://b.example/file'].join('\n'),
    )

    appStore.pendingBatch = [
      createBatchItem('uri', 'https://b.example/file\nhttps://c.example/file'),
      createBatchItem('uri', 'https://a.example/file'),
    ]

    await nextTick()
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      ['https://a.example/file', 'https://b.example/file', 'https://c.example/file'].join('\n'),
    )
    expect(appStore.pendingBatch).toEqual([])
  })

  it('resets batch list ui state on close so the next open does not leave an empty batch shell behind', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('torrent', '/tmp/one.torrent')]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    // Batch list should be visible when there are file items
    const batchListBeforeClose = wrapper.find('.batch-list')
    expect(batchListBeforeClose.exists()).toBe(true)

    // Simulate close: clear batch and hide dialog
    appStore.pendingBatch = []
    appStore.hideAddTaskDialog()
    await wrapper.setProps({ show: false })
    await flushPromises()

    // Re-open with empty batch — textarea should be empty, no stale state
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe('')
  })
})
