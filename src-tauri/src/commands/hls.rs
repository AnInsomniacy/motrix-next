//! Tauri commands for the in-process HLS VOD engine.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

use crate::aria2::types::Aria2Task;
use crate::commands::aria2::sanitize_out_option;
use crate::commands::http_client::{apply_explicit_proxy, build_proxy_url_with_credentials};
use crate::error::AppError;
use crate::hls::detect::{is_hls_gid, is_hls_uri, new_hls_gid};
use crate::hls::download::run_job;
use crate::hls::engine::HlsEngineState;
use crate::hls::ffmpeg::FfmpegStatus;
use crate::hls::map_task::{job_to_aria2_task, resolved_out};
use crate::hls::parser::parse_playlist;
use crate::hls::session;
use crate::hls::types::{HlsJob, HlsMediaKind};
use crate::services::config::RuntimeConfigState;

const INVALID_PLAYLIST: &str = "invalid-playlist";
const DEFAULT_SPLIT: u32 = 16;
const MIN_SPLIT: u32 = 1;
const MAX_SPLIT: u32 = 64;
const DEFAULT_MAX_CONCURRENT: u32 = 5;
const PLAYLIST_TIMEOUT: Duration = Duration::from_secs(30);
const HLS_TEMP_DIR_NAME: &str = "motrix-hls";
const HLS_SESSION_FILE: &str = "hls-session.json";
const MERGE_WAIT_SECS: u64 = 10;
const EXIT_FLUSH_TIMEOUT_SECS: u64 = 12;
const FFMPEG_VERSION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedHlsAddOptions {
    dir: String,
    out: String,
    headers: Vec<(String, String)>,
    proxy: Option<String>,
    split: u32,
}

/// ffmpeg probe result for the settings UI.
#[derive(Debug, Clone, Serialize)]
pub struct FfmpegStatusDto {
    pub kind: String,
    pub path: Option<String>,
    pub version: Option<String>,
}

fn json_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn option_raw<'a>(options: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let obj = options.as_object()?;
    keys.iter().find_map(|key| obj.get(*key))
}

