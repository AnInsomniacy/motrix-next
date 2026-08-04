/**
 * @fileoverview Extracted task CRUD operations from the Pinia task store.
 *
 * Contains: removeTask, pauseTask, resumeTask, pauseAllTask, resumeAllTask,
 * toggleTask, stopSharing, stopAllSharing, removeTaskRecord, purgeTaskRecord,
 * batchRemoveTask.
 *
 * Uses dependency injection — accepts API + store refs instead of importing
 * them directly, enabling testability and keeping the task store thin.
 */
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsBT, checkTaskIsSharing, getTaskSharingKind } from '@shared/utils'
import { logger } from '@shared/logger'
import { buildSharingCompletionRecord } from '@/composables/useTaskLifecycle'
import { cleanupAria2ControlFiles, deleteTaskFiles } from '@/composables/useFileDelete'
import { cleanupAria2MetadataFiles } from '@/composables/useDownloadCleanup'
import { useHistoryStore } from '@/stores/history'
import type { Aria2Task, TaskApi } from '@shared/types'
import type { Ref } from 'vue'

const REMOVE_RESULT_RETRY_ATTEMPTS = 5
const REMOVE_RESULT_RETRY_DELAY_MS = 120

export interface MagnetSelectionCleanupTarget {
  metadataGid: string
  downloadGid: string
}

interface TaskOperationsDeps {
  api: TaskApi
  taskList: Ref<Aria2Task[]>
  currentTaskGid: Ref<string>
  hideTaskDetail: () => void
  fetchList: () => Promise<void>
  removeResultRetryDelayMs?: number
}

