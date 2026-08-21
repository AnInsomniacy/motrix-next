//! Runtime services orchestration layer.
//!
//! Groups all background services that share the engine lifecycle:
//! - `config` — RuntimeConfig cache (refreshed on engine ready)
//! - `stat` — Global stat polling (download/upload speed)
//! - `speed` — Speed limit scheduler (time-of-day limits)
//! - `monitor` — Task lifecycle monitor (completion/error notifications)
//! - `aria2_events` — WebSocket bridge for immediate aria2 notifications
//!
//! The `on_engine_ready()` function orchestrates post-start initialization:
//! 1. Updates `Aria2Client` credentials to match the just-started engine
//! 2. Refreshes `RuntimeConfig` from the store
//! 3. Syncs global options to aria2 via `changeGlobalOption`
//! 4. Stops old background services and spawns fresh ones

pub mod aria2_events;
pub mod bt_blocklist;
pub mod config;
pub mod deep_link;
pub mod external_input;
pub mod frontend_action;
pub mod http_api;
pub mod monitor;
pub mod notification;
pub mod notification_i18n;
pub mod port_guard;
pub mod power;
pub mod speed;
pub mod stat;

use crate::aria2::client::Aria2State;
use crate::engine::{non_hot_reloadable_keys, supported_engine_keys};
use crate::error::AppError;
use config::RuntimeConfigState;
use port_guard::DEFAULT_RPC_PORT;
use tauri::Manager;
use tauri_plugin_store::StoreExt;

/// Reads the `system.json` store and returns its key-value pairs as a
/// flat `Map<String, String>`, filtered to only hot-reloadable keys.
///
/// `system.json` stores aria2 engine options in kebab-case as a flat
/// JSON object (written by the `save_system_config` command).
fn read_system_options(
    app: &tauri::AppHandle,
) -> Result<serde_json::Map<String, serde_json::Value>, AppError> {
    let store = app
        .store("system.json")
        .map_err(|e| AppError::Store(format!("Failed to open system.json: {e}")))?;

    // system.json stores all keys at the root level
    let mut opts = serde_json::Map::new();
    for key in store.keys() {
        if !supported_engine_keys().contains(key.as_str())
            || non_hot_reloadable_keys().contains(key.as_str())
        {
            continue;
        }
        if let Some(val) = store.get(&key) {
            // aria2 changeGlobalOption expects all values as strings
            let str_val = match &val {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                _ => continue,
            };
            opts.insert(key, serde_json::Value::String(str_val));
        }
    }
    Ok(opts)
}

/// Full post-engine-start orchestration sequence.
///
/// Must be called after the engine sidecar has started and is accepting
/// RPC connections.
///
/// Steps:
/// 1. Update `Aria2Client` credentials from config store
/// 2. Refresh `RuntimeConfigState` from preferences
/// 3. Read `system.json` and push hot-reloadable options to aria2
/// 4. Apply speed limit overrides based on schedule state
/// 5. Stop existing background services (handles restart gracefully)
/// 6. Spawn fresh background services (stat, speed scheduler, task monitor)
pub async fn on_engine_ready(app: &tauri::AppHandle) -> Result<(), AppError> {
    // 1. Update Aria2Client credentials
    let (port, secret) = read_engine_credentials(app)?;
    if let Some(aria2) = app.try_state::<Aria2State>() {
        aria2.0.update_credentials(port, secret).await;
    }

    // 2. Refresh RuntimeConfig
    if let Some(rc_state) = app.try_state::<RuntimeConfigState>() {
        let store = app
            .store("config.json")
            .map_err(|e| AppError::Store(format!("Failed to open config.json: {e}")))?;
        if let Some(prefs) = store.get("preferences") {
            let _ = rc_state.refresh_from_json(&prefs).await;
        }
    }

    // 3. Sync global options
    let mut opts = read_system_options(app)?;

    // 4. Speed limit override
    if let Some(rc_state) = app.try_state::<RuntimeConfigState>() {
        let cfg = rc_state.snapshot().await;
        if !cfg.speed_limit_enabled {
            // Speed limiter OFF → unlimited
            opts.insert(
                "max-overall-download-limit".to_string(),
                serde_json::Value::String("0".to_string()),
            );
            opts.insert(
                "max-overall-upload-limit".to_string(),
                serde_json::Value::String("0".to_string()),
            );
        } else if cfg.speed_schedule_enabled
            && !is_in_scheduled_period(
                &cfg.speed_schedule_from,
                &cfg.speed_schedule_to,
                cfg.speed_schedule_days,
            )
        {
            // Schedule ON but outside period → unlimited
            opts.insert(
                "max-overall-download-limit".to_string(),
                serde_json::Value::String("0".to_string()),
            );
            opts.insert(
                "max-overall-upload-limit".to_string(),
                serde_json::Value::String("0".to_string()),
            );
        }
        // Otherwise: in-period limits from system.json are already correct
    }

    // Push to aria2
    if !opts.is_empty() {
        if let Some(aria2) = app.try_state::<Aria2State>() {
            let count = opts.len();
            aria2.0.change_global_option(opts).await?;
            log::info!("runtime_services: synced {count} global options to aria2");
        }
    } else {
        log::info!("runtime_services: no global options to sync");
    }

    // 5–6. Stop old services, spawn fresh ones.
    // On first start the handles are None; on restart they hold the old handles.
    spawn_background_services(app).await;

    crate::commands::hls::restore_hls_session(app).await;

    Ok(())
}

