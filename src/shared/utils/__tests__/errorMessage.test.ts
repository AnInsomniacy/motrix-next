/** @fileoverview Tests for user-facing error message normalization. */
import { describe, expect, it } from 'vitest'
import { getErrorMessage } from '../errorMessage'

describe('getErrorMessage', () => {
  it('returns Error messages unchanged', () => {
    expect(getErrorMessage(new Error('process crashed'))).toBe('process crashed')
  })

  it('returns string errors unchanged', () => {
    expect(getErrorMessage('network timeout')).toBe('network timeout')
  })

  it('extracts Tauri AppError variant payloads', () => {
    expect(getErrorMessage({ Aria2: 'aria2 RPC error [1]: Unsupported URI scheme' })).toBe(
      'Aria2 Next error [1]: Unsupported URI scheme',
    )
    expect(getErrorMessage({ Hls: 'live-not-supported' })).toBe('HLS error: live-not-supported')
  })

  it('uses localized labels for Tauri AppError variants', () => {
    expect(
      getErrorMessage(
        { Aria2: 'aria2 RPC error [1]: Unsupported URI scheme' },
        { labels: { Aria2: 'Aria2 Next 错误' } },
      ),
    ).toBe('Aria2 Next 错误 [1]: Unsupported URI scheme')
  })

  it('keeps localized Aria2 labels for errors without RPC codes', () => {
    expect(
      getErrorMessage(
        { Aria2: 'HTTP request to aria2 failed: connection refused' },
        { labels: { Aria2: 'Aria2 Next 错误' } },
      ),
    ).toBe('Aria2 Next 错误: HTTP request to aria2 failed: connection refused')
  })

  it('localizes non-Aria2 Tauri AppError prefixes without rewriting payloads', () => {
    expect(getErrorMessage({ Engine: 'sidecar failed' }, { labels: { Engine: 'Engine failed' } })).toBe(
      'Engine failed: sidecar failed',
    )
  })

  it('extracts plain message fields', () => {
    expect(getErrorMessage({ message: 'invalid request' })).toBe('invalid request')
  })

  it('extracts JSON-RPC error objects', () => {
    expect(getErrorMessage({ error: { code: 1, message: 'Unsupported URI scheme' } })).toBe(
      'JSON-RPC error [1]: Unsupported URI scheme',
    )
  })

  it('serializes unknown objects instead of returning [object Object]', () => {
    expect(getErrorMessage({ code: 500, reason: 'failed' })).toBe('{"code":500,"reason":"failed"}')
  })

  it('handles circular objects safely', () => {
    const value: Record<string, unknown> = { reason: 'failed' }
    value.self = value

    expect(getErrorMessage(value)).toBe('{"reason":"failed","self":"[Circular]"}')
  })
})
