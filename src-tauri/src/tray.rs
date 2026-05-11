use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

/// Embedded tray icon bytes.
///
/// On macOS: a white-on-transparent template image (@2x, 88×88 px).
/// The system auto-inverts for light/dark menu bar — white silhouette
/// is the standard macOS convention.
///
/// On Windows/Linux: the full-colour app icon (64×64 px) for the
/// system tray.  Must be clearly visible on both light and dark
/// taskbar themes — a white silhouette would be invisible on a light
/// taskbar.
#[cfg(target_os = "macos")]
pub const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon@2x.png");
#[cfg(not(target_os = "macos"))]
pub const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-icon-color.png");
#[cfg(not(target_os = "macos"))]
pub const TRAY_ICON_DOWNLOADING_BYTES: &[u8] =
    include_bytes!("../icons/tray-icon-color-downloading.png");

/// Whether the current platform expects the tray icon to be rendered as an
/// AppKit template image.
pub const TRAY_ICON_IS_TEMPLATE: bool = cfg!(target_os = "macos");

/// Creates a `tauri::image::Image` from the embedded tray icon bytes.
///
/// This is the single source of truth for the tray icon bitmap, shared
/// between initial setup (`setup_tray`) and the `update_tray_title`
/// workaround that must re-set the icon after `set_title` on macOS.
pub fn tray_icon_image() -> tauri::image::Image<'static> {
    tray_icon_image_for_state(TrayIconState::Normal)
}

pub fn tray_icon_image_for_state(state: TrayIconState) -> tauri::image::Image<'static> {
    let icon = match state {
        TrayIconState::Normal => TRAY_ICON_BYTES,
        TrayIconState::Downloading => TRAY_ICON_DOWNLOADING_BYTES,
    };
    tauri::image::Image::from_bytes(icon).expect("embedded tray icon is valid PNG")
}

/// Re-applies the tray icon while preserving platform-specific rendering flags.
///
/// macOS menu bar icons must be template images so AppKit can render the same
/// monochrome mask correctly on light, dark, and highlighted menu bar states.
/// Any path that re-sets the icon must restore that flag immediately afterward,
/// otherwise AppKit treats the bitmap as a normal white image.
pub fn refresh_tray_icon(tray: &TrayIcon<tauri::Wry>) -> tauri::Result<()> {
    let tray_state = tray.app_handle().state::<TrayState>();
    let icon_state = *tray_state
        .icon_state
        .lock()
        .expect("get tray icon state lock error");
    let icon = tray_icon_image_for_state(icon_state);
    tray.set_icon(Some(icon))?;
    if TRAY_ICON_IS_TEMPLATE {
        tray.set_icon_as_template(true)?;
    }
    Ok(())
}

/// Holds references to tray menu items for dynamic label updates (i18n).
/// Used by the `update_tray_menu_labels` command to set localized text
/// at runtime without rebuilding the menu.
pub struct TrayState {
    pub items: Mutex<HashMap<String, MenuItem<tauri::Wry>>>,
    pub icon_state: Mutex<TrayIconState>,
}

/// Tray icon states for dynamic icon switching.
#[derive(Default, Clone, Copy)]
pub enum TrayIconState {
    #[default]
    Normal,
    Downloading,
}

