<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDataTable, NSelect } from 'naive-ui'
import { bytesToSize } from '@shared/utils'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import type { Aria2File, BtFilePriority } from '@shared/types'
import { buildFileDetailRows, type FileDetailRow } from '@/composables/useTaskDetailRows'
import { renderDetailCopyableText } from './TaskDetailShared'
import { changeOption } from '@/api/aria2'
import { useAppMessage } from '@/composables/useAppMessage'
import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'

const props = defineProps<{
  files: Aria2File[]
  tooltip: string
  onCopy: (value: string, label: string) => void
  gid?: string
  editable?: boolean
  terminal?: boolean
}>()

const { t } = useI18n()
const message = useAppMessage()
const priorityOverrides = ref<Record<number, BtFilePriority>>({})
const pendingPriority = ref<number | null>(null)
const rows = computed(() => buildFileDetailRows(props.files))
const priorityOptions = computed(() =>
  (['off', 'normal', 'high', 'top'] as const).map((value) => ({
    value,
    label: t(`task.file-priority-${value}`),
  })),
)

watch(
  () => props.gid,
  () => {
    priorityOverrides.value = {}
  },
)

async function updatePriority(row: FileDetailRow, priority: BtFilePriority) {
  if (!props.gid || !props.editable || pendingPriority.value !== null) return
  pendingPriority.value = row.idx
  try {
    await changeOption({ gid: props.gid, options: { 'bt-file-priority': `${row.idx}=${priority}` } })
    priorityOverrides.value = { ...priorityOverrides.value, [row.idx]: priority }
    message.success(t('task.options-applied'))
  } catch (error) {
    logger.warn('TaskDetail.files.priority', getErrorMessage(error))
    message.error(t('task.options-apply-failed'))
  } finally {
    pendingPriority.value = null
  }
}

const columns = computed(() => {
  const data = rows.value
  const result = [
    {
      title: t('task.file-index') || '#',
      key: 'idx',
      width: calcColumnWidth({
        title: t('task.file-index') || '#',
        values: data.map((row) => String(row.idx)),
        sortable: true,
      }),
      sorter: (a: FileDetailRow, b: FileDetailRow) => a.idx - b.idx,
    },
    {
      title: t('task.file-name') || 'Name',
      key: 'name',
      render: (row: FileDetailRow) =>
        renderDetailCopyableText({
          value: row.name,
          label: t('task.file-name'),
          tooltip: props.tooltip,
          onCopy: props.onCopy,
        }),
    },
    {
      title: t('task.file-extension') || 'Ext',
      key: 'extension',
      width: calcColumnWidth({
        title: t('task.file-extension') || 'Ext',
        values: data.map((row) => row.extension),
      }),
    },
    {
      title: t('task.task-peer-percent'),
      key: 'percent',
      width: calcColumnWidth({
        title: t('task.task-peer-percent'),
        values: data.map((row) => String(row.percent)),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: FileDetailRow, b: FileDetailRow) => a.percent - b.percent,
    },
    {
      title: t('task.file-completed'),
      key: 'completedLength',
      width: calcColumnWidth({
        title: t('task.file-completed'),
        values: data.map((row) => bytesToSize(String(row.completedLength))),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: FileDetailRow, b: FileDetailRow) => a.completedLength - b.completedLength,
      render: (row: FileDetailRow) => bytesToSize(String(row.completedLength)),
    },
    {
      title: t('task.file-priority'),
      key: 'priority',
      width: 128,
      render: (row: FileDetailRow) =>
        h(NSelect, {
          value: priorityOverrides.value[row.idx] ?? row.priority,
          options: priorityOptions.value,
          size: 'small',
          disabled: !props.editable || pendingPriority.value !== null,
          loading: pendingPriority.value === row.idx,
          'onUpdate:value': (value: BtFilePriority) => void updatePriority(row, value),
        }),
    },
    {
      title: t('task.file-size') || 'Size',
      key: 'length',
      width: calcColumnWidth({
        title: t('task.file-size') || 'Size',
        values: data.map((row) => bytesToSize(String(row.length))),
        sortable: true,
      }),
      align: 'right' as const,
      sorter: (a: FileDetailRow, b: FileDetailRow) => a.length - b.length,
      render: (row: FileDetailRow) => bytesToSize(String(row.length)),
    },
  ]
  return props.terminal ? result.filter((column) => column.key !== 'priority') : result
})
</script>

<template>
  <NDataTable
    :columns="columns"
    :data="rows"
    :row-key="(row: FileDetailRow) => row.idx"
    size="small"
    :bordered="true"
    :max-height="400"
    :virtual-scroll="true"
    :min-row-height="34"
    striped
  />
</template>
