use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::hls::types::{HlsJob, HlsJobStatus, HlsPhase};

/// Default concurrent HLS jobs when `maxConcurrentDownloads` is absent.
const DEFAULT_MAX_CONCURRENT: u32 = 5;

/// In-process HLS engine: job map, cancel tokens, and shared byte limiter.
pub struct HlsEngineState {
    pub(crate) inner: Mutex<HlsEngineInner>,
    pub(crate) limiter: ByteRateLimiter,
}

pub struct HlsEngineInner {
    pub jobs: HashMap<String, HlsJob>,
    pub max_concurrent: u32,
    pub cancel_tokens: HashMap<String, CancellationToken>,
    pub run_ids: HashMap<String, u64>,
}

/// Shared HLS-only token bucket. `None` rate means unlimited.
pub(crate) struct ByteRateLimiter {
    inner: Mutex<RateBucket>,
}

struct RateBucket {
    rate: Option<u64>,
    tokens: f64,
    last: Instant,
}

impl ByteRateLimiter {
    fn new() -> Self {
        Self {
            inner: Mutex::new(RateBucket {
                rate: None,
                tokens: 0.0,
                last: Instant::now(),
            }),
        }
    }

    pub async fn set_rate(&self, rate: Option<u64>) {
        let mut bucket = self.inner.lock().await;
        if bucket.rate != rate {
            bucket.rate = rate;
            bucket.tokens = rate.map(|value| value as f64).unwrap_or(0.0);
            bucket.last = Instant::now();
        }
    }

    /// Wait until `bytes` can be charged. `Err(())` means the job was cancelled.
    pub async fn consume(&self, bytes: u64, token: &CancellationToken) -> Result<(), ()> {
        if bytes == 0 {
            return Ok(());
        }
        loop {
            let wait = {
                let mut bucket = self.inner.lock().await;
                let Some(rate) = bucket.rate else {
                    return Ok(());
                };
                if rate == 0 {
                    return Ok(());
                }
                let now = Instant::now();
                let elapsed = now.saturating_duration_since(bucket.last).as_secs_f64();
                let cap = rate as f64;
                bucket.tokens = (bucket.tokens + elapsed * cap).min(cap);
                bucket.last = now;
                match token_bucket_charge(bucket.tokens, rate, bytes) {
                    Ok(remaining) => {
                        bucket.tokens = remaining;
                        return Ok(());
                    }
                    Err(wait) => wait,
                }
            };
            tokio::select! {
                () = token.cancelled() => return Err(()),
                () = tokio::time::sleep(wait) => {}
            }
        }
    }
}

/// Charge `bytes` against a refilled bucket, or return how long to wait.
///
/// `Ok(remaining)` may be negative (one overshoot). `Err(wait)` is always
/// finite when `rate > 0`.
fn token_bucket_charge(tokens: f64, rate: u64, bytes: u64) -> Result<f64, Duration> {
    if bytes == 0 || rate == 0 {
        return Ok(tokens);
    }
    let cap = rate as f64;
    let bytes_f = bytes as f64;
    // Wait only until the bucket is as full as the cap allows, then overshoot
    // so a single segment larger than tokens/sec can still proceed.
    let target = bytes_f.min(cap);
    if tokens >= target {
        Ok(tokens - bytes_f)
    } else {
        let need = target - tokens;
        Err(Duration::from_secs_f64((need / cap).max(0.001)))
    }
}

/// True when this captured run may delete temp and emit complete.
pub(crate) fn should_finish(status: &str, current_run_id: u64, captured_run_id: u64) -> bool {
    status == "active" && current_run_id == captured_run_id
}

fn active_count(jobs: &HashMap<String, HlsJob>) -> u32 {
    jobs.values().filter(|job| job.status == "active").count() as u32
}

fn not_found(gid: &str) -> AppError {
    AppError::NotFound(gid.into())
}

fn bump_run_id(inner: &mut HlsEngineInner, gid: &str) -> u64 {
    let next = inner
        .run_ids
        .get(gid)
        .copied()
        .unwrap_or(0)
        .saturating_add(1);
    inner.run_ids.insert(gid.to_string(), next);
    next
}

fn arm_run(inner: &mut HlsEngineInner, gid: &str) {
    bump_run_id(inner, gid);
    inner
        .cancel_tokens
        .insert(gid.to_string(), CancellationToken::new());
}

async fn remove_path_best_effort(path: &Path) {
    if tokio::fs::metadata(path).await.is_err() {
        return;
    }
    if tokio::fs::remove_file(path).await.is_err() {
        let _ = tokio::fs::remove_dir_all(path).await;
    }
}

