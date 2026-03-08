<script setup lang="ts">
/** @fileoverview Advanced preference form: proxy, tracker, RPC, port, and protocol settings. */
import { ref, h, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useTaskStore } from '@/stores/task'
import { relaunch } from '@tauri-apps/plugin-process'
import { appDataDir, resolveResource } from '@tauri-apps/api/path'
import {
  NGOSANG_TRACKERS_BEST_URL_CDN,
  NGOSANG_TRACKERS_BEST_IP_URL_CDN,
  ENGINE_RPC_PORT,
  LOG_LEVELS,
  PROXY_SCOPE_OPTIONS,
} from '@shared/constants'
import { convertCommaToLine, convertLineToComma, generateRandomInt } from '@shared/utils'
import { convertTrackerDataToLine } from '@shared/utils/tracker'
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
import { SyncOutline, DiceOutline } from '@vicons/ionicons5'
import { logger } from '@shared/logger'
import type { AppConfig } from '@shared/types'
import PreferenceActionBar from './PreferenceActionBar.vue'

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const message = useAppMessage()
const dialog = useDialog()

const DEFAULT_TRACKER_SOURCE = [NGOSANG_TRACKERS_BEST_URL_CDN, NGOSANG_TRACKERS_BEST_IP_URL_CDN]

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

function generateSecret(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const values = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(values, (v) => chars[v % chars.length]).join('')
}

const { form, isDirty, handleSave, handleReset } = usePreferenceForm({
  buildForm,
  buildSystemConfig: (f) => ({
    'rpc-listen-port': String(f.rpcListenPort),
    'rpc-secret': f.rpcSecret,
    'enable-dht': 'true',
    'enable-peer-exchange': 'true',
    'enable-upnp': String(f.enableUpnp),
    'listen-port': String(f.listenPort),
    'dht-listen-port': String(f.dhtListenPort),
    'user-agent': f.userAgent || '',
    'log-level': f.logLevel || 'warn',
    'bt-tracker': convertLineToComma(f.btTracker),
  }),
  transformForStore: (f) =>
    ({
      ...f,
      btTracker: convertLineToComma(f.btTracker),
      proxy: { ...f.proxy, scope: f.proxy.scope as unknown as string },
    }) as unknown as Partial<AppConfig>,
  beforeSave: (f) => {
    if (!f.rpcSecret) {
      message.error(t('preferences.rpc-secret-empty-warning'))
      return false
    }
    return true
  },
})

function buildForm() {
  const c = preferenceStore.config
  const proxy = c.proxy || { enable: false, server: '', bypass: '', scope: [] }
  const protocols = c.protocols || { magnet: false, thunder: false }
  const savedSecret = c.rpcSecret || ''
  const rpcSecret = savedSecret || generateSecret()
  if (!savedSecret) {
    preferenceStore.updateAndSave({ rpcSecret })
  }
  return {
    proxy: {
      enable: !!proxy.enable,
      server: proxy.server || '',
      bypass: proxy.bypass || '',
      scope: proxy.scope || [...PROXY_SCOPE_OPTIONS],
    },
    trackerSource: c.trackerSource || [...DEFAULT_TRACKER_SOURCE],
    btTracker: convertCommaToLine(c.btTracker || ''),
    autoSyncTracker: !!c.autoSyncTracker,
    lastSyncTrackerTime: c.lastSyncTrackerTime || 0,
    rpcListenPort: c.rpcListenPort || ENGINE_RPC_PORT,
    rpcSecret,
    enableUpnp: c.enableUpnp !== false,
    listenPort: Number(c.listenPort) || 21301,
    dhtListenPort: Number(c.dhtListenPort) || 26701,
    protocols: {
      magnet: protocols.magnet !== false,
      thunder: !!protocols.thunder,
    },
    userAgent: c.userAgent || '',
    logLevel: c.logLevel || 'warn',
  }
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
    sessionPath.value = `${dataDir}download.session`
    logPath.value = `${dataDir}motrix-next.log`
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
  form.value.rpcListenPort = generateRandomInt(ENGINE_RPC_PORT, 20000)
}

function onRpcSecretDice() {
  form.value.rpcSecret = generateSecret()
}

function onBtPortDice() {
  form.value.listenPort = generateRandomInt(20000, 24999)
}

function onDhtPortDice() {
  form.value.dhtListenPort = generateRandomInt(25000, 29999)
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
        await taskStore.purgeTaskRecord()
        await taskStore.pauseAllTask()
        message.success(t('preferences.session-reset'))
      } catch (e) {
        logger.error('Advanced.sessionReset', e)
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
        logger.error('Advanced.factoryReset', e)
      }
    },
  })
}

onMounted(() => {
  loadForm()
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

      <NDivider title-placement="left">{{ t('preferences.download-protocol') }}</NDivider>
      <NFormItem :show-label="false">
        <div class="info-text">{{ t('preferences.protocols-default-client') }}</div>
      </NFormItem>
      <NFormItem :label="t('preferences.protocols-magnet')">
        <NSwitch v-model:value="form.protocols.magnet" />
      </NFormItem>
      <NFormItem :label="t('preferences.protocols-thunder')">
        <NSwitch v-model:value="form.protocols.thunder" />
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
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" />
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
  color: #999;
  font-size: 12px;
}
.info-link {
  color: #e8a838;
  text-decoration: none;
  font-size: 12px;
}
.info-link:hover {
  text-decoration: underline;
}
.action-link {
  color: #e8a838;
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
