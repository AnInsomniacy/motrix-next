/** @fileoverview Pinia store for download task management: list, add, pause, resume, remove. */
import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import { EMPTY_STRING, TASK_STATUS } from '@shared/constants'
import { checkTaskIsEd2kSearch, intersection } from '@shared/utils'
import { logger } from '@shared/logger'
import type { Aria2Task, Aria2File, Aria2Peer, Aria2EngineOptions, TaskApi } from '@shared/types'

import { historyRecordToTask, mergeHistoryIntoTasks, isMetadataTask } from '@/composables/useTaskLifecycle'
import { trackTaskElapsed } from '@/composables/useTaskElapsed'
import { buildMetadataOnlyOptions, shouldShowFileSelection } from '@/composables/useMagnetFlow'
import {
  registerAddedAt,
  getAddedAt,
  trackFirstSeen,
  loadAddedAtFromRecords,
  buildSortableAddedAtMap,
} from '@/composables/useTaskOrder'
import {
  applyManualOrder,
  createManualOrderSnapshot,
  sortTasks,
  sortRecords,
  type ActiveSortField,
  type AllSortField,
  type SortDirection,
  type StoppedSortField,
} from '@/composables/useTaskSort'
import { DEFAULT_TASK_SORT } from '@/composables/useTaskSort'
import { useHistoryStore } from '@/stores/history'
import { useHttpAuthStore } from '@/stores/httpAuth'
import { usePreferenceStore } from '@/stores/preference'

import { restartTask as restartTaskImpl } from './restart'
import { createTaskOperations } from './operations'

export type { Aria2Task, Aria2File, Aria2Peer }

type TaskTabKey = 'active' | 'stopped' | 'all'

const DEFAULT_TASK_PAGE_SIZE = 20

function normalizeTaskTab(list: string): TaskTabKey {
  return list === 'stopped' ? 'stopped' : list === 'all' ? 'all' : 'active'
}

