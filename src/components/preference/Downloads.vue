<script setup lang="ts">
/** @fileoverview Downloads preference tab: paths, concurrency, speed limits, notifications, cleanup. */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { usePreferenceNumericValidation } from '@/composables/usePreferenceNumericValidation'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { extractSpeedUnit } from '@shared/utils'
import { logger } from '@shared/logger'
import { resolveUserVisibleDownloadDir } from '@shared/utils/userVisibleDirectory'
import { toggleSpeedLimit } from '@/composables/useSpeedLimiter'
import { changeGlobalOption, isEngineReady } from '@/api/aria2'
import { SCHEDULE_DAY } from '@shared/constants'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  buildDownloadsForm,
  buildDownloadsSystemConfig,
  getCompletedRecordRetentionSelectValue,
  recordDownloadsDirectory,
  resolveCompletedRecordRetentionDays,
  transformDownloadsForStore,
} from '@/composables/useDownloadsPreference'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NCheckbox,
  NButton,
  NDivider,
  NInputGroup,
  NText,
  NCollapseTransition,
  NIcon,
  NRadioButton,
  NRadioGroup,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import PreferenceCheckboxGrid from './PreferenceCheckboxGrid.vue'
import PreferenceHintLabel from './PreferenceHintLabel.vue'
import DirectoryPopover from '@/components/common/DirectoryPopover.vue'
import FileCategoryManager from './FileCategoryManager.vue'
import { FolderOpenOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()
const { constraint, configFieldProps, fieldProps, areConfigFieldsValid } = usePreferenceNumericValidation()
const defaultDownloadDir = ref('')

// ── File timestamp strategy ─────────────────────────────────────────
const FILE_TS_DOWNLOAD = 'download'
const FILE_TS_SERVER = 'server'
const fileTimestampOptions = computed(() => [
  { label: t('preferences.file-timestamp-download'), value: FILE_TS_DOWNLOAD },
  { label: t('preferences.file-timestamp-server'), value: FILE_TS_SERVER },
])
const fileTimestampValue = computed(() => (form.value.remoteTime ? FILE_TS_SERVER : FILE_TS_DOWNLOAD))
function handleFileTimestampChange(val: string) {
  form.value.remoteTime = val === FILE_TS_SERVER
}

const fileDeletionModeOptions = computed(() => [
  { label: t('preferences.file-deletion-mode-trash'), value: 'trash' },
  { label: t('preferences.file-deletion-mode-permanent'), value: 'permanent' },
])

const skipConfirmationFileLabel = computed(() =>
  t(
    form.value.fileDeletionMode === 'permanent'
      ? 'preferences.delete-files-when-skip-confirm-permanent'
      : 'preferences.delete-files-when-skip-confirm-trash',
  ),
)

function buildForm() {
  return buildDownloadsForm(preferenceStore.config, defaultDownloadDir.value)
}

const { form, isDirty, handleSave, handleReset, resetSnapshot, patchSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildDownloadsSystemConfig,
  transformForStore: transformDownloadsForStore,
  afterSave: (f) => {
    recordDownloadsDirectory(f, preferenceStore.recordHistoryDirectory)
  },
})

// ── Speed limit ─────────────────────────────────────────────────────
const uploadSpeedValue = ref(0)
const uploadUnit = ref('K')
const downloadSpeedValue = ref(0)
const downloadUnit = ref('K')
const speedUnitOptions = [
  { label: 'KB/s', value: 'K' },
  { label: 'MB/s', value: 'M' },
]

const timeOptions = (() => {
  const opts: Array<{ label: string; value: string }> = []
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const hh = String(h).padStart(2, '0')
      const mm = String(m).padStart(2, '0')
      opts.push({ label: `${hh}:${mm}`, value: `${hh}:${mm}` })
    }
  }
  return opts
})()

const scheduleDayOptions = computed(() => [
  { label: t('preferences.schedule-days-everyday'), value: SCHEDULE_DAY.EVERY_DAY },
  { label: t('preferences.schedule-days-weekdays'), value: SCHEDULE_DAY.WEEKDAYS },
  { label: t('preferences.schedule-days-weekends'), value: SCHEDULE_DAY.WEEKENDS },
])

