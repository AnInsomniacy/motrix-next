/** @fileoverview Application-wide constants: themes, intervals, suffixes, limits. */
import { DEFAULT_TASK_MANUAL_ORDER, DEFAULT_TASK_SORT } from '@/composables/useTaskSort'
import type { AppLogLevel, Aria2LogLevel } from '@shared/types'
export const EMPTY_STRING = ''
export const IS_PORTABLE = false

export const APP_THEME = {
  AUTO: 'auto',
  LIGHT: 'light',
  DARK: 'dark',
}

/** Color scheme definition for the preset palette picker. */
export interface ColorSchemeDefinition {
  /** Unique identifier stored in config (kebab-case). */
  id: string
  /** i18n key suffix: `preferences.color-scheme-{id}` */
  labelKey: string
  /** Seed hex fed to MCU `themeFromSourceColor` to generate the full M3 tonal palette. */
  seed: string
  /** Palette generation mode. Content keeps low-chroma colors visually neutral. */
  variant?: 'source' | 'content'
}

/**
 * 10 curated preset color schemes spanning warm, cool, and neutral hues.
 *
 * Each seed is chosen for:
 * - Even HSL hue distribution (~36° apart) to avoid clustering
 * - WCAG AA contrast compliance when MCU-generated
 * - Aesthetic harmony across both light and dark M3 surfaces
 *
 * Sources: Tailwind CSS v4, macOS system colors, Catppuccin/Nord,
 * M3 Material Theme Builder, color psychology research.
 */
export const COLOR_SCHEMES: ColorSchemeDefinition[] = [
  { id: 'amber', labelKey: 'preferences.color-scheme-amber', seed: '#E0A422' },
  { id: 'space', labelKey: 'preferences.color-scheme-space', seed: '#4A6CF7' },
  { id: 'mint', labelKey: 'preferences.color-scheme-mint', seed: '#10B981' },
  { id: 'rose', labelKey: 'preferences.color-scheme-rose', seed: '#F43F5E' },
  { id: 'aurora', labelKey: 'preferences.color-scheme-aurora', seed: '#8B5CF6' },
  { id: 'coral', labelKey: 'preferences.color-scheme-coral', seed: '#F97316' },
  { id: 'glacier', labelKey: 'preferences.color-scheme-glacier', seed: '#06B6D4' },
  { id: 'evergreen', labelKey: 'preferences.color-scheme-evergreen', seed: '#15803D' },
  { id: 'graphite', labelKey: 'preferences.color-scheme-graphite', seed: '#737373', variant: 'content' },
  { id: 'sakura', labelKey: 'preferences.color-scheme-sakura', seed: '#EC4899' },
]

export const CUSTOM_COLOR_SCHEME_ID = 'custom'
export const DEFAULT_CUSTOM_COLOR_SCHEME = '#737373'

export const APP_RUN_MODE = {
  STANDARD: 1,
  TRAY: 2,
  HIDE_TRAY: 3,
}

export const ADD_TASK_TYPE = {
  URI: 'uri',
  TORRENT: 'torrent',
}

export const TASK_STATUS = {
  ACTIVE: 'active',
  WAITING: 'waiting',
  PAUSED: 'paused',
  ERROR: 'error',
  COMPLETE: 'complete',
  REMOVED: 'removed',
  SHARING: 'sharing',
}

export const APP_LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const satisfies readonly AppLogLevel[]
export const ARIA2_LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const satisfies readonly Aria2LogLevel[]

export const MAX_NUM_OF_DIRECTORIES = 5

export const ENGINE_RPC_HOST = '127.0.0.1'
export const ENGINE_RPC_PORT = 29100
export const EXTENSION_API_PORT = 29110
export const BT_LISTEN_PORT = 29120
export const DHT_LISTEN_PORT = 29130
export const ED2K_LISTEN_PORT = 29140
export const ED2K_UDP_LISTEN_PORT = 29150
export const ED2K_SERVER_MET_URL = 'https://upd.emule-security.org/server.met'
export const ED2K_NODES_DAT_URL = 'https://upd.emule-security.org/nodes.dat'
export const BT_PEER_BLOCKLIST_URL = 'https://bcr.pbh-btn.com/combine/all.txt'
export const PORT_RECOVERY_RANGE_START = 29000
export const PORT_RECOVERY_RANGE_END = 29999
export const ENGINE_MAX_CONCURRENT_DOWNLOADS = 100
export const ENGINE_MAX_CONNECTION_PER_SERVER = 256
export const ENGINE_DEFAULT_CONNECTION_PER_SERVER = 64
export const ENGINE_DEFAULT_SPLIT = 64
export const ENGINE_DEFAULT_BT_MAX_PEERS = 128
export const ENGINE_MAX_BT_MAX_PEERS = 500

