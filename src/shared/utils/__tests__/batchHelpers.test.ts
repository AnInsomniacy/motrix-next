import { beforeEach, describe, expect, it } from 'vitest'
import { createBatchItem, mergeUriLines, normalizeUriLines, resetBatchIdCounter } from '../batchHelpers'

describe('normalizeUriLines', () => {
  it('splits lines, trims whitespace, drops blanks, and preserves first occurrence order', () => {
    expect(
      normalizeUriLines(`
        https://a.example/file
        magnet:?xt=urn:btih:abc

        https://a.example/file
        thunder://foo
      `),
    ).toEqual(['https://a.example/file', 'magnet:?xt=urn:btih:abc', 'thunder://foo'])
  })

  it('handles multiline payload text exactly like a textarea source', () => {
    expect(normalizeUriLines('https://a.example/file\nhttps://b.example/file\nhttps://a.example/file\n')).toEqual([
      'https://a.example/file',
      'https://b.example/file',
    ])
  })

  // ── Bare info hash normalization ────────────────────────────────────

  it('converts a bare SHA-1 hex hash (40 chars) to a magnet URI', () => {
    const hash = 'd8988e034cb5de79d319242e3365bf30a7741a6e'
    expect(normalizeUriLines(hash)).toEqual([`magnet:?xt=urn:btih:${hash}`])
  })

  it('converts an uppercase SHA-1 hex hash (40 chars) to a magnet URI', () => {
    const hash = 'D8988E034CB5DE79D319242E3365BF30A7741A6E'
    expect(normalizeUriLines(hash)).toEqual([`magnet:?xt=urn:btih:${hash}`])
  })

  it('converts a bare Base32 hash (32 chars) to a magnet URI', () => {
    const hash = 'TCIY4A2MWXPHTUYZEQUOMNS7GCDXOQTG'
    expect(normalizeUriLines(hash)).toEqual([`magnet:?xt=urn:btih:${hash}`])
  })

  it('normalizes bare hashes mixed with regular URIs', () => {
    const hash = 'aabbccddee00112233445566778899aabbccddee'
    expect(normalizeUriLines(`https://example.com/file.zip\n${hash}\nmagnet:?xt=urn:btih:existing`)).toEqual([
      'https://example.com/file.zip',
      `magnet:?xt=urn:btih:${hash}`,
      'magnet:?xt=urn:btih:existing',
    ])
  })

  it('deduplicates identical bare hashes', () => {
    const hash = 'd8988e034cb5de79d319242e3365bf30a7741a6e'
    expect(normalizeUriLines(`${hash}\n${hash}`)).toEqual([`magnet:?xt=urn:btih:${hash}`])
  })

  it('does NOT convert strings of wrong length (39 chars)', () => {
    const short = 'd8988e034cb5de79d319242e3365bf30a7741a6'
    expect(normalizeUriLines(short)).toEqual([short])
  })

  it('does NOT convert strings of wrong length (41 chars)', () => {
    const long = 'd8988e034cb5de79d319242e3365bf30a7741a6ef'
    expect(normalizeUriLines(long)).toEqual([long])
  })

  it('does NOT convert 64-char hex (SHA-256/BT v2 — unsupported by aria2)', () => {
    const sha256 = 'aabbccddee00112233445566778899aabbccddee00112233445566778899aabb'
    expect(normalizeUriLines(sha256)).toEqual([sha256])
  })

  it('does not touch already-prefixed magnet URIs', () => {
    const full = 'magnet:?xt=urn:btih:d8988e034cb5de79d319242e3365bf30a7741a6e'
    expect(normalizeUriLines(full)).toEqual([full])
  })
})

describe('mergeUriLines', () => {
  it('merges existing textarea content with incoming uri payloads and deduplicates per line', () => {
    const merged = mergeUriLines('https://a.example/file\nhttps://b.example/file', [
      'https://b.example/file',
      'https://c.example/file',
      'https://a.example/file\nhttps://d.example/file',
    ])

    expect(merged).toBe(
      ['https://a.example/file', 'https://b.example/file', 'https://c.example/file', 'https://d.example/file'].join(
        '\n',
      ),
    )
  })

  it('treats multiline incoming payloads as independent uri lines instead of one opaque blob', () => {
    const merged = mergeUriLines('https://a.example/file', ['https://b.example/file\nhttps://c.example/file'])

    expect(merged).toBe(['https://a.example/file', 'https://b.example/file', 'https://c.example/file'].join('\n'))
  })

  it('returns normalized existing content when incoming payloads are empty or duplicates', () => {
    const merged = mergeUriLines(' https://a.example/file \n\nhttps://a.example/file ', [
      '',
      'https://a.example/file',
      '   ',
    ])

    expect(merged).toBe('https://a.example/file')
  })
})

describe('createBatchItem', () => {
  beforeEach(() => {
    resetBatchIdCounter()
  })

  it('uses source as payload for uri items', () => {
    const item = createBatchItem('uri', 'magnet:?xt=urn:btih:abc')
    expect(item.payload).toBe('magnet:?xt=urn:btih:abc')
  })

  it('creates stable sequential ids for deterministic tests', () => {
    const a = createBatchItem('uri', 'https://a.example/file')
    const b = createBatchItem('uri', 'https://b.example/file')
    expect(a.id).toBe('batch-1')
    expect(b.id).toBe('batch-2')
  })
})
