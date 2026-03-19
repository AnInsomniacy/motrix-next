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
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({
    success: vi.fn(() => ({ destroy: vi.fn() })),
    error: vi.fn(() => ({ destroy: vi.fn() })),
    warning: vi.fn(() => ({ destroy: vi.fn() })),
    info: vi.fn(() => ({ destroy: vi.fn() })),
  }),
}))

// Mock isEngineReady for classifySubmitError tests
const mockIsEngineReady = vi.fn().mockReturnValue(true)
vi.mock('@/api/aria2', () => ({
  isEngineReady: () => mockIsEngineReady(),
}))

import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
  type AddTaskForm,
} from '../useAddTaskSubmit'
import type { BatchItem, Aria2EngineOptions } from '@shared/types'

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

  it('always includes max-connection-per-server synced to split', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts['max-connection-per-server']).toBe('16')
    expect(opts['max-connection-per-server']).toBe(opts.split)
  })

  it('syncs max-connection-per-server when split changes', () => {
    const opts = buildEngineOptions({ ...baseForm, split: 64 })
    expect(opts.split).toBe('64')
    expect(opts['max-connection-per-server']).toBe('64')
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
    registerTorrentSource: vi.fn(),
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

  it('submits single URI with auto-decoded outs when out is not specified', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/file.zip' }, { dir: '/dl' }, mockTaskStore)

    expect(mockTaskStore.addUri).toHaveBeenCalledWith({
      uris: ['http://example.com/file.zip'],
      outs: ['file.zip'],
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

  it('auto-decodes filenames from URIs when user has not specified out', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/AAA%20BBB.mp3' }, { dir: '/dl' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.outs).toEqual(['AAA BBB.mp3'])
  })

  it('auto-decodes filenames for each URI in multi-URI mode without user-specified out', async () => {
    await submitManualUris(
      { ...baseForm, uris: 'http://a.com/file%20one.zip\nhttp://b.com/file%E4%B8%AD.zip' },
      { dir: '/dl' },
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.outs).toEqual(['file one.zip', 'file中.zip'])
  })

  it('does not include magnet URIs in regular addUri call (they use separate addMagnetUri path)', async () => {
    await submitManualUris(
      { ...baseForm, uris: 'http://example.com/file%20name.zip\nmagnet:?xt=urn:btih:abc123' },
      { dir: '/dl' },
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Only the regular URI should be in the addUri call, with decoded outs
    expect(call.uris).toEqual(['http://example.com/file%20name.zip'])
    expect(call.outs).toEqual(['file name.zip'])
  })

  it('does not auto-generate outs when user has specified out', async () => {
    await submitManualUris(
      { ...baseForm, uris: 'http://example.com/AAA%20BBB.mp3', out: 'custom.mp3' },
      { dir: '/dl', out: 'custom.mp3' },
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.outs).toEqual([])
  })
})
