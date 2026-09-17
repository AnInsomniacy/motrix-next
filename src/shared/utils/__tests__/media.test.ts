/** @fileoverview Contracts for duration progress and native media options. */
import { describe, expect, it } from 'vitest'
import type { Aria2Task, Aria2Media } from '@shared/types'
import {
  defaultMediaOptions,
  mediaEngineOptions,
  mediaPercent,
  mediaDuration,
  mediaOutputHint,
  canFinishMedia,
} from '../media'
import { historyRecordToTask } from '@/composables/useTaskLifecycle'

function task(media: Partial<Aria2Media> = {}): Aria2Task {
  return {
    gid: '0123456789abcdef',
    status: 'active',
    totalLength: '0',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '1024',
    uploadSpeed: '0',
    connections: '1',
    dir: '/downloads',
    files: [],
    media: {
      state: 'downloading',
      protocol: 'hls',
      live: 'false',
      duration: '60000',
      completedDuration: '20000',
      downloadedLength: '4000000',
      progress: '0.333333',
      lengthKnown: 'false',
      error: '',
      tracks: [],
      ...media,
    },
  }
}
describe('media presentation contracts', () => {
  it('only offers publication for live media with committed content', () => {
    expect(canFinishMedia(task())).toBe(false)
    expect(canFinishMedia(task({ live: 'true', completedDuration: '0' }))).toBe(false)
    expect(canFinishMedia(task({ live: 'true' }))).toBe(true)
    expect(canFinishMedia({ ...task({ live: 'true' }), status: 'paused' })).toBe(true)
    expect(canFinishMedia(task({ live: 'true', state: 'finalizing' }))).toBe(false)
  })
  it('classifies known manifests by output container without rewriting ordinary files', () => {
    expect(mediaOutputHint('https://example.org/master.m3u8?token=abc', 'master.m3u8', 'auto', 'mkv')).toBe(
      'master.mkv',
    )
    expect(mediaOutputHint('https://example.org/master.m3u8', 'master.m3u8', 'file')).toBe('master.m3u8')
    expect(mediaOutputHint('https://example.org/archive.zip', 'archive.zip')).toBe('archive.zip')
  })
  it('uses presentation progress while output bytes are unknown', () => {
    expect(mediaPercent(task())).toBe(33.33)
    expect(mediaDuration('90061000')).toBe('25:01:01')
  })
  it('does not invent percentages for live recording, finalization, or absent progress', () => {
    expect(mediaPercent(task({ live: 'true' }))).toBeNull()
    expect(mediaPercent(task({ state: 'finalizing' }))).toBeNull()
    expect(mediaPercent(task({ progress: undefined }))).toBeNull()
    expect(mediaPercent(task({ progress: 'NaN' }))).toBeNull()
    expect(mediaPercent({ ...task({ live: 'true' }), status: 'complete' })).toBe(100)
  })
  it('preserves explicit selection and rejects invalid recording bounds', () => {
    const options = {
      ...defaultMediaOptions(),
      video: 'none',
      audio: 'audio-main',
      subtitles: 'en',
      format: 'mkv' as const,
    }
    expect(mediaEngineOptions(options)).toMatchObject({
      'media-video': 'none',
      'media-audio': 'audio-main',
      'media-subtitles': 'en',
      'media-format': 'mkv',
    })
    expect(() => mediaEngineOptions({ ...options, recordTime: -1 })).toThrow()
    expect(() => mediaEngineOptions({ ...options, recordTime: 0.5 })).toThrow()
    expect(() => mediaEngineOptions({ ...options, video: 'none', audio: 'none', subtitles: 'none' })).toThrow()
    expect(mediaEngineOptions({ ...options, mode: 'file' })).toEqual({ media: 'file' })
  })
  it('restores media semantics and selection options from persistent history', () => {
    const media = task({ live: 'true', state: 'complete' }).media
    const options = { 'media-format': 'mkv', 'media-subtitles': 'en' }
    const restored = historyRecordToTask({
      gid: 'abc',
      name: 'recording.mkv',
      status: 'complete',
      task_type: 'media',
      total_length: 1024,
      meta: JSON.stringify({ media, mediaOptions: options }),
    })
    expect(restored.media).toEqual(media)
    expect(restored.mediaOptions).toEqual(options)
  })
})

describe('media creation preferences', () => {
  it('defers creation policy to the desktop without sending unsupported engine values', () => {
    const options = defaultMediaOptions({ mediaSelectBeforeDownload: false, mediaDefaultFormat: 'mkv' })
    expect(mediaEngineOptions(options)).toMatchObject({ 'media-format': 'mkv' })
    expect(mediaEngineOptions(options)).not.toHaveProperty('media-pause-after-probe')
  })
  it('keeps an explicit confirmation separate from creation defaults', () => {
    const options = defaultMediaOptions({ mediaSelectBeforeDownload: true, mediaDefaultFormat: 'mp4' })
    expect(mediaEngineOptions({ ...options, pauseAfterProbe: 'false' })['media-pause-after-probe']).toBe('false')
  })
})
