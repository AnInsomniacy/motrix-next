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

// ── Mock external dependencies ──────────────────────────────────────
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
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
    streamMaxConnections: 16,
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
  }
  it('includes the canonical stream connection limit', () => {
    const opts = buildEngineOptions(baseForm)
    expect(opts.dir).toBe('/downloads')
    expect(opts['stream-max-connections']).toBe('16')
  })

  it('uses a per-task stream connection limit', () => {
    const opts = buildEngineOptions({ ...baseForm, streamMaxConnections: 8 })
    expect(opts['stream-max-connections']).toBe('8')
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

  const baseOptions: Aria2EngineOptions = { dir: '/dl', 'stream-max-connections': '16' }
  const readyTorrent = (overrides: Partial<BatchItem> = {}): BatchItem => ({
    id: 'torrent-1',
    kind: 'torrent',
    source: 'a.torrent',
    displayName: 'Archive',
    payload: 'base64',
    status: 'pending',
    inspectionState: 'ready',
    selectedFileIndices: [1, 3],
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('submits torrent items via addTorrent', async () => {
    const items = [readyTorrent()]

    await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(mockTaskStore.addTorrent).toHaveBeenCalledWith({
      torrent: 'base64',
      options: expect.objectContaining({ dir: '/dl', 'select-file': '1,3' }),
    })
    expect(items[0].status).toBe('submitted')
  })

  it('uses native torrent metadata to select the category directory', async () => {
    const items = [
      readyTorrent({
        selectedFileIndices: [1],
        torrentMeta: {
          name: 'movie',
          mode: 'single',
          infoHashV1: 'hash',
          infoHashV2: '',
          totalLength: '1000',
          files: [{ index: '1', path: 'movie.mkv', length: '1000' }],
        },
      }),
    ]

    await submitBatchItems(items, baseOptions, mockTaskStore, {
      enabled: true,
      categories: [{ label: 'Videos', extensions: ['mkv'], directory: '/dl/Videos' }],
    })

    expect(mockTaskStore.addTorrent).toHaveBeenCalledWith({
      torrent: 'base64',
      options: { dir: '/dl/Videos', 'select-file': '1' },
    })
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
    const items = [readyTorrent({ source: 'c.torrent', payload: 'b64' })]
    const opts = { ...baseOptions, out: 'custom.zip' }

    await submitBatchItems(items, opts, mockTaskStore)

    const passedOpts = (mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mock.calls[0][0].options
    expect(passedOpts.out).toBeUndefined()
    expect(passedOpts['stream-max-connections']).toBeUndefined()
  })

  it('marks items as failed on error and returns failure count', async () => {
    ;(mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('engine down'))

    const items = [readyTorrent({ source: 'e.torrent', payload: 'b64' })]

    const failures = await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(failures).toBe(1)
    expect(items[0].status).toBe('failed')
    expect(items[0].error).toBe('engine down')
  })

  it('stores readable failure text for structured Tauri errors', async () => {
    ;(mockTaskStore.addTorrent as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      Aria2: 'aria2 RPC error [1]: Unsupported URI scheme',
    })

    const items = [readyTorrent({ source: 'e.torrent', payload: 'b64' })]

    const failures = await submitBatchItems(items, baseOptions, mockTaskStore)

    expect(failures).toBe(1)
    expect(items[0].error).toBe('Aria2 Next error [1]: Unsupported URI scheme')
  })

  it('skips already submitted items', async () => {
    const items = [readyTorrent({ source: 'f.torrent', payload: 'b64', status: 'submitted' })]

    await submitBatchItems(items, baseOptions, mockTaskStore)
    expect(mockTaskStore.addTorrent).not.toHaveBeenCalled()
  })
})

// ── submitManualUris ────────────────────────────────────────────────

describe('submitManualUris', () => {
  const mockTaskStore = {
    addUri: vi.fn().mockResolvedValue(['gid1']),
    addUriAtomic: vi.fn().mockResolvedValue('atomic-gid'),
    addMagnetUri: vi.fn().mockResolvedValue('magnet-gid'),
    addTorrent: vi.fn().mockResolvedValue('torrent-gid'),
    registerTorrentSource: vi.fn(),
  } as unknown as ReturnType<typeof import('@/stores/task').useTaskStore>

  const baseForm: AddTaskForm = {
    uris: '',
    out: '',
    dir: '/dl',
    streamMaxConnections: 16,
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
  }
  const baseOptions = buildEngineOptions(baseForm)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does nothing when uris is empty/whitespace', async () => {
    await submitManualUris({ ...baseForm, uris: '  ' }, mockTaskStore)
    expect(mockTaskStore.addUri).not.toHaveBeenCalled()
  })

  it('submits single URI with extension — outs contains empty string (no HEAD needed)', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/file.zip' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.uris).toEqual(['http://example.com/file.zip'])
    // Each URI produces an empty string (= let aria2 decide), not a flat []
    expect(call.outs).toEqual([''])
    expect(call.options).toEqual(baseOptions)
  })

  it('builds external request headers once and leaves content decoding to the engine', async () => {
    const url = 'https://dl.example.com/file.zip'
    const requestHeaders = [
      { name: 'Sec-CH-UA', value: '"Chromium";v="151"' },
      { name: 'Sec-CH-UA-Mobile', value: '?0' },
      { name: 'Sec-CH-UA-Platform', value: '"Windows"' },
      { name: 'DNT', value: '1' },
      { name: 'Upgrade-Insecure-Requests', value: '1' },
      { name: 'Accept', value: 'application/octet-stream' },
      { name: 'Accept-Encoding', value: 'gzip, deflate, br, zstd' },
      { name: 'Sec-Fetch-Site', value: 'same-site' },
      { name: 'Sec-Fetch-Mode', value: 'navigate' },
      { name: 'Sec-Fetch-User', value: '?1' },
      { name: 'Sec-Fetch-Dest', value: 'document' },
      { name: 'Accept-Language', value: 'en-US,en;q=0.9' },
    ]
    const context = {
      url,
      referer: 'https://example.com/download',
      cookie: 'session=abc',
      userAgent: 'BrowserUA/1.0',
      requestHeaders,
    }

    await submitManualUris(
      {
        ...baseForm,
        uris: url,
        referer: context.referer,
        cookie: context.cookie,
        userAgent: context.userAgent,
        requestHeaders,
        uriRequestContexts: { [url]: context },
      },
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.options).toEqual({
      ...baseOptions,
      'user-agent': 'BrowserUA/1.0',
      referer: 'https://example.com/download',
      header: [
        'Sec-CH-UA: "Chromium";v="151"',
        'Sec-CH-UA-Mobile: ?0',
        'Sec-CH-UA-Platform: "Windows"',
        'DNT: 1',
        'Upgrade-Insecure-Requests: 1',
        'Accept: application/octet-stream',
        'Sec-Fetch-Site: same-site',
        'Sec-Fetch-Mode: navigate',
        'Sec-Fetch-User: ?1',
        'Sec-Fetch-Dest: document',
        'Accept-Language: en-US,en;q=0.9',
        'Cookie: session=abc',
      ],
    })
  })

  it('submits manual remote torrent URLs as ordinary URI downloads', async () => {
    const { invoke } = await import('@tauri-apps/api/core')

    await submitManualUris({ ...baseForm, uris: 'https://example.com/linux.torrent?token=abc' }, mockTaskStore)

    expect(invoke).not.toHaveBeenCalledWith('fetch_remote_bytes', expect.anything())
    expect(mockTaskStore.addTorrent).not.toHaveBeenCalled()
    expect(mockTaskStore.addUri).toHaveBeenCalledWith({
      uris: ['https://example.com/linux.torrent?token=abc'],
      outs: [''],
      options: baseOptions,
      fileCategory: undefined,
    })
  })

  it('passes Thunder links to the engine for manual URI tasks', async () => {
    const thunder = 'thunder://' + btoa('AAhttps://example.com/file.zipZZ')

    await submitManualUris({ ...baseForm, uris: thunder }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.uris).toEqual([thunder])
    expect(call.outs).toEqual([''])
  })

  it('submits aria2 input-file out options as separate task options', async () => {
    await submitManualUris(
      {
        ...baseForm,
        uris: [
          'https://example.com/index.html',
          '  out=index1.html',
          'https://example.com/index.html',
          '  out=index2.html',
        ].join('\n'),
      },
      mockTaskStore,
    )

    expect(mockTaskStore.addUri).toHaveBeenCalledTimes(2)
    expect(mockTaskStore.addUri).toHaveBeenNthCalledWith(1, {
      uris: ['https://example.com/index.html'],
      outs: ['index1.html'],
      options: { ...baseOptions, out: 'index1.html' },
      fileCategory: undefined,
    })
    expect(mockTaskStore.addUri).toHaveBeenNthCalledWith(2, {
      uris: ['https://example.com/index.html'],
      outs: ['index2.html'],
      options: { ...baseOptions, out: 'index2.html' },
      fileCategory: undefined,
    })
  })

  it('submits tab-separated aria2 input-file mirrors as one atomic URI task', async () => {
    await submitManualUris(
      {
        ...baseForm,
        uris: 'https://a.example/file.zip\thttps://b.example/file.zip\n  out=file.zip\n  header=Accept-Language: en-US',
      },
      mockTaskStore,
      {
        enabled: true,
        categories: [{ label: 'Archives', extensions: ['zip'], directory: '/dl/Archives' }],
      },
    )

    expect(mockTaskStore.addUriAtomic).toHaveBeenCalledWith({
      uris: ['https://a.example/file.zip', 'https://b.example/file.zip'],
      options: { ...baseOptions, dir: '/dl/Archives', out: 'file.zip', header: ['Accept-Language: en-US'] },
    })
  })

  it('keeps per-URI browser context when generating numbered output names', async () => {
    const firstUrl = 'https://a.example/download/1'
    const secondUrl = 'https://b.example/download/2'
    await submitManualUris(
      {
        ...baseForm,
        uris: `${firstUrl}\n${secondUrl}`,
        out: 'file.zip',
        uriRequestContexts: {
          [firstUrl]: { url: firstUrl, referer: 'https://a.example/', cookie: 'a=1' },
          [secondUrl]: { url: secondUrl, referer: 'https://b.example/', cookie: 'b=2' },
        },
      },
      mockTaskStore,
    )

    expect(mockTaskStore.addUri).toHaveBeenNthCalledWith(1, {
      uris: [firstUrl],
      outs: ['file_1.zip'],
      options: { ...baseOptions, referer: 'https://a.example/', header: ['Cookie: a=1'] },
      fileCategory: undefined,
    })
    expect(mockTaskStore.addUri).toHaveBeenNthCalledWith(2, {
      uris: [secondUrl],
      outs: ['file_2.zip'],
      options: { ...baseOptions, referer: 'https://b.example/', header: ['Cookie: b=2'] },
      fileCategory: undefined,
    })
  })

  it('does not invoke HEAD for percent-encoded URIs with extension — aria2 handles decode natively', async () => {
    await submitManualUris({ ...baseForm, uris: 'http://example.com/AAA%20BBB.mp3' }, mockTaskStore)

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // .mp3 has an extension → hasExtension returns true → no HEAD request
    expect(call.outs).toEqual([''])
  })

  it('invokes resolve_filename for extensionless URL paths', async () => {
    // This URL has no extension in the path — resolve_filename is invoked
    const { invoke } = await import('@tauri-apps/api/core')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce('215.zip')

    await submitManualUris({ ...baseForm, uris: 'https://datashop.cboe.com/download/sample/215' }, mockTaskStore)

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
      mockTaskStore,
    )

    const call = (mockTaskStore.addUri as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Only the regular URI should be in the addUri call
    expect(call.uris).toEqual(['http://example.com/file%20name.zip'])
    expect(call.outs).toEqual(['']) // .zip has extension → empty string (no HEAD)
  })

  it('does not invoke resolve_filename when user has specified out', async () => {
    const { invoke } = await import('@tauri-apps/api/core')

    await submitManualUris({ ...baseForm, uris: 'http://example.com/AAA%20BBB.mp3', out: 'custom.mp3' }, mockTaskStore)

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
      mockTaskStore,
    )

    expect(result).toEqual({
      submittedTaskNames: [],
      magnetGids: ['magnet-gid-1'],
      magnetFailures: [{ uri: 'magnet:?xt=urn:btih:bad', error: 'invalid magnet' }],
    })
  })
})
