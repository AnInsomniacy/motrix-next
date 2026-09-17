//! Tauri commands exposing aria2 RPC operations to the frontend.
//!
//! These commands serve as the invoke() transport layer. Each command maps
//! to one or more aria2 RPC methods.

use crate::aria2::types::{
    Aria2BtPeerAddResult, Aria2BtTrackerConfig, Aria2File, Aria2Task, Aria2TorrentInspection,
};
use crate::database::{Database, DatabaseState};
use crate::error::AppError;
use crate::services::tasks::{TaskService, TaskServiceState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

const ED2K_SEARCH_TEMP_PREFIX: &str = "rayburst-ed2k-search-";

/// Fetch task list by type.
#[tauri::command]
pub async fn aria2_fetch_task_list(
    state: State<'_, TaskServiceState>,
    r#type: String,
    limit: Option<i64>,
) -> Result<Vec<Aria2Task>, AppError> {
    let tasks = match r#type.as_str() {
        "all" => state.0.tell_task_snapshot(true).await,
        "active" => state.0.tell_task_snapshot(false).await,
        "waiting" => state.0.tell_waiting(0, limit.unwrap_or(1000)).await,
        _ => state.0.tell_stopped(0, limit.unwrap_or(1000)).await,
    }?;
    Ok(state.0.tasks.visible_tasks(tasks).await)
}

/// Fetch only active tasks (no waiting).
#[tauri::command]
pub async fn aria2_fetch_active_task_list(
    state: State<'_, TaskServiceState>,
) -> Result<Vec<Aria2Task>, AppError> {
    state.0.tell_active().await
}

