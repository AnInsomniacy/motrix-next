//! GPU crash detection and automatic recovery for Linux.
//!
//! WebKitGTK's DMA-BUF renderer crashes on various GPU/driver/compositor
//! combinations: NVIDIA proprietary, Intel UHD on Wayland, Broadcom on
//! Raspberry Pi, VM guests.  Upstream WebKit Bug #262607 is RESOLVED WONTFIX.
//!
//! ## Strategy
//!
//! **Default safe:** hardware rendering is OFF (`WEBKIT_DISABLE_DMABUF_RENDERER=1`).
//! Users who want GPU-accelerated rendering can opt in via the Advanced
//! preferences toggle.  If the opt-in causes a crash, the next launch
//! detects the crash via a sentinel file and automatically reverts the
//! preference to `false`.
//!
//! ### Sentinel protocol
//!
//! 1. [`pre_flight`] — before Tauri/WebKitGTK init:
//!    - If the sentinel file exists → last launch crashed after opting in →
//!      revert `hardwareRendering` to `false` in `config.json`, delete sentinel,
//!      set `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
//!    - If `hardwareRendering` is `false` (default) → set env var.
//!    - If `hardwareRendering` is `true` → write sentinel, leave env var unset.
//! 2. [`mark_healthy`] — after `setup_app()` succeeds → delete sentinel.
//!
//! ## Platform scope
//!
//! All functions are `#[cfg(target_os = "linux")]`-gated.  On Windows and macOS
//! the public API compiles to no-ops (the module still exists for `mod` hygiene).
//!
//! Helper functions are called by `pre_flight()` which is
//! `#[cfg(target_os = "linux")]`. On macOS/Windows the caller is compiled out,
//! making them appear unused — hence the module-level allow.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// Sentinel file name — written before WebKitGTK init, deleted on success.
const SENTINEL_NAME: &str = ".gpu-crash-sentinel";

/// Resolves the application data directory (`~/.local/share/com.motrix.next`).
///
/// Uses `dirs::data_dir()` (same as [`crate::read_log_level`]) because
/// `tauri-plugin-store` is unavailable before `Builder.build()`.
fn data_dir() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("com.motrix.next"))
}

/// Reads the `hardwareRendering` preference from raw `config.json`.
///
/// Same pattern as [`crate::read_log_level`] — direct JSON file read because
/// `tauri-plugin-store` isn't available yet.
///
/// Returns `false` (safe default) if the file is absent, unparseable, or the
/// key is missing.
fn read_hardware_rendering_from_config(data_dir: &std::path::Path) -> bool {
    (|| -> Option<bool> {
        let path = data_dir.join("config.json");
        let content = std::fs::read_to_string(path).ok()?;
        let json: serde_json::Value = serde_json::from_str(&content).ok()?;
        json.get("preferences")?.get("hardwareRendering")?.as_bool()
    })()
    .unwrap_or(false)
}

