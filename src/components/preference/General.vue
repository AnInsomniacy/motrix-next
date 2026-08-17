<script setup lang="ts">
/** @fileoverview General preference tab: system info, language, update, appearance, startup & tray. */
import { ref, computed, watch, onMounted, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { invoke } from '@tauri-apps/api/core'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { relaunch } from '@tauri-apps/plugin-process'
import { arch as osArch, version as osVersion } from '@tauri-apps/plugin-os'
import { usePlatform } from '@/composables/usePlatform'
import { getVersion as getAppVersion } from '@tauri-apps/api/app'
import { getVersion as getAria2Version } from '@/api/aria2'
import { locale as getOsLocale } from '@tauri-apps/plugin-os'
import { resolveSystemLocale } from '@shared/utils/locale'
import { SUPPORTED_LOCALES, loadLocale } from '@/composables/useLocale'
import { logger } from '@shared/logger'
import { writeAppClipboardText } from '@shared/utils'
import {
  buildGeneralForm,
  buildGeneralSystemConfig,
  transformGeneralForStore,
} from '@/composables/useGeneralPreference'
import { COLOR_SCHEMES, CUSTOM_COLOR_SCHEME_ID, ENGINE_RPC_PORT } from '@shared/constants'
import { normalizeCustomColorScheme } from '@shared/utils/colorSchemeConfig'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  NForm,
  NFormItem,
  NSelect,
  NSwitch,
  NButton,
  NDivider,
  NText,
  NCollapseTransition,
  NSpace,
  NTag,
  NRadioGroup,
  NRadioButton,
  NColorPicker,
  NIcon,
  useDialog,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import MTooltip from '@/components/common/MTooltip.vue'
import { CloudDownloadOutline } from '@vicons/ionicons5'
import UpdateDialog from '@/components/preference/UpdateDialog.vue'
import type { UpdateChannel } from '@shared/types'
import PreferenceHintLabel from './PreferenceHintLabel.vue'

const { t, locale } = useI18n()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()
const { isMac, isLinux, isMobile, platformLabel, archLabel: getArchLabel } = usePlatform()

// ─── System info card ────────────────────────────────────────────────
const sysArch = ref('')
const sysOsVersion = ref('')
const sysAppVersion = ref('')
const sysAria2Version = ref('')
const detectedLocaleCode = ref('en-US')
const archLabelDisplay = computed(() => getArchLabel(sysArch.value))

async function copyVersionToClipboard(text: string, label: string) {
  try {
    await writeAppClipboardText(text)
    message.success(t('about.version-copied', { label }))
  } catch (e) {
    logger.debug('General.clipboard', `writeText failed: ${e}`)
  }
}
const updateDialogRef = ref<InstanceType<typeof UpdateDialog> | null>(null)

const checkIntervalOptions = [
  { label: t('preferences.interval-every-startup'), value: 0 },
  { label: t('preferences.interval-daily'), value: 24 },
  { label: t('preferences.interval-weekly'), value: 168 },
  { label: t('preferences.interval-monthly'), value: 720 },
  { label: t('preferences.interval-semi-annual'), value: 4320 },
  { label: t('preferences.interval-yearly'), value: 8760 },
]

const CUSTOM_COLOR_SWATCHES = ['#F59E0B', '#2563EB', '#14B8A6', '#DC2626', '#9333EA', '#4B5563']

function buildForm() {
  return buildGeneralForm(preferenceStore.config)
}

const { form, isDirty, handleSave, handleReset, patchSnapshot, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildGeneralSystemConfig,
  transformForStore: transformGeneralForStore,
  afterSave: async (f, prevConfig) => {
    // Locale change → restart prompt
    const prevLocale = prevConfig.locale || 'auto'
    if (f.locale !== prevLocale) {
      // Determine the actual target locale for bilingual dialog rendering.
      const targetLocale = f.locale === 'auto' ? detectedLocaleCode.value || 'en-US' : f.locale
      const isEn = targetLocale === 'en-US'
      // Locale messages are lazy-loaded — pull in the target locale so the
      // dialog can render in it (falls back to English if loading fails).
      if (!isEn) await loadLocale(targetLocale)
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
          await invoke('stop_engine_command')
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
        logger.error('General.autostart', e)
      }
    }
  },
})

// Note: the legacy one-shot locale sync watcher has been removed.
// With 'auto' as an explicit option, there is no async race condition
// to handle — the form correctly initialises with 'auto' from config.

