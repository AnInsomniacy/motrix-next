use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use crate::engine;

#[tauri::command]
pub fn get_app_config(app: AppHandle) -> Result<Value, String> {
    let store = app.store("user.json").map_err(|e| e.to_string())?;
    let entries: serde_json::Map<String, Value> = store
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    Ok(Value::Object(entries))
}

#[tauri::command]
pub fn save_preference(app: AppHandle, config: Value) -> Result<(), String> {
    let store = app.store("user.json").map_err(|e| e.to_string())?;
    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            store.set(key.clone(), value.clone());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_system_config(app: AppHandle) -> Result<Value, String> {
    let store = app.store("system.json").map_err(|e| e.to_string())?;
    let entries: serde_json::Map<String, Value> = store
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    Ok(Value::Object(entries))
}

#[tauri::command]
pub fn save_system_config(app: AppHandle, config: Value) -> Result<(), String> {
    let store = app.store("system.json").map_err(|e| e.to_string())?;
    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            store.set(key.clone(), value.clone());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn start_engine_command(app: AppHandle) -> Result<(), String> {
    let config = get_system_config(app.clone())?;
    engine::start_engine(&app, &config)
}

#[tauri::command]
pub fn stop_engine_command(app: AppHandle) -> Result<(), String> {
    engine::stop_engine(&app)
}

#[tauri::command]
pub fn restart_engine_command(app: AppHandle) -> Result<(), String> {
    let config = get_system_config(app.clone())?;
    engine::restart_engine(&app, &config)
}

#[tauri::command]
pub fn factory_reset(app: AppHandle) -> Result<(), String> {
    let user_store = app.store("user.json").map_err(|e| e.to_string())?;
    user_store.clear();
    let system_store = app.store("system.json").map_err(|e| e.to_string())?;
    system_store.clear();
    Ok(())
}

#[tauri::command]
pub fn update_tray_title(app: AppHandle, title: String) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_title(Some(&title)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
