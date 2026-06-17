/**
 * @fileoverview Extracted restartTask logic — re-submits stopped/errored/completed
 * downloads with rollback on partial failure.
 *
 * This module is a pure async function with explicit dependency injection,
 * making it independently testable without Pinia or Vue reactivity.
 */
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsBT, getRestartDescriptors } from '@shared/utils'
import { shouldShowFileSelection } from '@/composables/useMagnetFlow'
import { logger } from '@shared/logger'
import type { Aria2Task, Aria2EngineOptions } from '@shared/types'

/** Minimal API surface needed by restartTask. */
export interface RestartTaskApi {
  addUriAtomic: (params: { uris: string[]; options: Aria2EngineOptions }) => Promise<string>
  getOption: (params: { gid: string }) => Promise<Record<string, string>>
  removeTask: (params: { gid: string }) => Promise<string>
  removeTaskRecord: (params: { gid: string }) => Promise<string>
  fetchList: () => Promise<unknown>
  saveSession: () => Promise<string>
}

/** Minimal history API needed for cleanup. */
export interface RestartHistoryApi {
  removeRecord: (gid: string) => Promise<void>
}

/** Keys that aria2 rejects on addUri — read-only or non-portable. */
const NON_PORTABLE_KEYS = new Set(['pauseMetadata', 'gid'])

/**
 * Restarts a stopped/errored/completed task by re-submitting its URI(s).
 *
 * - For BT tasks: rebuilds the magnet link → single addUri call.
 * - For multi-file HTTP/FTP tasks: submits each file URI separately.
 * - Uses rollback on partial failure: if any URI fails, all previously
 *   created downloads are removed so no orphan tasks remain.
 * - The old stopped record is only deleted after ALL new downloads succeed.
 */
export async function restartTask(task: Aria2Task, api: RestartTaskApi, historyApi: RestartHistoryApi): Promise<void> {
  const { status, gid, dir } = task
  const { ERROR, COMPLETE, REMOVED } = TASK_STATUS
  if (status !== ERROR && status !== COMPLETE && status !== REMOVED) return

  const descriptors = getRestartDescriptors(task, true) // include trackers for BT
  if (descriptors.length === 0) {
    throw new Error('Cannot restart: no download URIs found for this task')
  }

  // Preserve original per-task options (headers, proxy, auth, out, select-file, etc.).
  const options: Record<string, string> = {}
  try {
    const orig = await api.getOption({ gid })
    for (const [k, v] of Object.entries(orig)) {
      if (!NON_PORTABLE_KEYS.has(k) && v !== '') {
        options[k] = v
      }
    }
  } catch (e) {
    logger.warn('restartTask', `getOption gid=${gid} failed, using dir-only fallback: ${e}`)
    // Fallback: at minimum preserve download directory
    if (dir) options.dir = dir
  }

  // Submit each file as a separate download with ALL its mirror URIs,
  // tracking created GIDs for rollback.
  const isBT = checkTaskIsBT(task)
  if (isBT) {
    options['check-integrity'] = options['check-integrity'] ?? 'true'
    options['force-save'] = options['force-save'] ?? 'true'
  }
  const createdGids: string[] = []
  try {
    for (const mirrorGroup of descriptors) {
      const newGid = await api.addUriAtomic({ uris: mirrorGroup, options })
      createdGids.push(newGid)
      // BT restarts produce magnet URIs — register with the metadata poller
      // only when pause-metadata is enabled (file selection mode).
      if (isBT) {
        const { usePreferenceStore } = await import('@/stores/preference')
        const preferenceStore = usePreferenceStore()
        if (shouldShowFileSelection(preferenceStore.config)) {
          const { useAppStore } = await import('@/stores/app')
          const appStore = useAppStore()
          appStore.pendingMagnetGids = [...appStore.pendingMagnetGids, newGid]
        }
      }
    }
  } catch (e) {
    // Rollback: remove any partially created tasks
    for (const newGid of createdGids) {
      try {
        await api.removeTask({ gid: newGid })
      } catch (e) {
        logger.debug('restartTask', `rollback removeTask gid=${newGid} skipped: ${e}`)
      }
    }
    throw e // propagate original error to caller
  }

  // All new downloads succeeded — remove old record from both sources
  try {
    await api.removeTaskRecord({ gid })
  } catch (e) {
    logger.debug('restartTask.removeRecord', e)
  }
  try {
    await historyApi.removeRecord(gid)
  } catch (e) {
    logger.debug('restartTask.removeHistoryRecord', e)
  }

  await api.fetchList()
  await api.saveSession()
}
