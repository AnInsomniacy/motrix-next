/**
 * @fileoverview Pure functions extracted from Basic.vue for testability.
 *
 * Contains the basic preference form building and system config transforms.
 * The btAutoDownloadContent ↔ followTorrent/followMetalink/pauseMetadata
 * mapping is the key business logic tested here.
 */
import type { AppConfig } from '@shared/types'
import { DEFAULT_APP_CONFIG as D } from '@shared/constants'

// ── Types ───────────────────────────────────────────────────────────

export interface BasicForm {
  [key: string]: unknown
  autoCheckUpdate: boolean
  autoCheckUpdateInterval: number
  updateChannel: string
  dir: string
  locale: string
  theme: string
  openAtLogin: boolean
  keepWindowState: boolean
  resumeAllWhenAppLaunched: boolean
  autoHideWindow: boolean
  minimizeToTrayOnClose: boolean
  hideDockOnMinimize: boolean
  showProgressBar: boolean
  traySpeedometer: boolean
  dockBadgeSpeed: boolean
  taskNotification: boolean
  newTaskShowDownloading: boolean
  noConfirmBeforeDeleteTask: boolean
  maxConcurrentDownloads: number
  maxConnectionPerServer: number
  maxOverallDownloadLimit: string
  maxOverallUploadLimit: string
  btAutoDownloadContent: boolean
  btForceEncryption: boolean
  keepSeeding: boolean
  seedRatio: number
  seedTime: number
  continue: boolean
  deleteTorrentAfterComplete: boolean
  autoDeleteStaleRecords: boolean
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Builds the basic form state from the preference store config.
 * All fallback values reference DEFAULT_APP_CONFIG (single source of truth).
 * The btAutoDownloadContent field merges three separate config values.
 */
export function buildBasicForm(config: AppConfig, defaultDir: string = ''): BasicForm {
  const followTorrent = config.followTorrent ?? D.followTorrent
  const followMetalink = config.followMetalink ?? D.followMetalink
  const pauseMetadata = config.pauseMetadata ?? D.pauseMetadata
  const btAutoDownloadContent = followTorrent && followMetalink && !pauseMetadata

  return {
    autoCheckUpdate: config.autoCheckUpdate ?? D.autoCheckUpdate,
    autoCheckUpdateInterval: config.autoCheckUpdateInterval ?? D.autoCheckUpdateInterval,
    updateChannel: config.updateChannel ?? D.updateChannel,
    dir: config.dir || defaultDir,
    locale: config.locale || 'en-US',
    theme: config.theme ?? D.theme,
    openAtLogin: config.openAtLogin ?? D.openAtLogin,
    keepWindowState: config.keepWindowState ?? D.keepWindowState,
    resumeAllWhenAppLaunched: config.resumeAllWhenAppLaunched ?? D.resumeAllWhenAppLaunched,
    autoHideWindow: config.autoHideWindow ?? D.autoHideWindow,
    minimizeToTrayOnClose: config.minimizeToTrayOnClose ?? D.minimizeToTrayOnClose,
    hideDockOnMinimize: config.hideDockOnMinimize ?? D.hideDockOnMinimize,
    showProgressBar: config.showProgressBar ?? D.showProgressBar,
    traySpeedometer: config.traySpeedometer ?? D.traySpeedometer,
    dockBadgeSpeed: config.dockBadgeSpeed ?? D.dockBadgeSpeed,
    taskNotification: config.taskNotification ?? D.taskNotification,
    newTaskShowDownloading: config.newTaskShowDownloading ?? D.newTaskShowDownloading,
    noConfirmBeforeDeleteTask: config.noConfirmBeforeDeleteTask ?? D.noConfirmBeforeDeleteTask,
    maxConcurrentDownloads: config.maxConcurrentDownloads ?? D.maxConcurrentDownloads,
    maxConnectionPerServer: config.maxConnectionPerServer ?? D.maxConnectionPerServer,
    maxOverallDownloadLimit: String(config.maxOverallDownloadLimit ?? D.maxOverallDownloadLimit),
    maxOverallUploadLimit: String(config.maxOverallUploadLimit ?? D.maxOverallUploadLimit),
    btAutoDownloadContent,
    btForceEncryption: config.btForceEncryption ?? D.btForceEncryption,
    keepSeeding: config.keepSeeding ?? D.keepSeeding,
    seedRatio: config.seedRatio ?? D.seedRatio,
    seedTime: config.seedTime ?? D.seedTime,
    continue: config.continue ?? D.continue,
    deleteTorrentAfterComplete: config.deleteTorrentAfterComplete ?? false,
    autoDeleteStaleRecords: config.autoDeleteStaleRecords ?? false,
  }
}

/**
 * Converts the basic form into aria2 system config key-value pairs.
 * Handles the btAutoDownloadContent → follow-torrent/follow-metalink/pause-metadata expansion.
 */
export function buildBasicSystemConfig(f: BasicForm): Record<string, string> {
  const autoContent = !!f.btAutoDownloadContent
  return {
    dir: f.dir,
    'max-concurrent-downloads': String(f.maxConcurrentDownloads),
    'max-connection-per-server': String(f.maxConnectionPerServer),
    split: String(f.maxConnectionPerServer),
    'max-overall-download-limit': f.maxOverallDownloadLimit,
    'max-overall-upload-limit': f.maxOverallUploadLimit,
    'bt-save-metadata': 'true',
    'bt-load-saved-metadata': 'true',
    'bt-force-encryption': String(!!f.btForceEncryption),
    'seed-ratio': String(f.seedRatio),
    'seed-time': String(f.seedTime),
    'keep-seeding': String(!!f.keepSeeding),
    'follow-torrent': String(autoContent),
    'follow-metalink': String(autoContent),
    'pause-metadata': String(!autoContent),
    continue: String(f.continue !== false),
  }
}

/**
 * Transforms the basic form for store persistence.
 * Expands btAutoDownloadContent back into followTorrent/followMetalink/pauseMetadata.
 * Syncs split and engineMaxConnectionPerServer to maxConnectionPerServer so that
 * AddTask.vue and the engine startup args always use the user's chosen value.
 */
export function transformBasicForStore(f: BasicForm): Partial<AppConfig> {
  const data = { ...f } as Partial<AppConfig> & Record<string, unknown>
  delete data.btAutoDownloadContent
  // Keep split and engineMaxConnectionPerServer in sync with the user-facing value
  data.split = f.maxConnectionPerServer
  data.engineMaxConnectionPerServer = f.maxConnectionPerServer
  if (f.btAutoDownloadContent) {
    data.followTorrent = true
    data.followMetalink = true
    data.pauseMetadata = false
  } else {
    data.followTorrent = false
    data.followMetalink = false
    data.pauseMetadata = true
  }
  return data
}
