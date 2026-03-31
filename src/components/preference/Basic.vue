<script setup lang="ts">
/** @fileoverview Basic preference form: theme, locale, download dir, speed limits. */
import { ref, computed, watch, onMounted, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { relaunch } from '@tauri-apps/plugin-process'
import { useIpc } from '@/composables/useIpc'
import { platform, arch as osArch, version as osVersion } from '@tauri-apps/plugin-os'
import { getVersion as getAppVersion } from '@tauri-apps/api/app'
import { getVersion as getAria2Version } from '@/api/aria2'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { downloadDir } from '@tauri-apps/api/path'
import { extractSpeedUnit } from '@shared/utils'
import { logger } from '@shared/logger'
import {
  ENGINE_RPC_PORT,
  ENGINE_MAX_CONNECTION_PER_SERVER,
  ENGINE_MAX_BT_MAX_PEERS,
  SAFE_LIMIT_SPLIT,
  SAFE_LIMIT_CONNECTION_PER_SERVER,
  SAFE_LIMIT_BT_MAX_PEERS,
  COLOR_SCHEMES,
} from '@shared/constants'
import { useAppMessage } from '@/composables/useAppMessage'
import { buildBasicForm, buildBasicSystemConfig, transformBasicForStore } from '@/composables/useBasicPreference'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NSwitch,
  NButton,
  NDivider,
  NInputGroup,
  NText,
  NCollapseTransition,
  NTag,
  NSpace,
  NRadioGroup,
  NRadioButton,
  useDialog,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import MTooltip from '@/components/common/MTooltip.vue'
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

// ─── System info card ────────────────────────────────────────────────
const sysArch = ref('')
const sysOsVersion = ref('')
const sysAppVersion = ref('')
const sysAria2Version = ref('')
const archLabel = computed(() => {
  if (currentPlatform.value === 'macos') {
    return sysArch.value === 'aarch64' ? 'Apple Silicon' : 'Intel'
  }
  const map: Record<string, string> = { aarch64: 'ARM64', x86_64: 'x64', x86: 'x86' }
  return map[sysArch.value] || sysArch.value
})

async function copyVersionToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('about.version-copied', { label }))
  } catch {
    /* Clipboard API may fail in some contexts — silently ignore. */
  }
}
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

// ── Safe-limit warning configuration ────────────────────────────────
// Declarative config: fields that exceed their safe threshold are collected
// and presented in a single merged warning dialog before save.
const safeLimits = [
  {
    field: 'split' as const,
    safe: SAFE_LIMIT_SPLIT,
    labelKey: 'preferences.split-count',
    reasonKey: 'preferences.high-split-reason',
  },
  {
    field: 'maxConnectionPerServer' as const,
    safe: SAFE_LIMIT_CONNECTION_PER_SERVER,
    labelKey: 'preferences.max-connection-per-server',
    reasonKey: 'preferences.high-connection-reason',
  },
  {
    field: 'btMaxPeers' as const,
    safe: SAFE_LIMIT_BT_MAX_PEERS,
    labelKey: 'preferences.bt-max-peers',
    reasonKey: 'preferences.high-bt-peers-reason',
  },
]

/**
 * Builds a merged warning VNode listing all exceeded fields,
 * each with its current value, recommended limit, and risk reason.
 * Uses Vue h() because Naive UI dialog.content renders strings as plain text
 * without line break support.
 */
function buildSafeLimitContent(f: Record<string, unknown>, exceeded: typeof safeLimits) {
  return h(
    'div',
    { style: 'display: flex; flex-direction: column; gap: 12px' },
    exceeded.map((e) => {
      const current = f[e.field] as number
      return h('div', [
        h(
          'div',
          { style: 'font-weight: 500' },
          `• ${t(e.labelKey)}: ${current} (${t('preferences.recommended-limit', { value: e.safe })})`,
        ),
        h('div', { style: 'padding-left: 14px; opacity: 0.75' }, t(e.reasonKey)),
      ])
    }),
  )
}

/**
 * Shows a single merged warning dialog for all exceeded fields.
 * On cancel, all exceeded fields revert to their safe values atomically.
 */
