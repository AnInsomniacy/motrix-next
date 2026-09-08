import { describe, expect, it } from 'vitest'
import { detectResource } from '../resource'
import { DETECT_RESOURCE_MAX_CHARS, DETECT_RESOURCE_MAX_LINES } from '@shared/constants'
import type { ClipboardConfig } from '@shared/types'

const allProtocols: ClipboardConfig = {
  enable: true,
  http: true,
  sftp: true,
  magnet: true,
  ed2k: true,
  thunder: true,
  btHash: true,
}

describe('Resource detection contract', () => {
  it.each([
    'https://example.com/file.zip',
    'sftp://example.com/file.iso',
    'magnet:?xt=urn:btih:abc123',
    'ed2k://|file|a.iso|123|0123456789abcdef0123456789abcdef|/',
    'd8988e034cb5de79d319242e3365bf30a7741a6e',
  ])('accepts supported resource %s', (resource) => {
    expect(detectResource(resource)).toBe(true)
  })

  it.each([
    '',
    'Visit http://example.com for details',
    '[link](https://example.com)',
    'http://',
    'myapp://open?id=123',
  ])('rejects non-resource content %s', (content) => {
    expect(detectResource(content)).toBe(false)
  })

  it('accepts large URL batches within the documented limits', () => {
    const content = Array.from(
      { length: DETECT_RESOURCE_MAX_LINES },
      (_, index) => `https://cdn.example.com/package-${index}-release.zip`,
    ).join('\n')
    expect(content.length).toBeGreaterThan(2048)
    expect(detectResource(content)).toBe(true)
  })

  it('enforces clipboard input line and character limits', () => {
    const tooManyLines = Array.from(
      { length: DETECT_RESOURCE_MAX_LINES + 1 },
      (_, index) => `https://example.com/${index}`,
    ).join('\n')
    expect(detectResource(tooManyLines)).toBe(false)
    expect(detectResource(`https://example.com/${'a'.repeat(DETECT_RESOURCE_MAX_CHARS)}`)).toBe(false)
  })

  it('honors the master and per-protocol clipboard switches', () => {
    expect(detectResource('https://example.com/file.zip', { ...allProtocols, enable: false })).toBe(false)
    expect(detectResource('https://example.com/file.zip', { ...allProtocols, http: false })).toBe(false)
    expect(detectResource('magnet:?xt=urn:btih:abc123', { ...allProtocols, magnet: false })).toBe(false)
    expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6e', { ...allProtocols, btHash: false })).toBe(false)
  })

  it('keeps valid multi-line aria2 input while rejecting mixed prose', () => {
    expect(detectResource('https://example.com/index.html\n  out=index.html', allProtocols)).toBe(true)
    expect(detectResource('download this file\nhttps://example.com/file.zip', allProtocols)).toBe(false)
  })
})
