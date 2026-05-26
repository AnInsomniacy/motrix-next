use crate::error::AppError;
use serde_json::Value;
use std::path::Path;
use tauri::AppHandle;
use tauri::Manager;

fn redact_url_credentials(value: &str) -> String {
    match url::Url::parse(value) {
        Ok(url) => {
            let host = url.host_str().unwrap_or("invalid-host");
            let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
            let has_auth = !url.username().is_empty() || url.password().is_some();
            if has_auth {
                format!("{}://[REDACTED]@{host}{port}", url.scheme())
            } else {
                value.to_string()
            }
        }
        Err(_) => value.to_string(),
    }
}

fn sanitize_config_snapshot(raw: &Value) -> Value {
    let mut sanitized = raw.clone();
    if let Some(prefs) = sanitized
        .get_mut("preferences")
        .and_then(Value::as_object_mut)
    {
        for key in ["rpcSecret", "extensionApiSecret"] {
            if let Some(secret) = prefs.get_mut(key) {
                *secret = Value::String("[REDACTED]".into());
            }
        }
        if let Some(cookie) = prefs.get_mut("cookie") {
            *cookie = Value::String("[REDACTED]".into());
        }
        if let Some(proxy) = prefs.get_mut("proxy").and_then(Value::as_object_mut) {
            if let Some(server_value) = proxy.get_mut("server") {
                if let Some(server) = server_value.as_str() {
                    *server_value = Value::String(redact_url_credentials(server));
                }
            }
        }
    }
    sanitized
}

/// Returns `true` when the current process was launched by the OS
/// autostart mechanism (the Tauri autostart plugin appends `--autostart`)
/// **and** the app is still in the initial cold-start phase.
///
/// Once the user first dismisses the window (triggering
/// `handle_minimize_to_tray`), the lifecycle transitions to runtime
/// and this function always returns `false`.  This prevents lightweight
/// mode window recreations from incorrectly re-applying autostart-hide
/// logic — the recreated frontend calls this again, but the argv
/// `--autostart` flag is a process-level constant that never changes.
/// See issue #206.
///
/// Checks for both exact `--autostart` and prefix `--autostart=` variants
/// to tolerate edge cases from the auto-launch crate's Windows registry
/// entry handling (nicehash/auto-launch#771).
///
/// Logging strategy (privacy-safe):
/// - `info!`: argument count and boolean result only
/// - `debug!`: structured diagnostics (match type counts) — no raw argv,
///   because the default log level is `Debug` and diagnostic exports bundle
///   all log files into user-submitted ZIPs
#[tauri::command]
pub fn is_autostart_launch(lifecycle: tauri::State<'_, crate::AppLifecycleState>) -> bool {
    // After the cold-start phase ends (user dismissed the window at least
    // once), always return false.  Window recreations in lightweight mode
    // are user-initiated — they must NOT trigger autostart-hide.  #206.
    if !lifecycle.is_cold_start() {
        log::info!("is_autostart_launch: post-cold-start phase → false");
        return false;
    }

    // Cold start: check argv as before.
    let args: Vec<String> = std::env::args().collect();
    let matched_exact = args.iter().any(|a| a == "--autostart");
    let matched_prefixed = args.iter().any(|a| a.starts_with("--autostart="));
    let result = matched_exact || matched_prefixed;
    // Subtract 1 for argv[0] (binary name), then subtract matched args
    let other_arg_count =
        args.len().saturating_sub(1) - (matched_exact as usize) - (matched_prefixed as usize);
    log::info!("is_autostart_launch: argc={} result={}", args.len(), result);
    log::debug!(
        "is_autostart_launch: matched_exact={} matched_prefixed={} other_arg_count={}",
        matched_exact,
        matched_prefixed,
        other_arg_count
    );
    result
}

/// Truncates the application log file to zero bytes.
/// Uses `app_log_dir()` to locate the log — no frontend FS permission required.
#[tauri::command]
pub fn clear_log_file(app: AppHandle) -> Result<(), AppError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let log_path = log_dir.join("motrix-next.log");
    if log_path.exists() {
        std::fs::write(&log_path, "")
            .map_err(|e| AppError::Io(format!("Failed to clear log: {}", e)))?;
        log::info!("log file cleared: {}", log_path.display());
    }
    Ok(())
}