/// Returns the existing main window, or recreates it if it was destroyed.
///
/// On Linux/Wayland + `decorations: false`, the compositor can destroy
/// the window without emitting `CloseRequested`.  When the user later
/// clicks the tray icon or triggers macOS Reopen, the original window
/// handle is gone.  This function detects that and rebuilds the window
/// using the same config as `tauri.conf.json`.
///
/// The newly created window is visible by default — the caller can
/// `.show()` + `.set_focus()` as usual.
pub fn get_or_create_main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("main") {
        return Some(window);
    }

    // Window was destroyed — recreate from config.
    log::warn!("tray:window-not-found label=main — recreating after compositor force-close");
    crate::services::deep_link::mark_frontend_unready(app);
    crate::services::frontend_action::mark_frontend_actions_unready(app);

    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Motrix Next")
        .inner_size(1068.0, 680.0)
        .min_inner_size(970.0, 560.0)
        .visible(false);

    // macOS: native traffic lights via overlay title bar (matches tauri.macos.conf.json).
    #[cfg(target_os = "macos")]
    {
        use tauri::TitleBarStyle;
        builder = builder
            .transparent(true)
            .decorations(true)
            .hidden_title(true)
            .title_bar_style(TitleBarStyle::Overlay)
            .shadow(true);
    }
    // Windows/Linux: transparent frameless window with custom controls.
    // No CSS border-radius — DWM provides native corner rounding on Win11.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.transparent(true).decorations(false);
    }

    match builder.build() {
        Ok(w) => {
            crate::restore_window_state_if_enabled(app, &w);
            log::info!("tray:window-recreated label=main");
            Some(w)
        }
        Err(e) => {
            log::error!("tray:window-recreate-failed error={}", e);
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowActivationOutcome {
    Activated,
    WindowUnavailable,
}

pub fn activate_main_window(app: &AppHandle, source: &'static str) -> WindowActivationOutcome {
    log::info!("window:activate-start source={source}");
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        if let Err(e) = app.set_activation_policy(ActivationPolicy::Regular) {
            log::warn!("window:activate-policy-failed source={source} error={e}");
        }
    }

    let Some(window) = get_or_create_main_window(app) else {
        log::error!("window:activate-failed source={source} reason=window-unavailable");
        return WindowActivationOutcome::WindowUnavailable;
    };

    if let Err(e) = window.unminimize() {
        log::warn!("window:activate-unminimize-failed source={source} error={e}");
    }
    if let Err(e) = window.show() {
        log::warn!("window:activate-show-failed source={source} error={e}");
    }
    if let Err(e) = window.set_focus() {
        log::warn!("window:activate-focus-failed source={source} error={e}");
    }

    log::info!("window:activate-done source={source}");
    WindowActivationOutcome::Activated
}

pub fn setup_tray(app: &AppHandle) -> Result<TrayState, Box<dyn std::error::Error>> {
    // Create MenuItem references for TrayMenuState (used by update_tray_menu_labels).
    // All three platforms use the same native menu — no platform-specific branching.
    let show_item = MenuItem::with_id(app, "show", "Show Motrix Next", true, None::<&str>)?;
    let new_task_item = MenuItem::with_id(app, "tray-new-task", "New Task", true, None::<&str>)?;
    let resume_all_item =
        MenuItem::with_id(app, "tray-resume-all", "Resume All", true, None::<&str>)?;
    let pause_all_item = MenuItem::with_id(app, "tray-pause-all", "Pause All", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;

    // Clone items before moving into the HashMap — the menu needs the originals,
    // while the HashMap is used for dynamic label updates.
    let mut items_map: HashMap<String, MenuItem<tauri::Wry>> = HashMap::new();
    items_map.insert("show".to_string(), show_item.clone());
    items_map.insert("tray-new-task".to_string(), new_task_item.clone());
    items_map.insert("tray-resume-all".to_string(), resume_all_item.clone());
    items_map.insert("tray-pause-all".to_string(), pause_all_item.clone());
    items_map.insert("tray-quit".to_string(), quit_item.clone());

    // Build the native OS menu — unified for macOS, Windows, and Linux.
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &PredefinedMenuItem::separator(app)?,
            &new_task_item,
            &resume_all_item,
            &pause_all_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let _tray = TrayIconBuilder::with_id("motrix-next")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Motrix Next")
        .icon(tray_icon_image())
        .icon_as_template(TRAY_ICON_IS_TEMPLATE)
        .on_tray_icon_event(|tray, event| {
            // Left-click: show main window (macOS and Windows).
            // Linux libappindicator does not emit TrayIconEvent::Click —
            // the "Show" menu item serves as the equivalent on Linux.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                log::info!("tray:left-click — showing main window");
                activate_main_window(app, "tray-left-click");
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "show" => {
                    log::info!("tray:menu-show — showing main window");
                    activate_main_window(app, "tray-menu-show");
                }
                "tray-pause-all" => {
                    log::info!("tray:pause-all — calling aria2 directly");
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(aria2) = app.try_state::<crate::aria2::client::Aria2State>() {
                            if let Err(e) = aria2.0.force_pause_all().await {
                                log::warn!("tray:pause-all failed: {e}");
                            }
                        }
                    });
                }
                "tray-resume-all" => {
                    log::info!("tray:resume-all — calling aria2 directly");
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(aria2) = app.try_state::<crate::aria2::client::Aria2State>() {
                            if let Err(e) = aria2.0.unpause_all().await {
                                log::warn!("tray:resume-all failed: {e}");
                            }
                        }
                    });
                }
                "tray-quit" => {
                    // Handle quit directly — do NOT emit to frontend.
                    // In lightweight mode the WebView is destroyed (window.destroy()),
                    // so app.emit() would silently fail. app.exit(0) triggers the
                    // RunEvent::Exit handler for full cleanup (save session,
                    // stop engine, unmap UPnP). issue #194.
                    log::info!("tray:quit — exiting app");
                    app.exit(0);
                }
                "tray-new-task" => {
                    log::info!("tray:new-task — dispatching frontend action");
                    crate::services::frontend_action::dispatch_frontend_action(
                        app,
                        crate::services::frontend_action::FrontendActionChannel::TrayMenuAction,
                        crate::services::frontend_action::FrontendActionKind::NewTask,
                        "tray-new-task",
                    );
                }
                _ => {
                    if let Some(action) = resolve_tray_action(id) {
                        let _ = app.emit("tray-menu-action", action);
                    }
                }
            }
        })
        .build(app)?;

    // ── Linux: deferred icon re-set ──────────────────────────────────
    //
    // On Linux, the tray-icon crate uses the SNI D-Bus protocol via
    // libappindicator.  The icon is written to a temp PNG file under
    // $XDG_RUNTIME_DIR/tray-icon/ and registered with the session's
    // StatusNotifierWatcher.  When the app is launched at login by the
    // OS autostart mechanism, KDE Plasma Shell's StatusNotifierHost may
    // not be fully initialised — the SNI registration succeeds at the
    // D-Bus level but the host either misses the initial NewIcon signal
    // or fails to read the icon pixmap, resulting in a black square.
    //
    // Work around this by re-setting the icon after a short delay.
    // set_icon() overwrites the same temp PNG and calls
    // AppIndicator::set_icon_full(), which emits a fresh NewIcon signal.
    // The now-ready host receives it and re-reads the file correctly.
    //
    // This is the same pattern as the macOS set_title workaround in
    // stat.rs (L479-485) and aligns with the Electron community standard
    // of "sleep && relaunch" — but implemented non-blockingly inside the
    // app so no user-side .desktop file changes are needed.
    //
    // The call is idempotent: on manual launches where the host is
    // already ready, this is a harmless no-op.  Issue #242.
    #[cfg(target_os = "linux")]
    {
        let app_handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if let Some(tray) = app_handle.tray_by_id("motrix-next") {
                let _ = refresh_tray_icon(&tray);
                log::info!(
                    "tray:linux-deferred-icon-refresh — re-set icon after 3 s startup delay"
                );
            }
        });
    }

    Ok(TrayState {
        items: Mutex::new(items_map),
        icon_state: Mutex::new(TrayIconState::default()),
    })
}

