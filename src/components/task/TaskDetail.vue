<script setup lang="ts">
/** @fileoverview Detailed task view with file list, peers, and BT info. */
import { ref, computed, watch, defineComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTaskElapsed } from '@/composables/useTaskElapsed'
import { logger } from '@shared/logger'
import {
  checkTaskIsBT,
  checkTaskIsSharing,
  getTaskSharingKind,
  getTaskDisplayName,
  bytesToSize,
  localeDateTimeFormat,
  isBtMetadataTask,
} from '@shared/utils'
import {
  NDrawer,
  NDrawerContent,
  NDescriptions,
  NDescriptionsItem,
  NIcon,
  NTag,
  NButton,
  NSwitch,
  NForm,
  NInput,
  NInputGroup,
  NFormItem,
  NCollapseTransition,
} from 'naive-ui'
import {
  InformationCircleOutline,
  PulseOutline,
  DocumentOutline,
  PeopleOutline,
  ServerOutline,
  SettingsOutline,
  SearchOutline,
} from '@vicons/ionicons5'
import { useTaskDetailOptions } from '@/composables/useTaskDetailOptions'
import {
  buildBtHealthSummary,
  buildEd2kDetailSummary,
  buildTaskDetailKind,
  buildTaskTransferSummary,
  buildUriDetailSummary,
} from '@/composables/useTaskDetailSummary'
import { usePreferenceStore } from '@/stores/preference'
import { useTaskStore } from '@/stores/task'
import { useHistoryStore } from '@/stores/history'
import { useAppMessage } from '@/composables/useAppMessage'
import { useSystemProxyDetect } from '@/composables/useSystemProxyDetect'
import { getAddedAt } from '@/composables/useTaskOrder'
import type { Aria2Task, Aria2File, UserAgentProfile } from '@shared/types'
import UserAgentPopover from '@/components/common/UserAgentPopover.vue'
import { renderDetailCopyableText } from './detail/TaskDetailShared'
import TaskDetailActivity from './detail/TaskDetailActivity.vue'
import TaskDetailFiles from './detail/TaskDetailFiles.vue'
import TaskDetailPeers from './detail/TaskDetailPeers.vue'
import TaskDetailSources from './detail/TaskDetailSources.vue'
import TaskDetailTrackers from './detail/TaskDetailTrackers.vue'

const props = defineProps<{
  show: boolean
  task: Aria2Task | null
  files: Aria2File[]
}>()
const emit = defineEmits<{ close: [] }>()

const { t, locale } = useI18n()
const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const historyStore = useHistoryStore()
const message = useAppMessage()
const taskRef = computed(() => props.task)
const taskPrimaryUrl = computed(() => props.task?.files?.[0]?.uris?.[0]?.uri ?? '')
const taskAddedAtIso = computed(() => (props.task ? (getAddedAt(props.task.gid) ?? '') : ''))
const taskCompletedAtIso = ref('')
const { elapsedText } = useTaskElapsed(taskRef, t, {
  addedAt: taskAddedAtIso,
  completedAt: taskCompletedAtIso,
})

const {
  form: optForm,
  canModify: optCanModify,
  dirty: optDirty,
  applying: optApplying,
  applyOptions: optApplyFn,
} = useTaskDetailOptions({
  task: taskRef,
  getTaskOption: (gid) => taskStore.getTaskOption(gid),
  changeTaskOption: (payload) => taskStore.changeTaskOption(payload),
  proxyConfig: () => preferenceStore.config.proxy,
  message,
  t,
})

const { detecting: detectingProxy, detect: detectProxy } = useSystemProxyDetect({
  onSuccess(info) {
    optForm.customProxy = info.server
    optForm.proxyMode = 'manual'
    message.success(t('preferences.proxy-detected-success'))
  },
  onSocks() {
    message.warning(t('preferences.proxy-system-socks-rejected'))
  },
  onNotFound() {
    message.info(t('preferences.proxy-system-not-detected'))
  },
  onError() {
    message.error(t('preferences.proxy-system-detect-failed'))
  },
})

