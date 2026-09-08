/** @fileoverview TDD tests for the download history Pinia store (SQLite-backed).
 *
 * The `@tauri-apps/plugin-sql` module is mocked to use an in-memory
 * array, keeping tests synchronous and deterministic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { HistoryRecord } from '@shared/types'

// ── Mock: in-memory SQLite substitute ────────────────────────────────
let rows: HistoryRecord[] = []
let birthRows: Array<{ gid: string; added_at: string }> = []
let nextId = 1
let executedQueries: string[] = []

/** Minimal SQL executor that interprets the queries issued by the store. */
function mockExecute(query: string, params: unknown[]): { rowsAffected: number } {
  executedQueries.push(query.trim())
  const q = query.trim().toUpperCase()

  if (q.startsWith('INSERT') && q.includes('TASK_BIRTH')) {
    const [gid, addedAt] = params as [string, string]
    if (!birthRows.some((r) => r.gid === gid)) {
      birthRows.push({ gid, added_at: addedAt })
    }
    return { rowsAffected: 1 }
  }

  if (q.startsWith('INSERT') || q.startsWith('REPLACE')) {
    const [gid, name, uri, dir, totalLength, status, taskType, addedAt, completedAt, meta] = params as [
      string,
      string,
      string | null,
      string | null,
      number | null,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
    const existing = rows.findIndex((r) => r.gid === gid)
    const record: HistoryRecord = {
      id: existing >= 0 ? rows[existing].id : nextId++,
      gid,
      name,
      uri: uri ?? undefined,
      dir: dir ?? undefined,
      total_length: totalLength ?? undefined,
      status,
      task_type: taskType ?? undefined,
      // ON CONFLICT: preserve existing added_at (COALESCE)
      added_at: (existing >= 0 ? rows[existing].added_at : undefined) ?? addedAt ?? undefined,
      created_at: new Date().toISOString(),
      completed_at: completedAt ?? undefined,
      meta: meta ?? undefined,
    }
    if (existing >= 0) {
      rows[existing] = record
    } else {
      rows.push(record)
    }
    return { rowsAffected: 1 }
  }

  if (q.startsWith('DELETE')) {
    if (q.includes('TASK_BIRTH')) {
      const beforeBirths = birthRows.length
      const gids = params as string[]
      const gidSet = new Set(gids)
      birthRows = birthRows.filter((r) => !gidSet.has(r.gid))
      return { rowsAffected: beforeBirths - birthRows.length }
    }

    const before = rows.length
    if (q.includes('GID IN')) {
      const gids = params as string[]
      const gidSet = new Set(gids)
      rows = rows.filter((r) => !gidSet.has(r.gid))
    } else if (q.includes('WHERE GID')) {
      const gid = params[0] as string
      rows = rows.filter((r) => r.gid !== gid)
    } else if (q.includes('WHERE STATUS')) {
      const status = params[0] as string
      rows = rows.filter((r) => r.status !== status)
    } else {
      rows = []
    }
    return { rowsAffected: before - rows.length }
  }

  // PRAGMA responses
  if (q.startsWith('PRAGMA')) {
    return { rowsAffected: 0 }
  }

  return { rowsAffected: 0 }
}

function mockSelect(query: string, params: unknown[]): unknown[] {
  executedQueries.push(query.trim())
  const q = query.trim().toUpperCase()

  // PRAGMA integrity_check returns [{integrity_check: 'ok'}]
  if (q.includes('INTEGRITY_CHECK')) {
    return [{ integrity_check: 'ok' }]
  }

  if (q.includes('TASK_BIRTH')) {
    return [...birthRows]
  }

  if (q.includes('COUNT(DISTINCT GID)')) {
    const status = String(params[0])
    const values = new Set(params.slice(1).map(String))
    const matchedGids = new Set<string>()
    for (const row of rows) {
      if (row.status !== status) continue
      let meta: Record<string, unknown> = {}
      try {
        meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {}
      } catch {
        meta = {}
      }
      if (
        values.has(row.gid) ||
        (typeof meta.infoHash === 'string' && values.has(meta.infoHash)) ||
        (typeof meta.ed2kHash === 'string' && values.has(meta.ed2kHash)) ||
        (typeof meta.ed2kLink === 'string' && values.has(meta.ed2kLink))
      ) {
        matchedGids.add(row.gid)
      }
    }
    return [{ count: matchedGids.size }]
  }

  if (q.includes('COUNT(*)')) {
    if (q.includes('GROUP BY STATUS')) {
      return ['complete', 'error']
        .map((status) => ({ status, count: rows.filter((row) => row.status === status).length }))
        .filter((entry) => entry.count > 0)
    }
    if (q.includes('WHERE STATUS')) {
      const status = params[0] as string
      return [{ count: rows.filter((r) => r.status === status).length }]
    }
    return [{ count: rows.length }]
  }

  let result: HistoryRecord[]
  if (q.includes('WHERE STATUS')) {
    const status = params[0] as string
    result = rows
      .filter((r) => r.status === status)
      .sort((a, b) => {
        const ta = a.added_at ?? a.completed_at ?? ''
        const tb = b.added_at ?? b.completed_at ?? ''
        return tb.localeCompare(ta)
      })
  } else {
    // Default: return all, sorted by COALESCE(added_at, completed_at) DESC
    result = [...rows].sort((a, b) => {
      const ta = a.added_at ?? a.completed_at ?? ''
      const tb = b.added_at ?? b.completed_at ?? ''
      return tb.localeCompare(ta)
    })
  }

  if (q.includes('ORDER BY TOTAL_LENGTH')) {
    result = [...result].sort((a, b) => {
      const diff = (a.total_length ?? 0) - (b.total_length ?? 0)
      return q.includes('DESC') ? -diff : diff
    })
  }

  // Parse LIMIT / OFFSET clauses from the SQL query
  const limitMatch = q.match(/LIMIT\s+(\d+)/)
  const offsetMatch = q.match(/OFFSET\s+(\d+)/)
  if (offsetMatch) {
    const offset = parseInt(offsetMatch[1], 10)
    result = result.slice(offset)
  }
  if (limitMatch) {
    const limit = parseInt(limitMatch[1], 10)
    result = result.slice(0, limit)
  }

  return result
}

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn().mockResolvedValue({
      execute: vi.fn((q: string, p: unknown[]) => Promise.resolve(mockExecute(q, p))),
      select: vi.fn((q: string, p: unknown[]) => Promise.resolve(mockSelect(q, p))),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

vi.mock('@shared/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// Dynamic import AFTER mock is registered
const { useHistoryStore } = await import('../history')

// ── Test data factories ──────────────────────────────────────────────

function makeRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    gid: 'abc123',
    name: 'test-file.zip',
    uri: 'https://example.com/test-file.zip',
    dir: '/downloads',
    total_length: 1024000,
    status: 'complete',
    task_type: 'uri',
    completed_at: '2026-03-15T12:00:00Z',
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(false) }))

describe('HistoryStore', () => {
  let store: ReturnType<typeof useHistoryStore>

  beforeEach(async () => {
    rows = []
    birthRows = []
    nextId = 1
    executedQueries = []
    setActivePinia(createPinia())
    store = useHistoryStore()
    await store.init()
  })

  // ── addRecord ──────────────────────────────────────────────────

  describe('addRecord', () => {
    it('inserts a new record', async () => {
      const record = makeRecord()
      await store.addRecord(record)

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('abc123')
      expect(results[0].name).toBe('test-file.zip')
      expect(results[0].status).toBe('complete')
    })

    it('upserts on duplicate GID instead of throwing', async () => {
      await store.addRecord(makeRecord({ name: 'original.zip' }))
      await store.addRecord(makeRecord({ name: 'updated.zip' }))

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('updated.zip')
    })

    it('preserves all optional fields', async () => {
      const record = makeRecord({
        uri: 'magnet:?xt=urn:btih:abc',
        dir: '/custom/path',
        total_length: 5000000,
        task_type: 'torrent',
        meta: '{"infoHash":"abc123"}',
      })
      await store.addRecord(record)

      const results = await store.getRecords()
      expect(results[0].uri).toBe('magnet:?xt=urn:btih:abc')
      expect(results[0].dir).toBe('/custom/path')
      expect(results[0].total_length).toBe(5000000)
      expect(results[0].task_type).toBe('torrent')
      expect(results[0].meta).toBe('{"infoHash":"abc123"}')
    })

    it('handles records with minimal fields', async () => {
      await store.addRecord({ gid: 'min1', name: 'minimal.txt', status: 'error' })

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('min1')
    })
  })

  describe('getRecords', () => {
    it('returns all records when no filter is specified', async () => {
      await store.addRecord(makeRecord({ gid: 'g1', name: 'file1.zip', status: 'complete' }))
      await store.addRecord(makeRecord({ gid: 'g2', name: 'file2.zip', status: 'error' }))
      await store.addRecord(makeRecord({ gid: 'g3', name: 'file3.zip', status: 'removed' }))

      const results = await store.getRecords()
      expect(results).toHaveLength(3)
    })

    it('filters by status when specified', async () => {
      await store.addRecord(makeRecord({ gid: 'g1', status: 'complete' }))
      await store.addRecord(makeRecord({ gid: 'g2', status: 'error' }))
      await store.addRecord(makeRecord({ gid: 'g3', status: 'complete' }))

      const completed = await store.getRecords('complete')
      expect(completed).toHaveLength(2)
      completed.forEach((r) => expect(r.status).toBe('complete'))
    })

    it('returns records sorted by completed_at descending', async () => {
      await store.addRecord(makeRecord({ gid: 'old', name: 'old.zip', completed_at: '2026-01-01T00:00:00Z' }))
      await store.addRecord(makeRecord({ gid: 'new', name: 'new.zip', completed_at: '2026-03-15T00:00:00Z' }))
      await store.addRecord(makeRecord({ gid: 'mid', name: 'mid.zip', completed_at: '2026-02-01T00:00:00Z' }))

      const results = await store.getRecords()
      expect(results[0].gid).toBe('new')
      expect(results[1].gid).toBe('mid')
      expect(results[2].gid).toBe('old')
    })

    it('returns at most N records when limit is specified', async () => {
      for (let i = 0; i < 10; i++) {
        await store.addRecord(
          makeRecord({
            gid: `limited-${i}`,
            name: `file-${i}.zip`,
            completed_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          }),
        )
      }

      const limited = await store.getRecords(undefined, 3)
      expect(limited).toHaveLength(3)
      // Should return the 3 most recent (sorted by completed_at DESC)
      expect(limited[0].gid).toBe('limited-9')
      expect(limited[1].gid).toBe('limited-8')
      expect(limited[2].gid).toBe('limited-7')
    })

    it('returns all records when limit exceeds total count', async () => {
      await store.addRecord(makeRecord({ gid: 'only1', name: 'only.zip' }))

      const results = await store.getRecords(undefined, 100)
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('only1')
    })

    it('applies limit together with status filter', async () => {
      for (let i = 0; i < 5; i++) {
        await store.addRecord(
          makeRecord({
            gid: `c-${i}`,
            status: 'complete',
            completed_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          }),
        )
      }
      await store.addRecord(makeRecord({ gid: 'e-1', status: 'error' }))

      const limited = await store.getRecords('complete', 2)
      expect(limited).toHaveLength(2)
      limited.forEach((r) => expect(r.status).toBe('complete'))
    })

    it('returns one SQL-backed page with total count', async () => {
      for (let i = 0; i < 5; i++) {
        await store.addRecord(
          makeRecord({
            gid: `page-${i}`,
            completed_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          }),
        )
      }

      const page = await store.getRecordsPage({ page: 2, pageSize: 2 })

      expect(page.total).toBe(5)
      expect(page.records.map((r) => r.gid)).toEqual(['page-2', 'page-1'])
      expect(executedQueries.some((q) => q.includes('LIMIT 2 OFFSET 2'))).toBe(true)
      expect(executedQueries.some((q) => q.includes('COUNT(*)'))).toBe(true)
    })

    it('sorts a SQL-backed page only by whitelisted fields', async () => {
      await store.addRecord(makeRecord({ gid: 'small', total_length: 100, completed_at: '2026-02-01T00:00:00Z' }))
      await store.addRecord(makeRecord({ gid: 'large', total_length: 900, completed_at: '2026-01-01T00:00:00Z' }))

      const sorted = await store.getRecordsPage({
        page: 1,
        pageSize: 10,
        sortField: 'total_length',
        sortOrder: 'descend',
      })
      const fallback = await store.getRecordsPage({
        page: 1,
        pageSize: 10,
        sortField: 'gid; DROP TABLE download_history',
        sortOrder: 'ascend',
      })

      expect(sorted.records.map((r) => r.gid)).toEqual(['large', 'small'])
      expect(fallback.records.map((r) => r.gid)).toEqual(['small', 'large'])
      expect(executedQueries.join('\n')).not.toContain('DROP TABLE')
    })
  })

  // ── removeRecord ───────────────────────────────────────────────

  describe('removeRecord', () => {
    it('removes a single record by GID', async () => {
      await store.addRecord(makeRecord({ gid: 'g1' }))
      await store.addRecord(makeRecord({ gid: 'g2' }))

      await store.removeRecord('g1')

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('g2')
    })

    it('does not throw when removing non-existent GID', async () => {
      await expect(store.removeRecord('nonexistent')).resolves.not.toThrow()
    })
  })

  // ── removeBirthRecords ────────────────────────────────────────────

  describe('removeBirthRecords', () => {
    it('removes only the requested task birth records', async () => {
      await store.recordTaskBirth('metadata-gid', '2026-04-25T00:00:00Z')
      await store.recordTaskBirth('child-gid', '2026-04-25T00:00:01Z')
      await store.recordTaskBirth('unrelated-gid', '2026-04-25T00:00:02Z')

      await store.removeBirthRecords(['metadata-gid', 'child-gid'])

      const births = await store.loadBirthRecords()
      expect(births).toEqual([{ gid: 'unrelated-gid', added_at: '2026-04-25T00:00:02Z' }])
    })

    it('does nothing for an empty gid list', async () => {
      await store.recordTaskBirth('kept-gid', '2026-04-25T00:00:00Z')

      await store.removeBirthRecords([])

      expect(await store.loadBirthRecords()).toEqual([{ gid: 'kept-gid', added_at: '2026-04-25T00:00:00Z' }])
    })
  })

  // ── clearRecords ───────────────────────────────────────────────

  describe('clearRecords', () => {
    it('removes all records when no status filter', async () => {
      await store.addRecord(makeRecord({ gid: 'g1', status: 'complete' }))
      await store.addRecord(makeRecord({ gid: 'g2', status: 'error' }))

      await store.clearRecords()

      const results = await store.getRecords()
      expect(results).toEqual([])
    })

    it('removes only records matching the specified status', async () => {
      await store.addRecord(makeRecord({ gid: 'g1', status: 'complete' }))
      await store.addRecord(makeRecord({ gid: 'g2', status: 'error' }))
      await store.addRecord(makeRecord({ gid: 'g3', status: 'complete' }))

      await store.clearRecords('complete')

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('g2')
    })
  })

  // ── removeStaleRecords ─────────────────────────────────────────

  describe('removeStaleRecords', () => {
    it('removes records whose GIDs are in the provided list', async () => {
      await store.addRecord(makeRecord({ gid: 'g1' }))
      await store.addRecord(makeRecord({ gid: 'g2' }))
      await store.addRecord(makeRecord({ gid: 'g3' }))

      await store.removeStaleRecords(['g1', 'g3'])

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].gid).toBe('g2')
    })

    it('handles empty stale list gracefully', async () => {
      await store.addRecord(makeRecord({ gid: 'g1' }))

      await store.removeStaleRecords([])

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
    })
  })

  // ── Multiple operations ────────────────────────────────────────

  describe('combined operations', () => {
    it('add → remove → add with same GID works correctly', async () => {
      await store.addRecord(makeRecord({ gid: 'cycle', name: 'first.zip' }))
      await store.removeRecord('cycle')
      await store.addRecord(makeRecord({ gid: 'cycle', name: 'second.zip' }))

      const results = await store.getRecords()
      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('second.zip')
    })

    it('handles high volume of records', async () => {
      for (let i = 0; i < 100; i++) {
        await store.addRecord(
          makeRecord({
            gid: `gid-${i}`,
            name: `file-${i}.zip`,
            completed_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
          }),
        )
      }

      const all = await store.getRecords()
      expect(all).toHaveLength(100)

      // Verify sort order — most recent first (sorted by COALESCE(added_at, completed_at))
      for (let i = 0; i < all.length - 1; i++) {
        const ta = all[i].added_at ?? all[i].completed_at ?? ''
        const tb = all[i + 1].added_at ?? all[i + 1].completed_at ?? ''
        expect(ta >= tb).toBe(true)
      }
    })
  })

  // ── checkIntegrity ─────────────────────────────────────────────

  describe('checkIntegrity', () => {
    it('returns ok when database is healthy', async () => {
      const result = await store.checkIntegrity()
      expect(result).toBe('ok')
    })

    it('executes PRAGMA integrity_check', async () => {
      executedQueries = []
      await store.checkIntegrity()
      const integrityQueries = executedQueries.filter((q) => q.toUpperCase().includes('INTEGRITY_CHECK'))
      expect(integrityQueries.length).toBe(1)
    })
  })
})
