//! Engine management for the bundled Motrix Next engine sidecar.
//!
//! Split into focused sub-modules:
//! - [`state`] — `EngineState` struct, ANSI stripping, log routing
//! - [`lifecycle`] — `start_engine`, `stop_engine`, `restart_engine`
//! - [`config`] — managed runtime configuration for Aria2 Next
//! - [`cleanup`] — Runtime-state cleanup and process identification

mod cleanup;
mod config;
mod lifecycle;
mod log_level;
mod state;
pub mod supervisor;
#[cfg(windows)]
mod windows_process;

pub(crate) use cleanup::clear_engine_runtime_state;
pub(crate) use config::{non_hot_reloadable_keys, runtime_config_path, supported_engine_keys};
pub(crate) use lifecycle::{
    start_engine, stop_engine, wait_for_engine_exit, wait_for_engine_ports_release,
    StartEngineOutcome,
};
pub(crate) use log_level::{valid_aria2_log_level, DEFAULT_ARIA2_LOG_LEVEL};
pub(crate) use state::path_to_safe_string;
pub use state::EngineState;
