/**
 * @fileoverview TDD test suite for per-tab task sorting.
 *
 * Tests are written BEFORE implementation to drive the API design.
 * Sort fields per tab:
 *   Active:  added-at | name | size | progress | speed
 *   Stopped: added-at | completed-at | name | size
 *   All:     added-at | name | size
 * Every field supports 'asc' and 'desc' direction.
 */
import { describe, it, expect } from 'vitest'
import type { Aria2Task } from '@shared/types'
import {
  sortTasks,
  applyManualOrder,
  createManualOrderSnapshot,
  PROGRESS_SORT_FIELDS,
  TERMINAL_SORT_FIELDS,
  ALL_SORT_FIELDS,
  DEFAULT_TASK_SORT,
  DEFAULT_TASK_MANUAL_ORDER,
} from '../useTaskSort'

// ── Factories ────────────────────────────────────────────────────────

function mockTask(gid: string, overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid,
    status: 'active',
    totalLength: '1000',
    completedLength: '500',
    uploadLength: '0',
    downloadSpeed: '100',
    uploadSpeed: '0',
    connections: '1',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: `/downloads/${gid}.txt`,
        length: '1000',
        completedLength: '500',
        selected: 'true',
        uris: [],
      },
    ],
    ...overrides,
  }
}

function mockBtTask(gid: string, name: string, overrides: Partial<Aria2Task> = {}): Aria2Task {
  return mockTask(gid, {
    bittorrent: { info: { name } },
    ...overrides,
  })
}

// ── Helper: extract GID order after sort ─────────────────────────────

function gids(items: Array<{ gid: string }>): string[] {
  return items.map((i) => i.gid)
}

// ═════════════════════════════════════════════════════════════════════
// sortTasks — used by Active and All tabs
// ═════════════════════════════════════════════════════════════════════

