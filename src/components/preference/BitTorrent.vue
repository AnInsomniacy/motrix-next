<script setup lang="ts">
/** @fileoverview BitTorrent preference tab: BT settings + tracker management. */
import { ref, computed, onMounted, h } from 'vue'
import type { VNodeChild } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { usePreferenceNumericValidation } from '@/composables/usePreferenceNumericValidation'
import { changeGlobalOption, isEngineReady } from '@/api/aria2'
import { convertTrackerDataToComma, convertTrackerDataToLine } from '@shared/utils/tracker'
import { SYNC_MIN_DURATION } from '@shared/timing'
import { DEFAULT_TRACKER_SOURCE, SAFE_LIMIT_BT_MAX_PEERS, TRACKER_SOURCE_OPTIONS } from '@shared/constants'
import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { buildSystemConfigFromAppConfig } from '@shared/utils/systemConfig'
import { BT_PEER_ID_PREFIX_MAX_BYTES, isValidBtPeerIdPrefix, isValidBtUserAgent } from '@shared/utils/btIdentity'
import { useAppMessage } from '@/composables/useAppMessage'
import {
  buildBtForm,
  buildBtSystemConfig,
  transformBtForStore,
  isValidTrackerSourceUrl,
  validateBtEndpoint,
  randomBtPort,
} from '@/composables/useBtPreference'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NSwitch,
  NSelect,
  NButton,
  NDivider,
  NIcon,
  NCheckbox,
  NCheckboxGroup,
  NText,
  useDialog,
} from 'naive-ui'
import PreferenceActionBar from './PreferenceActionBar.vue'
import PreferenceHintLabel from './PreferenceHintLabel.vue'
import { SyncOutline, AddCircleOutline, CloseCircleOutline, DiceOutline } from '@vicons/ionicons5'

