/** @fileoverview Download resource detection: Thunder links, protocol tags, copyright. */
import { compact } from 'lodash-es'
import { RESOURCE_TAGS, BARE_INFO_HASH_RE } from '@shared/constants'
import { splitTextRows } from './format'
import { isAudioOrVideo } from './file'

/** Decodes a Thunder (迅雷) protocol link to its original HTTP/FTP URL. */
export const decodeThunderLink = (url = ''): string => {
  if (!url.startsWith('thunder://')) return url
  let result = url.trim()
  result = result.split('thunder://')[1]
  result = atob(result)
  result = result.substring(2, result.length - 2)
  return result
}

export const splitTaskLinks = (links = ''): string[] => {
  const temp = compact(splitTextRows(links))
  return temp.map((item) => decodeThunderLink(item))
}

/**
 * Returns true if the clipboard content represents downloadable resource(s).
 *
 * Detection rules (all must hold):
 * 1. Content length ≤ 2048 characters (long payloads are not URLs).
 * 2. Split into lines; ignore empty/whitespace-only lines.
 * 3. Every remaining line must start with a recognized protocol tag
 *    (`http://`, `https://`, `ftp://`, `magnet:`, `thunder://`)
 *    OR be a bare BitTorrent v1 info hash (SHA-1 hex / Base32).
 *
 * This rejects embedded URLs inside prose, code comments, JSON, HTML,
 * log lines, and mixed multi-line content.
 */
export const detectResource = (content: string): boolean => {
  if (!content || content.length > 2048) return false

  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length === 0) return false

  return lines.every((line) => RESOURCE_TAGS.some((tag) => line.startsWith(tag)) || BARE_INFO_HASH_RE.test(line))
}

export const needCheckCopyright = (links = ''): boolean => {
  const uris = splitTaskLinks(links)
  const avs = uris.filter((uri) => isAudioOrVideo(uri))
  return avs.length > 0
}
