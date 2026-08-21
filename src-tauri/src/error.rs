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
    /// Database read/write error (rusqlite).
    #[error("Database error: {0}")]
    Database(String),
    /// HLS VOD engine error (playlist, download, merge, remux).
    #[error("HLS error: {0}")]
    Hls(String),
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── Display output ──────────────────────────────────────────────

    #[test]
    fn display_store_error() {
        let e = AppError::Store("connection lost".into());
        assert_eq!(e.to_string(), "Store error: connection lost");
    }

    #[test]
    fn display_engine_error() {
        let e = AppError::Engine("spawn failed".into());
        assert_eq!(e.to_string(), "Engine error: spawn failed");
    }

    #[test]
    fn display_io_error() {
        let e = AppError::Io("file not found".into());
        assert_eq!(e.to_string(), "IO error: file not found");
    }

    #[test]
    fn display_not_found_error() {
        let e = AppError::NotFound("key missing".into());
        assert_eq!(e.to_string(), "Not found: key missing");
    }

    #[test]
    fn display_updater_error() {
        let e = AppError::Updater("network timeout".into());
        assert_eq!(e.to_string(), "Updater error: network timeout");
    }

    #[test]
    fn display_upnp_error() {
        let e = AppError::Upnp("gateway unreachable".into());
        assert_eq!(e.to_string(), "UPnP error: gateway unreachable");
    }

    #[test]
    fn display_protocol_error() {
        let e = AppError::Protocol("unsupported platform".into());
        assert_eq!(e.to_string(), "Protocol error: unsupported platform");
    }

    #[test]
    fn display_hls_error() {
        let e = AppError::Hls("bad playlist".into());
        assert_eq!(e.to_string(), "HLS error: bad playlist");
    }

    // ── From conversions ────────────────────────────────────────────

    #[test]
    fn from_io_error_produces_io_variant() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "missing file");
        let app_err = AppError::from(io_err);
        assert!(matches!(app_err, AppError::Io(_)));
        assert!(
            app_err.to_string().contains("missing file"),
            "expected 'missing file' in '{}'",
            app_err
        );
    }

    #[test]
    fn from_serde_json_error_produces_store_variant() {
        let json_err = serde_json::from_str::<serde_json::Value>("{{invalid}}")
            .expect_err("should fail to parse");
        let app_err = AppError::from(json_err);
        assert!(matches!(app_err, AppError::Store(_)));
    }

    // ── Serialization ───────────────────────────────────────────────

    #[test]
    fn serialize_produces_tagged_enum() {
        let e = AppError::Engine("test failure".into());
        let json = serde_json::to_string(&e).expect("AppError must serialize");
        // serde derives produce externally-tagged enum: {"Variant":"inner"}
        assert_eq!(json, r#"{"Engine":"test failure"}"#);
    }

    #[test]
    fn serialize_all_variants_are_tagged() {
        // Ensure every variant round-trips through serde correctly
        let cases: Vec<(&str, AppError)> = vec![
            ("Store", AppError::Store("s".into())),
            ("Engine", AppError::Engine("e".into())),
            ("Io", AppError::Io("i".into())),
            ("NotFound", AppError::NotFound("n".into())),
            ("Updater", AppError::Updater("u".into())),
            ("Upnp", AppError::Upnp("p".into())),
            ("Protocol", AppError::Protocol("r".into())),
            ("Aria2", AppError::Aria2("a".into())),
            ("Database", AppError::Database("d".into())),
            ("Hls", AppError::Hls("h".into())),
        ];
        for (tag, err) in cases {
            let json = serde_json::to_string(&err).expect("serialize");
            assert!(
                json.starts_with(&format!("{{\"{tag}\"")),
                "variant {tag} serialized as '{json}'"
            );
        }
    }

    // ── Aria2 + Database variants ───────────────────────────────────

    #[test]
    fn display_aria2_error() {
        let e = AppError::Aria2("connection refused".into());
        assert_eq!(e.to_string(), "Aria2 RPC error: connection refused");
    }

    #[test]
    fn display_database_error() {
        let e = AppError::Database("table not found".into());
        assert_eq!(e.to_string(), "Database error: table not found");
    }

    #[test]
    fn from_rusqlite_error_produces_database_variant() {
        let rusqlite_err = rusqlite::Error::InvalidParameterCount(0, 1);
        let app_err = AppError::from(rusqlite_err);
        assert!(matches!(app_err, AppError::Database(_)));
    }
}
