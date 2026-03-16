use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Strips ANSI escape sequences (color codes) from a string.
/// aria2c emits colored output (e.g., `\x1b[1;31mERROR\x1b[0m`) which
/// produces garbage in log files. This removes all CSI sequences.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_escape = false;
    for ch in input.chars() {
        if in_escape {
            // CSI sequences end with a letter (A-Z, a-z)
            if ch.is_ascii_alphabetic() {
                in_escape = false;
            }
        } else if ch == '\x1b' {
            in_escape = true;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Logs aria2c stdout with semantic log levels based on aria2's own tags.
///
/// aria2 prefixes output with `[NOTICE]`, `[ERROR]`, or `[WARN]`.
/// This function maps them to the correct `log` level so the global
/// log-level filter works correctly — no `level_for` override needed.
///
/// | aria2 tag   | log level |
/// |-------------|-----------|
/// | `[NOTICE]`  | `info!`   |
/// | `[ERROR]`   | `error!`  |
/// | `[WARN]`    | `warn!`   |
/// | (other)     | `debug!`  |
fn log_engine_stdout(raw: &str) {
    let clean = strip_ansi(raw);
    let trimmed = clean.trim();
    if trimmed.is_empty() {
        return;
    }
    if trimmed.contains("[ERROR]") {
        log::error!("engine: {}", trimmed);
    } else if trimmed.contains("[WARN]") {
        log::warn!("engine: {}", trimmed);
    } else if trimmed.contains("[NOTICE]") {
        log::info!("engine: {}", trimmed);
    } else {
        log::debug!("engine: {}", trimmed);
    }
}

/// Holds the aria2c child process handle, protected by a Mutex for thread-safe access.
///
/// `intentional_stop` distinguishes deliberate kills (restart, update, relaunch)
/// from genuine crashes.  Set to `true` before `child.kill()`, checked by the
/// async Terminated handler to suppress false `engine-error` events.
pub struct EngineState {
    child: Mutex<Option<CommandChild>>,
    intentional_stop: AtomicBool,
    /// Monotonically increasing generation counter.
    /// Each call to `start_engine` / `restart_engine` increments this.
    /// Terminated handlers capture their generation at spawn time and
    /// silently ignore events when their generation is stale.
    gen: AtomicU32,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            intentional_stop: AtomicBool::new(false),
            gen: AtomicU32::new(0),
        }
    }

    /// Returns the current generation value (used by tests).
    #[cfg(test)]
    pub fn generation(&self) -> u32 {
        self.gen.load(Ordering::SeqCst)
    }

    /// Atomically increments the generation counter and returns the new value.
    pub fn next_generation(&self) -> u32 {
        self.gen.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Returns `true` if `gen` matches the current generation.
    pub fn is_current_generation(&self, gen: u32) -> bool {
        self.gen.load(Ordering::SeqCst) == gen
    }
}

/// Spawns the aria2c engine process with the given configuration.
/// Creates the download directory, cleans up stale port listeners, and passes
/// whitelisted config keys as CLI arguments.
pub fn start_engine(app: &tauri::AppHandle, config: &serde_json::Value) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;

    if child_lock.is_some() {
        return Ok(());
    }

    // Ensure the download directory exists
    if let Some(dir) = config.get("dir").and_then(|v| v.as_str()) {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create download directory '{}': {}", dir, e))?;
    }

    // Kill any leftover aria2c process on the RPC port before starting
    let port = config
        .get("rpc-listen-port")
        .and_then(|v| v.as_str())
        .unwrap_or("16800");
    cleanup_port(port);

    // aria2.conf sits next to the aria2c binary in binaries/
    let exe_dir = std::env::current_exe().map_err(|e| format!("Failed to get exe path: {}", e))?;
    let exe_dir = exe_dir.parent().ok_or("Failed to get exe dir")?;
    let conf_path = exe_dir.join("binaries").join("aria2.conf");
    let conf_str = conf_path.to_string_lossy().to_string();

    // Session file for persisting active/paused downloads across restarts
    let session_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("download.session");
    let session_str = session_path.to_string_lossy().to_string();

    // Ensure the app data directory exists
    if let Some(parent) = session_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let args = build_start_args(
        config,
        if conf_path.exists() {
            Some(&conf_str)
        } else {
            None
        },
        &session_str,
        session_path.exists(),
    );

    let sidecar = app
        .shell()
        .sidecar("motrixnext-aria2c")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(&args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn aria2c: {}", e))?;

    log::info!("started engine process: PID {}", child.pid());

    let spawned_pid = child.pid();
    *child_lock = Some(child);
    let my_gen = state.next_generation();

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    log_engine_stdout(&text);
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        log::warn!("stderr: {}", trimmed);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let exit_code = payload.code.unwrap_or(-1);
                    log::warn!("terminated with exit code: {}", exit_code);

                    // Generation guard: if a newer engine was spawned since this
                    // monitor started, this is a stale handler — ignore silently.
                    let is_stale = app_handle
                        .try_state::<EngineState>()
                        .map_or(true, |s| !s.is_current_generation(my_gen));
                    if is_stale {
                        log::debug!("stale monitor (gen {}) ignoring termination", my_gen);
                        break;
                    }

                    // Only notify frontend of UNEXPECTED termination.
                    // Intentional stops (restart, update, relaunch) set the flag
                    // before kill() — swap(false) atomically reads and resets.
                    let was_intentional = if let Some(state) = app_handle.try_state::<EngineState>() {
                        state.intentional_stop.swap(false, Ordering::SeqCst)
                    } else {
                        false
                    };

                    if !was_intentional {
                        // Any non-intentional exit is a crash — including kill -9
                        // which produces exit_code 0.  Frontend drives recovery.
                        let _ = app_handle.emit(
                            "engine-crashed",
                            serde_json::json!({
                                "code": exit_code,
                                "signal": payload.signal
                            }),
                        );
                    } else {
                        let _ = app_handle.emit("engine-stopped", ());
                    }

                    if let Some(state) = app_handle.try_state::<EngineState>() {
                        if let Ok(mut lock) = state.child.lock() {
                            if lock.as_ref().map(|c| c.pid()) == Some(spawned_pid) {
                                *lock = None;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Kills the running aria2c child process and releases the lock.
/// Waits briefly after kill to let the OS reclaim the process.
pub fn stop_engine(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<EngineState>();
    // Signal intentional stop BEFORE kill so the Terminated handler
    // knows this is deliberate and suppresses engine-error.
    state.intentional_stop.store(true, Ordering::SeqCst);
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;

    if let Some(child) = child_lock.take() {
        let pid = child.pid();
        child
            .kill()
            .map_err(|e| format!("Failed to kill aria2c: {}", e))?;
        log::info!("stopped engine process: PID {}", pid);
        // Brief wait for the OS to fully terminate the process and release the port.
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    Ok(())
}

/// Atomically stops the current engine and starts a new one.
///
/// Holds the `EngineState` Mutex for the entire duration to prevent concurrent
/// restarts from spawning duplicate aria2c processes.  Sequence:
///   1. Kill the old child (if any) and wait for OS cleanup
///   2. Run `cleanup_port` to kill any orphaned aria2c on the RPC port
///   3. Spawn a new aria2c sidecar
///
/// This is the fix for: rapid "Save & Apply" → "Restart Engine" creating
/// orphaned aria2c processes on all platforms.
pub fn restart_engine(app: &tauri::AppHandle, config: &serde_json::Value) -> Result<(), String> {
    let state = app.state::<EngineState>();
    // Signal intentional stop BEFORE kill so the old process's Terminated
    // handler suppresses engine-error.
    state.intentional_stop.store(true, Ordering::SeqCst);
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;

    // Step 1: Kill existing child if present
    if let Some(child) = child_lock.take() {
        let pid = child.pid();
        child
            .kill()
            .map_err(|e| format!("Failed to kill aria2c: {}", e))?;
        log::info!("restart: killed old engine process: PID {}", pid);
        // Wait for the OS to reclaim the process and release the port
        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    // Step 2: Defense-in-depth — kill any orphans still holding the port
    let port = config
        .get("rpc-listen-port")
        .and_then(|v| v.as_str())
        .unwrap_or("16800");
    cleanup_port(port);

    // Step 3: Spawn new aria2c (inlined from start_engine to keep lock held)
    if let Some(dir) = config.get("dir").and_then(|v| v.as_str()) {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create download directory '{}': {}", dir, e))?;
    }

    let exe_dir = std::env::current_exe().map_err(|e| format!("Failed to get exe path: {}", e))?;
    let exe_dir = exe_dir.parent().ok_or("Failed to get exe dir")?;
    let conf_path = exe_dir.join("binaries").join("aria2.conf");
    let conf_str = conf_path.to_string_lossy().to_string();

    let session_path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("download.session");
    let session_str = session_path.to_string_lossy().to_string();

    if let Some(parent) = session_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let args = build_start_args(
        config,
        if conf_path.exists() {
            Some(&conf_str)
        } else {
            None
        },
        &session_str,
        session_path.exists(),
    );

    let sidecar = app
        .shell()
        .sidecar("motrixnext-aria2c")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(&args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn aria2c: {}", e))?;

    log::info!("restart: started new engine process: PID {}", child.pid());
    let spawned_pid = child.pid();
    *child_lock = Some(child);
    let my_gen = state.next_generation();

    // Reset intentional_stop for the NEW process.  This is safe because old
    // monitors are gated by generation and will never reach the swap — they
    // break immediately on stale gen check.  Without this reset, the flag
    // stays true forever and every future termination is wrongly treated as
    // intentional (suppressing crash detection AND blocking app exit).
    state.intentional_stop.store(false, Ordering::SeqCst);

    // Monitor for process termination (PID-guarded clear)
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line);
                    log_engine_stdout(&text);
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        log::warn!("stderr: {}", trimmed);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let exit_code = payload.code.unwrap_or(-1);
                    log::warn!("restart: terminated with exit code: {}", exit_code);

                    // Generation guard: stale monitor → ignore silently.
                    let is_stale = app_handle
                        .try_state::<EngineState>()
                        .map_or(true, |s| !s.is_current_generation(my_gen));
                    if is_stale {
                        log::debug!("stale monitor (gen {}) ignoring termination", my_gen);
                        break;
                    }

                    // Only notify frontend of UNEXPECTED termination.
                    let was_intentional = if let Some(state) = app_handle.try_state::<EngineState>() {
                        state.intentional_stop.swap(false, Ordering::SeqCst)
                    } else {
                        false
                    };

                    if !was_intentional {
                        let _ = app_handle.emit(
                            "engine-crashed",
                            serde_json::json!({
                                "code": exit_code,
                                "signal": payload.signal
                            }),
                        );
                    } else {
                        let _ = app_handle.emit("engine-stopped", ());
                    }

                    if let Some(state) = app_handle.try_state::<EngineState>() {
                        if let Ok(mut lock) = state.child.lock() {
                            if lock.as_ref().map(|c| c.pid()) == Some(spawned_pid) {
                                *lock = None;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

fn build_start_args(
    config: &serde_json::Value,
    conf_path: Option<&str>,
    session_path: &str,
    session_exists: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    // Load bundled config file if available
    if let Some(path) = conf_path {
        args.push(format!("--conf-path={}", path));
    }

    // Session persistence: save active/paused downloads, restore on restart
    args.push(format!("--save-session={}", session_path));
    if session_exists {
        args.push(format!("--input-file={}", session_path));
    }

    // Whitelist: only valid aria2c CLI options (from configKeys.ts systemKeys)
    const VALID_ARIA2_KEYS: &[&str] = &[
        "all-proxy-passwd",
        "all-proxy-user",
        "all-proxy",
        "allow-overwrite",
        "allow-piece-length-change",
        "always-resume",
        "async-dns",
        "auto-file-renaming",
        "bt-enable-hook-after-hash-check",
        "bt-enable-lpd",
        "bt-exclude-tracker",
        "bt-external-ip",
        "bt-force-encryption",
        "bt-hash-check-seed",
        "bt-load-saved-metadata",
        "bt-max-peers",
        "bt-metadata-only",
        "bt-min-crypto-level",
        "bt-prioritize-piece",
        "bt-remove-unselected-file",
        "bt-request-peer-speed-limit",
        "bt-require-crypto",
        "bt-save-metadata",
        "bt-seed-unverified",
        "bt-stop-timeout",
        "bt-tracker-connect-timeout",
        "bt-tracker-interval",
        "bt-tracker-timeout",
        "bt-tracker",
        "check-integrity",
        "checksum",
        "conditional-get",
        "connect-timeout",
        "content-disposition-default-utf8",
        "continue",
        "dht-file-path",
        "dht-file-path6",
        "dht-listen-port",
        "dir",
        "dry-run",
        "enable-dht",
        "enable-http-keep-alive",
        "enable-http-pipelining",
        "enable-mmap",
        "enable-peer-exchange",
        "file-allocation",
        "follow-metalink",
        "follow-torrent",
        "force-save",
        "force-sequential",
        "ftp-passwd",
        "ftp-pasv",
        "ftp-proxy-passwd",
        "ftp-proxy-user",
        "ftp-proxy",
        "ftp-reuse-connection",
        "ftp-type",
        "ftp-user",
        "gid",
        "hash-check-only",
        "header",
        "http-accept-gzip",
        "http-auth-challenge",
        "http-no-cache",
        "http-passwd",
        "http-proxy-passwd",
        "http-proxy-user",
        "http-proxy",
        "http-user",
        "https-proxy-passwd",
        "https-proxy-user",
        "https-proxy",
        "index-out",
        "listen-port",
        "log-level",
        "lowest-speed-limit",
        "max-concurrent-downloads",
        "max-connection-per-server",
        "max-download-limit",
        "max-file-not-found",
        "max-mmap-limit",
        "max-overall-download-limit",
        "max-overall-upload-limit",
        "max-resume-failure-tries",
        "max-tries",
        "max-upload-limit",
        "min-split-size",
        "no-file-allocation-limit",
        "no-netrc",
        "no-proxy",
        "no-want-digest-header",
        "out",
        "parameterized-uri",
        "pause-metadata",
        "pause",
        "piece-length",
        "proxy-method",
        "realtime-chunk-checksum",
        "referer",
        "remote-time",
        "remove-control-file",
        "retry-wait",
        "reuse-uri",
        "rpc-listen-port",
        "rpc-save-upload-metadata",
        "rpc-secret",
        "seed-ratio",
        "seed-time",
        "select-file",
        "split",
        "ssh-host-key-md",
        "stream-piece-selector",
        "timeout",
        "uri-selector",
        "use-head",
        "user-agent",
    ];

    // Check keep-seeding flag (app-level logic, not aria2c option)
    // Frontend sends String("true"/"false"), so handle both Bool and String
    let keep_seeding = config
        .get("keep-seeding")
        .map(|v| match v {
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::String(s) => s == "true",
            _ => false,
        })
        .unwrap_or(false);

    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            // Only pass whitelisted aria2c keys
            if !VALID_ARIA2_KEYS.contains(&key.as_str()) {
                continue;
            }

            // Security: always force rpc-listen-all=false
            if key == "rpc-listen-all" {
                continue;
            }

            // Handle keep-seeding: skip seed-time if keep_seeding is true
            if keep_seeding && key == "seed-time" {
                continue;
            }

            let val_str = match value {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                _ => continue,
            };

            // Skip empty values
            if val_str.is_empty() {
                continue;
            }

            // Handle keep-seeding: override seed-ratio to 0
            if keep_seeding && key == "seed-ratio" {
                args.push("--seed-ratio=0".to_string());
                continue;
            }

            args.push(format!("--{}={}", key, val_str));
        }
    }

    // If no conf file, ensure RPC is enabled
    if conf_path.is_none() {
        args.push("--enable-rpc=true".to_string());
        args.push("--rpc-allow-origin-all=true".to_string());
    }

    // Security: only listen on localhost
    args.push("--rpc-listen-all=false".to_string());

    args
}

/// Kill only aria2c processes occupying the given port, so a new aria2c can bind to it.
/// Non-aria2c processes on the same port are left untouched to prevent accidental kills.
fn cleanup_port(port: &str) {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("sh")
            .args(["-c", &format!("lsof -ti:{} 2>/dev/null", port)])
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
                    // Verify the process is aria2c before killing
                    let check = std::process::Command::new("sh")
                        .args(["-c", &format!("ps -p {} -o comm= 2>/dev/null", pid)])
                        .output();
                    if let Ok(check_out) = check {
                        let comm = String::from_utf8_lossy(&check_out.stdout);
                        let comm = comm.trim();
                        if comm.contains("aria2c") {
                            log::debug!(
                                "killing leftover aria2c process on port {}: PID {}",
                                port, pid
                            );
                            let _ = std::process::Command::new("sh")
                                .args(["-c", &format!("kill -9 {} 2>/dev/null", pid)])
                                .status();
                            killed_any = true;
                        } else {
                            log::debug!(
                                "port {} occupied by non-aria2c process '{}' (PID {}), skipping",
                                port, comm, pid
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

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // Prevent child processes from creating visible console windows.
        // Without this flag, each cmd.exe / taskkill spawn briefly flashes
        // a CMD window on the user's desktop during startup cleanup.
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
                        // Verify the process is aria2c before killing
                        let check = std::process::Command::new("cmd")
                            .args([
                                "/C",
                                &format!("tasklist /FI \"PID eq {}\" /NH /FO CSV 2>NUL", pid),
                            ])
                            .creation_flags(CREATE_NO_WINDOW)
                            .output();
                        let is_aria2c = check
                            .map(|o| {
                                let s = String::from_utf8_lossy(&o.stdout);
                                s.to_lowercase().contains("aria2c")
                            })
                            .unwrap_or(false);
                        if is_aria2c {
                            log::debug!(
                                "killing leftover aria2c process on port {}: PID {}",
                                port, pid
                            );
                            let _ = std::process::Command::new("taskkill")
                                .args(["/F", "/PID", pid])
                                .creation_flags(CREATE_NO_WINDOW)
                                .status();
                            killed_any = true;
                        } else {
                            log::debug!(
                                "port {} occupied by non-aria2c process (PID {}), skipping",
                                port, pid
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
    use serde_json::json;

    #[test]
    fn build_args_passes_whitelisted_keys() {
        let config = json!({ "dir": "/tmp", "split": 16 });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(args.iter().any(|a| a == "--dir=/tmp"));
        assert!(args.iter().any(|a| a == "--split=16"));
    }

    #[test]
    fn build_args_rejects_non_whitelisted_keys() {
        let config = json!({ "dir": "/tmp", "not-a-real-key": "value", "keep-seeding": true });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("not-a-real-key")));
        assert!(!args.iter().any(|a| a.contains("keep-seeding")));
    }

    #[test]
    fn build_args_forces_rpc_listen_all_false() {
        let config = json!({ "rpc-listen-all": "true" });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        // Must NOT pass the user's rpc-listen-all=true
        let rpc_args: Vec<_> = args
            .iter()
            .filter(|a| a.contains("rpc-listen-all"))
            .collect();
        assert_eq!(rpc_args.len(), 1);
        assert_eq!(rpc_args[0], "--rpc-listen-all=false");
    }

    #[test]
    fn build_args_keep_seeding_skips_seed_time() {
        let config = json!({ "keep-seeding": true, "seed-time": "60" });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("seed-time")));
    }

    #[test]
    fn build_args_keep_seeding_overrides_seed_ratio() {
        let config = json!({ "keep-seeding": true, "seed-ratio": "1.0" });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(args.iter().any(|a| a == "--seed-ratio=0"));
    }

    #[test]
    fn build_args_skips_empty_values() {
        let config = json!({ "dir": "" });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("--dir=")));
    }

    #[test]
    fn build_args_loads_session_on_exists() {
        let args = build_start_args(&json!({}), None, "/tmp/s.session", true);
        assert!(args.iter().any(|a| a == "--input-file=/tmp/s.session"));
        assert!(args.iter().any(|a| a == "--save-session=/tmp/s.session"));
    }

    #[test]
    fn build_args_no_input_file_when_no_session() {
        let args = build_start_args(&json!({}), None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("input-file")));
        assert!(args.iter().any(|a| a == "--save-session=/tmp/s.session"));
    }

    #[test]
    fn build_args_includes_conf_path() {
        let args = build_start_args(&json!({}), Some("/etc/aria2.conf"), "/tmp/s.session", false);
        assert!(args.iter().any(|a| a == "--conf-path=/etc/aria2.conf"));
    }

    #[test]
    fn build_args_enables_rpc_without_conf() {
        let args = build_start_args(&json!({}), None, "/tmp/s.session", false);
        assert!(args.iter().any(|a| a == "--enable-rpc=true"));
        assert!(args.iter().any(|a| a == "--rpc-allow-origin-all=true"));
    }

    #[test]
    fn build_args_no_rpc_enable_with_conf() {
        let args = build_start_args(&json!({}), Some("/etc/aria2.conf"), "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("enable-rpc")));
    }

    // ── Generation counter tests ────────────────────────────────────────

    #[test]
    fn engine_state_starts_at_generation_zero() {
        let state = EngineState::new();
        assert_eq!(state.generation(), 0);
    }

    #[test]
    fn next_generation_increments_monotonically() {
        let state = EngineState::new();
        assert_eq!(state.next_generation(), 1);
        assert_eq!(state.next_generation(), 2);
        assert_eq!(state.next_generation(), 3);
        assert_eq!(state.generation(), 3);
    }

    #[test]
    fn is_current_generation_true_for_matching() {
        let state = EngineState::new();
        let gen = state.next_generation();
        assert!(state.is_current_generation(gen));
    }

    #[test]
    fn is_current_generation_false_for_stale() {
        let state = EngineState::new();
        let old_gen = state.next_generation();
        let _new_gen = state.next_generation();
        // Old generation must NOT match current
        assert!(!state.is_current_generation(old_gen));
    }

    #[test]
    fn is_current_generation_false_for_zero() {
        let state = EngineState::new();
        let _gen = state.next_generation();
        // Generation 0 (initial) is never "current" after any increment
        assert!(!state.is_current_generation(0));
    }

    #[test]
    fn intentional_stop_is_independent_of_generation() {
        let state = EngineState::new();
        state.intentional_stop.store(true, Ordering::SeqCst);
        let _gen = state.next_generation();
        // Incrementing generation must NOT touch intentional_stop
        assert!(state.intentional_stop.load(Ordering::SeqCst));
    }

    // ── strip_ansi tests ────────────────────────────────────────────────

    #[test]
    fn strip_ansi_removes_color_codes() {
        let input = "\x1b[1;31mERROR\x1b[0m Something went wrong";
        assert_eq!(strip_ansi(input), "ERROR Something went wrong");
    }

    #[test]
    fn strip_ansi_preserves_plain_text() {
        let input = "normal text";
        assert_eq!(strip_ansi(input), "normal text");
    }

    #[test]
    fn strip_ansi_handles_notice_tag() {
        let input = "03/15 00:56:16 [\x1b[1;32mNOTICE\x1b[0m] IPv4 RPC: listening on TCP port 16800";
        let clean = strip_ansi(input);
        assert!(clean.contains("[NOTICE]"));
        assert!(!clean.contains("\x1b"));
    }

    #[test]
    fn strip_ansi_handles_error_tag() {
        let input = "03/15 00:23:41 [\x1b[1;31mERROR\x1b[0m] Unrecognized URI";
        let clean = strip_ansi(input);
        assert!(clean.contains("[ERROR]"));
        assert!(!clean.contains("\x1b"));
    }

    #[test]
    fn strip_ansi_empty_string() {
        assert_eq!(strip_ansi(""), "");
    }
}
