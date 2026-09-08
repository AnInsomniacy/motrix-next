use crate::engine;
use crate::error::AppError;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// Reads the generated engine-option snapshot from `system.json`.
pub(crate) fn read_engine_config_snapshot(app: AppHandle) -> Result<Value, AppError> {
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

/// Replaces the generated engine-option snapshot in `system.json`.
#[tauri::command]
pub fn replace_system_config(app: AppHandle, config: Value) -> Result<(), AppError> {
    let store = app
        .store("system.json")
        .map_err(|e| AppError::Store(e.to_string()))?;
    store.clear();
    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            store.set(key.clone(), value.clone());
        }
    }
    store.save().map_err(|e| AppError::Store(e.to_string()))?;
    log::debug!(
        "config:replace-system keys={}",
        config.as_object().map_or(0, serde_json::Map::len)
    );
    Ok(())
}

#[tauri::command]
pub fn read_settings_backup_file(path: String) -> Result<String, AppError> {
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::Io(format!("Failed to read settings backup: {e}")))
}

#[tauri::command]
pub fn write_settings_backup_file(path: String, content: String) -> Result<(), AppError> {
    std::fs::write(&path, content)
        .map_err(|e| AppError::Io(format!("Failed to write settings backup: {e}")))
}

/// Clears user, system, and preference stores, resetting the app to defaults.
/// Also removes engine runtime state and managed network caches.
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

    engine::clear_engine_runtime_state(&app).map_err(AppError::Io)?;
    crate::commands::bt_blocklist::remove_bt_peer_blocklist_cache(&app)?;
    crate::commands::ed2k::remove_ed2k_bootstrap_cache(&app)?;

    Ok(())
}

/// Returns the managed runtime aria2.conf path.
#[tauri::command]
pub fn get_engine_conf_path(app: AppHandle) -> Result<String, AppError> {
    let conf_path = engine::runtime_config_path(&app).map_err(AppError::Io)?;
    Ok(engine::path_to_safe_string(&conf_path))
}
