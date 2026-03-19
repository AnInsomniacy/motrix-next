/** @fileoverview Tests for task metadata utilities: progress, naming, BT detection, magnet links. */
import { describe, it, expect } from 'vitest'
import {
  calcProgress,
  calcRatio,
  getTaskName,
  isMagnetTask,
  checkTaskIsBT,
  checkTaskIsSeeder,
  getFileNameFromFile,
  getTaskDisplayName,
  buildMagnetLink,
  getTaskUri,
  checkTaskTitleIsEmpty,
  mergeTaskResult,
  resolveOpenTarget,
} from '../task'
import type { Aria2Task, Aria2File } from '@shared/types'

function createMockTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: '1',
    status: 'active',
    totalLength: '1000',
    completedLength: '500',
    uploadLength: '0',
    downloadSpeed: '100',
    uploadSpeed: '0',
    connections: '1',
    dir: '/tmp',
    files: [],
    ...overrides,
  }
}

function createMockFile(overrides: Partial<Aria2File> = {}): Aria2File {
  return {
    index: '1',
    path: '/tmp/test.txt',
    length: '1000',
    completedLength: '500',
    selected: 'true',
    uris: [],
    ...overrides,
  }
}

describe('calcProgress', () => {
  it('returns 0 for zero total length', () => {
    expect(calcProgress(0, 0)).toBe(0)
  })

  it('calculates percentage correctly', () => {
    expect(calcProgress(1000, 500)).toBe(50)
    expect(calcProgress(1000, 1000)).toBe(100)
    expect(calcProgress(1000, 250)).toBe(25)
  })

  it('respects decimal parameter', () => {
    expect(calcProgress(3, 1, 1)).toBeCloseTo(33.3, 1)
  })

  it('handles string inputs', () => {
    expect(calcProgress('1000', '500')).toBe(50)
  })

  it('returns 0 when completed is 0', () => {
    expect(calcProgress(1000, 0)).toBe(0)
  })
})

describe('calcRatio', () => {
  it('returns 0 for zero total length', () => {
    expect(calcRatio(0, 0)).toBe(0)
  })

  it('calculates ratio correctly', () => {
    expect(calcRatio(1000, 500)).toBe(0.5)
    expect(calcRatio(1000, 1000)).toBe(1)
  })

  it('returns 0 when upload is 0', () => {
    expect(calcRatio(1000, 0)).toBe(0)
  })

  it('handles string inputs', () => {
    expect(calcRatio('1000', '2000')).toBe(2)
  })
})

describe('getTaskName', () => {
  it('returns default name for null task', () => {
    expect(getTaskName(null, { defaultName: 'Unknown' })).toBe('Unknown')
  })

  it('returns empty string for null task with no default', () => {
    expect(getTaskName(null)).toBe('')
  })

  it('returns BT info name when available', () => {
    const task = createMockTask({
      files: [createMockFile()],
      bittorrent: { info: { name: 'My Torrent' } },
    })
    expect(getTaskName(task)).toBe('My Torrent')
  })

  it('returns filename for single-file HTTP task', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/downloads/movie.mp4' })],
    })
    expect(getTaskName(task)).toBe('movie.mp4')
  })

  it('returns default when files array is empty', () => {
    const task = createMockTask({ files: [] })
    expect(getTaskName(task, { defaultName: 'N/A' })).toBe('N/A')
  })

  it('returns full-length BT names without truncation', () => {
    const task = createMockTask({
      files: [createMockFile()],
      bittorrent: { info: { name: 'A'.repeat(100) } },
    })
    const result = getTaskName(task)
    expect(result).toBe('A'.repeat(100))
  })
})

describe('getFileNameFromFile', () => {
  it('returns filename from path', () => {
    const file = createMockFile({ path: '/tmp/download/test.zip' })
    expect(getFileNameFromFile(file)).toBe('test.zip')
  })

  it('returns empty string for undefined file', () => {
    expect(getFileNameFromFile()).toBe('')
  })

  it('falls back to first URI when path is empty', () => {
    const file = createMockFile({
      path: '',
      uris: [{ uri: 'https://example.com/file.zip', status: 'used' }],
    })
    expect(getFileNameFromFile(file)).toBe('file.zip')
  })

  it('returns full path when no separator found', () => {
    const file = createMockFile({ path: 'plainfile.txt' })
    expect(getFileNameFromFile(file)).toBe('plainfile.txt')
  })

  it('returns empty when path and uris are empty', () => {
    const file = createMockFile({ path: '', uris: [] })
    expect(getFileNameFromFile(file)).toBe('')
  })
})

// ── getTaskDisplayName ───────────────────────────────────────────────

