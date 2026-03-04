use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub struct EngineState {
    child: Mutex<Option<CommandChild>>,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

pub fn start_engine(app: &tauri::AppHandle, config: &serde_json::Value) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;

    if child_lock.is_some() {
        return Ok(());
    }

    // Ensure the download directory exists
    if let Some(dir) = config.get("dir").and_then(|v| v.as_str()) {
        let _ = std::fs::create_dir_all(dir);
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
        .sidecar("aria2c")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?
        .args(&args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn aria2c: {}", e))?;

    *child_lock = Some(child);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(_line) => {}
                CommandEvent::Stderr(_line) => {}
                CommandEvent::Terminated(_payload) => {
                    if let Some(state) = app_handle.try_state::<EngineState>() {
                        if let Ok(mut child_lock) = state.child.lock() {
                            *child_lock = None;
                        }
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

pub fn stop_engine(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<EngineState>();
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;

    if let Some(child) = child_lock.take() {
        child
            .kill()
            .map_err(|e| format!("Failed to kill aria2c: {}", e))?;
    }

    Ok(())
}

pub fn restart_engine(app: &tauri::AppHandle, config: &serde_json::Value) -> Result<(), String> {
    stop_engine(app)?;
    start_engine(app, config)
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
    let keep_seeding = config
        .get("keep-seeding")
        .and_then(|v| v.as_bool())
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

/// Kill any process occupying the given port, so aria2c can bind to it.
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
                eprintln!(
                    "[aria2c] killing leftover process on port {}: PIDs {}",
                    port, pids
                );
                let _ = std::process::Command::new("sh")
                    .args(["-c", &format!("kill -9 {} 2>/dev/null", pids)])
                    .status();
                // Brief wait for OS to release the port
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
    }

    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/C", &format!("netstat -ano | findstr :{}", port)])
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if let Some(pid) = line.split_whitespace().last() {
                    if pid.parse::<u32>().is_ok() {
                        eprintln!(
                            "[aria2c] killing leftover process on port {}: PID {}",
                            port, pid
                        );
                        let _ = std::process::Command::new("taskkill")
                            .args(["/F", "/PID", pid])
                            .status();
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    }
}
