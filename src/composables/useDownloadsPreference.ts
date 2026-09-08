/**
 * @fileoverview Pure functions for the Downloads preference tab.
 *
 * Manages: download paths, task concurrency, retry/recovery, speed limits,
 * notifications/automation, and auto-cleanup. This is the core download
 * experience tab — most fields map to aria2 engine options.
 */
import type { AppConfig, FileCategory, FileDeletionMode } from '@shared/types'
import {
  DEFAULT_APP_CONFIG as D,
  buildDefaultCategories,
  BUILTIN_CATEGORY_LABELS,
  BUILTIN_CATEGORY_TEMPLATES,
  COMPLETED_RECORD_RETENTION_OPTIONS,
} from '@shared/constants'
import { normalizeFileCategory } from '@shared/utils/fileCategory'

// ── Types ───────────────────────────────────────────────────────────

export interface DownloadsForm {
  [key: string]: unknown
  dir: string
  fileCategoryEnabled: boolean
  fileCategories: FileCategory[]
  maxConcurrentDownloads: number
  streamMaxConnections: number
  sharingMode: 'stop-by-condition' | 'manual-stop'
  shareRatio: number
  shareTime: number
  continue: boolean
  maxTries: number
  retryWait: number
  remoteTime: boolean
  maxOverallDownloadLimit: string
  maxOverallUploadLimit: string
  speedScheduleEnabled: boolean
  speedScheduleFrom: string
  speedScheduleTo: string
  speedScheduleDays: number
  newTaskShowDownloading: boolean
  noConfirmBeforeDeleteTask: boolean
  fileDeletionMode: FileDeletionMode
  deleteFilesWhenSkipConfirm: boolean
  taskNotification: boolean
  notifyOnStart: boolean
  notifyOnComplete: boolean
  shutdownWhenComplete: boolean
  keepAwake: boolean
  deleteTorrentAfterComplete: boolean
  autoDeleteStaleRecords: boolean
  clearCompletedOnExit: boolean
  completedRecordRetentionDays: number
}

// ── Internals ───────────────────────────────────────────────────────

/**
 * Hydrates categories loaded from persisted config with missing fields.
 * - `builtIn`: inferred from label matching against BUILTIN_CATEGORY_TEMPLATES
 * - `directory`: filled from baseDir + template subdirName (built-in) or baseDir (custom)
 * Empty directories would cause aria2 to fail, so this is safety-critical.
 */