// ── Instant color-scheme application ─────────────────────────────────
function handlePresetColorScheme(scheme: (typeof COLOR_SCHEMES)[number]): void {
  if (form.value.colorScheme === scheme.id) return

  form.value.colorScheme = scheme.id
  preferenceStore.updateAndSave({ colorScheme: scheme.id, customColorScheme: form.value.customColorScheme })
  patchSnapshot({ colorScheme: scheme.id } as Partial<typeof form.value>)
  message.success(t('preferences.color-scheme-switched', { name: t(scheme.labelKey) }))
}

async function handleCustomColorChange(value: string | null): Promise<void> {
  const color = normalizeCustomColorScheme(value)
  if (form.value.colorScheme === CUSTOM_COLOR_SCHEME_ID && form.value.customColorScheme === color) return

  form.value.customColorScheme = color
  form.value.colorScheme = CUSTOM_COLOR_SCHEME_ID
  patchSnapshot({ colorScheme: CUSTOM_COLOR_SCHEME_ID, customColorScheme: color } as Partial<typeof form.value>)
  await preferenceStore.updateAndSave({ colorScheme: CUSTOM_COLOR_SCHEME_ID, customColorScheme: color })
}

function handleCustomColorComplete(value: string): void {
  const color = normalizeCustomColorScheme(value)
  message.success(t('preferences.color-scheme-switched', { name: color }))
}

// ── Instant theme application ────────────────────────────────────────
watch(
  () => form.value.theme,
  (newTheme, oldTheme) => {
    if (!newTheme || newTheme === oldTheme) return
    preferenceStore.updateAndSave({ theme: newTheme as 'auto' | 'light' | 'dark' })
    patchSnapshot({ theme: newTheme } as Partial<typeof form.value>)
  },
)

// ── Lightweight mode ↔ Minimize-to-tray linkage ─────────────────────
watch(
  () => form.value.lightweightMode,
  (enabled) => {
    if (enabled && !form.value.minimizeToTrayOnClose) {
      form.value.minimizeToTrayOnClose = true
    }
  },
)
watch(
  () => form.value.minimizeToTrayOnClose,
  (enabled) => {
    if (!enabled && form.value.lightweightMode) {
      form.value.lightweightMode = false
    }
  },
)

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
  { label: 'हिन्दी · Hindi', value: 'hi' },
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

/** Dynamic label for the 'auto' option. */
const autoLocaleLabel = computed(() => {
  return locale.value === 'en-US' ? t('preferences.follow-system') : `${t('preferences.follow-system')} · Follow System`
})

/** Full locale options with 'Follow System' prepended as the first choice. */
const fullLocaleOptions = computed(() => [{ label: autoLocaleLabel.value, value: 'auto' }, ...localeOptions])

const themeOptions = computed(() => [
  { label: t('preferences.theme-auto'), value: 'auto' },
  { label: t('preferences.theme-light'), value: 'light' },
  { label: t('preferences.theme-dark'), value: 'dark' },
])

const taskCardModeOptions = computed(() => [
  { label: t('preferences.task-card-mode-full'), value: 'full' },
  { label: t('preferences.task-card-mode-compact'), value: 'compact' },
])

function handleCheckUpdate() {
  updateDialogRef.value?.open()
}

const { restartEngine } = useEngineRestart()

function handleManualRestart() {
  const port = (preferenceStore.config.rpcListenPort as number) || ENGINE_RPC_PORT
  const secret = (preferenceStore.config.rpcSecret as string) || ''
  const d = dialog.info({
    title: t('preferences.engine-restart-title'),
    content: t('preferences.engine-restart-manual-confirm'),
    positiveText: t('preferences.engine-restart-now'),
    negativeText: t('preferences.engine-restart-later'),
    maskClosable: false,
    onPositiveClick: async () => {
      d.loading = true
      d.negativeText = ''
      d.closable = false
      message.info(t('preferences.engine-restarting'))
      await new Promise((r) => requestAnimationFrame(r))
      await restartEngine({ port, secret })
    },
  })
}

