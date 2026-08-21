use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderName, HeaderValue, RANGE};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::commands::http_client::apply_explicit_proxy;
use crate::error::AppError;
use crate::hls::decrypt::decrypt_aes128;
use crate::hls::engine::{should_finish, HlsEngineState};
use crate::hls::ffmpeg::{build_concat_protocol_list, build_ts_remux_args, resolve_ffmpeg_path};
use crate::hls::key::default_iv;
use crate::hls::map_task::{job_to_aria2_task, output_stem, resolved_out};
use crate::hls::merge::{concat_files, partial_combine};
use crate::hls::parser::{
    parse_playlist, select_best_variant, InitSegment, MediaSegment, ParsedMedia, ParsedPlaylist,
};
use crate::hls::types::{EncryptInfo, HlsEncryptMethod, HlsMediaKind, HlsPhase};
use crate::services::config::RuntimeConfigState;
use crate::services::monitor::{events, persist_and_emit_task_event, TaskEvent};

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const RETRY_ATTEMPTS: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const PARTIAL_COMBINE_THRESHOLD: usize = 1800;
const PARTIAL_COMBINE_CHUNK: usize = 100;
const LIVE_NOT_SUPPORTED: &str = "live-not-supported";
const INVALID_PLAYLIST: &str = "invalid-playlist";

#[derive(Debug)]
enum RunError {
    Cancelled,
    Failed(AppError),
}

struct Clip {
    index: i64,
    url: String,
    start_range: Option<u64>,
    expect_length: Option<u64>,
    encrypt: EncryptInfo,
    path: PathBuf,
}

struct SpeedMeter {
    start: Instant,
    bytes: u64,
}

impl SpeedMeter {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            bytes: 0,
        }
    }

    fn add(&mut self, nbytes: u64) -> u64 {
        self.bytes = self.bytes.saturating_add(nbytes);
        let secs = self.start.elapsed().as_secs_f64().max(0.001);
        (self.bytes as f64 / secs) as u64
    }
}

fn hls_err(code: &str) -> AppError {
    AppError::Hls(code.into())
}

fn map_http(err: reqwest::Error) -> AppError {
    AppError::Hls(err.to_string())
}

fn job_error_message(err: &AppError) -> String {
    match err {
        AppError::Hls(msg) | AppError::Io(msg) => msg.clone(),
        other => other.to_string(),
    }
}

/// Skip a segment file that already exists with a usable size.
///
/// True when the path exists, length > 0, and `expect_len` is `None` or equals
/// the file length (resume / skip already-written decrypted bytes).
pub fn should_skip_segment(path: &Path, expect_len: Option<u64>) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let len = meta.len();
    if len == 0 {
        return false;
    }
    match expect_len {
        None => true,
        Some(expected) => expected == len,
    }
}

/// Parse an aria2-style overall download limit into bytes per second.
///
/// `"0"` / empty → unlimited (`None`). Bare numbers are bytes. `K`/`M`/`G`
/// are 1024-based (`1K` = 1024, `1M` = 1048576, `1G` = 1024³).
pub fn parse_overall_limit(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "0" {
        return None;
    }
    let (num_part, multiplier) = match trimmed.as_bytes().last() {
        Some(b'K' | b'k') => (&trimmed[..trimmed.len() - 1], 1024u64),
        Some(b'M' | b'm') => (&trimmed[..trimmed.len() - 1], 1024 * 1024),
        Some(b'G' | b'g') => (&trimmed[..trimmed.len() - 1], 1024 * 1024 * 1024),
        _ => (trimmed, 1u64),
    };
    let num_part = num_part.trim();
    if num_part.is_empty() {
        return None;
    }
    let n: u64 = num_part.parse().ok()?;
    if n == 0 {
        return None;
    }
    n.checked_mul(multiplier)
}

fn index_width(indices: impl Iterator<Item = i64>) -> usize {
    indices
        .map(|index| index.to_string().len())
        .max()
        .unwrap_or(1)
}

fn clip_file_name(index: i64, width: usize) -> String {
    format!("{index:0width$}")
}

/// Dedicated init name so `#EXT-X-MAP` cannot collide with `MEDIA-SEQUENCE` 0.
const INIT_CLIP_FILE_NAME: &str = "init";

fn concat_paths(clips: &[Clip]) -> Vec<PathBuf> {
    clips.iter().map(|clip| clip.path.clone()).collect()
}

fn part_path(path: &Path) -> PathBuf {
    let mut raw = path.as_os_str().to_os_string();
    raw.push(".part");
    PathBuf::from(raw)
}

