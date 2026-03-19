/** @fileoverview Pure utility functions for task lifecycle events.
 *
 * Bridges aria2 task state changes to download history records
 * and cleanup logic. All functions are pure for testability.
 */
import type { Aria2Task, HistoryRecord } from '@shared/types'
import { decodePathSegment } from '@shared/utils/batchHelpers'

/** Detect BT metadata-only downloads (the intermediate magnet resolution phase).
 *
 * These tasks have `[METADATA]` in the first file path (aria2 convention when
 * bt-save-metadata is enabled) or a `followedBy` field pointing to the real
 * download. They should NOT be persisted as history records. */
export function isMetadataTask(task: Aria2Task): boolean {
  if (task.followedBy && task.followedBy.length > 0) return true
  const firstPath = task.files?.[0]?.path ?? ''
  return firstPath.startsWith('[METADATA]')
}

/** Extract a HistoryRecord from an aria2 task for persistence. */
export function buildHistoryRecord(task: Aria2Task): HistoryRecord {
  const btName = task.bittorrent?.info?.name
  const firstFile = task.files?.[0]
  const pathName = firstFile?.path?.split(/[/\\]/).pop()
  const name = btName || (pathName ? decodePathSegment(pathName) : '') || 'Unknown'

  const uri = firstFile?.uris?.[0]?.uri
  const taskType = task.bittorrent ? 'bt' : 'uri'

  // Persist BT-specific metadata needed for task reconstruction.
  // infoHash is essential for rebuilding the magnet link on restart.
  const meta: Record<string, string> = {}
  if (task.infoHash) meta.infoHash = task.infoHash

  return {
    gid: task.gid,
    name,
    uri: uri ?? undefined,
    dir: task.dir ?? undefined,
    total_length: task.totalLength ? Number(task.totalLength) : undefined,
    status: task.status,
    task_type: taskType,
    completed_at: new Date().toISOString(),
    meta: Object.keys(meta).length > 0 ? JSON.stringify(meta) : undefined,
  }
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

  // Parse meta JSON for BT-specific fields
  let meta: Record<string, string> = {}
  if (record.meta) {
    try {
      meta = JSON.parse(record.meta) as Record<string, string>
    } catch {
      // Corrupt meta — ignore
    }
  }

  // Synthesize files[0] — path is dir/name, uris from record.uri
  const filePath = dir && record.name ? `${dir}/${record.name}` : record.name
  const uris = record.uri ? [{ uri: record.uri, status: 'used' as const }] : []
  const file = { index: '1', path: filePath, length: totalLength, completedLength, selected: 'true', uris }

  const task: Aria2Task = {
    gid: record.gid,
    status: record.status as Aria2Task['status'],
    totalLength,
    completedLength,
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir,
    files: [file],
  }

  // BT tasks get a bittorrent.info stub so getTaskName() resolves correctly
  if (record.task_type === 'bt') {
    task.bittorrent = { info: { name: record.name } }
  }

  // Restore infoHash from meta — essential for magnet link reconstruction
  if (meta.infoHash) {
    task.infoHash = meta.infoHash
  }

  return task
}

/** Merge live aria2 stopped tasks with persisted history records.
 *
 * Aria2 data takes priority for any GID that appears in both sources.
 * History-only records (from previous sessions) are appended after
 * the live data, preserving temporal ordering. */
export function mergeHistoryIntoTasks(aria2Tasks: Aria2Task[], historyRecords: HistoryRecord[]): Aria2Task[] {
  if (historyRecords.length === 0) return aria2Tasks

  const seenGids = new Set(aria2Tasks.map((t) => t.gid))
  const historyOnly = historyRecords.filter((r) => !seenGids.has(r.gid))

  return [...aria2Tasks, ...historyOnly.map(historyRecordToTask)]
}
