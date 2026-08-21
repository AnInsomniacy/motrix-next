//! Runtime configuration cache for Rust-side consumers.
//!
//! Holds a subset of `AppConfig` preferences needed by background services
//! (monitors, scheduler, tray, stat service) so they don't have to read
//! `config.json` on every tick.
//!
//! Refreshed by the frontend via `invoke('refresh_runtime_config')` after
//! any config save operation.

use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::RwLock;

pub const DEFAULT_EXTENSION_API_PORT: u16 = 29110;

/// Subset of `AppConfig` fields consumed by Rust runtime services.
///
/// Field names use `camelCase` via `#[serde(rename_all = "camelCase")]` to
/// match the JSON layout in `config.json`'s `preferences` object.
///
/// Fields are consumed by monitor, scheduler, and stat_service (Tasks 5-7).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    #[serde(default = "default_locale")]
    pub locale: String,
    #[serde(default)]
    pub speed_limit_enabled: bool,
    #[serde(default)]
    pub speed_schedule_enabled: bool,
    #[serde(default = "default_schedule_from")]
    pub speed_schedule_from: String,
    #[serde(default = "default_schedule_to")]
    pub speed_schedule_to: String,
    #[serde(default)]
    pub speed_schedule_days: u8,
    #[serde(default)]
    pub max_overall_download_limit: String,
    #[serde(default)]
    pub max_overall_upload_limit: String,
    #[serde(default)]
    pub tray_speedometer: bool,
    #[cfg(target_os = "macos")]
    #[serde(default = "default_true")]
    pub dock_badge_speed: bool,
    #[cfg(not(target_os = "linux"))]
    #[serde(default)]
    pub show_progress_bar: bool,
    /// Whether to shut down the system after all downloads complete.
    #[serde(default)]
    pub shutdown_when_complete: bool,
    /// Whether to prevent system idle sleep during active downloads.
    /// Uses platform-native power assertions: Windows Power Requests,
    /// macOS IOPMAssertion, and Linux systemd Inhibit.
    #[serde(default)]
    pub keep_awake: bool,
    /// Whether task lifecycle events should trigger native system notifications.
    #[serde(default = "default_true")]
    pub task_notification: bool,
    /// Whether completed downloads should trigger native system notifications.
    #[serde(default = "default_true")]
    pub notify_on_complete: bool,
    /// Whether newly started downloads should trigger native system notifications.
    #[serde(default = "default_true")]
    pub notify_on_start: bool,
    /// Port for the embedded HTTP API (browser extension communication).
    #[serde(default = "default_extension_api_port")]
    pub extension_api_port: u16,
    /// Whether local control endpoints may listen on LAN interfaces.
    #[serde(default)]
    pub allow_remote_access: bool,
    /// Optional ffmpeg binary for MPEG-TS HLS remux. Empty means search PATH.
    #[serde(default)]
    pub ffmpeg_binary_path: String,
}

fn default_true() -> bool {
    true
}

fn default_locale() -> String {
    "auto".to_string()
}

fn default_schedule_from() -> String {
    "00:00".to_string()
}

fn default_schedule_to() -> String {
    "06:00".to_string()
}

fn default_extension_api_port() -> u16 {
    DEFAULT_EXTENSION_API_PORT
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            locale: default_locale(),
            speed_limit_enabled: false,
            speed_schedule_enabled: false,
            speed_schedule_from: default_schedule_from(),
            speed_schedule_to: default_schedule_to(),
            speed_schedule_days: 0,
            max_overall_download_limit: String::new(),
            max_overall_upload_limit: String::new(),
            tray_speedometer: false,
            #[cfg(target_os = "macos")]
            dock_badge_speed: true,
            #[cfg(not(target_os = "linux"))]
            show_progress_bar: false,
            shutdown_when_complete: false,
            keep_awake: false,
            task_notification: true,
            notify_on_complete: true,
            notify_on_start: true,
            extension_api_port: default_extension_api_port(),
            allow_remote_access: false,
            ffmpeg_binary_path: String::new(),
        }
    }
}

