/**
 * @fileoverview Tests for the archived-paths runtime lookup table.
 *
 * Validates the Map-based gid→newPath resolution, Vue reactivity bridge,
 * and the global recheck trigger mechanism.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
let paths: typeof import('../useArchivedPaths')
let setArchivedPath: typeof paths.setArchivedPath
let resolveTaskFilePath: typeof paths.resolveTaskFilePath
let requestFileRecheck: typeof paths.requestFileRecheck
let recheckTrigger: typeof paths.recheckTrigger
import type { Aria2Task } from '@shared/types'

/** Minimal task factory for testing. */
function makeTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: 'abc123',
    status: 'complete',
    totalLength: '1024',
    completedLength: '1024',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/file.zip',
        length: '1024',
        completedLength: '1024',
        selected: 'true',
        uris: [],
      },
    ],
    ...overrides,
  }
}

beforeEach(async () => {
  vi.resetModules()
  paths = await import('../useArchivedPaths')
  ;({ setArchivedPath, resolveTaskFilePath, requestFileRecheck, recheckTrigger } = paths)
})

// ── resolveTaskFilePath ─────────────────────────────────────────────

describe('resolveTaskFilePath', () => {
  it('returns archived path when available (priority 1)', () => {
    setArchivedPath('abc123', '/downloads/Archives/file.zip')
    const task = makeTask()
    expect(resolveTaskFilePath(task)).toBe('/downloads/Archives/file.zip')
  })

  it('falls back to task.files[0].path when no archived path (priority 2)', () => {
    const task = makeTask()
    expect(resolveTaskFilePath(task)).toBe('/downloads/file.zip')
  })

  it('prefers selected file over first file', () => {
    const task = makeTask({
      files: [
        { index: '1', path: '/downloads/a.txt', length: '100', completedLength: '100', selected: 'false', uris: [] },
        { index: '2', path: '/downloads/b.txt', length: '200', completedLength: '200', selected: 'true', uris: [] },
      ],
    })
    expect(resolveTaskFilePath(task)).toBe('/downloads/b.txt')
  })

  it('returns null for task with no files', () => {
    const task = makeTask({ files: [] })
    expect(resolveTaskFilePath(task)).toBeNull()
  })

  it('returns null for task with undefined files', () => {
    const task = makeTask()
    // Force undefined to simulate edge case
    ;(task as unknown as Record<string, unknown>).files = undefined
    expect(resolveTaskFilePath(task)).toBeNull()
  })

  it('archived path takes priority even when files have valid paths', () => {
    setArchivedPath('abc123', '/downloads/Videos/movie.mp4')
    const task = makeTask({
      files: [
        {
          index: '1',
          path: '/downloads/movie.mp4',
          length: '5000',
          completedLength: '5000',
          selected: 'true',
          uris: [],
        },
      ],
    })
    expect(resolveTaskFilePath(task)).toBe('/downloads/Videos/movie.mp4')
  })

  it('handles Windows-style archived paths (forward-slash normalized)', () => {
    setArchivedPath('def456', 'C:/Users/test/Downloads/Archives/file.7z')
    const task = makeTask({
      gid: 'def456',
      files: [
        {
          index: '1',
          path: 'C:/Users/test/Downloads/file.7z',
          length: '1024',
          completedLength: '1024',
          selected: 'true',
          uris: [],
        },
      ],
    })
    expect(resolveTaskFilePath(task)).toBe('C:/Users/test/Downloads/Archives/file.7z')
  })
})

// ── Reactivity: recheckTrigger ──────────────────────────────────────

describe('requestFileRecheck / recheckTrigger', () => {
  it('increments recheckTrigger on each call', () => {
    const before = recheckTrigger.value
    requestFileRecheck()
    expect(recheckTrigger.value).toBe(before + 1)
    requestFileRecheck()
    expect(recheckTrigger.value).toBe(before + 2)
  })

  it('recheckTrigger is a shallowRef with numeric value', () => {
    expect(typeof recheckTrigger.value).toBe('number')
  })
})
