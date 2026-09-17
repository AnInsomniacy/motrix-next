use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle,
};

pub fn build_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    // ── App menu (first submenu = macOS application menu) ────────────
    //
    // PredefinedMenuItem variants (hide, hide_others, show_all, quit)
    // are auto-localized by macOS — no manual i18n required.
    // "About" uses a custom MenuItem so it routes through on_menu_event
    // to open the in-app AboutPanel instead of the bare native panel.
    let app_menu = Submenu::with_items(
        app,
        "Rayburst",
        true,
        &[
            &MenuItem::with_id(app, "about", "About Rayburst", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "preferences",
                "Preferences...",
                true,
                Some("CmdOrCtrl+,"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // ── File menu ────────────────────────────────────────────────────
    let file_menu = Submenu::with_id_and_items(
        app,
        "file-menu",
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new-task", "New Task", true, Some("CmdOrCtrl+N"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "open-torrent",
                "Open Torrent File...",
                true,
                Some("CmdOrCtrl+O"),
            )?,
        ],
    )?;

    // ── Edit menu ────────────────────────────────────────────────────
    //
    // All items are PredefinedMenuItem — macOS auto-localizes them.
    let edit_menu = Submenu::with_id_and_items(
        app,
        "edit-menu",
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // ── Window menu ──────────────────────────────────────────────────
    //
    // Custom items instead of PredefinedMenuItem variants — the
    // predefined versions call native macOS selectors (miniaturize:,
    // zoom:, performClose:) which are no-ops on frameless windows.
    let window_menu = Submenu::with_id_and_items(
        app,
        "window-menu",
        "Window",
        true,
        &[
            &MenuItem::with_id(
                app,
                "minimize-window",
                "Minimize",
                true,
                Some("CmdOrCtrl+M"),
            )?,
            &MenuItem::with_id(app, "zoom-window", "Zoom", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "close-window",
                "Close Window",
                true,
                Some("CmdOrCtrl+W"),
            )?,
        ],
    )?;

    // ── Help menu ────────────────────────────────────────────────────
    let help_menu = Submenu::with_id_and_items(
        app,
        "help-menu",
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "release-notes", "Release Notes", true, None::<&str>)?,
            &MenuItem::with_id(app, "report-issue", "Report Issue", true, None::<&str>)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &window_menu, &help_menu],
    )?;

    Ok(menu)
}