// Safe thresholds — values above these trigger a user confirmation warning.
// These are "recommended" values displayed in UI labels; exceeding them is allowed
// but requires explicit opt-in via a warning dialog.
export const SAFE_LIMIT_SPLIT = 64
export const SAFE_LIMIT_CONNECTION_PER_SERVER = 64
export const SAFE_LIMIT_BT_MAX_PEERS = 128

export const UNKNOWN_PEERID = '%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00'
export const UNKNOWN_PEERID_NAME = 'unknown'
export const GRAPHIC = '░▒▓█'

export const ONE_SECOND = 1000
export const ONE_MINUTE = ONE_SECOND * 60
export const ONE_HOUR = ONE_MINUTE * 60
export const ONE_DAY = ONE_HOUR * 24
export const COMPLETED_RECORD_RETENTION_FOREVER = 0
export const COMPLETED_RECORD_RETENTION_OPTIONS = [0, 1, 7, 180, 365] as const

// One Week
export const AUTO_CHECK_UPDATE_INTERVAL = ONE_DAY * 7

export const UPDATE_CHANNELS = ['stable', 'beta', 'latest'] as const

/**
 * Factory default values for every AppConfig field.
 * **This is the single source of truth** for both first-launch initialization
 * and the "Restore Defaults" action. All fallbacks in buildGeneralForm(),
 * buildDownloadsForm(), buildBtForm(), buildNetworkForm(), and
 * buildAdvancedForm() must reference these values via `?? D.field`.
 *
 * Each value is justified by industry research:
 * - aria2 official defaults (concurrent=5, split=5, conn/server=1)
 * - BT client conventions (qBittorrent, Transmission, Deluge)
 * - Download manager standards (IDM, FDM, Motrix)
 * - Security best practices (UPnP off, rpcSecret generated at runtime)
 *
 * Dynamic values handled at runtime:
 * - `locale: ''`    → OS locale detection in main.ts
 * - `dir: ''`       → user-visible download directory resolver at runtime
 * - `rpcSecret`     → ABSENT from defaults; auto-generated on first launch in main.ts
 */

/** Day-of-week bitmask constants for speed schedule. Mon=1 … Sun=64. */
export const SCHEDULE_DAY = {
  MON: 1,
  TUE: 2,
  WED: 4,
  THU: 8,
  FRI: 16,
  SAT: 32,
  SUN: 64,
  /** Every day (special sentinel — checked first, bypasses bitmask). */
  EVERY_DAY: 0,
  /** Monday–Friday. */
  WEEKDAYS: 1 + 2 + 4 + 8 + 16, // 31
  /** Saturday–Sunday. */
  WEEKENDS: 32 + 64, // 96
} as const

/** Built-in file category templates for smart path classification (Issue #94).
 *  Extensions are lowercase without dot prefix.  `subdirName` is a fixed English
 *  directory name (filesystem paths should not change with locale).
 *  Use `buildDefaultCategories(baseDir)` to produce runtime FileCategory[]. */
export const BUILTIN_CATEGORY_TEMPLATES = [
  {
    label: 'file-category-videos',
    extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'ts', 'm4v', 'rmvb'],
    subdirName: 'Videos',
  },
  {
    label: 'file-category-music',
    extensions: ['mp3', 'flac', 'aac', 'ogg', 'wav', 'wma', 'm4a', 'opus', 'ape'],
    subdirName: 'Music',
  },
  {
    label: 'file-category-images',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'psd', 'raw'],
    subdirName: 'Images',
  },
  {
    label: 'file-category-documents',
    extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'epub', 'md', 'rtf'],
    subdirName: 'Documents',
  },
  {
    label: 'file-category-archives',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'dmg', 'iso', 'zst'],
    subdirName: 'Archives',
  },
  {
    label: 'file-category-programs',
    extensions: ['exe', 'msi', 'deb', 'rpm', 'appimage', 'pkg', 'apk', 'snap'],
    subdirName: 'Programs',
  },
] as const

/** Builds the default FileCategory[] with absolute directory paths derived from `baseDir`.
 *  Called when the user first enables classification or clicks "Restore Defaults". */
export function buildDefaultCategories(baseDir: string): import('@shared/types').FileCategory[] {
  const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return BUILTIN_CATEGORY_TEMPLATES.map((t) => ({
    label: t.label,
    extensions: [...t.extensions],
    directory: `${normalizedBase}/${t.subdirName}`,
    builtIn: true,
  }))
}

