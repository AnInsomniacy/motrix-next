/** @fileoverview Application-wide constants: themes, intervals, suffixes, limits. */
import { DEFAULT_TASK_SORT } from '@/composables/useTaskSort'
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
  { id: 'graphite', labelKey: 'preferences.color-scheme-graphite', seed: '#6B7280' },
  { id: 'sakura', labelKey: 'preferences.color-scheme-sakura', seed: '#EC4899' },
]

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
  SEEDING: 'seeding',
}

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug']

export const MAX_NUM_OF_DIRECTORIES = 5

export const ENGINE_RPC_HOST = '127.0.0.1'
export const ENGINE_RPC_PORT = 16800
export const ENGINE_MAX_CONCURRENT_DOWNLOADS = 10
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

// 12 Hours
export const AUTO_SYNC_TRACKER_INTERVAL = ONE_HOUR * 12

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
 * - `dir: ''`       → system Downloads directory via Tauri API
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

export const DEFAULT_APP_CONFIG = {
  configVersion: 6,
  dbSchemaVersion: CURRENT_DB_SCHEMA_VERSION,
  // ── Appearance ──────────────────────────────────────────────────
  theme: 'auto' as const,
  colorScheme: 'amber',
  locale: 'auto',

  // ── Download Core (aria2 defaults: concurrent=5, split=5, conn/server=1) ──
  dir: '',
  split: ENGINE_DEFAULT_SPLIT, // parallel segments per file; independent of maxConnectionPerServer since v2
  maxConcurrentDownloads: 5, // aria2 default; IDM=4, FDM=3~12
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

  // ── BitTorrent (qBT/Transmission/Deluge conventions) ──────────
  btMaxPeers: ENGINE_DEFAULT_BT_MAX_PEERS, // aria2 default=55; qBT=100, Transmission=60, Deluge=200
  seedRatio: 2, // old Motrix=2, Transmission=2; 2:1 supports BT ecosystem health
  seedTime: 2880, // old Motrix=2880 (48h); generous default for healthy swarm contribution
  keepSeeding: false, // qBT stops at ratio; safer default for new users
  forceSave: true, // persist completed/seeding BT tasks in session file (aria2 skips FINISHED tasks without this)
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
  extensionApiPort: 16801,
  autoChangeConflictingPorts: true,
  portConflictRecovery: {
    enabled: true,
    rangeStart: 30000,
    rangeEnd: 39999,
    rpc: true,
    extensionApi: true,
    bt: true,
    dht: true,
    ed2k: true,
  },
  // extensionApiSecret is intentionally ABSENT from defaults.
  // rpcSecret is intentionally ABSENT from defaults.
  // For both secrets:
  //   undefined → main.ts auto-generates on first launch.
  //   '' → user intentionally cleared (respected, not regenerated).
  //   'abc' → user-set or auto-generated secret (kept as-is).
  listenPort: 21301,
  dhtListenPort: 26701,
  ed2kListenPort: 4662,
  ed2kServer: '',
  ed2kServerList: '',
  ed2kNodeList: '',
  ed2kUploadSlots: 3,
  ed2kShareFiles: [] as string[],
  ed2kSearchTimeout: 20,
  proxy: {
    enable: false,
    server: '',
    bypass: '',
    scope: ['download', 'update-app', 'update-trackers'],
    matchMode: 'blacklist',
  },
  protocols: { magnet: true, ed2k: true, thunder: false, motrixnext: true },
  clipboard: { enable: true, http: true, ftp: true, magnet: true, ed2k: true, thunder: true, btHash: true },
  autoSubmitFromExtension: true,
  autoSelectAllFilesFromExtension: false,
  silentAutoSubmitFromExtension: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  logLevel: 'debug', // captures full diagnostic output for bug reports out of the box
  cookie: '',
  runMode: '',
  engineBinPath: '',
  tempFilesDir: '',

  // ── Tracker ───────────────────────────────────────────────────
  autoSyncTracker: true,
  trackerSource: [] as string[], // populated from DEFAULT_TRACKER_SOURCE below at runtime
  customTrackerUrls: [] as string[],
  btTracker: '',
  lastSyncTrackerTime: 0,

  // ── Directories ───────────────────────────────────────────────
  historyDirectories: [] as string[],
  favoriteDirectories: [] as string[],

  // ── Cleanup ───────────────────────────────────────────────────
  deleteTorrentAfterComplete: false,
  autoDeleteStaleRecords: false,
  clearCompletedOnExit: false,

  // ── Power Management ────────────────────────────────────────────
  shutdownWhenComplete: false,
  keepAwake: false,

  // ── Retry & Timeout (matches aria2.conf defaults) ──────────────
  maxTries: 0, // 0 = unlimited retries
  retryWait: 10, // seconds; aria2 waits this long after 503 before retrying
  connectTimeout: 10, // seconds to establish connection
  timeout: 10, // seconds for data transfer after connection
  fileAllocation: 'prealloc', // 'none' | 'trunc' | 'prealloc' | 'falloc'

  // ── Task Sorting ─────────────────────────────────────────────
  taskSort: DEFAULT_TASK_SORT,
}

