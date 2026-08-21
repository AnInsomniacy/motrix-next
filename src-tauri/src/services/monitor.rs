//! Task lifecycle monitor — polls aria2 for status transitions.
//!
//! Runs as a background tokio task, scanning active + stopped slices
//! for new completions, errors, and shared-upload transitions.
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
//! Port of the frontend `createTaskLifecycleService`.

use super::notification::send_task_notification;
use crate::aria2::types::Aria2Task;
use crate::history::HistoryDbState;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::watch;

/// Maximum number of stopped tasks to scan per tick.
const STOPPED_SLICE_LIMIT: i64 = 50;

/// Default polling interval in milliseconds.
const DEFAULT_INTERVAL_MS: u64 = 2000;

/// Events emitted to the frontend.
pub mod events {
    pub const TASK_ERROR: &str = "task-monitor:error";
    pub const TASK_COMPLETE: &str = "task-monitor:complete";
    pub const SHARING_COMPLETE: &str = "task-monitor:sharing-complete";
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

/// HLS fields persisted into `HistoryMeta.hls`.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventHls {
    pub playlist_url: String,
    pub media_kind: String,
    pub output_path: Option<String>,
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
    pub ed2k_link: Option<String>,
    pub is_bt: bool,
    pub is_ed2k: bool,
    #[serde(default)]
    pub is_hls: bool,
    pub sharing_kind: Option<&'static str>,
    /// Full file list snapshot — required for correct multi-file BT
    /// history records (deletion, open-folder, stale detection).
    #[serde(skip_serializing)]
    pub files: Vec<TaskEventFile>,
    /// BT tracker announce list — required for magnet link reconstruction
    /// from history records after session restart.
    #[serde(skip_serializing)]
    pub announce_list: Vec<Vec<String>>,
    /// HLS playlist metadata — used when writing history records.
    #[serde(skip_serializing)]
    pub hls: Option<TaskEventHls>,
}

impl TaskEvent {
    pub fn from_aria2(task: &Aria2Task) -> Self {
        let name = Self::extract_name(task);
        let info_hash = task.info_hash.clone().filter(|h| !h.is_empty());
        let is_bt = task.bittorrent.is_some();
        let is_ed2k = task.ed2k.is_some();
        let is_hls = task.hls.is_some() || task.gid.starts_with("hls-");
        let magnet_link = task
            .bittorrent
            .as_ref()
            .and_then(|bt| bt.magnet_link.clone())
            .filter(|value| !value.is_empty());
        let ed2k_link = task
            .ed2k
            .as_ref()
            .and_then(|ed2k| ed2k.ed2k_link.clone())
            .filter(|value| !value.is_empty());
        let hls = task.hls.as_ref().map(|hls| TaskEventHls {
            playlist_url: hls.playlist_url.clone(),
            media_kind: hls.media_kind.clone(),
            output_path: hls.output_path.clone(),
        });

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
            ed2k_link,
            is_bt,
            is_ed2k,
            is_hls,
            sharing_kind: sharing_kind(task).map(SharingKind::as_str),
            files,
            announce_list,
            hls,
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
                    return path[idx + 1..].to_string();
                }
                return path.clone();
            }
        }
        String::new()
    }
}

fn is_metadata_task(task: &Aria2Task) -> bool {
    task.bittorrent.is_some()
        && task
            .bittorrent
            .as_ref()
            .and_then(|bt| bt.info.as_ref())
            .is_none()
        && task.following.is_none()
}

