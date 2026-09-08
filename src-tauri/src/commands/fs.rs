use crate::error::AppError;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use tauri::AppHandle;
use tauri::Manager;

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
///   because diagnostic exports can include debug logs when users enable them
///   for issue reproduction
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

fn clear_managed_log_files_in_dir(log_dir: &Path) -> Result<(), AppError> {
    if !log_dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(log_dir)
        .map_err(|e| AppError::Io(format!("Failed to read log dir: {e}")))?
        .flatten()
    {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !path.is_file() {
            continue;
        }
        if crate::log_policy::is_managed_active_log_file(name) {
            std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .map_err(|e| AppError::Io(format!("Failed to clear active log: {e}")))?;
        } else if crate::log_policy::managed_log_source(name).is_some() {
            std::fs::remove_file(&path)
                .map_err(|e| AppError::Io(format!("Failed to remove rotated log: {e}")))?;
        }
    }
    Ok(())
}

/// Clears managed logs in the app log directory.
#[tauri::command]
pub fn clear_log_file(app: AppHandle) -> Result<(), AppError> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    clear_managed_log_files_in_dir(&log_dir)
}

/// Exports a redacted runtime snapshot and the complete application and engine logs.
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

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let config_path = data_dir.join("config.json");
    let raw_config = if config_path.exists() {
        match std::fs::read(&config_path) {
            Ok(content) => match serde_json::from_slice::<Value>(&content) {
                Ok(value) => Some(value),
                Err(e) => {
                    log::warn!("diagnostic export: config parse failed, omitting raw config: {e}");
                    None
                }
            },
            Err(e) => {
                log::warn!("diagnostic export: config read failed: {e}");
                None
            }
        }
    } else {
        None
    };
    log::logger().flush();
    if let (Some(state), Some(level)) = (
        app.try_state::<crate::aria2::client::Aria2State>(),
        raw_config
            .as_ref()
            .and_then(|value| value.get("preferences"))
            .and_then(|value| value.get("aria2LogLevel"))
            .and_then(Value::as_str),
    ) {
        let mut log_option = serde_json::Map::new();
        log_option.insert("log-level".to_string(), Value::String(level.to_string()));
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            state.0.change_global_option(log_option),
        )
        .await;
    }

    let logs = crate::diagnostics::collect_logs(&log_dir)?;
    let diagnostics = crate::diagnostics::runtime_snapshot(&app, raw_config.as_ref()).await;
    crate::diagnostics::write_archive(&zip_path, &logs, &diagnostics)?;

    log::info!(target: "diagnostics", event = "diagnostics_exported", path:% = zip_path.display(); "diagnostics_exported");
    Ok(crate::engine::path_to_safe_string(&zip_path))
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn clear_managed_log_files_truncates_active_logs_and_removes_rotations() {
        let dir = tempfile::tempdir().expect("tempdir");
        let motrix = dir.path().join("motrix-next.log");
        let aria2 = dir.path().join("aria2-next.log");
        let rotated = dir.path().join("aria2-next.1.log");
        let motrix_rotated = dir.path().join("motrix-next_2026-08-27_12-00-00.log");
        let other = dir.path().join("other.log");

        std::fs::write(&motrix, "motrix log").expect("motrix log");
        std::fs::write(&aria2, "aria2 log").expect("aria2 log");
        std::fs::write(&rotated, "rotated log").expect("rotated log");
        std::fs::write(&motrix_rotated, "rotated log").expect("motrix rotated log");
        std::fs::write(&other, "other log").expect("other log");

        clear_managed_log_files_in_dir(dir.path()).expect("clear logs");

        assert_eq!(
            std::fs::metadata(&motrix).expect("motrix metadata").len(),
            0
        );
        assert_eq!(std::fs::metadata(&aria2).expect("aria2 metadata").len(), 0);
        assert!(!rotated.exists());
        assert!(!motrix_rotated.exists());
        assert_eq!(
            std::fs::read_to_string(&other).expect("other content"),
            "other log"
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
    let fixed: PathBuf = if path_str.starts_with(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", &path_str[r"\\?\UNC\".len()..]))
    } else if path_str.starts_with(r"\\?\") {
        // Shouldn't happen (dunce handles this), but defensive
        PathBuf::from(&path_str[r"\\?\".len()..])
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileDeletionMode {
    Trash,
    Permanent,
}

#[tauri::command]
pub fn delete_path(path: String, mode: FileDeletionMode) -> Result<bool, AppError> {
    if path.trim().is_empty() {
        return Ok(false);
    }

    let target = Path::new(&path);
    let metadata = match std::fs::symlink_metadata(target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(AppError::Io(error.to_string())),
    };

    log::info!("file:delete mode={mode:?} path={path:?}");
    match mode {
        FileDeletionMode::Trash => {
            trash::delete(target).map_err(|error| AppError::Io(error.to_string()))?
        }
        FileDeletionMode::Permanent if metadata.file_type().is_dir() => {
            std::fs::remove_dir_all(target).map_err(|error| AppError::Io(error.to_string()))?;
        }
        FileDeletionMode::Permanent => {
            std::fs::remove_file(target).map_err(|error| AppError::Io(error.to_string()))?;
        }
    }

    Ok(true)
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn normalize_path_preserves_simple_unix_path() {
        let result = normalize_path("/home/user/downloads/file.txt");
        assert_eq!(result, "/home/user/downloads/file.txt");
    }

    #[test]
    fn normalize_path_preserves_path_with_spaces() {
        let result = normalize_path("/home/user/my downloads/file name.txt");
        assert_eq!(result, "/home/user/my downloads/file name.txt");
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
    fn normalize_path_handles_forward_slash_only() {
        // Pure forward-slash paths (cross-platform compatible)
        let result = normalize_path("/var/log/app.log");
        assert_eq!(result, "/var/log/app.log");
    }

    // ── delete_path ─────────────────────────────────────────────────

    #[test]
    fn delete_path_permanently_deletes_existing_file() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let file = dir.path().join("test.bin");
        std::fs::write(&file, "data").expect("write test file");

        let result = delete_path(
            file.to_string_lossy().to_string(),
            FileDeletionMode::Permanent,
        );
        assert!(result.expect("delete file"));
        assert!(!file.exists(), "file must be permanently deleted");
    }

    #[test]
    fn delete_path_permanently_deletes_directory_tree() {
        let root = tempfile::tempdir().expect("create temp dir");
        let directory = root.path().join("download");
        std::fs::create_dir_all(directory.join("nested")).expect("create directory tree");
        std::fs::write(directory.join("nested/file.bin"), "data").expect("write file");

        let result = delete_path(
            directory.to_string_lossy().to_string(),
            FileDeletionMode::Permanent,
        );
        assert!(result.expect("delete directory"));
        assert!(
            !directory.exists(),
            "directory tree must be permanently deleted"
        );
    }

    #[test]
    fn delete_path_returns_false_for_nonexistent_path() {
        let result = delete_path(
            "/definitely/does/not/exist/file.bin".to_string(),
            FileDeletionMode::Permanent,
        );
        assert!(!result.expect("missing path is a no-op"));
    }

    #[test]
    fn delete_path_returns_false_for_empty_path() {
        let result = delete_path(String::new(), FileDeletionMode::Permanent);
        assert!(!result.expect("empty path is a no-op"));
    }

    #[cfg(unix)]
    #[test]
    fn delete_path_removes_symlink_without_following_target() {
        let root = tempfile::tempdir().expect("create temp dir");
        let target = root.path().join("target");
        let link = root.path().join("link");
        std::fs::create_dir_all(&target).expect("create target");
        std::fs::write(target.join("file.bin"), "data").expect("write target file");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");

        let result = delete_path(
            link.to_string_lossy().to_string(),
            FileDeletionMode::Permanent,
        );
        assert!(result.expect("delete symlink"));
        assert!(!link.exists(), "symlink must be deleted");
        assert!(
            target.join("file.bin").exists(),
            "symlink target must remain"
        );
    }
}