/// Stops any running background services and spawns fresh ones.
///
/// Safe to call multiple times — idempotent stop + fresh spawn.
async fn spawn_background_services(app: &tauri::AppHandle) {
    use bt_blocklist::{self, BtPeerBlocklistServiceState};
    use monitor::{self, TaskMonitorState};
    use speed::{self, SpeedSchedulerState};
    use stat::{self, StatServiceState};

    let aria2_arc = match app.try_state::<Aria2State>() {
        Some(s) => s.0.clone(),
        None => {
            log::warn!("runtime_services: Aria2State not available, skipping service spawn");
            return;
        }
    };

    // Stop existing services (handles restart scenario)
    if let Some(ss) = app.try_state::<StatServiceState>() {
        let old = {
            let mut guard = ss.0.lock().await;
            guard.take()
        };
        if let Some(old) = old {
            old.stop().await;
            log::debug!("runtime_services: stopped old stat_service");
        }
    }
    if let Some(ss) = app.try_state::<SpeedSchedulerState>() {
        let mut guard = ss.0.lock().await;
        if let Some(old) = guard.take() {
            old.stop();
            log::debug!("runtime_services: stopped old speed_scheduler");
        }
    }
    if let Some(ts) = app.try_state::<TaskMonitorState>() {
        let mut guard = ts.0.lock().await;
        if let Some(old) = guard.take() {
            old.stop();
            log::debug!("runtime_services: stopped old task_monitor");
        }
    }
    if let Some(es) = app.try_state::<aria2_events::Aria2EventState>() {
        let mut guard = es.0.lock().await;
        if let Some(old) = guard.take() {
            old.stop();
            log::debug!("runtime_services: stopped old aria2_event_listener");
        }
    }
    if let Some(bs) = app.try_state::<BtPeerBlocklistServiceState>() {
        let mut guard = bs.0.lock().await;
        if let Some(old) = guard.take() {
            old.stop();
            log::debug!("runtime_services: stopped old bt_peer_blocklist service");
        }
    }

    // Spawn fresh services
    let stat_handle = stat::spawn_stat_service(app.clone(), aria2_arc.clone());
    if let Some(ss) = app.try_state::<StatServiceState>() {
        *ss.0.lock().await = Some(stat_handle);
    }

    let scheduler_handle = speed::spawn_speed_scheduler(app.clone(), aria2_arc.clone());
    if let Some(ss) = app.try_state::<SpeedSchedulerState>() {
        *ss.0.lock().await = Some(scheduler_handle);
    }

    let blocklist_handle =
        bt_blocklist::spawn_bt_peer_blocklist_service(app.clone(), aria2_arc.clone());
    if let Some(bs) = app.try_state::<BtPeerBlocklistServiceState>() {
        *bs.0.lock().await = Some(blocklist_handle);
    }

    let monitor_handle = monitor::spawn_task_monitor(app.clone(), aria2_arc);
    if let Some(ts) = app.try_state::<TaskMonitorState>() {
        *ts.0.lock().await = Some(monitor_handle);
    }

    if let Some(aria2) = app.try_state::<Aria2State>() {
        let event_handle = aria2_events::spawn_aria2_event_listener(app.clone(), aria2.0.clone());
        if let Some(es) = app.try_state::<aria2_events::Aria2EventState>() {
            *es.0.lock().await = Some(event_handle);
        }
    }

    // HTTP API — keep running across engine restarts.  Idempotent: skips
    // if already bound to the correct port and interface. On mismatch the old
    // server is stopped and a new one spawned.
    let desired_port = http_api::read_extension_api_port(app).await;
    let desired_remote_access = http_api::read_extension_api_allow_remote_access(app).await;
    if let Some(api_state) = app.try_state::<http_api::HttpApiState>() {
        let guard = api_state.0.lock().await;
        let current_port = guard.as_ref().map(http_api::HttpApiHandle::port);
        let current_remote_access = guard
            .as_ref()
            .map(http_api::HttpApiHandle::allow_remote_access);
        drop(guard);
        if current_port != Some(desired_port)
            || current_remote_access != Some(desired_remote_access)
        {
            match http_api::restart_on_port(app, desired_port).await {
                Ok(active_port) => {
                    log::info!("runtime_services: HTTP API listening on port {active_port}");
                }
                Err(e) => {
                    log::warn!(
                        "runtime_services: HTTP API bind failed on port {desired_port}: {e}"
                    );
                    port_guard::emit_bind_failed(
                        app,
                        port_guard::PortKind::ExtensionApi,
                        desired_port,
                        port_guard::PortSwitchFailureSource::Startup,
                    );
                }
            }
        }
    }

    log::info!(
        "runtime_services: spawned stat_service + speed_scheduler + task_monitor + bt_peer_blocklist"
    );
}

