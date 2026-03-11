use crate::engine;
use crate::error::AppError;
use crate::tray::TrayMenuState;
use serde_json::Value;
use tauri::window::ProgressBarState;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_store::StoreExt;

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
/// Runs on a background thread to avoid blocking the WebView main thread.
#[tauri::command]
pub async fn start_engine_command(app: AppHandle) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let config = get_system_config(app.clone())?;
        engine::start_engine(&app, &config).map_err(AppError::Engine)
    })
    .await
    .map_err(|e| AppError::Engine(e.to_string()))?
}

/// Gracefully stops the running aria2c engine process.
/// Runs on a background thread to avoid blocking the WebView main thread.
#[tauri::command]
pub async fn stop_engine_command(app: AppHandle) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || engine::stop_engine(&app).map_err(AppError::Engine))
        .await
        .map_err(|e| AppError::Engine(e.to_string()))?
}

/// Stops and restarts the aria2c engine with current system configuration.
/// Runs on a background thread to avoid blocking the WebView main thread
/// during the kill → sleep → cleanup → spawn sequence.
#[tauri::command]
pub async fn restart_engine_command(app: AppHandle) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let config = get_system_config(app.clone())?;
        engine::restart_engine(&app, &config).map_err(AppError::Engine)
    })
    .await
    .map_err(|e| AppError::Engine(e.to_string()))?
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

/// Toggles the macOS Dock icon visibility at runtime.
/// `Accessory` hides the icon (menu-bar-only mode); `Regular` restores it.
/// No-op on non-macOS platforms.
///
/// When hiding, forces macOS to process the policy change by calling
/// `NSApp.hide()`. Without this, `setActivationPolicy(.accessory)` alone
/// does not reliably remove the dock icon after the app has been presented
/// as a Regular app.
#[tauri::command]
pub fn set_dock_visible(app: AppHandle, visible: bool) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(if visible {
            ActivationPolicy::Regular
        } else {
            ActivationPolicy::Accessory
        });
        // Force macOS to update the dock by deactivating the app.
        // set_activation_policy alone doesn't remove the dock icon
        // after the app has already been presented as Regular.
        if !visible {
            unsafe {
                use objc2::MainThreadMarker;
                use objc2_app_kit::NSApplication;
                let mtm = MainThreadMarker::new_unchecked();
                let ns_app = NSApplication::sharedApplication(mtm);
                ns_app.hide(None);
            }
        }
    }
    let _ = (app, visible);
    Ok(())
}

/// Probes a list of tracker URLs for reachability via HTTP HEAD requests.
/// UDP and WSS trackers cannot be probed from HTTP and are marked `"unknown"`.
/// Returns a JSON map of `{ url: "online" | "offline" | "unknown" }`.
#[tauri::command]
pub async fn probe_trackers(urls: Vec<String>) -> Result<Value, AppError> {
    use std::collections::HashMap;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| AppError::Io(e.to_string()))?;

    let mut results: HashMap<String, String> = HashMap::new();

    for url in &urls {
        if url.starts_with("udp://") || url.starts_with("wss://") {
            results.insert(url.clone(), "unknown".to_string());
            continue;
        }
        let status = match client.head(url).send().await {
            Ok(_) => "online",
            Err(_) => "offline",
        };
        results.insert(url.clone(), status.to_string());
    }

    serde_json::to_value(results).map_err(|e| AppError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_probe_classifies_udp_as_unknown() {
        let urls = vec!["udp://tracker.example.com:6969".to_string()];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(probe_trackers(urls)).unwrap();
        let map = result.as_object().unwrap();
        assert_eq!(
            map.get("udp://tracker.example.com:6969")
                .unwrap()
                .as_str()
                .unwrap(),
            "unknown"
        );
    }

    #[test]
    fn test_probe_classifies_wss_as_unknown() {
        let urls = vec!["wss://tracker.example.com/announce".to_string()];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(probe_trackers(urls)).unwrap();
        let map = result.as_object().unwrap();
        assert_eq!(
            map.get("wss://tracker.example.com/announce")
                .unwrap()
                .as_str()
                .unwrap(),
            "unknown"
        );
    }

    #[test]
    fn test_probe_empty_list_returns_empty() {
        let urls: Vec<String> = vec![];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(probe_trackers(urls)).unwrap();
        let map = result.as_object().unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn test_probe_unreachable_http_returns_offline() {
        // Use an invalid host that will fail to connect within the timeout
        let urls = vec!["http://192.0.2.1:1/announce".to_string()];
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(probe_trackers(urls)).unwrap();
        let map = result.as_object().unwrap();
        assert_eq!(
            map.get("http://192.0.2.1:1/announce")
                .unwrap()
                .as_str()
                .unwrap(),
            "offline"
        );
    }
}
