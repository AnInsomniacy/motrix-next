/**
 * @fileoverview Composable encapsulating AddTask submission logic.
 *
 * Extracted from AddTask.vue to make the complex branching testable:
 * - Options building (headers, proxy, user-agent, etc.)
 * - Batch submission routing (torrent vs metalink)
 * - Manual URI submission with multi-URI rename
 * - Error classification (engine-not-ready, duplicate, generic)
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '@/stores/app'
import { useTaskStore } from '@/stores/task'
import { usePreferenceStore } from '@/stores/preference'
import { useAppMessage } from '@/composables/useAppMessage'
import { useAppNotification } from '@/composables/useAppNotification'
import { isEngineReady } from '@/api/aria2'
import { normalizeUriLines } from '@shared/utils/batchHelpers'
import { buildOuts } from '@shared/utils/rename'
import { logger } from '@shared/logger'
import type { Aria2EngineOptions, BatchItem } from '@shared/types'

export interface AddTaskForm {
  uris: string
  out: string
  dir: string
  split: number
  userAgent: string
  authorization: string
  referer: string
  cookie: string
  allProxy: string
}

export interface UseAddTaskSubmitOptions {
  form: Ref<AddTaskForm>
  onClose: () => void
}

/**
 * Builds aria2 engine options from the add-task form.
 * Pure function — no side effects, fully testable.
 */
export function buildEngineOptions(form: AddTaskForm): Aria2EngineOptions {
  const options: Aria2EngineOptions = {
    dir: form.dir,
    split: String(form.split),
  }
  if (form.out) options.out = form.out
  if (form.userAgent) options['user-agent'] = form.userAgent
  if (form.referer) options.referer = form.referer

  const headers: string[] = []
  if (form.cookie) headers.push(`Cookie: ${form.cookie}`)
  if (form.authorization) headers.push(`Authorization: ${form.authorization}`)
  if (headers.length > 0) options.header = headers

  if (form.allProxy) options['all-proxy'] = form.allProxy
  return options
}

/**
 * Classifies an error from task submission into a user-friendly category.
 * Pure function — fully testable.
 */
export function classifySubmitError(err: unknown): 'engine-not-ready' | 'duplicate' | 'generic' {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('not initialized') || !isEngineReady()) return 'engine-not-ready'
  if (/duplicate|already/i.test(msg)) return 'duplicate'
  return 'generic'
}

/**
 * Submits file-based batch items (torrent/metalink) to the engine.
 * Mutates item.status in place; returns count of failures.
 */
export async function submitBatchItems(
  items: BatchItem[],
  options: Aria2EngineOptions,
  taskStore: ReturnType<typeof useTaskStore>,
): Promise<number> {
  let failures = 0
  for (const item of items) {
    if (item.kind === 'uri') continue
    if (item.status !== 'pending' && item.status !== 'failed') continue
    try {
      if (item.kind === 'torrent') {
        const opts: Aria2EngineOptions = { ...options }
        delete opts.out
        if (
          item.selectedFileIndices &&
          item.torrentMeta &&
          item.selectedFileIndices.length > 0 &&
          item.selectedFileIndices.length < item.torrentMeta.files.length
        ) {
          opts['select-file'] = item.selectedFileIndices.join(',')
        }
        await taskStore.addTorrent({ torrent: item.payload, options: opts })
      } else if (item.kind === 'metalink') {
        const opts: Aria2EngineOptions = { ...options }
        delete opts.out
        await taskStore.addMetalink({ metalink: item.payload, options: opts })
      }
      item.status = 'submitted'
    } catch (e) {
      item.status = 'failed'
      item.error = e instanceof Error ? e.message : String(e)
      failures++
    }
  }
  return failures
}

/**
 * Submits manually entered URIs from the textarea.
 * Handles multi-URI rename with buildOuts.
 */
export async function submitManualUris(
  form: AddTaskForm,
  options: Aria2EngineOptions,
  taskStore: ReturnType<typeof useTaskStore>,
): Promise<void> {
  if (!form.uris.trim()) return
  const uris = normalizeUriLines(form.uris)
  if (uris.length > 1 && form.out) {
    delete options.out
    let outs = buildOuts(uris, form.out)
    if (outs.length === 0) {
      const dotIdx = form.out.lastIndexOf('.')
      const base = dotIdx > 0 ? form.out.substring(0, dotIdx) : form.out
      const ext = dotIdx > 0 ? form.out.substring(dotIdx) : ''
      outs = uris.map((_, i) => `${base}_${i + 1}${ext}`)
    }
    await taskStore.addUri({ uris, outs, options })
  } else {
    await taskStore.addUri({ uris, outs: [], options })
  }
}

export function useAddTaskSubmit({ form, onClose }: UseAddTaskSubmitOptions) {
  const { t } = useI18n()
  const router = useRouter()
  const appStore = useAppStore()
  const taskStore = useTaskStore()
  const preferenceStore = usePreferenceStore()
  const message = useAppMessage()
  const { notifyError } = useAppNotification()
  const submitting = ref(false)

  async function handleSubmit() {
    if (submitting.value) return
    submitting.value = true

    try {
      const options = buildEngineOptions(form.value)
      const batch = appStore.pendingBatch

      if (batch.length > 0) {
        await submitBatchItems(batch, options, taskStore)
      }
      if (form.value.uris.trim()) {
        await submitManualUris(form.value, options, taskStore)
      }

      const failed = batch.filter((i) => i.status === 'failed')
      if (failed.length > 0) {
        message.warning(`${failed.length} ${t('task.failed') || 'failed'}`, { duration: 5000, closable: true })
      } else {
        message.success(t('task.add-task-success') || 'Task added successfully')
        onClose()
        if (preferenceStore.config.newTaskShowDownloading !== false) {
          router.push({ path: '/task/active' }).catch((e) => {
            logger.debug('AddTask.submit', 'navigation to /task/active failed', e)
          })
        }
      }
    } catch (e: unknown) {
      const category = classifySubmitError(e)
      const errMsg = e instanceof Error ? e.message : String(e)
      logger.error('AddTask.submit', e)
      if (category === 'engine-not-ready') {
        notifyError(e, 'engine')
      } else if (category === 'duplicate') {
        message.warning(errMsg, { duration: 5000, closable: true })
      } else {
        notifyError(e, 'task')
      }
    } finally {
      submitting.value = false
    }
  }

  return { submitting, handleSubmit }
}
