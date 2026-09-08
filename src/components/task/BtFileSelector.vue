<script setup lang="ts">
/** @fileoverview Shared BitTorrent file selector for local torrents and magnets. */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDataTable } from 'naive-ui'
import type { DataTableColumns, DataTableRowKey } from 'naive-ui'
import { bytesToSize } from '@shared/utils'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import type { BtFileSelectionItem } from '@shared/types'

const props = withDefaults(
  defineProps<{
    files: BtFileSelectionItem[]
    selectedIndices: number[]
    maxHeight?: number
  }>(),
  { maxHeight: 240 },
)

const emit = defineEmits<{
  'update:selectedIndices': [indices: number[]]
}>()

const { t } = useI18n()
const countDirection = ref<'bt-value-up' | 'bt-value-down'>('bt-value-up')
const sizeDirection = ref<'bt-value-up' | 'bt-value-down'>('bt-value-up')

const columns = computed<DataTableColumns<BtFileSelectionItem>>(() => [
  { type: 'selection' },
  {
    title: t('task.file-index') || '#',
    key: 'index',
    width: calcColumnWidth({
      title: t('task.file-index') || '#',
      values: props.files.map((file) => String(file.index)),
    }),
  },
  {
    title: t('task.file-name') || 'File Name',
    key: 'path',
    ellipsis: { tooltip: true },
  },
  {
    title: t('task.file-size') || 'Size',
    key: 'length',
    width: calcColumnWidth({
      title: t('task.file-size') || 'Size',
      values: props.files.map((file) => bytesToSize(file.length)),
      sortable: true,
    }),
    sorter: (a, b) => a.length - b.length,
    render: (row) => bytesToSize(row.length),
  },
])

const selectedFiles = computed(() => {
  const selected = new Set(props.selectedIndices)
  return props.files.filter((file) => selected.has(file.index))
})
const selectedSize = computed(() => selectedFiles.value.reduce((sum, file) => sum + file.length, 0))

watch(
  () => props.selectedIndices.length,
  (current, previous) => {
    countDirection.value = current >= previous ? 'bt-value-up' : 'bt-value-down'
  },
)

watch(selectedSize, (current, previous) => {
  sizeDirection.value = current >= previous ? 'bt-value-up' : 'bt-value-down'
})

function updateSelection(keys: DataTableRowKey[]) {
  emit('update:selectedIndices', keys.map(Number).filter(Number.isFinite))
}
</script>

<template>
  <div class="bt-file-selector">
    <NDataTable
      :columns="columns"
      :data="files"
      :row-key="(row: BtFileSelectionItem) => row.index"
      :checked-row-keys="selectedIndices"
      :max-height="maxHeight"
      size="small"
      @update:checked-row-keys="updateSelection"
    />
    <div class="file-summary" aria-live="polite">
      <Transition :name="countDirection" mode="out-in">
        <span :key="selectedIndices.length" class="summary-value">
          {{ selectedIndices.length }}/{{ files.length }}
        </span>
      </Transition>
      <span class="summary-divider">—</span>
      <Transition :name="sizeDirection" mode="out-in">
        <span :key="bytesToSize(selectedSize)" class="summary-value">{{ bytesToSize(selectedSize) }}</span>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.bt-file-selector {
  display: grid;
  gap: 10px;
}

.file-summary {
  display: inline-flex;
  justify-self: end;
  align-items: baseline;
  gap: 6px;
  min-height: 20px;
  color: var(--m3-on-surface-variant);
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
}

.summary-value {
  color: var(--m3-on-surface);
  font-weight: 600;
}

.summary-divider {
  color: var(--m3-outline);
}
</style>

<style>
.bt-value-up-enter-active,
.bt-value-up-leave-active,
.bt-value-down-enter-active,
.bt-value-down-leave-active {
  transition:
    opacity 0.15s ease-out,
    transform 0.15s ease-out;
}

.bt-value-up-enter-from,
.bt-value-down-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.bt-value-up-leave-to,
.bt-value-down-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .bt-value-up-enter-active,
  .bt-value-up-leave-active,
  .bt-value-down-enter-active,
  .bt-value-down-leave-active {
    transition: none;
  }
}
</style>
