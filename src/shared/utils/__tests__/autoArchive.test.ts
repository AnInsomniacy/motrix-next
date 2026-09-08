/**
 * @fileoverview TDD test suite for autoArchive.ts — post-download classification.
 *
 * Tests the resolveArchiveAction function that determines whether a completed
 * download should be moved to a category directory based on its real filename
 * (as resolved by aria2 via Content-Disposition / URL path).
 *
 * Written BEFORE implementation per TDD discipline.
 */
import { describe, it, expect } from 'vitest'
import { resolveArchiveAction } from '../autoArchive'
import type { Aria2Task, FileCategory } from '@shared/types'

// ── Test fixtures ───────────────────────────────────────────────────

const CATEGORIES: FileCategory[] = [
  { label: 'Videos', extensions: ['mp4', 'mkv', 'avi'], directory: '/Users/test/Downloads/Videos', builtIn: true },
  { label: 'Music', extensions: ['mp3', 'flac'], directory: '/Users/test/Downloads/Music', builtIn: true },
  { label: 'Documents', extensions: ['pdf', 'docx'], directory: '/Users/test/Downloads/Documents', builtIn: true },
  { label: 'Archives', extensions: ['zip', '7z'], directory: '/Users/test/Downloads/Archives', builtIn: true },
]

/** Builds a minimal Aria2Task with the given file path and directory. */
function makeTask(filePath: string, dir: string): Aria2Task {
  return {
    gid: 'test-gid',
    status: 'complete',
    totalLength: '1000',
    completedLength: '1000',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir,
    files: [
      {
        index: '1',
        path: filePath,
        length: '1000',
        completedLength: '1000',
        selected: 'true',
        uris: [],
      },
    ],
  }
}

// ════════════════════════════════════════════════════════════════════
// resolveArchiveAction
// ════════════════════════════════════════════════════════════════════

const BASE_DIR = '/Users/test/Downloads'

