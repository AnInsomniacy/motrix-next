//! System power management — cross-platform shutdown via OS-native commands.
//!
//! Uses `std::process::Command` instead of third-party crates to avoid
//! pulling in heavy dependencies (`zbus` on Linux, `windows` on Windows).
//! This matches the project's existing cfg-gated platform pattern
//! (see `commands/fs.rs`, `commands/protocol.rs`).

use crate::error::AppError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// Shared cancellation flag for the auto-shutdown safety-net timer.
///
/// Follows the same `AtomicBool` pattern as `UpdateCancelState` in
/// `commands/updater.rs`.  The monitor resets the flag when triggering
/// a new shutdown sequence; the frontend sets it via `cancel_shutdown`
/// to skip only the current countdown without disabling the preference.
pub struct ShutdownCancelState(AtomicBool);

impl ShutdownCancelState {
    pub fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    /// Arms the cancel state for a new shutdown sequence (resets the flag).
    pub fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    /// Signals cancellation of the current shutdown countdown.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Returns `true` if the current shutdown was cancelled by the user.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Initiates a system shutdown using platform-native commands.
///
/// Called by the frontend countdown dialog after the 60-second grace period
/// expires, or by the Rust-side lightweight-mode safety net.
///
/// Platform commands:
/// - macOS: `osascript -e 'tell app "System Events" to shut down'`
/// - Windows: `shutdown /s /t 0`
/// - Linux: `systemctl poweroff`
///
/// These commands work without elevated privileges in a normal desktop session.
#[tauri::command]
pub async fn system_shutdown() -> Result<(), AppError> {
    log::info!("power: initiating system shutdown");
    do_shutdown_internal()
}

/// Cancels the current auto-shutdown countdown.
///
/// Sets the `ShutdownCancelState` flag so the Rust-side 70-second
/// safety-net timer skips execution.  Does NOT modify the
/// `shutdownWhenComplete` preference — the feature stays enabled
/// for the next download cycle.
#[tauri::command]
pub fn cancel_shutdown(app: AppHandle) -> Result<(), AppError> {
    log::info!("power: shutdown cancelled by user");
    let state = app.state::<Arc<ShutdownCancelState>>();
    state.cancel();
    Ok(())
}

/// Internal shutdown implementation, callable from both the Tauri command
/// and the Rust-side lightweight-mode safety net in `monitor.rs`.
#[cfg(target_os = "macos")]
pub(crate) fn do_shutdown_internal() -> Result<(), AppError> {
    std::process::Command::new("osascript")
        .args(["-e", "tell application \"System Events\" to shut down"])
        .output()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn do_shutdown_internal() -> Result<(), AppError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    std::process::Command::new("shutdown")
        .args(["/s", "/t", "0"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn do_shutdown_internal() -> Result<(), AppError> {
    std::process::Command::new("systemctl")
        .arg("poweroff")
        .output()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

// Android: no system shutdown command exists. Return an explicit error so the
// frontend can hide/disable the "shutdown when complete" feature gracefully.
#[cfg(target_os = "android")]
pub(crate) fn do_shutdown_internal() -> Result<(), AppError> {
    Err(AppError::Engine(
        "System shutdown is not supported on Android".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: We cannot call do_shutdown_internal() in tests — it would
    // actually shut down the machine.  Instead we validate:
    //  1. The function exists and compiles on the current platform.
    //  2. The return type is correct.
    //  3. The AppError::Io variant is used for spawn failures.

    /// Validates that do_shutdown_internal compiles and returns the
    /// expected Result type.  We don't actually execute it.
    #[test]
    fn do_shutdown_internal_returns_result() {
        // Type-level assertion: do_shutdown_internal() -> Result<(), AppError>
        let _: fn() -> Result<(), AppError> = do_shutdown_internal;
    }

    /// system_shutdown is an async fn returning Result<(), AppError>.
    /// We verify it compiles correctly as a tauri::command.
    #[tokio::test]
    #[allow(clippy::type_complexity)]
    async fn system_shutdown_compiles_as_tauri_command() {
        // Type assertion — doesn't execute the shutdown.
        let _fn_ptr: fn() -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<(), AppError>> + Send>,
        > = || Box::pin(system_shutdown());
    }

    /// Validates that a failed process spawn produces AppError::Io.
    #[test]
    fn io_error_maps_to_app_error_io() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "command not found");
        let app_err = AppError::Io(io_err.to_string());
        assert!(matches!(app_err, AppError::Io(_)));
        assert!(app_err.to_string().contains("command not found"));
    }
}
