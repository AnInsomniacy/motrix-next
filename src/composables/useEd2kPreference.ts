/**
 * @fileoverview Pure functions for the ED2K preference tab.
 *
 * ED2K uses server endpoints, server.met, nodes.dat, upload slots, and search.
 * These options are Aria2 Next startup options, so changes require an engine
 * restart instead of hot reloading through changeGlobalOption.
 */
import type { AppConfig } from '@shared/types'
import type { I18nKey } from '@shared/i18nTypes'
import { PORT_RECOVERY_RANGE_END, PORT_RECOVERY_RANGE_START, DEFAULT_APP_CONFIG as D } from '@shared/constants'
import { convertCommaToLine, convertLineToComma, generateRandomInt } from '@shared/utils'

export const DEFAULT_ED2K_SERVER_MET_URL = 'https://upd.emule-security.org/server.met'
export const DEFAULT_ED2K_NODES_DAT_URL = 'https://upd.emule-security.org/nodes.dat'
export const ED2K_SEARCH_POLL_INTERVAL_MS = 1000
export const ED2K_SEARCH_MAX_DURATION_MS = 90000
export const ED2K_SEARCH_MIN_TIMEOUT_SECONDS = 10
export const ED2K_SEARCH_MAX_TIMEOUT_SECONDS = 600

export type Ed2kSearchOutcome = 'completed' | 'cancelled' | 'failed'

