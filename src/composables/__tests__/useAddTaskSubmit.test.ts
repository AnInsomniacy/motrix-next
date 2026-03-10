/**
 * @fileoverview Tests for the extracted AddTask submission logic.
 *
 * Tests REAL pure functions without mocking them:
 * - buildEngineOptions: form → aria2 options conversion
 * - classifySubmitError: error categorization
 * - submitBatchItems: batch routing to torrent/metalink stores
 * - submitManualUris: multi-URI handling with rename
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock external dependencies ──────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, te: () => false }),
}))

const mockNotificationError = vi.fn(() => ({ destroy: vi.fn() }))
const mockNotificationWarning = vi.fn(() => ({ destroy: vi.fn() }))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    success: vi.fn(() => ({ destroy: vi.fn() })),
    error: vi.fn(() => ({ destroy: vi.fn() })),
    warning: vi.fn(() => ({ destroy: vi.fn() })),
    info: vi.fn(() => ({ destroy: vi.fn() })),
  }),
  useNotification: () => ({
    error: mockNotificationError,
    warning: mockNotificationWarning,
    info: vi.fn(() => ({ destroy: vi.fn() })),
    success: vi.fn(() => ({ destroy: vi.fn() })),
  }),
}))

// Mock isEngineReady for classifySubmitError tests
const mockIsEngineReady = vi.fn().mockReturnValue(true)
vi.mock('@/api/aria2', () => ({
  isEngineReady: () => mockIsEngineReady(),
}))

const mockRouterPush = vi.fn().mockResolvedValue(undefined)
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
}))

vi.mock('@shared/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
  useAddTaskSubmit,
  type AddTaskForm,
} from '../useAddTaskSubmit'
import type { BatchItem, Aria2EngineOptions } from '@shared/types'

function withSetup<T>(composableFn: () => T): { result: T; unmount: () => void } {
  let result!: T
  const wrapper = mount(
    defineComponent({
      setup() {
        result = composableFn()
        return {}
      },
      template: '<div />',
    }),
  )
  return { result, unmount: () => wrapper.unmount() }
}

// ── buildEngineOptions ──────────────────────────────────────────────

describe('buildEngineOptions', () => {
  const baseForm: AddTaskForm = {
    uris: '',
    out: '',
    dir: '/downloads',
    split: 16,
    userAgent: '',
    authorization: '',
    referer: '',
    cookie: '',
    allProxy: '',
  }

  it('always includes dir and split', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.dir).toBe('/downloads')
    expect(opts.split).toBe('16')
  })

  it('includes out when non-empty', () => {
    const opts = buildEngineOptions({ ...baseForm, out: 'file.zip' })
    expect(opts.out).toBe('file.zip')
  })

  it('omits out when empty', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.out).toBeUndefined()
  })

  it('includes user-agent when set', () => {
    const opts = buildEngineOptions({ ...baseForm, userAgent: 'MyUA/1.0' })
    expect(opts['user-agent']).toBe('MyUA/1.0')
  })

  it('includes referer when set', () => {
    const opts = buildEngineOptions({ ...baseForm, referer: 'https://r.com' })
    expect(opts.referer).toBe('https://r.com')
  })

  it('builds header array from cookie and authorization', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      cookie: 'session=abc',
      authorization: 'Bearer token',
    })
    expect(opts.header).toEqual(['Cookie: session=abc', 'Authorization: Bearer token'])
  })

  it('omits header when no cookie or auth', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.header).toBeUndefined()
  })

  it('includes all-proxy when set', () => {
    const opts = buildEngineOptions({ ...baseForm, allProxy: 'socks5://127.0.0.1:1080' })
    expect(opts['all-proxy']).toBe('socks5://127.0.0.1:1080')
  })
})

// ── classifySubmitError ─────────────────────────────────────────────

describe('classifySubmitError', () => {
  beforeEach(() => {
    mockIsEngineReady.mockReturnValue(true)
  })

  it('returns engine-not-ready when message contains "not initialized"', () => {
    expect(classifySubmitError(new Error('Aria2 client not initialized'))).toBe('engine-not-ready')
  })

  it('returns engine-not-ready when engine is not ready', () => {
    mockIsEngineReady.mockReturnValue(false)
    expect(classifySubmitError(new Error('some error'))).toBe('engine-not-ready')
  })

  it('returns duplicate for "already exists" errors', () => {
    expect(classifySubmitError(new Error('GID already exists'))).toBe('duplicate')
  })

  it('returns duplicate for "duplicate download" errors', () => {
    expect(classifySubmitError(new Error('duplicate download detected'))).toBe('duplicate')
  })

  it('returns generic for unknown errors', () => {
    expect(classifySubmitError(new Error('network timeout'))).toBe('generic')
  })

  it('handles non-Error values', () => {
    expect(classifySubmitError('some string error')).toBe('generic')
  })
})

// ── submitBatchItems ────────────────────────────────────────────────

describe('submitBatchItems', () => {
  const mockTaskStore = {
    addTorrent: vi.fn().mockResolvedValue('gid1'),
    addMetalink: vi.fn().mockResolvedValue(['gid2']),
  } as unknown as ReturnType<typeof import('@/stores/task').useTaskStore>

  const baseOptions: Aria2EngineOptions = { dir: '/dl', split: '16' }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('submits torrent items via addTorrent', async () => {
    const items: BatchItem[] = [
      { id: 1, kind: 'torrent', source: 'a.torrent', payload: 'base64', status: 'pending' } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(mockTaskStore.addTorrent).toHaveBeenCalledWith({
      torrent: 'base64',
      options: expect.objectContaining({ dir: '/dl' }),
    })
    expect(items[0].status).toBe('submitted')
  })

  it('submits metalink items via addMetalink', async () => {
    const items: BatchItem[] = [
      { id: 2, kind: 'metalink', source: 'b.meta4', payload: 'mlData', status: 'pending' } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(mockTaskStore.addMetalink).toHaveBeenCalledWith({
      metalink: 'mlData',
      options: expect.objectContaining({ dir: '/dl' }),
    })
    expect(items[0].status).toBe('submitted')
  })

  it('skips URI items (handled separately)', async () => {
    const items: BatchItem[] = [
      {
        id: 3,
        kind: 'uri',
        source: 'http://e.com',
        payload: 'http://e.com',
        status: 'pending',
      } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(mockTaskStore.addTorrent).not.toHaveBeenCalled()
    expect(mockTaskStore.addMetalink).not.toHaveBeenCalled()
  })

  it('removes out option for torrent/metalink items', async () => {
    const items: BatchItem[] = [
      { id: 4, kind: 'torrent', source: 'c.torrent', payload: 'b64', status: 'pending' } as unknown as BatchItem,
    ]
    const opts = { ...baseOptions, out: 'custom.zip' }

    await submitBatchItems(items, opts, mockTaskStore)

    const passedOpts = (mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mock.calls[0][0].options
    expect(passedOpts.out).toBeUndefined()
  })

  it('includes select-file when partial selection', async () => {
    const items: BatchItem[] = [
      {
        id: 5,
        kind: 'torrent',
        source: 'd.torrent',
        payload: 'b64',
        status: 'pending',
        selectedFileIndices: [1, 3],
        torrentMeta: { files: [{ idx: 1 }, { idx: 2 }, { idx: 3 }] },
      } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    const passedOpts = (mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mock.calls[0][0].options
    expect(passedOpts['select-file']).toBe('1,3')
  })

  it('marks items as failed on error and returns failure count', async () => {
    ;(mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('engine down'))

    const items: BatchItem[] = [
      { id: 6, kind: 'torrent', source: 'e.torrent', payload: 'b64', status: 'pending' } as unknown as BatchItem,
    ]

    const failures = await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(failures).toBe(1)
    expect(items[0].status).toBe('failed')
    expect(items[0].error).toBe('engine down')
  })

  it('skips already submitted items', async () => {
    const items: BatchItem[] = [
      { id: 7, kind: 'torrent', source: 'f.torrent', payload: 'b64', status: 'submitted' } as unknown as BatchItem,
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore)
    expect(mockTaskStore.addTorrent).not.toHaveBeenCalled()
  })
})

// ── submitManualUris ────────────────────────────────────────────────

describe('submitManualUris', () => {
  const mockTaskStore = {
    addUri: vi.fn().mockResolvedValue(['gid1']),
  } as unknown as ReturnType<typeof import('@/stores/task').useTaskStore>

  const baseForm: AddTaskForm = {
    uris: '',
    out: '',
    dir: '/dl',
    split: 16,
    userAgent: '',
    authorization: '',
    referer: '',
    cookie: '',
    allProxy: '',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when uris is empty/whitespace', async () => {
    await submitManualUris({ ...baseForm, uris: '  ' }, {}, mockTaskStore)
    expect(mockTaskStore.addUri).not.toHaveBeenCalled()
  })

  it('submits single URI without outs', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/file.zip' }, { dir: '/dl' }, mockTaskStore)

    expect(mockTaskStore.addUri).toHaveBeenCalledWith({
      uris: ['http://example.com/file.zip'],
      outs: [],
      options: { dir: '/dl' },
    })
  })

  it('generates numbered outs for multi-URI with out specified', async () => {
    await submitManualUris(
      { ...baseForm, uris: 'http://a.com/1\nhttp://b.com/2', out: 'file.zip' },
      { dir: '/dl' },
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.uris).toHaveLength(2)
    // Should have generated numbered filenames (fallback since buildOuts may return empty)
    expect(call.outs.length).toBeGreaterThan(0)
  })

  it('submits multi-URI without out as empty outs array', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://a.com/1\nhttp://b.com/2' }, { dir: '/dl' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.outs).toEqual([])
  })
})

// ── handleSubmit error notification paths ───────────────────────────

describe('handleSubmit error notifications', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockIsEngineReady.mockReturnValue(true)
  })

  function setupSubmit(uris: string) {
    const appStore = useAppStore()
    const taskStore = useTaskStore()
    // Make addUri reject to trigger error paths
    taskStore.addUri = vi.fn().mockRejectedValue(new Error('not initialized'))
    appStore.pendingBatch = []
    const form = ref<AddTaskForm>({
      uris,
      out: '',
      dir: '/dl',
      split: 16,
      userAgent: '',
      authorization: '',
      referer: '',
      cookie: '',
      allProxy: '',
    })
    const onClose = vi.fn()
    const { result, unmount } = withSetup(() => useAddTaskSubmit({ form, onClose }))
    return { result, unmount, taskStore }
  }

  it('calls notifyError with engine hint when engine is not ready', async () => {
    mockIsEngineReady.mockReturnValue(false)
    const { result, unmount, taskStore } = setupSubmit('http://example.com/file.zip')
    taskStore.addUri = vi.fn().mockRejectedValue(new Error('some error'))

    await result.handleSubmit()

    expect(mockNotificationError).toHaveBeenCalledOnce()
    const opts = (mockNotificationError.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    // Should show engine error title (falls back to generic since te() returns false in mock)
    expect(opts.title).toBeDefined()
    unmount()
  })

  it('calls notifyError with task hint for generic submit errors', async () => {
    const { result, unmount, taskStore } = setupSubmit('http://example.com/file.zip')
    taskStore.addUri = vi.fn().mockRejectedValue(new Error('network timeout'))

    await result.handleSubmit()

    expect(mockNotificationError).toHaveBeenCalledOnce()
    unmount()
  })

  it('does not call notifyError for duplicate errors (uses message.warning)', async () => {
    const { result, unmount, taskStore } = setupSubmit('http://example.com/file.zip')
    taskStore.addUri = vi.fn().mockRejectedValue(new Error('GID already exists'))

    await result.handleSubmit()

    expect(mockNotificationError).not.toHaveBeenCalled()
    unmount()
  })
})
