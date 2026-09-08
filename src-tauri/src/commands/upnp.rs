//! Tauri commands for UPnP port mapping management.

use crate::error::AppError;
use crate::upnp::UpnpState;

#[tauri::command]
pub async fn start_upnp_mapping(
    state: tauri::State<'_, UpnpState>,
    ed2k_port: Option<u16>,
    ed2k_udp_port: Option<u16>,
) -> Result<serde_json::Value, AppError> {
    log::info!("upnp:start ed2k_port={ed2k_port:?} ed2k_udp_port={ed2k_udp_port:?}");
    crate::upnp::start_mapping(state.inner(), ed2k_port, ed2k_udp_port)
        .await
        .map_err(AppError::Upnp)
}

#[tauri::command]
pub async fn stop_upnp_mapping(state: tauri::State<'_, UpnpState>) -> Result<(), AppError> {
    log::info!("upnp:stop");
    crate::upnp::stop_mapping(state.inner()).await;
    Ok(())
}

#[tauri::command]
pub fn get_upnp_status(state: tauri::State<'_, UpnpState>) -> serde_json::Value {
    crate::upnp::get_status(state.inner())
}
