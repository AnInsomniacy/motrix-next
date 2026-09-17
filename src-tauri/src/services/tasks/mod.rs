//! Application task queries, admission and native controls.
mod policy;
use crate::{
    aria2::{rpc::RpcClient, types::*},
    error::AppError,
};
use policy::TaskPolicy;
use serde::{de::DeserializeOwned, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

pub struct TaskService {
    rpc: RpcClient,
    pub tasks: TaskPolicy,
    generation: AtomicU64,
}
pub struct TaskServiceState(pub Arc<TaskService>);
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeEligibleResult {
    pub resumed: usize,
    pub blocked: usize,
}
impl TaskService {
    pub fn new(port: u16, secret: String) -> Self {
        Self {
            rpc: RpcClient::new(port, secret),
            tasks: TaskPolicy::default(),
            generation: AtomicU64::new(0),
        }
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }
    pub async fn update_credentials(&self, port: u16, secret: String) {
        self.generation.fetch_add(1, Ordering::Relaxed);
        self.tasks.clear_automatic().await;
        self.rpc.update_credentials(port, secret).await;
    }
    pub async fn credentials(&self) -> (u16, String) {
        self.rpc.credentials().await
    }
    async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: Vec<serde_json::Value>,
    ) -> Result<T, AppError> {
        self.rpc.call(&format!("aria2.{method}"), params).await
    }
    // ── Public API ──────────────────────────────────────────────────

    pub async fn finish_media(&self, gid: &str) -> Result<String, AppError> {
        self.call("finishMedia", vec![gid.into()]).await
    }
    pub async fn retry_media(
        &self,
        gid: &str,
        options: serde_json::Value,
    ) -> Result<String, AppError> {
        self.call("retryMedia", vec![gid.into(), options]).await
    }

    /// Saves the current aria2 download session to disk.
    pub async fn save_session(&self) -> Result<String, AppError> {
        self.call("saveSession", vec![]).await
    }

    pub async fn shutdown(&self) -> Result<String, AppError> {
        self.call("shutdown", vec![]).await
    }

    /// Returns global download/upload statistics.
    pub async fn get_global_stat(&self) -> Result<Aria2GlobalStat, AppError> {
        let mut stat: Aria2GlobalStat = self.call("getGlobalStat", vec![]).await?;
        if self.tasks.has_internal().await {
            let tasks = self.tell_task_snapshot(false).await?;
            stat.num_active = tasks
                .iter()
                .filter(|task| task.status == "active")
                .count()
                .to_string();
            stat.num_waiting = tasks
                .iter()
                .filter(|task| matches!(task.status.as_str(), "waiting" | "paused"))
                .count()
                .to_string();
        }
        Ok(stat)
    }

    /// Returns all active (downloading/seeding) tasks.
    pub async fn tell_active(&self) -> Result<Vec<Aria2Task>, AppError> {
        Ok(self
            .tasks
            .visible_tasks(self.call("tellActive", vec![]).await?)
            .await)
    }

    /// Read queue transitions in one native RPC dispatch, including terminal
    /// results that have not reached application history yet.
    pub async fn tell_task_snapshot(
        &self,
        include_stopped: bool,
    ) -> Result<Vec<Aria2Task>, AppError> {
        Ok(self
            .tasks
            .visible_tasks(self.raw_task_snapshot(include_stopped).await?)
            .await)
    }

    pub async fn hidden_tasks(&self) -> Result<Vec<Aria2Task>, AppError> {
        let gids = self.tasks.internal_ids().await;
        if gids.is_empty() {
            return Ok(Vec::new());
        }
        let mut tasks = self.raw_task_snapshot(true).await?;
        tasks.retain(|task| gids.contains(&task.gid));
        Ok(tasks)
    }

    async fn raw_task_snapshot(&self, include_stopped: bool) -> Result<Vec<Aria2Task>, AppError> {
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
        Ok(self.tasks.visible_tasks(tasks).await)
    }

    /// Returns the status of a single task by GID.
    pub async fn tell_status(&self, gid: &str) -> Result<Aria2Task, AppError> {
        self.call("tellStatus", vec![gid.into()]).await
    }

    /// Forcefully pauses all active tasks.
    pub async fn force_pause_all(&self) -> Result<String, AppError> {
        self.tasks.clear_automatic().await;
        if !self.tasks.has_internal().await {
            return self.call("forcePauseAll", vec![]).await;
        }
        let tasks = self.tell_active().await?;
        let gids: Vec<_> = tasks.iter().map(|task| task.gid.clone()).collect();
        if !gids.is_empty() {
            let calls = gids
                .iter()
                .map(|gid| ("forcePause".into(), vec![serde_json::json!(gid)]))
                .collect();
            let results = self.multicall(calls).await?;
            validate_multicall_results("pause", &gids, &results)?;
        }
        Ok("OK".into())
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
            if self.tasks.is_internal(&task.gid).await {
                blocked += 1;
                continue;
            }
            let requires_file_selection = task
                .bittorrent
                .as_ref()
                .and_then(|bt| bt.file_selection_state.as_deref())
                == Some("awaiting");
            if requires_file_selection
                || task
                    .media
                    .as_ref()
                    .is_some_and(|media| media.state == "awaiting-selection")
            {
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
        self.rpc.call("system.listMethods", vec![]).await
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
        self.tasks.set_automatic(gid, false).await;
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
        let calls: Vec<_> = calls
            .into_iter()
            .map(|(method, params)| {
                serde_json::json!({
                    "methodName": format!("aria2.{method}"), "params": params,
                })
            })
            .collect();
        self.rpc.call("system.multicall", vec![calls.into()]).await
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

#[cfg(test)]
mod tests {
    use super::*;
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