fn option_string(options: &Value, keys: &[&str]) -> Option<String> {
    let obj = options.as_object()?;
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(json_string) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn parse_header_line(line: &str) -> Option<(String, String)> {
    let (name, value) = line.split_once(':')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some((name.to_string(), value.trim().to_string()))
}

fn collect_header_option(options: &Value) -> Vec<(String, String)> {
    let Some(value) = option_raw(options, &["header"]) else {
        return Vec::new();
    };
    match value {
        Value::String(s) => s.lines().filter_map(parse_header_line).collect(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().and_then(parse_header_line))
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_u64_value(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(num)) => num
            .as_u64()
            .or_else(|| num.as_i64().map(|i| i.max(0) as u64)),
        Some(Value::String(s)) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn parse_split(options: &Value) -> u32 {
    parse_u64_value(option_raw(options, &["split"]))
        .unwrap_or(DEFAULT_SPLIT as u64)
        .clamp(MIN_SPLIT as u64, MAX_SPLIT as u64) as u32
}

fn parse_hls_add_options(options: &Value) -> ParsedHlsAddOptions {
    let dir = option_string(options, &["dir"]).unwrap_or_default();
    let out = option_string(options, &["out"])
        .and_then(|raw| sanitize_out_option(&raw))
        .unwrap_or_default();
    let mut headers = collect_header_option(options);
    if let Some(ua) = option_string(options, &["user-agent", "userAgent"]) {
        headers.push(("User-Agent".into(), ua));
    }
    if let Some(referer) = option_string(options, &["referer", "Referer"]) {
        headers.push(("Referer".into(), referer));
    }
    let proxy_server = option_string(options, &["all-proxy", "allProxy", "proxy"]);
    let proxy_user = option_string(options, &["all-proxy-user", "allProxyUser"]);
    let proxy_pass = option_string(options, &["all-proxy-passwd", "allProxyPasswd"]);
    let proxy = proxy_server.map(|server| {
        build_proxy_url_with_credentials(&server, proxy_user.as_deref(), proxy_pass.as_deref())
    });
    ParsedHlsAddOptions {
        dir,
        out,
        headers,
        proxy,
        split: parse_split(options),
    }
}

fn playlist_body_is_extm3u(body: &str) -> bool {
    body.trim_start_matches(|c: char| c == '\u{feff}' || c.is_whitespace())
        .starts_with("#EXTM3U")
}

fn parse_max_concurrent_pref(prefs: &Value) -> u32 {
    parse_u64_value(prefs.get("maxConcurrentDownloads"))
        .filter(|&value| value > 0)
        .map(|value| value as u32)
        .unwrap_or(DEFAULT_MAX_CONCURRENT)
}

fn parse_ffmpeg_version_line(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    let rest = line.strip_prefix("ffmpeg version ")?;
    let ver = rest.split_whitespace().next()?;
    Some(ver.to_string())
}

fn list_group_tasks(jobs: &[HlsJob], group: &str) -> Vec<Aria2Task> {
    if group != "active" {
        return Vec::new();
    }
    let mut tasks: Vec<Aria2Task> = jobs
        .iter()
        .filter(|job| matches!(job.status.as_str(), "active" | "waiting" | "paused"))
        .map(job_to_aria2_task)
        .collect();
    tasks.sort_by(|left, right| left.gid.cmp(&right.gid));
    tasks
}

fn apply_headers(
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

async fn fetch_playlist_text(
    url: &str,
    headers: &[(String, String)],
    proxy: &Option<String>,
) -> Result<String, AppError> {
    let builder = reqwest::Client::builder()
        .timeout(PLAYLIST_TIMEOUT)
        .connect_timeout(PLAYLIST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(10));
    let client = apply_explicit_proxy(builder, proxy, "hls")
        .build()
        .map_err(|err| AppError::Hls(err.to_string()))?;
    let response = apply_headers(client.get(url), headers)
        .send()
        .await
        .map_err(|err| AppError::Hls(err.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::Hls(format!("HTTP {}", response.status())));
    }
    response
        .text()
        .await
        .map_err(|err| AppError::Hls(err.to_string()))
}

fn hls_temp_root(app: &AppHandle) -> Result<PathBuf, AppError> {
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
            .map_err(|err| AppError::Io(err.to_string()))
    }
}

fn hls_job_temp_dir(app: &AppHandle, gid: &str) -> Result<PathBuf, AppError> {
    Ok(hls_temp_root(app)?.join(HLS_TEMP_DIR_NAME).join(gid))
}

fn hls_session_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(HLS_SESSION_FILE))
        .map_err(|err| AppError::Io(err.to_string()))
}

fn read_max_concurrent_from_app(app: &AppHandle) -> u32 {
    app.store("config.json")
        .ok()
        .and_then(|store| store.get("preferences"))
        .map(|prefs| parse_max_concurrent_pref(&prefs))
        .unwrap_or(DEFAULT_MAX_CONCURRENT)
}

fn spawn_run_job(app: AppHandle, state: Arc<HlsEngineState>, gid: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run_job(app, state, gid.clone()).await {
            log::error!("hls: run_job {gid} failed: {err}");
        }
    });
}

async fn spawn_added_and_queued(
    app: &AppHandle,
    state: &Arc<HlsEngineState>,
    spawn_gid: Option<String>,
) {
    if let Some(gid) = spawn_gid {
        spawn_run_job(app.clone(), Arc::clone(state), gid);
    }
    for gid in state.tick_queue().await {
        spawn_run_job(app.clone(), Arc::clone(state), gid);
    }
}

async fn probe_ffmpeg_version(path: &str) -> Option<String> {
    let path = path.to_string();
    let output = tokio::time::timeout(
        FFMPEG_VERSION_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let mut cmd = std::process::Command::new(&path);
            cmd.arg("-version");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            cmd.output()
        }),
    )
    .await
    .ok()?
    .ok()?
    .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_ffmpeg_version_line(&stdout)
}

/// Restore persisted HLS jobs after the download engine is ready.
pub(crate) async fn restore_hls_session(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<HlsEngineState>>() else {
        log::warn!("hls: HlsEngineState not available, skip session restore");
        return;
    };
    let engine = Arc::clone(&state);
    engine
        .set_max_concurrent(read_max_concurrent_from_app(app))
        .await;
    if !engine.snapshot_jobs().await.is_empty() {
        spawn_added_and_queued(app, &engine, None).await;
        return;
    }
    let path = match hls_session_path(app) {
        Ok(path) => path,
        Err(err) => {
            log::warn!("hls: session path: {err}");
            return;
        }
    };
    match session::load(&path) {
        Ok(jobs) => {
            let spawn = engine.restore_jobs(jobs).await;
            for gid in spawn {
                spawn_run_job(app.clone(), Arc::clone(&engine), gid);
            }
            spawn_added_and_queued(app, &engine, None).await;
        }
        Err(err) => log::warn!("hls: failed to load session: {err}"),
    }
}

