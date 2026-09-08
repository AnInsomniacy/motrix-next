/** @fileoverview Proxy policy: mode normalization, URL building/validation,
 * scope checks, and aria2 engine option assembly. */
import { PROXY_SCOPES } from '@shared/constants'
import type { Aria2EngineOptions, ProxyConfig } from '@shared/types'

// ── Modes ───────────────────────────────────────────────────────────

export const ENGINE_PROXY_MODES = ['direct', 'manual'] as const
export type EngineProxyMode = (typeof ENGINE_PROXY_MODES)[number]

export type TaskProxyMode = EngineProxyMode

export function normalizeProxyMode(mode: unknown): EngineProxyMode {
  return ENGINE_PROXY_MODES.includes(mode as EngineProxyMode) ? (mode as EngineProxyMode) : 'direct'
}

export function proxySwitchValueToMode(enabled: boolean): EngineProxyMode {
  return enabled ? 'manual' : 'direct'
}

// ── URL helpers ─────────────────────────────────────────────────────

export interface ProxyCredentials {
  username?: string
  password?: string
}

export interface ProxyEndpoint extends ProxyCredentials {
  server?: string
}

export function buildProxyUrlWithCredentials(proxy: ProxyEndpoint): string | null {
  const server = proxy.server?.trim()
  if (!server) return null
  const username = proxy.username?.trim() ?? ''
  const password = proxy.password ?? ''
  if (!username && !password) return server

  const parseTarget = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(server) ? server : `http://${server}`
  try {
    const url = new URL(parseTarget)
    url.username = username
    url.password = password
    return url.toString()
  } catch {
    return server
  }
}

export function hasProxyScope(proxy: Pick<ProxyConfig, 'scope'>, scope: string): boolean {
  return Array.isArray(proxy.scope) && proxy.scope.includes(scope)
}

// ── aria2 proxy URL validation ──────────────────────────────────────

/** Regex matching URI schemes that aria2 cannot handle as proxy. */
export const UNSUPPORTED_PROXY_SCHEME_RE = /^socks[45a-z]*:\/\//i

/**
 * Validates a proxy URL against aria2's `HttpProxyOptionHandler` whitelist.
 *
 * Aria2 Next accepts `http://`, `https://`, and bare `HOST:PORT`
 * values. SOCKS/custom schemes are rejected before they can crash the engine.
 */
export function isValidAria2ProxyUrl(url: string): boolean {
  if (!url || !url.trim()) return true
  const trimmed = url.trim()

  if (UNSUPPORTED_PROXY_SCHEME_RE.test(trimmed)) return false

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      new URL(trimmed)
      return true
    } catch {
      return false
    }
  }

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      new URL(`http://${trimmed}`)
      return true
    } catch {
      return false
    }
  }

  return false
}

export function isValidBtProxyUrl(url: string): boolean {
  if (!url.trim()) return true
  const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url.trim()) ? url.trim() : `http://${url.trim()}`
  try {
    const parsed = new URL(normalized)
    return ['http:', 'socks4:', 'socks5:'].includes(parsed.protocol) && !!parsed.hostname && !!parsed.port
  } catch {
    return false
  }
}

// ── App-side scoped proxy resolution ────────────────────────────────

export type AppProxyScope = (typeof PROXY_SCOPES)[keyof typeof PROXY_SCOPES]

/** Resolves the proxy URL for an app-side request (updater, tracker sync)
 * when the given scope is enabled; `null` means connect directly. */
export function resolveAppProxyUrl(proxy: Partial<ProxyConfig> | undefined, scope: AppProxyScope): string | null {
  if (!proxy || proxy.mode !== 'manual') return null
  if (!proxy.server?.trim()) return null
  if (!Array.isArray(proxy.scope) || !proxy.scope.includes(scope)) return null
  return buildProxyUrlWithCredentials(proxy)
}

// ── aria2 engine option assembly ────────────────────────────────────

function hasDownloadScope(proxy: Pick<ProxyConfig, 'scope'>): boolean {
  return hasProxyScope(proxy, PROXY_SCOPES.DOWNLOAD)
}

