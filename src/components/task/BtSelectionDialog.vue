<script setup lang="ts">
/** @fileoverview BitTorrent file selection using the existing native task. */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NCard, NSpace, NButton, NAlert, NSpin } from 'naive-ui'
import { useTaskStore } from '@/stores/task'
import { useBtSelection } from '@/composables/useBtSelection'
import { isPendingMagnetSelectionTask, parseFilesForSelection } from '@/composables/useMagnetFlow'
import { getTaskName } from '@shared/utils/task'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { logger } from '@shared/logger'
import type { Aria2Task, BtFileSelectionItem } from '@shared/types'
import BtFileSelector from './BtFileSelector.vue'

const props = defineProps<{ show: boolean; gid: string }>()
const emit = defineEmits<{ close: []; afterLeave: [] }>()
const { t } = useI18n()
const tasks = useTaskStore()
const { selectFiles } = useBtSelection()
const task = ref<Aria2Task | null>(null)
const files = ref<BtFileSelectionItem[]>([])
const indices = ref<number[]>([])
const loading = ref(false)
const submitting = ref(false)
const ready = ref(false)
const error = ref('')
const name = computed(() => (task.value ? getTaskName(task.value) : ''))
let generation = 0
async function load(gid: string) {
  const request = ++generation
  loading.value = true
  ready.value = false
  error.value = ''
  try {
    const current = await tasks.fetchTaskStatus(gid)
    if (request !== generation || !props.show) return
    if (!isPendingMagnetSelectionTask(current)) {
      emit('close')
      return
    }
    task.value = current
    const result = await tasks.getFiles(gid)
    if (request !== generation || !props.show) return
    files.value = parseFilesForSelection(result)
    if (!files.value.length) throw new Error('No torrent files are available')
    indices.value = files.value.map((file) => file.index)
    ready.value = true
  } catch (cause) {
    if (request === generation && props.show) error.value = getErrorMessage(cause)
    logger.warn('BtSelection.load', getErrorMessage(cause))
  } finally {
    if (request === generation) loading.value = false
  }
}
watch(
  () => [props.gid, props.show] as const,
  ([gid, visible]) => {
    generation++
    if (gid && visible) {
      task.value = null
      submitting.value = false
      void load(gid)
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  generation++
})
async function confirm() {
  if (!task.value || !ready.value || !indices.value.length || submitting.value) return
  const request = generation
  const gid = props.gid
  submitting.value = true
  error.value = ''
  try {
    const current = await tasks.fetchTaskStatus(gid)
    if (request !== generation || !props.show) return
    if (!isPendingMagnetSelectionTask(current)) {
      emit('close')
      return
    }
    await selectFiles(current, files.value, indices.value)
    if (request === generation) emit('close')
  } catch (cause) {
    if (request === generation) error.value = getErrorMessage(cause)
    logger.warn('BtSelection.confirm', getErrorMessage(cause))
  } finally {
    if (request === generation) submitting.value = false
  }
}
function dismiss() {
  if (!submitting.value) emit('close')
}
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="false"
    :close-on-esc="!submitting"
    transform-origin="center"
    @update:show="(value) => !value && dismiss()"
    @after-leave="emit('afterLeave')"
  >
    <NCard
      :title="t('task.select-files')"
      :bordered="false"
      :closable="!submitting"
      role="dialog"
      :aria-label="t('task.select-files')"
      aria-modal="true"
      class="selection-dialog"
      :content-style="{ overflowY: 'auto', minHeight: '0', flex: '1' }"
      :segmented="{ footer: true }"
      @close="dismiss"
    >
      <div class="selection-summary">
        <div class="selection-name" :title="name">{{ name || '' }}</div>
      </div>
      <NAlert v-if="error" type="error" class="selection-error">{{ error }}</NAlert>
      <Transition name="selection-content" mode="out-in">
        <div v-if="loading" key="loading" class="selection-loading" role="status" aria-busy="true">
          <NSpin size="small" /> {{ t('task.bt-metadata-fetching') }}
        </div>
        <div v-else-if="ready" key="files" :inert="submitting">
          <BtFileSelector v-model:selected-indices="indices" :files="files" :max-height="360" />
        </div>
      </Transition>
      <template #footer>
        <NSpace justify="end">
          <NButton :disabled="submitting" @click="dismiss">{{ t('task.magnet-choose-later') }}</NButton>
          <NButton v-if="error && !ready" :loading="loading" @click="load(gid)">{{ t('task.retry-task') }}</NButton>
          <NButton v-else type="primary" :loading="submitting" :disabled="!ready || !indices.length" @click="confirm">{{
            t('task.magnet-start-download')
          }}</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style src="@/styles/selection-dialog.css" scoped></style>
