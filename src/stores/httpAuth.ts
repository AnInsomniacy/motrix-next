/** Saved credentials are matched and persisted by the native database owner. */
import { defineStore } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { useDatabaseStore } from '@/stores/database'
import type { HttpAuthCredential, HttpAuthInput } from '@shared/types'

export const useHttpAuthStore = defineStore('httpAuth', () => {
  const database = useDatabaseStore()
  async function saveCredential(input: HttpAuthInput): Promise<void> {
    await database.init()
    await invoke('http_auth_save', { url: input.url, username: input.username, password: input.password })
  }
  async function findByUrl(url: string): Promise<HttpAuthCredential | null> {
    if (database.phase === 'failed' || database.phase === 'resetting') return null
    if (!/^https?:/i.test(url)) return null
    await database.init()
    return invoke<HttpAuthCredential | null>('http_auth_find', { url })
  }
  async function markUsed(id: number): Promise<void> {
    await database.init()
    await invoke('http_auth_mark_used', { id })
  }
  return { saveCredential, findByUrl, markUsed }
})