describe('getTaskDisplayName', () => {
  it('decodes percent-encoded filename from file path', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/downloads/AAA%20BBB.mp3' })],
    })
    expect(getTaskDisplayName(task)).toBe('AAA BBB.mp3')
  })

  it('decodes UTF-8 percent sequences in filename', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/downloads/file%E4%B8%AD%E6%96%87.txt' })],
    })
    expect(getTaskDisplayName(task)).toBe('file中文.txt')
  })

  it('returns default name for null task', () => {
    expect(getTaskDisplayName(null, { defaultName: 'Unknown' })).toBe('Unknown')
  })

  it('passes through BT names unmodified', () => {
    const task = createMockTask({
      files: [createMockFile()],
      bittorrent: { info: { name: 'Ubuntu 24.04' } },
    })
    expect(getTaskDisplayName(task)).toBe('Ubuntu 24.04')
  })

  it('returns original name for malformed percent sequence', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/downloads/bad%ZZname.txt' })],
    })
    expect(getTaskDisplayName(task)).toBe('bad%ZZname.txt')
  })
})

describe('isMagnetTask', () => {
  it('returns true for magnet task without info', () => {
    const task = createMockTask({ bittorrent: {} })
    expect(isMagnetTask(task)).toBe(true)
  })

  it('returns false for regular BT task', () => {
    const task = createMockTask({ bittorrent: { info: { name: 'test' } } })
    expect(isMagnetTask(task)).toBe(false)
  })

  it('returns false for HTTP task', () => {
    const task = createMockTask()
    expect(isMagnetTask(task)).toBe(false)
  })
})

describe('checkTaskIsBT', () => {
  it('returns true when bittorrent metadata is present', () => {
    const task = createMockTask({ bittorrent: { info: { name: 'test' } } })
    expect(checkTaskIsBT(task)).toBe(true)
  })

  it('returns false when no bittorrent metadata', () => {
    expect(checkTaskIsBT(createMockTask())).toBe(false)
  })

  it('returns false for empty object', () => {
    expect(checkTaskIsBT()).toBe(false)
  })
})

describe('checkTaskIsSeeder', () => {
  it('returns true when BT task has seeder=true', () => {
    const task = createMockTask({
      bittorrent: { info: { name: 'test' } },
      seeder: 'true',
    })
    expect(checkTaskIsSeeder(task)).toBe(true)
  })

  it('returns false for non-BT task', () => {
    expect(checkTaskIsSeeder(createMockTask())).toBe(false)
  })

  it('returns false when seeder is false string', () => {
    const task = createMockTask({
      bittorrent: { info: { name: 'test' } },
      seeder: 'false',
    })
    expect(checkTaskIsSeeder(task)).toBe(false)
  })

  it('returns false when seeder is true but task is paused', () => {
    const task = createMockTask({
      status: 'paused',
      bittorrent: { info: { name: 'test' } },
      seeder: 'true',
    })
    expect(checkTaskIsSeeder(task)).toBe(false)
  })
})

describe('buildMagnetLink', () => {
  it('builds basic magnet link with infoHash', () => {
    const task = createMockTask({ infoHash: 'abc123', bittorrent: {} })
    const result = buildMagnetLink(task)
    expect(result).toBe('magnet:?xt=urn:btih:abc123')
  })

  it('includes display name when BT info has name', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: { info: { name: 'My File' } },
    })
    const result = buildMagnetLink(task)
    expect(result).toContain('dn=My%20File')
  })

  it('includes trackers when withTracker is true', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: {
        info: { name: 'test' },
        announceList: [['http://tracker1.com', 'http://tracker2.com']],
      },
    })
    const result = buildMagnetLink(task, true)
    expect(result).toContain('tr=http%3A%2F%2Ftracker1.com')
    expect(result).toContain('tr=http%3A%2F%2Ftracker2.com')
  })

  it('excludes trackers already in btTracker list', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: {
        info: { name: 'test' },
        announceList: [['http://tracker1.com', 'http://tracker2.com']],
      },
    })
    const result = buildMagnetLink(task, true, ['http://tracker1.com'])
    expect(result).not.toContain('tr=http%3A%2F%2Ftracker1.com')
    expect(result).toContain('tr=http%3A%2F%2Ftracker2.com')
  })

  it('does not include trackers when withTracker is false', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: {
        info: { name: 'test' },
        announceList: [['http://tracker1.com']],
      },
    })
    const result = buildMagnetLink(task, false)
    expect(result).not.toContain('tr=')
  })
})

