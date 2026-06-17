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
  magnetLink?: string
  creationDate?: number
  comment?: string
  mode?: string
}

/** ED2K metadata attached to a task when the download is an ED2K file link. */
export interface Aria2Ed2kInfo {
  ed2kLink?: string
  hash?: string
  name?: string
  length?: string
  completedLength?: string
  partHashCount?: string
  aichRoot?: string
  serverCount?: string
  connectedServerCount?: string
  peerCount?: string
  queuedPeerCount?: string
  acceptedPeerCount?: string
  deadPeerCount?: string
  lowIdPeerCount?: string
  callbackWaitingPeerCount?: string
  kadNodeCount?: string
  kadRouterCount?: string
  kadFirewalled?: boolean
  kadObservedAddressCount?: string
  searchActive?: boolean
  searchMoreResults?: boolean
  searchResultCount?: string
  uploadingPeerCount?: string
  waitingUploadPeerCount?: string
  peerCreditCount?: string
}

export interface Ed2kSearchOptions {
  fileType?: string
  extension?: string
  minSize?: string
  maxSize?: string
  minSourceCount?: string
  minCompleteSourceCount?: string
}

export interface Ed2kSearchResult {
  hash?: string
  name?: string
  length?: string
  sourceCount?: string
  completeSourceCount?: string
  fileType?: string
  extension?: string
  sourceNetwork?: string
  ed2kLink?: string
}

export interface Ed2kSearchResults {
  gid?: string
  status?: string
  moreResults?: boolean
  results?: Ed2kSearchResult[]
  [key: string]: unknown
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
  ed2k?: Aria2Ed2kInfo
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

/** HTTP proxy configuration for download tasks and scoped app requests. */
export interface ProxyConfig {
  mode?: import('@shared/utils/proxyPolicy').EngineProxyMode
  server: string
  username?: string
  password?: string
  bypass?: string
  scope?: string[]
}

/** Result from the `get_system_proxy` Tauri command.
 *  Mirrors the Rust `SystemProxyInfo` struct (camelCase via serde). */
export interface SystemProxyInfo {
  /** Proxy URL, e.g. "http://127.0.0.1:7890" */
  server: string
  /** OS bypass list (comma-separated domains/CIDRs) */
  bypass: string
  /** True when the detected proxy uses a SOCKS protocol (unsupported by aria2) */
  isSocks: boolean
}

export type UpdateChannel = 'stable' | 'beta' | 'latest'
export type ResolvedUpdateChannel = Exclude<UpdateChannel, 'latest'>

/** Clipboard auto-detection filter: controls which protocol families
 *  trigger the "new task" dialog when a URL is detected in the clipboard. */
export interface ClipboardConfig {
  /** Master switch — when false, clipboard detection is fully disabled. */
  enable: boolean
  /** Detect http:// and https:// URLs. */
  http: boolean
  /** Detect ftp:// URLs. */
  ftp: boolean
  /** Detect magnet: URIs. */
  magnet: boolean
  /** Detect ed2k:// file links. */
  ed2k: boolean
  /** Detect thunder:// (迅雷) links. */
  thunder: boolean
  /** Detect bare BitTorrent v1 info hashes (40-char hex / 32-char Base32). */
  btHash: boolean
}

/** Automatic local port conflict recovery policy. */
export interface PortConflictRecoveryConfig {
  enabled: boolean
  rangeStart: number
  rangeEnd: number
  rpc: boolean
  extensionApi: boolean
  bt: boolean
  dht: boolean
  ed2k: boolean
  ed2kUdp: boolean
}

/** A file category rule mapping extensions to a download directory. */
export interface FileCategory {
  /** Display label — i18n key suffix for built-in categories, user-provided name for custom ones. */
  label: string
  /** File extensions (lowercase, no dot prefix) belonging to this category. */
  extensions: string[]
  /** Absolute directory path where matching files are saved. */
  directory: string
  /** Whether this is a built-in category (cannot be deleted, label resolved via i18n). */
  builtIn?: boolean
}

export interface UserAgentProfile {
  id: string
  name: string
  value: string
  createdAt: number
  updatedAt: number
}

export interface UserAgentRule {
  id: string
  enabled: boolean
  hostPattern: string
  profileId: string
  overridePlugin: boolean
  createdAt: number
  updatedAt: number
}

/** Application user preferences with full type coverage. */
export interface AppConfig {
  /** Schema version for config migration. Absent in pre-migration configs (treated as 0). */
  configVersion: number
  /** Last known DB schema version for upgrade toast detection.
   *  Stored in config.json so that existing users (who already have config data)
   *  can be distinguished from fresh installs (who have empty config). */
  dbSchemaVersion: number
  theme: 'auto' | 'light' | 'dark'
  colorScheme: string
  taskCardMode: 'full' | 'compact'
  taskPageSize: number
  locale: string
  dir: string
  split: number
  maxConcurrentDownloads: number
  maxConnectionPerServer: number
  maxOverallDownloadLimit: string
  maxOverallUploadLimit: string
  maxDownloadLimit: string
  maxUploadLimit: string
  /** Whether the Speedometer speed limit toggle is active.
   *  When true, configured limits are applied to aria2 at runtime.
   *  When false, aria2 runs with 0 (unlimited) regardless of configured values. */
  speedLimitEnabled: boolean
  /** Whether the speed schedule is enabled. When true, the scheduler automatically
   *  toggles speedLimitEnabled on/off based on time of day and day of week. */
  speedScheduleEnabled: boolean
  /** Schedule start time in "HH:mm" format (24-hour). */
  speedScheduleFrom: string
  /** Schedule end time in "HH:mm" format (24-hour). Supports overnight spans (e.g. "22:00"→"08:00"). */
  speedScheduleTo: string
  /** Day-of-week bitmask: Mon=1, Tue=2, Wed=4, Thu=8, Fri=16, Sat=32, Sun=64.
   *  0 = every day. Weekdays = 31. Weekends = 96. */
  speedScheduleDays: number
  /** Whether smart file classification is active.
   *  When true, downloads are routed to subdirectories by extension. */
  fileCategoryEnabled: boolean
  /** User-configurable file classification rules. */
  fileCategories: FileCategory[]
  shareTime: number
  shareRatio: number
  btMaxPeers: number
  btDhtEnabled: boolean
  btPeerExchangeEnabled: boolean
  btLocalPeerDiscoveryEnabled: boolean
  openAtLogin: boolean
  autoCheckUpdate: boolean
  autoHideWindow: boolean
  minimizeToTrayOnClose: boolean
  hideDockOnMinimize: boolean
  lightweightMode: boolean
  btTrackerAutoSync: boolean
  btTrackerSyncIntervalHours: number
  keepSharing: boolean
  keepWindowState: boolean

