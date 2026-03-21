use crate::engine;
use crate::error::AppError;
use crate::tray::TrayMenuState;
use serde_json::Value;
use std::path::Path;
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
    log::debug!(
        "config:save-preference keys={}",
        config.as_object().map_or(0, |o| o.len())
    );
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
    log::debug!(
        "config:save-system keys={}",
        config.as_object().map_or(0, |o| o.len())
    );
    Ok(())
}

/// Starts the aria2c engine process with current system configuration.
/// Runs on a background thread to avoid blocking the WebView main thread.
#[tauri::command]
pub async fn start_engine_command(app: AppHandle) -> Result<(), AppError> {
    log::info!("engine:start-command");
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
    log::info!("engine:stop-command");
    tokio::task::spawn_blocking(move || engine::stop_engine(&app).map_err(AppError::Engine))
        .await
        .map_err(|e| AppError::Engine(e.to_string()))?
}

/// Stops and restarts the aria2c engine with current system configuration.
/// Runs on a background thread to avoid blocking the WebView main thread
/// during the kill → sleep → cleanup → spawn sequence.
#[tauri::command]
pub async fn restart_engine_command(app: AppHandle) -> Result<(), AppError> {
    log::info!("engine:restart-command");
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
    log::warn!("config:factory-reset");
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
        log::info!("engine:clear-session path={}", session_path.display());
    }
    Ok(())
}

