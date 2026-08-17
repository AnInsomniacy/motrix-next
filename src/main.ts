/** @fileoverview Application entry point: mounts Vue, initializes i18n, aria2 engine, and IPC listeners. */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import { i18n, loadLocale, SUPPORTED_LOCALES } from '@/composables/useLocale'
import { setI18nLocale } from '@shared/utils/i18n'
import { usePreferenceStore } from './stores/preference'
import { useTaskStore } from './stores/task'
import { useAppStore } from './stores/app'
import { useHistoryStore } from './stores/history'
import aria2Api from './api/aria2'
import {
  BT_LISTEN_PORT,
  DEFAULT_TRACKER_SOURCE,
  DHT_LISTEN_PORT,
  ENGINE_RPC_PORT,
  PROXY_SCOPES,
} from '@shared/constants'
import { convertTrackerDataToLine, convertTrackerDataToComma, reduceTrackerString } from '@shared/utils/tracker'
import { logger } from '@shared/logger'
import { getErrorMessage } from '@shared/utils/errorMessage'
import { resolveUserVisibleDownloadDir, shouldPersistResolvedDownloadDir } from '@shared/utils/userVisibleDirectory'
import { getUpdateProxy } from '@/composables/useUpdateFlow'
import { resolveAppProxyUrl } from '@shared/utils/proxy'
import { checkSyncDue } from '@shared/utils/syncSchedule'
import type { AppConfig, TauriUpdate } from '@shared/types'
import App from './App.vue'
import 'virtual:uno.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/transitions.css'
import './styles/preferences.css'
import './styles/naive-overrides.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { resolveSystemLocale } from '@shared/utils/locale'
import { usePlatform } from '@/composables/usePlatform'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)
app.use(i18n)

const { isMobile } = usePlatform()

