import { describe, expect, it } from 'vitest'
import {
  createBatchItem,
  detectExternalInputKind,
  detectKind,
  extractMagnetDisplayName,
  mergeRawUriLines,
  normalizeUriLines,
  decodePathSegment,
  extractDecodedFilename,
  sanitizeAria2OutHint,
  resolveExternalFilenameHint,
  parseAria2Input,
} from '../batchHelpers'

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

  it('converts a bare BitTorrent v2 hash', () => {
    const sha256 = 'aabbccddee00112233445566778899aabbccddee00112233445566778899aabb'
    expect(normalizeUriLines(sha256)).toEqual([`magnet:?xt=urn:btmh:1220${sha256}`])
  })

  it('does not touch already-prefixed magnet URIs', () => {
    const full = 'magnet:?xt=urn:btih:d8988e034cb5de79d319242e3365bf30a7741a6e'
    expect(normalizeUriLines(full)).toEqual([full])
  })

  it('keeps Thunder links wrapped for engine parsing', () => {
    const thunder = 'thunder://' + btoa('AAhttps://example.com/file.zipZZ')
    expect(normalizeUriLines(thunder)).toEqual([thunder])
  })

  it('keeps mixed-case Thunder schemes wrapped for engine parsing', () => {
    const thunder = 'Thunder://' + btoa('AAhttps://example.com/file.zipZZ')
    expect(normalizeUriLines(thunder)).toEqual([thunder])
  })

  it('deduplicates Thunder links by exact normalized line', () => {
    const thunder = 'thunder://' + btoa('AAhttps://example.com/file.zipZZ')
    expect(normalizeUriLines(`${thunder}\n${thunder}`)).toEqual([thunder])
  })
})

describe('parseAria2Input', () => {
  it('parses aria2 input-file entries with per-task options', () => {
    expect(
      parseAria2Input(`
        https://example.com/index.html
          out=index1.html
        https://example.com/index.html
          out=index2.html
      `).entries,
    ).toEqual([
      { uris: ['https://example.com/index.html'], options: { out: 'index1.html' } },
      { uris: ['https://example.com/index.html'], options: { out: 'index2.html' } },
    ])
  })

  it('keeps tab-separated mirrors as one aria2 task', () => {
    expect(
      parseAria2Input('https://mirror-a.example/file.zip\thttps://mirror-b.example/file.zip\n  out=file.zip').entries,
    ).toEqual([
      {
        uris: ['https://mirror-a.example/file.zip', 'https://mirror-b.example/file.zip'],
        options: { out: 'file.zip' },
      },
    ])
  })

  it('keeps cumulative header options in input order', () => {
    expect(
      parseAria2Input(
        [
          'https://example.com/file.zip',
          '  header=Accept-Language: en-US,en;q=0.9',
          '  header=Cookie: a=b',
          '  checksum=sha-256=abc',
        ].join('\n'),
      ).entries,
    ).toEqual([
      {
        uris: ['https://example.com/file.zip'],
        options: {
          header: ['Accept-Language: en-US,en;q=0.9', 'Cookie: a=b'],
          checksum: 'sha-256=abc',
        },
      },
    ])
  })

  it('does not treat orphan option lines as URIs', () => {
    expect(parseAria2Input('  out=orphan.html\nhttps://example.com/file.zip').entries).toEqual([
      { uris: ['https://example.com/file.zip'], options: {} },
    ])
  })

  it('ignores malformed indented option lines after a task', () => {
    expect(parseAria2Input('https://example.com/file.zip\n  malformed-option-line').entries).toEqual([
      { uris: ['https://example.com/file.zip'], options: {} },
    ])
  })
})

describe('mergeRawUriLines', () => {
  it('keeps Thunder links raw while still trimming blanks and deduplicating exact lines', () => {
    const thunder = 'thunder://' + btoa('AAhttps://example.com/file.zipZZ')

    expect(mergeRawUriLines('', [` ${thunder} \n\n${thunder}`])).toBe(thunder)
  })

  it('normalizes bare info hashes for display parity with manual URI input', () => {
    const hash = 'd8988e034cb5de79d319242e3365bf30a7741a6e'

    expect(mergeRawUriLines('', [hash])).toBe(`magnet:?xt=urn:btih:${hash}`)
  })
})

// ── detectKind ────────────────────────────────────────────────────────
// Scheme-first → remote URI download → local path suffix → fallback.

