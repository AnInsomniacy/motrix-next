use crate::error::AppError;
use semver::Version;
use serde::Serialize;
use std::cmp::Ordering;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::{Mutex, Notify};
use url::Url;

/// Base URL for update JSON files on the fixed `updater` GitHub Release tag.
const UPDATER_BASE_URL: &str =
    "https://github.com/AnInsomniacy/motrix-next/releases/download/updater";

/// Serializable update metadata returned to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
    pub channel: String,
    pub requested_channel: String,
    /// True when the offered version is lower than the running version
    /// (cross-channel switch, e.g. beta -> stable).
    pub is_rollback: bool,
}

/// Outcome of a download_update command.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DownloadUpdateStatus {
    Downloaded,
    NoUpdate,
}

/// Structured result returned to the frontend after checking/downloading.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DownloadUpdateResult {
    pub status: DownloadUpdateStatus,
}

/// Progress event emitted to the frontend during update download.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateProgressEvent {
    Started {
        content_length: u64,
    },
    Progress {
        chunk_length: usize,
        downloaded: u64,
    },
    Finished,
}

/// Shared state for coordinating update cancellation between commands.
pub struct UpdateCancelState {
    /// Set to `true` when the user requests cancellation.
    cancelled: AtomicBool,
    /// Notified when cancellation is requested, waking the `select!` branch.
    notify: Notify,
}

impl UpdateCancelState {
    pub fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    /// Arms the cancel state for a new download (resets the flag).
    fn reset(&self) {
        self.cancelled.store(false, AtomicOrdering::SeqCst);
    }

