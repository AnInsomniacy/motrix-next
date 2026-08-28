//! Task lifecycle persistence and active-state monitoring.
//!
//! Aria2 Next WebSocket events drive terminal task processing. A lightweight
//! poll remains for aggregate active state and ED2K sharing transitions.
//!
//! Persists history records to the Rust-side `HistoryDb` directly,
//! ensuring task completion data survives even when the WebView is
//! destroyed in lightweight mode (issue #194).
//!
//! Sends native system notifications from Rust so lightweight mode still
//! notifies when the WebView is destroyed. Also emits Tauri events to the
//! frontend when it is available so the UI can show in-app toasts and run
//! file actions.
//!

use super::notification::send_task_notification;
use crate::aria2::types::Aria2Task;
use crate::error::AppError;
use crate::history::HistoryDbState;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::watch;

/// Default polling interval in milliseconds.
const DEFAULT_INTERVAL_MS: u64 = 2000;

static COMPLETION_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Events emitted to the frontend.
pub mod events {
    pub const TASK_ERROR: &str = "task-monitor:error";
    pub const TASK_COMPLETE: &str = "task-monitor:complete";
    pub const P2P_DOWNLOAD_COMPLETE: &str = "task-monitor:p2p-download-complete";
    pub const TASK_START: &str = "task-monitor:start";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SharingKind {
    Bt,
    Ed2k,
}

impl SharingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bt => "bt",
            Self::Ed2k => "ed2k",
        }
    }
}

/// Snapshot of a single file within a TaskEvent.
///
/// Mirrors the frontend's `HistoryFileSnapshot` type, enabling correct
/// multi-file deletion and folder-opening after history round-trip.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskEventFile {
    pub path: String,
    pub length: String,
    pub selected: String,
    pub uris: Vec<String>,
}

/// Payload for task lifecycle events.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub gid: String,
    pub name: String,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub dir: String,
    pub total_length: String,
    pub completed_length: String,
    pub info_hash: Option<String>,
    pub magnet_link: Option<String>,
    pub sharing_time: Option<String>,
    pub ed2k_link: Option<String>,
    pub ed2k_hash: Option<String>,
    pub is_bt: bool,
    pub is_ed2k: bool,
    pub sharing_kind: Option<&'static str>,
    /// Full file list snapshot — required for correct multi-file BT
    /// history records (deletion, open-folder, stale detection).
    #[serde(skip_serializing)]
    pub files: Vec<TaskEventFile>,
    /// BT tracker announce list — required for magnet link reconstruction
    /// from history records after session restart.
    #[serde(skip_serializing)]
    pub announce_list: Vec<Vec<String>>,
}

impl TaskEvent {
    pub(crate) fn from_aria2(task: &Aria2Task) -> Self {
        let name = Self::extract_name(task);
        let info_hash = task.info_hash.clone().filter(|h| !h.is_empty());
        let is_bt = task.bittorrent.is_some();
        let is_ed2k = task.ed2k.is_some();
        let magnet_link = task
            .bittorrent
            .as_ref()
            .and_then(|bt| bt.magnet_link.clone())
            .filter(|value| !value.is_empty());
        let sharing_time = task
            .bittorrent
            .as_ref()
            .and_then(|bt| bt.finished_time.clone())
            .or_else(|| {
                task.ed2k
                    .as_ref()
                    .and_then(|ed2k| ed2k.sharing_time.clone())
            })
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0)
            .map(|value| value.to_string());
        let ed2k_link = task
            .ed2k
            .as_ref()
            .and_then(|ed2k| ed2k.ed2k_link.clone())
            .filter(|value| !value.is_empty());
        let ed2k_hash = task
            .ed2k
            .as_ref()
            .and_then(|ed2k| ed2k.hash.clone())
            .filter(|value| !value.is_empty());

        let files: Vec<TaskEventFile> = task
            .files
            .iter()
            .map(|f| TaskEventFile {
                path: f.path.clone(),
                length: f.length.clone(),
                selected: f.selected.clone(),
                uris: f.uris.iter().map(|u| u.uri.clone()).collect(),
            })
            .collect();

        let announce_list = task
            .bittorrent
            .as_ref()
            .and_then(|bt| bt.announce_list.clone())
            .unwrap_or_default();

