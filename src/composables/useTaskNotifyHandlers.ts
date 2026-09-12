/**
 * @fileoverview Extracted notification handlers for task lifecycle events.
 *
 * MainLayout registers these callbacks on the lifecycle service.
 *
 * **Notification architecture:**
 * - In-app toast (Naive UI message) — always fires for immediate feedback.
 * - OS-level start, completion and error notifications are all sent from Rust,
 *   driven by Aria2 Next lifecycle events. They therefore fire in lightweight
 *   mode after the WebView is destroyed, and for tasks added outside the app
 *   such as from a browser extension, which never reach these handlers.
 *
 * Completion toasts render inline action buttons so the user can open
 * the downloaded file or reveal it in the system file manager directly
 * from the notification — without navigating through the task list.
 */
import type { VNodeChild } from 'vue'
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
 * Shows the in-app toast only. The OS notification is sent from Rust when
 * Aria2 Next reports the download starting, so it fires no matter how the task
 * was added.
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
  logger.info('TaskNotify.start', 'download_notification_started', {
    count: taskNames.length,
    first: /^(?:https?|sftp|magnet|ed2k|thunder):/i.test(firstName) ? summarizeExternalInput(firstName) : firstName,
  })
}
