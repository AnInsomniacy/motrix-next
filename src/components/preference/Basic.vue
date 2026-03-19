<script setup lang="ts">
/** @fileoverview Basic preference form: theme, locale, download dir, speed limits. */
import { ref, computed, watch, onMounted, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { relaunch } from '@tauri-apps/plugin-process'
import { useIpc } from '@/composables/useIpc'
import { platform } from '@tauri-apps/plugin-os'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { downloadDir } from '@tauri-apps/api/path'
import { extractSpeedUnit } from '@shared/utils'
import { logger } from '@shared/logger'
import { ENGINE_RPC_PORT } from '@shared/constants'
import { useAppMessage } from '@/composables/useAppMessage'
import { buildBasicForm, buildBasicSystemConfig, transformBasicForStore } from '@/composables/useBasicPreference'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NCheckbox,
  NSwitch,
  NButton,
  NSpace,
  NDivider,
  NInputGroup,
  NText,
  NCollapseTransition,
  NTag,
  NRadioGroup,
  NRadioButton,
  useDialog,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import { FolderOpenOutline, CloudDownloadOutline } from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'

const { t, locale } = useI18n()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()
const defaultDownloadDir = ref('')
const currentPlatform = ref('')
const isMac = computed(() => currentPlatform.value === 'macos')
const isMacOrWin = computed(() => currentPlatform.value === 'macos' || currentPlatform.value === 'windows')
const isMacOrLinux = computed(() => currentPlatform.value === 'macos' || currentPlatform.value === 'linux')
const platformLabel = computed(() => {
  const map: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }
  return map[currentPlatform.value] || currentPlatform.value
})
const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

const checkIntervalOptions = [
  { label: t('preferences.interval-daily'), value: 24 },
  { label: t('preferences.interval-weekly'), value: 168 },
  { label: t('preferences.interval-monthly'), value: 720 },
  { label: t('preferences.interval-semi-annual'), value: 4320 },
  { label: t('preferences.interval-yearly'), value: 8760 },
]

function buildForm() {
  return buildBasicForm(preferenceStore.config, defaultDownloadDir.value)
}

const CONNECTION_SAFE_LIMIT = 64

const { form, isDirty, handleSave, handleReset, resetSnapshot, patchSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildBasicSystemConfig,
  transformForStore: transformBasicForStore,
  beforeSave: async (f) => {
    // Gate save on user confirmation when connection count exceeds safe threshold.
    // Modern HTTP/2 & HTTP/3 servers rarely benefit from >64 connections, and
    // aggressive counts may trigger server-side rate limiting or IP bans.
    if (f.maxConnectionPerServer > CONNECTION_SAFE_LIMIT) {
      return new Promise<boolean>((resolve) => {
        const revert = () => {
          f.maxConnectionPerServer = CONNECTION_SAFE_LIMIT
          resolve(false)
        }
        dialog.warning({
          title: t('preferences.high-connection-warning-title'),
          content: t('preferences.high-connection-warning'),
          positiveText: t('preferences.high-connection-continue'),
          negativeText: t('app.cancel'),
          onPositiveClick: () => resolve(true),
          onNegativeClick: revert,
          onClose: revert,
        })
      })
    }
    return true
  },
  afterSave: async (f, prevConfig) => {
    // Locale change → restart prompt
    const prevLocale = prevConfig.locale || 'en-US'
    if (f.locale !== prevLocale) {
      const targetLocale = f.locale
      const isEn = targetLocale === 'en-US'
      const tt = (key: string) => t(key, {}, { locale: targetLocale })
      dialog.info({
        style: 'min-width: 520px',
        title: isEn
          ? tt('preferences.language-changed-title')
          : () =>
              h('div', { style: 'padding-left: 12px' }, [
                h('div', tt('preferences.language-changed-title')),
                h('div', 'Language Changed'),
              ]),
        content: isEn
          ? tt('preferences.language-changed-content')
          : () =>
              h('div', { style: 'padding: 10px 0' }, [
                h('p', { style: 'margin: 0' }, tt('preferences.language-changed-content')),
                h('p', { style: 'margin: 0' }, 'Please restart the application to apply the new language.'),
              ]),
        positiveText: isEn
          ? tt('preferences.language-changed-restart')
          : `${tt('preferences.language-changed-restart')} · Restart Now`,
        negativeText: isEn
          ? tt('preferences.language-changed-later')
          : `${tt('preferences.language-changed-later')} · Later`,
        onPositiveClick: async () => {
          const { stopEngine } = useIpc()
          await stopEngine()
          relaunch()
        },
      })
    }

    // Sync autostart state immediately on save
    if (f.openAtLogin !== !!prevConfig.openAtLogin) {
      try {
        const { isEnabled, enable, disable } = await import('@tauri-apps/plugin-autostart')
        const currentlyEnabled = await isEnabled()
        if (f.openAtLogin && !currentlyEnabled) await enable()
        else if (!f.openAtLogin && currentlyEnabled) await disable()
      } catch (e) {
        console.error('Failed to sync autostart:', e)
      }
    }
  },
})

