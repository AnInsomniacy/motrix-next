<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NCard, NDataTable, NInput, NModal, NSpace, NTag } from 'naive-ui'
import { getBtTrackers, replaceBtTrackers, replaceBtWebSeeds } from '@/api/aria2'
import { renderDetailCopyableText } from './TaskDetailShared'
import { calcColumnWidth } from '@shared/utils/calcColumnWidth'
import { logger } from '@shared/logger'
import type { Aria2BtTracker } from '@shared/types'
import { useAppMessage } from '@/composables/useAppMessage'
import { getErrorMessage } from '@shared/utils/errorMessage'

const props = defineProps<{
  gid: string
  tooltip: string
  onCopy: (value: string, label: string) => void
  webSeeds?: string[]
  editable?: boolean
}>()

const { t } = useI18n()
const message = useAppMessage()
const trackers = ref<Aria2BtTracker[]>([])
const editor = ref<'trackers' | 'web-seeds' | null>(null)
const editorValue = ref('')
const saving = ref(false)
const managedWebSeeds = ref<string[]>([])

const rows = computed(() =>
  trackers.value.map((tracker) => ({
    ...tracker,
    tierNumber: Number(tracker.tier) + 1,
    protocol: tracker.url.match(/^(\w+):\/\//)?.[1]?.toLowerCase() ?? 'unknown',
  })),
)

async function refreshTrackers() {
  if (!props.gid) {
    trackers.value = []
    return
  }
  try {
    trackers.value = await getBtTrackers({ gid: props.gid })
  } catch (error) {
    trackers.value = []
    logger.debug('TaskDetail.trackers', error)
  }
}

function openEditor(kind: 'trackers' | 'web-seeds') {
  if (!props.editable) return
  editor.value = kind
  editorValue.value =
    kind === 'trackers' ? trackers.value.map((tracker) => tracker.url).join('\n') : managedWebSeeds.value.join('\n')
}

async function saveEditor() {
  if (!editor.value) return
  const values = [
    ...new Set(
      editorValue.value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
  saving.value = true
  try {
    if (editor.value === 'trackers') {
      const currentTiers = new Map(trackers.value.map((tracker) => [tracker.url, Number(tracker.tier)]))
      await replaceBtTrackers({
        gid: props.gid,
        trackers: values.map((url) => ({ url, tier: currentTiers.get(url) ?? 0 })),
      })
      await refreshTrackers()
    } else {
      await replaceBtWebSeeds({ gid: props.gid, webSeeds: values })
      managedWebSeeds.value = values
    }
    editor.value = null
    message.success(t('task.options-applied'))
  } catch (error) {
    logger.warn('TaskDetail.trackers.edit', getErrorMessage(error))
    message.error(t('task.options-apply-failed'))
  } finally {
    saving.value = false
  }
}

const statusType = (status: string) =>
  status === 'working' ? 'success' : status === 'error' ? 'error' : status === 'updating' ? 'warning' : 'default'

const columns = computed(() => {
  const data = rows.value
  return [
    {
      title: t('task.task-tracker-tier'),
      key: 'tierNumber',
      width: calcColumnWidth({
        title: t('task.task-tracker-tier'),
        values: data.map((row) => String(row.tierNumber)),
        sortable: true,
      }),
      align: 'center' as const,
      sorter: (a: (typeof data)[number], b: (typeof data)[number]) => a.tierNumber - b.tierNumber,
    },
    {
      title: 'URL',
      key: 'url',
      render: (row: (typeof data)[number]) =>
        renderDetailCopyableText({ value: row.url, label: 'URL', tooltip: props.tooltip, onCopy: props.onCopy }),
    },
    {
      title: t('task.task-tracker-protocol'),
      key: 'protocol',
      width: calcColumnWidth({
        title: t('task.task-tracker-protocol'),
        values: data.map((row) => row.protocol),
        sortable: true,
      }),
      align: 'center' as const,
      sorter: 'default' as const,
    },
    {
      title: t('task.task-tracker-status'),
      key: 'status',
      width: calcColumnWidth({
        title: t('task.task-tracker-status'),
        values: data.map((row) => row.status),
        sortable: true,
        extraWidth: 20,
      }),
      align: 'center' as const,
      sorter: 'default' as const,
      render: (row: (typeof data)[number]) =>
        h(NTag, { type: statusType(row.status), size: 'small', round: true }, () =>
          t(`task.task-tracker-runtime-${row.status}`),
        ),
    },
  ]
})

watch(() => props.gid, refreshTrackers)
watch(
  () => props.webSeeds,
  (value) => {
    managedWebSeeds.value = [...(value ?? [])]
  },
  { immediate: true },
)
onMounted(refreshTrackers)
</script>

<template>
  <NSpace class="detail-action-row">
    <NButton size="small" :disabled="!editable" @click="openEditor('trackers')">
      {{ t('task.bt-trackers-edit') }}
    </NButton>
    <NButton size="small" :disabled="!editable" @click="openEditor('web-seeds')">
      {{ t('task.bt-web-seeds-manage') }}
    </NButton>
  </NSpace>
  <NDataTable
    :columns="columns"
    :data="rows"
    :row-key="(row) => row.url"
    size="small"
    :bordered="true"
    :max-height="400"
    :virtual-scroll="true"
    :min-row-height="34"
    striped
  />
  <NModal :show="editor !== null" @update:show="(show) => !show && (editor = null)">
    <NCard
      class="source-editor"
      :title="editor === 'trackers' ? t('task.bt-trackers-edit') : t('task.bt-web-seeds-manage')"
      :bordered="false"
      role="dialog"
    >
      <NInput
        v-model:value="editorValue"
        type="textarea"
        :autosize="{ minRows: 8, maxRows: 16 }"
        :placeholder="t('task.bt-source-one-per-line')"
      />
      <template #footer>
        <NSpace justify="end">
          <NButton @click="editor = null">{{ t('app.cancel') }}</NButton>
          <NButton type="primary" :loading="saving" @click="saveEditor">{{ t('app.save') }}</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.detail-action-row {
  margin-bottom: 12px;
}
.source-editor {
  width: min(680px, calc(100vw - 32px));
}
</style>
