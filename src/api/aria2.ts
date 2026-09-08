/**
 * @fileoverview Aria2 API — invoke() transport layer.
 *
 * All aria2 RPC calls go through Tauri invoke() to the Rust backend.
 * The Rust Aria2Client handles HTTP JSON-RPC communication with Aria2 Next.
 */
import { invoke } from '@tauri-apps/api/core'
import { changeKeysToCamelCase, formatOptionsForEngine } from '@shared/utils'
import type {
  Aria2Task,
  Aria2RawGlobalStat,
  Aria2Peer,
  Aria2EngineOptions,
  Aria2File,
  Aria2BtTracker,
  Aria2BtTrackerConfig,
  Aria2BtPeerAddResult,
  AppConfig,
  Ed2kSearchOptions,
  Ed2kSearchResults,
  ExternalDownloadContext,
  TorrentInspection,
  BatchDeleteTaskTarget,
  BatchTaskOperationResult,
  ResumeEligibleResult,
} from '@shared/types'
import { logger } from '@shared/logger'
import { resolveDownloadDir } from '@shared/utils/fileCategory'
import { extractDecodedFilename, sanitizeAria2OutHint } from '@shared/utils/batchHelpers'
import { summarizeAria2Options, summarizeExternalInput } from '@shared/utils/externalInputDiagnostics'
import { useEngineStore } from '@/stores/engine'
import { getActivePinia } from 'pinia'

/** Returns true when the aria2 engine has started and is accepting RPC. */
export function isEngineReady(): boolean {
  const pinia = getActivePinia()
  return pinia ? useEngineStore(pinia).isReady : false
}

function withBtSafetyOptions(options: Aria2EngineOptions): Aria2EngineOptions {
  return {
    ...options,
    'check-integrity': options['check-integrity'] ?? 'true',
    'force-save': options['force-save'] ?? 'true',
  }
}

/** Retrieves aria2 engine version and list of enabled features. */
export async function getVersion(): Promise<{ version: string; enabledFeatures: string[] }> {
  return invoke<{ version: string; enabledFeatures: string[] }>('aria2_get_version')
}

/** Fetches aggregated download/upload statistics from aria2. */
export async function getGlobalStat(): Promise<Aria2RawGlobalStat> {
  return invoke<Aria2RawGlobalStat>('aria2_get_global_stat')
}

/** Updates aria2 global configuration at runtime. */
export async function changeGlobalOption(options: Partial<AppConfig>): Promise<void> {
  const engineOptions = formatOptionsForEngine(options)
  logger.debug('aria2.changeGlobalOption', engineOptions)
  await invoke<string>('aria2_change_global_option', { options: engineOptions })
}

/** Fetches the option set for a specific download task as camelCase keys. */
export async function getOption(params: { gid: string }): Promise<Record<string, string>> {
  const data = await invoke<Record<string, string>>('aria2_get_option', { gid: params.gid })
  return changeKeysToCamelCase(data) as Record<string, string>
}

/** Modifies options for a specific download task at runtime. */
export async function changeOption(params: { gid: string; options: Aria2EngineOptions }): Promise<void> {
  const engineOptions = formatOptionsForEngine(params.options)
  await invoke<string>('aria2_change_option', { gid: params.gid, options: engineOptions })
}

/** Retrieves the file list for a download task by GID. */
export async function getFiles(params: { gid: string }): Promise<Aria2File[]> {
  const data = await invoke<Record<string, unknown>[]>('aria2_get_files', { gid: params.gid })
  return data.map((f) => changeKeysToCamelCase(f)) as unknown as Aria2File[]
}

export async function getBtTrackers(params: { gid: string }): Promise<Aria2BtTracker[]> {
  return invoke<Aria2BtTracker[]>('aria2_get_bt_trackers', { gid: params.gid })
}

export async function forceBtRecheck(params: { gid: string }): Promise<void> {
  await invoke<string>('aria2_force_bt_recheck', params)
}

export async function replaceBtTrackers(params: { gid: string; trackers: Aria2BtTrackerConfig[] }): Promise<void> {
  await invoke<string>('aria2_replace_bt_trackers', params)
}