export interface Ed2kForm {
  [key: string]: unknown
  ed2kListenPort: number
  ed2kUdpListenPort: number
  ed2kServer: string
  ed2kServerMetUrl: string
  ed2kNodesDatUrl: string
  ed2kBootstrapAutoSync: boolean
  ed2kBootstrapSyncIntervalHours: number
  ed2kUploadSlots: number
  ed2kMaxConnections: number
  ed2kPreviewPriority: boolean
  ed2kSearchTimeout: number
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function joinLines(value: string): string {
  return splitLines(value).join('\n')
}

export function buildEd2kForm(config: AppConfig): Ed2kForm {
  return {
    ed2kListenPort: Number(config.ed2kListenPort ?? D.ed2kListenPort),
    ed2kUdpListenPort: Number(config.ed2kUdpListenPort ?? D.ed2kUdpListenPort),
    ed2kServer: convertCommaToLine(config.ed2kServer ?? D.ed2kServer),
    ed2kServerMetUrl: String(config.ed2kServerMetUrl ?? DEFAULT_ED2K_SERVER_MET_URL),
    ed2kNodesDatUrl: String(config.ed2kNodesDatUrl ?? DEFAULT_ED2K_NODES_DAT_URL),
    ed2kBootstrapAutoSync: config.ed2kBootstrapAutoSync ?? D.ed2kBootstrapAutoSync,
    ed2kBootstrapSyncIntervalHours: Number(config.ed2kBootstrapSyncIntervalHours ?? D.ed2kBootstrapSyncIntervalHours),
    ed2kUploadSlots: Number(config.ed2kUploadSlots ?? D.ed2kUploadSlots),
    ed2kMaxConnections: Number(config.ed2kMaxConnections ?? D.ed2kMaxConnections),
    ed2kPreviewPriority: config.ed2kPreviewPriority ?? D.ed2kPreviewPriority,
    ed2kSearchTimeout: Number(config.ed2kSearchTimeout ?? D.ed2kSearchTimeout),
  }
}

export function buildEd2kSystemConfig(f: Ed2kForm): Record<string, string> {
  return {
    'ed2k-listen-port': String(f.ed2kListenPort),
    'ed2k-udp-listen-port': String(f.ed2kUdpListenPort),
    'ed2k-server': convertLineToComma(joinLines(f.ed2kServer)),
    'ed2k-upload-slots': String(f.ed2kUploadSlots),
    'ed2k-max-connections': String(f.ed2kMaxConnections),
    'ed2k-preview-priority': String(f.ed2kPreviewPriority),
  }
}

export function transformEd2kForStore(f: Ed2kForm): Partial<AppConfig> {
  return {
    ed2kListenPort: Number(f.ed2kListenPort),
    ed2kUdpListenPort: Number(f.ed2kUdpListenPort),
    ed2kServer: convertLineToComma(joinLines(f.ed2kServer)),
    ed2kServerMetUrl: String(f.ed2kServerMetUrl).trim(),
    ed2kNodesDatUrl: String(f.ed2kNodesDatUrl).trim(),
    ed2kBootstrapAutoSync: !!f.ed2kBootstrapAutoSync,
    ed2kBootstrapSyncIntervalHours: Number(f.ed2kBootstrapSyncIntervalHours),
    ed2kUploadSlots: Number(f.ed2kUploadSlots),
    ed2kMaxConnections: Number(f.ed2kMaxConnections),
    ed2kPreviewPriority: !!f.ed2kPreviewPriority,
    ed2kSearchTimeout: Number(f.ed2kSearchTimeout),
  }
}

export function validateServerLines(value: string): boolean {
  return splitLines(value).every((line) => {
    const separator = line.lastIndexOf(':')
    if (separator <= 0 || separator === line.length - 1) return false
    const host = line.slice(0, separator).trim()
    const port = Number(line.slice(separator + 1))
    return !!host && Number.isInteger(port) && port > 0 && port <= 65535
  })
}

function validateHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function validateEd2kForm(f: Ed2kForm): string | null {
  if (!Number.isInteger(f.ed2kListenPort) || f.ed2kListenPort < 0 || f.ed2kListenPort > 65535) {
    return 'preferences.ed2k-invalid-listen-port'
  }
  if (!Number.isInteger(f.ed2kUdpListenPort) || f.ed2kUdpListenPort < 0 || f.ed2kUdpListenPort > 65535) {
    return 'preferences.ed2k-invalid-listen-port'
  }
  if (!Number.isInteger(f.ed2kUploadSlots) || f.ed2kUploadSlots < 1 || f.ed2kUploadSlots > 100) {
    return 'preferences.ed2k-invalid-upload-slots'
  }
  if (!Number.isInteger(f.ed2kMaxConnections) || f.ed2kMaxConnections < 1 || f.ed2kMaxConnections > 1024) {
    return 'preferences.ed2k-invalid-max-connections'
  }
  if (
    !Number.isInteger(f.ed2kSearchTimeout) ||
    f.ed2kSearchTimeout < ED2K_SEARCH_MIN_TIMEOUT_SECONDS ||
    f.ed2kSearchTimeout > ED2K_SEARCH_MAX_TIMEOUT_SECONDS
  ) {
    return 'preferences.ed2k-invalid-search-timeout'
  }
  if (!validateServerLines(f.ed2kServer)) {
    return 'preferences.ed2k-invalid-server'
  }
  if (!validateHttpUrl(f.ed2kServerMetUrl) || !validateHttpUrl(f.ed2kNodesDatUrl)) {
    return 'preferences.ed2k-invalid-bootstrap-url'
  }
  return null
}

export function randomEd2kPort(): number {
  return generateRandomInt(PORT_RECOVERY_RANGE_START, PORT_RECOVERY_RANGE_END + 1)
}

export function getEd2kSearchToastKey(outcome: Ed2kSearchOutcome, resultCount: number): I18nKey {
  if (outcome === 'cancelled') {
    return resultCount > 0 ? 'preferences.ed2k-search-cancelled-with-results' : 'preferences.ed2k-search-cancelled'
  }
  if (outcome === 'failed') return 'preferences.ed2k-search-failed'
  return resultCount > 0 ? 'preferences.ed2k-search-completed' : 'preferences.ed2k-search-empty'
}

export interface Ed2kSearchPollState {
  elapsedMs: number
  resultCount: number
  previousResultCount: number
  stablePolls: number
  moreResults?: boolean
  maxDurationMs?: number
}

export function shouldFinishEd2kSearchPoll(state: Ed2kSearchPollState): boolean {
  return state.elapsedMs >= (state.maxDurationMs ?? ED2K_SEARCH_MAX_DURATION_MS)
}
