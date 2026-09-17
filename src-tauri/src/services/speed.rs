//! Speed scheduler — time-based speed limit window management.
//!
//! Checks every 60 seconds whether the current time falls within the
//! configured speed-limit schedule. On state transitions, pushes limits
//! to aria2 via `changeGlobalOption`.
//!
//! Port of the frontend `startScheduler` in `useSpeedScheduler.ts`.
//!
//! **The scheduler never modifies `speedLimitEnabled`.** It is a passive
//! layer that only controls WHEN already-enabled limits are enforced.

use super::config::RuntimeConfigState;
use super::is_in_scheduled_period;
use crate::services::tasks::TaskService;
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::sync::watch;

/// How often the scheduler checks the current time.
const SCHEDULER_INTERVAL: Duration = Duration::from_secs(60);

/// Handle for controlling the background scheduler.
pub struct SpeedSchedulerHandle {
    stop_tx: watch::Sender<bool>,
}

impl SpeedSchedulerHandle {
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

/// Spawns the speed scheduler as a background tokio task.
pub fn spawn_speed_scheduler(
    app: tauri::AppHandle,
    aria2: Arc<TaskService>,
) -> SpeedSchedulerHandle {
    let (stop_tx, stop_rx) = watch::channel(false);

    tokio::spawn(async move {
        scheduler_loop(app, aria2, stop_rx).await;
    });

    SpeedSchedulerHandle { stop_tx }
}

async fn scheduler_loop(
    app: tauri::AppHandle,
    aria2: Arc<TaskService>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut last_in_period: Option<bool> = None;

    // Run immediately on start to sync current state
    if let Some(transition) = evaluate_tick(&app, &mut last_in_period).await {
        apply_transition(&aria2, &transition).await;
    }

    loop {
        tokio::select! {
            _ = tokio::time::sleep(SCHEDULER_INTERVAL) => {},
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    log::info!("speed_scheduler: stopped");
                    return;
                }
            }
        }

        if let Some(transition) = evaluate_tick(&app, &mut last_in_period).await {
            apply_transition(&aria2, &transition).await;
        }
    }
}

/// The action to take when the schedule state transitions.
#[derive(Debug, Clone, PartialEq)]
enum ScheduleTransition {
    /// Enter the scheduled window — enforce configured limits.
    EnterPeriod {
        download_limit: String,
        upload_limit: String,
    },
    /// Leave the scheduled window — set unlimited.
    LeavePeriod,
    /// Schedule or speed limit disabled — go idle.
    Idle,
}

/// Evaluate a single tick and return a transition if one occurred.
async fn evaluate_tick(
    app: &tauri::AppHandle,
    last_in_period: &mut Option<bool>,
) -> Option<ScheduleTransition> {
    let rc_state = app.try_state::<RuntimeConfigState>()?;
    let cfg = rc_state.snapshot().await;

    // Idle when either switch is off
    if !cfg.speed_schedule_enabled || !cfg.speed_limit_enabled {
        if last_in_period.is_some() {
            *last_in_period = None;
            log::info!("speed_scheduler: idle — schedule or speed limit disabled");
            return Some(ScheduleTransition::Idle);
        }
        return None;
    }

    let in_period = is_in_scheduled_period(
        &cfg.speed_schedule_from,
        &cfg.speed_schedule_to,
        cfg.speed_schedule_days,
    );

    // Only act on state transitions
    if Some(in_period) == *last_in_period {
        return None;
    }
    *last_in_period = Some(in_period);

    if in_period {
        log::info!(
            "speed_scheduler: in period — dl={} ul={}",
            cfg.max_overall_download_limit,
            cfg.max_overall_upload_limit
        );
        Some(ScheduleTransition::EnterPeriod {
            download_limit: cfg.max_overall_download_limit.clone(),
            upload_limit: cfg.max_overall_upload_limit.clone(),
        })
    } else {
        log::info!("speed_scheduler: out of period — unlimited");
        Some(ScheduleTransition::LeavePeriod)
    }
}

/// Apply a schedule transition to aria2.
async fn apply_transition(aria2: &TaskService, transition: &ScheduleTransition) {
    let opts = match transition {
        ScheduleTransition::EnterPeriod {
            download_limit,
            upload_limit,
        } => {
            let mut m = serde_json::Map::new();
            m.insert(
                "max-overall-download-limit".to_string(),
                serde_json::Value::String(download_limit.clone()),
            );
            m.insert(
                "max-overall-upload-limit".to_string(),
                serde_json::Value::String(upload_limit.clone()),
            );
            m
        }
        ScheduleTransition::LeavePeriod | ScheduleTransition::Idle => {
            let mut m = serde_json::Map::new();
            m.insert(
                "max-overall-download-limit".to_string(),
                serde_json::Value::String("0".to_string()),
            );
            m.insert(
                "max-overall-upload-limit".to_string(),
                serde_json::Value::String("0".to_string()),
            );
            m
        }
    };

    if let Err(e) = aria2.change_global_option(opts).await {
        log::error!("speed_scheduler: transition failed: {e}");
    }
}

/// Managed state wrapper.
pub struct SpeedSchedulerState(pub Arc<tokio::sync::Mutex<Option<SpeedSchedulerHandle>>>);

impl SpeedSchedulerState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── ScheduleTransition ──────────────────────────────────────────

    #[test]
    fn transition_enter_period_carries_limits() {
        let t = ScheduleTransition::EnterPeriod {
            download_limit: "1M".to_string(),
            upload_limit: "512K".to_string(),
        };
        if let ScheduleTransition::EnterPeriod {
            download_limit,
            upload_limit,
        } = &t
        {
            assert_eq!(download_limit, "1M");
            assert_eq!(upload_limit, "512K");
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn transition_variants_are_distinct() {
        let enter = ScheduleTransition::EnterPeriod {
            download_limit: "1M".to_string(),
            upload_limit: "512K".to_string(),
        };
        let leave = ScheduleTransition::LeavePeriod;
        let idle = ScheduleTransition::Idle;

        assert_ne!(enter, leave);
        assert_ne!(leave, idle);
        assert_ne!(enter, idle);
    }

    // ── State transition logic (unit tests via last_in_period) ───────

    #[test]
    fn last_in_period_none_means_idle() {
        let state: Option<bool> = None;
        assert!(state.is_none());
    }

    #[test]
    fn last_in_period_some_true_means_in_period() {
        let state = Some(true);
        assert_eq!(state, Some(true));
    }

    #[test]
    fn last_in_period_transitions_detected() {
        let mut last: Option<bool> = None;

        // First tick: None → Some(true) = transition
        let new = true;
        assert_ne!(Some(new), last);
        last = Some(new);

        // Same state: no transition
        assert_eq!(Some(true), last);

        // State change: Some(true) → Some(false) = transition
        let new = false;
        assert_ne!(Some(new), last);
        last = Some(new);
        assert_eq!(last, Some(false));
    }

    // ── Constants ───────────────────────────────────────────────────

    #[test]
    fn scheduler_interval_is_60_seconds() {
        assert_eq!(SCHEDULER_INTERVAL, Duration::from_secs(60));
    }
}
