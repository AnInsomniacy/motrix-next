/**
 * @fileoverview Extracted notification handlers for task lifecycle events.
 *
 * MainLayout registers these callbacks on the lifecycle service.
 *
 * **Notification architecture:**
 * - In-app toast (Naive UI message) — always fires for immediate feedback.
 * - OS-level completion/error notification is sent by Rust's task monitor so
 *   lightweight mode works after the WebView is destroyed.
 *
 * Completion toasts render inline action buttons so the user can open
 * the downloaded file or reveal it in the system file manager directly
 * from the notification — without navigating through the task list.
 */
import type { VNodeChild } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { Aria2Task } from '@shared/types'
import { getTaskDisplayName } from '@shared/utils'
import type { TaskSharingKind } from '@shared/utils/task'
import { logger } from '@shared/logger'
import { summarizeExternalInput } from '@shared/utils/externalInputDiagnostics'
import { isMetadataTask } from '@/composables/useTaskLifecycle'
import { renderCompletionToast } from '@/composables/useNotificationToast'

export interface NotifyDeps {
  messageSuccess: (content: string | (() => VNodeChild)) => void
  messageError: (content: string) => void
  t: (key: string, params?: Record<string, unknown>) => string
  onOpenFile: (task: Aria2Task) => void
  onShowInFolder: (task: Aria2Task) => void
}

/**
 * Handle a completed stream download.
 * Always sends in-app toast. Native OS notification is sent by Rust monitor.
 *
 * The toast includes inline buttons
 * for "Open File" and "Show in Folder".
 */
export function handleTaskComplete(task: Aria2Task, deps: NotifyDeps): void {
  if (isMetadataTask(task)) return

  const taskName = getTaskDisplayName(task)
  const body = deps.t('task.download-complete-message', { taskName })

  const toastContent = renderCompletionToast({
    body,
    t: deps.t,
    onOpenFile: () => deps.onOpenFile(task),
    onShowInFolder: () => deps.onShowInFolder(task),
  })
  deps.messageSuccess(toastContent)
  logger.debug('TaskNotify.complete', 'completion_toast_shown', { gid: task.gid, task_name: taskName })
}

/**
 * Handle a P2P download entering shared-upload state.
 * Always sends in-app toast. Native OS notification is sent by Rust monitor.
 *
 * The toast includes inline buttons
 * for "Open File" and "Show in Folder".
 */
export function handleP2pDownloadComplete(task: Aria2Task, kind: TaskSharingKind, deps: NotifyDeps): void {
  const taskName = getTaskDisplayName(task)
  const bodyKey = kind === 'bt' ? 'task.bt-download-complete-message' : 'task.ed2k-download-complete-message'
  const body = deps.t(bodyKey, { taskName })

  const toastContent = renderCompletionToast({
    body,
    t: deps.t,
    onOpenFile: () => deps.onOpenFile(task),
    onShowInFolder: () => deps.onShowInFolder(task),
  })
  deps.messageSuccess(toastContent)
  logger.debug('TaskNotify.p2pDownloadComplete', 'p2p_completion_toast_shown', {
    gid: task.gid,
    kind,
    task_name: taskName,
  })
}

/**
 * Handle a download error.
 * Always sends in-app toast. Native OS notification is sent by Rust monitor.
 */
export function handleTaskError(task: Aria2Task, reason: string, deps: Pick<NotifyDeps, 'messageError' | 't'>): void {
  const taskName = getTaskDisplayName(task, { defaultName: 'Unknown' })
  const body = deps.t('task.download-fail-message', { taskName, reason })
  deps.messageError(body)
  logger.warn('TaskNotify.error', 'download_error_toast_shown', { gid: task.gid, reason })
}

// ── Download-start notification ─────────────────────────────────────

/** Dependency interface for start notification — minimal subset. */
export interface StartNotifyDeps {
  messageInfo: (content: string) => void
  t: (key: string, params?: Record<string, unknown>) => string
}

/**
 * Handle download submission success — send start notification.
 *
 * For single tasks:  "Downloading: movie.mp4"
 * For batch tasks:   "Downloading: movie.mp4 and 2 other task(s)"
 *
 * Toast always fires; OS notification is delegated to Rust so lightweight mode
 * uses the same backend-owned native path as completion/error notifications.
 */
export function handleTaskStart(taskNames: string[], deps: StartNotifyDeps): void {
  if (taskNames.length === 0) return

  const firstName = taskNames[0]
  const body =
    taskNames.length === 1
      ? deps.t('task.download-start-message', { taskName: firstName })
      : deps.t('task.download-batch-start-message', {
          taskName: firstName,
          count: taskNames.length - 1,
        })

  deps.messageInfo(body)
  Promise.resolve(invoke('send_task_start_notification', { taskNames })).catch((error) =>
    logger.debug('TaskNotify.start', `native notification failed: ${error}`),
  )
  logger.info('TaskNotify.start', 'download_notification_started', {
    count: taskNames.length,
    first: /^(?:https?|sftp|magnet|ed2k|thunder):/i.test(firstName) ? summarizeExternalInput(firstName) : firstName,
  })
}