onMounted(async () => {
  try {
    sysArch.value = osArch()
  } catch (e) {
    logger.debug('General.arch', e)
  }
  try {
    sysOsVersion.value = osVersion()
  } catch (e) {
    logger.debug('General.osVersion', e)
  }
  try {
    sysAppVersion.value = await getAppVersion()
  } catch (e) {
    logger.debug('General.appVersion', e)
  }
  try {
    const info = await getAria2Version()
    sysAria2Version.value = info.version
  } catch (e) {
    logger.debug('General.aria2Version', e)
  }
  try {
    const raw = (await getOsLocale()) || navigator.language || 'en-US'
    detectedLocaleCode.value = resolveSystemLocale(raw, SUPPORTED_LOCALES)
  } catch (e) {
    logger.debug('General.detectLocale', e)
  }
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <div class="preference-form-scroll">
      <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
        <!-- ① System info -->
        <NDivider title-placement="left">{{ t('preferences.system-info') }}</NDivider>
        <NFormItem :label="t('preferences.detected-platform')">
          <NSpace :size="8">
            <NTag type="info" round size="medium">{{ platformLabel }}</NTag>
            <NTag type="success" round size="medium">{{ archLabelDisplay }}</NTag>
          </NSpace>
        </NFormItem>
        <NFormItem :label="t('about.app-version')">
          <MTooltip>
            <template #trigger>
              <button
                class="sysinfo-ver-badge"
                @click="copyVersionToClipboard(`Motrix Next v${sysAppVersion}`, 'Motrix Next')"
              >
                <span class="sysinfo-ver-value">v{{ sysAppVersion || '\u2014' }}</span>
                <svg class="sysinfo-ver-copy" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
                </svg>
              </button>
            </template>
            {{ t('about.click-to-copy') }}
          </MTooltip>
        </NFormItem>
        <NFormItem :label="t('about.aria2-version')">
          <MTooltip v-if="sysAria2Version">
            <template #trigger>
              <button
                class="sysinfo-ver-badge"
                @click="copyVersionToClipboard(`Aria2 Next v${sysAria2Version}`, 'Aria2 Next')"
              >
                <span class="sysinfo-ver-value">v{{ sysAria2Version }}</span>
                <svg class="sysinfo-ver-copy" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2" />
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2" />
                </svg>
              </button>
            </template>
            {{ t('about.click-to-copy') }}
          </MTooltip>
          <div v-else class="sysinfo-ver-badge sysinfo-ver-badge--muted">
            <span class="sysinfo-ver-muted">{{ t('about.unavailable') }}</span>
          </div>
        </NFormItem>

        <!-- ② Language -->
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
          <NSelect
            v-model:value="form.locale"
            :options="fullLocaleOptions"
            class="pref-control-auto pref-control-language"
          />
        </NFormItem>

        <!-- ③ Auto Update -->
        <NDivider title-placement="left">{{ t('preferences.auto-update') }}</NDivider>
        <NFormItem :label="t('preferences.auto-check-update')">
          <NSwitch v-model:value="form.autoCheckUpdate" />
        </NFormItem>
        <NCollapseTransition :show="form.autoCheckUpdate" class="collapse-indent">
          <NFormItem :label="t('preferences.check-frequency')">
            <NSelect
              v-model:value="form.autoCheckUpdateInterval"
              :options="checkIntervalOptions"
              class="pref-control-auto"
            />
          </NFormItem>
        </NCollapseTransition>
        <NFormItem :label="t('preferences.update-channel')">
          <NRadioGroup
            v-model:value="form.updateChannel"
            size="small"
            @update:value="
              async (v: string) => {
                const ok = await preferenceStore.updateAndSave({ updateChannel: v as UpdateChannel })
                if (ok) {
                  patchSnapshot({ updateChannel: v } as Partial<typeof form.value>)
                }
              }
            "
          >
            <NRadioButton value="stable">{{ t('preferences.update-channel-stable') }}</NRadioButton>
            <NRadioButton value="beta">{{ t('preferences.update-channel-beta') }}</NRadioButton>
            <NRadioButton value="latest">{{ t('preferences.update-channel-latest') }}</NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.last-check-update-time')">
          <div class="pref-inline-row">
            <NButton size="small" @click="handleCheckUpdate">
              <template #icon>
                <NIcon :size="14"><CloudDownloadOutline /></NIcon>
              </template>
              {{ t('app.check-updates-now') }}
            </NButton>
            <NText v-if="preferenceStore.config.lastCheckUpdateTime" depth="3" class="pref-inline-row__meta">
              {{ new Date(preferenceStore.config.lastCheckUpdateTime).toLocaleString() }}
            </NText>
            <NText v-else depth="3" class="pref-inline-row__meta">—</NText>
          </div>
        </NFormItem>
        <UpdateDialog ref="updateDialogRef" />

        <!-- ④ Appearance -->
        <NDivider title-placement="left">{{ t('preferences.appearance-section') }}</NDivider>
        <NFormItem :label="t('preferences.appearance')">
          <NSelect v-model:value="form.theme" :options="themeOptions" class="pref-control-auto" />
        </NFormItem>
        <NFormItem :label="t('preferences.color-scheme')">
          <div class="color-scheme-picker">
            <MTooltip v-for="scheme in COLOR_SCHEMES" :key="scheme.id">
              <template #trigger>
                <button
                  class="color-swatch"
                  :class="{ active: form.colorScheme === scheme.id }"
                  :style="{ '--swatch-color': scheme.seed }"
                  @click="handlePresetColorScheme(scheme)"
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
        <NFormItem :label="t('preferences.custom-color-scheme')">
          <div class="custom-color-picker-wrap">
            <NColorPicker
              :value="form.customColorScheme"
              :modes="['hex']"
              :show-alpha="false"
              :show-preview="true"
              :swatches="CUSTOM_COLOR_SWATCHES"
              class="custom-color-picker"
              @update:value="handleCustomColorChange"
              @complete="handleCustomColorComplete"
            />
          </div>
        </NFormItem>
        <NFormItem :label="t('preferences.task-card-mode')">
          <NRadioGroup v-model:value="form.taskCardMode">
            <NRadioButton v-for="option in taskCardModeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </NRadioButton>
          </NRadioGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.sidebar-task-counts')">
          <NSwitch v-model:value="form.sidebarTaskCounts" />
        </NFormItem>
        <NFormItem :label="t('preferences.task-list-watermark')">
          <NSwitch v-model:value="form.taskListWatermark" />
        </NFormItem>
        <NFormItem v-if="isMac" :label="t('preferences.dock-badge-speed')">
          <NSwitch v-model:value="form.dockBadgeSpeed" />
        </NFormItem>

        <!-- 11 Startup & Tray (Android hides desktop-only autostart/tray items) -->
        <template v-if="!isMobile">
          <NDivider title-placement="left">{{ t('preferences.startup-behavior') }}</NDivider>
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
          <NDivider title-placement="left">{{ t('preferences.tray-and-dock') }}</NDivider>
          <NFormItem :label="t('preferences.minimize-to-tray-on-close')">
            <NSwitch v-model:value="form.minimizeToTrayOnClose" />
          </NFormItem>
          <NFormItem v-if="isMac" :label="t('preferences.hide-dock-on-minimize')">
            <NSwitch v-model:value="form.hideDockOnMinimize" />
          </NFormItem>
          <NFormItem v-if="isMac || isLinux" :label="t('preferences.tray-speedometer')">
            <NSwitch v-model:value="form.traySpeedometer" />
          </NFormItem>
          <NFormItem :label="t('preferences.show-progress-bar')">
            <NSwitch v-model:value="form.showProgressBar" />
          </NFormItem>
          <NFormItem>
            <template #label>
              <PreferenceHintLabel
                :label="t('preferences.lightweight-mode')"
                :hint="t('preferences.lightweight-mode-hint')"
              />
            </template>
            <NSwitch v-model:value="form.lightweightMode" />
          </NFormItem>
        </template>
        <template v-else>
          <!-- Android: auto-resume stays available -->
          <NDivider title-placement="left">{{ t('preferences.startup-behavior') }}</NDivider>
          <NFormItem :label="t('preferences.auto-resume-all')">
            <NSwitch v-model:value="form.resumeAllWhenAppLaunched" />
          </NFormItem>
        </template>
      </NForm>
    </div>
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" @restart="handleManualRestart" />
  </div>
</template>

<style scoped>
.pref-control-language {
  min-width: 260px;
}

/* ── System info version badge ─────────────────────────────────────── */
.sysinfo-ver-badge {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 8px;
  background: var(--about-card-bg);
  cursor: pointer;
  transition: var(--transition-all);
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace;
}
.sysinfo-ver-badge:hover {
  border-color: var(--m3-primary);
  background: var(--about-card-hover-bg);
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
  color: var(--m3-on-surface);
  letter-spacing: 0.3px;
}
.sysinfo-ver-copy {
  opacity: 0.35;
  margin-left: auto;
  color: var(--m3-on-surface-variant);
  transition: var(--transition-all);
  flex-shrink: 0;
}
.sysinfo-ver-badge--muted {
  cursor: default;
}
.sysinfo-ver-badge--muted:hover {
  border-color: var(--m3-outline-variant);
  background: var(--about-card-bg);
}
.sysinfo-ver-muted {
  font-size: 12px;
  font-weight: 500;
  color: var(--m3-outline);
  letter-spacing: 0.3px;
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
  border-color: var(--m3-on-surface);
  box-shadow:
    0 0 0 2px var(--swatch-color),
    0 2px 8px rgba(0, 0, 0, 0.25);
}
.custom-color-picker-wrap {
  width: 100px;
  flex: 0 0 auto;
  display: inline-block;
}
.custom-color-picker {
  width: 100%;
}
.swatch-check {
  width: 14px;
  height: 14px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}
</style>