describe('detectKind', () => {
  // ── 1. Scheme-first: magnet / thunder ──────────────────────────────

  it('classifies plain magnet URIs as uri', () => {
    expect(detectKind('magnet:?xt=urn:btih:abc123')).toBe('uri')
  })

  it('classifies magnet URIs with tracker.torrent.eu.org as uri (regression)', () => {
    const magnet =
      'magnet:?xt=urn:btih:a09e89b13c5347a2e3414aaa6556c950bf9a6277' +
      '&dn=test&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce'
    expect(detectKind(magnet)).toBe('uri')
  })

  it('classifies thunder:// links as uri', () => {
    expect(detectKind('thunder://QUFodHRwOi8vZXhhbXBsZS5jb20vZmlsZS56aXBaWg==')).toBe('uri')
  })

  it('classifies ED2K file links as uri', () => {
    expect(detectKind('ed2k://|file|Ubuntu%2026.04.iso|123456789|0123456789abcdef0123456789abcdef|/')).toBe('uri')
  })

  // ── 2. Remote URLs: pathname-only extension match ──────────────────

  it('classifies remote .torrent URLs as uri for manual downloads', () => {
    expect(detectKind('https://example.com/files/download.torrent')).toBe('uri')
  })

  it('classifies remote .torrent URLs with query params as uri for manual downloads', () => {
    expect(detectKind('https://example.com/file.torrent?token=abc&v=2')).toBe('uri')
  })

  it('classifies remote URLs with .torrent in hostname but not pathname as uri', () => {
    expect(detectKind('https://tracker.torrent.eu.org/announce')).toBe('uri')
  })

  it('classifies remote URLs with .torrent in query but not pathname as uri', () => {
    expect(detectKind('https://example.com/download?file=a.torrent')).toBe('uri')
  })

  it('classifies plain HTTP URLs as uri', () => {
    expect(detectKind('https://example.com/file.zip')).toBe('uri')
  })

  it('classifies SFTP URLs with .torrent as uri', () => {
    expect(detectKind('sftp://mirror.example.com/pub/file.torrent')).toBe('uri')
  })

  // ── 3. Local file paths ───────────────────────────────────────────

  it('classifies local .torrent paths as torrent', () => {
    expect(detectKind('/Users/me/Downloads/ubuntu.torrent')).toBe('torrent')
  })

  it('classifies external remote .torrent URLs as torrent', () => {
    expect(detectExternalInputKind('https://example.com/files/download.torrent')).toBe('torrent')
    expect(detectExternalInputKind('https://example.com/file.torrent?token=abc&v=2')).toBe('torrent')
  })

  // ── 4. Fallback ───────────────────────────────────────────────────

  it('classifies unknown URIs as uri', () => {
    expect(detectKind('ed2k://|file|example|123|abc|/')).toBe('uri')
  })
})

// ── extractMagnetDisplayName ────────────────────────────────────────

describe('extractMagnetDisplayName', () => {
  it('extracts dn from a standard magnet URI', () => {
    const uri = 'magnet:?xt=urn:btih:abc123&dn=Ubuntu+24.04+LTS'
    expect(extractMagnetDisplayName(uri)).toBe('Ubuntu 24.04 LTS')
  })

  it('decodes percent-encoded UTF-8 dn values', () => {
    const uri = 'magnet:?xt=urn:btih:abc&dn=caf%C3%A9'
    expect(extractMagnetDisplayName(uri)).toBe('café')
  })

  it('returns empty string when dn is absent', () => {
    expect(extractMagnetDisplayName('magnet:?xt=urn:btih:abc123')).toBe('')
  })

  it('returns empty string for non-magnet URIs', () => {
    expect(extractMagnetDisplayName('https://example.com?dn=test')).toBe('')
  })

  it('returns empty string for bare magnet: without query', () => {
    expect(extractMagnetDisplayName('magnet:')).toBe('')
  })

  it('handles dn with special characters', () => {
    const uri = 'magnet:?xt=urn:btih:abc&dn=File%20%26%20Folder%20(2024)'
    expect(extractMagnetDisplayName(uri)).toBe('File & Folder (2024)')
  })

  it('handles dn with tracker params after it', () => {
    const uri = 'magnet:?xt=urn:btih:abc&dn=Test+Name&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451'
    expect(extractMagnetDisplayName(uri)).toBe('Test Name')
  })
})

