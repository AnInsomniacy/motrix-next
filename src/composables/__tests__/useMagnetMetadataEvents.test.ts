import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMagnetMetadataResolver,
  resolvePendingMagnetMetadata,
  type MagnetMetadataState,
} from '@/composables/useMagnetMetadataEvents'
import type { Aria2Task } from '@shared/types'
import { logger } from '@shared/logger'

vi.mock('@shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/logger')>()
  return {
    ...actual,
    logger: {
      ...actual.logger,
      debug: vi.fn(),
    },
  }
})

function makeTask(gid: string, extra: Partial<Aria2Task> = {}): Aria2Task {
  return {
    gid,
    status: 'complete',
    totalLength: '0',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/downloads',
    files: [],
    ...extra,
  }
}

function makeSelectionTask(gid: string, name = 'Ubuntu ISO'): Aria2Task {
  return makeTask(gid, {
    status: 'paused',
    bittorrent: { info: { name }, state: 'paused', fileSelectionState: 'awaiting' },
    files: [
      {
        index: '1',
        path: `/downloads/${name}/file.bin`,
        length: '1024',
        completedLength: '0',
        selected: 'true',
        uris: [],
      },
    ],
  })
}

describe('useMagnetMetadataEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens file selection when the pending GID pauses for selection', async () => {
    const state: MagnetMetadataState = {
      deferredGids: [],
      pendingGids: ['metadata-gid'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }
    const fetchTaskStatus = vi.fn(async (gid: string) => makeSelectionTask(gid))
    const getFiles = vi.fn().mockResolvedValue([
      {
        index: '1',
        path: '/downloads/Ubuntu/ubuntu.iso',
        length: '1024',
        completedLength: '0',
        selected: 'true',
        uris: [],
      },
    ])

    const resolved = await resolvePendingMagnetMetadata(
      {
        state,
        fetchTaskStatus,
        fetchPendingTasks: vi.fn().mockResolvedValue([]),
        getFiles,
        fallbackName: () => 'Magnet task',
      },
      'metadata-gid',
    )

    expect(resolved).toBe(true)
    expect(state.pendingGids).toEqual(['metadata-gid'])
    expect(state.visible).toBe(true)
    expect(state.session).toEqual({ gid: 'metadata-gid' })
    expect(state.name).toBe('Ubuntu ISO')
    expect(state.files).toEqual([
      {
        index: 1,
        name: 'ubuntu.iso',
        path: '/downloads/Ubuntu/ubuntu.iso',
        length: 1024,
      },
    ])
    expect(fetchTaskStatus).toHaveBeenCalledWith('metadata-gid')
    expect(getFiles).toHaveBeenCalledWith('metadata-gid')
  })

  it('opens selection when task-list metadata is sparse but getFiles is ready', async () => {
    const state: MagnetMetadataState = {
      deferredGids: [],
      pendingGids: ['metadata-gid'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }
    const sparseTask = makeTask('metadata-gid', {
      status: 'paused',
      bittorrent: {
        state: 'paused',
        fileSelectionState: 'awaiting',
        magnetLink: 'magnet:?xt=urn:btih:abc&dn=Recovered%20Torrent',
      },
      files: [],
    })

    const resolved = await resolvePendingMagnetMetadata(
      {
        state,
        fetchTaskStatus: vi.fn().mockResolvedValue(sparseTask),
        fetchPendingTasks: vi.fn().mockResolvedValue([]),
        getFiles: vi.fn().mockResolvedValue([
          {
            index: '1',
            path: '/downloads/recovered.iso',
            length: '1024',
            completedLength: '0',
            selected: 'true',
            uris: [],
          },
        ]),
        fallbackName: () => 'Magnet task',
      },
      'metadata-gid',
    )

    expect(resolved).toBe(true)
    expect(state.name).toBe('Recovered Torrent')
  })

  it('ignores completion events for non-pending gids', async () => {
    const state: MagnetMetadataState = {
      deferredGids: [],
      pendingGids: ['metadata-gid'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }
    const fetchTaskStatus = vi.fn()

    const resolved = await resolvePendingMagnetMetadata(
      {
        state,
        fetchTaskStatus,
        fetchPendingTasks: vi.fn().mockResolvedValue([]),
        getFiles: vi.fn(),
        fallbackName: () => 'Magnet task',
      },
      'other-gid',
    )

    expect(resolved).toBe(false)
    expect(fetchTaskStatus).not.toHaveBeenCalled()
    expect(state.pendingGids).toEqual(['metadata-gid'])
  })

  it('keeps a registered task while magnet metadata is still loading', async () => {
    const state: MagnetMetadataState = {
      deferredGids: [],
      pendingGids: ['metadata-gid'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }

    const resolved = await resolvePendingMagnetMetadata(
      {
        state,
        fetchTaskStatus: vi.fn().mockResolvedValue(makeTask('metadata-gid', { status: 'active' })),
        fetchPendingTasks: vi.fn().mockResolvedValue([]),
        getFiles: vi.fn(),
        fallbackName: () => 'Magnet task',
      },
      'metadata-gid',
    )

    expect(resolved).toBe(false)
    expect(state.pendingGids).toEqual(['metadata-gid'])
  })

  it('keeps a dismissed selection pending without reopening it automatically', async () => {
    const state: MagnetMetadataState = {
      deferredGids: ['metadata-gid'],
      pendingGids: ['metadata-gid'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }
    const fetchTaskStatus = vi.fn()

    const resolved = await resolvePendingMagnetMetadata(
      {
        state,
        fetchTaskStatus,
        fetchPendingTasks: vi.fn().mockResolvedValue([]),
        getFiles: vi.fn(),
        fallbackName: () => 'Magnet task',
      },
      'metadata-gid',
    )

    expect(resolved).toBe(false)
    expect(state.pendingGids).toEqual(['metadata-gid'])
    expect(fetchTaskStatus).not.toHaveBeenCalled()
  })

  it('serializes simultaneous metadata pauses without replacing the open selection', async () => {
    const state: MagnetMetadataState = {
      deferredGids: [],
      pendingGids: ['metadata-a', 'metadata-b'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }
    const fetchTaskStatus = vi.fn(async (gid: string) => makeSelectionTask(gid, gid))
    const resolver = createMagnetMetadataResolver(() => ({
      state,
      fetchTaskStatus,
      fetchPendingTasks: vi.fn().mockResolvedValue([]),
      getFiles: vi
        .fn()
        .mockResolvedValue([
          { index: '1', path: '/downloads/file.bin', length: '1024', completedLength: '0', selected: 'true', uris: [] },
        ]),
      fallbackName: () => 'Magnet task',
    }))

    await Promise.all([resolver.request('metadata-a'), resolver.request('metadata-b')])

    expect(state.visible).toBe(true)
    expect(state.session).toEqual({ gid: 'metadata-a' })
    expect(state.pendingGids).toEqual(['metadata-a', 'metadata-b'])
  })

  it('opens the explicitly requested task instead of an older pending task', async () => {
    const state: MagnetMetadataState = {
      deferredGids: [],
      pendingGids: ['metadata-a', 'metadata-b'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }
    const resolver = createMagnetMetadataResolver(() => ({
      state,
      fetchTaskStatus: vi.fn(async (gid: string) => makeSelectionTask(gid, gid)),
      fetchPendingTasks: vi.fn().mockResolvedValue([]),
      getFiles: vi
        .fn()
        .mockResolvedValue([
          { index: '1', path: '/downloads/file.bin', length: '1024', completedLength: '0', selected: 'true', uris: [] },
        ]),
      fallbackName: () => 'Magnet task',
    }))

    await resolver.request('metadata-b')

    expect(state.session).toEqual({ gid: 'metadata-b' })
  })

  it('recovers the same GID from the one-shot pending task scan', async () => {
    const state: MagnetMetadataState = {
      deferredGids: [],
      pendingGids: ['metadata-gid'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }
    const followupTask = makeSelectionTask('metadata-gid', 'Recovered ISO')
    const fetchTaskStatus = vi.fn().mockRejectedValue({ Aria2: 'aria2 RPC error [1]: GID not found' })
    const getFiles = vi.fn().mockResolvedValue(followupTask.files)

    const resolved = await resolvePendingMagnetMetadata(
      {
        state,
        fetchTaskStatus,
        fetchPendingTasks: vi.fn().mockResolvedValue([followupTask]),
        getFiles,
        fallbackName: () => 'Magnet task',
      },
      'metadata-gid',
    )

    expect(resolved).toBe(true)
    expect(state.visible).toBe(true)
    expect(state.session).toEqual({ gid: 'metadata-gid' })
    expect(state.name).toBe('Recovered ISO')
    expect(getFiles).toHaveBeenCalledWith('metadata-gid')
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('serializes Tauri errors when neither metadata nor a follow-up task exists', async () => {
    const state: MagnetMetadataState = {
      deferredGids: [],
      pendingGids: ['metadata-gid'],
      visible: false,
      files: [],
      session: null,
      name: '',
    }

    const resolved = await resolvePendingMagnetMetadata(
      {
        state,
        fetchTaskStatus: vi.fn().mockRejectedValue({ Aria2: 'aria2 RPC error [1]: GID not found' }),
        fetchPendingTasks: vi.fn().mockResolvedValue([]),
        getFiles: vi.fn(),
        fallbackName: () => 'Magnet task',
      },
      'metadata-gid',
    )

    expect(resolved).toBe(false)
    expect(state.pendingGids).toEqual([])
    expect(logger.debug).toHaveBeenCalledWith('MagnetMetadata.resolve', 'metadata_resolution_skipped', {
      gid: 'metadata-gid',
      outcome: 'skipped',
      reason: 'Aria2 Next error [1]: GID not found',
    })
  })
})
