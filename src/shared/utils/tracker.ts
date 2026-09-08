/** @fileoverview BT tracker list fetching via Rust backend and data conversion utilities. */
import { isEmpty } from 'lodash-es'
import type { ProxyConfig } from '@shared/types'
import { invoke } from '@tauri-apps/api/core'
import { PROXY_SCOPES } from '@shared/constants'
import { logger } from '@shared/logger'
import { resolveAppProxyUrl } from '@shared/utils/proxy'

// ── Types ───────────────────────────────────────────────────────

/** A single tracker source URL that failed during fetch. */
export interface FailedTrackerSource {
  url: string
  reason: string
}

/** Structured result from the Rust `fetch_tracker_sources` command. */
export interface FetchTrackerSourcesResult {
  data: string[]
  failures: FailedTrackerSource[]
}

// ── Proxy resolution ────────────────────────────────────────────

/**
 * Determines the proxy server URL to pass to the Rust backend.
 * Returns the server string when the proxy is enabled and the scope
 * includes UPDATE_TRACKERS; otherwise returns `null`.
 */
export function computeTrackerProxyServer(proxyConfig: Partial<ProxyConfig>): string | null {
  return resolveAppProxyUrl(proxyConfig, PROXY_SCOPES.UPDATE_TRACKERS)
}

// ── Core fetch ──────────────────────────────────────────────────

/**
 * Fetches BT tracker lists from external source URLs via the Rust backend,
 * bypassing browser CORS restrictions that block webview-based XHR requests.
 *
 * Returns a structured result containing both successful response bodies
 * and per-URL failure details for granular UI feedback.
 */
export const fetchBtTrackerFromSource = async (
  source: string[],
  proxyConfig: Partial<ProxyConfig> = {},
): Promise<FetchTrackerSourcesResult> => {
  if (isEmpty(source)) {
    return { data: [], failures: [] }
  }

  logger.info('TrackerSync', `fetching from ${source.length} source(s)`)

  const proxyServer = computeTrackerProxyServer(proxyConfig)

  const result = await invoke<FetchTrackerSourcesResult>('fetch_tracker_sources', {
    urls: source,
    proxyServer,
  })

  // Mirror failures to frontend log for DevTools visibility
  for (const f of result.failures) {
    logger.warn('TrackerSync', `failed to fetch ${f.url}: ${f.reason}`)
  }

  logger.info('TrackerSync', `completed: ${result.data.length}/${source.length} succeeded`)

  return result
}

// ── Data conversion utilities ───────────────────────────────────

export const convertTrackerDataToLine = (arr: string[] = []): string => {
  const lines = arr
    .join('\r\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return [...new Set(lines)].join('\r\n')
}

export const convertTrackerDataToComma = (arr: string[] = []): string => {
  return convertTrackerDataToLine(arr)
    .replace(/(?:\r\n|\r|\n)/g, ',')
    .trim()
}
