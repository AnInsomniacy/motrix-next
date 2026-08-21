/**
 * @fileoverview Probes ffmpeg availability for the Advanced settings UI.
 *
 * Calls the Rust `hls_ffmpeg_status` command. Invoke failures degrade to
 * `{ kind: 'missing' }` so the preference page never surfaces an exception.
 */
import { ref, type Ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { logger } from '@shared/logger'

/** Mirrors Rust `FfmpegStatusDto`: kind is `configured` | `path` | `missing`. */
export interface HlsFfmpegStatus {
  kind: string
  path?: string
  version?: string
}

export interface UseHlsFfmpegStatusReturn {
  status: Ref<HlsFfmpegStatus | null>
  refresh: () => Promise<void>
}

/**
 * Reactive ffmpeg probe used by Advanced preferences.
 * `refresh()` never throws; a failed invoke is logged and treated as missing.
 */
export function useHlsFfmpegStatus(): UseHlsFfmpegStatusReturn {
  const status = ref<HlsFfmpegStatus | null>(null)

  async function refresh(): Promise<void> {
    try {
      status.value = await invoke<HlsFfmpegStatus>('hls_ffmpeg_status')
    } catch (e) {
      status.value = { kind: 'missing' }
      logger.warn('HlsFfmpegStatus', `hls_ffmpeg_status failed: ${e}`)
    }
  }

  return { status, refresh }
}