/// Collects all log files from the app log directory and compresses them
/// into a ZIP archive at the user-specified path (chosen via a save dialog
/// on the frontend). Includes:
/// - `system-info.json` with enriched machine/runtime context for diagnostics
/// - All log files from the app log directory
/// - `config.json` user configuration snapshot for issue reproduction
///
/// Returns the full path to the created ZIP file.
#[tauri::command]
pub async fn export_diagnostic_logs(app: AppHandle, save_path: String) -> Result<String, AppError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;

    if !log_dir.exists() {
        return Err(AppError::NotFound("Log directory does not exist".into()));
    }

    let zip_path = std::path::PathBuf::from(&save_path);

    let zip_file = std::fs::File::create(&zip_path)
        .map_err(|e| AppError::Io(format!("Failed to create zip: {}", e)))?;
    let mut zip_writer = zip::ZipWriter::new(zip_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // ── System info: enriched machine context for diagnostics ────────
    let pkg = app.package_info();
    let engine_pid = app
        .state::<crate::engine::EngineState>()
        .child
        .lock()
        .expect("engine state lock poisoned")
        .as_ref()
        .map(tauri_plugin_shell::process::CommandChild::pid);
    let system_info = serde_json::json!({
        "os": std::env::consts::OS,
        "os_version": os_info::get().version().to_string(),
        "arch": std::env::consts::ARCH,
        "locale": sys_locale::get_locale().unwrap_or_default(),
        "app_version": pkg.version.to_string(),
        "app_name": pkg.name,
        "log_level": format!("{}", crate::read_log_level()),
        "engine_pid": engine_pid,
        "webkit_dmabuf_disabled": std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .unwrap_or_default(),
        "gpu_hardware_rendering": crate::gpu_guard::is_hardware_rendering_enabled(),
        "exported_at": chrono::Local::now().to_rfc3339(),
    });
    let info_bytes = serde_json::to_vec_pretty(&system_info)
        .map_err(|e| AppError::Io(format!("Failed to serialize system info: {}", e)))?;
    zip_writer
        .start_file("system-info.json", options)
        .map_err(|e| AppError::Io(format!("Failed to add system-info.json: {}", e)))?;
    std::io::Write::write_all(&mut zip_writer, &info_bytes)
        .map_err(|e| AppError::Io(format!("Failed to write system-info.json: {}", e)))?;

    // ── Log files ───────────────────────────────────────────────────
    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| AppError::Io(format!("Failed to read log dir: {}", e)))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let content = std::fs::read(&path)
                .map_err(|e| AppError::Io(format!("Failed to read {}: {}", name, e)))?;
            zip_writer
                .start_file(name.to_string(), options)
                .map_err(|e| AppError::Io(format!("Failed to add {} to zip: {}", name, e)))?;
            std::io::Write::write_all(&mut zip_writer, &content)
                .map_err(|e| AppError::Io(format!("Failed to write {}: {}", name, e)))?;
        }
    }

    // ── Config snapshot: user preferences for issue reproduction ─────
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let config_path = data_dir.join("config.json");
    if config_path.exists() {
        let config_content = std::fs::read(&config_path)
            .map_err(|e| AppError::Io(format!("Failed to read config: {}", e)))?;
        let sanitized = match serde_json::from_slice::<Value>(&config_content) {
            Ok(value) => serde_json::to_vec_pretty(&sanitize_config_snapshot(&value))
                .map_err(|e| AppError::Io(format!("Failed to sanitize config: {}", e)))?,
            Err(e) => {
                log::warn!("diagnostic export: config parse failed, omitting raw config: {e}");
                serde_json::to_vec_pretty(&serde_json::json!({
                    "error": "Failed to sanitize config snapshot"
                }))
                .map_err(|serr| {
                    AppError::Io(format!("Failed to serialize config fallback: {}", serr))
                })?
            }
        };
        zip_writer
            .start_file("config.json", options)
            .map_err(|e| AppError::Io(format!("Failed to add config.json: {}", e)))?;
        std::io::Write::write_all(&mut zip_writer, &sanitized)
            .map_err(|e| AppError::Io(format!("Failed to write config.json: {}", e)))?;
    }

    zip_writer
        .finish()
        .map_err(|e| AppError::Io(format!("Failed to finalize zip: {}", e)))?;

    log::info!("Exported diagnostic logs to {}", zip_path.display());
    Ok(crate::engine::path_to_safe_string(&zip_path))
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn redact_url_credentials_masks_auth_section() {
        assert_eq!(
            redact_url_credentials("http://user:pass@example.com:8080"),
            "http://[REDACTED]@example.com:8080"
        );
    }

    #[test]
    fn sanitize_config_snapshot_redacts_api_secrets_cookie_and_proxy_server() {
        let raw = serde_json::json!({
            "preferences": {
                "rpcSecret": "secret",
                "extensionApiSecret": "api-secret",
                "cookie": "session=abc",
                "proxy": {
                    "server": "http://user:pass@example.com:8080"
                }
            }
        });
        let sanitized = sanitize_config_snapshot(&raw);
        let prefs = sanitized
            .get("preferences")
            .and_then(Value::as_object)
            .expect("preferences object must exist");
        assert_eq!(
            prefs.get("rpcSecret").and_then(Value::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            prefs.get("extensionApiSecret").and_then(Value::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            prefs.get("cookie").and_then(Value::as_str),
            Some("[REDACTED]")
        );
        assert_eq!(
            prefs
                .get("proxy")
                .and_then(Value::as_object)
                .and_then(|proxy| proxy.get("server"))
                .and_then(Value::as_str),
            Some("http://[REDACTED]@example.com:8080")
        );
    }
}

/// Checks whether a file or directory exists at the given path.
///
/// This command bypasses Tauri's frontend FS scope restrictions, which
/// fail to match Windows drive-root paths like `Z:\` due to glob pattern
/// limitations (see <https://github.com/tauri-apps/tauri/issues/11119>).
///
/// For a download manager that must verify user-chosen download targets on
/// any mounted volume, scope-free existence checks are essential.
#[tauri::command]
pub fn check_path_exists(path: String) -> bool {
    let result = std::path::Path::new(&path).exists();
    log::debug!("check_path_exists: path={path:?} result={result}");
    result
}

/// Returns `true` when the given path exists **and** is a directory.
///
/// Counterpart to [`check_path_exists`] — used by the frontend to decide
/// whether to call `openPath` (for a directory) or `revealItemInDir` (for
/// a file). Same scope-bypass rationale applies.
#[tauri::command]
pub fn check_path_is_dir(path: String) -> bool {
    let result = std::path::Path::new(&path).is_dir();
    log::debug!("check_path_is_dir: path={path:?} result={result}");
    result
}

/// Reads a local file selected or referenced by the user.
///
/// This command keeps arbitrary user-path reads behind Rust IPC instead of
/// granting the frontend plugin a wildcard filesystem scope.
#[tauri::command]
pub fn read_local_file(path: String) -> Result<Vec<u8>, AppError> {
    std::fs::read(&path).map_err(|e| AppError::Io(format!("Failed to read file: {e}")))
}

/// Lists regular file names in a directory.
///
/// Used for aria2 metadata cleanup without exposing a wildcard frontend FS
/// scope. Directory traversal stays in Rust, and only file names are returned.
#[tauri::command]
pub fn list_dir_files(path: String) -> Result<Vec<String>, AppError> {
    let entries =
        std::fs::read_dir(&path).map_err(|e| AppError::Io(format!("Failed to read dir: {e}")))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        if entry.path().is_file() {
            if let Some(name) = entry.file_name().to_str() {
                files.push(name.to_string());
            }
        }
    }
    Ok(files)
}

