/** @fileoverview Pure utility functions for task lifecycle events.
 *
 * Bridges aria2 task state changes to download history records
 * and cleanup logic. All functions are pure for testability.
 */
import type { Aria2Task, Aria2File, HistoryRecord, HistoryMeta, HistoryFileSnapshot } from '@shared/types'
import { decodePathSegment } from '@shared/utils/batchHelpers'
import { normalizeSep } from '@shared/utils/autoArchive'
import { isBtMetadataTask } from '@shared/utils/task'
import { checkTaskIsHls, isHlsGid } from '@shared/utils/hls'
import { getAddedAt } from '@/composables/useTaskOrder'
import { logger } from '@shared/logger'

/** Detect magnet tasks that are still resolving BitTorrent metadata. */
export function isMetadataTask(task: Aria2Task): boolean {
  return isBtMetadataTask(task)
}

// ── Centralized history snapshot helpers ────────────────────────────
// All meta read/write MUST go through these functions. Never JSON.parse
// HistoryRecord.meta directly in consumer code.

/** Build structured meta from a live aria2 task (write path).
 *
 * - Stores infoHash for BT magnet reconstruction.
 * - Stores full file list (with ALL mirror URIs) for multi-file tasks.
 *   Single-file tasks omit meta.files to keep JSON compact. */
export function buildHistoryMeta(task: Aria2Task): HistoryMeta {
  const meta: HistoryMeta = {}
  if (task.infoHash) meta.infoHash = task.infoHash
  if (task.bittorrent?.magnetLink) meta.magnetLink = task.bittorrent.magnetLink
  if (task.ed2k?.ed2kLink) meta.ed2kLink = task.ed2k.ed2kLink
  if (task.ed2k?.hash) meta.ed2kHash = task.ed2k.hash
  if (task.bittorrent?.announceList && task.bittorrent.announceList.length > 0) {
    meta.announceList = task.bittorrent.announceList.map((tier) => [...tier])
  }
  if (task.hls) {
    meta.hls = {
      playlistUrl: task.hls.playlistUrl,
      mediaKind: task.hls.mediaKind,
      outputPath: task.hls.outputPath,
    }
  }

  // Snapshot trigger: multi-file OR any file with multiple mirror URIs.
  // Multi-file: enables correct delete (all files) and stale cleanup.
  // Multi-mirror: enables correct restart with all mirrors via addUriAtomic.
  const files = task.files ?? []
  const hasMultipleFiles = files.length > 1
  const hasMirrors = files.some((f) => (f.uris?.length ?? 0) > 1)
  const needsSnapshot = hasMultipleFiles || hasMirrors
  if (needsSnapshot) {
    meta.files = files.map(
      (f): HistoryFileSnapshot => ({
        path: f.path,
        length: f.length,
        selected: f.selected,
        uris: (f.uris ?? []).map((u) => u.uri),
      }),
    )
  }
  return meta
}

/** Parse structured meta from a persisted history record (read path).
 *  Never throws — returns empty object on corrupt/missing meta. */
export function parseHistoryMeta(record: HistoryRecord): HistoryMeta {
  if (!record.meta) return {}
  try {
    return JSON.parse(record.meta) as HistoryMeta // HistoryRecord.meta is a JSON-encoded HistoryMeta snapshot
  } catch {
    return {}
  }
}

/** Extract all expected file paths from a history record.
 *
 * Used by stale cleanup to check whether downloaded files still exist.
 * Multi-file records return all paths; legacy single-file records return
 * a single synthetic path from dir + name. */
export function extractHistoryFilePaths(record: HistoryRecord): string[] {
  const meta = parseHistoryMeta(record)
  if (meta.files && meta.files.length > 0) {
    return meta.files.map((f) => f.path).filter(Boolean)
  }
  // Legacy fallback: single file path from dir + name
  if (record.dir && record.name) {
    const dir = record.dir.replace(/[\\/]+$/, '')
    return [`${dir}/${record.name}`]
  }
  return []
}

/** Extract a HistoryRecord from an aria2 task for persistence. */
export function buildHistoryRecord(task: Aria2Task): HistoryRecord {
  const btName = task.bittorrent?.info?.name
  const firstFile = task.files?.[0]
  const pathName = firstFile?.path?.split(/[/\\]/).pop()
  const name = btName || (pathName ? decodePathSegment(pathName) : '') || 'Unknown'

  const uri = task.hls?.playlistUrl || firstFile?.uris?.[0]?.uri
  const taskType = task.bittorrent ? 'bt' : task.ed2k ? 'ed2k' : task.hls || checkTaskIsHls(task) ? 'hls' : 'uri'

  // Build structured meta snapshot (centralised — no inline JSON.stringify elsewhere)
  const meta = buildHistoryMeta(task)

  return {
    gid: task.gid,
    name,
    uri: uri ?? undefined,
    dir: task.dir ?? undefined,
    total_length: task.totalLength ? Number(task.totalLength) : undefined,
    status: task.status,
    task_type: taskType,
    added_at: getAddedAt(task.gid),
    completed_at: new Date().toISOString(),
    meta: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
  }
}