// ── Global error boundary — catch all uncaught exceptions to log file ──
// Register before preference hydration so startup failures do not disappear
// before Vue mounts and the app-level handler becomes active.
window.addEventListener('error', (e) => {
  logger.error('GlobalError', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  logger.error('UnhandledRejection', e.reason)
})
app.config.errorHandler = (err) => {
  logger.error('VueError', err)
}

// ── Production guard: suppress browser default context menu ─────────
// In dev mode, keep the context menu for DevTools / Inspect Element.
// Industry standard for Tauri/Electron desktop apps (Discord, Slack, VS Code).
// Mobile (Android): long-press context menu is a native touch interaction —
// keep it so text selection / copy works.
if (import.meta.env.PROD && !isMobile.value) {
  document.addEventListener('contextmenu', (e) => e.preventDefault())
}

// ── Main window initialization ──────────────────────────────────────

{
  const preferenceStore = usePreferenceStore()
  const taskStore = useTaskStore()
  const appStore = useAppStore()
  const historyStore = useHistoryStore()

  /** Rust-side health check: probes Aria2 Next HTTP RPC with retries.
   *  Also updates Aria2Client credentials so invoke() commands work. */
  async function waitForEngine(): Promise<boolean> {
    const { invoke } = await import('@tauri-apps/api/core')
    try {
      return await invoke<boolean>('wait_for_engine')
    } catch (e) {
      logger.error('waitForEngine', `invoke failed: ${e}`)
      return false
    }
  }

  async function autoCheckForUpdate() {
    const config = preferenceStore.config
    if (config.autoCheckUpdate === false) return

    const intervalHours = Number(config.autoCheckUpdateInterval ?? 0)
    if (Number.isFinite(intervalHours) && intervalHours > 0) {
      const lastCheck = Number(config.lastCheckUpdateTime) || 0
      const intervalMs = intervalHours * 3_600_000
      if (Date.now() - lastCheck < intervalMs) return
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const channel = config.updateChannel || 'stable'
      const proxyServer = getUpdateProxy(config.proxy)
      const update = await invoke<TauriUpdate | null>('check_for_update', { channel, proxy: proxyServer })
      if (update) {
        appStore.pendingUpdate = update
      }
      preferenceStore.updateAndSave({ lastCheckUpdateTime: Date.now() })
    } catch (e) {
      logger.warn('Updater', 'auto check failed: ' + (e as Error).message)
    }
  }

  function emitAppToast(payload: { type: 'success' | 'info' | 'warning' | 'error'; key: string }): void {
    window.dispatchEvent(new CustomEvent('app:toast', { detail: payload }))
  }

  async function syncBtTrackersIfDue(startup: boolean) {
    const config = preferenceStore.config
    if (
      !checkSyncDue({
        enabled: !!config.btTrackerAutoSync,
        intervalHours: Number(config.btTrackerSyncIntervalHours),
        lastSyncTime: Number(config.lastSyncTrackerTime),
        now: Date.now(),
        startup,
      })
    ) {
      return
    }

    const sources = config.trackerSource?.length ? config.trackerSource : DEFAULT_TRACKER_SOURCE
    try {
      const result = await preferenceStore.fetchBtTracker(sources)
      const text = convertTrackerDataToLine(result.data)
      if (!text) return

      const comma = convertTrackerDataToComma(result.data)
      await preferenceStore.updateAndSave({
        btTracker: comma,
        lastSyncTrackerTime: Date.now(),
      })

      const { invoke } = await import('@tauri-apps/api/core')
      const reduced = reduceTrackerString(comma)
      await invoke('save_system_config', { config: { 'bt-tracker': reduced } })
      if (appStore.engineReady) {
        await aria2Api.changeGlobalOption({ 'bt-tracker': reduced } as Partial<AppConfig>)
      }
      logger.info('Tracker', `Auto-synced: ${result.data.length}/${sources.length} source(s) succeeded`)
      emitAppToast({ type: 'success', key: 'preferences.bt-tracker-sync-succeed' })
    } catch (e) {
      logger.debug('Tracker', 'auto-sync failed: ' + (e as Error).message)
    }
  }

  async function syncEd2kBootstrapIfDue(startup: boolean) {
    const config = preferenceStore.config
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const status = await invoke<{ serverMetModified: number | null; nodesDatModified: number | null }>(
        'get_ed2k_bootstrap_status',
      )
      const lastSync = Math.max(status.serverMetModified ?? 0, status.nodesDatModified ?? 0)
      if (
        !checkSyncDue({
          enabled: !!config.ed2kBootstrapAutoSync,
          intervalHours: Number(config.ed2kBootstrapSyncIntervalHours),
          lastSyncTime: lastSync,
          now: Date.now(),
          startup,
        })
      ) {
        return
      }

      await invoke('sync_ed2k_bootstrap_files', {
        serverMetUrl: config.ed2kServerMetUrl,
        nodesDatUrl: config.ed2kNodesDatUrl,
        proxy: resolveAppProxyUrl(config.proxy, PROXY_SCOPES.UPDATE_TRACKERS) ?? undefined,
      })
      logger.info('ED2K', 'Bootstrap files auto-synced')
      emitAppToast({ type: 'success', key: 'preferences.ed2k-bootstrap-sync-succeed' })
    } catch (e) {
      logger.debug('ED2K.bootstrapAutoSync', e)
    }
  }

  function syncNetworkSourcesIfDue(startup: boolean) {
    void syncBtTrackersIfDue(startup)
    void syncEd2kBootstrapIfDue(startup)
  }

  // ---------------------------------------------------------------------------
  // Startup orchestration
  //
  // The chain is split into phases that run as parallel as possible so the
  // window appears almost instantly while the engine boots in the background.
  //
  //  Phase 1 (critical path)   – loadPreference → locale → window.show()
  //  Phase 2 (engine, async)   – rpcSecret → save config → start engine
  //                              → on_engine_ready (Rust) → wait_for_engine
  //  Phase 3 (non-critical)    – autostart, protocol sync (parallel)
  //  Phase 4 (deferred)        – update check, tracker sync, FS warmup,
  //                              clipboard monitor
  // ---------------------------------------------------------------------------

  /** Start the aria2 engine, wait for readiness, and connect the RPC client.
   *  Returns `true` if the engine is usable, `false` on failure. */
  async function initEngine(port: number, secret: string, config: AppConfig): Promise<boolean> {
    try {
      const { invoke } = await import('@tauri-apps/api/core')

      // Resolve a user-visible writable directory before aria2 starts.
      let defaultDir = ''
      let configuredDirIsHome = false
      if (config.dir) {
        try {
          const { homeDir } = await import('@tauri-apps/api/path')
          const home = (await homeDir()).replace(/\\/g, '/').replace(/\/+$/, '')
          const configured = config.dir.replace(/\\/g, '/').replace(/\/+$/, '')
          configuredDirIsHome = !!home && configured === home
        } catch (e) {
          logger.debug('Engine.defaultDirHomeCheck', e)
        }
      }

      if (!config.dir || configuredDirIsHome) {
        const resolvedDir = await resolveUserVisibleDownloadDir()
        defaultDir = resolvedDir.path
        if (defaultDir) {
          config.dir = defaultDir
          if (shouldPersistResolvedDownloadDir(resolvedDir)) {
            preferenceStore.updateAndSave({ dir: defaultDir })
          }
          logger.info(
            'Engine',
            `resolved default download dir source=${resolvedDir.source} fallback=${resolvedDir.usedFallback}`,
          )
        }
      }

      // Seed system.json with the FULL set of default system config values.
      // This ensures CLI args include --split, --max-connection-per-server,
      // --user-agent, etc. even before the user opens the preference page.
      // On subsequent launches, saved values from Downloads/BT/Network/Advanced
      // preferences already exist in system.json and will be merged (not overwritten).
      const { buildSystemConfigFromAppConfig } = await import('@shared/utils/systemConfig')

      await invoke('save_system_config', {
        config: {
          ...buildSystemConfigFromAppConfig(config, defaultDir),
          // Override with runtime values — secret may have been auto-generated
          'rpc-secret': secret,
          'rpc-listen-port': String(port),
        },
      })
      // start_engine_command ONLY spawns the bundled engine sidecar.
      // Credential update + option sync happen in wait_for_engine
      // (after Aria2 Next is confirmed ready).
      await invoke('start_engine_command')
    } catch (e) {
      logger.error('Engine', e)
      return false
    }

    // Rust-side health check: probe → on_engine_ready (credential + option sync)
    const ready = await waitForEngine()
    if (!ready) {
      logger.error('Engine', 'Engine did not become ready after retries')
      return false
    }

    // Mark frontend as ready — invoke() transport is always available
    const { setEngineReady } = await import('@/api/aria2')
    setEngineReady(true)
    logger.info('Engine', `Rust aria2 client connected via invoke() on port ${port}`)
    return true
  }

  /**
   * Sync autostart state with persisted preference.
   *
   * When `openAtLogin` is true we **always** call `enable()`, even if
   * `isEnabled()` reports true.  This is a deliberate workaround for
   * auto-launch crate v0.5.0 bug: on Windows the registry entry under
   * `HKCU\...\Run` is sometimes removed after the first successful
   * launch (tauri-apps/plugins-workspace#771).  Re-calling `enable()`
   * is idempotent and guarantees the entry + `--autostart` args are
   * present for the next boot.
   */
  async function syncAutostart(config: typeof preferenceStore.config): Promise<void> {
    // Mobile: autostart has no meaning on Android — skip entirely.
    if (isMobile.value) return
    try {
      const { isEnabled, enable, disable } = await import('@tauri-apps/plugin-autostart')
      const currentlyEnabled = await isEnabled()

      if (config.openAtLogin) {
        // Always re-enable to self-heal the registry (#771 workaround).
        await enable()
        logger.info('main.autostart', `ensured enabled (was=${currentlyEnabled} openAtLogin=${config.openAtLogin})`)
      } else if (currentlyEnabled) {
        await disable()
        logger.info('main.autostart', 'disabled (openAtLogin=false)')
      }
    } catch (e) {
      logger.debug('main.autostart', e)
    }
  }

  async function bootstrapMainWindow(): Promise<void> {
    // ── Phase 1: critical path → window visible ASAP ──────────────────────
    await preferenceStore.loadPreference()

    const storedLocale = preferenceStore.locale
    let resolvedLocale: string

    if (!storedLocale || storedLocale === 'auto') {
      // First install (empty/auto) or explicit Follow System mode:
      // detect the OS locale and resolve to the closest available match.
      try {
        // Desktop: tauri-plugin-locale. Mobile (Android): the plugin is
        // desktop-only — fall back to the WebView's navigator.language.
        let raw = 'en-US'
        if (isMobile.value) {
          raw = navigator.language || 'en-US'
        } else {
          const { getLocale } = await import('tauri-plugin-locale-api')
          raw = (await getLocale()) || 'en-US'
        }
        resolvedLocale = resolveSystemLocale(raw, SUPPORTED_LOCALES)
      } catch (e) {
        logger.debug('main.locale', e)
        resolvedLocale = 'en-US'
      }

      if (!storedLocale) {
        // Legacy first-install path (locale was ''): persist 'auto' so
        // subsequent launches continue to follow the system language.
        preferenceStore.updatePreference({ locale: 'auto' })
        preferenceStore.savePreference()
      }
      // When storedLocale is already 'auto', we intentionally do NOT
      // overwrite it — the config stays 'auto' across restarts.
    } else {
      // Explicit locale chosen by the user (e.g. 'zh-CN', 'ja').
      resolvedLocale = storedLocale
    }

    // Apply resolved locale to vue-i18n and expose it on the store
    // so downstream consumers (direction, General.vue) can read it.
    // Locale messages are lazily loaded — only en-US ships in the main bundle.
    if (resolvedLocale) {
      await loadLocale(resolvedLocale)
      setI18nLocale(i18n, resolvedLocale)
    }

    // Flush deferred migration toasts now that i18n locale is active.
    // loadPreference() buffers these signals to avoid showing English toasts.
    preferenceStore.flushMigrationSignals()

    // Mount only after preference + locale hydration so root-level theme,
    // color-scheme, locale, and layout watchers see stable persisted values
    // on their first run. The native window is still hidden until
    // MainLayout.onMounted explicitly shows it.
    app.mount('#app')

    const config = preferenceStore.config

    // ── Phase 2: engine startup (non-blocking) ────────────────────────────
    const port = config.rpcListenPort || ENGINE_RPC_PORT
    const secret = config.rpcSecret

    taskStore.setApi(aria2Api)

    // Engine initializes in the background — does NOT block the UI.
    // appStore.engineRestarting drives the engine banner in MainLayout.
    const enginePromise = initEngine(port, secret, config)

    // ── Phase 3: non-critical IPC ────────────────────────────────────────
    //
    // External input routing is owned by Rust and consumed from
    // `take_pending_deep_links` after MainLayout registers listeners. Do not
    // call tauri-plugin-deep-link `getCurrent()` here: that value is
    // process-level plugin state, so lightweight-mode WebView recreation would
    // replay stale torrent/protocol inputs.
    Promise.allSettled([syncAutostart(config)])

    // Start UPnP port mapping if enabled (fire-and-forget)
    if (config.enableUpnp) {
      import('@tauri-apps/api/core')
        .then(({ invoke }) =>
          invoke('start_upnp_mapping', {
            btPort: Number(config.listenPort) || BT_LISTEN_PORT,
            btExternalPort: Number(config.btExternalPort) || 0,
            dhtPort: Number(config.dhtListenPort) || DHT_LISTEN_PORT,
            ed2kPort: Number(config.ed2kListenPort) > 0 ? Number(config.ed2kListenPort) : null,
            ed2kUdpPort: Number(config.ed2kUdpListenPort) > 0 ? Number(config.ed2kUdpListenPort) : null,
          }),
        )
        .catch((e) => logger.warn('UPnP', `startup mapping failed: ${getErrorMessage(e)}`))
    }

    // ── Phase 2 completion: engine ready ───────────────────────────────────
    // try/finally guarantees engineRestarting always clears, even on failure.
    // engineReady distinguishes success from failure for the UI toast.
    try {
      const ok = await enginePromise
      appStore.engineReady = ok

      // Global option sync and speed scheduler are now handled by Rust:
      // - on_engine_ready() syncs system.json options to aria2 via changeGlobalOption
      // - spawn_speed_scheduler() runs a 60s timer in tokio (no WebView needed)
      if (ok) {
        await preferenceStore.reloadPreferenceFromDisk()
        logger.info('Engine', 'Rust on_engine_ready completed: options synced, services spawned')
      }
    } catch (e) {
      logger.error('Engine', 'unexpected startup error: ' + e)
      appStore.engineReady = false
    } finally {
      appStore.setEngineRestarting(false)
    }

    // Resume all paused/waiting tasks on launch if configured
    if (config.resumeAllWhenAppLaunched) {
      taskStore.resumeAllTask().catch((e) => logger.debug('main.resumeAll', e))
    }

    // ── Phase 4: deferred non-critical tasks ───────────────────────────────
    autoCheckForUpdate()
    syncNetworkSourcesIfDue(true)

    // Initialize download history database, then schedule lightweight cleanup.
    historyStore
      .init({
        onCorrupt: () => logger.warn('HistoryDB', 'Database corrupted, rebuilding…'),
        onError: (e) => logger.warn('HistoryDB', `Load failed, rebuilding… ${e}`),
        onRebuilt: () => logger.info('HistoryDB', 'Database rebuilt successfully'),
        onRebuildFailed: (e) => logger.error('HistoryDB', `Rebuild failed: ${e}`),
      })
      .then(() => {
        const runCleanup = async () => {
          try {
            const { runHistoryMaintenance } = await import('./composables/useStaleCleanup')
            const { extractHistoryFilePaths } = await import('./composables/useTaskLifecycle')
            await runHistoryMaintenance({
              autoDeleteStaleRecords: !!preferenceStore.config?.autoDeleteStaleRecords,
              completedRecordRetentionDays: Number(preferenceStore.config?.completedRecordRetentionDays ?? 0),
              getRecords: historyStore.getRecords,
              removeStaleRecords: historyStore.removeStaleRecords,
              removeHistoryRecords: historyStore.removeStaleRecords,
              removeTaskRecord: aria2Api.removeTaskRecord,
              extractFilePaths: extractHistoryFilePaths,
            })
          } catch (e) {
            logger.debug('HistoryMaintenance', e)
          }
        }
        // First scan 30s after startup — not urgent.
        setTimeout(runCleanup, 30_000)
        // Re-scan every 30 minutes for long-running sessions.
        setInterval(runCleanup, 1_800_000)
      })
      .catch((e) => logger.warn('HistoryDB', 'init failed: ' + e))

    setInterval(() => syncNetworkSourcesIfDue(false), 3_600_000)

    // Warm up Tauri FS plugin IPC channel to eliminate cold-start delay on first
    // file operation (e.g. task deletion).
    setTimeout(() => {
      import('@tauri-apps/plugin-fs').then(({ exists }) => exists('/')).catch(() => {})
    }, 3000)

    // ── Lightweight mode: destroy WebView after autostart init ─────────
    //
    // When autostart + autoHideWindow + lightweightMode are all enabled,
    // destroy the WebView to free ~300MB RAM.  This MUST run after all
    // critical invoke() calls complete (engine start, option sync,
    // resume-all, history init) because invoke() requires a live WebView.
    //
    // Delegates to handle_minimize_to_tray() in Rust which handles:
    //   - end_cold_start()  → prevents re-hide on window recreation
    //   - lightweightMode   → window.destroy() vs window.hide()
    //   - macOS Dock hiding → hideDockOnMinimize (cfg-gated in Rust)
    //
    // Cross-platform: macOS (WKWebView), Windows (WebView2), Linux (WebKitGTK)
    // all release the renderer process on destroy().  ExitRequested handler
    // in handle_run_event() calls prevent_exit() to keep the process alive.
    if (config.lightweightMode && config.autoHideWindow) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const isAutostart = await invoke<boolean>('is_autostart_launch')
        if (isAutostart) {
          logger.info('main', 'autostart + lightweight: destroying WebView via minimize_to_tray')
          await invoke('minimize_to_tray')
          // WebView destroyed — JS execution stops here.
          // All background services (stat, monitor, speed scheduler) continue in Rust.
          return
        }
      } catch (e) {
        // Non-fatal: WebView stays alive (standard autostart-hide behavior).
        // Graceful degradation — the user just doesn't get the RAM savings.
        logger.debug('main.lightweightAutostart', e)
      }
    }

    let lastClipboardText = ''

    // Clipboard auto-detect. Desktop: triggered on window focus (getCurrentWindow
    // onFocusChanged). Mobile (Android): there is no window-focus concept — use
    // the document visibility change (app returning to foreground) instead.
    const handleClipboardDetect = async (): Promise<void> => {
      if (appStore.addTaskVisible) return
      const clipboardConfig = preferenceStore.config.clipboard
      if (!clipboardConfig?.enable) return
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
        const text = ((await readText()) || '').trim()
        if (!text || text === lastClipboardText) return
        const { detectResource, shouldIgnoreClipboardTextForAutoDetect } = await import('@shared/utils')
        if (shouldIgnoreClipboardTextForAutoDetect(text)) {
          lastClipboardText = text
          return
        }
        if (detectResource(text, clipboardConfig)) {
          lastClipboardText = text
          appStore.showAddTaskDialog()
        }
      } catch (e) {
        logger.debug('Main.clipboardMonitor', e)
      }
    }

    if (isMobile.value) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          void handleClipboardDetect()
        }
      })
    } else {
      getCurrentWindow().onFocusChanged(async ({ payload: focused }) => {
        if (!focused) return
        await handleClipboardDetect()
      })
    }
  }

  void bootstrapMainWindow().catch((e) => {
    logger.error('main.bootstrap', e)
    appStore.setEngineRestarting(false)
  })
} // end: main window initialization