        Self {
            gid: task.gid.clone(),
            name,
            status: task.status.clone(),
            error_code: task.error_code.clone(),
            error_message: task.error_message.clone(),
            dir: task.dir.clone(),
            total_length: task.total_length.clone(),
            completed_length: task.completed_length.clone(),
            info_hash,
            magnet_link,
            sharing_time,
            ed2k_link,
            ed2k_hash,
            is_bt,
            is_ed2k,
            sharing_kind: sharing_kind(task).map(SharingKind::as_str),
            files,
            announce_list,
        }
    }

    /// Best-effort task name extraction matching the TS `getTaskName()`.
    fn extract_name(task: &Aria2Task) -> String {
        // BT: prefer bittorrent.info.name
        if let Some(bt) = &task.bittorrent {
            if let Some(info) = &bt.info {
                if !info.name.is_empty() {
                    return info.name.clone();
                }
            }
        }
        // Fallback: first file's path basename
        if let Some(first) = task.files.first() {
            if !first.path.is_empty() {
                let path = &first.path;
                let sep = path.rfind('/').or_else(|| path.rfind('\\'));
                if let Some(idx) = sep {
                    return crate::commands::net::decode_filename_encoding(&path[idx + 1..]);
                }
                return crate::commands::net::decode_filename_encoding(path);
            }
        }
        "Unknown".to_string()
    }
}

fn is_metadata_task(task: &Aria2Task) -> bool {
    let Some(bt) = task.bittorrent.as_ref() else {
        return false;
    };
    bt.info.is_none() && matches!(bt.state.as_deref(), Some("adding" | "downloadingMetadata"))
}

/// Builds the JSON `meta` field for a history record.
///
/// Produces the structured history metadata consumed by the frontend:
/// ```json
/// {
///   "infoHash": "abc123...",
///   "files": [{"path": "...", "length": "...", "selected": "true", "uris": [...]}],
///   "announceList": [["tracker1..."], ["tracker2..."]]
/// }
/// ```
///
/// This is critical for correct behavior after history round-trip:
/// - `infoHash` → BT deduplication in `mergeHistoryIntoTasks()`
/// - `files`    → multi-file folder detection in `resolveOpenTarget()` / `deleteTaskFiles()`
/// - `announceList` → magnet link reconstruction for restart
///
/// Returns `None` for non-BT tasks with a single file and no mirrors
/// (matches the frontend's compact-omission optimization).
fn build_history_meta_json(event: &TaskEvent) -> Option<String> {
    let mut meta = serde_json::Map::new();

    if let Some(ref hash) = event.info_hash {
        meta.insert(
            "infoHash".to_string(),
            serde_json::Value::String(hash.clone()),
        );
    }
    if let Some(ref magnet_link) = event.magnet_link {
        meta.insert(
            "magnetLink".to_string(),
            serde_json::Value::String(magnet_link.clone()),
        );
    }
    if let Some(ref sharing_time) = event.sharing_time {
        meta.insert(
            "sharingTime".to_string(),
            serde_json::Value::String(sharing_time.clone()),
        );
    }
    if let Some(ref ed2k_link) = event.ed2k_link {
        meta.insert(
            "ed2kLink".to_string(),
            serde_json::Value::String(ed2k_link.clone()),
        );
    }
    if let Some(ref ed2k_hash) = event.ed2k_hash {
        meta.insert(
            "ed2kHash".to_string(),
            serde_json::Value::String(ed2k_hash.clone()),
        );
    }

    if !event.announce_list.is_empty() {
        let al: Vec<serde_json::Value> = event
            .announce_list
            .iter()
            .map(|tier| {
                serde_json::Value::Array(
                    tier.iter()
                        .map(|t| serde_json::Value::String(t.clone()))
                        .collect(),
                )
            })
            .collect();
        meta.insert("announceList".to_string(), serde_json::Value::Array(al));
    }

    // Snapshot trigger: multi-file OR any file with multiple mirror URIs.
    let has_multiple_files = event.files.len() > 1;
    let has_mirrors = event.files.iter().any(|f| f.uris.len() > 1);
    if has_multiple_files || has_mirrors {
        let files: Vec<serde_json::Value> = event
            .files
            .iter()
            .map(|f| {
                serde_json::json!({
                    "path": f.path,
                    "length": f.length,
                    "selected": f.selected,
                    "uris": f.uris,
                })
            })
            .collect();
        meta.insert("files".to_string(), serde_json::Value::Array(files));
    }

    if meta.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&meta).unwrap_or_default())
    }
}

/// Converts a [`TaskEvent`] into a [`HistoryRecord`] for Rust-side DB persistence.
///
/// This enables the task monitor to write history records directly to the database,
/// bypassing the frontend. Critical for lightweight mode where the WebView is
/// destroyed — without this, task completions during headless operation would
/// be silently lost (issue #194 follow-up).
///
/// The resulting record uses `ON CONFLICT(gid) DO UPDATE` when inserted.
#[cfg(test)]
fn build_history_record(event: &TaskEvent, event_name: &str) -> crate::history::HistoryRecord {
    build_history_record_with_added_at(event, event_name, None)
}