const { t, locale } = useI18n()
const preferenceStore = usePreferenceStore()
const dialog = useDialog()
const message = useAppMessage()
const { constraint, configFieldProps, areConfigFieldsValid } = usePreferenceNumericValidation()
const syncingTracker = ref(false)
const syncingBlocklist = ref(false)
const customTrackerInput = ref('')
const pendingPortSwitch = ref<{ from: number; to: number } | null>(null)
interface BtPeerBlocklistStatus {
  ruleCount: number
  fileSize: number
  modified: number
  source: string
  bundled: boolean
}
const blocklistStatus = ref<BtPeerBlocklistStatus | null>(null)
const syncIntervalOptions = computed(() => [
  { label: t('preferences.interval-every-startup'), value: 0 },
  { label: t('preferences.interval-6-hours'), value: 6 },
  { label: t('preferences.interval-12-hours'), value: 12 },
  { label: t('preferences.interval-daily'), value: 24 },
  { label: t('preferences.interval-weekly'), value: 168 },
])
const encryptionOptions = computed(() => [
  { label: t('preferences.bt-encryption-preferred'), value: 'preferred' },
  { label: t('preferences.bt-encryption-required'), value: 'required' },
  { label: t('preferences.bt-encryption-disabled'), value: 'disabled' },
])
const transportOptions = computed(() => [
  { label: t('preferences.bt-transport-both'), value: 'both' },
  { label: 'TCP', value: 'tcp' },
  { label: 'uTP', value: 'utp' },
])
const magnetFileSelectionOptions = computed(() => [
  { label: t('preferences.magnet-file-selection-download-all'), value: 'download-all' },
  { label: t('preferences.magnet-file-selection-prompt'), value: 'prompt' },
  { label: t('preferences.magnet-file-selection-manual'), value: 'manual' },
])
const blocklistScopeOptions = computed(() => [
  { label: t('preferences.bt-blocklist-scope-peers'), value: 'peers' },
  { label: t('preferences.bt-blocklist-scope-trackers'), value: 'peers-and-trackers' },
  { label: t('preferences.bt-blocklist-scope-all'), value: 'all' },
])
const blocklistStatusText = computed(() => {
  const status = blocklistStatus.value
  if (!status) return t('preferences.bt-peer-blocklist-unavailable')
  const rules = t('preferences.bt-peer-blocklist-rule-count', { count: status.ruleCount })
  const updated = status.modified
    ? new Intl.DateTimeFormat(locale.value, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(status.modified)
    : ''
  return updated ? `${rules} · ${t('preferences.last-sync-time')} ${updated}` : rules
})
// ── Tracker source management ───────────────────────────────────────
const presetTrackerValues = new Set<string>(TRACKER_SOURCE_OPTIONS.map((source) => source.value))

const presetSources = computed({
  get: () => form.value.trackerSource.filter((v: string) => presetTrackerValues.has(v)),
  set: (vals: string[]) => {
    const custom = form.value.trackerSource.filter((v: string) => !presetTrackerValues.has(v))
    form.value.trackerSource = [...vals, ...custom]
  },
})

const customSelectOptions = computed(() =>
  form.value.customTrackerUrls.map((url: string) => ({ label: url, value: url })),
)

const customSources = computed({
  get: () => form.value.trackerSource.filter((v: string) => !presetTrackerValues.has(v)),
  set: (vals: string[]) => {
    const preset = form.value.trackerSource.filter((v: string) => presetTrackerValues.has(v))
    form.value.trackerSource = [...preset, ...vals]
  },
})

function onDeleteCustomTracker(url: string, e: Event) {
  e.stopPropagation()
  form.value.customTrackerUrls = form.value.customTrackerUrls.filter((v: string) => v !== url)
  customSources.value = customSources.value.filter((v: string) => v !== url)
}

function renderCustomOption(info: {
  node: VNodeChild
  option: { value?: string | number }
  selected: boolean
}): VNodeChild {
  const url = String(info.option.value ?? '')
  return h('div', { class: 'custom-tracker-option' }, [
    h('div', { class: 'custom-tracker-option__content' }, [info.node]),
    h(
      'span',
      {
        class: 'custom-tracker-option__delete',
        onClick: (e: Event) => onDeleteCustomTracker(url, e),
      },
      [h(NIcon, { size: 18 }, { default: () => h(CloseCircleOutline) })],
    ),
  ])
}

function openTrackerSource(url: string) {
  openUrl(url).catch((e) => logger.error('BT.openTrackerSource', e))
}

const customPlaceholder = computed(() =>
  form.value.customTrackerUrls.length
    ? t('preferences.bt-tracker-source-custom-select')
    : t('preferences.bt-tracker-source-custom-empty'),
)

function buildForm() {
  const c = preferenceStore.config
  const formData = buildBtForm(c)
  if (!c.trackerSource) {
    formData.trackerSource = [...DEFAULT_TRACKER_SOURCE]
  }
  return formData
}

function buildSafeLimitContent(current: number) {
  return h('div', { style: 'display: flex; flex-direction: column; gap: 8px' }, [
    h(
      'div',
      { style: 'font-weight: 500' },
      `${t('preferences.bt-max-peers')}: ${current} (${t('preferences.recommended-limit', {
        value: SAFE_LIMIT_BT_MAX_PEERS,
      })})`,
    ),
    h('div', { style: 'opacity: 0.75' }, t('preferences.high-bt-peers-reason')),
  ])
}

function confirmBtPeerSafeLimit(f: Record<string, unknown>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const revert = () => {
      f.btMaxPeers = SAFE_LIMIT_BT_MAX_PEERS
      resolve(false)
    }
    dialog.warning({
      title: t('preferences.safe-limit-warning-title'),
      content: () => buildSafeLimitContent(Number(f.btMaxPeers) || 0),
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
  buildSystemConfig: buildBtSystemConfig,
  transformForStore: transformBtForStore,
  saveFeedback: (f, prevConfig) =>
    f.listenPort !== prevConfig.listenPort ||
    f.btExternalIp.trim() !== String(prevConfig.btExternalIp ?? '').trim() ||
    f.btExternalPort !== prevConfig.btExternalPort
      ? {
          success: t('preferences.bt-connection-apply-succeeded'),
          restored: t('preferences.bt-connection-restore-succeeded'),
          rollbackFailed: t('preferences.bt-connection-restore-failed'),
        }
      : null,
  beforeSave: async (f) => {
    pendingPortSwitch.value = null
    if (!isValidBtUserAgent(f.btUserAgent)) {
      message.error(t('preferences.bt-user-agent-invalid'))
      return false
    }
    if (!isValidBtPeerIdPrefix(f.btPeerIdPrefix)) {
      message.error(
        t('preferences.bt-peer-id-prefix-invalid', {
          max: BT_PEER_ID_PREFIX_MAX_BYTES,
        }),
      )
      return false
    }
    const endpointValidationKey = validateBtEndpoint(f)
    if (endpointValidationKey) {
      message.error(t(endpointValidationKey))
      return false
    }
    f.btExternalIp = f.btExternalIp.trim()
    if (Number(f.listenPort) !== Number(preferenceStore.config.listenPort)) {
      const requestedPort = Number(f.listenPort)
      try {
        const resolvedPort = await invoke<number>('resolve_bt_listen_port', {
          requestedPort: f.listenPort,
        })
        if (resolvedPort !== requestedPort) {
          pendingPortSwitch.value = { from: requestedPort, to: resolvedPort }
        }
        f.listenPort = resolvedPort
      } catch (e) {
        logger.warn('BT.listenPort', getErrorMessage(e))
        message.error(t('preferences.bt-port-unavailable'))
        return false
      }
    }
    if (!isValidTrackerSourceUrl(String(f.btPeerBlocklistUrl))) {
      message.warning(t('preferences.bt-peer-blocklist-invalid-url'))
      return false
    }
    if (typeof f.btMaxPeers === 'number' && f.btMaxPeers > SAFE_LIMIT_BT_MAX_PEERS) {
      const ok = await confirmBtPeerSafeLimit(f)
      if (!ok) return false
    }

    return true
  },
  afterSave: async () => {
    if (pendingPortSwitch.value) {
      const { from, to } = pendingPortSwitch.value
      pendingPortSwitch.value = null
      const ports = `${t('preferences.bt-port')} ${from} -> ${to}`
      message.info(t('preferences.port-auto-switched', { ports }))
    }
    reconcileBlocklistInBackground()
  },
})
const btUserAgentValid = computed(() => isValidBtUserAgent(form.value.btUserAgent))
const btPeerIdPrefixValid = computed(() => isValidBtPeerIdPrefix(form.value.btPeerIdPrefix))
const formFieldsValid = computed(
  () =>
    btUserAgentValid.value &&
    btPeerIdPrefixValid.value &&
    areConfigFieldsValid({
      btMaxPeers: form.value.btMaxPeers,
      btMaxConnections: form.value.btMaxConnections,
      btMaxUploads: form.value.btMaxUploads,
      btMaxUploadsPerTorrent: form.value.btMaxUploadsPerTorrent,
      listenPort: form.value.listenPort,
      btExternalPort: form.value.btExternalPort,
    }),
)

function onBtPortDice() {
  form.value.listenPort = randomBtPort()
}

function reconcileBlocklistInBackground() {
  void invoke<BtPeerBlocklistStatus>('reconcile_bt_peer_blocklist')
    .then((status) => {
      blocklistStatus.value = status
    })
    .catch((error) => {
      logger.warn('BT.blocklistReconcile', getErrorMessage(error))
      message.warning(t('preferences.bt-peer-blocklist-update-failed-keeping-current'))
    })
}

const mergedTrackerCount = computed(
  () =>
    form.value.btTracker
      .split(/\r?\n/)
      .map((tracker) => tracker.trim())
      .filter(Boolean).length,
)

async function loadBlocklistStatus() {
  try {
    blocklistStatus.value = await invoke<BtPeerBlocklistStatus>('get_bt_peer_blocklist_status')
  } catch (e) {
    logger.debug('BT.blocklistStatus', e)
  }
}

async function handleSyncBlocklist() {
  syncingBlocklist.value = true
  try {
    blocklistStatus.value = await invoke<BtPeerBlocklistStatus>('sync_bt_peer_blocklist')
    message.success(t('preferences.bt-peer-blocklist-update-succeed'))
  } catch (e) {
    logger.warn('BT.blocklistSync', getErrorMessage(e))
    message.error(t('preferences.bt-peer-blocklist-update-failed-keeping-current'))
  } finally {
    syncingBlocklist.value = false
  }
}

// ── Tracker sync ────────────────────────────────────────────────────
async function handleSyncTracker() {
  if (form.value.trackerSource.length === 0) {
    message.warning(t('preferences.bt-tracker-select-source'))
    return
  }
  syncingTracker.value = true
  try {
    const [result] = await Promise.all([
      preferenceStore.fetchBtTracker(form.value.trackerSource),
      new Promise((r) => setTimeout(r, SYNC_MIN_DURATION)),
    ])
    const text = convertTrackerDataToLine(result.data)
    if (result.failures.length === 0 && text) {
      await applySyncedTrackers(text, result.data)
      message.success(t('preferences.bt-tracker-sync-succeed'))
    } else if (result.data.length > 0 && text) {
      await applySyncedTrackers(text, result.data)
      showSyncFailureDialog(result.failures, result.data.length, form.value.trackerSource.length)
    } else {
      showSyncFailureDialog(result.failures, 0, form.value.trackerSource.length)
    }
  } catch (e) {
    logger.debug('BT.syncTracker', e)
    message.error(t('preferences.bt-tracker-sync-failed'))
  } finally {
    syncingTracker.value = false
  }
}

async function applySyncedTrackers(text: string, data: string[]) {
  const now = Date.now()
  const comma = convertTrackerDataToComma(data)
  form.value.btTracker = text
  form.value.lastSyncTrackerTime = now
  await preferenceStore.updateAndSave({ btTracker: comma, lastSyncTrackerTime: now })
  patchSnapshot({ btTracker: text, lastSyncTrackerTime: now } as Partial<typeof form.value>)
  await invoke('replace_system_config', {
    config: buildSystemConfigFromAppConfig(preferenceStore.config, preferenceStore.config.dir),
  })
  if (isEngineReady()) {
    await changeGlobalOption({ 'bt-tracker': comma } as Partial<typeof preferenceStore.config>)
  }
}

function showSyncFailureDialog(
  failures: Array<{ url: string; reason: string }>,
  successCount: number,
  totalCount: number,
) {
  const isPartial = successCount > 0
  const dialogType = isPartial ? 'warning' : 'error'
  const title = isPartial ? t('preferences.bt-tracker-sync-partial-title') : t('preferences.bt-tracker-sync-failed')
  dialog[dialogType]({
    title,
    content: () =>
      h('div', { class: 'tracker-sync-failures' }, [
        isPartial
          ? h(
              'p',
              { class: 'tracker-sync-failures__summary' },
              `${successCount}/${totalCount} ${t('preferences.bt-tracker-sync-sources-ok')}`,
            )
          : null,
        h('p', { class: 'tracker-sync-failures__heading' }, t('preferences.bt-tracker-sync-failed-sources')),
        ...failures.map((f) =>
          h('div', { class: 'tracker-sync-failure' }, [
            h('div', { class: 'tracker-sync-failure__url' }, f.url),
            h('div', { class: 'tracker-sync-failure__reason' }, f.reason),
          ]),
        ),
      ]),
    positiveText: 'OK',
  })
}

function onAddCustomTracker() {
  const url = customTrackerInput.value.trim()
  if (!url) return
  if (!isValidTrackerSourceUrl(url)) {
    message.warning(t('preferences.bt-tracker-source-invalid-url'))
    return
  }
  if (!form.value.customTrackerUrls.includes(url)) {
    form.value.customTrackerUrls = [...form.value.customTrackerUrls, url]
  }
  if (!form.value.trackerSource.includes(url)) {
    form.value.trackerSource = [...form.value.trackerSource, url]
  }
  customTrackerInput.value = ''
}

onMounted(() => {
  Object.assign(form.value, buildForm())
  resetSnapshot()
  void loadBlocklistStatus()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <div class="preference-form-scroll">
      <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
        <!-- BT Settings -->
        <NDivider title-placement="left">{{ t('preferences.bt-settings') }}</NDivider>

        <NFormItem :label="t('preferences.magnet-file-selection')">
          <NSelect
            v-model:value="form.magnetFileSelectionPolicy"
            :options="magnetFileSelectionOptions"
            class="pref-control-auto"
          />
        </NFormItem>
        <NFormItem :label="t('preferences.bt-encryption')">
          <NSelect v-model:value="form.btEncryption" :options="encryptionOptions" class="pref-control-auto" />
        </NFormItem>
        <NFormItem :label="t('preferences.bt-transport')">
          <NSelect v-model:value="form.btTransport" :options="transportOptions" class="pref-control-auto" />
        </NFormItem>
        <NFormItem :label="t('preferences.bt-first-last-piece-first')">
          <NSwitch v-model:value="form.btFirstLastPieceFirst" />
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.bt-connection-section') }}</NDivider>
        <NFormItem :label="t('preferences.bt-max-peers')" v-bind="configFieldProps('btMaxPeers', form.btMaxPeers)">
          <NInputNumber
            v-model:value="form.btMaxPeers"
            :min="constraint('btMaxPeers').min"
            :max="constraint('btMaxPeers').max"
            class="pref-number"
          />
        </NFormItem>
        <NFormItem
          :label="t('preferences.bt-max-connections')"
          v-bind="configFieldProps('btMaxConnections', form.btMaxConnections)"
        >
          <NInputNumber
            v-model:value="form.btMaxConnections"
            :min="constraint('btMaxConnections').min"
            :max="constraint('btMaxConnections').max"
            class="pref-number"
          />
        </NFormItem>
        <NFormItem
          :label="t('preferences.bt-max-uploads')"
          v-bind="configFieldProps('btMaxUploads', form.btMaxUploads)"
        >
          <NInputNumber
            v-model:value="form.btMaxUploads"
            :min="constraint('btMaxUploads').min"
            :max="constraint('btMaxUploads').max"
            class="pref-number"
          />
        </NFormItem>
        <NFormItem
          :label="t('preferences.bt-max-uploads-per-torrent')"
          v-bind="configFieldProps('btMaxUploadsPerTorrent', form.btMaxUploadsPerTorrent)"
        >
          <NInputNumber
            v-model:value="form.btMaxUploadsPerTorrent"
            :min="constraint('btMaxUploadsPerTorrent').min"
            :max="constraint('btMaxUploadsPerTorrent').max"
            class="pref-number"
          />
        </NFormItem>
        <NFormItem :label="t('preferences.bt-rate-limit-overhead')">
          <NSwitch v-model:value="form.btRateLimitOverhead" />
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.bt-endpoint-section') }}</NDivider>
        <NFormItem :label="t('preferences.bt-port')" v-bind="configFieldProps('listenPort', form.listenPort)">
          <NInputGroup>
            <NInputNumber
              v-model:value="form.listenPort"
              :min="constraint('listenPort').min"
              :max="constraint('listenPort').max"
              class="pref-port"
            />
            <NButton secondary class="pref-action-button pref-action-button--compact" @click="onBtPortDice">
              <template #icon>
                <NIcon><DiceOutline /></NIcon>
              </template>
              {{ t('preferences.random-port') }}
            </NButton>
          </NInputGroup>
        </NFormItem>
        <NFormItem v-bind="configFieldProps('btExternalPort', form.btExternalPort)">
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.bt-external-ip')"
              :hint="t('preferences.bt-external-ip-hint')"
            />
          </template>
          <NInput
            v-model:value="form.btExternalIp"
            :placeholder="t('preferences.bt-external-ip-placeholder')"
            clearable
            class="pref-control-auto"
          />
        </NFormItem>
        <NFormItem>
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.bt-external-port')"
              :hint="t('preferences.bt-external-port-hint')"
            />
          </template>
          <NInputNumber
            v-model:value="form.btExternalPort"
            :min="constraint('btExternalPort').min"
            :max="constraint('btExternalPort').max"
            class="pref-port"
          />
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.bt-discovery-section') }}</NDivider>
        <NFormItem :label="t('preferences.bt-peer-exchange')">
          <NSwitch v-model:value="form.btPeerExchangeEnabled" />
        </NFormItem>
        <NFormItem :label="t('preferences.bt-local-peer-discovery')">
          <NSwitch v-model:value="form.btLocalPeerDiscoveryEnabled" />
        </NFormItem>
        <NFormItem :label="t('preferences.bt-dht')">
          <NSwitch v-model:value="form.btDhtEnabled" />
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.bt-identity-privacy-section') }}</NDivider>
        <NFormItem>
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.bt-anonymous-mode')"
              :hint="t('preferences.bt-anonymous-mode-hint')"
            />
          </template>
          <NSwitch v-model:value="form.btAnonymousMode" />
        </NFormItem>
        <NFormItem
          :validation-status="btUserAgentValid ? undefined : 'error'"
          :feedback="btUserAgentValid ? undefined : t('preferences.bt-user-agent-invalid')"
        >
          <template #label>
            <PreferenceHintLabel :label="t('preferences.bt-user-agent')" :hint="t('preferences.bt-user-agent-hint')" />
          </template>
          <NInput v-model:value="form.btUserAgent" class="pref-control-auto" />
        </NFormItem>
        <NFormItem
          :validation-status="btPeerIdPrefixValid ? undefined : 'error'"
          :feedback="
            btPeerIdPrefixValid
              ? undefined
              : t('preferences.bt-peer-id-prefix-invalid', { max: BT_PEER_ID_PREFIX_MAX_BYTES })
          "
        >
          <template #label>
            <PreferenceHintLabel
              :label="t('preferences.bt-peer-id-prefix')"
              :hint="t('preferences.bt-peer-id-prefix-hint', { max: BT_PEER_ID_PREFIX_MAX_BYTES })"
            />
          </template>
          <NInput v-model:value="form.btPeerIdPrefix" class="pref-control-auto" />
        </NFormItem>

        <NDivider title-placement="left">{{ t('preferences.bt-peer-blocklist') }}</NDivider>
        <NFormItem :label="t('preferences.bt-peer-blocklist-enable')">
          <NSwitch v-model:value="form.btPeerBlocklistEnabled" />
        </NFormItem>
        <div class="blocklist-collapse" :class="{ 'blocklist-collapse--open': form.btPeerBlocklistEnabled }">
          <div class="blocklist-collapse__inner">
            <NFormItem :label="t('preferences.bt-peer-blocklist-url')">
              <NInput
                v-model:value="form.btPeerBlocklistUrl"
                :placeholder="t('preferences.bt-peer-blocklist-url-placeholder')"
                clearable
              />
            </NFormItem>
            <NFormItem :label="t('preferences.bt-blocklist-scope')">
              <NSelect
                v-model:value="form.btBlocklistScope"
                :options="blocklistScopeOptions"
                class="pref-control-auto bt-blocklist-scope-select"
              />
            </NFormItem>
            <NFormItem label=" ">
              <div class="pref-action-stack">
                <NButton
                  class="pref-action-button bt-blocklist-update-button"
                  :loading="syncingBlocklist"
                  :disabled="isDirty"
                  type="primary"
                  secondary
                  @click="handleSyncBlocklist"
                >
                  <template #icon>
                    <NIcon><SyncOutline /></NIcon>
                  </template>
                  {{ t('preferences.bt-peer-blocklist-update') }}
                </NButton>
                <NText depth="3" class="pref-inline-row__meta">{{ blocklistStatusText }}</NText>
              </div>
            </NFormItem>
            <NFormItem :label="t('preferences.auto-sync')">
              <NSwitch v-model:value="form.btPeerBlocklistAutoSync" />
            </NFormItem>
            <div
              class="blocklist-frequency-collapse"
              :class="{ 'blocklist-frequency-collapse--open': form.btPeerBlocklistAutoSync }"
            >
              <div class="blocklist-frequency-collapse__inner">
                <NFormItem :label="t('preferences.sync-frequency')">
                  <NSelect
                    v-model:value="form.btPeerBlocklistSyncIntervalHours"
                    :options="syncIntervalOptions"
                    class="pref-control-auto"
                  />
                </NFormItem>
              </div>
            </div>
            <NFormItem :show-label="false">
              <button
                class="info-link"
                type="button"
                @click="openTrackerSource('https://github.com/PBH-BTN/BTN-Collected-Rules')"
              >
                PBH-BTN/BTN-Collected-Rules ↗
              </button>
            </NFormItem>
          </div>
        </div>

        <!-- Tracker Management -->
        <NDivider title-placement="left">{{ t('preferences.bt-tracker') }}</NDivider>
        <NFormItem :label="t('preferences.bt-tracker-source-preset')">
          <NCheckboxGroup v-model:value="presetSources" class="tracker-source-group">
            <div class="tracker-source-list">
              <NCheckbox
                v-for="source in TRACKER_SOURCE_OPTIONS"
                :key="source.value"
                :value="source.value"
                class="tracker-source-option"
              >
                <span class="tracker-source-option__content">
                  <span class="tracker-source-option__owner">{{ source.owner }}</span>
                  <span class="tracker-source-option__repository">{{ source.repository }}</span>
                </span>
              </NCheckbox>
            </div>
          </NCheckboxGroup>
        </NFormItem>
        <NFormItem :label="t('preferences.bt-tracker-source-custom')">
          <NInputGroup>
            <NInput
              v-model:value="customTrackerInput"
              :placeholder="t('preferences.bt-tracker-source-custom-placeholder')"
              clearable
              class="pref-control-full"
              @keydown.enter="onAddCustomTracker"
            />
            <NButton size="small" class="pref-input-group-action" @click="onAddCustomTracker">
              <template #icon>
                <NIcon><AddCircleOutline /></NIcon>
              </template>
            </NButton>
          </NInputGroup>
        </NFormItem>
        <NFormItem label=" ">
          <NSelect
            v-model:value="customSources"
            :options="customSelectOptions"
            :render-option="renderCustomOption"
            multiple
            clearable
            :placeholder="customPlaceholder"
            max-tag-count="responsive"
          />
        </NFormItem>
        <NFormItem label=" ">
          <div class="pref-action-stack">
            <NButton
              class="pref-action-button bt-tracker-sync-button"
              :loading="syncingTracker"
              type="primary"
              secondary
              @click="handleSyncTracker"
            >
              <template #icon>
                <NIcon><SyncOutline /></NIcon>
              </template>
              {{ t('preferences.bt-tracker-sync') }}
            </NButton>
            <NText depth="3" class="pref-inline-row__meta">
              {{ t('preferences.bt-tracker-count', { count: mergedTrackerCount }) }} ·
              {{ t('preferences.last-sync-time') }}
              {{ form.lastSyncTrackerTime ? new Date(form.lastSyncTrackerTime as number).toLocaleString() : '—' }}
            </NText>
          </div>
        </NFormItem>
        <NFormItem :label="t('preferences.bt-tracker-content')">
          <NInput
            v-model:value="form.btTracker"
            type="textarea"
            :autosize="{ minRows: 3, maxRows: 8 }"
            :placeholder="t('preferences.bt-tracker-input-tips')"
          />
        </NFormItem>
        <NFormItem :label="t('preferences.auto-sync')">
          <NSwitch v-model:value="form.btTrackerAutoSync" />
        </NFormItem>
        <NFormItem v-if="form.btTrackerAutoSync" :label="t('preferences.sync-frequency')">
          <NSelect
            v-model:value="form.btTrackerSyncIntervalHours"
            :options="syncIntervalOptions"
            class="pref-control-auto"
          />
        </NFormItem>
      </NForm>
    </div>
    <PreferenceActionBar :is-dirty="isDirty" :is-valid="formFieldsValid" @save="handleSave" @discard="handleReset" />
  </div>
</template>

<style scoped>
.bt-tracker-sync-button {
  min-width: 100px;
}
:global(.custom-tracker-option) {
  position: relative;
  display: flex;
  align-items: center;
  padding-right: 32px;
}
:global(.custom-tracker-option__content) {
  flex: 1;
  min-width: 0;
}
:global(.custom-tracker-option__delete) {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  color: var(--m3-error);
  cursor: pointer;
}
:global(.tracker-sync-failures) {
  max-height: 300px;
  overflow-y: auto;
}
:global(.tracker-sync-failures__summary) {
  margin: 0 0 8px;
  color: var(--m3-on-surface-variant);
}
:global(.tracker-sync-failures__heading) {
  margin: 0 0 8px;
  font-weight: 500;
}
:global(.tracker-sync-failure) {
  margin: 6px 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--m3-error-container);
  color: var(--m3-on-error-container);
}
:global(.tracker-sync-failure__url) {
  font-size: 12px;
  font-weight: 500;
  word-break: break-all;
}
:global(.tracker-sync-failure__reason) {
  margin-top: 2px;
  font-size: 11px;
}
.tracker-source-group {
  width: 100%;
}
.tracker-source-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
  max-width: 520px;
}
.tracker-source-option {
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: 9px;
  background: color-mix(in srgb, var(--m3-surface-container-low) 72%, transparent);
  transition:
    border-color 180ms ease,
    background-color 180ms ease;
}
.tracker-source-option:hover {
  border-color: color-mix(in srgb, var(--m3-primary) 42%, var(--m3-outline-variant));
  background: var(--m3-surface-container-low);
}
.tracker-source-option.n-checkbox--checked {
  border-color: color-mix(in srgb, var(--m3-primary) 58%, var(--m3-outline-variant));
  background: color-mix(in srgb, var(--m3-primary) 7%, var(--m3-surface-container-low));
}
.tracker-source-option:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--m3-primary) 68%, transparent);
  outline-offset: 2px;
}
.tracker-source-option :deep(.n-checkbox__label) {
  min-width: 0;
  flex: 1;
}
.tracker-source-option__content {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.tracker-source-option__owner,
.tracker-source-option__repository {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tracker-source-option__owner {
  color: var(--m3-on-surface);
  font-size: 13px;
  font-weight: 600;
}
.tracker-source-option__repository {
  color: var(--m3-on-surface-variant);
  font-size: 12px;
}
.bt-blocklist-update-button {
  min-width: 100px;
}
.bt-blocklist-scope-select {
  width: 200px;
}
.blocklist-collapse,
.blocklist-frequency-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.blocklist-collapse--open,
.blocklist-frequency-collapse--open {
  grid-template-rows: 1fr;
}
.blocklist-collapse__inner,
.blocklist-frequency-collapse__inner {
  overflow: hidden;
}

.info-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--m3-primary);
  cursor: pointer;
  text-decoration: none;
  font-size: 12px;
}
.info-link:hover {
  text-decoration: underline;
}
@media (max-width: 720px) {
  .tracker-source-list {
    grid-template-columns: 1fr;
  }
}
</style>
