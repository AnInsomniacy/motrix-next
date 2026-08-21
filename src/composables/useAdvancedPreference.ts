/**
 * @fileoverview Pure functions extracted from Advanced.vue for testability.
 *
 * Contains configuration transforms, secret generation, and port randomization
 * logic that was previously inline in the component's script setup.
 */
import {
  PORT_RECOVERY_RANGE_END,
  PORT_RECOVERY_RANGE_START,
  PROXY_SCOPE_OPTIONS,
  DEFAULT_APP_CONFIG as D,
} from '@shared/constants'
import { generateRandomInt } from '@shared/utils'
import { isValidAria2ProxyUrl, UNSUPPORTED_PROXY_SCHEME_RE } from '@shared/utils/proxy'
import type { AppConfig, AppLogLevel, Aria2LogLevel } from '@shared/types'
import { buildDownloadProxyOptions, normalizeProxyMode, type EngineProxyMode } from '@shared/utils/proxy'
import { generateConfigSecret } from '@shared/utils/configHydration'

export { isValidAria2ProxyUrl } from '@shared/utils/proxy'

// ── Types ───────────────────────────────────────────────────────────

export interface AdvancedForm {
  [key: string]: unknown
  proxy: {
    mode: EngineProxyMode
    server: string
    username?: string
    password?: string
    bypass: string
    scope: string[]
  }
  rpcListenPort: number
  rpcSecret: string
  extensionApiPort: number
  extensionApiSecret: string
  allowRemoteAccess: boolean
  autoSubmitFromExtension: boolean
  autoSelectAllBtFilesFromExtension: boolean
  silentAutoSubmitFromExtension: boolean
  autoChangeConflictingPorts: boolean
  enableUpnp: boolean
  userAgent: string
  logLevel: AppLogLevel
  aria2LogLevel: Aria2LogLevel
  tempFilesDir: string
  ffmpegBinaryPath: string
  hardwareRendering: boolean
  // Clipboard detection (migrated from legacy Basic tab)
  clipboardEnable: boolean
  clipboardHttp: boolean
  clipboardFtp: boolean
  clipboardMagnet: boolean
  clipboardEd2k: boolean
  clipboardThunder: boolean
  clipboardBtHash: boolean
  // Timeout & disk (shared with Network tab but kept for backward compat)
  connectTimeout: number
  timeout: number
  fileAllocation: string
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Generates a cryptographically random secret string of 16 alphanumeric chars.
 * Used for aria2 RPC authentication.
 */
export function generateSecret(): string {
  return generateConfigSecret()
}

/**
 * Builds the advanced form state from the preference store config.
 * All fallback values reference DEFAULT_APP_CONFIG (single source of truth).
 */
export function buildAdvancedForm(config: AppConfig): {
  form: AdvancedForm
} {
  const proxy = config.proxy ?? D.proxy
  return {
    form: {
      proxy: {
        mode: normalizeProxyMode(proxy.mode),
        server: proxy.server ?? D.proxy.server,
        username: proxy.username ?? D.proxy.username,
        password: proxy.password ?? D.proxy.password,
        bypass: proxy.bypass ?? D.proxy.bypass,
        scope: proxy.scope ?? [...PROXY_SCOPE_OPTIONS],
      },
      rpcListenPort: config.rpcListenPort ?? D.rpcListenPort,
      rpcSecret: config.rpcSecret,
      extensionApiPort: config.extensionApiPort ?? D.extensionApiPort,
      extensionApiSecret: config.extensionApiSecret,
      allowRemoteAccess: config.allowRemoteAccess ?? D.allowRemoteAccess,
      autoSubmitFromExtension: config.autoSubmitFromExtension ?? D.autoSubmitFromExtension,
      autoSelectAllBtFilesFromExtension:
        config.autoSelectAllBtFilesFromExtension ?? D.autoSelectAllBtFilesFromExtension,
      silentAutoSubmitFromExtension: config.silentAutoSubmitFromExtension ?? D.silentAutoSubmitFromExtension,
      autoChangeConflictingPorts: config.autoChangeConflictingPorts ?? D.autoChangeConflictingPorts,
      enableUpnp: config.enableUpnp ?? D.enableUpnp,
      userAgent: config.userAgent ?? D.userAgent,
      logLevel: config.logLevel ?? D.logLevel,
      aria2LogLevel: config.aria2LogLevel ?? D.aria2LogLevel,
      tempFilesDir: config.tempFilesDir ?? D.tempFilesDir,
      ffmpegBinaryPath: config.ffmpegBinaryPath ?? D.ffmpegBinaryPath,
      hardwareRendering: config.hardwareRendering ?? D.hardwareRendering,
      // Clipboard detection
      clipboardEnable: config.clipboard?.enable ?? D.clipboard.enable,
      clipboardHttp: config.clipboard?.http ?? D.clipboard.http,
      clipboardFtp: config.clipboard?.ftp ?? D.clipboard.ftp,
      clipboardMagnet: config.clipboard?.magnet ?? D.clipboard.magnet,
      clipboardEd2k: config.clipboard?.ed2k ?? D.clipboard.ed2k,
      clipboardThunder: config.clipboard?.thunder ?? D.clipboard.thunder,
      clipboardBtHash: config.clipboard?.btHash ?? D.clipboard.btHash,
      // Timeout & disk
      connectTimeout: config.connectTimeout ?? D.connectTimeout,
      timeout: config.timeout ?? D.timeout,
      fileAllocation: config.fileAllocation ?? D.fileAllocation,
    },
  }
}

/**
 * Converts the advanced form into aria2 system config key-value pairs.
 * Pure function — no side effects.
 */
export function buildAdvancedSystemConfig(f: AdvancedForm): Record<string, string> {
  return {
    'rpc-listen-port': String(f.rpcListenPort),
    'allow-remote-access': String(!!f.allowRemoteAccess),
    'rpc-secret': f.rpcSecret,
    'user-agent': f.userAgent || '',
    ...buildDownloadProxyOptions(f.proxy),
  }
}

/**
 * Transforms the advanced form for store persistence.
 * Collapses flat clipboard fields into nested objects and
 * normalizes tracker format.
 */
export function transformAdvancedForStore(f: AdvancedForm): Record<string, unknown> {
  const {
    clipboardEnable,
    clipboardHttp,
    clipboardFtp,
    clipboardMagnet,
    clipboardEd2k,
    clipboardThunder,
    clipboardBtHash,
    ...rest
  } = f
  return {
    ...rest,
    clipboard: {
      enable: clipboardEnable,
      http: clipboardHttp,
      ftp: clipboardFtp,
      magnet: clipboardMagnet,
      ed2k: clipboardEd2k,
      thunder: clipboardThunder,
      btHash: clipboardBtHash,
    },
  }
}

// ── Form validation ─────────────────────────────────────────────────

/**
 * Validates the advanced preference form before saving.
 * Returns null if valid, or an i18n error key if invalid.
 */
export function validateAdvancedForm(f: AdvancedForm): string | null {
  if (f.proxy.mode === 'manual' && f.proxy.server) {
    if (!isValidAria2ProxyUrl(f.proxy.server)) {
      return UNSUPPORTED_PROXY_SCHEME_RE.test(f.proxy.server.trim())
        ? 'preferences.proxy-unsupported-protocol'
        : 'preferences.invalid-proxy-url'
    }
  }
  return null
}

// ── Port Randomization ──────────────────────────────────────────────

export function randomRpcPort(): number {
  return generateRandomInt(PORT_RECOVERY_RANGE_START, PORT_RECOVERY_RANGE_END + 1)
}