impl HlsEngineState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HlsEngineInner {
                jobs: HashMap::new(),
                max_concurrent: DEFAULT_MAX_CONCURRENT,
                cancel_tokens: HashMap::new(),
                run_ids: HashMap::new(),
            }),
            limiter: ByteRateLimiter::new(),
        }
    }

    /// Insert `job`. Does not spawn `run_job`. Returns whether the caller should spawn.
    pub async fn add(&self, mut job: HlsJob) -> bool {
        let mut inner = self.inner.lock().await;
        if let Some(token) = inner.cancel_tokens.remove(&job.gid) {
            token.cancel();
        }
        inner.jobs.remove(&job.gid);
        let spawn = active_count(&inner.jobs) < inner.max_concurrent;
        if spawn {
            job.status = HlsJobStatus::Active.as_str().into();
            arm_run(&mut inner, &job.gid);
        } else {
            job.status = HlsJobStatus::Waiting.as_str().into();
        }
        inner.jobs.insert(job.gid.clone(), job);
        spawn
    }

    pub async fn set_max_concurrent(&self, max: u32) {
        let mut inner = self.inner.lock().await;
        inner.max_concurrent = max.max(1);
    }

    pub async fn get_job(&self, gid: &str) -> Option<HlsJob> {
        let inner = self.inner.lock().await;
        inner.jobs.get(gid).cloned()
    }

    pub async fn snapshot_jobs(&self) -> Vec<HlsJob> {
        let inner = self.inner.lock().await;
        inner.jobs.values().cloned().collect()
    }

    /// Insert restored jobs without changing status. Arms tokens for `active` jobs.
    /// Returns gids the caller should spawn.
    pub async fn restore_jobs(&self, jobs: Vec<HlsJob>) -> Vec<String> {
        let mut inner = self.inner.lock().await;
        let mut spawn = Vec::new();
        for job in jobs {
            let gid = job.gid.clone();
            if let Some(token) = inner.cancel_tokens.remove(&gid) {
                token.cancel();
            }
            let is_active = job.status == "active";
            inner.jobs.insert(gid.clone(), job);
            if is_active {
                arm_run(&mut inner, &gid);
                spawn.push(gid);
            }
        }
        spawn
    }

    pub async fn has_active_merge_or_remux(&self) -> bool {
        let inner = self.inner.lock().await;
        inner.jobs.values().any(|job| {
            job.status == "active" && matches!(job.phase, HlsPhase::Merge | HlsPhase::Remux)
        })
    }

    pub async fn pause_active_merge_or_remux(&self) {
        let mut inner = self.inner.lock().await;
        let gids: Vec<String> = inner
            .jobs
            .iter()
            .filter(|(_, job)| {
                job.status == "active" && matches!(job.phase, HlsPhase::Merge | HlsPhase::Remux)
            })
            .map(|(gid, _)| gid.clone())
            .collect();
        for gid in gids {
            if let Some(token) = inner.cancel_tokens.remove(&gid) {
                token.cancel();
            }
            if let Some(job) = inner.jobs.get_mut(&gid) {
                job.status = "paused".into();
            }
        }
    }

    pub async fn pause(&self, gid: &str) -> Result<(), AppError> {
        let mut inner = self.inner.lock().await;
        if let Some(token) = inner.cancel_tokens.remove(gid) {
            token.cancel();
        }
        let job = inner.jobs.get_mut(gid).ok_or_else(|| not_found(gid))?;
        job.status = "paused".into();
        Ok(())
    }

    /// Resume a paused job. Returns whether the caller should spawn `run_job`.
    pub async fn resume(&self, gid: &str) -> Result<bool, AppError> {
        let mut inner = self.inner.lock().await;
        let paused = inner.jobs.get(gid).ok_or_else(|| not_found(gid))?.status == "paused";
        if !paused {
            return Ok(false);
        }
        let spawn = active_count(&inner.jobs) < inner.max_concurrent;
        {
            let job = inner.jobs.get_mut(gid).ok_or_else(|| not_found(gid))?;
            job.status = if spawn { "active" } else { "waiting" }.into();
        }
        if spawn {
            arm_run(&mut inner, gid);
        }
        Ok(spawn)
    }

    pub async fn remove(&self, gid: &str, delete_files: bool) -> Result<(), AppError> {
        let mut inner = self.inner.lock().await;
        if let Some(token) = inner.cancel_tokens.remove(gid) {
            token.cancel();
        }
        inner.run_ids.remove(gid);
        let Some(job) = inner.jobs.remove(gid) else {
            return Err(not_found(gid));
        };
        drop(inner);
        if !job.temp_dir.as_os_str().is_empty() {
            let _ = tokio::fs::remove_dir_all(&job.temp_dir).await;
        }
        if delete_files {
            if let Some(path) = job.output_path.as_deref() {
                remove_path_best_effort(Path::new(path)).await;
            }
            if let Some(path) = job.fallback_ts_path.as_deref() {
                remove_path_best_effort(Path::new(path)).await;
            }
        }
        Ok(())
    }

    /// Promote waiting jobs into free active slots. Returns gids the caller should spawn.
    pub async fn tick_queue(&self) -> Vec<String> {
        let mut inner = self.inner.lock().await;
        let mut spawn = Vec::new();
        loop {
            if active_count(&inner.jobs) >= inner.max_concurrent {
                break;
            }
            let mut waiting: Vec<String> = inner
                .jobs
                .iter()
                .filter(|(_, job)| job.status == "waiting")
                .map(|(gid, _)| gid.clone())
                .collect();
            if waiting.is_empty() {
                break;
            }
            waiting.sort();
            let Some(gid) = waiting.into_iter().next() else {
                break;
            };
            if let Some(job) = inner.jobs.get_mut(&gid) {
                job.status = "active".into();
            }
            arm_run(&mut inner, &gid);
            spawn.push(gid);
        }
        spawn
    }
}

