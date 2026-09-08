import { describe, expect, it } from 'vitest'
import { formatSharingDuration, getBtLifecycleState } from '@/composables/useBtLifecycle'
import type { Aria2Task } from '@shared/types'

function task(overrides: Partial<Aria2Task>): Aria2Task {
  return {
    gid: 'gid',
    status: 'active',
    totalLength: '100',
    completedLength: '0',
    uploadLength: '0',
    downloadSpeed: '0',
    uploadSpeed: '0',
    connections: '0',
    dir: '/tmp',
    files: [],
    bittorrent: { state: 'downloading' },
    ...overrides,
  }
}

describe('getBtLifecycleState', () => {
  it('keeps file selection distinct from a generic pause', () => {
    expect(
      getBtLifecycleState(task({ status: 'paused', bittorrent: { state: 'paused', fileSelectionState: 'awaiting' } })),
    ).toBe('selection')
  })

  it('distinguishes active and paused seeding', () => {
    expect(
      getBtLifecycleState(
        task({ status: 'active', completedLength: '100', seeder: 'true', bittorrent: { state: 'seeding' } }),
      ),
    ).toBe('seeding')
    expect(
      getBtLifecycleState(
        task({ status: 'paused', completedLength: '100', seeder: 'true', bittorrent: { state: 'paused' } }),
      ),
    ).toBe('paused-seeding')
  })

  it('keeps incomplete pauses resumable as downloads', () => {
    expect(getBtLifecycleState(task({ status: 'paused', bittorrent: { state: 'paused' } }))).toBe('paused-download')
  })

  it('treats a selectively completed active task as seeding', () => {
    expect(
      getBtLifecycleState(
        task({ status: 'active', completedLength: '50', seeder: 'true', bittorrent: { state: 'finished' } }),
      ),
    ).toBe('seeding')
  })

  it('keeps native recovery states distinct from metadata and downloads', () => {
    expect(
      getBtLifecycleState(
        task({
          status: 'active',
          seeder: 'false',
          bittorrent: { state: 'recovering' },
        }),
      ),
    ).toBe('recovering')
  })

  it('uses the structured BitTorrent error independently from task status', () => {
    expect(
      getBtLifecycleState(
        task({
          status: 'paused',
          bittorrent: {
            state: 'error',
            error: { code: '1', kind: 'storage', category: 'system', message: 'disk error', recoverable: 'false' },
          },
        }),
      ),
    ).toBe('error')
  })

  it('formats multi-day seeding time without truncating it', () => {
    expect(formatSharingDuration(183900, { day: 'd', hour: 'h', minute: 'm', second: 's' })).toBe('2d 3h')
  })
})