fn apply_job_headers(
    mut req: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        match (
            HeaderName::try_from(name.as_str()),
            HeaderValue::try_from(value),
        ) {
            (Ok(header_name), Ok(header_value)) => {
                req = req.header(header_name, header_value);
            }
            _ => log::warn!("hls: skipping invalid header {name}"),
        }
    }
    req
}

fn build_client(proxy: &Option<String>) -> Result<reqwest::Client, AppError> {
    let builder = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10));
    apply_explicit_proxy(builder, proxy, "hls")
        .build()
        .map_err(map_http)
}

fn check_status(status: reqwest::StatusCode) -> Result<(), AppError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(AppError::Hls(format!("HTTP {status}")))
    }
}

async fn http_get_bytes_inner(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    range: Option<(u64, Option<u64>)>,
) -> Result<Vec<u8>, AppError> {
    let mut req = apply_job_headers(client.get(url), headers);
    if let Some((start, length)) = range {
        let value = match length {
            Some(len) if len > 0 => {
                format!(
                    "bytes={start}-{}",
                    start.saturating_add(len.saturating_sub(1))
                )
            }
            _ => format!("bytes={start}-"),
        };
        req = req.header(RANGE, value);
    }
    let response = req.send().await.map_err(map_http)?;
    check_status(response.status())?;
    let bytes = response.bytes().await.map_err(map_http)?;
    Ok(bytes.to_vec())
}

async fn http_get_bytes(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    range: Option<(u64, Option<u64>)>,
    token: &CancellationToken,
) -> Result<Vec<u8>, RunError> {
    tokio::select! {
        () = token.cancelled() => Err(RunError::Cancelled),
        result = http_get_bytes_inner(client, url, headers, range) => {
            result.map_err(RunError::Failed)
        }
    }
}

async fn http_get_text(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    token: &CancellationToken,
) -> Result<String, RunError> {
    let bytes = fetch_with_retry(client, url, headers, None, token).await?;
    String::from_utf8(bytes).map_err(|_| RunError::Failed(hls_err(INVALID_PLAYLIST)))
}

async fn fetch_with_retry(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    range: Option<(u64, Option<u64>)>,
    token: &CancellationToken,
) -> Result<Vec<u8>, RunError> {
    let mut last_err = hls_err("download failed");
    for attempt in 0..RETRY_ATTEMPTS {
        if token.is_cancelled() {
            return Err(RunError::Cancelled);
        }
        match http_get_bytes(client, url, headers, range, token).await {
            Ok(bytes) => return Ok(bytes),
            Err(RunError::Cancelled) => return Err(RunError::Cancelled),
            Err(RunError::Failed(err)) => {
                last_err = err;
                if attempt + 1 < RETRY_ATTEMPTS {
                    tokio::select! {
                        () = token.cancelled() => return Err(RunError::Cancelled),
                        () = tokio::time::sleep(RETRY_DELAY) => {}
                    }
                }
            }
        }
    }
    Err(RunError::Failed(last_err))
}

fn decrypt_bytes(
    data: Vec<u8>,
    encrypt: &EncryptInfo,
    index: i64,
    keys: &HashMap<String, Vec<u8>>,
) -> Result<Vec<u8>, AppError> {
    match encrypt.method {
        HlsEncryptMethod::None => Ok(data),
        HlsEncryptMethod::Aes128 | HlsEncryptMethod::Aes128Ecb => {
            let key = if let Some(key) = &encrypt.key {
                key.clone()
            } else if let Some(uri) = &encrypt.key_uri {
                keys.get(uri)
                    .cloned()
                    .ok_or_else(|| hls_err(INVALID_PLAYLIST))?
            } else {
                return Err(hls_err(INVALID_PLAYLIST));
            };
            let iv = encrypt.iv.unwrap_or_else(|| default_iv(index));
            let ecb = encrypt.method == HlsEncryptMethod::Aes128Ecb;
            decrypt_aes128(&data, &key, &iv, ecb)
        }
    }
}

fn collect_key_uris(media: &ParsedMedia) -> Vec<String> {
    let mut uris = Vec::new();
    let mut push = |info: &EncryptInfo| {
        if let Some(uri) = &info.key_uri {
            if !uris.iter().any(|existing| existing == uri) {
                uris.push(uri.clone());
            }
        }
    };
    if let Some(init) = &media.init {
        push(&init.encrypt);
    }
    for segment in &media.segments {
        push(&segment.encrypt);
    }
    uris
}

async fn fetch_keys(
    client: &reqwest::Client,
    headers: &[(String, String)],
    media: &ParsedMedia,
    token: &CancellationToken,
) -> Result<HashMap<String, Vec<u8>>, RunError> {
    let mut keys = HashMap::new();
    for uri in collect_key_uris(media) {
        let bytes = fetch_with_retry(client, &uri, headers, None, token).await?;
        keys.insert(uri, bytes);
    }
    Ok(keys)
}

