use crate::error::AppError;
use crate::tray::TrayState;
use serde_json::Value;
#[cfg(not(target_os = "macos"))]
use tauri::window::ProgressBarState;
use tauri::AppHandle;
use tauri::Manager;

/// Updates the system tray title text.
///
/// Supported platforms:
/// - **macOS**: renders in the menu bar next to the tray icon
/// - **Linux**: renders as an appindicator label next to the icon
/// - **Windows**: no-op (Windows system tray has no title API)
#[tauri::command]
pub fn update_tray_title(app: AppHandle, title: String) -> Result<(), AppError> {
    if let Some(tray) = app.tray_by_id("motrix-next") {
        tray.set_title(Some(&title))
            .map_err(|e| AppError::Io(e.to_string()))?;
        // Workaround: re-set icon after set_title to prevent macOS icon disappearing (Tauri/tao bug).
        // Uses the dedicated tray icon — NOT default_window_icon() which is the
        // full-colour app icon and would look out of place in the macOS menu bar.
        // The helper keeps the macOS template flag attached to the refreshed icon.
        #[cfg(target_os = "macos")]
        {
            let _ = crate::tray::refresh_tray_icon(&tray);
        }
    }
    Ok(())
}

/// Updates localized labels on tray menu items by their IDs.
#[tauri::command]
pub fn update_tray_menu_labels(app: AppHandle, labels: Value) -> Result<(), AppError> {
    let state = app.state::<TrayState>();
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
///
/// macOS: Uses `set_dock_progress()` (NSDockTile, app-level — no Window required).
/// Windows: Uses `window.set_progress_bar()` (taskbar progress, requires Window).
#[tauri::command]
pub fn update_progress_bar(app: AppHandle, progress: f64) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        if progress < 0.0 {
            crate::services::stat::set_dock_progress(None);
        } else {
            crate::services::stat::set_dock_progress(Some((progress * 100.0) as u64));
        }
    }

    #[cfg(not(target_os = "macos"))]
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

    let _ = app; // suppress unused warning when macOS
    Ok(())
}

/// Updates the macOS dock badge label (empty string clears the badge).
///
/// Uses `set_dock_badge()` which calls `NSApp().dockTile().setBadgeLabel()`
/// directly — no Window object required.  This ensures the badge updates
/// even when the WebView is destroyed in lightweight mode.
#[tauri::command]
pub fn update_dock_badge(_app: AppHandle, label: String) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        if label.is_empty() {
            crate::services::stat::set_dock_badge(None);
        } else {
            crate::services::stat::set_dock_badge(Some(&label));
        }
    }
    let _ = _app; // suppress unused warning on non-macOS
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

/// Sets the main window's alpha (opacity) value.
///
/// Used during the exit animation to fade the entire native window —
/// including OS-rendered elements like the macOS traffic lights — that
/// CSS opacity transitions cannot reach.
///
/// `alpha` is clamped to `0.0..=1.0`.  No-op on non-macOS.
#[tauri::command]
pub fn set_window_alpha(app: AppHandle, alpha: f64) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        let alpha = alpha.clamp(0.0, 1.0);
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(ns_window) = window.ns_window() {
                // SAFETY: ns_window() returns a valid NSWindow pointer.
                // setAlphaValue: is a standard NSWindow method (not private API).
                unsafe {
                    let ns_win: &objc2::runtime::AnyObject =
                        &*(ns_window as *const objc2::runtime::AnyObject);
                    let _: () = objc2::msg_send![ns_win, setAlphaValue: alpha];
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, alpha);
    Ok(())
}

/// Programmatically triggers the minimize-to-tray flow from the frontend.
///
/// Delegates entirely to [`handle_minimize_to_tray()`](crate::handle_minimize_to_tray)
/// — the same code path used by `CloseRequested` and `Cmd+W`.  In lightweight
/// mode this destroys the WebView; in standard mode it hides the window.
///
/// Primary use case: autostart + lightweight mode.  The frontend calls this
/// **after** completing all initialization (engine start, option sync,
/// resume-all) so the WebView can be safely destroyed without breaking
/// the startup sequence.  All background services (stat polling, task
/// monitor, speed scheduler) continue running in Rust.
///
/// Cross-platform: macOS Dock hiding (`hideDockOnMinimize`) and the
/// cold-start phase transition (`end_cold_start`) are handled internally
/// by `handle_minimize_to_tray` — no platform-specific logic needed here.
#[tauri::command]
pub fn minimize_to_tray(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        crate::handle_minimize_to_tray(&app, &window);
    }
}
