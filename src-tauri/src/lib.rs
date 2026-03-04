mod engine;
mod menu;
mod tray;
mod commands;

use engine::EngineState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(EngineState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_config,
            commands::save_preference,
            commands::get_system_config,
            commands::save_system_config,
            commands::start_engine_command,
            commands::stop_engine_command,
            commands::restart_engine_command,
            commands::factory_reset,
            commands::update_tray_title,
        ])
        .setup(|app| {
            let handle = app.handle();
            let m = menu::build_menu(handle)?;
            app.set_menu(m)?;
            tray::setup_tray(handle)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