pub fn build_history_record_with_added_at(
    event: &TaskEvent,
    event_name: &str,
    added_at: Option<String>,
) -> crate::history::HistoryRecord {
    let status = match event_name {
        events::TASK_COMPLETE | events::P2P_DOWNLOAD_COMPLETE => "complete",
        events::TASK_ERROR => "error",
        _ => "unknown",
    };

    let task_type = if event.is_bt {
        Some("bt".to_string())
    } else if event.is_ed2k {
        Some("ed2k".to_string())
    } else {
        Some("uri".to_string())
    };

    let total_length = event.total_length.parse::<i64>().ok();
    let now = chrono::Utc::now().to_rfc3339();
    let added_at = added_at.unwrap_or_else(|| now.clone());

    // This ensures historyRecordToTask() can reconstruct multi-file BT tasks
    // for deletion, open-folder, and deduplication.
    let meta = build_history_meta_json(event);

    let uri = event
        .files
        .first()
        .and_then(|file| file.uris.first())
        .filter(|uri| !uri.is_empty())
        .cloned();

    crate::history::HistoryRecord {
        id: None,
        gid: event.gid.clone(),
        name: event.name.clone(),
        uri,
        dir: Some(event.dir.clone()),
        total_length,
        status: status.to_string(),
        task_type,
        added_at: Some(added_at),
        created_at: None,
        completed_at: Some(now),
        meta,
    }
}

async fn persist_lifecycle_event(
    app: &tauri::AppHandle,
    event_name: &str,
    payload: &TaskEvent,
) -> Result<(), AppError> {
    let Some(db_state) = app.try_state::<HistoryDbState>() else {
        return Err(AppError::Store(
            "History database is unavailable during lifecycle processing".into(),
        ));
    };
    let db = db_state.0.clone();
    if !db.is_ready().await {
        return Ok(());
    }
    let existing_added_at = db.get_task_birth(&payload.gid).await?;
    let record = build_history_record_with_added_at(payload, event_name, existing_added_at);

    if let Some(info_hash) = payload.info_hash.as_deref() {
        db.remove_by_info_hash(info_hash, Some(&payload.gid))
            .await?;
    }
    if let Some(added_at) = record.added_at.as_deref() {
        db.record_task_birth(&record.gid, added_at).await?;
    }
    db.add_record(&record).await
}

/// Announces a download that has just entered the active state.
///
/// Separate from `process_lifecycle_task` on purpose. A start is
/// notification only: the task has not finished, so it must not be written
/// to the history database, and there is no completion generation to bump.
pub async fn process_download_start(
    app: &tauri::AppHandle,
    task: &Aria2Task,
) -> Result<(), AppError> {
    if is_metadata_task(task) {
        return Ok(());
    }

    let payload = TaskEvent::from_aria2(task);
    let runtime_config = match app.try_state::<super::config::RuntimeConfigState>() {
        Some(state) => state.snapshot().await,
        None => {
            log::warn!("notification:runtime-config-unavailable fallback=defaults");
            super::config::RuntimeConfig::default()
        }
    };
    let webview_alive = app.get_webview_window("main").is_some();
    log::info!(
        target: "task_lifecycle",
        event = events::TASK_START,
        gid = payload.gid.as_str(),
        task_name:% = payload.name,
        webview_alive;
        "task_lifecycle_event"
    );
    send_task_notification(app, events::TASK_START, &payload, &runtime_config);
    Ok(())
}

pub async fn process_lifecycle_task(
    app: &tauri::AppHandle,
    event_name: &str,
    task: &Aria2Task,
    notify: bool,
) -> Result<(), AppError> {
    if is_metadata_task(task) {
        return Ok(());
    }

    let payload = TaskEvent::from_aria2(task);
    if let Err(error) = persist_lifecycle_event(app, event_name, &payload).await {
        log::error!(
            "task_lifecycle:persist-failed gid={} error={error}",
            payload.gid
        );
    }

    if !notify {
        return Ok(());
    }

    if matches!(
        event_name,
        events::TASK_COMPLETE | events::P2P_DOWNLOAD_COMPLETE
    ) {
        COMPLETION_GENERATION.fetch_add(1, Ordering::Relaxed);
    }

    let runtime_config = match app.try_state::<super::config::RuntimeConfigState>() {
        Some(state) => state.snapshot().await,
        None => {
            log::warn!("notification:runtime-config-unavailable fallback=defaults");
            super::config::RuntimeConfig::default()
        }
    };
    let webview_alive = app.get_webview_window("main").is_some();
    log::info!(
        target: "task_lifecycle",
        event = event_name,
        gid = payload.gid.as_str(),
        task_name:% = payload.name,
        webview_alive;
        "task_lifecycle_event"
    );
    if let Err(error) = app.emit(event_name, &payload) {
        log::warn!("task_lifecycle: failed to emit {event_name}: {error}");
    }
    send_task_notification(app, event_name, &payload, &runtime_config).await;
    Ok(())
}

