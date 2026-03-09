<script setup lang="ts">
/** @fileoverview Advanced preference form: proxy, tracker, RPC, port, and user-agent settings. */
import { ref, h, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useTaskStore } from '@/stores/task'
import { fetchTaskList } from '@/api/aria2'
import { relaunch } from '@tauri-apps/plugin-process'
import { appDataDir, join, resolveResource } from '@tauri-apps/api/path'
import { LOG_LEVELS, PROXY_SCOPE_OPTIONS } from '@shared/constants'
import { convertTrackerDataToLine } from '@shared/utils/tracker'
import {
  generateSecret,
  buildAdvancedForm,
  buildAdvancedSystemConfig,
  transformAdvancedForStore,
  validateAdvancedForm,
  randomRpcPort,
  randomBtPort,
  randomDhtPort,
} from '@/composables/useAdvancedPreference'
import userAgentMap from '@shared/ua'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NSwitch,
  NSelect,
  NTag,
  NButton,
  NButtonGroup,
  NSpace,
  NDivider,
  NIcon,
  useDialog,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import { useAppNotification } from '@/composables/useAppNotification'
import { SyncOutline, DiceOutline } from '@vicons/ionicons5'
import { logger } from '@shared/logger'
import PreferenceActionBar from './PreferenceActionBar.vue'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const message = useAppMessage()
const { notifyError } = useAppNotification()
const dialog = useDialog()

import { DEFAULT_TRACKER_SOURCE } from '@shared/constants'