/// Normalizes a file-system path for safe use with OS shell APIs.
///
/// Handles three classes of path issues that cause "file not found" errors:
/// 1. **Mixed separators** — aria2 on Windows may return `Z:\\` while JS
///    joins with `/`, producing `Z:\\/file.exe`. `Path::new()` normalizes
///    this to the platform's native separator.
/// 2. **`\\?\\` prefix** — `std::fs::canonicalize()` on Windows may return
///    extended-length paths (`\\?\\C:\\...`). `dunce::simplified()` strips
///    this prefix when safe, since Win32 Shell APIs like `ILCreateFromPathW`
///    do not support it.
/// 3. **Trailing separators** — Ensures paths ending in `\\` or `/` do not
///    confuse shell APIs.
pub(crate) fn normalize_path(raw: &str) -> String {
    use std::path::PathBuf;
    // Step 1: Decompose into components and reassemble with native separators.
    // On Windows, `Path::new("Z:/file")` understands `/` but `to_string_lossy()`
    // returns the ORIGINAL string unchanged. `.components().collect::<PathBuf>()`
    // reconstructs with `\` on Windows, `/` on Unix.
    let reassembled: PathBuf = Path::new(raw).components().collect();
    // Step 2: Strip `\\?\` prefix if present (safe for Win32 Shell APIs).
    let normalized = dunce::simplified(&reassembled);
    log::debug!("normalize_path: raw={raw:?} normalized={normalized:?}");
    normalized.to_string_lossy().to_string()
}

/// Reveals a file or directory in the system file explorer.
///
/// ## Windows
///
/// Bypasses `tauri_plugin_opener::reveal_item_in_dir` because that plugin
/// calls `dunce::canonicalize()` internally (L13 of `reveal_item_in_dir.rs`),
/// which converts mapped-drive paths (e.g. `Z:\file`) to UNC format
/// (`\\?\UNC\server\share\file`). `ILCreateFromPathW` cannot handle the
/// `\\?\UNC\` prefix → returns NULL → os error 2.
/// See: <https://github.com/tauri-apps/plugins-workspace/issues/3304>
///
/// Instead, we call the Windows Shell APIs directly:
/// 1. Normalize separators via `components().collect()`
/// 2. Canonicalize via `dunce::canonicalize()` (strips `\\?\` for local drives)
/// 3. Strip residual `\\?\UNC\` prefix → `\\server\share\...` (for mapped drives)
/// 4. Call `ILCreateFromPathW` + `SHOpenFolderAndSelectItems`
/// 5. Fallback: `ShellExecuteExW` on `ERROR_FILE_NOT_FOUND` (Electron pattern)
///
/// ## macOS / Linux
///
/// Delegates to `tauri_plugin_opener::reveal_item_in_dir` (no UNC bug on these
/// platforms — macOS uses `NSWorkspace`, Linux uses D-Bus FileManager1).
#[tauri::command]
pub fn show_item_in_dir(path: String) -> Result<(), AppError> {
    let normalized = normalize_path(&path);
    log::debug!("show_item_in_dir: original={path:?} normalized={normalized:?}");
    reveal_in_explorer(&normalized)
}

/// Platform-dispatched implementation for revealing files in the explorer.
#[cfg(not(windows))]
fn reveal_in_explorer(path: &str) -> Result<(), AppError> {
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|e| AppError::Io(format!("Failed to reveal: {e}")))
}

