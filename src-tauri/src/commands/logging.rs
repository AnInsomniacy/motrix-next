use tauri::State;

use crate::error::AppError;
use crate::log_policy::LogLevelControl;

#[tauri::command]
pub fn set_app_log_level(
    level: String,
    control: State<'_, LogLevelControl>,
) -> Result<(), AppError> {
    let applied = control.set(&level).map_err(AppError::Store)?;
    log::info!(target: "logging", level = applied.as_str(); "log_level_changed");
    Ok(())
}
