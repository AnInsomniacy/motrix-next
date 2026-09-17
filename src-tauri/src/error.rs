use serde::Serialize;

/// Structured error type for all Tauri IPC commands.
///
/// Replaces raw `String` errors to provide typed error categories
/// that frontends can pattern-match on for appropriate user feedback.
///
/// Uses `thiserror` for derive-based `Display` and `Error` implementations,
/// following Tauri's officially recommended error handling pattern.
#[derive(Debug, Serialize, thiserror::Error)]
pub enum AppError {
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Conflict: {0}")]
    Conflict(String),
    #[error("Aria2 RPC error [{code}]: {message}")]
    Rpc {
        code: i64,
        message: String,
        data: Option<serde_json::Value>,
    },
    /// Persistent store read/write failure (user.json, system.json).
    #[error("Store error: {0}")]
    Store(String),
    /// Engine lifecycle error (start, stop, restart of the bundled engine sidecar).
    #[error("Engine error: {0}")]
    Engine(String),
    /// File system I/O error.
    #[error("IO error: {0}")]
    Io(String),
    /// Requested resource not found.
    #[error("Not found: {0}")]
    NotFound(String),
    /// Auto-updater check or install failure.
    #[error("Updater error: {0}")]
    Updater(String),
    /// UPnP port mapping error (discovery, map, unmap).
    #[error("UPnP error: {0}")]
    Upnp(String),
    /// Protocol handler registration/query error.
    #[error("Protocol error: {0}")]
    Protocol(String),
    /// Aria2 JSON-RPC communication error.
    #[error("Aria2 RPC error: {0}")]
    Aria2(String),
    /// Native torrent metainfo inspection failure.
    #[error("Torrent inspection error [{kind}]: {message}")]
    TorrentInspection { kind: String, message: String },
    /// Database read/write error (rusqlite).
    #[error("Database error: {0}")]
    Database(String),
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Store(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Aria2(e.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}
