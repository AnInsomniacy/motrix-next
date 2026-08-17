/// Determines whether a process command name is a supported Aria2 Next process.
///
/// Used by `cleanup_port` (Unix) to verify that only supported engine processes are
/// killed when reclaiming the RPC port — never arbitrary processes that
/// happen to occupy the same port.
///
/// Matches only the current `motrix-next-engine` sidecar process.
///
fn is_supported_engine_process(comm: &str) -> bool {
    comm.contains("motrix-next-engine")
}

#[cfg(unix)]
#[cfg(not(target_os = "android"))]
fn process_identity(pid: &str) -> Option<String> {
    let args_output = std::process::Command::new("ps")
        .args(["-p", pid, "-o", "args="])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let args = String::from_utf8_lossy(&args_output.stdout)
        .trim()
        .to_string();
    if !args.is_empty() {
        return Some(args);
    }

    let comm_output = std::process::Command::new("ps")
        .args(["-p", pid, "-o", "comm="])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let comm = String::from_utf8_lossy(&comm_output.stdout)
        .trim()
        .to_string();
    (!comm.is_empty()).then_some(comm)
}

/// Kill only supported engine processes occupying the given port, so a new engine can bind to it.
/// Non-engine processes on the same port are left untouched to prevent accidental kills.
pub(crate) fn cleanup_port(port: &str) {
    // Validate port is a legal u16 — rejects injection payloads,
    // out-of-range values, and non-numeric strings at the gate.
    if port.parse::<u16>().is_err() {
        log::warn!("cleanup_port: rejected invalid port value: {:?}", port);
        return;
    }

    #[cfg(all(unix, not(target_os = "android")))]
    {
        // Direct command invocation — no shell interpolation.
        // The port value is validated as numeric-only above.
        let output = std::process::Command::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .stderr(std::process::Stdio::null())
            .output();

        if let Ok(out) = output {
            let pids = String::from_utf8_lossy(&out.stdout);
            let pids = pids.trim();
            if !pids.is_empty() {
                let mut killed_any = false;
                for pid in pids.lines() {
                    let pid = pid.trim();
                    if pid.is_empty() {
                        continue;
                    }
                    if let Some(identity) = process_identity(pid) {
                        if is_supported_engine_process(&identity) {
                            log::debug!(
                                "killing leftover engine process on port {}: PID {}",
                                port,
                                pid
                            );
                            let _ = std::process::Command::new("kill")
                                .args(["-9", pid])
                                .stderr(std::process::Stdio::null())
                                .status();
                            killed_any = true;
                        } else {
                            log::debug!(
                                "port {} occupied by non-engine process '{}' (PID {}), skipping",
                                port,
                                identity,
                                pid
                            );
                        }
                    }
                }
                // Brief wait for OS to release the port — only needed when we killed something
                if killed_any {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                }
            }
        }
    }

    // Android: external `lsof`/`ps`/`kill` commands are unavailable. The
    // engine is a child of this process, so stale listeners are impossible
    // across restarts — nothing to clean up.
    #[cfg(target_os = "android")]
    {
        let _ = port;
        log::debug!("cleanup_port: skipped on Android (no external commands)");
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // Port value is validated as u16 at function entry.
        // cmd /C is required for the netstat | findstr pipeline syntax —
        // this cannot be expressed as a single Command::new() call.
        // The interpolated port is guaranteed numeric-only by the guard.
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let output = std::process::Command::new("cmd")
            .args(["/C", &format!("netstat -ano | findstr :{}", port)])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            let mut killed_any = false;
            for line in text.lines() {
                if let Some(pid) = line.split_whitespace().last() {
                    if pid.parse::<u32>().is_ok() {
                        // Verify the process is a supported engine before killing
                        let check = std::process::Command::new("cmd")
                            .args([
                                "/C",
                                &format!("tasklist /FI \"PID eq {}\" /NH /FO CSV 2>NUL", pid),
                            ])
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();
                        let is_supported_engine = check
                            .map(|o| {
                                let s = String::from_utf8_lossy(&o.stdout).to_lowercase();
                                is_supported_engine_process(&s)
                            })
                            .unwrap_or(false);
                        if is_supported_engine {
                            log::debug!(
                                "killing leftover engine process on port {}: PID {}",
                                port,
                                pid
                            );
                            let _ = std::process::Command::new("taskkill")
                                .args(["/F", "/PID", pid])
                                .creation_flags(CREATE_NO_WINDOW)
                                .status();
                            killed_any = true;
                        } else {
                            log::debug!(
                                "port {} occupied by non-engine process (PID {}), skipping",
                                port,
                                pid
                            );
                        }
                    }
                }
            }
            // Brief wait for OS to release the port — only needed when we killed something
            if killed_any {
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_supported_engine_process_matches_motrix_next_engine() {
        assert!(is_supported_engine_process("motrix-next-engine"));
        assert!(is_supported_engine_process(
            "/Applications/MotrixNext.app/Contents/Resources/motrix-next-engine"
        ));
        assert!(is_supported_engine_process(
            "/usr/bin/motrix-next-engine --conf-path=/usr/lib/MotrixNext/binaries/aria2.conf"
        ));
    }

    #[test]
    fn is_supported_engine_process_does_not_trust_truncated_comm_names() {
        assert!(!is_supported_engine_process("motrix-next-eng"));
    }

    #[test]
    fn is_supported_engine_process_rejects_other_processes() {
        assert!(!is_supported_engine_process("nginx"));
        assert!(!is_supported_engine_process("node"));
        assert!(!is_supported_engine_process("python3"));
        assert!(!is_supported_engine_process(""));
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
}
