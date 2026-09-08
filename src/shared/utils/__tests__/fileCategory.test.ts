/**
 * @fileoverview TDD test suite for fileCategory.ts — smart file classification engine.
 *
 * Tests cover three public functions:
 *   - extractExtension: URL/filename → lowercase extension
 *   - resolveCategory:  extension × categories → matching FileCategory | undefined
 *   - resolveDownloadDir: URL × config → absolute target directory
 *
 * V2: FileCategory uses absolute `directory` paths (not relative subdirectory).
 */
import { describe, it, expect } from 'vitest'
import {
  extractExtension,
  resolveCategory,
  resolveDownloadDir,
  resolveFileSetCategory,
  validateCategoryUrlPatterns,
} from '../fileCategory'
import type { FileCategory } from '@shared/types'

// ── Test fixtures ───────────────────────────────────────────────────

const TEST_CATEGORIES: FileCategory[] = [
  {
    label: 'Videos',
    extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm'],
    directory: '/Users/test/Downloads/Videos',
    builtIn: true,
  },
  {
    label: 'Music',
    extensions: ['mp3', 'flac', 'aac', 'ogg', 'wav'],
    directory: '/Users/test/Downloads/Music',
    builtIn: true,
  },
  {
    label: 'Images',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    directory: '/Users/test/Downloads/Images',
    builtIn: true,
  },
  {
    label: 'Documents',
    extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt'],
    directory: '/Users/test/Downloads/Documents',
    builtIn: true,
  },
  {
    label: 'Archives',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz'],
    directory: '/Users/test/Downloads/Archives',
    builtIn: true,
  },
  {
    label: 'Programs',
    extensions: ['exe', 'msi', 'deb', 'dmg', 'pkg'],
    directory: '/Users/test/Downloads/Programs',
    builtIn: true,
  },
]

// ════════════════════════════════════════════════════════════════════
// extractExtension
// ════════════════════════════════════════════════════════════════════

describe('extractExtension', () => {
  // ── Standard URLs ──────────────────────────────────────────────

  it('extracts extension from simple HTTP URL', () => {
    expect(extractExtension('https://example.com/video.mp4')).toBe('mp4')
  })

  it('extracts extension from deep path URL', () => {
    expect(extractExtension('https://cdn.example.com/releases/v2/file.tar.gz')).toBe('gz')
  })

  it('extracts extension from SFTP URL', () => {
    expect(extractExtension('sftp://mirror.example.com/pub/archive.zip')).toBe('zip')
  })

  // ── Query strings & fragments ──────────────────────────────────

  it('ignores query string after filename', () => {
    expect(extractExtension('https://example.com/file.pdf?token=abc123&expires=999')).toBe('pdf')
  })

  it('ignores fragment after filename', () => {
    expect(extractExtension('https://example.com/file.docx#page=3')).toBe('docx')
  })

  it('handles URL with both query and fragment', () => {
    expect(extractExtension('https://dl.example.com/release.dmg?v=2#checksum')).toBe('dmg')
  })

  // ── Case insensitivity ─────────────────────────────────────────

  it('returns lowercase extension regardless of URL case', () => {
    expect(extractExtension('https://example.com/Image.PNG')).toBe('png')
  })

  it('returns lowercase for mixed-case extension', () => {
    expect(extractExtension('https://example.com/Setup.ExE')).toBe('exe')
  })

  // ── URL encoding ───────────────────────────────────────────────

  it('handles percent-encoded filename', () => {
    expect(extractExtension('https://example.com/%E6%96%87%E4%BB%B6.pdf')).toBe('pdf')
  })

  it('handles encoded path segments with extension', () => {
    expect(extractExtension('https://example.com/path%20to/my%20file.mp3')).toBe('mp3')
  })

  // ── Edge cases ─────────────────────────────────────────────────

  it('returns empty string for URL without extension', () => {
    expect(extractExtension('https://example.com/download')).toBe('')
  })

  it('returns empty string for URL with trailing slash', () => {
    expect(extractExtension('https://example.com/folder/')).toBe('')
  })

  it('returns empty string for bare domain', () => {
    expect(extractExtension('https://example.com')).toBe('')
  })

  it('returns empty string for magnet URI', () => {
    expect(extractExtension('magnet:?xt=urn:btih:abc123')).toBe('')
  })

  it('returns empty string for empty string input', () => {
    expect(extractExtension('')).toBe('')
  })

  it('returns extension from bare filename (no URL)', () => {
    expect(extractExtension('document.xlsx')).toBe('xlsx')
  })

  it('handles double extension (takes last)', () => {
    expect(extractExtension('https://example.com/archive.tar.gz')).toBe('gz')
  })

  it('returns empty string for dotfile without extension', () => {
    expect(extractExtension('https://example.com/.gitignore')).toBe('')
  })

  it('handles filename with multiple dots', () => {
    expect(extractExtension('https://example.com/v2.1.0-release.zip')).toBe('zip')
  })
})

