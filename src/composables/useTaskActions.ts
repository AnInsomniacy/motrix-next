/**
 * @fileoverview Composable for task action handler functions.
 *
 * Extracted from TaskView.vue to reduce component script size.
 * Uses dependency injection for all Vue/Pinia dependencies — stores,
 * i18n, dialog, and message are passed in via the options object.
 */
import { ref, h } from 'vue'
import {
  getTaskUri,
  getTaskDisplayName,
  resolveOpenTarget,
  canRestart,
  writeAppClipboardText,
  getSharingResultLabelKey,
  getTaskSharingKind,
} from '@shared/utils'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { invoke } from '@tauri-apps/api/core'
import { deleteTaskFiles } from '@/composables/useFileDelete'
import { resolveTaskFilePath, requestFileRecheck } from '@/composables/useArchivedPaths'
import { logger } from '@shared/logger'
import { NCheckbox, useDialog } from 'naive-ui'
import type { Aria2Task, AppConfig } from '@shared/types'

interface TaskActionsDeps {
  taskStore: {
    pauseTask: (task: Aria2Task) => Promise<unknown>
    resumeTask: (task: Aria2Task) => Promise<unknown>
    finishSharing: (task: Aria2Task) => Promise<unknown>
    removeTask: (task: Aria2Task) => Promise<unknown>
    removeTaskRecord: (task: Aria2Task) => Promise<unknown>
    retryTask: (task: Aria2Task) => Promise<unknown>
    redownloadTask: (task: Aria2Task) => Promise<unknown>
    showTaskDetail: (task: Aria2Task) => void
    fetchList: () => Promise<unknown>
    taskList: Aria2Task[]
  }
  requestMagnetSelection: (gid: string) => void
  preferenceConfig: () => AppConfig
  t: (key: string, params?: Record<string, unknown>) => string
  dialog: ReturnType<typeof useDialog>
  message: {
    success: (msg: string) => void
    error: (msg: string) => void
    warning: (msg: string) => void
    info: (msg: string) => void
  }
}

