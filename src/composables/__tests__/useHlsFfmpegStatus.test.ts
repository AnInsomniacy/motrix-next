/**
 * @fileoverview Tests for `useHlsFfmpegStatus`: invoke mapping and failure fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInvoke = vi.fn()
const mockWarn = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

vi.mock('@shared/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockWarn(...args),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

import { useHlsFfmpegStatus } from '../useHlsFfmpegStatus'

describe('useHlsFfmpegStatus', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockWarn.mockReset()
  })

  it('stores the ffmpeg probe DTO from hls_ffmpeg_status', async () => {
    mockInvoke.mockResolvedValue({
      kind: 'path',
      path: '/usr/bin/ffmpeg',
      version: '7.0.2',
    })
    const { status, refresh } = useHlsFfmpegStatus()

    await refresh()

    expect(mockInvoke).toHaveBeenCalledWith('hls_ffmpeg_status')
    expect(status.value).toEqual({
      kind: 'path',
      path: '/usr/bin/ffmpeg',
      version: '7.0.2',
    })
  })

  it('falls back to missing and does not throw when invoke fails', async () => {
    mockInvoke.mockRejectedValue(new Error('ipc down'))
    const { status, refresh } = useHlsFfmpegStatus()

    await expect(refresh()).resolves.toBeUndefined()
    expect(status.value).toEqual({ kind: 'missing' })
    expect(mockWarn).toHaveBeenCalled()
  })
})
