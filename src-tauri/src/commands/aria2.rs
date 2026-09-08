//! Tauri commands exposing aria2 RPC operations to the frontend.
//!
//! These commands serve as the invoke() transport layer. Each command maps
//! to one or more aria2 RPC methods.

use crate::aria2::client::{Aria2Client, Aria2State};
use crate::aria2::types::{
    Aria2BtPeerAddResult, Aria2BtTrackerConfig, Aria2File, Aria2Task, Aria2TorrentInspection,
};
use crate::commands::net::decode_filename_encoding;
use crate::error::AppError;
use crate::history::{HistoryDb, HistoryDbState};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

const ED2K_SEARCH_TEMP_PREFIX: &str = "motrix-next-ed2k-search-";

/// Fetch task list by type.
#[tauri::command]
pub async fn aria2_fetch_task_list(
    state: State<'_, Aria2State>,
    r#type: String,
    limit: Option<i64>,
) -> Result<Vec<Aria2Task>, AppError> {
    match r#type.as_str() {
        "all" => state.0.tell_task_snapshot(true).await,
        "active" => state.0.tell_task_snapshot(false).await,
        "waiting" => state.0.tell_waiting(0, limit.unwrap_or(1000)).await,
        _ => state.0.tell_stopped(0, limit.unwrap_or(1000)).await,
    }
}

/// Fetch only active tasks (no waiting).
#[tauri::command]
pub async fn aria2_fetch_active_task_list(
    state: State<'_, Aria2State>,
) -> Result<Vec<Aria2Task>, AppError> {
    state.0.tell_active().await
}