// ════════════════════════════════════════════════════════════════════
// resolveCategory — returns the matching FileCategory object or undefined
// ════════════════════════════════════════════════════════════════════

describe('resolveCategory', () => {
  it('returns FileCategory object for matching video extension', () => {
    const result = resolveCategory('mp4', TEST_CATEGORIES)
    expect(result).toBeDefined()
    expect(result!.label).toBe('Videos')
    expect(result!.directory).toBe('/Users/test/Downloads/Videos')
  })

  it('returns FileCategory for matching archive extension', () => {
    const result = resolveCategory('zip', TEST_CATEGORIES)
    expect(result).toBeDefined()
    expect(result!.directory).toBe('/Users/test/Downloads/Archives')
  })

  it('returns FileCategory for matching program extension', () => {
    const result = resolveCategory('exe', TEST_CATEGORIES)
    expect(result).toBeDefined()
    expect(result!.directory).toBe('/Users/test/Downloads/Programs')
  })

  it('returns FileCategory for matching document extension', () => {
    const result = resolveCategory('pdf', TEST_CATEGORIES)
    expect(result?.directory).toBe('/Users/test/Downloads/Documents')
  })

  it('returns FileCategory for matching music extension', () => {
    const result = resolveCategory('flac', TEST_CATEGORIES)
    expect(result?.directory).toBe('/Users/test/Downloads/Music')
  })

  it('returns FileCategory for matching image extension', () => {
    const result = resolveCategory('png', TEST_CATEGORIES)
    expect(result?.directory).toBe('/Users/test/Downloads/Images')
  })

  it('returns undefined for unrecognized extension', () => {
    expect(resolveCategory('xyz', TEST_CATEGORIES)).toBeUndefined()
  })

  it('returns undefined for empty extension', () => {
    expect(resolveCategory('', TEST_CATEGORIES)).toBeUndefined()
  })

  it('returns first matching category when extension appears in multiple', () => {
    const overlapping: FileCategory[] = [
      { label: 'A', extensions: ['bin'], directory: '/first', builtIn: false },
      { label: 'B', extensions: ['bin'], directory: '/second', builtIn: false },
    ]
    const result = resolveCategory('bin', overlapping)
    expect(result?.directory).toBe('/first')
  })

  it('returns undefined for empty categories array', () => {
    expect(resolveCategory('mp4', [])).toBeUndefined()
  })

  it('matches custom category with absolute path', () => {
    const custom: FileCategory[] = [
      { label: 'Subtitles', extensions: ['srt', 'ass', 'sub'], directory: '/Volumes/NAS/Subtitles', builtIn: false },
    ]
    const result = resolveCategory('srt', custom)
    expect(result?.directory).toBe('/Volumes/NAS/Subtitles')
  })

  it('matches URL-only wildcard rules against the source URL', () => {
    const categories: FileCategory[] = [
      {
        label: 'Logs',
        extensions: [],
        urlPatterns: ['*://*.example.com/logs/*'],
        urlPatternMode: 'wildcard',
        directory: '/Users/test/Downloads/Logs',
      },
    ]

    const result = resolveCategory('', categories, { urls: ['https://cdn.example.com/logs/export'] })

    expect(result?.directory).toBe('/Users/test/Downloads/Logs')
  })

  it('requires both extension and URL rules when both are configured', () => {
    const categories: FileCategory[] = [
      {
        label: 'Logs',
        extensions: ['zip'],
        urlPatterns: ['*://*.example.com/logs/*'],
        urlPatternMode: 'wildcard',
        directory: '/Users/test/Downloads/Logs',
      },
    ]

    expect(resolveCategory('zip', categories, { urls: ['https://cdn.example.com/logs/export.zip'] })?.directory).toBe(
      '/Users/test/Downloads/Logs',
    )
    expect(resolveCategory('txt', categories, { urls: ['https://cdn.example.com/logs/export.txt'] })).toBeUndefined()
    expect(resolveCategory('zip', categories, { urls: ['https://cdn.other.com/logs/export.zip'] })).toBeUndefined()
  })

  it('matches URL regex rules and ignores invalid regex patterns', () => {
    const categories: FileCategory[] = [
      {
        label: 'Broken',
        extensions: [],
        urlPatterns: ['^https://(.+'],
        urlPatternMode: 'regex',
        directory: '/Users/test/Downloads/Broken',
      },
      {
        label: 'Reports',
        extensions: [],
        urlPatterns: ['^https://reports\\.example\\.com/.+\\.csv$'],
        urlPatternMode: 'regex',
        directory: '/Users/test/Downloads/Reports',
      },
    ]

    const result = resolveCategory('', categories, { urls: ['https://reports.example.com/monthly.csv'] })

    expect(result?.directory).toBe('/Users/test/Downloads/Reports')
  })
})

