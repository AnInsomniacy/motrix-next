/** Task input transformations and diagnostic behavior at the native IPC boundary. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── Hoisted mocks ───────────────────────────────────────────────────
const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({}),
}))

const engineState = vi.hoisted(() => ({ isReady: false }))

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@/stores/engine', () => ({
  useEngineStore: () => engineState,
}))

vi.mock('@shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/logger')>()
  return {
    ...actual,
    logger: loggerMock,
  }
})

import { changeGlobalOption, getOption, changeOption, getFiles, addUri, addUriAtomic, addTorrent } from '../aria2'

describe('aria2 API (invoke transport)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    engineState.isReady = false
  })

  // ── RPC Method Delegation ───────────────────────────────────────

  describe('RPC methods via invoke', () => {
    beforeEach(async () => {
      engineState.isReady = true
    })

    it('changeGlobalOption invokes with formatted options', async () => {
      mockInvoke.mockResolvedValueOnce('OK')
      await changeGlobalOption({ maxConcurrentDownloads: 10 })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_change_global_option', {
        options: { 'max-concurrent-downloads': '10' },
      })
    })

    it('getOption invokes with gid and converts to camelCase', async () => {
      mockInvoke.mockResolvedValueOnce({ 'max-download-limit': '0', 'select-file': '2-9' })
      const result = await getOption({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_option', { gid: 'abc' })
      expect(result).toEqual({ maxDownloadLimit: '0', selectFile: '2-9' })
    })

    it('changeOption invokes with gid and formatted options', async () => {
      mockInvoke.mockResolvedValueOnce('OK')
      await changeOption({ gid: 'abc', options: { 'max-download-limit': '0' } })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_change_option', {
        gid: 'abc',
        options: { 'max-download-limit': '0' },
      })
    })

    it('getFiles invokes and returns camelCase typed files', async () => {
      const rawFiles = [
        {
          index: '1',
          path: '/downloads/movie.mkv',
          length: '1500000000',
          'completed-length': '0',
          selected: 'true',
          uris: [{ uri: 'magnet:?xt=urn:btih:abc', status: 'used' }],
        },
        {
          index: '2',
          path: '/downloads/subtitle.srt',
          length: '50000',
          'completed-length': '0',
          selected: 'true',
          uris: [],
        },
      ]
      mockInvoke.mockResolvedValueOnce(rawFiles)
      const result = await getFiles({ gid: 'magnet-gid' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_files', { gid: 'magnet-gid' })
      expect(result).toHaveLength(2)
      expect(result[0].path).toBe('/downloads/movie.mkv')
      expect(result[0].completedLength).toBe('0')
    })
  })

  it('logs addUri option diagnostics without leaking header values or query tokens', async () => {
    mockInvoke.mockResolvedValueOnce('gid1')

    await addUri({
      uris: ['https://example.com/file.zip?token=secret'],
      outs: [''],
      options: {
        dir: '/downloads',
        'stream-max-connections': '16',
        'user-agent': 'BrowserUA/1.0',
        referer: 'https://example.com/page?token=secret',
        header: ['Accept: application/octet-stream', 'Cookie: session=secret'],
      },
    })

    const fields = loggerMock.info.mock.calls[0]?.[2]
    const logs = JSON.stringify(fields)
    expect(fields).toEqual(expect.objectContaining({ headerNames: 'Accept,Cookie', hasCookieHeader: true }))
    expect(logs).not.toContain('session=secret')
    expect(logs).not.toContain('token=secret')
    expect(logs).not.toContain('BrowserUA')
    expect(logs).not.toContain('/downloads')
  })

  // ── Task Creation ───────────────────────────────────────────────

  describe('task creation', () => {
    beforeEach(async () => {
      engineState.isReady = true
    })

    it('addUri creates one invoke per URI with per-URI out option', async () => {
      mockInvoke.mockResolvedValue('gid1')

      const result = await addUri({
        uris: ['http://a.com/1.zip', 'http://b.com/2.zip'],
        outs: ['file1.zip', ''],
        options: {},
      })

      expect(result).toHaveLength(2)
      // First call should have out option
      const firstCallArgs = mockInvoke.mock.calls[0]
      expect(firstCallArgs[0]).toBe('aria2_add_uri')
      expect(firstCallArgs[1].options.out).toBe('file1.zip')
    })

    it('addUri classifies extensionless downloads by the resolved output filename', async () => {
      mockInvoke.mockResolvedValue('gid1')

      await addUri({
        uris: ['https://mail-attachment.googleusercontent.com/attachment/u/0/'],
        outs: ['ИТОГИ ЛДУ 2026.xlsx'],
        options: { dir: '/downloads' },
        fileCategory: {
          enabled: true,
          categories: [{ label: 'Documents', extensions: ['xlsx'], directory: '/downloads/Documents' }],
        },
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['https://mail-attachment.googleusercontent.com/attachment/u/0/'],
        options: { dir: '/downloads/Documents', out: 'ИТОГИ ЛДУ 2026.xlsx' },
      })
    })

    it('addUri classifies ED2K downloads by the canonical link filename', async () => {
      mockInvoke.mockResolvedValue('gid1')
      const uri = 'ed2k://|file|Ubuntu%2026.04.iso|123456789|0123456789abcdef0123456789abcdef|/'

      await addUri({
        uris: [uri],
        outs: [],
        options: { dir: '/downloads' },
        fileCategory: {
          enabled: true,
          categories: [{ label: 'Archives', extensions: ['iso'], directory: '/downloads/Archives' }],
        },
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: [uri],
        options: { dir: '/downloads/Archives' },
      })
    })

    it('addUri classifies downloads by extension and URL context', async () => {
      mockInvoke.mockResolvedValue('gid1')

      await addUri({
        uris: ['https://cdn.example.net/export/file.zip'],
        outs: ['file.zip'],
        options: { dir: '/downloads' },
        fileCategory: {
          enabled: true,
          categories: [
            {
              label: 'Logs',
              extensions: ['zip'],
              urlPatterns: ['*://reports.example.com/logs/*'],
              urlPatternMode: 'wildcard',
              directory: '/downloads/Logs',
            },
          ],
          contexts: {
            'https://cdn.example.net/export/file.zip': {
              finalUrl: 'https://reports.example.com/logs/file.zip',
            },
          },
        },
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['https://cdn.example.net/export/file.zip'],
        options: { dir: '/downloads/Logs', out: 'file.zip' },
      })
    })

    it('addUriAtomic creates exactly one invoke with all URIs', async () => {
      mockInvoke.mockResolvedValueOnce('gid-atomic')

      const result = await addUriAtomic({
        uris: ['http://mirror1.com/f.zip', 'http://mirror2.com/f.zip'],
        options: {},
      })

      expect(result).toBe('gid-atomic')
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['http://mirror1.com/f.zip', 'http://mirror2.com/f.zip'],
        options: expect.any(Object),
      })
    })

    it('addTorrent passes base64 torrent data', async () => {
      mockInvoke.mockResolvedValueOnce('gid-torrent')
      const result = await addTorrent({ torrent: 'base64data', options: {} })
      expect(result).toBe('gid-torrent')
      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_torrent', {
        torrent: 'base64data',
        options: { 'force-save': 'true', 'check-integrity': 'true' },
      })
    })

    it('addTorrent preserves caller-supplied options', async () => {
      mockInvoke.mockResolvedValueOnce('gid-torrent')
      await addTorrent({ torrent: 'data', options: { dir: '/custom', 'stream-max-connections': '4' } })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      const options = callArgs.options as Record<string, string>
      expect(options['force-save']).toBe('true')
      expect(options['check-integrity']).toBe('true')
      expect(options.dir).toBe('/custom')
      expect(options['stream-max-connections']).toBe('4')
    })

    it('addTorrent keeps explicit caller force-save value', async () => {
      mockInvoke.mockResolvedValueOnce('gid-torrent')
      await addTorrent({ torrent: 'data', options: { 'force-save': 'false' } })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      expect((callArgs.options as Record<string, string>)['force-save']).toBe('false')
    })

    it('addUri does NOT inject force-save (HTTP downloads must not persist)', async () => {
      mockInvoke.mockResolvedValue('gid-http')
      await addUri({ uris: ['http://example.com/file.zip'], outs: [], options: {} })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      expect((callArgs.options as Record<string, string>)['force-save']).toBeUndefined()
    })

    it('addUriAtomic does NOT inject force-save', async () => {
      mockInvoke.mockResolvedValueOnce('gid-atomic')
      await addUriAtomic({ uris: ['http://example.com/f.zip'], options: {} })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      expect((callArgs.options as Record<string, string>)['force-save']).toBeUndefined()
    })
  })
})
