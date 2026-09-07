/** @fileoverview Unit tests for task fuzzy-search helpers. */
import { describe, it, expect } from 'vitest'
import {
  buildTaskSearchIndex,
  parseSearchTokens,
  taskMatchesKeyword,
  filterTasksByKeyword,
  isKeywordActive,
} from '../useTaskSearch'
import type { Aria2Task } from '@shared/types'

function makeTask(gid: string, extra: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid,
    status: 'complete',
    totalLength: '1000',
    completedLength: '1000',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [],
    ...extra,
  }
}

describe('parseSearchTokens', () => {
  it('splits on whitespace and lowercases', () => {
    expect(parseSearchTokens('  Ubuntu  22.04 ')).toEqual(['ubuntu', '22.04'])
  })

  it('returns no tokens for blank keywords', () => {
    expect(parseSearchTokens('   ')).toEqual([])
    expect(parseSearchTokens('')).toEqual([])
  })
})

describe('buildTaskSearchIndex', () => {
  it('includes the display name and decoded file basenames', () => {
    const task = makeTask('g1', {
      files: [
        {
          index: '1',
          path: '/downloads/My%20Movie.mkv',
          length: '1',
          completedLength: '1',
          selected: 'true',
          uris: [],
        },
      ],
    })
    const index = buildTaskSearchIndex(task)
    expect(index).toContain('my movie.mkv')
    expect(index).toContain('my movie.mkv')
  })

  it('includes BT torrent info name', () => {
    const task = makeTask('g2', {
      bittorrent: { info: { name: 'Ubuntu ISO' } },
    })
    expect(buildTaskSearchIndex(task)).toContain('ubuntu iso')
  })
})

describe('taskMatchesKeyword', () => {
  it('matches a substring of the task name case-insensitively', () => {
    const task = makeTask('g1', {
      files: [
        {
          index: '1',
          path: '/downloads/Ubuntu-22.04.iso',
          length: '1',
          completedLength: '1',
          selected: 'true',
          uris: [],
        },
      ],
    })
    expect(taskMatchesKeyword(task, ['ubuntu'])).toBe(true)
    expect(taskMatchesKeyword(task, ['UBUNTU-22'])).toBe(true)
    expect(taskMatchesKeyword(task, ['debian'])).toBe(false)
  })

  it('matches a basename of any file in multi-file tasks', () => {
    const task = makeTask('g2', {
      bittorrent: { info: { name: 'Linux Pack' } },
      files: [
        {
          index: '1',
          path: '/downloads/Linux Pack/app.zip',
          length: '1',
          completedLength: '1',
          selected: 'true',
          uris: [],
        },
        {
          index: '2',
          path: '/downloads/Linux Pack/readme.txt',
          length: '1',
          completedLength: '1',
          selected: 'true',
          uris: [],
        },
      ],
    })
    expect(taskMatchesKeyword(task, ['readme'])).toBe(true)
    expect(taskMatchesKeyword(task, ['missing'])).toBe(false)
  })

  it('requires every token to match', () => {
    const task = makeTask('g3', {
      files: [
        {
          index: '1',
          path: '/downloads/ubuntu-22.04-desktop.iso',
          length: '1',
          completedLength: '1',
          selected: 'true',
          uris: [],
        },
      ],
    })
    expect(taskMatchesKeyword(task, ['ubuntu', 'desktop'])).toBe(true)
    expect(taskMatchesKeyword(task, ['ubuntu', 'server'])).toBe(false)
  })

  it('matches everything when no tokens are given', () => {
    expect(taskMatchesKeyword(makeTask('g4'), [])).toBe(true)
  })
})

describe('filterTasksByKeyword', () => {
  const tasks = [
    makeTask('a', {
      files: [{ index: '1', path: '/d/alpha.zip', length: '1', completedLength: '1', selected: 'true', uris: [] }],
    }),
    makeTask('b', {
      files: [{ index: '1', path: '/d/beta.zip', length: '1', completedLength: '1', selected: 'true', uris: [] }],
    }),
  ]

  it('filters by keyword', () => {
    expect(filterTasksByKeyword(tasks, 'alp').map((t) => t.gid)).toEqual(['a'])
  })

  it('returns a copy of the input for blank keywords', () => {
    const result = filterTasksByKeyword(tasks, '  ')
    expect(result).toEqual(tasks)
    expect(result).not.toBe(tasks)
  })
})

describe('isKeywordActive', () => {
  it('is false for blank keywords', () => {
    expect(isKeywordActive('')).toBe(false)
    expect(isKeywordActive('  ')).toBe(false)
    expect(isKeywordActive(undefined)).toBe(false)
  })

  it('is true for any non-blank keyword', () => {
    expect(isKeywordActive('u')).toBe(true)
  })
})
