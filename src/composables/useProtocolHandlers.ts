import { computed, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'

export type ProtocolKey = 'magnet' | 'ed2k' | 'thunder' | 'motrixnext'
type ProtocolResult =
  | { kind: 'success' | 'unchanged' | 'manual' | 'cancelled' | 'query-failed' | 'ignored' }
  | { kind: 'failed'; reason: string }

const protocolKeys: ProtocolKey[] = ['magnet', 'ed2k', 'thunder', 'motrixnext']

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'Protocol' in error) return String(error.Protocol)
  return String(error)
}

export function useProtocolHandlers() {
  const status = ref<Record<ProtocolKey, boolean>>({ magnet: false, ed2k: false, thunder: false, motrixnext: false })
  const pending = ref<ProtocolKey | null>(null)
  const refreshing = ref(false)
  const busy = computed(() => refreshing.value || pending.value !== null)

  async function refreshProtocol(protocol: ProtocolKey): Promise<boolean> {
    const enabled = await invoke<boolean>('is_default_protocol_client', { protocol })
    status.value[protocol] = enabled
    return enabled
  }

  async function refreshAll(): Promise<void> {
    if (busy.value) return
    refreshing.value = true
    try {
      await Promise.all(
        protocolKeys.map(async (protocol) => {
          try {
            await refreshProtocol(protocol)
          } catch (error) {
            logger.debug('Protocol.refresh', { protocol, reason: errorReason(error) })
          }
        }),
      )
    } finally {
      refreshing.value = false
    }
  }

  async function setProtocolEnabled(protocol: ProtocolKey, enabled: boolean): Promise<ProtocolResult> {
    if (busy.value) return { kind: 'ignored' }
    pending.value = protocol
    try {
      let failure: string | undefined
      try {
        await invoke(enabled ? 'set_default_protocol_client' : 'remove_as_default_protocol_client', { protocol })
      } catch (error) {
        failure = errorReason(error)
        logger.debug('Protocol.change', 'operation returned an error', { protocol, enabled, reason: failure })
      }

      let actual: boolean
      try {
        actual = await refreshProtocol(protocol)
      } catch (error) {
        logger.warn('Protocol.verify', 'could not verify association', {
          protocol,
          enabled,
          reason: errorReason(error),
        })
        return { kind: failure === 'cancelled' ? 'cancelled' : 'query-failed' }
      }

      if (failure === 'cancelled') return { kind: 'cancelled' }
      if (actual === enabled) return { kind: 'success' }
      if (failure === 'manual_change_required') return { kind: 'manual' }
      if (failure !== undefined) {
        logger.warn('Protocol.change', 'association change failed', { protocol, enabled, actual, reason: failure })
        return { kind: 'failed', reason: failure }
      }
      logger.warn('Protocol.verify', 'association unchanged', { protocol, enabled, actual })
      return { kind: 'unchanged' }
    } finally {
      pending.value = null
    }
  }

  return {
    status: computed(() => status.value),
    pending: computed(() => pending.value),
    busy,
    refreshAll,
    setProtocolEnabled,
  }
}
