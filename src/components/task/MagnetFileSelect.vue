<script setup lang="ts">
/** @fileoverview Modal dialog for selecting files from a magnet link's metadata.
 *
 * Displayed after aria2 downloads the metadata (info dict) for a magnet URI.
 * Uses NDataTable file selection pattern consistent with torrent upload in AddTask.
 */
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NModal, NCard, NButton, NSpace, NEllipsis } from 'naive-ui'
import type { MagnetSelectionSubmission } from '@/composables/useMagnetFlow'
import type { BtFileSelectionItem } from '@shared/types'
import BtFileSelector from '@/components/task/BtFileSelector.vue'

const props = defineProps<{
  show: boolean
  files: BtFileSelectionItem[]
  taskName: string
  submission: MagnetSelectionSubmission
}>()

const emit = defineEmits<{
  confirm: [selectedIndices: number[]]
  dismiss: []
  afterLeave: []
}>()

const { t } = useI18n()

const checkedKeys = ref<number[]>([])

watch(
  () => props.files,
  (files) => {
    checkedKeys.value = files.map((f) => f.index)
  },
  { immediate: true },
)

const hasSelection = computed(() => checkedKeys.value.length > 0)
const submitting = computed(() => props.submission !== null)
const confirming = computed(() => props.submission === 'confirm')

function handleConfirm() {
  if (submitting.value) return
  emit('confirm', checkedKeys.value)
}

function handleDismiss() {
  if (submitting.value) return
  emit('dismiss')
}
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="false"
    :close-on-esc="!submitting"
    :auto-focus="false"
    transform-origin="center"
    :transition="{ name: 'fade-scale' }"
    @update:show="(v) => !v && handleDismiss()"
    @after-leave="emit('afterLeave')"
  >
    <NCard
      :title="t('task.select-files') || 'Select Files'"
      :bordered="false"
      :closable="!submitting"
      role="dialog"
      class="magnet-file-select-card"
      :style="{
        maxWidth: '640px',
        width: '85vw',
        margin: 'auto',
        height: '78vh',
        display: 'flex',
        flexDirection: 'column',
      }"
      :content-style="{ flex: '1', minHeight: '0', overflowY: 'auto', overflowX: 'hidden' }"
      :segmented="{ footer: true }"
      @close="handleDismiss"
    >
      <!-- Task name subtitle -->
      <div class="task-name-subtitle">
        <NEllipsis :line-clamp="1">{{ taskName }}</NEllipsis>
      </div>

      <BtFileSelector v-model:selected-indices="checkedKeys" :files="files" :max-height="360" />

      <template #footer>
        <NSpace justify="end" align="center">
          <NSpace>
            <NButton :disabled="submitting" @click="handleDismiss">
              {{ t('task.magnet-choose-later') || 'Choose Later' }}
            </NButton>
            <NButton
              type="primary"
              :loading="confirming"
              :disabled="submitting || !hasSelection"
              @click="handleConfirm"
            >
              {{ t('task.magnet-start-download') || 'Start Download' }}
            </NButton>
          </NSpace>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
/* Card dimensions are set via inline :style for consistency with AddTask. */

.task-name-subtitle {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--m3-on-surface-variant);
  line-height: 1.4;
}
</style>
