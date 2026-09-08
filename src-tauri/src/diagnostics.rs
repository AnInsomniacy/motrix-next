use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::Manager;

use crate::aria2::client::Aria2State;
use crate::engine::supervisor::EngineSupervisor;
use crate::error::AppError;
use crate::log_policy::{managed_log_source, LogSource};

pub(crate) struct DiagnosticLogs {
    pub motrix: Vec<u8>,
    pub aria2: Vec<u8>,
}

fn append_file(output: &mut Vec<u8>, path: &Path) -> Result<(), AppError> {
    let content = std::fs::read(path)
        .map_err(|error| AppError::Io(format!("Failed to read {}: {error}", path.display())))?;
    if content.is_empty() {
        return Ok(());
    }
    if !output.is_empty() && !output.ends_with(b"\n") {
        output.push(b'\n');
    }
    output.extend_from_slice(&content);
    Ok(())
}

pub(crate) fn collect_logs(log_dir: &Path) -> Result<DiagnosticLogs, AppError> {
    let mut files: Vec<(PathBuf, LogSource)> = std::fs::read_dir(log_dir)
        .map_err(|error| AppError::Io(format!("Failed to read log directory: {error}")))?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let name = path.file_name()?.to_str()?;
            let source = managed_log_source(name)?;
            Some((path, source))
        })
        .collect();
    files.sort_by(|(left, _), (right, _)| {
        let modified = |path: &Path| {
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        };
        modified(left)
            .cmp(&modified(right))
            .then_with(|| left.file_name().cmp(&right.file_name()))
    });

    let mut logs = DiagnosticLogs {
        motrix: Vec::new(),
        aria2: Vec::new(),
    };
    for (path, source) in files {
        match source {
            LogSource::Motrix => append_file(&mut logs.motrix, &path)?,
            LogSource::Aria2 => append_file(&mut logs.aria2, &path)?,
        }
    }
    Ok(logs)
}

fn redact_url(value: &str) -> String {
    let Ok(mut url) = url::Url::parse(value) else {
        return value.to_string();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn sanitize_value(key: &str, value: &Value) -> Value {
    let normalized = key.to_ascii_lowercase();
    if [
        "secret",
        "password",
        "passwd",
        "cookie",
        "authorization",
        "username",
        "token",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
    {
        return Value::String("[REDACTED]".to_string());
    }
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(child_key, child)| (child_key.clone(), sanitize_value(child_key, child)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|child| sanitize_value(key, child))
                .collect(),
        ),
        Value::String(value) => {
            if value.contains("://") {
                Value::String(redact_url(value))
            } else if normalized.contains("dir") || normalized.contains("path") {
                let home = dirs::home_dir()
                    .and_then(|path| path.to_str().map(ToString::to_string))
                    .unwrap_or_default();
                Value::String(value.replacen(&home, "~", 1))
            } else {
                Value::String(value.clone())
            }
        }
        value => value.clone(),
    }
}

pub(crate) fn sanitize_config_snapshot(raw: &Value) -> Value {
    sanitize_value("config", raw)
}

pub(crate) async fn runtime_snapshot(app: &tauri::AppHandle, raw_config: Option<&Value>) -> Value {
    let engine_pid = app
        .try_state::<crate::engine::EngineState>()
        .and_then(|state| {
            state.child.lock().ok().and_then(|child| {
                child
                    .as_ref()
                    .map(tauri_plugin_shell::process::CommandChild::pid)
            })
        });
    let supervisor = app
        .try_state::<EngineSupervisor>()
        .map(|state| state.snapshot());
    let (engine_version, global_stat, bt_session) =
        if let Some(state) = app.try_state::<Aria2State>() {
            let version =
                tokio::time::timeout(std::time::Duration::from_secs(2), state.0.get_version())
                    .await
                    .ok()
                    .and_then(Result::ok);
            let global =
                tokio::time::timeout(std::time::Duration::from_secs(2), state.0.get_global_stat())
                    .await
                    .ok()
                    .and_then(Result::ok);
            let bt = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                state.0.get_bt_session_status(),
            )
            .await
            .ok()
            .and_then(Result::ok);
            (version, global, bt)
        } else {
            (None, None, None)
        };
    let preferences = raw_config.and_then(|value| value.get("preferences"));
    let native_messaging = crate::native_messaging::diagnostic_snapshot(app).await;
    serde_json::json!({
        "schema_version": crate::log_policy::LOG_SCHEMA_VERSION,
        "exported_at": chrono::Local::now().to_rfc3339(),
        "run_id": crate::log_policy::run_id(),
        "application": {
            "name": app.package_info().name,
            "version": app.package_info().version.to_string(),
            "os": std::env::consts::OS,
            "os_version": os_info::get().version().to_string(),
            "arch": std::env::consts::ARCH,
            "locale": sys_locale::get_locale().unwrap_or_default(),
            "log_level": app.try_state::<crate::log_policy::LogLevelControl>()
                .map(|state| state.level().to_string())
                .unwrap_or_else(|| crate::read_log_level().to_string()),
        },
        "engine": {
            "pid": engine_pid,
            "log_level": preferences.and_then(|value| value.get("aria2LogLevel")).and_then(Value::as_str),
            "version": engine_version,
            "global_stat": global_stat,
            "bt_session": bt_session,
            "supervisor": supervisor,
        },
        "rendering": {
            "webkit_dmabuf_disabled": std::env::var(crate::gpu_guard::WEBKIT_DISABLE_DMABUF_RENDERER).unwrap_or_default(),
            "webkit_compositing_disabled": std::env::var(crate::gpu_guard::WEBKIT_DISABLE_COMPOSITING_MODE).unwrap_or_default(),
            "hardware_acceleration_enabled": crate::gpu_guard::is_hardware_rendering_enabled(),
            "xdg_session_type": std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
        },
        "configuration": raw_config.map(sanitize_config_snapshot),
        "native_messaging": native_messaging,
    })
}