  newTaskShowDownloading: boolean
  noConfirmBeforeDeleteTask: boolean
  deleteFilesWhenSkipConfirm: boolean
  resumeAllWhenAppLaunched: boolean
  taskNotification: boolean
  /** OS notification when a download starts (gated by taskNotification). */
  notifyOnStart: boolean
  /** OS notification when a download completes or BT enters seeding (gated by taskNotification). */
  notifyOnComplete: boolean
  showProgressBar: boolean
  traySpeedometer: boolean
  dockBadgeSpeed: boolean
  logLevel: string
  aria2LogLevel: string
  engineBinPath: string
  /** Directory for internal temporary engine files. Empty means the OS temporary directory. */
  tempFilesDir: string
  cookie: string
  proxy: ProxyConfig
  clipboard: ClipboardConfig
  /** When true, extension-intercepted URI downloads bypass the AddTask dialog. */
  autoSubmitFromExtension: boolean
  /** When true, extension-intercepted BT tasks skip file selection and download every file. */
  autoSelectAllBtFilesFromExtension: boolean
  /** When true, auto-submitted extension downloads are handled in the
   *  background without raising the main window. Only applies when
   *  autoSubmitFromExtension is enabled. */
  silentAutoSubmitFromExtension: boolean
  trackerSource: string[]
  customTrackerUrls: string[]
  historyDirectories: string[]
  favoriteDirectories: string[]
  lastCheckUpdateTime: number
  lastSyncTrackerTime: number
  /** Linux-only: opt into DMA-BUF GPU hardware rendering (default: false = software). */
  hardwareRendering: boolean
  updateChannel: UpdateChannel
  runMode: string
  userAgent: string
  userAgentProfiles: UserAgentProfile[]
  userAgentRules: UserAgentRule[]
  recentUserAgentProfileIds: string[]
  rpcListenPort: number
  /** Port for the embedded HTTP API that browser extensions use to submit
   *  downloads. Defaults to 29110. */
  extensionApiPort: number
  /** Shared secret for the extension HTTP API. The browser extension must
   *  send this as a `Bearer` token in the `Authorization` header.
   *  Empty string means the user intentionally cleared it. */
  extensionApiSecret: string
  /** Shared secret for the aria2 RPC API. Empty string means the user intentionally cleared it. */
  rpcSecret: string
  /** When true, aria2 RPC and the extension API listen on all network interfaces. */
  allowRemoteAccess: boolean
  /** Automatically switches locally bound ports when another process or OS reservation blocks them. */
  autoChangeConflictingPorts: boolean
  portConflictRecovery: PortConflictRecoveryConfig
  listenPort: number
  dhtListenPort: number
  ed2kListenPort: number
  ed2kUdpListenPort: number
  ed2kServer: string
  ed2kServerMetUrl: string
  ed2kNodesDatUrl: string
  ed2kBootstrapAutoSync: boolean
  ed2kBootstrapSyncIntervalHours: number
  ed2kUploadSlots: number
  ed2kSearchTimeout: number
  btTracker: string
  btForceEncryption: boolean
  pauseMetadata: boolean
  continue: boolean
  /** When true, aria2 applies the remote server's Last-Modified timestamp
   *  to the local file instead of using the download-completion time. */
  remoteTime: boolean
  autoCheckUpdateInterval: number
  enableUpnp: boolean
  deleteTorrentAfterComplete: boolean
  autoDeleteStaleRecords: boolean
  clearCompletedOnExit: boolean
  /** Completed history retention in days. 0 means keep forever. */
  completedRecordRetentionDays: number
  /** When true, the system shuts down after all downloads complete. */
  shutdownWhenComplete: boolean
  /** When true, prevents system idle sleep while downloads are active.
   *  Uses OS-native APIs: macOS IOPMAssertion, Windows SetThreadExecutionState,
   *  Linux systemd Inhibit. */
  keepAwake: boolean
  /** Maximum number of retries per download (0 = unlimited). Maps to aria2 --max-tries. */
  maxTries: number
  /** Seconds to wait between retries after HTTP 503 or similar errors. Maps to aria2 --retry-wait. */
  retryWait: number
  /** Seconds to wait when establishing a connection. Maps to aria2 --connect-timeout. */
  connectTimeout: number
  /** Seconds to wait for data transfer after connection is established. Maps to aria2 --timeout. */
  timeout: number
  /** Disk space pre-allocation method. Maps to aria2 --file-allocation.
   *  Values: 'none' | 'trunc' | 'prealloc' | 'falloc' */
  fileAllocation: string
  /** Enables c-ares based asynchronous DNS resolution. Maps to aria2 --async-dns. */
  asyncDns: boolean
  /** Per-tab sort configuration (field + direction), persisted independently per tab. */
  taskSort: import('@/composables/useTaskSort').TaskSortConfig
  /** Per-tab manual task order. Unknown tasks are inserted above stored tasks. */
  taskManualOrder: import('@/composables/useTaskSort').TaskManualOrderConfig
  [key: string]: unknown
}

/** Aria2 engine option dictionary passed to RPC calls (kebab-case keys after formatting). */
export interface Aria2EngineOptions {
  [key: string]: string | string[] | undefined
}

export interface BrowserRequestHeader {
  name: string
  value: string
}

export interface ExternalDownloadContext {
  url?: string
  finalUrl?: string
  referer?: string
  cookie?: string
  userAgent?: string
  requestHeaders?: BrowserRequestHeader[]
  traceId?: string
}

export interface ExternalDownloadInput extends ExternalDownloadContext {
  url: string
  finalUrl?: string
  filename?: string
  source?: string
}

/** Saved HTTP Basic authentication credential scoped to a normalized URL origin. */
export interface HttpAuthCredential {
  id: number
  origin: string
  username: string
  password: string
  created_at?: string
  updated_at?: string
  last_used_at?: string | null
}

export interface HttpAuthInput {
  url: string
  username: string
  password: string
}

/** Parameters for adding a URI-based download task. */
export interface AddUriParams {
  uris: string[]
  outs: string[]
  options: Aria2EngineOptions
  /** Optional file classification config for per-URI directory routing. */
  fileCategory?: { enabled: boolean; categories: FileCategory[] }
}

/** Parameters for adding a torrent-based download task. */
export interface AddTorrentParams {
  torrent: string
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
  channel: ResolvedUpdateChannel
  requestedChannel: UpdateChannel
}

// ── Batch Add Task ──────────────────────────────────────────────────

export type BatchItemKind = 'uri' | 'torrent'
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
  /** URI text (for uri kind) or base64-encoded file content (for torrent). */
  payload: string
  /** Browser request context captured by the extension for this item. */
  browserContext?: ExternalDownloadContext
  /** Parsed torrent metadata — only present for torrent items. */
  torrentMeta?: { infoHash: string; files: { idx: number; path: string; length: number }[] }
  /** Selected file indices for torrent selective download. */
  selectedFileIndices?: number[]
  status: BatchItemStatus
  /** Error message when status is 'failed'. */
  error?: string
}

