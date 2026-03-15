import { beforeEach, describe, expect, it } from 'vitest'
import { createBatchItem, mergeUriLines, normalizeUriLines, resetBatchIdCounter } from '../batchHelpers'

describe('normalizeUriLines', () => {
  it('splits lines, trims whitespace, drops blanks, and preserves first occurrence order', () => {
    expect(
      normalizeUriLines(`
        https://a.example/file
        magnet:?xt=urn:btih:abc
        d8988e034cb5de79d319242e3365bf30a7741a6e

        https://a.example/file
        thunder://foo
      `),
    ).toEqual([
      'https://a.example/file',
      'magnet:?xt=urn:btih:abc',
      'magnet:?xt=urn:btih:d8988e034cb5de79d319242e3365bf30a7741a6e',
      'thunder://foo',
    ])
  })

  it('handles multiline payload text exactly like a textarea source', () => {
    expect(normalizeUriLines('https://a.example/file\nhttps://b.example/file\nhttps://a.example/file\n')).toEqual([
      'https://a.example/file',
      'https://b.example/file',
    ])
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