describe('createBatchItem', () => {
  it('uses source as payload for uri items', () => {
    const item = createBatchItem('uri', 'magnet:?xt=urn:btih:abc')
    expect(item.payload).toBe('magnet:?xt=urn:btih:abc')
  })

  it('assigns distinct IDs to separate items', () => {
    const a = createBatchItem('uri', 'https://a.example/file')
    const b = createBatchItem('uri', 'https://b.example/file')
    expect(a.id).not.toBe(b.id)
  })
})

// ── decodePathSegment ─────────────────────────────────────────────────

describe('decodePathSegment', () => {
  it('decodes percent-encoded spaces', () => {
    expect(decodePathSegment('AAA%20BBB')).toBe('AAA BBB')
  })

  it('decodes UTF-8 percent sequences', () => {
    expect(decodePathSegment('r%C3%A9sum%C3%A9')).toBe('résumé')
  })

  it('returns original string for malformed percent sequence', () => {
    expect(decodePathSegment('bad%ZZname')).toBe('bad%ZZname')
  })

  it('returns unencoded strings unchanged', () => {
    expect(decodePathSegment('normal.txt')).toBe('normal.txt')
  })

  it('returns empty string for empty input', () => {
    expect(decodePathSegment('')).toBe('')
  })

  it('handles string with only a percent sign', () => {
    // '%' alone is malformed, decodeURIComponent throws → returns original
    expect(decodePathSegment('%')).toBe('%')
  })
})

// ── extractDecodedFilename ────────────────────────────────────────────

describe('extractDecodedFilename', () => {
  it('decodes percent-encoded spaces in HTTP URIs', () => {
    expect(extractDecodedFilename('http://example.com/AAA%20BBB.mp3')).toBe('AAA BBB.mp3')
  })

  it('decodes UTF-8 percent sequences', () => {
    expect(extractDecodedFilename('http://example.com/file-r%C3%A9sum%C3%A9.txt')).toBe('file-résumé.txt')
  })

  it('returns unencoded filename unchanged', () => {
    expect(extractDecodedFilename('http://example.com/plain.zip')).toBe('plain.zip')
  })

  it('strips query string and fragment before extracting', () => {
    expect(extractDecodedFilename('http://example.com/file.zip?v=1&t=2#section')).toBe('file.zip')
  })

  it('handles deep paths and extracts only the last segment', () => {
    expect(extractDecodedFilename('https://cdn.example.com/a/b/c/deep%20file.tar.gz')).toBe('deep file.tar.gz')
  })

  it('sanitizes decoded forward slashes to underscores (path traversal defense)', () => {
    expect(extractDecodedFilename('http://example.com/a%2Fb.txt')).toBe('a_b.txt')
  })

  it('sanitizes Windows-unsafe characters to underscores', () => {
    expect(extractDecodedFilename('http://example.com/a%3Ab%2Ac.txt')).toBe('a_b_c.txt')
  })

  it('returns empty string for trailing-slash URIs (no filename)', () => {
    expect(extractDecodedFilename('http://example.com/')).toBe('')
  })

  it('returns empty string for bare domain URIs', () => {
    expect(extractDecodedFilename('http://example.com')).toBe('')
  })

  it('returns empty string for magnet URIs', () => {
    expect(extractDecodedFilename('magnet:?xt=urn:btih:abc123')).toBe('')
  })

  it('extracts the display filename from ED2K file links', () => {
    expect(
      extractDecodedFilename('ed2k://|file|Ubuntu%2026.04%20LTS.iso|123456789|0123456789abcdef0123456789abcdef|/'),
    ).toBe('Ubuntu 26.04 LTS.iso')
  })

  it('sanitizes unsafe characters in ED2K filenames', () => {
    expect(extractDecodedFilename('ed2k://|file|bad%2Fname%3F.iso|123|0123456789abcdef0123456789abcdef|/')).toBe(
      'bad_name_.iso',
    )
  })

  it('returns empty string for data URIs', () => {
    expect(extractDecodedFilename('data:text/plain;base64,SGVsbG8=')).toBe('')
  })

  it('returns original segment for malformed percent sequence', () => {
    expect(extractDecodedFilename('http://example.com/bad%ZZname.txt')).toBe('bad%ZZname.txt')
  })

  it('handles SFTP URIs', () => {
    expect(extractDecodedFilename('sftp://files.example.com/pub/file%20name.tar.gz')).toBe('file name.tar.gz')
  })

  it('returns empty string for blob URIs', () => {
    expect(extractDecodedFilename('blob:http://example.com/abc-123')).toBe('')
  })

  it('preserves plus signs (not decoded as spaces in path segments)', () => {
    // Plus in URL path is a literal +, not a space (RFC 3986)
    expect(extractDecodedFilename('http://example.com/file+name.zip')).toBe('file+name.zip')
  })

  it('handles double-encoded sequences by decoding only once', () => {
    // %2520 → first decode → %20 (the literal string %20, not a space)
    expect(extractDecodedFilename('http://example.com/file%2520name.zip')).toBe('file%20name.zip')
  })

  it('handles HTTPS with port number', () => {
    expect(extractDecodedFilename('https://cdn.example.com:8443/path/file%20name.zip')).toBe('file name.zip')
  })

  it('handles already-decoded filenames without re-encoding', () => {
    expect(extractDecodedFilename('http://example.com/already decoded.zip')).toBe('already decoded.zip')
  })

  it('rejects filenames that are only dots', () => {
    expect(extractDecodedFilename('http://example.com/..')).toBe('')
    expect(extractDecodedFilename('http://example.com/.')).toBe('')
  })

  it('sanitizes backslash in decoded filename', () => {
    // %5C = backslash
    expect(extractDecodedFilename('http://example.com/path%5Cfile.txt')).toBe('path_file.txt')
  })
})