/** Build a history record for a task entering shared-upload state.
 *
 * Shared upload means the download phase is complete and verified.
 * Aria2 still reports status='active' for these tasks, but from the user's
 * perspective the download is done. This function overrides status to
 * 'complete' so the record correctly reflects download completion.
 *
 * Used by both the lifecycle service (automatic detection) and
 * stopSharing (manual stop) to avoid duplicating the override logic. */
export function buildSharingCompletionRecord(task: Aria2Task): HistoryRecord {
  const record = buildHistoryRecord(task)
  record.status = 'complete'
  return record
}

/** Determine if stale record cleanup should run based on user config. */
export function shouldRunStaleCleanup(config: Partial<{ autoDeleteStaleRecords: boolean }> | undefined): boolean {
  return config?.autoDeleteStaleRecords === true
}

/** Reconstruct an Aria2Task from a persisted HistoryRecord.
 *
 * This is the inverse of buildHistoryRecord — it synthesizes the `files[]`
 * and optional `bittorrent` fields so that TaskItem can render the record
 * using the same code paths as live aria2 tasks.
 *
 * Fields not available in the DB (downloadSpeed, connections, etc.) are
 * zero-filled, which is correct for stopped/completed tasks. */
export function historyRecordToTask(record: HistoryRecord): Aria2Task {
  const dir = record.dir ?? ''
  const totalLength = String(record.total_length ?? 0)
  const completedLength = record.status === 'complete' ? totalLength : '0'

  // Centralised meta parsing — never JSON.parse directly.
  const meta = parseHistoryMeta(record)

  // Build files array: prefer multi-file snapshot from meta.files,
  // fall back to legacy single-file synthesis for old records.
  let files: Aria2File[]
  if (meta.files && meta.files.length > 0) {
    // Full restoration from snapshot — preserves all paths, lengths, and mirror URIs.
    files = meta.files.map((f, i) => ({
      index: String(i + 1),
      path: f.path,
      length: f.length ?? '0',
      completedLength: record.status === 'complete' ? (f.length ?? '0') : '0',
      selected: f.selected ?? 'true',
      uris: f.uris.map((uri) => ({ uri, status: 'used' as const })), // snapshot URIs are treated as used for restart
    }))
  } else {
    // Legacy single-file fallback — path is dir + separator + name.
    // dir may end with `\\` (Windows) or `/` (Unix); avoid double separators.
    const filePath = dir && record.name ? `${dir.replace(/[\\/]+$/, '')}/${record.name}` : record.name
    const uris = record.uri ? [{ uri: record.uri, status: 'used' as const }] : [] // single-URI records start as used
    files = [{ index: '1', path: filePath, length: totalLength, completedLength, selected: 'true', uris }]
  }

  const task: Aria2Task = {
    gid: record.gid,
    status: record.status as Aria2Task['status'], // HistoryRecord.status is a string; TaskStatus is the closed union
    totalLength,
    completedLength,
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir,
    files,
  }

  // BT tasks get a bittorrent.info stub so getTaskName() resolves correctly
  if (record.task_type === 'bt') {
    task.bittorrent = { info: { name: record.name } }
    if (meta.magnetLink) {
      task.bittorrent.magnetLink = meta.magnetLink
    }
    if (meta.announceList && meta.announceList.length > 0) {
      task.bittorrent.announceList = meta.announceList.map((tier) => [...tier])
    }
  }

  if (record.task_type === 'ed2k') {
    task.ed2k = {
      name: record.name,
      length: totalLength,
    }
    if (meta.ed2kLink) {
      task.ed2k.ed2kLink = meta.ed2kLink
    }
  }

  applyHlsHistoryStub(task, record, meta)

  // Restore infoHash from meta — essential for magnet link reconstruction
  if (meta.infoHash) {
    task.infoHash = meta.infoHash
  }

  return task
}

/** Restore HLS playlist metadata so history stubs stay restartable. */
function applyHlsHistoryStub(task: Aria2Task, record: HistoryRecord, meta: HistoryMeta): void {
  if (record.task_type !== 'hls' && !isHlsGid(record.gid)) return

  const playlistUrl = meta.hls?.playlistUrl ?? record.uri ?? ''
  task.hls = {
    playlistUrl,
    mediaKind: meta.hls?.mediaKind ?? 'mpegts',
    segmentCount: 0,
    segmentTotal: 0,
    encryptMethod: 'none',
    phase: 'download',
    outputPath: meta.hls?.outputPath,
  }

  const file = task.files[0]
  if (!file) return
  if (meta.hls?.outputPath) {
    file.path = meta.hls.outputPath
  }
  if (playlistUrl && !file.uris.some((u) => u.uri === playlistUrl)) {
    file.uris = [{ uri: playlistUrl, status: 'used' }, ...file.uris]
  }
}

