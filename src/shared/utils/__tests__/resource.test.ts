/** @fileoverview Tests for resource detection utilities. */
import { describe, it, expect } from 'vitest'
import { decodeThunderLink, splitTaskLinks, detectResource, needCheckCopyright } from '../resource'

describe('decodeThunderLink', () => {
  it('returns non-thunder links unchanged', () => {
    expect(decodeThunderLink('http://example.com/file.zip')).toBe('http://example.com/file.zip')
  })
  it('decodes thunder:// encoded link', () => {
    const encoded = 'thunder://' + btoa('AAhttp://example.com/file.zipZZ')
    const result = decodeThunderLink(encoded)
    expect(result).toBe('http://example.com/file.zip')
  })
})

describe('splitTaskLinks', () => {
  it('splits multiline links', () => {
    const result = splitTaskLinks('http://a.com\nhttp://b.com')
    expect(result).toEqual(['http://a.com', 'http://b.com'])
  })
  it('returns empty for empty input', () => {
    expect(splitTaskLinks('')).toEqual([])
  })
  it('decodes thunder links within multiline input', () => {
    const thunderLink = 'thunder://' + btoa('AAhttp://decoded.com/file.zipZZ')
    const result = splitTaskLinks(`http://normal.com\n${thunderLink}`)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('http://normal.com')
    expect(result[1]).toBe('http://decoded.com/file.zip')
  })
})

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// detectResource — comprehensive TDD test suite
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('detectResource', () => {
  // ── Valid single-line resources (should trigger) ────────────────────

  describe('valid single-line resources', () => {
    it('detects http:// URL', () => {
      expect(detectResource('http://example.com/file.zip')).toBe(true)
    })

    it('detects https:// URL', () => {
      expect(detectResource('https://cdn.example.com/release-v2.tar.gz')).toBe(true)
    })

    it('detects ftp:// URL', () => {
      expect(detectResource('ftp://mirror.example.com/pub/file.iso')).toBe(true)
    })

    it('detects magnet link', () => {
      expect(detectResource('magnet:?xt=urn:btih:abc123def456')).toBe(true)
    })

    it('detects thunder:// link', () => {
      expect(detectResource('thunder://QUFodHRwOi8vZXhhbXBsZS5jb20vZmlsZS56aXBaWg==')).toBe(true)
    })

    it('detects URL with trailing whitespace', () => {
      expect(detectResource('  https://example.com/file.zip  ')).toBe(true)
    })
  })

  // ── Valid multi-line resource lists (should trigger) ────────────────

  describe('valid multi-line resource lists', () => {
    it('detects multiple http URLs on separate lines', () => {
      expect(detectResource('http://a.com/1.zip\nhttps://b.com/2.zip')).toBe(true)
    })

    it('detects mixed protocols on separate lines', () => {
      const input = 'http://a.com/file.zip\nftp://b.com/file.iso\nmagnet:?xt=urn:btih:abc'
      expect(detectResource(input)).toBe(true)
    })

    it('detects URLs with blank lines between them', () => {
      expect(detectResource('http://a.com\n\nhttps://b.com\n\n')).toBe(true)
    })

    it('detects URLs with Windows-style line endings', () => {
      expect(detectResource('http://a.com\r\nhttps://b.com')).toBe(true)
    })
  })

  // ── False positives that MUST be rejected ──────────────────────────

  describe('false positives — embedded URLs in text', () => {
    it('rejects paragraph containing a URL', () => {
      expect(detectResource('Visit http://example.com for more info')).toBe(false)
    })

    it('rejects code comment containing URL', () => {
      expect(detectResource('// fetch from https://api.example.com/data')).toBe(false)
    })

    it('rejects markdown with URL', () => {
      expect(detectResource('[click here](https://example.com)')).toBe(false)
    })

    it('rejects log line containing URL', () => {
      expect(detectResource('[INFO] Downloaded from http://cdn.example.com/v2.zip successfully')).toBe(false)
    })

    it('rejects HTML anchor tag', () => {
      expect(detectResource('<a href="https://example.com">link</a>')).toBe(false)
    })
  })

  describe('false positives — mixed content', () => {
    it('rejects multi-line text where only some lines are URLs', () => {
      expect(detectResource('Here is a file:\nhttp://example.com/file.zip')).toBe(false)
    })

    it('rejects URL followed by description text', () => {
      expect(detectResource('http://example.com\nThis is my download server')).toBe(false)
    })

    it('rejects JSON containing a URL field', () => {
      const json = '{"url": "https://example.com/api/data"}'
      expect(detectResource(json)).toBe(false)
    })
  })

  describe('false positives — oversized content', () => {
    it('rejects content exceeding 2048 characters', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2100)
      expect(detectResource(longUrl)).toBe(false)
    })
  })

  // ── Bare BitTorrent info hashes ────────────────────────────────────

  describe('bare info hash detection', () => {
    it('detects a bare SHA-1 hex hash (40 chars)', () => {
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6e')).toBe(true)
    })

    it('detects an uppercase SHA-1 hex hash (40 chars)', () => {
      expect(detectResource('D8988E034CB5DE79D319242E3365BF30A7741A6E')).toBe(true)
    })

    it('detects a bare Base32 hash (32 chars)', () => {
      expect(detectResource('TCIY4A2MWXPHTUYZEQUOMNS7GCDXOQTG')).toBe(true)
    })

    it('detects mixed bare hash and magnet URI on separate lines', () => {
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6e\nmagnet:?xt=urn:btih:abc')).toBe(true)
    })

    it('rejects 39-char hex (too short)', () => {
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6')).toBe(false)
    })

    it('rejects 41-char hex (too long)', () => {
      expect(detectResource('d8988e034cb5de79d319242e3365bf30a7741a6ef')).toBe(false)
    })

    it('rejects 64-char hex (SHA-256/BT v2 — unsupported by aria2)', () => {
      expect(detectResource('aabbccddee00112233445566778899aabbccddee00112233445566778899aabb')).toBe(false)
    })

    it('rejects 32-char lowercase string (not valid Base32)', () => {
      expect(detectResource('abcdefghijklmnopqrstuvwxyz234567')).toBe(false)
    })
  })

  // ── Edge cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns false for empty string', () => {
      expect(detectResource('')).toBe(false)
    })

    it('returns false for plain text', () => {
      expect(detectResource('hello world')).toBe(false)
    })

    it('returns false for whitespace-only string', () => {
      expect(detectResource('   \n\n   ')).toBe(false)
    })

    it('returns false for random protocol-like strings', () => {
      expect(detectResource('myapp://open?id=123')).toBe(false)
    })

    it('returns false for email addresses', () => {
      expect(detectResource('user@http://example.com')).toBe(false)
    })
  })
})

describe('needCheckCopyright', () => {
  it('returns true for video links', () => {
    expect(needCheckCopyright('http://example.com/video.mp4')).toBe(true)
  })
  it('returns true for audio links', () => {
    expect(needCheckCopyright('http://example.com/song.mp3')).toBe(true)
  })
  it('returns false for non-media links', () => {
    expect(needCheckCopyright('http://example.com/file.zip')).toBe(false)
  })
  it('returns false for empty string', () => {
    expect(needCheckCopyright('')).toBe(false)
  })
})
