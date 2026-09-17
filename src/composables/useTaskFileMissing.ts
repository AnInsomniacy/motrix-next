/** @fileoverview File-missing detection for stopped task cards. */
import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { TASK_STATUS } from '@shared/constants'
import { logger } from '@shared/logger'
import { resolveTaskFilePath, recheckTrigger } from '@/composables/useArchivedPaths'
import type { Aria2Task } from '@shared/types'

const FILE_CHECK_THROTTLE_MS = 120

export function useTaskFileMissing(task: ComputedRef<Aria2Task>) {
  const fileMissing = ref(false)
  let fileCheckTimer: ReturnType<typeof setTimeout> | null = null

  const fileCheckTargetPath = computed(() => {
    const status = task.value.status
    if (task.value.media && status !== TASK_STATUS.COMPLETE) return null
    if (status === TASK_STATUS.ACTIVE || status === TASK_STATUS.WAITING || status === TASK_STATUS.PAUSED) {
      return null
    }
    return resolveTaskFilePath(task.value)
  })

  async function checkFileExists(targetPath: string | null) {
    if (!targetPath) {
      fileMissing.value = false
      return
    }

    try {
      fileMissing.value = !(await invoke<boolean>('check_path_exists', { path: targetPath }))
    } catch (e) {
      logger.debug('TaskItem.fileCheck', e)
      fileMissing.value = false
    }
  }

  function scheduleFileExistsCheck(targetPath: string | null) {
    if (fileCheckTimer) {
      clearTimeout(fileCheckTimer)
      fileCheckTimer = null
    }

    if (!targetPath) {
      fileMissing.value = false
      return
    }

    fileCheckTimer = setTimeout(() => {
      fileCheckTimer = null
      void checkFileExists(targetPath)
    }, FILE_CHECK_THROTTLE_MS)
  }

  watch([fileCheckTargetPath, recheckTrigger], ([path]) => scheduleFileExistsCheck(path), { immediate: true })
  onBeforeUnmount(() => {
    if (fileCheckTimer) {
      clearTimeout(fileCheckTimer)
      fileCheckTimer = null
    }
  })

  return { fileMissing }
}