const trackerSourceOptions = [
  {
    type: 'group' as const,
    label: 'ngosang/trackerslist',
    key: 'ngosang',
    children: [
      {
        label: 'trackers_best.txt',
        value: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
      },
      {
        label: 'trackers_best_ip.txt',
        value: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best_ip.txt',
      },
      {
        label: 'trackers_all.txt',
        value: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt',
      },
      {
        label: 'trackers_all_ip.txt',
        value: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all_ip.txt',
      },
      {
        label: () =>
          h('span', {}, [
            h('span', {}, 'trackers_best.txt '),
            h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' }),
          ]),
        value: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best.txt',
      },
      {
        label: () =>
          h('span', {}, [
            h('span', {}, 'trackers_best_ip.txt '),
            h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' }),
          ]),
        value: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_best_ip.txt',
      },
      {
        label: () =>
          h('span', {}, [
            h('span', {}, 'trackers_all.txt '),
            h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' }),
          ]),
        value: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_all.txt',
      },
      {
        label: () =>
          h('span', {}, [
            h('span', {}, 'trackers_all_ip.txt '),
            h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' }),
          ]),
        value: 'https://cdn.jsdelivr.net/gh/ngosang/trackerslist/trackers_all_ip.txt',
      },
    ],
  },
  {
    type: 'group' as const,
    label: 'XIU2/TrackersListCollection',
    key: 'xiu2',
    children: [
      { label: 'best.txt', value: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt' },
      { label: 'all.txt', value: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt' },
      { label: 'http.txt', value: 'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/http.txt' },
      {
        label: () =>
          h('span', {}, [
            h('span', {}, 'best.txt '),
            h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' }),
          ]),
        value: 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/best.txt',
      },
      {
        label: () =>
          h('span', {}, [
            h('span', {}, 'all.txt '),
            h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' }),
          ]),
        value: 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/all.txt',
      },
      {
        label: () =>
          h('span', {}, [
            h('span', {}, 'http.txt '),
            h(NTag, { size: 'tiny', type: 'warning', bordered: false }, { default: () => 'CDN' }),
          ]),
        value: 'https://cdn.jsdelivr.net/gh/XIU2/TrackersListCollection/http.txt',
      },
    ],
  },
]

const proxyScopeOptions = PROXY_SCOPE_OPTIONS.map((s: string) => ({
  label: t(`preferences.proxy-scope-${s}`),
  value: s,
}))

const logLevelOptions = LOG_LEVELS.map((l: string) => ({ label: l, value: l }))

const syncingTracker = ref(false)

const aria2ConfPath = ref('')
const sessionPath = ref('')
const logPath = ref('')

const { form, isDirty, handleSave, handleReset, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildAdvancedSystemConfig,
  transformForStore: transformAdvancedForStore,
  beforeSave: (f) => {
    const error = validateAdvancedForm(f)
    if (error) {
      message.error(t(error))
      return false
    }
    return true
  },
  afterSave: (f, prevConfig) => {
    // Sync UPnP mapping state only after a successful Save.
    if (f.enableUpnp !== prevConfig.enableUpnp) {
      syncUpnpState(!!f.enableUpnp, f.listenPort, f.dhtListenPort)
    }
  },
})

function buildForm() {
  const c = preferenceStore.config
  const { form: formData, generatedSecret } = buildAdvancedForm(c)
  // Side effect: persist auto-generated secret
  if (generatedSecret) {
    preferenceStore.updateAndSave({ rpcSecret: generatedSecret })
  }
  // Restore trackerSource default that buildAdvancedForm doesn't know about
  if (!c.trackerSource) {
    formData.trackerSource = [...DEFAULT_TRACKER_SOURCE]
  }
  return formData
}

function loadForm() {
  Object.assign(form.value, buildForm())
}

async function loadPaths() {
  try {
    aria2ConfPath.value = await resolveResource('engine/aria2.conf')
  } catch (e) {
    aria2ConfPath.value = ''
    logger.debug('Advanced.loadConf', e)
  }
  try {
    const dataDir = await appDataDir()
    sessionPath.value = await join(dataDir, 'download.session')
    logPath.value = await join(dataDir, 'motrix-next.log')
  } catch (e) {
    logger.debug('Advanced.loadPaths', e)
  }
}

async function handleSyncTracker() {
  if (form.value.trackerSource.length === 0) {
    message.warning(t('preferences.bt-tracker-select-source'))
    return
  }
  syncingTracker.value = true
  try {
    const results = await preferenceStore.fetchBtTracker(form.value.trackerSource)
    const text = convertTrackerDataToLine(results)
    if (text) {
      form.value.btTracker = text
      form.value.lastSyncTrackerTime = Date.now()
      message.success(t('preferences.bt-tracker-sync-succeed'))
    } else {
      message.error(t('preferences.bt-tracker-sync-failed'))
    }
  } catch (e) {
    logger.debug('Advanced.syncTracker', e)
    message.error(t('preferences.bt-tracker-sync-failed'))
  } finally {
    syncingTracker.value = false
  }
}

function onRpcPortDice() {
  form.value.rpcListenPort = randomRpcPort()
}

function onRpcSecretDice() {
  form.value.rpcSecret = generateSecret()
}

function onBtPortDice() {
  form.value.listenPort = randomBtPort()
}

function onDhtPortDice() {
  form.value.dhtListenPort = randomDhtPort()
}

// ─── UPnP Save-time Sync ─────────────────────────────────────────────

/** Sync UPnP port-mapping state after preferences are saved. */
async function syncUpnpState(enabled: boolean, btPort: number, dhtPort: number) {
  try {
    if (enabled) {
      await invoke('start_upnp_mapping', { btPort, dhtPort })
    } else {
      await invoke('stop_upnp_mapping')
    }
  } catch (e) {
    logger.warn('UPnP', `sync failed: ${e}`)
    message.warning(t('preferences.upnp-mapping-failed'))
  }
}

function changeUA(type: string) {
  const ua = userAgentMap[type]
  if (ua) form.value.userAgent = ua
}

function handleSessionReset() {
  dialog.warning({
    title: t('preferences.session-reset'),
    content: t('preferences.session-reset-confirm'),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      try {
        // Fetch ALL tasks from aria2 across every category.
        // taskStore.taskList only holds the currently displayed tab,
        // so we query aria2 directly to get the complete queue.
        const [activeTasks, stoppedTasks] = await Promise.all([
          fetchTaskList({ type: 'active' }),
          fetchTaskList({ type: 'stopped' }),
        ])
        const allGids = [...activeTasks, ...stoppedTasks].map((t) => t.gid)
        // Force-remove all tasks from aria2's in-memory queue.
        // Without this, tasks stay in memory and the 10-second
        // save-session-interval writes them back to disk.
        if (allGids.length > 0) {
          await taskStore.batchRemoveTask(allGids)
        }
        // Purge any remaining stopped download results from aria2.
        await taskStore.purgeTaskRecord()
        // Delete the session file itself.
        await invoke('clear_session_file')
        message.success(t('preferences.session-reset'))
      } catch (e) {
        logger.error('Advanced.sessionReset', e)
      }
    },
  })
}