/// Maps a tray menu event ID to the action string emitted to the frontend.
///
/// Returns `None` for actions handled natively in `on_menu_event`
/// (show, pause-all, resume-all, quit, new-task) and for unknown IDs.
///
/// All tray actions are now handled directly in Rust to work correctly
/// when the WebView is destroyed in lightweight mode (issue #194).
/// This function remains as a fallback for future extensibility.
pub fn resolve_tray_action(menu_id: &str) -> Option<&str> {
    // All known tray actions are handled natively in on_menu_event:
    //   "show", "tray-pause-all", "tray-resume-all" — direct aria2/window ops
    //   "tray-quit" — app.exit(0)
    //   "tray-new-task" — get_or_create_main_window + emit
    // No action is forwarded to the frontend.
    let _ = menu_id;
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_quit_handled_natively() {
        // tray-quit is handled directly by app.exit(0) in on_menu_event,
        // not routed through resolve_tray_action → emit to frontend.
        // This ensures quit works even when the WebView is destroyed
        // (lightweight mode). See issue #194.
        assert_eq!(resolve_tray_action("tray-quit"), None);
    }

    #[test]
    fn resolve_new_task_handled_natively() {
        // tray-new-task is handled directly in on_menu_event:
        // get_or_create_main_window() + emit. Not routed through
        // resolve_tray_action. Ensures window is recreated in
        // lightweight mode before the event is emitted.
        assert_eq!(resolve_tray_action("tray-new-task"), None);
    }

    #[test]
    fn resolve_pause_all_handled_natively() {
        assert_eq!(resolve_tray_action("tray-pause-all"), None);
    }

    #[test]
    fn resolve_resume_all_handled_natively() {
        assert_eq!(resolve_tray_action("tray-resume-all"), None);
    }

    #[test]
    fn resolve_show_returns_none() {
        // "show" is handled natively, not emitted to frontend
        assert_eq!(resolve_tray_action("show"), None);
    }

    #[test]
    fn resolve_unknown_returns_none() {
        assert_eq!(resolve_tray_action("nonexistent"), None);
    }

    /// Verify the embedded tray icon bytes are a valid PNG with correct header.
    #[test]
    fn tray_icon_bytes_are_valid_png() {
        // PNG files start with the 8-byte magic signature.
        let png_signature: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert!(
            TRAY_ICON_BYTES.len() > 8,
            "tray icon file is too small to be a valid PNG"
        );
        assert_eq!(
            &TRAY_ICON_BYTES[..8],
            &png_signature,
            "tray icon does not have valid PNG header"
        );
    }

    /// Verify tray_icon_image() does not panic (bytes decode successfully).
    #[test]
    fn tray_icon_image_does_not_panic() {
        let img = tray_icon_image();
        // Image must have non-zero dimensions.
        assert!(
            !img.rgba().is_empty(),
            "decoded tray icon has no pixel data"
        );
    }
}
