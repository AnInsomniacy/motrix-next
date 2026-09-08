/**
 * @fileoverview Per-tab task sorting composable.
 *
 * Provides pure, testable sort functions for the four exclusive task scopes.
 *
 * Each tab maintains independent sort state (field + direction).
 *
 * Every scope sorts the same task model, including terminal snapshots.
 */
import { getTaskName, getTaskCompletedLength } from '@shared/utils/task'
import type { Aria2Task } from '@shared/types'

// ── Sort field types ────────────────────────────────────────────────

export type SortDirection = 'asc' | 'desc'

export type TaskScope = 'all' | 'progress' | 'failed' | 'completed'
export type ProgressSortField = 'manual' | 'added-at' | 'name' | 'size' | 'progress' | 'speed'
export type TerminalSortField = 'manual' | 'added-at' | 'completed-at' | 'name' | 'size'
export type AllSortField = 'manual' | 'added-at' | 'name' | 'size'

/** Unified sort configuration persisted in AppConfig. */
export interface TaskSortConfig {
  all: { field: AllSortField; direction: SortDirection }
  progress: { field: ProgressSortField; direction: SortDirection }
  failed: { field: TerminalSortField; direction: SortDirection }
  completed: { field: TerminalSortField; direction: SortDirection }
}

export interface TaskManualOrderConfig {
  all: string[]
  progress: string[]
  failed: string[]
  completed: string[]
}

// ── Constants ───────────────────────────────────────────────────────

export const PROGRESS_SORT_FIELDS: readonly ProgressSortField[] = [
  'manual',
  'added-at',
  'name',
  'size',
  'progress',
  'speed',
]

export const TERMINAL_SORT_FIELDS: readonly TerminalSortField[] = ['manual', 'added-at', 'completed-at', 'name', 'size']

export const ALL_SORT_FIELDS: readonly AllSortField[] = ['manual', 'added-at', 'name', 'size']

export const DEFAULT_TASK_SORT: TaskSortConfig = {
  all: { field: 'added-at', direction: 'desc' },
  progress: { field: 'added-at', direction: 'desc' },
  failed: { field: 'added-at', direction: 'desc' },
  completed: { field: 'added-at', direction: 'desc' },
}

export const DEFAULT_TASK_MANUAL_ORDER: TaskManualOrderConfig = {
  all: [],
  progress: [],
  failed: [],
  completed: [],
}

// ── Internal comparators ────────────────────────────────────────────

/** Compare two string values with direction. Empty strings sort last in DESC. */
function compareStrings(a: string, b: string, dir: SortDirection): number {
  return dir === 'asc' ? a.localeCompare(b) : b.localeCompare(a)
}

/** Compare two numeric values with direction. */
function compareNumbers(a: number, b: number, dir: SortDirection): number {
  return dir === 'asc' ? a - b : b - a
}

// ── Task sort value extractors ──────────────────────────────────────

/** Extract a comparable value from an Aria2Task for the given sort field. */
function taskSortValue(
  task: Aria2Task,
  field: Exclude<ProgressSortField | TerminalSortField, 'manual'>,
  addedAtIndex: Map<string, string>,
  completedAtIndex: Map<string, string>,
): string | number {
  switch (field) {
    case 'added-at':
      return addedAtIndex.get(task.gid) ?? ''
    case 'completed-at':
      return completedAtIndex.get(task.gid) ?? ''
    case 'name':
      return getTaskName(task).toLowerCase()
    case 'size':
      return Number(task.totalLength) || 0
    case 'progress': {
      const total = Number(task.totalLength) || 0
      return total > 0 ? getTaskCompletedLength(task) / total : 0
    }
    case 'speed':
      return Number(task.downloadSpeed) || 0
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Sort an array of Aria2Tasks in-place.
 *
 * Used by every task scope. The `addedAtIndex` map is required for
 * 'added-at' sorting — pass `buildSortableAddedAtMap()` output or an
 * empty Map if using a field that doesn't need it.
 */
export function sortTasks(
  tasks: Aria2Task[],
  field: ProgressSortField | TerminalSortField,
  direction: SortDirection,
  addedAtIndex: Map<string, string>,
  completedAtIndex = new Map<string, string>(),
): void {
  if (field === 'manual') return
  const sortableField = field
  tasks.sort((a, b) => {
    const va = taskSortValue(a, sortableField, addedAtIndex, completedAtIndex)
    const vb = taskSortValue(b, sortableField, addedAtIndex, completedAtIndex)
    if (typeof va === 'string' && typeof vb === 'string') {
      return compareStrings(va, vb, direction)
    }
    return compareNumbers(va as number, vb as number, direction)
  })
}

export function applyManualOrder<T extends { gid: string }>(
  items: T[],
  manualOrder: readonly string[],
  fallbackSort: (items: T[]) => void,
): void {
  const position = new Map(manualOrder.map((gid, index) => [gid, index]))
  const known: T[] = []
  const fresh: T[] = []

  for (const item of items) {
    if (position.has(item.gid)) known.push(item)
    else fresh.push(item)
  }

  fallbackSort(fresh)
  known.sort((a, b) => position.get(a.gid)! - position.get(b.gid)!)
  items.splice(0, items.length, ...fresh, ...known)
}

export function createManualOrderSnapshot(items: readonly { gid: string }[]): string[] {
  return items.map((item) => item.gid)
}