// One-shot sync: if async OS locale detection completes after mount, patch the form.
// On first launch (no config.json), buildForm() snapshots locale as 'en-US' (fallback)
// because main.ts hasn't finished getLocale() yet. When detection completes and
// updateAndSave() writes the real locale, this watcher patches the dropdown once.
const stopLocaleSync = watch(
  () => preferenceStore.config.locale,
  (detected) => {
    if (detected && form.value.locale === 'en-US' && detected !== 'en-US') {
      form.value.locale = detected
      patchSnapshot({ locale: detected } as Partial<typeof form.value>)
      stopLocaleSync()
    }
  },
)

const uploadSpeedValue = ref(0)
const uploadUnit = ref('K')
const downloadSpeedValue = ref(0)
const downloadUnit = ref('K')

const speedUnitOptions = [
  { label: 'KB/s', value: 'K' },
  { label: 'MB/s', value: 'M' },
]

const localeOptions = [
  { label: 'English', value: 'en-US' },
  { label: '简体中文 · Chinese Simplified', value: 'zh-CN' },
  { label: '繁體中文 · Chinese Traditional', value: 'zh-TW' },
  { label: '日本語 · Japanese', value: 'ja' },
  { label: '한국어 · Korean', value: 'ko' },
  { label: 'Français · French', value: 'fr' },
  { label: 'Deutsch · German', value: 'de' },
  { label: 'Español · Spanish', value: 'es' },
  { label: 'Português · Portuguese (Brazil)', value: 'pt-BR' },
  { label: 'Русский · Russian', value: 'ru' },
  { label: 'Türkçe · Turkish', value: 'tr' },
  { label: 'العربية · Arabic', value: 'ar' },
  { label: 'Български · Bulgarian', value: 'bg' },
  { label: 'Català · Catalan', value: 'ca' },
  { label: 'Ελληνικά · Greek', value: 'el' },
  { label: 'فارسی · Persian', value: 'fa' },
  { label: 'Magyar · Hungarian', value: 'hu' },
  { label: 'Bahasa Indonesia · Indonesian', value: 'id' },
  { label: 'Italiano · Italian', value: 'it' },
  { label: 'Norsk Bokmål · Norwegian', value: 'nb' },
  { label: 'Nederlands · Dutch', value: 'nl' },
  { label: 'Polski · Polish', value: 'pl' },
  { label: 'Română · Romanian', value: 'ro' },
  { label: 'ไทย · Thai', value: 'th' },
  { label: 'Українська · Ukrainian', value: 'uk' },
  { label: 'Tiếng Việt · Vietnamese', value: 'vi' },
]

const themeOptions = computed(() => [
  { label: t('preferences.theme-auto'), value: 'auto' },
  { label: t('preferences.theme-light'), value: 'light' },
  { label: t('preferences.theme-dark'), value: 'dark' },
])

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

function onKeepSeedingChange(enable: boolean) {
  if (enable) {
    form.value.seedRatio = 0
    form.value.seedTime = 525600
  } else {
    form.value.seedRatio = 1
    form.value.seedTime = 60
  }
}

async function handleSelectDir() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (typeof selected === 'string') form.value.dir = selected
}

function loadForm() {
  Object.assign(form.value, buildForm())

  const ul = parseSpeedLimit(form.value.maxOverallUploadLimit)
  uploadSpeedValue.value = ul.num
  uploadUnit.value = ul.unit

  const dl = parseSpeedLimit(form.value.maxOverallDownloadLimit)
  downloadSpeedValue.value = dl.num
  downloadUnit.value = dl.unit
}

function handleCheckUpdate() {
  updateDialogRef.value?.open()
}

const { restartEngine } = useEngineRestart()

function handleManualRestart() {
  const port = (preferenceStore.config.rpcListenPort as number) || ENGINE_RPC_PORT
  const secret = (preferenceStore.config.rpcSecret as string) || ''
  const d = dialog.warning({
    title: t('preferences.engine-restart-title'),
    content: t('preferences.engine-restart-manual-confirm'),
    positiveText: t('preferences.engine-restart-now'),
    negativeText: t('preferences.engine-restart-later'),
    maskClosable: false,
    onPositiveClick: async () => {
      d.loading = true
      d.negativeText = ''
      d.closable = false
      message.info(t('preferences.engine-restarting'), { duration: 2000 })
      await new Promise((r) => requestAnimationFrame(r))
      await restartEngine({ port, secret })
    },
  })
}

