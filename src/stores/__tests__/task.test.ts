/** @fileoverview Unit tests for TaskStore with mocked TaskApi. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useTaskStore } from '../task'
import type { Aria2Task, Aria2Peer, TaskStatus, HistoryRecord } from '@shared/types'
import { _resetForTesting, registerAddedAt } from '@/composables/useTaskOrder'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

// ── Mock history store (DB-primary architecture) ─────────────────────
const mockHistoryFns = {
  init: vi.fn().mockResolvedValue(undefined),
  addRecord: vi.fn().mockResolvedValue(undefined),
  getRecords: vi.fn().mockResolvedValue([] as HistoryRecord[]),
  removeRecord: vi.fn().mockResolvedValue(undefined),
  clearRecords: vi.fn().mockResolvedValue(undefined),
  removeStaleRecords: vi.fn().mockResolvedValue(undefined),
  checkIntegrity: vi.fn().mockResolvedValue('ok'),
  closeConnection: vi.fn().mockResolvedValue(undefined),
  recordTaskBirth: vi.fn().mockResolvedValue(undefined),
  loadBirthRecords: vi.fn().mockResolvedValue([]),
  getSchemaVersion: vi.fn().mockResolvedValue(2),
  removeByInfoHash: vi.fn().mockResolvedValue(undefined),
}
vi.mock('@/stores/history', () => ({
  useHistoryStore: () => mockHistoryFns,
}))

const mockHttpAuthFns = {
  findByUrl: vi.fn().mockResolvedValue(null),
  markUsed: vi.fn().mockResolvedValue(undefined),
}
vi.mock('@/stores/httpAuth', () => ({
  useHttpAuthStore: () => mockHttpAuthFns,
}))

const makeMockTask = (gid: string, status: TaskStatus = 'active', extra: Partial<Aria2Task> = {}): Aria2Task => ({
  gid,
  status,
  totalLength: '1000',
  completedLength: '500',
  uploadLength: '0',
  downloadSpeed: '1000',
  uploadSpeed: '0',
  connections: '1',
  numSeeders: '0',
  dir: '/tmp',
  files: [],
  bittorrent: undefined,
  infoHash: undefined,
  errorCode: undefined,
  errorMessage: undefined,
  numPieces: undefined,
  pieceLength: undefined,
  followedBy: undefined,
  following: undefined,
  belongsTo: undefined,
  ...extra,
})

function createMockApi() {
  return {
    fetchTaskList: vi.fn().mockResolvedValue([makeMockTask('gid1'), makeMockTask('gid2')]),
    fetchTaskItem: vi.fn().mockResolvedValue(makeMockTask('gid1')),
    fetchTaskItemWithPeers: vi.fn().mockResolvedValue({ ...makeMockTask('gid1'), peers: [] as Aria2Peer[] }),
    fetchActiveTaskList: vi.fn().mockResolvedValue([]),
    addUri: vi.fn().mockResolvedValue(['gid3']),
    addUriAtomic: vi.fn().mockResolvedValue('gid3'),
    addHls: vi.fn().mockResolvedValue('hls-gid'),
    addTorrent: vi.fn().mockResolvedValue('gid4'),
    getOption: vi.fn().mockResolvedValue({}),
    changeOption: vi.fn().mockResolvedValue(undefined),
    getFiles: vi.fn().mockResolvedValue([]),
    removeTask: vi.fn().mockResolvedValue('gid1'),
    forcePauseTask: vi.fn().mockResolvedValue('gid1'),
    pauseTask: vi.fn().mockResolvedValue('gid1'),
    resumeTask: vi.fn().mockResolvedValue('gid1'),
    batchResumeTask: vi.fn().mockResolvedValue([]),
    batchPauseTask: vi.fn().mockResolvedValue([]),
    batchForcePauseTask: vi.fn().mockResolvedValue([]),
    batchRemoveTask: vi.fn().mockResolvedValue([]),
    removeTaskRecord: vi.fn().mockResolvedValue('OK'),
    purgeTaskRecord: vi.fn().mockResolvedValue('OK'),
    saveSession: vi.fn().mockResolvedValue('OK'),
  }
}

describe('TaskStore', () => {
  let store: ReturnType<typeof useTaskStore>
  let mockApi: ReturnType<typeof createMockApi>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useTaskStore()
    mockApi = createMockApi()
    store.setApi(mockApi)
    // Reset history mock between tests
    Object.values(mockHistoryFns).forEach((fn) => fn.mockClear())
    mockHistoryFns.getRecords.mockResolvedValue([])
    mockHistoryFns.recordTaskBirth.mockResolvedValue(undefined)
    mockHttpAuthFns.findByUrl.mockResolvedValue(null)
    mockHttpAuthFns.markUsed.mockResolvedValue(undefined)
    // Reset in-memory task order state
    _resetForTesting()
  })

  // ─── fetchList ──────────────────────────────────────────

  it('fetchList populates taskList from API', async () => {
    await store.fetchList()
    expect(store.taskList).toHaveLength(2)
    // Active tab sorts by added-at DESC; trackFirstSeen assigns sequential
    // timestamps so gid2 (later) comes before gid1 (earlier).
    expect(store.taskList[0].gid).toBe('gid2')
    expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
  })

  it('manual active order survives polling and inserts new tasks above stored tasks', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    preferenceStore.updatePreference({
      taskSort: {
        active: { field: 'manual', direction: 'desc' },
        stopped: { field: 'added-at', direction: 'desc' },
        all: { field: 'added-at', direction: 'desc' },
      },
      taskManualOrder: {
        active: ['old-2', 'old-1'],
        stopped: [],
        all: [],
      },
    })
    registerAddedAt('old-1', '2024-01-01T00:00:00Z')
    registerAddedAt('old-2', '2024-01-02T00:00:00Z')
    registerAddedAt('fresh', '2024-01-03T00:00:00Z')
    mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('old-1'), makeMockTask('fresh'), makeMockTask('old-2')])

    await store.fetchList()

    expect(store.taskList.map((task) => task.gid)).toEqual(['fresh', 'old-2', 'old-1'])
  })

  it('applies active sort changes before waiting for the next poll', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    const saveSpy = vi.spyOn(preferenceStore, 'updateAndSave').mockResolvedValue(true)
    registerAddedAt('alpha', '2024-01-01T00:00:00Z')
    registerAddedAt('beta', '2024-01-02T00:00:00Z')
    mockApi.fetchTaskList.mockResolvedValue([
      makeMockTask('beta', 'active', { files: [{ path: '/tmp/beta.zip' } as Aria2Task['files'][number]] }),
      makeMockTask('alpha', 'active', { files: [{ path: '/tmp/alpha.zip' } as Aria2Task['files'][number]] }),
    ])
    await store.fetchList()
    expect(store.taskList.map((task) => task.gid)).toEqual(['beta', 'alpha'])

    await store.changeCurrentSort('name')

    expect(preferenceStore.config.taskSort.active).toEqual({ field: 'name', direction: 'desc' })
    expect(store.taskList.map((task) => task.gid)).toEqual(['beta', 'alpha'])

    await store.changeCurrentSort('name')

    expect(preferenceStore.config.taskSort.active).toEqual({ field: 'name', direction: 'asc' })
    expect(store.taskList.map((task) => task.gid)).toEqual(['alpha', 'beta'])
    expect(saveSpy).toHaveBeenCalledTimes(2)
  })

  // ─── fetchList: 'all' branch — 3-source merge ──────────────────

  describe('fetchList all branch', () => {
    beforeEach(() => {
      // Reset mock to avoid interference from the default setup
      mockApi.fetchTaskList.mockReset()
    })

    it('merges active + stopped + history records', async () => {
      await store.changeCurrentList('all')

      // Setup: active returns 1 task, stopped returns 1 task, history returns 1 record
      mockApi.fetchTaskList
        .mockResolvedValueOnce([makeMockTask('aaa', 'active')]) // active
        .mockResolvedValueOnce([makeMockTask('bbb', 'complete')]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        { gid: 'ccc', name: 'old.zip', status: 'complete' } as HistoryRecord,
      ])

      await store.fetchList()

      // All 3 tasks should be present
      expect(store.taskList).toHaveLength(3)
      const gids = store.taskList.map((t: { gid: string }) => t.gid)
      expect(gids).toContain('aaa')
      expect(gids).toContain('bbb')
      expect(gids).toContain('ccc')
    })

    it('deduplicates GIDs: aria2 data takes priority over history', async () => {
      await store.changeCurrentList('all')

      // Same GID 'dup1' exists in both aria2 stopped and history DB
      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active
        .mockResolvedValueOnce([makeMockTask('dup1', 'complete')]) // stopped (aria2)
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        { gid: 'dup1', name: 'history-version.zip', status: 'complete' } as HistoryRecord,
      ])

      await store.fetchList()

      // Only one entry for 'dup1' — aria2 version wins
      expect(store.taskList).toHaveLength(1)
      expect(store.taskList[0].gid).toBe('dup1')
    })

    it('sorts all tasks by added_at DESC regardless of status', async () => {
      // Pre-register birth timestamps to control sort order
      registerAddedAt('active-1', '2024-01-01T10:00:00Z') // oldest
      registerAddedAt('stopped-1', '2024-01-01T10:01:00Z') // middle

      await store.changeCurrentList('all')

      // Live active task + completed stopped task
      mockApi.fetchTaskList
        .mockResolvedValueOnce([makeMockTask('active-1', 'active')]) // active
        .mockResolvedValueOnce([makeMockTask('stopped-1', 'complete')]) // stopped
      // History record with added_at — newest
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        {
          gid: 'hist-1',
          name: 'old.zip',
          status: 'complete',
          added_at: '2024-01-01T10:02:00Z',
        } as HistoryRecord,
      ])

      await store.fetchList()

      const gids = store.taskList.map((t: { gid: string }) => t.gid)
      // Sorted by added_at DESC: hist-1 (newest), stopped-1, active-1 (oldest)
      expect(gids).toEqual(['hist-1', 'stopped-1', 'active-1'])
    })

    it('calls fetchTaskList for active and stopped concurrently', async () => {
      // changeCurrentList('all') internally calls fetchList, so we set up returns for that first
      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active (consumed by changeCurrentList)
        .mockResolvedValueOnce([]) // stopped (consumed by changeCurrentList)
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.changeCurrentList('all')

      // Reset to count only the explicit fetchList call
      mockApi.fetchTaskList.mockReset()
      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active
        .mockResolvedValueOnce([]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      // Should call fetchTaskList twice: once for active, once for stopped
      expect(mockApi.fetchTaskList).toHaveBeenCalledTimes(2)
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith(expect.objectContaining({ type: 'stopped' }))
    })

    it('passes limit for stopped and history queries', async () => {
      await store.changeCurrentList('all')

      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active
        .mockResolvedValueOnce([]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      // The stopped call should have a limit
      const stoppedCall = mockApi.fetchTaskList.mock.calls.find(
        (c: unknown[]) => (c[0] as { type: string }).type === 'stopped',
      )
      expect(stoppedCall).toBeDefined()
      expect((stoppedCall![0] as { limit?: number }).limit).toBeDefined()
      expect(typeof (stoppedCall![0] as { limit?: number }).limit).toBe('number')

      // History should also be called with a limit
      expect(mockHistoryFns.getRecords).toHaveBeenCalledWith(undefined, expect.any(Number))
    })

    it('handles empty data from all sources gracefully', async () => {
      await store.changeCurrentList('all')

      mockApi.fetchTaskList.mockResolvedValueOnce([]).mockResolvedValueOnce([])
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      expect(store.taskList).toEqual([])
    })

    it('preserves position when task transitions from active to stopped', async () => {
      // Simulate: task 'bbb' completes between polls.
      // Both tasks pre-registered with birth timestamps
      registerAddedAt('bbb', '2024-01-01T10:01:00Z') // added second (newer)
      registerAddedAt('aaa', '2024-01-01T10:00:00Z') // added first (older)

      await store.changeCurrentList('all')

      // Poll 1: both active
      mockApi.fetchTaskList
        .mockResolvedValueOnce([makeMockTask('bbb', 'active'), makeMockTask('aaa', 'active')])
        .mockResolvedValueOnce([])
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()
      const poll1Gids = store.taskList.map((t: { gid: string }) => t.gid)
      // Sorted by added_at DESC: bbb (newer) then aaa (older)
      expect(poll1Gids).toEqual(['bbb', 'aaa'])

      // Poll 2: 'bbb' moved to stopped, 'aaa' still active
      mockApi.fetchTaskList
        .mockResolvedValueOnce([makeMockTask('aaa', 'active')])
        .mockResolvedValueOnce([makeMockTask('bbb', 'complete')])
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()
      const poll2Gids = store.taskList.map((t: { gid: string }) => t.gid)
      // Position unchanged: bbb still before aaa (sorted by added_at)
      expect(poll2Gids).toEqual(['bbb', 'aaa'])
    })

    it('newly tracked tasks (no pre-registered added_at) sort above old DB records', async () => {
      // Edge case: a task appears in aria2 tellStopped before addedAtMap is populated.
      // trackFirstSeen assigns a current timestamp → sorts above old DB records.
      await store.changeCurrentList('all')

      mockApi.fetchTaskList
        .mockResolvedValueOnce([]) // active
        .mockResolvedValueOnce([makeMockTask('fresh', 'complete')]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        {
          gid: 'old',
          name: 'old.zip',
          status: 'complete',
          added_at: '2024-01-01T00:00:00Z',
        } as HistoryRecord,
      ])

      await store.fetchList()

      const gids = store.taskList.map((t: { gid: string }) => t.gid)
      // 'fresh' gets current time from trackFirstSeen → sorts first
      expect(gids).toEqual(['fresh', 'old'])
    })

    it('filters out completed native aria2 metadata tasks from the stopped source', async () => {
      await store.changeCurrentList('all')

      const completedMeta = makeMockTask('meta1', 'complete', {
        bittorrent: {},
        followedBy: ['real-gid'],
      })
      const realTask = makeMockTask('real-gid', 'active')

      mockApi.fetchTaskList.mockResolvedValueOnce([realTask]).mockResolvedValueOnce([completedMeta])
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      expect(store.taskList).toHaveLength(1)
      expect(store.taskList[0].gid).toBe('real-gid')
    })

    it('keeps actively-downloading native aria2 metadata tasks visible', async () => {
      await store.changeCurrentList('all')

      const activeMeta = makeMockTask('meta-active', 'active', {
        bittorrent: {},
      })

      mockApi.fetchTaskList.mockResolvedValueOnce([activeMeta]).mockResolvedValueOnce([]) // stopped
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      expect(store.taskList).toHaveLength(1)
      expect(store.taskList[0].gid).toBe('meta-active')
    })

    it('filters ED2K search request groups from the task list', async () => {
      await store.changeCurrentList('all')

      const searchTask = makeMockTask('search-gid', 'active', {
        ed2k: { searchActive: true },
        files: [
          {
            index: '1',
            path: '/Users/test/Downloads/aria2-next-ed2k-search-search-gid',
            length: '0',
            completedLength: '0',
            selected: 'true',
            uris: [],
          },
        ],
      })
      const downloadTask = makeMockTask('download-gid', 'active')

      mockApi.fetchTaskList.mockResolvedValueOnce([searchTask, downloadTask]).mockResolvedValueOnce([])
      mockHistoryFns.getRecords.mockResolvedValueOnce([])

      await store.fetchList()

      expect(store.taskList).toHaveLength(1)
      expect(store.taskList[0].gid).toBe('download-gid')
    })
  })

  // ─── pagination ────────────────────────────────────────

  it('keeps independent task page state per tab and clamps overflowing pages', async () => {
    store.setTaskPage('active', 3)
    store.setTaskPage('stopped', 2)
    store.setTaskPageSize(2)
    await store.fetchList()

    store.clampCurrentTaskPage()

    expect(store.taskPagination.active.page).toBe(1)
    expect(store.taskPagination.stopped.page).toBe(2)
    expect(store.taskPagination.pageSize).toBe(2)
  })

  it('keeps the previous page count while a different tab is loading', async () => {
    const activeTasks = [
      makeMockTask('a1'),
      makeMockTask('a2'),
      makeMockTask('a3'),
      makeMockTask('a4'),
      makeMockTask('a5'),
    ]
    mockApi.fetchTaskList.mockResolvedValueOnce([...activeTasks])
    store.setTaskPageSize(2)
    await store.fetchList()
    expect(store.currentTaskPageCount()).toBe(3)

    mockHistoryFns.getRecords.mockImplementationOnce(async () => {
      expect(store.taskList.map((task) => task.gid).sort()).toEqual(activeTasks.map((task) => task.gid).sort())
      expect(store.currentTaskPageCount()).toBe(3)
      return [
        { gid: 'b1', name: 'b1.zip', status: 'complete' } as HistoryRecord,
        { gid: 'b2', name: 'b2.zip', status: 'complete' } as HistoryRecord,
      ]
    })

    await store.changeCurrentList('stopped')

    expect(store.currentTaskPageCount()).toBe(1)
  })

  it('writes a reordered visible page back into the full task list before saving manual order', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    const saveSpy = vi.spyOn(preferenceStore, 'updateAndSave').mockResolvedValue(true)
    store.taskList = ['a', 'b', 'c', 'd', 'e'].map((gid) => makeMockTask(gid))
    store.setTaskPageSize(2)
    store.setTaskPage('active', 2)

    await store.saveVisiblePageManualOrder([makeMockTask('d'), makeMockTask('c')])

    expect(store.taskList.map((task) => task.gid)).toEqual(['a', 'b', 'd', 'c', 'e'])
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskManualOrder: expect.objectContaining({
          active: ['a', 'b', 'd', 'c', 'e'],
        }),
      }),
    )
  })

  // ─── addUri / addTorrent ────────────────────────────────

  it('addUri calls API and refreshes list', async () => {
    await store.addUri({ uris: ['http://example.com/file.zip'], outs: [], options: {} })
    expect(mockApi.addUri).toHaveBeenCalled()
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('addUri injects saved HTTP auth credentials for matching origins', async () => {
    mockHttpAuthFns.findByUrl.mockResolvedValueOnce({
      id: 10,
      origin: 'https://files.example.com',
      username: 'demo',
      password: 'secret',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      last_used_at: null,
    })

    await store.addUri({ uris: ['https://files.example.com/private/file.zip'], outs: [], options: {} })

    expect(mockApi.addUri).toHaveBeenCalledWith({
      uris: ['https://files.example.com/private/file.zip'],
      outs: [''],
      options: expect.objectContaining({
        'http-user': 'demo',
        'http-passwd': 'secret',
      }),
      fileCategory: undefined,
    })
    expect(mockHttpAuthFns.markUsed).toHaveBeenCalledWith(10)
  })

  it('addTorrent calls API, refreshes, and returns gid', async () => {
    const gid = await store.addTorrent({ torrent: 'base64data', options: {} })
    expect(mockApi.addTorrent).toHaveBeenCalledWith({ torrent: 'base64data', options: {} })
    expect(gid).toBe('gid4')
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('addHls calls API, records birth, refreshes, and returns gid', async () => {
    const gid = await store.addHls({ uri: 'https://x/a.m3u8', options: { dir: '/dl' } })
    expect(mockApi.addHls).toHaveBeenCalledWith({ uri: 'https://x/a.m3u8', options: { dir: '/dl' } })
    expect(gid).toBe('hls-gid')
    expect(mockHistoryFns.recordTaskBirth).toHaveBeenCalledWith('hls-gid', expect.any(String))
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('addMagnetUri forces integrity checking for the follow-up BitTorrent download', async () => {
    const gid = await store.addMagnetUri({ uri: 'magnet:?xt=urn:btih:abc123', options: { dir: '/dl' } })

    expect(gid).toBe('gid3')
    expect(mockApi.addUri).toHaveBeenCalledWith({
      uris: ['magnet:?xt=urn:btih:abc123'],
      outs: [],
      options: { dir: '/dl', 'pause-metadata': 'true', 'check-integrity': 'true', 'force-save': 'true' },
    })
  })

  // ─── pauseAllTask / resumeAllTask ───────────────────────

  it('pauseAllTask pauses non-seeding tasks individually via forcePauseTask', async () => {
    // Default mock taskList has 2 active tasks: gid1, gid2
    await store.fetchList()
    await store.pauseAllTask()
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid2' })
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('pauseAllTask skips seeding tasks', async () => {
    mockApi.fetchTaskList.mockResolvedValueOnce([
      makeMockTask('dl-1', 'active'),
      makeMockTask('seed-1', 'active', {
        bittorrent: { info: { name: 'movie.mkv' } },
        seeder: 'true',
      }),
    ])
    await store.fetchList()
    await store.pauseAllTask()
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'dl-1' })
    expect(mockApi.forcePauseTask).toHaveBeenCalledTimes(1)
  })

  it('resumeAllTask resumes eligible paused tasks, refreshes, and saves session', async () => {
    mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('paused-1', 'paused')])
    await store.fetchList()
    await store.resumeAllTask()
    expect(mockApi.batchResumeTask).toHaveBeenCalledWith({ gids: ['paused-1'] })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  // ─── showTaskDetail / hideTaskDetail ────────────────────

  it('showTaskDetail sets visibility, gid, and current task item', () => {
    const task = makeMockTask('gid1')
    store.showTaskDetail(task)
    expect(store.taskDetailVisible).toBe(true)
    expect(store.currentTaskGid).toBe('gid1')
    expect(store.currentTaskItem?.gid).toBe('gid1')
  })

  it('hideTaskDetail resets visibility', () => {
    store.showTaskDetail(makeMockTask('gid1'))
    store.hideTaskDetail()
    expect(store.taskDetailVisible).toBe(false)
  })

  // ─── changeCurrentList ──────────────────────────────────

  it('changeCurrentList keeps the current list visible until the target tab data arrives', async () => {
    store.taskList = [makeMockTask('old')]
    mockApi.fetchTaskList.mockImplementationOnce(async () => {
      expect(store.taskList.map((task) => task.gid)).toEqual(['old'])
      return [makeMockTask('fresh')]
    })

    await store.changeCurrentList('waiting')

    expect(store.currentList).toBe('waiting')
    expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'waiting' })
    expect(store.taskList.map((task) => task.gid)).toEqual(['fresh'])
  })

  // ─── removeTask ─────────────────────────────────────────

  it('removeTask calls API and refreshes list', async () => {
    const task = makeMockTask('gid1')
    await store.removeTask(task)
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('removeTask hides detail if removing current detail task', async () => {
    const task = makeMockTask('gid1')
    store.showTaskDetail(task)
    expect(store.taskDetailVisible).toBe(true)
    await store.removeTask(task)
    expect(store.taskDetailVisible).toBe(false)
  })

  it('removeTask always refreshes list even if API throws', async () => {
    mockApi.removeTask.mockRejectedValueOnce(new Error('not found'))
    const task = makeMockTask('gid1')
    await expect(store.removeTask(task)).rejects.toThrow('not found')
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  // ─── pauseTask / resumeTask ─────────────────────────────

  it('pauseTask uses forcePause for BT tasks', async () => {
    const btTask = makeMockTask('gid1', 'active', { bittorrent: { info: { name: 'test' } } })
    await store.pauseTask(btTask)
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.pauseTask).not.toHaveBeenCalled()
  })

  it('pauseTask uses regular pause for HTTP tasks', async () => {
    const httpTask = makeMockTask('gid1')
    await store.pauseTask(httpTask)
    expect(mockApi.pauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.forcePauseTask).not.toHaveBeenCalled()
  })

  it('resumeTask calls API, refreshes, and saves session', async () => {
    const task = makeMockTask('gid1')
    await store.resumeTask(task)
    expect(mockApi.resumeTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  // ─── toggleTask ─────────────────────────────────────────

  it('toggleTask pauses active task', async () => {
    const task = makeMockTask('gid1', 'active')
    await store.toggleTask(task)
    expect(mockApi.pauseTask).toHaveBeenCalled()
  })

  it('toggleTask resumes paused task', async () => {
    const task = makeMockTask('gid1', 'paused')
    await store.toggleTask(task)
    expect(mockApi.resumeTask).toHaveBeenCalled()
  })

  it('toggleTask pauses waiting task', async () => {
    const task = makeMockTask('gid1', 'waiting')
    await store.toggleTask(task)
    expect(mockApi.pauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.resumeTask).not.toHaveBeenCalled()
  })

  // ─── batch operations ───────────────────────────────────

  it('batchRemoveTask calls API with gids and saves session', async () => {
    await store.batchRemoveTask(['gid1', 'gid2'])
    expect(mockApi.batchRemoveTask).toHaveBeenCalledWith({ gids: ['gid1', 'gid2'] })
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  // ─── updateCurrentTaskItem ──────────────────────────────

  it('updateCurrentTaskItem sets task, files, and peers', () => {
    const task = makeMockTask('gid1', 'active', {
      files: [{ index: '1', path: '/tmp/f1', length: '100', completedLength: '50', selected: 'true', uris: [] }],
    })
    ;(task as Aria2Task & { peers?: Aria2Peer[] }).peers = [
      {
        peerId: '-qB1234-',
        ip: '1.2.3.4',
        port: '6881',
        bitfield: 'ff',
        amChoking: 'false',
        peerChoking: 'false',
        downloadSpeed: '100',
        uploadSpeed: '0',
        seeder: 'false',
      },
    ]
    store.updateCurrentTaskItem(task)
    expect(store.currentTaskItem?.gid).toBe('gid1')
    expect(store.currentTaskFiles).toHaveLength(1)
  })

  it('updateCurrentTaskItem with null clears all', () => {
    store.showTaskDetail(makeMockTask('gid1'))
    store.updateCurrentTaskItem(null)
    expect(store.currentTaskItem).toBeNull()
    expect(store.currentTaskFiles).toEqual([])
    expect(store.currentTaskPeers).toEqual([])
  })

  // ─── sharingList ────────────────────────────────────────

  it('addToSharingList adds new gid', () => {
    store.addToSharingList('gid1')
    expect(store.sharingList).toContain('gid1')
  })

  it('addToSharingList ignores duplicates', () => {
    store.addToSharingList('gid1')
    store.addToSharingList('gid1')
    expect(store.sharingList).toEqual(['gid1'])
  })

  it('removeFromSharingList removes existing gid', () => {
    store.addToSharingList('gid1')
    store.addToSharingList('gid2')
    store.removeFromSharingList('gid1')
    expect(store.sharingList).toEqual(['gid2'])
  })

  it('removeFromSharingList ignores non-existent gid', () => {
    store.addToSharingList('gid1')
    store.removeFromSharingList('gid999')
    expect(store.sharingList).toEqual(['gid1'])
  })

  // ─── stopSharing ────────────────────────────────────────

  it('stopSharing calls forcePause then removeTask then writes DB', async () => {
    const callOrder: string[] = []
    mockApi.forcePauseTask.mockImplementation(() => {
      callOrder.push('forcePause')
      return Promise.resolve('OK')
    })
    mockApi.removeTask.mockImplementation(() => {
      callOrder.push('removeTask')
      return Promise.resolve('OK')
    })

    const task = makeMockTask('gid1', 'active', { bittorrent: { info: { name: 'seed' } }, seeder: 'true' })
    await store.stopSharing(task)

    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(callOrder).toEqual(['forcePause', 'removeTask'])
    // DB persistence
    expect(mockHistoryFns.addRecord).toHaveBeenCalledWith(expect.objectContaining({ gid: 'gid1', status: 'complete' }))
  })

  it('stopSharing does not call removeTask if forcePause fails', async () => {
    mockApi.forcePauseTask.mockRejectedValueOnce(new Error('pause failed'))

    const task = makeMockTask('gid1', 'active', { bittorrent: { info: { name: 'x' } }, seeder: 'true' })
    await expect(store.stopSharing(task)).rejects.toThrow('pause failed')
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 'gid1' })
    expect(mockApi.removeTask).not.toHaveBeenCalled()
    expect(mockHistoryFns.addRecord).not.toHaveBeenCalled()
  })

  // ─── stopAllSharing ─────────────────────────────────────

  it('stopAllSharing calls two-step stop + DB write for every sharing task', async () => {
    const seeder1 = makeMockTask('s1', 'active', { bittorrent: { info: { name: 'a' } }, seeder: 'true' })
    const seeder2 = makeMockTask('s2', 'active', { bittorrent: { info: { name: 'b' } }, seeder: 'true' })
    store.taskList = [seeder1, seeder2]
    const count = await store.stopAllSharing()
    expect(count).toBe(2)
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 's1' })
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 's2' })
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 's1' })
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 's2' })
    // Both tasks persisted to DB
    expect(mockHistoryFns.addRecord).toHaveBeenCalledTimes(2)
  })

  it('stopAllSharing skips non-sharing tasks', async () => {
    const active = makeMockTask('a1', 'active')
    const seeder = makeMockTask('s1', 'active', { bittorrent: { info: { name: 'x' } }, seeder: 'true' })
    store.taskList = [active, seeder]
    const count = await store.stopAllSharing()
    expect(count).toBe(1)
    expect(mockApi.forcePauseTask).toHaveBeenCalledTimes(1)
    expect(mockApi.forcePauseTask).toHaveBeenCalledWith({ gid: 's1' })
    expect(mockApi.removeTask).toHaveBeenCalledTimes(1)
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 's1' })
  })

  it('stopAllSharing returns 0 when no sharing tasks exist', async () => {
    store.taskList = [makeMockTask('a1', 'active')]
    const count = await store.stopAllSharing()
    expect(count).toBe(0)
    expect(mockApi.forcePauseTask).not.toHaveBeenCalled()
    expect(mockApi.removeTask).not.toHaveBeenCalled()
  })

  it('stopAllSharing continues even if one task fails', async () => {
    const seeder1 = makeMockTask('s1', 'active', { bittorrent: { info: { name: 'a' } }, seeder: 'true' })
    const seeder2 = makeMockTask('s2', 'active', { bittorrent: { info: { name: 'b' } }, seeder: 'true' })
    store.taskList = [seeder1, seeder2]
    mockApi.forcePauseTask.mockRejectedValueOnce(new Error('fail'))
    const count = await store.stopAllSharing()
    expect(count).toBe(2)
    // Both tasks attempted — s1 failed at forcePause, s2 succeeded with both steps
    expect(mockApi.forcePauseTask).toHaveBeenCalledTimes(2)
  })

  // ─── removeTaskRecord ───────────────────────────────────

  it('removeTaskRecord removes completed task via DB then aria2', async () => {
    const task = makeMockTask('gid1', 'complete')
    await store.removeTaskRecord(task)
    // DB is primary — removeRecord called first
    expect(mockHistoryFns.removeRecord).toHaveBeenCalledWith('gid1')
    // aria2 best-effort cleanup
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'gid1' })
  })

  it('removeTaskRecord removes error task via DB then aria2', async () => {
    const task = makeMockTask('gid1', 'error')
    await store.removeTaskRecord(task)
    expect(mockHistoryFns.removeRecord).toHaveBeenCalledWith('gid1')
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'gid1' })
  })

  it('removeTaskRecord ignores active task', async () => {
    const task = makeMockTask('gid1', 'active')
    await store.removeTaskRecord(task)
    expect(mockHistoryFns.removeRecord).not.toHaveBeenCalled()
    expect(mockApi.removeTaskRecord).not.toHaveBeenCalled()
  })

  it('removeTaskRecord hides detail if removing current detail task', async () => {
    const task = makeMockTask('gid1', 'complete')
    store.showTaskDetail(task)
    await store.removeTaskRecord(task)
    expect(store.taskDetailVisible).toBe(false)
    expect(mockHistoryFns.removeRecord).toHaveBeenCalledWith('gid1')
  })

  it('removeTaskRecord survives aria2 failure (DB-only records)', async () => {
    mockApi.removeTaskRecord.mockRejectedValueOnce(new Error('GID not found'))
    const task = makeMockTask('gid1', 'complete')
    await store.removeTaskRecord(task)
    expect(mockHistoryFns.removeRecord).toHaveBeenCalledWith('gid1')
  })

  // ─── purgeTaskRecord ────────────────────────────────────

  it('purgeTaskRecord clears DB then aria2 and refreshes list', async () => {
    await store.purgeTaskRecord()
    expect(mockHistoryFns.clearRecords).toHaveBeenCalled()
    expect(mockApi.purgeTaskRecord).toHaveBeenCalled()
  })

  it('purgeTaskRecord survives aria2 failure', async () => {
    mockApi.purgeTaskRecord.mockRejectedValueOnce(new Error('RPC fail'))
    await store.purgeTaskRecord()
    expect(mockHistoryFns.clearRecords).toHaveBeenCalled()
  })

  // ─── saveSession ────────────────────────────────────────

  it('saveSession calls API', () => {
    store.saveSession()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })
  // ─── restartTask ───────────────────────────────────────

  it('restartTask submits single URI and removes old record on success', async () => {
    const task = makeMockTask('stopped1', 'error', {
      files: [
        {
          index: '1',
          path: '/tmp/file.zip',
          length: '1000',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/file.zip', status: 'used' }],
        },
      ],
    })
    mockApi.addUriAtomic.mockResolvedValue('new-gid-1')
    mockApi.getOption.mockResolvedValue({ dir: '/tmp' })
    await store.restartTask(task)

    expect(mockApi.addUriAtomic).toHaveBeenCalledTimes(1)
    expect(mockApi.addUriAtomic).toHaveBeenCalledWith({
      uris: ['http://example.com/file.zip'],
      options: { dir: '/tmp' },
    })
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'stopped1' })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('restartTask submits each URI separately for multi-file tasks', async () => {
    const task = makeMockTask('stopped2', 'error', {
      files: [
        {
          index: '1',
          path: '/tmp/a.zip',
          length: '500',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/a.zip', status: 'used' }],
        },
        {
          index: '2',
          path: '/tmp/b.zip',
          length: '500',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/b.zip', status: 'used' }],
        },
      ],
    })
    mockApi.addUriAtomic.mockResolvedValueOnce('new-a').mockResolvedValueOnce('new-b')
    mockApi.getOption.mockResolvedValue({ dir: '/tmp' })
    await store.restartTask(task)

    expect(mockApi.addUriAtomic).toHaveBeenCalledTimes(2)
    expect(mockApi.addUriAtomic).toHaveBeenNthCalledWith(1, {
      uris: ['http://example.com/a.zip'],
      options: { dir: '/tmp' },
    })
    expect(mockApi.addUriAtomic).toHaveBeenNthCalledWith(2, {
      uris: ['http://example.com/b.zip'],
      options: { dir: '/tmp' },
    })
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'stopped2' })
  })

  it('restartTask rolls back created tasks on partial failure', async () => {
    const task = makeMockTask('stopped3', 'error', {
      files: [
        {
          index: '1',
          path: '/tmp/a.zip',
          length: '500',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/a.zip', status: 'used' }],
        },
        {
          index: '2',
          path: '/tmp/b.zip',
          length: '500',
          completedLength: '0',
          selected: 'true',
          uris: [{ uri: 'http://example.com/b.zip', status: 'used' }],
        },
      ],
    })
    // First URI succeeds, second fails
    mockApi.addUriAtomic.mockResolvedValueOnce('new-a').mockRejectedValueOnce(new Error('network error'))

    await expect(store.restartTask(task)).rejects.toThrow('network error')

    // Rollback: the successfully created task should be removed
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 'new-a' })
    // Old record must NOT be deleted since restart failed
    expect(mockApi.removeTaskRecord).not.toHaveBeenCalled()
  })

  it('restartTask skips non-stopped tasks', async () => {
    const task = makeMockTask('active1', 'active')
    await store.restartTask(task)

    expect(mockApi.addUriAtomic).not.toHaveBeenCalled()
    expect(mockApi.removeTaskRecord).not.toHaveBeenCalled()
  })

  // ─── hasActiveTasks ─────────────────────────────────────

  describe('hasActiveTasks', () => {
    it('returns true when active tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('a1', 'active')])
      expect(await store.hasActiveTasks()).toBe(true)
    })

    it('returns true when waiting tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('w1', 'waiting')])
      expect(await store.hasActiveTasks()).toBe(true)
    })

    it('returns false when only paused/completed tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('p1', 'paused'), makeMockTask('c1', 'complete')])
      expect(await store.hasActiveTasks()).toBe(false)
    })

    it('returns false when no tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([])
      expect(await store.hasActiveTasks()).toBe(false)
    })

    it('returns false on API error', async () => {
      mockApi.fetchTaskList.mockRejectedValueOnce(new Error('RPC fail'))
      expect(await store.hasActiveTasks()).toBe(false)
    })

    it('queries globally regardless of current tab', async () => {
      // Switch to completed tab first
      mockApi.fetchTaskList.mockResolvedValue([])
      await store.changeCurrentList('stopped')
      mockApi.fetchTaskList.mockReset()

      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('a1', 'active')])
      expect(await store.hasActiveTasks()).toBe(true)
      // Must query active type, not the current 'stopped' tab
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
    })
  })

  // ─── hasPausedTasks ─────────────────────────────────────

  describe('hasPausedTasks', () => {
    it('returns true when paused tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('p1', 'paused')])
      expect(await store.hasPausedTasks()).toBe(true)
    })

    it('returns false when only active/waiting tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('a1', 'active'), makeMockTask('w1', 'waiting')])
      expect(await store.hasPausedTasks()).toBe(false)
    })

    it('returns false when no tasks exist', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([])
      expect(await store.hasPausedTasks()).toBe(false)
    })

    it('returns false on API error', async () => {
      mockApi.fetchTaskList.mockRejectedValueOnce(new Error('RPC fail'))
      expect(await store.hasPausedTasks()).toBe(false)
    })

    it('queries globally regardless of current tab', async () => {
      // Switch to completed tab
      mockApi.fetchTaskList.mockResolvedValue([])
      await store.changeCurrentList('stopped')
      mockApi.fetchTaskList.mockReset()

      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('p1', 'paused')])
      expect(await store.hasPausedTasks()).toBe(true)
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
    })
  })

  // NOTE: Task lifecycle scanning (completion + error detection) has been
  // migrated to the app-level useTaskLifecycleService. Tests are in
  // src/composables/__tests__/useTaskLifecycleService.test.ts

  // ── registerTorrentSource / consumeTorrentSource ────────────────────

  describe('torrent source path tracking', () => {
    it('registers and consumes a source path by infoHash', () => {
      store.registerTorrentSource('abc123', '/downloads/movie.torrent')
      expect(store.consumeTorrentSource('abc123')).toBe('/downloads/movie.torrent')
    })

    it('consumeTorrentSource returns undefined for unknown hash', () => {
      expect(store.consumeTorrentSource('nonexistent')).toBeUndefined()
    })

    it('consumeTorrentSource deletes the entry after first consumption', () => {
      store.registerTorrentSource('abc123', '/downloads/movie.torrent')
      store.consumeTorrentSource('abc123')
      expect(store.consumeTorrentSource('abc123')).toBeUndefined()
    })

    it('overwrites previous path when same hash is registered twice', () => {
      store.registerTorrentSource('abc123', '/old/path.torrent')
      store.registerTorrentSource('abc123', '/new/path.torrent')
      expect(store.consumeTorrentSource('abc123')).toBe('/new/path.torrent')
    })

    it('tracks multiple hashes independently', () => {
      store.registerTorrentSource('hash1', '/path/a.torrent')
      store.registerTorrentSource('hash2', '/path/b.torrent')
      expect(store.consumeTorrentSource('hash1')).toBe('/path/a.torrent')
      expect(store.consumeTorrentSource('hash2')).toBe('/path/b.torrent')
    })
  })
})