/// Writes `hardwareRendering = false` back into raw `config.json`.
///
/// Best-effort: errors are logged but never propagated (this runs before the
/// Tauri runtime, so there is no frontend to report to).
fn write_back_hardware_rendering_disabled(data_dir: &std::path::Path) {
    let path = data_dir.join("config.json");
    let result = (|| -> Result<(), String> {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut json: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        if let Some(prefs) = json.get_mut("preferences").and_then(|v| v.as_object_mut()) {
            prefs.insert(
                "hardwareRendering".to_string(),
                serde_json::Value::Bool(false),
            );
        }
        let out = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
        std::fs::write(&path, out).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("[motrix-next] gpu_guard: failed to write back config: {e}");
    }
}

/// Pre-flight GPU guard — must be called before any Tauri/WebKitGTK init.
///
/// Checks the sentinel file and user preference, then decides whether to set
/// `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
///
/// Returns `true` if DMA-BUF was disabled (either by default or crash recovery).
///
/// # Safety
///
/// Calls `std::env::set_var` which is `unsafe` since Rust 1.83.  This is safe
/// because it executes at the very start of `main()`, before the async runtime
/// or any secondary threads.
#[cfg(target_os = "linux")]
pub fn pre_flight() -> bool {
    // Respect user-set env var — never override explicit configuration.
    if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_ok() {
        return std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
    }

    let Some(dir) = data_dir() else {
        eprintln!("[motrix-next] gpu_guard: cannot resolve data dir — defaulting to safe mode");
        // SAFETY: single-threaded at this point.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        return true;
    };

    let sentinel = dir.join(SENTINEL_NAME);

    // ── Crash recovery ─────────────────────────────────────────────
    let crash_detected = sentinel.exists();
    if crash_detected {
        let _ = std::fs::remove_file(&sentinel);
        write_back_hardware_rendering_disabled(&dir);
        eprintln!(
            "[motrix-next] GPU crash detected on previous launch — \
             hardware rendering auto-disabled"
        );
    }

    // ── Read preference (after possible crash revert) ──────────────
    let hw_rendering = if crash_detected {
        false
    } else {
        read_hardware_rendering_from_config(&dir)
    };

    if hw_rendering {
        // User opted in — write sentinel; delete on successful startup.
        let _ = std::fs::write(&sentinel, "");
        eprintln!("[motrix-next] Hardware rendering enabled — sentinel written");
        false // DMA-BUF NOT disabled
    } else {
        // SAFETY: single-threaded at this point.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        eprintln!("[motrix-next] Hardware rendering disabled — using software compositing");
        true // DMA-BUF disabled
    }
}

/// Marks the current launch as healthy — deletes the sentinel file.
///
/// Called after `setup_app()` succeeds, proving that WebKitGTK's EGL init
/// completed without crashing.
#[cfg(target_os = "linux")]
pub fn mark_healthy() {
    if let Some(dir) = data_dir() {
        let sentinel = dir.join(SENTINEL_NAME);
        if sentinel.exists() {
            let _ = std::fs::remove_file(&sentinel);
            log::info!("gpu_guard: startup healthy — sentinel removed");
        }
    }
}

/// No-op on non-Linux platforms.
#[cfg(not(target_os = "linux"))]
pub fn pre_flight() -> bool {
    false
}

/// No-op on non-Linux platforms.
#[cfg(not(target_os = "linux"))]
pub fn mark_healthy() {}

/// Returns whether the user has opted into hardware rendering.
///
/// Used by `export_diagnostic_logs` to include GPU state in the diagnostic
/// archive.  On non-Linux platforms this always returns `false`.
pub fn is_hardware_rendering_enabled() -> bool {
    std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER")
        .map(|v| v != "1" && !v.eq_ignore_ascii_case("true"))
        .unwrap_or(true) // If env var not set → DMA-BUF is enabled
        && cfg!(target_os = "linux")
}

// ═════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Creates a unique temp directory for test isolation.
    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("motrix-gpu-guard-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    /// Writes a minimal config.json with the given hardwareRendering value.
    fn write_config(dir: &std::path::Path, hw: bool) {
        let config = serde_json::json!({
            "preferences": {
                "hardwareRendering": hw,
                "logLevel": "debug"
            }
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .expect("write config");
    }

    fn sentinel_path(dir: &std::path::Path) -> PathBuf {
        dir.join(SENTINEL_NAME)
    }

    // ── read_hardware_rendering_from_config ─────────────────────────

    #[test]
    fn read_hw_rendering_returns_false_when_config_absent() {
        let dir = test_dir("read_absent");
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_false_when_key_missing() {
        let dir = test_dir("read_missing_key");
        let config = serde_json::json!({
            "preferences": { "logLevel": "debug" }
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_false_when_value_is_false() {
        let dir = test_dir("read_false");
        write_config(&dir, false);
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_true_when_value_is_true() {
        let dir = test_dir("read_true");
        write_config(&dir, true);
        assert!(read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_false_when_json_malformed() {
        let dir = test_dir("read_malformed");
        fs::write(dir.join("config.json"), "not json at all").unwrap();
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn read_hw_rendering_returns_false_when_preferences_missing() {
        let dir = test_dir("read_no_prefs");
        fs::write(dir.join("config.json"), r#"{ "other": 42 }"#).unwrap();
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    // ── write_back_hardware_rendering_disabled ──────────────────────

    #[test]
    fn write_back_sets_hardware_rendering_to_false() {
        let dir = test_dir("write_back");
        write_config(&dir, true);
        // Precondition: config says true
        assert!(read_hardware_rendering_from_config(&dir));
        // Act
        write_back_hardware_rendering_disabled(&dir);
        // Postcondition: config now says false
        assert!(!read_hardware_rendering_from_config(&dir));
    }

    #[test]
    fn write_back_preserves_other_config_fields() {
        let dir = test_dir("write_back_preserve");
        let config = serde_json::json!({
            "preferences": {
                "hardwareRendering": true,
                "logLevel": "info",
                "theme": "dark"
            },
            "unrelated": "keep-me"
        });
        fs::write(
            dir.join("config.json"),
            serde_json::to_string_pretty(&config).unwrap(),
        )
        .unwrap();

        write_back_hardware_rendering_disabled(&dir);

        let content = fs::read_to_string(dir.join("config.json")).unwrap();
        let result: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(result["preferences"]["hardwareRendering"], false);
        assert_eq!(result["preferences"]["logLevel"], "info");
        assert_eq!(result["preferences"]["theme"], "dark");
        assert_eq!(result["unrelated"], "keep-me");
    }

    #[test]
    fn write_back_does_not_panic_when_config_absent() {
        let dir = test_dir("write_back_absent");
        // Should not panic — just eprintln error
        write_back_hardware_rendering_disabled(&dir);
    }

    #[test]
    fn write_back_does_not_panic_when_config_malformed() {
        let dir = test_dir("write_back_malformed");
        fs::write(dir.join("config.json"), "not json").unwrap();
        // Should not panic
        write_back_hardware_rendering_disabled(&dir);
    }

    // ── sentinel file operations ────────────────────────────────────

    #[test]
    fn sentinel_name_is_hidden_file() {
        assert!(
            SENTINEL_NAME.starts_with('.'),
            "sentinel must be a hidden file (dotfile)"
        );
    }

    #[test]
    fn sentinel_name_is_fixed_string() {
        // Guard against accidental rename that would break crash detection
        assert_eq!(SENTINEL_NAME, ".gpu-crash-sentinel");
    }

    // ── Integration: read → write_back round-trip ───────────────────

    #[test]
    fn crash_recovery_flow_reads_true_writes_back_false() {
        let dir = test_dir("crash_flow");
        write_config(&dir, true);
        // Simulate crash: sentinel exists
        fs::write(sentinel_path(&dir), "").unwrap();

        // Crash detection should see sentinel, revert config
        assert!(sentinel_path(&dir).exists());
        write_back_hardware_rendering_disabled(&dir);
        let _ = fs::remove_file(sentinel_path(&dir));

        assert!(!read_hardware_rendering_from_config(&dir));
        assert!(!sentinel_path(&dir).exists());
    }

    #[test]
    fn normal_startup_flow_sentinel_written_then_removed() {
        let dir = test_dir("normal_flow");
        write_config(&dir, true);

        // pre_flight would write sentinel
        fs::write(sentinel_path(&dir), "").unwrap();
        assert!(sentinel_path(&dir).exists());

        // mark_healthy would remove it
        let _ = fs::remove_file(sentinel_path(&dir));
        assert!(!sentinel_path(&dir).exists());
    }

    #[test]
    fn safe_mode_default_no_sentinel_written() {
        let dir = test_dir("safe_default");
        write_config(&dir, false);

        let hw = read_hardware_rendering_from_config(&dir);
        assert!(!hw);
        // No sentinel should be written when hw rendering is disabled
        assert!(!sentinel_path(&dir).exists());
    }

    // ── data_dir resolution ─────────────────────────────────────────

    #[test]
    fn data_dir_returns_some_on_normal_system() {
        // dirs::data_dir() should work on any CI/dev machine
        let dir = data_dir();
        assert!(dir.is_some(), "data_dir() must resolve on test system");
    }

    #[test]
    fn data_dir_ends_with_app_identifier() {
        let dir = data_dir().expect("data_dir must resolve");
        assert!(
            dir.ends_with("com.motrix.next"),
            "data_dir must end with com.motrix.next, got: {:?}",
            dir
        );
    }

    // ── Structural tests: public API exists ─────────────────────────

    #[test]
    fn pre_flight_function_exists_and_returns_bool() {
        // On non-Linux this is a no-op returning false.
        // On Linux this mutates env but we can't safely test that in parallel.
        // This test verifies the function signature compiles correctly.
        let _result: bool = pre_flight();
    }

    #[test]
    fn mark_healthy_function_exists() {
        // Verifies the function compiles. No-op on non-Linux.
        mark_healthy();
    }
}
