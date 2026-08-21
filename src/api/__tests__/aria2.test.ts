/**
 * @fileoverview Tests for the aria2 API layer (src/api/aria2.ts).
 *
 * Now tests the invoke()-based transport — verifies that each API function
 * calls the correct Tauri command with the expected arguments.
 *
 * Key behaviors under test:
 * - setEngineReady controls the readiness flag
 * - All API methods invoke the correct Tauri command
 * - fetchTaskList routes by type (active vs stopped)
 * - addUri creates one invoke per URI with per-URI output filename override
 * - addUriAtomic creates exactly one invoke with all URIs as mirrors
 * - Batch operations use batch invoke commands
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted mocks ───────────────────────────────────────────────────
const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue({}),
}))

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/logger')>()
  return {
    ...actual,
    logger: loggerMock,
  }
})

import {
  isEngineReady,
  setEngineReady,
  getVersion,
  getGlobalOption,
  getGlobalStat,
  changeGlobalOption,
  getOption,
  changeOption,
  getFiles,
  fetchTaskList,
  fetchTaskItem,
  fetchTaskItemWithPeers,
  fetchActiveTaskList,
  addUri,
  addUriAtomic,
  addHls,
  addTorrent,
  removeTask,
  pauseTask,
  resumeTask,
  forcePauseTask,
  saveSession,
  removeTaskRecord,
  purgeTaskRecord,
  batchResumeTask,
  batchPauseTask,
  batchRemoveTask,
} from '../aria2'

const HLS_GID = 'hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HLS_GID_B = 'hls-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('aria2 API (invoke transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setEngineReady(false)
  })

  // ── Client Lifecycle ────────────────────────────────────────────

  describe('client lifecycle', () => {
    it('setEngineReady explicitly controls readiness flag', () => {
      setEngineReady(true)
      expect(isEngineReady()).toBe(true)
      setEngineReady(false)
      expect(isEngineReady()).toBe(false)
    })
  })

  // ── RPC Method Delegation ───────────────────────────────────────

  describe('RPC methods via invoke', () => {
    beforeEach(async () => {
      setEngineReady(true)
    })

    it('getVersion invokes aria2_get_version', async () => {
      mockInvoke.mockResolvedValueOnce({ version: '1.37.0', enabledFeatures: ['BitTorrent'] })
      const result = await getVersion()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_version')
      expect(result.version).toBe('1.37.0')
    })

    it('getGlobalOption invokes and converts to camelCase', async () => {
      mockInvoke.mockResolvedValueOnce({ 'max-concurrent-downloads': '5' })
      const result = await getGlobalOption()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_global_option')
      expect(result).toHaveProperty('maxConcurrentDownloads')
    })

    it('getGlobalStat invokes aria2_get_global_stat', async () => {
      const stat = {
        downloadSpeed: '0',
        uploadSpeed: '0',
        numActive: '0',
        numStopped: '0',
        numWaiting: '0',
        numStoppedTotal: '0',
      }
      mockInvoke.mockResolvedValueOnce(stat)
      const result = await getGlobalStat()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_global_stat')
      expect(result).toEqual(stat)
    })

    it('changeGlobalOption invokes with formatted options', async () => {
      mockInvoke.mockResolvedValueOnce('OK')
      await changeGlobalOption({ maxConcurrentDownloads: 10 } as never)
      expect(mockInvoke).toHaveBeenCalledWith('aria2_change_global_option', { options: expect.any(Object) })
    })

    it('getOption invokes with gid and converts to camelCase', async () => {
      mockInvoke.mockResolvedValueOnce({ 'max-download-limit': '0', 'select-file': '2-9' })
      const result = await getOption({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_option', { gid: 'abc' })
      expect(result).toHaveProperty('maxDownloadLimit')
      expect(result).toHaveProperty('selectFile', '2-9')
    })

    it('changeOption invokes with gid and formatted options', async () => {
      mockInvoke.mockResolvedValueOnce('OK')
      await changeOption({ gid: 'abc', options: { maxDownloadLimit: '0' } as never })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_change_option', { gid: 'abc', options: expect.any(Object) })
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
        split: '16',
        'user-agent': 'BrowserUA/1.0',
        referer: 'https://example.com/page?token=secret',
        header: ['Accept: application/octet-stream', 'Cookie: session=secret'],
      },
    })

    const logs = loggerMock.info.mock.calls.flat().join(' ')
    expect(logs).toContain('headerNames=Accept,Cookie')
    expect(logs).toContain('hasCookieHeader=true')
    expect(logs).not.toContain('session=secret')
    expect(logs).not.toContain('token=secret')
    expect(logs).not.toContain('BrowserUA')
    expect(logs).not.toContain('/downloads')
  })

  // ── Task Fetching ───────────────────────────────────────────────

  describe('task fetching', () => {
    beforeEach(async () => {
      setEngineReady(true)
    })

    it('fetchTaskList with type "active" concatenates hls_list onto aria2 results', async () => {
      const aria2 = [
        { gid: '1', status: 'active' },
        { gid: '2', status: 'waiting' },
      ]
      const hls = [{ gid: HLS_GID, status: 'active' }]
      mockInvoke.mockImplementation((cmd: unknown) => {
        if (cmd === 'aria2_fetch_task_list') return Promise.resolve(aria2)
        if (cmd === 'hls_list') return Promise.resolve(hls)
        return Promise.resolve({})
      })

      const result = await fetchTaskList({ type: 'active' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_list', { type: 'active', limit: null })
      expect(mockInvoke).toHaveBeenCalledWith('hls_list', { group: 'active' })
      expect(result.map((task) => task.gid)).toEqual(['1', '2', HLS_GID])
    })

    it('fetchTaskList with stopped type invokes aria2_fetch_task_list and does not call hls_list', async () => {
      const stopped = [{ gid: '3', status: 'complete' }]
      mockInvoke.mockResolvedValueOnce(stopped)

      const result = await fetchTaskList({ type: 'stopped' })
      expect(result).toHaveLength(1)
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_list', { type: 'stopped', limit: null })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('hls_list')
    })

    it('fetchTaskList with complete type does not call hls_list', async () => {
      mockInvoke.mockResolvedValueOnce([{ gid: '3', status: 'complete' }])
      await fetchTaskList({ type: 'complete' })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('hls_list')
    })

    it('fetchTaskList with type active keeps aria2 results when hls_list fails', async () => {
      mockInvoke.mockImplementation((cmd: unknown) => {
        if (cmd === 'aria2_fetch_task_list') return Promise.resolve([{ gid: '1', status: 'active' }])
        if (cmd === 'hls_list') return Promise.reject(new Error('hls down'))
        return Promise.resolve({})
      })

      const result = await fetchTaskList({ type: 'active' })
      expect(result).toHaveLength(1)
      expect(result[0].gid).toBe('1')
      expect(loggerMock.warn).toHaveBeenCalledWith('aria2.fetchTaskList', expect.stringContaining('hls down'))
    })

    it('fetchActiveTaskList concatenates hls_list onto aria2 active tasks', async () => {
      mockInvoke.mockImplementation((cmd: unknown) => {
        if (cmd === 'aria2_fetch_active_task_list') return Promise.resolve([{ gid: '1' }])
        if (cmd === 'hls_list') return Promise.resolve([{ gid: HLS_GID }])
        return Promise.resolve({})
      })
      const result = await fetchActiveTaskList()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_active_task_list')
      expect(mockInvoke).toHaveBeenCalledWith('hls_list', { group: 'active' })
      expect(result.map((task) => task.gid)).toEqual(['1', HLS_GID])
    })

    it('fetchTaskItem invokes with gid', async () => {
      const task = {
        gid: 'abc',
        status: 'active',
        totalLength: '100',
        completedLength: '50',
        uploadLength: '0',
        downloadSpeed: '0',
        uploadSpeed: '0',
        connections: '1',
        dir: '/dl',
        files: [],
      }
      mockInvoke.mockResolvedValueOnce(task)
      const result = await fetchTaskItem({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_item', { gid: 'abc' })
      expect(result.gid).toBe('abc')
    })

    it('fetchTaskItemWithPeers invokes with gid', async () => {
      const merged = { gid: 'abc', status: 'active', peers: [{ peerId: 'peer1' }] }
      mockInvoke.mockResolvedValueOnce(merged)
      const result = await fetchTaskItemWithPeers({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_item_with_peers', { gid: 'abc' })
      expect(result.gid).toBe('abc')
      expect(result.peers).toHaveLength(1)
    })

    it('fetchTaskList preserves order from Rust response', async () => {
      const tasks = [
        { gid: 'c', status: 'active' },
        { gid: 'a', status: 'active' },
        { gid: 'd', status: 'waiting' },
        { gid: 'b', status: 'waiting' },
      ]
      mockInvoke.mockImplementation((cmd: unknown) => {
        if (cmd === 'aria2_fetch_task_list') return Promise.resolve(tasks)
        if (cmd === 'hls_list') return Promise.resolve([])
        return Promise.resolve({})
      })
      const result = await fetchTaskList({ type: 'active' })
      expect(result.map((t) => t.gid)).toEqual(['c', 'a', 'd', 'b'])
    })

    it('fetchTaskList passes limit to invoke', async () => {
      mockInvoke.mockResolvedValueOnce([])
      await fetchTaskList({ type: 'stopped', limit: 128 })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_list', { type: 'stopped', limit: 128 })
    })

    it('fetchTaskList uses null limit when undefined', async () => {
      mockInvoke.mockResolvedValueOnce([])
      await fetchTaskList({ type: 'stopped' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_list', { type: 'stopped', limit: null })
    })
  })

  // ── Task Creation ───────────────────────────────────────────────

  describe('task creation', () => {
    beforeEach(async () => {
      setEngineReady(true)
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

    it('addUri decodes RFC 2047 out hints before invoking the backend', async () => {
      mockInvoke.mockResolvedValue('gid1')

      await addUri({
        uris: ['https://mail-attachment.googleusercontent.com/attachment/u/0/'],
        outs: ['=?UTF-8?B?0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4?='],
        options: {},
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['https://mail-attachment.googleusercontent.com/attachment/u/0/'],
        options: { out: 'ИТОГИ ЛДУ 2026.xlsx' },
      })
    })

    it('addUri passes Thunder links to the backend for engine parsing', async () => {
      mockInvoke.mockResolvedValue('gid1')
      const thunder = 'thunder://' + btoa('AAhttps://example.com/file.zipZZ')

      await addUri({
        uris: [thunder],
        outs: [],
        options: {},
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: [thunder],
        options: {},
      })
    })

    it('addUri passes unpadded Thunder links to the backend', async () => {
      mockInvoke.mockResolvedValue('gid1')
      const thunder = 'thunder://' + btoa('AAhttps://example.com/file.zipZZ').replace(/=+$/, '')

      await addUri({
        uris: [thunder],
        outs: [],
        options: {},
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: [thunder],
        options: {},
      })
    })

    it('addUri leaves malformed Thunder links for backend validation', async () => {
      mockInvoke.mockResolvedValue('gid1')

      await addUri({
        uris: ['thunder://not-valid-base64'],
        outs: [],
        options: {},
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['thunder://not-valid-base64'],
        options: {},
      })
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

    it('addUriAtomic passes Thunder mirrors to the backend for engine parsing', async () => {
      mockInvoke.mockResolvedValueOnce('gid-atomic')
      const thunder = 'thunder://' + btoa('AAhttps://mirror.example.com/f.zipZZ')

      await addUriAtomic({
        uris: [thunder, 'https://mirror2.example.com/f.zip'],
        options: {},
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: [thunder, 'https://mirror2.example.com/f.zip'],
        options: expect.any(Object),
      })
    })

    it('addUriAtomic leaves malformed Thunder mirrors for backend validation', async () => {
      mockInvoke.mockResolvedValueOnce('gid-atomic')

      await addUriAtomic({
        uris: ['thunder://not-valid-base64'],
        options: {},
      })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_uri', {
        uris: ['thunder://not-valid-base64'],
        options: expect.any(Object),
      })
    })

    it('addHls invokes hls_add with url and formatted options', async () => {
      mockInvoke.mockResolvedValueOnce('hls-gid')

      const result = await addHls({
        uri: 'https://x/a.m3u8',
        options: { dir: '/dl', userAgent: 'UA/1.0', referer: 'https://r.com' },
      })

      expect(result).toBe('hls-gid')
      expect(mockInvoke).toHaveBeenCalledTimes(1)
      expect(mockInvoke).toHaveBeenCalledWith('hls_add', {
        url: 'https://x/a.m3u8',
        options: { dir: '/dl', 'user-agent': 'UA/1.0', referer: 'https://r.com' },
      })
    })

    it('addHls classifies playlist URLs as .ts for directory routing', async () => {
      mockInvoke.mockResolvedValueOnce('hls-gid')

      await addHls({
        uri: 'https://cdn.example/video.m3u8',
        options: { dir: '/downloads' },
        fileCategory: {
          enabled: true,
          categories: [{ label: 'Videos', extensions: ['ts'], directory: '/downloads/Videos' }],
        },
      })

      expect(mockInvoke).toHaveBeenCalledWith('hls_add', {
        url: 'https://cdn.example/video.m3u8',
        options: { dir: '/downloads/Videos' },
      })
    })

    it('addHls classifies .m3u playlist URLs as .ts for directory routing', async () => {
      mockInvoke.mockResolvedValueOnce('hls-gid')

      await addHls({
        uri: 'https://cdn.example/video.m3u',
        options: { dir: '/downloads' },
        fileCategory: {
          enabled: true,
          categories: [{ label: 'Videos', extensions: ['ts'], directory: '/downloads/Videos' }],
        },
      })

      expect(mockInvoke).toHaveBeenCalledWith('hls_add', {
        url: 'https://cdn.example/video.m3u',
        options: { dir: '/downloads/Videos' },
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
      await addTorrent({ torrent: 'data', options: { dir: '/custom', split: '4' } })
      const callArgs = mockInvoke.mock.calls[0][1] as Record<string, unknown>
      const options = callArgs.options as Record<string, string>
      expect(options['force-save']).toBe('true')
      expect(options['check-integrity']).toBe('true')
      expect(options.dir).toBe('/custom')
      expect(options.split).toBe('4')
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

  // ── Task Control ────────────────────────────────────────────────

  describe('task control', () => {
    beforeEach(async () => {
      setEngineReady(true)
      mockInvoke.mockResolvedValue('OK')
    })

    it('removeTask invokes aria2_force_remove', async () => {
      await removeTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_force_remove', { gid: 'abc' })
    })

    it('pauseTask invokes aria2_pause', async () => {
      await pauseTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_pause', { gid: 'abc' })
    })

    it('pauseTask with an HLS gid invokes hls_pause and does not invoke aria2_pause', async () => {
      await pauseTask({ gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_pause', { gid: HLS_GID })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_pause')
    })

    it('forcePauseTask invokes aria2_force_pause', async () => {
      await forcePauseTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_force_pause', { gid: 'abc' })
    })

    it('resumeTask invokes aria2_unpause', async () => {
      await resumeTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_unpause', { gid: 'abc' })
    })

    it('saveSession invokes aria2_save_session', async () => {
      await saveSession()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_save_session')
    })

    it('removeTaskRecord invokes aria2_remove_download_result', async () => {
      await removeTaskRecord({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_remove_download_result', { gid: 'abc' })
    })

    it('purgeTaskRecord invokes aria2_purge_download_result', async () => {
      await purgeTaskRecord()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_purge_download_result')
    })
  })

  // ── Batch Operations ────────────────────────────────────────────

  describe('batch operations', () => {
    beforeEach(async () => {
      setEngineReady(true)
      mockInvoke.mockResolvedValue([['OK'], ['OK']])
    })

    it('batchResumeTask invokes aria2_batch_unpause with gids', async () => {
      await batchResumeTask({ gids: ['g1', 'g2'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_unpause', { gids: ['g1', 'g2'] })
    })

    it('batchPauseTask invokes aria2_batch_force_pause with gids', async () => {
      await batchPauseTask({ gids: ['g1', 'g2'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_force_pause', { gids: ['g1', 'g2'] })
    })

    it('batchRemoveTask invokes aria2_batch_force_remove with gids', async () => {
      await batchRemoveTask({ gids: ['g1'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_force_remove', { gids: ['g1'] })
    })

    it('batchPauseTask splits mixed gids and skips empty buckets', async () => {
      await batchPauseTask({ gids: ['g1', HLS_GID, 'g2', HLS_GID_B] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_force_pause', { gids: ['g1', 'g2'] })
      expect(mockInvoke).toHaveBeenCalledWith('hls_pause', { gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_pause', { gid: HLS_GID_B })
    })

    it('batchPauseTask with only HLS gids does not invoke aria2_batch_force_pause', async () => {
      await batchPauseTask({ gids: [HLS_GID] })
      expect(mockInvoke).toHaveBeenCalledWith('hls_pause', { gid: HLS_GID })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_batch_force_pause')
    })

    it('batchResumeTask splits mixed gids onto hls_unpause and aria2_batch_unpause', async () => {
      await batchResumeTask({ gids: [HLS_GID, 'g1'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_unpause', { gids: ['g1'] })
      expect(mockInvoke).toHaveBeenCalledWith('hls_unpause', { gid: HLS_GID })
    })

    it('batchRemoveTask removes HLS gids with deleteFiles false', async () => {
      await batchRemoveTask({ gids: [HLS_GID, 'g1'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_force_remove', { gids: ['g1'] })
      expect(mockInvoke).toHaveBeenCalledWith('hls_remove', { gid: HLS_GID, deleteFiles: false })
    })
  })

  describe('HLS gid routing', () => {
    beforeEach(async () => {
      setEngineReady(true)
      mockInvoke.mockResolvedValue('OK')
    })

    it('fetchTaskItem with an HLS gid invokes hls_tell_status', async () => {
      mockInvoke.mockResolvedValueOnce({ gid: HLS_GID, status: 'active', files: [] })
      const result = await fetchTaskItem({ gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_tell_status', { gid: HLS_GID })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_fetch_task_item')
      expect(result.gid).toBe(HLS_GID)
    })

    it('fetchTaskItemWithPeers with an HLS gid invokes hls_tell_status and not aria2', async () => {
      mockInvoke.mockResolvedValueOnce({ gid: HLS_GID, status: 'active', files: [] })
      const result = await fetchTaskItemWithPeers({ gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_tell_status', { gid: HLS_GID })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_fetch_task_item_with_peers')
      expect(result.gid).toBe(HLS_GID)
      expect(result.peers).toEqual([])
    })

    it('getFiles with an HLS gid returns files from hls_tell_status', async () => {
      const files = [
        {
          index: '1',
          path: '/downloads/a.ts',
          length: '100',
          completedLength: '40',
          selected: 'true',
          uris: [],
        },
      ]
      mockInvoke.mockResolvedValueOnce({ gid: HLS_GID, files })
      const result = await getFiles({ gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_tell_status', { gid: HLS_GID })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_get_files')
      expect(result).toEqual(files)
    })

    it('getOption with an HLS gid invokes hls_get_option', async () => {
      mockInvoke.mockResolvedValueOnce({ dir: '/dl', out: 'a.ts' })
      const result = await getOption({ gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_get_option', { gid: HLS_GID })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_get_option')
      expect(result).toMatchObject({ dir: '/dl', out: 'a.ts' })
    })

    it('changeOption with an HLS gid returns without invoke', async () => {
      await changeOption({ gid: HLS_GID, options: { dir: '/other' } })
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('resumeTask with an HLS gid invokes hls_unpause', async () => {
      await resumeTask({ gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_unpause', { gid: HLS_GID })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_unpause')
    })

    it('forcePauseTask with an HLS gid invokes hls_pause and not aria2_force_pause', async () => {
      await forcePauseTask({ gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_pause', { gid: HLS_GID })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_force_pause')
    })

    it('removeTask with an HLS gid invokes hls_remove without deleting files', async () => {
      await removeTask({ gid: HLS_GID })
      expect(mockInvoke).toHaveBeenCalledWith('hls_remove', { gid: HLS_GID, deleteFiles: false })
      expect(mockInvoke.mock.calls.map((call) => call[0])).not.toContain('aria2_force_remove')
    })

    it('removeTaskRecord with an HLS gid returns OK without aria2 invoke', async () => {
      const result = await removeTaskRecord({ gid: HLS_GID })
      expect(result).toBe('OK')
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })
})
