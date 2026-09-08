/**
 * @fileoverview Tests for HTTP header value sanitization utilities.
 *
 * RFC 7230 §3.2.6: HTTP header field-values MUST NOT contain CR (\r) or LF (\n).
 * These utilities detect and strip such characters to prevent CRLF injection
 * and malformed HTTP headers (e.g. User-Agent containing trailing newlines
 * from textarea input, which causes HTTP 400 from some CDNs).
 */
import { describe, it, expect } from 'vitest'
import {
  hasUnsafeHeaderChars,
  sanitizeBrowserRequestHeadersWithDiagnostics,
  sanitizeHeaderValue,
  sanitizeHttpHeaderOptions,
} from '../headerSanitize'

describe('hasUnsafeHeaderChars', () => {
  it('returns false for a clean single-line string', () => {
    expect(hasUnsafeHeaderChars('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(hasUnsafeHeaderChars('')).toBe(false)
  })

  it('returns false for a string with only spaces', () => {
    expect(hasUnsafeHeaderChars('   ')).toBe(false)
  })

  it('returns false for a string with tabs (tabs are legal in HTTP obs-fold)', () => {
    expect(hasUnsafeHeaderChars('value\twith\ttabs')).toBe(false)
  })

  it('detects a trailing LF (\\n)', () => {
    expect(hasUnsafeHeaderChars('netdisk;moparse\n')).toBe(true)
  })

  it('detects a trailing CR (\\r)', () => {
    expect(hasUnsafeHeaderChars('netdisk;moparse\r')).toBe(true)
  })

  it('detects CRLF (\\r\\n)', () => {
    expect(hasUnsafeHeaderChars('netdisk;moparse\r\n')).toBe(true)
  })

  it('detects LF in the middle of a string', () => {
    expect(hasUnsafeHeaderChars('line1\nline2')).toBe(true)
  })

  it('detects CR in the middle of a string', () => {
    expect(hasUnsafeHeaderChars('line1\rline2')).toBe(true)
  })

  it('detects multiple newlines throughout a string', () => {
    expect(hasUnsafeHeaderChars('a\nb\nc\n')).toBe(true)
  })

  it('detects a single bare LF character', () => {
    expect(hasUnsafeHeaderChars('\n')).toBe(true)
  })
})

describe('sanitizeHeaderValue', () => {
  it('returns a clean string unchanged (no trimming needed)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    expect(sanitizeHeaderValue(ua)).toBe(ua)
  })

  it('returns empty string for empty input', () => {
    expect(sanitizeHeaderValue('')).toBe('')
  })

  it('strips a trailing LF', () => {
    expect(sanitizeHeaderValue('netdisk;moparse\n')).toBe('netdisk;moparse')
  })

  it('strips a trailing CR', () => {
    expect(sanitizeHeaderValue('netdisk;moparse\r')).toBe('netdisk;moparse')
  })

  it('strips a trailing CRLF', () => {
    expect(sanitizeHeaderValue('netdisk;moparse\r\n')).toBe('netdisk;moparse')
  })

  it('strips LF in the middle, joining segments', () => {
    expect(sanitizeHeaderValue('line1\nline2')).toBe('line1line2')
  })

  it('strips multiple consecutive newlines', () => {
    expect(sanitizeHeaderValue('a\n\n\nb')).toBe('ab')
  })

  it('strips mixed CR and LF characters', () => {
    expect(sanitizeHeaderValue('a\rb\nc\r\nd')).toBe('abcd')
  })

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeHeaderValue('  netdisk;moparse  ')).toBe('netdisk;moparse')
  })

  it('trims whitespace AND strips newlines combined', () => {
    expect(sanitizeHeaderValue('  netdisk;moparse\n  ')).toBe('netdisk;moparse')
  })

  it('preserves internal spaces (only strips CR/LF)', () => {
    expect(sanitizeHeaderValue('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(
      'Mozilla/5.0 (compatible; Googlebot/2.1)',
    )
  })

  it('preserves tabs (tabs are legal in HTTP obs-fold)', () => {
    expect(sanitizeHeaderValue('value\twith\ttabs')).toBe('value\twith\ttabs')
  })

  it('handles a string that is only newlines', () => {
    expect(sanitizeHeaderValue('\r\n\r\n')).toBe('')
  })

  it('handles a real-world BaiduPCS user-agent with trailing newline', () => {
    const dirty = 'netdisk;P2SP;3.0.20.138;netdisk;7.55.5.102;android-android;moparse\n'
    const clean = 'netdisk;P2SP;3.0.20.138;netdisk;7.55.5.102;android-android;moparse'
    expect(sanitizeHeaderValue(dirty)).toBe(clean)
  })
})

describe('sanitizeHttpHeaderOptions', () => {
  it('sanitizes all per-task HTTP header values before they reach aria2', () => {
    expect(
      sanitizeHttpHeaderOptions({
        userAgent: 'Agent\r\nInjected: bad',
        referer: 'https://example.com/\n',
        cookie: 'session=abc\r\nX-Evil: 1',
        authorization: 'Bearer token\nAnother: bad',
      }),
    ).toEqual({
      userAgent: 'AgentInjected: bad',
      referer: 'https://example.com/',
      cookie: 'session=abcX-Evil: 1',
      authorization: 'Bearer tokenAnother: bad',
    })
  })

  it('preserves undefined optional fields', () => {
    expect(sanitizeHttpHeaderOptions({ userAgent: 'Agent/1.0' })).toEqual({
      userAgent: 'Agent/1.0',
    })
  })
})

describe('sanitizeBrowserRequestHeadersWithDiagnostics', () => {
  it('reports safe header names and drop reasons without exposing header values', () => {
    const result = sanitizeBrowserRequestHeadersWithDiagnostics([
      { name: 'Accept', value: 'application/octet-stream' },
      { name: 'Accept-Encoding', value: 'gzip, br' },
      { name: 'Host', value: 'secret.example.com' },
      { name: 'Origin', value: 'https://example.com\r\nInjected: secret' },
      { name: 'DNT', value: '1' },
      { name: 'Accept-Language', value: 'x'.repeat(8193) },
    ])

    expect(result.headers).toEqual([
      { name: 'Accept', value: 'application/octet-stream' },
      { name: 'DNT', value: '1' },
    ])
    expect(result.diagnostics).toEqual({
      inputCount: 6,
      keptCount: 2,
      droppedCount: 4,
      keptNames: ['Accept', 'DNT'],
      droppedReasons: ['forbidden', 'forbidden', 'unsafe-value', 'unsafe-value'],
    })
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret')
    expect(JSON.stringify(result.diagnostics)).not.toContain('application/octet-stream')
  })
})