// ── sanitizeAria2OutHint ─────────────────────────────────────────────
// Pure filesystem safety — no business logic. Any out value (user-typed
// or extension-provided) is safe to pass through this function.

describe('sanitizeAria2OutHint', () => {
  it('returns clean filename unchanged', () => {
    expect(sanitizeAria2OutHint('file.zip')).toBe('file.zip')
  })

  it('strips path prefixes (basename extraction)', () => {
    expect(sanitizeAria2OutHint('/home/user/Downloads/file.zip')).toBe('file.zip')
    expect(sanitizeAria2OutHint('C:\\Users\\Downloads\\file.zip')).toBe('file.zip')
  })

  it('strips query string pollution from extension filenames', () => {
    expect(sanitizeAria2OutHint('photo.jpg?token=abc')).toBe('photo.jpg')
  })

  it('strips fragment pollution', () => {
    expect(sanitizeAria2OutHint('file.pdf#page=3')).toBe('file.pdf')
  })

  it('replaces filesystem-unsafe characters with underscores', () => {
    expect(sanitizeAria2OutHint('a:b*c.jpg')).toBe('a_b_c.jpg')
    expect(sanitizeAria2OutHint('what?.jpg')).toBe('what_.jpg')
    expect(sanitizeAria2OutHint('file<>name.txt')).toBe('file__name.txt')
  })

  it('does not drop HEAD-resolved names that start with replacement question marks', () => {
    expect(sanitizeAria2OutHint('????? ??? 2026.xlsx')).toBe('_____ ___ 2026.xlsx')
  })

  it('decodes RFC 2047 encoded-word filenames before filesystem sanitization', () => {
    expect(sanitizeAria2OutHint('=?UTF-8?B?0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4?=')).toBe('ИТОГИ ЛДУ 2026.xlsx')
  })

  it('decodes percent-encoded RFC 2047 filenames before filesystem sanitization', () => {
    expect(sanitizeAria2OutHint('=%3FUTF-8%3FB%3F0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4%3F=')).toBe('ИТОГИ ЛДУ 2026.xlsx')
  })

  it('decodes legacy percent-encoded UTF-8 filenames before filesystem sanitization', () => {
    expect(
      sanitizeAria2OutHint(
        'K430006866701%20%20%20%20%2020251022%20%20%20ASKO%20%20%20%20CW5937GCN%20%20%20%20%20CW51237GCN%E8%AF%B4%E6%98%8E%E4%B9%A6%28%E6%96%B0%E5%9B%BD%E6%A0%87%29.pdf',
      ),
    ).toBe('K430006866701     20251022   ASKO    CW5937GCN     CW51237GCN说明书(新国标).pdf')
  })

  it('keeps percent-decoded slashes inside a single safe filename', () => {
    expect(sanitizeAria2OutHint('safe%2Fevil.pdf')).toBe('safe_evil.pdf')
  })

  it('removes control characters', () => {
    expect(sanitizeAria2OutHint('\x01\x02file.jpg')).toBe('file.jpg')
  })

  it('trims trailing dots and spaces', () => {
    expect(sanitizeAria2OutHint('file.jpg...')).toBe('file.jpg')
    expect(sanitizeAria2OutHint('file.jpg   ')).toBe('file.jpg')
  })

  it('preserves extensionless filenames', () => {
    expect(sanitizeAria2OutHint('README')).toBe('README')
    expect(sanitizeAria2OutHint('Makefile')).toBe('Makefile')
  })

  it('preserves accented filenames', () => {
    expect(sanitizeAria2OutHint('résumé.pdf')).toBe('résumé.pdf')
  })

  it('returns empty for empty input', () => {
    expect(sanitizeAria2OutHint('')).toBe('')
  })

  it('returns empty for pure dots', () => {
    expect(sanitizeAria2OutHint('...')).toBe('')
  })

  it('returns empty for query-only strings', () => {
    expect(sanitizeAria2OutHint('?format=jpg')).toBe('')
  })
})

