import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Aria2Task } from '@shared/types'

const mockDeletePath = vi.fn()
const mockResolveOpenTarget = vi.fn()
const mockCleanupTorrentMetadata = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: Record<string, unknown>) => {
    if (command === 'delete_path') return mockDeletePath(args)
    return Promise.reject(new Error(`Unexpected invoke: ${command}`))
  },
}))

vi.mock('@shared/utils', () => ({
  resolveOpenTarget: (...args: unknown[]) => mockResolveOpenTarget(...args),
}))

vi.mock('@/composables/useDownloadCleanup', () => ({
  cleanupAria2MetadataFiles: (...args: unknown[]) => mockCleanupTorrentMetadata(...args),
}))

import { cleanupAria2ControlFiles, deletePath, deleteTaskFiles } from '../useFileDelete'

function makeTask(overrides: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid: 'abc123',
    status: 'complete',
    totalLength: '1000',
    completedLength: '1000',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [],
    ...overrides,
  }
}

function makeFile(path: string, index = '1') {
  return { index, path, length: '1000', completedLength: '1000', selected: 'true', uris: [] }
}

describe('deletePath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeletePath.mockResolvedValue(true)
  })

  it('passes the requested mode to the unified command', async () => {
    await expect(deletePath('/downloads/file.bin', 'permanent')).resolves.toBe(true)
    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/file.bin', mode: 'permanent' })
  })

  it('ignores empty paths without invoking the backend', async () => {
    await expect(deletePath('', 'trash')).resolves.toBe(false)
    expect(mockDeletePath).not.toHaveBeenCalled()
  })
})