describe('resolveArchiveAction', () => {
  // ── Positive cases: should archive ─────────────────────────────

  it('returns archive action for video file in default directory', () => {
    const task = makeTask('/Users/test/Downloads/movie.mp4', '/Users/test/Downloads')
    const result = resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)
    expect(result).not.toBeNull()
    expect(result!.source).toBe('/Users/test/Downloads/movie.mp4')
    expect(result!.targetDir).toBe('/Users/test/Downloads/Videos')
  })

  it('returns archive action for document downloaded without pre-classification', () => {
    const task = makeTask('/Users/test/Downloads/report.pdf', '/Users/test/Downloads')
    const result = resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)
    expect(result).not.toBeNull()
    expect(result!.targetDir).toBe('/Users/test/Downloads/Documents')
  })

  it('returns archive action for music file', () => {
    const task = makeTask('/Users/test/Downloads/song.flac', '/Users/test/Downloads')
    const result = resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)
    expect(result).not.toBeNull()
    expect(result!.targetDir).toBe('/Users/test/Downloads/Music')
  })

  it('returns archive action for archive file', () => {
    const task = makeTask('/Users/test/Downloads/backup.zip', '/Users/test/Downloads')
    const result = resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)
    expect(result).not.toBeNull()
    expect(result!.targetDir).toBe('/Users/test/Downloads/Archives')
  })

  // ── Negative cases: should NOT archive ─────────────────────────

  it('returns null when classification is disabled', () => {
    const task = makeTask('/Users/test/Downloads/movie.mp4', '/Users/test/Downloads')
    expect(resolveArchiveAction(task, false, CATEGORIES, BASE_DIR)).toBeNull()
  })

  it('returns null when extension does not match any category', () => {
    const task = makeTask('/Users/test/Downloads/readme.txt', '/Users/test/Downloads')
    expect(resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)).toBeNull()
  })

  it('returns null when file is already in the target category directory', () => {
    // Pre-download classification already placed it correctly
    const task = makeTask('/Users/test/Downloads/Videos/movie.mp4', '/Users/test/Downloads/Videos')
    expect(resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)).toBeNull()
  })

  it('returns null when file is in a user-specified custom path', () => {
    // User intentionally chose Desktop — auto-archive must NOT move it
    const task = makeTask('/Users/test/Desktop/movie.mp4', '/Users/test/Desktop')
    expect(resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)).toBeNull()
  })

  it('returns null when task has no files', () => {
    const task: Aria2Task = {
      gid: 'test-gid',
      status: 'complete',
      totalLength: '0',
      completedLength: '0',
      uploadLength: '0',
      downloadSpeed: '0',
      uploadSpeed: '0',
      connections: '0',
      dir: '/Users/test/Downloads',
      files: [],
    }
    expect(resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)).toBeNull()
  })

  it('returns null when file path is empty', () => {
    const task = makeTask('', '/Users/test/Downloads')
    expect(resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)).toBeNull()
  })

  it('returns null when categories array is empty', () => {
    const task = makeTask('/Users/test/Downloads/movie.mp4', '/Users/test/Downloads')
    expect(resolveArchiveAction(task, true, [], BASE_DIR)).toBeNull()
  })

  // ── BT multi-file tasks ───────────────────────────────────────

  // ── Custom absolute path categories ────────────────────────────

  it('archives to custom absolute path from NAS', () => {
    const customCats: FileCategory[] = [
      { label: 'NAS Videos', extensions: ['mp4'], directory: '/Volumes/NAS/Videos', builtIn: false },
    ]
    const task = makeTask('/Users/test/Downloads/movie.mp4', '/Users/test/Downloads')
    const result = resolveArchiveAction(task, true, customCats, BASE_DIR)
    expect(result).not.toBeNull()
    expect(result!.targetDir).toBe('/Volumes/NAS/Videos')
  })

  it('archives extensionless completed files by URL rule', () => {
    const categories: FileCategory[] = [
      {
        label: 'Reports',
        extensions: [],
        urlPatterns: ['*://reports.example.com/export/*'],
        urlPatternMode: 'wildcard',
        directory: '/Users/test/Downloads/Reports',
      },
    ]
    const task = makeTask('/Users/test/Downloads/latest', '/Users/test/Downloads')
    task.files[0].uris = [{ uri: 'https://reports.example.com/export/latest', status: 'used' }]

    const result = resolveArchiveAction(task, true, categories, BASE_DIR)

    expect(result?.targetDir).toBe('/Users/test/Downloads/Reports')
  })

  // ── Edge cases ─────────────────────────────────────────────────

  it('handles file path with spaces and special characters', () => {
    const task = makeTask('/Users/test/Downloads/my movie (2024).mp4', '/Users/test/Downloads')
    const result = resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)
    expect(result).not.toBeNull()
    expect(result!.source).toBe('/Users/test/Downloads/my movie (2024).mp4')
    expect(result!.targetDir).toBe('/Users/test/Downloads/Videos')
  })

  it('handles case-insensitive extension matching on real filename', () => {
    const task = makeTask('/Users/test/Downloads/Photo.MP4', '/Users/test/Downloads')
    const result = resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)
    expect(result).not.toBeNull()
    expect(result!.targetDir).toBe('/Users/test/Downloads/Videos')
  })

  it('only archives first file for single-file HTTP tasks', () => {
    // Multi-file HTTP is rare; archive only checks files[0]
    const task = makeTask('/Users/test/Downloads/part1.mp4', '/Users/test/Downloads')
    task.files!.push({
      index: '2',
      path: '/Users/test/Downloads/part2.mp4',
      length: '1000',
      completedLength: '1000',
      selected: 'true',
      uris: [],
    })
    // Should still return action for first file only
    const result = resolveArchiveAction(task, true, CATEGORIES, BASE_DIR)
    expect(result).not.toBeNull()
    expect(result!.source).toBe('/Users/test/Downloads/part1.mp4')
  })

  // ── Windows path separator normalization (Issue #229) ──────────

  describe('Windows path separator normalization', () => {
    const WIN_BASE = 'C:\\Users\\test\\Downloads'

    const WIN_CATEGORIES: FileCategory[] = [
      {
        label: 'Archives',
        extensions: ['zip', '7z'],
        directory: 'C:/Users/test/Downloads/Archives',
        builtIn: true,
      },
      {
        label: 'Videos',
        extensions: ['mp4', 'mkv'],
        directory: 'C:/Users/test/Downloads/Videos',
        builtIn: true,
      },
    ]

    it('normalizes backslash baseDir against forward-slash filePath from aria2', () => {
      // aria2 returns forward slashes; config.dir has backslashes on Windows
      const task = makeTask('C:/Users/test/Downloads/backup.zip', 'C:/Users/test/Downloads')
      const result = resolveArchiveAction(task, true, WIN_CATEGORIES, WIN_BASE)
      expect(result).not.toBeNull()
      expect(result!.targetDir).toBe('C:/Users/test/Downloads/Archives')
    })

    it('normalizes mixed-separator category directories', () => {
      // Categories with mixed separators from buildDefaultCategories() bug
      const mixedCats: FileCategory[] = [
        {
          label: 'Archives',
          extensions: ['zip'],
          directory: 'C:\\Users\\test\\Downloads/Archives',
          builtIn: true,
        },
      ]
      const task = makeTask('C:/Users/test/Downloads/backup.zip', 'C:/Users/test/Downloads')
      const result = resolveArchiveAction(task, true, mixedCats, WIN_BASE)
      expect(result).not.toBeNull()
      expect(result!.targetDir).toBe('C:\\Users\\test\\Downloads/Archives')
    })

    it('handles all-backslash paths consistently', () => {
      const task = makeTask('C:\\Users\\test\\Downloads\\movie.mp4', 'C:\\Users\\test\\Downloads')
      const result = resolveArchiveAction(task, true, WIN_CATEGORIES, WIN_BASE)
      expect(result).not.toBeNull()
      expect(result!.targetDir).toBe('C:/Users/test/Downloads/Videos')
    })

    it('still rejects files from non-base directories on Windows', () => {
      const task = makeTask('D:\\Other\\movie.mp4', 'D:\\Other')
      const result = resolveArchiveAction(task, true, WIN_CATEGORIES, WIN_BASE)
      expect(result).toBeNull()
    })

    it('handles trailing backslash on baseDir', () => {
      const task = makeTask('C:/Users/test/Downloads/backup.zip', 'C:/Users/test/Downloads')
      const result = resolveArchiveAction(task, true, WIN_CATEGORIES, 'C:\\Users\\test\\Downloads\\')
      expect(result).not.toBeNull()
      expect(result!.targetDir).toBe('C:/Users/test/Downloads/Archives')
    })
  })
})
