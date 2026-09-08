/** @fileoverview Pinia store for download task management: list, add, pause, resume, remove. */
import { defineStore } from 'pinia'
import { reactive, ref, watch } from 'vue'
import { EMPTY_STRING } from '@shared/constants'
import { checkTaskIsEd2kSearch } from '@shared/utils'
import { logger } from '@shared/logger'
import type { Aria2Task, Aria2File, Aria2Peer, Aria2EngineOptions, TaskApi } from '@shared/types'

import { mergeHistoryIntoTasks, isMetadataTask } from '@/composables/useTaskLifecycle'
import { buildMagnetOptions } from '@/composables/useMagnetFlow'
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
  type ProgressSortField,
  type AllSortField,
  type SortDirection,
  type TaskScope,
  type TerminalSortField,
} from '@/composables/useTaskSort'
import { DEFAULT_TASK_SORT } from '@/composables/useTaskSort'
import { useHistoryStore } from '@/stores/history'
import { useDatabaseStore } from '@/stores/database'
import { useHttpAuthStore } from '@/stores/httpAuth'
import { usePreferenceStore } from '@/stores/preference'

import { resubmitTask, type TaskResubmissionMode } from './resubmit'
import { createTaskOperations } from './operations'

export type { Aria2Task, Aria2File, Aria2Peer }

const DEFAULT_TASK_PAGE_SIZE = 20
const TASK_SCOPES: readonly TaskScope[] = ['all', 'progress', 'failed', 'completed']

function isLiveTask(task: Aria2Task): boolean {
  return task.status === 'active' || task.status === 'waiting' || task.status === 'paused'
}

function normalizeTaskScope(list: string): TaskScope {
  return TASK_SCOPES.includes(list as TaskScope) ? (list as TaskScope) : 'all'
}

export interface TaskCounts {
  all: number
  progress: number
  failed: number
  completed: number
}

