use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    menu::{Menu, MenuItem, PredefinedMenuItem},
    Manager, AppHandle, Emitter,
};

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "Show Motrix Next", true, None::<&str>)?;
    let new_task_item = MenuItem::with_id(app, "tray-new-task", "New Task", true, None::<&str>)?;
    let resume_all_item = MenuItem::with_id(app, "tray-resume-all", "Resume All", true, None::<&str>)?;
    let pause_all_item = MenuItem::with_id(app, "tray-pause-all", "Pause All", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &separator,
            &new_task_item,
            &resume_all_item,
            &pause_all_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let _tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .icon(app.default_window_icon().unwrap().clone())
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "tray-new-task" => {
                let _ = app.emit("menu-event", "new-task");
            }
            "tray-resume-all" => {
                let _ = app.emit("menu-event", "resume-all");
            }
            "tray-pause-all" => {
                let _ = app.emit("menu-event", "pause-all");
            }
            "tray-quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