/// Tauri managed state: holds the live RuntimeConfig behind a `RwLock`.
pub struct RuntimeConfigState(pub Arc<RwLock<RuntimeConfig>>);

impl RuntimeConfigState {
    pub fn new() -> Self {
        Self(Arc::new(RwLock::new(RuntimeConfig::default())))
    }

    /// Replace the entire config from a deserialized JSON value.
    ///
    /// Called when the frontend saves preferences.  Extracts the
    /// `RuntimeConfig` subset from the full `AppConfig` JSON.
    pub async fn refresh_from_json(&self, prefs: &serde_json::Value) -> Result<(), String> {
        let cfg: RuntimeConfig = serde_json::from_value(prefs.clone())
            .map_err(|e| format!("Failed to parse runtime config: {e}"))?;
        *self.0.write().await = cfg;
        log::info!("runtime_config refreshed");
        Ok(())
    }

    /// Read-only snapshot of the current config.
    pub async fn snapshot(&self) -> RuntimeConfig {
        self.0.read().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Default values ──────────────────────────────────────────────

    #[test]
    fn default_config_has_sane_values() {
        let cfg = RuntimeConfig::default();
        assert!(!cfg.speed_limit_enabled);
        assert_eq!(cfg.locale, "auto");
        assert!(!cfg.speed_schedule_enabled);
        assert_eq!(cfg.speed_schedule_from, "00:00");
        assert_eq!(cfg.speed_schedule_to, "06:00");
        assert_eq!(cfg.speed_schedule_days, 0);
        assert!(cfg.max_overall_download_limit.is_empty());
        assert!(cfg.max_overall_upload_limit.is_empty());
        assert!(!cfg.tray_speedometer); // default OFF
        #[cfg(target_os = "macos")]
        assert!(cfg.dock_badge_speed); // default ON
        #[cfg(not(target_os = "linux"))]
        assert!(!cfg.show_progress_bar);
        assert!(!cfg.shutdown_when_complete); // default OFF — opt-in only
        assert!(!cfg.keep_awake); // default OFF — opt-in only
        assert!(cfg.task_notification); // default ON
        assert!(cfg.notify_on_complete); // default ON
        assert!(cfg.notify_on_start); // default ON
        assert!(!cfg.allow_remote_access); // default OFF
        assert!(cfg.ffmpeg_binary_path.is_empty());
    }

    // ── Deserialization from AppConfig-shaped JSON ───────────────────

    #[test]
    fn deserialize_full_appconfig_json_extracts_runtime_fields() {
        let json = serde_json::json!({
            "speedLimitEnabled": true,
            "locale": "zh-CN",
            "speedScheduleEnabled": true,
            "speedScheduleFrom": "22:00",
            "speedScheduleTo": "08:00",
            "speedScheduleDays": 31,
            "maxOverallDownloadLimit": "1M",
            "maxOverallUploadLimit": "512K",
            "taskNotification": false,
            "notifyOnComplete": false,
            "notifyOnStart": false,
            "traySpeedometer": true,
            "dockBadgeSpeed": false,
            "showProgressBar": true,
            "shutdownWhenComplete": true,
            "keepAwake": true,
            "allowRemoteAccess": true,
            // Extra fields from AppConfig that RuntimeConfig ignores:
            "theme": "dark",
            "dir": "/downloads",
            "split": 16,
            "rpcListenPort": 29100,
            "rpcSecret": "changeme"
        });

        let cfg: RuntimeConfig = serde_json::from_value(json).expect("deserialize");
        assert!(cfg.speed_limit_enabled);
        assert_eq!(cfg.locale, "zh-CN");
        assert!(cfg.speed_schedule_enabled);
        assert_eq!(cfg.speed_schedule_from, "22:00");
        assert_eq!(cfg.speed_schedule_to, "08:00");
        assert_eq!(cfg.speed_schedule_days, 31);
        assert_eq!(cfg.max_overall_download_limit, "1M");
        assert_eq!(cfg.max_overall_upload_limit, "512K");
        assert!(cfg.tray_speedometer);
        #[cfg(target_os = "macos")]
        assert!(!cfg.dock_badge_speed);
        #[cfg(not(target_os = "linux"))]
        assert!(cfg.show_progress_bar);
        assert!(cfg.shutdown_when_complete);
        assert!(cfg.keep_awake);
        assert!(cfg.allow_remote_access);
        assert!(!cfg.task_notification);
        assert!(!cfg.notify_on_complete);
        assert!(!cfg.notify_on_start);
    }

    #[test]
    fn deserialize_shutdown_when_complete_defaults_to_false() {
        let json = serde_json::json!({ "speedLimitEnabled": true });
        let cfg: RuntimeConfig = serde_json::from_value(json).expect("deserialize");
        assert!(!cfg.shutdown_when_complete);
    }

    #[test]
    fn deserialize_empty_json_uses_defaults() {
        let json = serde_json::json!({});
        let cfg: RuntimeConfig = serde_json::from_value(json).expect("deserialize");
        assert!(!cfg.speed_limit_enabled);
        #[cfg(target_os = "macos")]
        assert!(cfg.dock_badge_speed); // default true
        assert_eq!(cfg.speed_schedule_from, "00:00");
        assert_eq!(cfg.speed_schedule_to, "06:00");
        assert_eq!(cfg.ffmpeg_binary_path, "");
    }

    #[test]
    fn ffmpeg_binary_path_deserializes_camel_case() {
        let json = serde_json::json!({ "ffmpegBinaryPath": r"C:\Tools\ffmpeg.exe" });
        let cfg: RuntimeConfig = serde_json::from_value(json).expect("deserialize");
        assert_eq!(cfg.ffmpeg_binary_path, r"C:\Tools\ffmpeg.exe");
    }

    #[test]
    fn deserialize_ignores_unknown_fields() {
        let json = serde_json::json!({
            "speedLimitEnabled": true,
            "unknownField": "should be ignored",
            "anotherUnknown": 42
        });
        let cfg: RuntimeConfig = serde_json::from_value(json).expect("deserialize");
        assert!(cfg.speed_limit_enabled);
    }

    // ── RuntimeConfigState ──────────────────────────────────────────

    #[tokio::test]
    async fn state_new_creates_default_config() {
        let state = RuntimeConfigState::new();
        let snap = state.snapshot().await;
        assert!(!snap.speed_limit_enabled);
    }

    #[tokio::test]
    async fn refresh_from_json_updates_config() {
        let state = RuntimeConfigState::new();
        let json = serde_json::json!({
            "speedLimitEnabled": true,
            "taskNotification": false,
            "traySpeedometer": true,
            "speedScheduleFrom": "23:00",
            "speedScheduleTo": "07:00"
        });
        state.refresh_from_json(&json).await.expect("refresh");

        let snap = state.snapshot().await;
        assert!(snap.speed_limit_enabled);
        assert!(snap.tray_speedometer);
        assert_eq!(snap.speed_schedule_from, "23:00");
        assert_eq!(snap.speed_schedule_to, "07:00");
    }

    #[tokio::test]
    async fn refresh_from_json_rejects_invalid_json() {
        let state = RuntimeConfigState::new();
        // speedScheduleDays expects u8, not a string
        let json = serde_json::json!({
            "speedScheduleDays": "not_a_number"
        });
        let result = state.refresh_from_json(&json).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Failed to parse"));
    }

    #[tokio::test]
    async fn snapshot_returns_cloned_value() {
        let state = RuntimeConfigState::new();
        let snap1 = state.snapshot().await;

        // Mutate via refresh
        let json = serde_json::json!({ "speedLimitEnabled": true });
        state.refresh_from_json(&json).await.expect("refresh");

        // snap1 is a clone, should still be false
        assert!(!snap1.speed_limit_enabled);
        // New snapshot reflects the update
        let snap2 = state.snapshot().await;
        assert!(snap2.speed_limit_enabled);
    }
}
