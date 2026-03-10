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
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::all()
                    & !tauri_plugin_window_state::StateFlags::DECORATIONS,
            )
            .build(),
    );

    builder
        .manage(EngineState::new())
        .manage(UpnpState::new())
        .manage(std::sync::Arc::new(UpdateCancelState::new()))
        .invoke_handler(tauri::generate_handler![
            commands::get_app_config,
            commands::get_window_chrome_state,
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

            // On macOS, keep the decorated overlay window for native rounded corners.
            // If the user has not opted into native traffic lights, hide the native
            // traffic lights but preserve the decorated host window.
            #[cfg(target_os = "macos")]
            {
                let use_native = app
                    .store("config.json")
                    .ok()
                    .and_then(|s| s.get("preferences"))
                    .and_then(|v| v.get("useNativeTrafficLights").cloned())
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                app.manage(commands::MacWindowChromeState {
                    native_traffic_lights_visible: use_native,
                });
                if let Some(window) = app.get_webview_window("main") {
                    let _ = commands::set_macos_traffic_lights_visible(&window, use_native);
                }
            }

            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                let _ = app_handle.emit("deep-link-open", &urls);
            });

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
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}
