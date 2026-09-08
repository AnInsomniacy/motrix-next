import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useHttpAuthStore } from '@/stores/httpAuth'

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: vi.fn().mockResolvedValue(mockDb),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(false) }))

describe('useHttpAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockDb.execute.mockResolvedValue(undefined)
    mockDb.select.mockResolvedValue([])
  })

  it('saves credentials by normalized origin and username', async () => {
    const store = useHttpAuthStore()

    await store.saveCredential({
      url: 'https://User:Pass@Files.Example.com:443/private/file.zip?token=1',
      username: ' demo ',
      password: ' secret ',
    })

    expect(mockDb.execute).toHaveBeenCalledWith(expect.stringContaining('http_auth_credentials'), [
      'https://files.example.com',
      'demo',
      'secret',
    ])
  })

  it('finds the most recently used credential for a download URL', async () => {
    mockDb.select.mockResolvedValueOnce([
      {
        id: 7,
        origin: 'https://files.example.com',
        username: 'demo',
        password: 'secret',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_used_at: null,
      },
    ])
    const store = useHttpAuthStore()

    const credential = await store.findByUrl('https://files.example.com/private/file.zip')

    expect(credential?.username).toBe('demo')
    expect(mockDb.select).toHaveBeenCalledWith(expect.stringContaining('WHERE origin = $1'), [
      'https://files.example.com',
    ])
  })
})
