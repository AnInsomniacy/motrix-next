/**
 * @fileoverview Extracted task CRUD operations from the Pinia task store.
 *
 * Contains: removeTask, pauseTask, resumeTask, pauseAllTask, resumeAllTask,
 * toggleTask, stopSeeding, stopAllSeeding, removeTaskRecord, purgeTaskRecord,
 * batchRemoveTask.
 *
 * Uses dependency injection — accepts API + store refs instead of importing
 * them directly, enabling testability and keeping the task store thin.
 */
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsBT, checkTaskIsSeeder } from '@shared/utils'
import { logger } from '@shared/logger'
import { buildBtCompletionRecord } from '@/composables/useTaskLifecycle'
import { useHistoryStore } from '@/stores/history'
import type { Aria2Task, TaskApi } from '@shared/types'
import type { Ref } from 'vue'

interface TaskOperationsDeps {
  api: TaskApi
  taskList: Ref<Aria2Task[]>
  currentTaskGid: Ref<string>
  hideTaskDetail: () => void
  fetchList: () => Promise<void>
}

export function createTaskOperations(deps: TaskOperationsDeps) {
  const { api, taskList, currentTaskGid, hideTaskDetail, fetchList } = deps

  async function removeTask(task: Aria2Task) {
    if (task.gid === currentTaskGid.value) hideTaskDetail()
    try {
      await api.removeTask({ gid: task.gid })
      // Purge from aria2's stopped-result list so force-save=true (BT/magnet)
      // won't persist the entry in the session file on exit.
      try {
        await api.removeTaskRecord({ gid: task.gid })
      } catch {
        /* best-effort: task may already be gone */
      }
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
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function resumeTask(task: Aria2Task) {
    try {
      await api.resumeTask({ gid: task.gid })
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function pauseAllTask() {
    try {
      await api.forcePauseAllTask()
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function resumeAllTask() {
    try {
      await api.resumeAllTask()
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  function toggleTask(task: Aria2Task) {
    const { status } = task
    if (status === TASK_STATUS.ACTIVE) return pauseTask(task)
    if (status === TASK_STATUS.WAITING || status === TASK_STATUS.PAUSED) return resumeTask(task)
  }

  async function stopSeeding(task: Aria2Task) {
    const { gid } = task
    try {
      await api.forcePauseTask({ gid })
      await api.removeTask({ gid })
      // Purge from aria2's stopped list so force-save=true won't persist it
      // in the session file. Without this, the stopped BT task reloads on
      // restart and enters seeding again (bt-seed-unverified=true).
      try {
        await api.removeTaskRecord({ gid })
      } catch {
        /* best-effort: task may already be gone */
      }
      // Also purge the parent metadata task from aria2's stopped list.
      // For magnet links, the metadata resolution task (GID-A) stays in
      // tellStopped with followedBy=[this GID] and the same infoHash.
      // If not cleaned up, its infoHash poisons mergeHistoryIntoTasks
      // dedup, causing the download task's history record to be discarded.
      if (task.following) {
        try {
          await api.removeTaskRecord({ gid: task.following })
        } catch {
          /* best-effort: metadata task may already be purged */
        }
      }
      const record = buildBtCompletionRecord(task)
      const historyStore = useHistoryStore()
      // Clean up stale DB records from previous sessions (different GID, same infoHash)
      if (task.infoHash) {
        await historyStore.removeByInfoHash(task.infoHash, task.gid)
      }
      await historyStore.addRecord(record)
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function stopAllSeeding(): Promise<number> {
    const seeders = taskList.value.filter(checkTaskIsSeeder)
    if (seeders.length === 0) return 0
    await Promise.allSettled(seeders.map((t) => stopSeeding(t)))
    return seeders.length
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
      // Purge each gid from aria2's stopped-result list so force-save=true
      // (BT/magnet) won't persist entries in the session file on exit.
      for (const gid of gids) {
        try {
          await api.removeTaskRecord({ gid })
        } catch {
          /* best-effort: task may already be gone */
        }
      }
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function hasActiveTasks(): Promise<boolean> {
    try {
      const tasks = await api.fetchTaskList({ type: TASK_STATUS.ACTIVE })
      return tasks.some((t) => t.status === TASK_STATUS.ACTIVE || t.status === TASK_STATUS.WAITING)
    } catch {
      return false
    }
  }

  async function hasPausedTasks(): Promise<boolean> {
    try {
      const tasks = await api.fetchTaskList({ type: TASK_STATUS.ACTIVE })
      return tasks.some((t) => t.status === TASK_STATUS.PAUSED)
    } catch {
      return false
    }
  }

  async function saveSession() {
    await api.saveSession()
  }

  return {
    removeTask,
    pauseTask,
    resumeTask,
    pauseAllTask,
    resumeAllTask,
    toggleTask,
    stopSeeding,
    stopAllSeeding,
    removeTaskRecord,
    purgeTaskRecord,
    batchRemoveTask,
    hasActiveTasks,
    hasPausedTasks,
    saveSession,
  }
}