const notificationTypeOptions = computed(() => [
  { label: t('preferences.notify-on-start'), value: 'start' },
  { label: t('preferences.notify-on-complete'), value: 'complete' },
])
const completedRecordRetentionOptions = computed(() => [
  { label: t('preferences.completed-record-retention-forever'), value: 0 },
  { label: t('preferences.completed-record-retention-1-day'), value: 1 },
  { label: t('preferences.completed-record-retention-1-week'), value: 7 },
  { label: t('preferences.completed-record-retention-6-months'), value: 180 },
  { label: t('preferences.completed-record-retention-1-year'), value: 365 },
  { label: t('preferences.completed-record-retention-custom'), value: -1 },
])
const completedRecordRetentionMode = ref(0)
const completedRecordRetentionSelectValue = computed<number>({
  get: () => completedRecordRetentionMode.value,
  set: (value) => {
    completedRecordRetentionMode.value = value
    form.value.completedRecordRetentionDays = resolveCompletedRecordRetentionDays(
      value,
      Number(form.value.completedRecordRetentionDays),
    )
  },
})
const selectedNotificationTypes = computed<string[]>({
  get: () => [...(form.value.notifyOnStart ? ['start'] : []), ...(form.value.notifyOnComplete ? ['complete'] : [])],
  set: (types) => {
    const selected = new Set(types)
    form.value.notifyOnStart = selected.has('start')
    form.value.notifyOnComplete = selected.has('complete')
  },
})
const numericFieldsValid = computed(
  () =>
    areConfigFieldsValid({
      maxConcurrentDownloads: form.value.maxConcurrentDownloads,
      streamMaxConnections: form.value.streamMaxConnections,
      maxTries: form.value.maxTries,
      retryWait: form.value.retryWait,
      shareRatio: form.value.shareRatio,
      shareTime: form.value.shareTime,
      completedRecordRetentionDays: form.value.completedRecordRetentionDays,
    }) &&
    (completedRecordRetentionSelectValue.value !== -1 ||
      !fieldProps(form.value.completedRecordRetentionDays, { min: 1, max: 3650, integer: true }).validationStatus),
)

function parseSpeedLimit(value: unknown) {
  const str = String(value || '0')
  const num = parseInt(str, 10) || 0
  const unit = extractSpeedUnit(str) || 'K'
  return { num, unit }
}

function buildSpeedLimit(value: number, unit: string): string {
  return value > 0 ? `${value}${unit}` : '0'
}

function handleUploadUnitChange(val: string) {
  uploadUnit.value = val
  form.value.maxOverallUploadLimit = buildSpeedLimit(uploadSpeedValue.value, val)
}
function handleDownloadUnitChange(val: string) {
  downloadUnit.value = val
  form.value.maxOverallDownloadLimit = buildSpeedLimit(downloadSpeedValue.value, val)
}
function handleUploadValueChange(val: number | null) {
  const v = val || 0
  uploadSpeedValue.value = v
  form.value.maxOverallUploadLimit = buildSpeedLimit(v, uploadUnit.value)
}
function handleDownloadValueChange(val: number | null) {
  const v = val || 0
  downloadSpeedValue.value = v
  form.value.maxOverallDownloadLimit = buildSpeedLimit(v, downloadUnit.value)
}

// ── File categories ─────────────────────────────────────────────────
const showCategoryManager = ref(false)
const categorySummary = computed(() => {
  const categories = form.value.fileCategories
  const urlRuleCount = categories.reduce((total, category) => total + (category.urlPatterns?.length ?? 0), 0)
  return t('preferences.file-category-summary', { count: categories.length, url: urlRuleCount })
})
const categoryBaseDir = computed(() => form.value.dir || defaultDownloadDir.value)
async function handleCategoryManagerSave(categories: typeof form.value.fileCategories) {
  form.value.fileCategories = categories
  const saved = await preferenceStore.updateAndSave({ fileCategories: categories })
  if (!saved) {
    message.error(t('preferences.save-fail-message'))
    return
  }
  patchSnapshot({ fileCategories: categories } as Partial<typeof form.value>)
}
async function handleSelectDir() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (typeof selected === 'string') form.value.dir = selected
}
function handleRecentDirSelect(dir: string) {
  form.value.dir = dir
}
// ── Speed limit toggle ──────────────────────────────────────────────
async function handleSpeedLimitToggle() {
  if (!isEngineReady()) return
  try {
    const result = await toggleSpeedLimit(preferenceStore.config, {
      changeGlobalOption,
      updateAndSave: (partial) => preferenceStore.updateAndSave(partial),
    })
    if (result === 'enabled') message.success(t('app.speedometer-limit-applied'))
    else if (result === 'disabled') message.success(t('app.speedometer-limit-removed'))
    else message.info(t('app.speedometer-needs-config-settings'))
  } catch (e) {
    logger.error('Downloads.speedLimitToggle', e)
  }
}

