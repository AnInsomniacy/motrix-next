//! Durable operation identities, independent of the history database and webview.
use super::contracts::{Format, Presentation, Selection, RECEIPT_MS};
use super::error::Error;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Probing,
    Ready,
    Starting,
    Submitted,
    Cancelled,
    Failed,
}
impl State {
    pub fn pending(self) -> bool {
        matches!(self, Self::Probing | Self::Ready)
    }
    pub fn active(self) -> bool {
        self.pending() || self == Self::Starting
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Operation {
    pub id: Uuid,
    pub fingerprint: String,
    pub expires_at: i64,
    pub retain_until: i64,
    pub gid: String,
    pub state: State,
    pub format: Format,
    pub presentation: Option<Presentation>,
    pub selection: Option<Selection>,
    pub submission_id: Option<Uuid>,
    pub error: Option<Error>,
}
impl Operation {
    pub fn new(id: Uuid, fingerprint: String, now: i64, format: Format) -> Self {
        Self {
            id,
            fingerprint,
            expires_at: now + super::contracts::LEASE_MS,
            retain_until: now + RECEIPT_MS,
            gid: new_gid(),
            state: State::Probing,
            format,
            presentation: None,
            selection: None,
            submission_id: None,
            error: None,
        }
    }
    pub fn response(&self) -> serde_json::Value {
        let mut value = serde_json::json!({"id":self.id,"expiresAt":self.expires_at,
            "state":self.state});
        if self.state == State::Starting {
            value["state"] = "submitting".into();
            value["submissionId"] = serde_json::json!(self.submission_id);
        }
        match self.state {
            State::Ready => value["presentation"] = serde_json::json!(self.presentation),
            State::Submitted => {
                value["submissionId"] = serde_json::json!(self.submission_id);
                value["gid"] = self.gid.clone().into();
            }
            State::Failed => {
                value["error"] = serde_json::json!(self.error.unwrap_or(Error::ProbeFailed))
            }
            _ => {}
        }
        value
    }
}
fn new_gid() -> String {
    Uuid::new_v4().simple().to_string()[..16].to_string()
}

#[derive(Clone)]
pub struct Journal(Arc<Mutex<Connection>>);
impl Journal {
    pub async fn open(path: PathBuf) -> Result<Self, Error> {
        tokio::task::spawn_blocking(move || {
            let connection = Connection::open(path).map_err(|_| Error::Unavailable)?;
            connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, retain_until INTEGER NOT NULL, record TEXT NOT NULL);").map_err(|_| Error::Unavailable)?;
            Ok(Self(Arc::new(Mutex::new(connection))))
        }).await.map_err(|_| Error::Unavailable)?
    }
    pub async fn load(&self) -> Result<Vec<Operation>, Error> {
        let journal = self.clone();
        tokio::task::spawn_blocking(move || {
            let db = journal.0.lock().map_err(|_| Error::Unavailable)?;
            let mut query = db
                .prepare("SELECT record FROM operations")
                .map_err(|_| Error::Unavailable)?;
            let rows = query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|_| Error::Unavailable)?;
            let mut records = Vec::new();
            for row in rows {
                records.push(
                    serde_json::from_str(&row.map_err(|_| Error::Unavailable)?)
                        .map_err(|_| Error::Unavailable)?,
                );
            }
            Ok(records)
        })
        .await
        .map_err(|_| Error::Unavailable)?
    }
    pub async fn save(&self, record: &Operation) -> Result<(), Error> {
        let journal = self.clone();
        let record = record.clone();
        tokio::task::spawn_blocking(move || {
            let value = serde_json::to_string(&record).map_err(|_| Error::Unavailable)?;
            journal.0.lock().map_err(|_| Error::Unavailable)?.execute(
                "INSERT INTO operations (id,retain_until,record) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET retain_until=excluded.retain_until,record=excluded.record",
                params![record.id.to_string(), record.retain_until, value]).map_err(|_| Error::Unavailable)?;
            Ok(())
        }).await.map_err(|_| Error::Unavailable)?
    }
    pub async fn delete(&self, id: Uuid) -> Result<(), Error> {
        let journal = self.clone();
        tokio::task::spawn_blocking(move || {
            journal
                .0
                .lock()
                .map_err(|_| Error::Unavailable)?
                .execute("DELETE FROM operations WHERE id=?1", [id.to_string()])
                .map_err(|_| Error::Unavailable)?;
            Ok(())
        })
        .await
        .map_err(|_| Error::Unavailable)?
    }
}