/** Maximum number of file categories a user can create (built-in + custom). */
export const MAX_FILE_CATEGORIES = 20

/** Set of built-in category label keys — used to hydrate the `builtIn` flag
 *  on categories loaded from persisted config (which may lack the field). */
export const BUILTIN_CATEGORY_LABELS: ReadonlySet<string> = new Set(BUILTIN_CATEGORY_TEMPLATES.map((t) => t.label))

/** Latest registered SQLite migration version for history.db.
 *  Keep this in sync with tauri_plugin_sql migrations in src-tauri/src/lib.rs
 *  and REGISTERED_VERSIONS in src-tauri/src/db_guard.rs. */
export const CURRENT_DB_SCHEMA_VERSION = 3

/** Official, independently hosted tracker-list sources. */
export const TRACKER_SOURCE_OPTIONS = [
  {
    owner: 'ngosang',
    repository: 'trackerslist',
    value: 'https://ngosang.github.io/trackerslist/trackers_best.txt',
  },
  {
    owner: 'XIU2',
    repository: 'TrackersListCollection',
    value: 'https://cf.trackerslist.com/best.txt',
  },
] as const

export const DEFAULT_TRACKER_SOURCE = TRACKER_SOURCE_OPTIONS.map((source) => source.value)

export const DEFAULT_APP_CONFIG = {
  configVersion: 5,
  dbSchemaVersion: CURRENT_DB_SCHEMA_VERSION,
  // ── Appearance ──────────────────────────────────────────────────
  theme: 'auto' as const,
  colorScheme: 'amber',
  customColorScheme: DEFAULT_CUSTOM_COLOR_SCHEME,
  taskCardMode: 'full' as const,
  reduceMotion: false,
  taskListWatermark: true,
  sidebarTaskCounts: true,
  taskPageSize: 20,
  locale: 'auto',

  // ── Download Core ─────────────────────────────────────────────────
  dir: '',
  split: ENGINE_DEFAULT_SPLIT, // parallel segments per file; independent of maxConnectionPerServer since v2
  maxConcurrentDownloads: 6,
  maxConnectionPerServer: ENGINE_DEFAULT_CONNECTION_PER_SERVER, // per-server connection cap; independent of split since v2
  maxOverallDownloadLimit: '0',
  maxOverallUploadLimit: '0',
  speedLimitEnabled: false,
  speedScheduleEnabled: false,
  speedScheduleFrom: '08:00',
  speedScheduleTo: '18:00',
  speedScheduleDays: 0, // 0 = every day
  maxDownloadLimit: '',
  maxUploadLimit: '',

  // ── File Classification (IDM-style pre-download routing) ──────
  fileCategoryEnabled: false, // opt-in: does not affect existing users until enabled
  fileCategories: [] as import('@shared/types').FileCategory[],

  // ── P2P Sharing (BT + ED2K) ────────────────────────────────────
  shareRatio: 2, // Transmission/qBT-style default for healthy P2P contribution
  shareTime: 2880, // 48h default sharing window
  keepSharing: false, // stop by condition by default

  // ── BitTorrent (qBT/Transmission/Deluge conventions) ──────────
  btMaxPeers: ENGINE_DEFAULT_BT_MAX_PEERS, // aria2 default=55; qBT=100, Transmission=60, Deluge=200
  btDhtIpv4Enabled: true, // improves peer discovery; also enables UDP tracker support
  btDhtIpv6Enabled: true, // restores IPv6 DHT peer discovery
  btPeerExchangeEnabled: true, // improves peer discovery inside active swarms
  btLocalPeerDiscoveryEnabled: true, // aria2.conf legacy default; helps LAN peers
  btForceEncryption: false, // qBT default "Allow", not "Force"; forcing reduces peers
  pauseMetadata: true, // pause follow-up download after metadata — let user select files first
  continue: true, // aria2 default=true; resume incomplete downloads
  remoteTime: false, // aria2 default=false; file timestamp = download completion time

  // ── Interface & Behavior ──────────────────────────────────────
  openAtLogin: false, // never auto-start on first install
  keepWindowState: false, // first launch has no saved state

  autoHideWindow: false,
  minimizeToTrayOnClose: false, // close=quit is default UX
  hideDockOnMinimize: false, // macOS: hide Dock icon when minimized to tray
  lightweightMode: false, // destroy WebView on minimize-to-tray to free ~300MB RAM
  showProgressBar: true,
  traySpeedometer: false, // opt-in: supported on macOS menu bar + Linux appindicator
  dockBadgeSpeed: true, // macOS Dock badge on by default
  taskNotification: true, // users expect download-complete notifications
  notifyOnStart: true,
  notifyOnComplete: true, // main value of OS notification: background completion alert
  newTaskShowDownloading: true, // auto-navigate to downloads after adding task
  noConfirmBeforeDeleteTask: false, // require confirmation to prevent accidental deletion
  fileDeletionMode: 'trash' as const,
  deleteFilesWhenSkipConfirm: false, // when skip-confirm is on, default to keeping files (safe)
  resumeAllWhenAppLaunched: false, // don't flood bandwidth on launch

  // ── Auto Update ───────────────────────────────────────────────
  autoCheckUpdate: true, // qBT checks every launch; security best practice
  autoCheckUpdateInterval: 0, // 0 means every frontend startup, including lightweight restores
  /** Linux-only: DMA-BUF GPU rendering is opt-in for Wayland/WebKitGTK stability. */
  hardwareRendering: false,
  updateChannel: 'stable' as const,
  lastCheckUpdateTime: 0,

  // ── Network & Security ────────────────────────────────────────
  enableUpnp: true, // old Motrix=true; required for BitTorrent behind NAT
  rpcListenPort: ENGINE_RPC_PORT,
  extensionApiPort: EXTENSION_API_PORT,
  allowRemoteAccess: false,
  autoChangeConflictingPorts: true,
  portConflictRecovery: {
    enabled: true,
    rangeStart: PORT_RECOVERY_RANGE_START,
    rangeEnd: PORT_RECOVERY_RANGE_END,
    rpc: true,
    extensionApi: true,
    bt: true,
    dht: true,
    ed2k: true,
    ed2kUdp: true,
  },
  // extensionApiSecret is intentionally ABSENT from defaults.
  // rpcSecret is intentionally ABSENT from defaults.
  // For both secrets:
  //   undefined → main.ts auto-generates on first launch.
  //   '' → user intentionally cleared (respected, not regenerated).
  //   'abc' → user-set or auto-generated secret (kept as-is).
  listenPort: BT_LISTEN_PORT,
  btExternalIp: '',
  btExternalPort: 0,
  dhtListenPort: DHT_LISTEN_PORT,
  ed2kListenPort: ED2K_LISTEN_PORT,
  ed2kUdpListenPort: ED2K_UDP_LISTEN_PORT,
  ed2kServer: '',
  ed2kServerMetUrl: ED2K_SERVER_MET_URL,
  ed2kNodesDatUrl: ED2K_NODES_DAT_URL,
  ed2kUploadSlots: 3,
  ed2kSearchTimeout: 20,
  proxy: {
    mode: 'direct' as const,
    server: '',
    username: '',
    password: '',
    bypass: '',
    scope: ['download', 'update-app', 'update-trackers'],
  },
  clipboard: { enable: true, http: true, ftp: true, magnet: true, ed2k: true, thunder: true, btHash: true },
  useIndependentDownloadWindow: true,
  autoSubmitFromExtension: true,
  autoSelectAllBtFilesFromExtension: false,
  silentAutoSubmitFromExtension: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  userAgentProfiles: [],
  userAgentRules: [],
  recentUserAgentProfileIds: [],
  logLevel: 'warn' as const,
  aria2LogLevel: 'warn' as const,
  cookie: '',
  runMode: '',
  engineBinPath: '',
  tempFilesDir: '',

  // ── Tracker ───────────────────────────────────────────────────
  btTrackerAutoSync: true,
  btTrackerSyncIntervalHours: 24,
  btPeerBlocklistEnabled: true,
  btPeerBlocklistUrl: BT_PEER_BLOCKLIST_URL,
  btPeerBlocklistAutoSync: true,
  btPeerBlocklistSyncIntervalHours: 24,
  trackerSource: [...DEFAULT_TRACKER_SOURCE],
  customTrackerUrls: [] as string[],
  btTracker: '',
  lastSyncTrackerTime: 0,
  ed2kBootstrapAutoSync: true,
  ed2kBootstrapSyncIntervalHours: 24,

  // ── Directories ───────────────────────────────────────────────
  historyDirectories: [] as string[],
  favoriteDirectories: [] as string[],

  // ── Cleanup ───────────────────────────────────────────────────
  deleteTorrentAfterComplete: false,
  autoDeleteStaleRecords: false,
  clearCompletedOnExit: false,
  completedRecordRetentionDays: COMPLETED_RECORD_RETENTION_FOREVER,

  // ── Power Management ────────────────────────────────────────────
  shutdownWhenComplete: false,
  keepAwake: false,

  // ── Retry & Timeout (matches aria2.conf defaults) ──────────────
  maxTries: 0, // 0 = unlimited retries
  retryWait: 10, // seconds; aria2 waits this long after 503 before retrying
  connectTimeout: 10, // seconds to establish connection
  timeout: 10, // seconds for data transfer after connection
  fileAllocation: 'trunc' as const, // 'none' | 'trunc' | 'prealloc' | 'falloc'
  asyncDns: false, // aria2-next default=true; keep Motrix default conservative

  // ── Task Sorting ─────────────────────────────────────────────
  taskSort: DEFAULT_TASK_SORT,
  taskManualOrder: DEFAULT_TASK_MANUAL_ORDER,
}

