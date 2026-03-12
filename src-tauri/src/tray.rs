use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    menu::MenuItem,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
#[cfg(not(target_os = "linux"))]
use tauri::PhysicalPosition;

/// Holds references to tray menu items for dynamic label updates (i18n).
/// Retained for backward-compatibility with `update_tray_menu_labels` command.
pub struct TrayMenuState {
    pub items: Mutex<HashMap<String, MenuItem<tauri::Wry>>>,
}

/// Create the custom tray popup window.
///
/// The window is built dynamically (NOT declared in tauri.conf.json).
/// It starts hidden and is shown/positioned on click via
/// `on_tray_icon_event` using click-event cursor coordinates.
///
/// Excluded on Linux: `libappindicator` does not emit `TrayIconEvent::Click`,
/// so the popup would never be shown — skip creating the WebKitGTK process.
#[cfg(not(target_os = "linux"))]
fn ensure_tray_popup(app: &AppHandle) {
    use tauri::WebviewWindowBuilder;

    // Only create once — subsequent calls are no-ops.
    if app.get_webview_window("tray-menu").is_some() {
        return;
    }

    let _popup = WebviewWindowBuilder::new(app, "tray-menu", tauri::WebviewUrl::App("/tray-menu".into()))
        .title("")
        .inner_size(232.0, 280.0)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .always_on_top(true)
        .accept_first_mouse(true)
        .shadow(false)
        .resizable(false)
        .build();
}

/// Popup dimensions (must match the CSS in TrayMenu.vue + padding).
#[cfg(not(target_os = "linux"))]
const POPUP_WIDTH: f64 = 232.0;
#[cfg(not(target_os = "linux"))]
const POPUP_HEIGHT: f64 = 280.0;

/// Gap between the popup and the cursor to avoid overlapping the icon.
#[cfg(not(target_os = "linux"))]
const POPUP_GAP: f64 = 8.0;

/// Position, show, and focus the custom tray popup window.
///
/// Uses the mouse click coordinates from `TrayIconEvent::Click.position`
/// for reliable cross-platform positioning.  This replaced the previous
/// `tauri-plugin-positioner` approach, which had known DPI and overflow-area
/// offset bugs on Windows.
///
/// Clamping algorithm:
///   - X: center the popup horizontally on the cursor, clamp to screen
///   - Y: place above cursor by default (bottom taskbar).  If the cursor
///         is near the top of the screen (top 1/3), flip below instead.
///
/// Excluded on Linux: same rationale as `ensure_tray_popup`.
#[cfg(not(target_os = "linux"))]
fn show_tray_popup(app: &AppHandle, cursor: PhysicalPosition<f64>) {
    ensure_tray_popup(app);

    let Some(popup) = app.get_webview_window("tray-menu") else {
        return;
    };

    // Resolve the monitor that contains the cursor for screen bounds.
    let (screen_w, screen_h) = popup
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let size = m.size();
            (size.width as f64, size.height as f64)
        })
        .unwrap_or((1920.0, 1080.0));

    // Center popup horizontally on cursor.
    let mut x = cursor.x - POPUP_WIDTH / 2.0;

    // Default: place popup above cursor (typical for bottom taskbar).
    let mut y = cursor.y - POPUP_HEIGHT - POPUP_GAP;

    // If cursor is in the top third of the screen, the taskbar is
    // likely at the top — flip the popup below the cursor instead.
    if cursor.y < screen_h / 3.0 {
        y = cursor.y + POPUP_GAP;
    }

    // Clamp to screen bounds to prevent off-screen overflow.
    x = x.clamp(0.0, (screen_w - POPUP_WIDTH).max(0.0));
    y = y.clamp(0.0, (screen_h - POPUP_HEIGHT).max(0.0));

    let _ = popup.set_position(PhysicalPosition::new(x as i32, y as i32));
    let _ = popup.show();
    let _ = popup.set_focus();
}

pub fn setup_tray(app: &AppHandle) -> Result<TrayMenuState, Box<dyn std::error::Error>> {
    // Create MenuItem references for TrayMenuState (used by update_tray_menu_labels).
    // On macOS/Windows these are NOT attached to a native OS menu — those platforms
    // use the custom Vue popup.  On Linux they are cloned into a native Menu because
    // libappindicator requires a menu for the tray icon to be visible.
    let show_item = MenuItem::with_id(app, "show", "Show Motrix Next", true, None::<&str>)?;
    let new_task_item = MenuItem::with_id(app, "tray-new-task", "New Task", true, None::<&str>)?;
    let resume_all_item =
        MenuItem::with_id(app, "tray-resume-all", "Resume All", true, None::<&str>)?;
    let pause_all_item = MenuItem::with_id(app, "tray-pause-all", "Pause All", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;

    // Clone items before moving into the HashMap — Linux needs the originals
    // for the native menu, while the HashMap is used for dynamic label updates.
    let mut items_map: HashMap<String, MenuItem<tauri::Wry>> = HashMap::new();
    items_map.insert("show".to_string(), show_item.clone());
    items_map.insert("tray-new-task".to_string(), new_task_item.clone());
    items_map.insert("tray-resume-all".to_string(), resume_all_item.clone());
    items_map.insert("tray-pause-all".to_string(), pause_all_item.clone());
    items_map.insert("tray-quit".to_string(), quit_item.clone());

    // Linux: build a native OS menu from the same items.
    // libappindicator requires a menu attached to the tray icon for it to be
    // visible in GNOME and other desktop environments.
    #[cfg(target_os = "linux")]
    let linux_menu = {
        use tauri::menu::{Menu, PredefinedMenuItem};
        Menu::with_items(
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
        )?
    };

    // Popup is created lazily on click via ensure_tray_popup / show_tray_popup.
    // No eager creation at startup — prevents blocking the main window.

    let builder = TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray-icon.png"
        ))?)
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();

            match event {
                // Left-click: show main window (all platforms)
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    #[cfg(target_os = "macos")]
                    {
                        use tauri::ActivationPolicy;
                        let _ = app.set_activation_policy(ActivationPolicy::Regular);
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                // Right-click: show the custom tray popup at cursor position.
                // Excluded on Linux: libappindicator does not emit Click events.
                #[cfg(not(target_os = "linux"))]
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    position,
                    ..
                } => {
                    show_tray_popup(app, position);
                }
                _ => {}
            }
        });

    // Linux: attach native menu and its event handler.
    #[cfg(target_os = "linux")]
    let builder = builder.menu(&linux_menu).on_menu_event(|app, event| {
        match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "tray-new-task" | "tray-resume-all" | "tray-pause-all" => {
                // Emit to frontend — MainLayout.vue handles these via
                // the existing tray-menu-action listener.
                let action = event.id.as_ref().strip_prefix("tray-").unwrap_or(event.id.as_ref());
                let _ = app.emit("tray-menu-action", action);
            }
            "tray-quit" => {
                app.exit(0);
            }
            _ => {}
        }
    });

    let _tray = builder.build(app)?;

    // Pre-create the popup window (hidden) so the WebView pre-loads the SPA.
    // Without this, the first right-click has a multi-second delay while the
    // JS bundle is fetched and compiled.  Subsequent shows are instant.
    // Excluded on Linux: popup is never shown, so skip the WebKitGTK process.
    #[cfg(not(target_os = "linux"))]
    ensure_tray_popup(app);

    Ok(TrayMenuState {
        items: Mutex::new(items_map),
    })
}