// ── resolveExternalFilenameHint ──────────────────────────────────────
// Smart external hint validation: decides whether to trust the extension
// filename or let resolve_filename HEAD take over.

describe('resolveExternalFilenameHint', () => {
  // ── Accept: hint has extension ─────────────────────────────────────

  it('accepts cloud drive filename with extension', () => {
    expect(resolveExternalFilenameHint('https://cdn.cloud.com/abc123', 'résumé.pdf')).toBe('résumé.pdf')
  })

  it('accepts RFC 2047 encoded-word external filename hints after decoding', () => {
    expect(
      resolveExternalFilenameHint(
        'https://mail-attachment.googleusercontent.com/attachment/u/0/',
        '=?UTF-8?B?0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4?=',
      ),
    ).toBe('ИТОГИ ЛДУ 2026.xlsx')
  })

  it('accepts hint with extension even when it matches URL basename', () => {
    expect(resolveExternalFilenameHint('https://example.com/photo.jpg', 'photo.jpg')).toBe('photo.jpg')
  })

  it('accepts hint after stripping query params and the result has extension', () => {
    expect(resolveExternalFilenameHint('https://cdn.example.com/photo.jpg?token=1', 'photo.jpg?token=1')).toBe(
      'photo.jpg',
    )
  })

  it('accepts hint with illegal chars after sanitization if it has extension', () => {
    // `?` stripped first as query boundary, then `:` and `*` replaced
    expect(resolveExternalFilenameHint('https://example.com/file', 'a:b*c.jpg')).toBe('a_b_c.jpg')
  })

  // ── Reject: extensionless and same as URL basename ────────────────

  it('rejects Twitter CDN filename (extensionless, matches URL basename)', () => {
    expect(
      resolveExternalFilenameHint(
        'https://pbs.twimg.com/media/G9v9wWdasAYNqt9?format=jpg&name=large',
        'G9v9wWdasAYNqt9?format=jpg&name=large',
      ),
    ).toBe('')
  })

  it('rejects extensionless hint that matches URL basename exactly', () => {
    expect(resolveExternalFilenameHint('https://cdn.example.com/abc123', 'abc123')).toBe('')
  })

  it('rejects generic browser fallback filename without extension', () => {
    expect(
      resolveExternalFilenameHint('https://mail-attachment.googleusercontent.com/attachment/u/0/', 'download'),
    ).toBe('')
  })

  it('rejects numeric browser placeholder filename for extensionless attachment URL', () => {
    expect(resolveExternalFilenameHint('https://mail-attachment.googleusercontent.com/attachment/u/0/', '0.xlsx')).toBe(
      '',
    )
  })

  // ── Accept: extensionless but different from URL basename ─────────

  it('accepts extensionless hint when different from URL basename (cloud drive real name)', () => {
    expect(resolveExternalFilenameHint('https://cdn.cloud.com/randomhash', 'README')).toBe('README')
  })

  it('accepts extensionless hint when different from URL basename', () => {
    expect(resolveExternalFilenameHint('https://cdn.example.com/abc123', 'Makefile')).toBe('Makefile')
  })

  // ── Edge cases ────────────────────────────────────────────────────

  it('returns empty for empty hint', () => {
    expect(resolveExternalFilenameHint('https://example.com/file', '')).toBe('')
  })

  it('returns empty for hint that sanitizes to empty', () => {
    expect(resolveExternalFilenameHint('https://example.com/file', '?format=jpg')).toBe('')
  })

  it('returns empty for pure-dot hint', () => {
    expect(resolveExternalFilenameHint('https://example.com/file', '...')).toBe('')
  })

  it('handles non-HTTP URLs gracefully', () => {
    // magnet URI → extractDecodedFilename returns '' → comparison impossible → accept hint
    expect(resolveExternalFilenameHint('magnet:?xt=urn:btih:abc', 'download.torrent')).toBe('download.torrent')
  })
})