impl Default for HlsEngineState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{should_finish, token_bucket_charge, ByteRateLimiter, HlsEngineState};
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    fn sample_job(gid: &str) -> crate::hls::types::HlsJob {
        crate::hls::types::HlsJob {
            gid: gid.into(),
            playlist_url: "https://cdn.example/vod.m3u8".into(),
            dir: "downloads".into(),
            temp_dir: std::path::PathBuf::from("hls-temp"),
            ..crate::hls::types::HlsJob::default()
        }
    }

    #[tokio::test]
    async fn new_engine_is_empty_with_placeholder_concurrency() {
        let state = HlsEngineState::new();
        let inner = state.inner.lock().await;
        assert!(inner.jobs.is_empty());
        assert_eq!(inner.max_concurrent, 5);
    }

    #[tokio::test]
    async fn set_max_concurrent_updates_limit() {
        let state = HlsEngineState::new();
        state.set_max_concurrent(2).await;
        let inner = state.inner.lock().await;
        assert_eq!(inner.max_concurrent, 2);
    }

    #[tokio::test]
    async fn add_returns_true_when_under_capacity() {
        let state = HlsEngineState::new();
        {
            let mut inner = state.inner.lock().await;
            inner.max_concurrent = 1;
        }
        let spawn = state.add(sample_job("hls-a")).await;
        assert!(spawn);
        let inner = state.inner.lock().await;
        assert_eq!(inner.jobs["hls-a"].status, "active");
    }

    #[tokio::test]
    async fn add_forces_waiting_when_at_capacity() {
        let state = HlsEngineState::new();
        {
            let mut inner = state.inner.lock().await;
            inner.max_concurrent = 1;
        }
        assert!(state.add(sample_job("hls-a")).await);
        let spawn = state.add(sample_job("hls-b")).await;
        assert!(!spawn);
        let inner = state.inner.lock().await;
        assert_eq!(inner.jobs["hls-a"].status, "active");
        assert_eq!(inner.jobs["hls-b"].status, "waiting");
    }

    #[tokio::test]
    async fn pause_sets_paused_and_keeps_temp_dir() {
        let state = HlsEngineState::new();
        let mut job = sample_job("hls-a");
        job.temp_dir = std::path::PathBuf::from("keep-me");
        assert!(state.add(job).await);
        state.pause("hls-a").await.expect("pause");
        let inner = state.inner.lock().await;
        assert_eq!(inner.jobs["hls-a"].status, "paused");
        assert_eq!(
            inner.jobs["hls-a"].temp_dir,
            std::path::PathBuf::from("keep-me")
        );
    }

    #[tokio::test]
    async fn pause_cancels_in_flight_token() {
        let state = HlsEngineState::new();
        assert!(state.add(sample_job("hls-a")).await);
        let token = {
            let inner = state.inner.lock().await;
            inner
                .cancel_tokens
                .get("hls-a")
                .expect("token for active job")
                .clone()
        };
        assert!(!token.is_cancelled());
        state.pause("hls-a").await.expect("pause");
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn resume_uses_same_slot_rule() {
        let state = HlsEngineState::new();
        {
            let mut inner = state.inner.lock().await;
            inner.max_concurrent = 1;
        }
        assert!(state.add(sample_job("hls-a")).await);
        assert!(!state.add(sample_job("hls-b")).await);
        state.pause("hls-b").await.expect("pause waiting job");
        let spawn = state.resume("hls-b").await.expect("resume");
        assert!(!spawn, "no free slot, should wait");
        {
            let inner = state.inner.lock().await;
            assert_eq!(inner.jobs["hls-b"].status, "waiting");
        }
        state.pause("hls-a").await.expect("pause active");
        state.pause("hls-b").await.expect("pause waiting again");
        let spawn = state.resume("hls-b").await.expect("resume into slot");
        assert!(spawn);
        let inner = state.inner.lock().await;
        assert_eq!(inner.jobs["hls-b"].status, "active");
    }

    #[tokio::test]
    async fn remove_drops_from_map_and_can_delete_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = dir.path().join("tmp");
        std::fs::create_dir_all(&temp).expect("temp job dir");
        let output = dir.path().join("out.ts");
        std::fs::write(&output, b"x").expect("output file");
        let mut job = sample_job("hls-a");
        job.temp_dir = temp.clone();
        job.output_path = Some(output.to_string_lossy().into_owned());
        let state = HlsEngineState::new();
        assert!(state.add(job).await);
        state.remove("hls-a", true).await.expect("remove");
        let inner = state.inner.lock().await;
        assert!(!inner.jobs.contains_key("hls-a"));
        drop(inner);
        assert!(!temp.exists());
        assert!(!output.exists());
    }

    #[tokio::test]
    async fn remove_always_deletes_temp_dir_even_when_keeping_output() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = dir.path().join("tmp");
        std::fs::create_dir_all(&temp).expect("temp job dir");
        let output = dir.path().join("out.ts");
        std::fs::write(&output, b"x").expect("output file");
        let mut job = sample_job("hls-a");
        job.temp_dir = temp.clone();
        job.output_path = Some(output.to_string_lossy().into_owned());
        let state = HlsEngineState::new();
        assert!(state.add(job).await);
        state.remove("hls-a", false).await.expect("remove");
        assert!(!temp.exists());
        assert!(output.exists());
    }

    #[tokio::test]
    async fn tick_queue_promotes_waiting_up_to_max_concurrent() {
        let state = HlsEngineState::new();
        {
            let mut inner = state.inner.lock().await;
            inner.max_concurrent = 1;
        }
        assert!(state.add(sample_job("hls-a")).await);
        assert!(!state.add(sample_job("hls-b")).await);
        state.pause("hls-a").await.expect("pause");
        let spawned = state.tick_queue().await;
        assert_eq!(spawned, vec!["hls-b".to_string()]);
        let inner = state.inner.lock().await;
        assert_eq!(inner.jobs["hls-b"].status, "active");
        assert_eq!(inner.jobs["hls-a"].status, "paused");
    }

    #[test]
    fn token_bucket_charge_overshoots_when_bytes_exceed_rate() {
        let charged = token_bucket_charge(1_048_576.0, 1_048_576, 2_000_000);
        assert!(
            matches!(charged, Ok(remaining) if remaining < 0.0),
            "2MB under a 1MB/s cap must charge immediately (tokens may go negative), got {charged:?}"
        );
    }

    #[tokio::test]
    async fn consume_returns_when_segment_exceeds_tokens_per_sec() {
        let limiter = ByteRateLimiter::new();
        limiter.set_rate(Some(1_048_576)).await;
        let token = CancellationToken::new();
        let result =
            tokio::time::timeout(Duration::from_secs(1), limiter.consume(2_000_000, &token)).await;
        assert!(
            matches!(result, Ok(Ok(()))),
            "consume(2_000_000) at 1048576 B/s must return without hanging, got {result:?}"
        );
    }

    #[test]
    fn stale_run_id_does_not_should_finish() {
        assert!(should_finish("active", 2, 2));
        assert!(
            !should_finish("active", 2, 1),
            "run_id mismatch must not finish/delete temp"
        );
        assert!(!should_finish("paused", 1, 1));
    }

    #[tokio::test]
    async fn resume_bumps_run_id_so_old_run_should_not_finish() {
        let state = HlsEngineState::new();
        assert!(state.add(sample_job("hls-a")).await);
        let captured = {
            let inner = state.inner.lock().await;
            *inner.run_ids.get("hls-a").expect("run_id after add")
        };
        state.pause("hls-a").await.expect("pause");
        assert!(state.resume("hls-a").await.expect("resume"));
        let current = {
            let inner = state.inner.lock().await;
            *inner.run_ids.get("hls-a").expect("run_id after resume")
        };
        assert_ne!(captured, current);
        assert!(!should_finish("active", current, captured));
    }

    #[tokio::test]
    async fn restore_jobs_preserves_status_and_returns_active_gids() {
        let state = HlsEngineState::new();
        let mut active = sample_job("hls-a");
        active.status = "active".into();
        let mut paused = sample_job("hls-p");
        paused.status = "paused".into();
        let spawn = state.restore_jobs(vec![active, paused]).await;
        assert_eq!(spawn, vec!["hls-a".to_string()]);
        let inner = state.inner.lock().await;
        assert_eq!(inner.jobs["hls-a"].status, "active");
        assert_eq!(inner.jobs["hls-p"].status, "paused");
        assert!(inner.cancel_tokens.contains_key("hls-a"));
        assert!(!inner.cancel_tokens.contains_key("hls-p"));
    }
}
