/**
 * @fileoverview Extracted task CRUD operations from the Pinia task store.
 *
 * Contains task mutation and native batch-operation orchestration.
 *
 * Uses dependency injection — accepts API + store refs instead of importing
 * them directly, enabling testability and keeping the task store thin.
 */
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsBT, checkTaskIsSharing } from '@shared/utils'
import { logger } from '@shared/logger'
import { isAwaitingBtFileSelection } from '@/composables/useBtLifecycle'
import type { Aria2Task, TaskApi } from '@shared/types'
import type { Ref } from 'vue'

interface TaskOperationsDeps {
  api: TaskApi
  taskList: Ref<Aria2Task[]>
  currentTaskGid: Ref<string>
  hideTaskDetail: () => void
  fetchList: () => Promise<void>
  setTaskRemoving?: (gid: string, removing: boolean) => void
  requestMagnetSelection?: (gid: string) => void
  clearMagnetSelections?: (gids: string[]) => void | Promise<void>
}

export function createTaskOperations(deps: TaskOperationsDeps) {
  const { api, taskList, currentTaskGid, hideTaskDetail, fetchList } = deps
  const setTaskRemoving = deps.setTaskRemoving ?? (() => undefined)

  async function removeTask(task: Aria2Task) {
    if (task.gid === currentTaskGid.value) hideTaskDetail()
    setTaskRemoving(task.gid, true)
    try {
      await api.deleteTask({ gid: task.gid, infoHash: task.infoHash })
      await deps.clearMagnetSelections?.([task.gid])
      logger.info('TaskOps.removeTask', `gid=${task.gid}`)
      setTaskRemoving(task.gid, false)
      await fetchList()
      await api.saveSession()
    } catch (error) {
      setTaskRemoving(task.gid, false)
      await fetchList()
      throw error
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

  async function finishSharing(task: Aria2Task): Promise<void> {
    try {
      await api.finishSharing({ gid: task.gid })
      logger.info('TaskOps.finishSharing', `gid=${task.gid}`)
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function finishSharingTasks(gids: string[]) {
    try {
      const result = await api.batchFinishSharing({ gids })
      logger.info(
        'TaskOps.finishSharingTasks',
        `finished=${result.succeeded.length} failed=${result.failed.length} gids=[${gids.join(',')}]`,
      )
      return result
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function resumeTask(task: Aria2Task): Promise<boolean> {
    if (isAwaitingBtFileSelection(task)) {
      logger.info('TaskOps.resumeTask', `gid=${task.gid} blocked=file-selection-required`)
      deps.requestMagnetSelection?.(task.gid)
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

  async function applyMagnetFileSelection(task: Aria2Task, selectFile: string, targetDir?: string): Promise<void> {
    if (task.status !== TASK_STATUS.PAUSED && task.status !== TASK_STATUS.WAITING) {
      throw new Error(`Cannot apply magnet file selection while task is ${task.status}`)
    }

    try {
      await api.changeOption({
        gid: task.gid,
        options: {
          'select-file': selectFile,
          ...(targetDir ? { dir: targetDir } : {}),
        },
      })
      if (task.status === TASK_STATUS.PAUSED) {
        await api.resumeTask({ gid: task.gid })
      }
      logger.info(
        'TaskOps.applyMagnetFileSelection',
        `gid=${task.gid} status=${task.status} classified=${Boolean(targetDir)}`,
      )
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function pauseAllTask() {
    try {
      await api.forcePauseAll()
      logger.info('TaskOps.pauseAllTask', 'native forcePauseAll completed')
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  async function resumeAllTask(): Promise<{ resumed: number; blocked: number }> {
    try {
      const result = await api.resumeEligible()
      logger.info('TaskOps.resumeAllTask', `resumed=${result.resumed} blocked=${result.blocked}`)
      return result
    } finally {
      await fetchList()
      await api.saveSession()
    }
  }

  function toggleTask(task: Aria2Task) {
    const { status } = task
    if (status === TASK_STATUS.ACTIVE) return pauseTask(task)
    if (status === TASK_STATUS.WAITING) return pauseTask(task)
    if (status === TASK_STATUS.PAUSED) return resumeTask(task)
    logger.debug('TaskOps.toggleTask', `no-op gid=${task.gid} status=${status} sharing=${checkTaskIsSharing(task)}`)
  }

  async function removeTaskRecord(task: Aria2Task) {
    await removeTask(task)
  }

  async function purgeTaskRecord() {
    await api.purgeTaskRecords()
    await fetchList()
    await api.saveSession()
  }

  async function batchRemoveTask(gids: string[]) {
    const tasks = new Map(taskList.value.map((task) => [task.gid, task]))
    gids.forEach((gid) => setTaskRemoving(gid, true))
    try {
      const result = await api.batchDeleteTasks({
        tasks: gids.map((gid) => ({ gid, infoHash: tasks.get(gid)?.infoHash })),
      })
      await deps.clearMagnetSelections?.(result.succeeded)
      logger.info(
        'TaskOps.batchRemoveTask',
        `removed=${result.succeeded.length} failed=${result.failed.length} gids=[${gids.join(',')}]`,
      )
      return result
    } finally {
      gids.forEach((gid) => setTaskRemoving(gid, false))
      await fetchList()
      await api.saveSession()
    }
  }

  async function hasActiveTasks(): Promise<boolean> {
    try {
      const tasks = await api.fetchTaskList({ type: TASK_STATUS.ACTIVE })
      return tasks.some((t) => t.status === TASK_STATUS.ACTIVE || t.status === TASK_STATUS.WAITING)
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
    pauseTask,
    finishSharing,
    finishSharingTasks,
    resumeTask,
    applyMagnetFileSelection,
    pauseAllTask,
    resumeAllTask,
    toggleTask,
    removeTaskRecord,
    purgeTaskRecord,
    batchRemoveTask,
    hasActiveTasks,
    hasPausedTasks,
    saveSession,
  }
}