onMounted(async () => {
  try {
    defaultDownloadDir.value = await downloadDir()
  } catch (e) {
    logger.debug('Basic.downloadDir', e)
  }
  try {
    currentPlatform.value = platform()
  } catch (e) {
    logger.debug('Basic.platform', e)
  }
  loadForm()
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="300px" size="small" class="form-preference">
      <NDivider title-placement="left">
        {{ locale === 'en-US' ? t('preferences.language') : `${t('preferences.language')} · Language` }}
      </NDivider>
      <NFormItem
        :label="
          locale === 'en-US'
            ? t('preferences.select-language')
            : `${t('preferences.select-language')} · Select Language`
        "
      >
        <NSelect v-model:value="form.locale" :options="localeOptions" style="width: 280px" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.auto-update') }}</NDivider>
      <NFormItem :label="t('preferences.auto-check-update')">
        <NSwitch v-model:value="form.autoCheckUpdate" />
      </NFormItem>
      <NCollapseTransition :show="form.autoCheckUpdate">
        <NFormItem :label="t('preferences.check-frequency')">
          <NSelect v-model:value="form.autoCheckUpdateInterval" :options="checkIntervalOptions" style="width: 180px" />
        </NFormItem>
      </NCollapseTransition>
      <NCollapseTransition :show="form.autoCheckUpdate">
        <NFormItem :label="t('preferences.update-channel')">
          <NRadioGroup
            v-model:value="form.updateChannel"
            size="small"
            @update:value="
              async (v: string) => {
                const ok = await preferenceStore.updateAndSave({ updateChannel: v as 'stable' | 'beta' })
                if (ok) {
                  // Only sync updateChannel in the snapshot — preserve dirty state
                  // for other unsaved fields (download dir, speed limits, etc.).
                  patchSnapshot({ updateChannel: v } as Partial<typeof form.value>)
                }
              }
            "
          >
            <NRadioButton value="stable">{{ t('preferences.update-channel-stable') }}</NRadioButton>
            <NRadioButton value="beta">{{ t('preferences.update-channel-beta') }}</NRadioButton>
          </NRadioGroup>
        </NFormItem>
      </NCollapseTransition>
      <NFormItem :label="t('preferences.last-check-update-time')">
        <div style="display: flex; align-items: center; gap: 16px">
          <NButton size="small" @click="handleCheckUpdate">
            <template #icon>
              <NIcon :size="14"><CloudDownloadOutline /></NIcon>
            </template>
            {{ t('app.check-updates-now') }}
          </NButton>
          <NText v-if="preferenceStore.config.lastCheckUpdateTime" depth="3" style="font-size: 13px">
            {{ new Date(preferenceStore.config.lastCheckUpdateTime).toLocaleString() }}
          </NText>
          <NText v-else depth="3" style="font-size: 13px">—</NText>
        </div>
      </NFormItem>
      <UpdateDialog ref="updateDialogRef" />

      <NDivider title-placement="left">{{ t('preferences.appearance-section') }}</NDivider>
      <NFormItem :label="t('preferences.detected-platform')">
        <NTag type="info" round>{{ platformLabel }}</NTag>
      </NFormItem>
      <NFormItem :label="t('preferences.appearance')">
        <NSelect v-model:value="form.theme" :options="themeOptions" style="width: 200px" />
      </NFormItem>
      <NFormItem v-if="isMacOrWin" :label="t('preferences.show-progress-bar')">
        <NSwitch v-model:value="form.showProgressBar" />
      </NFormItem>
      <NFormItem :label="t('preferences.mac-style-controls')">
        <NSwitch v-model:value="form.macStyleControls" />
      </NFormItem>
      <NFormItem v-if="isMac" :label="t('preferences.dock-badge-speed')">
        <NSwitch v-model:value="form.dockBadgeSpeed" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.window-and-tray') }}</NDivider>
      <NFormItem :label="t('preferences.minimize-to-tray-on-close')">
        <NSwitch v-model:value="form.minimizeToTrayOnClose" />
      </NFormItem>
      <NFormItem :label="t('preferences.auto-hide-window')">
        <NSwitch v-model:value="form.autoHideWindow" />
      </NFormItem>
      <NFormItem v-if="isMac" :label="t('preferences.hide-dock-on-minimize')">
        <NSwitch v-model:value="form.hideDockOnMinimize" />
      </NFormItem>
      <NFormItem v-if="isMacOrLinux" :label="t('preferences.tray-speedometer')">
        <NSwitch v-model:value="form.traySpeedometer" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.startup') }}</NDivider>
      <NFormItem :show-label="false">
        <NSpace vertical>
          <NCheckbox v-model:checked="form.openAtLogin">{{ t('preferences.open-at-login') }}</NCheckbox>
          <NCheckbox v-model:checked="form.keepWindowState">{{ t('preferences.keep-window-state') }}</NCheckbox>
          <NCheckbox v-model:checked="form.resumeAllWhenAppLaunched">{{ t('preferences.auto-resume-all') }}</NCheckbox>
        </NSpace>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.download-path-and-speed') }}</NDivider>
      <NFormItem :label="t('preferences.default-dir')">
        <NInputGroup>
          <NInput v-model:value="form.dir" style="flex: 1" />
          <NButton style="padding: 0 12px" @click="handleSelectDir">
            <template #icon>
              <NIcon :size="16"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.transfer-speed-upload')">
        <NInputGroup>
          <NInputNumber
            :value="uploadSpeedValue"
            :min="0"
            :max="65535"
            :step="1"
            style="width: 140px"
            @update:value="handleUploadValueChange"
          />
          <NSelect
            :value="uploadUnit"
            :options="speedUnitOptions"
            style="width: 100px"
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
            style="width: 140px"
            @update:value="handleDownloadValueChange"
          />
          <NSelect
            :value="downloadUnit"
            :options="speedUnitOptions"
            style="width: 100px"
            @update:value="handleDownloadUnitChange"
          />
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.bt-settings') }}</NDivider>
      <NFormItem :show-label="false">
        <NSpace vertical>
          <NCheckbox v-model:checked="form.btAutoDownloadContent">
            {{ t('preferences.bt-auto-download-content') }}
          </NCheckbox>
          <NCheckbox v-model:checked="form.btForceEncryption">{{ t('preferences.bt-force-encryption') }}</NCheckbox>
        </NSpace>
      </NFormItem>
      <NFormItem :label="t('preferences.keep-seeding')">
        <NSwitch v-model:value="form.keepSeeding" @update:value="onKeepSeedingChange" />
      </NFormItem>

      <NDivider v-if="!form.keepSeeding" title-placement="left">{{ t('preferences.seeding') }}</NDivider>
      <template v-if="!form.keepSeeding">
        <NFormItem :label="t('preferences.seed-ratio')">
          <NInputNumber v-model:value="form.seedRatio" :min="1" :max="100" :step="0.1" style="width: 120px" />
        </NFormItem>
        <NFormItem :label="t('preferences.seed-time') + ' (' + t('preferences.seed-time-unit') + ')'">
          <NInputNumber v-model:value="form.seedTime" :min="60" :max="525600" style="width: 120px" />
        </NFormItem>
      </template>

      <NDivider title-placement="left">{{ t('preferences.task-manage') }}</NDivider>
      <NFormItem :label="t('preferences.max-concurrent-downloads')">
        <NInputNumber v-model:value="form.maxConcurrentDownloads" :min="1" :max="10" style="width: 120px" />
      </NFormItem>
      <NFormItem :label="t('preferences.max-connection-per-server')">
        <NInputNumber v-model:value="form.maxConnectionPerServer" :min="1" :max="128" style="width: 120px" />
      </NFormItem>
      <NFormItem :show-label="false">
        <NCheckbox v-model:checked="form.continue">{{ t('preferences.continue') }}</NCheckbox>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.notification-and-confirm') }}</NDivider>
      <NFormItem :show-label="false">
        <NSpace vertical>
          <NCheckbox v-model:checked="form.newTaskShowDownloading">
            {{ t('preferences.new-task-show-downloading') }}
          </NCheckbox>
          <NCheckbox v-model:checked="form.taskNotification">{{ t('preferences.task-completed-notify') }}</NCheckbox>
          <NCheckbox v-model:checked="form.noConfirmBeforeDeleteTask">
            {{ t('preferences.no-confirm-before-delete-task') }}
          </NCheckbox>
        </NSpace>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.auto-cleanup') }}</NDivider>
      <NFormItem :show-label="false">
        <NSpace vertical>
          <NCheckbox v-model:checked="form.deleteTorrentAfterComplete">
            {{ t('preferences.delete-torrent-after-complete') || 'Delete .torrent file after download completes' }}
          </NCheckbox>
          <NCheckbox v-model:checked="form.autoDeleteStaleRecords">
            {{ t('preferences.auto-delete-stale-records') || 'Auto-delete records when local files are missing' }}
          </NCheckbox>
        </NSpace>
      </NFormItem>
    </NForm>
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" @restart="handleManualRestart" />
  </div>
</template>

<style scoped>
.preference-form-wrapper {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.form-preference {
  flex: 1;
  overflow-y: auto;
  padding: 16px 30px 64px 36px;
}
.form-preference :deep(.n-form-item) {
  padding-left: 50px;
}
.form-actions {
  padding: 16px 24px 16px 40px;
}
</style>
