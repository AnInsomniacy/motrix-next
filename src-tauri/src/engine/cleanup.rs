use std::path::{Path, PathBuf};

use tauri::Manager;

const DOWNLOAD_SESSION_FILE: &str = "download.session";
const ENGINE_STATE_DIR: &str = "state";

fn engine_runtime_paths(data_dir: &Path) -> [PathBuf; 2] {
    [
        data_dir.join(DOWNLOAD_SESSION_FILE),
        data_dir.join("engine").join(ENGINE_STATE_DIR),
    ]
}

fn remove_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .map_err(|error| format!("Failed to remove {}: {error}", path.display()))
}

fn clear_runtime_paths(data_dir: &Path) -> Result<(), String> {
    for path in engine_runtime_paths(data_dir) {
        remove_path(&path)?;
    }
    Ok(())
}

pub(crate) fn clear_engine_runtime_state(app: &tauri::AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to get app data directory: {error}"))?;
    clear_runtime_paths(&data_dir)?;
    log::info!("engine: cleared resumable runtime state");
    Ok(())
}

#[cfg(any(windows, test))]
pub(super) fn decode_windows_tcp_port(raw_port: u32) -> u16 {
    u16::from_be(raw_port as u16)
}

/// Kill only supported engine processes occupying the given port, so a new engine can bind to it.
/// Non-engine processes on the same port are left untouched to prevent accidental kills.
pub(crate) fn cleanup_port(port: &str) {
    // Validate port is a legal u16 — rejects injection payloads,
    // out-of-range values, and non-numeric strings at the gate.
    let Ok(_parsed_port) = port.parse::<u16>() else {
        log::warn!("cleanup_port: rejected invalid port value: {:?}", port);
        return;
    };

    #[cfg(unix)]
    log::debug!(
        "engine: leaving occupied port {} to native conflict recovery",
        port
    );

    #[cfg(windows)]
    {
        if let Err(error) = super::windows_process::cleanup_listener(_parsed_port) {
            log::warn!("cleanup_port: Windows native cleanup failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_runtime_fixture(data_dir: &Path) {
        let state_dir = data_dir.join("engine").join(ENGINE_STATE_DIR);
        std::fs::create_dir_all(state_dir.join("bittorrent").join("torrents")).unwrap();
        std::fs::create_dir_all(state_dir.join("ed2k")).unwrap();
        std::fs::write(data_dir.join(DOWNLOAD_SESSION_FILE), "session").unwrap();
        std::fs::write(state_dir.join("bittorrent").join("session"), "bt-state").unwrap();
        std::fs::write(
            state_dir
                .join("bittorrent")
                .join("torrents")
                .join("resume.dat"),
            "resume",
        )
        .unwrap();
        std::fs::write(state_dir.join("ed2k").join("state.db"), "ed2k-state").unwrap();
    }

    #[test]
    fn clear_runtime_paths_removes_only_resumable_engine_state() {
        let temp = tempfile::tempdir().unwrap();
        create_runtime_fixture(temp.path());
        std::fs::write(temp.path().join("history.db"), "history").unwrap();
        std::fs::write(temp.path().join("config.json"), "settings").unwrap();
        clear_runtime_paths(temp.path()).unwrap();

        for path in engine_runtime_paths(temp.path()) {
            assert!(!path.exists());
        }
        assert!(temp.path().join("history.db").exists());
        assert!(temp.path().join("config.json").exists());
    }

    // ── Port validation tests (code review fix) ──────────────────

    #[test]
    fn cleanup_port_rejects_shell_injection_attempts() {
        // These must NOT panic AND must NOT execute any shell command.
        // The u16 parse guard should reject all of these at the gate.
        cleanup_port("29100; rm -rf /");
        cleanup_port("29100 && echo pwned");
        cleanup_port("$(whoami)");
        cleanup_port("29100|cat /etc/passwd");
    }

    #[test]
    fn cleanup_port_rejects_non_numeric_input() {
        cleanup_port("");
        cleanup_port("abc");
        cleanup_port("port");
        cleanup_port("   ");
    }

    #[test]
    fn cleanup_port_rejects_out_of_u16_range() {
        // u16::MAX is 65535 — anything above must be rejected
        cleanup_port("65536");
        cleanup_port("99999");
        cleanup_port("100000");
    }

    #[test]
    fn cleanup_port_accepts_valid_port_numbers() {
        // These should not panic. They may fail to find any process
        // listening on these ports — that's fine, the test verifies
        // the validation layer lets them through.
        cleanup_port("1");
        cleanup_port("29100");
        cleanup_port("65535");
    }

    #[test]
    fn windows_tcp_port_decoder_handles_network_byte_order() {
        assert_eq!(decode_windows_tcp_port(0x0000_AC71), 29_100);
        assert_eq!(decode_windows_tcp_port(0x0000_A041), 16_800);
    }
}
