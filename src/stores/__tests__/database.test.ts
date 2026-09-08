import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import Database from '@tauri-apps/plugin-sql'
import { useDatabaseStore } from '../database'

const { connection } = vi.hoisted(() => ({
  connection: {
    path: 'sqlite:history.db',
    execute: vi.fn<Database['execute']>().mockResolvedValue({ rowsAffected: 0 }),
    select: <T>(): Promise<T> => Promise.reject(new Error('Unexpected query in lifecycle test')),
    close: vi.fn<Database['close']>().mockResolvedValue(true),
  },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: vi.fn(), get: vi.fn() } }))
vi.mock('@shared/logger', () => ({ logger: { error: vi.fn() } }))

describe('database lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(false)
    vi.mocked(Database.load).mockResolvedValue(connection)
    vi.mocked(Database.get).mockReturnValue(connection)
  })

  it('shares opening, configures SQLite, then enables native history access', async () => {
    const database = useDatabaseStore()
    expect(database.phase).toBe('idle')
    await Promise.all([database.init(), database.init()])
    expect(Database.load).toHaveBeenCalledTimes(1)
    expect(connection.execute.mock.calls.map(([sql]) => sql)).toEqual([
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = NORMAL',
      'PRAGMA busy_timeout = 5000',
      'PRAGMA foreign_keys = ON',
    ])
    expect(invoke).toHaveBeenLastCalledWith('database_initialize')
    expect(database.isReady).toBe(true)
  })

  it('preserves a failed database without retrying or resetting on subsequent reads', async () => {
    vi.mocked(invoke).mockRejectedValueOnce({ Database: 'corrupt' })
    const database = useDatabaseStore()
    await Promise.allSettled([database.init(), database.init()])
    await expect(database.init()).rejects.toEqual({ Database: 'corrupt' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(Database.load).not.toHaveBeenCalled()
    expect(database.phase).toBe('failed')
  })

  it('reuses native connections when the WebView is recreated', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true)
    await useDatabaseStore().init()
    expect(Database.get).toHaveBeenCalledWith('sqlite:history.db')
    expect(Database.load).not.toHaveBeenCalled()
    expect(connection.execute).not.toHaveBeenCalled()
  })

  it('exposes migration failure without opening native history or retrying SQL load', async () => {
    vi.mocked(Database.load).mockRejectedValueOnce(new Error('migration failed'))
    const database = useDatabaseStore()
    await expect(database.init()).rejects.toThrow('migration failed')
    await expect(database.init()).rejects.toThrow('migration failed')
    expect(database.phase).toBe('failed')
    expect(Database.load).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalledWith('database_initialize')
  })

  it('allows an explicit reset after failure and keeps reset failures visible', async () => {
    const database = useDatabaseStore()
    vi.mocked(invoke).mockRejectedValueOnce(new Error('corrupt'))
    await expect(database.init()).rejects.toThrow('corrupt')
    vi.mocked(invoke).mockRejectedValueOnce(new Error('permission denied'))
    await expect(database.reset()).rejects.toThrow('permission denied')
    expect(database.phase).toBe('failed')
    await expect(Promise.all([database.reset(), database.reset()])).resolves.toEqual([undefined, undefined])
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'database_reset')).toHaveLength(2)
    expect(invoke).toHaveBeenLastCalledWith('database_reset')
    expect(database.phase).toBe('resetting')
  })
})