describe('sortTasks', () => {
  // ── added-at sorting ───────────────────────────────────────────────

  describe('field: added-at', () => {
    const addedAtIndex = new Map([
      ['a', '2024-01-03T00:00:00Z'],
      ['b', '2024-01-01T00:00:00Z'],
      ['c', '2024-01-02T00:00:00Z'],
    ])

    it('sorts DESC — most recently added first', () => {
      const tasks = [mockTask('b'), mockTask('c'), mockTask('a')]
      sortTasks(tasks, 'added-at', 'desc', addedAtIndex)
      expect(gids(tasks)).toEqual(['a', 'c', 'b'])
    })

    it('sorts ASC — oldest first', () => {
      const tasks = [mockTask('a'), mockTask('c'), mockTask('b')]
      sortTasks(tasks, 'added-at', 'asc', addedAtIndex)
      expect(gids(tasks)).toEqual(['b', 'c', 'a'])
    })

    it('tasks without added-at sort to the end in DESC', () => {
      const index = new Map([['a', '2024-01-02T00:00:00Z']])
      const tasks = [mockTask('b'), mockTask('a')]
      sortTasks(tasks, 'added-at', 'desc', index)
      expect(gids(tasks)).toEqual(['a', 'b'])
    })

    it('tasks without added-at sort to the beginning in ASC', () => {
      const index = new Map([['a', '2024-01-02T00:00:00Z']])
      const tasks = [mockTask('a'), mockTask('b')]
      sortTasks(tasks, 'added-at', 'asc', index)
      expect(gids(tasks)).toEqual(['b', 'a'])
    })
  })

  // ── name sorting ───────────────────────────────────────────────────

  describe('field: name', () => {
    it('sorts A-Z (ASC)', () => {
      const tasks = [mockBtTask('c', 'Zebra'), mockBtTask('a', 'Alpha'), mockBtTask('b', 'Mango')]
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(gids(tasks)).toEqual(['a', 'b', 'c'])
    })

    it('sorts Z-A (DESC)', () => {
      const tasks = [mockBtTask('a', 'Alpha'), mockBtTask('c', 'Zebra'), mockBtTask('b', 'Mango')]
      sortTasks(tasks, 'name', 'desc', new Map())
      expect(gids(tasks)).toEqual(['c', 'b', 'a'])
    })

    it('is case-insensitive', () => {
      const tasks = [mockBtTask('b', 'banana'), mockBtTask('a', 'Apple')]
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(gids(tasks)).toEqual(['a', 'b'])
    })

    it('falls back to file path when no BT name', () => {
      const t1 = mockTask('a', {
        files: [{ index: '1', path: '/dl/zebra.iso', length: '0', completedLength: '0', selected: 'true', uris: [] }],
      })
      const t2 = mockTask('b', {
        files: [{ index: '1', path: '/dl/alpha.iso', length: '0', completedLength: '0', selected: 'true', uris: [] }],
      })
      const tasks = [t1, t2]
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a'])
    })
  })

  // ── size sorting ──────────────────────────────────────────────────

  describe('field: size', () => {
    it('sorts largest first (DESC)', () => {
      const tasks = [
        mockTask('a', { totalLength: '500' }),
        mockTask('b', { totalLength: '2000' }),
        mockTask('c', { totalLength: '100' }),
      ]
      sortTasks(tasks, 'size', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a', 'c'])
    })

    it('sorts smallest first (ASC)', () => {
      const tasks = [
        mockTask('b', { totalLength: '2000' }),
        mockTask('a', { totalLength: '500' }),
        mockTask('c', { totalLength: '100' }),
      ]
      sortTasks(tasks, 'size', 'asc', new Map())
      expect(gids(tasks)).toEqual(['c', 'a', 'b'])
    })

    it('treats missing totalLength as 0', () => {
      const t1 = mockTask('a', { totalLength: '1000' })
      const t2 = mockTask('b', { totalLength: '0' })
      sortTasks([t1, t2], 'size', 'desc', new Map())
      expect(gids([t1, t2])).toEqual(['a', 'b'])
    })
  })

  // ── progress sorting (Active tab only) ────────────────────────────

  describe('field: progress', () => {
    it('sorts highest progress first (DESC)', () => {
      const tasks = [
        mockTask('a', { totalLength: '1000', completedLength: '500' }), // 50%
        mockTask('b', { totalLength: '1000', completedLength: '900' }), // 90%
        mockTask('c', { totalLength: '1000', completedLength: '100' }), // 10%
      ]
      sortTasks(tasks, 'progress', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a', 'c'])
    })

    it('sorts lowest progress first (ASC)', () => {
      const tasks = [
        mockTask('b', { totalLength: '1000', completedLength: '900' }), // 90%
        mockTask('a', { totalLength: '1000', completedLength: '500' }), // 50%
        mockTask('c', { totalLength: '1000', completedLength: '100' }), // 10%
      ]
      sortTasks(tasks, 'progress', 'asc', new Map())
      expect(gids(tasks)).toEqual(['c', 'a', 'b'])
    })

    it('treats zero totalLength as 0% progress', () => {
      const tasks = [
        mockTask('a', { totalLength: '0', completedLength: '0' }),
        mockTask('b', { totalLength: '1000', completedLength: '500' }),
      ]
      sortTasks(tasks, 'progress', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a'])
    })

    it('uses aria2 completedLength for ED2K sorting', () => {
      const tasks = [
        mockTask('http', { totalLength: '1000', completedLength: '500' }),
        mockTask('ed2k', {
          status: 'active',
          totalLength: '1000',
          completedLength: '800',
          ed2k: {
            completedLength: '800',
          },
        }),
      ]
      sortTasks(tasks, 'progress', 'desc', new Map())
      expect(gids(tasks)).toEqual(['ed2k', 'http'])
    })
  })

  // ── speed sorting (Active tab only) ───────────────────────────────

  describe('field: speed', () => {
    it('sorts fastest first (DESC)', () => {
      const tasks = [
        mockTask('a', { downloadSpeed: '500' }),
        mockTask('b', { downloadSpeed: '2000' }),
        mockTask('c', { downloadSpeed: '100' }),
      ]
      sortTasks(tasks, 'speed', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a', 'c'])
    })

    it('sorts slowest first (ASC)', () => {
      const tasks = [
        mockTask('b', { downloadSpeed: '2000' }),
        mockTask('a', { downloadSpeed: '500' }),
        mockTask('c', { downloadSpeed: '100' }),
      ]
      sortTasks(tasks, 'speed', 'asc', new Map())
      expect(gids(tasks)).toEqual(['c', 'a', 'b'])
    })

    it('treats zero speed correctly', () => {
      const tasks = [mockTask('a', { downloadSpeed: '0' }), mockTask('b', { downloadSpeed: '1000' })]
      sortTasks(tasks, 'speed', 'desc', new Map())
      expect(gids(tasks)).toEqual(['b', 'a'])
    })
  })

  // ── edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty array', () => {
      const tasks: Aria2Task[] = []
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(tasks).toEqual([])
    })

    it('handles single-element array', () => {
      const tasks = [mockTask('a')]
      sortTasks(tasks, 'name', 'asc', new Map())
      expect(gids(tasks)).toEqual(['a'])
    })

    it('does not crash on tasks with missing files', () => {
      const t = mockTask('a', { files: [] })
      expect(() => sortTasks([t], 'name', 'asc', new Map())).not.toThrow()
    })
  })
})

