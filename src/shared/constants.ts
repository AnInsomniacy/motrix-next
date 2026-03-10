/** @fileoverview Application-wide constants: themes, intervals, suffixes, limits. */
export const EMPTY_STRING = ''
export const IS_PORTABLE = false

export const APP_THEME = {
  AUTO: 'auto',
  LIGHT: 'light',
  DARK: 'dark',
}

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

export const LOG_LEVELS = ['error', 'warn', 'info', 'verbose', 'debug', 'silly']

export const MAX_NUM_OF_DIRECTORIES = 5

export const ENGINE_RPC_HOST = '127.0.0.1'
export const ENGINE_RPC_PORT = 16800
export const ENGINE_MAX_CONCURRENT_DOWNLOADS = 10
export const ENGINE_MAX_CONNECTION_PER_SERVER = 64

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

export const UPDATE_CHANNELS = ['stable', 'beta'] as const

/**
 * Factory default values for every AppConfig field.
 * **This is the single source of truth** for both first-launch initialization
 * and the "Restore Defaults" action. All fallbacks in buildBasicForm() and
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
 * - `rpcSecret: ''` → random 16-char secret generated in main.ts / resetToDefaults()
 */
export const DEFAULT_APP_CONFIG = {
  // ── Appearance ──────────────────────────────────────────────────
  theme: 'auto' as const,
  locale: '',

  // ── Download Core (aria2 defaults: concurrent=5, split=5, conn/server=1) ──
  dir: '',
  split: 16, // aria2 default=5; 16 segments balances modern bandwidth
  maxConcurrentDownloads: 5, // aria2 default; IDM=4, FDM=3~12
  maxConnectionPerServer: 16, // aria2 default=1 (too conservative); IDM=8; 16 is community sweet spot
  maxOverallDownloadLimit: '0',
  maxOverallUploadLimit: '0',
  maxDownloadLimit: '',
  maxUploadLimit: '',

  // ── BitTorrent (qBT/Transmission/Deluge conventions) ──────────
  seedRatio: 1, // Deluge=1, Transmission=2; 1:1 is BT community minimum etiquette
  seedTime: 60, // Deluge=180min; 60min is beginner-friendly
  keepSeeding: false, // qBT stops at ratio; safer default for new users
  btSaveMetadata: false, // most clients don't save metadata by default
  btForceEncryption: false, // qBT default "Allow", not "Force"; forcing reduces peers
  followTorrent: true, // aria2 default=true
  followMetalink: true, // aria2 default=true
  pauseMetadata: false, // don't pause metadata download
  continue: true, // aria2 default=true; resume incomplete downloads

  // ── Interface & Behavior ──────────────────────────────────────
  openAtLogin: false, // never auto-start on first install
  keepWindowState: false, // first launch has no saved state
  autoHideWindow: false,
  minimizeToTrayOnClose: false, // close=quit is default UX
  showProgressBar: true,
  traySpeedometer: true, // Motrix signature feature
  dockBadgeSpeed: true, // macOS Dock badge on by default
  taskNotification: true, // users expect download-complete notifications
  newTaskShowDownloading: true, // auto-navigate to downloads after adding task
  noConfirmBeforeDeleteTask: false, // require confirmation to prevent accidental deletion
  resumeAllWhenAppLaunched: false, // don't flood bandwidth on launch
  hideAppMenu: false,
  useNativeTrafficLights: false, // macOS only; opt-in for native traffic light controls

  // ── Auto Update ───────────────────────────────────────────────
  autoCheckUpdate: true, // qBT checks every launch; security best practice
  autoCheckUpdateInterval: 24, // 24h (daily) is standard check frequency
  updateChannel: 'stable' as const,
  lastCheckUpdateTime: 0,

  // ── Network & Security ────────────────────────────────────────
  enableUpnp: false, // security consensus: UPnP has zero-auth design, default OFF
  rpcListenPort: ENGINE_RPC_PORT,
  rpcSecret: '', // generated dynamically at runtime (main.ts / resetToDefaults)
  listenPort: '21301',
  dhtListenPort: '26701',
  proxy: { enable: false, server: '', bypass: '', scope: [] as string[] },
  protocols: { magnet: false, thunder: false },
  userAgent: '',
  logLevel: 'warn', // production-standard log level
  cookie: '',
  runMode: '',
  engineBinPath: '',
  engineMaxConnectionPerServer: 16, // mirrors maxConnectionPerServer

  // ── Tracker ───────────────────────────────────────────────────
  autoSyncTracker: true,
  trackerSource: [] as string[], // populated from DEFAULT_TRACKER_SOURCE below at runtime
  btTracker: '',
  lastSyncTrackerTime: 0,

  // ── Directories ───────────────────────────────────────────────
  historyDirectories: [] as string[],
  favoriteDirectories: [] as string[],
}

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

export const COMMON_RESOURCE_TAGS = ['http://', 'https://', 'ftp://', 'magnet:']
export const THUNDER_RESOURCE_TAGS = ['thunder://']

export const RESOURCE_TAGS = [...COMMON_RESOURCE_TAGS, ...THUNDER_RESOURCE_TAGS]

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
  '.xsl',
  '.xslx',
]