/// Fetch a single task's full status by GID.
#[tauri::command]
pub async fn aria2_fetch_task_item(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<Aria2Task, AppError> {
    state.0.tell_status(&gid).await
}

/// Fetch task status with peer list (for BT tasks).
#[tauri::command]
pub async fn aria2_fetch_task_item_with_peers(
    state: State<'_, Aria2State>,
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
    state: State<'_, Aria2State>,
) -> Result<serde_json::Value, AppError> {
    state.0.get_version().await
}

/// Get global download/upload statistics.
#[tauri::command]
pub async fn aria2_get_global_stat(
    state: State<'_, Aria2State>,
) -> Result<serde_json::Value, AppError> {
    let stat = state.0.get_global_stat().await?;
    serde_json::to_value(&stat).map_err(|e| AppError::Aria2(format!("serialize stat: {e}")))
}

/// Change global aria2 options at runtime.
#[tauri::command]
pub async fn aria2_change_global_option(
    state: State<'_, Aria2State>,
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
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    state.0.get_option(&gid).await
}

/// Change per-task options.
#[tauri::command]
pub async fn aria2_change_option(
    state: State<'_, Aria2State>,
    gid: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    state.0.change_option(&gid, options).await
}

/// Get file list for a task.
#[tauri::command]
pub async fn aria2_get_files(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<Vec<Aria2File>, AppError> {
    state.0.get_files(&gid).await
}

#[tauri::command]
pub async fn aria2_get_bt_trackers(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    let trackers = state.0.get_bt_trackers(&gid).await?;
    serde_json::to_value(trackers).map_err(|e| AppError::Aria2(format!("serialize trackers: {e}")))
}

#[tauri::command]
pub async fn aria2_force_bt_recheck(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    state.0.force_bt_recheck(&gid).await
}

#[tauri::command]
pub async fn aria2_replace_bt_trackers(
    state: State<'_, Aria2State>,
    gid: String,
    trackers: Vec<Aria2BtTrackerConfig>,
) -> Result<String, AppError> {
    state.0.replace_bt_trackers(&gid, trackers).await
}

#[tauri::command]
pub async fn aria2_replace_bt_web_seeds(
    state: State<'_, Aria2State>,
    gid: String,
    web_seeds: Vec<String>,
) -> Result<String, AppError> {
    state.0.replace_bt_web_seeds(&gid, web_seeds).await
}

#[tauri::command]
pub async fn aria2_add_bt_peers(
    state: State<'_, Aria2State>,
    gid: String,
    peers: Vec<String>,
) -> Result<Aria2BtPeerAddResult, AppError> {
    state.0.add_bt_peers(&gid, peers).await
}

// ── `out` option sanitization ────────────────────────────────────────

/// Sanitizes an `out` option value into a safe, platform-valid filename.
///
/// aria2's `out` option must be a plain filename relative to `dir`.  aria2
/// itself performs **no** filename sanitization — it passes the value
/// directly to the OS `open()` call.  This function is the authoritative
/// safety boundary.
///
/// Three-step pipeline:
///   1. **Basename extraction** — strips path separators (including Windows
///      drive letters, UNC prefixes, and Unix absolute paths).
///   2. **NUL rejection** — NUL bytes truncate C strings inside aria2.
///   3. **Industry-standard sanitization** via the `sanitize-filename` crate
///      (same character set as Chrome `filename_util.cc` and Node.js
///      `sanitize-filename`):
///      - Replaces `/ \ : * ? " < > |` with `_`
///      - Removes ASCII control chars (0x00–0x1F, 0x7F) and C1 (0x80–0x9F)
///      - Rejects Windows reserved names (CON, NUL, COM1, LPT1, etc.)
///      - Strips trailing dots and spaces (Windows rejects these)
///      - Truncates to 255 bytes (filesystem limit)
///
/// Returns `None` for values that reduce to empty after sanitization.
fn sanitize_out_option(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    // 1. Basename extraction — split on both separators for cross-platform.
    let basename = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    if basename.is_empty() || basename == "." || basename == ".." {
        return None;
    }
    // 2. Reject NUL bytes early (truncate C strings inside aria2).
    if basename.contains('\0') {
        return None;
    }
    // 3. Industry-standard sanitization (Chrome / sanitize-filename char set).
    //    Always use Windows rules (most restrictive) regardless of build target
    //    to ensure filenames are safe when the Rust backend runs on any platform
    //    but may serve files destined for Windows clients.
    let decoded = decode_filename_encoding(basename);
    let sanitized = sanitize_filename::sanitize_with_options(
        decoded.as_str(),
        sanitize_filename::Options {
            windows: true,
            truncate: true,
            replacement: "_",
        },
    );
    let result = sanitized.trim().to_string();
    if result.is_empty() {
        return None;
    }
    Some(result)
}

/// Add URI download(s). Each URI gets its own aria2 task with optional
/// per-URI `out` filename override and file-category directory resolution.
#[tauri::command]
pub async fn aria2_add_uri(
    app: AppHandle,
    state: State<'_, Aria2State>,
    uris: Vec<String>,
    mut options: serde_json::Value,
) -> Result<String, AppError> {
    // Enforce out = safe-filename invariant before forwarding to aria2.
    // Prevents path traversal (#261) and illegal-character crashes (#264).
    if let Some(opts) = options.as_object_mut() {
        if let Some(out_val) = opts.get("out").and_then(|v| v.as_str()).map(String::from) {
            match sanitize_out_option(&out_val) {
                Some(ref clean) if *clean != out_val => {
                    log::warn!("aria2:add-uri sanitized out: {:?} → {:?}", out_val, clean);
                    opts.insert("out".to_string(), serde_json::Value::String(clean.clone()));
                }
                None => {
                    log::warn!("aria2:add-uri removed invalid out option");
                    opts.remove("out");
                }
                _ => {} // already a clean filename — no action needed
            }
        }
    }
    if uris.iter().any(|uri| {
        uri.trim_start()
            .to_ascii_lowercase()
            .starts_with("ed2k://|file|")
    }) {
        crate::commands::ed2k::inject_managed_ed2k_bootstrap_options(&app, &mut options)?;
    }
    log::debug!("aria2:add-uri count={}", uris.len());
    state.0.add_uri(uris, options).await
}

/// Add a torrent download from base64-encoded content.
#[tauri::command]
pub async fn aria2_add_torrent(
    state: State<'_, Aria2State>,
    torrent: String,
    options: serde_json::Value,
) -> Result<String, AppError> {
    log::info!("aria2:add-torrent");
    state.0.add_torrent(&torrent, options).await
}

/// Inspect torrent metainfo without creating a task or writing engine state.
#[tauri::command]
pub async fn aria2_inspect_torrent(
    state: State<'_, Aria2State>,
    torrent: String,
) -> Result<Aria2TorrentInspection, AppError> {
    state.0.inspect_torrent(&torrent).await
}

/// Start an ED2K search and return the search GID.
#[tauri::command]
pub async fn aria2_ed2k_search(
    app: AppHandle,
    state: State<'_, Aria2State>,
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
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<serde_json::Value, AppError> {
    state.0.get_ed2k_search_results(&gid).await
}

/// Remove an internal ED2K search request group and its temporary files.
#[tauri::command]
pub async fn aria2_cleanup_ed2k_search(
    app: AppHandle,
    state: State<'_, Aria2State>,
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
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    log::info!("aria2:remove gid={gid}");
    state.0.force_remove(&gid).await
}

fn is_missing_download(error: &AppError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("not found") || message.contains("no such download")
}

fn is_terminal_download_status(status: &str) -> bool {
    matches!(status, "complete" | "error" | "removed")
}

fn is_download_result_transitioning(error: &AppError) -> bool {
    error
        .to_string()
        .to_ascii_lowercase()
        .contains("could not remove download result")
}

async fn remove_engine_task(client: &Aria2Client, gid: &str) -> Result<(), AppError> {
    const RESULT_ATTEMPTS: usize = 100;
    const RESULT_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

    let force_result = client.force_remove(gid).await;
    let mut result_removed = false;

    for _ in 0..RESULT_ATTEMPTS {
        match client.tell_status(gid).await {
            Err(error) if is_missing_download(&error) => break,
            Err(error) => return Err(error),
            Ok(task) if is_terminal_download_status(&task.status) => {
                match client.remove_download_result(gid).await {
                    Ok(_) => {
                        result_removed = true;
                        break;
                    }
                    Err(error) if is_missing_download(&error) => break,
                    Err(error) if is_download_result_transitioning(&error) => {}
                    Err(error) => return Err(error),
                }
            }
            Ok(_) => {}
        }
        tokio::time::sleep(RESULT_DELAY).await;
    }

    if result_removed {
        return Ok(());
    }

    match client.tell_status(gid).await {
        Err(error) if is_missing_download(&error) => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(force_result.err().unwrap_or_else(|| {
            AppError::Aria2(format!("GID {gid} did not reach the removed state"))
        })),
    }
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
    client: &Aria2Client,
    history: &HistoryDb,
    gid: &str,
    info_hash: Option<&str>,
) -> Result<(), AppError> {
    log::info!("aria2:delete gid={gid}");
    remove_engine_task(client, gid).await?;
    history.remove_task_records(gid, info_hash).await
}

async fn finish_sharing_task(
    client: &Aria2Client,
    history: &HistoryDb,
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
    state: State<'_, Aria2State>,
    history: State<'_, HistoryDbState>,
    gid: String,
    info_hash: Option<String>,
) -> Result<(), AppError> {
    delete_task(&state.0, &history.0, &gid, info_hash.as_deref()).await
}

/// Delete multiple tasks while preserving per-task history cleanup semantics.
#[tauri::command]
pub async fn aria2_batch_delete_tasks(
    state: State<'_, Aria2State>,
    history: State<'_, HistoryDbState>,
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
    state: State<'_, Aria2State>,
    history: State<'_, HistoryDbState>,
    gid: String,
) -> Result<(), AppError> {
    finish_sharing_task(&state.0, &history.0, &gid).await
}

/// End multiple P2P sharing tasks while preserving files and completed history.
#[tauri::command]
pub async fn aria2_batch_finish_sharing(
    state: State<'_, Aria2State>,
    history: State<'_, HistoryDbState>,
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
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    log::debug!("aria2:force-pause gid={gid}");
    state.0.force_pause(&gid).await
}

/// Gracefully pause a task.
#[tauri::command]
pub async fn aria2_pause(state: State<'_, Aria2State>, gid: String) -> Result<String, AppError> {
    log::debug!("aria2:pause gid={gid}");
    state.0.pause(&gid).await
}

/// Resume a paused task.
#[tauri::command]
pub async fn aria2_unpause(state: State<'_, Aria2State>, gid: String) -> Result<String, AppError> {
    log::debug!("aria2:resume gid={gid}");
    state.0.unpause(&gid).await
}

/// Save the current aria2 session to disk.
#[tauri::command]
pub async fn aria2_save_session(state: State<'_, Aria2State>) -> Result<String, AppError> {
    state.0.save_session().await
}

/// Remove a completed/errored task record from aria2's download list.
#[tauri::command]
pub async fn aria2_remove_download_result(
    state: State<'_, Aria2State>,
    gid: String,
) -> Result<String, AppError> {
    state.0.remove_download_result(&gid).await
}

/// Clear application history and purge completed engine results.
#[tauri::command]
pub async fn aria2_purge_task_records(
    state: State<'_, Aria2State>,
    history: State<'_, HistoryDbState>,
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
pub async fn aria2_force_pause_all(state: State<'_, Aria2State>) -> Result<String, AppError> {
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
    state: State<'_, Aria2State>,
) -> Result<crate::aria2::client::ResumeEligibleResult, AppError> {
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
    use super::{
        is_download_result_transitioning, is_missing_download, is_p2p_sharing_task,
        is_terminal_download_status, sanitize_out_option, AppError,
    };
    use crate::aria2::types::{Aria2BtInfo, Aria2Ed2kInfo, Aria2Task};

    #[test]
    fn bare_filename_passes_through() {
        assert_eq!(sanitize_out_option("file.zip").as_deref(), Some("file.zip"));
    }

    #[test]
    fn windows_backslash_absolute_extracts_basename() {
        assert_eq!(
            sanitize_out_option("C:\\Users\\u\\Downloads\\file.zip").as_deref(),
            Some("file.zip")
        );
    }

    #[test]
    fn forward_slash_absolute_extracts_basename() {
        assert_eq!(
            sanitize_out_option("C:/Users/u/Downloads/file.zip").as_deref(),
            Some("file.zip")
        );
    }

    #[test]
    fn unc_path_extracts_basename() {
        assert_eq!(
            sanitize_out_option("\\\\server\\share\\file.zip").as_deref(),
            Some("file.zip")
        );
    }

    #[test]
    fn parent_traversal_extracts_basename() {
        assert_eq!(
            sanitize_out_option("../evil.exe").as_deref(),
            Some("evil.exe")
        );
    }

    #[test]
    fn dotdot_only_rejected() {
        assert_eq!(sanitize_out_option(".."), None);
    }

    #[test]
    fn dot_only_rejected() {
        assert_eq!(sanitize_out_option("."), None);
    }

    #[test]
    fn empty_rejected() {
        assert_eq!(sanitize_out_option(""), None);
    }

    #[test]
    fn nul_byte_rejected() {
        assert_eq!(sanitize_out_option("file\0.zip"), None);
    }

    #[test]
    fn accented_filename_preserved() {
        assert_eq!(
            sanitize_out_option("C:/Downloads/résumé.zip").as_deref(),
            Some("résumé.zip")
        );
    }

    #[test]
    fn trailing_separator_rejected() {
        assert_eq!(sanitize_out_option("path/to/"), None);
    }

    #[test]
    fn issue_261_regression() {
        assert_eq!(
            sanitize_out_option("C:/Users/37472/Downloads/sysdiag-all-x64.exe").as_deref(),
            Some("sysdiag-all-x64.exe")
        );
    }

    // ── #264: illegal character sanitization ────────────────────────

    #[test]
    fn issue_264_twitter_cdn_filename() {
        // Extension sends "G9v9wWdasAYNqt9?format=jpg&name=large" as filename.
        // `?` is replaced with `_` by the crate; `&` and `=` are legal filename
        // chars and pass through unchanged.
        assert_eq!(
            sanitize_out_option("G9v9wWdasAYNqt9?format=jpg&name=large").as_deref(),
            Some("G9v9wWdasAYNqt9_format=jpg&name=large")
        );
    }

    #[test]
    fn replaces_windows_illegal_chars() {
        assert_eq!(
            sanitize_out_option("a<b>c:d*e.jpg").as_deref(),
            Some("a_b_c_d_e.jpg")
        );
    }

    #[test]
    fn replaces_pipe_and_quotes() {
        assert_eq!(
            sanitize_out_option("file\"|pipe.txt").as_deref(),
            Some("file__pipe.txt")
        );
    }

    #[test]
    fn question_mark_in_filename_replaced() {
        // "what?.jpg" → "what_.jpg" (not truncated to "what")
        assert_eq!(
            sanitize_out_option("what?.jpg").as_deref(),
            Some("what_.jpg")
        );
    }

    #[test]
    fn percent_encoded_rfc2047_out_decodes_before_sanitize() {
        assert_eq!(
            sanitize_out_option("=%3FUTF-8%3FB%3F0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4%3F=")
                .as_deref(),
            Some("ИТОГИ ЛДУ 2026.xlsx")
        );
    }

    #[test]
    fn percent_encoded_utf8_out_decodes_before_sanitize() {
        assert_eq!(
            sanitize_out_option("K430006866701%20%20%20%20%2020251022%20%20%20ASKO%20%20%20%20CW5937GCN%20%20%20%20%20CW51237GCN%E8%AF%B4%E6%98%8E%E4%B9%A6%28%E6%96%B0%E5%9B%BD%E6%A0%87%29.pdf").as_deref(),
            Some("K430006866701     20251022   ASKO    CW5937GCN     CW51237GCN说明书(新国标).pdf")
        );
    }

    #[test]
    fn percent_encoded_slash_out_stays_single_safe_filename() {
        assert_eq!(
            sanitize_out_option("safe%2Fevil.pdf").as_deref(),
            Some("safe_evil.pdf")
        );
    }

    #[test]
    fn rfc2047_out_decodes_before_sanitize() {
        assert_eq!(
            sanitize_out_option("=?UTF-8?B?0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4?=").as_deref(),
            Some("ИТОГИ ЛДУ 2026.xlsx")
        );
    }

    // ── Windows reserved names ──────────────────────────────────────
    // The crate replaces reserved names with the replacement string "_".
    // Our wrapper then trims and rejects empty — but "_" is non-empty,
    // so reserved names become "_".  This is safe: "_" is a valid
    // filename on all platforms.

    #[test]
    fn windows_reserved_con_becomes_underscore() {
        assert_eq!(sanitize_out_option("CON").as_deref(), Some("_"));
    }

    #[test]
    fn windows_reserved_nul_txt_becomes_underscore() {
        assert_eq!(sanitize_out_option("NUL.txt").as_deref(), Some("_"));
    }

    #[test]
    fn windows_reserved_com1_becomes_underscore() {
        assert_eq!(sanitize_out_option("com1").as_deref(), Some("_"));
    }

    #[test]
    fn windows_reserved_lpt3_becomes_underscore() {
        assert_eq!(sanitize_out_option("LPT3").as_deref(), Some("_"));
    }

    // ── Trailing dots and spaces ────────────────────────────────────

    #[test]
    fn trailing_dots_stripped() {
        // The crate replaces trailing dots/spaces with replacement "_";
        // our wrapper calls .trim() which handles trailing whitespace.
        // "file.jpg..." → crate → "file.jpg_" → trim → "file.jpg_"
        let result = sanitize_out_option("file.jpg...");
        assert!(result.is_some());
        assert!(result.as_deref().unwrap_or("").starts_with("file.jpg"));
    }

    #[test]
    fn trailing_spaces_stripped() {
        // "file.jpg   " → crate → "file.jpg_" → trim → "file.jpg_"
        // Or our .trim() may catch it. Either way, starts with "file.jpg".
        let result = sanitize_out_option("file.jpg   ");
        assert!(result.is_some());
        assert!(result.as_deref().unwrap_or("").starts_with("file.jpg"));
    }

    // ── Control characters ──────────────────────────────────────────

    #[test]
    fn control_chars_removed() {
        // The crate removes control characters (0x00-0x1F, 0x80-0x9F)
        let result = sanitize_out_option("\x01\x02file.jpg");
        assert!(result.is_some());
        assert!(result.as_deref().unwrap_or("").contains("file.jpg"));
    }

    // ── Normal filenames unmodified ─────────────────────────────────

    #[test]
    fn normal_filename_with_spaces() {
        assert_eq!(
            sanitize_out_option("My Document.pdf").as_deref(),
            Some("My Document.pdf")
        );
    }

    #[test]
    fn extensionless_filename_preserved() {
        assert_eq!(sanitize_out_option("README").as_deref(), Some("README"));
    }

    #[test]
    fn dotfile_preserved() {
        assert_eq!(
            sanitize_out_option(".gitignore").as_deref(),
            Some(".gitignore")
        );
    }

    #[test]
    fn deletion_recognizes_missing_download_errors() {
        assert!(is_missing_download(&AppError::Aria2(
            "GID abc is not found".to_string()
        )));
        assert!(is_missing_download(&AppError::Aria2(
            "No such download for GID abc".to_string()
        )));
        assert!(!is_missing_download(&AppError::Aria2(
            "connection reset".to_string()
        )));
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
    fn deletion_retries_only_during_result_transition() {
        assert!(is_download_result_transitioning(&AppError::Aria2(
            "Could not remove download result of GID#abc".to_string()
        )));
        assert!(!is_download_result_transitioning(&AppError::Aria2(
            "connection reset".to_string()
        )));
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
