use crate::error::AppError;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
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
pub struct UpdateMetadata {
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
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
        self.cancelled.store(false, Ordering::SeqCst);
    }

    /// Signals cancellation.
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Returns `true` if cancellation has been requested.
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

/// Holds the downloaded update bytes between `download_update` and `apply_update`.
///
/// `download_update` stores the verified package here; `apply_update` takes it
/// out, stops the engine, and installs.  This decouples downloading (aria2 stays
/// alive) from installation (aria2 must be stopped).
pub struct DownloadedUpdate {
    bytes: Mutex<Option<Vec<u8>>>,
}

impl DownloadedUpdate {
    pub fn new() -> Self {
        Self {
            bytes: Mutex::new(None),
        }
    }
}

/// Returns the update endpoint URL for the given channel.
fn endpoint_for_channel(channel: &str) -> String {
    let file = if channel == "beta" {
        "beta.json"
    } else {
        "latest.json"
    };
    format!("{}/{}", UPDATER_BASE_URL, file)
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
    channel: &str,
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
            if let Ok(proxy_url) = Url::parse(p) {
                builder = builder.proxy(proxy_url);
            }
        }
    }

    // Allow cross-channel switching (e.g. beta → stable, even if it is
    // a semver "downgrade"). Any version != current is an update.
    builder
        .version_comparator(|current, update| update.version.to_string() != current.to_string())
        .build()
        .map_err(|e| AppError::Updater(e.to_string()))
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
    log::info!("updater:check channel={channel} proxy={proxy:?}");
    let update = build_updater(&app, &channel, &proxy)?
        .check()
        .await
        .map_err(|e| AppError::Updater(e.to_string()))?;

    Ok(match update {
        Some(u) => {
            log::info!("updater:check result=found version={}", u.version);
            Some(UpdateMetadata {
                version: u.version.clone(),
                body: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
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
/// The aria2c engine keeps running during download — user tasks are unaffected.
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
) -> Result<(), AppError> {
    log::info!("updater:download channel={channel} proxy={proxy:?}");
    let cancel_state = app.state::<Arc<UpdateCancelState>>();
    cancel_state.reset();

    let update = build_updater(&app, &channel, &proxy)?
        .check()
        .await
        .map_err(|e| AppError::Updater(e.to_string()))?;

    let update = match update {
        Some(u) => u,
        None => return Ok(()),
    };

    // ── Download only (aria2c stays alive) ───────────────────────────
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

    // Store downloaded bytes for later installation
    let dl_state = app.state::<Arc<DownloadedUpdate>>();
    let byte_count = bytes.len();
    *dl_state.bytes.lock().await = Some(bytes);
    log::info!("updater:download complete bytes={byte_count}");

    // Emit download-finished (NOT Finished — that signals post-install)
    if !cancel_state.is_cancelled() {
        let _ = app.emit("update-progress", UpdateProgressEvent::Finished);
    }

    Ok(())
}

/// Installs a previously downloaded update.
///
/// Uses a two-phase approach:
///   1. **Stop engine** — kill the aria2c sidecar so NSIS can overwrite it.
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
    log::info!("updater:apply channel={channel}");
    // Take the downloaded bytes from shared state
    let dl_state = app.state::<Arc<DownloadedUpdate>>();
    let bytes = dl_state
        .bytes
        .lock()
        .await
        .take()
        .ok_or_else(|| AppError::Updater("No downloaded update available".into()))?;

    // Re-check the update to obtain the Update object for installation
    let update = build_updater(&app, &channel, &proxy)?
        .check()
        .await
        .map_err(|e| AppError::Updater(e.to_string()))?
        .ok_or_else(|| AppError::Updater("Update no longer available".into()))?;

    // ── Phase 1: Stop aria2c engine BEFORE installation ─────────────
    // On Windows, NSIS cannot overwrite a running .exe binary.
    // On macOS/Linux this prevents session file corruption.
    {
        let app_for_stop = app.clone();
        tokio::task::spawn_blocking(move || {
            let _ = crate::engine::stop_engine(&app_for_stop);
        })
        .await
        .map_err(|e| AppError::Engine(e.to_string()))?;
    }
    log::info!("updater:apply phase=engine-stopped");

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
        let url = endpoint_for_channel("stable");
        assert!(url.ends_with("/latest.json"));
        assert!(url.starts_with(UPDATER_BASE_URL));
    }

    #[test]
    fn endpoint_for_beta_channel_returns_beta_json() {
        let url = endpoint_for_channel("beta");
        assert!(url.ends_with("/beta.json"));
        assert!(url.starts_with(UPDATER_BASE_URL));
    }

    #[test]
    fn endpoint_for_unknown_channel_falls_back_to_latest() {
        let url = endpoint_for_channel("nightly");
        assert!(url.ends_with("/latest.json"));
    }

    // ── Structural: apply_update must stop engine before install ─────

    /// Verifies that `apply_update` calls `stop_engine` before `.install()`.
    #[test]
    fn apply_update_stops_engine_before_install() {
        let source = include_str!("updater.rs");
        let fn_start = source
            .find("pub async fn apply_update")
            .expect("apply_update function must exist");
        let fn_body = &source[fn_start..];
        let stop_pos = fn_body
            .find("stop_engine")
            .expect("apply_update must call stop_engine");
        let install_pos = fn_body
            .find(".install(")
            .expect("apply_update must call .install()");
        assert!(
            stop_pos < install_pos,
            "stop_engine (pos {}) must appear before .install() (pos {}) in apply_update",
            stop_pos,
            install_pos
        );
    }

    /// Verifies that `download_update` does NOT call `stop_engine`.
    #[test]
    fn download_update_does_not_stop_engine() {
        let source = include_str!("updater.rs");
        let dl_start = source
            .find("pub async fn download_update")
            .expect("download_update function must exist");
        let apply_start = source
            .find("pub async fn apply_update")
            .expect("apply_update function must exist");
        let download_body = &source[dl_start..apply_start];
        assert!(
            !download_body.contains("stop_engine"),
            "download_update must NOT call stop_engine — engine stays alive during download"
        );
    }

    /// Verifies that `DownloadedUpdate` shared state struct exists.
    #[test]
    fn downloaded_update_shared_state_exists() {
        let source = include_str!("updater.rs");
        assert!(
            source.contains("pub struct DownloadedUpdate"),
            "DownloadedUpdate shared state must be defined"
        );
    }

    /// Verifies no combined download-and-install call in production code.
    #[test]
    fn no_combined_download_and_install() {
        let source = include_str!("updater.rs");
        let banned = format!("{}{}", "download_and_", "install");
        let production_end = source.find("#[cfg(test)]").unwrap_or(source.len());
        let production_code = &source[..production_end];
        assert!(
            !production_code.contains(&banned),
            "production code must NOT call {} — use download() + stop_engine + install() instead",
            banned
        );
    }

    // ── Proxy refactor: build_updater helper ────────────────────────

    /// Production code must NOT use `apply_proxy` — proxy is passed via
    /// `UpdaterBuilder::proxy()` instead of mutating process env vars.
    #[test]
    fn no_apply_proxy_function_in_production_code() {
        let source = include_str!("updater.rs");
        let production_end = source.find("#[cfg(test)]").unwrap_or(source.len());
        let production_code = &source[..production_end];
        assert!(
            !production_code.contains("fn apply_proxy"),
            "production code must NOT define apply_proxy — use UpdaterBuilder::proxy() instead"
        );
    }

    /// Production code must NOT call `set_var` or `remove_var` — these are
    /// unsafe in multi-threaded contexts (Rust 2024 edition) and unnecessary
    /// when `UpdaterBuilder::proxy()` is available.
    #[test]
    fn no_env_var_mutation_in_production_code() {
        let source = include_str!("updater.rs");
        let production_end = source.find("#[cfg(test)]").unwrap_or(source.len());
        let production_code = &source[..production_end];
        assert!(
            !production_code.contains("set_var"),
            "production code must NOT call set_var — use UpdaterBuilder::proxy() instead"
        );
        assert!(
            !production_code.contains("remove_var"),
            "production code must NOT call remove_var — use UpdaterBuilder::proxy() instead"
        );
    }

    /// A `build_updater` helper must exist to avoid repeating the builder
    /// construction in check_for_update, download_update, and apply_update.
    #[test]
    fn build_updater_helper_exists() {
        let source = include_str!("updater.rs");
        let production_end = source.find("#[cfg(test)]").unwrap_or(source.len());
        let production_code = &source[..production_end];
        assert!(
            production_code.contains("fn build_updater"),
            "a build_updater helper function must exist for DRY builder construction"
        );
    }

    /// All three command functions must delegate to `build_updater` rather
    /// than constructing the updater inline.
    #[test]
    fn all_commands_use_build_updater() {
        let source = include_str!("updater.rs");
        let production_end = source.find("#[cfg(test)]").unwrap_or(source.len());
        let production_code = &source[..production_end];

        for cmd in ["check_for_update", "download_update", "apply_update"] {
            let fn_start = production_code
                .find(&format!("pub async fn {}", cmd))
                .unwrap_or_else(|| panic!("{} function must exist", cmd));
            // Find next `pub` or end to delimit the function body
            let rest = &production_code[fn_start + 10..];
            let fn_end = rest
                .find("\npub ")
                .map(|p| fn_start + 10 + p)
                .unwrap_or(production_end);
            let fn_body = &production_code[fn_start..fn_end];
            assert!(
                fn_body.contains("build_updater"),
                "{} must call build_updater helper",
                cmd
            );
        }
    }

    /// `build_updater` must use the `UpdaterBuilder::proxy()` method when
    /// a proxy URL is provided, not environment variable mutation.
    #[test]
    fn build_updater_uses_proxy_method() {
        let source = include_str!("updater.rs");
        let fn_start = source
            .find("fn build_updater")
            .expect("build_updater function must exist");
        // Find the closing of the function (next `fn ` or `#[`)
        let rest = &source[fn_start..];
        let fn_end = rest[10..]
            .find("\nfn ")
            .or_else(|| rest[10..].find("\npub "))
            .or_else(|| rest[10..].find("\n#["))
            .map(|p| p + 10)
            .unwrap_or(rest.len());
        let fn_body = &rest[..fn_end];
        assert!(
            fn_body.contains(".proxy("),
            "build_updater must call .proxy() on the UpdaterBuilder"
        );
    }
}