/// Read engine port and secret from the config store.
fn read_engine_credentials(app: &tauri::AppHandle) -> Result<(u16, String), AppError> {
    let store = app
        .store("config.json")
        .map_err(|e| AppError::Store(format!("Failed to open config.json: {e}")))?;

    let prefs = store.get("preferences");

    let port = prefs
        .as_ref()
        .and_then(|p| {
            p.get("rpcListenPort").and_then(|v| {
                v.as_u64()
                    .map(|n| n as u16)
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
        })
        .unwrap_or(DEFAULT_RPC_PORT);

    let secret = prefs
        .as_ref()
        .and_then(|p| p.get("rpcSecret")?.as_str().map(String::from))
        .unwrap_or_default();

    Ok((port, secret))
}

/// Public wrapper for use by commands that need engine credentials
/// without running the full `on_engine_ready` orchestration.
pub fn read_engine_credentials_from_app(app: &tauri::AppHandle) -> Result<(u16, String), AppError> {
    read_engine_credentials(app)
}

/// Pure function: determines if the current time falls within the scheduled
/// speed-limit period.
///
/// Port of the TypeScript `isInScheduledPeriod` from `useSpeedScheduler.ts`.
///
/// - `from`/`to`: "HH:mm" 24-hour format strings
/// - `days`: bitmask (Mon=1,Tue=2,Wed=4,Thu=8,Fri=16,Sat=32,Sun=64; 0=every day)
pub fn is_in_scheduled_period(from: &str, to: &str, days: u8) -> bool {
    is_in_scheduled_period_at(from, to, days, chrono::Local::now())
}

/// Testable version with injectable "now".
fn is_in_scheduled_period_at(
    from: &str,
    to: &str,
    days: u8,
    now: chrono::DateTime<chrono::Local>,
) -> bool {
    use chrono::{Datelike, NaiveTime, Timelike};

    // Day-of-week check: Mon=1, Tue=2, ..., Sun=64; 0 = every day
    if days != 0 {
        // chrono: Mon=0..Sun=6 → bit position
        let day_bit = 1u8 << now.weekday().num_days_from_monday();
        if days & day_bit == 0 {
            return false;
        }
    }

    let from_time = match NaiveTime::parse_from_str(from, "%H:%M") {
        Ok(v) => v,
        Err(_) => return false,
    };
    let to_time = match NaiveTime::parse_from_str(to, "%H:%M") {
        Ok(v) => v,
        Err(_) => return false,
    };

    let now_minutes = now.hour() * 60 + now.minute();
    let from_minutes = from_time.hour() * 60 + from_time.minute();
    let to_minutes = to_time.hour() * 60 + to_time.minute();

    if from_minutes <= to_minutes {
        // Same-day span: 08:00 → 22:00
        now_minutes >= from_minutes && now_minutes < to_minutes
    } else {
        // Overnight span: 22:00 → 08:00
        now_minutes >= from_minutes || now_minutes < to_minutes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn make_time(hour: u32, minute: u32, weekday_offset: i64) -> chrono::DateTime<chrono::Local> {
        // Create a date at a known weekday offset from a Monday
        // 2025-01-06 is a Monday
        let naive = chrono::NaiveDate::from_ymd_opt(2025, 1, 6 + weekday_offset as u32)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap();
        chrono::Local.from_local_datetime(&naive).single().unwrap()
    }

    // ── Schedule period checks ──────────────────────────────────────

    #[test]
    fn same_day_span_inside() {
        // 08:00 → 22:00, currently 12:00 Monday, every day
        let now = make_time(12, 0, 0);
        assert!(is_in_scheduled_period_at("08:00", "22:00", 0, now));
    }

    #[test]
    fn same_day_span_outside_before() {
        let now = make_time(7, 30, 0);
        assert!(!is_in_scheduled_period_at("08:00", "22:00", 0, now));
    }

    #[test]
    fn same_day_span_outside_after() {
        let now = make_time(22, 30, 0);
        assert!(!is_in_scheduled_period_at("08:00", "22:00", 0, now));
    }

    #[test]
    fn overnight_span_inside_late() {
        // 22:00 → 08:00, currently 23:00
        let now = make_time(23, 0, 0);
        assert!(is_in_scheduled_period_at("22:00", "08:00", 0, now));
    }

    #[test]
    fn overnight_span_inside_early() {
        // 22:00 → 08:00, currently 06:00
        let now = make_time(6, 0, 0);
        assert!(is_in_scheduled_period_at("22:00", "08:00", 0, now));
    }

    #[test]
    fn overnight_span_outside() {
        // 22:00 → 08:00, currently 12:00
        let now = make_time(12, 0, 0);
        assert!(!is_in_scheduled_period_at("22:00", "08:00", 0, now));
    }

    #[test]
    fn boundary_exactly_at_from() {
        let now = make_time(8, 0, 0);
        assert!(is_in_scheduled_period_at("08:00", "22:00", 0, now));
    }

    #[test]
    fn boundary_exactly_at_to() {
        // "to" is exclusive
        let now = make_time(22, 0, 0);
        assert!(!is_in_scheduled_period_at("08:00", "22:00", 0, now));
    }

    // ── Day-of-week filtering ───────────────────────────────────────

    #[test]
    fn weekday_only_on_monday() {
        // Weekdays = 31 (Mon=1+Tue=2+Wed=4+Thu=8+Fri=16)
        let monday = make_time(12, 0, 0); // Monday
        assert!(is_in_scheduled_period_at("08:00", "22:00", 31, monday));
    }

    #[test]
    fn weekday_only_on_saturday() {
        // Weekdays = 31, Saturday offset = 5
        let saturday = make_time(12, 0, 5); // Saturday
        assert!(!is_in_scheduled_period_at("08:00", "22:00", 31, saturday));
    }

    #[test]
    fn weekend_only_on_sunday() {
        // Weekends = 96 (Sat=32+Sun=64)
        let sunday = make_time(12, 0, 6); // Sunday
        assert!(is_in_scheduled_period_at("08:00", "22:00", 96, sunday));
    }

    #[test]
    fn every_day_ignores_bitmask() {
        // days=0 means every day
        let wednesday = make_time(12, 0, 2);
        assert!(is_in_scheduled_period_at("08:00", "22:00", 0, wednesday));
    }

    // ── Invalid input handling ──────────────────────────────────────

    #[test]
    fn invalid_from_returns_false() {
        let now = make_time(12, 0, 0);
        assert!(!is_in_scheduled_period_at("invalid", "22:00", 0, now));
    }

    #[test]
    fn invalid_to_returns_false() {
        let now = make_time(12, 0, 0);
        assert!(!is_in_scheduled_period_at("08:00", "bad", 0, now));
    }

    #[test]
    fn invalid_time_components_return_false() {
        let now = make_time(12, 0, 0);
        assert!(!is_in_scheduled_period_at("00:99", "23:59", 0, now));
        assert!(!is_in_scheduled_period_at("24:00", "23:59", 0, now));
    }

    // ── non_hot_reloadable_keys (shared aria2Options.json) ─────────

    #[test]
    fn non_hot_reloadable_keys_cover_restart_and_startup_only_options() {
        let keys = crate::engine::non_hot_reloadable_keys();
        for key in [
            "rpc-listen-port",
            "allow-remote-access",
            "rpc-secret",
            "dht-listen-port",
            "ed2k-listen-port",
            "ed2k-udp-listen-port",
            "enable-dht",
            "enable-dht6",
            "enable-peer-exchange",
            "bt-enable-lpd",
            "bt-force-encryption",
            "bt-require-crypto",
            "bt-max-peers",
        ] {
            assert!(keys.contains(key), "missing: {key}");
        }
    }

    #[test]
    fn non_hot_reloadable_keys_exclude_hot_reloadable_options() {
        let keys = crate::engine::non_hot_reloadable_keys();
        assert!(!keys.contains("max-overall-download-limit"));
        assert!(!keys.contains("dir"));
        assert!(!keys.contains("split"));
        assert!(!keys.contains("listen-port"));
        assert!(!keys.contains("bt-external-ip"));
        assert!(!keys.contains("bt-external-port"));
    }
}