async fn snapshot_runtime(app: &AppHandle) -> crate::services::config::RuntimeConfig {
    match app.try_state::<RuntimeConfigState>() {
        Some(state) => state.snapshot().await,
        None => crate::services::config::RuntimeConfig::default(),
    }
}

async fn sync_limiter(app: &AppHandle, state: &HlsEngineState) {
    let cfg = snapshot_runtime(app).await;
    let rate = if cfg.speed_limit_enabled {
        parse_overall_limit(&cfg.max_overall_download_limit)
    } else {
        None
    };
    state.limiter.set_rate(rate).await;
}

async fn load_active_job(
    state: &HlsEngineState,
    gid: &str,
) -> Result<(crate::hls::types::HlsJob, CancellationToken, u64), RunError> {
    let inner = state.inner.lock().await;
    let Some(job) = inner.jobs.get(gid).cloned() else {
        return Err(RunError::Cancelled);
    };
    if job.status != "active" {
        return Err(RunError::Cancelled);
    }
    let Some(token) = inner.cancel_tokens.get(gid).cloned() else {
        return Err(RunError::Cancelled);
    };
    if token.is_cancelled() {
        return Err(RunError::Cancelled);
    }
    let run_id = inner.run_ids.get(gid).copied().unwrap_or(0);
    Ok((job, token, run_id))
}

async fn run_is_current(state: &HlsEngineState, gid: &str, run_id: u64) -> bool {
    let inner = state.inner.lock().await;
    inner.jobs.get(gid).is_some_and(|job| {
        should_finish(
            &job.status,
            inner.run_ids.get(gid).copied().unwrap_or(0),
            run_id,
        )
    })
}

async fn patch_job<F>(state: &HlsEngineState, gid: &str, patch: F)
where
    F: FnOnce(&mut crate::hls::types::HlsJob),
{
    let mut inner = state.inner.lock().await;
    if let Some(job) = inner.jobs.get_mut(gid) {
        patch(job);
    }
}

/// Apply `patch` only when this captured run still owns the active job.
async fn patch_job_if_current<F>(state: &HlsEngineState, gid: &str, run_id: u64, patch: F)
where
    F: FnOnce(&mut crate::hls::types::HlsJob),
{
    let mut inner = state.inner.lock().await;
    let current_run_id = inner.run_ids.get(gid).copied().unwrap_or(0);
    if let Some(job) = inner.jobs.get_mut(gid) {
        if should_finish(&job.status, current_run_id, run_id) {
            patch(job);
        }
    }
}

async fn bump_progress(
    state: &HlsEngineState,
    gid: &str,
    bytes: u64,
    meter: &Mutex<SpeedMeter>,
    known_total: u64,
) {
    let speed = {
        let mut meter = meter.lock().await;
        meter.add(bytes)
    };
    patch_job(state, gid, |job| {
        job.completed_length = job.completed_length.saturating_add(bytes);
        job.segment_count = job.segment_count.saturating_add(1);
        job.download_speed = speed;
        job.total_length = progress_total_length(
            job.completed_length,
            job.segment_count,
            job.segment_total,
            known_total,
        );
    })
    .await;
}

/// Byte total reported to the task list progress bar.
///
/// Known BYTERANGE sums are kept (lifted only if completed exceeds them).
/// Unknown sizes are estimated as `completed * segment_total / segment_count`,
/// matching N_m3u8DL-RE — never collapse total to completed after the first clip.
fn progress_total_length(
    completed_length: u64,
    segment_count: u32,
    segment_total: u32,
    known_total: u64,
) -> u64 {
    if known_total > 0 {
        return known_total.max(completed_length);
    }
    if segment_count == 0 || segment_total == 0 {
        return completed_length;
    }
    completed_length.saturating_mul(u64::from(segment_total)) / u64::from(segment_count)
}

fn estimate_total(init: Option<&InitSegment>, segments: &[MediaSegment]) -> u64 {
    let mut total = 0u64;
    let mut unknown = false;
    if let Some(init) = init {
        match init.expect_length {
            Some(len) => total = total.saturating_add(len),
            None => unknown = true,
        }
    }
    for segment in segments {
        match segment.expect_length {
            Some(len) => total = total.saturating_add(len),
            None => unknown = true,
        }
    }
    if unknown {
        0
    } else {
        total
    }
}