function selectTaskUserAgentProfile(profile: UserAgentProfile) {
  optForm.userAgent = profile.value
  preferenceStore.recordRecentUserAgentProfile(profile.id)
}

function copyLabel(label: string, fallback: string): string {
  return label || fallback
}

async function copyDetailValue(value: string | number | null | undefined, label: string) {
  const text = value === null || value === undefined ? '' : String(value)
  if (!text || text === '-') return
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('preferences.copied-to-clipboard', { label }))
  } catch (e) {
    logger.debug('TaskDetail.clipboard', `writeText failed: ${e}`)
  }
}

function renderCopyableValue(value: string | number, label: string) {
  return renderDetailCopyableText({
    value,
    label,
    tooltip: t('about.click-to-copy'),
    onCopy: copyDetailValue,
  })
}

const CopyableValue = defineComponent({
  name: 'CopyableValue',
  props: {
    value: {
      type: [String, Number],
      required: true,
    },
    label: {
      type: String,
      required: true,
    },
  },
  setup(componentProps) {
    return () => renderCopyableValue(componentProps.value, componentProps.label)
  },
})

const activeTab = ref('general')
const slideDirection = ref<'left' | 'right'>('left')
const prevTabIndex = ref(0)

interface TabDef {
  key: string
  labelKey: string
  icon: typeof InformationCircleOutline
  btOnly?: boolean
  protocolOnly?: boolean
  uriOnly?: boolean
}
const allTabs: TabDef[] = [
  { key: 'general', labelKey: 'task.task-tab-general', icon: InformationCircleOutline },
  { key: 'activity', labelKey: 'task.task-tab-activity', icon: PulseOutline },
  { key: 'files', labelKey: 'task.task-tab-files', icon: DocumentOutline },
  { key: 'options', labelKey: 'task.task-tab-options', icon: SettingsOutline },
  { key: 'sources', labelKey: 'task.task-tab-sources', icon: ServerOutline, uriOnly: true },
  { key: 'status', labelKey: 'task.task-tab-status', icon: PulseOutline, protocolOnly: true },
  { key: 'peers', labelKey: 'task.task-tab-peers', icon: PeopleOutline, btOnly: true },
  { key: 'trackers', labelKey: 'task.task-tab-trackers', icon: ServerOutline, btOnly: true },
]

const visibleTabs = computed(() =>
  allTabs.filter(
    (tab) =>
      (!tab.btOnly || isBT.value) && (!tab.protocolOnly || isBT.value || isED2K.value) && (!tab.uriOnly || isURI.value),
  ),
)

function switchTab(key: string) {
  const oldIdx = visibleTabs.value.findIndex((t) => t.key === activeTab.value)
  const newIdx = visibleTabs.value.findIndex((t) => t.key === key)
  slideDirection.value = newIdx > oldIdx ? 'left' : 'right'
  prevTabIndex.value = newIdx
  activeTab.value = key
}

const isBT = computed(() => (props.task ? checkTaskIsBT(props.task) : false))
const isED2K = computed(() => !!props.task?.ed2k)
const detailKind = computed(() => buildTaskDetailKind(props.task))
const isURI = computed(() => detailKind.value === 'uri')
const uriSummary = computed(() => buildUriDetailSummary(props.task))
const btHealth = computed(() => buildBtHealthSummary(props.task))
const ed2kSummary = computed(() => buildEd2kDetailSummary(props.task))
const transferSummary = computed(() => buildTaskTransferSummary(props.task))

const prevTaskGid = ref('')
watch(
  () => props.task?.gid,
  (gid) => {
    if (gid && gid !== prevTaskGid.value) {
      activeTab.value = 'general'
      prevTaskGid.value = gid
    }
  },
)

