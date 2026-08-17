mod aria2;
mod commands;
mod db_guard;
mod engine;
mod error;
mod gpu_guard;
mod history;
mod log_policy;
#[cfg(target_os = "macos")]
mod menu;
mod services;
#[cfg(desktop)]
mod tray;
mod upnp;

// Re-export the Windows elevation entry point at the crate root so that
// main.rs can call it before Tauri initialises.  The `commands` module
// is intentionally private — only this single function needs to be
// accessible from the binary crate.
#[cfg(windows)]
pub use commands::protocol::try_run_elevated;

use crate::commands::power::ShutdownCancelState;
use crate::commands::updater::{DownloadedUpdate, UpdateCancelState};
use engine::EngineState;
use services::port_guard::DEFAULT_RPC_PORT;
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_store::StoreExt;
use upnp::UpnpState;

/// Pre-reads the user's log-level preference from the raw config.json file.
///
/// `tauri-plugin-store` isn't available until after `Builder.build()`, so we
/// read the raw JSON file directly. Falls back to `Warn` when no preference
/// has been persisted yet.
pub(crate) fn read_log_level() -> log::LevelFilter {
    #[cfg(target_os = "android")]
    {
        // Android: `dirs::data_dir()` does not point at Tauri's app data dir,
        // so reading config.json here would always miss. Return the default —
        // the frontend adjusts log levels at runtime after preference load.
        return log::LevelFilter::Warn;
    }
    #[cfg(not(target_os = "android"))]
    {
        (|| -> Option<log::LevelFilter> {
            let data_dir = dirs::data_dir()?.join("com.motrix.next");
            let store_path = data_dir.join("config.json");
            let content = std::fs::read_to_string(store_path).ok()?;
            let json: serde_json::Value = serde_json::from_str(&content).ok()?;
            let level_str = json.get("preferences")?.get("logLevel")?.as_str()?;
            match level_str {
                "error" => Some(log::LevelFilter::Error),
                "warn" => Some(log::LevelFilter::Warn),
                "info" => Some(log::LevelFilter::Info),
                "debug" => Some(log::LevelFilter::Debug),
                _ => None,
            }
        })()
        .unwrap_or(log::LevelFilter::Warn)
    }
}

/// Tracks the application lifecycle phase for window visibility decisions.
///
/// During the cold-start phase (`is_cold_start = true`), the autostart
/// silent-mode guard may hide the window.  Once the user first dismisses
/// the window (via close button, Cmd+W, or any minimize-to-tray path),
/// the phase transitions to runtime (`is_cold_start = false`).
/// This transition is **irreversible** within the process lifetime.
///
/// After the transition, `is_autostart_launch()` always returns `false`
/// so that window recreations in lightweight mode correctly show the
/// window instead of re-applying autostart-hide logic.
///
/// Fixes issue #206: without this, `is_autostart_launch()` reads process
/// argv (which never changes), causing recreated windows to incorrectly
/// call `window.hide()` via the frontend's MainLayout.windowVisibility
/// defence-in-depth check.
pub struct AppLifecycleState {
    is_cold_start: std::sync::atomic::AtomicBool,
}

impl Default for AppLifecycleState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppLifecycleState {
    pub fn new() -> Self {
        Self {
            is_cold_start: std::sync::atomic::AtomicBool::new(true),
        }
    }