/// Windows implementation: direct Shell API calls with UNC prefix stripping.
///
/// Mirrors the approach used by:
/// - Electron: `shell/common/platform_util_win.cc` L282-310
/// - tauri-plugin-opener: `reveal_item_in_dir.rs` L99-160 (but with UNC fix)
#[cfg(windows)]
fn reveal_in_explorer(path: &str) -> Result<(), AppError> {
    use std::path::PathBuf;
    use windows_sys::Win32::{
        Foundation::ERROR_FILE_NOT_FOUND,
        System::Com::CoInitializeEx,
        UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems},
    };

    // Step 1: Best-effort canonicalization.
    // `dunce::canonicalize` resolves symlinks and strips `\\?\` for local drives.
    // However, some virtual file system drivers (RAM disks like ImDisk, Ruanmei Mofang)
    // do not support `GetFinalPathNameByHandleW` — the API that `canonicalize()`
    // relies on — and return ERROR_FILE_NOT_FOUND even though the file exists.
    // See: https://github.com/rust-lang/rust/issues/99608
    // Fallback: use the already-normalized path from `normalize_path()`.
    let canonical = dunce::canonicalize(path).unwrap_or_else(|e| {
        log::debug!("canonicalize failed (virtual FS?), using normalized path: {e}");
        PathBuf::from(path)
    });

    // Step 2: Strip `\\?\UNC\` prefix for mapped drives.
    // `\\?\UNC\server\share\file` → `\\server\share\file`
    // This is the fix for GitHub issue #3304.
    let path_str = canonical.to_string_lossy();
    let fixed: PathBuf = if let Some(stripped) = path_str.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{stripped}"))
    } else if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
        // Shouldn't happen (dunce handles this), but defensive
        PathBuf::from(stripped)
    } else {
        canonical.clone()
    };

    log::debug!("reveal_in_explorer: canonical={canonical:?} fixed={fixed:?}");

    // Step 3: Get the parent directory for SHOpenFolderAndSelectItems.
    let parent = fixed
        .parent()
        .ok_or_else(|| AppError::Io(format!("No parent directory for {path:?}")))?;

    // Step 4: Convert paths to wide strings (null-terminated UTF-16).
    let parent_wide = to_wide(parent.to_string_lossy().as_ref());
    let file_wide = to_wide(fixed.to_string_lossy().as_ref());

    unsafe {
        // Initialize COM (required for Shell APIs, idempotent).
        let _ = CoInitializeEx(std::ptr::null(), 0);

        // Convert parent directory to ITEMIDLIST.
        let parent_pidl = ILCreateFromPathW(parent_wide.as_ptr());
        if parent_pidl.is_null() {
            // Fallback: open the parent directory directly.
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        // Convert target file to ITEMIDLIST.
        let file_pidl = ILCreateFromPathW(file_wide.as_ptr());
        if file_pidl.is_null() {
            ILFree(parent_pidl);
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        // Open folder and select the file.
        let items: [*const _; 1] = [file_pidl as *const _];
        let result = SHOpenFolderAndSelectItems(parent_pidl, 1, items.as_ptr(), 0);

        // Electron-style fallback: on ERROR_FILE_NOT_FOUND, use ShellExecuteW.
        // "On some systems, the above call mysteriously fails with 'file not found'
        //  even though the file is there." — Electron source
        if result != 0 && (result as u32) == ERROR_FILE_NOT_FOUND {
            ILFree(file_pidl);
            ILFree(parent_pidl);
            return shell_execute_open(parent.to_string_lossy().as_ref());
        }

        ILFree(file_pidl);
        ILFree(parent_pidl);

        if result != 0 {
            return Err(AppError::Io(format!(
                "SHOpenFolderAndSelectItems failed: HRESULT 0x{result:08X}"
            )));
        }
    }

    Ok(())
}

/// Fallback: open a directory with `ShellExecuteW("explore")`.
#[cfg(windows)]
fn shell_execute_open(dir: &str) -> Result<(), AppError> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let dir_wide = to_wide(dir);
    let verb_wide = to_wide("explore");

    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(), // hwnd
            verb_wide.as_ptr(),   // lpOperation: "explore"
            dir_wide.as_ptr(),    // lpFile: directory path
            std::ptr::null(),     // lpParameters
            std::ptr::null(),     // lpDirectory
            SW_SHOWNORMAL,        // nShowCmd
        )
    };
    // ShellExecuteW returns HINSTANCE > 32 on success.
    if (result as isize) <= 32 {
        Err(AppError::Io(format!("ShellExecuteW failed for {dir:?}")))
    } else {
        Ok(())
    }
}

/// Convert a &str to a null-terminated Vec<u16> for Win32 wide-string APIs.
#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Opens a file or directory with the system's default application.
///
/// Normalizes the path before calling the opener to handle mixed separators.
/// Counterpart to [`show_item_in_dir`] — used when the target is a directory
/// (opens in file manager) or a file (opens with default app).
#[tauri::command]
pub fn open_path_normalized(app: AppHandle, path: String) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    log::debug!("file:open path={path:?}");
    let normalized = normalize_path(&path);
    app.opener()
        .open_path(&normalized, None::<&str>)
        .map_err(|e| AppError::Io(format!("Failed to open {}: {}", path, e)))
}