pub async fn reconcile_stopped_tasks(
    app: &tauri::AppHandle,
    aria2: &crate::aria2::client::Aria2Client,
) -> Result<usize, AppError> {
    let Some(db_state) = app.try_state::<HistoryDbState>() else {
        return Err(AppError::Store(
            "History database is unavailable during lifecycle reconciliation".into(),
        ));
    };
    let db = db_state.0.clone();
    if !db.is_ready().await {
        return Ok(0);
    }
    let mut reconciled = 0;

    for task in aria2.tell_all_stopped().await? {
        let event_name = match task.status.as_str() {
            "complete" => events::TASK_COMPLETE,
            "error" if task.error_code.as_deref() != Some("0") => events::TASK_ERROR,
            _ => continue,
        };
        if db.contains_record(&task.gid).await? {
            continue;
        }
        process_lifecycle_task(app, event_name, &task, false).await?;
        reconciled += 1;
    }

    Ok(reconciled)
}

/// Polling fallback for ED2K sharing, which has no dedicated RPC notification.
pub struct Ed2kSharingNotifier {
    notified: HashSet<String>,
    restored: HashSet<String>,
    initial_scan_done: bool,
}

impl Ed2kSharingNotifier {
    pub fn new() -> Self {
        Self {
            notified: HashSet::new(),
            restored: HashSet::new(),
            initial_scan_done: false,
        }
    }

    fn initial_scan_done(&self) -> bool {
        self.initial_scan_done
    }

    pub fn scan(&mut self, tasks: &[Aria2Task]) -> Vec<TaskEvent> {
        let mut events = Vec::new();

        for task in tasks {
            if task.ed2k.is_none() || is_metadata_task(task) {
                continue;
            }

            if !self.initial_scan_done() {
                self.restored.extend(ed2k_sharing_keys(task));
            }

            if sharing_kind(task) == Some(SharingKind::Ed2k) {
                let key = ed2k_sharing_key(task);
                if self.notified.insert(key) && self.initial_scan_done() && !self.is_restored(task)
                {
                    events.push(TaskEvent::from_aria2(task));
                }
            }
        }

        if !self.initial_scan_done() {
            log::debug!(
                "task_monitor: initial ED2K sharing scan suppressed {} pre-existing tasks",
                tasks.len()
            );
        }
        self.initial_scan_done = true;

        events
    }

    fn is_restored(&self, task: &Aria2Task) -> bool {
        ed2k_sharing_keys(task)
            .iter()
            .any(|key| self.restored.contains(key))
    }
}

fn protocol_sharing_kind(task: &Aria2Task) -> Option<SharingKind> {
    if task.bittorrent.is_some() {
        Some(SharingKind::Bt)
    } else if task.ed2k.is_some() {
        Some(SharingKind::Ed2k)
    } else {
        None
    }
}

fn sharing_kind(task: &Aria2Task) -> Option<SharingKind> {
    if task.status != "active" || task.seeder.as_deref() != Some("true") {
        return None;
    }
    protocol_sharing_kind(task)
}

fn ed2k_sharing_key(task: &Aria2Task) -> String {
    task.ed2k
        .as_ref()
        .and_then(|info| info.hash.as_deref())
        .filter(|hash| !hash.is_empty())
        .map(|hash| format!("ed2k:{hash}"))
        .unwrap_or_else(|| format!("ed2k:{}", task.gid))
}

fn ed2k_sharing_keys(task: &Aria2Task) -> Vec<String> {
    let mut keys = vec![format!("ed2k:{}", task.gid)];
    if let Some(hash) = task
        .ed2k
        .as_ref()
        .and_then(|info| info.hash.as_deref())
        .filter(|hash| !hash.is_empty())
    {
        keys.push(format!("ed2k:{hash}"));
    }
    keys
}

/// Handle for controlling the background monitor task.
pub struct TaskMonitorHandle {
    /// Send `true` to stop the monitor.
    stop_tx: watch::Sender<bool>,
}