export const FILE_ALLOCATION_OPTIONS = ['none', 'trunc', 'prealloc', 'falloc'] as const

export const PROXY_SCOPES = {
  DOWNLOAD: 'download',
  UPDATE_APP: 'update-app',
  UPDATE_TRACKERS: 'update-trackers',
}

export const PROXY_SCOPE_OPTIONS = [PROXY_SCOPES.DOWNLOAD, PROXY_SCOPES.UPDATE_APP, PROXY_SCOPES.UPDATE_TRACKERS]

export const NONE_SELECTED_FILES = 'none'
export const SELECTED_ALL_FILES = 'all'

export const IP_VERSION = {
  V4: 4,
  V6: 6,
}

export const LOGIN_SETTING_OPTIONS = {
  // For Windows
  args: ['--opened-at-login=1'],
}

export const TRAY_CANVAS_CONFIG = {
  WIDTH: 66,
  HEIGHT: 16,
  ICON_WIDTH: 16,
  ICON_HEIGHT: 16,
  TEXT_WIDTH: 46,
  TEXT_FONT_SIZE: 8,
}

export const COMMON_RESOURCE_TAGS = ['http://', 'https://', 'ftp://', 'magnet:', 'ed2k://']
export const THUNDER_RESOURCE_TAGS = ['thunder://']