fn build_clips(media: &ParsedMedia, temp_dir: &Path) -> Vec<Clip> {
    let width = index_width(media.segments.iter().map(|segment| segment.index));
    let mut clips = Vec::new();
    if let Some(init) = &media.init {
        clips.push(Clip {
            index: i64::from(init.index),
            url: init.url.clone(),
            start_range: init.start_range,
            expect_length: init.expect_length,
            encrypt: init.encrypt.clone(),
            path: temp_dir.join(INIT_CLIP_FILE_NAME),
        });
    }
    for segment in &media.segments {
        clips.push(Clip {
            index: segment.index,
            url: segment.url.clone(),
            start_range: segment.start_range,
            expect_length: segment.expect_length,
            encrypt: segment.encrypt.clone(),
            path: temp_dir.join(clip_file_name(segment.index, width)),
        });
    }
    clips
}

fn range_of(clip: &Clip) -> Option<(u64, Option<u64>)> {
    clip.start_range.map(|start| (start, clip.expect_length))
}

async fn write_clip(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let tmp = part_path(path);
    if let Some(parent) = tmp.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| AppError::Hls(err.to_string()))?;
    }
    tokio::fs::write(&tmp, bytes)
        .await
        .map_err(|err| AppError::Hls(err.to_string()))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|err| AppError::Hls(err.to_string()))
}

struct ClipSession {
    client: reqwest::Client,
    headers: Arc<Vec<(String, String)>>,
    keys: Arc<HashMap<String, Vec<u8>>>,
    token: CancellationToken,
    state: Arc<HlsEngineState>,
    gid: String,
    meter: Arc<Mutex<SpeedMeter>>,
    known_total: u64,
}

async fn download_clip(session: &ClipSession, clip: &Clip) -> Result<(), RunError> {
    let skip_len = match clip.encrypt.method {
        HlsEncryptMethod::None => clip.expect_length,
        _ => None,
    };
    if should_skip_segment(&clip.path, skip_len) {
        let len = tokio::fs::metadata(&clip.path)
            .await
            .map_err(|err| RunError::Failed(AppError::Hls(err.to_string())))?
            .len();
        bump_progress(
            &session.state,
            &session.gid,
            len,
            &session.meter,
            session.known_total,
        )
        .await;
        return Ok(());
    }

    let range = range_of(clip);
    let raw = fetch_with_retry(
        &session.client,
        &clip.url,
        &session.headers,
        range,
        &session.token,
    )
    .await?;
    if session
        .state
        .limiter
        .consume(raw.len() as u64, &session.token)
        .await
        .is_err()
    {
        return Err(RunError::Cancelled);
    }
    let decrypted =
        decrypt_bytes(raw, &clip.encrypt, clip.index, &session.keys).map_err(RunError::Failed)?;
    let written = decrypted.len() as u64;
    write_clip(&clip.path, &decrypted)
        .await
        .map_err(RunError::Failed)?;
    bump_progress(
        &session.state,
        &session.gid,
        written,
        &session.meter,
        session.known_total,
    )
    .await;
    Ok(())
}

async fn parse_media_playlist(
    client: &reqwest::Client,
    playlist_url: &str,
    headers: &[(String, String)],
    token: &CancellationToken,
) -> Result<ParsedMedia, RunError> {
    let text = http_get_text(client, playlist_url, headers, token).await?;
    let parsed = parse_playlist(&text, playlist_url).map_err(RunError::Failed)?;
    match parsed {
        ParsedPlaylist::Media(media) => {
            if !media.is_vod {
                return Err(RunError::Failed(hls_err(LIVE_NOT_SUPPORTED)));
            }
            Ok(media)
        }
        ParsedPlaylist::Master { variants } => {
            let best = select_best_variant(&variants)
                .ok_or_else(|| RunError::Failed(hls_err(INVALID_PLAYLIST)))?;
            let text = http_get_text(client, &best.url, headers, token).await?;
            match parse_playlist(&text, &best.url).map_err(RunError::Failed)? {
                ParsedPlaylist::Media(media) => {
                    if !media.is_vod {
                        return Err(RunError::Failed(hls_err(LIVE_NOT_SUPPORTED)));
                    }
                    Ok(media)
                }
                ParsedPlaylist::Master { .. } => Err(RunError::Failed(hls_err(INVALID_PLAYLIST))),
            }
        }
    }
}

fn encrypt_of(media: &ParsedMedia) -> HlsEncryptMethod {
    media
        .segments
        .first()
        .map(|segment| segment.encrypt.method)
        .or_else(|| media.init.as_ref().map(|init| init.encrypt.method))
        .unwrap_or(HlsEncryptMethod::None)
}

struct ClipBatch {
    app: AppHandle,
    state: Arc<HlsEngineState>,
    gid: String,
    client: reqwest::Client,
    headers: Arc<Vec<(String, String)>>,
    keys: Arc<HashMap<String, Vec<u8>>>,
    token: CancellationToken,
    split: u32,
    known_total: u64,
}

