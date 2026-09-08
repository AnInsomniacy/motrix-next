<script setup lang="ts">
/** @fileoverview Network preference tab: proxy, ports, user-agent, timeouts, file allocation. */
import { ref, computed, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { usePreferenceNumericValidation } from '@/composables/usePreferenceNumericValidation'
import { usePlatform } from '@/composables/usePlatform'
import { useSystemProxyDetect } from '@/composables/useSystemProxyDetect'
import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { useAppMessage } from '@/composables/useAppMessage'
import { PROXY_SCOPE_OPTIONS, FILE_ALLOCATION_OPTIONS } from '@shared/constants'
import {
  buildNetworkForm,
  buildNetworkSystemConfig,
  transformNetworkForStore,
  validateNetworkForm,
} from '@/composables/useNetworkPreference'
import { proxySwitchValueToMode } from '@shared/utils/proxy'

import userAgentMap from '@shared/ua'
import { hasUnsafeHeaderChars, sanitizeHeaderValue } from '@shared/utils/headerSanitize'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NSwitch,
  NSelect,
  NButton,
  NButtonGroup,
  NDivider,
  NIcon,
  NText,
} from 'naive-ui'
const showUserAgentManager = ref(false)
import PreferenceActionBar from './PreferenceActionBar.vue'
import PreferenceCheckboxGrid from './PreferenceCheckboxGrid.vue'
import PreferenceHintLabel from './PreferenceHintLabel.vue'
import UserAgentManager from './UserAgentManager.vue'
import { SearchOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const message = useAppMessage()
const { constraint, configFieldProps, fieldProps, areConfigFieldsValid, portRecoveryConstraint } =
  usePreferenceNumericValidation()
const { isWindows } = usePlatform()

const proxyScopeOptions = PROXY_SCOPE_OPTIONS.map((s: string) => ({
  label: t(`preferences.proxy-scope-${s}`),
  value: s,
}))
const fileAllocationOptions = computed(() =>
  FILE_ALLOCATION_OPTIONS.filter((value) => !(isWindows.value && value === 'falloc')).map((value) => ({
    label: value,
    value,
  })),
)

type PortRecoveryTarget = 'rpc' | 'extensionApi' | 'bt' | 'ed2k' | 'ed2kUdp'
const portRecoveryTargets: PortRecoveryTarget[] = ['rpc', 'extensionApi', 'bt', 'ed2k', 'ed2kUdp']
const portRecoveryTargetOptions = computed(() => [
  { label: t('preferences.rpc-listen-port'), value: 'rpc' },
  { label: t('preferences.extension-api-port'), value: 'extensionApi' },
  { label: t('preferences.port-conflict-recovery-bt'), value: 'bt' },
  { label: t('preferences.port-conflict-recovery-ed2k'), value: 'ed2k' },
  { label: t('preferences.port-conflict-recovery-ed2k-udp'), value: 'ed2kUdp' },
])
const selectedPortRecoveryTargets = computed<string[]>({
  get: () => portRecoveryTargets.filter((target) => form.value.portConflictRecovery[target]),
  set: (targets) => {
    const selected = new Set(targets)
    for (const target of portRecoveryTargets) {
      form.value.portConflictRecovery[target] = selected.has(target)
    }
  },
})

// ── Proxy detection ─────────────────────────────────────────────────
const { detecting: detectingProxy, detect: detectProxy } = useSystemProxyDetect({
  onSuccess(info) {
    form.value.proxy.server = info.server
    if (info.bypass) form.value.proxy.bypass = info.bypass
    form.value.proxy.mode = 'manual'
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

function buildForm() {
  return buildNetworkForm(preferenceStore.config)
}

const { form, isDirty, handleSave, handleReset, resetSnapshot, patchSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildNetworkSystemConfig,
  transformForStore: transformNetworkForStore,
  beforeSave: (f) => {
    const validationKey = validateNetworkForm(f)
    if (validationKey) {
      message.error(t(validationKey))
      return false
    }
    return true
  },
  afterSave: async (f, prevConfig) => {
    if (f.enableUpnp !== prevConfig.enableUpnp) await syncUpnpState(!!f.enableUpnp)
  },
})
const numericFieldsValid = computed(
  () =>
    areConfigFieldsValid({
      connectTimeout: form.value.connectTimeout,
      timeout: form.value.timeout,
    }) &&
    !fieldProps(form.value.portConflictRecovery.rangeStart, portRecoveryConstraint).validationStatus &&
    !fieldProps(form.value.portConflictRecovery.rangeEnd, portRecoveryConstraint).validationStatus &&
    form.value.portConflictRecovery.rangeStart <= form.value.portConflictRecovery.rangeEnd,
)
const portRecoveryFieldProps = computed(() => {
  const recovery = form.value.portConflictRecovery
  if (recovery.rangeStart > recovery.rangeEnd) {
    return {
      validationStatus: 'error' as const,
      feedback: t('preferences.port-conflict-recovery-invalid-range'),
    }
  }
  const start = fieldProps(recovery.rangeStart, portRecoveryConstraint)
  return start.validationStatus ? start : fieldProps(recovery.rangeEnd, portRecoveryConstraint)
})

// ── UPnP save-time sync ─────────────────────────────────────────────
async function syncUpnpState(enabled: boolean) {
  const config = preferenceStore.config
  try {
    if (enabled) {
      await invoke('start_upnp_mapping', {
        ed2kPort: Number(config.ed2kListenPort) > 0 ? Number(config.ed2kListenPort) : null,
        ed2kUdpPort: Number(config.ed2kUdpListenPort) > 0 ? Number(config.ed2kUdpListenPort) : null,
      })
    } else {
      await invoke('stop_upnp_mapping')
    }
  } catch (e) {
    logger.warn('UPnP', `sync failed: ${getErrorMessage(e)}`)
    message.warning(t('preferences.upnp-mapping-failed'))
  }
}

// ── User-Agent presets ──────────────────────────────────────────────
function changeUA(type: string) {
  const ua = userAgentMap[type]
  if (ua) form.value.userAgent = ua
}

const uaHasIssue = computed(() => !!form.value.userAgent && hasUnsafeHeaderChars(form.value.userAgent as string))

function cleanUserAgent() {
  form.value.userAgent = sanitizeHeaderValue(form.value.userAgent as string)
}

async function handleUserAgentManagerSave(payload: {
  profiles: typeof form.value.userAgentProfiles
  rules: typeof form.value.userAgentRules
  recentProfileIds: typeof form.value.recentUserAgentProfileIds
}) {
  form.value.userAgentProfiles = payload.profiles
  form.value.userAgentRules = payload.rules
  form.value.recentUserAgentProfileIds = payload.recentProfileIds
  const saved = await preferenceStore.updateAndSave({
    userAgentProfiles: payload.profiles,
    userAgentRules: payload.rules,
    recentUserAgentProfileIds: payload.recentProfileIds,
  })
  if (!saved) {
    message.error(t('preferences.save-fail-message'))
    return
  }
  patchSnapshot({
    userAgentProfiles: payload.profiles,
    userAgentRules: payload.rules,
    recentUserAgentProfileIds: payload.recentProfileIds,
  } as Partial<typeof form.value>)
}

function handleProxySwitch(value: boolean) {
  form.value.proxy.mode = proxySwitchValueToMode(value)
}

onMounted(() => {
  Object.assign(form.value, buildForm())
  resetSnapshot()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <div class="preference-form-scroll">
      <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
        <!-- User-Agent -->
        <NDivider title-placement="left">{{ t('preferences.user-agent') }}</NDivider>
        <NFormItem :label="t('preferences.mock-user-agent')">
          <div class="ua-field-wrapper">
            <NInput
              v-model:value="form.userAgent"
              type="textarea"
              :autosize="{ minRows: 2, maxRows: 4 }"
              placeholder="User-Agent"
            />
            <div class="ua-warn-collapse" :class="{ 'ua-warn-collapse--open': uaHasIssue }">
              <div class="ua-warn-collapse__inner">
                <div class="ua-warn-bar">
                  <span class="ua-warn-text">⚠ {{ t('preferences.ua-unsafe-chars-detected') }}</span>
                  <NButton size="tiny" type="primary" ghost @click="cleanUserAgent">
                    {{ t('preferences.ua-sanitize') }}
                  </NButton>
                </div>
              </div>
            </div>
          </div>
        </NFormItem>
        <NFormItem label=" ">
          <div class="ua-preset-row">
            <NButtonGroup size="small">
              <NButton @click="changeUA('chrome')">Chrome</NButton>
              <NButton @click="changeUA('edge')">Edge</NButton>
              <NButton @click="changeUA('safari')">Safari</NButton>
              <NButton @click="changeUA('firefox')">Firefox</NButton>
            </NButtonGroup>
            <NButton type="error" size="small" ghost @click="form.userAgent = ''">
              {{ t('preferences.ua-reset') }}
            </NButton>
          </div>
        </NFormItem>
        <NFormItem :label="t('preferences.ua-saved')">
          <div class="ua-manager-entry">
            <div class="ua-manager-entry-text">
              <strong>{{ t('preferences.ua-manager-title') }}</strong>
              <span>
                {{
                  t('preferences.ua-manager-summary', {
                    profiles: form.userAgentProfiles.length,
                    rules: form.userAgentRules.length,
                  })
                }}
              </span>
            </div>
            <NButton size="small" @click="showUserAgentManager = true">
              {{ t('preferences.ua-manage') }}
            </NButton>
          </div>
        </NFormItem>

        <!-- Proxy -->
        <NDivider title-placement="left">{{ t('preferences.proxy') }}</NDivider>
        <NFormItem>
          <template #label>
            <PreferenceHintLabel :label="t('task.use-proxy')" :hint="t('preferences.proxy-request-scope-hint')" />
          </template>
          <NSwitch :value="form.proxy.mode !== 'direct'" @update:value="handleProxySwitch" />
        </NFormItem>
        <div class="proxy-collapse" :class="{ 'proxy-collapse--open': form.proxy.mode === 'manual' }">
          <div class="proxy-collapse__inner collapse-indent">
            <NFormItem
              v-bind="
                form.portConflictRecovery.rangeStart > form.portConflictRecovery.rangeEnd
                  ? {
                      validationStatus: 'error',
                      feedback: t('preferences.port-conflict-recovery-invalid-range'),
                    }
                  : fieldProps(form.portConflictRecovery.rangeStart, portRecoveryConstraint)
              "
            >
              <template #label>
                <PreferenceHintLabel
                  :label="t('preferences.proxy-server')"
                  :hint="t('preferences.proxy-protocol-hint')"
                />
              </template>
              <NInputGroup>
                <NInput v-model:value="form.proxy.server" class="pref-control-full" placeholder="http://host:port" />
                <NButton
                  class="pref-action-button network-proxy-detect-button"
                  :loading="detectingProxy"
                  @click="detectProxy"
                >
                  <template #icon>
                    <NIcon><SearchOutline /></NIcon>
                  </template>
                  {{ t('preferences.detect-system-proxy') }}
                </NButton>
              </NInputGroup>
            </NFormItem>
            <NFormItem :label="t('preferences.proxy-username')">
              <NInput v-model:value="form.proxy.username" />
            </NFormItem>
            <NFormItem :label="t('preferences.proxy-password')">
              <NInput v-model:value="form.proxy.password" type="password" show-password-on="click" />
            </NFormItem>
            <NFormItem :label="t('preferences.proxy-bypass')">
              <NInput
                v-model:value="form.proxy.bypass"
                type="textarea"
                :autosize="{ minRows: 2, maxRows: 3 }"
                :placeholder="t('preferences.proxy-bypass-input-tips')"
              />
            </NFormItem>
            <NFormItem :label="t('preferences.proxy-scope')">
              <NSelect
                v-model:value="form.proxy.scope"
                :options="proxyScopeOptions"
                multiple
                class="pref-control-full"
              />
            </NFormItem>
          </div>
        </div>

        <!-- Port conflict recovery -->
        <NDivider title-placement="left">{{ t('preferences.port-conflict-recovery') }}</NDivider>
        <NFormItem :label="t('preferences.port-conflict-recovery-enable')">
          <NSwitch v-model:value="form.portConflictRecovery.enabled" />
        </NFormItem>
        <div
          class="port-recovery-collapse"
          :class="{ 'port-recovery-collapse--open': form.portConflictRecovery.enabled }"
        >
          <div class="port-recovery-collapse__inner collapse-indent">
            <NFormItem v-bind="portRecoveryFieldProps">
              <template #label>
                <PreferenceHintLabel
                  :label="t('preferences.port-conflict-recovery-range')"
                  :hint="t('preferences.port-conflict-recovery-range-hint')"
                />
              </template>
              <NInputGroup>
                <NInputNumber
                  v-model:value="form.portConflictRecovery.rangeStart"
                  :min="portRecoveryConstraint.min"
                  :max="portRecoveryConstraint.max"
                  class="pref-port"
                />
                <span class="port-range-separator">to</span>
                <NInputNumber
                  v-model:value="form.portConflictRecovery.rangeEnd"
                  :min="portRecoveryConstraint.min"
                  :max="portRecoveryConstraint.max"
                  class="pref-port"
                />
              </NInputGroup>
            </NFormItem>
            <NFormItem :label="t('preferences.port-conflict-recovery-apply-to')">
              <PreferenceCheckboxGrid
                v-model:value="selectedPortRecoveryTargets"
                :options="portRecoveryTargetOptions"
              />
            </NFormItem>
          </div>
        </div>

        <!-- Port mapping -->
        <NDivider title-placement="left">{{ t('preferences.port') }}</NDivider>
        <NFormItem label="UPnP/NAT-PMP">
          <NSwitch v-model:value="form.enableUpnp" />
        </NFormItem>

        <!-- Timeout & Disk -->
        <NDivider title-placement="left">{{ t('preferences.transfer-params') }}</NDivider>
        <NFormItem
          :label="t('preferences.connect-timeout')"
          v-bind="configFieldProps('connectTimeout', form.connectTimeout)"
        >
          <NInputNumber
            v-model:value="form.connectTimeout"
            :min="constraint('connectTimeout').min"
            :max="constraint('connectTimeout').max"
            class="pref-number"
          />
          <NText depth="3" class="pref-inline-note">{{ t('preferences.unit-seconds') }}</NText>
        </NFormItem>
        <NFormItem :label="t('preferences.timeout')" v-bind="configFieldProps('timeout', form.timeout)">
          <NInputNumber
            v-model:value="form.timeout"
            :min="constraint('timeout').min"
            :max="constraint('timeout').max"
            class="pref-number"
          />
          <NText depth="3" class="pref-inline-note">{{ t('preferences.unit-seconds') }}</NText>
        </NFormItem>
        <NFormItem :label="t('preferences.file-allocation')">
          <NSelect v-model:value="form.fileAllocation" :options="fileAllocationOptions" class="pref-control-auto" />
        </NFormItem>
      </NForm>
    </div>
    <UserAgentManager
      v-model:show="showUserAgentManager"
      :profiles="form.userAgentProfiles"
      :rules="form.userAgentRules"
      :recent-profile-ids="form.recentUserAgentProfileIds"
      @save="handleUserAgentManagerSave"
    />
    <PreferenceActionBar :is-dirty="isDirty" :is-valid="numericFieldsValid" @save="handleSave" @discard="handleReset" />
  </div>
</template>

<style scoped>
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
.port-recovery-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.port-recovery-collapse--open {
  grid-template-rows: 1fr;
}
.port-recovery-collapse__inner {
  overflow: hidden;
}
.port-range-separator {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  color: var(--m3-on-surface-variant);
  font-size: 12px;
  line-height: 1;
}
.network-proxy-detect-button {
  min-width: fit-content;
}
/* ── UA preset row ───────────────────────────────────────────────── */
.ua-preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ua-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.ua-manager-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--m3-outline-variant) 62%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--m3-surface-container-low) 54%, transparent);
}
.ua-manager-entry-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.ua-manager-entry-text strong {
  font-size: 13px;
  font-weight: 500;
}
.ua-manager-entry-text span {
  overflow: hidden;
  color: var(--n-text-color-3);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
</style>