/** Per-file snapshot stored in HistoryMeta.files for multi-file task reconstruction.
 *
 * Captures all data needed to fully restore restart, delete, and stale-cleanup
 * semantics for each individual file within a multi-file download. */
export interface HistoryFileSnapshot {
  /** Full local file path. */
  path: string
  /** File size as string (aria2 convention). */
  length?: string
  /** Whether the file was selected for download ("true"/"false"). */
  selected?: string
  /** All download URIs for this file — preserving mirrors, not just the first. */
  uris: string[]
}

/** Structured meta payload stored as JSON in HistoryRecord.meta.
 *
 * This is the single source of truth for multi-file task reconstruction.
 * All consumers MUST use the centralized helpers in useTaskLifecycle.ts:
 * - buildHistoryMeta()  — write path
 * - parseHistoryMeta()  — read path
 * - extractHistoryFilePaths() — stale cleanup */
export interface HistoryMeta {
  /** BT info hash — used for magnet link reconstruction on restart. */
  infoHash?: string
  /** Engine-serialized BT magnet link. */
  magnetLink?: string
  /** Engine-serialized ED2K file link. */
  ed2kLink?: string
  /** BT announce tiers — used to restore tracker-aware magnet restart links. */
  announceList?: string[][]
  /** Complete file list with all URIs — present when files.length > 1. */
  files?: HistoryFileSnapshot[]
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
  /** Download type: 'uri' or 'torrent'. */
  task_type?: string
  /** ISO 8601 timestamp when the task was first added to the download queue.
   *  Once set, never changes — used for position-stable ordering across all tabs. */
  added_at?: string
  /** ISO 8601 timestamp when the record was created. */
  created_at?: string
  /** ISO 8601 timestamp when the download finished. */
  completed_at?: string
  /** JSON-encoded metadata (BT info hash, torrent source path, etc.). */
  meta?: string
}

/** Aria2 JSON-RPC client API surface consumed by the task store. */
export interface TaskApi {
  fetchTaskList: (params: { type: string; limit?: number }) => Promise<Aria2Task[]>
  fetchTaskItem: (params: { gid: string }) => Promise<Aria2Task>
  fetchTaskItemWithPeers: (params: { gid: string }) => Promise<Aria2Task & { peers: Aria2Peer[] }>
  fetchActiveTaskList: () => Promise<Aria2Task[]>
  addUri: (params: AddUriParams) => Promise<string[]>
  addUriAtomic: (params: { uris: string[]; options: Aria2EngineOptions }) => Promise<string>
  addTorrent: (params: AddTorrentParams) => Promise<string>
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
