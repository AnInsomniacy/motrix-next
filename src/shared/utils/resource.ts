/** @fileoverview Clipboard resource detection and protocol filtering. */
import {
  RESOURCE_TAGS,
  BARE_INFO_HASH_RE,
  DETECT_RESOURCE_MAX_CHARS,
  DETECT_RESOURCE_MAX_LINES,
} from '@shared/constants'
import { parseAria2Input } from './batchHelpers'
import type { ClipboardConfig } from '@shared/types'

/**
 * Builds the list of allowed protocol prefixes based on a ClipboardConfig filter.
 * Without a filter, includes all recognized protocol tags.
 */
function buildAllowedTags(filter?: ClipboardConfig): string[] {
  if (!filter) return RESOURCE_TAGS

  const tags: string[] = []
  if (filter.http) {
    tags.push('http://', 'https://')
  }
  if (filter.sftp) {
    tags.push('sftp://')
  }
  if (filter.magnet) {
    tags.push('magnet:')
  }
  if (filter.ed2k) {
    tags.push('ed2k://')
  }
  if (filter.thunder) {
    tags.push('thunder://')
  }
  return tags
}

function lineMatchesAllowedResource(line: string, allowedTags: string[], allowHash: boolean): boolean {
  const lower = line.toLowerCase()
  return (
    allowedTags.some((tag) => lower.startsWith(tag) && line.length > tag.length) ||
    (allowHash && BARE_INFO_HASH_RE.test(line))
  )
}

function lineMatchesAnyResource(line: string): boolean {
  return lineMatchesAllowedResource(line, RESOURCE_TAGS, true)
}

function countMeaningfulInputLines(content: string): number {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')).length
}

/**
 * Returns true if the clipboard content represents downloadable resource(s).
 *
 * Detection rules (all must hold):
 * 1. Content length ≤ 2048 characters (long payloads are not URLs).
 * 2. Split into lines; ignore empty/whitespace-only lines.
 * 3. Every remaining line must start with a recognized protocol tag
 *    (`http://`, `https://`, `sftp://`, `magnet:`, `thunder://`)
 *    OR be a bare BitTorrent v1 or v2 info hash.
 *
 * When a `filter` is provided, only the enabled protocol families are matched.
 * The `enable` master switch short-circuits to false when off.
 *
 * This rejects embedded URLs inside prose, code comments, JSON, HTML,
 * log lines, and mixed multi-line content.
 */
export const detectResource = (content: string, filter?: ClipboardConfig): boolean => {
  if (filter && !filter.enable) return false
  if (!content || content.length > DETECT_RESOURCE_MAX_CHARS) return false

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length === 0 || lines.length > DETECT_RESOURCE_MAX_LINES) return false

  const allowedTags = buildAllowedTags(filter)
  const allowHash = filter ? filter.btHash : true

  if (lines.length === 1) return lineMatchesAllowedResource(lines[0], allowedTags, allowHash)

  const parsed = parseAria2Input(content)
  if (parsed.entries.length === 0) return false

  if (parsed.validLineCount !== countMeaningfulInputLines(content)) return false

  return parsed.entries.every((entry) => entry.uris.length > 0 && entry.uris.every(lineMatchesAnyResource))
}