it('sorts terminal tasks by completion time', () => {
  const tasks = [mockTask('older'), mockTask('newer')]
  sortTasks(
    tasks,
    'completed-at',
    'desc',
    new Map(),
    new Map([
      ['older', '2024-01-01'],
      ['newer', '2024-01-02'],
    ]),
  )
  expect(gids(tasks)).toEqual(['newer', 'older'])
})

describe('manual task order', () => {
  it('keeps stored tasks in manual order and inserts new tasks at the top by fallback order', () => {
    const tasks = [
      mockTask('old-1'),
      mockTask('newer', { totalLength: '3000' }),
      mockTask('old-2'),
      mockTask('newest', { totalLength: '4000' }),
    ]

    applyManualOrder(tasks, ['old-2', 'old-1'], (fresh) => {
      sortTasks(
        fresh,
        'added-at',
        'desc',
        new Map([
          ['newer', '2024-01-02T00:00:00Z'],
          ['newest', '2024-01-03T00:00:00Z'],
        ]),
      )
    })

    expect(gids(tasks)).toEqual(['newest', 'newer', 'old-2', 'old-1'])
  })

  it('creates a manual order snapshot from the current rendered list', () => {
    expect(createManualOrderSnapshot([mockTask('a'), mockTask('b'), mockTask('c')])).toEqual(['a', 'b', 'c'])
  })
})

// ═════════════════════════════════════════════════════════════════════
// Constants and type contracts
// ═════════════════════════════════════════════════════════════════════

describe('sort constants', () => {
  it('PROGRESS_SORT_FIELDS contains the progress-specific fields', () => {
    expect(PROGRESS_SORT_FIELDS).toEqual(['manual', 'added-at', 'name', 'size', 'progress', 'speed'])
  })

  it('TERMINAL_SORT_FIELDS contains the terminal-specific fields', () => {
    expect(TERMINAL_SORT_FIELDS).toEqual(['manual', 'added-at', 'completed-at', 'name', 'size'])
  })

  it('ALL_SORT_FIELDS contains exactly 3 fields', () => {
    expect(ALL_SORT_FIELDS).toEqual(['manual', 'added-at', 'name', 'size'])
  })

  it('DEFAULT_TASK_SORT has valid defaults for all tabs', () => {
    expect(DEFAULT_TASK_SORT).toEqual({
      all: { field: 'added-at', direction: 'desc' },
      progress: { field: 'added-at', direction: 'desc' },
      failed: { field: 'added-at', direction: 'desc' },
      completed: { field: 'added-at', direction: 'desc' },
    })
  })

  it('DEFAULT_TASK_SORT fields are in their respective field lists', () => {
    expect(PROGRESS_SORT_FIELDS).toContain(DEFAULT_TASK_SORT.progress.field)
    expect(TERMINAL_SORT_FIELDS).toContain(DEFAULT_TASK_SORT.failed.field)
    expect(TERMINAL_SORT_FIELDS).toContain(DEFAULT_TASK_SORT.completed.field)
    expect(ALL_SORT_FIELDS).toContain(DEFAULT_TASK_SORT.all.field)
  })

  it('ALL_SORT_FIELDS is a subset of PROGRESS_SORT_FIELDS', () => {
    for (const field of ALL_SORT_FIELDS) {
      expect(PROGRESS_SORT_FIELDS).toContain(field)
    }
  })

  it('DEFAULT_TASK_MANUAL_ORDER starts empty for every tab', () => {
    expect(DEFAULT_TASK_MANUAL_ORDER).toEqual({
      all: [],
      progress: [],
      failed: [],
      completed: [],
    })
  })
})