/// Fetch a single task's full status by GID.
#[tauri::command]
pub async fn aria2_fetch_task_item(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<Aria2Task, AppError> {
    state.0.tell_status(&gid).await
}

/// Fetch task status with peer list (for BT tasks).
#[tauri::command]
pub async fn aria2_fetch_task_item_with_peers(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    let task = state.0.tell_status(&gid).await?;
    let peers = if task.bittorrent.is_some() {
        state.0.get_peers(&gid).await?
    } else {
        serde_json::json!([])
    };
    let mut result =
        serde_json::to_value(&task).map_err(|e| AppError::Aria2(format!("serialize task: {e}")))?;
    result["peers"] = peers;
    Ok(result)
}

/// Get aria2 engine version and enabled features.
#[tauri::command]
pub async fn aria2_get_version(
    state: State<'_, TaskServiceState>,
) -> Result<serde_json::Value, AppError> {
    state.0.get_version().await
}

/// Get global download/upload statistics.
#[tauri::command]
pub async fn aria2_get_global_stat(
    state: State<'_, TaskServiceState>,
) -> Result<serde_json::Value, AppError> {
    let stat = state.0.get_global_stat().await?;
    serde_json::to_value(&stat).map_err(|e| AppError::Aria2(format!("serialize stat: {e}")))
}

/// Change global aria2 options at runtime.
#[tauri::command]
pub async fn aria2_change_global_option(
    state: State<'_, TaskServiceState>,
    options: serde_json::Map<String, serde_json::Value>,
) -> Result<String, AppError> {
    let endpoint_changed = options.contains_key("listen-port")
        || options.contains_key("bt-external-ip")
        || options.contains_key("bt-external-port");
    let result = state.0.change_global_option(options).await?;
    if endpoint_changed {
        match state.0.get_bt_session_status().await {
            Ok(endpoint) => log::info!(
                "aria2:bt-session listen_port={} announce_port={} endpoints={} external_ip_configured={}",
                endpoint.listen_port,
                endpoint.announce_port,
                endpoint.listen_endpoints.len(),
                !endpoint.external_ip.is_empty()
            ),
            Err(error) => log::debug!("aria2:bt-session diagnostics unavailable after option update: {error}"),
        }
    }
    Ok(result)
}

/// Get per-task options.
#[tauri::command]
pub async fn aria2_get_option(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    state.0.get_option(&gid).await
}

/// Change per-task options.
#[tauri::command]
pub async fn aria2_change_option(
    state: State<'_, TaskServiceState>,
    gid: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    let changes_media = options.as_object().is_some_and(|values| {
        values
            .keys()
            .any(|key| key == "media" || key.starts_with("media-"))
    });
    if changes_media {
        let task = state.0.tell_status(&gid).await?;
        if task.media.is_some() && task.status != "paused" {
            return Err(AppError::Aria2(
                "Pause media before changing its selection".into(),
            ));
        }
    }
    state.0.change_option(&gid, options).await
}

/// Get file list for a task.
#[tauri::command]
pub async fn aria2_get_files(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<Vec<Aria2File>, AppError> {
    state.0.get_files(&gid).await
}

#[tauri::command]
pub async fn aria2_get_bt_trackers(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    let trackers = state.0.get_bt_trackers(&gid).await?;
    serde_json::to_value(trackers).map_err(|e| AppError::Aria2(format!("serialize trackers: {e}")))
}

#[tauri::command]
pub async fn aria2_force_bt_recheck(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<String, AppError> {
    state.0.force_bt_recheck(&gid).await
}

#[tauri::command]
pub async fn aria2_replace_bt_trackers(
    state: State<'_, TaskServiceState>,
    gid: String,
    trackers: Vec<Aria2BtTrackerConfig>,
) -> Result<String, AppError> {
    state.0.replace_bt_trackers(&gid, trackers).await
}

#[tauri::command]
pub async fn aria2_replace_bt_web_seeds(
    state: State<'_, TaskServiceState>,
    gid: String,
    web_seeds: Vec<String>,
) -> Result<String, AppError> {
    state.0.replace_bt_web_seeds(&gid, web_seeds).await
}

#[tauri::command]
pub async fn aria2_add_bt_peers(
    state: State<'_, TaskServiceState>,
    gid: String,
    peers: Vec<String>,
) -> Result<Aria2BtPeerAddResult, AppError> {
    state.0.add_bt_peers(&gid, peers).await
}

/// Add URI download(s). Each URI gets its own aria2 task with optional
/// per-URI `out` filename override and file-category directory resolution.
#[tauri::command]
pub async fn aria2_add_uri(
    app: AppHandle,
    uris: Vec<String>,
    options: serde_json::Value,
    request_id: Option<String>,
) -> Result<String, AppError> {
    crate::services::downloads::submit(
        &app,
        crate::services::downloads::TaskInput::Uris(uris),
        options,
        request_id.as_deref(),
    )
    .await
}

/// Add a torrent download from base64-encoded content.
#[tauri::command]
pub async fn aria2_add_torrent(
    app: AppHandle,
    torrent: String,
    options: serde_json::Value,
    request_id: Option<String>,
) -> Result<String, AppError> {
    crate::services::downloads::submit(
        &app,
        crate::services::downloads::TaskInput::Torrent(torrent),
        options,
        request_id.as_deref(),
    )
    .await
}

/// Inspect torrent metainfo without creating a task or writing engine state.
#[tauri::command]
pub async fn aria2_inspect_torrent(
    state: State<'_, TaskServiceState>,
    torrent: String,
) -> Result<Aria2TorrentInspection, AppError> {
    state.0.inspect_torrent(&torrent).await
}

/// Start an ED2K search and return the search GID.
#[tauri::command]
pub async fn aria2_ed2k_search(
    app: AppHandle,
    state: State<'_, TaskServiceState>,
    keyword: String,
    mut options: serde_json::Value,
) -> Result<String, AppError> {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return Err(AppError::Aria2("ED2K search keyword is empty".into()));
    }
    log::info!("aria2:ed2k-search");
    cleanup_stale_ed2k_search_dirs(&app);
    let search_dir = create_ed2k_search_temp_dir(&app)?;
    ensure_json_object(&mut options).insert(
        "dir".to_string(),
        serde_json::Value::String(crate::engine::path_to_safe_string(&search_dir)),
    );
    crate::commands::ed2k::inject_managed_ed2k_bootstrap_options(&app, &mut options)?;
    let gid = match state.0.ed2k_search(keyword, options).await {
        Ok(gid) => gid,
        Err(e) => {
            cleanup_ed2k_search_dir(&search_dir);
            return Err(e);
        }
    };
    register_ed2k_search_dir(&app, &gid, &search_dir);
    Ok(gid)
}

/// Return ED2K search results by search GID.
#[tauri::command]
pub async fn aria2_get_ed2k_search_results(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    state.0.get_ed2k_search_results(&gid).await
}

/// Remove an internal ED2K search request group and its temporary files.
#[tauri::command]
pub async fn aria2_cleanup_ed2k_search(
    app: AppHandle,
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<(), AppError> {
    state.0.cleanup_ed2k_search(&gid).await?;
    cleanup_ed2k_search_files(&app, &gid);
    Ok(())
}

fn ensure_json_object(
    value: &mut serde_json::Value,
) -> &mut serde_json::Map<String, serde_json::Value> {
    if !value.is_object() {
        *value = serde_json::Value::Object(serde_json::Map::new());
    }
    value
        .as_object_mut()
        .expect("value was normalized to object")
}

fn ed2k_search_temp_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let configured = app
        .store("config.json")
        .ok()
        .and_then(|store| store.get("preferences"))
        .and_then(|prefs| {
            prefs
                .get("tempFilesDir")?
                .as_str()
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|path| !path.is_empty());

    if let Some(path) = configured {
        Ok(PathBuf::from(path))
    } else {
        app.path()
            .temp_dir()
            .map_err(|e| AppError::Io(e.to_string()))
    }
}

fn create_ed2k_search_temp_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let root = ed2k_search_temp_root(app)?;
    tempfile::Builder::new()
        .prefix(ED2K_SEARCH_TEMP_PREFIX)
        .tempdir_in(root)
        .map(tempfile::TempDir::keep)
        .map_err(AppError::from)
}

fn cleanup_ed2k_search_files(app: &AppHandle, gid: &str) {
    let Some(search_dir) = take_ed2k_search_dir(app, gid) else {
        return;
    };
    cleanup_ed2k_search_dir(&search_dir);
}

fn cleanup_ed2k_search_dir(path: &Path) {
    match std::fs::remove_dir_all(path) {
        Ok(()) => log::debug!("ed2k: removed search temp dir {}", path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::debug!(
            "ed2k: search temp dir cleanup skipped path={} error={}",
            path.display(),
            e
        ),
    }
}

fn cleanup_stale_ed2k_search_dirs(app: &AppHandle) {
    let Ok(root) = ed2k_search_temp_root(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if name.starts_with(ED2K_SEARCH_TEMP_PREFIX) {
            cleanup_ed2k_search_dir(&path);
        }
    }
}

fn is_safe_gid(gid: &str) -> bool {
    !gid.is_empty() && gid.bytes().all(|b| b.is_ascii_hexdigit())
}

static ED2K_SEARCH_DIRS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, PathBuf>>> =
    std::sync::OnceLock::new();

fn ed2k_search_dirs() -> &'static std::sync::Mutex<HashMap<String, PathBuf>> {
    ED2K_SEARCH_DIRS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn register_ed2k_search_dir(_app: &AppHandle, gid: &str, path: &Path) {
    if !is_safe_gid(gid) {
        return;
    }
    if let Ok(mut dirs) = ed2k_search_dirs().lock() {
        dirs.insert(gid.to_string(), path.to_path_buf());
    }
}

fn take_ed2k_search_dir(_app: &AppHandle, gid: &str) -> Option<PathBuf> {
    if !is_safe_gid(gid) {
        return None;
    }
    ed2k_search_dirs().lock().ok()?.remove(gid)
}

/// Forcefully remove a task by GID.
#[tauri::command]
pub async fn aria2_force_remove(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<String, AppError> {
    log::info!("aria2:remove gid={gid}");
    state.0.force_remove(&gid).await
}

fn is_terminal_download_status(status: &str) -> bool {
    matches!(status, "complete" | "error" | "removed")
}

async fn remove_engine_task(client: &TaskService, gid: &str) -> Result<(), AppError> {
    let operation = async {
        let mut removal_requested = false;
        loop {
            let tasks = client.tell_task_snapshot(true).await?;
            let Some(task) = tasks.iter().find(|task| task.gid == gid) else {
                return Ok(());
            };
            if is_terminal_download_status(&task.status) {
                match client.remove_download_result(gid).await {
                    Ok(_) => return Ok(()),
                    // Native result publication can trail a terminal snapshot.
                    // Re-read state on application faults; transport failures stay visible.
                    Err(AppError::Rpc { code: 1, .. }) => {}
                    Err(error) => return Err(error),
                }
            } else if !removal_requested {
                client.force_remove(gid).await?;
                removal_requested = true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), operation)
        .await
        .map_err(|_| AppError::Aria2(format!("Task {gid} did not finish removal")))?
}

fn is_p2p_sharing_task(task: &Aria2Task) -> bool {
    matches!(task.status.as_str(), "active" | "paused")
        && (task.bittorrent.is_some() || task.ed2k.is_some())
        && task.seeder.as_deref() == Some("true")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchDeleteTaskTarget {
    gid: String,
    info_hash: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTaskFailure {
    gid: String,
    message: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchTaskOperationResult {
    succeeded: Vec<String>,
    failed: Vec<BatchTaskFailure>,
}

impl BatchTaskOperationResult {
    fn record(&mut self, gid: String, operation: Result<(), AppError>) {
        match operation {
            Ok(()) => self.succeeded.push(gid),
            Err(error) => {
                log::warn!("aria2:batch-operation-failed gid={gid} error={error}");
                self.failed.push(BatchTaskFailure {
                    gid,
                    message: error.to_string(),
                });
            }
        }
    }
}

async fn delete_task(
    client: &TaskService,
    history: &Database,
    gid: &str,
    info_hash: Option<&str>,
) -> Result<(), AppError> {
    log::info!("aria2:delete gid={gid}");
    remove_engine_task(client, gid).await?;
    history.remove_task_records(gid, info_hash).await
}

async fn finish_sharing_task(
    client: &TaskService,
    history: &Database,
    gid: &str,
) -> Result<(), AppError> {
    let task = client.tell_status(gid).await?;
    if !is_p2p_sharing_task(&task) {
        return Err(AppError::Aria2(format!(
            "GID {gid} is not a P2P sharing task"
        )));
    }

    log::info!("aria2:finish-sharing gid={gid}");
    let event = crate::services::monitor::TaskEvent::from_aria2(&task);
    let added_at = history.get_task_birth(gid).await?;
    let record = crate::services::monitor::build_history_record_with_added_at(
        &event,
        crate::services::monitor::events::P2P_DOWNLOAD_COMPLETE,
        added_at,
    );
    history.add_record(&record).await?;
    remove_engine_task(client, gid).await
}

/// Delete a task regardless of whether it is live, transitioning, or stopped.
#[tauri::command]
pub async fn aria2_delete_task(
    state: State<'_, TaskServiceState>,
    history: State<'_, DatabaseState>,
    gid: String,
    info_hash: Option<String>,
) -> Result<(), AppError> {
    delete_task(&state.0, &history.0, &gid, info_hash.as_deref()).await
}

/// Delete multiple tasks while preserving per-task history cleanup semantics.
#[tauri::command]
pub async fn aria2_batch_delete_tasks(
    state: State<'_, TaskServiceState>,
    history: State<'_, DatabaseState>,
    tasks: Vec<BatchDeleteTaskTarget>,
) -> Result<BatchTaskOperationResult, AppError> {
    let mut result = BatchTaskOperationResult::default();
    for target in tasks {
        let operation = delete_task(
            &state.0,
            &history.0,
            &target.gid,
            target.info_hash.as_deref(),
        )
        .await;
        result.record(target.gid, operation);
    }
    log::info!(
        "aria2:batch-delete finished={} failed={}",
        result.succeeded.len(),
        result.failed.len()
    );
    Ok(result)
}

/// End P2P sharing while preserving downloaded files and the completed history record.
#[tauri::command]
pub async fn aria2_finish_sharing(
    state: State<'_, TaskServiceState>,
    history: State<'_, DatabaseState>,
    gid: String,
) -> Result<(), AppError> {
    finish_sharing_task(&state.0, &history.0, &gid).await
}

/// End multiple P2P sharing tasks while preserving files and completed history.
#[tauri::command]
pub async fn aria2_batch_finish_sharing(
    state: State<'_, TaskServiceState>,
    history: State<'_, DatabaseState>,
    gids: Vec<String>,
) -> Result<BatchTaskOperationResult, AppError> {
    let mut result = BatchTaskOperationResult::default();
    for gid in gids {
        let operation = finish_sharing_task(&state.0, &history.0, &gid).await;
        result.record(gid, operation);
    }
    log::info!(
        "aria2:batch-finish-sharing finished={} failed={}",
        result.succeeded.len(),
        result.failed.len()
    );
    Ok(result)
}

/// Forcefully pause a task by GID.
#[tauri::command]
pub async fn aria2_force_pause(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<String, AppError> {
    log::debug!("aria2:force-pause gid={gid}");
    state.0.force_pause(&gid).await
}

/// Gracefully pause a task.
#[tauri::command]
pub async fn aria2_pause(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<String, AppError> {
    log::debug!("aria2:pause gid={gid}");
    state.0.pause(&gid).await
}

/// Resume a paused task.
#[tauri::command]
pub async fn aria2_unpause(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<String, AppError> {
    log::debug!("aria2:resume gid={gid}");
    state.0.unpause(&gid).await
}

/// Save the current aria2 session to disk.
#[tauri::command]
pub async fn aria2_save_session(state: State<'_, TaskServiceState>) -> Result<String, AppError> {
    state.0.save_session().await
}

/// Remove a completed/errored task record from aria2's download list.
#[tauri::command]
pub async fn aria2_remove_download_result(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<String, AppError> {
    state.0.remove_download_result(&gid).await
}

/// Clear application history and purge completed engine results.
#[tauri::command]
pub async fn aria2_purge_task_records(
    state: State<'_, TaskServiceState>,
    history: State<'_, DatabaseState>,
) -> Result<(), AppError> {
    log::info!("aria2:purge-results");
    history.0.clear_records(None).await?;
    if let Err(error) = state.0.purge_download_result().await {
        log::debug!("aria2:purge-results engine cleanup failed: {error}");
    }
    Ok(())
}

/// Forcefully pause every active engine task through the native RPC.
#[tauri::command]
pub async fn aria2_force_pause_all(state: State<'_, TaskServiceState>) -> Result<String, AppError> {
    const SETTLE_ATTEMPTS: usize = 100;
    const SETTLE_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

    let (active, waiting) = tokio::try_join!(state.0.tell_active(), state.0.tell_waiting(0, 1000))?;
    let targets = active
        .into_iter()
        .chain(waiting)
        .filter(|task| matches!(task.status.as_str(), "active" | "waiting"))
        .map(|task| task.gid)
        .collect::<HashSet<_>>();

    log::info!("aria2:pause-all count={}", targets.len());
    let response = state.0.force_pause_all().await?;
    for _ in 0..SETTLE_ATTEMPTS {
        let (active, waiting) =
            tokio::try_join!(state.0.tell_active(), state.0.tell_waiting(0, 1000))?;
        let unsettled = active.into_iter().chain(waiting).any(|task| {
            targets.contains(&task.gid) && matches!(task.status.as_str(), "active" | "waiting")
        });
        if !unsettled {
            return Ok(response);
        }
        tokio::time::sleep(SETTLE_DELAY).await;
    }

    Err(AppError::Aria2(
        "Timed out while waiting for all tasks to pause".to_string(),
    ))
}

/// Resume paused tasks while keeping unresolved magnet selections paused.
#[tauri::command]
pub async fn aria2_resume_eligible(
    state: State<'_, TaskServiceState>,
) -> Result<crate::services::tasks::ResumeEligibleResult, AppError> {
    let result = state.0.resume_eligible().await?;
    log::info!(
        "aria2:resume-eligible resumed={} blocked={}",
        result.resumed,
        result.blocked
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{is_p2p_sharing_task, is_terminal_download_status};
    use crate::aria2::types::{Aria2BtInfo, Aria2Ed2kInfo, Aria2Task};

    #[tokio::test]
    async fn deletion_removes_the_visible_native_task_before_its_history() {
        use axum::{extract::State, routing::post, Json, Router};
        use serde_json::{json, Value};
        use std::sync::{
            atomic::{AtomicU8, Ordering},
            Arc,
        };
        async fn rpc(
            State(state): State<Arc<AtomicU8>>,
            Json(request): Json<Value>,
        ) -> Json<Value> {
            let result = match request["method"].as_str().unwrap() {
                "system.multicall" => {
                    let phase = state.load(Ordering::Relaxed);
                    let tasks = if phase == 2 {
                        vec![]
                    } else {
                        vec![Aria2Task {
                            gid: "task".into(),
                            status: if phase == 0 { "active" } else { "removed" }.into(),
                            ..Default::default()
                        }]
                    };
                    json!([[tasks], [[]], [[]]])
                }
                "aria2.forceRemove" => {
                    state.store(1, Ordering::Relaxed);
                    json!("task")
                }
                "aria2.removeDownloadResult" => {
                    state.store(2, Ordering::Relaxed);
                    json!("OK")
                }
                method => panic!("Unexpected operation: {method}"),
            };
            Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
        }
        let state = Arc::new(AtomicU8::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = crate::services::tasks::TaskService::new(
            listener.local_addr().unwrap().port(),
            String::new(),
        );
        let router = Router::new()
            .route("/jsonrpc", post(rpc))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let db = crate::database::Database::open_in_memory().unwrap();
        db.add_record(
            &serde_json::from_value(json!({"gid":"task","name":"file","status":"complete"}))
                .unwrap(),
        )
        .await
        .unwrap();
        super::delete_task(&client, &db, "task", None)
            .await
            .unwrap();
        assert_eq!(state.load(Ordering::Relaxed), 2);
        assert!(db.get_record("task").await.unwrap().is_none());
        server.abort();
    }

    #[test]
    fn deletion_waits_for_a_terminal_download_status() {
        assert!(is_terminal_download_status("complete"));
        assert!(is_terminal_download_status("error"));
        assert!(is_terminal_download_status("removed"));
        assert!(!is_terminal_download_status("active"));
        assert!(!is_terminal_download_status("waiting"));
        assert!(!is_terminal_download_status("paused"));
    }

    #[test]
    fn finish_sharing_accepts_bt_and_ed2k_seeders() {
        let bt = Aria2Task {
            status: "active".to_string(),
            seeder: Some("true".to_string()),
            bittorrent: Some(Aria2BtInfo::default()),
            ..Aria2Task::default()
        };
        let ed2k = Aria2Task {
            status: "paused".to_string(),
            seeder: Some("true".to_string()),
            ed2k: Some(Aria2Ed2kInfo::default()),
            ..Aria2Task::default()
        };
        assert!(is_p2p_sharing_task(&bt));
        assert!(is_p2p_sharing_task(&ed2k));
        assert!(!is_p2p_sharing_task(&Aria2Task::default()));
        assert!(!is_p2p_sharing_task(&Aria2Task {
            status: "complete".to_string(),
            seeder: Some("true".to_string()),
            bittorrent: Some(Aria2BtInfo::default()),
            ..Aria2Task::default()
        }));
    }
}

/// Confirm media selection or retry a failed media task with the same GID.
#[tauri::command]
pub async fn aria2_confirm_media(
    state: State<'_, TaskServiceState>,
    gid: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    let task = state.0.tell_status(&gid).await?;
    crate::services::media::native::start(
        &state.0,
        &task,
        options,
        crate::services::media::native::StartMode::User,
    )
    .await
}

/// Finalize committed live media without deleting its output or recovery state.
#[tauri::command]
pub async fn aria2_finish_media(
    state: State<'_, TaskServiceState>,
    gid: String,
) -> Result<String, AppError> {
    state.0.finish_media(&gid).await
}

/// Retry a failed presentation in its native recovery identity.
#[tauri::command]
pub async fn aria2_retry_media(
    state: State<'_, TaskServiceState>,
    gid: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    state.0.retry_media(&gid, options).await
}

/// Request publication for each selected recording and retain per-task failures.
#[tauri::command]
pub async fn aria2_batch_finish_media(
    state: State<'_, TaskServiceState>,
    gids: Vec<String>,
) -> Result<BatchTaskOperationResult, AppError> {
    let mut result = BatchTaskOperationResult::default();
    for gid in gids {
        let operation = state.0.finish_media(&gid).await.map(|_| ());
        result.record(gid, operation);
    }
    Ok(result)
}

#[tauri::command]
pub async fn cancel_download_request(app: AppHandle, id: String) -> Result<(), AppError> {
    crate::services::downloads::cancel(&app, &id).await
}