export function useTaskActions(deps: TaskActionsDeps) {
  const { taskStore, preferenceConfig, t, dialog, message, requestMagnetSelection } = deps

  const deleteFilesLabel = () =>
    t(
      preferenceConfig().fileDeletionMode === 'permanent'
        ? 'task.delete-local-files-permanent-label'
        : 'task.delete-local-files-trash-label',
    )

  function handlePauseTask(task: Aria2Task) {
    const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
    taskStore
      .pauseTask(task)
      .then(() => message.success(t('task.pause-task-success', { taskName })))
      .catch((e) => {
        logger.warn('TaskView.pauseTask', getErrorMessage(e))
        message.error(t('task.pause-task-fail', { taskName }))
      })
  }

  function handleResumeTask(task: Aria2Task) {
    const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
    taskStore
      .resumeTask(task)
      .then((resumed) => {
        if (resumed !== false) message.success(t('task.resume-task-success', { taskName }))
      })
      .catch((e) => {
        logger.warn('TaskView.resumeTask', getErrorMessage(e))
        message.error(t('task.resume-task-fail', { taskName }))
      })
  }

  function handleRetryTask(task: Aria2Task) {
    const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
    if (!canRestart(task)) {
      message.warning(t('task.restart-not-available'))
      return
    }
    taskStore
      .retryTask(task)
      .then(() => message.success(t('task.retry-task-success', { taskName })))
      .catch((error) => {
        logger.warn('TaskView.retryTask', getErrorMessage(error))
        message.error(t('task.retry-task-fail', { taskName }))
      })
  }

  function handleRedownloadTask(task: Aria2Task) {
    const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
    if (!canRestart(task)) {
      message.warning(t('task.restart-not-available'))
      return
    }
    taskStore
      .redownloadTask(task)
      .then(() => message.success(t('task.restart-task-success', { taskName })))
      .catch((error) => {
        logger.warn('TaskView.redownloadTask', getErrorMessage(error))
        message.error(t('task.restart-task-fail', { taskName }))
      })
  }

  function handleFinishSharing(task: Aria2Task) {
    const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
    const kind = getTaskSharingKind(task)
    if (!kind) return
    taskStore
      .finishSharing(task)
      .then(() => message.success(t(getSharingResultLabelKey(kind, 'success'), { taskName })))
      .catch((error) => {
        logger.warn('TaskView.finishSharing', getErrorMessage(error))
        message.error(t(getSharingResultLabelKey(kind, 'fail'), { taskName }))
      })
  }

  function handleDeleteTask(task: Aria2Task) {
    const config = preferenceConfig()
    const noConfirm = config.noConfirmBeforeDeleteTask
    if (noConfirm) {
      const alsoDeleteFiles = config.deleteFilesWhenSkipConfirm
      taskStore
        .removeTask(task)
        .then(async () => {
          if (alsoDeleteFiles) {
            try {
              await deleteTaskFiles(task, config.fileDeletionMode)
            } catch (error) {
              logger.error('TaskView.deleteTaskFiles', error)
              message.error(t('task.remove-task-file-fail'))
            }
          }
        })
        .catch((error: unknown) => {
          logger.error('TaskView.deleteTask', error)
          message.error(t('task.delete-task-fail', { taskName: getTaskDisplayName(task, { defaultName: 'Unknown' }) }))
        })
      return
    }
    const deleteFiles = ref(false)
    const name = getTaskDisplayName(task, { defaultName: 'Unknown' })
    const d = dialog.error({
      title: t('task.delete-task'),
      content: () =>
        h('div', {}, [
          h('p', { class: 'technical-text-wrap', style: 'margin: 0 0 12px;' }, name),
          h(
            NCheckbox,
            {
              checked: deleteFiles.value,
              'onUpdate:checked': (v: boolean) => {
                deleteFiles.value = v
              },
            },
            { default: deleteFilesLabel },
          ),
        ]),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        d.loading = true
        d.negativeButtonProps = { disabled: true }
        d.closable = false
        d.maskClosable = false
        try {
          await taskStore.removeTask(task)
          if (deleteFiles.value) {
            try {
              await deleteTaskFiles(task, config.fileDeletionMode)
            } catch (error) {
              logger.error('TaskView.deleteTaskFiles', error)
              message.error(t('task.remove-task-file-fail'))
              return
            }
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
    const config = preferenceConfig()
    const noConfirm = config.noConfirmBeforeDeleteTask
    if (noConfirm) {
      const alsoDeleteFiles = config.deleteFilesWhenSkipConfirm
      const taskRef = task
      taskStore
        .removeTaskRecord(task)
        .then(async () => {
          if (alsoDeleteFiles) {
            try {
              await deleteTaskFiles(taskRef, config.fileDeletionMode)
            } catch (error) {
              logger.error('TaskView.deleteRecordFiles', error)
              message.error(t('task.remove-task-file-fail'))
              return
            }
          }
          message.success(
            t('task.remove-record-success', { taskName: getTaskDisplayName(taskRef, { defaultName: 'Unknown' }) }),
          )
        })
        .catch((e: unknown) => logger.error('TaskView.deleteRecord', e))
      return
    }
    const deleteFiles = ref(false)
    const name = getTaskDisplayName(task, { defaultName: 'Unknown' })
    const d = dialog.error({
      title: t('task.delete-task'),
      content: () =>
        h('div', {}, [
          h('p', { class: 'technical-text-wrap', style: 'margin: 0 0 12px;' }, name),
          h(
            NCheckbox,
            {
              checked: deleteFiles.value,
              'onUpdate:checked': (v: boolean) => {
                deleteFiles.value = v
              },
            },
            { default: deleteFilesLabel },
          ),
        ]),
      positiveText: t('app.yes'),
      negativeText: t('app.no'),
      onPositiveClick: async () => {
        d.loading = true
        d.negativeButtonProps = { disabled: true }
        d.closable = false
        d.maskClosable = false
        try {
          if (deleteFiles.value) {
            try {
              await deleteTaskFiles(task, config.fileDeletionMode)
            } catch (error) {
              logger.error('TaskView.deleteRecordFiles', error)
              message.error(t('task.remove-task-file-fail'))
              return
            }
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

  async function handleCopyLink(task: Aria2Task) {
    const uri = getTaskUri(task).trim()
    if (!uri) {
      message.warning(t('task.copy-link-unavailable'))
      return
    }
    try {
      await writeAppClipboardText(uri)
      message.success(t('task.copy-link-success'))
    } catch (e) {
      logger.warn('TaskView.copyLink', getErrorMessage(e))
      message.error(t('task.copy-link-unavailable'))
    }
  }

  function handleShowInfo(task: Aria2Task) {
    taskStore.showTaskDetail(task)
  }

  async function handleShowInFolder(task: Aria2Task) {
    const files = task.files || []
    if (files.length === 0) return

    // Resolve correct path — archived location takes priority over aria2 original
    const filePath = resolveTaskFilePath(task)

    if (!filePath) return
    try {
      const fileExists = await invoke<boolean>('check_path_exists', { path: filePath })
      if (fileExists) {
        await invoke('show_item_in_dir', { path: filePath })
        message.success(t('task.open-folder-success'))
        return
      }
      // Fallback: file missing but BT folder or download dir may still exist
      const fallback = await resolveOpenTarget(task)
      if (fallback) {
        const fallbackExists = await invoke<boolean>('check_path_exists', { path: fallback })
        if (fallbackExists) {
          await invoke('show_item_in_dir', { path: fallback })
          message.success(t('task.open-folder-success'))
          return
        }
      }
      message.warning(t('task.file-not-exist'))
      requestFileRecheck()
    } catch (e) {
      logger.warn('TaskView.showInFolder', e instanceof Error ? e.message : JSON.stringify(e))
      message.warning(t('task.file-not-exist'))
      requestFileRecheck()
    }
  }

  async function handleOpenFile(task: Aria2Task) {
    const target = await resolveOpenTarget(task)
    if (!target) return
    try {
      const fileExists = await invoke<boolean>('check_path_exists', { path: target })
      if (!fileExists) {
        message.warning(t('task.file-not-exist'))
        requestFileRecheck()
        return
      }
      const isDir = await invoke<boolean>('check_path_is_dir', { path: target })
      await invoke('open_path_normalized', { path: target })
      message.success(t(isDir ? 'task.open-file-is-folder' : 'task.open-file-success'))
    } catch (e) {
      logger.warn('TaskView.openFile error', e instanceof Error ? e.message : JSON.stringify(e))
      message.warning(t('task.file-not-exist'))
      requestFileRecheck()
    }
  }

  function handleSelectFiles(task: Aria2Task) {
    requestMagnetSelection(task.gid)
  }

  return {
    handlePauseTask,
    handleResumeTask,
    handleRetryTask,
    handleRedownloadTask,
    handleFinishSharing,
    handleDeleteTask,
    handleDeleteRecord,
    handleCopyLink,
    handleShowInfo,
    handleShowInFolder,
    handleOpenFile,
    handleSelectFiles,
  }
}