export async function replaceBtWebSeeds(params: { gid: string; webSeeds: string[] }): Promise<void> {
  await invoke<string>('aria2_replace_bt_web_seeds', params)
}

export async function addBtPeers(params: { gid: string; peers: string[] }): Promise<Aria2BtPeerAddResult> {
  return invoke<Aria2BtPeerAddResult>('aria2_add_bt_peers', params)
}

/** Fetches only active tasks (no waiting). */
export async function fetchActiveTaskList(): Promise<Aria2Task[]> {
  return invoke<Aria2Task[]>('aria2_fetch_active_task_list')
}

/** Fetches a native task snapshot: all, active+waiting, or stopped. */
export async function fetchTaskList(params: { type: string; limit?: number }): Promise<Aria2Task[]> {
  return invoke<Aria2Task[]>('aria2_fetch_task_list', {
    type: params.type,
    limit: params.limit ?? null,
  })
}

/** Fetches a single task's full status by GID. */
export async function fetchTaskItem(params: { gid: string }): Promise<Aria2Task> {
  return invoke<Aria2Task>('aria2_fetch_task_item', { gid: params.gid })
}

/** Fetches a single task's status along with its peer list (for BT tasks). */
export async function fetchTaskItemWithPeers(params: { gid: string }): Promise<Aria2Task & { peers: Aria2Peer[] }> {
  return invoke<Aria2Task & { peers: Aria2Peer[] }>('aria2_fetch_task_item_with_peers', { gid: params.gid })
}

/** Adds one or more URI downloads with per-URI output filename overrides. */
export async function addUri(params: {
  uris: string[]
  outs: string[]
  options: Aria2EngineOptions
  fileCategory?: {
    enabled: boolean
    categories: import('@shared/types').FileCategory[]
    contexts?: Record<string, ExternalDownloadContext>
  }
}): Promise<string[]> {
  const { uris, outs, options, fileCategory } = params
  const engineOptions = formatOptionsForEngine(options)

  // Each URI gets its own aria2 task with optional per-URI overrides
  const tasks = uris.map(async (uri, index) => {
    const opts: Record<string, string> = { ...engineOptions }
    if (outs[index]) opts.out = outs[index]

    // Defense-in-depth: sanitize out for filesystem safety (#261, #264).
    // Rust sanitize_out_option is the authoritative boundary; this is belt-and-suspenders.
    if (opts.out) opts.out = sanitizeAria2OutHint(opts.out)
    if (!opts.out) delete opts.out

    // Smart file classification: resolve per-URI download directory
    if (fileCategory?.enabled && fileCategory.categories.length > 0) {
      const context = fileCategory.contexts?.[uri]
      opts.dir = resolveDownloadDir(
        opts.out || extractDecodedFilename(uri) || uri,
        opts.dir || '',
        true,
        fileCategory.categories,
        {
          urls: [uri, context?.finalUrl ?? '', context?.url ?? '', context?.referer ?? ''],
        },
      )
    }

    return invoke<string>('aria2_add_uri', { uris: [uri], options: opts })
  })

  const gids = await Promise.all(tasks)
  logger.info('aria2.addUri', 'downloads_added', {
    added: gids.length,
    gids: gids.join(','),
    first: uris[0] ? summarizeExternalInput(uris[0]) : 'none',
    ...summarizeAria2Options(engineOptions),
  })
  return gids
}

/**
 * Adds a single download with all URIs as mirrors (alternative sources).
 */
export async function addUriAtomic(params: { uris: string[]; options: Aria2EngineOptions }): Promise<string> {
  const { uris, options } = params
  const engineOptions = formatOptionsForEngine(options)
  const gid = await invoke<string>('aria2_add_uri', { uris, options: engineOptions })
  logger.debug('aria2.addUriAtomic', `gid=${gid} mirrors=${uris.length}`)
  return gid
}

/** Adds a torrent download from a base64-encoded .torrent file. */
export async function addTorrent(params: { torrent: string; options: Aria2EngineOptions }): Promise<string> {
  const engineOptions = formatOptionsForEngine(withBtSafetyOptions(params.options))
  const gid = await invoke<string>('aria2_add_torrent', { torrent: params.torrent, options: engineOptions })
  logger.info('aria2.addTorrent', `gid=${gid}`)
  return gid
}