describe('getTaskUri', () => {
  it('returns magnet link for BT task', () => {
    const task = createMockTask({
      infoHash: 'abc123',
      bittorrent: { info: { name: 'test' } },
      files: [],
    })
    const result = getTaskUri(task)
    expect(result).toContain('magnet:?xt=urn:btih:abc123')
  })

  it('returns first URI for single-file HTTP task', () => {
    const task = createMockTask({
      files: [
        createMockFile({
          uris: [{ uri: 'http://example.com/file.zip', status: 'used' }],
        }),
      ],
    })
    expect(getTaskUri(task)).toBe('http://example.com/file.zip')
  })

  it('returns empty for HTTP task with no URIs', () => {
    const task = createMockTask({
      files: [createMockFile({ uris: [] })],
    })
    expect(getTaskUri(task)).toBe('')
  })

  it('returns empty for multi-file HTTP task', () => {
    const task = createMockTask({
      files: [createMockFile(), createMockFile({ index: '2' })],
    })
    expect(getTaskUri(task)).toBe('')
  })
})

describe('checkTaskTitleIsEmpty', () => {
  it('returns true when path is empty and no BT info', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '' })],
    })
    expect(checkTaskTitleIsEmpty(task)).toBe(true)
  })

  it('returns false when path has value', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/tmp/file.txt' })],
    })
    expect(checkTaskTitleIsEmpty(task)).toBe(false)
  })

  it('returns false when BT info name is present', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '' })],
      bittorrent: { info: { name: 'My Torrent' } },
    })
    expect(checkTaskTitleIsEmpty(task)).toBe(false)
  })

  it('falls through to file path when BT info name is empty', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '/tmp/file.txt' })],
      bittorrent: { info: { name: '' } },
    })
    // bittorrent.info.name is falsy (''), so code falls through to file.path
    expect(checkTaskTitleIsEmpty(task)).toBe(false)
  })

  it('uses BT info name when present (non-empty)', () => {
    const task = createMockTask({
      files: [createMockFile({ path: '' })],
      bittorrent: { info: { name: 'My Torrent' } },
    })
    expect(checkTaskTitleIsEmpty(task)).toBe(false)
  })
})

describe('mergeTaskResult', () => {
  it('merges multiple arrays', () => {
    const result = mergeTaskResult([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(result).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns empty for empty input', () => {
    expect(mergeTaskResult([])).toEqual([])
  })

  it('returns empty for default parameter', () => {
    expect(mergeTaskResult()).toEqual([])
  })

  it('handles single nested array', () => {
    expect(mergeTaskResult([['x']])).toEqual(['x'])
  })
})

describe('resolveOpenTarget', () => {
  it('returns torrent root directory for BT multi-file tasks', () => {
    const task = createMockTask({
      dir: '/downloads',
      bittorrent: { info: { name: 'MyTorrent' } },
      files: [
        {
          index: '1',
          path: '/downloads/MyTorrent/file1.mkv',
          length: '1000',
          completedLength: '1000',
          selected: 'true',
          uris: [],
        },
        {
          index: '2',
          path: '/downloads/MyTorrent/file2.srt',
          length: '500',
          completedLength: '500',
          selected: 'true',
          uris: [],
        },
      ],
    })
    expect(resolveOpenTarget(task)).toBe('/downloads/MyTorrent')
  })

  it('returns file path for BT single-file tasks', () => {
    const task = createMockTask({
      dir: '/downloads',
      bittorrent: { info: { name: 'movie.mp4' } },
      files: [
        {
          index: '1',
          path: '/downloads/movie.mp4',
          length: '1000',
          completedLength: '1000',
          selected: 'true',
          uris: [],
        },
      ],
    })
    expect(resolveOpenTarget(task)).toBe('/downloads/movie.mp4')
  })

  it('returns file path for HTTP single-file tasks', () => {
    const task = createMockTask({
      dir: '/downloads',
      files: [
        {
          index: '1',
          path: '/downloads/file.zip',
          length: '1000',
          completedLength: '1000',
          selected: 'true',
          uris: [{ uri: 'http://example.com/file.zip', status: 'used' }],
        },
      ],
    })
    expect(resolveOpenTarget(task)).toBe('/downloads/file.zip')
  })

  it('prefers selected files over unselected', () => {
    const task = createMockTask({
      dir: '/downloads',
      files: [
        {
          index: '1',
          path: '/downloads/unwanted.txt',
          length: '100',
          completedLength: '100',
          selected: 'false',
          uris: [],
        },
        {
          index: '2',
          path: '/downloads/wanted.mkv',
          length: '1000',
          completedLength: '1000',
          selected: 'true',
          uris: [],
        },
      ],
    })
    expect(resolveOpenTarget(task)).toBe('/downloads/wanted.mkv')
  })

  it('falls back to task.dir when files array is empty', () => {
    const task = createMockTask({
      dir: '/downloads',
      files: [],
    })
    expect(resolveOpenTarget(task)).toBe('/downloads')
  })

  it('falls back to task.dir when no file path available', () => {
    const task = createMockTask({
      dir: '/downloads',
      files: [{ index: '1', path: '', length: '0', completedLength: '0', selected: 'true', uris: [] }],
    })
    expect(resolveOpenTarget(task)).toBe('/downloads')
  })
})
