import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { invoke } from '@tauri-apps/api/core'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { logger } from '@shared/logger'

/** One connection lifecycle for history and credentials, including recreated WebViews. */
export const useDatabaseStore = defineStore('database', () => {
  const phase = ref<'idle' | 'loading' | 'ready' | 'failed' | 'resetting'>('idle')
  const notified = ref(false)
  const isReady = computed(() => phase.value === 'ready')
  let initialization: Promise<void> | null = null
  let resetting: Promise<void> | null = null

  function init(): Promise<void> {
    if (phase.value === 'resetting') return Promise.reject(new Error('Database is resetting'))
    if (!initialization) {
      phase.value = 'loading'
      initialization = (async () => {
        await invoke('database_initialize')
        phase.value = 'ready'
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
        // Finish any in-flight opening before closing native storage.
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
