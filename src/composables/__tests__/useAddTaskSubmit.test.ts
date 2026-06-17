/**
 * @fileoverview Tests for the extracted AddTask submission logic.
 *
 * Tests REAL pure functions without mocking them:
 * - buildEngineOptions: form → aria2 options conversion
 * - classifySubmitError: error categorization
 * - submitBatchItems: batch routing to torrent store
 * - submitManualUris: multi-URI handling with rename
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

// ── Mock external dependencies ──────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params?.taskName ? `${key}:${params.taskName}` : key),
  }),
}))

const mockRouterPush = vi.fn().mockResolvedValue(undefined)
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockRouterPush }),
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

const mockAppStore = {
  pendingBatch: [] as BatchItem[],
}

const mockTaskStoreForHook = {
  addUri: vi.fn().mockResolvedValue(['gid1']),
  addMagnetUri: vi.fn().mockResolvedValue('magnet-gid'),
  addTorrent: vi.fn(),
  registerTorrentSource: vi.fn(),
}

const mockPreferenceStore = {
  config: {
    newTaskShowDownloading: true,
    proxy: { mode: 'direct', server: '', scope: [], bypass: '' },
    fileCategoryEnabled: false,
    fileCategories: [],
  },
}

const mockMessage = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}

vi.mock('@/stores/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('@/stores/task', () => ({
  useTaskStore: () => mockTaskStoreForHook,
}))

vi.mock('@/stores/preference', () => ({
  usePreferenceStore: () => mockPreferenceStore,
}))

vi.mock('@/composables/useAppMessage', () => ({
  useAppMessage: () => mockMessage,
}))

import {
  buildEngineOptions,
  classifySubmitError,
  submitBatchItems,
  submitManualUris,
  useAddTaskSubmit,
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
    httpAuthUsername: '',
    httpAuthPassword: '',
    saveHttpAuth: true,
    proxyMode: 'direct',
    customProxy: '',
    requestHeaders: [],
    multiSource: false,
  }

  it('always includes dir and split', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.dir).toBe('/downloads')
    expect(opts.split).toBe('16')
  })

  it('does NOT include max-connection-per-server (uses global value since v2)', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts['max-connection-per-server']).toBeUndefined()
  })

  it('includes split without coupling to max-connection-per-server', () => {
    const opts = buildEngineOptions({ ...baseForm, split: 128 })
    expect(opts.split).toBe('128')
    expect(opts['max-connection-per-server']).toBeUndefined()
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

  it('keeps plugin user-agent unless a matching saved rule overrides it', () => {
    const form = {
      ...baseForm,
      defaultUserAgent: 'DefaultUA/1.0',
      userAgentProfiles: [
        { id: 'quark', name: 'Quark Drive', value: 'QuarkUA/1.0', createdAt: 1, updatedAt: 1 },
        { id: 'baidu', name: 'Baidu Netdisk', value: 'BaiduUA/1.0', createdAt: 2, updatedAt: 2 },
      ],
      userAgentRules: [
        {
          id: 'quark-rule',
          enabled: true,
          hostPattern: '*.quark.cn',
          profileId: 'quark',
          overridePlugin: false,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'baidu-rule',
          enabled: true,
          hostPattern: 'pan.baidu.com',
          profileId: 'baidu',
          overridePlugin: true,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    }

    expect(
      buildEngineOptions(form, { url: 'https://cdn.quark.cn/file.zip', userAgent: 'BrowserUA/1.0' })['user-agent'],
    ).toBe('BrowserUA/1.0')
    expect(
      buildEngineOptions(form, { url: 'https://pan.baidu.com/file.zip', userAgent: 'BrowserUA/1.0' })['user-agent'],
    ).toBe('BaiduUA/1.0')
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

  it('merges sanitized browser request headers before explicit cookie and authorization', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      cookie: 'session=abc',
      authorization: 'Bearer token',
      requestHeaders: [
        { name: 'Accept', value: 'application/octet-stream' },
        { name: 'Accept-Language', value: 'en-US,en;q=0.9' },
      ],
    })

    expect(opts.header).toEqual([
      'Accept: application/octet-stream',
      'Accept-Language: en-US,en;q=0.9',
      'Cookie: session=abc',
      'Authorization: Bearer token',
    ])
  })

  it('drops unsafe, forbidden, duplicate, and overlong browser request headers', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      requestHeaders: [
        { name: 'Accept', value: 'application/octet-stream' },
        { name: 'Accept', value: 'text/html' },
        { name: 'Host', value: 'example.com' },
        { name: 'X-Evil', value: 'bad' },
        { name: 'Origin', value: 'https://example.com\r\nInjected: bad' },
        { name: 'DNT', value: '1' },
        { name: 'Accept-Language', value: 'x'.repeat(8193) },
      ],
    })

    expect(opts.header).toEqual(['Accept: application/octet-stream', 'DNT: 1'])
  })

  it('drops explicit header fields that contain CRLF instead of joining injected segments', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      userAgent: 'MyUA\r\nInjected: bad',
      referer: 'https://r.com\n',
      cookie: 'session=abc\r\nX-Evil: 1',
      authorization: 'Bearer token\nAnother: bad',
    })

    expect(opts['user-agent']).toBeUndefined()
    expect(opts.referer).toBeUndefined()
    expect(opts.header).toBeUndefined()
  })

  it('builds HTTP Basic Auth options from form fields', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      httpAuthUsername: ' demo ',
      httpAuthPassword: ' secret ',
    })
    expect(opts['http-user']).toBe('demo')
    expect(opts['http-passwd']).toBe('secret')
  })

  it('trims clean explicit HTTP header values before building aria2 options', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      userAgent: ' MyUA ',
      referer: ' https://r.com ',
      cookie: ' session=abc ',
      authorization: ' Bearer token ',
    })

    expect(opts['user-agent']).toBe('MyUA')
    expect(opts.referer).toBe('https://r.com')
    expect(opts.header).toEqual(['Cookie: session=abc', 'Authorization: Bearer token'])
  })

  it('omits header when no cookie or auth', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.header).toBeUndefined()
  })

  // ── Proxy mode tests ──

  it('forces direct mode when proxyMode is direct', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'direct',
    })
    expect(opts['proxy-mode']).toBeUndefined()
    expect(opts['all-proxy']).toBe('')
  })

  it('sets manual proxy options when proxyMode is manual with valid address', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'manual',
      customProxy: 'http://10.0.0.1:8080',
    })
    expect(opts['proxy-mode']).toBeUndefined()
    expect(opts['all-proxy']).toBe('http://10.0.0.1:8080')
  })

  it('sets structured proxy authentication options for manual task proxy', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'manual',
      customProxy: 'http://10.0.0.1:8080',
      customProxyUsername: 'proxy-user',
      customProxyPassword: 'proxy-pass',
    })
    expect(opts['all-proxy']).toBe('http://10.0.0.1:8080')
    expect(opts['all-proxy-user']).toBe('proxy-user')
    expect(opts['all-proxy-passwd']).toBe('proxy-pass')
    expect(opts['http-user']).toBeUndefined()
    expect(opts['http-passwd']).toBeUndefined()
  })

  it('falls back to direct when proxyMode is manual but customProxy is empty', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'manual',
      customProxy: '',
    })
    expect(opts['proxy-mode']).toBeUndefined()
    expect(opts['all-proxy']).toBe('')
  })

  it('inherits the app download proxy when manual task proxy has no custom address', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'manual',
      customProxy: '',
      appProxy: {
        mode: 'manual',
        server: 'http://127.0.0.1:7890',
        username: 'global-user',
        password: 'global-pass',
        bypass: 'localhost;127.*',
        scope: ['download'],
      },
    })
    expect(opts['proxy-mode']).toBeUndefined()
    expect(opts['all-proxy']).toBe('http://127.0.0.1:7890')
    expect(opts['all-proxy-user']).toBe('global-user')
    expect(opts['all-proxy-passwd']).toBe('global-pass')
    expect(opts['no-proxy']).toBe('localhost;127.*')
  })

  it('does not send all-proxy when proxyMode is direct even with customProxy set', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'direct',
      customProxy: 'http://10.0.0.1:8080',
    })
    expect(opts['proxy-mode']).toBeUndefined()
    expect(opts['all-proxy']).toBe('')
  })

  it('does not treat userinfo in proxy server as the credential source', () => {
    const opts = buildEngineOptions({
      ...baseForm,
      proxyMode: 'manual',
      customProxy: 'http://user:pass@proxy.example.com:8080',
    })
    expect(opts['all-proxy']).toBe('http://user:pass@proxy.example.com:8080')
    expect(opts['all-proxy-user']).toBeUndefined()
    expect(opts['all-proxy-passwd']).toBeUndefined()
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

  it('classifies duplicate Tauri AppError objects', () => {
    expect(classifySubmitError({ Aria2: 'aria2 RPC error [1]: GID already exists' })).toBe('duplicate')
  })
})

// ── submitBatchItems ────────────────────────────────────────────────

describe('submitBatchItems', () => {
  const mockTaskStore = {
    addTorrent: vi.fn().mockResolvedValue('gid1'),
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
  })

  it('removes out option for torrent items', async () => {
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

  it('stores readable failure text for structured Tauri errors', async () => {
    ;(mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      Aria2: 'aria2 RPC error [1]: Unsupported URI scheme',
    })

    const items: BatchItem[] = [
      { id: 8, kind: 'torrent', source: 'e.torrent', payload: 'b64', status: 'pending' } as unknown as BatchItem,
    ]

    const failures = await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(failures).toBe(1)
    expect(items[0].error).toBe('Aria2 Next error [1]: Unsupported URI scheme')
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
    addMagnetUri: vi.fn().mockResolvedValue('magnet-gid'),
    addTorrent: vi.fn().mockResolvedValue('torrent-gid'),
    registerTorrentSource: vi.fn(),
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
    httpAuthUsername: '',
    httpAuthPassword: '',
    saveHttpAuth: true,
    proxyMode: 'direct',
    customProxy: '',
    requestHeaders: [],
    multiSource: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when uris is empty/whitespace', async () => {
    await submitManualUris({ ...baseForm, uris: '  ' }, {}, mockTaskStore)
    expect(mockTaskStore.addUri).not.toHaveBeenCalled()
  })

  it('submits single URI with extension — outs contains empty string (no HEAD needed)', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/file.zip' }, { dir: '/dl' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.uris).toEqual(['http://example.com/file.zip'])
    // Each URI produces an empty string (= let aria2 decide), not a flat []
    expect(call.outs).toEqual([''])
    expect(call.options).toEqual({ dir: '/dl' })
  })

  it('submits manual remote torrent URLs as ordinary URI downloads', async () => {
    const { invoke } = await import('@tauri-apps/api/core')

    await submitManualUris(
      { ...baseForm, uris: 'https://example.com/linux.torrent?token=abc' },
      { dir: '/dl' },
      mockTaskStore,
    )

    expect(invoke).not.toHaveBeenCalledWith('fetch_remote_bytes', expect.anything())
    expect(mockTaskStore.addTorrent).not.toHaveBeenCalled()
    expect(mockTaskStore.addUri).toHaveBeenCalledWith({
      uris: ['https://example.com/linux.torrent?token=abc'],
      outs: [''],
      options: { dir: '/dl' },
    })
  })

  it('passes Thunder links to the engine for manual URI tasks', async () => {
    const thunder = 'thunder://' + btoa('AAhttps://example.com/file.zipZZ')

    await submitManualUris({ ...baseForm, uris: thunder }, { dir: '/dl' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.uris).toEqual([thunder])
    expect(call.outs).toEqual([''])
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

  it('does not invoke HEAD for percent-encoded URIs with extension — aria2 handles decode natively', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/AAA%20BBB.mp3' }, { dir: '/dl' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // .mp3 has an extension → hasExtension returns true → no HEAD request
    expect(call.outs).toEqual([''])
  })

  it('invokes resolve_filename for extensionless URL paths', async () => {
    // This URL has no extension in the path — resolve_filename is invoked
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('215.zip')

    await submitManualUris(
      { ...baseForm, uris: 'https://datashop.cboe.com/download/sample/215' },
      { dir: '/dl' },
      mockTaskStore,
    )

    expect(invoke).toHaveBeenCalledWith('resolve_filename', {
      url: 'https://datashop.cboe.com/download/sample/215',
      proxy: null,
    })
    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.outs).toEqual(['215.zip'])
  })

  it('passes referer and cookie to resolve_filename for authenticated extensionless URLs', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('Итоги_2026.docx')

    const result = await submitManualUris(
      {
        ...baseForm,
        uris: 'https://mail-attachment.googleusercontent.com/attachment/u/0/',
        referer: 'https://mail.google.com/mail/u/0/#inbox',
        cookie: 'COMPASS=gmail=abc',
      },
      { dir: '/dl', referer: 'https://mail.google.com/mail/u/0/#inbox', header: ['Cookie: COMPASS=gmail=abc'] },
      mockTaskStore,
    )

    expect(invoke).toHaveBeenCalledWith('resolve_filename', {
      url: 'https://mail-attachment.googleusercontent.com/attachment/u/0/',
      proxy: null,
      referer: 'https://mail.google.com/mail/u/0/#inbox',
      cookie: 'COMPASS=gmail=abc',
    })
    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.outs).toEqual(['Итоги_2026.docx'])
    expect(result.submittedTaskNames).toEqual(['Итоги_2026.docx'])
  })

  it('sanitizes referer and cookie before passing them to resolve_filename', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('safe.zip')

    await submitManualUris(
      {
        ...baseForm,
        uris: 'https://example.com/download',
        referer: 'https://example.com/\r\nInjected: bad',
        cookie: 'session=abc\nX-Evil: 1',
      },
      { dir: '/dl' },
      mockTaskStore,
    )

    expect(invoke).toHaveBeenCalledWith('resolve_filename', {
      url: 'https://example.com/download',
      proxy: null,
      referer: 'https://example.com/Injected: bad',
      cookie: 'session=abcX-Evil: 1',
    })
  })

  it('does not include magnet URIs in regular addUri call (they use separate addMagnetUri path)', async () => {
    await submitManualUris(
      { ...baseForm, uris: 'http://example.com/file%20name.zip\nmagnet:?xt=urn:btih:abc123' },
      { dir: '/dl' },
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Only the regular URI should be in the addUri call
    expect(call.uris).toEqual(['http://example.com/file%20name.zip'])
    expect(call.outs).toEqual(['']) // .zip has extension → empty string (no HEAD)
  })

  it('does not invoke resolve_filename when user has specified out', async () => {
    const { invoke } = await import('@tauri-apps/api/core')

    await submitManualUris(
      { ...baseForm, uris: 'http://example.com/AAA%20BBB.mp3', out: 'custom.mp3' },
      { dir: '/dl', out: 'custom.mp3' },
      mockTaskStore,
    )

    // User provided explicit out → buildOuts handles naming, resolve_filename not called
    expect(invoke).not.toHaveBeenCalledWith('resolve_filename', expect.anything())
  })

  it('returns structured magnet failures without throwing away successful submissions', async () => {
    ;(mockTaskStore.addMagnetUri as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('magnet-gid-1')
      .mockRejectedValueOnce(new Error('invalid magnet'))

    const result = await submitManualUris(
      {
        ...baseForm,
        uris: 'magnet:?xt=urn:btih:good\nmagnet:?xt=urn:btih:bad',
      },
      { dir: '/dl' },
      mockTaskStore,
    )

    expect(result).toEqual({
      submittedTaskNames: [],
      magnetGids: ['magnet-gid-1'],
      magnetFailures: [{ uri: 'magnet:?xt=urn:btih:bad', error: 'invalid magnet' }],
    })
  })
})

describe('useAddTaskSubmit', () => {
  const baseForm: AddTaskForm = {
    uris: '',
    out: '',
    dir: '/dl',
    split: 16,
    userAgent: '',
    authorization: '',
    referer: '',
    cookie: '',
    httpAuthUsername: '',
    httpAuthPassword: '',
    saveHttpAuth: true,
    proxyMode: 'direct',
    customProxy: '',
    requestHeaders: [],
    multiSource: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockAppStore.pendingBatch = []
    mockPreferenceStore.config.newTaskShowDownloading = true
    mockPreferenceStore.config.fileCategoryEnabled = false
    mockPreferenceStore.config.fileCategories = []
  })

  it('keeps AddTask open when a magnet submission fails', async () => {
    mockTaskStoreForHook.addMagnetUri.mockRejectedValueOnce(new Error('invalid magnet'))
    const onClose = vi.fn()

    const { handleSubmit } = useAddTaskSubmit({
      form: ref({ ...baseForm, uris: 'magnet:?xt=urn:btih:bad' }),
      onClose,
    })

    await handleSubmit()

    expect(onClose).not.toHaveBeenCalled()
    expect(mockMessage.warning).toHaveBeenCalledWith('1 task.failed', { closable: true })
    expect(mockRouterPush).not.toHaveBeenCalled()
  })

  it('shows readable toast text for structured Tauri add-uri errors', async () => {
    mockTaskStoreForHook.addUri.mockRejectedValueOnce({
      Aria2: 'aria2 RPC error [1]: Unsupported URI scheme',
    })
    const onClose = vi.fn()

    const { handleSubmit } = useAddTaskSubmit({
      form: ref({ ...baseForm, uris: '23222233' }),
      onClose,
    })

    await handleSubmit()

    expect(onClose).not.toHaveBeenCalled()
    expect(mockMessage.error).toHaveBeenCalledWith('task.error-aria2-next [1]: Unsupported URI scheme', {
      closable: true,
    })
  })

  it('uses the resolved output filename in the start toast for extensionless URLs', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('ИТОГИ ЛДУ 2026.xlsx')
    const onClose = vi.fn()

    const { handleSubmit } = useAddTaskSubmit({
      form: ref({
        ...baseForm,
        uris: 'http://127.0.0.1:18080/attachment/u/0/?ui=2&disp=safe',
      }),
      onClose,
    })

    await handleSubmit()

    expect(mockMessage.info).toHaveBeenCalledWith('task.download-start-message:ИТОГИ ЛДУ 2026.xlsx')
  })
})
