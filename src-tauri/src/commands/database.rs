//! Deferred database initialization and explicit reset, independent of window creation.

use crate::engine::supervisor::{EngineOperationCause, EngineSupervisor};
use crate::error::AppError;
use crate::history::HistoryDbState;
use std::path::Path;
use tauri::{AppHandle, Manager};

const DATABASE: &str = "sqlite:history.db";

fn inspect(path: &Path) -> Result<(), AppError> {
    if !path.try_exists()? {
        return Ok(());
    }
    // Allow SQLite's native hot-journal recovery without creating another database.
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    let result: String = conn.query_row("PRAGMA integrity_check(1)", [], |row| row.get(0))?;
    if result != "ok" {
        return Err(AppError::Database(result));
    }
    Ok(())
}

/// Recreated WebViews reuse the existing process-level connections.
#[tauri::command]
pub async fn database_prepare(app: AppHandle) -> Result<bool, AppError> {
    if app.state::<HistoryDbState>().0.is_ready().await {
        return Ok(true);
    }
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join("history.db");
    tokio::task::spawn_blocking(move || inspect(&path))
        .await
        .map_err(|e| AppError::Database(e.to_string()))??;
    Ok(false)
}

/// The SQL plugin applies migrations before this connection is opened.
#[tauri::command]
pub async fn database_initialize(app: AppHandle) -> Result<(), AppError> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join("history.db");
    app.state::<HistoryDbState>().0.initialize(&path).await
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
    app.state::<HistoryDbState>().0.close().await;
    let instances = app.state::<tauri_plugin_sql::DbInstances>();
    let mut pools = instances.0.write().await;
    if let Some(tauri_plugin_sql::DbPool::Sqlite(pool)) = pools.remove(DATABASE) {
        pool.close().await;
    }
    tokio::task::spawn_blocking(move || remove_database(&directory))
        .await
        .map_err(|e| AppError::Io(e.to_string()))??;
    log::info!("database:reset complete — restarting");
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspection_rejects_corruption_without_deleting_data() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        inspect(&path).unwrap();
        assert!(!path.exists());
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE download_history (gid TEXT); INSERT INTO download_history VALUES ('saved');").unwrap();
        inspect(&path).unwrap();
        conn.execute_batch("PRAGMA writable_schema=ON; UPDATE sqlite_master SET rootpage=2147483647 WHERE name='download_history'; PRAGMA writable_schema=OFF;").unwrap();
        drop(conn);
        assert!(inspect(&path).is_err());
        assert!(path.exists());
    }

    #[test]
    fn reset_removes_only_database_files_and_reports_failure() {
        let directory = tempfile::tempdir().unwrap();
        for name in [
            "history.db",
            "history.db-wal",
            "history.db-shm",
            "history.db-journal",
            "config.json",
            "download.zip",
        ] {
            std::fs::write(directory.path().join(name), "data").unwrap();
        }
        remove_database(directory.path()).unwrap();
        assert!(directory.path().join("config.json").exists());
        assert!(directory.path().join("download.zip").exists());
        assert!(!directory.path().join("history.db").exists());
        assert!(!directory.path().join("history.db-wal").exists());
        std::fs::create_dir(directory.path().join("history.db-wal")).unwrap();
        assert!(remove_database(directory.path()).is_err());
    }
}
