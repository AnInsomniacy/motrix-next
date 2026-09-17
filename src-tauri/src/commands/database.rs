//! Deferred database initialization and explicit reset, independent of window creation.

use crate::database::DatabaseState;
use crate::engine::supervisor::{EngineOperationCause, EngineSupervisor};
use crate::error::AppError;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// Initialize storage in the native process; safe to call from any entry point.
#[tauri::command]
pub async fn database_initialize(app: AppHandle) -> Result<(), AppError> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join("history.db");
    app.state::<DatabaseState>().0.initialize(&path).await
}

fn remove_database(directory: &Path) -> Result<(), AppError> {
    for suffix in ["-wal", "-shm", "-journal", ""] {
        let path = directory.join(format!("history.db{suffix}"));
        match std::fs::remove_file(&path) {
            Ok(()) => log::info!("database:reset removed={}", path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::Io(format!("{}: {error}", path.display()))),
        }
    }
    Ok(())
}

/// Shared by settings and recovery, always after explicit confirmation.
#[tauri::command]
pub async fn database_reset(app: AppHandle) -> Result<(), AppError> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    app.state::<EngineSupervisor>()
        .stop(&app, EngineOperationCause::AppRelaunch, false)
        .await?;
    app.state::<DatabaseState>().0.close().await;
    tokio::task::spawn_blocking(move || remove_database(&directory))
        .await
        .map_err(|e| AppError::Io(e.to_string()))??;
    log::info!("database:reset complete — restarting");
    app.request_restart();
    Ok(())
}

#[tauri::command]
pub async fn database_schema_version(
    state: tauri::State<'_, DatabaseState>,
) -> Result<u32, AppError> {
    state.0.schema_version().await
}
