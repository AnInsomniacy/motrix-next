import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import Database from '@tauri-apps/plugin-sql'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { logger } from '@shared/logger'

const DATABASE = 'sqlite:history.db'

/** One connection lifecycle for history and credentials, including recreated WebViews. */
export const useDatabaseStore = defineStore('database', () => {
  const phase = ref<'idle' | 'loading' | 'ready' | 'failed' | 'resetting'>('idle')
  const notified = ref(false)
  const isReady = computed(() => phase.value === 'ready')
  let initialization: Promise<Database> | null = null
  let resetting: Promise<void> | null = null

  function init(): Promise<Database> {
    if (phase.value === 'resetting') return Promise.reject(new Error('Database is resetting'))
    if (!initialization) {
      phase.value = 'loading'
      initialization = (async () => {
        const ready = await invoke<boolean>('database_prepare')
        const connection = ready ? Database.get(DATABASE) : await Database.load(DATABASE)
        if (!ready) {
          await connection.execute('PRAGMA journal_mode = WAL', [])
          await connection.execute('PRAGMA synchronous = NORMAL', [])
          await connection.execute('PRAGMA busy_timeout = 5000', [])
          await connection.execute('PRAGMA foreign_keys = ON', [])
          await invoke('database_initialize')
        }
        phase.value = 'ready'
        return connection
      })().catch((error: unknown) => {
        phase.value = 'failed'
        logger.error('Database.initialize', getErrorMessage(error))
        throw error
      })
    }
    return initialization
  }

  function reset(): Promise<void> {
    if (!resetting) {
      resetting = (async () => {
        // Finish any in-flight opening before closing both connection owners.
        if (initialization) await initialization.catch(() => undefined)
        phase.value = 'resetting'
        await invoke('database_reset')
      })().catch((error: unknown) => {
        phase.value = 'failed'
        initialization = Promise.reject(error)
        void initialization.catch(() => undefined)
        resetting = null
        throw error
      })
    }
    return resetting
  }

  return { phase, notified, isReady, init, reset }
})
