/**
 * @fileoverview Composable for task action handler functions.
 *
 * Extracted from TaskView.vue to reduce component script size.
 * Uses dependency injection for all Vue/Pinia dependencies — stores,
 * i18n, dialog, and message are passed in via the options object.
 */
import { ref, type Ref, h } from 'vue'
import { getTaskUri, getTaskDisplayName, resolveOpenTarget, canRestart } from '@shared/utils'
import { revealItemInDir, openPath } from '@tauri-apps/plugin-opener'
import { exists, stat } from '@tauri-apps/plugin-fs'
import { deleteTaskFiles } from '@/composables/useFileDelete'
import { TASK_STATUS } from '@shared/constants'
import { logger } from '@shared/logger'
import { NCheckbox, useDialog } from 'naive-ui'
import type { Aria2Task, AppConfig } from '@shared/types'

interface TaskActionsDeps {
  taskStore: {
    pauseTask: (task: Aria2Task) => Promise<unknown>
    resumeTask: (task: Aria2Task) => Promise<unknown>
    removeTask: (task: Aria2Task) => Promise<unknown>
    removeTaskRecord: (task: Aria2Task) => Promise<unknown>
    restartTask: (task: Aria2Task) => Promise<unknown>
    stopSeeding: (task: Aria2Task) => Promise<unknown>
    showTaskDetail: (task: Aria2Task) => void
    fetchList: () => Promise<unknown>
  }
  preferenceConfig: () => AppConfig
  t: (key: string, params?: Record<string, unknown>) => string
  dialog: ReturnType<typeof useDialog>
  message: {
    success: (msg: string) => void
    error: (msg: string) => void
    warning: (msg: string) => void
    info: (msg: string) => void
  }
  stoppingGids: Ref<string[]>
}

