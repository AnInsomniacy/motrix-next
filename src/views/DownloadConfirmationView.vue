<script setup lang="ts">
/** @fileoverview Dedicated extension-download confirmation window. */
import { nextTick, onBeforeUnmount, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import AddTask from '@/components/task/AddTask.vue'
import { useAppStore } from '@/stores/app'
import { logger } from '@shared/logger'
import type { PendingExternalInputsPayload } from '@shared/types'

const appStore = useAppStore()
const confirmationWindow = getCurrentWindow()
let unlistenExternalInput: UnlistenFn | undefined

function routeExternalInputs(payload: PendingExternalInputsPayload): boolean {
  if (payload.inputs.length === 0) return false
  appStore.handleExternalInputs(payload.inputs)
  return true
}

async function showConfirmationWindow(): Promise<void> {
  await confirmationWindow.show()
  await confirmationWindow.setFocus()
}

async function closeConfirmationWindow(): Promise<void> {
  appStore.hideAddTaskDialog()
  await nextTick()
  await confirmationWindow.close()
}

onMounted(async () => {
  try {
    unlistenExternalInput = await listen<PendingExternalInputsPayload>('external-input-open', (event) => {
      if (!routeExternalInputs(event.payload)) return
      void showConfirmationWindow()
    })

    const pending = await invoke<PendingExternalInputsPayload>('take_pending_external_inputs')
    if (!routeExternalInputs(pending)) {
      await closeConfirmationWindow()
      return
    }

    await showConfirmationWindow()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    logger.error('DownloadConfirmation', reason)
    await closeConfirmationWindow()
  }
})

onBeforeUnmount(() => {
  unlistenExternalInput?.()
})
</script>

<template>
  <main class="download-confirmation-surface">
    <AddTask :show="appStore.addTaskVisible" :show-mask="false" @close="closeConfirmationWindow" />
  </main>
</template>

<style scoped>
.download-confirmation-surface {
  min-height: 100dvh;
}
</style>
