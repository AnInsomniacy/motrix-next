/** @fileoverview Task metadata operations: naming, progress, task links, and open targets. */
import { parseInt } from 'lodash-es'
import { join } from '@tauri-apps/api/path'
import type { Aria2Task, Aria2File } from '@shared/types'
import { resolveTaskFilePath } from '@/composables/useArchivedPaths'

/** Calculates download progress as a percentage. */
export const calcProgress = (totalLength: string | number, completedLength: string | number, decimal = 2): number => {
  const total = parseInt(String(totalLength), 10)
  const completed = parseInt(String(completedLength), 10)
  if (total === 0 || completed === 0) return 0
  const percentage = (completed / total) * 100
  return parseFloat(percentage.toFixed(decimal))
}

const parseLength = (value: string | number | undefined): number => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export const getTaskCompletedLength = (task: Aria2Task): number => {
  return parseLength(task.completedLength)
}

/** Calculates upload-to-download ratio for shared-upload tasks. */
export const calcRatio = (totalLength: string | number, uploadLength: string | number): number => {
  const total = parseInt(String(totalLength), 10)
  const upload = parseInt(String(uploadLength), 10)
  if (total === 0 || upload === 0) return 0
  const percentage = upload / total
  return parseFloat(percentage.toFixed(4))
}

const filenameFromUri = (uri?: string): string => {
  if (!uri) return ''
  try {
    const segment = new URL(uri).pathname.split('/').filter(Boolean).pop() ?? ''
    if (!segment || !segment.includes('.')) return ''
    return decodeURIComponent(segment)
  } catch {
    return ''
  }
}

const getFileNameFromFile = (file?: Aria2File): string => {
  if (!file) return ''
  const { path } = file
  if (path) {
    // Path is set — aria2 has resolved the filename (from Content-Disposition or URL).
    const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    if (idx < 0) return path
    const name = path.substring(idx + 1)
    if (name) return name
    // Trailing separator means this is still a directory, not a resolved file.
  }
  // Path is empty or a directory: aria2 hasn't received the HTTP response yet,
  // or an HLS job was mapped to `dir/` before `out` was filled.
  // Fall back to extracting from URI, but only for segments that look like filenames
  // (i.e., contain a dot/extension). Extensionless segments like "/download/sample/215"
  // are typically redirect stubs or API endpoints — return '' so the UI shows a
  // placeholder instead of a misleading name.
  return filenameFromUri(file.uris?.[0]?.uri)
}

/** Resolves a human-readable task name from BT info or file path. */
export const getTaskName = (task: Aria2Task | null, options: { defaultName?: string } = {}): string => {
  const { defaultName = '' } = options
  let result = defaultName
  if (!task) return result

  const { files, bittorrent } = task
  if (!files || files.length === 0) return result

  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = bittorrent.info.name
  } else if (files.length === 1) {
    const name = getFileNameFromFile(files[0])
    result = name || result
  } else {
    // Multi-file HTTP: use first non-empty filename
    const firstName = files.map((f) => getFileNameFromFile(f)).find((n) => !!n)
    result = firstName || result
  }

  return result
}

/**
 * Returns a human-readable display name with URL-decoded filenames.
 *
 * Use for ALL UI display contexts (TaskItem, TaskDetail, notifications).
 * For filesystem operations, use getTaskName() instead.
 */