export const useTaskStore = defineStore('task', () => {
  const preferenceStore = usePreferenceStore()
  const currentList = ref('active')
  const taskDetailVisible = ref(false)
  const currentTaskGid = ref(EMPTY_STRING)
  const enabledFetchPeers = ref(false)
  const currentTaskItem = ref<Aria2Task | null>(null)
  const currentTaskFiles = ref<Aria2File[]>([])
  const currentTaskPeers = ref<Aria2Peer[]>([])
  const sharingList = ref<string[]>([])
  const taskList = ref<Aria2Task[]>([])
  const selectedGidList = ref<string[]>([])
  const taskListTransitionRevision = ref(0)
  const taskPagination = reactive({
    active: { page: 1, total: 0, loaded: false },
    stopped: { page: 1, total: 0, loaded: false },
    all: { page: 1, total: 0, loaded: false },
    pageSize: clampPageSize(preferenceStore.config.taskPageSize),
  })
  const visibleTaskPageCount = ref(1)

  let api: TaskApi

  /** In-memory map: infoHash → original .torrent file path for post-download cleanup. */
  const torrentSourcePaths = new Map<string, string>()
  const registerTorrentSource = (hash: string, p: string) => torrentSourcePaths.set(hash, p)
  function consumeTorrentSource(hash: string): string | undefined {
    const p = torrentSourcePaths.get(hash)
    if (p) torrentSourcePaths.delete(hash)
    return p
  }

  function setApi(a: TaskApi) {
    api = a
    // Wire up task operations once API is available
    const ops = createTaskOperations({
      api,
      taskList,
      currentTaskGid,
      hideTaskDetail,
      fetchList,
    })
    Object.assign(taskOps, ops)
  }

  async function changeCurrentList(list: string) {
    const sameList = currentList.value === list
    currentList.value = list
    if (!sameList) {
      taskList.value = []
      selectedGidList.value = []
      const tab = currentTaskTab()
      if (taskPagination[tab].loaded) refreshCurrentTaskPageCount()
    }
    await fetchList()
  }

  function currentTaskTab(): TaskTabKey {
    return normalizeTaskTab(currentList.value)
  }

  function clampPage(page: number): number {
    return Math.max(1, Math.floor(Number.isFinite(page) ? page : 1))
  }

  function clampPageSize(size: number): number {
    return Math.min(Math.max(1, Math.floor(Number.isFinite(size) ? size : DEFAULT_TASK_PAGE_SIZE)), 100)
  }

  function maxTaskPage(tab = currentTaskTab()): number {
    return Math.max(1, Math.ceil(taskPagination[tab].total / taskPagination.pageSize))
  }

  function currentTaskPageCount(): number {
    return visibleTaskPageCount.value
  }

  function refreshCurrentTaskPageCount() {
    visibleTaskPageCount.value = maxTaskPage()
  }

  function clampCurrentTaskPage() {
    const tab = currentTaskTab()
    taskPagination[tab].page = Math.min(clampPage(taskPagination[tab].page), maxTaskPage(tab))
  }

  function updateCurrentTaskTotal(total: number) {
    const tab = currentTaskTab()
    taskPagination[tab].total = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0))
    taskPagination[tab].loaded = true
  }

  function setTaskPage(tab: TaskTabKey, page: number) {
    taskPagination[tab].page = clampPage(page)
  }

  function setCurrentTaskPage(page: number) {
    setTaskPage(currentTaskTab(), page)
  }

  function applyTaskPageSize(size: number) {
    const pageSize = clampPageSize(size)
    if (taskPagination.pageSize === pageSize) return pageSize
    taskPagination.pageSize = pageSize
    clampCurrentTaskPage()
    refreshCurrentTaskPageCount()
    return pageSize
  }

  function setTaskPageSize(size: number) {
    const pageSize = applyTaskPageSize(size)
    preferenceStore
      .updateAndSave({ taskPageSize: pageSize })
      .catch((e: unknown) => logger.error('TaskStore.setTaskPageSize', e))
  }

  watch(
    () => preferenceStore.config.taskPageSize,
    (size) => {
      applyTaskPageSize(size)
    },
  )

  async function fetchList() {
    try {
      // Stopped tab is DB-primary: history.db is the single source of truth.
      // Active tab reads from aria2 (tellActive + tellWaiting).
      // All tab merges: aria2 active + aria2 stopped (bridge) + history DB.
      const sortConfig = usePreferenceStore().config?.taskSort ?? DEFAULT_TASK_SORT
      let data: Aria2Task[]
      if (currentList.value === 'stopped') {
        const historyStore = useHistoryStore()
        const records = await historyStore.getRecords()
        const { field, direction } = sortConfig.stopped
        if (field === 'manual') {
          applyManualOrder(records, usePreferenceStore().config.taskManualOrder.stopped, (fresh) => {
            sortRecords(fresh, 'added-at', 'desc')
          })
        } else {
          sortRecords(records, field, direction)
        }
        data = records.map(historyRecordToTask)
      } else if (currentList.value === 'all') {
        const ALL_STOPPED_LIMIT = 128
        const ALL_HISTORY_LIMIT = 256
        const [activeTasks, stoppedTasks, historyRecords] = await Promise.all([
          api.fetchTaskList({ type: 'active' }),
          api.fetchTaskList({ type: 'stopped', limit: ALL_STOPPED_LIMIT }),
          useHistoryStore().getRecords(undefined, ALL_HISTORY_LIMIT),
        ])
        data = mergeHistoryIntoTasks([...activeTasks, ...stoppedTasks], historyRecords)
        data = data.filter((t) => !checkTaskIsEd2kSearch(t))
        // Filter stale metadata tasks (completed magnet resolution) but keep
        // actively-downloading metadata visible so users see the progress.
        const LIVE_TASK_STATUSES = new Set(['active', 'waiting', 'paused'])
        data = data.filter((t) => LIVE_TASK_STATUSES.has(t.status) || !isMetadataTask(t))

        // Load DB-persisted added_at FIRST so that trackFirstSeen does not
        // overwrite completed tasks' timestamps with Date.now().
        loadAddedAtFromRecords(historyRecords)

        // Inherit added_at from parent task for aria2 "followedBy" GIDs.
        // When a magnet resolves, aria2 auto-creates a new GID for the real
        // download. This GID never goes through addUri/addTorrent, so it has
        // no birth timestamp. Without inheritance it gets Date.now() from
        // trackFirstSeen and jumps to the top of the list.
        for (const t of data) {
          if (t.following && !getAddedAt(t.gid)) {
            const parentAt = getAddedAt(t.following)
            if (parentAt) registerAddedAt(t.gid, parentAt)
          }
        }
        trackFirstSeen(data)

        const addedAtIndex = buildSortableAddedAtMap(data, historyRecords)
        const { field, direction } = sortConfig.all
        if (field === 'manual') {
          applyManualOrder(data, usePreferenceStore().config.taskManualOrder.all, (fresh) => {
            sortTasks(fresh, 'added-at', 'desc', addedAtIndex)
          })
        } else {
          sortTasks(data, field, direction, addedAtIndex)
        }
      } else {
        // Active tab: aria2 returns insertion-order; apply user sort.
        data = await api.fetchTaskList({ type: currentList.value })
        data = data.filter((t) => !checkTaskIsEd2kSearch(t))
        trackFirstSeen(data)
        const addedAtIndex = buildSortableAddedAtMap(data, [])
        const { field, direction } = sortConfig.active
        if (field === 'manual') {
          applyManualOrder(data, usePreferenceStore().config.taskManualOrder.active, (fresh) => {
            sortTasks(fresh, 'added-at', 'desc', addedAtIndex)
          })
        } else {
          sortTasks(data, field, direction, addedAtIndex)
        }
      }

      taskList.value = data
      trackTaskElapsed(data)
      updateCurrentTaskTotal(data.length)
      clampCurrentTaskPage()
      refreshCurrentTaskPageCount()
      const gids = data.map((task: Aria2Task) => task.gid)
      selectedGidList.value = intersection(selectedGidList.value, gids)
      if (taskDetailVisible.value && currentTaskGid.value) {
        try {
          const fresh = await api.fetchTaskItemWithPeers({ gid: currentTaskGid.value })
          if (fresh) updateCurrentTaskItem(fresh)
        } catch (e) {
          logger.debug('TaskStore.fetchPeers', e)
          const fresh = data.find((t: Aria2Task) => t.gid === currentTaskGid.value)
          if (fresh) updateCurrentTaskItem(fresh)
        }
      }
    } catch (e) {
      logger.debug('TaskStore.fetchList', e instanceof Error ? e.message : String(e))
    }
  }

  function selectTasks(list: string[]) {
    selectedGidList.value = list
  }

  async function saveManualOrder(gids: string[]) {
    const preferenceStore = usePreferenceStore()
    const tab = currentTaskTab()
    const taskSort = {
      ...preferenceStore.config.taskSort,
      [tab]: {
        ...preferenceStore.config.taskSort[tab],
        field: 'manual',
      },
    }
    const taskManualOrder = {
      ...preferenceStore.config.taskManualOrder,
      [tab]: [...gids],
    }
    await preferenceStore.updateAndSave({ taskSort, taskManualOrder })
  }

  async function saveCurrentManualOrder() {
    await saveManualOrder(createManualOrderSnapshot(taskList.value))
  }

  async function saveVisiblePageManualOrder(visibleTasks: Aria2Task[]) {
    const tab = currentTaskTab()
    const start = (taskPagination[tab].page - 1) * taskPagination.pageSize
    const nextList = [...taskList.value]
    nextList.splice(start, visibleTasks.length, ...visibleTasks)
    taskList.value = nextList
    await saveManualOrder(createManualOrderSnapshot(nextList))
  }

  async function changeCurrentSort(field: ActiveSortField | StoppedSortField | AllSortField) {
    const preferenceStore = usePreferenceStore()
    const tab = currentTaskTab()
    const taskSort = preferenceStore.config?.taskSort ?? DEFAULT_TASK_SORT
    const current = taskSort[tab]
    const direction: SortDirection =
      field === 'manual' ? 'desc' : current.field === field ? (current.direction === 'desc' ? 'asc' : 'desc') : 'desc'
    const nextTaskSort = { ...taskSort, [tab]: { field, direction } }
    const nextConfig =
      field === 'manual'
        ? {
            taskSort: nextTaskSort,
            taskManualOrder: {
              ...preferenceStore.config.taskManualOrder,
              [tab]: createManualOrderSnapshot(taskList.value),
            },
          }
        : { taskSort: nextTaskSort }

    preferenceStore.updatePreference(nextConfig)
    taskListTransitionRevision.value += 1
    await fetchList()
    preferenceStore.updateAndSave(nextConfig).catch((e: unknown) => logger.error('TaskStore.changeCurrentSort', e))
  }

  function selectAllTask() {
    selectedGidList.value = taskList.value.map((task) => task.gid)
  }

  async function fetchItem(gid: string) {
    const data = await api.fetchTaskItem({ gid })
    updateCurrentTaskItem(data)
  }

  function showTaskDetail(task: Aria2Task) {
    updateCurrentTaskItem(task)
    currentTaskGid.value = task.gid
    taskDetailVisible.value = true
  }

  async function showTaskDetailByGid(gid: string) {
    const task = await api.fetchTaskItem({ gid })
    showTaskDetail(task)
  }

  function hideTaskDetail() {
    taskDetailVisible.value = false
  }

  function updateCurrentTaskItem(task: Aria2Task | null) {
    currentTaskItem.value = task
    if (task) {
      currentTaskFiles.value = task.files
      currentTaskPeers.value = task.peers || []
    } else {
      currentTaskFiles.value = []
      currentTaskPeers.value = []
    }
  }

  async function addUri(data: {
    uris: string[]
    outs: string[]
    options: Aria2EngineOptions
    fileCategory?: { enabled: boolean; categories: import('@shared/types').FileCategory[] }
  }) {
    const gids: string[] = []
    const httpAuthStore = useHttpAuthStore()

    for (let index = 0; index < data.uris.length; index++) {
      const uri = data.uris[index]
      const options = await applySavedHttpAuth(uri, data.options, httpAuthStore)
      const added = await api.addUri({
        uris: [uri],
        outs: [data.outs[index] ?? ''],
        options,
        fileCategory: data.fileCategory,
      })
      gids.push(...added)
    }

    const now = new Date().toISOString()
    const historyStore = useHistoryStore()
    for (const gid of gids) {
      registerAddedAt(gid, now)
      historyStore.recordTaskBirth(gid, now).catch((e) => logger.debug('taskBirth.write', e))
    }
    await fetchList()
  }

  async function addUriAtomic(data: { uris: string[]; options: Aria2EngineOptions }) {
    const httpAuthStore = useHttpAuthStore()
    const options = await applySavedHttpAuth(data.uris[0], data.options, httpAuthStore)
    const gid = await api.addUriAtomic({ uris: data.uris, options })
    const now = new Date().toISOString()
    const historyStore = useHistoryStore()
    registerAddedAt(gid, now)
    historyStore.recordTaskBirth(gid, now).catch((e) => logger.debug('taskBirth.write', e))
    await fetchList()
    return gid
  }

  async function applySavedHttpAuth(
    uri: string,
    options: Aria2EngineOptions,
    httpAuthStore: ReturnType<typeof useHttpAuthStore>,
  ): Promise<Aria2EngineOptions> {
    if (options['http-user'] || options.httpUser) return options

    const credential = await httpAuthStore.findByUrl(uri)
    if (!credential) return options

    if (credential.id) {
      httpAuthStore.markUsed(credential.id).catch((e) => logger.debug('httpAuth.markUsed', e))
    }
    return {
      ...options,
      'http-user': credential.username,
      'http-passwd': credential.password,
    }
  }

  /**
   * Adds a magnet URI as a normal download. Returns the metadata GID.
   *
   * The global `pause-metadata` setting (controlled by btAutoDownloadContent)
   * determines what happens after metadata resolves:
   * - pause-metadata=true  → followedBy content task stays paused until selection
   * - pause-metadata=false → follow-up download starts immediately (no selection)
   *
   * Directly registers the GID for monitoring to avoid caller-chain breaks.
   */
  async function addMagnetUri(data: { uri: string; options: Aria2EngineOptions }): Promise<string> {
    const { usePreferenceStore } = await import('@/stores/preference')
    const preferenceStore = usePreferenceStore()
    const pauseMetadataOption = data.options['pause-metadata']
    const pauseMetadata =
      typeof pauseMetadataOption === 'string' ? pauseMetadataOption : preferenceStore.config.pauseMetadata
    const showFileSelection = shouldShowFileSelection({ pauseMetadata })
    const options = showFileSelection
      ? { ...buildMetadataOnlyOptions(data.options), 'check-integrity': 'true', 'force-save': 'true' }
      : { ...data.options, 'pause-metadata': 'false', 'check-integrity': 'true', 'force-save': 'true' }

    const gids = await api.addUri({
      uris: [data.uri],
      outs: [],
      options,
    })
    const gid = gids[0]

    // Register birth timestamp
    const now = new Date().toISOString()
    registerAddedAt(gid, now)
    const historyStore = useHistoryStore()
    historyStore.recordTaskBirth(gid, now).catch((e) => logger.debug('taskBirth.write', e))

    // Only register for file selection polling when pause-metadata is enabled.
    // When btAutoDownloadContent=true (pauseMetadata=false), aria2 starts the
    // follow-up download immediately — file selection is not needed.
    if (showFileSelection) {
      const { useAppStore } = await import('@/stores/app')
      const appStore = useAppStore()
      appStore.pendingMagnetGids = [...appStore.pendingMagnetGids, gid]
    }

    await fetchList()
    return gid
  }

  /** Fetch a single task's full status (used for polling followedBy on magnet tasks). */
  async function fetchTaskStatus(gid: string): Promise<Aria2Task> {
    return api.fetchTaskItem({ gid })
  }

  /** Retrieves the file list for a download task. */
  async function getFiles(gid: string): Promise<Aria2File[]> {
    return api.getFiles({ gid })
  }

  async function addTorrent(data: { torrent: string; options: Aria2EngineOptions }) {
    const gid = await api.addTorrent(data)
    const now = new Date().toISOString()
    registerAddedAt(gid, now)
    const historyStore = useHistoryStore()
    historyStore.recordTaskBirth(gid, now).catch((e) => logger.debug('taskBirth.write', e))
    await fetchList()
    return gid
  }

  async function getTaskOption(gid: string) {
    return api.getOption({ gid })
  }

  async function changeTaskOption(payload: { gid: string; options: Aria2EngineOptions }) {
    return api.changeOption(payload)
  }

  // Task CRUD operations are delegated to the taskOperations module.
  // The ops object is populated when setApi() is called.
  const taskOps = {} as ReturnType<typeof createTaskOperations>

  async function batchResumeSelectedTasks() {
    const selected = new Set(selectedGidList.value)
    const gids = taskList.value
      .filter((task) => selected.has(task.gid) && task.status === TASK_STATUS.PAUSED)
      .map((task) => task.gid)
    if (gids.length === 0) return
    return api.batchResumeTask({ gids })
  }

  async function batchPauseSelectedTasks() {
    const selected = new Set(selectedGidList.value)
    const gids = taskList.value
      .filter((task) => {
        if (!selected.has(task.gid)) return false
        return task.status === TASK_STATUS.ACTIVE || task.status === TASK_STATUS.WAITING
      })
      .map((task) => task.gid)
    if (gids.length === 0) return
    return api.batchPauseTask({ gids })
  }

  function addToSharingList(gid: string) {
    if (sharingList.value.includes(gid)) return
    sharingList.value = [...sharingList.value, gid]
  }

  function removeFromSharingList(gid: string) {
    const idx = sharingList.value.indexOf(gid)
    if (idx === -1) return
    sharingList.value = [...sharingList.value.slice(0, idx), ...sharingList.value.slice(idx + 1)]
  }

  async function restartTask(task: Aria2Task) {
    const historyStore = useHistoryStore()
    await restartTaskImpl(task, { ...api, fetchList, saveSession: () => api.saveSession() }, historyStore)
  }

  return {
    currentList,
    taskDetailVisible,
    currentTaskGid,
    enabledFetchPeers,
    currentTaskItem,
    currentTaskFiles,
    currentTaskPeers,
    sharingList,
    taskList,
    selectedGidList,
    taskListTransitionRevision,
    taskPagination,
    currentTaskPageCount,
    setApi,
    changeCurrentList,
    fetchList,
    selectTasks,
    saveManualOrder,
    saveCurrentManualOrder,
    saveVisiblePageManualOrder,
    setTaskPage,
    setCurrentTaskPage,
    setTaskPageSize,
    clampCurrentTaskPage,
    changeCurrentSort,
    selectAllTask,
    fetchItem,
    showTaskDetail,
    showTaskDetailByGid,
    hideTaskDetail,
    updateCurrentTaskItem,
    addUri,
    addUriAtomic,
    addTorrent,
    addMagnetUri,
    getFiles,
    fetchTaskStatus,
    getTaskOption,
    changeTaskOption,
    removeTask: (task: Aria2Task) => taskOps.removeTask(task),
    cancelMagnetSelectionDownload: (target: { metadataGid: string; downloadGid: string }) =>
      taskOps.cancelMagnetSelectionDownload(target),
    pauseTask: (task: Aria2Task) => taskOps.pauseTask(task),
    resumeTask: (task: Aria2Task) => taskOps.resumeTask(task),
    pauseAllTask: () => taskOps.pauseAllTask(),
    resumeAllTask: () => taskOps.resumeAllTask(),
    toggleTask: (task: Aria2Task) => taskOps.toggleTask(task),
    addToSharingList,
    removeFromSharingList,
    stopSharing: (task: Aria2Task) => taskOps.stopSharing(task),
    stopAllSharing: () => taskOps.stopAllSharing(),
    removeTaskRecord: (task: Aria2Task) => taskOps.removeTaskRecord(task),
    purgeTaskRecord: () => taskOps.purgeTaskRecord(),
    saveSession: () => taskOps.saveSession(),
    batchResumeSelectedTasks,
    batchPauseSelectedTasks,
    batchRemoveTask: (gids: string[]) => taskOps.batchRemoveTask(gids),
    restartTask,

    registerTorrentSource,
    consumeTorrentSource,
    hasActiveTasks: () => taskOps.hasActiveTasks(),
    hasPausedTasks: () => taskOps.hasPausedTasks(),
  }
})