/** Inspects torrent metainfo without creating a task or engine state. */
export async function inspectTorrent(params: { torrent: string }): Promise<TorrentInspection> {
  return invoke<TorrentInspection>('aria2_inspect_torrent', { torrent: params.torrent })
}

/** Starts an ED2K search and returns the search GID. */
export async function ed2kSearch(params: { keyword: string; options?: Ed2kSearchOptions }): Promise<string> {
  return invoke<string>('aria2_ed2k_search', {
    keyword: params.keyword,
    options: params.options ?? {},
  })
}

/** Fetches ED2K search results by search GID. */
export async function getEd2kSearchResults(params: { gid: string }): Promise<Ed2kSearchResults> {
  return invoke<Ed2kSearchResults>('aria2_get_ed2k_search_results', { gid: params.gid })
}

/** Cleans up an internal ED2K search task and its temporary files. */
export async function cleanupEd2kSearch(params: { gid: string }): Promise<void> {
  await invoke<void>('aria2_cleanup_ed2k_search', { gid: params.gid })
}

/** Forcefully removes a download task by GID. */
export async function removeTask(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_force_remove', { gid: params.gid })
}

/** Deletes a task across live, transitioning, stopped, and history states. */
export async function deleteTask(params: { gid: string; infoHash?: string }): Promise<void> {
  return invoke<void>('aria2_delete_task', {
    gid: params.gid,
    infoHash: params.infoHash ?? null,
  })
}

/** Ends one P2P sharing task while preserving files and completed history. */
export async function finishSharing(params: { gid: string }): Promise<void> {
  return invoke<void>('aria2_finish_sharing', params)
}

/** Ends multiple P2P sharing tasks in one native application transaction. */
export async function batchFinishSharing(params: { gids: string[] }): Promise<BatchTaskOperationResult> {
  return invoke<BatchTaskOperationResult>('aria2_batch_finish_sharing', params)
}

/** Deletes multiple tasks with native engine and history cleanup. */
export async function batchDeleteTasks(params: { tasks: BatchDeleteTaskTarget[] }): Promise<BatchTaskOperationResult> {
  return invoke<BatchTaskOperationResult>('aria2_batch_delete_tasks', params)
}

/** Forcefully pauses a download task by GID. */
export async function forcePauseTask(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_force_pause', { gid: params.gid })
}

/** Forcefully pauses every active task through Aria2 Next's native RPC. */
export async function forcePauseAll(): Promise<string> {
  return invoke<string>('aria2_force_pause_all')
}

/** Pauses a download task by GID (graceful). */
export async function pauseTask(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_pause', { gid: params.gid })
}

/** Resumes a paused download task by GID. */
export async function resumeTask(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_unpause', { gid: params.gid })
}

/** Resumes all eligible paused tasks while preserving magnet selection guards. */
export async function resumeEligible(): Promise<ResumeEligibleResult> {
  return invoke<ResumeEligibleResult>('aria2_resume_eligible')
}

/** Saves the current aria2 session to disk. */
export async function saveSession(): Promise<string> {
  return invoke<string>('aria2_save_session')
}

/** Removes a completed/errored task record from the download list. */
export async function removeTaskRecord(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_remove_download_result', { gid: params.gid })
}

/** Clears application history and purges completed engine results. */
export async function purgeTaskRecords(): Promise<void> {
  return invoke<void>('aria2_purge_task_records')
}

const api = {
  getVersion,
  getGlobalStat,
  changeGlobalOption,
  getOption,
  changeOption,
  getFiles,
  getBtTrackers,
  fetchActiveTaskList,
  fetchTaskList,
  fetchTaskItem,
  fetchTaskItemWithPeers,
  addUri,
  addUriAtomic,
  addTorrent,
  inspectTorrent,
  ed2kSearch,
  getEd2kSearchResults,
  cleanupEd2kSearch,
  removeTask,
  deleteTask,
  batchDeleteTasks,
  finishSharing,
  batchFinishSharing,
  forcePauseTask,
  forcePauseAll,
  pauseTask,
  resumeTask,
  resumeEligible,
  saveSession,
  removeTaskRecord,
  purgeTaskRecords,
}

export default api