function clearProxyOptions(): Aria2EngineOptions {
  return {
    'all-proxy': '',
    'all-proxy-user': '',
    'all-proxy-passwd': '',
    'http-proxy': '',
    'http-proxy-user': '',
    'http-proxy-passwd': '',
    'https-proxy': '',
    'https-proxy-user': '',
    'https-proxy-passwd': '',
    'no-proxy': '',
  }
}

function clearDownloadProxyOptions(): Aria2EngineOptions {
  return { ...clearProxyOptions(), 'bt-proxy': '' }
}

function addProxyCredentials(options: Aria2EngineOptions, username?: string, password?: string): void {
  const cleanUsername = username?.trim() ?? ''
  const cleanPassword = password ?? ''
  if (!cleanUsername && !cleanPassword) return
  options['all-proxy-user'] = cleanUsername
  options['all-proxy-passwd'] = cleanPassword
}

export function buildDownloadProxyOptions(proxy: ProxyConfig): Aria2EngineOptions {
  const mode = normalizeProxyMode(proxy.mode)
  if (mode !== 'manual') return clearDownloadProxyOptions()

  const server = proxy.server.trim()
  if (!server) return clearDownloadProxyOptions()

  const options: Aria2EngineOptions = {}

  if (hasDownloadScope(proxy)) {
    options['all-proxy'] = server
    addProxyCredentials(options, proxy.username, proxy.password)
    if (proxy.bypass?.trim()) options['no-proxy'] = proxy.bypass.trim()
  }
  if (hasProxyScope(proxy, PROXY_SCOPES.BITTORRENT)) {
    options['bt-proxy'] = buildProxyUrlWithCredentials(proxy) ?? ''
  }
  if (!hasDownloadScope(proxy)) Object.assign(options, clearProxyOptions())
  if (!hasProxyScope(proxy, PROXY_SCOPES.BITTORRENT)) options['bt-proxy'] = ''
  return options
}

export function buildTaskProxyOptions(
  mode: TaskProxyMode,
  customProxy: string,
  appProxy?: ProxyConfig,
  customProxyUsername?: string,
  customProxyPassword?: string,
): Aria2EngineOptions {
  if (mode !== 'manual') return clearProxyOptions()

  const useCustomProxy = !!customProxy.trim()
  const server = useCustomProxy ? customProxy.trim() : (appProxy ? getDownloadProxy(appProxy)?.trim() : '') || ''
  if (!server) return clearProxyOptions()

  const options: Aria2EngineOptions = {
    'all-proxy': server,
  }
  if (useCustomProxy) {
    addProxyCredentials(options, customProxyUsername, customProxyPassword)
  } else if (appProxy) {
    addProxyCredentials(options, appProxy.username, appProxy.password)
  }

  const bypass = appProxy?.bypass?.trim()
  if (bypass) options['no-proxy'] = bypass
  return options
}

export function isManualDownloadProxy(proxy: ProxyConfig): boolean {
  return normalizeProxyMode(proxy.mode) === 'manual' && hasDownloadScope(proxy) && !!proxy.server.trim()
}

export function getDownloadProxy(proxy: ProxyConfig): string | undefined {
  return isManualDownloadProxy(proxy) ? proxy.server : undefined
}

export function getDefaultTaskProxyMode(proxy: ProxyConfig): TaskProxyMode {
  return normalizeProxyMode(proxy.mode) === 'manual' && hasDownloadScope(proxy) ? 'manual' : 'direct'
}

export function getDefaultTaskProxyServer(proxy: ProxyConfig): string {
  return getDefaultTaskProxyMode(proxy) === 'manual' ? proxy.server : ''
}

export function getDefaultTaskProxyUsername(proxy: ProxyConfig): string {
  return getDefaultTaskProxyMode(proxy) === 'manual' ? proxy.username || '' : ''
}

export function getDefaultTaskProxyPassword(proxy: ProxyConfig): string {
  return getDefaultTaskProxyMode(proxy) === 'manual' ? proxy.password || '' : ''
}

export function getProxyServerFromOptions(options: Aria2EngineOptions): string {
  const proxy = options['all-proxy']
  return typeof proxy === 'string' ? proxy : ''
}

export function hasInvalidManualProxy(options: Aria2EngineOptions): boolean {
  const proxy = getProxyServerFromOptions(options)
  return !!proxy && !isValidAria2ProxyUrl(proxy)
}
