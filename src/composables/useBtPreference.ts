/**
 * @fileoverview Pure functions for the BitTorrent preference tab.
 *
 * Manages BT-specific config: file selection, encryption,
 * connection, discovery, max peers, and tracker management. Key business logic:
 * - BitTorrent file-selection presentation
 * - Tracker comma ↔ newline format conversion
 *
 * Tracker source URL validation (isValidTrackerSourceUrl) is co-located
 * here since it is only used in the BT tab's tracker source management.
 */
import type {
  AppConfig,
  BtBlocklistScope,
  BtEncryptionMode,
  BtTransportMode,
  MagnetFileSelectionPolicy,
} from '@shared/types'
import { DEFAULT_APP_CONFIG as D } from '@shared/constants'
import { PORT_RECOVERY_RANGE_END, PORT_RECOVERY_RANGE_START } from '@shared/constants'
import { convertCommaToLine, convertLineToComma, generateRandomInt } from '@shared/utils'
import { isValidOptionalIpAddress } from '@shared/utils/ipAddress'

// ── URL Validation ──────────────────────────────────────────────────

/**
 * Validates whether a string is a valid HTTP/HTTPS URL suitable for use as a
 * tracker source. Custom tracker sources are fetched over HTTP, so only
 * HTTP-based protocols are accepted.
 */
