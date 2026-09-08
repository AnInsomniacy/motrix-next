/**
 * @fileoverview Explicit retry and re-download transactions for terminal tasks.
 *
 * Retry resumes an interrupted payload. Re-download creates a fresh stream
 * download while preserving the original source and request options.
 */
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsBT, getRestartDescriptors } from '@shared/utils'
import { logger } from '@shared/logger'
import { changeKeysToCamelCase } from '@shared/utils/config'
import { engineOptionKeys } from '@shared/configKeys'
import type { Aria2Task, MagnetFileSelectionPolicy } from '@shared/types'

export type TaskResubmissionMode = 'retry' | 'redownload'

export interface TaskResubmissionApi {
  addUriAtomic: (params: { uris: string[]; options: Record<string, string> }) => Promise<string>
  fetchTaskItem: (params: { gid: string }) => Promise<Aria2Task>
  getOption: (params: { gid: string }) => Promise<Record<string, string>>
  removeTask: (params: { gid: string }) => Promise<string>
  removeTaskRecord: (params: { gid: string }) => Promise<string>
}

export interface TaskResubmissionHistoryApi {
  removeRecord: (gid: string) => Promise<void>
}

const RESUBMITTABLE_KEYS = new Set(
  Object.keys(changeKeysToCamelCase(Object.fromEntries(engineOptionKeys.map((key) => [key, true])))),
)
RESUBMITTABLE_KEYS.delete('pauseMetadata')
RESUBMITTABLE_KEYS.delete('gid')

const SUBMISSION_SETTLE_ATTEMPTS = 6

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function assertModeMatchesTask(task: Aria2Task, mode: TaskResubmissionMode): void {
  const expected = mode === 'retry' ? TASK_STATUS.ERROR : [TASK_STATUS.COMPLETE, TASK_STATUS.REMOVED]
  const allowed = Array.isArray(expected) ? expected.includes(task.status) : task.status === expected
  if (!allowed) throw new Error(`Cannot ${mode} task while status is ${task.status}`)
}

async function readResubmissionOptions(task: Aria2Task, api: TaskResubmissionApi): Promise<Record<string, string>> {
  const options: Record<string, string> = {}
  try {
    const original = await api.getOption({ gid: task.gid })
    for (const [key, value] of Object.entries(original)) {
      if (RESUBMITTABLE_KEYS.has(key) && value !== '') options[key] = value
    }
  } catch (error) {
    logger.warn('taskResubmission', `getOption gid=${task.gid} failed, using dir-only fallback: ${error}`)
    if (task.dir) options.dir = task.dir
  }
  return options
}

function applyModeOptions(
  options: Record<string, string>,
  mode: TaskResubmissionMode,
  isBt: boolean,
  magnetFileSelectionPolicy: MagnetFileSelectionPolicy,
): void {
  options.continue = mode === 'retry' || isBt ? 'true' : 'false'
  options.allowOverwrite = 'false'
  options.autoFileRenaming = mode === 'redownload' && !isBt ? 'true' : 'false'

  if (!isBt) return
  options.checkIntegrity = options.checkIntegrity ?? 'true'
  options.forceSave = options.forceSave ?? 'true'
  options.pauseMetadata = magnetFileSelectionPolicy === 'download-all' ? 'false' : 'true'
}

async function assertSubmissionAccepted(api: TaskResubmissionApi, gid: string): Promise<void> {
  let lastTask: Aria2Task | null = null
  for (let attempt = 0; attempt < SUBMISSION_SETTLE_ATTEMPTS; attempt += 1) {
    try {
      const task = await api.fetchTaskItem({ gid })
      lastTask = task
      if (task.status === TASK_STATUS.ERROR || task.status === TASK_STATUS.REMOVED) {
        throw new Error(task.errorMessage || `Submitted task ${gid} entered ${task.status} state`)
      }
      if (
        task.status === TASK_STATUS.ACTIVE ||
        task.status === TASK_STATUS.WAITING ||
        task.status === TASK_STATUS.PAUSED
      ) {
        return
      }
      if (task.status === TASK_STATUS.COMPLETE) return
    } catch (error) {
      if (attempt === SUBMISSION_SETTLE_ATTEMPTS - 1) throw error
    }
    await delay(40)
  }
  throw new Error(lastTask?.errorMessage || `Submitted task ${gid} was not accepted`)
}

async function rollbackSubmissions(api: TaskResubmissionApi, gids: string[]): Promise<void> {
  for (const gid of gids) {
    try {
      await api.removeTask({ gid })
    } catch (error) {
      logger.debug('taskResubmission.rollback', `gid=${gid} skipped: ${error}`)
    }
  }
}

/** Submits a terminal task with explicit retry or re-download semantics. */
export async function resubmitTask(
  task: Aria2Task,
  mode: TaskResubmissionMode,
  api: TaskResubmissionApi,
  historyApi: TaskResubmissionHistoryApi,
  magnetFileSelectionPolicy: MagnetFileSelectionPolicy,
  registerPendingMagnet: (gid: string) => void | Promise<void> = () => undefined,
): Promise<string[]> {
  assertModeMatchesTask(task, mode)

  const descriptors = getRestartDescriptors(task, true)
  if (descriptors.length === 0) throw new Error('Cannot resubmit: no download URIs found for this task')

  const isBt = checkTaskIsBT(task)
  const options = await readResubmissionOptions(task, api)
  applyModeOptions(options, mode, isBt, magnetFileSelectionPolicy)

  const createdGids: string[] = []
  try {
    for (const uris of descriptors) {
      const newGid = await api.addUriAtomic({ uris, options })
      createdGids.push(newGid)
      await assertSubmissionAccepted(api, newGid)
      if (isBt && magnetFileSelectionPolicy !== 'download-all') await registerPendingMagnet(newGid)
    }
  } catch (error) {
    await rollbackSubmissions(api, createdGids)
    throw error
  }

  try {
    await api.removeTaskRecord({ gid: task.gid })
  } catch (error) {
    logger.debug('taskResubmission.removeRecord', error)
  }
  try {
    await historyApi.removeRecord(task.gid)
  } catch (error) {
    logger.debug('taskResubmission.removeHistoryRecord', error)
  }

  return createdGids
}
