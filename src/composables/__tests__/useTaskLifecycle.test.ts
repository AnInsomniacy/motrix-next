/** @fileoverview TDD tests for useTaskLifecycle — pure functions bridging
 * task events to download history and cleanup actions.
 *
 * Tests written BEFORE implementation per TDD Iron Law.
 * Mocks are used only for external Tauri APIs (unavoidable).
 */
import { describe, it, expect, vi } from 'vitest'
import type { Aria2Task, HistoryRecord } from '@shared/types'

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(true),
  remove: vi.fn().mockResolvedValue(undefined),
}))

const { buildHistoryRecord, shouldRunStaleCleanup, historyRecordToTask, mergeHistoryIntoTasks } =
  await import('../useTaskLifecycle')

// ── Test data factories ──────────────────────────────────────────────

function makeTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: 'abc123',
    status: 'complete',
    totalLength: '1048576',
    completedLength: '1048576',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [
      {
        index: '1',
        path: '/downloads/test.zip',
        length: '1048576',
        selected: 'true',
        uris: [{ uri: 'https://example.com/test.zip', status: 'used' }],
      },
    ],
    ...overrides,
  } as unknown as Aria2Task
}

// ── buildHistoryRecord ───────────────────────────────────────────────

describe('buildHistoryRecord', () => {
  it('extracts gid, name, dir, status from Aria2Task', () => {
    const task = makeTask({ gid: 'g1', status: 'complete', dir: '/dl' })
    const record = buildHistoryRecord(task)

    expect(record.gid).toBe('g1')
    expect(record.status).toBe('complete')
    expect(record.dir).toBe('/dl')
  })

  it('extracts name from first file path basename', () => {
    const task = makeTask({
      files: [
        { index: '1', path: '/dl/big-file.iso', length: '999', completedLength: '999', selected: 'true', uris: [] },
      ],
    })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('big-file.iso')
  })

  it('extracts name from Windows backslash path', () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: 'C:\\Users\\foo\\Downloads\\setup.exe',
          length: '999',
          completedLength: '999',
          selected: 'true',
          uris: [],
        },
      ],
    })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('setup.exe')
  })

  it('uses bittorrent info name if available', () => {
    const task = makeTask({
      bittorrent: { info: { name: 'Ubuntu 24.04' } },
    })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('Ubuntu 24.04')
  })

  it('falls back to "Unknown" when no name source available', () => {
    const task = makeTask({ files: [], bittorrent: undefined })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('Unknown')
  })

  it('sets total_length from totalLength', () => {
    const task = makeTask({ totalLength: '2097152' })
    const record = buildHistoryRecord(task)
    expect(record.total_length).toBe(2097152)
  })

  it('extracts URI from first file uris array', () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: '/dl/f.zip',
          length: '100',
          completedLength: '100',
          selected: 'true',
          uris: [{ uri: 'https://dl.example.com/f.zip', status: 'used' }],
        },
      ],
    })
    const record = buildHistoryRecord(task)
    expect(record.uri).toBe('https://dl.example.com/f.zip')
  })

  it('sets task_type to "bt" for bittorrent tasks', () => {
    const task = makeTask({ bittorrent: { info: { name: 'torrent' } } })
    const record = buildHistoryRecord(task)
    expect(record.task_type).toBe('bt')
  })

  it('sets task_type to "uri" for regular downloads', () => {
    const task = makeTask({ bittorrent: undefined })
    const record = buildHistoryRecord(task)
    expect(record.task_type).toBe('uri')
  })

  it('sets completed_at to ISO string', () => {
    const task = makeTask()
    const record = buildHistoryRecord(task)
    expect(record.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('preserves error status for failed downloads', () => {
    const task = makeTask({ status: 'error', errorCode: '3', errorMessage: 'Resource not found' })
    const record = buildHistoryRecord(task)
    expect(record.status).toBe('error')
    expect(record.gid).toBe('abc123')
    expect(record.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('stores infoHash in meta JSON for BT tasks', () => {
    const task = makeTask({ infoHash: 'deadbeef1234567890abcdef' })
    const record = buildHistoryRecord(task)
    expect(record.meta).toBeDefined()
    const meta = JSON.parse(record.meta!)
    expect(meta.infoHash).toBe('deadbeef1234567890abcdef')
  })

  it('omits meta when no infoHash', () => {
    const task = makeTask({ bittorrent: undefined, infoHash: undefined })
    const record = buildHistoryRecord(task)
    expect(record.meta).toBeUndefined()
  })

  it('decodes percent-encoded path segments in file name', () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: '/downloads/AAA%20BBB.mp3',
          length: '100',
          completedLength: '100',
          selected: 'true',
          uris: [],
        },
      ],
    })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('AAA BBB.mp3')
  })

  it('decodes UTF-8 percent sequences in file name', () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: '/downloads/%E4%B8%AD%E6%96%87.txt',
          length: '100',
          completedLength: '100',
          selected: 'true',
          uris: [],
        },
      ],
    })
    const record = buildHistoryRecord(task)
    expect(record.name).toBe('中文.txt')
  })
})

// ── shouldRunStaleCleanup ────────────────────────────────────────────