async fn download_all_clips(batch: ClipBatch, clips: Vec<Clip>) -> Result<(), RunError> {
    let semaphore = Arc::new(Semaphore::new(batch.split.clamp(1, 64) as usize));
    let meter = Arc::new(Mutex::new(SpeedMeter::new()));
    let mut join = JoinSet::new();
    for clip in clips {
        let sem = Arc::clone(&semaphore);
        let app = batch.app.clone();
        let session = ClipSession {
            client: batch.client.clone(),
            headers: Arc::clone(&batch.headers),
            keys: Arc::clone(&batch.keys),
            token: batch.token.clone(),
            state: Arc::clone(&batch.state),
            gid: batch.gid.clone(),
            meter: Arc::clone(&meter),
            known_total: batch.known_total,
        };
        join.spawn(async move {
            let _permit = match sem.acquire().await {
                Ok(permit) => permit,
                Err(_) => return Err(RunError::Cancelled),
            };
            if session.token.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            sync_limiter(&app, &session.state).await;
            download_clip(&session, &clip).await
        });
    }

    let mut first_err: Option<RunError> = None;
    while let Some(joined) = join.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                if first_err.is_none() {
                    first_err = Some(err);
                    join.abort_all();
                }
            }
            Err(join_err) => {
                if join_err.is_cancelled() {
                    continue;
                }
                if first_err.is_none() {
                    first_err = Some(RunError::Failed(AppError::Hls(join_err.to_string())));
                    join.abort_all();
                }
            }
        }
    }
    match first_err {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

async fn run_ffmpeg_remux(
    ffmpeg: &Path,
    concat_list: &str,
    output: &Path,
    cwd: &Path,
) -> Result<(), AppError> {
    let args = build_ts_remux_args(concat_list, output);
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(&args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd
        .output()
        .await
        .map_err(|err| AppError::Hls(err.to_string()))?;
    if child.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&child.stderr);
        Err(AppError::Hls(format!("ffmpeg remux failed: {stderr}")))
    }
}

async fn maybe_remux_mpegts(
    ffmpeg: Option<PathBuf>,
    segment_paths: &[PathBuf],
    ts_path: &Path,
    mp4_path: &Path,
    temp_dir: &Path,
) -> Option<PathBuf> {
    let ffmpeg = ffmpeg?;
    let remux_inputs = if segment_paths.len() >= PARTIAL_COMBINE_THRESHOLD {
        match partial_combine(segment_paths, temp_dir, PARTIAL_COMBINE_CHUNK) {
            Ok(parts) => parts,
            Err(err) => {
                log::warn!(
                    "hls: partial_combine failed ({err}); keeping {}",
                    ts_path.display()
                );
                return Some(ts_path.to_path_buf());
            }
        }
    } else {
        segment_paths.to_vec()
    };
    let concat_list = build_concat_protocol_list(&remux_inputs);
    let cwd = remux_inputs
        .first()
        .and_then(|path| path.parent())
        .unwrap_or(temp_dir);
    match run_ffmpeg_remux(&ffmpeg, &concat_list, mp4_path, cwd).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(ts_path).await;
            None
        }
        Err(err) => {
            log::warn!("hls: remux failed ({err}); keeping {}", ts_path.display());
            Some(ts_path.to_path_buf())
        }
    }
}

async fn mark_error_if_current(state: &HlsEngineState, gid: &str, run_id: u64, err: &AppError) {
    patch_job_if_current(state, gid, run_id, |job| {
        job.status = "error".into();
        job.error_message = Some(job_error_message(err));
        job.download_speed = 0;
    })
    .await;
}

async fn emit_hls_lifecycle(app: &AppHandle, state: &HlsEngineState, gid: &str, event_name: &str) {
    let Some(job) = state.get_job(gid).await else {
        return;
    };
    let expected_status = match event_name {
        events::TASK_COMPLETE => "complete",
        events::TASK_ERROR => "error",
        _ => return,
    };
    if job.status != expected_status {
        return;
    }
    let event = TaskEvent::from_aria2(&job_to_aria2_task(&job));
    persist_and_emit_task_event(app, event_name, event).await;
}

