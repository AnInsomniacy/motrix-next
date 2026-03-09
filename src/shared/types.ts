/** @fileoverview Core type definitions for Aria2 JSON-RPC responses and application configuration. */

/** Task lifecycle status as reported by aria2 RPC. */
export type TaskStatus = 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'

/** URI entry within an aria2 file descriptor. */
export interface Aria2FileUri {
  uri: string
  status: string
}

/** Single file within an aria2 download task, as returned by tellStatus. */
export interface Aria2File {
  index: string
  path: string
  length: string
  completedLength: string
  /** Whether the file is selected for download ("true" or "false" as string). */
  selected: string
  uris: Aria2FileUri[]
}

/** BitTorrent metadata attached to a task when the download is a torrent. */
export interface Aria2BtInfo {
  info?: { name: string }
  announceList?: string[]
  creationDate?: number
  comment?: string
  mode?: string
}

/** Remote peer information for an active BitTorrent task. */
export interface Aria2Peer {
  peerId: string
  ip: string
  port: string
  bitfield: string
  amChoking: string
  peerChoking: string
  downloadSpeed: string
  uploadSpeed: string
  seeder: string
}

/**
 * Complete aria2 task object returned by tellStatus, tellActive, tellWaiting, or tellStopped.
 * All numeric values are represented as strings per the aria2 JSON-RPC protocol.
 */
export interface Aria2Task {
  gid: string
  status: TaskStatus
  totalLength: string
  completedLength: string
  uploadLength: string
  downloadSpeed: string
  uploadSpeed: string
  connections: string
  dir: string
  files: Aria2File[]
  bittorrent?: Aria2BtInfo
  infoHash?: string
  numSeeders?: string
  seeder?: string
  bitfield?: string
  errorCode?: string
  errorMessage?: string
  numPieces?: string
  pieceLength?: string
  verifiedLength?: string
  verifyIntegrityPending?: string
  peers?: Aria2Peer[]
  followedBy?: string[]
  following?: string
  belongsTo?: string
}

/** Parsed global statistics with numeric values (post-conversion from string). */
export interface Aria2GlobalStat {
  downloadSpeed: number
  uploadSpeed: number
  numActive: number
  numWaiting: number
  numStopped: number
}

/** Engine version information returned by aria2.getVersion. */
export interface Aria2Version {
  version: string
  enabledFeatures: string[]
}

/** Raw global statistics as returned by aria2 RPC (all values are strings). */
export interface Aria2RawGlobalStat {
  downloadSpeed: string
  uploadSpeed: string
  numActive: string
  numWaiting: string
  numStopped: string
  numStoppedTotal: string
  [key: string]: string
}

/** HTTP/SOCKS proxy configuration for aria2 and tracker requests. */
export interface ProxyConfig {
  enable: boolean
  server: string
  bypass?: string
  scope?: string[]
}

/** Protocol handler registration settings (system-level). */
export interface ProtocolsConfig {
  magnet: boolean
  thunder: boolean
}

/** Close-action behavior when the user closes the app window. */
export type CloseAction = 'ask' | 'minimize' | 'quit'

/** Application user preferences with full type coverage. */
export interface AppConfig {
  theme: 'auto' | 'light' | 'dark'
  locale: string
  dir: string
  split: number
  maxConcurrentDownloads: number
  maxConnectionPerServer: number
  maxOverallDownloadLimit: string
  maxOverallUploadLimit: string
  maxDownloadLimit: string
  maxUploadLimit: string
  seedTime: number
  seedRatio: number
  openAtLogin: boolean
  autoCheckUpdate: boolean
  autoHideWindow: boolean
  closeAction: CloseAction
  autoSyncTracker: boolean
  keepSeeding: boolean
  keepWindowState: boolean
  newTaskShowDownloading: boolean
  noConfirmBeforeDeleteTask: boolean
  resumeAllWhenAppLaunched: boolean
  taskNotification: boolean
  showProgressBar: boolean
  traySpeedometer: boolean
  dockBadgeSpeed: boolean
  hideAppMenu: boolean
  useNativeTrafficLights: boolean
  logLevel: string
  engineBinPath: string
  engineMaxConnectionPerServer: number
  cookie: string
  proxy: ProxyConfig
  protocols: ProtocolsConfig
  trackerSource: string[]
  historyDirectories: string[]
  favoriteDirectories: string[]
  lastCheckUpdateTime: number
  lastSyncTrackerTime: number
  updateChannel: 'stable' | 'beta'
  runMode: string
  userAgent: string
  rpcListenPort: number
  rpcSecret: string
  listenPort: string
  dhtListenPort: string
  btTracker: string
  btSaveMetadata: boolean
  btForceEncryption: boolean
  followTorrent: boolean
  followMetalink: boolean
  pauseMetadata: boolean
  continue: boolean
  autoCheckUpdateInterval: number
  enableUpnp: boolean
  [key: string]: unknown
}

/** Aria2 engine option dictionary passed to RPC calls (kebab-case keys after formatting). */
export interface Aria2EngineOptions {
  [key: string]: string | string[] | undefined
}

/** Parameters for adding a URI-based download task. */
export interface AddUriParams {
  uris: string[]
  outs: string[]
  options: Aria2EngineOptions
}

/** Parameters for adding a torrent-based download task. */
export interface AddTorrentParams {
  torrent: string
  options: Aria2EngineOptions
}

/** Parameters for adding a metalink-based download task. */
export interface AddMetalinkParams {
  metalink: string
  options: Aria2EngineOptions
}

/** Parameters for changing options on an existing task. */
export interface TaskOptionParams {
  gid: string
  options: Aria2EngineOptions
}

/** Aria2File enriched with a parsed file extension (used by file filter utilities). */
export interface EnrichedFile extends Aria2File {
  extension?: string
}

/** Update metadata returned by the Rust `check_for_update` command. */
export interface TauriUpdate {
  version: string
  body: string | null
  date: string | null
}

// ── Batch Add Task ──────────────────────────────────────────────────

export type BatchItemKind = 'uri' | 'torrent' | 'metalink'
export type BatchItemStatus = 'pending' | 'submitted' | 'failed'

/** A single item in the add-task batch queue. */
export interface BatchItem {
  /** Unique identifier for this batch entry. */
  id: string
  kind: BatchItemKind
  /** Original source path or URI. */
  source: string
  /** Human-readable display name (filename or truncated URI). */
  displayName: string
  /** URI text (for uri kind) or base64-encoded file content (for torrent/metalink). */
  payload: string
  /** Parsed torrent metadata — only present for torrent items. */
  torrentMeta?: { infoHash: string; files: { idx: number; path: string; length: number }[] }
  /** Selected file indices for torrent selective download. */
  selectedFileIndices?: number[]
  status: BatchItemStatus
  /** Error message when status is 'failed'. */
  error?: string
}
