use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};

use log::kv::{Key, Value, VisitSource};
use serde::{Deserialize, Serialize};

pub(crate) const LOG_SCHEMA_VERSION: u32 = 1;
pub(crate) const MAX_LOG_FILE_SIZE: u64 = 10 * 1024 * 1024;
pub(crate) const MAX_LOG_FILES: usize = 3;
pub(crate) const MOTRIX_LOG_FILE: &str = "motrix-next.log";
pub(crate) const ARIA2_LOG_FILE: &str = "aria2-next.log";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LogSource {
    Motrix,
    Aria2,
}

pub(crate) fn managed_log_source(name: &str) -> Option<LogSource> {
    if name == MOTRIX_LOG_FILE || (name.starts_with("motrix-next_") && name.ends_with(".log")) {
        return Some(LogSource::Motrix);
    }
    if name == ARIA2_LOG_FILE
        || name
            .strip_prefix("aria2-next.")
            .and_then(|value| value.strip_suffix(".log"))
            .is_some_and(|value| {
                !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
            })
    {
        return Some(LogSource::Aria2);
    }
    None
}

pub(crate) fn is_managed_active_log_file(name: &str) -> bool {
    matches!(name, MOTRIX_LOG_FILE | ARIA2_LOG_FILE)
}

pub(crate) fn run_id() -> &'static str {
    static RUN_ID: OnceLock<String> = OnceLock::new();
    RUN_ID.get_or_init(|| {
        let timestamp = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
        format!("{timestamp:x}-{:x}", std::process::id())
    })
}

fn parse_level(value: &str) -> Option<log::LevelFilter> {
    match value {
        "error" => Some(log::LevelFilter::Error),
        "warn" => Some(log::LevelFilter::Warn),
        "info" => Some(log::LevelFilter::Info),
        "debug" => Some(log::LevelFilter::Debug),
        _ => None,
    }
}

fn encode_level(level: log::LevelFilter) -> u8 {
    match level {
        log::LevelFilter::Off => 0,
        log::LevelFilter::Error => 1,
        log::LevelFilter::Warn => 2,
        log::LevelFilter::Info => 3,
        log::LevelFilter::Debug | log::LevelFilter::Trace => 4,
    }
}

fn decode_level(level: u8) -> log::LevelFilter {
    match level {
        0 => log::LevelFilter::Off,
        1 => log::LevelFilter::Error,
        2 => log::LevelFilter::Warn,
        3 => log::LevelFilter::Info,
        _ => log::LevelFilter::Debug,
    }
}

#[derive(Clone)]
pub(crate) struct LogLevelControl(Arc<AtomicU8>);

impl LogLevelControl {
    pub(crate) fn new(level: log::LevelFilter) -> Self {
        Self(Arc::new(AtomicU8::new(encode_level(level))))
    }

    pub(crate) fn set(&self, value: &str) -> Result<log::LevelFilter, String> {
        let level =
            parse_level(value).ok_or_else(|| format!("Invalid Motrix Next log level: {value}"))?;
        self.0.store(encode_level(level), Ordering::Release);
        Ok(level)
    }

    pub(crate) fn level(&self) -> log::LevelFilter {
        decode_level(self.0.load(Ordering::Acquire))
    }

    pub(crate) fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        if metadata.target().starts_with("tao") || metadata.target().starts_with("tracing") {
            return false;
        }
        metadata.level().to_level_filter() <= self.level()
    }
}

#[derive(Default)]
struct FieldCollector(BTreeMap<String, String>);

impl<'kvs> VisitSource<'kvs> for FieldCollector {
    fn visit_pair(&mut self, key: Key<'kvs>, value: Value<'kvs>) -> Result<(), log::kv::Error> {
        self.0.insert(key.to_string(), value.to_string());
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct ApplicationLogRecord {
    timestamp: String,
    level: String,
    source: String,
    target: String,
    run_id: String,
    message: String,
    fields: BTreeMap<String, String>,
}

fn sanitize_line(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '\r' | '\n' => ' ',
            character if character.is_control() => ' ',
            character => character,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(debug_assertions)]
fn terminal_colors_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED
        .get_or_init(|| anstream::stdout().current_choice() == anstream::ColorChoice::AlwaysAnsi)
}

#[cfg(debug_assertions)]
fn level_style(level: &str) -> anstyle::Style {
    use anstyle::AnsiColor;

    match level {
        "ERROR" => AnsiColor::BrightRed.on_default().bold(),
        "WARN" => AnsiColor::BrightYellow.on_default().bold(),
        "INFO" => AnsiColor::BrightCyan.on_default(),
        "DEBUG" | "TRACE" => AnsiColor::BrightBlack.on_default(),
        _ => anstyle::Style::new(),
    }
}

#[cfg(debug_assertions)]
fn compact_target(target: &str) -> &str {
    if target == "motrix_next_lib" {
        "app"
    } else {
        target.strip_prefix("motrix_next_lib::").unwrap_or(target)
    }
}

#[cfg(debug_assertions)]
fn compact_terminal_line(
    level: &str,
    source: &str,
    target: &str,
    message: &str,
    colors: bool,
) -> String {
    let timestamp = chrono::Local::now().format("%H:%M:%S%.3f");
    let level = format!("{level:<5}");
    let level = if colors {
        let style = level_style(level.trim());
        format!("{style}{level}{style:#}")
    } else {
        level
    };
    format!(
        "{timestamp}  {level}  {source:<6}  {target:<24}  {}",
        sanitize_line(message)
    )
}

#[cfg(debug_assertions)]
fn engine_terminal_parts(value: &str) -> (String, String, String) {
    let normalized = sanitize_line(value);
    let Some((position, level, marker)) = [
        ("TRACE", "[trace]"),
        ("DEBUG", "[debug]"),
        ("INFO", "[info]"),
        ("WARN", "[warning]"),
        ("ERROR", "[error]"),
        ("ERROR", "[critical]"),
    ]
    .into_iter()
    .find_map(|(level, marker)| {
        normalized
            .find(marker)
            .map(|position| (position, level, marker))
    }) else {
        return ("INFO".to_string(), "aria2".to_string(), normalized);
    };
    let mut message = normalized[position + marker.len()..].trim();
    let mut target = "aria2";
    if let Some(rest) = message.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            target = &rest[..end];
            message = rest[end + 1..].trim();
        }
    }
    (level.to_string(), target.to_string(), message.to_string())
}

