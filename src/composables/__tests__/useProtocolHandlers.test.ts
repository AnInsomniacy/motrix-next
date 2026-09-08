import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

import { useProtocolHandlers } from '../useProtocolHandlers'

describe('useProtocolHandlers', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
  })

  it('re-reads the real OS state after unregister fails', async () => {
    mockInvoke
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce({ Protocol: 'manual_change_required' })
      .mockResolvedValueOnce(true)

    const protocols = useProtocolHandlers()

    await protocols.refreshAll()
    await protocols.setProtocolEnabled('magnet', false)

    expect(mockInvoke).toHaveBeenCalledWith('remove_as_default_protocol_client', { protocol: 'magnet' })
    expect(mockInvoke).toHaveBeenLastCalledWith('is_default_protocol_client', { protocol: 'magnet' })
    expect(protocols.status.value.magnet).toBe(true)
  })

  it.each([
    { enabled: true, actual: true, failure: undefined, kind: 'success' },
    { enabled: false, actual: false, failure: undefined, kind: 'success' },
    { enabled: true, actual: false, failure: undefined, kind: 'unchanged' },
    { enabled: false, actual: true, failure: undefined, kind: 'unchanged' },
    { enabled: true, actual: false, failure: 'access denied', kind: 'failed' },
    { enabled: false, actual: true, failure: 'access denied', kind: 'failed' },
    { enabled: false, actual: true, failure: 'manual_change_required', kind: 'manual' },
    { enabled: true, actual: false, failure: 'cancelled', kind: 'cancelled' },
    { enabled: true, actual: true, failure: 'cache refresh failed', kind: 'success' },
  ])('verifies the outcome: $enabled / $actual / $failure → $kind', async ({ enabled, actual, failure, kind }) => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'is_default_protocol_client') return actual
      if (failure) throw { Protocol: failure }
    })
    const protocols = useProtocolHandlers()
    const result = await protocols.setProtocolEnabled('magnet', enabled)
    expect(result).toEqual(kind === 'failed' ? { kind, reason: failure } : { kind })
    expect(protocols.status.value.magnet).toBe(actual)
    expect(protocols.busy.value).toBe(false)
  })

  it('releases the operation after verification fails and allows retry', async () => {
    mockInvoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('query failed'))
    const protocols = useProtocolHandlers()
    expect(await protocols.setProtocolEnabled('magnet', true)).toEqual({ kind: 'query-failed' })
    expect(protocols.pending.value).toBeNull()
    mockInvoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true)
    expect(await protocols.setProtocolEnabled('magnet', true)).toEqual({ kind: 'success' })
  })

  it('prevents overlapping writes and refreshes from clearing a pending operation', async () => {
    let complete!: () => void
    mockInvoke
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          complete = resolve
        }),
      )
      .mockResolvedValueOnce(true)
    const protocols = useProtocolHandlers()
    const operation = protocols.setProtocolEnabled('magnet', true)
    expect(await protocols.setProtocolEnabled('ed2k', true)).toEqual({ kind: 'ignored' })
    await protocols.refreshAll()
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(protocols.pending.value).toBe('magnet')
    complete()
    await operation
    expect(protocols.busy.value).toBe(false)
  })

  it('keeps successful query results when another protocol cannot be read', async () => {
    mockInvoke.mockImplementation(async (_command: string, { protocol }: { protocol: string }) => {
      if (protocol === 'ed2k') throw new Error('query failed')
      return true
    })
    const protocols = useProtocolHandlers()
    await protocols.refreshAll()
    expect(protocols.status.value).toEqual({ magnet: true, ed2k: false, thunder: true, motrixnext: true })
    expect(protocols.busy.value).toBe(false)
  })
})
