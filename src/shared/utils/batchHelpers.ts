/**
 * @fileoverview Utilities for the batch add-task model.
 * Normalizes external inputs (deep links, drag-drop, file picker) into
 * BatchItem entries for the unified add-task dialog.
 */
import type { BatchItemKind, BatchItem } from '@shared/types'
import { BARE_INFO_HASH_RE } from '@shared/constants'
import { decodeMimeWords } from 'lettercoder'
import sanitizeFilename from 'sanitize-filename'
import { decodeThunderLink } from './resource'

let nextId = 0

/** Deterministic, incrementing ID for batch items. */
function genId(): string {
  return `batch-${++nextId}`
}

/**
 * Classify a source string as a download kind for the batch add-task model.
 *
 * Follows the same priority chain as aria2's `ProtocolDetector`
 * (`download_helper.cc` AccRequestGroup::operator()):
 *
 *   1. **Scheme-first** — magnet/thunder URIs are always 'uri' tasks
 *      (aria2: `guessTorrentMagnet` checks `magnet:?` prefix).
 *   2. **Remote URLs** — remain URI downloads. Manual AddTask URL input
 *      downloads the referenced file itself.
 *   3. **Local paths** — `.torrent` files become torrent tasks.
 *   4. **Fallback** — everything else is a plain 'uri'.
 */
export function detectKind(source: string): BatchItemKind {
  const lower = source.toLowerCase()

  // ── 1. Scheme-first: non-file protocols are always URI tasks ──────
  if (lower.startsWith('magnet:') || lower.startsWith('thunder://')) {
    return 'uri'
  }

  // ── 2. Remote URLs are ordinary downloads ────────────────────────
  if (/^https?:\/\//i.test(lower)) return 'uri'

  if (/^ftp:\/\//i.test(lower)) return 'uri'

  // ── 3. Local file paths: extension suffix match ───────────────────
  if (lower.endsWith('.torrent')) return 'torrent'

  // ── 4. Fallback ───────────────────────────────────────────────────
  return 'uri'
}

/** Classify external-capture inputs where remote .torrent means "add BT task". */
export function detectExternalInputKind(source: string): BatchItemKind {
  if (/^https?:\/\//i.test(source)) {
    try {
      const pathname = new URL(source).pathname.toLowerCase()
      if (pathname.endsWith('.torrent')) return 'torrent'
    } catch {
      return 'uri'
    }
  }
  return detectKind(source)
}

/**
 * Extract the display name (`dn`) from a magnet URI.
 *
 * The `dn` parameter is the standard way to convey a human-readable name
 * in a magnet link (BEP 9 § magnet URI format).  Most tracker sites
 * (nyaa.si, 1337x, etc.) include it, but it is optional — bare info-hash
 * magnets omit it entirely.
 *
 * Returns the percent-decoded `dn` value, or an empty string if:
 * - the URI is not a `magnet:` scheme
 * - the `dn` parameter is absent or empty
 * - the URI is malformed
 */
export function extractMagnetDisplayName(uri: string): string {
  if (!uri.toLowerCase().startsWith('magnet:')) return ''
  try {
    const queryStart = uri.indexOf('?')
    if (queryStart < 0) return ''
    const params = new URLSearchParams(uri.substring(queryStart + 1))
    return params.get('dn') || ''
  } catch {
    return ''
  }
}

export function extractEd2kDisplayName(uri: string): string {
  if (!uri.toLowerCase().startsWith('ed2k://|file|')) return ''
  const parts = uri.split('|')
  const rawName = parts[2]
  return rawName ? sanitizeFilenameSegment(decodePathSegment(rawName)) : ''
}

/** Extract a short display name from a source path or URI. */
function toDisplayName(source: string, kind: BatchItemKind): string {
  if (kind === 'uri') {
    // Truncate long URIs for display
    return source.length > 80 ? source.substring(0, 77) + '...' : source
  }
  // File path — extract basename
  const sep = Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\'))
  return sep >= 0 ? source.substring(sep + 1) : source
}

/** Create a pending BatchItem from a raw input. Payload is set later for file-based items. */
export function createBatchItem(kind: BatchItemKind, source: string, payload = ''): BatchItem {
  return {
    id: genId(),
    kind,
    source,
    displayName: toDisplayName(source, kind),
    payload: payload || source, // URI items use source as payload
    status: 'pending',
  }
}

/** Reset the ID counter (useful for testing). */
export function resetBatchIdCounter(): void {
  nextId = 0
}

// ── URI normalization ───────────────────────────────────────────────

/** If the line is a bare BitTorrent v1 info hash, wrap it as a magnet URI. */
function normalizeInfoHash(line: string): string {
  return BARE_INFO_HASH_RE.test(line) ? `magnet:?xt=urn:btih:${line}` : line
}

function normalizeUriLine(line: string): string {
  return normalizeInfoHash(decodeThunderLink(line.trim()))
}

function normalizeRawUriLine(line: string): string {
  return normalizeInfoHash(line.trim())
}

/**
 * Split, trim, remove blanks, and deduplicate URI lines by first occurrence.
 * Handles multiline payloads — each line is treated as an independent URI.
 * Bare info hashes (SHA-1 hex / Base32) are automatically wrapped as magnet URIs.
 */
export function normalizeUriLines(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of text.split('\n')) {
    const line = normalizeUriLine(raw)
    if (line && !seen.has(line)) {
      seen.add(line)
      result.push(line)
    }
  }
  return result
}

/**
 * Merge existing textarea content with incoming URI payloads.
 * Each incoming payload is treated as potentially multiline (split by \\n).
 * Returns a single string with order-preserving, deduplicated URI lines.
 */
export function mergeUriLines(existingText: string, incoming: string[]): string {
  const existing = normalizeUriLines(existingText)
  const seen = new Set(existing)
  for (const payload of incoming) {
    // Each payload may itself contain multiple lines (e.g. multiline deep-link arg)
    for (const raw of payload.split('\n')) {
      const line = normalizeUriLine(raw)
      if (line && !seen.has(line)) {
        seen.add(line)
        existing.push(line)
      }
    }
  }
  return existing.join('\n')
}

/**
 * Merge URI lines for display/editing without decoding protocol wrappers.
 * Submission paths must use normalizeUriLines() so Thunder links are decoded
 * before reaching aria2.
 */
export function mergeRawUriLines(existingText: string, incoming: string[]): string {
  const existing = existingText.split('\n').map(normalizeRawUriLine).filter(Boolean)
  const seen = new Set(existing)
  for (const payload of incoming) {
    for (const raw of payload.split('\n')) {
      const line = normalizeRawUriLine(raw)
      if (line && !seen.has(line)) {
        seen.add(line)
        existing.push(line)
      }
    }
  }
  return existing.join('\n')
}

// ── Filename extraction and decoding ────────────────────────────────

/** ASCII control characters (0x00–0x1F, 0x7F) and C1 controls (0x80–0x9F). */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\x80-\x9f]/g