async fn run_job_inner(
    app: AppHandle,
    state: Arc<HlsEngineState>,
    gid: String,
    captured_run_id: &mut u64,
) -> Result<(), RunError> {
    let (job, token, run_id) = load_active_job(&state, &gid).await?;
    *captured_run_id = run_id;
    sync_limiter(&app, &state).await;
    let client = build_client(&job.proxy).map_err(RunError::Failed)?;
    let headers = Arc::new(job.headers.clone());

    let media = parse_media_playlist(&client, &job.playlist_url, &headers, &token).await?;
    if media.segments.is_empty() && media.init.is_none() {
        return Err(RunError::Failed(hls_err(INVALID_PLAYLIST)));
    }

    let media_kind = if media.init.is_some() {
        HlsMediaKind::Fmp4
    } else {
        HlsMediaKind::Mpegts
    };
    let encrypt_method = encrypt_of(&media);
    let segment_total = media.segments.len() as u32 + u32::from(media.init.is_some());
    let total_length = estimate_total(media.init.as_ref(), &media.segments);
    let display_out = resolved_out(&job.out, &job.playlist_url, media_kind);
    patch_job_if_current(&state, &gid, run_id, |job| {
        job.media_kind = media_kind;
        job.encrypt_method = encrypt_method;
        job.phase = HlsPhase::Download;
        job.segment_total = segment_total;
        job.segment_count = 0;
        job.completed_length = 0;
        job.total_length = total_length;
        job.out = display_out;
        job.error_message = None;
    })
    .await;

    tokio::fs::create_dir_all(&job.temp_dir)
        .await
        .map_err(|err| RunError::Failed(AppError::Hls(err.to_string())))?;
    if !job.dir.is_empty() {
        tokio::fs::create_dir_all(&job.dir)
            .await
            .map_err(|err| RunError::Failed(AppError::Hls(err.to_string())))?;
    }

    let keys = Arc::new(fetch_keys(&client, &headers, &media, &token).await?);
    let clips = build_clips(&media, &job.temp_dir);
    let ordered_paths = concat_paths(&clips);
    let segment_paths: Vec<PathBuf> = if media.init.is_some() {
        clips.iter().skip(1).map(|clip| clip.path.clone()).collect()
    } else {
        ordered_paths.clone()
    };

    download_all_clips(
        ClipBatch {
            app: app.clone(),
            state: Arc::clone(&state),
            gid: gid.clone(),
            client: client.clone(),
            headers,
            keys,
            token: token.clone(),
            split: job.split,
            known_total: total_length,
        },
        clips,
    )
    .await?;

    if token.is_cancelled() || !run_is_current(&state, &gid, run_id).await {
        return Err(RunError::Cancelled);
    }

    let stem = output_stem(&job.out, &job.playlist_url);
    let ext = match media_kind {
        HlsMediaKind::Fmp4 => "mp4",
        HlsMediaKind::Mpegts => "ts",
    };
    let concat_output = Path::new(&job.dir).join(format!("{stem}.{ext}"));
    if matches!(tokio::fs::try_exists(&concat_output).await, Ok(true)) {
        tokio::fs::remove_file(&concat_output)
            .await
            .map_err(|err| RunError::Failed(AppError::Hls(err.to_string())))?;
    }

    patch_job_if_current(&state, &gid, run_id, |job| {
        job.phase = HlsPhase::Merge;
        job.download_speed = 0;
    })
    .await;
    concat_files(&ordered_paths, &concat_output)
        .await
        .map_err(RunError::Failed)?;

    let mut output_path = concat_output.clone();
    let mut fallback_ts_path = None;
    if media_kind == HlsMediaKind::Mpegts {
        let cfg = snapshot_runtime(&app).await;
        let ffmpeg = resolve_ffmpeg_path(&cfg.ffmpeg_binary_path);
        if ffmpeg.is_some() {
            patch_job_if_current(&state, &gid, run_id, |job| job.phase = HlsPhase::Remux).await;
            let mp4_path = Path::new(&job.dir).join(format!("{stem}.mp4"));
            fallback_ts_path = maybe_remux_mpegts(
                ffmpeg,
                &segment_paths,
                &concat_output,
                &mp4_path,
                &job.temp_dir,
            )
            .await;
            if fallback_ts_path.is_none() {
                output_path = mp4_path;
            }
        }
    }

    let output_path_str = output_path.to_string_lossy().into_owned();
    let fallback_str = fallback_ts_path
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    let completed_length = tokio::fs::metadata(&output_path)
        .await
        .map(|meta| meta.len())
        .unwrap_or(0);

    let should_finish_run = run_is_current(&state, &gid, run_id).await;
    if !should_finish_run {
        return Err(RunError::Cancelled);
    }

    if let Err(err) = tokio::fs::remove_dir_all(&job.temp_dir).await {
        log::warn!(
            "hls: failed to delete temp dir {}: {err}",
            job.temp_dir.display()
        );
    }

    let marked_complete = {
        let mut inner = state.inner.lock().await;
        let current_run_id = inner.run_ids.get(&gid).copied().unwrap_or(0);
        match inner.jobs.get_mut(&gid) {
            Some(job) if should_finish(&job.status, current_run_id, run_id) => {
                job.status = "complete".into();
                job.phase = HlsPhase::Merge;
                job.output_path = Some(output_path_str.clone());
                job.fallback_ts_path = fallback_str.clone();
                job.completed_length = completed_length;
                job.total_length = completed_length.max(job.total_length);
                job.segment_count = job.segment_total;
                job.download_speed = 0;
                job.error_message = None;
                true
            }
            _ => false,
        }
    };
    if !marked_complete {
        return Err(RunError::Cancelled);
    }

    log::info!("hls job {gid} complete: {output_path_str}");
    emit_hls_lifecycle(&app, &state, &gid, events::TASK_COMPLETE).await;
    Ok(())
}

