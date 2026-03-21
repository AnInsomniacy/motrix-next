mod commands;
mod engine;
mod error;
#[cfg(target_os = "macos")]
mod menu;
mod tray;
mod upnp;

use crate::commands::updater::{DownloadedUpdate, UpdateCancelState};
use engine::EngineState;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_store::StoreExt;
use upnp::UpnpState;

/// Pre-reads the user's log-level preference from the raw config.json file.
///
/// `tauri-plugin-store` isn't available until after `Builder.build()`, so we
/// read the raw JSON file directly.  Falls back to `Debug` if absent so that
/// first-run users get full diagnostic output for bug reports.
pub(crate) fn read_log_level() -> log::LevelFilter {
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
    .unwrap_or(log::LevelFilter::Debug)
}

/// Initialises menus, tray, deep links, window state, and platform-specific
/// workarounds.  Called once by `Builder.setup()`.
fn setup_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    #[cfg(target_os = "macos")]
    {
        let m = menu::build_menu(handle)?;
        app.set_menu(m)?;
    }
    let tray_state = tray::setup_tray(handle)?;
    app.manage(tray_state);

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

            let store_prefs = app
                .store("config.json")
                .ok()
                .and_then(|s| s.get("preferences"));

            let should_hide = store_prefs
                .as_ref()
                .and_then(|p| p.get("minimizeToTrayOnClose")?.as_bool())
                .unwrap_or(false);

            if should_hide {
                log::info!("menu:close-window — hiding to tray");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }

                let hide_dock = store_prefs
                    .as_ref()
                    .and_then(|p| p.get("hideDockOnMinimize")?.as_bool())
                    .unwrap_or(false);
                if hide_dock {
                    use tauri::ActivationPolicy;
                    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                }
            } else {
                log::info!("menu:close-window — showing exit dialog");
                let _ = app.emit("show-exit-dialog", ());
            }
        }
        "about" => {
            let _ = app.emit("menu-event", "about");
        }
        "new-task" => {
            let _ = app.emit("menu-event", "new-task");
        }
        "open-torrent" => {
            let _ = app.emit("menu-event", "open-torrent");
        }
        "preferences" => {
            let _ = app.emit("menu-event", "preferences");
        }
        "release-notes" => {
            let _ = app.emit("menu-event", "release-notes");
        }
        "report-issue" => {
            let _ = app.emit("menu-event", "report-issue");
        }
        _ => {}
    });

    let app_handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().iter().map(ToString::to_string).collect();
        let _ = app_handle.emit("deep-link-open", &urls);
    });

    // Conditionally restore window state based on user preference.
    // The window-state plugin is registered with skip_initial_state("main")
    // so it does NOT auto-restore.  We read the preference here and
    // call restore_state() manually only when the user has opted in.
    // The plugin still saves state on exit regardless, so toggling the
    // preference on later will pick up the last saved geometry.
    {
        use tauri_plugin_window_state::{StateFlags, WindowExt};

        let keep_state = app
            .store("config.json")
            .ok()
            .and_then(|s| s.get("preferences"))
            .and_then(|p| p.get("keepWindowState")?.as_bool())
            .unwrap_or(false);

        if keep_state {
            if let Some(w) = app.get_webview_window("main") {
                // Exclude MAXIMIZED on macOS — same tao bug as above.
                let flags = {
                    #[cfg(target_os = "macos")]
                    {
                        StateFlags::all() & !StateFlags::MAXIMIZED
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        StateFlags::all()
                    }
                };
                let _ = w.restore_state(flags);
            }
        }
    }

    // Window visibility is deferred to the Vue frontend.
    // The window starts hidden (tauri.conf.json visible: false) and
    // only becomes visible when MainLayout.vue mounts and calls
    // show() + setFocus().  This prevents the transparent-frame
    // flash on Windows where DWM renders a shadow before WebView2
    // finishes initializing.  The frontend checks autoHideWindow +
    // is_autostart_launch to decide whether to show.

    // Disable Windows 11 DWM rounded corners on the main window.
    // With `transparent: true` + `decorations: false`, Windows 11
    // applies its own ~8px corner rounding to the HWND, which
    // conflicts with the CSS `border-radius: 12px` on #container.
    // The mismatch creates visible desktop-color leaks at the
    // corners.  Setting DWMWCP_DONOTROUND (value 1) tells DWM to
    // keep the window rectangular, letting CSS handle all rounding
    // on the transparent canvas.
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
        };
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(hwnd_handle) = w.hwnd() {
                let hwnd = hwnd_handle.0 as *mut std::ffi::c_void;
                let preference: u32 = 1; // DWMWCP_DONOTROUND
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
        let hide_dock = app
            .store("config.json")
            .ok()
            .and_then(|s| s.get("preferences"))
            .map(|prefs| {
                let auto_hide = prefs
                    .get("autoHideWindow")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let dock_hide = prefs
                    .get("hideDockOnMinimize")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                auto_hide && dock_hide
            })
            .unwrap_or(false);
        if hide_dock && is_autostart {
            use tauri::ActivationPolicy;
            app.set_activation_policy(ActivationPolicy::Accessory);
        }
    }

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
                let should_hide = app
                    .store("config.json")
                    .ok()
                    .and_then(|s| s.get("preferences"))
                    .and_then(|p| p.get("minimizeToTrayOnClose")?.as_bool())
                    .unwrap_or(false);

                log::debug!("app:exit-requested minimizeToTrayOnClose={}", should_hide);

                if should_hide {
                    api.prevent_exit();
                    log::info!("app:exit-prevented reason=minimize-to-tray");
                }
            }
        }
        tauri::RunEvent::Exit => {
            log::info!("app:exit — stopping engine and UPnP");
            let _ = engine::stop_engine(app);
            // Clean up UPnP port mappings on exit.
            if let Some(state) = app.try_state::<UpnpState>() {
                tauri::async_runtime::block_on(upnp::stop_mapping(state.inner()));
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            log::info!("app:reopen — restoring main window");
            // Restore Dock icon before showing the window.
            use tauri::ActivationPolicy;
            let _ = app.set_activation_policy(ActivationPolicy::Regular);
            if let Some(window) = tray::get_or_create_main_window(app) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ── Linux/NVIDIA: auto-disable DMABuf renderer before any thread spawn ──
    //
    // WORKAROUND for WebKitGTK Bug #262607 (RESOLVED WONTFIX).
    // <https://bugs.webkit.org/show_bug.cgi?id=262607>
    //
    // NVIDIA proprietary drivers crash WebKitGTK's GBM EGL display init
    // with "EGL_NOT_INITIALIZED", aborting the process before any window
    // can open.  When the NVIDIA kernel module is loaded we proactively
    // disable the DMABuf renderer so WebKitGTK falls back to software
    // compositing.
    //
    // Detection: `/proc/driver/nvidia/version` is created by the nvidia.ko
    // kernel module on load — its presence is a reliable, zero-dependency
    // indicator that the NVIDIA proprietary driver is in use.
    //
    // The existing `is_dmabuf_renderer_disabled()` command in app.rs reads
    // this same env var at runtime, so the frontend's border-radius
    // workaround (MainLayout.vue) activates automatically.
    //
    // SAFETY: `set_var` is unsafe since Rust 1.83 due to potential data
    // races in multi-threaded programs.  This call is safe because it
    // executes at the very start of `main()`, before Tauri's thread pool,
    // the async runtime, or any plugin initialisation.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err()
            && std::path::Path::new("/proc/driver/nvidia/version").exists()
        {
            // SAFETY: single-threaded at this point — no data race possible.
            unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
            eprintln!(
                "[motrix-next] NVIDIA GPU detected — auto-set \
                 WEBKIT_DISABLE_DMABUF_RENDERER=1 to prevent WebKitGTK EGL crash"
            );
        }
    }

    // ── Panic hook: route panics through log crate for file persistence ──
    // Must be set BEFORE Tauri Builder so even plugin init panics are caught.
    // Without this, panics only reach stderr and are lost on process exit.
    std::panic::set_hook(Box::new(|info| {
        log::error!("PANIC: {}", info);
    }));

    let log_level = read_log_level();

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
                .max_file_size(10_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .level(log_level)
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
                    vec![tauri_plugin_sql::Migration {
                        version: 1,
                        description: "create download_history table",
                        sql: include_str!("../migrations/001_download_history.sql"),
                        kind: tauri_plugin_sql::MigrationKind::Up,
                    }],
                )
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_locale::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ));

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let _ = app.emit("single-instance-triggered", &argv);
            if let Some(w) = app.get_webview_window("main") {
                let _: Result<(), _> = w.show();
                let _: Result<(), _> = w.set_focus();
            }
        }));
    }

    builder = builder.plugin(tauri_plugin_deep_link::init());
    // Window-state plugin: saves/restores window position and size.
    //
    // macOS: Exclude StateFlags::MAXIMIZED to avoid a known bug in tao
    // where isMaximized() triggers a new resize event, creating an
    // infinite loop (tauri-apps/tauri#5812).  The frontend also skips
    // isMaximized() tracking on macOS (see MainLayout.vue).
    builder = builder.plugin({
        use tauri_plugin_window_state::StateFlags;

        let flags = {
            #[cfg(target_os = "macos")]
            {
                StateFlags::all() & !StateFlags::MAXIMIZED
            }
            #[cfg(not(target_os = "macos"))]
            {
                StateFlags::all()
            }
        };

        tauri_plugin_window_state::Builder::new()
            .skip_initial_state("main")
            .with_state_flags(flags)
            .build()
    });

    builder
        .manage(EngineState::new())
        .manage(UpnpState::new())
        .manage(std::sync::Arc::new(UpdateCancelState::new()))
        .manage(std::sync::Arc::new(DownloadedUpdate::new()))
        .invoke_handler(tauri::generate_handler![
            commands::get_app_config,
            commands::save_preference,
            commands::get_system_config,
            commands::save_system_config,
            commands::start_engine_command,
            commands::stop_engine_command,
            commands::restart_engine_command,
            commands::factory_reset,
            commands::clear_session_file,
            commands::update_tray_title,
            commands::update_tray_menu_labels,
            commands::update_menu_labels,
            commands::update_progress_bar,
            commands::update_dock_badge,
            commands::check_for_update,
            commands::download_update,
            commands::apply_update,
            commands::cancel_update,
            commands::start_upnp_mapping,
            commands::stop_upnp_mapping,
            commands::get_upnp_status,
            commands::set_dock_visible,
            commands::probe_trackers,
            commands::is_autostart_launch,
            commands::clear_log_file,
            commands::export_diagnostic_logs,
            commands::check_path_exists,
            commands::check_path_is_dir,
            commands::show_item_in_dir,
            commands::open_path_normalized,
            commands::trash_file,
            commands::get_engine_conf_path,
            commands::is_dmabuf_renderer_disabled,
        ])
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
                let store_prefs = app
                    .store("config.json")
                    .ok()
                    .and_then(|s| s.get("preferences"));

                let should_hide = store_prefs
                    .as_ref()
                    .and_then(|p| p.get("minimizeToTrayOnClose")?.as_bool())
                    .unwrap_or(false);

                log::debug!("window:prefs minimizeToTrayOnClose={}", should_hide);

                if should_hide {
                    log::info!("window:hide-to-tray label=main");
                    let _ = window.hide();

                    #[cfg(target_os = "macos")]
                    {
                        let hide_dock = store_prefs
                            .as_ref()
                            .and_then(|p| p.get("hideDockOnMinimize")?.as_bool())
                            .unwrap_or(false);
                        log::debug!("window:prefs hideDockOnMinimize={}", hide_dock);
                        if hide_dock {
                            use tauri::ActivationPolicy;
                            let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                        }
                    }
                } else {
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
