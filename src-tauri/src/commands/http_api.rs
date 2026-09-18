use crate::error::AppError;
use crate::services::{deep_link, external_input, frontend_action, http_api};

/// Restart the embedded HTTP API server on a new port.
///
/// Called by the frontend when the user changes `extensionApiPort` in
/// Advanced settings and confirms the port-switch dialog.  The old server
/// is stopped before binding the new port.
#[tauri::command]
pub async fn restart_http_api(app: tauri::AppHandle, port: u16) -> Result<u16, AppError> {
    http_api::restart_on_port(&app, port).await
}

/// Drain and return all pending deep-link URLs.
///
/// Called by the frontend during its boot sequence (`setupListeners` in
/// `useAppEvents.ts`) to consume deep-link URLs that were queued by native
/// external-input handlers while the WebView was being recreated.
///
/// Returns an empty vec if no URLs are pending (normal startup, or the
/// window was already alive when the download was routed).
#[tauri::command]
pub fn take_pending_deep_links(
    state: tauri::State<'_, deep_link::PendingDeepLinkState>,
) -> deep_link::PendingDeepLinksPayload {
    deep_link::take_pending_deep_links(state.inner())
}

#[tauri::command]
pub fn take_pending_external_inputs(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, external_input::PendingExternalInputState>,
) -> external_input::PendingExternalInputsPayload {
    if window.label() == external_input::DOWNLOAD_CONFIRMATION_WINDOW_LABEL {
        external_input::take_pending_confirmation_inputs(state.inner())
    } else {
        external_input::take_pending_external_inputs(state.inner())
    }
}

#[tauri::command]
pub fn peek_pending_deep_links_silent(
    state: tauri::State<'_, deep_link::PendingDeepLinkState>,
) -> bool {
    deep_link::peek_pending_deep_links_silent(state.inner())
}

#[tauri::command]
pub fn peek_pending_external_inputs_silent(
    state: tauri::State<'_, external_input::PendingExternalInputState>,
) -> bool {
    external_input::peek_pending_external_inputs_silent(state.inner())
}

/// Drain and return all pending frontend UI actions.
///
/// Called by the frontend during its boot sequence after menu and tray
/// listeners are registered. This prevents lightweight-mode WebView
/// recreation from dropping native tray or menu actions.
#[tauri::command]
pub fn take_pending_frontend_actions(
    state: tauri::State<'_, frontend_action::PendingFrontendActionState>,
) -> Vec<frontend_action::PendingFrontendAction> {
    frontend_action::take_pending_frontend_actions(state.inner())
}