export function isValidTrackerSourceUrl(input: string): boolean {
  const trimmed = input.trim()
  if (!trimmed) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// ── Types ───────────────────────────────────────────────────────────

export interface BtForm {
  [key: string]: unknown
  magnetFileSelectionPolicy: MagnetFileSelectionPolicy
  btEncryption: BtEncryptionMode
  btTransport: BtTransportMode
  btMaxConnections: number
  btMaxUploads: number
  btMaxUploadsPerTorrent: number
  btFirstLastPieceFirst: boolean
  btRateLimitOverhead: boolean
  btAnonymousMode: boolean
  btUserAgent: string
  btPeerIdPrefix: string
  btBlocklistScope: BtBlocklistScope
  btDhtEnabled: boolean
  btPeerExchangeEnabled: boolean
  btLocalPeerDiscoveryEnabled: boolean
  btMaxPeers: number
  listenPort: number
  btExternalIp: string
  btExternalPort: number
  btPeerBlocklistEnabled: boolean
  btPeerBlocklistUrl: string
  btPeerBlocklistAutoSync: boolean
  btPeerBlocklistSyncIntervalHours: number
  trackerSource: string[]
  customTrackerUrls: string[]
  btTracker: string
  btTrackerAutoSync: boolean
  btTrackerSyncIntervalHours: number
  lastSyncTrackerTime: number
}

// ── Pure Functions ──────────────────────────────────────────────────

/**
 * Builds the BT form state from the preference store config.
 */
export function buildBtForm(config: AppConfig): BtForm {
  return {
    magnetFileSelectionPolicy: config.magnetFileSelectionPolicy ?? D.magnetFileSelectionPolicy,
    btEncryption: config.btEncryption ?? D.btEncryption,
    btTransport: config.btTransport ?? D.btTransport,
    btMaxConnections: config.btMaxConnections ?? D.btMaxConnections,
    btMaxUploads: config.btMaxUploads ?? D.btMaxUploads,
    btMaxUploadsPerTorrent: config.btMaxUploadsPerTorrent ?? D.btMaxUploadsPerTorrent,
    btFirstLastPieceFirst: config.btFirstLastPieceFirst ?? D.btFirstLastPieceFirst,
    btRateLimitOverhead: config.btRateLimitOverhead ?? D.btRateLimitOverhead,
    btAnonymousMode: config.btAnonymousMode ?? D.btAnonymousMode,
    btUserAgent: config.btUserAgent ?? D.btUserAgent,
    btPeerIdPrefix: config.btPeerIdPrefix ?? D.btPeerIdPrefix,
    btBlocklistScope: config.btBlocklistScope ?? D.btBlocklistScope,
    btDhtEnabled: config.btDhtEnabled ?? D.btDhtEnabled,
    btPeerExchangeEnabled: config.btPeerExchangeEnabled ?? D.btPeerExchangeEnabled,
    btLocalPeerDiscoveryEnabled: config.btLocalPeerDiscoveryEnabled ?? D.btLocalPeerDiscoveryEnabled,
    btMaxPeers: config.btMaxPeers ?? D.btMaxPeers,
    listenPort: Number(config.listenPort ?? D.listenPort),
    btExternalIp: config.btExternalIp ?? D.btExternalIp,
    btExternalPort: Number(config.btExternalPort ?? D.btExternalPort),
    btPeerBlocklistEnabled: config.btPeerBlocklistEnabled ?? D.btPeerBlocklistEnabled,
    btPeerBlocklistUrl: config.btPeerBlocklistUrl ?? D.btPeerBlocklistUrl,
    btPeerBlocklistAutoSync: config.btPeerBlocklistAutoSync ?? D.btPeerBlocklistAutoSync,
    btPeerBlocklistSyncIntervalHours: Number(
      config.btPeerBlocklistSyncIntervalHours ?? D.btPeerBlocklistSyncIntervalHours,
    ),
    trackerSource: config.trackerSource ?? [...D.trackerSource],
    customTrackerUrls: config.customTrackerUrls ?? [...D.customTrackerUrls],
    btTracker: convertCommaToLine(config.btTracker ?? D.btTracker),
    btTrackerAutoSync: config.btTrackerAutoSync ?? D.btTrackerAutoSync,
    btTrackerSyncIntervalHours: Number(config.btTrackerSyncIntervalHours ?? D.btTrackerSyncIntervalHours),
    lastSyncTrackerTime: config.lastSyncTrackerTime ?? D.lastSyncTrackerTime,
  }
}

/**
 * Converts the BT form into aria2 system config key-value pairs.
 * The global engine default pauses magnet metadata for explicit file control.
 * The download-all policy overrides it per task through the native RPC option.
 *
 * IMPORTANT: force-save is intentionally excluded from global config.
 * It must only be set per-download on BT tasks to prevent aria2 from
 * re-downloading completed HTTP tasks on restart.
 */
export function buildBtSystemConfig(f: BtForm): Record<string, string> {
  return {
    'detach-share-only': 'true',
    'bt-max-peers': String(f.btMaxPeers),
    'listen-port': String(f.listenPort),
    'bt-external-ip': f.btExternalIp.trim(),
    'bt-external-port': String(f.btExternalPort),
    'bt-encryption': f.btEncryption,
    'bt-transport': f.btTransport,
    'bt-max-connections': String(f.btMaxConnections),
    'bt-max-uploads': String(f.btMaxUploads),
    'bt-max-uploads-per-torrent': String(f.btMaxUploadsPerTorrent),
    'bt-first-last-piece-first': String(!!f.btFirstLastPieceFirst),
    'bt-rate-limit-overhead': String(!!f.btRateLimitOverhead),
    'bt-anonymous-mode': String(!!f.btAnonymousMode),
    'bt-user-agent': f.btUserAgent,
    'bt-peer-id-prefix': f.btPeerIdPrefix,
    'bt-blocklist-scope': f.btBlocklistScope,
    'enable-dht': String(!!f.btDhtEnabled),
    'enable-peer-exchange': String(!!f.btPeerExchangeEnabled),
    'bt-enable-lpd': String(!!f.btLocalPeerDiscoveryEnabled),
    'pause-metadata': 'true',
    'bt-tracker': convertLineToComma(f.btTracker),
  }
}

export function validateBtEndpoint(f: BtForm): string | null {
  if (!Number.isInteger(f.listenPort) || f.listenPort < 1024 || f.listenPort > 65535) {
    return 'preferences.bt-port-unavailable'
  }
  if (!isValidOptionalIpAddress(f.btExternalIp)) {
    return 'preferences.bt-external-ip-invalid'
  }
  if (!Number.isInteger(f.btExternalPort) || f.btExternalPort < 0 || f.btExternalPort > 65535) {
    return 'preferences.bt-external-port-invalid'
  }
  return null
}

export function randomBtPort(): number {
  return generateRandomInt(PORT_RECOVERY_RANGE_START, PORT_RECOVERY_RANGE_END + 1)
}

/**
 * Transforms the BT form for store persistence.
 * Converts tracker newline format back to comma-separated for storage.
 */
export function transformBtForStore(f: BtForm): Partial<AppConfig> {
  const data = { ...f } as Partial<AppConfig> & Record<string, unknown>

  data.btTracker = convertLineToComma(f.btTracker)

  return data
}
