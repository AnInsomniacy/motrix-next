<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TASK_STATUS } from '@shared/constants'
import {
  checkTaskIsBT, checkTaskIsSeeder, getTaskName,
  bytesToSize, calcProgress, calcRatio, getFileName, getFileExtension,
  localeDateTimeFormat, bitfieldToPercent, peerIdParser, timeRemaining, timeFormat
} from '@shared/utils'
import {
  NDrawer, NDrawerContent, NDescriptions, NDescriptionsItem,
  NDataTable, NIcon, NProgress, NTag, NInput
} from 'naive-ui'
import {
  InformationCircleOutline, PulseOutline, DocumentOutline,
  PeopleOutline, ServerOutline
} from '@vicons/ionicons5'
import TaskItemActions from './TaskItemActions.vue'
import TaskGraphic from './TaskGraphic.vue'

const props = defineProps<{
  show: boolean
  task: Record<string, unknown> | null
  files: unknown[]
}>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const activeTab = ref('general')
const slideDirection = ref<'left' | 'right'>('left')
const prevTabIndex = ref(0)

interface TabDef { key: string; icon: typeof InformationCircleOutline; btOnly?: boolean }
const allTabs: TabDef[] = [
  { key: 'general', icon: InformationCircleOutline },
  { key: 'activity', icon: PulseOutline },
  { key: 'files', icon: DocumentOutline },
  { key: 'peers', icon: PeopleOutline, btOnly: true },
  { key: 'trackers', icon: ServerOutline, btOnly: true },
]

const visibleTabs = computed(() =>
  allTabs.filter(tab => !tab.btOnly || isBT.value)
)

function switchTab(key: string) {
  const oldIdx = visibleTabs.value.findIndex(t => t.key === activeTab.value)
  const newIdx = visibleTabs.value.findIndex(t => t.key === key)
  slideDirection.value = newIdx > oldIdx ? 'left' : 'right'
  prevTabIndex.value = newIdx
  activeTab.value = key
}

const isBT = computed(() => props.task ? checkTaskIsBT(props.task as never) : false)
const isSeeder = computed(() => props.task ? checkTaskIsSeeder(props.task as never) : false)
const taskStatus = computed(() => isSeeder.value ? TASK_STATUS.SEEDING : (props.task?.status as string))
const isActive = computed(() => props.task?.status === TASK_STATUS.ACTIVE)
const taskFullName = computed(() =>
  props.task ? getTaskName(props.task as never, { defaultName: 'Unknown', maxLen: -1 }) : ''
)
const percent = computed(() =>
  props.task ? calcProgress(props.task.totalLength as number, props.task.completedLength as number) : 0
)

const remaining = computed(() => {
  if (!isActive.value || !props.task) return 0
  return timeRemaining(
    Number(props.task.totalLength),
    Number(props.task.completedLength),
    Number(props.task.downloadSpeed)
  )
})

const remainingText = computed(() => {
  if (remaining.value <= 0) return ''
  return timeFormat(remaining.value, {
    prefix: t('task.remaining-prefix') || '',
    i18n: {
      gt1d: t('app.gt1d') || '>1d',
      hour: t('app.hour') || 'h',
      minute: t('app.minute') || 'm',
      second: t('app.second') || 's'
    }
  })
})

const ratio = computed(() => {
  if (!isBT.value || !props.task) return 0
  return calcRatio(Number(props.task.totalLength), Number(props.task.uploadLength))
})

const btInfo = computed(() => {
  if (!isBT.value || !props.task) return null
  return props.task.bittorrent as Record<string, unknown> | undefined
})

const statusTagType = computed(() => {
  switch (taskStatus.value) {
    case 'active': return 'warning'
    case 'complete': return 'success'
    case 'error': return 'error'
    default: return 'default'
  }
})

const fileList = computed(() =>
  (props.files || []).map((item: unknown) => {
    const f = item as Record<string, unknown>
    const name = getFileName(f.path as string)
    return {
      idx: Number(f.index),
      name,
      extension: '.' + getFileExtension(name),
      length: Number(f.length),
      completedLength: Number(f.completedLength),
      percent: calcProgress(f.length as number, f.completedLength as number, 1),
      selected: f.selected === 'true',
    }
  })
)