/// Best-effort session flush on process exit. Times out rather than blocking forever.
pub(crate) fn flush_hls_session(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<HlsEngineState>>() else {
        return;
    };
    let engine = Arc::clone(&state);
    let path = match hls_session_path(app) {
        Ok(path) => path,
        Err(err) => {
            log::warn!("hls: session path: {err}");
            return;
        }
    };
    let _ = tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_secs(EXIT_FLUSH_TIMEOUT_SECS), async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(MERGE_WAIT_SECS);
            while engine.has_active_merge_or_remux().await {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            engine.pause_active_merge_or_remux().await;
            let jobs = engine.snapshot_jobs().await;
            if let Err(err) = session::save(&path, &jobs) {
                log::warn!("hls: failed to save session: {err}");
            }
        })
        .await
    });
}

#[tauri::command]
pub async fn hls_add(
    app: AppHandle,
    state: State<'_, Arc<HlsEngineState>>,
    url: String,
    options: Value,
) -> Result<String, AppError> {
    if !is_hls_uri(&url) {
        return Err(AppError::Hls(INVALID_PLAYLIST.into()));
    }
    let parsed = parse_hls_add_options(&options);
    let body = fetch_playlist_text(&url, &parsed.headers, &parsed.proxy).await?;
    if !playlist_body_is_extm3u(&body) {
        return Err(AppError::Hls(INVALID_PLAYLIST.into()));
    }
    parse_playlist(&body, &url)?;

    let engine = Arc::clone(&state);
    engine
        .set_max_concurrent(read_max_concurrent_from_app(&app))
        .await;

    let gid = new_hls_gid();
    let temp_dir = hls_job_temp_dir(&app, &gid)?;
    let out = if parsed.out.is_empty() {
        resolved_out("", &url, HlsMediaKind::Mpegts)
    } else {
        parsed.out
    };
    let job = HlsJob {
        gid: gid.clone(),
        playlist_url: url,
        dir: parsed.dir,
        out,
        headers: parsed.headers,
        proxy: parsed.proxy,
        temp_dir,
        split: parsed.split,
        ..HlsJob::default()
    };
    let should_spawn = engine.add(job).await;
    spawn_added_and_queued(&app, &engine, should_spawn.then_some(gid.clone())).await;
    Ok(gid)
}

#[tauri::command]
pub async fn hls_list(
    state: State<'_, Arc<HlsEngineState>>,
    group: String,
) -> Result<Vec<Aria2Task>, AppError> {
    let jobs = state.snapshot_jobs().await;
    Ok(list_group_tasks(&jobs, &group))
}

fn require_hls_gid(gid: &str) -> Result<(), AppError> {
    if is_hls_gid(gid) {
        Ok(())
    } else {
        Err(AppError::NotFound(gid.to_string()))
    }
}

#[tauri::command]
pub async fn hls_tell_status(
    state: State<'_, Arc<HlsEngineState>>,
    gid: String,
) -> Result<Aria2Task, AppError> {
    require_hls_gid(&gid)?;
    state
        .get_job(&gid)
        .await
        .map(|job| job_to_aria2_task(&job))
        .ok_or(AppError::NotFound(gid))
}

#[tauri::command]
pub async fn hls_pause(
    app: AppHandle,
    state: State<'_, Arc<HlsEngineState>>,
    gid: String,
) -> Result<String, AppError> {
    require_hls_gid(&gid)?;
    let engine = Arc::clone(&state);
    engine.pause(&gid).await?;
    spawn_added_and_queued(&app, &engine, None).await;
    Ok(gid)
}

#[tauri::command]
pub async fn hls_unpause(
    app: AppHandle,
    state: State<'_, Arc<HlsEngineState>>,
    gid: String,
) -> Result<String, AppError> {
    require_hls_gid(&gid)?;
    let engine = Arc::clone(&state);
    let should_spawn = engine.resume(&gid).await?;
    spawn_added_and_queued(&app, &engine, should_spawn.then_some(gid.clone())).await;
    Ok(gid)
}

#[tauri::command]
pub async fn hls_remove(
    app: AppHandle,
    state: State<'_, Arc<HlsEngineState>>,
    gid: String,
    delete_files: bool,
) -> Result<String, AppError> {
    require_hls_gid(&gid)?;
    let engine = Arc::clone(&state);
    engine.remove(&gid, delete_files).await?;
    spawn_added_and_queued(&app, &engine, None).await;
    Ok(gid)
}