/// Moves a file to the OS trash / recycle bin.
///
/// Uses the `trash` crate for cross-platform support:
/// - macOS: NSFileManager.trashItemAtURL
/// - Windows: IFileOperation + FOFX_RECYCLEONDELETE
/// - Linux: FreeDesktop Trash spec (XDG_DATA_HOME/Trash)
#[tauri::command]
pub fn trash_file(path: String) -> Result<(), AppError> {
    log::info!("file:trash path={path:?}");
    trash::delete(&path).map_err(|e| AppError::Io(e.to_string()))
}

/// Moves a file to a target directory, creating the directory if needed.
///
/// Uses `std::fs::rename` for same-filesystem moves (zero-copy, atomic).
/// Falls back to copy+delete for cross-filesystem moves (e.g. NAS, external drives).
/// Returns the absolute path of the moved file.
///
/// Used by the auto-archive feature to relocate completed downloads into
/// category directories based on file extension classification.
#[tauri::command]
pub fn move_file(source: String, target_dir: String) -> Result<String, AppError> {
    let src = Path::new(&source);
    if !src.is_file() {
        return Err(AppError::Io(format!("Source is not a file: {source:?}")));
    }

    let target = Path::new(&target_dir);
    if !target.exists() {
        std::fs::create_dir_all(target)
            .map_err(|e| AppError::Io(format!("Failed to create directory {target_dir:?}: {e}")))?;
    }

    let file_name = src
        .file_name()
        .ok_or_else(|| AppError::Io(format!("Cannot extract filename from {source:?}")))?;
    let dest = target.join(file_name);

    // Avoid overwriting existing files — append (1), (2), etc.
    let dest = if dest.exists() {
        let stem = dest
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = dest.extension().map(|e| e.to_string_lossy().to_string());
        let mut counter = 1u32;
        loop {
            let new_name = match &ext {
                Some(e) => format!("{stem} ({counter}).{e}"),
                None => format!("{stem} ({counter})"),
            };
            let candidate = target.join(&new_name);
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
            if counter > 999 {
                return Err(AppError::Io(format!(
                    "Too many name collisions for {file_name:?} in {target_dir:?}"
                )));
            }
        }
    } else {
        dest
    };

    log::info!("file:move {source:?} → {dest:?}");

    // Try rename first (same filesystem = atomic, zero-copy)
    match std::fs::rename(src, &dest) {
        Ok(()) => {}
        Err(e)
            if e.raw_os_error() == Some(18 /* EXDEV */)
                || e.kind() == std::io::ErrorKind::Other =>
        {
            // Cross-filesystem: copy + delete
            std::fs::copy(src, &dest)
                .map_err(|e| AppError::Io(format!("Failed to copy {source:?} to {dest:?}: {e}")))?;
            std::fs::remove_file(src).map_err(|e| {
                AppError::Io(format!(
                    "File copied to {dest:?} but failed to remove source {source:?}: {e}"
                ))
            })?;
        }
        Err(e) => {
            return Err(AppError::Io(format!(
                "Failed to move {source:?} to {dest:?}: {e}"
            )));
        }
    }

    // Normalize to forward slashes — aria2 and the frontend canonicalize
    // all paths with `/`.  On Windows, PathBuf::join() produces `\`.
    Ok(crate::engine::path_to_safe_string(&dest).replace('\\', "/"))
}

/// Permanently deletes a file from disk (NOT move to trash).
///
/// Used for internal aria2 metadata files that have no user value:
/// - `.aria2` control files (piece bitmap + checksums)
/// - hex40-named `.torrent` metadata (`rpc-save-upload-metadata`)
///
/// This replicates what aria2's native `removeControlFile()` does (`std::remove`).
/// The frontend MUST only call this for files it has verified are internal
/// aria2 metadata — never for user-downloaded content (use `trash_file` instead).
#[tauri::command]
pub fn remove_file(path: String) -> Result<(), AppError> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Ok(());
    }
    log::debug!("file:remove path={path:?}");
    std::fs::remove_file(p).map_err(|e| AppError::Io(e.to_string()))
}

