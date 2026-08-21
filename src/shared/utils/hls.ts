/** @fileoverview HLS VOD helpers: playlist URL detection, GID format, and task classification. */
import type { Aria2Task } from '@shared/types'

const HLS_GID_PATTERN = /^hls-[0-9a-f]{32}$/
const HLS_PLAYLIST_SUFFIXES = ['.m3u8', '.m3u'] as const // fixed playlist extensions for suffix matching

/** Returns true when the URI pathname ends with .m3u8 or .m3u (case-insensitive). */
export const isHlsUri = (uri: string): boolean => {
  try {
    const pathname = new URL(uri).pathname.replace(/\/+$/, '')
    const lowerPath = pathname.toLowerCase()
    return HLS_PLAYLIST_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix))
  } catch {
    return false
  }
}

/** Returns true when the GID matches the HLS prefix plus 32 lowercase hex digits. */
export const isHlsGid = (gid: string): boolean => {
  return HLS_GID_PATTERN.test(gid)
}

/** Splits GIDs into HLS and aria2 buckets, preserving encounter order in each. */
export const splitGids = (gids: string[]): { hls: string[]; aria2: string[] } => {
  const hls: string[] = []
  const aria2: string[] = []
  for (const gid of gids) {
    if (isHlsGid(gid)) hls.push(gid)
    else aria2.push(gid)
  }
  return { hls, aria2 }
}

/** Returns true when the task carries HLS metadata or an HLS-style GID. */
export const checkTaskIsHls = (task: Pick<Aria2Task, 'gid' | 'hls'>): boolean => {
  return Boolean(task.hls) || isHlsGid(task.gid)
}

const HLS_ERROR_I18N_KEYS: Record<string, string> = {
  'live-not-supported': 'task.hls-live-not-supported',
  'encrypt-not-supported': 'task.hls-encrypt-not-supported',
  'invalid-playlist': 'task.hls-invalid-playlist',
}

/** Maps HLS engine short-codes to locale keys; unknown codes stay raw. */
export const hlsErrorI18nKey = (code: string): string | undefined => {
  return HLS_ERROR_I18N_KEYS[code]
}

const HLS_ERROR_DISPLAY_PREFIX = 'HLS error: '

/** Reads the HLS short-code from a Tauri `{ Hls }` payload or Display string. */
export const extractHlsErrorCode = (value: unknown): string | undefined => {
  if (typeof value === 'object' && value !== null && 'Hls' in value) {
    const payload = value.Hls
    if (typeof payload === 'string') return payload.trim() || undefined
  }
  const raw = typeof value === 'string' ? value : value instanceof Error ? value.message : undefined
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed.startsWith(HLS_ERROR_DISPLAY_PREFIX)) {
    return trimmed.slice(HLS_ERROR_DISPLAY_PREFIX.length).trim() || undefined
  }
  return HLS_ERROR_I18N_KEYS[trimmed] ? trimmed : undefined
}
