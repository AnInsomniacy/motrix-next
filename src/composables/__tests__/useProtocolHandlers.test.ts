import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('@shared/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { useProtocolHandlers } from '../useProtocolHandlers'

describe('protocol associations', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it.each([
    { enabled: true, actual: true, failure: undefined, kind: 'success' },
    { enabled: true, actual: false, failure: undefined, kind: 'unchanged' },
    { enabled: true, actual: false, failure: 'access denied', kind: 'failed' },
    { enabled: false, actual: true, failure: 'manual_change_required', kind: 'manual' },
    { enabled: true, actual: false, failure: 'cancelled', kind: 'cancelled' },
  ])('uses the OS result: $enabled / $actual / $failure', async ({ enabled, actual, failure, kind }) => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'is_default_protocol_client') return actual
      if (failure) throw { Protocol: failure }
    })
    const protocols = useProtocolHandlers()
    expect(await protocols.setProtocolEnabled('magnet', enabled)).toEqual(
      kind === 'failed' ? { kind, reason: failure } : { kind },
    )
    expect(protocols.status.value.magnet).toBe(actual)
    expect(protocols.busy.value).toBe(false)
  })

  it('distinguishes failed queries from off and recovers on retry', async () => {
    mockInvoke.mockImplementation(async (_command: string, { protocol }: { protocol: string }) => {
      if (protocol === 'ed2k') throw new Error('query failed')
      return true
    })
    const protocols = useProtocolHandlers()
    expect(protocols.status.value.ed2k).toBeUndefined()
    await protocols.refreshAll()
    expect(protocols.status.value).toEqual({ magnet: true, ed2k: null, thunder: true, rayburst: true })

    mockInvoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('query failed'))
    expect(await protocols.setProtocolEnabled('magnet', false)).toEqual({ kind: 'query-failed' })
    expect(protocols.status.value.magnet).toBeNull()
    expect(protocols.pending.value).toBeNull()

    mockInvoke.mockResolvedValue(false)
    await protocols.refreshAll()
    expect(protocols.status.value).toEqual({ magnet: false, ed2k: false, thunder: false, rayburst: false })
  })

  it('serializes changes and verifies before releasing the pending state', async () => {
    let complete!: () => void
    mockInvoke
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          complete = resolve
        }),
      )
      .mockResolvedValueOnce(false)
    const protocols = useProtocolHandlers()
    const operation = protocols.setProtocolEnabled('magnet', false)
    expect(await protocols.setProtocolEnabled('ed2k', true)).toEqual({ kind: 'ignored' })
    await protocols.refreshAll()
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(protocols.pending.value).toBe('magnet')
    complete()
    expect(await operation).toEqual({ kind: 'success' })
    expect(mockInvoke).toHaveBeenLastCalledWith('is_default_protocol_client', { protocol: 'magnet' })
    expect(protocols.busy.value).toBe(false)
  })
})
