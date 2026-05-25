/** @fileoverview Tests for proxy whitelist matching utilities. */
import { describe, it, expect } from 'vitest'
import { parseWhitelist, isUrlInWhitelist } from '../proxyWhitelist'

describe('parseWhitelist', () => {
  it('splits comma-separated entries', () => {
    expect(parseWhitelist('example.com,*.example.org')).toEqual(['example.com', '*.example.org'])
  })

  it('splits newline-separated entries', () => {
    expect(parseWhitelist('example.com\n*.example.org')).toEqual(['example.com', '*.example.org'])
  })

  it('handles mixed separators (commas + newlines)', () => {
    expect(parseWhitelist('example.com\n*.example.org,api.test.com')).toEqual([
      'example.com',
      '*.example.org',
      'api.test.com',
    ])
  })

  it('trims whitespace from each entry', () => {
    expect(parseWhitelist('  example.com  ,  *.example.org  ')).toEqual(['example.com', '*.example.org'])
  })

  it('filters out empty entries', () => {
    expect(parseWhitelist('example.com,,*.example.org')).toEqual(['example.com', '*.example.org'])
  })

  it('filters out entries that are only whitespace', () => {
    expect(parseWhitelist('example.com,   ,*.example.org')).toEqual(['example.com', '*.example.org'])
  })

  it('returns empty array for empty string', () => {
    expect(parseWhitelist('')).toEqual([])
  })

  it('returns empty array for whitespace-only string', () => {
    expect(parseWhitelist('   ')).toEqual([])
  })
})

describe('isUrlInWhitelist', () => {
  describe('exact domain matching', () => {
    it('matches exact domain', () => {
      expect(isUrlInWhitelist('https://example.com/file.zip', ['example.com'])).toBe(true)
    })

    it('matches exact domain with www prefix', () => {
      expect(isUrlInWhitelist('https://www.example.com/file.zip', ['www.example.com'])).toBe(true)
    })

    it('does not match subdomain when exact domain is listed', () => {
      expect(isUrlInWhitelist('https://sub.example.com/file.zip', ['example.com'])).toBe(false)
    })

    it('does not match different domain', () => {
      expect(isUrlInWhitelist('https://other.com/file.zip', ['example.com'])).toBe(false)
    })
  })

  describe('wildcard domain matching', () => {
    it('matches all subdomains with *. prefix', () => {
      expect(isUrlInWhitelist('https://sub.example.com/file.zip', ['*.example.com'])).toBe(true)
    })

    it('matches nested subdomains with *. prefix', () => {
      expect(isUrlInWhitelist('https://deep.sub.example.com/file.zip', ['*.example.com'])).toBe(true)
    })

    it('matches the bare domain when wildcard is listed', () => {
      expect(isUrlInWhitelist('https://example.com/file.zip', ['*.example.com'])).toBe(true)
    })

    it('does not match unrelated domain', () => {
      expect(isUrlInWhitelist('https://other.com/file.zip', ['*.example.com'])).toBe(false)
    })
  })

  describe('protocol handling', () => {
    it('matches https URLs', () => {
      expect(isUrlInWhitelist('https://example.com/file.zip', ['example.com'])).toBe(true)
    })

    it('matches http URLs', () => {
      expect(isUrlInWhitelist('http://example.com/file.zip', ['example.com'])).toBe(true)
    })

    it('matches ftp URLs', () => {
      expect(isUrlInWhitelist('ftp://example.com/file.zip', ['example.com'])).toBe(true)
    })
  })

  describe('URLs with port and auth', () => {
    it('matches URLs with port numbers', () => {
      expect(isUrlInWhitelist('https://example.com:8080/file.zip', ['example.com'])).toBe(true)
    })

    it('matches URLs with userinfo', () => {
      expect(isUrlInWhitelist('https://user:pass@example.com/file.zip', ['example.com'])).toBe(true)
    })
  })

  describe('non-URL strings', () => {
    it('returns false for magnet URIs', () => {
      expect(isUrlInWhitelist('magnet:?xt=urn:btih:xxx', ['example.com'])).toBe(false)
    })

    it('returns false for ed2k URIs', () => {
      expect(isUrlInWhitelist('ed2k://|file|test.avi|...', ['example.com'])).toBe(false)
    })

    it('returns false for thunder URIs', () => {
      expect(isUrlInWhitelist('thunder://xxx', ['example.com'])).toBe(false)
    })
  })
})
