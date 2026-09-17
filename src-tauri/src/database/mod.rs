//! Process-owned SQLite storage. No database lifecycle depends on a WebView.
mod credentials;
mod history;
mod submissions;
use crate::error::AppError;
pub use credentials::HttpAuthCredential;
pub use history::{HistoryPage, HistoryPageInput, HistoryRecord};
use rusqlite::Connection;
use std::{path::Path, sync::Arc};
pub use submissions::SubmissionState;
use tokio::sync::{MappedMutexGuard, Mutex, MutexGuard};

pub const SCHEMA_VERSION: u32 = 4;
// Connection is Send but not Sync; one owner serializes access and transactions.
pub struct Database {
    conn: Mutex<Option<Connection>>,
}
pub struct DatabaseState(pub Arc<Database>);
impl Database {
    pub fn unavailable() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
    pub async fn is_ready(&self) -> bool {
        self.conn.lock().await.is_some()
    }
    pub async fn initialize(&self, path: &Path) -> Result<(), AppError> {
        let mut conn = self.conn.lock().await;
        if conn.is_none() {
            let path = path.to_owned();
            *conn = tokio::task::spawn_blocking(move || Self::open(&path))
                .await
                .map_err(|error| AppError::Database(error.to_string()))??
                .conn
                .into_inner();
        }
        Ok(())
    }
    pub async fn close(&self) {
        self.conn.lock().await.take();
    }
    async fn connection(&self) -> Result<MappedMutexGuard<'_, Connection>, AppError> {
        MutexGuard::try_map(self.conn.lock().await, Option::as_mut)
            .map_err(|_| AppError::Database("Database is unavailable".into()))
    }
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;")?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(AppError::Database("Unsupported database schema".into()));
        }
        let transaction = conn.transaction()?;
        transaction.execute_batch(include_str!("schema.sql"))?;
        transaction.prepare("SELECT gid, added_at, meta FROM download_history LIMIT 0")?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
        Ok(Self {
            conn: Mutex::new(Some(conn)),
        })
    }
    pub async fn schema_version(&self) -> Result<u32, AppError> {
        Ok(self
            .connection()
            .await?
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, AppError> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(include_str!("schema.sql"))?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self {
            conn: Mutex::new(Some(conn)),
        })
    }
}
