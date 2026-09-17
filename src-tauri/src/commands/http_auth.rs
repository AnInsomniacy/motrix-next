//! Saved HTTP credentials exposed through named IPC commands.
use crate::{database::DatabaseState, error::AppError};
use tauri::State;

#[tauri::command]
pub async fn http_auth_save(
    state: State<'_, DatabaseState>,
    url: String,
    username: String,
    password: String,
) -> Result<(), AppError> {
    state.0.save_credential(&url, &username, &password).await
}
#[tauri::command]
pub async fn http_auth_find(
    state: State<'_, DatabaseState>,
    url: String,
) -> Result<Option<crate::database::HttpAuthCredential>, AppError> {
    state.0.credential_for_url(&url).await
}
#[tauri::command]
pub async fn http_auth_mark_used(state: State<'_, DatabaseState>, id: i64) -> Result<(), AppError> {
    state.0.mark_credential_used(id).await
}
