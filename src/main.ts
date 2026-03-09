/** @fileoverview Application entry point: mounts Vue, initializes i18n, aria2 engine, and IPC listeners. */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import { i18n } from '@/composables/useLocale'
import { setI18nLocale } from '@shared/utils/i18n'
import { usePreferenceStore } from './stores/preference'
import { useTaskStore } from './stores/task'
import { useAppStore } from './stores/app'
import aria2Api, { initClient } from './api/aria2'
import { ENGINE_RPC_PORT, AUTO_SYNC_TRACKER_INTERVAL, DEFAULT_TRACKER_SOURCE } from '@shared/constants'
import { convertTrackerDataToLine, convertTrackerDataToComma, reduceTrackerString } from '@shared/utils/tracker'
import { logger } from '@shared/logger'
import { normalizeError } from '@shared/errorNormalizer'
import App from './App.vue'
import 'virtual:uno.css'
import './styles/variables.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { getLocale } from 'tauri-plugin-locale-api'
import { platform } from '@tauri-apps/plugin-os'

document.documentElement.dataset.platform = platform()

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(i18n)

app.mount('#app')

// Window visibility is deferred until preferences are loaded (see below).
// This replaces the unconditional show() that ignored autoHideWindow.

const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const appStore = useAppStore()

async function waitForEngine(port: number, secret: string, maxRetries = 15): Promise<boolean> {
  const { Aria2 } = await import('@shared/aria2')
  for (let i = 0; i < maxRetries; i++) {
    try {
      const probe = new Aria2({ host: '127.0.0.1', port, secret })
      await probe.open()
      await probe.call('getVersion')
      await probe.close()
      return true
    } catch (e) {
      logger.debug('waitForEngine', `attempt ${i + 1}/${maxRetries} failed: ${e}`)
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  return false
}

async function autoCheckForUpdate() {
  const config = preferenceStore.config
  if (config.autoCheckUpdate === false) return

  const lastCheck = Number(config.lastCheckUpdateTime) || 0
  const intervalMs = (Number(config.autoCheckUpdateInterval) || 24) * 3_600_000
  if (Date.now() - lastCheck < intervalMs) return

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const channel = config.updateChannel || 'stable'
    const proxy = config.proxy
    const proxyServer =
      proxy?.enable && proxy.server && (proxy.scope || []).includes('update-app') ? proxy.server : null
    const update = await invoke<{ version: string; body: string | null; date: string | null } | null>(
      'check_for_update',
      { channel, proxy: proxyServer },
    )
    preferenceStore.updateAndSave({ lastCheckUpdateTime: Date.now() })
    if (update) {
      appStore.pendingUpdate = { version: update.version, body: update.body, date: update.date }
    }
  } catch (e) {
    logger.warn('Updater', 'auto check failed: ' + (e as Error).message)
  }
}

async function autoSyncTrackerOnStartup() {
  const config = preferenceStore.config
  if (!config.autoSyncTracker) return

  const lastSync = config.lastSyncTrackerTime || 0
  if (Date.now() - lastSync < AUTO_SYNC_TRACKER_INTERVAL) return

  const sources = config.trackerSource?.length ? config.trackerSource : DEFAULT_TRACKER_SOURCE
  try {
    const results = await preferenceStore.fetchBtTracker(sources)
    const text = convertTrackerDataToLine(results)
    if (!text) return

    const comma = convertTrackerDataToComma(results)
    await preferenceStore.updateAndSave({
      btTracker: comma,
      trackerSource: sources,
      lastSyncTrackerTime: Date.now(),
    })

    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_system_config', { config: { 'bt-tracker': reduceTrackerString(comma) } })
    logger.info('Tracker', `Auto-synced ${results.length} tracker source(s)`)
  } catch (e) {
    logger.debug('Tracker', 'auto-sync failed: ' + (e as Error).message)
  }
}

preferenceStore.loadPreference().then(async () => {
  let locale = preferenceStore.locale
  if (!locale) {
    try {
      const raw = (await getLocale()) || 'en-US'
      const sysLang = raw.replace('-Hans', '').replace('-Hant', '')
      const available = i18n.global.availableLocales
      if (available.includes(sysLang)) {
        locale = sysLang
      } else {
        const prefix = sysLang.split('-')[0]
        locale = available.find((l) => l === prefix || l.startsWith(prefix + '-')) || 'en-US'
      }
    } catch (e) {
      logger.debug('main.locale', e)
      locale = 'en-US'
    }
    // Update config reactively FIRST (synchronous), then persist to disk (async).
    // updateAndSave() delays config.value assignment until after file I/O,
    // which causes a race: components that mount before the save completes
    // would read stale '' locale and fall back to 'en-US'.
    preferenceStore.updatePreference({ locale })
    preferenceStore.savePreference()
  }
  if (locale && i18n.global.locale) {
    setI18nLocale(i18n, locale)
  }

  const config = preferenceStore.config
  const port = config.rpcListenPort || ENGINE_RPC_PORT
  let secret = config.rpcSecret || ''

  if (!secret) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const values = crypto.getRandomValues(new Uint8Array(16))
    secret = Array.from(values, (v) => chars[v % chars.length]).join('')
    await preferenceStore.updateAndSave({ rpcSecret: secret })
  }

  taskStore.setApi(aria2Api)

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_system_config', {
      config: { 'rpc-secret': secret, 'rpc-listen-port': String(port) },
    })
    await invoke('start_engine_command')
  } catch (e) {
    logger.error('Engine', e)
    appStore.startupErrors.push(normalizeError(e, 'engine'))
  }

  const ready = await waitForEngine(port, secret)
  if (!ready) {
    logger.error('Engine', 'Engine did not become ready after retries')
    appStore.startupErrors.push(normalizeError('Engine did not become ready after retries', 'engine'))
  }

  try {
    await initClient({ port, secret })
    logger.info('Engine', `RPC client connected via WebSocket on port ${port}`)

    // Warm up Tauri FS plugin IPC channel to eliminate cold-start delay on first
    // file operation (e.g. task deletion). Deferred to avoid impacting startup.
    setTimeout(() => {
      import('@tauri-apps/plugin-fs').then(({ exists }) => exists('/')).catch(() => {})
    }, 500)
  } catch (e) {
    logger.warn('Engine', 'WebSocket failed, using HTTP fallback: ' + (e as Error).message)
    // Engine is running (confirmed by waitForEngine), mark as ready for HTTP RPC polling
    const { setEngineReady } = await import('@/api/aria2')
    setEngineReady(true)
  }

  try {
    const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
    const startUrls = await getCurrent()
    if (startUrls && startUrls.length > 0) {
      appStore.handleDeepLinkUrls(startUrls)
    }
    await onOpenUrl((urls) => {
      appStore.handleDeepLinkUrls(urls)
    })
  } catch (e) {
    logger.warn('DeepLink', 'setup failed: ' + (e as Error).message)
  }

  // Show the window unless user has autoHideWindow enabled
  if (!config.autoHideWindow) {
    const mainWindow = getCurrentWindow()
    await mainWindow.show()
    await mainWindow.setFocus()
  }

  // Resume all paused/waiting tasks on launch if configured
  if (config.resumeAllWhenAppLaunched) {
    taskStore.resumeAllTask().catch((e) => logger.debug('main.resumeAll', e))
  }

  // Start UPnP port mapping if enabled (mirrors legacy Motrix initUPnPManager)
  if (config.enableUpnp) {
    import('@tauri-apps/api/core')
      .then(({ invoke }) =>
        invoke('start_upnp_mapping', {
          btPort: Number(config.listenPort) || 21301,
          dhtPort: Number(config.dhtListenPort) || 26701,
        }),
      )
      .catch((e) => logger.warn('UPnP', 'startup mapping failed: ' + e))
  }

  // Sync autostart state with user preference
  try {
    const { isEnabled, enable, disable } = await import('@tauri-apps/plugin-autostart')
    const currentlyEnabled = await isEnabled()
    if (config.openAtLogin && !currentlyEnabled) {
      await enable()
    } else if (!config.openAtLogin && currentlyEnabled) {
      await disable()
    }
  } catch (e) {
    logger.debug('main.autostart', e)
  }

  autoCheckForUpdate()
  autoSyncTrackerOnStartup()

  // Re-check tracker sync hourly for long-running sessions.
  // autoSyncTrackerOnStartup() internally de-duplicates via lastSyncTrackerTime.
  setInterval(autoSyncTrackerOnStartup, 3_600_000)

  let lastClipboardText = ''
  getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
    if (!focused) return
    if (appStore.addTaskVisible) return
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
      const text = ((await readText()) || '').trim()
      if (!text || text === lastClipboardText) return
      const { detectResource } = await import('@shared/utils')
      if (detectResource(text)) {
        lastClipboardText = text
        const { createBatchItem } = await import('@shared/utils/batchHelpers')
        appStore.enqueueBatch([createBatchItem('uri', text)])
      }
    } catch (e) {
      logger.debug('Main.clipboardMonitor', e)
    }
  })
})
