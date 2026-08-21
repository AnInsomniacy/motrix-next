<script setup lang="ts">
/** @fileoverview Advanced preference tab: RPC, extension, clipboard, default programs, engine, FFmpeg, log, history, diagnostics. */
import { ref, computed, nextTick, onMounted, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { usePlatform } from '@/composables/usePlatform'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { useTaskStore } from '@/stores/task'
import { useHistoryStore } from '@/stores/history'
import { useAdvancedActions } from '@/composables/useAdvancedActions'
import { useProtocolHandlers, type ProtocolKey } from '@/composables/useProtocolHandlers'
import { useHlsFfmpegStatus } from '@/composables/useHlsFfmpegStatus'
import { relaunch } from '@tauri-apps/plugin-process'
import { appDataDir, appLogDir, join, tempDir } from '@tauri-apps/api/path'
import { APP_LOG_LEVELS, ARIA2_LOG_LEVELS } from '@shared/constants'
import {
  generateSecret,
  buildAdvancedForm,
  buildAdvancedSystemConfig,
  transformAdvancedForStore,
  validateAdvancedForm,
  randomRpcPort,
} from '@/composables/useAdvancedPreference'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NSwitch,
  NSelect,
  NButton,
  NSpace,
  NDivider,
  NIcon,
  NModal,
  NCard,
  NDataTable,
  NEmpty,
  NCollapseTransition,
  useDialog,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  CloudDownloadOutline,
  CloudUploadOutline,
  DiceOutline,
  DownloadOutline,
  FolderOpenOutline,
  TrashOutline,
  CopyOutline,
} from '@vicons/ionicons5'
import { logger } from '@shared/logger'
import PreferenceActionBar from './PreferenceActionBar.vue'
import PreferenceCheckboxGrid from './PreferenceCheckboxGrid.vue'
import PreferenceHintLabel from './PreferenceHintLabel.vue'

const { restartEngine } = useEngineRestart()

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const historyStore = useHistoryStore()
const message = useAppMessage()
const dialog = useDialog()
const protocolHandlers = useProtocolHandlers()
const protocolStatus = protocolHandlers.status
const protocolPending = protocolHandlers.pending

const { isLinux, isWindows } = usePlatform()
const { status: ffmpegStatus, refresh: refreshFfmpegStatus } = useHlsFfmpegStatus()

import { ENGINE_RPC_PORT } from '@shared/constants'
import { diffConfig, checkIsNeedRestart } from '@shared/utils/config'
import { writeAppClipboardText } from '@shared/utils'

const appLogLevelOptions = APP_LOG_LEVELS.map((level) => ({ label: level, value: level }))
const aria2LogLevelOptions = ARIA2_LOG_LEVELS.map((level) => ({ label: level, value: level }))

type ClipboardType = 'http' | 'ftp' | 'magnet' | 'ed2k' | 'thunder' | 'btHash'
const clipboardTypes: ClipboardType[] = ['http', 'ftp', 'magnet', 'ed2k', 'thunder', 'btHash']
const clipboardTypeOptions = computed(() => [
  { label: t('preferences.clipboard-http'), value: 'http' },
  { label: t('preferences.clipboard-ftp'), value: 'ftp' },
  { label: t('preferences.clipboard-magnet'), value: 'magnet' },
  { label: t('preferences.clipboard-ed2k'), value: 'ed2k' },
  { label: t('preferences.clipboard-thunder'), value: 'thunder' },
  { label: t('preferences.clipboard-bt-hash'), value: 'btHash' },
])
const clipboardFieldByType: Record<ClipboardType, keyof typeof form.value> = {
  http: 'clipboardHttp',
  ftp: 'clipboardFtp',
  magnet: 'clipboardMagnet',
  ed2k: 'clipboardEd2k',
  thunder: 'clipboardThunder',
  btHash: 'clipboardBtHash',
}
const selectedClipboardTypes = computed<string[]>({
  get: () => clipboardTypes.filter((type) => !!form.value[clipboardFieldByType[type]]),
  set: (types) => {
    const selected = new Set(types)
    for (const type of clipboardTypes) {
      form.value[clipboardFieldByType[type]] = selected.has(type)
    }
  },
})