/// Download, decrypt, concat, and optionally remux one HLS job.
pub async fn run_job(
    app: AppHandle,
    state: Arc<HlsEngineState>,
    gid: String,
) -> Result<(), AppError> {
    let mut captured_run_id = 0u64;
    match run_job_inner(
        app.clone(),
        state.clone(),
        gid.clone(),
        &mut captured_run_id,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(RunError::Cancelled) => Ok(()),
        Err(RunError::Failed(err)) => {
            mark_error_if_current(&state, &gid, captured_run_id, &err).await;
            emit_hls_lifecycle(&app, &state, &gid, events::TASK_ERROR).await;
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_clips, concat_paths, estimate_total, parse_overall_limit, progress_total_length,
        should_skip_segment,
    };
    use crate::hls::map_task::output_stem;
    use crate::hls::parser::{parse_playlist, ParsedPlaylist};
    use std::fs;
    use std::path::PathBuf;

    fn temp_file(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("000.ts");
        fs::write(&path, bytes).expect("write fixture");
        (dir, path)
    }

    #[test]
    fn skip_requires_existing_nonzero_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("missing.ts");
        assert!(!should_skip_segment(&missing, None));

        let (_dir, empty) = temp_file(b"");
        assert!(!should_skip_segment(&empty, None));

        let (_dir, present) = temp_file(b"abc");
        assert!(should_skip_segment(&present, None));
    }

    #[test]
    fn skip_matches_expect_len_when_provided() {
        let (_dir, path) = temp_file(b"abcd");
        assert!(should_skip_segment(&path, Some(4)));
        assert!(!should_skip_segment(&path, Some(3)));
        assert!(!should_skip_segment(&path, Some(5)));
    }

    #[test]
    fn parse_overall_limit_bytes_and_sia_suffixes() {
        assert_eq!(parse_overall_limit("1048576"), Some(1_048_576));
        assert_eq!(parse_overall_limit("1M"), Some(1_048_576));
        assert_eq!(parse_overall_limit("1K"), Some(1024));
        assert_eq!(parse_overall_limit("1G"), Some(1024 * 1024 * 1024));
        assert_eq!(parse_overall_limit("0"), None);
        assert_eq!(parse_overall_limit(""), None);
    }

    #[test]
    fn estimate_total_is_zero_without_byterange() {
        let text = "\
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
a.ts
#EXTINF:4.0,
b.ts
#EXTINF:4.0,
c.ts
#EXT-X-ENDLIST
";
        let parsed = parse_playlist(text, "https://ex.com/vod.m3u8").expect("vod playlist");
        let ParsedPlaylist::Media(media) = parsed else {
            panic!("expected media playlist");
        };
        assert_eq!(estimate_total(media.init.as_ref(), &media.segments), 0);
    }

    #[test]
    fn estimate_total_sums_known_byterange() {
        let text = "\
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@0
clip.bin
#EXTINF:4.0,
#EXT-X-BYTERANGE:1500@1000
clip.bin
#EXT-X-ENDLIST
";
        let parsed = parse_playlist(text, "https://ex.com/vod.m3u8").expect("vod playlist");
        let ParsedPlaylist::Media(media) = parsed else {
            panic!("expected media playlist");
        };
        assert_eq!(estimate_total(media.init.as_ref(), &media.segments), 2500);
    }

    #[test]
    fn unknown_size_progress_is_not_full_after_first_clip() {
        // Typical HLS: no BYTERANGE, first of 100 clips written.
        // Lifting total to completed would report 100% immediately.
        let completed = 4096u64;
        let total = progress_total_length(completed, 1, 100, 0);
        assert!(
            total > completed,
            "unknown-size total must stay ahead of completed, got {total}"
        );
        assert_eq!(total, 409_600);
        let pct = (completed as f64 / total as f64) * 100.0;
        assert!(pct < 2.0, "first clip of 100 must be ~1%, got {pct}");
    }

    #[test]
    fn unknown_size_progress_reaches_completed_when_all_clips_done() {
        assert_eq!(progress_total_length(50_000, 10, 10, 0), 50_000);
    }

    #[test]
    fn known_playlist_total_is_kept_until_completed_exceeds_it() {
        assert_eq!(progress_total_length(1_000, 1, 10, 50_000), 50_000);
        assert_eq!(progress_total_length(60_000, 10, 10, 50_000), 60_000);
    }

    #[test]
    fn output_stem_prefers_sanitized_out_then_url() {
        assert_eq!(output_stem("movie", "https://cdn.example/a.m3u8"), "movie");
        assert_eq!(
            output_stem("", "https://cdn.example/vod/show.m3u8?token=1"),
            "show"
        );
        assert_eq!(output_stem("", "https://cdn.example/"), "playlist");
    }

    #[test]
    fn fmp4_init_path_does_not_collide_with_media_sequence_zero() {
        let text = "\
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI=\"init.mp4\"
#EXTINF:4.0,
seg0.m4s
#EXT-X-ENDLIST
";
        let parsed = parse_playlist(text, "https://ex.com/p/index.m3u8").expect("vod playlist");
        let ParsedPlaylist::Media(media) = parsed else {
            panic!("expected media playlist");
        };
        assert_eq!(media.media_sequence, 0);
        assert_eq!(media.init.as_ref().expect("MAP").index, 0);
        assert_eq!(media.segments[0].index, 0);

        let dir = tempfile::tempdir().expect("tempdir");
        let clips = build_clips(&media, dir.path());
        let paths = concat_paths(&clips);
        assert_eq!(paths.len(), 2);
        assert_eq!(clips[0].url, media.init.as_ref().expect("MAP").url);
        assert_eq!(clips[1].url, media.segments[0].url);
        assert_ne!(
            paths[0], paths[1],
            "init and first media clip must not share a temp path"
        );
        assert_eq!(paths[0], clips[0].path);
        assert_eq!(paths[1], clips[1].path);
    }

    #[tokio::test]
    async fn stale_run_id_does_not_mark_error_or_complete() {
        use super::mark_error_if_current;
        use crate::error::AppError;
        use crate::hls::engine::{should_finish, HlsEngineState};
        use crate::hls::types::HlsJob;

        fn sample_job(gid: &str) -> HlsJob {
            HlsJob {
                gid: gid.into(),
                playlist_url: "https://cdn.example/vod.m3u8".into(),
                dir: "downloads".into(),
                temp_dir: std::path::PathBuf::from("hls-temp"),
                ..HlsJob::default()
            }
        }

        let state = HlsEngineState::new();
        assert!(state.add(sample_job("hls-a")).await);
        let stale = {
            let inner = state.inner.lock().await;
            *inner.run_ids.get("hls-a").expect("run_id after add")
        };
        state.pause("hls-a").await.expect("pause");
        assert!(state.resume("hls-a").await.expect("resume"));
        let current = {
            let inner = state.inner.lock().await;
            *inner.run_ids.get("hls-a").expect("run_id after resume")
        };
        assert_ne!(stale, current);
        assert!(
            !should_finish("active", current, stale),
            "superseded run must not finish/delete/emit"
        );

        mark_error_if_current(
            &state,
            "hls-a",
            stale,
            &AppError::Hls("stale failure".into()),
        )
        .await;

        let inner = state.inner.lock().await;
        assert_eq!(
            inner.jobs["hls-a"].status, "active",
            "stale run_id must not set status=error on resumed job"
        );
        assert!(inner.jobs["hls-a"].error_message.is_none());
    }

    #[tokio::test]
    async fn current_run_id_marks_error() {
        use super::mark_error_if_current;
        use crate::error::AppError;
        use crate::hls::engine::HlsEngineState;
        use crate::hls::types::HlsJob;

        fn sample_job(gid: &str) -> HlsJob {
            HlsJob {
                gid: gid.into(),
                playlist_url: "https://cdn.example/vod.m3u8".into(),
                dir: "downloads".into(),
                temp_dir: std::path::PathBuf::from("hls-temp"),
                ..HlsJob::default()
            }
        }

        let state = HlsEngineState::new();
        assert!(state.add(sample_job("hls-a")).await);
        let run_id = {
            let inner = state.inner.lock().await;
            *inner.run_ids.get("hls-a").expect("run_id")
        };

        mark_error_if_current(
            &state,
            "hls-a",
            run_id,
            &AppError::Hls("download failed".into()),
        )
        .await;

        let inner = state.inner.lock().await;
        assert_eq!(inner.jobs["hls-a"].status, "error");
        assert_eq!(
            inner.jobs["hls-a"].error_message.as_deref(),
            Some("download failed")
        );
    }
}