    /// Returns `true` during the initial cold-start phase (before the
    /// user first dismisses the window).
    pub fn is_cold_start(&self) -> bool {
        self.is_cold_start.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Ends the cold-start phase.  Called once by `handle_minimize_to_tray()`
    /// when the user first dismisses the window.  Irreversible.
    pub fn end_cold_start(&self) {
        self.is_cold_start
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(desktop)]
fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;

    #[cfg(target_os = "macos")]
    {
        StateFlags::all() & !StateFlags::MAXIMIZED & !StateFlags::VISIBLE
    }
    #[cfg(not(target_os = "macos"))]
    {
        StateFlags::all() & !StateFlags::VISIBLE
    }
}

/// Reads a boolean preference straight from the persistent `config.json`
/// store, without an IPC round-trip. Returns `default` when the store is
/// unavailable or the key is absent / not a boolean.
///
/// This is the single reader for the many Rust-side window/exit/lightweight
/// decisions that must run before (or without) a live WebView.
pub(crate) fn read_pref_bool(app: &tauri::AppHandle, key: &str, default: bool) -> bool {
    app.store("config.json")
        .ok()
        .and_then(|s| s.get("preferences"))
        .and_then(|p| p.get(key)?.as_bool())
        .unwrap_or(default)
}

#[cfg(desktop)]
fn keep_window_state_enabled(app: &tauri::AppHandle) -> bool {
    read_pref_bool(app, "keepWindowState", false)
}

/// Restores window geometry when the user has opted into window-state restore.
///
/// Visibility is intentionally excluded. The app owns visibility through the
/// autostart silent-mode guard and the frontend show-on-ready flow, so restoring
/// visibility here would reintroduce startup flashes.
#[cfg(desktop)]
pub(crate) fn restore_window_state_if_enabled(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) {
    use tauri_plugin_window_state::WindowExt;

    if !keep_window_state_enabled(app) {
        return;
    }

    if let Err(e) = window.restore_state(window_state_flags()) {
        log::warn!(
            "window-state:restore-failed label={} error={}",
            window.label(),
            e
        );
    }
}

#[cfg(desktop)]
fn save_window_state_before_lightweight_destroy(app: &tauri::AppHandle) {
    use tauri_plugin_window_state::AppHandleExt;

    if let Err(e) = app.save_window_state(window_state_flags()) {
        log::warn!("window-state:save-before-lightweight-destroy-failed error={e}");
    }
}

/// Minimizes the main window to tray, either by destroying the WebView
/// (lightweight mode — reduces memory usage) or by
/// hiding it (standard mode — instant show on tray click).
///
/// Shared by `on_window_event(CloseRequested)` and `on_menu_event("close-window")`
/// to keep the two close paths consistent.
#[cfg(desktop)]
pub(crate) fn handle_minimize_to_tray(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    // End the cold-start phase on the first window dismissal.
    // After this point, is_autostart_launch() returns false so that
    // window recreations in lightweight mode show the window instead
    // of re-applying autostart-hide logic.  Issue #206.
    if let Some(lifecycle) = app.try_state::<AppLifecycleState>() {
        if lifecycle.is_cold_start() {
            lifecycle.end_cold_start();
            log::info!("lifecycle: cold-start phase ended");
        }
    }
    let lightweight = read_pref_bool(app, "lightweightMode", false);

    if lightweight {
        log::info!("tray:lightweight-destroy label={}", window.label());
        save_window_state_before_lightweight_destroy(app);
        services::deep_link::mark_frontend_unready(app);
        services::external_input::mark_frontend_unready(app);
        services::frontend_action::mark_frontend_actions_unready(app);
        let _ = window.destroy();
    } else {
        log::info!("tray:hide label={}", window.label());
        let _ = window.hide();
    }

    #[cfg(target_os = "macos")]
    {
        if read_pref_bool(app, "hideDockOnMinimize", false) {
            use tauri::ActivationPolicy;
            let _ = app.set_activation_policy(ActivationPolicy::Accessory);
        }
    }
}

/// Initialises menus, tray, deep links, window state, and platform-specific
/// workarounds.  Called once by `Builder.setup()`.
fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    match handle.path().app_log_dir() {
        Ok(log_dir) => {
            if let Err(error) = log_policy::remove_legacy_log_files(&log_dir) {
                log::warn!("Failed to remove legacy log files: {error}");
            }
        }
        Err(error) => log::warn!("Failed to resolve log directory for cleanup: {error}"),
    }
    #[cfg(target_os = "macos")]
    {
        let m = menu::build_menu(handle)?;
        app.set_menu(m)?;
    }
    #[cfg(desktop)]
    {
        let tray_state = tray::setup_tray(handle)?;
        app.manage(tray_state);
    }

    // Aria2 JSON-RPC client — starts with default credentials, updated
    // after engine start via Aria2Client::update_credentials().
    let aria2_state = aria2::client::Aria2State(std::sync::Arc::new(
        aria2::client::Aria2Client::new(DEFAULT_RPC_PORT, String::new()),
    ));
    app.manage(aria2_state);

    // Runtime config cache — refreshed by frontend after each config save.
    app.manage(services::config::RuntimeConfigState::new());