    /// Signals cancellation.
    fn cancel(&self) {
        self.cancelled.store(true, AtomicOrdering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Returns `true` if cancellation has been requested.
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(AtomicOrdering::SeqCst)
    }
}

/// A downloaded update package pinned to the version it was downloaded for.
///
/// `downloaded_version` is captured from `Update::version` at download time so
/// that `apply_update` can detect if the remote channel drifted between download
/// and install.  Without this, a version-B `Update` object could be paired with
/// version-A bytes, causing install() to fail and discard the cached package.
pub struct DownloadedPackage {
    pub downloaded_version: String,
    pub bytes: Vec<u8>,
}

/// Holds the downloaded update package between `download_update` and `apply_update`.
///
/// `download_update` stores the verified package here; `apply_update` takes it
/// out, stops the engine, and installs.  This decouples downloading (aria2 stays
/// alive) from installation (aria2 must be stopped).
///
/// **Important**: `install(bytes)` consumes `Vec<u8>` by value.  If installation
/// fails, the bytes are unrecoverable without a full re-download — this is a
/// Tauri API limitation, not a design oversight.
pub struct DownloadedUpdate {
    package: Mutex<Option<DownloadedPackage>>,
}

impl DownloadedUpdate {
    pub fn new() -> Self {
        Self {
            package: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReleaseChannel {
    Stable,
    Beta,
}

impl ReleaseChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }

    fn endpoint_file(self) -> &'static str {
        match self {
            Self::Stable => "latest.json",
            Self::Beta => "beta.json",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdatePolicy {
    Stable,
    Beta,
    Latest,
}

impl UpdatePolicy {
    fn from_input(input: &str) -> Self {
        match input {
            "beta" => Self::Beta,
            "latest" => Self::Latest,
            _ => Self::Stable,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Latest => "latest",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CandidateVersion {
    channel: ReleaseChannel,
    version: String,
}

impl CandidateVersion {
    fn new(channel: ReleaseChannel, version: impl Into<String>) -> Self {
        Self {
            channel,
            version: version.into(),
        }
    }
}

struct SelectedUpdate {
    channel: ReleaseChannel,
    requested_policy: UpdatePolicy,
    update: tauri_plugin_updater::Update,
}

/// Returns the update endpoint URL for the given release channel.
fn endpoint_for_channel(channel: ReleaseChannel) -> String {
    let file = channel.endpoint_file();
    format!("{}/{}", UPDATER_BASE_URL, file)
}

fn candidate_channels_for_policy(policy: UpdatePolicy) -> Vec<ReleaseChannel> {
    match policy {
        UpdatePolicy::Stable => vec![ReleaseChannel::Stable],
        UpdatePolicy::Beta => vec![ReleaseChannel::Beta],
        UpdatePolicy::Latest => vec![ReleaseChannel::Stable, ReleaseChannel::Beta],
    }
}

fn parse_semver(version: &str) -> Option<Version> {
    Version::parse(version.trim_start_matches('v')).ok()
}

fn compare_candidate_versions(a: &CandidateVersion, b: &CandidateVersion) -> Ordering {
    match (parse_semver(&a.version), parse_semver(&b.version)) {
        (Some(a_version), Some(b_version)) => a_version.cmp(&b_version).then_with(|| {
            release_channel_priority(a.channel).cmp(&release_channel_priority(b.channel))
        }),
        _ => a.version.cmp(&b.version).then_with(|| {
            release_channel_priority(a.channel).cmp(&release_channel_priority(b.channel))
        }),
    }
}

fn release_channel_priority(channel: ReleaseChannel) -> u8 {
    match channel {
        ReleaseChannel::Stable => 1,
        ReleaseChannel::Beta => 0,
    }
}

fn is_strict_semver_upgrade(current: &str, target: &str) -> bool {
    match (parse_semver(current), parse_semver(target)) {
        (Some(current), Some(target)) => target > current,
        _ => target != current,
    }
}

/// True when the offered version is strictly lower than the running one.
/// Unparseable versions are never flagged as rollbacks.
fn is_semver_rollback(current: &str, target: &str) -> bool {
    match (parse_semver(current), parse_semver(target)) {
        (Some(current), Some(target)) => target < current,
        _ => false,
    }
}

fn select_latest_candidate(
    current_version: &str,
    candidates: Vec<CandidateVersion>,
) -> Option<CandidateVersion> {
    candidates
        .into_iter()
        .filter(|candidate| is_strict_semver_upgrade(current_version, &candidate.version))
        .max_by(compare_candidate_versions)
}

fn redact_proxy_for_log(proxy: &Option<String>) -> String {
    let Some(proxy) = proxy.as_deref() else {
        return "disabled".into();
    };
    if proxy.is_empty() {
        return "disabled".into();
    }
    match Url::parse(proxy) {
        Ok(url) => {
            let host = url.host_str().unwrap_or("invalid-host");
            let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
            let has_auth = !url.username().is_empty() || url.password().is_some();
            if has_auth {
                format!("{}://[REDACTED]@{host}{port}", url.scheme())
            } else {
                format!("{}://{host}{port}", url.scheme())
            }
        }
        Err(_) => "invalid".into(),
    }
}

/// Constructs a configured `Updater` ready to call `.check()`.
///
/// Centralises endpoint resolution, proxy configuration, and the
/// version comparator so that `check_for_update`, `download_update`,
/// and `apply_update` share a single code-path.
///
/// Proxy is applied via `UpdaterBuilder::proxy()` (per-request, thread-safe)
/// rather than mutating process-level environment variables.
fn build_updater(
    app: &AppHandle,
    channel: ReleaseChannel,
    proxy: &Option<String>,
) -> Result<tauri_plugin_updater::Updater, AppError> {
    let endpoint =
        Url::parse(&endpoint_for_channel(channel)).map_err(|e| AppError::Updater(e.to_string()))?;

    let mut builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| AppError::Updater(e.to_string()))?;

    // Apply proxy at the HTTP client level — no env var mutation.
    if let Some(p) = proxy {
        if !p.is_empty() {
            let proxy_url = Url::parse(p)
                .map_err(|e| AppError::Updater(format!("Invalid update proxy config: {e}")))?;
            builder = builder.proxy(proxy_url);
        } else {
            builder = builder.no_proxy();
        }
    } else {
        builder = builder.no_proxy();
    }

    // Allow cross-channel switching (e.g. beta → stable, even if it is
    // a semver "downgrade"). Any version != current is an update.
    builder
        .version_comparator(|current, update| update.version.to_string() != current.to_string())
        .build()
        .map_err(|e| AppError::Updater(e.to_string()))
}

async fn check_release_channel(
    app: &AppHandle,
    channel: ReleaseChannel,
    proxy: &Option<String>,
) -> Result<Option<tauri_plugin_updater::Update>, AppError> {
    build_updater(app, channel, proxy)?
        .check()
        .await
        .map_err(|e| AppError::Updater(e.to_string()))
}

async fn resolve_update(
    app: &AppHandle,
    requested_policy: UpdatePolicy,
    proxy: &Option<String>,
) -> Result<Option<SelectedUpdate>, AppError> {
    if requested_policy != UpdatePolicy::Latest {
        let channel = candidate_channels_for_policy(requested_policy)
            .into_iter()
            .next()
            .unwrap_or(ReleaseChannel::Stable);
        return Ok(check_release_channel(app, channel, proxy)
            .await?
            .map(|update| SelectedUpdate {
                channel,
                requested_policy,
                update,
            }));
    }

    let mut current_version: Option<String> = None;
    let mut updates: Vec<(CandidateVersion, tauri_plugin_updater::Update)> = Vec::new();
    for channel in candidate_channels_for_policy(requested_policy) {
        let Some(update) = check_release_channel(app, channel, proxy).await? else {
            continue;
        };
        current_version.get_or_insert_with(|| update.current_version.clone());
        let candidate = CandidateVersion::new(channel, update.version.clone());
        updates.push((candidate, update));
    }

    let Some(best_candidate) = select_latest_candidate(
        current_version.as_deref().unwrap_or_default(),
        updates
            .iter()
            .map(|(candidate, _)| candidate.clone())
            .collect(),
    ) else {
        return Ok(None);
    };

    let Some(index) = updates
        .iter()
        .position(|(candidate, _)| candidate == &best_candidate)
    else {
        return Ok(None);
    };
    let (candidate, update) = updates.swap_remove(index);

    Ok(Some(SelectedUpdate {
        channel: candidate.channel,
        requested_policy,
        update,
    }))
}

/// Checks for available updates on the specified channel.
///
/// Returns `Some(UpdateMetadata)` if an update is available, or `None`
/// if the application is already on the latest version for that channel.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    channel: String,
    proxy: Option<String>,
) -> Result<Option<UpdateMetadata>, AppError> {
    log::info!(
        "updater:check channel={channel} proxy={}",
        redact_proxy_for_log(&proxy)
    );
    let requested_policy = UpdatePolicy::from_input(&channel);
    let selected = resolve_update(&app, requested_policy, &proxy).await?;

    Ok(match selected {
        Some(selected) => {
            let u = selected.update;
            log::info!(
                "updater:check result=found version={} channel={} requested={}",
                u.version,
                selected.channel.as_str(),
                selected.requested_policy.as_str()
            );
            Some(UpdateMetadata {
                is_rollback: is_semver_rollback(&u.current_version, &u.version),
                version: u.version.clone(),
                body: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
                channel: selected.channel.as_str().into(),
                requested_channel: selected.requested_policy.as_str().into(),
            })
        }
        None => {
            log::info!("updater:check result=up-to-date");
            None
        }
    })
}

/// Downloads the latest update on the specified channel WITHOUT installing.
///
/// The Aria2 Next engine keeps running during download — user tasks are unaffected.
/// Downloaded bytes are stored in `DownloadedUpdate` shared state for later
/// installation via `apply_update`.
///
/// Emits `update-progress` events to the frontend with download progress.
/// The download can be cancelled by calling `cancel_update`.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    channel: String,
    proxy: Option<String>,
) -> Result<DownloadUpdateResult, AppError> {
    log::info!(
        "updater:download channel={channel} proxy={}",
        redact_proxy_for_log(&proxy)
    );
    let cancel_state = app.state::<Arc<UpdateCancelState>>();
    cancel_state.reset();

    let requested_policy = UpdatePolicy::from_input(&channel);
    let selected = resolve_update(&app, requested_policy, &proxy).await?;

    let selected = match selected {
        Some(selected) => selected,
        None => {
            log::info!("updater:download result=no-update");
            return Ok(DownloadUpdateResult {
                status: DownloadUpdateStatus::NoUpdate,
            });
        }
    };
    let update = selected.update;

    // ── Download only (Aria2 Next stays alive) ───────────────────────────
    let app_handle = app.clone();
    let cancel = cancel_state.inner().clone();
    let mut downloaded: u64 = 0;

    let download_fut = update.download(
        move |chunk_length, content_length| {
            if cancel.is_cancelled() {
                return;
            }

            downloaded += chunk_length as u64;

            if downloaded == chunk_length as u64 {
                let _ = app_handle.emit(
                    "update-progress",
                    UpdateProgressEvent::Started {
                        content_length: content_length.unwrap_or(0),
                    },
                );
            }

            let _ = app_handle.emit(
                "update-progress",
                UpdateProgressEvent::Progress {
                    chunk_length,
                    downloaded,
                },
            );
        },
        || {},
    );

    // Race the download against cancellation.
    let bytes = tokio::select! {
        result = download_fut => {
            if cancel_state.is_cancelled() {
                log::warn!("updater:download cancelled by user");
                return Err(AppError::Updater("Update cancelled by user".into()));
            }
            result.map_err(|e| AppError::Updater(e.to_string()))?
        }
        _ = cancel_state.notify.notified() => {
            log::warn!("updater:download cancelled by user (via notify)");
            return Err(AppError::Updater("Update cancelled by user".into()));
        }
    };

    // Store downloaded package (version + bytes) for later installation.
    // The version is pinned here so apply_update can detect channel drift.
    let dl_state = app.state::<Arc<DownloadedUpdate>>();
    let byte_count = bytes.len();
    *dl_state.package.lock().await = Some(DownloadedPackage {
        downloaded_version: update.version.clone(),
        bytes,
    });
    log::info!(
        "updater:download complete version={} channel={} requested={} bytes={byte_count}",
        update.version,
        selected.channel.as_str(),
        selected.requested_policy.as_str()
    );

    // Emit download-finished (NOT Finished — that signals post-install)
    if !cancel_state.is_cancelled() {
        let _ = app.emit("update-progress", UpdateProgressEvent::Finished);
    }

    Ok(DownloadUpdateResult {
        status: DownloadUpdateStatus::Downloaded,
    })
}

/// Installs a previously downloaded update.
///
/// Uses a two-phase approach:
///   1. **Stop engine** — kill the Aria2 Next sidecar so NSIS can overwrite it.
///   2. **Install** — run the platform installer (NSIS / tar.gz replacement).
///
/// The caller (frontend) should invoke this only after `download_update`
/// succeeds and the user confirms installation.
#[tauri::command]
pub async fn apply_update(
    app: AppHandle,
    channel: String,
    proxy: Option<String>,
) -> Result<(), AppError> {
    log::info!(
        "updater:apply channel={channel} proxy={}",
        redact_proxy_for_log(&proxy)
    );
    // Android: the Tauri updater installs NSIS/tar.gz artifacts, not APKs.
    // Updates must be distributed through the Play Store / APK sideloading.
    #[cfg(target_os = "android")]
    {
        let _ = (app, channel, proxy);
        return Err(AppError::Updater(
            "In-app updates are not supported on Android — download the new APK from the release page"
                .into(),
        ));
    }
    // Re-check the update to obtain the Update object for installation.
    // This MUST happen before take() — if check() fails (network flap,
    // JSON changed between download and install), the already-downloaded
    // bytes remain in shared state and the user can retry without
    // re-downloading.
    let requested_policy = UpdatePolicy::from_input(&channel);
    let selected = resolve_update(&app, requested_policy, &proxy)
        .await?
        .ok_or_else(|| AppError::Updater("Update no longer available".into()))?;
    let update = selected.update;

    let dl_state = app.state::<Arc<DownloadedUpdate>>();
    let pkg_guard = dl_state.package.lock().await;
    let cached = pkg_guard
        .as_ref()
        .ok_or_else(|| AppError::Updater("No downloaded update available".into()))?;

    // Version-drift guard: if the remote channel moved to a different version
    // since download, reject and preserve the cached package for retry.
    if update.version != cached.downloaded_version {
        log::warn!(
            "updater:apply version drift: downloaded={} remote={}",
            cached.downloaded_version,
            update.version
        );
        let cached_ver = cached.downloaded_version.clone();
        return Err(AppError::Updater(format!(
            "Downloaded v{cached_ver} but channel now points to v{}; please re-download",
            update.version
        )));
    }
    drop(pkg_guard); // release lock before engine stop

    // ── Phase 1: Stop Aria2 Next engine BEFORE installation ─────────────
    // On Windows, NSIS cannot overwrite a running .exe binary.
    // On macOS/Linux this prevents session file corruption.
    {
        let app_for_stop = app.clone();
        tokio::task::spawn_blocking(move || {
            crate::engine::stop_engine(&app_for_stop, false).map_err(AppError::Engine)
        })
        .await
        .map_err(|e| AppError::Engine(e.to_string()))??;
    }
    log::info!("updater:apply phase=engine-stopped");

    let cached = dl_state
        .package
        .lock()
        .await
        .take()
        .ok_or_else(|| AppError::Updater("No downloaded update available".into()))?;
    let bytes = cached.bytes;

    // ── Phase 2: Install (NSIS / tar.gz replacement) ────────────────
    // On install failure, restart the engine so download functionality is
    // restored.  restart_engine() atomically resets intentional_stop,
    // preventing the crash watcher from being permanently masked.
    if let Err(e) = update.install(bytes) {
        log::warn!("updater:apply install failed, attempting engine recovery: {e}");

        let app_for_restart = app.clone();
        let recovery = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let config = super::config::get_system_config(app_for_restart.clone())
                .map_err(|ce| format!("config read failed: {ce}"))?;
            crate::engine::restart_engine(&app_for_restart, &config)
        })
        .await;

        match recovery {
            Ok(Ok(())) => {
                log::info!("updater:apply engine recovered after install failure");
                let _ = app.emit(
                    "engine-recovered",
                    serde_json::json!({ "source": "updater-install-failed" }),
                );
            }
            Ok(Err(engine_err)) => {
                log::error!("updater:apply engine recovery failed: {engine_err}");
                let _ = app.emit(
                    "engine-crashed",
                    serde_json::json!({ "code": -1, "signal": null }),
                );
                return Err(AppError::Updater(format!(
                    "{}; engine recovery also failed: {}",
                    e, engine_err
                )));
            }
            Err(join_err) => {
                log::error!("updater:apply recovery task panicked: {join_err}");
                let _ = app.emit(
                    "engine-crashed",
                    serde_json::json!({ "code": -1, "signal": null }),
                );
                return Err(AppError::Updater(format!(
                    "{}; engine recovery panicked: {}",
                    e, join_err
                )));
            }
        }

        // Only reached when recovery succeeded — return the original install error
        return Err(AppError::Updater(e.to_string()));
    }
    log::info!("updater:apply phase=installed");

    // macOS: flush icon cache after OTA bundle replacement.
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        if let Ok(exe) = std::env::current_exe() {
            if let Some(app_bundle) = exe
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
            {
                let _ = Command::new("touch").arg(app_bundle).output();
                let _ = Command::new("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
                    .args(["-f", &app_bundle.to_string_lossy()])
                    .output();
            }
        }
    }

    Ok(())
}

/// Cancels an in-progress update download.
#[tauri::command]
pub fn cancel_update(app: AppHandle) -> Result<(), AppError> {
    log::info!("updater:cancel");
    let cancel_state = app.state::<Arc<UpdateCancelState>>();
    cancel_state.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── UpdateCancelState ───────────────────────────────────────────

    #[test]
    fn cancel_state_starts_not_cancelled() {
        let state = UpdateCancelState::new();
        assert!(!state.is_cancelled());
    }

    #[test]
    fn cancel_state_cancel_sets_flag() {
        let state = UpdateCancelState::new();
        state.cancel();
        assert!(state.is_cancelled());
    }

    #[test]
    fn cancel_state_reset_clears_flag() {
        let state = UpdateCancelState::new();
        state.cancel();
        assert!(state.is_cancelled());
        state.reset();
        assert!(!state.is_cancelled());
    }

    #[test]
    fn cancel_state_double_cancel_is_idempotent() {
        let state = UpdateCancelState::new();
        state.cancel();
        state.cancel();
        assert!(state.is_cancelled());
    }

    #[test]
    fn cancel_state_reset_cancel_cycle() {
        let state = UpdateCancelState::new();
        for _ in 0..5 {
            state.cancel();
            assert!(state.is_cancelled());
            state.reset();
            assert!(!state.is_cancelled());
        }
    }

    // ── endpoint_for_channel ────────────────────────────────────────

    #[test]
    fn endpoint_for_stable_channel_returns_latest_json() {
        let url = endpoint_for_channel(ReleaseChannel::Stable);
        assert!(url.ends_with("/latest.json"));
        assert!(url.starts_with(UPDATER_BASE_URL));
    }

    #[test]
    fn endpoint_for_beta_channel_returns_beta_json() {
        let url = endpoint_for_channel(ReleaseChannel::Beta);
        assert!(url.ends_with("/beta.json"));
        assert!(url.starts_with(UPDATER_BASE_URL));
    }

    #[test]
    fn unknown_policy_falls_back_to_stable() {
        assert_eq!(UpdatePolicy::from_input("nightly"), UpdatePolicy::Stable);
    }

    #[test]
    fn semver_rollback_detects_downgrades_only() {
        assert!(is_semver_rollback("2.0.0", "1.9.9"));
        assert!(is_semver_rollback("2.0.0", "2.0.0-beta.1"));
        assert!(!is_semver_rollback("1.0.0", "2.0.0"));
        assert!(!is_semver_rollback("2.0.0", "2.0.0"));
        // Unparseable versions are never flagged as rollbacks.
        assert!(!is_semver_rollback("", "1.0.0"));
        assert!(!is_semver_rollback("2.0.0", "not-a-version"));
    }

    #[test]
    fn latest_policy_checks_stable_and_beta_channels() {
        assert_eq!(
            candidate_channels_for_policy(UpdatePolicy::Latest),
            vec![ReleaseChannel::Stable, ReleaseChannel::Beta]
        );
    }

    #[test]
    fn stable_and_beta_policies_check_only_their_own_channel() {
        assert_eq!(
            candidate_channels_for_policy(UpdatePolicy::Stable),
            vec![ReleaseChannel::Stable]
        );
        assert_eq!(
            candidate_channels_for_policy(UpdatePolicy::Beta),
            vec![ReleaseChannel::Beta]
        );
    }

    #[test]
    fn latest_policy_selects_highest_semver_candidate() {
        let candidates = vec![
            CandidateVersion::new(ReleaseChannel::Stable, "3.8.7"),
            CandidateVersion::new(ReleaseChannel::Beta, "3.8.8-beta.1"),
        ];

        assert_eq!(
            select_latest_candidate("3.8.6", candidates).map(|candidate| candidate.channel),
            Some(ReleaseChannel::Beta)
        );
    }

    #[test]
    fn latest_policy_selects_stable_when_stable_is_newer_than_beta() {
        let candidates = vec![
            CandidateVersion::new(ReleaseChannel::Stable, "3.8.8"),
            CandidateVersion::new(ReleaseChannel::Beta, "3.8.8-beta.4"),
        ];

        assert_eq!(
            select_latest_candidate("3.8.7", candidates).map(|candidate| candidate.channel),
            Some(ReleaseChannel::Stable)
        );
    }

    #[test]
    fn latest_policy_ignores_candidates_that_are_not_newer_than_current() {
        let candidates = vec![
            CandidateVersion::new(ReleaseChannel::Stable, "3.8.6"),
            CandidateVersion::new(ReleaseChannel::Beta, "3.8.7-beta.4"),
        ];

        assert!(select_latest_candidate("3.8.7-beta.4", candidates).is_none());
    }

    #[test]
    fn redact_proxy_for_log_hides_credentials() {
        let proxy = Some("http://user:pass@example.com:8080".to_string());
        assert_eq!(
            redact_proxy_for_log(&proxy),
            "http://[REDACTED]@example.com:8080"
        );
    }

    #[test]
    fn redact_proxy_for_log_marks_invalid_proxy() {
        let proxy = Some("://not-a-url".to_string());
        assert_eq!(redact_proxy_for_log(&proxy), "invalid");
    }
}
