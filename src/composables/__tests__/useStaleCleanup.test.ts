/** @fileoverview TDD tests for runStaleRecordCleanup — the orchestration function
 * that connects the history store to file existence checks.
 *
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCheckPathExists = vi.fn()
vi.mock('@tauri-apps/plugin-fs', () => ({
  remove: vi.fn(),
}))

// Mock Tauri path — join uses OS-native separator, mock with /
vi.mock('@tauri-apps/api/path', () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
}))

// Mock invoke — routes check_path_exists to dedicated handler
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'check_path_exists') return mockCheckPathExists(args)
    return Promise.reject(new Error(`Unexpected invoke: ${cmd}`))
  },
}))

const { getCompletedRecordRetentionCutoff, runCompletedRecordRetentionCleanup, runStaleRecordCleanup } =
  await import('../useStaleCleanup')

describe('runStaleRecordCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes records whose files no longer exist', async () => {
    // 3 records: file1 exists, file2 gone, file3 gone
    mockCheckPathExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false)

    const records = [
      { gid: 'g1', name: 'exists.zip', dir: '/dl', status: 'complete' },
      { gid: 'g2', name: 'gone.zip', dir: '/dl', status: 'complete' },
      { gid: 'g3', name: 'deleted.zip', dir: '/dl', status: 'complete' },
    ]

    const mockRemoveStale = vi.fn().mockResolvedValue(undefined)
    const result = await runStaleRecordCleanup(records, mockRemoveStale)

    expect(result.scanned).toBe(3)
    expect(result.removed).toBe(2)
    expect(mockRemoveStale).toHaveBeenCalledWith(['g2', 'g3'])
  })

  it('does nothing when all files exist', async () => {
    mockCheckPathExists.mockResolvedValue(true)

    const records = [{ gid: 'g1', name: 'a.zip', dir: '/dl', status: 'complete' }]

    const mockRemoveStale = vi.fn()
    const result = await runStaleRecordCleanup(records, mockRemoveStale)

    expect(result.scanned).toBe(1)
    expect(result.removed).toBe(0)
    expect(mockRemoveStale).not.toHaveBeenCalled()
  })

  it('does nothing with empty records', async () => {
    const mockRemoveStale = vi.fn()
    const result = await runStaleRecordCleanup([], mockRemoveStale)

    expect(result.scanned).toBe(0)
    expect(result.removed).toBe(0)
    expect(mockRemoveStale).not.toHaveBeenCalled()
  })

  it('handles errors gracefully without throwing', async () => {
    mockCheckPathExists.mockRejectedValue(new Error('fs error'))

    const records = [{ gid: 'g1', name: 'a.zip', dir: '/dl', status: 'complete' }]

    const mockRemoveStale = vi.fn().mockResolvedValue(undefined)
    // Should not throw — errors mean file doesn't exist, so mark stale
    const result = await runStaleRecordCleanup(records, mockRemoveStale)
    expect(result.removed).toBe(1)
  })
})

describe('completed record retention', () => {
  it('keeps records forever when retention is disabled', () => {
    const now = new Date('2026-05-26T00:00:00.000Z')

    expect(getCompletedRecordRetentionCutoff(0, now)).toBeNull()
  })

  it('builds a cutoff from the configured day count', () => {
    const now = new Date('2026-05-26T12:00:00.000Z')

    expect(getCompletedRecordRetentionCutoff(7, now)).toBe('2026-05-19T12:00:00.000Z')
  })

  it('removes expired completed records from history and aria2 result list', async () => {
    const records = [
      { gid: 'old', name: 'old.zip', status: 'complete', completed_at: '2026-05-01T00:00:00.000Z' },
      { gid: 'new', name: 'new.zip', status: 'complete', completed_at: '2026-05-25T00:00:00.000Z' },
      { gid: 'error', name: 'error.zip', status: 'error', completed_at: '2026-05-01T00:00:00.000Z' },
    ]
    const removeHistoryRecords = vi.fn().mockResolvedValue(undefined)
    const removeTaskRecord = vi.fn().mockResolvedValue('OK')

    const result = await runCompletedRecordRetentionCleanup({
      retentionDays: 7,
      now: new Date('2026-05-26T00:00:00.000Z'),
      records,
      removeHistoryRecords,
      removeTaskRecord,
    })

    expect(result).toEqual({ scanned: 3, removed: 1 })
    expect(removeHistoryRecords).toHaveBeenCalledWith(['old'])
    expect(removeTaskRecord).toHaveBeenCalledWith({ gid: 'old' })
  })
})