const fileColumns = computed(() => [
  { title: '#', key: 'idx', width: 50 },
  { title: t('task.file-name') || 'Name', key: 'name', ellipsis: { tooltip: true } },
  { title: t('task.file-extension') || 'Ext', key: 'extension', width: 70 },
  { title: '%', key: 'percent', width: 60, align: 'right' as const },
  { title: '✓', key: 'completedLength', width: 90, align: 'right' as const, render: (row: Record<string, unknown>) => bytesToSize(String(row.completedLength)) },
  { title: t('task.file-size') || 'Size', key: 'length', width: 90, align: 'right' as const, render: (row: Record<string, unknown>) => bytesToSize(String(row.length)) },
])

const peers = computed(() => {
  if (!props.task || !isBT.value) return []
  const p = props.task.peers as Record<string, unknown>[] | undefined
  return (p || []).map((peer) => ({
    host: `${peer.ip}:${peer.port}`,
    client: peerIdParser(peer.peerId as string),
    percent: peer.bitfield ? bitfieldToPercent(peer.bitfield as string) + '%' : '-',
    uploadSpeed: bytesToSize(String(peer.uploadSpeed)) + '/s',
    downloadSpeed: bytesToSize(String(peer.downloadSpeed)) + '/s',
  }))
})

const peerColumns = [
  { title: 'Host', key: 'host', minWidth: 140 },
  { title: 'Client', key: 'client', minWidth: 120 },
  { title: '%', key: 'percent', width: 60, align: 'right' as const },
  { title: '↑', key: 'uploadSpeed', width: 100, align: 'right' as const },
  { title: '↓', key: 'downloadSpeed', width: 100, align: 'right' as const },
]

const announceList = computed(() => {
  if (!isBT.value || !btInfo.value) return ''
  const list = btInfo.value.announceList as string[][]
  if (!list) return ''
  return list.map((group) => (Array.isArray(group) ? group[0] : group)).join('\n')
})

function handleClose() {
  emit('close')
}
</script>

