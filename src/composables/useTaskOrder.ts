/**
 * @fileoverview In-memory registry of task birth timestamps (added_at).
 *
 * Provides position-stable ordering: once a task is assigned an added_at
 * timestamp, it never changes — ensuring the task's position in the list
 * remains fixed regardless of status transitions or batch operations.
 *
 * Lifecycle:
 *   addUri/addTorrent → registerAddedAt(gid, now)
 *   fetchList poll    → trackFirstSeen(tasks) — fallback for session-restored tasks
 *   task_birth        → Rust lifecycle writer preserves download_history.added_at
 *   App start         → loadBirthRecords() → pre-populate from task_birth table
 *
 * Two persistence layers:
 *   task_birth table        — written at task birth, survives restarts
 *   download_history.added_at — written at completion, survives task removal
 */

/** Internal store — module-scoped singleton, not exported. */
const addedAtMap = new Map<string, string>()

/** Record the birth time of a task. No-op if already tracked (idempotent). */
export function registerAddedAt(gid: string, timestamp?: string): void {
  if (!addedAtMap.has(gid)) {
    addedAtMap.set(gid, timestamp ?? new Date().toISOString())
  }
}

/** Retrieve the stored added_at for a task, or undefined if untracked. */
export function getAddedAt(gid: string): string | undefined {
  return addedAtMap.get(gid)
}

/**
 * Ensure all tasks in the array have an added_at entry.
 *
 * For tasks not yet tracked (e.g. session-restored active tasks on restart),
 * assigns sequential timestamps 1 ms apart so that aria2's queue order
 * (which preserves insertion order via its internal deque) is maintained.
 */
export function trackFirstSeen(tasks: ReadonlyArray<{ gid: string }>): void {
  let baseTime = Date.now()
  for (const t of tasks) {
    if (!addedAtMap.has(t.gid)) {
      addedAtMap.set(t.gid, new Date(baseTime++).toISOString())
    }
  }
}

/**
 * Pre-populate the map from persisted records (task_birth + download_history).
 * Existing entries are never overwritten — memory always wins.
 */
export function loadAddedAtFromRecords(records: ReadonlyArray<{ gid: string; added_at?: string | null }>): void {
  for (const r of records) {
    if (r.added_at && !addedAtMap.has(r.gid)) {
      addedAtMap.set(r.gid, r.added_at)
    }
  }
}

/**
 * Build a unified added_at lookup for sorting.
 *
 * Merges three sources (priority: memory Map > DB records > fallback):
 *   1. In-memory addedAtMap (authoritative for active tasks)
 *   2. History records from download_history.added_at (completed tasks)
 *   3. Falls back to empty string for unknown tasks (sorts last in DESC)
 */
export function buildSortableAddedAtMap(
  tasks: ReadonlyArray<{ gid: string }>,
  historyRecords: ReadonlyArray<{ gid: string; added_at?: string | null }>,
): Map<string, string> {
  const result = new Map<string, string>()

  // DB records first (stable, persisted)
  for (const r of historyRecords) {
    if (r.added_at) result.set(r.gid, r.added_at)
  }

  // Memory wins — overrides DB for active tasks
  for (const t of tasks) {
    const mem = addedAtMap.get(t.gid)
    if (mem) result.set(t.gid, mem)
  }

  return result
}