export const useTaskStore = defineStore('task', () => {
  const preferenceStore = usePreferenceStore()
  const currentList = ref<TaskScope>('all')
  const taskDetailVisible = ref(false)
  const currentTaskGid = ref(EMPTY_STRING)
  const enabledFetchPeers = ref(false)
  const currentTaskItem = ref<Aria2Task | null>(null)
  const currentTaskFiles = ref<Aria2File[]>([])
  const currentTaskPeers = ref<Aria2Peer[]>([])
  const taskList = ref<Aria2Task[]>([])
  const removingGids = ref<string[]>([])
  const resubmittingGids = ref<string[]>([])
  const taskCounts = reactive<TaskCounts>({ all: 0, progress: 0, failed: 0, completed: 0 })
  const taskPagination = reactive({
    all: { page: 1, total: 0, loaded: false },
    progress: { page: 1, total: 0, loaded: false },
    failed: { page: 1, total: 0, loaded: false },
    completed: { page: 1, total: 0, loaded: false },
    pageSize: clampPageSize(preferenceStore.config.taskPageSize),
  })
  const visibleTaskPageCount = ref(1)

  let api: TaskApi
  let apiReady = false
  let listRequestId = 0
  const resubmissionPromises = new Map<string, Promise<void>>()
  const cardKeys = reactive(new Map<string, string>())
  function taskCardKey(gid: string): string {
    const key = cardKeys.get(gid)
    // A failed old-record cleanup must never create duplicate Vue keys.
    return key && !taskList.value.some((task) => task.gid === key) ? key : gid
  }

  /** In-memory map: GID → original .torrent file path for post-download cleanup. */
  const torrentSourcePaths = new Map<string, string>()
  const registerTorrentSource = (gid: string, path: string) => torrentSourcePaths.set(gid, path)
  function consumeTorrentSource(gid: string): string | undefined {
    const p = torrentSourcePaths.get(gid)
    if (p) torrentSourcePaths.delete(gid)
    return p
  }

  function setApi(a: TaskApi) {
    api = a
    apiReady = true
    // Wire up task operations once API is available
    const ops = createTaskOperations({
      api,
      taskList,
      currentTaskGid,
      hideTaskDetail,
      fetchList,
      setTaskRemoving,
      requestMagnetSelection: (gid) => {
        void import('@/stores/app').then(({ useAppStore }) => useAppStore().requestMagnetSelection(gid))
      },
      clearMagnetSelections: (gids) => {
        return import('@/stores/app').then(({ useAppStore }) => useAppStore().clearMagnetSelections(gids))
      },
    })
    Object.assign(taskOps, ops)
  }

  async function changeCurrentList(list: string) {
    const scope = normalizeTaskScope(list)
    const sameList = currentList.value === scope
    currentList.value = scope
    if (!sameList) {
      const tab = currentTaskTab()
      if (taskPagination[tab].loaded) refreshCurrentTaskPageCount()
    }
    await fetchList()
  }

  function currentTaskTab(): TaskScope {
    return currentList.value
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

  function refreshCurrentTaskPageCount(tab = currentTaskTab()) {
    visibleTaskPageCount.value = maxTaskPage(tab)
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

  function setTaskPage(tab: TaskScope, page: number) {
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
    // A resubmission is one replacement, not separate add/remove UI updates.
    if (!apiReady || resubmittingGids.value.length > 0) return
    const requestId = ++listRequestId
    try {
      const scope = currentTaskTab()
      const engineTasks = await api.fetchTaskList({ type: 'all' })
      // Read history after the engine snapshot: stopping sharing writes history
      // before removing its engine task.
      const historyRecords = useDatabaseStore().isReady ? await useHistoryStore().getRecords() : []
      if (requestId !== listRequestId || currentTaskTab() !== scope) return
      const removing = new Set(removingGids.value)
      const tasks = mergeHistoryIntoTasks(
        engineTasks.filter((task) => task.status !== 'removed'),
        historyRecords,
      ).filter(
        (task) =>
          !removing.has(task.gid) && !checkTaskIsEd2kSearch(task) && (isLiveTask(task) || !isMetadataTask(task)),
      )

      Object.assign(taskCounts, {
        all: tasks.length,
        progress: tasks.filter(isLiveTask).length,
        completed: tasks.filter((task) => task.status === 'complete').length,
        failed: tasks.filter((task) => task.status === 'error').length,
      })
      const data = tasks.filter(
        (task) =>
          scope === 'all' ||
          (scope === 'progress' ? isLiveTask(task) : task.status === (scope === 'failed' ? 'error' : 'complete')),
      )
      loadAddedAtFromRecords(historyRecords)
      trackFirstSeen(data)
      const addedAtIndex = buildSortableAddedAtMap(data, historyRecords)
      const completedAtIndex = new Map(historyRecords.map((record) => [record.gid, record.completed_at ?? '']))
      const { field, direction } = preferenceStore.config.taskSort?.[scope] ?? DEFAULT_TASK_SORT[scope]
      if (field === 'manual') {
        applyManualOrder(data, preferenceStore.config.taskManualOrder[scope], (fresh) => {
          sortTasks(fresh, 'added-at', 'desc', addedAtIndex)
        })
      } else {
        sortTasks(data, field, direction, addedAtIndex, completedAtIndex)
      }
      taskList.value = data
      updateCurrentTaskTotal(data.length)
      clampCurrentTaskPage()
      refreshCurrentTaskPageCount()
      const visibleGids = new Set(tasks.map((task) => task.gid))
      for (const gid of cardKeys.keys()) {
        if (!visibleGids.has(gid)) cardKeys.delete(gid)
      }
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

  function setTaskRemoving(gid: string, removing: boolean) {
    if (removing) {
      if (!removingGids.value.includes(gid)) removingGids.value = [...removingGids.value, gid]
      taskList.value = taskList.value.filter((task) => task.gid !== gid)
      updateCurrentTaskTotal(taskList.value.length)
      clampCurrentTaskPage()
      refreshCurrentTaskPageCount()
      return
    }
    removingGids.value = removingGids.value.filter((candidate) => candidate !== gid)
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

  async function changeCurrentSort(field: ProgressSortField | TerminalSortField | AllSortField) {
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
    await fetchList()
    preferenceStore.updateAndSave(nextConfig).catch((e: unknown) => logger.error('TaskStore.changeCurrentSort', e))
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
    fileCategory?: {
      enabled: boolean
      categories: import('@shared/types').FileCategory[]
      contexts?: Record<string, import('@shared/types').ExternalDownloadContext>
    }
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
    const options = await applySavedHttpAuth(data.uris[0] ?? '', data.options, httpAuthStore)
    const gid = await api.addUriAtomic({ uris: data.uris, options })
    const now = new Date().toISOString()
    registerAddedAt(gid, now)
    const historyStore = useHistoryStore()
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
   * Adds a magnet URI as a normal download. The returned GID owns the complete
   * metadata, file-selection, download, and seeding lifecycle.
   *
   * aria2 either continues with every file or pauses for selection according
   * to the application-owned magnet selection policy.
   */
  async function addMagnetUri(data: {
    uri: string
    options: Aria2EngineOptions
    fileCategory?: { enabled: boolean; categories: import('@shared/types').FileCategory[] }
  }): Promise<string> {
    const policy = preferenceStore.config.magnetFileSelectionPolicy
    const classifyFiles = Boolean(data.fileCategory?.enabled && data.fileCategory.categories.length > 0)
    const options = {
      ...buildMagnetOptions(data.options, policy, classifyFiles),
      'check-integrity': 'true',
      'force-save': 'true',
    }

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

    if (policy !== 'download-all' || classifyFiles) {
      const { useAppStore } = await import('@/stores/app')
      useAppStore().queueMagnetSelection(gid, policy === 'prompt')
    }

    await fetchList()
    return gid
  }

  /** Fetch a single task's full status. */
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

  function resubmitTerminalTask(task: Aria2Task, mode: TaskResubmissionMode): Promise<void> {
    const existing = resubmissionPromises.get(task.gid)
    if (existing) return existing

    const historyStore = useHistoryStore()
    const policy = preferenceStore.config.magnetFileSelectionPolicy
    resubmittingGids.value = [...resubmittingGids.value, task.gid]
    listRequestId += 1
    const operation = resubmitTask(task, mode, api, historyStore, policy, async (gid) => {
      const { useAppStore } = await import('@/stores/app')
      useAppStore().queueMagnetSelection(gid, policy === 'prompt')
    })
      .then(async (gids) => {
        const replacement = gids[0]
        if (!replacement) return
        cardKeys.set(replacement, taskCardKey(task.gid))
        const addedAt = getAddedAt(task.gid) ?? new Date().toISOString()
        registerAddedAt(replacement, addedAt)
        historyStore.recordTaskBirth(replacement, addedAt).catch((error) => logger.warn('taskBirth.replace', error))
        const order = preferenceStore.config.taskManualOrder
        if (!TASK_SCOPES.some((scope) => order[scope].includes(task.gid))) return
        await preferenceStore
          .updateAndSave({
            taskManualOrder: {
              all: order.all.map((gid) => (gid === task.gid ? replacement : gid)),
              progress: order.progress.map((gid) => (gid === task.gid ? replacement : gid)),
              failed: order.failed.map((gid) => (gid === task.gid ? replacement : gid)),
              completed: order.completed.map((gid) => (gid === task.gid ? replacement : gid)),
            },
          })
          .catch((error) => logger.warn('TaskStore.replaceManualOrder', error))
      })
      .then(async () => {
        await api.saveSession()
      })
      .finally(async () => {
        resubmissionPromises.delete(task.gid)
        resubmittingGids.value = resubmittingGids.value.filter((gid) => gid !== task.gid)
        await fetchList()
      })
    resubmissionPromises.set(task.gid, operation)
    return operation
  }

  return {
    taskCardKey,
    currentList,
    taskCounts,
    taskDetailVisible,
    currentTaskGid,
    enabledFetchPeers,
    currentTaskItem,
    currentTaskFiles,
    currentTaskPeers,
    taskList,
    removingGids,
    resubmittingGids,
    taskPagination,
    currentTaskPageCount,
    setApi,
    changeCurrentList,
    fetchList,
    saveManualOrder,
    saveCurrentManualOrder,
    saveVisiblePageManualOrder,
    setTaskPage,
    setCurrentTaskPage,
    setTaskPageSize,
    clampCurrentTaskPage,
    changeCurrentSort,
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
    pauseTask: (task: Aria2Task) => taskOps.pauseTask(task),
    finishSharing: (task: Aria2Task) => taskOps.finishSharing(task),
    finishSharingTasks: (gids: string[]) => taskOps.finishSharingTasks(gids),
    resumeTask: (task: Aria2Task) => taskOps.resumeTask(task),
    applyMagnetFileSelection: (task: Aria2Task, selectFile: string, targetDir?: string) =>
      taskOps.applyMagnetFileSelection(task, selectFile, targetDir),
    pauseAllTask: () => taskOps.pauseAllTask(),
    resumeAllTask: () => taskOps.resumeAllTask(),
    toggleTask: (task: Aria2Task) => taskOps.toggleTask(task),
    removeTaskRecord: (task: Aria2Task) => taskOps.removeTaskRecord(task),
    purgeTaskRecord: () => taskOps.purgeTaskRecord(),
    saveSession: () => taskOps.saveSession(),
    batchRemoveTask: (gids: string[]) => taskOps.batchRemoveTask(gids),
    retryTask: (task: Aria2Task) => resubmitTerminalTask(task, 'retry'),
    redownloadTask: (task: Aria2Task) => resubmitTerminalTask(task, 'redownload'),

    registerTorrentSource,
    consumeTorrentSource,
    hasActiveTasks: () => taskOps.hasActiveTasks(),
    hasPausedTasks: () => taskOps.hasPausedTasks(),
  }
})