fn job_to_option_map(job: HlsJob) -> HashMap<String, String> {
    let mut map = HashMap::new();
    map.insert("dir".into(), job.dir);
    map.insert("out".into(), job.out);
    if job.split > 0 {
        map.insert("split".into(), job.split.to_string());
    }
    if let Some(proxy) = job.proxy.filter(|value| !value.is_empty()) {
        map.insert("all-proxy".into(), proxy);
    }
    if !job.headers.is_empty() {
        let header = job
            .headers
            .into_iter()
            .map(|(name, value)| format!("{name}: {value}"))
            .collect::<Vec<_>>()
            .join("\n");
        map.insert("header".into(), header);
    }
    map
}

#[tauri::command]
pub async fn hls_get_option(
    state: State<'_, Arc<HlsEngineState>>,
    gid: String,
) -> Result<HashMap<String, String>, AppError> {
    require_hls_gid(&gid)?;
    let job = state.get_job(&gid).await.ok_or(AppError::NotFound(gid))?;
    Ok(job_to_option_map(job))
}

#[tauri::command]
pub async fn hls_ffmpeg_status(app: AppHandle) -> Result<FfmpegStatusDto, AppError> {
    let configured = match app.try_state::<RuntimeConfigState>() {
        Some(rc) => rc.snapshot().await.ffmpeg_binary_path,
        None => String::new(),
    };
    let status = FfmpegStatus::probe(&configured);
    let version = match status.path.as_deref() {
        Some(path) => probe_ffmpeg_version(path).await,
        None => None,
    };
    Ok(FfmpegStatusDto {
        kind: status.kind.to_string(),
        path: status.path,
        version,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        job_to_option_map, list_group_tasks, parse_ffmpeg_version_line, parse_hls_add_options,
        parse_max_concurrent_pref, playlist_body_is_extm3u, require_hls_gid, ParsedHlsAddOptions,
    };
    use crate::hls::types::HlsJob;

    #[test]
    fn require_hls_gid_accepts_hls_shape_and_rejects_aria2_gid() {
        assert!(require_hls_gid("hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").is_ok());
        assert!(require_hls_gid("0123456789abcdef").is_err());
    }

    fn job(gid: &str, status: &str) -> HlsJob {
        HlsJob {
            gid: gid.into(),
            playlist_url: "https://cdn.example/vod.m3u8".into(),
            dir: "downloads".into(),
            out: "vod.ts".into(),
            status: status.into(),
            temp_dir: std::path::PathBuf::from("hls-temp"),
            ..HlsJob::default()
        }
    }

    #[test]
    fn parses_header_string_and_array() {
        let from_string = parse_hls_add_options(&serde_json::json!({
            "header": "Cookie: a=1"
        }));
        assert_eq!(from_string.headers, vec![("Cookie".into(), "a=1".into())]);

        let from_array = parse_hls_add_options(&serde_json::json!({
            "header": ["Cookie: a=1", "X-Test: b"]
        }));
        assert_eq!(
            from_array.headers,
            vec![
                ("Cookie".into(), "a=1".into()),
                ("X-Test".into(), "b".into()),
            ]
        );

        let from_multiline = parse_hls_add_options(&serde_json::json!({
            "header": "Cookie: a=1\nReferer: https://ex.com"
        }));
        assert_eq!(
            from_multiline.headers,
            vec![
                ("Cookie".into(), "a=1".into()),
                ("Referer".into(), "https://ex.com".into()),
            ]
        );
    }

    #[test]
    fn job_option_map_echoes_dir_out_headers_and_proxy() {
        let mut job = job("hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "paused");
        job.headers = vec![
            ("Cookie".into(), "a=1".into()),
            ("Referer".into(), "https://ex.com".into()),
        ];
        job.proxy = Some("http://user:pass@127.0.0.1:8080".into());
        job.split = 8;
        let map = job_to_option_map(job);
        assert_eq!(map.get("dir").map(String::as_str), Some("downloads"));
        assert_eq!(map.get("out").map(String::as_str), Some("vod.ts"));
        assert_eq!(
            map.get("header").map(String::as_str),
            Some("Cookie: a=1\nReferer: https://ex.com")
        );
        assert_eq!(
            map.get("all-proxy").map(String::as_str),
            Some("http://user:pass@127.0.0.1:8080")
        );
        assert_eq!(map.get("split").map(String::as_str), Some("8"));
    }

    #[test]
    fn accepts_camel_and_kebab_option_keys() {
        let kebab = parse_hls_add_options(&serde_json::json!({
            "dir": "D:/dl",
            "out": "show.ts",
            "user-agent": "UA-Kebab",
            "referer": "https://ex.com",
            "all-proxy": "http://127.0.0.1:8080",
            "split": "8"
        }));
        assert_eq!(
            kebab,
            ParsedHlsAddOptions {
                dir: "D:/dl".into(),
                out: "show.ts".into(),
                headers: vec![
                    ("User-Agent".into(), "UA-Kebab".into()),
                    ("Referer".into(), "https://ex.com".into()),
                ],
                proxy: Some("http://127.0.0.1:8080".into()),
                split: 8,
            }
        );

        let camel = parse_hls_add_options(&serde_json::json!({
            "userAgent": "UA-Camel",
            "Referer": "https://ref.example/",
            "allProxy": "http://proxy:9",
            "split": 4
        }));
        assert_eq!(
            camel.headers,
            vec![
                ("User-Agent".into(), "UA-Camel".into()),
                ("Referer".into(), "https://ref.example/".into()),
            ]
        );
        assert_eq!(camel.proxy.as_deref(), Some("http://proxy:9"));
        assert_eq!(camel.split, 4);

        let proxy_alias = parse_hls_add_options(&serde_json::json!({
            "proxy": "socks5://127.0.0.1:1080"
        }));
        assert_eq!(
            proxy_alias.proxy.as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
    }

    #[test]
    fn injects_proxy_credentials_into_proxy_url() {
        let parsed = parse_hls_add_options(&serde_json::json!({
            "all-proxy": "http://127.0.0.1:8080",
            "all-proxy-user": "proxy-user",
            "all-proxy-passwd": "proxy-pass"
        }));
        let proxy = parsed.proxy.expect("proxy");
        assert!(
            proxy.contains("proxy-user:proxy-pass@127.0.0.1:8080"),
            "expected credentials in proxy URL, got {proxy}"
        );
    }

    #[test]
    fn clamps_split_to_1_64_and_defaults_to_16() {
        assert_eq!(parse_hls_add_options(&serde_json::json!({})).split, 16);
        assert_eq!(
            parse_hls_add_options(&serde_json::json!({"split": 0})).split,
            1
        );
        assert_eq!(
            parse_hls_add_options(&serde_json::json!({"split": 100})).split,
            64
        );
        assert_eq!(
            parse_hls_add_options(&serde_json::json!({"split": "1"})).split,
            1
        );
    }

    #[test]
    fn sanitizes_out_and_skips_empty() {
        let empty = parse_hls_add_options(&serde_json::json!({"out": ""}));
        assert!(empty.out.is_empty());
        let traversal = parse_hls_add_options(&serde_json::json!({"out": "../evil.ts"}));
        assert_eq!(traversal.out, "evil.ts");
        assert!(!traversal.out.contains(".."));
    }

    #[test]
    fn playlist_body_requires_extm3u_after_bom_and_whitespace() {
        assert!(playlist_body_is_extm3u("#EXTM3U\n#EXTINF:1,\nseg.ts\n"));
        assert!(playlist_body_is_extm3u("\u{feff}  \n#EXTM3U\n"));
        assert!(!playlist_body_is_extm3u("not a playlist"));
        assert!(!playlist_body_is_extm3u(""));
    }

    #[test]
    fn max_concurrent_pref_reads_number_or_string_default_5() {
        assert_eq!(parse_max_concurrent_pref(&serde_json::json!({})), 5);
        assert_eq!(
            parse_max_concurrent_pref(&serde_json::json!({"maxConcurrentDownloads": 3})),
            3
        );
        assert_eq!(
            parse_max_concurrent_pref(&serde_json::json!({"maxConcurrentDownloads": "7"})),
            7
        );
        assert_eq!(
            parse_max_concurrent_pref(&serde_json::json!({"maxConcurrentDownloads": 0})),
            5
        );
    }

    #[test]
    fn ffmpeg_version_line_takes_first_token_after_prefix() {
        assert_eq!(
            parse_ffmpeg_version_line("ffmpeg version 7.0.2 Copyright (c) 2000\n"),
            Some("7.0.2".into())
        );
        assert_eq!(parse_ffmpeg_version_line("not ffmpeg"), None);
    }

    #[test]
    fn list_group_active_includes_waiting_and_paused() {
        let jobs = vec![
            job("hls-a", "active"),
            job("hls-w", "waiting"),
            job("hls-p", "paused"),
            job("hls-c", "complete"),
            job("hls-e", "error"),
        ];
        let gids: Vec<String> = list_group_tasks(&jobs, "active")
            .into_iter()
            .map(|task| task.gid)
            .collect();
        assert_eq!(gids, vec!["hls-a", "hls-p", "hls-w"]);
        assert!(list_group_tasks(&jobs, "stopped").is_empty());
        assert!(list_group_tasks(&jobs, "waiting").is_empty());
    }
}
