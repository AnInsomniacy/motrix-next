mod commands;
mod engine;
mod error;
#[cfg(target_os = "macos")]
mod menu;
mod tray;
mod upnp;

use crate::commands::updater::UpdateCancelState;
use engine::EngineState;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_store::StoreExt;
use upnp::UpnpState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
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
            None,
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
    builder = builder.plugin(
        tauri_plugin_window_state::Builder::new()
            .skip_initial_state("main")
            .build(),
    );

    builder
        .manage(EngineState::new())
        .manage(UpnpState::new())
        .manage(std::sync::Arc::new(UpdateCancelState::new()))
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
            commands::install_update,
            commands::cancel_update,
            commands::start_upnp_mapping,
            commands::stop_upnp_mapping,
            commands::get_upnp_status,
            commands::set_dock_visible,
            commands::probe_trackers,
        ])
        .setup(|app| {
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
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
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
                        let _ = w.restore_state(StateFlags::all());
                    }
                }
            }

            // Show the main window now that state restoration is complete.
            // The window starts hidden (tauri.conf.json visible: false) to
            // prevent the default-size flash on Windows.  The auto-hide
            // block below will re-hide it if tray-only mode is active.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }

            // Hide Dock icon on startup when both autoHideWindow and
            // hideDockOnMinimize are enabled.  Setting the activation policy
            // in setup() — before any window is shown — is the most widely
            // adopted pattern in the Tauri ecosystem.
            //
            // NOTE: This only takes effect in production builds (.app bundle).
            // In `cargo tauri dev` the process is a cargo child, so macOS
            // Launch Services does not honour activation policy changes.
            #[cfg(target_os = "macos")]
            {
                let hide_dock = app
                    .store("config.json")
                    .ok()
                    .and_then(|s| s.get("preferences"))
                    .map(|prefs| {
                        let auto_hide = prefs
                            .get("autoHideWindow")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let dock_hide = prefs
                            .get("hideDockOnMinimize")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        auto_hide && dock_hide
                    })
                    .unwrap_or(false);
                if hide_dock {
                    use tauri::ActivationPolicy;
                    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                }
            }

            // Auto-hide the main window on startup when the user has
            // opted into tray-only mode.  The window starts hidden
            // (tauri.conf.json visible: false) and was just shown above;
            // calling hide() here prevents it from reaching the screen.
            {
                let auto_hide = app
                    .store("config.json")
                    .ok()
                    .and_then(|s| s.get("preferences"))
                    .and_then(|p| p.get("autoHideWindow")?.as_bool())
                    .unwrap_or(false);
                if auto_hide {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                let _ = engine::stop_engine(app);
                // Clean up UPnP port mappings on exit.
                if let Some(state) = app.try_state::<UpnpState>() {
                    tauri::async_runtime::block_on(upnp::stop_mapping(state.inner()));
                }
            }
            // Rust-level defense for minimize-to-tray on close.
            // On Linux/Wayland with decorations:false, the frontend
            // onCloseRequested listener may not fire for all close
            // paths (e.g. Alt+F4, GNOME overview ×, taskbar close).
            // This handler ensures the window is hidden rather than
            // destroyed when the setting is enabled.
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { api, .. },
                label,
                ..
            } => {
                let should_hide = app
                    .store("config.json")
                    .ok()
                    .and_then(|s| s.get("preferences"))
                    .map(|prefs| {
                        prefs
                            .get("minimizeToTrayOnClose")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);

                if should_hide {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.hide();
                    }

                    // Hide Dock icon when the user has opted in.
                    #[cfg(target_os = "macos")]
                    {
                        let hide_dock = app
                            .store("config.json")
                            .ok()
                            .and_then(|s| s.get("preferences"))
                            .map(|prefs| {
                                prefs
                                    .get("hideDockOnMinimize")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false)
                            })
                            .unwrap_or(false);
                        if hide_dock {
                            use tauri::ActivationPolicy;
                            let _ = app.set_activation_policy(ActivationPolicy::Accessory);
                            // Force macOS to process the policy change.
                            // Without this, the dock icon remains after
                            // the app was already shown as Regular.
                            unsafe {
                                use objc2::MainThreadMarker;
                                use objc2_app_kit::NSApplication;
                                let mtm = MainThreadMarker::new_unchecked();
                                NSApplication::sharedApplication(mtm).hide(None);
                            }
                        }
                    }
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                // Restore Dock icon before showing the window.
                use tauri::ActivationPolicy;
                let _ = app.set_activation_policy(ActivationPolicy::Regular);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}