<template>
  <NDrawer
    :show="show"
    :width="'61.8%'"
    placement="right"
    :trap-focus="false"
    :block-scroll="false"
    @update:show="(v: boolean) => { if (!v) handleClose() }"
  >
    <NDrawerContent :title="t('task.task-detail-title') || 'Task Details'" closable @close="handleClose">
      <div class="detail-tabs">
        <button
          v-for="tab in visibleTabs"
          :key="tab.key"
          :class="['detail-tab', { active: activeTab === tab.key }]"
          @click="switchTab(tab.key)"
        >
          <NIcon :size="18"><component :is="tab.icon" /></NIcon>
        </button>
      </div>

      <div class="tab-content-wrapper">
        <Transition :name="`tab-slide-${slideDirection}`" mode="out-in">
          <div v-if="activeTab === 'general'" key="general" class="tab-content">
            <template v-if="task">
              <NDescriptions :column="1" label-placement="left" bordered size="small">
                <NDescriptionsItem :label="t('task.task-gid') || 'GID'">{{ task.gid }}</NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-name') || 'Name'">{{ taskFullName }}</NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-dir') || 'Directory'">{{ task.dir }}</NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-status') || 'Status'">
                  <NTag :type="statusTagType" size="small">{{ taskStatus }}</NTag>
                </NDescriptionsItem>
                <NDescriptionsItem
                  v-if="task.errorCode && task.errorCode !== '0'"
                  :label="t('task.task-error-info') || 'Error'"
                >
                  {{ task.errorCode }} {{ task.errorMessage }}
                </NDescriptionsItem>
              </NDescriptions>
              <template v-if="isBT && btInfo">
                <div class="section-divider">BitTorrent</div>
                <NDescriptions :column="1" label-placement="left" bordered size="small">
                  <NDescriptionsItem :label="t('task.task-info-hash') || 'Hash'">{{ task.infoHash }}</NDescriptionsItem>
                  <NDescriptionsItem :label="t('task.task-piece-length') || 'Piece Size'">{{ bytesToSize(String(task.pieceLength)) }}</NDescriptionsItem>
                  <NDescriptionsItem :label="t('task.task-num-pieces') || 'Pieces'">{{ task.numPieces }}</NDescriptionsItem>
                  <NDescriptionsItem
                    v-if="(btInfo as Record<string, unknown>)?.creationDate"
                    :label="t('task.task-bittorrent-creation-date') || 'Created'"
                  >
                    {{ localeDateTimeFormat(Number((btInfo as Record<string, unknown>).creationDate), 'en') }}
                  </NDescriptionsItem>
                  <NDescriptionsItem
                    v-if="(btInfo as Record<string, unknown>)?.comment"
                    :label="t('task.task-bittorrent-comment') || 'Comment'"
                  >
                    {{ (btInfo as Record<string, unknown>).comment }}
                  </NDescriptionsItem>
                </NDescriptions>
              </template>
            </template>
          </div>

          <div v-else-if="activeTab === 'activity'" key="activity" class="tab-content">
            <template v-if="task">
              <TaskGraphic v-if="task.bitfield" :bitfield="task.bitfield as string" />
              <NDescriptions :column="1" label-placement="left" bordered size="small">
                <NDescriptionsItem :label="t('task.task-progress-info') || 'Progress'">
                  <div class="progress-row">
                    <NProgress type="line" :percentage="percent" :height="10" :show-indicator="false" processing />
                    <span class="progress-pct">{{ percent }}%</span>
                  </div>
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-file-size') || 'Size'">
                  {{ bytesToSize(task.completedLength as string, 2) }}
                  <span v-if="Number(task.totalLength) > 0"> / {{ bytesToSize(task.totalLength as string, 2) }}</span>
                  <span v-if="remainingText" class="remaining-text">{{ remainingText }}</span>
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-download-speed') || 'DL Speed'">{{ bytesToSize(task.downloadSpeed as string) }}/s</NDescriptionsItem>
                <NDescriptionsItem v-if="isBT" :label="t('task.task-upload-speed') || 'UL Speed'">{{ bytesToSize(task.uploadSpeed as string) }}/s</NDescriptionsItem>
                <NDescriptionsItem v-if="isBT" :label="t('task.task-upload-length') || 'Uploaded'">{{ bytesToSize(task.uploadLength as string) }}</NDescriptionsItem>
                <NDescriptionsItem v-if="isBT" :label="t('task.task-ratio') || 'Ratio'">{{ ratio }}</NDescriptionsItem>
                <NDescriptionsItem v-if="isBT" :label="t('task.task-num-seeders') || 'Seeders'">{{ task.numSeeders }}</NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-connections') || 'Connections'">{{ task.connections }}</NDescriptionsItem>
              </NDescriptions>
            </template>
          </div>

          <div v-else-if="activeTab === 'files'" key="files" class="tab-content">
            <NDataTable
              :columns="fileColumns"
              :data="fileList"
              :row-key="(row: Record<string, unknown>) => row.idx as number"
              size="small"
              :bordered="true"
              :max-height="400"
              virtual-scroll
              striped
            />
          </div>

          <div v-else-if="activeTab === 'peers'" key="peers" class="tab-content">
            <NDataTable
              :columns="peerColumns"
              :data="peers"
              :row-key="(row: Record<string, unknown>) => row.host as string"
              size="small"
              :bordered="true"
              :max-height="400"
              striped
            />
          </div>

          <div v-else-if="activeTab === 'trackers'" key="trackers" class="tab-content">
            <NInput
              type="textarea"
              :value="announceList"
              readonly
              :autosize="{ minRows: 5, maxRows: 20 }"
              placeholder="No trackers"
            />
          </div>
        </Transition>
      </div>



    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.detail-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--panel-border, #3a3a3a);
  padding-bottom: 0;
  margin-bottom: 0;
}

.detail-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 36px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--task-action-color, #999);
  cursor: pointer;
  transition: all 0.2s ease;
}

.detail-tab:hover {
  color: var(--primary-color, #E0A422);
}

.detail-tab.active {
  color: var(--primary-color, #E0A422);
  border-bottom-color: var(--primary-color, #E0A422);
}

.tab-content-wrapper {
  overflow: hidden;
  position: relative;
}

.tab-content {
  padding: 16px 0;
}

.section-divider {
  margin: 20px 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--primary-color, #E0A422);
  letter-spacing: 0.5px;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.progress-pct {
  white-space: nowrap;
  font-size: 12px;
  color: #999;
  min-width: 45px;
  text-align: right;
}

.remaining-text {
  margin-left: 12px;
  color: #999;
  font-size: 12px;
}

.detail-footer {
  display: flex;
  justify-content: center;
}

.detail-footer :deep(.task-item-actions) {
  position: static;
  width: auto;
  height: auto;
  overflow: visible;
  direction: ltr;
  text-align: center;
}

.tab-slide-left-enter-active,
.tab-slide-left-leave-active,
.tab-slide-right-enter-active,
.tab-slide-right-leave-active {
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}

.tab-slide-left-enter-from {
  opacity: 0;
  transform: translateX(40px);
}
.tab-slide-left-leave-to {
  opacity: 0;
  transform: translateX(-40px);
}

.tab-slide-right-enter-from {
  opacity: 0;
  transform: translateX(-40px);
}
.tab-slide-right-leave-to {
  opacity: 0;
  transform: translateX(40px);
}
</style>