watch(visibleTabs, (tabs) => {
  if (!tabs.some((tab) => tab.key === activeTab.value)) {
    activeTab.value = 'general'
    prevTabIndex.value = 0
  }
})
const sharingKind = computed(() => (props.task ? getTaskSharingKind(props.task) : null))
const isSharing = computed(() => (props.task ? checkTaskIsSharing(props.task) : false))
const isMetadataFetching = computed(() => (props.task ? isBtMetadataTask(props.task) : false))
const taskStatusKey = computed(() =>
  isSharing.value
    ? sharingKind.value === 'bt'
      ? 'seeding'
      : 'sharing'
    : isMetadataFetching.value
      ? 'bt-metadata-fetching'
      : props.task?.status,
)
const taskStatus = computed(() => {
  const key = taskStatusKey.value
  const labelKey = key === 'seeding' || key === 'sharing' ? `task.${key}` : `task.status-${key}`
  const translated = t(labelKey)
  return translated !== labelKey ? translated : key
})
const taskFullName = computed(() => (props.task ? getTaskDisplayName(props.task, { defaultName: 'Unknown' }) : ''))

// ── Task date display ────────────────────────────────────────────────
const taskAddedAt = computed(() => {
  if (!props.task) return ''
  const iso = getAddedAt(props.task.gid)
  if (!iso) return ''
  return localeDateTimeFormat(new Date(iso).getTime(), locale.value)
})

const taskCompletedAt = ref('')
watch(
  () => props.task?.gid,
  async (gid) => {
    if (!gid) {
      taskCompletedAt.value = ''
      taskCompletedAtIso.value = ''
      return
    }
    try {
      const record = await historyStore.getRecordByGid(gid)
      if (record?.completed_at) {
        taskCompletedAt.value = localeDateTimeFormat(new Date(record.completed_at).getTime(), locale.value)
        taskCompletedAtIso.value = record.completed_at
      } else {
        taskCompletedAt.value = ''
        taskCompletedAtIso.value = ''
      }
    } catch (e) {
      logger.debug('TaskDetail.completedAt', `gid=${gid} query failed: ${e}`)
      taskCompletedAt.value = ''
      taskCompletedAtIso.value = ''
    }
  },
  { immediate: true },
)
const btInfo = computed(() => {
  if (!isBT.value || !props.task) return null
  return props.task.bittorrent ?? null
})

const ed2kInfo = computed(() => {
  if (!isED2K.value || !props.task) return null
  return props.task.ed2k
})

function yesNo(value?: boolean | string): string {
  if (value === undefined || value === '') return '-'
  const normalized = typeof value === 'boolean' ? value : value === 'true'
  return normalized ? t('task.task-ed2k-yes') : t('task.task-ed2k-no')
}