pub(crate) fn write_archive(
    output: &Path,
    logs: &DiagnosticLogs,
    diagnostics: &Value,
) -> Result<(), AppError> {
    use std::io::Write;

    let file = std::fs::File::create(output)
        .map_err(|error| AppError::Io(format!("Failed to create archive: {error}")))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let diagnostics = serde_json::to_vec_pretty(diagnostics)
        .map_err(|error| AppError::Io(format!("Failed to serialize diagnostics: {error}")))?;

    for (name, content) in [
        ("diagnostics.json", diagnostics.as_slice()),
        ("logs/motrix-next.log", logs.motrix.as_slice()),
        ("logs/aria2-next.log", logs.aria2.as_slice()),
    ] {
        archive
            .start_file(name, options)
            .map_err(|error| AppError::Io(format!("Failed to add {name}: {error}")))?;
        archive
            .write_all(content)
            .map_err(|error| AppError::Io(format!("Failed to write {name}: {error}")))?;
    }

    archive
        .finish()
        .map_err(|error| AppError::Io(format!("Failed to finalize archive: {error}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn exports_three_file_diagnostic_bundle() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("motrix-next.log"), "app\n").expect("app log");
        std::fs::write(directory.path().join("aria2-next.log"), "engine\n").expect("engine log");
        let logs = collect_logs(directory.path()).expect("logs");
        let diagnostics = serde_json::json!({
            "configuration": sanitize_config_snapshot(&serde_json::json!({
                "preferences": {"rpcSecret": "private"}
            }))
        });
        let output = directory.path().join("diagnostics.zip");
        write_archive(&output, &logs, &diagnostics).expect("archive");

        let file = std::fs::File::open(output).expect("archive file");
        let mut archive = zip::ZipArchive::new(file).expect("valid zip");
        assert_eq!(archive.len(), 3);
        assert!(archive.by_name("logs/motrix-next.log").is_ok());
        assert!(archive.by_name("logs/aria2-next.log").is_ok());
        let mut snapshot = String::new();
        archive
            .by_name("diagnostics.json")
            .expect("diagnostics")
            .read_to_string(&mut snapshot)
            .expect("diagnostics text");
        assert!(snapshot.contains("[REDACTED]"));
        assert!(!snapshot.contains("private"));
    }
}