function sanitizeFilenameSegment(name: string): string {
  const stripped = name.replace(CONTROL_CHAR_RE, '').replace(/[. ]+$/, '')
  const sanitized = sanitizeFilename(stripped, { replacement: '_' })
    .trim()
    .replace(/[. ]+$/, '')
  return sanitized && !/^\.+$/.test(sanitized) ? sanitized : ''
}

/**
 * Safely percent-decodes a single path segment.
 * Returns the original string if decoding fails (malformed % sequence).
 */
export function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * Extracts and URL-decodes the filename from a URI, then removes
 * filesystem-unsafe characters.
 *
 * Follows browser-level precedent (Chrome / Firefox / Electron):
 *   1. Parse URL → isolate pathname
 *   2. Extract last path segment
 *   3. Percent-decode via decodeURIComponent
 *   4. Replace characters forbidden by Windows / macOS / Linux with '_'
 *
 * Returns '' if no filename can be extracted (bare domain, trailing slash,
 * magnet URI, data URI, etc.) — caller should NOT set `out` in that case.
 *
 * Security: sanitizes decoded `/`, `\`, `:` etc. to prevent path traversal
 * (cf. Firefox CVE-2022-31739).
 */
export function extractDecodedFilename(uri: string): string {
  const ed2kName = extractEd2kDisplayName(uri)
  if (ed2kName) return ed2kName

  // Skip non-HTTP protocols that don't use URL-path filenames
  if (/^(magnet|ed2k|data|blob):/i.test(uri)) return ''

  let pathname: string
  try {
    pathname = new URL(uri).pathname
  } catch {
    // Malformed URI — attempt simple extraction
    pathname = uri.split('?')[0].split('#')[0]
  }

  const segments = pathname.split('/').filter(Boolean)
  const raw = segments.pop()
  if (!raw) return ''

  const decoded = decodePathSegment(raw)

  return sanitizeFilenameSegment(decoded)
}

/**
 * Returns true if a filename contains a recognizable file extension
 * (a dot followed by 1–10 alphanumeric characters at the end).
 *
 * Used by `submitManualUris` to decide whether `resolve_filename` (HEAD
 * request) is needed — URLs with extensions are handled natively by aria2.
 */
export function hasExtension(filename: string): boolean {
  return /\.[a-zA-Z0-9]{1,10}$/.test(filename)
}

function hasHttpDownloadScheme(uri: string): boolean {
  try {
    const protocol = new URL(uri).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return /^https?:\/\//i.test(uri)
  }
}

function looksLikeOpaqueRemoteFilename(filename: string): boolean {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  if (stem.length < 16) return false
  if (/^\d{12,}$/.test(stem)) return true
  if (/^[a-fA-F0-9]{16,}$/.test(stem)) return true
  return /^[A-Za-z0-9]{16,}$/.test(stem) && /[A-Za-z]/.test(stem) && /\d/.test(stem)
}

/**
 * Returns whether manual URL submission should ask the backend to probe HTTP
 * headers for a better filename before handing the task to aria2.
 *
 * We always probe URLs whose path has no usable extension. For URLs that do
 * have an extension, we only probe opaque CDN-style basenames such as
 * "080545q06zvvvvag3u3vh6.zip"; ordinary names like "ubuntu.iso" are left to
 * aria2 to avoid slowing down common manual adds.
 */
export function shouldProbeRemoteFilename(uri: string): boolean {
  if (!hasHttpDownloadScheme(uri)) return false

  const filename = extractDecodedFilename(uri)
  if (!filename) return false
  if (!hasExtension(filename)) return true
  return looksLikeOpaqueRemoteFilename(filename)
}

// ── External filename hint resolution ───────────────────────────────

const GENERIC_EXTERNAL_FILENAME_HINTS = new Set(['download', 'unresolved-filename'])

function stripUrlSuffixPollution(name: string): string {
  const qIdx = name.indexOf('?')
  if (qIdx >= 0) {
    const before = name.substring(0, qIdx)
    const after = name.substring(qIdx + 1)
    if (hasExtension(before) || after.includes('=') || after.includes('&')) {
      name = before
    }
  }

  const hIdx = name.indexOf('#')
  if (hIdx >= 0) {
    const before = name.substring(0, hIdx)
    const after = name.substring(hIdx + 1)
    if (hasExtension(before) || after.includes('=') || after.includes('&')) {
      name = before
    }
  }

  return name
}

function looksLikeRfc2047EncodedWord(value: string): boolean {
  return value.includes('=?') && value.includes('?=')
}

function decodeFilenameEncoding(raw: string): string {
  const trimmed = raw.trim()
  const decodedCandidates = [trimmed]

  if (trimmed.includes('%')) {
    try {
      const decoded = decodeURIComponent(trimmed)
      if (decoded !== trimmed) decodedCandidates.push(decoded)
    } catch {
      // Malformed percent sequences are treated as literal filename text.
    }
  }

  for (const candidate of decodedCandidates) {
    if (!looksLikeRfc2047EncodedWord(candidate)) continue
    try {
      const decoded = decodeMimeWords(candidate)
      if (decoded) return decoded.trim()
    } catch {
      return candidate
    }
  }

  const percentDecoded = decodedCandidates[1]?.trim()
  return percentDecoded || trimmed
}

/**
 * Sanitizes a raw string into a filesystem-safe filename.
 *
 * Applies the same character set as Chrome's `filename_util.cc` and the
 * `sanitize-filename` npm/crate ecosystem:
 *   1. Strip path separators (basename extraction)
 *   2. Remove `?`/`#` suffixes (URL fragment pollution from extensions)
 *   3. Replace filesystem-unsafe characters: `/ \ : * ? " < > |`
 *   4. Remove ASCII/C1 control characters
 *   5. Trim trailing dots and spaces (Windows rejects these)
 *   6. Reject empty results or pure-dot sequences
 *
 * This is a pure sanitization function — no business logic (e.g. extension
 * checks). Safe for both external hints AND user-typed `out` values.
 */
