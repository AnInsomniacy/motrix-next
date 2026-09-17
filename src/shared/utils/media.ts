/** @fileoverview Native presentation options and progress semantics. */
import { DEFAULT_APP_CONFIG } from '@shared/constants'
import type { AppConfig, Aria2Task, Aria2EngineOptions, Aria2MediaTrack, MediaState } from '@shared/types'
import type { I18nKey } from '@shared/i18nTypes'
import { logger } from '@shared/logger'

export interface MediaOptions {
  mode: 'auto' | 'file' | 'hls' | 'dash'
  format: 'mp4' | 'mkv'
  video: string
  audio: string
  subtitles: string
  recordTime: number
  pauseAfterProbe: 'true' | 'false' | 'default'
}

export function defaultMediaOptions(
  config: Pick<AppConfig, 'mediaSelectBeforeDownload' | 'mediaDefaultFormat'> = DEFAULT_APP_CONFIG,
): MediaOptions {
  return {
    mode: 'auto',
    format: config.mediaDefaultFormat,
    video: 'best',
    audio: 'best',
    subtitles: 'none',
    recordTime: 0,
    pauseAfterProbe: 'default',
  }
}

export function readMediaOptions(options: Record<string, string>, tracks: Aria2MediaTrack[] = []): MediaOptions {
  const mode = options.media
  const format = options.mediaFormat
  if ((mode !== 'auto' && mode !== 'hls' && mode !== 'dash') || (format !== 'mp4' && format !== 'mkv'))
    throw new Error('Invalid native media options')
  const recordTime = Number(options.mediaRecordTime)
  if (!Number.isInteger(recordTime) || recordTime < 0 || recordTime > 31536000)
    throw new Error('Invalid native recording duration')
  function selected(value: string, type: string): string {
    if (!value) throw new Error('Missing native media selection')
    if (value === 'best' || value === 'none') return value
    return (
      tracks.find((track) => track.type === type && track.selected === 'true' && track.language === value)?.id ?? value
    )
  }
  return {
    mode,
    format,
    video: selected(options.mediaVideo, 'video'),
    audio: selected(options.mediaAudio, 'audio'),
    subtitles: selected(options.mediaSubtitles, 'subtitle'),
    recordTime,
    pauseAfterProbe: 'false',
  }
}

export function mediaTrackLabel(track: Aria2MediaTrack, locale: string): string {
  let language = track.language
  if (language) {
    try {
      language = new Intl.DisplayNames([locale], { type: 'language' }).of(language) || language
    } catch {
      logger.debug('MediaTrack.language', `Unrecognized language tag: ${language}`)
    }
  }
  return (
    [
      language,
      Number(track.height) ? `${track.width}×${track.height}` : '',
      track.codec,
      Number(track.bandwidth) ? `${Math.round(Number(track.bandwidth) / 1000)} kb/s` : '',
    ]
      .filter(Boolean)
      .join(' · ') || track.id
  )
}

/** A filename hint for known manifests; actual media detection remains native. */
export function mediaOutputHint(uri: string, name: string, mode = 'auto', format = 'mp4'): string {
  if (mode === 'file') return name
  let manifest = mode === 'hls' || mode === 'dash'
  try {
    manifest ||= /\.(m3u8|mpd)$/i.test(new URL(uri).pathname)
  } catch {
    return name
  }
  if (!manifest || !name) return name
  return `${name.replace(/\.[^./\\]*$/, '') || 'media'}.${format === 'mkv' ? 'mkv' : 'mp4'}`
}

export function mediaEngineOptions(value: MediaOptions): Aria2EngineOptions {
  if (value.mode === 'file') return { media: 'file' }
  if (!Number.isInteger(value.recordTime) || value.recordTime < 0 || value.recordTime > 31536000)
    throw new Error('Recording duration must be between 0 and 31536000 seconds')
  if (value.video === 'none' && value.audio === 'none') throw new Error('Select at least one audio or video track')
  return {
    media: value.mode,
    'media-format': value.format,
    'media-video': value.video,
    'media-audio': value.audio,
    'media-subtitles': value.subtitles,
    'media-record-time': String(value.recordTime),
    ...(value.pauseAfterProbe === 'default' ? {} : { 'media-pause-after-probe': value.pauseAfterProbe }),
  }
}

/** Unknown lengths and live timelines must not masquerade as zero progress. */
export function mediaPercent(task: Aria2Task): number | null {
  if (task.status === 'complete') return 100
  const media = task.media
  if (!media || media.live === 'true' || media.state === 'finalizing' || media.progress === undefined) return null
  const value = Number(media.progress)
  return Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 10000) / 100 : null
}

export function canFinishMedia(task: Aria2Task): boolean {
  return (
    task.media?.live === 'true' &&
    task.media.state !== 'finalizing' &&
    Number(task.media.completedDuration) > 0 &&
    ['active', 'paused'].includes(task.status)
  )
}

export const mediaStateLabel: Record<MediaState, I18nKey> = {
  waiting: 'task.status-waiting',
  probing: 'media.probing',
  'awaiting-selection': 'media.waiting-selection',
  downloading: 'media.downloading',
  recording: 'media.recording',
  finalizing: 'media.finalizing',
  paused: 'task.status-paused',
  complete: 'task.status-complete',
  error: 'task.status-error',
  removed: 'task.status-removed',
}

export function mediaDuration(milliseconds: string): string {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0)
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
}

export function canSelectMedia(task: Aria2Task): boolean {
  return Boolean(
    !task.selectionManaged &&
    task.media &&
    ['paused', 'error'].includes(task.status) &&
    task.media.state !== 'finalizing',
  )
}
