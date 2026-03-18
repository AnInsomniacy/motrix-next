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
  announceList?: string[][]
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
  minimizeToTrayOnClose: boolean
  hideDockOnMinimize: boolean
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
  listenPort: number
  dhtListenPort: number
  btTracker: string
  btSaveMetadata: boolean
  btLoadSavedMetadata: boolean
  btForceEncryption: boolean
  followTorrent: boolean
  followMetalink: boolean
  pauseMetadata: boolean
  continue: boolean
  autoCheckUpdateInterval: number
  enableUpnp: boolean
  deleteTorrentAfterComplete: boolean
  autoDeleteStaleRecords: boolean
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

/** A completed/errored download record stored in SQLite, independent from the aria2 session. */
export interface HistoryRecord {
  /** Auto-incremented primary key (present on read, omitted on insert). */
  id?: number
  /** aria2 GID — unique identifier for deduplication. */
  gid: string
  /** Display name of the downloaded file or torrent. */
  name: string
  /** Primary download URI or magnet link. */
  uri?: string
  /** Local directory where the file was saved. */
  dir?: string
  /** Total file size in bytes. */
  total_length?: number
  /** Terminal status: 'complete', 'error', or 'removed'. */
  status: string
  /** Download type: 'uri', 'torrent', or 'metalink'. */
  task_type?: string
  /** ISO 8601 timestamp when the record was created. */
  created_at?: string
  /** ISO 8601 timestamp when the download finished. */
  completed_at?: string
  /** JSON-encoded metadata (BT info hash, torrent source path, etc.). */
  meta?: string
}

/** Aria2 JSON-RPC client API surface consumed by the task store. */
export interface TaskApi {
  fetchTaskList: (params: { type: string }) => Promise<Aria2Task[]>
  fetchTaskItem: (params: { gid: string }) => Promise<Aria2Task>
  fetchTaskItemWithPeers: (params: { gid: string }) => Promise<Aria2Task & { peers: Aria2Peer[] }>
  fetchActiveTaskList: () => Promise<Aria2Task[]>
  addUri: (params: AddUriParams) => Promise<string[]>
  addUriAtomic: (params: { uris: string[]; options: Record<string, string> }) => Promise<string>
  addTorrent: (params: AddTorrentParams) => Promise<string>
  addMetalink: (params: AddMetalinkParams) => Promise<string[]>
  getOption: (params: { gid: string }) => Promise<Record<string, string>>
  changeOption: (params: TaskOptionParams) => Promise<void>
  getFiles: (params: { gid: string }) => Promise<Aria2File[]>
  removeTask: (params: { gid: string }) => Promise<string>
  forcePauseTask: (params: { gid: string }) => Promise<string>
  pauseTask: (params: { gid: string }) => Promise<string>
  resumeTask: (params: { gid: string }) => Promise<string>
  pauseAllTask: () => Promise<string>
  forcePauseAllTask: () => Promise<string>
  resumeAllTask: () => Promise<string>
  batchResumeTask: (params: { gids: string[] }) => Promise<unknown[][]>
  batchPauseTask: (params: { gids: string[] }) => Promise<unknown[][]>
  batchForcePauseTask: (params: { gids: string[] }) => Promise<unknown[][]>
  batchRemoveTask: (params: { gids: string[] }) => Promise<unknown[][]>
  removeTaskRecord: (params: { gid: string }) => Promise<string>
  purgeTaskRecord: () => Promise<string>
  saveSession: () => Promise<string>
}
