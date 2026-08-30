/** @fileoverview Unit tests for TaskStore with mocked TaskApi. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  getStatusCounts: vi.fn().mockResolvedValue({ completed: 0, failed: 0 }),
  countRecordsMatchingTaskIdentities: vi.fn().mockResolvedValue(0),
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
    addTorrent: vi.fn().mockResolvedValue('gid4'),
    getOption: vi.fn().mockResolvedValue({}),
    changeOption: vi.fn().mockResolvedValue(undefined),
    getFiles: vi.fn().mockResolvedValue([]),
    removeTask: vi.fn().mockResolvedValue('gid1'),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    batchDeleteTasks: vi.fn().mockResolvedValue({ succeeded: ['gid1', 'gid2'], failed: [] }),
    finishSharing: vi.fn().mockResolvedValue(undefined),
    batchFinishSharing: vi.fn().mockResolvedValue({ succeeded: [], failed: [] }),
    forcePauseTask: vi.fn().mockResolvedValue('gid1'),
    forcePauseAll: vi.fn().mockResolvedValue('OK'),
    pauseTask: vi.fn().mockResolvedValue('gid1'),
    resumeTask: vi.fn().mockResolvedValue('gid1'),
    resumeEligible: vi.fn().mockResolvedValue({ resumed: 1, blocked: 0 }),
    removeTaskRecord: vi.fn().mockResolvedValue('OK'),
    purgeTaskRecords: vi.fn().mockResolvedValue(undefined),
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
    store.currentList = 'progress'
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
        all: { field: 'added-at', direction: 'desc' },
        progress: { field: 'manual', direction: 'desc' },
        failed: { field: 'added-at', direction: 'desc' },
        completed: { field: 'added-at', direction: 'desc' },
      },
      taskManualOrder: {
        all: [],
        progress: ['old-2', 'old-1'],
        failed: [],
        completed: [],
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

    expect(preferenceStore.config.taskSort.progress).toEqual({ field: 'name', direction: 'desc' })
    expect(store.taskList.map((task) => task.gid)).toEqual(['beta', 'alpha'])

    await store.changeCurrentSort('name')

    expect(preferenceStore.config.taskSort.progress).toEqual({ field: 'name', direction: 'asc' })
    expect(store.taskList.map((task) => task.gid)).toEqual(['alpha', 'beta'])
    expect(saveSpy).toHaveBeenCalledTimes(2)
  })

  // ─── exclusive task scopes ──────────────────────────────

  describe('exclusive task scopes', () => {
    it('merges live tasks and persisted history in All', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('live', 'active')])
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        { gid: 'done', name: 'done.zip', status: 'complete' } as HistoryRecord,
        { gid: 'failed', name: 'failed.zip', status: 'error' } as HistoryRecord,
      ])

      await store.changeCurrentList('all')

      expect(new Set(store.taskList.map((task) => task.gid))).toEqual(new Set(['live', 'done', 'failed']))
      expect(mockApi.fetchTaskList).toHaveBeenCalledWith({ type: 'active' })
      expect(mockHistoryFns.getRecords).toHaveBeenCalledWith()
    })

    it('keeps a sharing task only in In Progress until sharing ends', async () => {
      const sharing = makeMockTask('torrent', 'active', {
        seeder: 'true',
        infoHash: 'hash',
        bittorrent: { info: { name: 'torrent' } },
      })
      const completedRecord = {
        gid: 'torrent',
        name: 'torrent',
        status: 'complete',
        task_type: 'bt',
        meta: JSON.stringify({ infoHash: 'hash' }),
      } as HistoryRecord

      mockHistoryFns.getRecords.mockResolvedValueOnce([completedRecord])
      mockApi.fetchTaskList.mockResolvedValueOnce([sharing])
      await store.changeCurrentList('completed')
      expect(store.taskList).toEqual([])

      mockHistoryFns.getRecords.mockResolvedValueOnce([completedRecord])
      mockApi.fetchTaskList.mockResolvedValueOnce([])
      await store.fetchList()
      expect(store.taskList.map((task) => task.gid)).toEqual(['torrent'])
    })

    it('shows errors only in Failed', async () => {
      mockHistoryFns.getRecords.mockResolvedValueOnce([
        { gid: 'error', name: 'error.zip', status: 'error' } as HistoryRecord,
      ])
      mockApi.fetchTaskList.mockResolvedValueOnce([])

      await store.changeCurrentList('failed')

      expect(store.taskList).toHaveLength(1)
      expect(store.taskList[0].status).toBe('error')
      expect(mockHistoryFns.getRecords).toHaveBeenCalledWith('error')
    })

    it('filters internal ED2K search groups from In Progress', async () => {
      const searchTask = makeMockTask('search', 'active', {
        ed2k: { searchActive: true },
        files: [
          {
            index: '1',
            path: '/tmp/aria2-next-ed2k-search-search',
            length: '0',
            completedLength: '0',
            selected: 'true',
            uris: [],
          },
        ],
      })
      mockApi.fetchTaskList.mockResolvedValueOnce([searchTask, makeMockTask('download')])

      await store.changeCurrentList('progress')

      expect(store.taskList.map((task) => task.gid)).toEqual(['download'])
    })

    it('derives exclusive counts from live tasks and terminal history', async () => {
      mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('sharing')])
      mockHistoryFns.getStatusCounts.mockResolvedValueOnce({ completed: 4, failed: 2 })
      mockHistoryFns.countRecordsMatchingTaskIdentities.mockResolvedValueOnce(1).mockResolvedValueOnce(0)

      await store.refreshTaskCounts()

      expect(store.taskCounts).toEqual({ all: 6, progress: 1, failed: 2, completed: 3 })
    })
  })

  // ─── pagination ────────────────────────────────────────

  it('keeps independent task page state per tab and clamps overflowing pages', async () => {
    store.setTaskPage('progress', 3)
    store.setTaskPage('completed', 2)
    store.setTaskPageSize(2)
    await store.fetchList()

    store.clampCurrentTaskPage()

    expect(store.taskPagination.progress.page).toBe(1)
    expect(store.taskPagination.completed.page).toBe(2)
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

    mockApi.fetchTaskList.mockResolvedValueOnce([])
    await store.changeCurrentList('completed')

    expect(store.currentTaskPageCount()).toBe(1)
  })

  it('writes a reordered visible page back into the full task list before saving manual order', async () => {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    const saveSpy = vi.spyOn(preferenceStore, 'updateAndSave').mockResolvedValue(true)
    store.taskList = ['a', 'b', 'c', 'd', 'e'].map((gid) => makeMockTask(gid))
    store.setTaskPageSize(2)
    store.setTaskPage('progress', 2)

    await store.saveVisiblePageManualOrder([makeMockTask('d'), makeMockTask('c')])

    expect(store.taskList.map((task) => task.gid)).toEqual(['a', 'b', 'd', 'c', 'e'])
    expect(saveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskManualOrder: expect.objectContaining({
          progress: ['a', 'b', 'd', 'c', 'e'],
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

  it('addMagnetUri forces integrity checking for the follow-up BitTorrent download', async () => {
    const gid = await store.addMagnetUri({ uri: 'magnet:?xt=urn:btih:abc123', options: { dir: '/dl' } })

    expect(gid).toBe('gid3')
    expect(mockApi.addUri).toHaveBeenCalledWith({
      uris: ['magnet:?xt=urn:btih:abc123'],
      outs: [],
      options: { dir: '/dl', 'pause-metadata': 'true', 'check-integrity': 'true', 'force-save': 'true' },
    })
    const { useAppStore } = await import('@/stores/app')
    expect(useAppStore().pendingMagnetGids).toEqual(['gid3'])
    expect(useAppStore().automaticMagnetPromptGids).toEqual(['gid3'])
  })

  it('captures manual selection for a new magnet without automatic prompting', async () => {
    const { useAppStore } = await import('@/stores/app')
    const { usePreferenceStore } = await import('@/stores/preference')
    usePreferenceStore().updatePreference({ magnetFileSelectionPolicy: 'manual' })

    await store.addMagnetUri({ uri: 'magnet:?xt=urn:btih:abc123', options: { dir: '/dl' } })

    expect(useAppStore().pendingMagnetGids).toEqual(['gid3'])
    expect(useAppStore().automaticMagnetPromptGids).toEqual([])
  })

  it('lets aria2 download every magnet file without creating selection state', async () => {
    const { useAppStore } = await import('@/stores/app')
    const { usePreferenceStore } = await import('@/stores/preference')
    usePreferenceStore().updatePreference({ magnetFileSelectionPolicy: 'download-all' })

    await store.addMagnetUri({ uri: 'magnet:?xt=urn:btih:abc123', options: { dir: '/dl' } })

    expect(mockApi.addUri).toHaveBeenCalledWith({
      uris: ['magnet:?xt=urn:btih:abc123'],
      outs: [],
      options: { dir: '/dl', 'pause-metadata': 'false', 'check-integrity': 'true', 'force-save': 'true' },
    })
    expect(useAppStore().pendingMagnetGids).toEqual([])
    expect(useAppStore().automaticMagnetPromptGids).toEqual([])
  })

  it('pauses download-all magnets for native metadata classification', async () => {
    const { useAppStore } = await import('@/stores/app')
    const { usePreferenceStore } = await import('@/stores/preference')
    usePreferenceStore().updatePreference({ magnetFileSelectionPolicy: 'download-all' })

    await store.addMagnetUri({
      uri: 'magnet:?xt=urn:btih:abc123',
      options: { dir: '/dl' },
      fileCategory: {
        enabled: true,
        categories: [{ label: 'Videos', extensions: ['mkv'], directory: '/dl/Videos' }],
      },
    })

    expect(mockApi.addUri).toHaveBeenCalledWith({
      uris: ['magnet:?xt=urn:btih:abc123'],
      outs: [],
      options: { dir: '/dl', 'pause-metadata': 'true', 'check-integrity': 'true', 'force-save': 'true' },
    })
    expect(useAppStore().pendingMagnetGids).toEqual(['gid3'])
    expect(useAppStore().automaticMagnetPromptGids).toEqual([])
  })

  // ─── pauseAllTask / resumeAllTask ───────────────────────

  it('pauseAllTask uses the native engine-wide pause operation', async () => {
    await store.fetchList()
    await store.pauseAllTask()
    expect(mockApi.forcePauseAll).toHaveBeenCalledOnce()
    expect(mockApi.forcePauseTask).not.toHaveBeenCalled()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })

  it('pauseAllTask remains native when the queue contains sharing tasks', async () => {
    mockApi.fetchTaskList.mockResolvedValueOnce([
      makeMockTask('dl-1', 'active'),
      makeMockTask('seed-1', 'active', {
        bittorrent: { info: { name: 'movie.mkv' } },
        seeder: 'true',
      }),
    ])
    await store.fetchList()
    await store.pauseAllTask()
    expect(mockApi.forcePauseAll).toHaveBeenCalledOnce()
  })

  it('resumeAllTask resumes eligible paused tasks, refreshes, and saves session', async () => {
    mockApi.fetchTaskList.mockResolvedValueOnce([makeMockTask('paused-1', 'paused')])
    await store.fetchList()
    await store.resumeAllTask()
    expect(mockApi.resumeEligible).toHaveBeenCalledOnce()
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
    mockHistoryFns.getRecords.mockImplementationOnce(async () => {
      expect(store.taskList.map((task) => task.gid)).toEqual(['old'])
      return [{ gid: 'fresh', name: 'fresh.zip', status: 'complete' } as HistoryRecord]
    })
    mockApi.fetchTaskList.mockResolvedValueOnce([])

    await store.changeCurrentList('completed')

    expect(store.currentList).toBe('completed')
    expect(mockHistoryFns.getRecords).toHaveBeenCalledWith('complete')
    expect(store.taskList.map((task) => task.gid)).toEqual(['fresh'])
  })

  it('ignores a stale response from the previous scope', async () => {
    let resolveProgress!: (tasks: Aria2Task[]) => void
    mockApi.fetchTaskList.mockImplementationOnce(
      () =>
        new Promise<Aria2Task[]>((resolve) => {
          resolveProgress = resolve
        }),
    )
    const staleRequest = store.fetchList()

    mockHistoryFns.getRecords.mockResolvedValueOnce([
      { gid: 'completed', name: 'completed.zip', status: 'complete' } as HistoryRecord,
    ])
    mockApi.fetchTaskList.mockResolvedValueOnce([])
    await store.changeCurrentList('completed')

    resolveProgress([makeMockTask('stale')])
    await staleRequest

    expect(store.currentList).toBe('completed')
    expect(store.taskList.map((task) => task.gid)).toEqual(['completed'])
  })

  // ─── removeTask ─────────────────────────────────────────

  it('removeTask calls API and refreshes list', async () => {
    const task = makeMockTask('gid1')
    await store.removeTask(task)
    expect(mockApi.deleteTask).toHaveBeenCalledWith({ gid: 'gid1', infoHash: undefined })
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
    mockApi.deleteTask.mockRejectedValueOnce(new Error('not found'))
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
    expect(mockApi.batchDeleteTasks).toHaveBeenCalledWith({
      tasks: [
        { gid: 'gid1', infoHash: undefined },
        { gid: 'gid2', infoHash: undefined },
      ],
    })
    expect(mockApi.deleteTask).not.toHaveBeenCalled()
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
        state: 'connected',
        transport: 'tcp',
        encryption: 'plain',
        sources: ['tracker'],
        progress: '0.500000',
        flags: 'D',
        incoming: 'false',
        downloaded: '100',
        uploaded: '0',
        completedLength: '50',
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

  // ─── removeTaskRecord ───────────────────────────────────

  it('removeTaskRecord uses the unified deletion transaction', async () => {
    const task = makeMockTask('gid1', 'complete')
    await store.removeTaskRecord(task)
    expect(mockApi.deleteTask).toHaveBeenCalledWith({ gid: 'gid1', infoHash: undefined })
  })

  it('removeTaskRecord hides the current task detail', async () => {
    const task = makeMockTask('gid1', 'complete')
    store.showTaskDetail(task)
    await store.removeTaskRecord(task)
    expect(store.taskDetailVisible).toBe(false)
  })

  // ─── purgeTaskRecord ────────────────────────────────────

  it('purgeTaskRecord uses the native application transaction', async () => {
    await store.purgeTaskRecord()
    expect(mockApi.purgeTaskRecords).toHaveBeenCalledOnce()
    expect(mockHistoryFns.clearRecords).not.toHaveBeenCalled()
  })

  it('purgeTaskRecord surfaces a native transaction failure', async () => {
    mockApi.purgeTaskRecords.mockRejectedValueOnce(new Error('IPC fail'))
    await expect(store.purgeTaskRecord()).rejects.toThrow('IPC fail')
  })

  // ─── saveSession ────────────────────────────────────────

  it('saveSession calls API', () => {
    store.saveSession()
    expect(mockApi.saveSession).toHaveBeenCalled()
  })
  // ─── terminal resubmission ─────────────────────────────

  it('retryTask coalesces repeated clicks into one submission', async () => {
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
    const pending = new Promise<Aria2Task>((resolve) => {
      setTimeout(() => resolve(makeMockTask('new-gid-1', 'active')), 10)
    })
    mockApi.fetchTaskItem.mockReturnValue(pending)
    const first = store.retryTask(task)
    const second = store.retryTask(task)
    await Promise.all([first, second])

    expect(mockApi.addUriAtomic).toHaveBeenCalledTimes(1)
    expect(mockApi.addUriAtomic).toHaveBeenCalledWith({
      uris: ['http://example.com/file.zip'],
      options: { dir: '/tmp', continue: 'true', allowOverwrite: 'false', autoFileRenaming: 'false' },
    })
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'stopped1' })
    expect(mockApi.fetchTaskList).toHaveBeenCalled()
  })

  it('redownloadTask submits each URI separately with fresh-file options', async () => {
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
    mockApi.fetchTaskItem.mockImplementation(({ gid }) => Promise.resolve(makeMockTask(gid, 'active')))
    await store.redownloadTask({ ...task, status: 'complete' })

    expect(mockApi.addUriAtomic).toHaveBeenCalledTimes(2)
    expect(mockApi.addUriAtomic).toHaveBeenNthCalledWith(1, {
      uris: ['http://example.com/a.zip'],
      options: { dir: '/tmp', continue: 'false', allowOverwrite: 'false', autoFileRenaming: 'true' },
    })
    expect(mockApi.addUriAtomic).toHaveBeenNthCalledWith(2, {
      uris: ['http://example.com/b.zip'],
      options: { dir: '/tmp', continue: 'false', allowOverwrite: 'false', autoFileRenaming: 'true' },
    })
    expect(mockApi.removeTaskRecord).toHaveBeenCalledWith({ gid: 'stopped2' })
  })

  it('retryTask rolls back created tasks on partial failure', async () => {
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

    mockApi.fetchTaskItem.mockImplementation(({ gid }) => Promise.resolve(makeMockTask(gid, 'active')))
    await expect(store.retryTask(task)).rejects.toThrow('network error')

    // Rollback: the successfully created task should be removed
    expect(mockApi.removeTask).toHaveBeenCalledWith({ gid: 'new-a' })
    // Old record must NOT be deleted since restart failed
    expect(mockApi.removeTaskRecord).not.toHaveBeenCalled()
  })

  it('retryTask rejects non-error tasks', async () => {
    const task = makeMockTask('active1', 'active')
    await expect(store.retryTask(task)).rejects.toThrow('Cannot retry')
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

  describe('filename search', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function flushSearchRefetch(): Promise<void> {
      await vi.advanceTimersByTimeAsync(250)
    }

    it('filters the All list by a fuzzy keyword after the debounce', async () => {
      const alpha = makeMockTask('alpha', 'active', {
        files: [
          { index: '1', path: '/d/ubuntu-22.04.iso', length: '1', completedLength: '1', selected: 'true', uris: [] },
        ],
      })
      const beta = makeMockTask('beta', 'active', {
        files: [
          { index: '1', path: '/d/debian-12.iso', length: '1', completedLength: '1', selected: 'true', uris: [] },
        ],
      })
      mockApi.fetchTaskList.mockResolvedValue([alpha, beta])
      await store.changeCurrentList('all')

      store.setTaskSearchKeyword('UBUNTU')
      expect(store.taskList).toHaveLength(2)
      await flushSearchRefetch()

      expect(store.taskList.map((task) => task.gid)).toEqual(['alpha'])
      expect(store.taskPagination.all.total).toBe(1)
    })

    it('filters the Completed list by record name', async () => {
      mockHistoryFns.getRecords.mockResolvedValue([
        { gid: 'done-1', name: 'movie-night.mkv', status: 'complete' } as HistoryRecord,
        { gid: 'done-2', name: 'backup.tar.gz', status: 'complete' } as HistoryRecord,
      ])
      mockApi.fetchTaskList.mockResolvedValue([])
      await store.changeCurrentList('completed')

      store.setTaskSearchKeyword('backup')
      await flushSearchRefetch()

      expect(store.taskList.map((task) => task.gid)).toEqual(['done-2'])
    })

    it('clearing the keyword restores the unfiltered list', async () => {
      mockHistoryFns.getRecords.mockResolvedValue([
        { gid: 'done-1', name: 'movie-night.mkv', status: 'complete' } as HistoryRecord,
        { gid: 'done-2', name: 'backup.tar.gz', status: 'complete' } as HistoryRecord,
      ])
      mockApi.fetchTaskList.mockResolvedValue([])
      await store.changeCurrentList('completed')

      store.setTaskSearchKeyword('backup')
      await flushSearchRefetch()
      expect(store.taskList).toHaveLength(1)

      store.setTaskSearchKeyword('')
      await flushSearchRefetch()
      expect(store.taskList.map((task) => task.gid)).toEqual(['done-1', 'done-2'])
      expect(store.taskPagination.completed.total).toBe(2)
    })

    it('keeps the keyword per scope', async () => {
      mockApi.fetchTaskList.mockResolvedValue([makeMockTask('alpha', 'active')])
      await store.changeCurrentList('all')
      store.setTaskSearchKeyword('alpha')
      await flushSearchRefetch()

      await store.changeCurrentList('completed')
      expect(store.taskSearchKeywords.completed).toBe('')
      expect(store.taskSearchKeywords.all).toBe('alpha')
    })

    it('matches a file basename inside a multi-file task', async () => {
      const pack = makeMockTask('pack', 'active', {
        bittorrent: { info: { name: 'Linux Pack' } },
        files: [
          { index: '1', path: '/d/Linux Pack/app.zip', length: '1', completedLength: '1', selected: 'true', uris: [] },
          {
            index: '2',
            path: '/d/Linux Pack/readme.txt',
            length: '1',
            completedLength: '1',
            selected: 'true',
            uris: [],
          },
        ],
      })
      mockApi.fetchTaskList.mockResolvedValue([pack])
      await store.changeCurrentList('all')

      store.setTaskSearchKeyword('readme')
      await flushSearchRefetch()
      expect(store.taskList.map((task) => task.gid)).toEqual(['pack'])
    })

    it('applies the keyword to polling refetches without re-setting it', async () => {
      const alpha = makeMockTask('alpha', 'active', {
        files: [{ index: '1', path: '/d/ubuntu.iso', length: '1', completedLength: '1', selected: 'true', uris: [] }],
      })
      const beta = makeMockTask('beta', 'active', {
        files: [{ index: '1', path: '/d/debian.iso', length: '1', completedLength: '1', selected: 'true', uris: [] }],
      })
      mockApi.fetchTaskList.mockResolvedValue([alpha, beta])
      await store.changeCurrentList('all')

      store.setTaskSearchKeyword('ubuntu')
      await flushSearchRefetch()
      expect(store.taskList).toHaveLength(1)

      await store.fetchList()
      expect(store.taskList.map((task) => task.gid)).toEqual(['alpha'])
    })
  })
})