function confirmSafeLimits(f: Record<string, unknown>, exceeded: typeof safeLimits): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const revert = () => {
      for (const e of exceeded) f[e.field] = e.safe
      resolve(false)
    }
    dialog.warning({
      title: t('preferences.safe-limit-warning-title'),
      content: () => buildSafeLimitContent(f, exceeded),
      positiveText: t('preferences.high-connection-continue'),
      negativeText: t('app.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: revert,
      onClose: revert,
    })
  })
}

const { form, isDirty, handleSave, handleReset, resetSnapshot, patchSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildBasicSystemConfig,
  transformForStore: transformBasicForStore,
  beforeSave: async (f) => {
    // Collect all fields exceeding their safe threshold, show one merged dialog
    const exceeded = safeLimits.filter((e) => {
      const v = f[e.field as string]
      return typeof v === 'number' && v > e.safe
    })
    if (exceeded.length > 0) {
      return confirmSafeLimits(f, exceeded)
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

// ── Instant color‑scheme application ─────────────────────────────────
// Color scheme is a purely visual preference that benefits from instant
// feedback. Persist directly to the store on click — no Save & Apply needed.
// The snapshot is also patched so isDirty stays false for this field.
watch(
  () => form.value.colorScheme,
  (newId, oldId) => {
    if (!newId || newId === oldId) return
    preferenceStore.updateAndSave({ colorScheme: newId })
    patchSnapshot({ colorScheme: newId } as Partial<typeof form.value>)
    const scheme = COLOR_SCHEMES.find((s) => s.id === newId)
    if (scheme) {
      message.success(t('preferences.color-scheme-switched', { name: t(scheme.labelKey) }))
    }
  },
)

// ── Instant theme (appearance) application ───────────────────────────
// Theme is also a purely visual preference — apply immediately.
watch(
  () => form.value.theme,
  (newTheme, oldTheme) => {
    if (!newTheme || newTheme === oldTheme) return
    preferenceStore.updateAndSave({ theme: newTheme as 'auto' | 'light' | 'dark' })
    patchSnapshot({ theme: newTheme } as Partial<typeof form.value>)
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

/**
 * Register/unregister a protocol handler immediately when the user toggles.
 * Operates independently of the form save flow — protocol registration
 * is an OS-level side-effect, not an aria2 config change.
 * On failure the switch reverts to its previous state.
 */
async function onProtocolToggle(protocol: string, enabled: boolean) {
  try {
    const { register, unregister } = await import('@tauri-apps/plugin-deep-link')
    if (enabled) {
      await register(protocol)
    } else {
      await unregister(protocol)
    }
    message.success(t(enabled ? 'preferences.protocol-registered' : 'preferences.protocol-unregistered', { protocol }))
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    logger.warn('Basic.protocol', `Failed to ${enabled ? 'register' : 'unregister'} ${protocol}: ${reason}`)
    message.error(t('preferences.protocol-failed', { protocol, reason }))
    // Revert switch on failure
    if (protocol === 'magnet') form.value.protocolMagnet = !enabled
    else form.value.protocolThunder = !enabled
  }
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
  try {
    sysArch.value = osArch()
  } catch (e) {
    logger.debug('Basic.arch', e)
  }
  try {
    sysOsVersion.value = osVersion()
  } catch (e) {
    logger.debug('Basic.osVersion', e)
  }
  try {
    sysAppVersion.value = await getAppVersion()
  } catch (e) {
    logger.debug('Basic.appVersion', e)
  }
  try {
    const info = await getAria2Version()
    sysAria2Version.value = info.version
  } catch (e) {
    logger.debug('Basic.aria2Version', e)
  }
  loadForm()
  resetSnapshot()

  // Read actual OS registration state for protocol toggles (Windows/Linux).
  // This ensures the switches reflect reality even if another app has taken
  // over the protocol association since Motrix last ran.
  if (currentPlatform.value && currentPlatform.value !== 'macos') {
    try {
      const { isRegistered } = await import('@tauri-apps/plugin-deep-link')
      form.value.protocolMagnet = await isRegistered('magnet')
      form.value.protocolThunder = await isRegistered('thunder')
    } catch (e) {
      logger.debug('Basic.protocolCheck', e)
    }
  }
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
      <!-- System info — About-panel badge style -->
      <NDivider title-placement="left">{{ t('preferences.system-info') }}</NDivider>
      <NFormItem :label="t('preferences.detected-platform')">
        <NSpace :size="8">
          <NTag type="info" round size="medium">{{ platformLabel }}</NTag>
          <NTag type="success" round size="medium">{{ archLabel }}</NTag>
        </NSpace>
      </NFormItem>
      <NFormItem :label="t('about.app-version')">
        <button
          class="sysinfo-ver-badge"
          :title="t('about.click-to-copy')"
          @click="copyVersionToClipboard(`Motrix Next v${sysAppVersion}`, 'Motrix Next')"
        >
          <span class="sysinfo-ver-value">v{{ sysAppVersion || '\u2014' }}</span>
          <svg class="sysinfo-ver-copy" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
      </NFormItem>
      <NFormItem :label="t('about.aria2-version')">
        <button
          v-if="sysAria2Version"
          class="sysinfo-ver-badge"
          :title="t('about.click-to-copy')"
          @click="copyVersionToClipboard(`aria2 v${sysAria2Version}`, 'aria2')"
        >
          <span class="sysinfo-ver-value">v{{ sysAria2Version }}</span>
          <svg class="sysinfo-ver-copy" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
        <div v-else class="sysinfo-ver-badge sysinfo-ver-badge--muted">
          <span class="sysinfo-ver-muted">{{ t('about.unavailable') }}</span>
        </div>
      </NFormItem>
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
      <NCollapseTransition :show="form.autoCheckUpdate" class="collapse-indent">
        <NFormItem :label="t('preferences.check-frequency')">
          <NSelect v-model:value="form.autoCheckUpdateInterval" :options="checkIntervalOptions" style="width: 180px" />
        </NFormItem>
      </NCollapseTransition>
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
      <NFormItem :label="t('preferences.appearance')">
        <NSelect v-model:value="form.theme" :options="themeOptions" style="width: 200px" />
      </NFormItem>

      <!-- ── Color Scheme Picker ────────────────────────────────── -->
      <NFormItem :label="t('preferences.color-scheme')">
        <div class="color-scheme-picker">
          <MTooltip v-for="scheme in COLOR_SCHEMES" :key="scheme.id">
            <template #trigger>
              <button
                class="color-swatch"
                :class="{ active: form.colorScheme === scheme.id }"
                :style="{ '--swatch-color': scheme.seed }"
                @click="form.colorScheme = scheme.id"
              >
                <svg v-if="form.colorScheme === scheme.id" class="swatch-check" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4 8.5L6.5 11L12 5"
                    stroke="white"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </template>
            {{ t(scheme.labelKey) }}
          </MTooltip>
        </div>
      </NFormItem>
      <NFormItem v-if="isMacOrWin" :label="t('preferences.show-progress-bar')">
        <NSwitch v-model:value="form.showProgressBar" />
      </NFormItem>

      <NFormItem v-if="isMac" :label="t('preferences.dock-badge-speed')">
        <NSwitch v-model:value="form.dockBadgeSpeed" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.window-and-tray') }}</NDivider>
      <NFormItem :label="t('preferences.minimize-to-tray-on-close')">
        <NSwitch v-model:value="form.minimizeToTrayOnClose" />
      </NFormItem>
      <NFormItem v-if="isMac" :label="t('preferences.hide-dock-on-minimize')">
        <NSwitch v-model:value="form.hideDockOnMinimize" />
      </NFormItem>
      <NFormItem v-if="isMacOrLinux" :label="t('preferences.tray-speedometer')">
        <NSwitch v-model:value="form.traySpeedometer" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.startup') }}</NDivider>
      <NFormItem :label="t('preferences.open-at-login')">
        <NSwitch v-model:value="form.openAtLogin" />
      </NFormItem>
      <NCollapseTransition :show="form.openAtLogin" class="collapse-indent">
        <NFormItem :label="t('preferences.auto-hide-window')">
          <NSwitch v-model:value="form.autoHideWindow" />
        </NFormItem>
      </NCollapseTransition>
      <NFormItem :label="t('preferences.keep-window-state')">
        <NSwitch v-model:value="form.keepWindowState" />
      </NFormItem>
      <NFormItem :label="t('preferences.auto-resume-all')">
        <NSwitch v-model:value="form.resumeAllWhenAppLaunched" />
      </NFormItem>

      <!-- ── Protocol Handlers (Windows/Linux only) ────────────────── -->
      <template v-if="!isMac">
        <NDivider title-placement="left">{{ t('preferences.protocol-handler') }}</NDivider>
        <NFormItem :label="t('preferences.protocol-magnet')">
          <NSwitch v-model:value="form.protocolMagnet" @update:value="onProtocolToggle('magnet', $event)" />
        </NFormItem>
        <NFormItem :label="t('preferences.protocol-thunder')">
          <NSwitch v-model:value="form.protocolThunder" @update:value="onProtocolToggle('thunder', $event)" />
        </NFormItem>
      </template>

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
      <NFormItem :label="t('preferences.bt-auto-download-content')">
        <NSwitch v-model:value="form.btAutoDownloadContent" />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-force-encryption')">
        <NSwitch v-model:value="form.btForceEncryption" />
      </NFormItem>
      <NFormItem :label="t('preferences.keep-seeding')">
        <NSwitch v-model:value="form.keepSeeding" @update:value="onKeepSeedingChange" />
      </NFormItem>

      <NCollapseTransition :show="!form.keepSeeding" class="collapse-indent">
        <NFormItem :label="t('preferences.seed-ratio')">
          <NInputNumber v-model:value="form.seedRatio" :min="1" :max="100" :step="0.1" style="width: 120px" />
        </NFormItem>
        <NFormItem :label="t('preferences.seed-time') + ' (' + t('preferences.seed-time-unit') + ')'">
          <NInputNumber v-model:value="form.seedTime" :min="60" :max="525600" style="width: 120px" />
        </NFormItem>
      </NCollapseTransition>

      <NDivider title-placement="left">{{ t('preferences.task-manage') }}</NDivider>
      <NFormItem :label="t('preferences.max-concurrent-downloads')">
        <NInputNumber v-model:value="form.maxConcurrentDownloads" :min="1" :max="10" style="width: 120px" />
      </NFormItem>
      <NFormItem :label="t('preferences.split-count')">
        <NInputNumber
          v-model:value="form.split"
          :min="1"
          :max="ENGINE_MAX_CONNECTION_PER_SERVER"
          style="width: 120px"
        />
      </NFormItem>
      <NFormItem :label="t('preferences.max-connection-per-server')">
        <NInputNumber
          v-model:value="form.maxConnectionPerServer"
          :min="1"
          :max="ENGINE_MAX_CONNECTION_PER_SERVER"
          style="width: 120px"
        />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-max-peers')">
        <NInputNumber v-model:value="form.btMaxPeers" :min="1" :max="ENGINE_MAX_BT_MAX_PEERS" style="width: 120px" />
      </NFormItem>
      <NFormItem :label="t('preferences.continue')">
        <NSwitch v-model:value="form.continue" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.notification-and-confirm') }}</NDivider>
      <NFormItem :label="t('preferences.new-task-show-downloading')">
        <NSwitch v-model:value="form.newTaskShowDownloading" />
      </NFormItem>
      <NFormItem :label="t('preferences.task-completed-notify')">
        <NSwitch v-model:value="form.taskNotification" />
      </NFormItem>
      <NFormItem :label="t('preferences.no-confirm-before-delete-task')">
        <NSwitch v-model:value="form.noConfirmBeforeDeleteTask" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.auto-cleanup') }}</NDivider>
      <NFormItem :label="t('preferences.delete-torrent-after-complete')">
        <NSwitch v-model:value="form.deleteTorrentAfterComplete" />
      </NFormItem>
      <NFormItem :label="t('preferences.auto-delete-stale-records')">
        <NSwitch v-model:value="form.autoDeleteStaleRecords" />
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.clipboard-detection') }}</NDivider>
      <NFormItem :label="t('preferences.clipboard-auto-detect')">
        <NSwitch v-model:value="form.clipboardEnable" />
      </NFormItem>
      <NCollapseTransition :show="form.clipboardEnable" class="collapse-indent">
        <NFormItem :label="t('preferences.clipboard-http')">
          <NSwitch v-model:value="form.clipboardHttp" />
        </NFormItem>
        <NFormItem :label="t('preferences.clipboard-ftp')">
          <NSwitch v-model:value="form.clipboardFtp" />
        </NFormItem>
        <NFormItem :label="t('preferences.clipboard-magnet')">
          <NSwitch v-model:value="form.clipboardMagnet" />
        </NFormItem>
        <NFormItem :label="t('preferences.clipboard-thunder')">
          <NSwitch v-model:value="form.clipboardThunder" />
        </NFormItem>
        <NFormItem :label="t('preferences.clipboard-bt-hash')">
          <NSwitch v-model:value="form.clipboardBtHash" />
        </NFormItem>
      </NCollapseTransition>
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
  overflow-x: hidden;
  padding: 16px 30px 64px 36px;
}
.form-preference :deep(.n-form-item) {
  padding-left: 50px;
}
.form-actions {
  padding: 16px 24px 16px 40px;
}

/* ── System info version badge (matches About panel) ─────────────── */
.sysinfo-ver-badge {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--m3-outline-variant, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  background: var(--about-card-bg, rgba(255, 255, 255, 0.03));
  cursor: pointer;
  transition: var(--transition-all, 0.2s ease);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
}
.sysinfo-ver-badge:hover {
  border-color: var(--color-primary);
  background: var(--about-card-hover-bg, rgba(255, 255, 255, 0.06));
}
.sysinfo-ver-badge:hover .sysinfo-ver-copy {
  opacity: 0.7;
}
.sysinfo-ver-badge:active {
  transform: scale(0.97);
}
.sysinfo-ver-value {
  font-size: 13px;
  font-weight: 520;
  color: var(--m3-on-surface, rgba(255, 255, 255, 0.9));
  letter-spacing: 0.3px;
}
.sysinfo-ver-copy {
  opacity: 0.35;
  margin-left: auto;
  color: var(--m3-on-surface-variant, rgba(255, 255, 255, 0.5));
  transition: var(--transition-all, 0.2s ease);
  flex-shrink: 0;
}
.sysinfo-ver-badge--muted {
  cursor: default;
}
.sysinfo-ver-badge--muted:hover {
  border-color: var(--m3-outline-variant, rgba(255, 255, 255, 0.08));
  background: var(--about-card-bg, rgba(255, 255, 255, 0.03));
}
.sysinfo-ver-muted {
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-outline, rgba(255, 255, 255, 0.38));
  letter-spacing: 0.3px;
}

/* ── Collapse indent: subordinate toggle hierarchy indicator ──────── */
.form-preference :deep(.collapse-indent) {
  position: relative;
  margin-left: 16px;
}

/* ── Color Scheme Swatch Picker ───────────────────────────────────── */
.color-scheme-picker {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.color-swatch {
  position: relative;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid transparent;
  background: var(--swatch-color);
  cursor: pointer;
  transition:
    transform 0.2s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.2s cubic-bezier(0.2, 0, 0, 1),
    box-shadow 0.2s cubic-bezier(0.2, 0, 0, 1);
  display: flex;
  align-items: center;
  justify-content: center;
  outline: none;
  padding: 0;
}
.color-swatch:hover {
  transform: scale(1.18);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}
.color-swatch:active {
  transform: scale(1.05);
}
.color-swatch.active {
  border-color: var(--m3-on-surface, #fff);
  box-shadow:
    0 0 0 2px var(--swatch-color),
    0 2px 8px rgba(0, 0, 0, 0.25);
}
.swatch-check {
  width: 14px;
  height: 14px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}
</style>
