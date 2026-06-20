import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import AddTask from '@/components/task/AddTask.vue'
import AdvancedOptions from '@/components/task/addtask/AdvancedOptions.vue'
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
  homeDir: vi.fn(async () => '/home/test'),
  appDataDir: vi.fn(async () => '/home/test/.local/share/com.motrix.next'),
  join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: readFileMock,
  exists: vi.fn(async () => true),
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
    inheritAttrs: false,
    emits: ['click'],
    setup(_, { slots, emit, attrs }) {
      return () => h('button', { ...attrs, onClick: () => emit('click') }, slots.default ? slots.default() : [])
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

  const NSwitch = defineComponent({
    props: {
      value: { type: Boolean, default: false },
    },
    emits: ['update:value'],
    setup(props, { emit }) {
      return () =>
        h('input', {
          type: 'checkbox',
          checked: props.value,
          onChange: (e: Event) => emit('update:value', (e.target as HTMLInputElement).checked),
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
    NSwitch,
    NButton,
    NSpace: passthrough,
    NGrid: passthrough,
    NGridItem: passthrough,
    NIcon: passthrough,
    NInputGroup: passthrough,
    NDataTable,
    NTag: passthrough,
    NEllipsis: passthrough,
    NPopover: passthrough,
    NEmpty: passthrough,
    NCheckbox: passthrough,
    NCollapseTransition: passthrough,
  }
})

function mountDialog() {
  return mount(AddTask, {
    props: { show: false },
    global: {
      stubs: {
        AdvancedOptions,
      },
    },
  })
}

function getTextarea(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('textarea')
}

function getRenameInput(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('input[placeholder="task.task-out-tips"]')
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

  it('keeps raw Thunder links visible in the textarea when opening extension batch items', async () => {
    const appStore = useAppStore()
    const thunder = 'thunder://' + btoa('AAhttps://example.com/file.zipZZ')
    appStore.pendingBatch = [createBatchItem('uri', thunder)]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(thunder)
    expect(appStore.pendingBatch).toEqual([])
  })

  it('replaces textarea with newly arriving batch items (batch priority over prior content)', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('uri', 'https://a.example/file\nhttps://b.example/file')]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      ['https://a.example/file', 'https://b.example/file'].join('\n'),
    )

    // New batch items arrive while dialog is open (e.g. extension deep-link).
    // These REPLACE the textarea content instead of merging, because batch
    // content takes priority over any clipboard auto-fill.
    appStore.pendingBatch = [
      createBatchItem('uri', 'https://b.example/file\nhttps://c.example/file'),
      createBatchItem('uri', 'https://a.example/file'),
    ]

    await nextTick()
    await flushPromises()

    // Only the new batch items appear — prior textarea content is replaced.
    // mergeUriLines still deduplicates within the new batch itself.
    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe(
      ['https://b.example/file', 'https://c.example/file', 'https://a.example/file'].join('\n'),
    )
    expect(appStore.pendingBatch).toEqual([])
  })

  it('clears stale rename value when a new batch without filename arrives while open', async () => {
    const appStore = useAppStore()
    appStore.pendingFilename = 'old.zip'

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    expect((getRenameInput(wrapper).element as HTMLInputElement).value).toBe('old.zip')

    appStore.pendingFilename = ''
    appStore.pendingBatch = [createBatchItem('uri', 'https://example.com/new.zip')]

    await nextTick()
    await flushPromises()

    expect((getTextarea(wrapper).element as HTMLTextAreaElement).value).toBe('https://example.com/new.zip')
    expect((getRenameInput(wrapper).element as HTMLInputElement).value).toBe('')
  })

  it('resets batch list ui state on close so the next open does not leave an empty batch shell behind', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('torrent', '/tmp/one.torrent')]

    const wrapper = mountDialog()

    await wrapper.setProps({ show: true })
    await flushPromises()

    // Torrent panel should be visible when there are file items
    const torrentPanel = wrapper.find('.torrent-panel')
    expect(torrentPanel.exists()).toBe(true)

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

describe('AddTask split preference sync', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
  })

  it('syncs form.split from preferenceStore.config.split when dialog opens', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    // Simulate user having saved maxConnectionPerServer=32 in Basic settings
    // which writes split=32 to the store via transformDownloadsForStore
    preferenceStore.$patch({ config: { split: 32, maxConnectionPerServer: 32 } })

    const wrapper = mountDialog()
    await flushPromises()

    // Initially mounted with stale default (64 from DEFAULT_APP_CONFIG)
    // Opening the dialog should sync to the store's latest value
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    // Find the split input (NInputNumber renders as <input type="number">)
    const numberInputs = wrapper.findAll('input[type="number"]')
    // The split input should reflect the store value, not the stale default
    const splitInput = numberInputs.find((i) => Number((i.element as HTMLInputElement).value) <= 64)
    expect(splitInput).toBeDefined()
    expect(Number((splitInput!.element as HTMLInputElement).value)).toBe(32)
  })

  it('preserves current form.split when config.split is absent (no maxConn fallback in v2)', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    // Simulate legacy store data where split was never saved — explicitly
    // null out split so the ?? fallback keeps current form.split.
    // After v2 decoupling, there is no fallback to maxConnectionPerServer.
    preferenceStore.$patch({
      config: { split: undefined as unknown as number, maxConnectionPerServer: 48 },
    })

    const wrapper = mountDialog()
    await flushPromises()

    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    const numberInputs = wrapper.findAll('input[type="number"]')
    const splitInput = numberInputs.find((i) => {
      const val = Number((i.element as HTMLInputElement).value)
      return val > 0 && val <= 256
    })
    expect(splitInput).toBeDefined()
    // When config.split is undefined, form.split retains its initialization
    // value (from config.split in the reactive form, which is the initial 16).
    // It does NOT fall back to maxConnectionPerServer (v2 decoupling).
    expect(Number((splitInput!.element as HTMLInputElement).value)).not.toBe(48)
  })

  it('re-syncs split on subsequent opens after preference changes', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    preferenceStore.$patch({ config: { split: 64, maxConnectionPerServer: 64 } })

    const wrapper = mountDialog()
    await flushPromises()

    // First open — split should be 64
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    // Close
    await wrapper.setProps({ show: false })
    await flushPromises()

    // User changes preference while dialog is closed
    preferenceStore.$patch({ config: { split: 16, maxConnectionPerServer: 16 } })

    // Re-open — split should now be 16
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    const numberInputs = wrapper.findAll('input[type="number"]')
    const splitInput = numberInputs.find((i) => {
      const val = Number((i.element as HTMLInputElement).value)
      return val > 0 && val <= 128
    })
    expect(splitInput).toBeDefined()
    expect(Number((splitInput!.element as HTMLInputElement).value)).toBe(16)
  })

  it('syncs task proxy mode while the dialog is open when proxy preference changes', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    preferenceStore.$patch({
      config: { proxy: { mode: 'direct', server: '', bypass: '', scope: ['download'] } },
    })

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()
    await nextTick()

    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    const proxyCheckbox = checkboxes[checkboxes.length - 1].element as HTMLInputElement
    expect(proxyCheckbox.checked).toBe(false)

    preferenceStore.$patch({
      config: {
        proxy: {
          mode: 'manual',
          server: 'http://127.0.0.1:7890',
          bypass: '',
          scope: ['download'],
        },
      },
    })
    await nextTick()

    expect((wrapper.findAll('input[type="checkbox"]').pop()!.element as HTMLInputElement).checked).toBe(true)
    const proxyInput = wrapper.find('input[placeholder="http://host:port"]')
    expect((proxyInput.element as HTMLInputElement).value).toBe('http://127.0.0.1:7890')
  })
})

describe('AddTask redesigned layout and animation structure', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetBatchIdCounter()
  })

  it('renders a textarea for URI input in the URI tab', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = []

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(getTextarea(wrapper).exists()).toBe(true)
  })

  // ── Torrent panel: conditional rendering ───────────────────────────

  it('shows the torrent panel (.torrent-panel) when fileItems exist', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('torrent', '/tmp/a.torrent')]

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.find('.torrent-panel').exists()).toBe(true)
  })

  it('hides the torrent panel when no fileItems exist', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = []

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.find('.torrent-panel').exists()).toBe(false)
  })

  it('renders batch items inside the torrent panel', async () => {
    const appStore = useAppStore()
    appStore.pendingBatch = [createBatchItem('torrent', '/tmp/a.torrent'), createBatchItem('torrent', '/tmp/b.torrent')]

    const wrapper = mountDialog()
    await wrapper.setProps({ show: true })
    await flushPromises()

    expect(wrapper.findAll('.batch-item').length).toBe(2)
  })
})