/** Merge live aria2 tasks with persisted history records.
 *
 * Deduplicates on two dimensions:
 * 1. **GID** — same-session dedup (task still in aria2 with original GID).
 * 2. **infoHash** — cross-session dedup (aria2 reassigns GIDs on session
 *    restore, but the torrent's infoHash is globally stable).
 *
 * Aria2 live data always takes priority. History-only records (from
 * previous sessions) are appended after the live data. */
export function mergeHistoryIntoTasks(aria2Tasks: Aria2Task[], historyRecords: HistoryRecord[]): Aria2Task[] {
  if (historyRecords.length === 0) return aria2Tasks

  // ── Post-archive path correction ────────────────────────────────
  // After auto-archive moves a file, aria2's DownloadResult snapshot
  // still reports the original dir (aria2 RPC has no mechanism to
  // update stopped tasks — DownloadResult is immutable, see aria2
  // DownloadResult.h).  The history DB stores the corrected dir from
  // updateHistoryFilePath().  Patch aria2's stale paths here so that
  // resolveTaskFilePath / check_path_exists see the archived location
  // after WebView recreation (lightweight mode) or window re-open.
  const recordByGid = new Map<string, HistoryRecord>()
  for (const r of historyRecords) recordByGid.set(r.gid, r)

  const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'waiting', 'paused'])
  for (const task of aria2Tasks) {
    if (LIVE_STATUSES.has(task.status)) continue
    const dbRecord = recordByGid.get(task.gid)
    if (!dbRecord?.dir) continue
    if (normalizeSep(dbRecord.dir) === normalizeSep(task.dir ?? '')) continue

    // Patch dir — the DB value reflects the post-archive directory.
    task.dir = dbRecord.dir

    // Patch files[].path from the DB meta snapshot when available
    // (multi-file or mirror tasks store individual file paths).
    const meta = parseHistoryMeta(dbRecord)
    if (meta.files && task.files) {
      for (let i = 0; i < task.files.length && i < meta.files.length; i++) {
        if (meta.files[i].path) task.files[i].path = meta.files[i].path
      }
    } else if (task.files?.[0] && dbRecord.name) {
      // Single-file fallback: reconstruct from corrected dir + name.
      task.files[0].path = `${dbRecord.dir}/${dbRecord.name}`
    }
  }

  // Primary dedup key: GID (handles same-session tasks)
  const seenGids = new Set(aria2Tasks.map((t) => t.gid))

  // Secondary dedup key: infoHash (handles cross-session BT tasks).
  // Metadata tasks are excluded — their infoHash is identical to the real
  // download task's, and including it would incorrectly suppress the download
  // task's history record when the metadata task lingers in tellStopped.
  const seenInfoHashes = new Set<string>()
  for (const t of aria2Tasks) {
    if (t.infoHash && !isMetadataTask(t)) seenInfoHashes.add(t.infoHash)
  }

  const historyOnly = historyRecords.filter((r) => {
    // Same-session: GID match → aria2 data wins
    if (seenGids.has(r.gid)) return false
    // Cross-session: infoHash match → live seeding task wins
    if (r.meta) {
      const meta = parseHistoryMeta(r)
      if (meta.infoHash && seenInfoHashes.has(meta.infoHash)) return false
    }
    return true
  })

  return [...aria2Tasks, ...historyOnly.map(historyRecordToTask)]
}

// ── Post-archive history path update ────────────────────────────────

/** Minimal history store interface needed by updateHistoryFilePath.
 *  Avoids coupling to the full Pinia store type. */
interface HistoryStoreSubset {
  getRecordByGid: (gid: string) => Promise<HistoryRecord | null>
  addRecord: (record: HistoryRecord) => Promise<void>
}

/**
 * Update a history record's file paths after auto-archive moves the file.
 *
 * Handles two record flavours:
 * - **Multi-file / mirror** records (meta.files present): patches matching
 *   `files[].path` entries in the JSON snapshot.
 * - **Single-file** records (no meta.files): updates `record.dir` to the
 *   archive directory so `historyRecordToTask()` synthesizes the correct
 *   `dir/name` path.
 *
 * Uses the existing `addRecord` upsert — no new SQL needed.
 */
export async function updateHistoryFilePath(
  store: HistoryStoreSubset,
  gid: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const record = await store.getRecordByGid(gid)
  if (!record) return

  const meta = parseHistoryMeta(record)
  let changed = false
  const normalizedOld = normalizeSep(oldPath)

  // Patch meta.files snapshot — used by multi-file and mirror tasks
  if (meta.files && meta.files.length > 0) {
    for (const f of meta.files) {
      if (normalizeSep(f.path) === normalizedOld) {
        f.path = newPath
        changed = true
      }
    }
  }

  // Update dir to the archive directory (parent of newPath).
  // historyRecordToTask() uses dir+name for single-file fallback.
  const lastSlash = newPath.lastIndexOf('/')
  if (lastSlash > 0) {
    const newDir = newPath.substring(0, lastSlash)
    if (record.dir !== newDir) {
      record.dir = newDir
      changed = true
    }
  }

  if (!changed) return

  record.meta = Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined
  await store.addRecord(record)
  logger.debug('AutoArchive.historyUpdated', `gid=${gid} dir=${record.dir}`)
}