export function useTaskActions(deps: TaskActionsDeps) {
  const { taskStore, preferenceConfig, t, dialog, message, stoppingGids } = deps

  function handlePauseTask(task: Aria2Task) {
    const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
    taskStore
      .pauseTask(task)
      .then(() => message.success(t('task.pause-task-success', { taskName })))
      .catch(() => message.error(t('task.pause-task-fail', { taskName })))
  }

  function handleResumeTask(task: Aria2Task) {
    const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
    const { COMPLETE, ERROR, REMOVED } = TASK_STATUS
    if (task.status === ERROR || task.status === COMPLETE || task.status === REMOVED) {
      if (!canRestart(task)) {
        message.warning(t('task.restart-not-available'))
        return
      }
      taskStore
        .restartTask(task)
        .then(() => message.success(t('task.restart-task-success', { taskName })))
        .catch(() => message.error(t('task.restart-task-fail', { taskName })))
    } else {
      taskStore
        .resumeTask(task)
        .then(() => message.success(t('task.resume-task-success', { taskName })))
        .catch(() => message.error(t('task.resume-task-fail', { taskName })))
    }
  }

  function handleDeleteTask(task: Aria2Task) {
    const noConfirm = preferenceConfig()?.noConfirmBeforeDeleteTask
    if (noConfirm) {
      taskStore.removeTask(task).catch((e: unknown) => logger.error('TaskView', e))
      return
    }
    const deleteFiles = ref(false)
    const name = getTaskDisplayName(task, { defaultName: 'Unknown' })
    const d = dialog.warning({
      title: t('task.delete-task'),
      content: () =>
        h('div', {}, [
          h('p', { style: 'margin: 0 0 12px; word-break: break-all;' }, name),
          h(
            NCheckbox,
            {
              checked: deleteFiles.value,
              'onUpdate:checked': (v: boolean) => {
                deleteFiles.value = v
              },
            },
            { default: () => t('task.delete-task-label') },
          ),
        ]),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        d.loading = true
        d.negativeButtonProps = { disabled: true }
        d.closable = false
        d.maskClosable = false
        await new Promise((r) => setTimeout(r, 50))
        try {
          await taskStore.removeTask(task)
          if (deleteFiles.value) {
            await deleteTaskFiles(task)
          }
          message.success(t('task.delete-task-success', { taskName: name }))
        } catch (e) {
          logger.error('TaskView.deleteTask', e)
          message.error(t('task.delete-task-fail', { taskName: name }))
        }
      },
    })
  }

  function handleDeleteRecord(task: Aria2Task) {
    const noConfirm = preferenceConfig()?.noConfirmBeforeDeleteTask
    if (noConfirm) {
      taskStore
        .removeTaskRecord(task)
        .then(() =>
          message.success(
            t('task.remove-record-success', { taskName: getTaskDisplayName(task, { defaultName: 'Unknown' }) }),
          ),
        )
        .catch((e: unknown) => logger.error('TaskView.deleteRecord', e))
      return
    }
    const deleteFiles = ref(false)
    const name = getTaskDisplayName(task, { defaultName: 'Unknown' })
    const d = dialog.warning({
      title: t('task.delete-task'),
      content: () =>
        h('div', {}, [
          h('p', { style: 'margin: 0 0 12px; word-break: break-all;' }, name),
          h(
            NCheckbox,
            {
              checked: deleteFiles.value,
              'onUpdate:checked': (v: boolean) => {
                deleteFiles.value = v
              },
            },
            { default: () => t('task.delete-task-label') },
          ),
        ]),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        d.loading = true
        d.negativeButtonProps = { disabled: true }
        d.closable = false
        d.maskClosable = false
        await new Promise((r) => setTimeout(r, 50))
        try {
          if (deleteFiles.value) {
            await deleteTaskFiles(task)
          }
          await taskStore.removeTaskRecord(task)
          message.success(t('task.delete-task-success', { taskName: name }))
        } catch (e) {
          logger.error('TaskView.deleteRecord', e)
          message.error(t('task.delete-task-fail', { taskName: name }))
        }
      },
    })
  }

  function handleCopyLink(task: Aria2Task) {
    navigator.clipboard.writeText(getTaskUri(task))
    message.success(t('task.copy-link-success'))
  }

  function handleShowInfo(task: Aria2Task) {
    taskStore.showTaskDetail(task)
  }

  async function handleShowInFolder(task: Aria2Task) {
    const files = task.files || []
    const filePath = files[0]?.path
    if (!filePath) return
    try {
      const fileExists = await exists(filePath)
      if (!fileExists) {
        message.warning(t('task.file-not-exist'))
        return
      }
      await revealItemInDir(filePath)
      message.success(t('task.open-folder-success'))
    } catch (e) {
      logger.warn('TaskView.showInFolder', String(e))
      message.warning(t('task.file-not-exist'))
    }
  }

  async function handleOpenFile(task: Aria2Task) {
    const target = resolveOpenTarget(task)
    if (!target) return
    try {
      const fileExists = await exists(target)
      if (!fileExists) {
        message.warning(t('task.file-not-exist'))
        return
      }
      const info = await stat(target)
      await openPath(target)
      message.success(t(info.isDirectory ? 'task.open-folder-success' : 'task.open-file-success'))
    } catch (e) {
      logger.warn('TaskView.openFile error', String(e))
      message.warning(t('task.file-not-exist'))
    }
  }

  async function handleStopSeeding(task: Aria2Task) {
    if (stoppingGids.value.includes(task.gid)) return
    stoppingGids.value = [...stoppingGids.value, task.gid]
    try {
      await taskStore.stopSeeding(task)
      stoppingGids.value = stoppingGids.value.filter((g) => g !== task.gid)
      message.success(t('task.stop-seeding-success'))
      await taskStore.fetchList()
    } catch (e) {
      logger.warn('[TaskView] stopSeeding failed:', String(e))
      stoppingGids.value = stoppingGids.value.filter((g) => g !== task.gid)
    }
  }

  return {
    handlePauseTask,
    handleResumeTask,
    handleDeleteTask,
    handleDeleteRecord,
    handleCopyLink,
    handleShowInfo,
    handleShowInFolder,
    handleOpenFile,
    handleStopSeeding,
  }
}