const statusTagType = computed(() => {
  switch (taskStatusKey.value) {
    case 'active':
      return 'warning'
    case 'complete':
      return 'success'
    case 'error':
      return 'error'
    default:
      return 'default'
  }
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
    @update:show="
      (v: boolean) => {
        if (!v) handleClose()
      }
    "
  >
    <NDrawerContent :title="t('task.task-detail-title') || 'Task Details'" closable @close="handleClose">
      <div class="detail-tabs">
        <button
          v-for="tab in visibleTabs"
          :key="tab.key"
          :class="['detail-tab', { active: activeTab === tab.key }]"
          @click="switchTab(tab.key)"
        >
          <NIcon :size="16"><component :is="tab.icon" /></NIcon>
          <span class="detail-tab-label">{{ t(tab.labelKey) }}</span>
        </button>
      </div>

      <div class="tab-content-wrapper">
        <Transition :name="`tab-slide-${slideDirection}`" mode="out-in">
          <div v-if="activeTab === 'general'" key="general" class="tab-content">
            <template v-if="task">
              <NDescriptions
                :column="1"
                label-placement="left"
                bordered
                size="small"
                :label-style="{ width: '1px', whiteSpace: 'nowrap' }"
              >
                <NDescriptionsItem :label="t('task.task-gid') || 'GID'">
                  <CopyableValue :value="task.gid" :label="copyLabel(t('task.task-gid'), 'GID')" />
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-name') || 'Name'">
                  <CopyableValue :value="taskFullName" :label="copyLabel(t('task.task-name'), 'Name')" />
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-dir') || 'Directory'">
                  <CopyableValue :value="task.dir" :label="copyLabel(t('task.task-dir'), 'Directory')" />
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-status') || 'Status'">
                  <NTag :type="statusTagType" size="small">{{ taskStatus }}</NTag>
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-type') || 'Type'">
                  {{ t(`task.task-type-${detailKind}`) }}
                </NDescriptionsItem>
                <NDescriptionsItem
                  v-if="task.errorCode && task.errorCode !== '0'"
                  :label="t('task.task-error-info') || 'Error'"
                >
                  {{ task.errorCode }} {{ task.errorMessage }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="taskAddedAt" :label="t('task.task-added-at') || 'Added At'">
                  {{ taskAddedAt }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="taskCompletedAt" :label="t('task.task-completed-at') || 'Completed At'">
                  {{ taskCompletedAt }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="elapsedText" :label="t('task.task-elapsed') || 'Elapsed'">
                  {{ elapsedText }}
                </NDescriptionsItem>
              </NDescriptions>
              <template v-if="isBT && btInfo">
                <div class="section-divider">BitTorrent</div>
                <NDescriptions
                  :column="1"
                  label-placement="left"
                  bordered
                  size="small"
                  :label-style="{ width: '1px', whiteSpace: 'nowrap' }"
                >
                  <NDescriptionsItem :label="t('task.task-info-hash') || 'Hash'">
                    <CopyableValue :value="task.infoHash || '-'" :label="copyLabel(t('task.task-info-hash'), 'Hash')" />
                  </NDescriptionsItem>
                  <NDescriptionsItem :label="t('task.task-piece-length') || 'Piece Size'">
                    {{ bytesToSize(String(task.pieceLength)) }}
                  </NDescriptionsItem>
                  <NDescriptionsItem :label="t('task.task-num-pieces') || 'Pieces'">
                    {{ task.numPieces }}
                  </NDescriptionsItem>
                  <NDescriptionsItem
                    v-if="btInfo?.creationDate"
                    :label="t('task.task-bittorrent-creation-date') || 'Created'"
                  >
                    {{ localeDateTimeFormat(Number(btInfo.creationDate), locale) }}
                  </NDescriptionsItem>
                  <NDescriptionsItem v-if="btInfo?.comment" :label="t('task.task-bittorrent-comment') || 'Comment'">
                    {{ btInfo.comment }}
                  </NDescriptionsItem>
                </NDescriptions>
              </template>
              <template v-if="isED2K && ed2kInfo">
                <div class="section-divider">ED2K</div>
                <NDescriptions
                  :column="1"
                  label-placement="left"
                  bordered
                  size="small"
                  :label-style="{ width: '1px', whiteSpace: 'nowrap' }"
                >
                  <NDescriptionsItem :label="t('task.task-ed2k-hash')">
                    <CopyableValue :value="ed2kInfo.hash || '-'" :label="t('task.task-ed2k-hash')" />
                  </NDescriptionsItem>
                </NDescriptions>
              </template>
            </template>
          </div>

          <div v-else-if="activeTab === 'activity'" key="activity" class="tab-content">
            <TaskDetailActivity :task="task" :transfer-summary="transferSummary" />
          </div>

          <div v-else-if="activeTab === 'status' && isBT" key="bt-status" class="tab-content">
            <template v-if="task && isBT">
              <NDescriptions
                :column="1"
                label-placement="left"
                bordered
                size="small"
                :label-style="{ width: '1px', whiteSpace: 'nowrap' }"
              >
                <NDescriptionsItem :label="t('task.task-bt-metadata-state')">
                  {{ t(`task.task-bt-metadata-${btHealth.metadataState}`) }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-bt-has-metadata')">
                  {{ yesNo(btHealth.hasMetadata) }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-bt-selected-files')">
                  {{ btHealth.selectedFileCount }} / {{ btHealth.totalFileCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-bt-selected-size')">
                  {{ bytesToSize(btHealth.selectedLength) }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-bt-trackers')">
                  {{ btHealth.trackerCount }}
                  <span v-if="btHealth.unprobeableTrackerCount > 0" class="muted-inline">
                    · {{ btHealth.unprobeableTrackerCount }} {{ t('task.task-tracker-not-probed') }}
                  </span>
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-bt-peers')">
                  {{ btHealth.peerCount }}
                  <span v-if="btHealth.seederPeerCount > 0" class="muted-inline">
                    · {{ btHealth.seederPeerCount }} {{ t('task.task-peer-seeder') }}
                  </span>
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-bt-active-peers')">
                  {{ t('task.task-peer-download-speed') }} {{ btHealth.activeDownloadPeerCount }} /
                  {{ t('task.task-peer-upload-speed') }} {{ btHealth.activeUploadPeerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-bt-choking')">
                  {{ t('task.task-bt-am-choking') }} {{ btHealth.amChokingCount }} /
                  {{ t('task.task-bt-peer-choking') }} {{ btHealth.peerChokingCount }}
                </NDescriptionsItem>
              </NDescriptions>
            </template>
          </div>

          <div v-else-if="activeTab === 'files'" key="files" class="tab-content">
            <TaskDetailFiles :files="files" :tooltip="t('about.click-to-copy')" :on-copy="copyDetailValue" />
          </div>

          <div v-else-if="activeTab === 'sources'" key="sources" class="tab-content">
            <TaskDetailSources
              v-if="task && isURI"
              :task="task"
              :summary="uriSummary"
              :tooltip="t('about.click-to-copy')"
              :on-copy="copyDetailValue"
            />
          </div>

          <div v-else-if="activeTab === 'options'" key="options" class="tab-content">
            <NForm label-placement="left" label-width="110px" class="options-form">
              <NFormItem :label="t('task.task-user-agent') + ':'">
                <NInputGroup class="detail-ua-row">
                  <NInput
                    v-model:value="optForm.userAgent"
                    type="textarea"
                    :autosize="{ minRows: 1, maxRows: 3 }"
                    :readonly="!optCanModify"
                    :placeholder="t('task.task-user-agent-placeholder') || ''"
                  />
                  <UserAgentPopover
                    :url="taskPrimaryUrl"
                    :profiles="preferenceStore.config.userAgentProfiles"
                    :rules="preferenceStore.config.userAgentRules"
                    :recent-profile-ids="preferenceStore.config.recentUserAgentProfileIds"
                    :disabled="!optCanModify"
                    @select="selectTaskUserAgentProfile"
                  />
                </NInputGroup>
              </NFormItem>
              <NFormItem :label="t('task.task-authorization') + ':'">
                <NInput
                  v-model:value="optForm.authorization"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  :readonly="!optCanModify"
                  :placeholder="t('task.task-authorization-placeholder') || ''"
                />
              </NFormItem>
              <NFormItem :label="t('task.task-http-auth') + ':'">
                <div class="http-auth-fields">
                  <NInput
                    v-model:value="optForm.httpAuthUsername"
                    :readonly="!optCanModify"
                    :placeholder="t('task.task-http-auth-username-placeholder') || ''"
                  />
                  <NInput
                    v-model:value="optForm.httpAuthPassword"
                    type="password"
                    show-password-on="click"
                    :readonly="!optCanModify"
                    :placeholder="t('task.task-http-auth-password-placeholder') || ''"
                  />
                </div>
              </NFormItem>
              <NFormItem :label="t('task.task-referer') + ':'">
                <NInput
                  v-model:value="optForm.referer"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  :readonly="!optCanModify"
                  :placeholder="t('task.task-referer-placeholder') || ''"
                />
              </NFormItem>
              <NFormItem :label="t('task.task-cookie') + ':'">
                <NInput
                  v-model:value="optForm.cookie"
                  type="textarea"
                  :autosize="{ minRows: 1, maxRows: 3 }"
                  :readonly="!optCanModify"
                  :placeholder="t('task.task-cookie-placeholder') || ''"
                />
              </NFormItem>
              <NFormItem :label="t('task.use-proxy') + ':'">
                <NSwitch
                  :value="optForm.proxyMode === 'manual'"
                  :disabled="!optCanModify"
                  @update:value="optForm.proxyMode = $event ? 'manual' : 'direct'"
                />
              </NFormItem>
              <NFormItem label=" " :show-feedback="false" class="proxy-options-item">
                <NCollapseTransition :show="optForm.proxyMode === 'manual'">
                  <div class="proxy-radio-group">
                    <div class="custom-proxy-input">
                      <NInput
                        v-model:value="optForm.customProxy"
                        :readonly="!optCanModify"
                        :placeholder="'http://host:port'"
                      />
                      <NInput
                        v-model:value="optForm.customProxyUsername"
                        :readonly="!optCanModify"
                        :placeholder="t('preferences.proxy-username') || ''"
                      />
                      <NInput
                        v-model:value="optForm.customProxyPassword"
                        type="password"
                        show-password-on="click"
                        :readonly="!optCanModify"
                        :placeholder="t('preferences.proxy-password') || ''"
                      />
                      <NButton :loading="detectingProxy" :disabled="!optCanModify" size="small" @click="detectProxy">
                        <template #icon>
                          <NIcon><SearchOutline /></NIcon>
                        </template>
                        {{ t('preferences.detect-system-proxy') }}
                      </NButton>
                    </div>
                  </div>
                </NCollapseTransition>
              </NFormItem>
              <div v-if="optCanModify" class="options-apply-bar">
                <NButton
                  :type="optDirty ? 'primary' : 'default'"
                  :disabled="!optDirty"
                  :loading="optApplying"
                  class="apply-btn"
                  @click="optApplyFn"
                >
                  {{ optDirty ? t('task.apply-changes') : t('task.no-changes') }}
                </NButton>
              </div>
            </NForm>
          </div>

          <div v-else-if="activeTab === 'status' && isED2K" key="ed2k-status" class="tab-content">
            <template v-if="ed2kInfo">
              <NDescriptions
                :column="1"
                label-placement="left"
                bordered
                size="small"
                :label-style="{ width: '1px', whiteSpace: 'nowrap' }"
              >
                <NDescriptionsItem :label="t('task.task-ed2k-hash')">
                  <CopyableValue :value="ed2kInfo.hash || '-'" :label="t('task.task-ed2k-hash')" />
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-name')">
                  <CopyableValue :value="ed2kInfo.name || taskFullName" :label="t('task.task-name')" />
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-file-size')">
                  {{ ed2kInfo.length ? bytesToSize(ed2kInfo.length) : bytesToSize(task?.totalLength || '0') }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-part-hash-count')">
                  {{ ed2kInfo.partHashCount || 0 }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-aich-root')">
                  <CopyableValue :value="ed2kInfo.aichRoot || '-'" :label="t('task.task-ed2k-aich-root')" />
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-server-count')">
                  {{ ed2kSummary.connectedServerCount }} / {{ ed2kSummary.serverCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-peer-count')">
                  {{ ed2kSummary.peerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-queued-peer-count')">
                  {{ ed2kSummary.queuedPeerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-accepted-peer-count')">
                  {{ ed2kSummary.acceptedPeerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-dead-peer-count')">
                  {{ ed2kSummary.deadPeerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-low-id-peer-count')">
                  {{ ed2kSummary.lowIdPeerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-callback-waiting-peer-count')">
                  {{ ed2kSummary.callbackWaitingPeerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-kad-node-count')">
                  {{ ed2kSummary.kadNodeCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-kad-router-count')">
                  {{ ed2kSummary.kadRouterCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-kad-firewalled')">
                  {{ yesNo(ed2kSummary.kadFirewalled) }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-kad-observed-address-count')">
                  {{ ed2kInfo.kadObservedAddressCount || 0 }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="ed2kSummary.hasSearchState" :label="t('task.task-ed2k-search-active')">
                  {{ yesNo(ed2kInfo.searchActive) }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="ed2kSummary.hasSearchState" :label="t('task.task-ed2k-search-more-results')">
                  {{ yesNo(ed2kInfo.searchMoreResults) }}
                </NDescriptionsItem>
                <NDescriptionsItem v-if="ed2kSummary.hasSearchState" :label="t('task.task-ed2k-search-result-count')">
                  {{ ed2kInfo.searchResultCount || 0 }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-uploading-peer-count')">
                  {{ ed2kSummary.uploadingPeerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-waiting-upload-peer-count')">
                  {{ ed2kSummary.waitingUploadPeerCount }}
                </NDescriptionsItem>
                <NDescriptionsItem :label="t('task.task-ed2k-peer-credit-count')">
                  {{ ed2kInfo.peerCreditCount || 0 }}
                </NDescriptionsItem>
              </NDescriptions>
            </template>
          </div>

          <div v-else-if="activeTab === 'peers'" key="peers" class="tab-content">
            <TaskDetailPeers
              :peers="task?.peers"
              :locale="locale"
              :tooltip="t('about.click-to-copy')"
              :on-copy="copyDetailValue"
            />
          </div>

          <div v-else-if="activeTab === 'trackers'" key="trackers" class="tab-content">
            <TaskDetailTrackers :bt-info="btInfo" :tooltip="t('about.click-to-copy')" :on-copy="copyDetailValue" />
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
  gap: 5px;
  padding: 0 12px;
  height: 36px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--task-action-color, #999);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.detail-tab:hover {
  color: var(--color-primary);
}

.detail-tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.tab-content-wrapper {
  overflow: hidden;
  position: relative;
}

.tab-content {
  padding: 16px 0;
}

:deep(.detail-copyable-value) {
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  max-width: 100%;
  min-width: 0;
  vertical-align: middle;
}

:deep(.detail-long-text),
:deep(.detail-copyable-text) {
  min-width: 0;
  max-width: 100%;
  line-height: 1.45;
}

:deep(.detail-copy-button) {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  opacity: 0.58;
  transition:
    opacity 0.16s cubic-bezier(0.2, 0, 0, 1),
    color 0.16s cubic-bezier(0.2, 0, 0, 1);
}

:deep(.detail-copy-button:hover) {
  opacity: 1;
  color: var(--color-primary);
}

.section-divider {
  margin: 20px 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-primary);
  letter-spacing: 0.5px;
}

:deep(.progress-row) {
  display: flex;
  align-items: center;
  gap: 12px;
}

:deep(.progress-pct) {
  white-space: nowrap;
  font-size: 12px;
  color: var(--m3-on-surface-variant);
  min-width: 45px;
  text-align: right;
}

:deep(.remaining-text) {
  margin-left: 12px;
  color: var(--m3-on-surface-variant);
  font-size: 12px;
}
.muted-inline {
  color: var(--m3-on-surface-variant);
  font-size: inherit;
  line-height: inherit;
  vertical-align: baseline;
}
:deep(.source-table) {
  margin-top: 12px;
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
  transition: all 0.2s cubic-bezier(0.2, 0, 0, 1);
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

/* Probe button M3 transition */
:deep(.probe-btn) {
  transition:
    background-color 0.3s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.3s cubic-bezier(0.2, 0, 0, 1),
    color 0.3s cubic-bezier(0.2, 0, 0, 1);
}

/* Spinning indicator matching Naive UI's loading style */
:deep(.probe-spinner) {
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: m3-spin 0.8s linear infinite;
  will-change: transform;
  contain: layout style paint;
}

@keyframes m3-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── Options tab ─────────────────────────────────────────────────── */
.options-form {
  padding: 4px 0;
}
.detail-ua-row {
  display: flex;
  align-items: stretch;
  width: 100%;
}
.detail-ua-row :deep(.n-input) {
  flex: 1;
}
.options-apply-bar {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
}
.apply-btn {
  transition:
    background-color 0.25s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.25s cubic-bezier(0.2, 0, 0, 1),
    color 0.25s cubic-bezier(0.2, 0, 0, 1),
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.proxy-radio-group {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.custom-proxy-input {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.custom-proxy-input .n-button {
  align-self: flex-start;
}
.http-auth-fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
/* Allow table header text to wrap instead of truncating with "…"
   when the column is too narrow for the translated label. */
:deep(.n-data-table-th__title) {
  white-space: normal;
  overflow-wrap: normal;
  word-break: break-all;
  hyphens: none;
}

:deep(.n-data-table-td) {
  vertical-align: top;
}
</style>