async function handleScheduleToggle(enabled: boolean) {
  try {
    await preferenceStore.updateAndSave({ speedScheduleEnabled: enabled })
    message.success(t(enabled ? 'app.schedule-enabled' : 'app.schedule-disabled'))
  } catch (e) {
    logger.error('Downloads.scheduleToggle', e)
  }
}

function loadForm() {
  Object.assign(form.value, buildForm())
  completedRecordRetentionMode.value = getCompletedRecordRetentionSelectValue(
    Number(form.value.completedRecordRetentionDays),
  )
  const ul = parseSpeedLimit(form.value.maxOverallUploadLimit)
  uploadSpeedValue.value = ul.num
  uploadUnit.value = ul.unit
  const dl = parseSpeedLimit(form.value.maxOverallDownloadLimit)
  downloadSpeedValue.value = dl.num
  downloadUnit.value = dl.unit
}

onMounted(async () => {
  try {
    const resolvedDir = await resolveUserVisibleDownloadDir({ configuredDir: preferenceStore.config.dir })
    defaultDownloadDir.value = resolvedDir.path
    logger.info('Downloads.downloadDir', `resolved source=${resolvedDir.source} fallback=${resolvedDir.usedFallback}`)
  } catch (e) {
    logger.debug('Downloads.downloadDir', e)
  }
  loadForm()
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <div class="preference-form-scroll">
      <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
        <NDivider title-placement="left">{{ t('preferences.download-concurrency') }}</NDivider>
        <NFormItem
          :label="t('preferences.max-concurrent-downloads')"
          v-bind="configFieldProps('maxConcurrentDownloads', form.maxConcurrentDownloads)"
        >
          <NInputNumber
            v-model:value="form.maxConcurrentDownloads"
            :min="constraint('maxConcurrentDownloads').min"
            :max="constraint('maxConcurrentDownloads').max"
            class="pref-number"
          />
        </NFormItem>
        <NFormItem
          :label="t('preferences.stream-max-connections')"
          v-bind="configFieldProps('streamMaxConnections', form.streamMaxConnections)"
        >
          <NInputNumber
            v-model:value="form.streamMaxConnections"
            :min="constraint('streamMaxConnections').min"
            :max="constraint('streamMaxConnections').max"
            class="pref-number"
          />
        </NFormItem>
        <NDivider title-placement="left">{{ t('preferences.p2p-sharing-section') }}</NDivider>
        <NFormItem :label="t('preferences.sharing-mode')">
          <NRadioGroup v-model:value="form.sharingMode" size="small">
            <NRadioButton value="stop-by-condition">
              {{ t('preferences.sharing-mode-stop-by-condition') }}
            </NRadioButton>
            <NRadioButton value="manual-stop">{{ t('preferences.sharing-mode-manual-stop') }}</NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NCollapseTransition :show="form.sharingMode === 'stop-by-condition'" class="collapse-indent">
          <NFormItem :label="t('preferences.share-ratio')" v-bind="configFieldProps('shareRatio', form.shareRatio)">
            <NInputNumber
              v-model:value="form.shareRatio"
              :min="constraint('shareRatio').min"
              :max="constraint('shareRatio').max"
              :step="0.1"
              class="pref-number"
            />
          </NFormItem>
          <NFormItem
            :label="t('preferences.share-time') + ' (' + t('preferences.share-time-unit') + ')'"
            v-bind="configFieldProps('shareTime', form.shareTime)"
          >
            <NInputNumber
              v-model:value="form.shareTime"
              :min="constraint('shareTime').min"
              :max="constraint('shareTime').max"
              class="pref-number"
            />
          </NFormItem>
        </NCollapseTransition>
        <NCollapseTransition :show="form.sharingMode === 'manual-stop'" class="collapse-indent">
          <NFormItem label=" ">
            <NText depth="3">{{ t('preferences.sharing-mode-manual-stop-tips') }}</NText>
          </NFormItem>
        </NCollapseTransition>
        <!-- Retry & File Options -->
        <NDivider title-placement="left">{{ t('preferences.retry-and-file-behavior') }}</NDivider>
        <NFormItem :label="t('preferences.max-tries')" v-bind="configFieldProps('maxTries', form.maxTries)">
          <NInputNumber
            v-model:value="form.maxTries"
            :min="constraint('maxTries').min"
            :max="constraint('maxTries').max"
            class="pref-number"
          />
          <NText depth="3" class="pref-inline-note">
            {{ t('preferences.max-tries-hint') }}
          </NText>
        </NFormItem>
        <NFormItem :label="t('preferences.retry-wait')" v-bind="configFieldProps('retryWait', form.retryWait)">
          <NInputNumber
            v-model:value="form.retryWait"
            :min="constraint('retryWait').min"
            :max="constraint('retryWait').max"
            class="pref-number"
          />
          <NText depth="3" class="pref-inline-note">{{ t('preferences.unit-seconds') }}</NText>
        </NFormItem>
        <NFormItem :label="t('preferences.continue')">
          <NSwitch v-model:value="form.continue" />
        </NFormItem>

        <!-- Download Path -->
        <NDivider title-placement="left">{{ t('preferences.download-path') }}</NDivider>
        <NFormItem :label="t('preferences.default-path')">
          <NInputGroup>
            <NInput v-model:value="form.dir" class="pref-control-full" />
            <NButton class="pref-icon-button" @click="handleSelectDir">
              <template #icon>
                <NIcon :size="16"><FolderOpenOutline /></NIcon>
              </template>
            </NButton>
            <DirectoryPopover @select="handleRecentDirSelect" />
          </NInputGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.file-timestamp')">
          <NSelect
            :value="fileTimestampValue"
            :options="fileTimestampOptions"
            class="pref-control-auto pref-control-file-timestamp"
            @update:value="handleFileTimestampChange"
          />
        </NFormItem>
        <NFormItem>
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.file-category-save')"
              :hint="t('preferences.file-category-auto-archive-hint')"
            />
          </template>
          <NSwitch v-model:value="form.fileCategoryEnabled" />
        </NFormItem>
        <NFormItem :show-label="false">
          <div class="file-category-summary-row">
            <div class="file-category-summary-text">
              <span>{{ categorySummary }}</span>
              <NText depth="3">{{ t('preferences.file-category-manager-hint') }}</NText>
            </div>
            <NButton size="small" @click="showCategoryManager = true">
              {{ t('preferences.file-category-manage') }}
            </NButton>
          </div>
        </NFormItem>

        <!-- Speed Limit -->
        <NDivider title-placement="left">{{ t('preferences.speed-limit') }}</NDivider>
        <NFormItem :label="t('app.speedometer-enable-limit')">
          <NSwitch :value="preferenceStore.config.speedLimitEnabled" @update:value="handleSpeedLimitToggle" />
        </NFormItem>
        <NFormItem>
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.speed-schedule-enabled')"
              :hint="t('preferences.schedule-hint')"
            />
          </template>
          <NSwitch :value="preferenceStore.config.speedScheduleEnabled" @update:value="handleScheduleToggle" />
        </NFormItem>
        <NCollapseTransition :show="preferenceStore.config.speedScheduleEnabled" class="collapse-indent">
          <Transition name="schedule-warn">
            <NFormItem v-if="!preferenceStore.config.speedLimitEnabled" :show-label="false">
              <NText depth="3" type="warning" class="pref-inline-note pref-inline-note--warning">
                {{ t('preferences.schedule-needs-limit') }}
              </NText>
            </NFormItem>
          </Transition>
          <NFormItem :label="t('preferences.schedule-from')">
            <NSelect v-model:value="form.speedScheduleFrom" :options="timeOptions" class="pref-control-auto" />
          </NFormItem>
          <NFormItem :label="t('preferences.schedule-to')">
            <NSelect v-model:value="form.speedScheduleTo" :options="timeOptions" class="pref-control-auto" />
          </NFormItem>
          <NFormItem :label="t('preferences.schedule-days')">
            <NSelect v-model:value="form.speedScheduleDays" :options="scheduleDayOptions" class="pref-control-auto" />
          </NFormItem>
        </NCollapseTransition>
        <div>
          <NFormItem :label="t('preferences.transfer-speed-upload')">
            <NInputGroup>
              <NInputNumber
                :value="uploadSpeedValue"
                :min="0"
                :max="65535"
                :step="1"
                class="pref-port"
                @update:value="handleUploadValueChange"
              />
              <NSelect
                :value="uploadUnit"
                :options="speedUnitOptions"
                class="pref-control-auto pref-control-compact"
                @update:value="handleUploadUnitChange"
              />
            </NInputGroup>
          </NFormItem>
          <NFormItem :label="t('preferences.transfer-speed-download')">
            <NInputGroup>
              <NInputNumber
                :value="downloadSpeedValue"
                :min="0"
                :max="65535"
                :step="1"
                class="pref-port"
                @update:value="handleDownloadValueChange"
              />
              <NSelect
                :value="downloadUnit"
                :options="speedUnitOptions"
                class="pref-control-auto pref-control-compact"
                @update:value="handleDownloadUnitChange"
              />
            </NInputGroup>
          </NFormItem>
        </div>

        <!-- Notification & Confirm -->
        <NDivider title-placement="left">{{ t('preferences.notification-and-confirm') }}</NDivider>
        <NFormItem :label="t('preferences.new-task-show-downloading')">
          <NSwitch v-model:value="form.newTaskShowDownloading" />
        </NFormItem>
        <NFormItem :label="t('preferences.file-deletion-mode')">
          <NSelect v-model:value="form.fileDeletionMode" :options="fileDeletionModeOptions" class="pref-control-auto" />
        </NFormItem>
        <NFormItem :label="t('preferences.no-confirm-before-delete-task')">
          <NSwitch v-model:value="form.noConfirmBeforeDeleteTask" />
        </NFormItem>
        <NCollapseTransition :show="form.noConfirmBeforeDeleteTask">
          <NFormItem label=" ">
            <NCheckbox v-model:checked="form.deleteFilesWhenSkipConfirm">
              {{ skipConfirmationFileLabel }}
            </NCheckbox>
          </NFormItem>
        </NCollapseTransition>
        <NFormItem :label="t('preferences.task-completed-notify')">
          <NSwitch v-model:value="form.taskNotification" />
        </NFormItem>
        <NCollapseTransition :show="form.taskNotification">
          <NFormItem label=" ">
            <PreferenceCheckboxGrid v-model:value="selectedNotificationTypes" :options="notificationTypeOptions" />
          </NFormItem>
        </NCollapseTransition>
        <NFormItem :label="t('preferences.shutdown-when-complete')">
          <NSwitch v-model:value="form.shutdownWhenComplete" />
        </NFormItem>
        <NFormItem :label="t('preferences.keep-awake')">
          <NSwitch v-model:value="form.keepAwake" />
        </NFormItem>

        <!-- Auto Cleanup -->
        <NDivider title-placement="left">{{ t('preferences.auto-cleanup') }}</NDivider>
        <NFormItem :label="t('preferences.delete-torrent-after-complete')">
          <NSwitch v-model:value="form.deleteTorrentAfterComplete" />
        </NFormItem>
        <NFormItem :label="t('preferences.auto-delete-stale-records')">
          <NSwitch v-model:value="form.autoDeleteStaleRecords" />
        </NFormItem>
        <NFormItem :label="t('preferences.clear-completed-on-exit')">
          <NSwitch v-model:value="form.clearCompletedOnExit" />
        </NFormItem>
        <NFormItem :label="t('preferences.completed-record-retention')">
          <NSelect
            v-model:value="completedRecordRetentionSelectValue"
            :options="completedRecordRetentionOptions"
            class="pref-control-auto"
          />
        </NFormItem>
        <NCollapseTransition :show="completedRecordRetentionSelectValue === -1">
          <NFormItem
            :label="t('preferences.completed-record-retention-custom-days')"
            v-bind="fieldProps(form.completedRecordRetentionDays, { min: 1, max: 3650, integer: true })"
          >
            <NInputNumber v-model:value="form.completedRecordRetentionDays" :min="1" :max="3650" class="pref-number" />
            <NText depth="3" class="pref-inline-note">
              {{ t('preferences.completed-record-retention-days-unit') }}
            </NText>
          </NFormItem>
        </NCollapseTransition>
      </NForm>
    </div>
    <PreferenceActionBar :is-dirty="isDirty" :is-valid="numericFieldsValid" @save="handleSave" @discard="handleReset" />
    <FileCategoryManager
      v-model:show="showCategoryManager"
      :categories="form.fileCategories"
      :base-dir="categoryBaseDir"
      @save="handleCategoryManagerSave"
    />
  </div>
</template>

<style scoped>
.pref-control-compact {
  min-width: 80px;
}

.pref-control-file-timestamp {
  min-width: 200px;
}

.schedule-warn-enter-active,
.schedule-warn-leave-active {
  transition:
    opacity 0.25s cubic-bezier(0.2, 0, 0, 1),
    transform 0.25s cubic-bezier(0.2, 0, 0, 1),
    max-height 0.25s cubic-bezier(0.2, 0, 0, 1);
  overflow: hidden;
}
.schedule-warn-enter-from,
.schedule-warn-leave-to {
  opacity: 0;
  transform: translateY(-8px);
  max-height: 0;
}
.schedule-warn-enter-to,
.schedule-warn-leave-from {
  max-height: 60px;
}

.file-category-summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 8px;
  background: var(--m3-surface-container-low);
}

.file-category-summary-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
</style>