export const getTaskDisplayName = (task: Aria2Task | null, options: { defaultName?: string } = {}): string => {
  const name = getTaskName(task, options)
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** Returns true if the task is a magnet link still resolving metadata. */
export const isMagnetTask = (task: Aria2Task): boolean => {
  const { bittorrent } = task
  return !!bittorrent && !bittorrent.info
}

/** Returns true when native aria2 is still resolving torrent metadata. */
export const isBtMetadataTask = (task: Aria2Task): boolean => {
  if (!task.bittorrent) return false
  if (task.bittorrent.info) return false
  return !task.following
}

export type TaskSharingKind = 'bt' | 'ed2k'

/** Returns the protocol-specific shared-upload state, if the task is upload-only and active. */
export const getTaskSharingKind = (task: Aria2Task): TaskSharingKind | null => {
  if (task.status !== 'active' || task.seeder !== 'true') return null
  if (task.bittorrent) return 'bt'
  if (task.ed2k) return 'ed2k'
  return null
}

/** Returns true if the task is in a completed shared-upload state. */
export const checkTaskIsSharing = (task: Aria2Task): boolean => {
  return getTaskSharingKind(task) !== null
}

/** Returns true if the task is a BitTorrent download (has bittorrent metadata). */
export const checkTaskIsBT = (task: Partial<Aria2Task> = {} as Partial<Aria2Task>): boolean => {
  return !!task.bittorrent
}

/** Returns true for Aria2 Next internal ED2K search request groups. */
export const checkTaskIsEd2kSearch = (task: Partial<Aria2Task> = {} as Partial<Aria2Task>): boolean => {
  return !!(
    task.ed2k?.searchActive === true || task.files?.some((file) => file.path.includes('aria2-next-ed2k-search-'))
  )
}

/**
 * Collects all download URIs from a task.
 * For BT and ED2K tasks, returns the engine-serialized canonical link.
 * For HLS tasks, returns the playlist URL even when files[] is empty.
 * For HTTP/FTP tasks, iterates all files and extracts their URIs.
 */
export const getTaskUris = (task: Aria2Task, _withTracker = false): string[] => {
  const magnet = task.bittorrent?.magnetLink?.trim()
  if (magnet) {
    return magnet ? [magnet] : []
  }
  const ed2kLink = task.ed2k?.ed2kLink?.trim()
  if (ed2kLink) {
    return [ed2kLink]
  }
  const playlistUrl = task.hls?.playlistUrl?.trim()
  if (playlistUrl) {
    return [playlistUrl]
  }
  const { files } = task
  if (!files || files.length === 0) return []
  const uris: string[] = []
  for (const file of files) {
    if (file.uris && file.uris.length > 0) {
      uris.push(file.uris[0].uri)
    }
  }
  return uris
}

/**
 * Build restart descriptors: one URI group per file.
 *
 * Unlike getTaskUris() which flattens all URIs into a single list,
 * this returns grouped URIs so each file can be submitted to addUriAtomic()
 * with ALL its mirrors in a single call, preserving multi-source semantics.
 *
 * - BT: single group containing the magnet link
 * - ED2K: single group containing the file link
 * - HTTP/FTP: one group per file, each containing ALL mirror URIs
 *
 * Each group maps to one addUriAtomic({ uris: [...mirrors] }) call.
 */
export const getRestartDescriptors = (task: Aria2Task, _withTracker = false): string[][] => {
  const magnet = task.bittorrent?.magnetLink?.trim()
  if (magnet) return [[magnet]]
  const ed2kLink = task.ed2k?.ed2kLink?.trim()
  if (ed2kLink) return [[ed2kLink]]
  const { files } = task
  if (!files || files.length === 0) return []
  const descriptors: string[][] = []
  for (const file of files) {
    if (file.uris && file.uris.length > 0) {
      descriptors.push(file.uris.map((u) => u.uri))
    }
  }
  return descriptors
}

/** Returns the primary download URI or magnet link for a task. */
export const getTaskUri = (task: Aria2Task, withTracker = false): string => {
  const uris = getTaskUris(task, withTracker)
  return uris.length > 0 ? uris[0] : ''
}

/** Whether a stopped/errored/completed task can be re-submitted to aria2.
 *  Returns false when the record lacks both a download URI and a BT infoHash. */
export const canRestart = (task: Aria2Task): boolean => {
  return getTaskUris(task, true).length > 0
}

export const checkTaskTitleIsEmpty = (task: Aria2Task): boolean => {
  const { files, bittorrent } = task
  const [file] = files
  const { path } = file
  let result = path
  if (bittorrent && bittorrent.info && bittorrent.info.name) {
    result = bittorrent.info.name
  }
  return result === ''
}

export const mergeTaskResult = (response: unknown[][] = []): unknown[] => {
  let result: unknown[] = []
  for (const res of response) {
    result = result.concat(...res)
  }
  return result
}

/**
 * Resolves the filesystem target to open for a completed task.
 *
 * - BT multi-file: opens the torrent's root directory (`dir/torrentName`)
 * - BT single-file / HTTP: opens the downloaded file directly
 * - Fallback: opens the download directory when no file path is available
 */
export const resolveOpenTarget = async (task: Aria2Task): Promise<string> => {
  const { files, bittorrent, dir } = task

  // BT multi-file: the torrent creates a subdirectory under `dir`
  if (bittorrent?.info?.name && files.length > 1) {
    return await join(dir, bittorrent.info.name)
  }

  // Single file (BT or HTTP): prefer archived path, then selected file
  const resolved = resolveTaskFilePath(task)
  if (resolved) return resolved

  // Fallback: open the download directory
  return dir
}

export { getFileNameFromFile }

// ── Stable task identity (dedup of live tasks vs history records) ───

export interface TaskIdentityBuckets {
  gids: string[]
  btInfoHashes: string[]
  ed2kHashes: string[]
  ed2kLinks: string[]
}

function addUnique(values: Set<string>, value: string | undefined): void {
  const normalized = value?.trim()
  if (normalized) values.add(normalized)
}

export function collectTaskIdentityBuckets(tasks: Aria2Task[]): TaskIdentityBuckets {
  const gids = new Set<string>()
  const btInfoHashes = new Set<string>()
  const ed2kHashes = new Set<string>()
  const ed2kLinks = new Set<string>()

  for (const task of tasks) {
    addUnique(gids, task.gid)
    addUnique(btInfoHashes, task.infoHash)
    addUnique(ed2kHashes, task.ed2k?.hash)
    addUnique(ed2kLinks, task.ed2k?.ed2kLink)
  }

  return {
    gids: [...gids],
    btInfoHashes: [...btInfoHashes],
    ed2kHashes: [...ed2kHashes],
    ed2kLinks: [...ed2kLinks],
  }
}