impl TaskMonitorHandle {
    /// Signal the monitor to stop.
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

/// Spawns the task monitor as a background tokio task.
///
/// Returns a handle that can signal the monitor to stop.
pub fn spawn_task_monitor(
    app: tauri::AppHandle,
    aria2: Arc<crate::aria2::client::Aria2Client>,
) -> TaskMonitorHandle {
    let (stop_tx, stop_rx) = watch::channel(false);

    tokio::spawn(async move {
        monitor_loop(app, aria2, stop_rx).await;
    });

    TaskMonitorHandle { stop_tx }
}

async fn monitor_loop(
    app: tauri::AppHandle,
    aria2: Arc<crate::aria2::client::Aria2Client>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut sharing_notifier = Ed2kSharingNotifier::new();
    let mut completion_generation = COMPLETION_GENERATION.load(Ordering::Relaxed);
    let interval = Duration::from_millis(DEFAULT_INTERVAL_MS);

    // ── Auto-shutdown state ─────────────────────────────────────────
    // Tracks whether active downloads existed during this engine cycle,
    // preventing false triggers on app launch with an empty queue.
    let mut had_active_downloads = false;
    let mut shutdown_triggered = false;

    match aria2.tell_active().await {
        Ok(tasks) => {
            sharing_notifier.scan(&tasks);
        }
        Err(error) => {
            log::debug!("task_monitor: initial tell_active failed: {error}");
            sharing_notifier.scan(&[]);
        }
    }

    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval) => {},
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    log::info!("task_monitor: stopped");
                    return;
                }
            }
        }

        // Active-task polling remains necessary for aggregate state, ED2K
        // sharing detection, and auto-shutdown. Terminal task events arrive
        // through Aria2 Next's native WebSocket notifications.
        let active = match aria2.tell_active().await {
            Ok(tasks) => tasks,
            Err(e) => {
                log::debug!("task_monitor: tell_active failed: {e}");
                continue;
            }
        };

        let sharing_events = sharing_notifier.scan(&active);
        for payload in sharing_events {
            let task = active.iter().find(|task| task.gid == payload.gid);
            if let Some(task) = task {
                if let Err(error) =
                    process_lifecycle_task(&app, events::P2P_DOWNLOAD_COMPLETE, task, true).await
                {
                    log::warn!(
                        "task_monitor: ED2K sharing lifecycle failed gid={}: {error}",
                        task.gid
                    );
                }
            }
        }
        let current_completion_generation = COMPLETION_GENERATION.load(Ordering::Relaxed);
        let has_new_completion = current_completion_generation != completion_generation;
        completion_generation = current_completion_generation;

        // ── Auto-shutdown detection ─────────────────────────────────
        // Active-download tracking runs unconditionally so that
        // `shutdown_triggered` can reset when new downloads appear
        // after a previous trigger (cancelled or completed).
        {
            let active_dl = count_active_downloads(&active);
            let waiting: usize = aria2.tell_waiting(0, 1).await.map(|w| w.len()).unwrap_or(0);

            if active_dl > 0 || waiting > 0 {
                had_active_downloads = true;
                // New downloads appeared — allow re-detection.
                shutdown_triggered = false;
            }

            // A new completion event means a task went through its full lifecycle
            // (waiting → active → complete) even if we never observed it as active
            // in the 2s poll window (instant download). Treat this as equivalent to
            // "had active downloads" and allow re-triggering.
            if shutdown_triggered && has_new_completion {
                shutdown_triggered = false;
            }

            if has_new_completion {
                had_active_downloads = true;
            }

            if !shutdown_triggered && had_active_downloads && active_dl == 0 && waiting == 0 {
                let should_shutdown = app
                    .try_state::<super::config::RuntimeConfigState>()
                    .map(|rc| rc.0.try_read().is_ok_and(|cfg| cfg.shutdown_when_complete))
                    .unwrap_or(false);

                if should_shutdown {
                    shutdown_triggered = true;
                    log::info!("task_monitor: all downloads complete, shutdown requested");

                    // Reset the cancel flag for this new shutdown sequence.
                    // Previous cancellations must not suppress this trigger.
                    if let Some(cancel) = app
                        .try_state::<std::sync::Arc<crate::commands::power::ShutdownCancelState>>()
                    {
                        cancel.reset();
                    }

                    // Notify frontend to show 60s countdown dialog.
                    let _ = app.emit("power:countdown", ());

                    // Lightweight-mode safety net: if the WebView is destroyed,
                    // the frontend can't show a countdown or invoke the command.
                    // Wait 70s (> 60s frontend countdown) then execute directly.
                    let app_clone = app.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(70)).await;
                        // Check cancel flag — set by frontend's cancel_shutdown command
                        let was_cancelled = app_clone
                            .try_state::<std::sync::Arc<crate::commands::power::ShutdownCancelState>>()
                            .map(|s| s.is_cancelled())
                            .unwrap_or(true); // if state missing, assume cancelled (safe default)

                        if !was_cancelled {
                            log::info!("power: lightweight fallback — executing shutdown");
                            if let Err(e) = crate::commands::power::do_shutdown_internal() {
                                log::error!("power: shutdown failed: {e}");
                            }
                        } else {
                            log::info!("power: shutdown cancelled by user");
                        }
                    });
                }
            }
        }
    }
}

/// Counts active downloads, excluding P2P tasks that are only sharing.
fn count_active_downloads(tasks: &[Aria2Task]) -> usize {
    tasks
        .iter()
        .filter(|t| t.status == "active" && sharing_kind(t).is_none())
        .count()
}

/// Managed state wrapper for the monitor handle.
pub struct TaskMonitorState(pub Arc<tokio::sync::Mutex<Option<TaskMonitorHandle>>>);