const aria2ConfPath = ref('')
const sessionPath = ref('')
const logPath = ref('')
const defaultTempPath = ref('')

const { form, isDirty, handleSave, handleReset, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildAdvancedSystemConfig,
  transformForStore: transformAdvancedForStore,
  beforeSave: async (f) => {
    const error = validateAdvancedForm(f)
    if (error) {
      message.error(t(error))
      return false
    }
    // Only warn when user actively clears the secret (non-empty → empty).
    // If it was already empty before this edit session, no need to re-warn.
    const prevSecret = preferenceStore.config.rpcSecret
    if (!f.rpcSecret && !!prevSecret) {
      const ok = await new Promise<boolean>((resolve) => {
        dialog.info({
          title: t('preferences.rpc-secret-empty-title'),
          content: t('preferences.rpc-secret-empty-confirm'),
          positiveText: t('preferences.rpc-secret-empty-continue'),
          negativeText: t('app.cancel'),
          maskClosable: false,
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!ok) return false
    }

    // Gate: engine restart confirmation (RPC port / secret change).
    // Must confirm BEFORE saving — declining cancels the entire save so
    // config.json never contains values the running engine doesn't match.
    const changed = diffConfig(preferenceStore.config, f)
    if (checkIsNeedRestart(changed)) {
      const ok = await new Promise<boolean>((resolve) => {
        dialog.info({
          title: t('preferences.engine-restart-title'),
          content: t('preferences.engine-restart-confirm'),
          positiveText: t('preferences.engine-restart-now'),
          negativeText: t('app.cancel'),
          maskClosable: false,
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!ok) return false
    }

    // Gate: extension API port change confirmation.
    // Separate from engine restart — this only rebinds the HTTP API server,
    // downloads are unaffected.
    if (changed.extensionApiPort !== undefined) {
      const ok = await new Promise<boolean>((resolve) => {
        dialog.warning({
          title: t('preferences.extension-api-port'),
          content: t('preferences.extension-api-port-confirm', { port: f.extensionApiPort }),
          positiveText: t('app.confirm'),
          negativeText: t('app.cancel'),
          maskClosable: false,
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!ok) return false
    }

    return true
  },
  afterSave: async (f, prevConfig) => {
    const changed = diffConfig(prevConfig, f)

    // Engine restart — user already confirmed in beforeSave, execute immediately.
    if (checkIsNeedRestart(changed)) {
      const port = f.rpcListenPort || ENGINE_RPC_PORT
      const secret = f.rpcSecret || ''
      message.info(t('preferences.engine-restarting'))
      await nextTick()
      await new Promise((r) => requestAnimationFrame(r))
      await restartEngine({ port, secret })
    }

    // Motrix log level changes need a full app relaunch,
    // because tauri-plugin-log is configured at process startup.
    if (changed.logLevel !== undefined && changed.logLevel !== prevConfig.logLevel) {
      dialog.info({
        title: t('preferences.restart-required'),
        content: t('preferences.log-level-restart-confirm'),
        positiveText: t('preferences.restart-now'),
        negativeText: t('preferences.engine-restart-later'),
        maskClosable: false,
        onPositiveClick: async () => {
          await invoke('stop_engine_command')
          await relaunch()
        },
      })
    }

    // WebKitGTK rendering variables are read at process startup.
    if (changed.hardwareRendering !== undefined && changed.hardwareRendering !== prevConfig.hardwareRendering) {
      dialog.info({
        title: t('preferences.restart-required'),
        content: t('preferences.hardware-rendering-restart-confirm'),
        positiveText: t('preferences.restart-now'),
        negativeText: t('preferences.engine-restart-later'),
        maskClosable: false,
        onPositiveClick: async () => {
          await invoke('stop_engine_command')
          await relaunch()
        },
      })
    }

    // Extension API port — user already confirmed in beforeSave, execute immediately.
    if (changed.extensionApiPort !== undefined) {
      const newPort = f.extensionApiPort
      try {
        const appliedPort = await invoke<number>('restart_http_api', { port: newPort })
        if (appliedPort !== newPort) {
          f.extensionApiPort = appliedPort
          preferenceStore.updatePreference({ extensionApiPort: appliedPort })
          resetSnapshot()
        }
        message.success(t('preferences.extension-api-port-applied', { port: appliedPort }))
      } catch (e) {
        logger.warn('Advanced.extensionApi', `restart_http_api port=${newPort} failed: ${e}`)
      }
    }

    // Preference store refreshes RuntimeConfig fire-and-forget; await so the
    // ffmpeg probe reads the path that was just persisted.
    try {
      await invoke('refresh_runtime_config')
    } catch (e) {
      logger.warn('Advanced.refreshRuntimeConfig', `refresh_runtime_config failed: ${e}`)
    }
    await refreshFfmpegStatus()
  },
})

function buildForm() {
  return buildAdvancedForm(preferenceStore.config).form
}

function loadForm() {
  Object.assign(form.value, buildForm())
}

async function handleProtocolToggle(protocol: ProtocolKey, enabled: boolean) {
  await protocolHandlers.setProtocolEnabled(protocol, enabled)
}

async function loadPaths() {
  try {
    aria2ConfPath.value = await invoke<string>('get_engine_conf_path')
  } catch (e) {
    aria2ConfPath.value = ''
    logger.debug('Advanced.loadConf', e)
  }
  try {
    const dataDir = await appDataDir()
    sessionPath.value = await join(dataDir, 'download.session')
  } catch (e) {
    logger.debug('Advanced.loadPaths', e)
  }
  try {
    const logDir = await appLogDir()
    logPath.value = await join(logDir, 'motrix-next.log')
  } catch (e) {
    logger.debug('Advanced.loadLogPath', e)
  }
  try {
    defaultTempPath.value = await tempDir()
  } catch (e) {
    logger.debug('Advanced.loadTempPath', e)
  }
}

function onRpcPortDice() {
  form.value.rpcListenPort = randomRpcPort()
}

function onRpcSecretDice() {
  form.value.rpcSecret = generateSecret()
}

function onApiSecretDice() {
  form.value.extensionApiSecret = generateSecret()
}

async function copyToClipboard(text: string, label: string) {
  if (!text) return
  try {
    await writeAppClipboardText(text)
    message.success(t('preferences.copied-to-clipboard', { label }))
  } catch (e) {
    logger.debug('Advanced.clipboard', `writeText failed: ${e}`)
  }
}

async function handleSelectTempDir() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (typeof selected === 'string') form.value.tempFilesDir = selected
}

function handleClearTempDir() {
  form.value.tempFilesDir = ''
}

const ffmpegDetectedPath = computed(() => ffmpegStatus.value?.path || '')

const ffmpegStatusText = computed(() => {
  const current = ffmpegStatus.value
  if (!current) return ''
  if (current.kind === 'missing') return t('preferences.ffmpeg-status-missing')
  const found = t('preferences.ffmpeg-status-found')
  return current.version ? `${found} ${current.version}` : found
})

async function handleSelectFfmpeg() {
  const selected = await openDialog({
    directory: false,
    multiple: false,
    ...(isWindows.value ? { filters: [{ name: 'ffmpeg', extensions: ['exe'] }] } : {}),
  })
  if (typeof selected === 'string') form.value.ffmpegBinaryPath = selected
}

// ─── Advanced Actions (delegated to composable) ─────────────────────

const {
  showDbBrowse,
  dbRecords,
  dbRecordsLoading,
  dbBrowseColumns,
  dbBrowsePagination,
  handleDbSorterChange,
  exportingLogs,
  exportingSettings,
  importingSettings,
  handleManualRestart: handleManualRestartAction,
  handleSessionReset,
  handleRestoreDefaults,
  handleFactoryReset,
  handleDbIntegrityCheck,
  handleDbBrowse,
  handleDbReset,
  handleExportLogs,
  handleExportSettings,
  handleImportSettings,
  handleClearLog,
  handleRevealPath,
  handleOpenConfigFolder,
} = useAdvancedActions({
  t,
  message,
  taskStore,
  historyStore,
  preferenceStore,
  form,
  buildForm,
  resetSnapshot,
})

function handleManualRestart() {
  handleManualRestartAction(form.value.rpcListenPort as number, form.value.rpcSecret as string)
}

onMounted(async () => {
  loadForm()
  resetSnapshot()
  loadPaths()
  await refreshFfmpegStatus()

  try {
    await protocolHandlers.refreshAll()
  } catch (e) {
    logger.debug('Advanced.protocolCheck', e)
  }
})

watch(protocolHandlers.lastError, (error) => {
  if (!error) return
  logger.warn(
    'Advanced.protocol',
    `Failed to ${error.enabled ? 'register' : 'unregister'} ${error.protocol}: ${error.reason}`,
  )
  if (!error.enabled && error.reason.includes('manual_change_required')) {
    message.warning(t('preferences.protocol-unregister-manual-required'))
  } else {
    message.error(t('preferences.protocol-failed', { protocol: error.protocol, reason: error.reason }))
  }
})
</script>

<template>
  <div class="preference-form-wrapper">
    <div class="preference-form-scroll">
      <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
        <NDivider title-placement="left">{{ t('preferences.extension-section') }}</NDivider>
        <NFormItem :label="t('preferences.auto-submit-from-extension')">
          <NSwitch v-model:value="form.autoSubmitFromExtension" />
        </NFormItem>
        <NCollapseTransition :show="form.autoSubmitFromExtension" class="collapse-indent">
          <NFormItem :label="t('preferences.silent-auto-submit-from-extension')">
            <NSwitch v-model:value="form.silentAutoSubmitFromExtension" />
          </NFormItem>
          <NFormItem>
            <template #label>
              <PreferenceHintLabel
                :label="t('preferences.auto-select-all-bt-files-from-extension')"
                :hint="t('preferences.auto-select-all-bt-files-from-extension-hint')"
              />
            </template>
            <NSwitch v-model:value="form.autoSelectAllBtFilesFromExtension" />
          </NFormItem>
        </NCollapseTransition>
        <NFormItem :label="t('preferences.extension-api-port')">
          <NInputNumber v-model:value="form.extensionApiPort" :min="1024" :max="65535" class="pref-port" />
        </NFormItem>
        <NFormItem :validation-status="form.extensionApiSecret ? undefined : 'warning'">
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.extension-api-secret')"
              :hint="t('preferences.extension-api-secret-tip')"
            />
          </template>
          <NInputGroup>
            <NInput
              v-model:value="form.extensionApiSecret"
              type="password"
              show-password-on="click"
              :placeholder="t('preferences.extension-api-secret')"
              class="pref-control-full"
              :status="form.extensionApiSecret ? undefined : 'warning'"
            />
            <NButton
              class="pref-icon-button"
              @click="copyToClipboard(form.extensionApiSecret, t('preferences.extension-api-secret'))"
            >
              <template #icon>
                <NIcon :size="14"><CopyOutline /></NIcon>
              </template>
            </NButton>
            <NButton class="pref-icon-button" @click="onApiSecretDice">
              <template #icon>
                <NIcon :size="14"><DiceOutline /></NIcon>
              </template>
            </NButton>
          </NInputGroup>
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.rpc') }}</NDivider>
        <NFormItem :label="t('preferences.rpc-listen-port')">
          <NInputGroup>
            <NInputNumber v-model:value="form.rpcListenPort" :min="1024" :max="65535" class="pref-port" />
            <NButton
              class="pref-icon-button"
              @click="copyToClipboard(String(form.rpcListenPort), t('preferences.rpc-listen-port'))"
            >
              <template #icon>
                <NIcon :size="14"><CopyOutline /></NIcon>
              </template>
            </NButton>
            <NButton class="pref-icon-button" @click="onRpcPortDice">
              <template #icon>
                <NIcon :size="14"><DiceOutline /></NIcon>
              </template>
            </NButton>
          </NInputGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.rpc-secret')" :validation-status="form.rpcSecret ? undefined : 'warning'">
          <NInputGroup>
            <NInput
              v-model:value="form.rpcSecret"
              type="password"
              show-password-on="click"
              :placeholder="t('preferences.rpc-secret')"
              class="pref-control-full"
              :status="form.rpcSecret ? undefined : 'warning'"
            />
            <NButton class="pref-icon-button" @click="copyToClipboard(form.rpcSecret, t('preferences.rpc-secret'))">
              <template #icon>
                <NIcon :size="14"><CopyOutline /></NIcon>
              </template>
            </NButton>
            <NButton class="pref-icon-button" @click="onRpcSecretDice">
              <template #icon>
                <NIcon :size="14"><DiceOutline /></NIcon>
              </template>
            </NButton>
          </NInputGroup>
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.engine-section') }}</NDivider>
        <NFormItem :label="t('preferences.allow-remote-access')">
          <NSwitch v-model:value="form.allowRemoteAccess" />
        </NFormItem>
        <NFormItem :label="t('preferences.temp-files-dir')">
          <NInputGroup>
            <NInput
              :value="form.tempFilesDir || defaultTempPath"
              readonly
              class="pref-control-full"
              :placeholder="defaultTempPath"
            />
            <NButton
              class="pref-icon-button"
              @click="copyToClipboard(form.tempFilesDir || defaultTempPath, t('preferences.temp-files-dir'))"
            >
              <template #icon>
                <NIcon :size="14"><CopyOutline /></NIcon>
              </template>
            </NButton>
            <NButton class="pref-icon-button" @click="handleSelectTempDir">
              <template #icon>
                <NIcon :size="14"><FolderOpenOutline /></NIcon>
              </template>
            </NButton>
            <NButton v-if="form.tempFilesDir" quaternary class="pref-icon-button" @click="handleClearTempDir">
              {{ t('preferences.ua-reset') }}
            </NButton>
          </NInputGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.aria2-conf-path')">
          <NInputGroup>
            <NInput :value="aria2ConfPath" readonly class="pref-control-full" />
            <NButton class="pref-icon-button" @click="copyToClipboard(aria2ConfPath, t('preferences.aria2-conf-path'))">
              <template #icon>
                <NIcon :size="14"><CopyOutline /></NIcon>
              </template>
            </NButton>
            <NButton class="pref-icon-button" @click="handleRevealPath(aria2ConfPath)">
              <template #icon>
                <NIcon :size="14"><FolderOpenOutline /></NIcon>
              </template>
            </NButton>
          </NInputGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.session-path')">
          <NInputGroup>
            <NInput :value="sessionPath" readonly class="pref-control-full" />
            <NButton class="pref-icon-button" @click="copyToClipboard(sessionPath, t('preferences.session-path'))">
              <template #icon>
                <NIcon :size="14"><CopyOutline /></NIcon>
              </template>
            </NButton>
            <NButton class="pref-icon-button" @click="handleRevealPath(sessionPath)">
              <template #icon>
                <NIcon :size="14"><FolderOpenOutline /></NIcon>
              </template>
            </NButton>
          </NInputGroup>
        </NFormItem>
        <NFormItem label=" ">
          <NButton type="error" ghost @click="handleSessionReset">
            {{ t('preferences.clear-all-tasks') }}
          </NButton>
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.ffmpeg-section') }}</NDivider>
        <NFormItem>
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.ffmpeg-binary-path')"
              :hint="t('preferences.ffmpeg-binary-path-tips')"
            />
          </template>
          <div class="ffmpeg-path-field">
            <NInputGroup>
              <NInput
                v-model:value="form.ffmpegBinaryPath"
                class="pref-control-full"
                :placeholder="ffmpegDetectedPath"
              />
              <NButton
                class="pref-icon-button"
                @click="
                  copyToClipboard(form.ffmpegBinaryPath || ffmpegDetectedPath, t('preferences.ffmpeg-binary-path'))
                "
              >
                <template #icon>
                  <NIcon :size="14"><CopyOutline /></NIcon>
                </template>
              </NButton>
              <NButton class="pref-icon-button" @click="handleSelectFfmpeg">
                <template #icon>
                  <NIcon :size="14"><FolderOpenOutline /></NIcon>
                </template>
              </NButton>
            </NInputGroup>
            <p v-if="ffmpegStatus" class="ffmpeg-status">{{ ffmpegStatusText }}</p>
          </div>
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.log-section') }}</NDivider>
        <NFormItem :label="t('preferences.log-path')">
          <NInputGroup>
            <NInput :value="logPath" readonly class="pref-control-full" />
            <NButton class="pref-icon-button" @click="copyToClipboard(logPath, t('preferences.log-path'))">
              <template #icon>
                <NIcon :size="14"><CopyOutline /></NIcon>
              </template>
            </NButton>
            <NButton class="pref-icon-button" @click="handleRevealPath(logPath)">
              <template #icon>
                <NIcon :size="14"><FolderOpenOutline /></NIcon>
              </template>
            </NButton>
          </NInputGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.log-level')">
          <div class="log-level-row">
            <div class="log-level-control">
              <span class="log-level-control__label">{{ t('preferences.motrix-next') }}</span>
              <NSelect
                v-model:value="form.logLevel"
                :options="appLogLevelOptions"
                class="pref-control-auto pref-control-log-level"
              />
            </div>
            <div class="log-level-control">
              <span class="log-level-control__label">{{ t('preferences.aria2-next') }}</span>
              <NSelect
                v-model:value="form.aria2LogLevel"
                :options="aria2LogLevelOptions"
                class="pref-control-auto pref-control-log-level"
              />
            </div>
          </div>
        </NFormItem>
        <NFormItem label=" ">
          <div class="log-action-row">
            <NButton type="primary" ghost :loading="exportingLogs" @click="handleExportLogs">
              <template #icon>
                <NIcon><DownloadOutline /></NIcon>
              </template>
              {{ t('preferences.export-diagnostic-logs') }}
            </NButton>
            <NButton type="error" ghost @click="handleClearLog">
              <template #icon>
                <NIcon><TrashOutline /></NIcon>
              </template>
              {{ t('preferences.clear-log') }}
            </NButton>
          </div>
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.maintenance-section') }}</NDivider>
        <NFormItem v-if="isLinux">
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.hardware-rendering')"
              :hint="t('preferences.hardware-rendering-hint')"
            />
          </template>
          <NSwitch v-model:value="form.hardwareRendering" />
        </NFormItem>
        <NFormItem :label="t('preferences.history-section')">
          <NSpace>
            <NButton class="db-integrity-check-btn" @click="handleDbIntegrityCheck">
              {{ t('preferences.db-integrity-check') }}
            </NButton>
            <NButton class="db-browse-btn" @click="handleDbBrowse">
              {{ t('preferences.db-browse') }}
            </NButton>
            <NButton type="error" ghost @click="handleDbReset">
              {{ t('preferences.db-reset') }}
            </NButton>
          </NSpace>
        </NFormItem>

        <NFormItem :label="t('preferences.configuration-section')">
          <NSpace>
            <NButton class="open-config-folder-btn" @click="handleOpenConfigFolder">
              <template #icon>
                <NIcon :size="14"><FolderOpenOutline /></NIcon>
              </template>
              {{ t('preferences.open-config-folder') }}
            </NButton>
            <NButton type="error" ghost @click="handleRestoreDefaults">
              {{ t('preferences.restore-defaults') }}
            </NButton>
            <NButton type="error" ghost @click="handleFactoryReset">
              {{ t('preferences.factory-reset') }}
            </NButton>
          </NSpace>
        </NFormItem>
        <NFormItem :label="t('preferences.settings-backup')">
          <div class="settings-backup-row">
            <NSpace>
              <NButton type="primary" ghost :loading="exportingSettings" @click="handleExportSettings">
                <template #icon>
                  <NIcon><CloudDownloadOutline /></NIcon>
                </template>
                {{ t('preferences.export-settings') }}
              </NButton>
              <NButton type="warning" ghost :loading="importingSettings" @click="handleImportSettings">
                <template #icon>
                  <NIcon><CloudUploadOutline /></NIcon>
                </template>
                {{ t('preferences.import-settings') }}
              </NButton>
            </NSpace>
          </div>
        </NFormItem>

        <!-- Clipboard Detection (migrated from Basic) -->
        <NDivider title-placement="left">{{ t('preferences.clipboard-detection') }}</NDivider>
        <NFormItem>
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.clipboard-auto-detect')"
              :hint="t('preferences.clipboard-filter-hint')"
            />
          </template>
          <NSwitch v-model:value="form.clipboardEnable" />
        </NFormItem>
        <NCollapseTransition :show="form.clipboardEnable">
          <NFormItem label=" ">
            <PreferenceCheckboxGrid v-model:value="selectedClipboardTypes" :options="clipboardTypeOptions" />
          </NFormItem>
        </NCollapseTransition>

        <!-- Default Programs (migrated from Basic) -->
        <NDivider title-placement="left">{{ t('preferences.default-programs') }}</NDivider>
        <NFormItem :label="t('preferences.protocol-magnet')">
          <NSwitch
            :value="protocolStatus.magnet"
            :loading="protocolPending === 'magnet'"
            @update:value="(value) => handleProtocolToggle('magnet', value)"
          />
        </NFormItem>
        <NFormItem :label="t('preferences.protocol-ed2k')">
          <NSwitch
            :value="protocolStatus.ed2k"
            :loading="protocolPending === 'ed2k'"
            @update:value="(value) => handleProtocolToggle('ed2k', value)"
          />
        </NFormItem>
        <NFormItem :label="t('preferences.protocol-thunder')">
          <NSwitch
            :value="protocolStatus.thunder"
            :loading="protocolPending === 'thunder'"
            @update:value="(value) => handleProtocolToggle('thunder', value)"
          />
        </NFormItem>
        <NFormItem :label="t('preferences.protocol-motrixnext')">
          <NSwitch
            :value="protocolStatus.motrixnext"
            :loading="protocolPending === 'motrixnext'"
            @update:value="(value) => handleProtocolToggle('motrixnext', value)"
          />
        </NFormItem>
      </NForm>
    </div>

    <!-- Database records viewer modal -->
    <NModal v-model:show="showDbBrowse" :mask-closable="true" transform-origin="center">
      <NCard
        :title="t('preferences.db-browse-title')"
        closable
        class="db-record-modal"
        :bordered="false"
        @close="showDbBrowse = false"
      >
        <NDataTable
          :columns="dbBrowseColumns"
          :data="dbRecords"
          :loading="dbRecordsLoading"
          remote
          :pagination="dbBrowsePagination"
          :max-height="420"
          :scroll-x="700"
          size="small"
          striped
          @update:sorter="handleDbSorterChange"
        >
          <template #empty>
            <NEmpty :description="t('preferences.db-record-count', { count: 0 })" />
          </template>
        </NDataTable>
      </NCard>
    </NModal>
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" @restart="handleManualRestart" />
  </div>
</template>

<style scoped>
.info-link {
  color: var(--m3-primary);
  text-decoration: none;
  font-size: 12px;
}
.info-link:hover {
  text-decoration: underline;
}
.action-link {
  color: var(--m3-primary);
  cursor: pointer;
  margin-left: 8px;
  font-size: 12px;
}
.action-link:hover {
  text-decoration: underline;
}
.log-level-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  width: 100%;
}
.db-record-modal {
  width: min(760px, calc(100vw - 96px));
  max-height: min(620px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
}
.db-record-modal :deep(.n-card__content) {
  min-height: 0;
  overflow: hidden;
}
.log-level-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pref-control-log-level {
  min-width: 100px;
}
.log-level-control__label {
  color: var(--m3-on-surface);
  font-size: 13px;
  white-space: nowrap;
}
.log-action-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  width: 100%;
}
.settings-backup-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  width: 100%;
}

/* ── UA preset row — button group + standalone reset ─────────────── */
.ua-preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* ── UA field wrapper — stacks textarea + warning within same NFormItem ── */
.ua-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* ── UA warning — CSS Grid 0fr→1fr slide-in, matches proxy-collapse ── */
.ua-warn-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-warn-collapse--open {
  grid-template-rows: 1fr;
}
.ua-warn-collapse__inner {
  overflow: hidden;
}
.ua-warn-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-top: 6px;
  border-radius: var(--border-radius);
  background: var(--m3-error-container);
  opacity: 0;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.ua-warn-collapse--open .ua-warn-bar {
  opacity: 1;
}
.ua-warn-text {
  font-size: var(--font-size-sm);
  color: var(--m3-on-error-container);
  flex: 1;
}

/* ── Proxy collapse — CSS Grid 0fr→1fr for glitch-free height:auto ── */
.proxy-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.proxy-collapse--open {
  grid-template-rows: 1fr;
}
.proxy-collapse__inner {
  overflow: hidden;
}
.ffmpeg-path-field {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 6px;
}
.ffmpeg-status {
  margin: 0;
  font-size: 12px;
  color: var(--m3-on-surface-variant);
}
</style>