describe('deleteTaskFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeletePath.mockResolvedValue(true)
    mockCleanupTorrentMetadata.mockResolvedValue(true)
  })

  it('moves user content to Trash and permanently deletes internal metadata', async () => {
    const infoHash = 'abcdef1234567890abcdef1234567890abcdef12'
    const task = makeTask({
      bittorrent: { info: { name: 'My Torrent' } },
      infoHash,
      files: [
        {
          index: '1',
          path: '/downloads/My Torrent/file.bin',
          length: '1000',
          completedLength: '1000',
          selected: 'true',
          uris: [],
        },
      ],
    })
    mockResolveOpenTarget.mockResolvedValue('/downloads/My Torrent')

    await deleteTaskFiles(task, 'trash')

    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/My Torrent', mode: 'trash' })
    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/My Torrent.aria2', mode: 'permanent' })
    expect(mockDeletePath).toHaveBeenCalledWith({ path: `/downloads/${infoHash}.aria2`, mode: 'permanent' })
    expect(mockCleanupTorrentMetadata).toHaveBeenCalledWith('/downloads', infoHash)
  })

  it('permanently deletes user content when configured', async () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: '/downloads/file.bin',
          length: '1000',
          completedLength: '1000',
          selected: 'true',
          uris: [],
        },
      ],
    })
    mockResolveOpenTarget.mockResolvedValue('/downloads/file.bin')

    await deleteTaskFiles(task, 'permanent')

    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/file.bin', mode: 'permanent' })
    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/file.bin.aria2', mode: 'permanent' })
  })

  it('deletes individual files without deleting the download root', async () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: '/downloads/one.bin',
          length: '500',
          completedLength: '500',
          selected: 'true',
          uris: [],
        },
        {
          index: '2',
          path: '/downloads/two.bin',
          length: '500',
          completedLength: '500',
          selected: 'true',
          uris: [],
        },
      ],
    })
    mockResolveOpenTarget.mockResolvedValue('/downloads')

    await deleteTaskFiles(task, 'trash')

    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/one.bin', mode: 'trash' })
    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/two.bin', mode: 'trash' })
    expect(mockDeletePath).not.toHaveBeenCalledWith({ path: '/downloads', mode: 'trash' })
  })

  it('attempts every content path and reports deletion failures', async () => {
    const task = makeTask({
      files: [
        {
          index: '1',
          path: '/downloads/locked.bin',
          length: '500',
          completedLength: '500',
          selected: 'true',
          uris: [],
        },
        {
          index: '2',
          path: '/downloads/open.bin',
          length: '500',
          completedLength: '500',
          selected: 'true',
          uris: [],
        },
      ],
    })
    mockResolveOpenTarget.mockResolvedValue('/downloads')
    mockDeletePath.mockImplementation(({ path }: { path: string }) =>
      path === '/downloads/locked.bin' ? Promise.reject(new Error('permission denied')) : Promise.resolve(true),
    )

    await expect(deleteTaskFiles(task, 'permanent')).rejects.toThrow('Failed to delete 1 path')
    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/open.bin', mode: 'permanent' })
    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/locked.bin.aria2', mode: 'permanent' })
  })

  it('handles tasks without content paths', async () => {
    const task = makeTask()
    mockResolveOpenTarget.mockResolvedValue('/downloads')

    await expect(deleteTaskFiles(task, 'trash')).resolves.toBeUndefined()
    expect(mockDeletePath).not.toHaveBeenCalled()
  })

  it('keeps a file another task is still downloading', async () => {
    const removed = makeTask({ gid: 'removed', files: [makeFile('/downloads/shared.bin')] })
    const kept = makeTask({ gid: 'kept', files: [makeFile('/downloads/shared.bin')] })
    mockResolveOpenTarget.mockImplementation((task: Aria2Task) => Promise.resolve(task.files?.[0]?.path ?? task.dir))

    await deleteTaskFiles(removed, 'trash', [kept])

    expect(mockDeletePath).not.toHaveBeenCalledWith({ path: '/downloads/shared.bin', mode: 'trash' })
    expect(mockDeletePath).not.toHaveBeenCalledWith({ path: '/downloads/shared.bin.aria2', mode: 'permanent' })
  })

  it('keeps a folder that contains files of another task', async () => {
    const removed = makeTask({ gid: 'removed', files: [makeFile('/downloads/Album/track1.mp3')] })
    const kept = makeTask({ gid: 'kept', files: [makeFile('/downloads/Album/track2.mp3')] })
    mockResolveOpenTarget.mockImplementation((task: Aria2Task) =>
      Promise.resolve(task.gid === 'removed' ? '/downloads/Album' : '/downloads/Album/track2.mp3'),
    )

    await deleteTaskFiles(removed, 'trash', [kept])

    expect(mockDeletePath).not.toHaveBeenCalledWith({ path: '/downloads/Album', mode: 'trash' })
  })

  it('still deletes when the other tasks point elsewhere', async () => {
    const removed = makeTask({ gid: 'removed', files: [makeFile('/downloads/mine.bin')] })
    const other = makeTask({ gid: 'other', files: [makeFile('/downloads/theirs.bin')] })
    mockResolveOpenTarget.mockImplementation((task: Aria2Task) => Promise.resolve(task.files?.[0]?.path ?? task.dir))

    await deleteTaskFiles(removed, 'trash', [other])

    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/mine.bin', mode: 'trash' })
    expect(mockDeletePath).not.toHaveBeenCalledWith({ path: '/downloads/theirs.bin', mode: 'trash' })
  })

  it('ignores a stale entry for the task being removed', async () => {
    const removed = makeTask({ gid: 'removed', files: [makeFile('/downloads/mine.bin')] })
    mockResolveOpenTarget.mockResolvedValue('/downloads/mine.bin')

    await deleteTaskFiles(removed, 'trash', [removed])

    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/mine.bin', mode: 'trash' })
  })
})

describe('cleanupAria2ControlFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeletePath.mockResolvedValue(true)
  })

  it('permanently deletes task control files', async () => {
    const task = makeTask({
      infoHash: 'deadbeef'.repeat(5),
      files: [
        {
          index: '1',
          path: '/downloads/file.bin',
          length: '1000',
          completedLength: '1000',
          selected: 'true',
          uris: [],
        },
      ],
    })
    mockResolveOpenTarget.mockResolvedValue('/downloads/file.bin')

    await cleanupAria2ControlFiles(task)

    expect(mockDeletePath).toHaveBeenCalledWith({ path: `/downloads/${task.infoHash}.aria2`, mode: 'permanent' })
    expect(mockDeletePath).toHaveBeenCalledWith({ path: '/downloads/file.bin.aria2', mode: 'permanent' })
  })

  it('does not propagate cleanup errors', async () => {
    const task = makeTask({ files: [] })
    mockResolveOpenTarget.mockRejectedValue(new Error('resolve failed'))

    await expect(cleanupAria2ControlFiles(task)).resolves.toBeUndefined()
  })
})