impl TaskMonitorState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aria2::types::{Aria2BtInfo, Aria2BtName, Aria2Ed2kInfo, Aria2File, Aria2FileUri};

    fn make_task(gid: &str, status: &str) -> Aria2Task {
        Aria2Task {
            gid: gid.to_string(),
            status: status.to_string(),
            total_length: "1024".to_string(),
            completed_length: "1024".to_string(),
            dir: "/tmp".to_string(),
            files: vec![Aria2File {
                index: "1".to_string(),
                path: "/tmp/test.zip".to_string(),
                length: "1024".to_string(),
                completed_length: "1024".to_string(),
                selected: "true".to_string(),
                priority: None,
                uris: vec![],
            }],
            ..Aria2Task::default()
        }
    }

    fn make_bt_task(gid: &str, status: &str, seeder: bool) -> Aria2Task {
        let mut task = make_task(gid, status);
        task.bittorrent = Some(Aria2BtInfo {
            info: Some(Aria2BtName {
                name: "Ubuntu.iso".to_string(),
            }),
            announce_list: Some(vec![vec!["udp://tracker.example.com:6969".to_string()]]),
            magnet_link: Some("magnet:?xt=urn:btih:abcdef1234567890&dn=Ubuntu.iso".to_string()),
            ..Aria2BtInfo::default()
        });
        task.info_hash = Some("abcdef1234567890".to_string());
        task.seeder = Some(seeder.to_string());
        task
    }

    fn make_ed2k_task(gid: &str, status: &str, sharing: bool) -> Aria2Task {
        let mut task = make_task(gid, status);
        task.ed2k = Some(Aria2Ed2kInfo {
            ed2k_link: Some(
                "ed2k://|file|ed2k.bin|1024|31313131313131313131313131313131|/".to_string(),
            ),
            hash: Some("ed2khash".to_string()),
            name: Some("ed2k.bin".to_string()),
            length: Some("1024".to_string()),
            completed_length: Some("1024".to_string()),
            ..Aria2Ed2kInfo::default()
        });
        task.seeder = Some(sharing.to_string());
        task
    }

    /// Multi-file BT task — the scenario that triggered the bug.
    /// BT downloads with multiple files need a `files` snapshot in meta
    /// for correct deletion (single trash call) and folder-opening.
    fn make_multi_file_bt_task(gid: &str) -> Aria2Task {
        Aria2Task {
            gid: gid.to_string(),
            status: "active".to_string(),
            total_length: "2048".to_string(),
            completed_length: "2048".to_string(),
            dir: "/downloads".to_string(),
            files: vec![
                Aria2File {
                    index: "1".to_string(),
                    path: "/downloads/MyTorrent/video.mkv".to_string(),
                    length: "1536".to_string(),
                    completed_length: "1536".to_string(),
                    selected: "true".to_string(),
                    priority: None,
                    uris: vec![],
                },
                Aria2File {
                    index: "2".to_string(),
                    path: "/downloads/MyTorrent/subs.srt".to_string(),
                    length: "512".to_string(),
                    completed_length: "512".to_string(),
                    selected: "true".to_string(),
                    priority: None,
                    uris: vec![],
                },
            ],
            bittorrent: Some(Aria2BtInfo {
                info: Some(Aria2BtName {
                    name: "MyTorrent".to_string(),
                }),
                announce_list: Some(vec![
                    vec!["udp://tracker1.example.com:6969".to_string()],
                    vec!["udp://tracker2.example.com:6969".to_string()],
                ]),
                magnet_link: Some("magnet:?xt=urn:btih:deadbeef&dn=MyTorrent".to_string()),
                mode: Some("multi".to_string()),
                ..Aria2BtInfo::default()
            }),
            info_hash: Some("deadbeef".repeat(5)),
            seeder: Some("true".to_string()),
            ..Aria2Task::default()
        }
    }

    fn make_error_task(gid: &str, code: &str) -> Aria2Task {
        let mut task = make_task(gid, "error");
        task.error_code = Some(code.to_string());
        task.error_message = Some("download failed".to_string());
        task
    }

    #[test]
    fn ed2k_sharing_scan_suppresses_restored_tasks() {
        let mut notifier = Ed2kSharingNotifier::new();
        let task = make_ed2k_task("ed2k-restored", "active", true);

        assert!(notifier.scan(std::slice::from_ref(&task)).is_empty());
        assert!(notifier.scan(&[task]).is_empty());
    }

    #[test]
    fn ed2k_sharing_scan_emits_new_sharing_task_once() {
        let mut notifier = Ed2kSharingNotifier::new();
        notifier.scan(&[]);
        let task = make_ed2k_task("ed2k-new", "active", true);

        let events = notifier.scan(std::slice::from_ref(&task));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].gid, "ed2k-new");
        assert_eq!(events[0].sharing_kind, Some("ed2k"));
        assert!(notifier.scan(&[task]).is_empty());
    }

    #[test]
    fn ed2k_sharing_scan_ignores_bt_tasks() {
        let mut notifier = Ed2kSharingNotifier::new();
        notifier.scan(&[]);

        assert!(notifier
            .scan(&[make_bt_task("bt-native-event", "active", true)])
            .is_empty());
    }

    // ── TaskEvent extraction ────────────────────────────────────────

    #[test]
    fn task_event_extracts_name_from_bt_info() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        assert_eq!(event.name, "Ubuntu.iso");
        assert!(event.is_bt);
        assert_eq!(event.info_hash, Some("abcdef1234567890".to_string()));
    }

    #[test]
    fn task_event_extracts_name_from_file_path() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        assert_eq!(event.name, "test.zip");
        assert!(!event.is_bt);
    }

    #[test]
    fn task_event_decodes_filename_from_file_path() {
        let mut task = make_task("g1", "complete");
        task.files[0].path = "/tmp/r%C3%A9sum%C3%A9.txt".to_string();

        assert_eq!(TaskEvent::from_aria2(&task).name, "résumé.txt");
    }

    #[test]
    fn task_event_handles_empty_files() {
        let mut task = make_task("g1", "complete");
        task.files = vec![];
        let event = TaskEvent::from_aria2(&task);
        assert_eq!(event.name, "Unknown");
    }

    // ── build_history_record unit tests ─────────────────────────────
    //
    // Validates the pure conversion from TaskEvent → HistoryRecord.
    // This function enables Rust-side DB persistence so that history
    // records are written even when the WebView is destroyed in
    // lightweight mode (issue #194 follow-up).

    #[test]
    fn build_history_record_sets_complete_status_for_task_complete() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert_eq!(record.gid, "g1");
        assert_eq!(record.status, "complete");
        assert_eq!(record.name, "test.zip");
        assert!(record.completed_at.is_some());
    }

    #[test]
    fn build_history_record_with_added_at_uses_persisted_task_birth() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record_with_added_at(
            &event,
            events::TASK_COMPLETE,
            Some("2025-01-01T00:00:00Z".to_string()),
        );

        assert_eq!(record.added_at.as_deref(), Some("2025-01-01T00:00:00Z"));
        assert_ne!(record.completed_at, record.added_at);
    }

    #[test]
    fn build_history_record_sets_complete_status_for_bt_complete() {
        let mut task = make_bt_task("g2", "active", true);
        task.bittorrent.as_mut().unwrap().finished_time = Some("3600".to_string());
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        assert_eq!(record.gid, "g2");
        assert_eq!(record.status, "complete");
        assert_eq!(record.name, "Ubuntu.iso");
        assert!(record.completed_at.is_some());

        // Meta must be valid JSON containing infoHash (not a raw hex string)
        let meta_str = record.meta.as_ref().expect("meta should be Some for BT");
        let meta: serde_json::Value =
            serde_json::from_str(meta_str).expect("meta must be valid JSON");
        assert_eq!(meta["infoHash"], "abcdef1234567890");
        assert_eq!(meta["sharingTime"], "3600");
    }

    #[test]
    fn build_history_record_sets_error_status_for_task_error() {
        let task = make_error_task("g3", "5");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_ERROR);

        assert_eq!(record.gid, "g3");
        assert_eq!(record.status, "error");
        assert!(record.completed_at.is_some());
    }

    #[test]
    fn build_history_record_preserves_ed2k_sharing_time() {
        let mut task = make_ed2k_task("ed2k-time", "active", true);
        task.ed2k.as_mut().unwrap().sharing_time = Some("1800".to_string());
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);
        let meta: serde_json::Value =
            serde_json::from_str(record.meta.as_deref().unwrap()).unwrap();

        assert_eq!(meta["sharingTime"], "1800");
    }

    #[test]
    fn build_history_record_populates_dir_and_total_length() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert_eq!(record.dir, Some("/tmp".to_string()));
        assert_eq!(record.total_length, Some(1024));
    }

    #[test]
    fn build_history_record_preserves_primary_uri_for_lightweight_mode_restart() {
        let mut task = make_task("g1", "complete");
        task.files[0].path = "/tmp/ИТОГИ ЛДУ 2026.xlsx".to_string();
        task.files[0].uris = vec![Aria2FileUri {
            uri: "https://mail-attachment.googleusercontent.com/attachment/u/0/".to_string(),
            status: "used".to_string(),
        }];
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert_eq!(
            record.uri.as_deref(),
            Some("https://mail-attachment.googleusercontent.com/attachment/u/0/")
        );
    }

    #[test]
    fn build_history_record_derives_task_type_for_bt() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        assert_eq!(record.task_type, Some("bt".to_string()));
    }

    #[test]
    fn build_history_record_derives_task_type_for_uri() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert_eq!(record.task_type, Some("uri".to_string()));
    }

    #[test]
    fn build_history_record_id_is_none() {
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        // DB auto-assigns the id via AUTOINCREMENT
        assert!(record.id.is_none());
    }

    // ── JSON meta format validation ─────────────────────────────────
    //
    // These tests validate that build_history_record() produces meta in
    // the correct JSON format expected by the frontend's parseHistoryMeta().
    // The old code stored a raw infoHash string, which caused JSON.parse()
    // to fail and all downstream operations to use wrong legacy fallbacks.

    #[test]
    fn bt_meta_is_valid_json_with_info_hash() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        let meta_str = record.meta.as_ref().unwrap();
        let meta: serde_json::Value =
            serde_json::from_str(meta_str).expect("meta must be valid JSON, not a raw hex string");
        assert_eq!(meta["infoHash"], "abcdef1234567890");
        assert!(meta.get("announceList").is_some());
    }

    #[test]
    fn bt_meta_contains_announce_list() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();
        let al = meta["announceList"].as_array().unwrap();
        assert_eq!(al.len(), 1);
        assert_eq!(al[0][0], "udp://tracker.example.com:6969");
    }

    #[test]
    fn bt_meta_contains_engine_magnet_link() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();
        assert_eq!(
            meta["magnetLink"],
            "magnet:?xt=urn:btih:abcdef1234567890&dn=Ubuntu.iso"
        );
    }

    #[test]
    fn ed2k_meta_contains_engine_ed2k_link() {
        let task = make_ed2k_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();
        assert_eq!(
            meta["ed2kLink"],
            "ed2k://|file|ed2k.bin|1024|31313131313131313131313131313131|/"
        );
    }

    #[test]
    fn multi_file_bt_meta_contains_files_snapshot() {
        let task = make_multi_file_bt_task("g1");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();

        // Must have files array with both entries
        let files = meta["files"]
            .as_array()
            .expect("meta.files must exist for multi-file BT");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["path"], "/downloads/MyTorrent/video.mkv");
        assert_eq!(files[1]["path"], "/downloads/MyTorrent/subs.srt");
        assert_eq!(files[0]["length"], "1536");
        assert_eq!(files[0]["selected"], "true");
    }

    #[test]
    fn multi_file_bt_meta_has_announce_list_and_info_hash() {
        let task = make_multi_file_bt_task("g1");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();

        assert_eq!(meta["infoHash"], "deadbeef".repeat(5));
        let al = meta["announceList"].as_array().unwrap();
        assert_eq!(al.len(), 2);
    }

    #[test]
    fn single_file_uri_task_has_no_meta() {
        // Non-BT single-file tasks should have meta = None
        // (matches frontend's compact-omission optimization)
        let task = make_task("g1", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert!(
            record.meta.is_none(),
            "single-file URI tasks should omit meta"
        );
    }

    #[test]
    fn single_file_bt_meta_omits_files_but_has_info_hash() {
        // Single-file BT task: meta should have infoHash but NOT files
        // (files snapshot only needed for multi-file or multi-mirror)
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::P2P_DOWNLOAD_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();
        assert!(meta.get("infoHash").is_some());
        assert!(
            meta.get("files").is_none(),
            "single-file BT should not include files snapshot"
        );
    }

    #[test]
    fn task_event_from_aria2_populates_files_and_announce_list() {
        let task = make_multi_file_bt_task("g1");
        let event = TaskEvent::from_aria2(&task);

        assert_eq!(event.files.len(), 2);
        assert_eq!(event.files[0].path, "/downloads/MyTorrent/video.mkv");
        assert_eq!(event.files[1].path, "/downloads/MyTorrent/subs.srt");
        assert_eq!(event.announce_list.len(), 2);
    }

    // ── count_active_downloads (auto-shutdown) ──────────────────────
    //
    // Validates the pure helper that determines whether any "real"
    // downloads are in progress.  BT tasks that are only sharing
    // (active + seeder=true) must be excluded so they don't block
    // the auto-shutdown trigger.

    #[test]
    fn count_active_downloads_excludes_shared_upload_tasks() {
        let tasks = vec![
            make_task("g1", "active"),
            make_bt_task("g2", "active", true),
            make_ed2k_task("g3", "active", true),
            make_bt_task("g4", "active", false),
        ];
        assert_eq!(count_active_downloads(&tasks), 2);
    }

    #[test]
    fn count_active_downloads_ignores_non_active_statuses() {
        let tasks = vec![
            make_task("g1", "complete"),
            make_task("g2", "paused"),
            make_task("g3", "error"),
            make_task("g4", "waiting"),
            make_task("g5", "removed"),
        ];
        assert_eq!(count_active_downloads(&tasks), 0);
    }

    #[test]
    fn count_active_downloads_empty_list_returns_zero() {
        assert_eq!(count_active_downloads(&[]), 0);
    }

    #[test]
    fn count_active_downloads_all_sharing_tasks_returns_zero() {
        let tasks = vec![
            make_bt_task("g1", "active", true),
            make_ed2k_task("g2", "active", true),
        ];
        assert_eq!(count_active_downloads(&tasks), 0);
    }

    #[test]
    fn count_active_downloads_mixed_sharing_and_paused_sharing() {
        let tasks = vec![
            make_task("g1", "active"),
            make_bt_task("g2", "paused", true),
            make_ed2k_task("g3", "active", true),
        ];
        assert_eq!(count_active_downloads(&tasks), 1);
    }
}
