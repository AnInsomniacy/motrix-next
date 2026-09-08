import { listen } from '@tauri-apps/api/event'
import { logger } from '@shared/logger'
import {
  findPendingMagnetSelectionTask,
  isPendingMagnetSelectionTask,
  parseFilesForSelection,
  type MagnetSelectionResolution,
} from '@/composables/useMagnetFlow'
import type { Aria2Task, BtFileSelectionItem } from '@shared/types'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { getTaskDisplayName } from '@shared/utils/task'

export interface MagnetMetadataState {
  pendingGids: string[]
  deferredGids: string[]
  visible: boolean
  files: BtFileSelectionItem[]
  session: MagnetSelectionResolution | null
  name: string
}

export interface MagnetMetadataDeps {
  state: MagnetMetadataState
  fetchTaskStatus: (gid: string) => Promise<Aria2Task>
  fetchPendingTasks: () => Promise<Aria2Task[]>
  getFiles: (gid: string) => Promise<Aria2Task['files']>
  fallbackName: () => string
}

export interface MagnetMetadataResolver {
  request: (gid: string) => Promise<void>
}

type PendingTaskLoader = () => Promise<Aria2Task[]>

export async function resolvePendingMagnetMetadata(
  deps: MagnetMetadataDeps,
  gid: string,
  loadPendingTasks: PendingTaskLoader = deps.fetchPendingTasks,
): Promise<boolean> {
  const { state } = deps
  if (state.visible) return false
  if (!state.pendingGids.includes(gid)) return false
  if (state.deferredGids.includes(gid)) return false

  let queryError: unknown
  let task: Aria2Task | undefined

  try {
    const candidate = await deps.fetchTaskStatus(gid)
    if (isPendingMagnetSelectionTask(candidate)) task = candidate
  } catch (error) {
    queryError = error
  }

  try {
    task ??= findPendingMagnetSelectionTask(await loadPendingTasks(), gid)

    if (!task) {
      if (queryError !== undefined) {
        state.pendingGids = state.pendingGids.filter((candidate) => candidate !== gid)
        state.deferredGids = state.deferredGids.filter((candidate) => candidate !== gid)
        logger.debug('MagnetMetadata.resolve', 'metadata_resolution_skipped', {
          gid,
          outcome: 'skipped',
          reason: getErrorMessage(queryError),
        })
      }
      return false
    }

    const files = parseFilesForSelection(await deps.getFiles(gid))
    if (files.length === 0) return false

    if (state.visible || !state.pendingGids.includes(gid)) return false

    state.files = files
    state.session = { gid }
    state.name = getTaskDisplayName(task, { defaultName: files[0]?.name || deps.fallbackName() })
    state.visible = true
    return true
  } catch (error) {
    logger.debug('MagnetMetadata.resolve', 'metadata_resolution_skipped', {
      gid,
      outcome: 'skipped',
      reason: getErrorMessage(error),
    })
    return false
  }
}

export function createMagnetMetadataResolver(getDeps: () => MagnetMetadataDeps): MagnetMetadataResolver {
  let running = false
  const requestedGids = new Set<string>()

  async function request(gid: string): Promise<void> {
    if (!getDeps().state.pendingGids.includes(gid)) return

    requestedGids.add(gid)
    if (running) return

    running = true
    try {
      while (requestedGids.size > 0) {
        const deps = getDeps()
        const next = requestedGids.values().next()
        if (next.done) break
        requestedGids.delete(next.value)
        await resolvePendingMagnetMetadata(deps, next.value)
      }
    } finally {
      running = false
    }
  }

  return { request }
}

export async function listenForAria2DownloadPause(
  onPause: (gid: string) => unknown | Promise<unknown>,
): Promise<() => void> {
  return listen<{ gid: string }>('aria2-event:download-pause', (event) => {
    void onPause(event.payload.gid)
  })
}
