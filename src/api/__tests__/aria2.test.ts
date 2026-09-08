/**
 * @fileoverview Tests for the aria2 API layer (src/api/aria2.ts).
 *
 * Now tests the invoke()-based transport — verifies that each API function
 * calls the correct Tauri command with the expected arguments.
 *
 * Key behaviors under test:
 * - readiness comes from the engine supervisor store
 * - All API methods invoke the correct Tauri command
 * - fetchTaskList routes by type (active vs stopped)
 * - addUri creates one invoke per URI with per-URI output filename override
 * - addUriAtomic creates exactly one invoke with all URIs as mirrors
 * - Batch operations use batch invoke commands
 */
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

import {
  isEngineReady,
  getVersion,
  getGlobalStat,
  changeGlobalOption,
  getOption,
  changeOption,
  getFiles,
  forceBtRecheck,
  replaceBtTrackers,
  replaceBtWebSeeds,
  addBtPeers,
  fetchTaskList,
  fetchTaskItem,
  fetchTaskItemWithPeers,
  fetchActiveTaskList,
  addUri,
  addUriAtomic,
  addTorrent,
  inspectTorrent,
  removeTask,
  deleteTask,
  batchDeleteTasks,
  finishSharing,
  batchFinishSharing,
  pauseTask,
  resumeTask,
  forcePauseTask,
  forcePauseAll,
  resumeEligible,
  saveSession,
  removeTaskRecord,
  purgeTaskRecords,
} from '../aria2'

describe('aria2 API (invoke transport)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    engineState.isReady = false
  })

  // ── Client Lifecycle ────────────────────────────────────────────

  describe('client lifecycle', () => {
    it('reads readiness from the supervisor store', () => {
      engineState.isReady = true
      expect(isEngineReady()).toBe(true)
      engineState.isReady = false
      expect(isEngineReady()).toBe(false)
    })
  })

  // ── RPC Method Delegation ───────────────────────────────────────

  describe('RPC methods via invoke', () => {
    beforeEach(async () => {
      engineState.isReady = true
    })

    it('getVersion invokes aria2_get_version', async () => {
      mockInvoke.mockResolvedValueOnce({ version: '1.37.0', enabledFeatures: ['BitTorrent'] })
      const result = await getVersion()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_get_version')
      expect(result.version).toBe('1.37.0')
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

    it('delegates native BitTorrent task controls', async () => {
      mockInvoke.mockResolvedValue('OK')
      await forceBtRecheck({ gid: 'bt1' })
      await replaceBtTrackers({ gid: 'bt1', trackers: [{ url: 'udp://tracker.example:6969', tier: 0 }] })
      await replaceBtWebSeeds({ gid: 'bt1', webSeeds: ['https://seed.example/file'] })
      await addBtPeers({ gid: 'bt1', peers: ['192.0.2.1:6881'] })

      expect(mockInvoke).toHaveBeenCalledWith('aria2_force_bt_recheck', { gid: 'bt1' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_replace_bt_trackers', {
        gid: 'bt1',
        trackers: [{ url: 'udp://tracker.example:6969', tier: 0 }],
      })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_replace_bt_web_seeds', {
        gid: 'bt1',
        webSeeds: ['https://seed.example/file'],
      })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_add_bt_peers', {
        gid: 'bt1',
        peers: ['192.0.2.1:6881'],
      })
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

  // ── Task Fetching ───────────────────────────────────────────────

  describe('task fetching', () => {
    beforeEach(async () => {
      engineState.isReady = true
    })

    it('fetchTaskList with type "active" invokes aria2_fetch_task_list', async () => {
      const combined = [
        { gid: '1', status: 'active' },
        { gid: '2', status: 'waiting' },
      ]
      mockInvoke.mockResolvedValueOnce(combined)

      const result = await fetchTaskList({ type: 'active' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_task_list', { type: 'active', limit: null })
      expect(result).toHaveLength(2)
      expect(result[0].gid).toBe('1')
      expect(result[1].gid).toBe('2')
    })

    it('fetchTaskList with stopped type invokes aria2_fetch_task_list', async () => {
      const stopped = [{ gid: '3', status: 'complete' }]
      mockInvoke.mockResolvedValueOnce(stopped)

      const result = await fetchTaskList({ type: 'complete' })
      expect(result).toHaveLength(1)
    })

    it('fetchActiveTaskList invokes aria2_fetch_active_task_list', async () => {
      mockInvoke.mockResolvedValueOnce([{ gid: '1' }])
      const result = await fetchActiveTaskList()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_fetch_active_task_list')
      expect(result).toHaveLength(1)
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
      mockInvoke.mockResolvedValueOnce(tasks)
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

    it('inspectTorrent returns native metainfo without task options', async () => {
      const inspection = {
        name: 'Bundle',
        mode: 'multi' as const,
        infoHashV1: 'a'.repeat(40),
        infoHashV2: 'b'.repeat(64),
        totalLength: '3',
        files: [{ index: '1', path: 'Bundle/a.bin', length: '3' }],
      }
      mockInvoke.mockResolvedValueOnce(inspection)

      await expect(inspectTorrent({ torrent: 'base64data' })).resolves.toEqual(inspection)
      expect(mockInvoke).toHaveBeenCalledWith('aria2_inspect_torrent', { torrent: 'base64data' })
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
      engineState.isReady = true
      mockInvoke.mockResolvedValue('OK')
    })

    it('removeTask invokes aria2_force_remove', async () => {
      await removeTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_force_remove', { gid: 'abc' })
    })

    it('deleteTask invokes the state-independent deletion command', async () => {
      await deleteTask({ gid: 'abc', infoHash: 'hash' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_delete_task', { gid: 'abc', infoHash: 'hash' })
    })

    it('finishSharing invokes the terminal sharing command', async () => {
      await finishSharing({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_finish_sharing', { gid: 'abc' })
    })

    it('pauseTask invokes aria2_pause', async () => {
      await pauseTask({ gid: 'abc' })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_pause', { gid: 'abc' })
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

    it('purgeTaskRecords invokes the native application transaction', async () => {
      await purgeTaskRecords()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_purge_task_records')
    })
  })

  // ── Batch Operations ────────────────────────────────────────────

  describe('batch operations', () => {
    beforeEach(async () => {
      engineState.isReady = true
      mockInvoke.mockResolvedValue({ succeeded: ['g1', 'g2'], failed: [] })
    })

    it('forcePauseAll invokes the native engine operation', async () => {
      await forcePauseAll()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_force_pause_all')
    })

    it('resumeEligible invokes the guarded native batch operation', async () => {
      await resumeEligible()
      expect(mockInvoke).toHaveBeenCalledWith('aria2_resume_eligible')
    })

    it('batchDeleteTasks invokes the native deletion transaction', async () => {
      const tasks = [{ gid: 'g1', infoHash: 'hash' }]
      await batchDeleteTasks({ tasks })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_delete_tasks', { tasks })
    })

    it('batchFinishSharing invokes the native sharing transaction', async () => {
      await batchFinishSharing({ gids: ['g1', 'g2'] })
      expect(mockInvoke).toHaveBeenCalledWith('aria2_batch_finish_sharing', { gids: ['g1', 'g2'] })
    })
  })
})
