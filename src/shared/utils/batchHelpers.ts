/**
 * @fileoverview Utilities for the batch add-task model.
 * Normalizes external inputs (deep links, drag-drop, file picker) into
 * BatchItem entries for the unified add-task dialog.
 */
import type { BatchItemKind, BatchItem } from '@shared/types'
import type { Aria2EngineOptions } from '@shared/types'
import { BARE_INFO_HASH_RE } from '@shared/constants'
import sanitizeFilename from 'sanitize-filename'

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
  if (/^(?:https?|sftp):\/\//i.test(lower)) return 'uri'

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
    inspectionState: kind === 'torrent' ? 'reading' : undefined,
  }
}

// ── URI normalization ───────────────────────────────────────────────

/** If the line is a bare BitTorrent info hash, wrap it as a magnet URI. */
function normalizeInfoHash(line: string): string {
  if (!BARE_INFO_HASH_RE.test(line)) return line
  return line.length === 64 ? `magnet:?xt=urn:btmh:1220${line.toLowerCase()}` : `magnet:?xt=urn:btih:${line}`
}

function normalizeUriLine(line: string): string {
  return normalizeInfoHash(line.trim())
}

function normalizeRawUriLine(line: string): string {
  return normalizeInfoHash(line.trim())
}

export interface Aria2InputEntry {
  uris: string[]
  options: Aria2EngineOptions
}

export interface ParsedAria2Input {
  entries: Aria2InputEntry[]
  validLineCount: number
}

function isAria2OptionLine(line: string): boolean {
  return line.startsWith(' ') || line.startsWith('\t')
}

function isAria2OptionAssignment(line: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]*=/.test(line)
}

function appendAria2Option(options: Aria2EngineOptions, rawLine: string): void {
  const line = rawLine.trim()
  const separator = line.indexOf('=')
  if (separator <= 0) return

  const key = line.slice(0, separator).trim()
  const value = line.slice(separator + 1)
  if (!key) return

  const existing = options[key]
  if (existing === undefined) {
    options[key] = value
  } else if (Array.isArray(existing)) {
    existing.push(value)
  } else {
    options[key] = [existing, value]
  }
}

function parseAria2UriLine(line: string): string[] {
  return line
    .split('\t')
    .map((part) => normalizeUriLine(part))
    .filter(Boolean)
}

function countLeadingSpaces(line: string): number {
  const match = line.match(/^[ \t]*/)
  return match ? match[0].length : 0
}

function trimCommonInputIndent(lines: string[]): string[] {
  const contentIndents = lines
    .filter((line) => {
      const trimmed = line.trim()
      return trimmed && !trimmed.startsWith('#') && !isAria2OptionAssignment(trimmed)
    })
    .map(countLeadingSpaces)

  if (contentIndents.length === 0) return lines

  const commonIndent = Math.min(...contentIndents)
  if (commonIndent <= 0) return lines

  return lines.map((line) => line.slice(Math.min(commonIndent, countLeadingSpaces(line))))
}

/**
 * Parses aria2 input-file structure used by aria2-next:
 * - a non-indented line starts one task
 * - tab-separated URIs on that line are mirrors for the same task
 * - following space/tab-indented key=value lines are per-task options
 * - option validity is intentionally left to aria2-next
 */
export function parseAria2Input(text: string): ParsedAria2Input {
  const entries: Aria2InputEntry[] = []
  let current: Aria2InputEntry | null = null
  let validLineCount = 0

  for (const rawLine of trimCommonInputIndent(text.split('\n'))) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (isAria2OptionLine(rawLine) && isAria2OptionAssignment(trimmed)) {
      if (current) {
        appendAria2Option(current.options, rawLine)
        validLineCount++
      }
      continue
    }
    if (isAria2OptionLine(rawLine) && current) continue

    const uris = parseAria2UriLine(rawLine)
    if (uris.length === 0) continue
    current = { uris, options: {} }
    entries.push(current)
    validLineCount++
  }

  return { entries, validLineCount }
}

/**
 * Split, trim, remove blanks, and deduplicate URI lines by first occurrence.
 * Handles multiline payloads — each line is treated as an independent URI.
 * Bare info hashes (SHA-1 hex / Base32) are automatically wrapped as magnet URIs.
 */
export function normalizeUriLines(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of parseAria2Input(text).entries) {
    for (const line of entry.uris) {
      if (!seen.has(line)) {
        seen.add(line)
        result.push(line)
      }
    }
  }
  return result
}

/**
 * Merge URI lines for display/editing without decoding protocol wrappers.
 * Submission paths use normalizeUriLines(); Thunder links stay wrapped because
 * Aria2 Next owns Thunder parsing.
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
