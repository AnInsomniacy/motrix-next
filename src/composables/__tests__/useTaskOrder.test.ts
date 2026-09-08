/**
 * @fileoverview Tests for useTaskOrder — in-memory task birth registry.
 *
 * Validates:
 *   1. registerAddedAt idempotency (first write wins)
 *   2. trackFirstSeen assigns sequential timestamps
 *   3. loadAddedAtFromRecords does not overwrite existing entries
 *   4. buildSortableAddedAtMap merge priority (memory > DB)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
let registry: typeof import('../useTaskOrder')
let registerAddedAt: typeof registry.registerAddedAt
let getAddedAt: typeof registry.getAddedAt
let trackFirstSeen: typeof registry.trackFirstSeen
let loadAddedAtFromRecords: typeof registry.loadAddedAtFromRecords
let buildSortableAddedAtMap: typeof registry.buildSortableAddedAtMap

beforeEach(async () => {
  vi.resetModules()
  registry = await import('../useTaskOrder')
  ;({ registerAddedAt, getAddedAt, trackFirstSeen, loadAddedAtFromRecords, buildSortableAddedAtMap } = registry)
})

// ── registerAddedAt ─────────────────────────────────────────────────

describe('registerAddedAt', () => {
  it('stores timestamp on first call', () => {
    registerAddedAt('aaa', '2024-01-01T00:00:00Z')
    expect(getAddedAt('aaa')).toBe('2024-01-01T00:00:00Z')
  })

  it('ignores subsequent calls for the same GID (first write wins)', () => {
    registerAddedAt('aaa', '2024-01-01T00:00:00Z')
    registerAddedAt('aaa', '2099-12-31T23:59:59Z')
    expect(getAddedAt('aaa')).toBe('2024-01-01T00:00:00Z')
  })

  it('auto-generates ISO timestamp when none provided', () => {
    registerAddedAt('aaa')
    const ts = getAddedAt('aaa')
    expect(ts).toBeDefined()
    expect(() => new Date(ts!).toISOString()).not.toThrow()
  })

  it('returns undefined for untracked GID', () => {
    expect(getAddedAt('unknown')).toBeUndefined()
  })
})

// ── trackFirstSeen ──────────────────────────────────────────────────

describe('trackFirstSeen', () => {
  it('assigns sequential timestamps preserving array order', () => {
    trackFirstSeen([{ gid: 'a' }, { gid: 'b' }, { gid: 'c' }])

    const ta = getAddedAt('a')!
    const tb = getAddedAt('b')!
    const tc = getAddedAt('c')!

    // Sequential: a < b < c (1ms apart)
    expect(ta < tb).toBe(true)
    expect(tb < tc).toBe(true)
  })

  it('does not overwrite existing entries', () => {
    registerAddedAt('b', '2020-01-01T00:00:00Z')
    trackFirstSeen([{ gid: 'a' }, { gid: 'b' }, { gid: 'c' }])

    // b retains its original timestamp
    expect(getAddedAt('b')).toBe('2020-01-01T00:00:00Z')
    // a and c get new timestamps
    expect(getAddedAt('a')).toBeDefined()
    expect(getAddedAt('c')).toBeDefined()
  })
})

// ── loadAddedAtFromRecords ──────────────────────────────────────────

describe('loadAddedAtFromRecords', () => {
  it('populates map from DB records', () => {
    loadAddedAtFromRecords([
      { gid: 'x', added_at: '2024-06-15T10:00:00Z' },
      { gid: 'y', added_at: '2024-06-15T11:00:00Z' },
    ])

    expect(getAddedAt('x')).toBe('2024-06-15T10:00:00Z')
    expect(getAddedAt('y')).toBe('2024-06-15T11:00:00Z')
  })

  it('skips records with null/undefined added_at', () => {
    loadAddedAtFromRecords([
      { gid: 'x', added_at: null },
      { gid: 'y', added_at: undefined },
    ])

    expect(getAddedAt('x')).toBeUndefined()
    expect(getAddedAt('y')).toBeUndefined()
  })

  it('does not overwrite existing in-memory entries', () => {
    registerAddedAt('x', '2020-01-01T00:00:00Z')
    loadAddedAtFromRecords([{ gid: 'x', added_at: '2099-12-31T23:59:59Z' }])

    expect(getAddedAt('x')).toBe('2020-01-01T00:00:00Z')
  })
})

// ── buildSortableAddedAtMap ─────────────────────────────────────────

describe('buildSortableAddedAtMap', () => {
  it('merges memory and DB sources with memory taking priority', () => {
    registerAddedAt('a', '2024-01-01T00:00:00Z')

    const result = buildSortableAddedAtMap(
      [{ gid: 'a' }, { gid: 'b' }],
      [
        { gid: 'a', added_at: '2020-01-01T00:00:00Z' }, // should be overridden
        { gid: 'b', added_at: '2024-06-01T00:00:00Z' },
        { gid: 'c', added_at: '2024-09-01T00:00:00Z' }, // DB-only task
      ],
    )

    expect(result.get('a')).toBe('2024-01-01T00:00:00Z') // memory wins
    expect(result.get('b')).toBe('2024-06-01T00:00:00Z') // from DB (not in memory)
    expect(result.get('c')).toBe('2024-09-01T00:00:00Z') // DB-only
  })

  it('returns empty map when no sources', () => {
    const result = buildSortableAddedAtMap([], [])
    expect(result.size).toBe(0)
  })
})

// ── Position stability simulation ───────────────────────────────────

describe('position stability across lifecycle', () => {
  it('batch stop seeding preserves original add order', () => {
    // User adds A, then B, then C — each gets a timestamp
    registerAddedAt('A', '2024-01-01T10:00:00Z')
    registerAddedAt('B', '2024-01-01T10:01:00Z')
    registerAddedAt('C', '2024-01-01T10:02:00Z')

    // User stops A first, then C, then B (arbitrary order)
    // completed_at would be A=T1, C=T2, B=T3 — but we sort by added_at

    const sortMap = buildSortableAddedAtMap([{ gid: 'A' }, { gid: 'B' }, { gid: 'C' }], [])

    const sorted = ['A', 'B', 'C'].sort((a, b) => {
      const ta = sortMap.get(a) ?? ''
      const tb = sortMap.get(b) ?? ''
      return tb.localeCompare(ta) // DESC
    })

    // C (most recently added) first, then B, then A
    expect(sorted).toEqual(['C', 'B', 'A'])
  })

  it('restart preserves order via loadAddedAtFromRecords', () => {
    // Simulate app restart: memory is empty, load from DB
    loadAddedAtFromRecords([
      { gid: 'A', added_at: '2024-01-01T10:00:00Z' },
      { gid: 'C', added_at: '2024-01-01T10:02:00Z' },
    ])

    // B is still active (from aria2 session restore)
    trackFirstSeen([{ gid: 'B' }])
    const bTime = getAddedAt('B')!

    // B gets a new timestamp (now) > A and C's persisted timestamps
    // This is the trade-off for active tasks without birth records.
    // With task_birth table, B would retain its original timestamp.
    expect(new Date(bTime).getTime()).toBeGreaterThan(new Date('2024-01-01T10:02:00Z').getTime())
  })
})
