<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NDataTable, NDescriptions, NDescriptionsItem } from 'naive-ui'
import type { PaginationProps } from 'naive-ui'
import type { Aria2Task } from '@shared/types'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import type { UriDetailSummary } from '@/composables/useTaskDetailSummary'
import { buildSourceDetailRows, sourceRowsSignature, type SourceDetailRow } from '@/composables/useTaskDetailRows'
import { nextFrame, renderDetailCopyableText } from './TaskDetailShared'

const props = defineProps<{
  task: Aria2Task | null
  summary: UriDetailSummary
  tooltip: string
  onCopy: (value: string, label: string) => void
}>()

const { t } = useI18n()
const rows = shallowRef<SourceDetailRow[]>([])
const loading = ref(false)
const hasLoaded = ref(false)
const loadedTaskGid = ref<string | null>(null)
let generation = 0

watch(
  () => sourceRowsSignature(props.task),
  async () => {
    const current = ++generation
    const taskGid = props.task?.gid ?? null
    if (loadedTaskGid.value !== taskGid) {
      rows.value = []
      hasLoaded.value = false
      loadedTaskGid.value = taskGid
    }
    if (!taskGid) {
      loading.value = false
      return
    }
    if (!hasLoaded.value) loading.value = true
    await nextFrame()
    if (current !== generation) return
    rows.value = buildSourceDetailRows(props.task)
    hasLoaded.value = true
    loading.value = false
  },
  { immediate: true },
)

function sourceStatusLabel(status: string): string {
  if (!status || status === '-') return '-'
  const key = `task.task-source-${status}`
  const translated = t(key)
  return translated === key ? status : translated
}

const pagination = computed<PaginationProps | false>(() =>
  rows.value.length > 24
    ? {
        pageSize: 24,
        showSizePicker: true,
        pageSizes: [12, 24, 48],
      }
    : false,
)

const columns = computed(() => [
  {
    title: t('task.file-index') || '#',
    key: 'fileIndex',
    width: calcColumnWidth({
      title: t('task.file-index') || '#',
      values: rows.value.map((row) => String(row.fileIndex)),
      sortable: true,
    }),
    align: 'center' as const,
    sorter: (a: SourceDetailRow, b: SourceDetailRow) => a.fileIndex - b.fileIndex,
  },
  {
    title: 'URL',
    key: 'uri',
    render: (row: SourceDetailRow) =>
      renderDetailCopyableText({ value: row.uri, label: 'URL', tooltip: props.tooltip, onCopy: props.onCopy }),
  },
  {
    title: t('task.task-source-status'),
    key: 'status',
    width: calcColumnWidth({
      title: t('task.task-source-status'),
      values: ['used', 'waiting', '-'].map(sourceStatusLabel),
    }),
    align: 'center' as const,
    render: (row: SourceDetailRow) => sourceStatusLabel(row.status),
  },
])
</script>

<template>
  <template v-if="task">
    <NDescriptions
      :column="1"
      label-placement="left"
      bordered
      size="small"
      :label-style="{ width: '1px', whiteSpace: 'nowrap' }"
    >
      <NDescriptionsItem :label="t('task.task-primary-uri')">
        <component
          :is="
            () =>
              renderDetailCopyableText({
                value: summary.primaryUri || '-',
                label: t('task.task-primary-uri'),
                tooltip,
                onCopy,
              })
          "
        />
      </NDescriptionsItem>
      <NDescriptionsItem :label="t('task.task-source-files')">
        {{ summary.selectedFileCount }} / {{ summary.fileCount }}
      </NDescriptionsItem>
      <NDescriptionsItem :label="t('task.task-source-mirrors')">
        {{ summary.mirrorCount }}
      </NDescriptionsItem>
      <NDescriptionsItem :label="t('task.task-source-unique')">
        {{ summary.uniqueSourceCount }}
      </NDescriptionsItem>
      <NDescriptionsItem :label="t('task.task-source-used')">
        {{ summary.usedMirrorCount }}
      </NDescriptionsItem>
      <NDescriptionsItem :label="t('task.task-source-waiting')">
        {{ summary.waitingMirrorCount }}
      </NDescriptionsItem>
    </NDescriptions>
    <div v-if="rows.length > 0 || loading" class="source-table">
      <NDataTable
        :columns="columns"
        :data="rows"
        :row-key="(row: SourceDetailRow) => row.key"
        :loading="loading"
        :pagination="pagination"
        size="small"
        :bordered="true"
        :max-height="320"
        striped
      />
    </div>
  </template>
</template>

<style scoped></style>
