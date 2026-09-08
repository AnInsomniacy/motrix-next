import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const invokeMock = vi.fn()
const listenMock = vi.fn()
let stateListener: ((event: { payload: unknown }) => void) | null = null

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}))

import { useEngineStore, type EngineOperationCause, type EngineSnapshot } from '@/stores/engine'

function snapshot(operationId: number, phase: EngineSnapshot['phase']): EngineSnapshot {
  return {
    phase,
    desired: phase === 'stopped' ? 'stopped' : 'running',
    revision: operationId,
    operationId,
    attempt: phase === 'stopped' ? 0 : 1,
    maxAttempts: 5,
    cause: 'manualRestart',
    failure: null,
  }
}

describe('engine supervisor store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stateListener = null
    listenMock.mockImplementation(async (_event: string, listener: (event: { payload: unknown }) => void) => {
      stateListener = listener
      return vi.fn()
    })
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'engine_supervisor_state') return snapshot(0, 'stopped')
      return snapshot(1, 'running')
    })
  })

  it('subscribes before reading the initial supervisor snapshot', async () => {
    const store = useEngineStore()
    await store.initialize()
    expect(listenMock).toHaveBeenCalledWith('engine-state-changed', expect.any(Function))
    expect(invokeMock).toHaveBeenCalledWith('engine_supervisor_state')
    expect(store.snapshot.phase).toBe('stopped')
  })

  it('ignores stale state events', async () => {
    const store = useEngineStore()
    await store.initialize()
    stateListener?.({ payload: snapshot(4, 'running') })
    stateListener?.({ payload: snapshot(3, 'failed') })
    expect(store.snapshot.operationId).toBe(4)
    expect(store.isReady).toBe(true)
  })

  it('ignores an older transition from the same operation', async () => {
    const store = useEngineStore()
    await store.initialize()
    const running = { ...snapshot(4, 'running'), revision: 12 }
    const probing = { ...snapshot(4, 'probing'), revision: 11 }
    stateListener?.({ payload: running })
    stateListener?.({ payload: probing })
    expect(store.snapshot.phase).toBe('running')
    expect(store.snapshot.revision).toBe(12)
  })

  it('delegates cancellation to the supervisor', async () => {
    invokeMock.mockResolvedValueOnce(snapshot(8, 'stopped'))
    const store = useEngineStore()
    await store.cancel()
    expect(invokeMock).toHaveBeenCalledWith('engine_cancel')
    expect(store.snapshot.phase).toBe('stopped')
  })

  it('refreshes the authoritative state after a command error', async () => {
    invokeMock.mockRejectedValueOnce(new Error('restart failed')).mockResolvedValueOnce(snapshot(9, 'failed'))
    const store = useEngineStore()
    await expect(store.restart('manualRestart')).rejects.toThrow('restart failed')
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'engine_restart', { cause: 'manualRestart' })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'engine_supervisor_state')
    expect(store.snapshot.phase).toBe('failed')
  })

  it('keeps automatic recovery visible across every busy phase', () => {
    const store = useEngineStore()
    const busyPhases: EngineSnapshot['phase'][] = [
      'recovering',
      'preparing',
      'starting',
      'probing',
      'initializing',
      'stabilizing',
    ]

    for (const phase of busyPhases) {
      store.snapshot = {
        ...snapshot(2, phase),
        attempt: 2,
        cause: 'startup',
      }
      expect(store.showStatusDialog).toBe(true)
    }
  })

  it('keeps explicit failure recovery visible from its first phase', () => {
    const store = useEngineStore()
    store.snapshot = {
      ...snapshot(3, 'starting'),
      cause: 'failureRetry',
    }
    expect(store.showStatusDialog).toBe(true)

    store.snapshot = {
      ...snapshot(4, 'cleaning'),
      cause: 'sessionRecovery',
      attempt: 0,
    }
    expect(store.showStatusDialog).toBe(true)
  })

  it('shows the unified status dialog as soon as a confirmed restart begins', () => {
    const store = useEngineStore()

    const causes: EngineOperationCause[] = ['manualRestart', 'settingsChange']
    for (const cause of causes) {
      store.snapshot = {
        ...snapshot(store.snapshot.operationId + 1, 'stopping'),
        cause,
      }
      expect(store.showStatusDialog).toBe(true)
    }
  })
})