export const FILE_ALLOCATION_OPTIONS = ['none', 'trunc', 'prealloc', 'falloc'] as const

export const MAX_BT_TRACKER_LENGTH = 6144

/**
 * @see https://github.com/ngosang/trackerslist
 */
export const NGOSANG_TRACKERS_BEST_URL =
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt'
export const NGOSANG_TRACKERS_BEST_IP_URL =
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt'
export const NGOSANG_TRACKERS_ALL_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt'
export const NGOSANG_TRACKERS_ALL_IP_URL =
  'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ip.txt'

export const NGOSANG_TRACKERS_BEST_URL_CDN = 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best.txt'
export const NGOSANG_TRACKERS_BEST_IP_URL_CDN = 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best_ip.txt'
export const NGOSANG_TRACKERS_ALL_URL_CDN = 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_all.txt'
export const NGOSANG_TRACKERS_ALL_IP_URL_CDN = 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_all_ip.txt'

/**
 * @see https://github.com/XIU2/TrackersListCollection
 */
export const XIU2_TRACKERS_BEST_URL = 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt'
export const XIU2_TRACKERS_ALL_URL = 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt'
export const XIU2_TRACKERS_HTTP_URL = 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/http.txt'

export const XIU2_TRACKERS_BEST_URL_CDN = 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/best.txt'
export const XIU2_TRACKERS_ALL_URL_CDN = 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/all.txt'
export const XIU2_TRACKERS_HTTP_URL_CDN = 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/http.txt'

// For bt-exclude-tracker
export const XIU2_TRACKERS_BLACK_URL = 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/blacklist.txt'

/** Sensible default tracker sources for first install (CDN endpoints). */
export const DEFAULT_TRACKER_SOURCE = [NGOSANG_TRACKERS_BEST_URL_CDN, NGOSANG_TRACKERS_BEST_IP_URL_CDN]

// Backfill DEFAULT_APP_CONFIG.trackerSource now that the URLs are defined.
// This preserves the single-source-of-truth invariant: DEFAULT_APP_CONFIG
// is the authoritative set of defaults, and trackerSource is populated
// once JS finishes evaluating all module-level constants.
;(DEFAULT_APP_CONFIG as Record<string, unknown>).trackerSource = [...DEFAULT_TRACKER_SOURCE]

export const TRACKER_SOURCE_OPTIONS = [
  {
    label: 'ngosang/trackerslist',
    options: [
      {
        value: NGOSANG_TRACKERS_BEST_URL,
        label: 'trackers_best.txt',
        cdn: false,
      },
      {
        value: NGOSANG_TRACKERS_BEST_IP_URL,
        label: 'trackers_best_ip.txt',
        cdn: false,
      },
      {
        value: NGOSANG_TRACKERS_ALL_URL,
        label: 'trackers_all.txt',
        cdn: false,
      },
      {
        value: NGOSANG_TRACKERS_ALL_IP_URL,
        label: 'trackers_all_ip.txt',
        cdn: false,
      },
      {
        value: NGOSANG_TRACKERS_BEST_URL_CDN,
        label: 'trackers_best.txt',
        cdn: true,
      },
      {
        value: NGOSANG_TRACKERS_BEST_IP_URL_CDN,
        label: 'trackers_best_ip.txt',
        cdn: true,
      },
      {
        value: NGOSANG_TRACKERS_ALL_URL_CDN,
        label: 'trackers_all.txt',
        cdn: true,
      },
      {
        value: NGOSANG_TRACKERS_ALL_IP_URL_CDN,
        label: 'trackers_all_ip.txt',
        cdn: true,
      },
    ],
  },
  {
    label: 'XIU2/TrackersListCollection',
    options: [
      {
        value: XIU2_TRACKERS_BEST_URL,
        label: 'best.txt',
        cdn: false,
      },
      {
        value: XIU2_TRACKERS_ALL_URL,
        label: 'all.txt',
        cdn: false,
      },
      {
        value: XIU2_TRACKERS_HTTP_URL,
        label: 'http.txt',
        cdn: false,
      },
      {
        value: XIU2_TRACKERS_BEST_URL_CDN,
        label: 'best.txt',
        cdn: true,
      },
      {
        value: XIU2_TRACKERS_ALL_URL_CDN,
        label: 'all.txt',
        cdn: true,
      },
      {
        value: XIU2_TRACKERS_HTTP_URL_CDN,
        label: 'http.txt',
        cdn: true,
      },
    ],
  },
]

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