describe('shouldRunStaleCleanup', () => {
  it('returns true when autoDeleteStaleRecords is true', () => {
    expect(shouldRunStaleCleanup({ autoDeleteStaleRecords: true })).toBe(true)
  })

  it('returns false when autoDeleteStaleRecords is false', () => {
    expect(shouldRunStaleCleanup({ autoDeleteStaleRecords: false })).toBe(false)
  })

  it('returns false when config is undefined', () => {
    expect(shouldRunStaleCleanup(undefined)).toBe(false)
  })

  it('returns false when autoDeleteStaleRecords is missing', () => {
    expect(shouldRunStaleCleanup({})).toBe(false)
  })
})

// ── historyRecordToTask ─────────────────────────────────────────────

function makeRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    gid: 'hist-001',
    name: 'test-file.zip',
    status: 'complete',
    uri: 'https://example.com/test-file.zip',
    dir: '/downloads',
    total_length: 2048000,
    task_type: 'uri',
    completed_at: '2026-03-15T10:00:00.000Z',
    ...overrides,
  }
}

describe('historyRecordToTask', () => {
  it('maps gid, status, dir, totalLength from record', () => {
    const task = historyRecordToTask(makeRecord())
    expect(task.gid).toBe('hist-001')
    expect(task.status).toBe('complete')
    expect(task.dir).toBe('/downloads')
    expect(task.totalLength).toBe('2048000')
    expect(task.completedLength).toBe('2048000')
  })

  it('constructs files[0] with correct path and uri for URI tasks', () => {
    const task = historyRecordToTask(makeRecord())
    expect(task.files).toHaveLength(1)
    expect(task.files[0].path).toBe('/downloads/test-file.zip')
    expect(task.files[0].uris).toEqual([{ uri: 'https://example.com/test-file.zip', status: 'used' }])
  })

  it('constructs bittorrent.info.name for BT tasks', () => {
    const task = historyRecordToTask(makeRecord({ task_type: 'bt', name: 'My Torrent' }))
    expect(task.bittorrent?.info?.name).toBe('My Torrent')
    expect(task.files[0].path).toBe('/downloads/My Torrent')
  })

  it('handles missing optional fields gracefully', () => {
    const task = historyRecordToTask(makeRecord({ uri: undefined, dir: undefined, total_length: undefined }))
    expect(task.dir).toBe('')
    expect(task.totalLength).toBe('0')
    expect(task.files[0].uris).toEqual([])
  })

  it('preserves error status', () => {
    const task = historyRecordToTask(makeRecord({ status: 'error' }))
    expect(task.status).toBe('error')
  })

  it('sets completedLength = totalLength for complete records, 0 for error', () => {
    const complete = historyRecordToTask(makeRecord({ status: 'complete', total_length: 5000 }))
    expect(complete.completedLength).toBe('5000')

    const errored = historyRecordToTask(makeRecord({ status: 'error', total_length: 5000 }))
    expect(errored.completedLength).toBe('0')
  })

  it('restores infoHash from meta JSON for BT restart', () => {
    const meta = JSON.stringify({ infoHash: 'deadbeef1234567890abcdef' })
    const task = historyRecordToTask(makeRecord({ task_type: 'bt', name: 'My Torrent', meta }))
    expect(task.infoHash).toBe('deadbeef1234567890abcdef')
    expect(task.bittorrent?.info?.name).toBe('My Torrent')
  })

  it('handles missing/corrupt meta gracefully', () => {
    const task1 = historyRecordToTask(makeRecord({ meta: undefined }))
    expect(task1.infoHash).toBeUndefined()

    const task2 = historyRecordToTask(makeRecord({ meta: 'NOT_JSON' }))
    expect(task2.infoHash).toBeUndefined()
  })
})

// ── mergeHistoryIntoTasks ───────────────────────────────────────────

describe('mergeHistoryIntoTasks', () => {
  it('returns aria2 tasks unchanged when no history records', () => {
    const aria2 = [makeTask({ gid: 'a1' })]
    const result = mergeHistoryIntoTasks(aria2, [])
    expect(result).toEqual(aria2)
  })

  it('appends history-only records after aria2 tasks', () => {
    const aria2 = [makeTask({ gid: 'a1' })]
    const history = [makeRecord({ gid: 'h1' })]
    const result = mergeHistoryIntoTasks(aria2, history)
    expect(result).toHaveLength(2)
    expect(result[0].gid).toBe('a1')
    expect(result[1].gid).toBe('h1')
  })

  it('deduplicates by GID — aria2 data wins', () => {
    const aria2 = [makeTask({ gid: 'shared', totalLength: '9999' })]
    const history = [makeRecord({ gid: 'shared', total_length: 1111 })]
    const result = mergeHistoryIntoTasks(aria2, history)
    expect(result).toHaveLength(1)
    expect(result[0].gid).toBe('shared')
    expect(result[0].totalLength).toBe('9999') // aria2 data preserved
  })

  it('handles empty aria2 with history records', () => {
    const history = [makeRecord({ gid: 'h1' }), makeRecord({ gid: 'h2' })]
    const result = mergeHistoryIntoTasks([], history)
    expect(result).toHaveLength(2)
    expect(result.map((t) => t.gid)).toEqual(['h1', 'h2'])
  })

  it('handles both empty', () => {
    expect(mergeHistoryIntoTasks([], [])).toEqual([])
  })
})
