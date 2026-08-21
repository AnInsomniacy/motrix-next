// src/shared/utils/__tests__/hls.test.ts
import { describe, expect, it } from 'vitest'
import { checkTaskIsHls, extractHlsErrorCode, hlsErrorI18nKey, isHlsGid, isHlsUri } from '@shared/utils/hls'

describe('isHlsUri', () => {
  it('detects m3u8 path ignoring query and hash', () => {
    expect(isHlsUri('https://cdn.example/a/master.m3u8?token=1#x')).toBe(true)
    expect(isHlsUri('HTTPS://CDN.EXAMPLE/A/INDEX.M3U')).toBe(true)
  })

  it('rejects non-playlist http urls', () => {
    expect(isHlsUri('https://cdn.example/video.mp4')).toBe(false)
    expect(isHlsUri('https://cdn.example/m3u8/video.ts')).toBe(false)
    expect(isHlsUri('magnet:?xt=urn:btih:abc')).toBe(false)
    expect(isHlsUri('')).toBe(false)
  })
})

describe('isHlsGid', () => {
  it('accepts hls- plus 32 lowercase hex', () => {
    expect(isHlsGid('hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true)
  })
  it('rejects aria2-style 16 hex gids', () => {
    expect(isHlsGid('0123456789abcdef')).toBe(false)
    expect(isHlsGid('HLS-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
  })
})

describe('checkTaskIsHls', () => {
  it('is true when hls field or gid prefix is present', () => {
    expect(checkTaskIsHls({ gid: 'hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toBe(true)
    expect(
      checkTaskIsHls({
        gid: '0123456789abcdef',
        hls: {
          playlistUrl: 'https://x/a.m3u8',
          mediaKind: 'mpegts',
          segmentCount: 0,
          segmentTotal: 1,
          encryptMethod: 'none',
          phase: 'download',
        },
      }),
    ).toBe(true)
  })
})

describe('hlsErrorI18nKey', () => {
  it('maps known HLS short codes to task locale keys', () => {
    expect(hlsErrorI18nKey('live-not-supported')).toBe('task.hls-live-not-supported')
    expect(hlsErrorI18nKey('encrypt-not-supported')).toBe('task.hls-encrypt-not-supported')
    expect(hlsErrorI18nKey('invalid-playlist')).toBe('task.hls-invalid-playlist')
  })

  it('leaves unknown codes unmapped so the raw message can be shown', () => {
    expect(hlsErrorI18nKey('invalid-key')).toBeUndefined()
    expect(hlsErrorI18nKey('invalid-ciphertext')).toBeUndefined()
    expect(hlsErrorI18nKey('')).toBeUndefined()
  })
})

describe('extractHlsErrorCode', () => {
  it('reads the Tauri Hls variant payload', () => {
    expect(extractHlsErrorCode({ Hls: 'live-not-supported' })).toBe('live-not-supported')
  })

  it('strips the Display prefix from serialized HLS errors', () => {
    expect(extractHlsErrorCode('HLS error: invalid-playlist')).toBe('invalid-playlist')
    expect(extractHlsErrorCode(new Error('HLS error: encrypt-not-supported'))).toBe('encrypt-not-supported')
  })

  it('returns undefined for non-HLS errors', () => {
    expect(extractHlsErrorCode({ Aria2: 'boom' })).toBeUndefined()
    expect(extractHlsErrorCode('network timeout')).toBeUndefined()
  })
})