/// Builds the JSON `meta` field for a history record.
///
/// Produces a JSON object matching the frontend's `buildHistoryMeta()` format:
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
    if let Some(ref ed2k_link) = event.ed2k_link {
        meta.insert(
            "ed2kLink".to_string(),
            serde_json::Value::String(ed2k_link.clone()),
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

    if event.is_hls {
        if let Some(hls) = &event.hls {
            let mut hls_meta = serde_json::Map::new();
            hls_meta.insert(
                "playlistUrl".to_string(),
                serde_json::Value::String(hls.playlist_url.clone()),
            );
            hls_meta.insert(
                "mediaKind".to_string(),
                serde_json::Value::String(hls.media_kind.clone()),
            );
            if let Some(path) = &hls.output_path {
                hls_meta.insert(
                    "outputPath".to_string(),
                    serde_json::Value::String(path.clone()),
                );
            }
            meta.insert("hls".to_string(), serde_json::Value::Object(hls_meta));
        }
    }

    // Snapshot trigger: multi-file OR any file with multiple mirror URIs.
    // Matches the frontend's buildHistoryMeta() condition exactly.
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
/// The resulting record uses `ON CONFLICT(gid) DO UPDATE` when inserted,
/// so duplicate writes from both Rust and frontend are idempotent.
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
        events::TASK_COMPLETE | events::SHARING_COMPLETE => "complete",
        events::TASK_ERROR => "error",
        _ => "unknown",
    };

    let task_type = if event.is_bt {
        Some("bt".to_string())
    } else if event.is_ed2k {
        Some("ed2k".to_string())
    } else if event.is_hls {
        Some("hls".to_string())
    } else {
        Some("uri".to_string())
    };

    let total_length = event.total_length.parse::<i64>().ok();
    let now = chrono::Utc::now().to_rfc3339();
    let added_at = added_at.unwrap_or_else(|| now.clone());

    // Build structured JSON meta matching the frontend's buildHistoryMeta() format.
    // This ensures historyRecordToTask() can correctly reconstruct multi-file BT
    // tasks for deletion, open-folder, and deduplication.
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

fn is_terminal_history_event(event_name: &str) -> bool {
    event_name == events::TASK_COMPLETE
        || event_name == events::SHARING_COMPLETE
        || event_name == events::TASK_ERROR
}

fn persist_history_record(app: &tauri::AppHandle, event_name: &str, event: &TaskEvent) {
    if !is_terminal_history_event(event_name) {
        return;
    }
    let Some(db_state) = app.try_state::<HistoryDbState>() else {
        return;
    };
    let db = db_state.0.clone();
    let payload = event.clone();
    let event_name_owned = event_name.to_string();
    // Spawn a non-blocking write — callers must not block on DB I/O.
    tokio::spawn(async move {
        let existing_added_at = match db.get_task_birth(&payload.gid).await {
            Ok(added_at) => added_at,
            Err(e) => {
                log::warn!("task_monitor: task_birth lookup failed for {event_name_owned}: {e}");
                None
            }
        };
        let record =
            build_history_record_with_added_at(&payload, &event_name_owned, existing_added_at);
        if let Some(added_at) = record.added_at.as_deref() {
            if let Err(e) = db.record_task_birth(&record.gid, added_at).await {
                log::warn!("task_monitor: task_birth write failed for {event_name_owned}: {e}");
            }
        }
        if let Err(e) = db.add_record(&record).await {
            log::warn!("task_monitor: history write failed for {event_name_owned}: {e}");
        }
    });
}

/// Persist a terminal task event to history, send a native notification, and
/// emit the frontend event. Shared by the aria2 monitor loop and HLS `run_job`.
pub async fn persist_and_emit_task_event(
    app: &tauri::AppHandle,
    event_name: &str,
    event: TaskEvent,
) {
    persist_history_record(app, event_name, &event);

    let runtime_config = match app.try_state::<super::config::RuntimeConfigState>() {
        Some(state) => state.snapshot().await,
        None => {
            log::warn!("notification:runtime-config-unavailable fallback=defaults");
            super::config::RuntimeConfig::default()
        }
    };

    let webview_alive = app.get_webview_window("main").is_some();
    log::info!(
        "task_monitor:event type={} gid={} name={:?} webview_alive={}",
        event_name,
        event.gid,
        event.name,
        webview_alive
    );
    send_task_notification(app, event_name, &event, &runtime_config);
    if let Err(e) = app.emit(event_name, &event) {
        log::warn!("task_monitor: failed to emit {event_name}: {e}");
    }
}

/// Internal deduplication state — mirrors `createTaskNotifier()` from TS.
pub struct TaskNotifier {
    notified_errors: HashSet<String>,
    notified_completes: HashSet<String>,
    notified_sharing_completes: HashSet<String>,
    restored_sharing_completes: HashSet<String>,
    scan_count: u8,
}

impl TaskNotifier {
    pub fn new() -> Self {
        Self {
            notified_errors: HashSet::new(),
            notified_completes: HashSet::new(),
            notified_sharing_completes: HashSet::new(),
            restored_sharing_completes: HashSet::new(),
            scan_count: 0,
        }
    }

    fn initial_scan_done(&self) -> bool {
        self.scan_count > 0
    }

    /// Scan tasks and return events that should be emitted.
    ///
    /// Suppresses callbacks during the first scan to avoid ghost
    /// notifications for pre-existing terminal tasks.
    pub fn scan(&mut self, tasks: &[Aria2Task]) -> Vec<(String, TaskEvent)> {
        let mut emit = Vec::new();

        for task in tasks {
            if is_metadata_task(task) {
                continue;
            }

            // Error detection
            if task.status == "error" {
                if let Some(code) = &task.error_code {
                    if code != "0" && !self.notified_errors.contains(&task.gid) {
                        self.notified_errors.insert(task.gid.clone());
                        if self.initial_scan_done() {
                            emit.push((
                                events::TASK_ERROR.to_string(),
                                TaskEvent::from_aria2(task),
                            ));
                        }
                    }
                }
            }

            // Completion detection
            if task.status == "complete" && !self.notified_completes.contains(&task.gid) {
                self.notified_completes.insert(task.gid.clone());
                if self.initial_scan_done() {
                    emit.push((
                        events::TASK_COMPLETE.to_string(),
                        TaskEvent::from_aria2(task),
                    ));
                }
            }

            if !self.initial_scan_done() {
                if let Some(kind) = protocol_sharing_kind(task) {
                    self.restored_sharing_completes
                        .extend(sharing_restore_keys(task, kind));
                }
            }

            if let Some(kind) = sharing_kind(task) {
                let key = sharing_completion_key(task, kind);
                if !self.notified_sharing_completes.contains(&key) {
                    self.notified_sharing_completes.insert(key.clone());
                    if self.initial_scan_done() && !self.is_restored_sharing(task, kind) {
                        emit.push((
                            events::SHARING_COMPLETE.to_string(),
                            TaskEvent::from_aria2(task),
                        ));
                    }
                }
            }
        }

        if !self.initial_scan_done() {
            log::debug!(
                "task_monitor: initial scan suppressed {} pre-existing tasks",
                tasks.len()
            );
        }
        self.scan_count = self.scan_count.saturating_add(1);

        emit
    }

    fn is_restored_sharing(&self, task: &Aria2Task, kind: SharingKind) -> bool {
        sharing_restore_keys(task, kind)
            .iter()
            .any(|key| self.restored_sharing_completes.contains(key))
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

fn sharing_completion_key(task: &Aria2Task, kind: SharingKind) -> String {
    match kind {
        SharingKind::Bt => task
            .info_hash
            .as_deref()
            .filter(|hash| !hash.is_empty())
            .map(|hash| format!("bt:{hash}"))
            .unwrap_or_else(|| format!("bt:{}", task.gid)),
        SharingKind::Ed2k => task
            .ed2k
            .as_ref()
            .and_then(|info| info.hash.as_deref())
            .filter(|hash| !hash.is_empty())
            .map(|hash| format!("ed2k:{hash}"))
            .unwrap_or_else(|| format!("ed2k:{}", task.gid)),
    }
}

fn sharing_restore_keys(task: &Aria2Task, kind: SharingKind) -> Vec<String> {
    let prefix = kind.as_str();
    let mut keys = vec![format!("{prefix}:{}", task.gid)];
    match kind {
        SharingKind::Bt => {
            if let Some(hash) = task.info_hash.as_deref().filter(|hash| !hash.is_empty()) {
                keys.push(format!("bt:{hash}"));
            }
        }
        SharingKind::Ed2k => {
            if let Some(hash) = task
                .ed2k
                .as_ref()
                .and_then(|info| info.hash.as_deref())
                .filter(|hash| !hash.is_empty())
            {
                keys.push(format!("ed2k:{hash}"));
            }
        }
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
    let mut notifier = TaskNotifier::new();
    let interval = Duration::from_millis(DEFAULT_INTERVAL_MS);

    // ── Auto-shutdown state ─────────────────────────────────────────
    // Tracks whether active downloads existed during this engine cycle,
    // preventing false triggers on app launch with an empty queue.
    let mut had_active_downloads = false;
    let mut shutdown_triggered = false;

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

        // Fetch active + stopped tasks
        let active = match aria2.tell_active().await {
            Ok(tasks) => tasks,
            Err(e) => {
                log::debug!("task_monitor: tell_active failed: {e}");
                continue;
            }
        };

        let stopped = match aria2.tell_stopped(0, STOPPED_SLICE_LIMIT).await {
            Ok(tasks) => tasks,
            Err(e) => {
                log::debug!("task_monitor: tell_stopped failed: {e}");
                continue;
            }
        };

        let mut all = active;
        all.extend(stopped);

        let events = notifier.scan(&all);

        // Track whether this cycle produced a new completion event.
        // Used below to reset `shutdown_triggered` for instant downloads
        // that complete within a single poll window.
        let has_new_completion = events
            .iter()
            .any(|(n, _)| n == events::TASK_COMPLETE || n == events::SHARING_COMPLETE);

        if !events.is_empty() {
            for (event_name, payload) in events {
                persist_and_emit_task_event(&app, &event_name, payload).await;
            }
        }

        // ── Auto-shutdown detection ─────────────────────────────────
        // Active-download tracking runs unconditionally so that
        // `shutdown_triggered` can reset when new downloads appear
        // after a previous trigger (cancelled or completed).
        {
            let (hls_active, hls_waiting) =
                match app.try_state::<Arc<crate::hls::engine::HlsEngineState>>() {
                    Some(state) => {
                        let jobs = state.snapshot_jobs().await;
                        (count_hls_active_jobs(&jobs), count_hls_waiting_jobs(&jobs))
                    }
                    None => (0, 0),
                };
            let active_dl = count_active_downloads(&all) + hls_active;
            let waiting: usize =
                aria2.tell_waiting(0, 1).await.map(|w| w.len()).unwrap_or(0) + hls_waiting;

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

fn count_hls_active_jobs(jobs: &[crate::hls::types::HlsJob]) -> usize {
    jobs.iter().filter(|job| job.status == "active").count()
}

fn count_hls_waiting_jobs(jobs: &[crate::hls::types::HlsJob]) -> usize {
    jobs.iter().filter(|job| job.status == "waiting").count()
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
    use crate::aria2::types::{
        Aria2BtInfo, Aria2BtName, Aria2Ed2kInfo, Aria2File, Aria2FileUri, Aria2HlsInfo,
    };

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
        task.seeder = Some(if seeder { "true" } else { "false" }.to_string());
        task
    }

    fn make_bt_task_with_hash(gid: &str, status: &str, seeder: bool, info_hash: &str) -> Aria2Task {
        let mut task = make_bt_task(gid, status, seeder);
        task.info_hash = Some(info_hash.to_string());
        task
    }

    fn make_hls_task(gid: &str, status: &str) -> Aria2Task {
        let mut task = make_task(gid, status);
        task.hls = Some(Aria2HlsInfo {
            playlist_url: "https://cdn.example/a.m3u8".to_string(),
            media_kind: "mpegts".to_string(),
            segment_count: 10,
            segment_total: 10,
            encrypt_method: "none".to_string(),
            phase: "merge".to_string(),
            output_path: Some("/tmp/video.ts".to_string()),
            fallback_ts_path: None,
        });
        task.files[0].path = "/tmp/video.ts".to_string();
        task.files[0].uris = vec![Aria2FileUri {
            uri: "https://cdn.example/a.m3u8".to_string(),
            status: "used".to_string(),
        }];
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
        task.seeder = Some(if sharing { "true" } else { "false" }.to_string());
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
                    uris: vec![],
                },
                Aria2File {
                    index: "2".to_string(),
                    path: "/downloads/MyTorrent/subs.srt".to_string(),
                    length: "512".to_string(),
                    completed_length: "512".to_string(),
                    selected: "true".to_string(),
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

    fn make_metadata_task(gid: &str) -> Aria2Task {
        let mut task = make_task(gid, "complete");
        task.bittorrent = Some(Aria2BtInfo::default());
        task.info_hash = Some("abcdef1234567890abcdef1234567890abcdef12".to_string());
        task
    }

    // ── Initial scan suppression ────────────────────────────────────

    #[test]
    fn initial_scan_suppresses_all_events() {
        let mut notifier = TaskNotifier::new();
        let tasks = vec![
            make_task("g1", "complete"),
            make_error_task("g2", "1"),
            make_bt_task("g3", "active", true),
        ];

        let events = notifier.scan(&tasks);
        assert!(events.is_empty(), "initial scan should suppress all events");
        assert!(notifier.initial_scan_done());
    }

    #[test]
    fn second_scan_emits_new_events() {
        let mut notifier = TaskNotifier::new();
        // Initial scan
        notifier.scan(&[make_task("g1", "complete")]);

        // Second scan with new completion
        let events = notifier.scan(&[
            make_task("g1", "complete"), // already seen
            make_task("g2", "complete"), // new
        ]);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::TASK_COMPLETE);
        assert_eq!(events[0].1.gid, "g2");
    }

    // ── Error detection ─────────────────────────────────────────────

    #[test]
    fn detects_new_error() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);
        // empty initial scan

        let events = notifier.scan(&[make_error_task("g1", "1")]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::TASK_ERROR);
        assert_eq!(events[0].1.error_code, Some("1".to_string()));
    }

    #[test]
    fn error_code_zero_is_ignored() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_error_task("g1", "0")]);
        assert!(events.is_empty(), "error code 0 = success, should not emit");
    }

    #[test]
    fn same_error_not_emitted_twice() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        notifier.scan(&[make_error_task("g1", "3")]);
        let events = notifier.scan(&[make_error_task("g1", "3")]);
        assert!(events.is_empty());
    }

    // ── Completion detection ────────────────────────────────────────

    #[test]
    fn detects_new_completion() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_task("g1", "complete")]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::TASK_COMPLETE);
    }

    #[test]
    fn same_completion_not_emitted_twice() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        notifier.scan(&[make_task("g1", "complete")]);
        let events = notifier.scan(&[make_task("g1", "complete")]);
        assert!(events.is_empty());
    }

    #[test]
    fn completed_metadata_task_is_ignored() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_metadata_task("metadata-gid")]);

        assert!(
            events.is_empty(),
            "metadata completion must not be recorded as user history"
        );
    }

    #[test]
    fn metadata_task_does_not_mark_gid_as_completed() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        notifier.scan(&[make_metadata_task("metadata-gid")]);
        let mut real_task = make_task("metadata-gid", "complete");
        real_task.files[0].path = "/downloads/real-file.iso".to_string();

        let events = notifier.scan(&[real_task]);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::TASK_COMPLETE);
    }

    // ── shared-upload detection ────────────────────────────────────────

    #[test]
    fn detects_bt_sharing_start() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_bt_task("g1", "active", true)]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::SHARING_COMPLETE);
        assert!(events[0].1.is_bt);
    }

    #[test]
    fn detects_ed2k_sharing_start() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_ed2k_task("ed2k1", "active", true)]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::SHARING_COMPLETE);
        assert_eq!(events[0].1.sharing_kind, Some("ed2k"));
    }

    #[test]
    fn restored_bt_complete_that_reports_seeder_later_does_not_emit() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[make_bt_task("g1", "active", false)]);

        let events = notifier.scan(&[make_bt_task("g2", "active", true)]);

        assert!(
            events.is_empty(),
            "restored complete BT tasks must not emit when seeder becomes true later"
        );
    }

    #[test]
    fn restored_bt_that_starts_as_zero_length_does_not_emit_when_seeder_arrives() {
        let mut notifier = TaskNotifier::new();
        let mut restoring = make_bt_task("g1", "active", false);
        restoring.total_length = "0".to_string();
        restoring.completed_length = "0".to_string();
        restoring.info_hash = None;

        notifier.scan(&[restoring]);

        let events = notifier.scan(&[make_bt_task_with_hash(
            "g1",
            "active",
            true,
            "hydrated-info-hash",
        )]);

        assert!(
            events.is_empty(),
            "restored BT tasks can start as 0/0 before aria2 hydrates seeder and infoHash"
        );
    }

    #[test]
    fn restored_bt_complete_is_matched_by_info_hash_across_gid_changes() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[make_bt_task_with_hash(
            "old-gid",
            "active",
            false,
            "same-info-hash",
        )]);

        let events = notifier.scan(&[make_bt_task_with_hash(
            "new-gid",
            "active",
            true,
            "same-info-hash",
        )]);

        assert!(
            events.is_empty(),
            "restored BT completion baseline should use infoHash before gid"
        );
    }

    #[test]
    fn bt_sharing_after_initial_restore_window_emits() {
        let mut notifier = TaskNotifier::new();
        let mut downloading = make_bt_task("g1", "active", false);
        downloading.completed_length = "512".to_string();

        notifier.scan(&[]);
        notifier.scan(&[downloading]);

        let events = notifier.scan(&[make_bt_task("g1", "active", true)]);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, events::SHARING_COMPLETE);
    }

    #[test]
    fn existing_seeder_first_scan_never_reemits() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[make_bt_task("g1", "active", true)]);

        let events = notifier.scan(&[make_bt_task("g1", "active", true)]);

        assert!(events.is_empty());
    }

    #[test]
    fn bt_not_sharing_is_not_emitted() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_bt_task("g1", "active", false)]);
        assert!(events.is_empty());
    }

    #[test]
    fn bt_sharing_but_not_active_is_not_emitted() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let events = notifier.scan(&[make_bt_task("g1", "paused", true)]);
        assert!(events.is_empty());
    }

    // ── Fresh notifier replaces reset ────────────────────────────────

    #[test]
    fn fresh_notifier_has_clean_state() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[make_task("g1", "complete")]);
        assert!(notifier.initial_scan_done());

        // On restart, a new notifier is created — verify it starts clean
        let fresh = TaskNotifier::new();
        assert!(!fresh.initial_scan_done());
        assert!(fresh.notified_completes.is_empty());
        assert!(fresh.notified_errors.is_empty());
        assert!(fresh.notified_sharing_completes.is_empty());
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
    fn task_event_handles_empty_files() {
        let mut task = make_task("g1", "complete");
        task.files = vec![];
        let event = TaskEvent::from_aria2(&task);
        assert_eq!(event.name, "");
    }

    // ── Mixed event emission ────────────────────────────────────────

    #[test]
    fn emits_multiple_event_types_in_single_scan() {
        let mut notifier = TaskNotifier::new();
        notifier.scan(&[]);

        let tasks = vec![
            make_task("g1", "complete"),
            make_error_task("g2", "5"),
            make_bt_task("g3", "active", true),
        ];

        let events = notifier.scan(&tasks);
        assert_eq!(events.len(), 3);

        let types: Vec<&str> = events.iter().map(|(t, _)| t.as_str()).collect();
        assert!(types.contains(&events::TASK_COMPLETE));
        assert!(types.contains(&events::TASK_ERROR));
        assert!(types.contains(&events::SHARING_COMPLETE));
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
        let task = make_bt_task("g2", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::SHARING_COMPLETE);

        assert_eq!(record.gid, "g2");
        assert_eq!(record.status, "complete");
        assert_eq!(record.name, "Ubuntu.iso");
        assert!(record.completed_at.is_some());

        // Meta must be valid JSON containing infoHash (not a raw hex string)
        let meta_str = record.meta.as_ref().expect("meta should be Some for BT");
        let meta: serde_json::Value =
            serde_json::from_str(meta_str).expect("meta must be valid JSON");
        assert_eq!(meta["infoHash"], "abcdef1234567890");
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
        let record = build_history_record(&event, events::SHARING_COMPLETE);

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
    fn build_history_record_derives_task_type_for_hls() {
        let task = make_hls_task("hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "complete");
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::TASK_COMPLETE);

        assert_eq!(record.task_type, Some("hls".to_string()));
        let meta: serde_json::Value =
            serde_json::from_str(record.meta.as_ref().expect("hls meta")).unwrap();
        assert_eq!(meta["hls"]["playlistUrl"], "https://cdn.example/a.m3u8");
        assert_eq!(meta["hls"]["mediaKind"], "mpegts");
        assert_eq!(meta["hls"]["outputPath"], "/tmp/video.ts");
    }

    #[test]
    fn task_event_from_aria2_marks_hls_gid_prefix() {
        let task = make_task("hls-0123456789abcdef0123456789abcdef", "complete");
        let event = TaskEvent::from_aria2(&task);
        assert!(event.is_hls);
        let record = build_history_record(&event, events::TASK_COMPLETE);
        assert_eq!(record.task_type, Some("hls".to_string()));
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
        let record = build_history_record(&event, events::SHARING_COMPLETE);

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
        let record = build_history_record(&event, events::SHARING_COMPLETE);

        let meta: serde_json::Value = serde_json::from_str(record.meta.as_ref().unwrap()).unwrap();
        let al = meta["announceList"].as_array().unwrap();
        assert_eq!(al.len(), 1);
        assert_eq!(al[0][0], "udp://tracker.example.com:6969");
    }

    #[test]
    fn bt_meta_contains_engine_magnet_link() {
        let task = make_bt_task("g1", "active", true);
        let event = TaskEvent::from_aria2(&task);
        let record = build_history_record(&event, events::SHARING_COMPLETE);

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
        let record = build_history_record(&event, events::SHARING_COMPLETE);

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
        let record = build_history_record(&event, events::SHARING_COMPLETE);

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
        let record = build_history_record(&event, events::SHARING_COMPLETE);

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
        let record = build_history_record(&event, events::SHARING_COMPLETE);

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

    #[test]
    fn count_hls_jobs_counts_active_and_waiting() {
        let jobs = vec![
            crate::hls::types::HlsJob {
                status: "active".into(),
                download_speed: 100,
                ..crate::hls::types::HlsJob::default()
            },
            crate::hls::types::HlsJob {
                status: "waiting".into(),
                ..crate::hls::types::HlsJob::default()
            },
            crate::hls::types::HlsJob {
                status: "paused".into(),
                ..crate::hls::types::HlsJob::default()
            },
            crate::hls::types::HlsJob {
                status: "active".into(),
                download_speed: 50,
                ..crate::hls::types::HlsJob::default()
            },
        ];
        assert_eq!(count_hls_active_jobs(&jobs), 2);
        assert_eq!(count_hls_waiting_jobs(&jobs), 1);
    }
}