    // Background services — handles stored here so on_engine_ready can
    // stop old tasks before spawning new ones on restart.
    app.manage(services::stat::StatServiceState::new());
    app.manage(services::speed::SpeedSchedulerState::new());
    app.manage(services::monitor::TaskMonitorState::new());
    app.manage(services::aria2_events::Aria2EventState::new());
    app.manage(services::bt_blocklist::BtPeerBlocklistServiceState::new());
    app.manage(commands::bt_blocklist::BtPeerBlocklistUpdateState::new());
    app.manage(services::http_api::HttpApiState::new());
    #[cfg(target_os = "linux")]
    app.manage(services::notification::LinuxNotificationRegistry::new());
    app.manage(services::deep_link::PendingDeepLinkState::new());
    app.manage(services::external_input::PendingExternalInputState::new());
    app.manage(services::frontend_action::PendingFrontendActionState::new());

    // App lifecycle — tracks cold-start vs runtime phase for autostart
    // visibility decisions.  See AppLifecycleState doc and issue #206.
    app.manage(AppLifecycleState::new());

    // History database — opens the same DB as tauri-plugin-sql migrations.
    {
        use tauri::Manager;
        let app_data = app.path().app_data_dir()?;
        let db_path = app_data.join("history.db");
        let history_db = history::HistoryDb::open(&db_path)
            .map_err(|e| format!("Failed to open history.db: {e}"))?;
        app.manage(history::HistoryDbState(std::sync::Arc::new(history_db)));
    }

    #[cfg(target_os = "macos")]
    app.on_menu_event(|app, event| match event.id().as_ref() {
        // ── Window menu: custom handlers for frameless window ────────
        //
        // PredefinedMenuItem variants call native macOS selectors
        // (miniaturize:, zoom:, performClose:) which are no-ops on
        // frameless (decorations: false) windows.  Custom items route
        // through Tauri's window API, which works correctly.
        "minimize-window" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.minimize();
            }
        }
        "zoom-window" => {
            if let Some(window) = app.get_webview_window("main") {
                let is_max = window.is_maximized().unwrap_or(false);
                if is_max {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
        }
        // ── Cmd+W: replicate CloseRequested hide-or-dialog logic ──
        "close-window" => {
            log::info!("menu:close-window — handling Cmd+W");

            let should_hide = read_pref_bool(app, "minimizeToTrayOnClose", false);

            if should_hide {
                if let Some(window) = app.get_webview_window("main") {
                    handle_minimize_to_tray(app, &window);
                }
            } else {
                log::info!("menu:close-window — showing exit dialog");
                let _ = app.emit("show-exit-dialog", ());
            }
        }
        id => {
            if let Some(action) = services::frontend_action::menu_action_from_id(id) {
                services::frontend_action::dispatch_frontend_action(
                    app,
                    services::frontend_action::FrontendActionChannel::MenuEvent,
                    action,
                    "native-menu-action",
                );
            }
        }
    });

