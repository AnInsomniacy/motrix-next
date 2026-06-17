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
  AppConfig,
  Ed2kSearchOptions,
  Ed2kSearchResults,
} from '@shared/types'
import { formatLogFields, logger } from '@shared/logger'
import { resolveDownloadDir } from '@shared/utils/fileCategory'
import { sanitizeAria2OutHint } from '@shared/utils/batchHelpers'
import { summarizeAria2Options, summarizeExternalInput } from '@shared/utils/externalInputDiagnostics'

/**
 * Engine readiness state.
 * With the Rust backend transport, readiness is determined by the engine
 * lifecycle commands — the Aria2Client is always available once credentials
 * are set by `on_engine_ready`.
 */
let engineReady = false

/** Returns true when the aria2 engine has started and is accepting RPC. */
export function isEngineReady(): boolean {
  return engineReady
}

/** Marks the engine as ready/unready. */
export function setEngineReady(ready: boolean): void {
  engineReady = ready
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

/** Fetches all global aria2 configuration options as camelCase keys. */
export async function getGlobalOption(): Promise<Record<string, string>> {
  const data = await invoke<Record<string, string>>('aria2_get_global_option')
  return changeKeysToCamelCase(data) as Record<string, string>
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

/** Fetches only active tasks (no waiting). */
export async function fetchActiveTaskList(): Promise<Aria2Task[]> {
  return invoke<Aria2Task[]>('aria2_fetch_active_task_list')
}

/** Fetches task list by status type: active+waiting or stopped. */
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
  fileCategory?: { enabled: boolean; categories: import('@shared/types').FileCategory[] }
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
      opts.dir = resolveDownloadDir(opts.out || uri, opts.dir || '', true, fileCategory.categories)
    }

    return invoke<string>('aria2_add_uri', { uris: [uri], options: opts })
  })

  const gids = await Promise.all(tasks)
  logger.info(
    'aria2.addUri',
    formatLogFields({
      added: gids.length,
      gids: `[${gids.join(',')}]`,
      first: uris[0] ? summarizeExternalInput(uris[0]) : 'none',
      ...summarizeAria2Options(engineOptions),
    }),
  )
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

/** Forcefully pauses a download task by GID. */
export async function forcePauseTask(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_force_pause', { gid: params.gid })
}

/** Pauses a download task by GID (graceful). */
export async function pauseTask(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_pause', { gid: params.gid })
}

/** Resumes a paused download task by GID. */
export async function resumeTask(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_unpause', { gid: params.gid })
}

/** Pauses all active downloads (graceful). */
export async function pauseAllTask(): Promise<string> {
  return invoke<string>('aria2_pause_all')
}

/** Forcefully pauses all active downloads. */
export async function forcePauseAllTask(): Promise<string> {
  return invoke<string>('aria2_force_pause_all')
}

/** Resumes all paused downloads. */
export async function resumeAllTask(): Promise<string> {
  return invoke<string>('aria2_unpause_all')
}

/** Saves the current aria2 session to disk. */
export async function saveSession(): Promise<string> {
  return invoke<string>('aria2_save_session')
}

/** Removes a completed/errored task record from the download list. */
export async function removeTaskRecord(params: { gid: string }): Promise<string> {
  return invoke<string>('aria2_remove_download_result', { gid: params.gid })
}

/** Purges all completed/errored task records from the download list. */
export async function purgeTaskRecord(): Promise<string> {
  return invoke<string>('aria2_purge_download_result')
}

/** Batch-resumes multiple tasks by GID array via multicall. */
export async function batchResumeTask(params: { gids: string[] }): Promise<unknown[][]> {
  return invoke<unknown[][]>('aria2_batch_unpause', { gids: params.gids })
}

/** Batch-pauses multiple tasks by GID array via multicall (force). */
export async function batchPauseTask(params: { gids: string[] }): Promise<unknown[][]> {
  return invoke<unknown[][]>('aria2_batch_force_pause', { gids: params.gids })
}

/** Alias for batchPauseTask — force-pauses multiple tasks. */
export async function batchForcePauseTask(params: { gids: string[] }): Promise<unknown[][]> {
  return batchPauseTask(params)
}

/** Batch-removes multiple tasks by GID array via multicall (force). */
export async function batchRemoveTask(params: { gids: string[] }): Promise<unknown[][]> {
  return invoke<unknown[][]>('aria2_batch_force_remove', { gids: params.gids })
}

const api = {
  getVersion,
  getGlobalOption,
  getGlobalStat,
  changeGlobalOption,
  getOption,
  changeOption,
  getFiles,
  fetchActiveTaskList,
  fetchTaskList,
  fetchTaskItem,
  fetchTaskItemWithPeers,
  addUri,
  addUriAtomic,
  addTorrent,
  ed2kSearch,
  getEd2kSearchResults,
  cleanupEd2kSearch,
  removeTask,
  forcePauseTask,
  pauseTask,
  resumeTask,
  pauseAllTask,
  forcePauseAllTask,
  resumeAllTask,
  saveSession,
  removeTaskRecord,
  purgeTaskRecord,
  batchResumeTask,
  batchPauseTask,
  batchForcePauseTask,
  batchRemoveTask,
}

export default api