// ════════════════════════════════════════════════════════════════════
// validateCategoryUrlPatterns
// ════════════════════════════════════════════════════════════════════

describe('validateCategoryUrlPatterns', () => {
  it('accepts valid wildcard URL rules', () => {
    expect(validateCategoryUrlPatterns(['*://*.example.com/logs/*'], 'wildcard')).toBeUndefined()
  })

  it('reports the first invalid regex URL rule line', () => {
    expect(validateCategoryUrlPatterns(['^https://reports\\.example\\.com/.+$', '^https://(.+'], 'regex')).toEqual({
      line: 2,
      reason: 'invalid-regex',
    })
  })

  it('reports overlong URL rules instead of dropping them silently', () => {
    expect(validateCategoryUrlPatterns(['a'.repeat(513)], 'wildcard')).toEqual({
      line: 1,
      reason: 'too-long',
    })
  })
})

// ════════════════════════════════════════════════════════════════════
// resolveDownloadDir — uses FileCategory.directory (absolute path)
// ════════════════════════════════════════════════════════════════════

describe('resolveDownloadDir', () => {
  const BASE = '/Users/test/Downloads'

  it('returns category absolute directory for matching extension', () => {
    const result = resolveDownloadDir('https://example.com/movie.mp4', BASE, true, TEST_CATEGORIES)
    expect(result).toBe('/Users/test/Downloads/Videos')
  })

  it('returns baseDir when extension does not match any category', () => {
    const result = resolveDownloadDir('https://example.com/file.xyz', BASE, true, TEST_CATEGORIES)
    expect(result).toBe(BASE)
  })

  it('returns baseDir when feature is disabled', () => {
    const result = resolveDownloadDir('https://example.com/movie.mp4', BASE, false, TEST_CATEGORIES)
    expect(result).toBe(BASE)
  })

  it('returns baseDir for URL without extension', () => {
    const result = resolveDownloadDir('https://example.com/download', BASE, true, TEST_CATEGORIES)
    expect(result).toBe(BASE)
  })

  it('returns baseDir for magnet URI', () => {
    const result = resolveDownloadDir('magnet:?xt=urn:btih:abc123', BASE, true, TEST_CATEGORIES)
    expect(result).toBe(BASE)
  })

  it('returns baseDir when categories are empty', () => {
    const result = resolveDownloadDir('https://example.com/movie.mp4', BASE, true, [])
    expect(result).toBe(BASE)
  })

  it('uses category absolute path even when baseDir differs', () => {
    // Category points to /Volumes/NAS/Videos, baseDir is ~/Downloads
    const customCats: FileCategory[] = [
      { label: 'Videos', extensions: ['mp4'], directory: '/Volumes/NAS/Videos', builtIn: false },
    ]
    const result = resolveDownloadDir('https://example.com/movie.mp4', BASE, true, customCats)
    expect(result).toBe('/Volumes/NAS/Videos')
  })

  it('classifies document by extension from URL with query string', () => {
    const result = resolveDownloadDir('https://example.com/report.pdf?token=secret', BASE, true, TEST_CATEGORIES)
    expect(result).toBe('/Users/test/Downloads/Documents')
  })

  it('classifies archive case-insensitively', () => {
    const result = resolveDownloadDir('https://example.com/BACKUP.ZIP', BASE, true, TEST_CATEGORIES)
    expect(result).toBe('/Users/test/Downloads/Archives')
  })

  it('classifies program installer correctly', () => {
    const result = resolveDownloadDir('https://example.com/setup.exe', BASE, true, TEST_CATEGORIES)
    expect(result).toBe('/Users/test/Downloads/Programs')
  })

  it('handles Windows-style category directory', () => {
    const winCats: FileCategory[] = [
      { label: 'Images', extensions: ['jpg'], directory: 'D:\\Downloads\\Images', builtIn: true },
    ]
    const result = resolveDownloadDir('https://example.com/photo.jpg', 'D:\\Downloads', true, winCats)
    expect(result).toBe('D:\\Downloads\\Images')
  })

  it('routes extensionless downloads by URL rules', () => {
    const categories: FileCategory[] = [
      {
        label: 'Reports',
        extensions: [],
        urlPatterns: ['*://reports.example.com/export/*'],
        urlPatternMode: 'wildcard',
        directory: '/Users/test/Downloads/Reports',
      },
    ]

    const result = resolveDownloadDir('https://reports.example.com/export/latest', BASE, true, categories)

    expect(result).toBe('/Users/test/Downloads/Reports')
  })

  it('treats wildcard URL rules as plain URL text patterns', () => {
    const categories: FileCategory[] = [
      {
        label: 'Example',
        extensions: [],
        urlPatterns: ['*example.com*'],
        urlPatternMode: 'wildcard',
        directory: '/Users/test/Downloads/Example',
      },
    ]

    const result = resolveDownloadDir('https://example.com/a/b/file.zip?token=1', BASE, true, categories)

    expect(result).toBe('/Users/test/Downloads/Example')
  })
})

describe('resolveFileSetCategory', () => {
  it('classifies a single torrent payload file', () => {
    const result = resolveFileSetCategory([{ path: 'release/movie.mkv' }], TEST_CATEGORIES)
    expect(result?.directory).toBe('/Users/test/Downloads/Videos')
  })

  it('classifies selected files that share one category', () => {
    const result = resolveFileSetCategory(
      [{ path: 'album/track-1.flac' }, { path: 'album/track-2.mp3' }],
      TEST_CATEGORIES,
    )
    expect(result?.directory).toBe('/Users/test/Downloads/Music')
  })

  it('keeps mixed torrent content in the default directory', () => {
    const result = resolveFileSetCategory(
      [{ path: 'release/movie.mkv' }, { path: 'release/readme.txt' }],
      TEST_CATEGORIES,
    )
    expect(result).toBeUndefined()
  })

  it('keeps partially unclassified content in the default directory', () => {
    const result = resolveFileSetCategory(
      [{ path: 'release/movie.mkv' }, { path: 'release/subtitle.srt' }],
      TEST_CATEGORIES,
    )
    expect(result).toBeUndefined()
  })
})