    // On macOS, runtime deep links arrive via RunEvent::Opened → the
    // plugin emits "deep-link://new-url".  We listen for that event and
    // route it through the shared external-input service. If lightweight
    // mode destroyed the WebView, the service queues the URLs and schedules
    // window wake-up outside this native callback.
    //
    // On Windows/Linux this listener is compile-time excluded because
    // runtime deep links there arrive via the single-instance plugin,
    // which invokes the single-instance callback below. That callback uses
    // the same shared external-input service and emits "deep-link-open"
    // only when an existing frontend listener is already alive.
    // Registering on_open_url on those platforms would cause
    // handleDeepLinkUrls() to fire twice per URL (once from (a) hitting
    // this listener, once from (b) hitting useAppEvents).
    #[cfg(target_os = "macos")]
    {
        let app_handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            let urls: Vec<String> = event.urls().iter().map(ToString::to_string).collect();
            services::deep_link::route_external_inputs(&app_handle, urls, "macos-open-url");
        });
    }

    // The window-state plugin is registered with skip_initial_state("main"),
    // so initial and lightweight-recreated windows both restore through the
    // same explicit helper.
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("main") {
        restore_window_state_if_enabled(handle, &w);
    }

    // Window visibility follows a two-layer defense-in-depth pattern:
    //
    //   1. PRIMARY (Rust): The autostart silent-mode guard below detects
    //      --autostart + autoHideWindow and force-hides the window before
    //      the frontend mounts.  Window-state plugin is permanently
    //      configured to exclude StateFlags::VISIBLE (#109).
    //
    //   2. SECONDARY (Frontend): MainLayout.vue onMounted calls
    //      show() + setFocus() ONLY when NOT in autostart-silent mode.
    //      If the window is somehow visible despite the Rust guard, the
    //      frontend force-hides it as a safety net.
    //
    // The window starts hidden (tauri.conf.json visible: false) and
    // transitions through this pipeline before becoming visible.

    // Force Windows 11 DWM native rounded corners on the main window.
    //
    // With `transparent: true` + `decorations: false`, the HWND is a
    // layered window — DWM does NOT auto-round layered windows.  We
    // explicitly request DWMWCP_ROUND (value 2) so DWM applies its
    // native ~8px corner rounding, matching the original Motrix look.
    //
    // Previously this block used DWMWCP_DONOTROUND (value 1) to
    // *disable* DWM corners because CSS `border-radius: 12px` was
    // drawing its own competing rounded corners on the transparent
    // canvas.  Now that CSS border-radius is removed, DWM handles
    // all corner rounding natively — no CSS workarounds needed.
    //
    // Safe no-op on Windows 10 (DWM ignores the preference).
    // DWM auto-disables rounding when the window is maximized.
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
        };
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(hwnd_handle) = w.hwnd() {
                let hwnd = hwnd_handle.0 as *mut std::ffi::c_void;
                // DWMWCP_ROUND = 2: force DWM native rounded corners
                let preference: u32 = 2;
                unsafe {
                    DwmSetWindowAttribute(
                        hwnd,
                        DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                        &preference as *const u32 as *const _,
                        std::mem::size_of::<u32>() as u32,
                    );
                }
            }
        }
    }
    // Hide Dock icon on startup when both autoHideWindow and
    // hideDockOnMinimize are enabled, AND the app was launched by
    // the OS autostart mechanism (--autostart flag).  Manual launches
    // always keep the Dock icon visible.
    //
    // NOTE: This only takes effect in production builds (.app bundle).
    // In `cargo tauri dev` the process is a cargo child, so macOS
    // Launch Services does not honour activation policy changes.
    #[cfg(target_os = "macos")]
    {
        let is_autostart = std::env::args().any(|a| a == "--autostart");
        let hide_dock = read_pref_bool(app.handle(), "autoHideWindow", false)
            && read_pref_bool(app.handle(), "hideDockOnMinimize", false);
        if hide_dock && is_autostart {
            use tauri::ActivationPolicy;
            app.set_activation_policy(ActivationPolicy::Accessory);
        }
    }

    // Autostart silent-mode guard: detect + log + force-hide.
    //
    // When the app is launched by OS autostart (--autostart flag) AND the
    // user has opted into "minimize to tray on autostart" (autoHideWindow),
    // we force-hide the window HERE in Rust setup(), BEFORE the frontend
    // mounts.  This is the primary defense — it runs synchronously in the
    // setup() callback, guaranteeing the window never becomes visible.
    //
    // The frontend (MainLayout.vue) has its own defense-in-depth check:
    // if shouldHide is true, it calls hide() again as a safety net.
    //
    // This two-layer approach mirrors the Electron industry standard where
    // the main process checks process.argv for --hidden before calling
    // BrowserWindow.show().
    //
    // Logging at INFO level ensures user-submitted logs always contain the
    // data needed to diagnose autostart bugs (e.g. --autostart flag missing
    // from the Windows registry entry — auto-launch crate #771).
    #[cfg(desktop)]
    {
        let is_autostart =
            std::env::args().any(|a| a == "--autostart" || a.starts_with("--autostart="));
        let auto_hide = read_pref_bool(app.handle(), "autoHideWindow", false);

        let should_hide = is_autostart && auto_hide;

        log::info!(
            "setup: is_autostart={} auto_hide_window={} → should_hide={} (window will {})",
            is_autostart,
            auto_hide,
            should_hide,
            if should_hide {
                "stay hidden"
            } else {
                "be shown by frontend when ready"
            }
        );

        if should_hide {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
                log::info!("setup: window force-hidden for autostart silent mode");
            }
        }
    }

    // ── GeoIP: load bundled DB-IP Country Lite for peer country flags ─
    let geoip_state = commands::geoip::init_geoip(&app.handle().clone());
    app.manage(geoip_state);

    Ok(())
}