export const RESOURCE_TAGS = [...COMMON_RESOURCE_TAGS, ...THUNDER_RESOURCE_TAGS]

/** Memory-safety guard: reject clipboard content longer than this (characters). */
export const DETECT_RESOURCE_MAX_CHARS = 100_000

/**
 * Maximum number of non-empty lines detectResource will evaluate.
 * Prevents pathological performance on huge lists while supporting realistic
 * batch-download scenarios (the old 2048-char limit broke at ~13 URLs).
 */
export const DETECT_RESOURCE_MAX_LINES = 200

/**
 * Matches bare BitTorrent v1 info hashes:
 * - SHA-1 hex: exactly 40 hex characters (most common format)
 * - Base32:    exactly 32 uppercase A-Z / 2-7 characters
 *
 * SHA-256 (64 hex, BitTorrent v2 / btmh) is intentionally excluded
 * because aria2 does not support the v2 protocol.
 */
export const BARE_INFO_HASH_RE = /^[0-9a-fA-F]{40}$|^[A-Z2-7]{32}$/

export const SUPPORT_RTL_LOCALES = [
  /* 'العربية', Arabic */
  'ar',
  /* 'فارسی', Persian */
  'fa',
  /* 'עברית', Hebrew */
  'he',
  /* 'Kurdî / كوردی', Kurdish */
  'ku',
  /* 'پنجابی', Western Punjabi */
  'pa',
  /* 'پښتو', Pashto, */
  'ps',
  /* 'سنڌي', Sindhi */
  'sd',
  /* 'اردو', Urdu */
  'ur',
  /* 'ייִדיש', Yiddish */
  'yi',
]

export const IMAGE_SUFFIXES = [
  '.ai',
  '.bmp',
  '.eps',
  '.fig',
  '.gif',
  '.heic',
  '.icn',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.psd',
  '.raw',
  '.sketch',
  '.svg',
  '.tif',
  '.webp',
  '.xd',
]

export const AUDIO_SUFFIXES = ['.aac', '.ape', '.flac', '.flav', '.m4a', '.mp3', '.ogg', '.wav', '.wma']

export const VIDEO_SUFFIXES = ['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpg', '.rmvb', '.vob', '.wmv']

export const SUB_SUFFIXES = ['.ass', '.idx', '.smi', '.srt', '.ssa', '.sst', '.sub']

export const DOCUMENT_SUFFIXES = [
  '.azw3',
  '.csv',
  '.doc',
  '.docx',
  '.epub',
  '.key',
  '.mobi',
  '.numbers',
  '.pages',
  '.pdf',
  '.ppt',
  '.pptx',
  '.txt',
  '.xls',
  '.xlsx',
]