export function createTaskOperations(deps: TaskOperationsDeps) {
  const { api, taskList, currentTaskGid, hideTaskDetail, fetchList } = deps
  const removeResultRetryDelayMs = deps.removeResultRetryDelayMs ?? REMOVE_RESULT_RETRY_DELAY_MS

  function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function requiresMagnetFileSelection(task: Aria2Task): Promise<boolean> {
    if (task.status !== TASK_STATUS.PAUSED) return false
    if (!task.following || !task.bittorrent) return false
    if (!task.files.some((file) => Number(file.length) > 0)) return false

    try {
      const options = await api.getOption({ gid: task.gid })
      return !options.selectFile?.trim()
    } catch (e) {
      logger.warn('TaskOps.resumeTask', `getOption gid=${task.gid} failed; keeping file selection pause: ${e}`)
      return true
    }
  }

  async function resumeTasks(tasks: Aria2Task[]): Promise<{ resumed: number; blocked: number }> {
    const checks = await Promise.all(
      tasks.map(async (task) => ({ task, blocked: await requiresMagnetFileSelection(task) })),
    )
    const resumableGids = checks.filter(({ blocked }) => !blocked).map(({ task }) => task.gid)
    const blocked = checks.length - resumableGids.length

    if (resumableGids.length > 0) {
      await api.batchResumeTask({ gids: resumableGids })
    }
    return { resumed: resumableGids.length, blocked }
  }

  async function removeTaskRecordWithRetry(gid: string, scope: string): Promise<boolean> {
    for (let attempt = 1; attempt <= REMOVE_RESULT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await api.removeTaskRecord({ gid })
        return true
      } catch (e) {
        if (attempt === REMOVE_RESULT_RETRY_ATTEMPTS) {
          logger.debug(scope, `removeTaskRecord gid=${gid} skipped after ${attempt} attempts: ${e}`)
          return false
        }
        await sleep(removeResultRetryDelayMs)
      }
    }
    return false
  }

  async function removeHistoryRecordForDeletedTask(task: Aria2Task): Promise<void> {
    const historyStore = useHistoryStore()
    if (task.infoHash) {
      try {
        await historyStore.removeByInfoHash(task.infoHash)
      } catch (e) {
        logger.debug('TaskOps.removeTask', `removeByInfoHash infoHash=${task.infoHash} skipped: ${e}`)
      }
    }
    try {
      await historyStore.removeRecord(task.gid)
    } catch (e) {
      logger.debug('TaskOps.removeTask', `removeHistory gid=${task.gid} skipped: ${e}`)
    }
  }

  async function removeHistoryRecordsByGid(gids: string[], scope: string): Promise<void> {
    if (gids.length === 0) return
    const historyStore = useHistoryStore()
    for (const gid of gids) {
      try {
        await historyStore.removeRecord(gid)
      } catch (e) {
        logger.debug(scope, `removeHistory gid=${gid} skipped: ${e}`)
      }
    }
  }

  async function removeTask(task: Aria2Task) {
    if (task.gid === currentTaskGid.value) hideTaskDetail()
    try {
      await api.removeTask({ gid: task.gid })
      // Purge from aria2's stopped-result list so it is not saved again.
      try {
        await api.removeTaskRecord({ gid: task.gid })
      } catch (e) {
        logger.debug('TaskOps.removeTask', `removeTaskRecord gid=${task.gid} skipped: ${e}`)
      }
      logger.info('TaskOps.removeTask', `gid=${task.gid}`)
    } finally {
      await removeHistoryRecordForDeletedTask(task)
      await fetchList()
      await api.saveSession()
    }
  }

  async function fetchTaskForCleanup(gid: string): Promise<Aria2Task | null> {
    try {
      return await api.fetchTaskItem({ gid })
    } catch (e) {
      logger.debug('TaskOps.cancelMagnetSelection', `fetchTaskItem gid=${gid} skipped: ${e}`)
      return null
    }
  }

  async function cleanupMagnetSelectionFiles(task: Aria2Task): Promise<void> {
    try {
      await cleanupAria2ControlFiles(task)
    } catch (e) {
      logger.debug('TaskOps.cancelMagnetSelection', `cleanupControlFile gid=${task.gid} skipped: ${e}`)
    }

    try {
      await deleteTaskFiles(task, 'trash', taskList.value)
    } catch (e) {
      logger.debug('TaskOps.cancelMagnetSelection', `deleteTaskFiles gid=${task.gid} skipped: ${e}`)
    }

    if (task.dir && task.infoHash) {
      try {
        await cleanupAria2MetadataFiles(task.dir, task.infoHash)
      } catch (e) {
        logger.debug('TaskOps.cancelMagnetSelection', `cleanupMetadata gid=${task.gid} skipped: ${e}`)
      }
    }
  }

  async function cancelMagnetSelectionDownload(target: MagnetSelectionCleanupTarget) {
    const { downloadGid, metadataGid } = target
    if (downloadGid === currentTaskGid.value) hideTaskDetail()

    try {
      const task = await fetchTaskForCleanup(downloadGid)

      try {
        await api.removeTask({ gid: downloadGid })
      } catch (e) {
        logger.debug('TaskOps.cancelMagnetSelection', `removeTask gid=${downloadGid} skipped: ${e}`)
      }

      const resultGids = new Set<string>([downloadGid])
      if (metadataGid) resultGids.add(metadataGid)
      if (task?.following) resultGids.add(task.following)

      for (const gid of resultGids) {
        await removeTaskRecordWithRetry(gid, 'TaskOps.cancelMagnetSelection')
      }

      const historyStore = useHistoryStore()
      for (const gid of resultGids) {
        try {
          await historyStore.removeRecord(gid)
        } catch (e) {
          logger.debug('TaskOps.cancelMagnetSelection', `removeHistory gid=${gid} skipped: ${e}`)
        }
      }
      try {
        await historyStore.removeBirthRecords([...resultGids])
      } catch (e) {
        logger.debug('TaskOps.cancelMagnetSelection', `removeBirthRecords skipped: ${e}`)
      }

      if (task) await cleanupMagnetSelectionFiles(task)

      logger.info(
        'TaskOps.cancelMagnetSelection',
        `downloadGid=${downloadGid} metadataGid=${metadataGid || task?.following || 'n/a'}`,
      )
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function pauseTask(task: Aria2Task) {
    const isBT = checkTaskIsBT(task)
    const promise = isBT ? api.forcePauseTask({ gid: task.gid }) : api.pauseTask({ gid: task.gid })
    try {
      await promise
      logger.info('TaskOps.pauseTask', `gid=${task.gid} bt=${isBT}`)
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function resumeTask(task: Aria2Task): Promise<boolean> {
    if (await requiresMagnetFileSelection(task)) {
      logger.info('TaskOps.resumeTask', `gid=${task.gid} blocked=file-selection-required`)
      return false
    }

    try {
      await api.resumeTask({ gid: task.gid })
      logger.info('TaskOps.resumeTask', `gid=${task.gid}`)
      return true
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function applyMagnetFileSelection(task: Aria2Task, selectFile: string): Promise<void> {
    if (task.status !== TASK_STATUS.PAUSED && task.status !== TASK_STATUS.WAITING) {
      throw new Error(`Cannot apply magnet file selection while task is ${task.status}`)
    }

    try {
      await api.changeOption({ gid: task.gid, options: { 'select-file': selectFile } })
      if (task.status === TASK_STATUS.PAUSED) {
        await api.resumeTask({ gid: task.gid })
      }
      logger.info('TaskOps.applyMagnetFileSelection', `gid=${task.gid} status=${task.status}`)
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function pauseAllTask() {
    try {
      const pausableTasks = taskList.value.filter(
        (t) => (t.status === TASK_STATUS.ACTIVE || t.status === TASK_STATUS.WAITING) && !checkTaskIsSharing(t),
      )
      if (pausableTasks.length > 0) {
        await Promise.allSettled(pausableTasks.map((t) => api.forcePauseTask({ gid: t.gid })))
      }
      logger.info(
        'TaskOps.pauseAllTask',
        `paused=${pausableTasks.length} gids=[${pausableTasks.map((t) => t.gid).join(',')}]`,
      )
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function resumeAllTask(): Promise<{ resumed: number; blocked: number }> {
    try {
      const pausedTasks = taskList.value.filter((task) => task.status === TASK_STATUS.PAUSED)
      const result = await resumeTasks(pausedTasks)
      logger.info('TaskOps.resumeAllTask', `resumed=${result.resumed} blocked=${result.blocked}`)
      return result
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  function toggleTask(task: Aria2Task) {
    const { status } = task
    if (status === TASK_STATUS.ACTIVE && !checkTaskIsSharing(task)) return pauseTask(task)
    if (status === TASK_STATUS.WAITING) return pauseTask(task)
    if (status === TASK_STATUS.PAUSED) return resumeTask(task)
    logger.debug('TaskOps.toggleTask', `no-op gid=${task.gid} status=${status} sharing=${checkTaskIsSharing(task)}`)
  }

  async function stopSharing(task: Aria2Task) {
    const { gid } = task
    const protocolKind = getTaskSharingKind(task) ?? (task.bittorrent ? 'bt' : task.ed2k ? 'ed2k' : null)
    try {
      await api.forcePauseTask({ gid })
      await api.removeTask({ gid })
      // Purge from aria2's stopped list so it is not restored on restart.
      try {
        await api.removeTaskRecord({ gid })
      } catch (e) {
        logger.debug('TaskOps.stopSharing', `removeTaskRecord gid=${gid} skipped: ${e}`)
      }
      if (protocolKind === 'bt' && task.following) {
        try {
          await api.removeTaskRecord({ gid: task.following })
        } catch (e) {
          logger.debug('TaskOps.stopSharing', `removeTaskRecord following=${task.following} skipped: ${e}`)
        }
      }
      const record = buildSharingCompletionRecord(task)
      const historyStore = useHistoryStore()
      if (protocolKind === 'bt' && task.infoHash) {
        await historyStore.removeByInfoHash(task.infoHash, task.gid)
      }
      await historyStore.addRecord(record)
      if (protocolKind === 'bt' || protocolKind === 'ed2k') {
        try {
          await cleanupAria2ControlFiles(task)
        } catch (e) {
          logger.debug('TaskOps.stopSharing', `cleanupControlFiles gid=${gid} skipped: ${e}`)
        }
      }
      if (protocolKind === 'bt') {
        if (task.dir && task.infoHash) {
          try {
            await cleanupAria2MetadataFiles(task.dir, task.infoHash)
          } catch (e) {
            logger.debug('TaskOps.stopSharing', `cleanupMetadata gid=${gid} skipped: ${e}`)
          }
        }
      }
      logger.info('TaskOps.stopSharing', `gid=${gid} kind=${protocolKind ?? 'unknown'}`)
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function stopAllSharing(): Promise<number> {
    const sharingTasks = taskList.value.filter(checkTaskIsSharing)
    if (sharingTasks.length === 0) return 0
    await Promise.allSettled(sharingTasks.map((t) => stopSharing(t)))
    logger.info('TaskOps.stopAllSharing', `stopped ${sharingTasks.length} sharing task(s)`)
    return sharingTasks.length
  }

  async function removeTaskRecord(task: Aria2Task) {
    const { gid, status } = task
    if (gid === currentTaskGid.value) hideTaskDetail()
    const { ERROR, COMPLETE, REMOVED } = TASK_STATUS
    if ([ERROR, COMPLETE, REMOVED].indexOf(status) === -1) return
    const historyStore = useHistoryStore()
    await historyStore.removeRecord(gid)
    try {
      await api.removeTaskRecord({ gid })
    } catch (e) {
      logger.debug('TaskStore.removeTaskRecord.aria2', e)
    }
    await fetchList()
    await api.saveSession()
  }

  async function purgeTaskRecord() {
    const historyStore = useHistoryStore()
    await historyStore.clearRecords()
    try {
      await api.purgeTaskRecord()
    } catch (e) {
      logger.debug('TaskStore.purgeTaskRecord.aria2', e)
    }
    await fetchList()
    await api.saveSession()
  }

  async function batchRemoveTask(gids: string[]) {
    try {
      await api.batchRemoveTask({ gids })
      // Purge each gid from aria2's stopped-result list so it is not saved again.
      for (const gid of gids) {
        try {
          await api.removeTaskRecord({ gid })
        } catch (e) {
          logger.debug('TaskOps.batchRemoveTask', `removeTaskRecord gid=${gid} skipped: ${e}`)
        }
      }
      logger.info('TaskOps.batchRemoveTask', `removed ${gids.length} task(s) gids=[${gids.join(',')}]`)
    } finally {
      await removeHistoryRecordsByGid(gids, 'TaskOps.batchRemoveTask')
      await fetchList()
      await api.saveSession()
    }
  }

  async function hasActiveTasks(): Promise<boolean> {
    try {
      const tasks = await api.fetchTaskList({ type: TASK_STATUS.ACTIVE })
      return tasks.some(
        (t) => (t.status === TASK_STATUS.ACTIVE && !checkTaskIsSharing(t)) || t.status === TASK_STATUS.WAITING,
      )
    } catch (e) {
      logger.debug('TaskOps.hasActiveTasks', `fetchTaskList failed: ${e}`)
      return false
    }
  }

  async function hasPausedTasks(): Promise<boolean> {
    try {
      const tasks = await api.fetchTaskList({ type: TASK_STATUS.ACTIVE })
      return tasks.some((t) => t.status === TASK_STATUS.PAUSED)
    } catch (e) {
      logger.debug('TaskOps.hasPausedTasks', `fetchTaskList failed: ${e}`)
      return false
    }
  }

  async function saveSession() {
    await api.saveSession()
  }

  return {
    removeTask,
    cancelMagnetSelectionDownload,
    pauseTask,
    resumeTask,
    applyMagnetFileSelection,
    resumeTasks,
    pauseAllTask,
    resumeAllTask,
    toggleTask,
    stopSharing,
    stopAllSharing,
    removeTaskRecord,
    purgeTaskRecord,
    batchRemoveTask,
    hasActiveTasks,
    hasPausedTasks,
    saveSession,
  }
}
