//! Aria2 JSON-RPC HTTP client.
//!
//! Provides a managed `Aria2Client` that communicates with the local Aria2 Next
//! sidecar over HTTP JSON-RPC.  Designed for internal Rust-side use by
//! monitors, tray actions, and the exit handler — NOT yet exposed to the
//! frontend (that happens in Task 8).

use crate::aria2::types::*;
use crate::error::AppError;
use serde::{de::DeserializeOwned, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

/// Aria2 JSON-RPC HTTP client.  Thread-safe via interior mutability.
///
/// Port and secret are protected by `RwLock` so they can be updated
/// after engine restart without reconstructing the client.
pub struct Aria2Client {
    http: reqwest::Client,
    port: RwLock<u16>,
    secret: RwLock<String>,
    request_id: AtomicU64,
}

/// Tauri managed state wrapper.
pub struct Aria2State(pub Arc<Aria2Client>);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeEligibleResult {
    pub resumed: usize,
    pub blocked: usize,
}

impl Aria2Client {
    /// Creates a new client with default credentials.
    ///
    /// The `reqwest::Client` is reused across all requests for connection
    /// pooling.  Credentials can be updated later via `update_credentials`.
    pub fn new(port: u16, secret: String) -> Self {
        let http = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("local aria2 RPC client");
        Self {
            http,
            port: RwLock::new(port),
            secret: RwLock::new(secret),
            request_id: AtomicU64::new(1),
        }
    }

    /// Updates connection credentials after engine restart.
    pub async fn update_credentials(&self, port: u16, secret: String) {
        *self.port.write().await = port;
        *self.secret.write().await = secret;
        log::debug!("aria2 client credentials updated: port={}", port);
    }

    /// Returns the current local RPC port and secret for companion transports.
    pub async fn credentials(&self) -> (u16, String) {
        let port = *self.port.read().await;
        let secret = self.secret.read().await.clone();
        (port, secret)
    }

    /// Builds the JSON-RPC params array with token prepended if secret is set.
    async fn build_params(&self, extra: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
        let secret = self.secret.read().await;
        if secret.is_empty() {
            extra
        } else {
            let mut params = vec![serde_json::Value::String(format!("token:{}", *secret))];
            params.extend(extra);
            params
        }
    }

    /// Generic JSON-RPC call.  Handles request construction, token injection,
    /// HTTP transport, and response parsing.
    async fn call_rpc<T: DeserializeOwned>(
        &self,
        method: &str,
        extra_params: Vec<serde_json::Value>,
    ) -> Result<T, AppError> {
        let port = *self.port.read().await;
        let params = self.build_params(extra_params).await;
        let id = self.request_id.fetch_add(1, Ordering::Relaxed);

        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: id.to_string(),
            method: method.to_string(),
            params,
        };

        let started = Instant::now();
        let result =
            async {
                let url = format!("http://127.0.0.1:{port}/jsonrpc");
                let resp: reqwest::Response =
                    self.http.post(&url).json(&req).send().await.map_err(|e| {
                        AppError::Aria2(format!("HTTP request to aria2 failed: {e}"))
                    })?;

                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| AppError::Aria2(format!("Failed to read aria2 response: {e}")))?;
                let body: JsonRpcResponse<T> = parse_jsonrpc_response(&bytes, "aria2")?;

                if let Some(err) = body.error {
                    if let Some(kind @ ("invalidBase64" | "torrentTooLarge" | "invalidTorrent")) =
                        err.data
                            .as_ref()
                            .and_then(|data| data.get("kind"))
                            .and_then(serde_json::Value::as_str)
                    {
                        return Err(AppError::TorrentInspection {
                            kind: kind.to_string(),
                            message: err.message,
                        });
                    }
                    return Err(AppError::Aria2(format!(
                        "aria2 RPC error [{}]: {}",
                        err.code, err.message
                    )));
                }

                body.result
                    .ok_or_else(|| AppError::Aria2("aria2 returned null result".into()))
            }
            .await;
        record_rpc_result(method, id, started, &result);
        result
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        extra_params: Vec<serde_json::Value>,
    ) -> Result<T, AppError> {
        self.call_rpc(&format!("aria2.{method}"), extra_params)
            .await
    }

    // ── Public API ──────────────────────────────────────────────────

    /// Saves the current aria2 download session to disk.
    pub async fn save_session(&self) -> Result<String, AppError> {
        self.call("saveSession", vec![]).await
    }

    pub async fn shutdown(&self) -> Result<String, AppError> {
        self.call("shutdown", vec![]).await
    }

    /// Returns global download/upload statistics.
    pub async fn get_global_stat(&self) -> Result<Aria2GlobalStat, AppError> {
        self.call("getGlobalStat", vec![]).await
    }

    /// Returns all active (downloading/seeding) tasks.
    pub async fn tell_active(&self) -> Result<Vec<Aria2Task>, AppError> {
        self.call("tellActive", vec![]).await
    }

    /// Read queue transitions in one native RPC dispatch, including terminal
    /// results that have not reached application history yet.
    pub async fn tell_task_snapshot(
        &self,
        include_stopped: bool,
    ) -> Result<Vec<Aria2Task>, AppError> {
        // aria2 clamps the requested range to the queue length, without allocating
        // the requested capacity. Avoid silently dropping tasks after entry 1000.
        let range = vec![0.into(), i32::MAX.into()];
        let mut calls = vec![
            ("tellActive".into(), vec![]),
            ("tellWaiting".into(), range.clone()),
        ];
        if include_stopped {
            calls.push(("tellStopped".into(), range));
        }
        let expected = calls.len();
        let results = self.multicall(calls).await?;
        if results.len() != expected {
            return Err(AppError::Aria2("Incomplete task snapshot".into()));
        }
        let mut tasks = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for result in results {
            let value = result
                .as_array()
                .filter(|row| row.len() == 1)
                .and_then(|row| row.first())
                .ok_or_else(|| AppError::Aria2(format!("Invalid task snapshot: {result}")))?;
            let page: Vec<Aria2Task> = serde_json::from_value(value.clone())
                .map_err(|error| AppError::Aria2(format!("Invalid task snapshot: {error}")))?;
            tasks.extend(
                page.into_iter()
                    .filter(|task| seen.insert(task.gid.clone())),
            );
        }
        Ok(tasks)
    }

    /// Returns waiting tasks starting at `offset` up to `num` entries.
    pub async fn tell_waiting(&self, offset: i64, num: i64) -> Result<Vec<Aria2Task>, AppError> {
        self.call("tellWaiting", vec![offset.into(), num.into()])
            .await
    }

    /// Returns stopped tasks starting at `offset` up to `num` entries.
    pub async fn tell_stopped(&self, offset: i64, num: i64) -> Result<Vec<Aria2Task>, AppError> {
        self.call("tellStopped", vec![offset.into(), num.into()])
            .await
    }

    /// Returns every stopped task using bounded native RPC pages.
    pub async fn tell_all_stopped(&self) -> Result<Vec<Aria2Task>, AppError> {
        const PAGE_SIZE: i64 = 256;

        let mut tasks = Vec::new();
        let mut offset = 0;
        loop {
            let page = self.tell_stopped(offset, PAGE_SIZE).await?;
            let page_len = page.len();
            tasks.extend(page);
            if page_len < PAGE_SIZE as usize {
                break;
            }
            offset += page_len as i64;
        }
        Ok(tasks)
    }

    /// Returns the status of a single task by GID.
    pub async fn tell_status(&self, gid: &str) -> Result<Aria2Task, AppError> {
        self.call("tellStatus", vec![gid.into()]).await
    }

    /// Forcefully pauses all active tasks.
    pub async fn force_pause_all(&self) -> Result<String, AppError> {
        self.call("forcePauseAll", vec![]).await
    }

    /// Resumes paused tasks that do not require unresolved magnet file selection.
    pub async fn resume_eligible(&self) -> Result<ResumeEligibleResult, AppError> {
        const PAGE_SIZE: i64 = 1000;
        let mut waiting_tasks = Vec::new();
        let mut offset = 0;
        loop {
            let page = self.tell_waiting(offset, PAGE_SIZE).await?;
            let page_len = page.len();
            waiting_tasks.extend(page);
            if page_len < PAGE_SIZE as usize {
                break;
            }
            offset += PAGE_SIZE;
        }
        let paused_tasks = waiting_tasks
            .into_iter()
            .filter(|task| task.status == "paused")
            .collect::<Vec<_>>();
        let mut resumable_gids = Vec::new();
        let mut blocked = 0;
        for task in paused_tasks {
            let requires_file_selection = task
                .bittorrent
                .as_ref()
                .and_then(|bt| bt.file_selection_state.as_deref())
                == Some("awaiting");
            if requires_file_selection {
                blocked += 1;
                continue;
            }
            resumable_gids.push(task.gid);
        }

        if !resumable_gids.is_empty() {
            let calls = resumable_gids
                .iter()
                .map(|gid| {
                    (
                        "unpause".to_string(),
                        vec![serde_json::Value::String(gid.clone())],
                    )
                })
                .collect();
            let results = self.multicall(calls).await?;
            validate_multicall_results("resume", &resumable_gids, &results)?;
        }

        Ok(ResumeEligibleResult {
            resumed: resumable_gids.len(),
            blocked,
        })
    }

    /// Changes global aria2 options at runtime.
    pub async fn change_global_option(
        &self,
        opts: serde_json::Map<String, serde_json::Value>,
    ) -> Result<String, AppError> {
        self.call("changeGlobalOption", vec![serde_json::Value::Object(opts)])
            .await
    }

    pub async fn get_bt_session_status(&self) -> Result<Aria2BtSessionStatus, AppError> {
        self.call("getBtSessionStatus", vec![]).await
    }

    pub async fn get_bt_trackers(&self, gid: &str) -> Result<Vec<Aria2BtTracker>, AppError> {
        self.call("getBtTrackers", vec![gid.into()]).await
    }

    pub async fn force_bt_recheck(&self, gid: &str) -> Result<String, AppError> {
        self.call("forceBtRecheck", vec![gid.into()]).await
    }

    pub async fn replace_bt_trackers(
        &self,
        gid: &str,
        trackers: Vec<Aria2BtTrackerConfig>,
    ) -> Result<String, AppError> {
        self.call(
            "replaceBtTrackers",
            vec![gid.into(), serde_json::json!(trackers)],
        )
        .await
    }

    pub async fn replace_bt_web_seeds(
        &self,
        gid: &str,
        web_seeds: Vec<String>,
    ) -> Result<String, AppError> {
        self.call(
            "replaceBtWebSeeds",
            vec![gid.into(), serde_json::json!(web_seeds)],
        )
        .await
    }

    pub async fn add_bt_peers(
        &self,
        gid: &str,
        peers: Vec<String>,
    ) -> Result<Aria2BtPeerAddResult, AppError> {
        self.call("addBtPeers", vec![gid.into(), serde_json::json!(peers)])
            .await
    }

    /// Adds a URI-based download.
    pub async fn add_uri(
        &self,
        uris: Vec<String>,
        opts: serde_json::Value,
    ) -> Result<String, AppError> {
        self.call("addUri", vec![serde_json::json!(uris), opts])
            .await
    }

    /// Adds a torrent download from base64-encoded .torrent content.
    pub async fn add_torrent(
        &self,
        base64: &str,
        opts: serde_json::Value,
    ) -> Result<String, AppError> {
        self.call(
            "addTorrent",
            vec![base64.into(), serde_json::json!([]), opts],
        )
        .await
    }

    /// Inspects torrent metainfo without creating a download task.
    pub async fn inspect_torrent(&self, base64: &str) -> Result<Aria2TorrentInspection, AppError> {
        self.call("inspectTorrent", vec![base64.into()]).await
    }

    /// Returns file descriptors for a task.
    pub async fn get_files(&self, gid: &str) -> Result<Vec<Aria2File>, AppError> {
        self.call("getFiles", vec![gid.into()]).await
    }

    /// Returns per-task options.
    pub async fn get_option(&self, gid: &str) -> Result<serde_json::Value, AppError> {
        self.call("getOption", vec![gid.into()]).await
    }

    /// Changes per-task options.
    pub async fn change_option(
        &self,
        gid: &str,
        opts: serde_json::Value,
    ) -> Result<String, AppError> {
        self.call("changeOption", vec![gid.into(), opts]).await
    }

    /// Returns the aria2 engine version and enabled features.
    pub async fn get_version(&self) -> Result<serde_json::Value, AppError> {
        self.call("getVersion", vec![]).await
    }

    pub async fn list_methods(&self) -> Result<Vec<String>, AppError> {
        self.call_rpc("system.listMethods", vec![]).await
    }

    /// Returns peer information for a BitTorrent task.
    pub async fn get_peers(&self, gid: &str) -> Result<serde_json::Value, AppError> {
        self.call("getPeers", vec![gid.into()]).await
    }

    /// Starts an ED2K search and returns the search GID.
    pub async fn ed2k_search(
        &self,
        keyword: &str,
        opts: serde_json::Value,
    ) -> Result<String, AppError> {
        self.call("ed2kSearch", vec![keyword.into(), opts]).await
    }

    /// Returns ED2K search results for a search GID.
    pub async fn get_ed2k_search_results(&self, gid: &str) -> Result<serde_json::Value, AppError> {
        self.call("getEd2kSearchResults", vec![gid.into()]).await
    }

    /// Removes an internal ED2K search request group after results are read.
    pub async fn cleanup_ed2k_search(&self, gid: &str) -> Result<(), AppError> {
        match self.force_remove(gid).await {
            Ok(_) => return Ok(()),
            Err(e) => log::debug!("ed2k: force_remove search gid={gid} skipped: {e}"),
        }
        match self.remove_download_result(gid).await {
            Ok(_) => Ok(()),
            Err(e) => {
                log::debug!("ed2k: remove_download_result search gid={gid} skipped: {e}");
                Ok(())
            }
        }
    }

    /// Gracefully pauses a task (waits for piece boundary).
    pub async fn pause(&self, gid: &str) -> Result<String, AppError> {
        self.call("pause", vec![gid.into()]).await
    }

    /// Forcefully pauses a task immediately.
    pub async fn force_pause(&self, gid: &str) -> Result<String, AppError> {
        self.call("forcePause", vec![gid.into()]).await
    }

    /// Resumes a paused task.
    pub async fn unpause(&self, gid: &str) -> Result<String, AppError> {
        self.call("unpause", vec![gid.into()]).await
    }

    /// Forcefully removes a task.
    pub async fn force_remove(&self, gid: &str) -> Result<String, AppError> {
        self.call("forceRemove", vec![gid.into()]).await
    }

    /// Removes a completed/error/removed download result.
    pub async fn remove_download_result(&self, gid: &str) -> Result<String, AppError> {
        self.call("removeDownloadResult", vec![gid.into()]).await
    }

    /// Removes stopped results in bounded native RPC batches.
    pub async fn remove_download_results(&self, gids: &[String]) -> Result<(), AppError> {
        const BATCH_SIZE: usize = 256;

        for batch in gids.chunks(BATCH_SIZE) {
            let calls = batch
                .iter()
                .map(|gid| {
                    (
                        "removeDownloadResult".to_string(),
                        vec![serde_json::Value::String(gid.clone())],
                    )
                })
                .collect();
            let results = self.multicall(calls).await?;
            if results.len() != batch.len() {
                return Err(AppError::Aria2(format!(
                    "aria2 returned {} results for {} removals",
                    results.len(),
                    batch.len()
                )));
            }
            for (gid, result) in batch.iter().zip(results) {
                if let Some(error) = result
                    .as_object()
                    .filter(|value| value.contains_key("code"))
                {
                    let message = error
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown RPC error");
                    return Err(AppError::Aria2(format!(
                        "Failed to remove completed result {gid}: {message}"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Purges all completed/error/removed download results.
    pub async fn purge_download_result(&self) -> Result<String, AppError> {
        self.call("purgeDownloadResult", vec![]).await
    }

    /// Batch execute multiple RPC calls via system.multicall.
    ///
    /// Each entry is (method_suffix, params) where method_suffix is e.g.
    /// "forcePause" and params is the extra params (GID, etc.).
    /// Returns per-call results as a JSON array.
    pub async fn multicall(
        &self,
        calls: Vec<(String, Vec<serde_json::Value>)>,
    ) -> Result<Vec<serde_json::Value>, AppError> {
        let secret = self.secret.read().await;
        let methods: Vec<serde_json::Value> = calls
            .into_iter()
            .map(|(method, extra)| {
                let mut params = Vec::new();
                if !secret.is_empty() {
                    params.push(serde_json::Value::String(format!("token:{}", *secret)));
                }
                params.extend(extra);
                serde_json::json!({
                    "methodName": format!("aria2.{method}"),
                    "params": params,
                })
            })
            .collect();

        let port = *self.port.read().await;
        let id = self.request_id.fetch_add(1, Ordering::Relaxed);
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: id.to_string(),
            method: "system.multicall".to_string(),
            params: vec![serde_json::Value::Array(methods)],
        };

        let started = Instant::now();
        let result =
            async {
                let url = format!("http://127.0.0.1:{port}/jsonrpc");
                let resp =
                    self.http.post(&url).json(&req).send().await.map_err(|e| {
                        AppError::Aria2(format!("HTTP request to aria2 failed: {e}"))
                    })?;

                let bytes = resp.bytes().await.map_err(|e| {
                    AppError::Aria2(format!("Failed to read multicall response: {e}"))
                })?;
                let body: JsonRpcResponse<Vec<serde_json::Value>> =
                    parse_jsonrpc_response(&bytes, "multicall")?;

                if let Some(err) = body.error {
                    return Err(AppError::Aria2(format!(
                        "aria2 multicall error [{}]: {}",
                        err.code, err.message
                    )));
                }

                body.result
                    .ok_or_else(|| AppError::Aria2("aria2 multicall returned null result".into()))
            }
            .await;
        record_rpc_result("system.multicall", id, started, &result);
        result
    }
}

fn is_polling_method(method: &str) -> bool {
    matches!(
        method,
        "aria2.getVersion"
            | "aria2.getGlobalStat"
            | "aria2.tellActive"
            | "aria2.tellWaiting"
            | "aria2.tellStopped"
            | "aria2.tellStatus"
            | "aria2.getPeers"
            | "aria2.getFiles"
    )
}

fn record_rpc_result<T>(method: &str, id: u64, started: Instant, result: &Result<T, AppError>) {
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Err(error) if is_polling_method(method) => log::debug!(
            target: "aria2_rpc",
            event = "rpc_unavailable",
            rpc_id = id,
            method,
            duration_ms,
            error:% = error;
            "rpc_unavailable"
        ),
        Err(error) => log::error!(
            target: "aria2_rpc",
            event = "rpc_failed",
            rpc_id = id,
            method,
            duration_ms,
            error:% = error;
            "rpc_failed"
        ),
        Ok(_) if duration_ms >= 1_000 => log::warn!(
            target: "aria2_rpc",
            event = "rpc_slow",
            rpc_id = id,
            method,
            duration_ms;
            "rpc_slow"
        ),
        Ok(_) if !is_polling_method(method) => log::debug!(
            target: "aria2_rpc",
            event = "rpc_completed",
            rpc_id = id,
            method,
            duration_ms;
            "rpc_completed"
        ),
        Ok(_) => {}
    }
}

fn validate_multicall_results(
    operation: &str,
    gids: &[String],
    results: &[serde_json::Value],
) -> Result<(), AppError> {
    if results.len() != gids.len() {
        return Err(AppError::Aria2(format!(
            "aria2 returned {} results for {} {operation} calls",
            results.len(),
            gids.len()
        )));
    }
    for (gid, result) in gids.iter().zip(results) {
        if let Some(error) = result
            .as_object()
            .filter(|value| value.contains_key("code"))
        {
            let message = error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown RPC error");
            return Err(AppError::Aria2(format!(
                "Failed to {operation} task {gid}: {message}"
            )));
        }
    }
    Ok(())
}

fn parse_jsonrpc_response<T: DeserializeOwned>(
    bytes: &[u8],
    context: &str,
) -> Result<JsonRpcResponse<T>, AppError> {
    let body = String::from_utf8_lossy(bytes);
    serde_json::from_str::<JsonRpcResponse<T>>(&body)
        .map_err(|e| AppError::Aria2(format!("Failed to parse {context} response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Token parameter construction ────────────────────────────────

    #[tokio::test]
    async fn build_params_prepends_token_when_secret_is_set() {
        let client = Aria2Client::new(29100, "mysecret".to_string());
        let params = client.build_params(vec![serde_json::json!("arg1")]).await;

        assert_eq!(params.len(), 2);
        assert_eq!(params[0], serde_json::json!("token:mysecret"));
        assert_eq!(params[1], serde_json::json!("arg1"));
    }

    #[tokio::test]
    async fn build_params_omits_token_when_secret_is_empty() {
        let client = Aria2Client::new(29100, String::new());
        let params = client.build_params(vec![serde_json::json!("arg1")]).await;

        assert_eq!(params.len(), 1);
        assert_eq!(params[0], serde_json::json!("arg1"));
    }

    #[tokio::test]
    async fn build_params_empty_extra_with_secret() {
        let client = Aria2Client::new(29100, "sec".to_string());
        let params = client.build_params(vec![]).await;

        assert_eq!(params.len(), 1);
        assert_eq!(params[0], serde_json::json!("token:sec"));
    }

    #[tokio::test]
    async fn build_params_empty_extra_without_secret() {
        let client = Aria2Client::new(29100, String::new());
        let params = client.build_params(vec![]).await;

        assert!(params.is_empty());
    }

    #[test]
    fn parse_jsonrpc_response_tolerates_invalid_utf8_in_string_values() {
        let bytes =
            b"{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{\"results\":[{\"name\":\"bad-\xFF-name\"}]}}";
        let response: JsonRpcResponse<serde_json::Value> =
            parse_jsonrpc_response(bytes, "aria2").expect("invalid UTF-8 should be replaced");
        let result = response.result.expect("result must exist");
        let name = result["results"][0]["name"]
            .as_str()
            .expect("name must stay readable");

        assert_eq!(name, "bad-\u{FFFD}-name");
    }

    // ── Credential update ───────────────────────────────────────────

    #[tokio::test]
    async fn update_credentials_changes_port_and_secret() {
        let client = Aria2Client::new(29100, "old".to_string());
        assert_eq!(*client.port.read().await, 29100);
        assert_eq!(*client.secret.read().await, "old");

        client
            .update_credentials(29120, "new_secret".to_string())
            .await;

        assert_eq!(*client.port.read().await, 29120);
        assert_eq!(*client.secret.read().await, "new_secret");
    }

    // ── Request ID monotonicity ─────────────────────────────────────

    #[test]
    fn request_id_increments_monotonically() {
        let client = Aria2Client::new(29100, String::new());
        let id1 = client.request_id.fetch_add(1, Ordering::Relaxed);
        let id2 = client.request_id.fetch_add(1, Ordering::Relaxed);
        let id3 = client.request_id.fetch_add(1, Ordering::Relaxed);

        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
        assert_eq!(id3, 3);
    }

    // ── Aria2State wrapping ─────────────────────────────────────────

    #[test]
    fn aria2_state_wraps_client_in_arc() {
        let client = Aria2Client::new(29100, "test".to_string());
        let state = Aria2State(Arc::new(client));
        // Arc clone produces a second strong reference
        let _clone = state.0.clone();
        assert_eq!(Arc::strong_count(&state.0), 2);
    }

    // ── call() error handling (network failure) ─────────────────────

    #[tokio::test]
    async fn call_returns_aria2_error_on_connection_refused() {
        // Use a port where nothing is listening
        let client = Aria2Client::new(19999, String::new());
        let result = client.save_session().await;

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Aria2(_)),
            "expected Aria2 variant, got: {err:?}"
        );
        assert!(
            err.to_string().contains("HTTP request to aria2 failed"),
            "unexpected message: {}",
            err
        );
    }

    // ── Token format contract ───────────────────────────────────────

    #[tokio::test]
    async fn token_format_matches_aria2_protocol() {
        // aria2 expects exactly "token:{secret}" as the first param
        let client = Aria2Client::new(29100, "s3cret!@#$".to_string());
        let params = client.build_params(vec![]).await;

        let token = params[0].as_str().expect("token must be a string");
        assert!(
            token.starts_with("token:"),
            "token must start with 'token:'"
        );
        assert_eq!(token, "token:s3cret!@#$");
    }

    // ── Multiple extra params preserved in order ────────────────────

    #[tokio::test]
    async fn build_params_preserves_multiple_extra_params_order() {
        let client = Aria2Client::new(29100, "sec".to_string());
        let params = client
            .build_params(vec![
                serde_json::json!("first"),
                serde_json::json!(42),
                serde_json::json!({"key": "val"}),
            ])
            .await;

        assert_eq!(params.len(), 4);
        assert_eq!(params[0], serde_json::json!("token:sec"));
        assert_eq!(params[1], serde_json::json!("first"));
        assert_eq!(params[2], serde_json::json!(42));
        assert_eq!(params[3], serde_json::json!({"key": "val"}));
    }

    #[test]
    fn multicall_validation_accepts_one_result_per_gid() {
        let gids = vec!["a".to_string(), "b".to_string()];
        let results = vec![serde_json::json!(["a"]), serde_json::json!(["b"])];
        assert!(validate_multicall_results("resume", &gids, &results).is_ok());
    }

    #[test]
    fn multicall_validation_rejects_per_task_errors() {
        let gids = vec!["a".to_string()];
        let results = vec![serde_json::json!({"code": 1, "message": "cannot resume"})];
        let error = validate_multicall_results("resume", &gids, &results).unwrap_err();
        assert!(error.to_string().contains("cannot resume"));
    }
}
