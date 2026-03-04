use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use std::sync::Mutex;
use log;

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

    let args = build_start_args(config);

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
                CommandEvent::Stdout(line) => {
                    log::info!("[aria2c stdout] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[aria2c stderr] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    log::info!("[aria2c] terminated with code: {:?}", payload.code);
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
        child.kill().map_err(|e| format!("Failed to kill aria2c: {}", e))?;
    }

    Ok(())
}

pub fn restart_engine(app: &tauri::AppHandle, config: &serde_json::Value) -> Result<(), String> {
    stop_engine(app)?;
    start_engine(app, config)
}

fn build_start_args(config: &serde_json::Value) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    // Essential defaults — always enable RPC on expected port
    let mut has_enable_rpc = false;
    let mut has_rpc_listen_port = false;
    let mut has_rpc_allow_origin = false;
    let mut has_rpc_listen_all = false;

    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            let val_str = match value {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                _ => continue,
            };
            match key.as_str() {
                "enable-rpc" => has_enable_rpc = true,
                "rpc-listen-port" => has_rpc_listen_port = true,
                "rpc-allow-origin-all" => has_rpc_allow_origin = true,
                "rpc-listen-all" => has_rpc_listen_all = true,
                _ => {}
            }
            args.push(format!("--{}={}", key, val_str));
        }
    }

    // Add essential defaults if not provided by config
    if !has_enable_rpc {
        args.push("--enable-rpc=true".to_string());
    }
    if !has_rpc_listen_port {
        args.push("--rpc-listen-port=16800".to_string());
    }
    if !has_rpc_allow_origin {
        args.push("--rpc-allow-origin-all=true".to_string());
    }
    if !has_rpc_listen_all {
        args.push("--rpc-listen-all=true".to_string());
    }

    args
}
