/**
 * @fileoverview Utilities for the batch add-task model.
 * Normalizes external inputs (deep links, drag-drop, file picker) into
 * BatchItem entries for the unified add-task dialog.
 */
import type { BatchItemKind, BatchItem } from '@shared/types'
import { BARE_INFO_HASH_RE } from '@shared/constants'

let nextId = 0

/** Deterministic, incrementing ID for batch items. */
function genId(): string {
  return `batch-${++nextId}`
}

/** Detect the kind of a source path or URI. */
export function detectKind(source: string): BatchItemKind {
  const lower = source.toLowerCase()
  if (lower.endsWith('.torrent') || lower.includes('.torrent')) return 'torrent'
  if (
    lower.endsWith('.metalink') ||
    lower.endsWith('.meta4') ||
    lower.includes('.metalink') ||
    lower.includes('.meta4')
  )
    return 'metalink'
  return 'uri'
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

/**
 * Split, trim, remove blanks, and deduplicate URI lines by first occurrence.
 * Handles multiline payloads — each line is treated as an independent URI.
 * Bare info hashes (SHA-1 hex / Base32) are automatically wrapped as magnet URIs.
 */
export function normalizeUriLines(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of text.split('\n')) {
    const line = normalizeInfoHash(raw.trim())
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
      const line = raw.trim()
      if (line && !seen.has(line)) {
        seen.add(line)
        existing.push(line)
      }
    }
  }
  return existing.join('\n')
}
