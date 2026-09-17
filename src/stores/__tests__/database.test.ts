import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { useDatabaseStore } from '../database'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn() } }))
beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
})
describe('database UI state', () => {
  it('shares initialization and exposes native readiness', async () => {
    const db = useDatabaseStore()
    await Promise.all([db.init(), db.init()])
    expect(db.isReady).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('keeps a storage failure visible until an explicit reset', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('corrupt'))
    const db = useDatabaseStore()
    await expect(db.init()).rejects.toThrow('corrupt')
    await expect(db.init()).rejects.toThrow('corrupt')
    expect(db.phase).toBe('failed')
    expect(invoke).toHaveBeenCalledTimes(1)
    await db.reset()
    expect(db.phase).toBe('resetting')
  })
})