export function sanitizeAria2OutHint(raw: string): string {
  if (!raw) return ''

  // 1. Basename — strip path prefixes
  const basename = raw.trim().replace(/^.*[/\\]/, '')
  let name = decodeFilenameEncoding(basename)

  // 2. Strip URL query/fragment pollution without treating every '?' as a URL boundary.
  name = stripUrlSuffixPollution(name)

  return sanitizeFilenameSegment(name)
}

function filenameStem(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(0, dot) : filename
}

function isWeakExternalFilenameHint(url: string, filename: string): boolean {
  const lower = filename.toLowerCase()
  const stem = filenameStem(filename).toLowerCase()
  if (GENERIC_EXTERNAL_FILENAME_HINTS.has(lower)) return true

  const isRemoteDownloadUrl = /^(?:https?|ftp):\/\//i.test(url)
  if (!isRemoteDownloadUrl) return false
  if (GENERIC_EXTERNAL_FILENAME_HINTS.has(stem)) return true

  const urlBasename = extractDecodedFilename(url)
  const urlHasExtension = hasExtension(urlBasename)
  if (urlBasename && !urlHasExtension && stem === urlBasename.toLowerCase()) return true

  return /^\d+$/.test(stem) && !urlHasExtension
}

/**
 * Determines whether an external filename hint (from extensions, deep links,
 * or the HTTP API) should be trusted as the aria2 `out` option.
 *
 * External filename hints are advisory (RFC 6266 §4.3) — this function
 * decides whether the hint adds value over what `resolve_filename` (HEAD
 * request → Content-Disposition / MIME) would infer on its own.
 *
 * Strategy:
 *   1. Sanitize the raw hint into a filesystem-safe name.
 *   2. Reject browser-generated placeholders (e.g. "0.xlsx" for `/u/0/`).
 *   3. If the cleaned hint has a file extension → accept (e.g. "报告.pdf").
 *   4. If extensionless, compare with the URL's own basename:
 *      - Same name → reject (hint is redundant; `resolve_filename` can
 *        append the correct extension via Content-Type MIME mapping).
 *      - Different name → accept (hint carries information the URL lacks,
 *        e.g. cloud drive filenames like "README" from CDN hash URLs).
 *
 * Returns the sanitized filename to use as `out`, or '' to indicate the
 * hint should be discarded and `resolve_filename` should take over.
 *
 * @param url  The download URL (used to extract the URL basename).
 * @param rawHint  The raw filename from the browser extension / deep link.
 */
export function resolveExternalFilenameHint(url: string, rawHint: string): string {
  const cleaned = sanitizeAria2OutHint(rawHint)
  if (!cleaned) return ''
  if (isWeakExternalFilenameHint(url, cleaned)) return ''

  // Hint has a file extension → trust it after placeholder filtering.
  // Cloud drives (Baidu, Quark) provide correct filenames like "报告.pdf"
  // that the URL path (a CDN hash) cannot reproduce.
  if (hasExtension(cleaned)) return cleaned

  if (GENERIC_EXTERNAL_FILENAME_HINTS.has(cleaned.toLowerCase())) return ''

  // Hint is extensionless — compare with the URL's own basename.
  // If they match, the hint adds no value; let resolve_filename run
  // a HEAD request to infer the extension via Content-Type MIME mapping
  // (e.g. Twitter "G9v9wWdasAYNqt9" → image/jpeg → ".jpg").
  const urlBasename = extractDecodedFilename(url)
  if (urlBasename && cleaned === urlBasename) return ''

  // Extensionless but genuinely different from URL basename →
  // the extension provided a real name (e.g. "README" for a CDN hash URL).
  return cleaned
}