/// Handles Tauri `RunEvent`s: process-exit prevention, cleanup, and
/// macOS Dock icon restore.
///
/// ## Event responsibilities
///
/// | Event | Handler |
/// |-------|--------|
/// | `CloseRequested` | `Builder::on_window_event()` (see [`run()`]) |
/// | `ExitRequested` | Here — prevents process death on Wayland force-close |
/// | `Exit` | Here — engine + UPnP cleanup |
/// | `Reopen` | Here — macOS Dock icon restore |
///
/// ### Wayland force-close safety net
///
/// On Linux/Wayland + `decorations: false`, the compositor can destroy the
/// window without emitting `CloseRequested`.  When the last window is
/// destroyed, Tauri fires `ExitRequested` with `code: None`.  We intercept
/// this and call `api.prevent_exit()` when minimize-to-tray is enabled,
/// keeping the process alive so the tray can recreate the window later.
fn handle_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    match event {
        // ── Wayland safety net ────────────────────────────────────────
        //
        // `code.is_none()` = implicit exit triggered by the last window
        // closing (NOT an explicit `app.exit()` call).  When the user
        // has minimize-to-tray enabled, keep the process alive.
        tauri::RunEvent::ExitRequested { ref api, code, .. } => {
            log::info!("app:exit-requested code={:?}", code);

            if code.is_none() {
                let should_hide = read_pref_bool(app, "minimizeToTrayOnClose", false);

                log::debug!("app:exit-requested minimizeToTrayOnClose={}", should_hide);

                if should_hide {
                    api.prevent_exit();
                    log::info!("app:exit-prevented reason=minimize-to-tray");
                }
            }
        }
        tauri::RunEvent::Exit => {
            log::info!("app:exit — saving session, stopping engine and UPnP");

            // ── Clear completed download records on exit ────────────
            // When the user exits via tray-quit (app.exit(0)), the frontend's
            // handleExitConfirm() is bypassed. Read the preference from the
            // persistent store and clear records directly via HistoryDb.
            // Best-effort with 2s timeout — never blocks app exit.
            {
                let clear_on_exit = read_pref_bool(app, "clearCompletedOnExit", false);
                if clear_on_exit {
                    if let Some(db_state) = app.try_state::<history::HistoryDbState>() {
                        let db = db_state.0.clone();
                        let _ = tauri::async_runtime::block_on(async {
                            tokio::time::timeout(
                                std::time::Duration::from_secs(2),
                                db.clear_records(Some("complete")),
                            )
                            .await
                        });
                        log::info!("app:exit — cleared completed history records");
                    }
                }
            }

            // Save aria2 session before killing the engine so in-progress
            // downloads survive across restarts.  Best-effort with 500ms
            // timeout — never blocks app exit.
            if let Some(aria2) = app.try_state::<aria2::client::Aria2State>() {
                let client = aria2.0.clone();
                let _ = tauri::async_runtime::block_on(async {
                    tokio::time::timeout(
                        std::time::Duration::from_millis(500),
                        client.save_session(),
                    )
                    .await
                });
                log::info!("aria2 session save attempted via managed client");
            }
            let _ = engine::stop_engine(app, true);
            // Stop the extension HTTP API server gracefully.
            if let Some(api_state) = app.try_state::<services::http_api::HttpApiState>() {
                let _ = tauri::async_runtime::block_on(async {
                    tokio::time::timeout(std::time::Duration::from_millis(500), async {
                        if let Some(handle) = api_state.0.lock().await.take() {
                            handle.stop().await;
                        }
                    })
                    .await
                });
                log::info!("http_api: stopped");
            }
            // Clean up UPnP port mappings on exit.
            if let Some(state) = app.try_state::<UpnpState>() {
                tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        upnp::stop_mapping(state.inner()),
                    )
                    .await;
                });
            }
            // Stop stat service before process shutdown so any active
            // keep-awake power assertion is released deterministically.
            if let Some(stat_state) = app.try_state::<services::stat::StatServiceState>() {
                let _ = tauri::async_runtime::block_on(async {
                    tokio::time::timeout(std::time::Duration::from_millis(500), async {
                        let handle = {
                            let mut guard = stat_state.0.lock().await;
                            guard.take()
                        };
                        if let Some(handle) = handle {
                            handle.stop().await;
                        }
                    })
                    .await
                });
                log::info!("stat_service: stopped");
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            log::info!("app:reopen — restoring main window");
            tray::activate_main_window(app, "macos-reopen");
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── Linux: GPU rendering guard ──────────────────────────────────
    //
    // WORKAROUND for WebKitGTK Bug #262607 (RESOLVED WONTFIX).
    // <https://bugs.webkit.org/show_bug.cgi?id=262607>
    //
    // WebKitGTK hardware rendering can crash on various GPU, driver, and
    // compositor combinations. DMA-BUF is the best-known failure path, but
    // AppImage/Wayland systems can still hit GBM/DRI through accelerated
    // compositing, so software mode disables both paths.
    //
    // Strategy:
    // - Default: hardware rendering OFF (software compositing).
    //   Safe for all GPUs, negligible perf difference for a download manager UI.
    // - Users can opt in via Advanced → "WebKitGTK Hardware Acceleration".
    // - If opting in crashes the app, edit config.json and set
    //   preferences.hardwareRendering to false.
    //
    // SAFETY: `set_var` (called inside pre_flight) is unsafe since Rust 1.83.
    // Safe here because it executes at the very start of `main()`, before
    // Tauri's thread pool, the async runtime, or any plugin initialisation.
    gpu_guard::pre_flight();

    // ── Panic hook: route panics through log crate for file persistence ──
    // Must be set BEFORE Tauri Builder so even plugin init panics are caught.
    // Without this, panics only reach stderr and are lost on process exit.
    std::panic::set_hook(Box::new(|info| {
        log::error!("PANIC: {}", info);
    }));

    let log_level = read_log_level();

    // ── Pre-flight DB migration guard ────────────────────────────
    // Must run BEFORE tauri_plugin_sql to prevent panic on downgrade.
    // Uses the platform-specific app data directory (same path that
    // tauri_plugin_sql's "sqlite:history.db" resolves to).
    // Android: `dirs::data_dir()` does not match Tauri's app_data_dir and
    // the native dialog backend (rfd) is desktop-only, so skip the guard —
    // tauri_plugin_sql handles migration failures gracefully there.
    #[cfg(not(target_os = "android"))]
    if let Some(dir) = dirs::data_dir().map(|d| d.join("com.motrix.next")) {
        db_guard::check(&dir);
    }

    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("motrix-next".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .format(|out, message, record| {
                    let now = chrono::Local::now();
                    let source = if record
                        .target()
                        .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
                    {
                        "webview"
                    } else {
                        "rust"
                    };
                    out.finish(format_args!(
                        "{} [{:<5}] [{}] {}",
                        now.format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
                        record.level(),
                        source,
                        message
                    ))
                })
                .max_file_size(log_policy::MAX_LOG_FILE_SIZE.into())
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .level(log_level)
                .level_for("maxminddb", log::LevelFilter::Warn)
                .level_for("sqlx", log::LevelFilter::Warn)
                .level_for("zbus", log::LevelFilter::Warn)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .filter(|metadata| {
                    !metadata.target().starts_with("tao")
                        && !metadata.target().starts_with("tracing")
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:history.db",
                    vec![
                        tauri_plugin_sql::Migration {
                            version: 1,
                            description: "create download_history table",
                            sql: include_str!("../migrations/001_download_history.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 2,
                            description: "add added_at column and task_birth table for position-stable ordering",
                            sql: include_str!("../migrations/002_add_added_at.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 3,
                            description: "add HTTP auth credentials table",
                            sql: include_str!("../migrations/003_http_auth_credentials.sql"),
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ));
    }

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let urls = services::deep_link::filter_external_input_args(&argv);
            if !urls.is_empty() {
                services::deep_link::route_external_inputs(app, urls, "single-instance");
                return;
            }

            if services::deep_link::is_autostart_arg_launch(&argv) {
                log::info!("single-instance:autostart-skip argc={}", argv.len());
                return;
            }

            let app_handle = app.clone();
            if let Err(e) = app.run_on_main_thread(move || {
                tray::activate_main_window(&app_handle, "single-instance-launch");
            }) {
                log::warn!("single-instance:activate-schedule-failed error={e}");
            }
        }));
    }

    builder = builder.plugin(tauri_plugin_deep_link::init());
    // Window-state plugin: saves/restores window position and size.
    // (Desktop-only — Android has no window geometry to persist.)
    //
    // VISIBLE is permanently excluded from the plugin's state flags.
    // Window visibility is managed entirely by the autostart-silent-mode
    // guard in setup_app() and the frontend's MainLayout.vue.  Allowing
    // the plugin to save/restore VISIBLE would cause the window to flash
    // on autostart before the silent-mode check can hide it (#109).
    //
    // macOS: Also exclude StateFlags::MAXIMIZED to avoid a known bug in
    // tao where isMaximized() triggers a new resize event, creating an
    // infinite loop (tauri-apps/tauri#5812).  The frontend also skips
    // isMaximized() tracking on macOS (see MainLayout.vue).
    #[cfg(desktop)]
    builder = builder.plugin({
        use tauri_plugin_window_state::StateFlags;

        let flags = {
            #[cfg(target_os = "macos")]
            {
                StateFlags::all() & !StateFlags::MAXIMIZED & !StateFlags::VISIBLE
            }
            #[cfg(not(target_os = "macos"))]
            {
                StateFlags::all() & !StateFlags::VISIBLE
            }
        };

        tauri_plugin_window_state::Builder::new()
            .skip_initial_state("main")
            .with_state_flags(flags)
            .build()
    });

    builder = builder
        .manage(EngineState::new())
        .manage(UpnpState::new())
        .manage(std::sync::Arc::new(UpdateCancelState::new()))
        .manage(std::sync::Arc::new(DownloadedUpdate::new()))
        .manage(std::sync::Arc::new(ShutdownCancelState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::get_system_config,
            commands::save_system_config,
            commands::read_settings_backup_file,
            commands::write_settings_backup_file,
            commands::start_engine_command,
            commands::stop_engine_command,
            commands::restart_engine_command,
            commands::resolve_bt_listen_port,
            commands::factory_reset,
            commands::clear_session_file,
            commands::update_progress_bar,
            commands::update_dock_badge,
            commands::send_task_start_notification,
            commands::send_app_system_notification,
            commands::check_for_update,
            commands::download_update,
            commands::apply_update,
            commands::cancel_update,
            commands::start_upnp_mapping,
            commands::stop_upnp_mapping,
            commands::get_upnp_status,
            commands::get_ed2k_bootstrap_status,
            commands::sync_ed2k_bootstrap_files,
            commands::get_bt_peer_blocklist_status,
            commands::sync_bt_peer_blocklist,
            commands::reconcile_bt_peer_blocklist,
            commands::set_dock_visible,
            commands::probe_trackers,
            commands::fetch_tracker_sources,
            commands::is_autostart_launch,
            commands::clear_log_file,
            commands::export_diagnostic_logs,
            commands::check_path_exists,
            commands::check_path_is_dir,
            commands::read_local_file,
            commands::list_dir_files,
            commands::show_item_in_dir,
            commands::open_path_normalized,
            commands::delete_path,
            commands::move_file,
            commands::get_engine_conf_path,
            commands::set_window_alpha,
            commands::is_default_protocol_client,
            commands::set_default_protocol_client,
            commands::remove_as_default_protocol_client,
            commands::resolve_filename,
            commands::fetch_remote_bytes,
            commands::get_system_proxy,
            commands::lookup_peer_ips,
            commands::refresh_runtime_config,
            commands::restart_http_api,
            commands::peek_pending_deep_links_silent,
            commands::peek_pending_external_inputs_silent,
            commands::take_pending_deep_links,
            commands::take_pending_external_inputs,
            commands::take_pending_frontend_actions,
            commands::history_add_record,
            commands::history_get_records,
            commands::history_remove_record,
            commands::history_clear_records,
            commands::history_remove_stale,
            commands::history_remove_by_info_hash,
            commands::history_record_birth,
            commands::history_load_births,
            commands::history_check_integrity,
            commands::aria2_fetch_task_list,
            commands::aria2_fetch_active_task_list,
            commands::aria2_fetch_task_item,
            commands::aria2_fetch_task_item_with_peers,
            commands::aria2_get_version,
            commands::aria2_get_global_option,
            commands::aria2_get_global_stat,
            commands::aria2_change_global_option,
            commands::aria2_get_option,
            commands::aria2_change_option,
            commands::aria2_get_files,
            commands::aria2_add_uri,
            commands::aria2_add_torrent,
            commands::aria2_ed2k_search,
            commands::aria2_get_ed2k_search_results,
            commands::aria2_cleanup_ed2k_search,
            commands::aria2_force_remove,
            commands::aria2_force_pause,
            commands::aria2_pause,
            commands::aria2_unpause,
            commands::aria2_save_session,
            commands::aria2_remove_download_result,
            commands::aria2_purge_download_result,
            commands::aria2_batch_unpause,
            commands::aria2_batch_force_pause,
            commands::aria2_batch_force_remove,
            commands::wait_for_engine,
            commands::system_shutdown,
            commands::cancel_shutdown,
        ]);

    // Desktop-only commands (tray/menu/window) — unavailable on Android.
    #[cfg(desktop)]
    builder = builder.invoke_handler(tauri::generate_handler![
        commands::update_tray_title,
        commands::update_tray_menu_labels,
        commands::update_menu_labels,
        commands::minimize_to_tray,
    ]);
    builder
        // ── Window event interception ─────────────────────────────────
        //
        // Registered via `on_window_event` — the FIRST hook in Tauri's
        // event lifecycle.  Handles two events:
        //
        // 1. `CloseRequested` — prevents native close, routes to
        //    minimize-to-tray or exit dialog.  Fires on macOS/Windows
        //    and Linux/X11, but may NOT fire on Linux/Wayland +
        //    `decorations: false` (tao upstream limitation).
        //
        // 2. `Destroyed` — logs window destruction for diagnostics.
        //    On Wayland force-close, this is the ONLY event that fires
        //    (CloseRequested is skipped entirely).  The process stays
        //    alive via `ExitRequested { api.prevent_exit() }` in
        //    `handle_run_event`.
        //
        // Ref: https://docs.rs/tauri/latest/tauri/struct.Builder.html#method.on_window_event
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                log::info!("window:close-requested label={}", window.label());

                // Only intercept the main window; let other windows close freely.
                if window.label() != "main" {
                    return;
                }

                // ALWAYS prevent native close — the app owns the exit flow
                // (exit confirmation dialog / minimize-to-tray).
                api.prevent_close();
                log::info!("window:close-prevented label=main");

                let app = window.app_handle();

                // Read minimize-to-tray preference directly from the
                // persistent store (Rust-side, no IPC round-trip).
                let should_hide = read_pref_bool(app, "minimizeToTrayOnClose", false);

                log::debug!("window:prefs minimizeToTrayOnClose={}", should_hide);

                #[cfg(desktop)]
                if should_hide {
                    // Lightweight mode destroys the WebView to reduce memory usage;
                    // standard mode hides it for instant show on tray click.
                    // Window is fully recreated on tray-click via get_or_create_main_window.
                    // Downloads, monitoring, and tray continue — they run in Rust.
                    if let Some(wv) = app.get_webview_window(window.label()) {
                        handle_minimize_to_tray(app, &wv);
                    }
                }

                // Mobile (Android): minimize-to-tray does not exist; on the
                // (rare) close event, just emit the exit dialog for the
                // frontend to confirm — matching the desktop non-hide path.
                #[cfg(not(desktop))]
                let _ = should_hide;

                if !should_hide || cfg!(not(desktop)) {
                    log::info!("window:show-exit-dialog label=main");
                    // Emit event for the frontend to show the exit dialog.
                    // More reliable than the JS onCloseRequested listener
                    // which may not fire for certain close paths on
                    // Linux/Wayland with decorations:false.
                    let _ = app.emit("show-exit-dialog", ());
                }
            }
            tauri::WindowEvent::Destroyed => {
                log::info!("window:destroyed label={}", window.label());
            }
            _ => {}
        })
        .setup(|app| setup_app(app))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(handle_run_event);
}

#[cfg(test)]
mod tests {
    use super::AppLifecycleState;

    #[test]
    fn app_lifecycle_starts_cold() {
        assert!(AppLifecycleState::new().is_cold_start());
    }
}
