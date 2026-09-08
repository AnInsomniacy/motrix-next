/**
 * @fileoverview HTTP header value sanitization utilities.
 *
 * RFC 7230 §3.2.6: HTTP header field-values MUST NOT contain CR (\r)
 * or LF (\n).  Textarea inputs naturally introduce trailing newlines
 * which, when passed as User-Agent or Referer, produce malformed HTTP
 * requests — some CDNs (e.g. BaiduPCS) respond with HTTP 400.
 *
 * These pure functions detect and strip such characters.
 */

/**
 * Returns `true` if `value` contains any CR (`\r`) or LF (`\n`) characters
 * that are illegal in HTTP header field-values.
 */
export function hasUnsafeHeaderChars(value: string): boolean {
  return /[\r\n]/.test(value)
}

/**
 * Strips all CR/LF characters and trims leading/trailing whitespace.
 * Preserves all other characters including tabs (legal per HTTP obs-fold).
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, '').trim()
}

export interface HttpHeaderOptions {
  userAgent?: string
  referer?: string
  cookie?: string
  authorization?: string
}

export interface RequestHeaderInput {
  name: string
  value: string
}

export interface SanitizedRequestHeader {
  name: string
  value: string
}

export type HeaderDropReason = 'invalid-name' | 'forbidden' | 'duplicate' | 'unsafe-value' | 'limit'

export interface HeaderSanitizeDiagnostics {
  inputCount: number
  keptCount: number
  droppedCount: number
  keptNames: string[]
  droppedReasons: HeaderDropReason[]
}

export interface HeaderSanitizeResult {
  headers: SanitizedRequestHeader[]
  diagnostics: HeaderSanitizeDiagnostics
}

const MAX_BROWSER_REQUEST_HEADERS = 32
const MAX_HEADER_VALUE_LENGTH = 8192

const CANONICAL_BROWSER_HEADERS = new Map<string, string>([
  ['accept', 'Accept'],
  ['accept-language', 'Accept-Language'],
  ['sec-ch-ua', 'Sec-CH-UA'],
  ['sec-ch-ua-mobile', 'Sec-CH-UA-Mobile'],
  ['sec-ch-ua-platform', 'Sec-CH-UA-Platform'],
  ['sec-fetch-dest', 'Sec-Fetch-Dest'],
  ['sec-fetch-mode', 'Sec-Fetch-Mode'],
  ['sec-fetch-site', 'Sec-Fetch-Site'],
  ['sec-fetch-user', 'Sec-Fetch-User'],
  ['upgrade-insecure-requests', 'Upgrade-Insecure-Requests'],
  ['dnt', 'DNT'],
  ['origin', 'Origin'],
])

const FORBIDDEN_BROWSER_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'range',
  'referer',
  'referrer',
  'transfer-encoding',
  'user-agent',
])

const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function hasIllegalControlChars(value: string): boolean {
  return (
    /[\r\n]/.test(value) ||
    Array.from(value).some((ch) => {
      const code = ch.charCodeAt(0)
      return code < 32 && code !== 9
    })
  )
}

function isForbiddenBrowserHeaderName(name: string): boolean {
  return (
    FORBIDDEN_BROWSER_HEADERS.has(name) ||
    name.startsWith('proxy-') ||
    name.startsWith('if-') ||
    !CANONICAL_BROWSER_HEADERS.has(name)
  )
}

export function sanitizeSingleHeaderValue(value: string | undefined): string {
  if (value === undefined) return ''
  if (hasIllegalControlChars(value) || value.length > MAX_HEADER_VALUE_LENGTH) return ''
  return value.trim()
}

export function sanitizeBrowserRequestHeaders(headers: readonly RequestHeaderInput[] = []): SanitizedRequestHeader[] {
  return sanitizeBrowserRequestHeadersWithDiagnostics(headers).headers
}

export function sanitizeBrowserRequestHeadersWithDiagnostics(
  headers: readonly RequestHeaderInput[] = [],
): HeaderSanitizeResult {
  const sanitized: SanitizedRequestHeader[] = []
  const seen = new Set<string>()
  const droppedReasons: HeaderDropReason[] = []

  for (const header of headers) {
    if (sanitized.length >= MAX_BROWSER_REQUEST_HEADERS) {
      droppedReasons.push('limit')
      continue
    }
    const normalizedName = header.name.trim().toLowerCase()
    if (!normalizedName || !HTTP_TOKEN_RE.test(header.name.trim())) {
      droppedReasons.push('invalid-name')
      continue
    }
    if (isForbiddenBrowserHeaderName(normalizedName)) {
      droppedReasons.push('forbidden')
      continue
    }
    if (seen.has(normalizedName)) {
      droppedReasons.push('duplicate')
      continue
    }

    const value = sanitizeSingleHeaderValue(header.value)
    if (!value) {
      droppedReasons.push('unsafe-value')
      continue
    }

    seen.add(normalizedName)
    sanitized.push({
      name: CANONICAL_BROWSER_HEADERS.get(normalizedName) ?? header.name.trim(),
      value,
    })
  }

  return {
    headers: sanitized,
    diagnostics: {
      inputCount: headers.length,
      keptCount: sanitized.length,
      droppedCount: droppedReasons.length,
      keptNames: sanitized.map((header) => header.name),
      droppedReasons,
    },
  }
}

export function sanitizeHttpHeaderOptions(options: HttpHeaderOptions): HttpHeaderOptions {
  const sanitized: HttpHeaderOptions = {}

  if (options.userAgent !== undefined) sanitized.userAgent = sanitizeHeaderValue(options.userAgent)
  if (options.referer !== undefined) sanitized.referer = sanitizeHeaderValue(options.referer)
  if (options.cookie !== undefined) sanitized.cookie = sanitizeHeaderValue(options.cookie)
  if (options.authorization !== undefined) sanitized.authorization = sanitizeHeaderValue(options.authorization)

  return sanitized
}