/// Returns `true` when the WebKitGTK DMABuf renderer has been disabled via
/// the `WEBKIT_DISABLE_DMABUF_RENDERER` environment variable.
///
/// # Context
///
/// WORKAROUND for WebKitGTK Bug #262607 (RESOLVED WONTFIX).
/// <https://bugs.webkit.org/show_bug.cgi?id=262607>
///
/// WebKitGTK's DMA-BUF renderer crashes on various GPU/driver/compositor
/// combinations (NVIDIA, Intel UHD + Wayland, Broadcom on RPi, VM guests).
/// By default, hardware rendering is OFF (`WEBKIT_DISABLE_DMABUF_RENDERER=1`).
/// Users can opt in via Advanced → "Hardware Rendering".
///
/// The frontend uses this flag to decide:
/// - `false` → safe to remove border-radius on maximize (normal behavior)
/// - `true`  → keep border-radius at all times (software compositing workaround)
///
/// On non-Linux platforms this always returns `false`.
#[tauri::command]
pub fn is_dmabuf_renderer_disabled() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs_source() -> String {
        include_str!("fs.rs").replace("\r\n", "\n")
    }

    fn native_expected_path(path: &str) -> String {
        if cfg!(windows) {
            path.replace('/', "\\")
        } else {
            path.to_string()
        }
    }

    // ── check_path_exists ──────────────────────────────────────────────

    #[test]
    fn check_path_exists_returns_true_for_existing_file() {
        // Cargo.toml always exists at the workspace root when tests run
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/Cargo.toml";
        assert!(check_path_exists(path));
    }

    #[test]
    fn check_path_exists_returns_true_for_existing_directory() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/src";
        assert!(check_path_exists(path));
    }

    #[test]
    fn check_path_exists_returns_false_for_nonexistent_path() {
        assert!(!check_path_exists(
            "/definitely/does/not/exist/anywhere/file.txt".to_string()
        ));
    }

    #[test]
    fn check_path_exists_returns_false_for_empty_string() {
        assert!(!check_path_exists(String::new()));
    }

    #[test]
    fn check_path_exists_handles_path_with_spaces() {
        // Create a temp file with spaces in the path
        let dir = std::env::temp_dir().join("motrix test spaces");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("test file.txt");
        let _ = std::fs::write(&file, "test");
        assert!(check_path_exists(file.to_string_lossy().to_string()));
        // Cleanup
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    // ── check_path_is_dir ──────────────────────────────────────────────

    #[test]
    fn check_path_is_dir_returns_true_for_directory() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/src";
        assert!(check_path_is_dir(path));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_file() {
        let path = env!("CARGO_MANIFEST_DIR").to_string() + "/Cargo.toml";
        assert!(!check_path_is_dir(path));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_nonexistent() {
        assert!(!check_path_is_dir("/does/not/exist/whatsoever".to_string()));
    }

    #[test]
    fn check_path_is_dir_returns_false_for_empty_string() {
        assert!(!check_path_is_dir(String::new()));
    }

    // ── normalize_path ─────────────────────────────────────────────────

    #[test]
    fn normalize_path_uses_native_separators_for_simple_path() {
        let result = normalize_path("/home/user/downloads/file.txt");
        assert_eq!(
            result,
            native_expected_path("/home/user/downloads/file.txt")
        );
    }

    #[test]
    fn normalize_path_uses_native_separators_for_path_with_spaces() {
        let result = normalize_path("/home/user/my downloads/file name.txt");
        assert_eq!(
            result,
            native_expected_path("/home/user/my downloads/file name.txt")
        );
    }

    #[test]
    fn normalize_path_handles_empty_string() {
        let result = normalize_path("");
        assert_eq!(result, "");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_fixes_mixed_separators_windows() {
        // aria2 returns `Z:\\` + JS joins with `/` → `Z:\\/file.exe`
        let result = normalize_path("Z:\\/MotrixNext_setup.exe");
        assert_eq!(result, "Z:\\MotrixNext_setup.exe");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_fixes_double_backslash_forward_slash() {
        let result = normalize_path("D:\\/downloads/subfolder/file.zip");
        assert_eq!(result, "D:\\downloads\\subfolder\\file.zip");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_strips_extended_length_prefix() {
        // std::fs::canonicalize adds \\?\\
        let result = normalize_path("\\\\?\\C:\\Users\\test\\file.txt");
        assert_eq!(result, "C:\\Users\\test\\file.txt");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_handles_windows_unc_path() {
        let result = normalize_path("\\\\server\\share\\file.txt");
        assert_eq!(result, "\\\\server\\share\\file.txt");
    }

    #[test]
    fn normalize_path_handles_forward_slash_only_with_native_separators() {
        let result = normalize_path("/var/log/app.log");
        assert_eq!(result, native_expected_path("/var/log/app.log"));
    }

    // ── show_item_in_dir structural tests ──────────────────────────────

    /// Verifies show_item_in_dir calls normalize_path then reveal_in_explorer.
    #[test]
    fn show_item_in_dir_calls_normalize_then_reveal() {
        let source = fs_source();
        let fn_start = source
            .find("pub fn show_item_in_dir")
            .expect("show_item_in_dir function must exist");
        let fn_body = &source[fn_start..fn_start + 500];
        let norm_pos = fn_body
            .find("normalize_path")
            .expect("show_item_in_dir must call normalize_path");
        let reveal_pos = fn_body
            .find("reveal_in_explorer")
            .expect("show_item_in_dir must call reveal_in_explorer");
        assert!(
            norm_pos < reveal_pos,
            "normalize_path must appear before reveal_in_explorer"
        );
    }

    /// Verifies Windows cfg-gate exists and bypasses tauri_plugin_opener.
    #[test]
    fn reveal_in_explorer_has_windows_cfg_gate() {
        let source = fs_source();
        // Must have #[cfg(windows)] fn reveal_in_explorer
        assert!(
            source.contains("#[cfg(windows)]\nfn reveal_in_explorer"),
            "reveal_in_explorer must have a #[cfg(windows)] variant"
        );
        // Must have #[cfg(not(windows))] fn reveal_in_explorer
        assert!(
            source.contains("#[cfg(not(windows))]\nfn reveal_in_explorer"),
            "reveal_in_explorer must have a #[cfg(not(windows))] fallback"
        );
    }

    /// Verifies the Windows implementation uses ILCreateFromPathW (not plugin).
    #[test]
    fn windows_reveal_uses_shell_api() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains("ILCreateFromPathW"),
            "Windows reveal must use ILCreateFromPathW"
        );
        assert!(
            fn_body.contains("SHOpenFolderAndSelectItems"),
            "Windows reveal must use SHOpenFolderAndSelectItems"
        );
    }

    /// Verifies the Windows implementation strips \\?\UNC\ prefix (issue #3304 fix).
    #[test]
    fn windows_reveal_strips_unc_prefix() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains(r#"strip_prefix(r"\\?\UNC\")"#),
            "Windows reveal must check for \\\\?\\UNC\\ prefix"
        );
    }

    /// Verifies the Windows implementation has an Electron-style ShellExecuteExW fallback.
    #[test]
    fn windows_reveal_has_shell_execute_fallback() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        assert!(
            fn_body.contains("shell_execute_open"),
            "Windows reveal must have ShellExecuteExW fallback"
        );
        assert!(
            fn_body.contains("ERROR_FILE_NOT_FOUND"),
            "Windows reveal must handle ERROR_FILE_NOT_FOUND"
        );
    }

    /// Verifies non-Windows fallback uses tauri_plugin_opener.
    #[test]
    fn non_windows_reveal_uses_plugin_opener() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(not(windows))]\nfn reveal_in_explorer")
            .expect("non-Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 300];
        assert!(
            fn_body.contains("tauri_plugin_opener::reveal_item_in_dir"),
            "non-Windows fallback must use tauri_plugin_opener"
        );
    }

    // ── canonicalize best-effort tests (RAM disk / virtual FS) ────────

    /// Verifies canonicalize uses unwrap_or_else (best-effort, never hard-fails).
    /// Critical for RAM disks (ImDisk, Ruanmei Mofang) where GetFinalPathNameByHandleW
    /// is unsupported. See: https://github.com/rust-lang/rust/issues/99608
    #[test]
    fn windows_reveal_canonicalize_is_best_effort() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        // Must use unwrap_or_else (graceful fallback), NOT map_err/? (hard error)
        assert!(
            fn_body.contains("dunce::canonicalize(path).unwrap_or_else"),
            "canonicalize must use unwrap_or_else for best-effort (not map_err/?)"
        );
        // Must NOT have map_err on canonicalize (regression guard)
        let canonicalize_pos = fn_body
            .find("dunce::canonicalize")
            .expect("must call dunce::canonicalize");
        let after_canonicalize = &fn_body[canonicalize_pos..canonicalize_pos + 200];
        assert!(
            !after_canonicalize.contains("map_err"),
            "canonicalize must NOT use map_err (would hard-fail on RAM disks)"
        );
        assert!(
            !after_canonicalize.contains(")?"),
            "canonicalize must NOT use ? operator (would hard-fail on RAM disks)"
        );
    }

    /// Verifies canonicalize fallback logs a debug message for diagnostics.
    #[test]
    fn windows_reveal_canonicalize_fallback_logs_debug() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        // The unwrap_or_else closure must log the error
        let fallback_start = fn_body
            .find("unwrap_or_else")
            .expect("must have unwrap_or_else");
        let fallback_body = &fn_body[fallback_start..fallback_start + 200];
        assert!(
            fallback_body.contains("log::debug!"),
            "canonicalize fallback must log debug message with the error"
        );
    }

    /// Verifies canonicalize fallback creates PathBuf from the input path.
    #[test]
    fn windows_reveal_canonicalize_fallback_uses_input_path() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        let fallback_start = fn_body
            .find("unwrap_or_else")
            .expect("must have unwrap_or_else");
        let fallback_body = &fn_body[fallback_start..fallback_start + 200];
        assert!(
            fallback_body.contains("PathBuf::from(path)"),
            "canonicalize fallback must use the already-normalized input path"
        );
    }

    /// Verifies shell_execute_open uses ShellExecuteW (not ShellExecuteExW).
    /// ShellExecuteExW requires Win32_System_Registry feature; ShellExecuteW does not.
    #[test]
    fn shell_execute_open_uses_shell_execute_w() {
        let source = fs_source();
        // Verify the import line exists in the actual function (not test code).
        // The function imports "Shell::ShellExecuteW;" (note the semicolon — not Ex variant).
        assert!(
            source.contains("Shell::ShellExecuteW;"),
            "shell_execute_open must import ShellExecuteW"
        );
    }

    /// Verifies the to_wide helper function exists with cfg(windows).
    #[test]
    fn to_wide_helper_exists() {
        let source = fs_source();
        // Check the cfg gate + function signature + utf16 encoding all exist
        assert!(
            source.contains("#[cfg(windows)]\nfn to_wide("),
            "to_wide helper must exist with #[cfg(windows)]"
        );
        assert!(
            source.contains("encode_utf16"),
            "to_wide must use encode_utf16 for wide string conversion"
        );
    }

    /// Verifies show_item_in_dir includes debug logging for traceability.
    #[test]
    fn show_item_in_dir_has_debug_logging() {
        let source = fs_source();
        // Search within the function body (between pub fn and next fn/doc comment)
        let fn_start = source
            .find("pub fn show_item_in_dir")
            .expect("show_item_in_dir function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(fn_start + 500);
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("log::debug!"),
            "show_item_in_dir must include debug logging"
        );
    }

    /// Verifies Windows reveal_in_explorer initializes COM before Shell API calls.
    #[test]
    fn windows_reveal_initializes_com() {
        let source = fs_source();
        let cfg_start = source
            .find("#[cfg(windows)]\nfn reveal_in_explorer")
            .expect("Windows reveal_in_explorer must exist");
        let fn_body = &source[cfg_start..cfg_start + 2500];
        let com_pos = fn_body
            .find("CoInitializeEx")
            .expect("Windows reveal must initialize COM");
        let shell_pos = fn_body
            .find("ILCreateFromPathW")
            .expect("must call ILCreateFromPathW");
        assert!(
            com_pos < shell_pos,
            "COM init must happen before Shell API calls"
        );
    }

    /// Verifies open_path_normalized calls normalize_path before open_path.
    #[test]
    fn open_path_normalized_calls_normalize_path() {
        let source = fs_source();
        let fn_start = source
            .find("pub fn open_path_normalized")
            .expect("open_path_normalized function must exist");
        let fn_body = &source[fn_start..fn_start + 500];
        let norm_pos = fn_body
            .find("normalize_path(")
            .expect("open_path_normalized must call normalize_path()");
        let open_pos = fn_body
            .find("open_path(")
            .expect("open_path_normalized must call open_path()");
        assert!(
            norm_pos < open_pos,
            "normalize_path must be called before open_path"
        );
    }

    // ── normalize_path tests ──────────────────────────────────────────

    /// Verifies normalize_path uses components().collect() for separator normalization.
    #[test]
    fn normalize_path_uses_components_collect() {
        let source = fs_source();
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("components().collect"),
            "normalize_path must use components().collect() for separator normalization"
        );
    }

    /// Verifies normalize_path uses dunce::simplified for prefix stripping.
    #[test]
    fn normalize_path_uses_dunce() {
        let source = fs_source();
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("dunce::simplified"),
            "normalize_path must use dunce::simplified for \\\\?\\ prefix stripping"
        );
    }

    /// Verifies normalize_path includes debug logging.
    #[test]
    fn normalize_path_has_debug_logging() {
        let source = fs_source();
        let fn_start = source
            .find("pub(crate) fn normalize_path")
            .expect("normalize_path function must exist");
        let fn_end = source[fn_start..]
            .find("\n/// ")
            .or_else(|| source[fn_start..].find("\n#["))
            .map(|p| fn_start + p)
            .unwrap_or(source.len());
        let fn_body = &source[fn_start..fn_end];
        assert!(
            fn_body.contains("log::debug!"),
            "normalize_path must include debug logging"
        );
    }

    // ── remove_file ─────────────────────────────────────────────────

    #[test]
    fn remove_file_deletes_existing_file() {
        let dir = std::env::temp_dir().join("motrix_test_remove");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("test.aria2");
        std::fs::write(&file, "control data").expect("write test file");
        assert!(file.exists(), "precondition: file must exist");

        let result = remove_file(file.to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(!file.exists(), "file must be permanently deleted");

        // Cleanup
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn remove_file_returns_ok_for_nonexistent() {
        let result = remove_file("/definitely/does/not/exist/file.aria2".to_string());
        assert!(
            result.is_ok(),
            "remove_file must be a silent no-op for missing files"
        );
    }

    #[test]
    fn remove_file_returns_ok_for_empty_string() {
        let result = remove_file(String::new());
        assert!(
            result.is_ok(),
            "remove_file must handle empty path gracefully"
        );
    }

    #[test]
    fn remove_file_handles_path_with_spaces() {
        let dir = std::env::temp_dir().join("motrix test remove spaces");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("my download.aria2");
        std::fs::write(&file, "data").expect("write");

        let result = remove_file(file.to_string_lossy().to_string());
        assert!(result.is_ok());
        assert!(!file.exists());

        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn remove_file_does_not_delete_directories() {
        let dir = std::env::temp_dir().join("motrix_test_remove_dir_guard");
        let _ = std::fs::create_dir_all(&dir);
        assert!(dir.exists(), "precondition: dir must exist");

        // std::fs::remove_file on a directory fails — verify it returns Err
        let result = remove_file(dir.to_string_lossy().to_string());
        assert!(result.is_err(), "remove_file must not delete directories");
        assert!(
            dir.exists(),
            "directory must still exist after failed removal"
        );

        let _ = std::fs::remove_dir(&dir);
    }
}
