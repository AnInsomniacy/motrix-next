use crate::engine;
use crate::error::AppError;
use crate::tray::TrayMenuState;
use serde_json::Value;
use tauri::window::ProgressBarState;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_store::StoreExt;

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
pub struct MacWindowChromeState {
    pub native_traffic_lights_visible: bool,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowChromeStatePayload {
    pub native_traffic_lights_visible: bool,
}

/// Reads all user preferences from the `user.json` store.
#[tauri::command]
pub fn get_app_config(app: AppHandle) -> Result<Value, AppError> {
    let store = app
        .store("user.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    let entries: serde_json::Map<String, Value> = store
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    Ok(Value::Object(entries))
}

/// Merges the given key-value pairs into the `user.json` store.
#[tauri::command]
pub fn save_preference(app: AppHandle, config: Value) -> Result<(), AppError> {
    let store = app
        .store("user.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            store.set(key.clone(), value.clone());
        }
    }
    Ok(())
}

/// Reads all system-level configuration from the `system.json` store.
#[tauri::command]
pub fn get_system_config(app: AppHandle) -> Result<Value, AppError> {
    let store = app
        .store("system.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    let entries: serde_json::Map<String, Value> = store
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    Ok(Value::Object(entries))
}

/// Merges the given key-value pairs into the `system.json` store.
#[tauri::command]
pub fn save_system_config(app: AppHandle, config: Value) -> Result<(), AppError> {
    let store = app
        .store("system.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            store.set(key.clone(), value.clone());
        }
    }
    Ok(())
}

/// Starts the aria2c engine process with current system configuration.
#[tauri::command]
pub fn start_engine_command(app: AppHandle) -> Result<(), AppError> {
    let config = get_system_config(app.clone())?;
    engine::start_engine(&app, &config).map_err(|e| AppError::Engine(e))
}

/// Gracefully stops the running aria2c engine process.
#[tauri::command]
pub fn stop_engine_command(app: AppHandle) -> Result<(), AppError> {
    engine::stop_engine(&app).map_err(|e| AppError::Engine(e))
}

/// Stops and restarts the aria2c engine with current system configuration.
#[tauri::command]
pub fn restart_engine_command(app: AppHandle) -> Result<(), AppError> {
    let config = get_system_config(app.clone())?;
    engine::restart_engine(&app, &config).map_err(|e| AppError::Engine(e))
}

/// Clears user, system, and preference stores, resetting the app to defaults.
/// Also removes the aria2 session file to prevent tasks from resurrecting.
#[tauri::command]
pub fn factory_reset(app: AppHandle) -> Result<(), AppError> {
    let user_store = app
        .store("user.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    user_store.clear();
    let system_store = app
        .store("system.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    system_store.clear();
    // Also clear config.json where frontend preferences are persisted
    let config_store = app
        .store("config.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    config_store.clear();

    // Remove aria2 session file so downloads don't reappear after restart
    clear_session_file_inner(&app)?;

    Ok(())
}

/// Removes the aria2 download session file.
/// Called by both factory reset and session reset flows.
#[tauri::command]
pub fn clear_session_file(app: AppHandle) -> Result<(), AppError> {
    clear_session_file_inner(&app)
}

fn clear_session_file_inner(app: &AppHandle) -> Result<(), AppError> {
    let session_path = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join("download.session");
    if session_path.exists() {
        std::fs::remove_file(&session_path).map_err(|e| AppError::Io(e.to_string()))?;
    }
    Ok(())
}

/// Updates the system tray title text (macOS menu bar display).
#[tauri::command]
pub fn update_tray_title(app: AppHandle, title: String) -> Result<(), AppError> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_title(Some(&title))
            .map_err(|e| AppError::Io(e.to_string()))?;
        // Workaround: re-set icon after set_title to prevent macOS icon disappearing (Tauri/tao bug)
        if let Some(icon) = app.default_window_icon() {
            let _ = tray.set_icon(Some(icon.clone()));
        }
    }
    Ok(())
}

/// Updates localized labels on tray menu items by their IDs.
#[tauri::command]
pub fn update_tray_menu_labels(app: AppHandle, labels: Value) -> Result<(), AppError> {
    let state = app.state::<TrayMenuState>();
    let items = state
        .items
        .lock()
        .map_err(|e| AppError::Store(e.to_string()))?;
    if let Some(obj) = labels.as_object() {
        for (id, text) in obj {
            if let Some(item) = items.get(id.as_str()) {
                let _ = item.set_text(text.as_str().unwrap_or(id));
            }
        }
    }
    Ok(())
}

/// Updates localized labels on application menu items by their IDs.
#[tauri::command]
pub fn update_menu_labels(app: AppHandle, labels: Value) -> Result<(), AppError> {
    use tauri::menu::MenuItemKind;
    if let Some(menu) = app.menu() {
        if let Some(obj) = labels.as_object() {
            for (id, text) in obj {
                if let Some(item) = menu.get(id) {
                    match item {
                        MenuItemKind::MenuItem(mi) => {
                            let _ = mi.set_text(text.as_str().unwrap_or(id));
                        }
                        MenuItemKind::Submenu(sub) => {
                            let _ = sub.set_text(text.as_str().unwrap_or(id));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(())
}

/// Updates the taskbar/dock progress bar (0.0–1.0 for progress, negative to clear).
#[tauri::command]
pub fn update_progress_bar(app: AppHandle, progress: f64) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window("main") {
        if progress < 0.0 {
            let _ = window.set_progress_bar(ProgressBarState {
                status: Some(tauri::window::ProgressBarStatus::None),
                progress: None,
            });
        } else {
            let _ = window.set_progress_bar(ProgressBarState {
                status: Some(tauri::window::ProgressBarStatus::Normal),
                progress: Some((progress * 100.0) as u64),
            });
        }
    }
    Ok(())
}

/// Returns the window chrome mode that was applied to this session at startup.
#[tauri::command]
pub fn get_window_chrome_state(app: AppHandle) -> Result<WindowChromeStatePayload, AppError> {
    #[cfg(target_os = "macos")]
    if let Some(state) = app.try_state::<MacWindowChromeState>() {
        return Ok(WindowChromeStatePayload {
            native_traffic_lights_visible: state.native_traffic_lights_visible,
        });
    }

    Ok(WindowChromeStatePayload {
        native_traffic_lights_visible: false,
    })
}

/// Shows or hides the native macOS traffic lights while keeping the decorated window.
#[cfg(target_os = "macos")]
pub fn set_macos_traffic_lights_visible(
    window: &tauri::WebviewWindow,
    visible: bool,
) -> Result<(), AppError> {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let window = window.clone();
    let main_thread_window = window.clone();
    window
        .run_on_main_thread(move || {
            let Ok(ns_window_ptr) = main_thread_window.ns_window() else {
                return;
            };
            let ns_window = unsafe { &*(ns_window_ptr as *mut NSWindow) };
            for button_kind in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ] {
                if let Some(button) = ns_window.standardWindowButton(button_kind) {
                    button.setHidden(!visible);
                    button.setEnabled(visible);
                }
            }
        })
        .map_err(|e| AppError::Io(e.to_string()))
}

/// Updates the macOS dock badge label (empty string clears the badge).
#[tauri::command]
pub fn update_dock_badge(app: AppHandle, label: String) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_webview_window("main") {
            if label.is_empty() {
                let _ = window.set_badge_label(None::<String>);
            } else {
                let _ = window.set_badge_label(Some(label));
            }
        }
    }
    let _ = app; // suppress unused warning on non-macOS
    let _ = label;
    Ok(())
}
