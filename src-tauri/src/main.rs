// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Elevated subprocess mode: perform a single privileged operation and exit.
    // This path runs BEFORE Tauri initialises, so no window is created.
    // See protocol.rs `mod elevation` for details on the Chrome-style pattern.
    #[cfg(windows)]
    if let Some(code) = rayburst_lib::try_run_elevated() {
        std::process::exit(code);
    }

    rayburst_lib::run()
}