function handleRestoreDefaults() {
  dialog.warning({
    title: t('preferences.restore-defaults'),
    content: t('preferences.restore-defaults-confirm'),
    positiveText: t('preferences.restore-defaults'),
    negativeText: t('app.cancel'),
    onPositiveClick: async () => {
      const ok = await preferenceStore.resetToDefaults()
      if (ok) {
        Object.assign(form.value, buildForm())
        resetSnapshot()
        message.success(t('preferences.restore-defaults-success'))
        dialog.info({
          title: t('preferences.restore-defaults'),
          content: t('preferences.restart-required'),
          positiveText: t('preferences.restart-now'),
          negativeText: t('app.cancel'),
          onPositiveClick: () => relaunch(),
        })
      }
    },
  })
}

function handleFactoryReset() {
  dialog.error({
    title: t('preferences.factory-reset'),
    content: t('preferences.factory-reset-confirm'),
    positiveText: t('app.yes'),
    negativeText: t('app.no'),
    onPositiveClick: async () => {
      try {
        await invoke('factory_reset')
        relaunch()
      } catch (e) {
        notifyError(e, 'config')
      }
    },
  })
}

onMounted(() => {
  loadForm()
  resetSnapshot()
  loadPaths()
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="240px" size="small" class="form-preference">
      <NDivider title-placement="left">{{ t('preferences.proxy') }}</NDivider>
      <NFormItem :label="t('preferences.enable-proxy')">
        <NSwitch v-model:value="form.proxy.enable" />
      </NFormItem>
      <template v-if="form.proxy.enable">
        <NFormItem :label="t('preferences.proxy-server')">
          <NInput v-model:value="form.proxy.server" placeholder="[http://][USER:PASSWORD@]HOST[:PORT]" />
        </NFormItem>
        <NFormItem label="Bypass">
          <NInput
            v-model:value="form.proxy.bypass"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 3 }"
            :placeholder="t('preferences.proxy-bypass-input-tips')"
          />
        </NFormItem>
        <NFormItem label="Scope">
          <NSelect v-model:value="form.proxy.scope" :options="proxyScopeOptions" multiple style="width: 100%" />
        </NFormItem>
        <NFormItem :show-label="false">
          <a
            target="_blank"
            href="https://github.com/AnInsomniacy/motrix-next/wiki/Proxy"
            rel="noopener noreferrer"
            class="info-link"
          >
            {{ t('preferences.proxy-tips') }} ↗
          </a>
        </NFormItem>
      </template>

      <NDivider title-placement="left">{{ t('preferences.bt-tracker') }}</NDivider>
      <NFormItem :label="t('preferences.bt-tracker-source')">
        <NInputGroup>
          <NSelect
            v-model:value="form.trackerSource"
            :options="trackerSourceOptions"
            multiple
            :placeholder="t('preferences.bt-tracker-tips')"
            style="flex: 1"
            clearable
            max-tag-count="responsive"
          />
          <NButton :loading="syncingTracker" size="small" style="flex-shrink: 0" @click="handleSyncTracker">
            <template #icon>
              <NIcon><SyncOutline /></NIcon>
            </template>
            {{ t('preferences.bt-tracker-sync') }}
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.bt-tracker-content')">
        <NInput
          v-model:value="form.btTracker"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :placeholder="t('preferences.bt-tracker-input-tips')"
        />
      </NFormItem>
      <NFormItem :show-label="false">
        <div class="info-text">
          {{ t('preferences.bt-tracker-tips') }}
          <a target="_blank" href="https://github.com/ngosang/trackerslist" rel="noopener noreferrer" class="info-link"
            >ngosang/trackerslist ↗</a
          >
          <a
            target="_blank"
            href="https://github.com/XIU2/TrackersListCollection"
            rel="noopener noreferrer"
            class="info-link"
            style="margin-left: 8px"
            >XIU2/TrackersListCollection ↗</a
          >
        </div>
      </NFormItem>
      <NFormItem :label="t('preferences.auto-sync-tracker')">
        <NSwitch v-model:value="form.autoSyncTracker" />
      </NFormItem>
      <NFormItem v-if="form.lastSyncTrackerTime" :show-label="false">
        <div class="info-text">{{ new Date(form.lastSyncTrackerTime).toLocaleString() }}</div>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.rpc') }}</NDivider>
      <NFormItem :label="t('preferences.rpc-listen-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.rpcListenPort" :min="1024" :max="65535" style="width: 160px" />
          <NButton style="padding: 0 10px" @click="onRpcPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.rpc-secret')" :validation-status="form.rpcSecret ? undefined : 'error'">
        <NInputGroup>
          <NInput
            v-model:value="form.rpcSecret"
            type="password"
            show-password-on="click"
            placeholder="RPC Secret"
            style="flex: 1"
            :status="form.rpcSecret ? undefined : 'error'"
          />
          <NButton style="padding: 0 10px" @click="onRpcSecretDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.port') }}</NDivider>
      <NFormItem label="UPnP/NAT-PMP">
        <NSwitch v-model:value="form.enableUpnp" />
      </NFormItem>
      <NFormItem :label="t('preferences.bt-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.listenPort" :min="1024" :max="65535" style="width: 160px" />
          <NButton style="padding: 0 10px" @click="onBtPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.dht-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.dhtListenPort" :min="1024" :max="65535" style="width: 160px" />
          <NButton style="padding: 0 10px" @click="onDhtPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.user-agent') }}</NDivider>
      <NFormItem :label="t('preferences.mock-user-agent')">
        <NInput
          v-model:value="form.userAgent"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          placeholder="User-Agent"
        />
      </NFormItem>
      <NFormItem :show-label="false">
        <NSpace align="center" :size="8">
          <NButtonGroup size="small">
            <NButton @click="changeUA('aria2')">Aria2</NButton>
            <NButton @click="changeUA('transmission')">Transmission</NButton>
            <NButton @click="changeUA('chrome')">Chrome</NButton>
            <NButton @click="changeUA('du')">du</NButton>
          </NButtonGroup>
          <NButton size="small" quaternary type="warning" @click="form.userAgent = ''">Reset</NButton>
        </NSpace>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.developer') }}</NDivider>
      <NFormItem :label="t('preferences.aria2-conf-path')">
        <NInput :value="aria2ConfPath" readonly />
      </NFormItem>
      <NFormItem :label="t('preferences.download-session-path')">
        <NInput :value="sessionPath" readonly />
      </NFormItem>
      <NFormItem :label="t('preferences.app-log-path')">
        <NInputGroup>
          <NInput :value="logPath" readonly style="flex: 1" />
          <NSelect v-model:value="form.logLevel" :options="logLevelOptions" style="width: 110px" />
        </NInputGroup>
      </NFormItem>
      <NFormItem :show-label="false">
        <NSpace>
          <NButton type="warning" ghost @click="handleSessionReset">{{ t('preferences.session-reset') }}</NButton>
          <NButton type="error" ghost @click="handleFactoryReset">{{ t('preferences.factory-reset') }}</NButton>
        </NSpace>
      </NFormItem>
    </NForm>
    <PreferenceActionBar
      :is-dirty="isDirty"
      @save="handleSave"
      @discard="handleReset"
      @restore="handleRestoreDefaults"
    />
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
  padding: 16px 24px 64px 24px;
}
.form-preference :deep(.n-form-item) {
  padding-left: 50px;
}
.info-text {
  color: var(--m3-on-surface-variant);
  font-size: 12px;
}
.info-link {
  color: var(--color-primary);
  text-decoration: none;
  font-size: 12px;
}
.info-link:hover {
  text-decoration: underline;
}
.action-link {
  color: var(--color-primary);
  cursor: pointer;
  margin-left: 8px;
  font-size: 12px;
}
.action-link:hover {
  text-decoration: underline;
}
.form-actions {
  position: sticky;
  bottom: 0;
  z-index: 10;
  padding: 16px 24px 16px 40px;
}
</style>