/// Returns the absolute path to the bundled aria2.conf file.
///
/// Resolves via Tauri's resource directory so the path is correct in both
/// dev mode (`target/debug/`) and production bundles where resources live
/// in a platform-specific location (macOS `Contents/Resources/`, Linux
/// `/usr/lib/{app}/`, Windows beside the executable).
#[tauri::command]
pub fn get_engine_conf_path(app: AppHandle) -> Result<String, AppError> {
    let conf_path = app
        .path()
        .resolve("binaries/aria2.conf", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(crate::engine::path_to_safe_string(&conf_path))
}

/// Updates the system tray title text.
///
/// Supported platforms:
/// - **macOS**: renders in the menu bar next to the tray icon
/// - **Linux**: renders as an appindicator label next to the icon
/// - **Windows**: no-op (Windows system tray has no title API)
#[tauri::command]
pub fn update_tray_title(app: AppHandle, title: String) -> Result<(), AppError> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_title(Some(&title))
            .map_err(|e| AppError::Io(e.to_string()))?;
        // Workaround: re-set icon after set_title to prevent macOS icon disappearing (Tauri/tao bug).
        // Only needed on macOS — Linux appindicator does not have this issue.
        #[cfg(target_os = "macos")]
        {
            if let Some(icon) = app.default_window_icon() {
                let _ = tray.set_icon(Some(icon.clone()));
            }
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
///
/// Recursively traverses all submenus so that items nested inside
/// submenus are found — `Menu::get()` only checks direct children.
#[tauri::command]
pub fn update_menu_labels(app: AppHandle, labels: Value) -> Result<(), AppError> {
    use tauri::menu::MenuItemKind;

    fn apply_labels(items: &[MenuItemKind<tauri::Wry>], map: &serde_json::Map<String, Value>) {
        for item in items {
            match item {
                MenuItemKind::MenuItem(mi) => {
                    if let Some(text) = map.get(mi.id().as_ref()) {
                        let _ = mi.set_text(text.as_str().unwrap_or_default());
                    }
                }
                MenuItemKind::Submenu(sub) => {
                    if let Some(text) = map.get(sub.id().as_ref()) {
                        let _ = sub.set_text(text.as_str().unwrap_or_default());
                    }
                    if let Ok(children) = sub.items() {
                        apply_labels(&children, map);
                    }
                }
                // PredefinedMenuItems have auto-generated UUIDs that cannot
                // be predicted, so we match by their current display text
                // instead (keyed by the English default in the labels map).
                MenuItemKind::Predefined(pi) => {
                    if let Ok(current) = pi.text() {
                        if let Some(new_text) = map.get(&current) {
                            let _ = pi.set_text(new_text.as_str().unwrap_or_default());
                        }
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(menu) = app.menu() {
        if let Some(obj) = labels.as_object() {
            if let Ok(items) = menu.items() {
                apply_labels(&items, obj);
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
/// When `visible` is false, reads the `hideDockOnMinimize` preference from
/// the persistent store — only hides the Dock icon if the user opted in.
/// When `visible` is true, always restores the icon (e.g. on Reopen / tray show).
/// No-op on non-macOS platforms.
#[tauri::command]
pub fn set_dock_visible(app: AppHandle, visible: bool) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        use tauri_plugin_store::StoreExt;

        if visible {
            let _ = app.set_activation_policy(ActivationPolicy::Regular);
        } else {
            let hide_dock = app
                .store("config.json")
                .ok()
                .and_then(|s| s.get("preferences"))
                .and_then(|p| p.get("hideDockOnMinimize")?.as_bool())
                .unwrap_or(false);
            if hide_dock {
                let _ = app.set_activation_policy(ActivationPolicy::Accessory);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
    Ok(())
}

/// Classifies a tracker URL's protocol to determine probing strategy.
///
/// - `"probeable"` — HTTP/HTTPS trackers that can be checked with HEAD requests
/// - `"unknown"` — UDP/WSS trackers that cannot be probed from HTTP
fn classify_tracker_protocol(url: &str) -> &'static str {
    if url.starts_with("udp://") || url.starts_with("wss://") {
        "unknown"
    } else {
        "probeable"
    }
}

/// Probes a list of tracker URLs for reachability via HTTP HEAD requests.
/// UDP and WSS trackers cannot be probed from HTTP and are marked `"unknown"`.
/// Returns a JSON map of `{ url: "online" | "offline" | "unknown" }`.
#[tauri::command]
pub async fn probe_trackers(urls: Vec<String>) -> Result<Value, AppError> {
    use std::collections::HashMap;
    log::debug!("tracker:probe urls={}", urls.len());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| AppError::Io(e.to_string()))?;

    let mut results: HashMap<String, String> = HashMap::new();

    for url in &urls {
        if classify_tracker_protocol(url) == "unknown" {
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
        let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
        let result = rt
            .block_on(probe_trackers(urls))
            .expect("probe_trackers returned Err");
        let map = result.as_object().expect("result is not a JSON object");
        assert_eq!(
            map.get("udp://tracker.example.com:6969")
                .expect("UDP tracker key missing")
                .as_str()
                .expect("value is not a string"),
            "unknown"
        );
    }

    #[test]
    fn test_probe_classifies_wss_as_unknown() {
        let urls = vec!["wss://tracker.example.com/announce".to_string()];
        let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
        let result = rt
            .block_on(probe_trackers(urls))
            .expect("probe_trackers returned Err");
        let map = result.as_object().expect("result is not a JSON object");
        assert_eq!(
            map.get("wss://tracker.example.com/announce")
                .expect("WSS tracker key missing")
                .as_str()
                .expect("value is not a string"),
            "unknown"
        );
    }

    #[test]
    fn test_probe_empty_list_returns_empty() {
        let urls: Vec<String> = vec![];
        let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
        let result = rt
            .block_on(probe_trackers(urls))
            .expect("probe_trackers returned Err");
        let map = result.as_object().expect("result is not a JSON object");
        assert!(map.is_empty());
    }

    #[test]
    fn test_probe_unreachable_http_returns_offline() {
        // Use an invalid host that will fail to connect within the timeout
        let urls = vec!["http://192.0.2.1:1/announce".to_string()];
        let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
        let result = rt
            .block_on(probe_trackers(urls))
            .expect("probe_trackers returned Err");
        let map = result.as_object().expect("result is not a JSON object");
        assert_eq!(
            map.get("http://192.0.2.1:1/announce")
                .expect("HTTP tracker key missing")
                .as_str()
                .expect("value is not a string"),
            "offline"
        );
    }

    // ── classify_tracker_protocol ────────────────────────────────────

    #[test]
    fn classify_http_as_probeable() {
        assert_eq!(
            classify_tracker_protocol("http://tracker.example.com:6969/announce"),
            "probeable"
        );
    }

    #[test]
    fn classify_https_as_probeable() {
        assert_eq!(
            classify_tracker_protocol("https://tracker.example.com/announce"),
            "probeable"
        );
    }

    #[test]
    fn classify_udp_as_unknown() {
        assert_eq!(
            classify_tracker_protocol("udp://tracker.example.com:6969"),
            "unknown"
        );
    }

    #[test]
    fn classify_wss_as_unknown() {
        assert_eq!(
            classify_tracker_protocol("wss://tracker.example.com/announce"),
            "unknown"
        );
    }

    #[test]
    fn classify_empty_url_as_probeable() {
        // Empty/malformed URLs are not udp/wss, so they fall through to
        // HTTP probing which will fail gracefully with "offline"
        assert_eq!(classify_tracker_protocol(""), "probeable");
    }

    #[test]
    fn classify_magnet_as_probeable() {
        // Non-tracker schemes fall through to HTTP probing attempt
        assert_eq!(
            classify_tracker_protocol("magnet:?xt=urn:btih:abc"),
            "probeable"
        );
    }

    // ── check_path_exists ──────────────────────────────────────────────

    #[test]
    fn check_path_exists_returns_true_for_existing_file() {
        // Cargo.toml always exists at the workspace root when tests run
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/Cargo.toml";
        assert!(check_path_exists(path));
    }

    #[test]
    fn check_path_exists_returns_true_for_existing_directory() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/src";
        assert!(check_path_exists(path));
    }

    #[test]
    fn check_path_exists_returns_false_for_nonexistent_path() {
        assert!(!check_path_exists(
            "/definitely/does/not/exist/anywhere/file.txt".to_string()
        ));
    }

    #[test]
    fn check_path_exists_returns_false_for_empty_string() {
        assert!(!check_path_exists(String::new()));
    }

    #[test]
    fn check_path_exists_handles_path_with_spaces() {
        // Create a temp file with spaces in the path
        let dir = std::env::temp_dir().join("motrix test spaces");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("test file.txt");
        let _ = std::fs::write(&file, "test");
        assert!(check_path_exists(file.to_string_lossy().to_string()));
        // Cleanup
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    // ── check_path_is_dir ──────────────────────────────────────────────

    #[test]
    fn check_path_is_dir_returns_true_for_directory() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/src";
        assert!(check_path_is_dir(path));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_file() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/Cargo.toml";
        assert!(!check_path_is_dir(path));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_nonexistent() {
        assert!(!check_path_is_dir("/does/not/exist/whatsoever".to_string()));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_empty_string() {
        assert!(!check_path_is_dir(String::new()));
    }

    // ── normalize_path ─────────────────────────────────────────────────

    #[test]
    fn normalize_path_preserves_simple_unix_path() {
        let result = normalize_path("/home/user/downloads/file.txt");
        assert_eq!(result, "/home/user/downloads/file.txt");
    }

    #[test]
    fn normalize_path_preserves_path_with_spaces() {
        let result = normalize_path("/home/user/my downloads/file name.txt");
        assert_eq!(result, "/home/user/my downloads/file name.txt");
    }

    #[test]
    fn normalize_path_handles_empty_string() {
        let result = normalize_path("");
        assert_eq!(result, "");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_fixes_mixed_separators_windows() {
        // aria2 returns `Z:\\` + JS joins with `/` → `Z:\\/file.exe`
        let result = normalize_path("Z:\\/MotrixNext_setup.exe");
        assert_eq!(result, "Z:\\MotrixNext_setup.exe");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_fixes_double_backslash_forward_slash() {
        let result = normalize_path("D:\\/downloads/subfolder/file.zip");
        assert_eq!(result, "D:\\downloads\\subfolder\\file.zip");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_strips_extended_length_prefix() {
        // std::fs::canonicalize adds \\?\\
        let result = normalize_path("\\\\?\\C:\\Users\\test\\file.txt");
        assert_eq!(result, "C:\\Users\\test\\file.txt");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_handles_windows_unc_path() {
        let result = normalize_path("\\\\server\\share\\file.txt");
        assert_eq!(result, "\\\\server\\share\\file.txt");
    }

    #[test]
    fn normalize_path_handles_forward_slash_only() {
        // Pure forward-slash paths (cross-platform compatible)
        let result = normalize_path("/var/log/app.log");
        assert_eq!(result, "/var/log/app.log");
    }

    // ── show_item_in_dir structural tests ──────────────────────────────

    /// Verifies show_item_in_dir calls normalize_path then reveal_in_explorer.
    #[test]
    fn show_item_in_dir_calls_normalize_then_reveal() {
        let source = include_str!("app.rs");
        let fn_start = source
            .find("pub fn show_item_in_dir")
            .expect("show_item_in_dir function must exist");
        let fn_body = &source[fn_start..fn_start + 500];
        let norm_pos = fn_body
            .find("normalize_path")
            .expect("show_item_in_dir must call normalize_path");
        let reveal_pos = fn_body
            .find("reveal_in_explorer")
            .expect("show_item_in_dir must call reveal_in_explorer");
        assert!(
            norm_pos < reveal_pos,
            "normalize_path must appear before reveal_in_explorer"
        );
    }

    /// Verifies Windows cfg-gate exists and bypasses tauri_plugin_opener.
    #[test]
    fn reveal_in_explorer_has_windows_cfg_gate() {
        let source = include_str!("app.rs");
        // Must have #[cfg(windows)] fn reveal_in_explorer
        assert!(
            source.contains("#[cfg(windows)]\nfn reveal_in_explorer"),
            "reveal_in_explorer must have a #[cfg(windows)] variant"
        );
        // Must have #[cfg(not(windows))] fn reveal_in_explorer
        assert!(
            source.contains("#[cfg(not(windows))]\nfn reveal_in_explorer"),
            "reveal_in_explorer must have a #[cfg(not(windows))] fallback"
        );
    }

    /// Verifies the Windows implementation uses ILCreateFromPathW (not plugin).
    #[test]
    fn windows_reveal_uses_shell_api() {
        let source = include_str!("app.rs");
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains("ILCreateFromPathW"),
            "Windows reveal must use ILCreateFromPathW"
        );
        assert!(
            fn_body.contains("SHOpenFolderAndSelectItems"),
            "Windows reveal must use SHOpenFolderAndSelectItems"
        );
    }

    /// Verifies the Windows implementation strips \\?\UNC\ prefix (issue #3304 fix).
    #[test]
    fn windows_reveal_strips_unc_prefix() {
        let source = include_str!("app.rs");
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains(r#"starts_with(r"\\?\UNC\")"#),
            "Windows reveal must check for \\\\?\\UNC\\ prefix"
        );
    }

    /// Verifies the Windows implementation has an Electron-style ShellExecuteExW fallback.
    #[test]
    fn windows_reveal_has_shell_execute_fallback() {
        let source = include_str!("app.rs");
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains("shell_execute_open"),
            "Windows reveal must have ShellExecuteExW fallback"
        );
        assert!(
            fn_body.contains("ERROR_FILE_NOT_FOUND"),
            "Windows reveal must handle ERROR_FILE_NOT_FOUND"
        );
    }

    /// Verifies non-Windows fallback uses tauri_plugin_opener.
    #[test]
    fn non_windows_reveal_uses_plugin_opener() {
        let source = include_str!("app.rs");
        let cfg_start = source
            .find("#[cfg(not(windows))]\nfn reveal_in_explorer")
            .expect("non-Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 300];
        assert!(
            fn_body.contains("tauri_plugin_opener::reveal_item_in_dir"),
            "non-Windows fallback must use tauri_plugin_opener"
        );
    }

    // ── canonicalize best-effort tests (RAM disk / virtual FS) ────────

    /// Verifies canonicalize uses unwrap_or_else (best-effort, never hard-fails).
    /// Critical for RAM disks (ImDisk, Ruanmei Mofang) where GetFinalPathNameByHandleW
    /// is unsupported. See: https://github.com/rust-lang/rust/issues/99608
    #[test]
    fn windows_reveal_canonicalize_is_best_effort() {
        let source = include_str!("app.rs");
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        // Must use unwrap_or_else (graceful fallback), NOT map_err/? (hard error)
        assert!(
            fn_body.contains("dunce::canonicalize(path).unwrap_or_else"),
            "canonicalize must use unwrap_or_else for best-effort (not map_err/?)"
        );
        // Must NOT have map_err on canonicalize (regression guard)
        let canonicalize_pos = fn_body
            .find("dunce::canonicalize")
            .expect("must call dunce::canonicalize");
        let after_canonicalize = &fn_body[canonicalize_pos..canonicalize_pos + 200];
        assert!(
            !after_canonicalize.contains("map_err"),
            "canonicalize must NOT use map_err (would hard-fail on RAM disks)"
        );
        assert!(
            !after_canonicalize.contains(")?"),
            "canonicalize must NOT use ? operator (would hard-fail on RAM disks)"
        );
    }

    /// Verifies canonicalize fallback logs a debug message for diagnostics.
    #[test]
    fn windows_reveal_canonicalize_fallback_logs_debug() {
        let source = include_str!("app.rs");
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        // The unwrap_or_else closure must log the error
        let fallback_start = fn_body
            .find("unwrap_or_else")
            .expect("must have unwrap_or_else");
        let fallback_body = &fn_body[fallback_start..fallback_start + 200];
        assert!(
            fallback_body.contains("log::debug!"),
            "canonicalize fallback must log debug message with the error"
        );
    }

    /// Verifies canonicalize fallback creates PathBuf from the input path.
    #[test]
    fn windows_reveal_canonicalize_fallback_uses_input_path() {
        let source = include_str!("app.rs");
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        let fallback_start = fn_body
            .find("unwrap_or_else")
            .expect("must have unwrap_or_else");
        let fallback_body = &fn_body[fallback_start..fallback_start + 200];
        assert!(
            fallback_body.contains("PathBuf::from(path)"),
            "canonicalize fallback must use the already-normalized input path"
        );
    }

    /// Verifies shell_execute_open uses ShellExecuteW (not ShellExecuteExW).
    /// ShellExecuteExW requires Win32_System_Registry feature; ShellExecuteW does not.
    #[test]
    fn shell_execute_open_uses_shell_execute_w() {
        let source = include_str!("app.rs");
        // Verify the import line exists in the actual function (not test code).
        // The function imports "Shell::ShellExecuteW;" (note the semicolon — not Ex variant).
        assert!(
            source.contains("Shell::ShellExecuteW;"),
            "shell_execute_open must import ShellExecuteW"
        );
    }

    /// Verifies the to_wide helper function exists with cfg(windows).
    #[test]
    fn to_wide_helper_exists() {
        let source = include_str!("app.rs");
        // Check the cfg gate + function signature + utf16 encoding all exist
        assert!(
            source.contains("#[cfg(windows)]\nfn to_wide("),
            "to_wide helper must exist with #[cfg(windows)]"
        );
        assert!(
            source.contains("encode_utf16"),
            "to_wide must use encode_utf16 for wide string conversion"
        );
    }

    /// Verifies show_item_in_dir includes debug logging for traceability.
    #[test]
    fn show_item_in_dir_has_debug_logging() {
        let source = include_str!("app.rs");
        // Search within the function body (between pub fn and next fn/doc comment)
        let fn_start = source
            .find("pub fn show_item_in_dir")
            .expect("show_item_in_dir function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(fn_start + 500);
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("log::debug!"),
            "show_item_in_dir must include debug logging"
        );
    }

    /// Verifies Windows reveal_in_explorer initializes COM before Shell API calls.
    #[test]
    fn windows_reveal_initializes_com() {
        let source = include_str!("app.rs");
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        let com_pos = fn_body
            .find("CoInitializeEx")
            .expect("Windows reveal must initialize COM");
        let shell_pos = fn_body
            .find("ILCreateFromPathW")
            .expect("must call ILCreateFromPathW");
        assert!(
            com_pos < shell_pos,
            "COM init must happen before Shell API calls"
        );
    }

    /// Verifies open_path_normalized calls normalize_path before open.
    #[test]
    fn open_path_normalized_calls_normalize_path() {
        let source = include_str!("app.rs");
        let fn_start = source
            .find("pub fn open_path_normalized")
            .expect("open_path_normalized function must exist");
        let fn_body = &source[fn_start..fn_start + 500];
        let norm_pos = fn_body
            .find("normalize_path")
            .expect("open_path_normalized must call normalize_path");
        // normalize_path appears in the function name itself, so check
        // that there's a second occurrence (the actual call)
        let second_norm = fn_body[norm_pos + 1..]
            .find("normalize_path")
            .map(|p| p + norm_pos + 1);
        assert!(
            second_norm.is_some(),
            "open_path_normalized must call normalize_path (not just contain it in the name)"
        );
    }

    // ── normalize_path tests ──────────────────────────────────────────

    /// Verifies normalize_path uses components().collect() for separator normalization.
    #[test]
    fn normalize_path_uses_components_collect() {
        let source = include_str!("app.rs");
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("components().collect"),
            "normalize_path must use components().collect() for separator normalization"
        );
    }

    /// Verifies normalize_path uses dunce::simplified for prefix stripping.
    #[test]
    fn normalize_path_uses_dunce() {
        let source = include_str!("app.rs");
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("dunce::simplified"),
            "normalize_path must use dunce::simplified for \\\\?\\ prefix stripping"
        );
    }

    /// Verifies normalize_path includes debug logging.
    #[test]
    fn normalize_path_has_debug_logging() {
        let source = include_str!("app.rs");
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("log::debug!"),
            "normalize_path must include debug logging"
        );
    }
}

/// Returns `true` when the current process was launched by the OS
/// autostart mechanism (the Tauri autostart plugin appends `--autostart`).
#[tauri::command]
pub fn is_autostart_launch() -> bool {
    std::env::args().any(|a| a == "--autostart")
}

/// Truncates the application log file to zero bytes.
/// Uses `app_log_dir()` to locate the log — no frontend FS permission required.
#[tauri::command]
pub fn clear_log_file(app: AppHandle) -> Result<(), AppError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let log_path = log_dir.join("motrix-next.log");
    if log_path.exists() {
        std::fs::write(&log_path, "")
            .map_err(|e| AppError::Io(format!("Failed to clear log: {}", e)))?;
        log::info!("log file cleared: {}", log_path.display());
    }
    Ok(())
}

/// Collects all log files from the app log directory and compresses them
/// into a ZIP archive at the user-specified path (chosen via a save dialog
/// on the frontend). Includes:
/// - `system-info.json` with enriched machine/runtime context for diagnostics
/// - All log files from the app log directory
/// - `config.json` user configuration snapshot for issue reproduction
///
/// Returns the full path to the created ZIP file.
#[tauri::command]
pub async fn export_diagnostic_logs(app: AppHandle, save_path: String) -> Result<String, AppError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;

    if !log_dir.exists() {
        return Err(AppError::NotFound("Log directory does not exist".into()));
    }

    let zip_path = std::path::PathBuf::from(&save_path);

    let zip_file = std::fs::File::create(&zip_path)
        .map_err(|e| AppError::Io(format!("Failed to create zip: {}", e)))?;
    let mut zip_writer = zip::ZipWriter::new(zip_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // ── System info: enriched machine context for diagnostics ────────
    let pkg = app.package_info();
    let engine_pid = app
        .state::<crate::engine::EngineState>()
        .child
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.pid());
    let system_info = serde_json::json!({
        "os": std::env::consts::OS,
        "os_version": os_info::get().version().to_string(),
        "arch": std::env::consts::ARCH,
        "locale": sys_locale::get_locale().unwrap_or_default(),
        "app_version": pkg.version.to_string(),
        "app_name": pkg.name,
        "log_level": format!("{}", crate::read_log_level()),
        "engine_pid": engine_pid,
        "webkit_dmabuf_disabled": std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .unwrap_or_default(),
        "exported_at": chrono::Local::now().to_rfc3339(),
    });
    let info_bytes = serde_json::to_vec_pretty(&system_info)
        .map_err(|e| AppError::Io(format!("Failed to serialize system info: {}", e)))?;
    zip_writer
        .start_file("system-info.json", options)
        .map_err(|e| AppError::Io(format!("Failed to add system-info.json: {}", e)))?;
    std::io::Write::write_all(&mut zip_writer, &info_bytes)
        .map_err(|e| AppError::Io(format!("Failed to write system-info.json: {}", e)))?;

    // ── Log files ───────────────────────────────────────────────────
    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| AppError::Io(format!("Failed to read log dir: {}", e)))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let content = std::fs::read(&path)
                .map_err(|e| AppError::Io(format!("Failed to read {}: {}", name, e)))?;
            zip_writer
                .start_file(name.to_string(), options)
                .map_err(|e| AppError::Io(format!("Failed to add {} to zip: {}", name, e)))?;
            std::io::Write::write_all(&mut zip_writer, &content)
                .map_err(|e| AppError::Io(format!("Failed to write {}: {}", name, e)))?;
        }
    }

    // ── Config snapshot: user preferences for issue reproduction ─────
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let config_path = data_dir.join("config.json");
    if config_path.exists() {
        let config_content = std::fs::read(&config_path)
            .map_err(|e| AppError::Io(format!("Failed to read config: {}", e)))?;
        zip_writer
            .start_file("config.json", options)
            .map_err(|e| AppError::Io(format!("Failed to add config.json: {}", e)))?;
        std::io::Write::write_all(&mut zip_writer, &config_content)
            .map_err(|e| AppError::Io(format!("Failed to write config.json: {}", e)))?;
    }

    zip_writer
        .finish()
        .map_err(|e| AppError::Io(format!("Failed to finalize zip: {}", e)))?;

    log::info!("Exported diagnostic logs to {}", zip_path.display());
    Ok(crate::engine::path_to_safe_string(&zip_path))
}

/// Checks whether a file or directory exists at the given path.
///
/// This command bypasses Tauri's frontend FS scope restrictions, which
/// fail to match Windows drive-root paths like `Z:\` due to glob pattern
/// limitations (see <https://github.com/tauri-apps/tauri/issues/11119>).
///
/// For a download manager that must verify user-chosen download targets on
/// any mounted volume, scope-free existence checks are essential.
#[tauri::command]
pub fn check_path_exists(path: String) -> bool {
    let result = std::path::Path::new(&path).exists();
    log::debug!("check_path_exists: path={path:?} result={result}");
    result
}

/// Returns `true` when the given path exists **and** is a directory.
///
/// Counterpart to [`check_path_exists`] — used by the frontend to decide
/// whether to call `openPath` (for a directory) or `revealItemInDir` (for
/// a file). Same scope-bypass rationale applies.
#[tauri::command]
pub fn check_path_is_dir(path: String) -> bool {
    let result = std::path::Path::new(&path).is_dir();
    log::debug!("check_path_is_dir: path={path:?} result={result}");
    result
}

/// Normalizes a file-system path for safe use with OS shell APIs.
///
/// Handles three classes of path issues that cause "file not found" errors:
/// 1. **Mixed separators** — aria2 on Windows may return `Z:\\` while JS
///    joins with `/`, producing `Z:\\/file.exe`. `Path::new()` normalizes
///    this to the platform's native separator.
/// 2. **`\\?\\` prefix** — `std::fs::canonicalize()` on Windows may return
///    extended-length paths (`\\?\\C:\\...`). `dunce::simplified()` strips
///    this prefix when safe, since Win32 Shell APIs like `ILCreateFromPathW`
///    do not support it.
/// 3. **Trailing separators** — Ensures paths ending in `\\` or `/` do not
///    confuse shell APIs.
pub(crate) fn normalize_path(raw: &str) -> String {
    use std::path::PathBuf;
    // Step 1: Decompose into components and reassemble with native separators.
    // On Windows, `Path::new("Z:/file")` understands `/` but `to_string_lossy()`
    // returns the ORIGINAL string unchanged. `.components().collect::<PathBuf>()`
    // reconstructs with `\` on Windows, `/` on Unix.
    let reassembled: PathBuf = Path::new(raw).components().collect();
    // Step 2: Strip `\\?\` prefix if present (safe for Win32 Shell APIs).
    let normalized = dunce::simplified(&reassembled);
    log::debug!("normalize_path: raw={raw:?} normalized={normalized:?}");
    normalized.to_string_lossy().to_string()
}

/// Reveals a file or directory in the system file explorer.
///
/// ## Windows
///
/// Bypasses `tauri_plugin_opener::reveal_item_in_dir` because that plugin
/// calls `dunce::canonicalize()` internally (L13 of `reveal_item_in_dir.rs`),
/// which converts mapped-drive paths (e.g. `Z:\file`) to UNC format
/// (`\\?\UNC\server\share\file`). `ILCreateFromPathW` cannot handle the
/// `\\?\UNC\` prefix → returns NULL → os error 2.
/// See: <https://github.com/tauri-apps/plugins-workspace/issues/3304>
///
/// Instead, we call the Windows Shell APIs directly:
/// 1. Normalize separators via `components().collect()`
/// 2. Canonicalize via `dunce::canonicalize()` (strips `\\?\` for local drives)
/// 3. Strip residual `\\?\UNC\` prefix → `\\server\share\...` (for mapped drives)
/// 4. Call `ILCreateFromPathW` + `SHOpenFolderAndSelectItems`
/// 5. Fallback: `ShellExecuteExW` on `ERROR_FILE_NOT_FOUND` (Electron pattern)
///
/// ## macOS / Linux
///
/// Delegates to `tauri_plugin_opener::reveal_item_in_dir` (no UNC bug on these
/// platforms — macOS uses `NSWorkspace`, Linux uses D-Bus FileManager1).
#[tauri::command]
pub fn show_item_in_dir(path: String) -> Result<(), AppError> {
    let normalized = normalize_path(&path);
    log::debug!("show_item_in_dir: original={path:?} normalized={normalized:?}");
    reveal_in_explorer(&normalized)
}

/// Platform-dispatched implementation for revealing files in the explorer.
#[cfg(not(windows))]
fn reveal_in_explorer(path: &str) -> Result<(), AppError> {
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|e| AppError::Io(format!("Failed to reveal: {e}")))
}

/// Windows implementation: direct Shell API calls with UNC prefix stripping.
///
/// Mirrors the approach used by:
/// - Electron: `shell/common/platform_util_win.cc` L282-310
/// - tauri-plugin-opener: `reveal_item_in_dir.rs` L99-160 (but with UNC fix)
#[cfg(windows)]
fn reveal_in_explorer(path: &str) -> Result<(), AppError> {
    use std::path::PathBuf;
    use windows_sys::Win32::{
        Foundation::ERROR_FILE_NOT_FOUND,
        System::Com::CoInitializeEx,
        UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems},
    };

    // Step 1: Best-effort canonicalization.
    // `dunce::canonicalize` resolves symlinks and strips `\\?\` for local drives.
    // However, some virtual file system drivers (RAM disks like ImDisk, Ruanmei Mofang)
    // do not support `GetFinalPathNameByHandleW` — the API that `canonicalize()`
    // relies on — and return ERROR_FILE_NOT_FOUND even though the file exists.
    // See: https://github.com/rust-lang/rust/issues/99608
    // Fallback: use the already-normalized path from `normalize_path()`.
    let canonical = dunce::canonicalize(path).unwrap_or_else(|e| {
        log::debug!("canonicalize failed (virtual FS?), using normalized path: {e}");
        PathBuf::from(path)
    });

    // Step 2: Strip `\\?\UNC\` prefix for mapped drives.
    // `\\?\UNC\server\share\file` → `\\server\share\file`
    // This is the fix for GitHub issue #3304.
    let path_str = canonical.to_string_lossy();
    let fixed: PathBuf = if path_str.starts_with(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", &path_str[r"\\?\UNC\".len()..]))
    } else if path_str.starts_with(r"\\?\") {
        // Shouldn't happen (dunce handles this), but defensive
        PathBuf::from(&path_str[r"\\?\".len()..])
    } else {
        canonical.clone()
    };

    log::debug!("reveal_in_explorer: canonical={canonical:?} fixed={fixed:?}");

    // Step 3: Get the parent directory for SHOpenFolderAndSelectItems.
    let parent = fixed
        .parent()
        .ok_or_else(|| AppError::Io(format!("No parent directory for {path:?}")))?;

    // Step 4: Convert paths to wide strings (null-terminated UTF-16).
    let parent_wide = to_wide(parent.to_string_lossy().as_ref());
    let file_wide = to_wide(fixed.to_string_lossy().as_ref());

    unsafe {
        // Initialize COM (required for Shell APIs, idempotent).
        let _ = CoInitializeEx(std::ptr::null(), 0);

        // Convert parent directory to ITEMIDLIST.
        let parent_pidl = ILCreateFromPathW(parent_wide.as_ptr());
        if parent_pidl.is_null() {
            // Fallback: open the parent directory directly.
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        // Convert target file to ITEMIDLIST.
        let file_pidl = ILCreateFromPathW(file_wide.as_ptr());
        if file_pidl.is_null() {
            ILFree(parent_pidl);
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        // Open folder and select the file.
        let items: [*const _; 1] = [file_pidl as *const _];
        let result = SHOpenFolderAndSelectItems(parent_pidl, 1, items.as_ptr(), 0);

        // Electron-style fallback: on ERROR_FILE_NOT_FOUND, use ShellExecuteW.
        // "On some systems, the above call mysteriously fails with 'file not found'
        //  even though the file is there." — Electron source
        if result != 0 && (result as u32) == ERROR_FILE_NOT_FOUND {
            ILFree(file_pidl);
            ILFree(parent_pidl);
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        ILFree(file_pidl);
        ILFree(parent_pidl);

        if result != 0 {
            return Err(AppError::Io(format!(
                "SHOpenFolderAndSelectItems failed: HRESULT 0x{result:08X}"
            )));
        }
    }

    Ok(())
}

/// Fallback: open a directory with `ShellExecuteW("explore")`.
#[cfg(windows)]
fn shell_execute_open(dir: &str) -> Result<(), AppError> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let dir_wide = to_wide(dir);
    let verb_wide = to_wide("explore");

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(), // hwnd
            verb_wide.as_ptr(),   // lpOperation: "explore"
            dir_wide.as_ptr(),    // lpFile: directory path
            std::ptr::null(),     // lpParameters
            std::ptr::null(),     // lpDirectory
            SW_SHOWNORMAL,        // nShowCmd
        )
    };
    // ShellExecuteW returns HINSTANCE > 32 on success.
    if (result as isize) <= 32 {
        Err(AppError::Io(format!("ShellExecuteW failed for {dir:?}")))
    } else {
        Ok(())
    }
}

/// Convert a &str to a null-terminated Vec<u16> for Win32 wide-string APIs.
#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Opens a file or directory with the system's default application.
///
/// Normalizes the path before calling the opener to handle mixed separators.
/// Counterpart to [`show_item_in_dir`] — used when the target is a directory
/// (opens in file manager) or a file (opens with default app).
#[tauri::command]
pub fn open_path_normalized(app: AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    log::debug!("file:open path={path:?}");
    let normalized = normalize_path(&path);
    app.opener()
        .open_path(&normalized, None::<&str>)
        .map_err(|e| AppError::Io(format!("Failed to open {}: {}", path, e)))
}

/// Moves a file to the OS trash / recycle bin.
///
/// Uses the `trash` crate for cross-platform support:
/// - macOS: NSFileManager.trashItemAtURL
/// - Windows: IFileOperation + FOFX_RECYCLEONDELETE
/// - Linux: FreeDesktop Trash spec (XDG_DATA_HOME/Trash)
#[tauri::command]
pub fn trash_file(path: String) -> Result<(), AppError> {
    log::info!("file:trash path={path:?}");
    trash::delete(&path).map_err(|e| AppError::Io(e.to_string()))
}

/// Returns `true` when the WebKitGTK DMABuf renderer has been disabled via
/// the `WEBKIT_DISABLE_DMABUF_RENDERER` environment variable.
///
/// # Context
///
/// WORKAROUND for WebKitGTK Bug #262607 (RESOLVED WONTFIX).
/// <https://bugs.webkit.org/show_bug.cgi?id=262607>
///
/// On Linux with NVIDIA proprietary drivers, WebKitGTK's DMABuf renderer
/// crashes, so users must set `WEBKIT_DISABLE_DMABUF_RENDERER=1` to fall
/// back to software compositing.  That fallback loses the alpha channel
/// after a maximize → restore cycle, breaking CSS `border-radius` corners.
///
/// The frontend uses this flag to decide:
/// - `false` → safe to remove border-radius on maximize (normal behavior)
/// - `true`  → keep border-radius at all times (NVIDIA workaround)
///
/// On non-Linux platforms this always returns `false`.
#[tauri::command]
pub fn is_dmabuf_renderer_disabled() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}