function hydrateCategories(categories: FileCategory[], baseDir: string): FileCategory[] {
  const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const templateMap: ReadonlyMap<string, string> = new Map(
    BUILTIN_CATEGORY_TEMPLATES.map((t) => [t.label, t.subdirName]),
  )

  return categories
    .map((cat) => {
      const isBuiltIn = cat.builtIn ?? BUILTIN_CATEGORY_LABELS.has(cat.label)
      let directory = cat.directory
      if (!directory) {
        const subdirName = templateMap.get(cat.label)
        directory = subdirName ? `${normalizedBase}/${subdirName}` : normalizedBase
      }
      return { ...cat, builtIn: isBuiltIn, directory }
    })
    .map(normalizeFileCategory)
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Builds the downloads form state from the preference store config.
 * All fallback values reference DEFAULT_APP_CONFIG (single source of truth).
 */
export function buildDownloadsForm(config: AppConfig, defaultDir: string = ''): DownloadsForm {
  return {
    dir: config.dir || defaultDir,
    fileCategoryEnabled: config.fileCategoryEnabled ?? D.fileCategoryEnabled,
    fileCategories:
      config.fileCategories && config.fileCategories.length > 0
        ? hydrateCategories(config.fileCategories, config.dir || defaultDir)
        : buildDefaultCategories(config.dir || defaultDir),
    maxConcurrentDownloads: config.maxConcurrentDownloads ?? D.maxConcurrentDownloads,
    streamMaxConnections: config.streamMaxConnections ?? D.streamMaxConnections,
    sharingMode: (config.keepSharing ?? D.keepSharing) ? 'manual-stop' : 'stop-by-condition',
    shareRatio: config.shareRatio ?? D.shareRatio,
    shareTime: config.shareTime ?? D.shareTime,
    continue: config.continue ?? D.continue,
    maxTries: config.maxTries ?? D.maxTries,
    retryWait: config.retryWait ?? D.retryWait,
    remoteTime: config.remoteTime ?? D.remoteTime,
    maxOverallDownloadLimit: String(config.maxOverallDownloadLimit ?? D.maxOverallDownloadLimit),
    maxOverallUploadLimit: String(config.maxOverallUploadLimit ?? D.maxOverallUploadLimit),
    speedScheduleEnabled: config.speedScheduleEnabled ?? D.speedScheduleEnabled,
    speedScheduleFrom: config.speedScheduleFrom ?? D.speedScheduleFrom,
    speedScheduleTo: config.speedScheduleTo ?? D.speedScheduleTo,
    speedScheduleDays: config.speedScheduleDays ?? D.speedScheduleDays,
    newTaskShowDownloading: config.newTaskShowDownloading ?? D.newTaskShowDownloading,
    noConfirmBeforeDeleteTask: config.noConfirmBeforeDeleteTask ?? D.noConfirmBeforeDeleteTask,
    fileDeletionMode: config.fileDeletionMode ?? D.fileDeletionMode,
    deleteFilesWhenSkipConfirm: config.deleteFilesWhenSkipConfirm ?? D.deleteFilesWhenSkipConfirm,
    taskNotification: config.taskNotification ?? D.taskNotification,
    notifyOnStart: config.notifyOnStart ?? D.notifyOnStart,
    notifyOnComplete: config.notifyOnComplete ?? D.notifyOnComplete,
    shutdownWhenComplete: config.shutdownWhenComplete ?? D.shutdownWhenComplete,
    keepAwake: config.keepAwake ?? D.keepAwake,
    deleteTorrentAfterComplete: config.deleteTorrentAfterComplete ?? false,
    autoDeleteStaleRecords: config.autoDeleteStaleRecords ?? false,
    clearCompletedOnExit: config.clearCompletedOnExit ?? false,
    completedRecordRetentionDays: config.completedRecordRetentionDays ?? D.completedRecordRetentionDays,
  }
}

/**
 * Converts the downloads form into aria2 system config key-value pairs.
 * Only engine-level download params; app-only keys (notifications, cleanup)
 * are excluded.
 */
export function buildDownloadsSystemConfig(f: DownloadsForm): Record<string, string> {
  const keepSharing = f.sharingMode === 'manual-stop'
  return {
    dir: f.dir,
    'max-concurrent-downloads': String(f.maxConcurrentDownloads),
    'stream-max-connections': String(f.streamMaxConnections),
    'max-overall-download-limit': f.maxOverallDownloadLimit,
    'max-overall-upload-limit': f.maxOverallUploadLimit,
    continue: String(f.continue !== false),
    'remote-time': String(!!f.remoteTime),
    'max-tries': String(f.maxTries),
    'retry-wait': String(f.retryWait),
    'seed-ratio': keepSharing ? '0' : String(f.shareRatio),
    'seed-time': keepSharing ? '' : String(f.shareTime),
    'keep-sharing': String(keepSharing),
  }
}

/**
 * Transforms the downloads form for store persistence.
 * Handles the fileCategories auto-populate guard.
 */
export function transformDownloadsForStore(f: DownloadsForm): Partial<AppConfig> {
  const data = { ...f } as Partial<AppConfig> & Record<string, unknown>
  delete data.sharingMode
  data.keepSharing = f.sharingMode === 'manual-stop'

  // Guard: auto-populate default categories when classification is enabled but
  // the categories array is empty (edge case from GitHub issue #229).
  if (f.fileCategoryEnabled && (!f.fileCategories || f.fileCategories.length === 0)) {
    data.fileCategories = buildDefaultCategories(f.dir)
  } else {
    data.fileCategories = f.fileCategories.map(normalizeFileCategory)
  }

  return data
}

export function recordDownloadsDirectory(f: DownloadsForm, recordDirectory: (directory: string) => void): void {
  const directory = f.dir.trim()
  if (!directory) return
  recordDirectory(directory)
}

export function getCompletedRecordRetentionSelectValue(days: number): number {
  return COMPLETED_RECORD_RETENTION_OPTIONS.includes(days as (typeof COMPLETED_RECORD_RETENTION_OPTIONS)[number])
    ? days
    : -1
}

export function resolveCompletedRecordRetentionDays(selectedValue: number, currentDays: number): number {
  if (selectedValue !== -1) return selectedValue
  return currentDays > 0 ? currentDays : 30
}