#[cfg(debug_assertions)]
pub(crate) fn format_engine_terminal_record(value: &str) -> String {
    let (level, target, message) = engine_terminal_parts(value);
    compact_terminal_line(
        &level,
        "ENGINE",
        &target,
        &message,
        terminal_colors_enabled(),
    )
}

#[cfg(debug_assertions)]
pub(crate) fn format_terminal_record(
    message: &std::fmt::Arguments<'_>,
    record: &log::Record<'_>,
) -> String {
    let formatted = message.to_string();
    let Ok(entry) = serde_json::from_str::<ApplicationLogRecord>(&formatted) else {
        return compact_terminal_line(
            record.level().as_str(),
            "APP",
            compact_target(record.target()),
            &formatted,
            terminal_colors_enabled(),
        );
    };
    let source = if entry.source == "webview" {
        "UI"
    } else {
        "APP"
    };
    let mut body = entry.message;
    for (key, value) in entry.fields {
        if key == "event" && value == body {
            continue;
        }
        body.push(' ');
        body.push_str(&key);
        body.push('=');
        body.push_str(&value);
    }
    compact_terminal_line(
        &entry.level,
        source,
        compact_target(&entry.target),
        &body,
        terminal_colors_enabled(),
    )
}

pub(crate) fn format_record(
    _formatted_message: &std::fmt::Arguments<'_>,
    record: &log::Record<'_>,
) -> String {
    let mut fields = FieldCollector::default();
    let _ = record.key_values().visit(&mut fields);
    let source = if record
        .target()
        .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
    {
        "webview"
    } else {
        "motrix"
    };
    let target = fields
        .0
        .remove("target")
        .unwrap_or_else(|| record.target().to_string());
    serde_json::to_string(&ApplicationLogRecord {
        timestamp: chrono::Local::now()
            .format("%Y-%m-%dT%H:%M:%S%.6f%:z")
            .to_string(),
        level: record.level().as_str().to_string(),
        source: source.to_string(),
        target,
        run_id: run_id().to_string(),
        message: sanitize_line(&record.args().to_string()),
        fields: fields.0,
    })
    .unwrap_or_else(|error| {
        serde_json::json!({
            "level": "ERROR",
            "source": "motrix",
            "target": "logger",
            "message": format!("serialization failed: {error}"),
        })
        .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_log_source_accepts_current_and_rotated_files() {
        assert_eq!(
            managed_log_source("motrix-next.log"),
            Some(LogSource::Motrix)
        );
        assert_eq!(
            managed_log_source("motrix-next_2026-08-27_12-00-00.log"),
            Some(LogSource::Motrix)
        );
        assert_eq!(
            managed_log_source("aria2-next.2.log"),
            Some(LogSource::Aria2)
        );
        assert_eq!(managed_log_source("unrelated.log"), None);
    }

    #[test]
    fn dynamic_level_control_applies_immediately() {
        let control = LogLevelControl::new(log::LevelFilter::Warn);
        let debug = log::Metadata::builder()
            .level(log::Level::Debug)
            .target("app")
            .build();
        assert!(!control.enabled(&debug));
        control.set("debug").expect("valid level");
        assert!(control.enabled(&debug));
    }

    #[test]
    fn file_and_terminal_formats_preserve_structured_fields() {
        let key_values =
            std::collections::HashMap::from([("target", "TaskOps.resumeTask"), ("gid", "abc123")]);
        let record = log::Record::builder()
            .args(format_args!("app_started"))
            .level(log::Level::Info)
            .target("lifecycle")
            .key_values(&key_values)
            .build();
        let serialized = format_record(
            &format_args!("app_started event=app_started version=1.0.0"),
            &record,
        );
        #[cfg(debug_assertions)]
        {
            let terminal = format_terminal_record(&format_args!("{serialized}"), &record);
            assert!(terminal.contains("TaskOps.resumeTask"), "{terminal}");
            assert!(terminal.contains("gid=abc123"), "{terminal}");
        }
        let output: ApplicationLogRecord = serde_json::from_str(&serialized).expect("JSON log");
        assert_eq!(output.message, "app_started");
        assert_eq!(output.target, "TaskOps.resumeTask");
        assert_eq!(output.fields.get("gid").map(String::as_str), Some("abc123"));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn terminal_format_is_compact_for_application_and_engine_records() {
        let application = compact_terminal_line(
            "INFO",
            "APP",
            "TaskOps.pauseAllTask",
            "forcePauseAll completed",
            false,
        );
        assert!(application.contains("INFO   APP     TaskOps.pauseAllTask"));
        assert!(!application.contains("source="));
        assert!(!application.contains("run_id="));

        let (level, target, message) =
            engine_terminal_parts("08/27 13:28:17 [info] Download GID#abc paused");
        assert_eq!(
            (level.as_str(), target.as_str(), message.as_str()),
            ("INFO", "aria2", "Download GID#abc paused")
        );
    }
}
