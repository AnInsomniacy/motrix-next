//! Extension HTTP API micro-service.
//!
//! Embeds an Axum HTTP server inside the Tauri process, sharing the existing
//! tokio runtime.  Provides a local REST API for browser extension → desktop
//! communication.
//!
//! Download requests are routed through the frontend as structured external
//! inputs. Legacy OS protocol handling still uses the deep-link service.
//! Rust selects the destination surface from the extension preferences and
//! manages its lifecycle. The frontend displays the AddTask dialog when
//! auto-submit is disabled, or auto-submits through the main window otherwise.
//!
//! Endpoints:
//! - `GET  /ping`       — heartbeat + app version
//! - `POST /add`        — route download to frontend
//! - `GET  /version`    — app + engine version info
//! - `GET  /stat`       — global download/upload statistics
//! - `POST /pause-all`  — pause all active downloads
//! - `POST /resume-all` — resume all paused downloads

use crate::aria2::client::Aria2State;
use crate::error::AppError;
use crate::services::config::{RuntimeConfigState, DEFAULT_EXTENSION_API_PORT};
use crate::services::external_input::{self, ExternalDownloadInput, ExternalRequestHeader};
use crate::services::port_guard;
use axum::{
    extract::State,
    http::{header, HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

// ── Request / Response Types ────────────────────────────────────────

/// POST /add request body from the browser extension.
#[derive(Debug, Deserialize)]
pub struct AddRequest {
    pub url: String,
    #[serde(rename = "finalUrl")]
    pub final_url: Option<String>,
    pub referer: Option<String>,
    pub cookie: Option<String>,
    #[serde(rename = "userAgent")]
    pub user_agent: Option<String>,
    #[serde(rename = "requestHeaders", default)]
    pub request_headers: Vec<ExternalRequestHeader>,
    /// Output filename hint from the browser extension.
    /// Extracted from the URL's `response-content-disposition` query parameter
    /// (RFC 6266).
    pub filename: Option<String>,
}

/// POST /add response.
#[derive(Debug, Serialize)]
pub struct AddResponse {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// GET /ping response.
#[derive(Debug, Serialize)]
pub struct PingResponse {
    pub status: String,
    pub version: String,
}

/// GET /version response.
#[derive(Debug, Serialize)]
pub struct VersionResponse {
    pub app: String,
    pub engine: String,
}

/// GET /stat response — mirrors aria2's getGlobalStat for the extension popup.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatResponse {
    pub download_speed: String,
    pub upload_speed: String,
    pub num_active: String,
    pub num_waiting: String,
    pub num_stopped: String,
    pub num_stopped_total: String,
}

/// Generic action response for control endpoints (pause-all, resume-all).
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ActionResponse {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── Auth Extraction ─────────────────────────────────────────────────

/// Extract and validate the Bearer token from the Authorization header.
///
/// Returns `Ok(())` if:
/// - The server secret is empty (authentication disabled)
/// - The header matches `Bearer {secret}`
///
/// Returns `Err(StatusCode::UNAUTHORIZED)` otherwise.
pub fn validate_bearer_token(headers: &HeaderMap, expected_secret: &str) -> Result<(), StatusCode> {
    // Empty secret = auth disabled (matches aria2 behavior)
    if expected_secret.is_empty() {
        return Ok(());
    }

    let header_value = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let expected = format!("Bearer {expected_secret}");
    if header_value == expected {
        Ok(())
    } else {
        log::warn!("http_api: 401 Unauthorized (invalid or missing Bearer token)");
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// Check whether an Origin header value belongs to a browser extension.
///
/// Only `chrome-extension://` and `moz-extension://` prefixes are accepted.
/// Used by the CORS layer to restrict API access to browser extensions only.
#[cfg(test)]
pub fn is_allowed_extension_origin(origin: &str) -> bool {
    origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://")
}

// ── Axum State ──────────────────────────────────────────────────────

/// Shared state passed to Axum handlers via `State<Arc<ApiContext>>`.
pub struct ApiContext {
    pub app: AppHandle,
}

// ── Router Builder ──────────────────────────────────────────────────

/// Build the Axum router with all routes.
pub fn build_router(ctx: Arc<ApiContext>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_private_network(true);

    Router::new()
        .route("/ping", get(handle_ping))
        .route("/add", post(handle_add))
        .route("/version", get(handle_version))
        .route("/stat", get(handle_stat))
        .route("/pause-all", post(handle_pause_all))
        .route("/resume-all", post(handle_resume_all))
        .layer(cors)
        .with_state(ctx)
}

// ── Handlers ────────────────────────────────────────────────────────

async fn handle_ping(State(ctx): State<Arc<ApiContext>>) -> impl IntoResponse {
    let version = ctx.app.package_info().version.to_string();
    Json(PingResponse {
        status: "ok".to_string(),
        version,
    })
}

async fn handle_add(
    State(ctx): State<Arc<ApiContext>>,
    headers: HeaderMap,
    Json(body): Json<AddRequest>,
) -> Result<Json<AddResponse>, StatusCode> {
    let secret = read_api_secret(&ctx.app);
    validate_bearer_token(&headers, &secret)?;

    log::info!(
        "http_api: POST /add url={} final_url={} header_count={} has_user_agent={} has_cookie={} source=http-api filename={}",
        summarize_url_for_log(&body.url),
        body.final_url
            .as_deref()
            .map(summarize_url_for_log)
            .unwrap_or_else(|| "none".to_string()),
        body.request_headers.len(),
        body.user_agent.as_ref().is_some_and(|v| !v.is_empty()),
        body.cookie.as_ref().is_some_and(|v| !v.is_empty()),
        if body.filename.as_ref().is_some_and(|v| !v.is_empty()) {
            "present"
        } else {
            "none"
        },
    );

    // Route all downloads through a frontend surface.
    //
    // This unified path handles supported URL types (HTTP, magnet, local torrent)
    // and all main-window states (normal, hidden, destroyed in lightweight mode).
    route_to_frontend(&ctx.app, &body);
    Ok(Json(AddResponse {
        action: "queued".to_string(),
        gid: None,
        message: None,
    }))
}

async fn handle_version(State(ctx): State<Arc<ApiContext>>) -> impl IntoResponse {
    let app_version = ctx.app.package_info().version.to_string();

    let engine_status = if ctx.app.try_state::<Aria2State>().is_some() {
        "running"
    } else {
        "stopped"
    };

    Json(VersionResponse {
        app: app_version,
        engine: engine_status.to_string(),
    })
}

/// GET /stat — global download/upload statistics.
///
/// Returns the same shape as aria2's `getGlobalStat`, allowing the
/// extension popup to display speed and task counts without needing
/// a direct aria2 RPC connection.
async fn handle_stat(
    State(ctx): State<Arc<ApiContext>>,
    headers: HeaderMap,
) -> Result<Json<StatResponse>, StatusCode> {
    let secret = read_api_secret(&ctx.app);
    validate_bearer_token(&headers, &secret)?;

    let aria2 = ctx
        .app
        .try_state::<Aria2State>()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;

    match aria2.0.get_global_stat().await {
        Ok(stat) => Ok(Json(StatResponse {
            download_speed: stat.download_speed,
            upload_speed: stat.upload_speed,
            num_active: stat.num_active,
            num_waiting: stat.num_waiting,
            num_stopped: stat.num_stopped,
            num_stopped_total: stat.num_stopped_total,
        })),
        Err(e) => {
            log::error!("http_api: get_global_stat failed: {e}");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

/// POST /pause-all — pause all active downloads.
async fn handle_pause_all(
    State(ctx): State<Arc<ApiContext>>,
    headers: HeaderMap,
) -> Result<Json<ActionResponse>, StatusCode> {
    let secret = read_api_secret(&ctx.app);
    validate_bearer_token(&headers, &secret)?;

    log::info!("http_api: POST /pause-all");

    let aria2 = match ctx.app.try_state::<Aria2State>() {
        Some(s) => s,
        None => {
            return Ok(Json(ActionResponse {
                status: "error".to_string(),
                error: Some("Engine not running".to_string()),
            }));
        }
    };

    match aria2.0.force_pause_all().await {
        Ok(_) => Ok(Json(ActionResponse {
            status: "ok".to_string(),
            error: None,
        })),
        Err(e) => Ok(Json(ActionResponse {
            status: "error".to_string(),
            error: Some(e.to_string()),
        })),
    }
}

/// POST /resume-all — resume all paused downloads.
async fn handle_resume_all(
    State(ctx): State<Arc<ApiContext>>,
    headers: HeaderMap,
) -> Result<Json<ActionResponse>, StatusCode> {
    let secret = read_api_secret(&ctx.app);
    validate_bearer_token(&headers, &secret)?;

    log::info!("http_api: POST /resume-all");

    let aria2 = match ctx.app.try_state::<Aria2State>() {
        Some(s) => s,
        None => {
            return Ok(Json(ActionResponse {
                status: "error".to_string(),
                error: Some("Engine not running".to_string()),
            }));
        }
    };

    match aria2.0.resume_eligible().await {
        Ok(result) => {
            log::info!(
                "http_api: POST /resume-all resumed={} blocked={}",
                result.resumed,
                result.blocked
            );
            Ok(Json(ActionResponse {
                status: "ok".to_string(),
                error: None,
            }))
        }
        Err(e) => Ok(Json(ActionResponse {
            status: "error".to_string(),
            error: Some(e.to_string()),
        })),
    }
}

// ── Helper Functions ────────────────────────────────────────────────

/// Reads the `extensionApiSecret` for HTTP API authentication.
/// This secret is fully independent from `rpcSecret` (used for aria2 RPC).
/// Returns empty string if not configured (auth disabled).
fn read_api_secret(app: &AppHandle) -> String {
    app.store("config.json")
        .ok()
        .and_then(|s| s.get("preferences"))
        .and_then(|p| {
            p.get("extensionApiSecret")
                .and_then(|v| v.as_str().map(String::from))
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default()
}

/// Route a download request through the shared external-input channel.
fn route_to_frontend(app: &AppHandle, req: &AddRequest) {
    let input = ExternalDownloadInput {
        url: req.url.clone(),
        final_url: req.final_url.clone(),
        referer: req.referer.clone(),
        cookie: req.cookie.clone(),
        filename: req.filename.clone(),
        user_agent: req.user_agent.clone(),
        request_headers: req.request_headers.clone(),
        source: Some("http-api".to_string()),
    };
    let route = extension_input_route(app, req);
    external_input::route_external_inputs(app, vec![input], "http-api", route);
}

fn extension_input_route(app: &AppHandle, req: &AddRequest) -> external_input::ExternalInputRoute {
    app.store("config.json")
        .ok()
        .and_then(|s| s.get("preferences"))
        .map(|p| {
            let auto_submit = p
                .get("autoSubmitFromExtension")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let use_independent_window = p
                .get("useIndependentDownloadWindow")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let silent = p
                .get("silentAutoSubmitFromExtension")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let auto_select_all = p
                .get("autoSelectAllBtFilesFromExtension")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let pause_metadata = p
                .get("pauseMetadata")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            let effective_url = req.final_url.as_deref().unwrap_or(&req.url);
            extension_input_route_url(
                effective_url,
                auto_submit,
                use_independent_window,
                silent,
                auto_select_all,
                pause_metadata,
            )
        })
        .unwrap_or(external_input::ExternalInputRoute::MainWindow)
}

fn extension_input_route_url(
    raw_url: &str,
    auto_submit: bool,
    use_independent_window: bool,
    silent: bool,
    auto_select_all: bool,
    pause_metadata: bool,
) -> external_input::ExternalInputRoute {
    if !auto_submit {
        return if use_independent_window {
            external_input::ExternalInputRoute::DownloadConfirmation
        } else {
            external_input::ExternalInputRoute::MainWindow
        };
    }
    if should_silent_route_url(
        raw_url,
        auto_submit,
        silent,
        auto_select_all,
        pause_metadata,
    ) {
        external_input::ExternalInputRoute::Silent
    } else {
        external_input::ExternalInputRoute::MainWindow
    }
}

fn should_silent_route_url(
    raw_url: &str,
    auto_submit: bool,
    silent: bool,
    auto_select_all: bool,
    pause_metadata: bool,
) -> bool {
    if !(auto_submit && silent) {
        return false;
    }
    let lower = raw_url.to_ascii_lowercase();
    if lower.starts_with("magnet:") {
        if auto_select_all {
            return true;
        }
        return !pause_metadata;
    }
    if is_remote_torrent_url(raw_url) {
        return auto_select_all;
    }
    true
}

fn is_remote_torrent_url(raw_url: &str) -> bool {
    let Ok(url) = url::Url::parse(raw_url) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.path().to_ascii_lowercase().ends_with(".torrent")
}

/// Build a `motrixnext://new?url=X&referer=Y&cookie=Z` deep-link URL.
///
/// Uses the `url` crate for proper percent-encoding of query parameter
/// values, avoiding manual escaping bugs with special characters.
#[cfg(test)]
fn build_deep_link_url(req: &AddRequest) -> String {
    let mut deep_link = url::Url::parse("motrixnext://new").expect("static URL must parse");
    {
        let mut q = deep_link.query_pairs_mut();
        q.append_pair("url", &req.url);
        if let Some(ref referer) = req.referer {
            if !referer.is_empty() {
                q.append_pair("referer", referer);
            }
        }
        if let Some(ref cookie) = req.cookie {
            if !cookie.is_empty() {
                q.append_pair("cookie", cookie);
            }
        }
        if let Some(ref filename) = req.filename {
            if !filename.is_empty() {
                q.append_pair("filename", filename);
            }
        }
    }
    deep_link.to_string()
}

fn summarize_url_for_log(value: &str) -> String {
    let lower = value.to_lowercase();
    if lower.starts_with("magnet:") {
        return format!("scheme=magnet length={}", value.len());
    }
    if lower.starts_with("ed2k://") {
        return format!("scheme=ed2k length={}", value.len());
    }
    if lower.starts_with("thunder://") {
        return format!("scheme=thunder length={}", value.len());
    }

    match url::Url::parse(value) {
        Ok(parsed) => {
            let scheme = parsed.scheme();
            let host = parsed.host_str().unwrap_or("none");
            let ext = parsed
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext))
                .filter(|ext| !ext.is_empty() && ext.len() <= 16)
                .unwrap_or("none");
            format!(
                "scheme={scheme} host={host} ext={} has_query={} length={}",
                ext.to_ascii_lowercase(),
                parsed.query().is_some(),
                value.len()
            )
        }
        Err(_) => format!("parseable=false length={}", value.len()),
    }
}
// ── Server Lifecycle ────────────────────────────────────────────────

/// Handle for a running HTTP API server.  Allows graceful shutdown.
pub struct HttpApiHandle {
    shutdown_tx: tokio::sync::oneshot::Sender<()>,
    join_handle: tokio::task::JoinHandle<()>,
    port: u16,
    allow_remote_access: bool,
}

impl HttpApiHandle {
    /// The port this server is currently bound to.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Whether this server is bound to all network interfaces.
    pub fn allow_remote_access(&self) -> bool {
        self.allow_remote_access
    }

    /// Signal the server to shut down and wait for it to finish.
    pub async fn stop(self) {
        let _ = self.shutdown_tx.send(());
        let _ = self.join_handle.await;
    }
}

/// Tauri managed state for the HTTP API server handle.
pub struct HttpApiState(pub Mutex<Option<HttpApiHandle>>);

impl HttpApiState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}

/// Spawn the HTTP API server on the given port.
///
/// The server binds locally by default and runs until the returned
/// handle is stopped or the application exits.
pub async fn spawn_http_api(
    app: AppHandle,
    port: u16,
    allow_remote_access: bool,
) -> Result<HttpApiHandle, AppError> {
    let ctx = Arc::new(ApiContext { app });
    let router = build_router(ctx);

    let host = if allow_remote_access {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };
    let addr = std::net::SocketAddr::from((host, port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| AppError::Io(format!("Failed to bind HTTP API on port {port}: {e}")))?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let join_handle = tokio::spawn(async move {
        let graceful = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = graceful.await {
            log::error!("http_api: server error: {e}");
        }
    });

    log::info!("http_api: listening on {addr}");

    Ok(HttpApiHandle {
        shutdown_tx,
        join_handle,
        port,
        allow_remote_access,
    })
}

/// Stop the current HTTP API server (if running) and respawn on `new_port`.
///
/// Used by:
/// - `on_engine_ready()` during startup (idempotent — skipped if already
///   bound to the correct port by the caller)
/// - `restart_http_api` command when the user changes the port at runtime
///
/// The old server is stopped *before* binding the new one because the old
/// and new port may be identical (user changed and reverted), so the
/// listener must be released first.
pub async fn restart_on_port(app: &AppHandle, new_port: u16) -> Result<u16, AppError> {
    let api_state = app
        .try_state::<HttpApiState>()
        .ok_or_else(|| AppError::Engine("HttpApiState not managed".into()))?;

    let mut guard = api_state.0.lock().await;

    // Stop existing server (if any)
    if let Some(handle) = guard.take() {
        log::info!(
            "http_api: stopping server on port {} for rebind to {new_port}",
            handle.port()
        );
        handle.stop().await;
    }

    let allow_remote_access = read_extension_api_allow_remote_access(app).await;

    // Spawn on the new port, then recover once if the chosen port is busy.
    let handle = match spawn_http_api(app.clone(), new_port, allow_remote_access).await {
        Ok(handle) => handle,
        Err(e) => {
            log::warn!("http_api: bind failed on port {new_port}: {e}");
            let fallback = port_guard::recover_extension_api_port(app, new_port).await?;
            match spawn_http_api(app.clone(), fallback, allow_remote_access).await {
                Ok(handle) => handle,
                Err(e) => {
                    port_guard::emit_bind_failed(
                        app,
                        port_guard::PortKind::ExtensionApi,
                        fallback,
                        port_guard::PortSwitchFailureSource::ExtensionApi,
                    );
                    return Err(e);
                }
            }
        }
    };
    let port = handle.port();
    *guard = Some(handle);
    Ok(port)
}

// ── Read extension API port from RuntimeConfig ─────────────────────

/// Read the extension API port from RuntimeConfigState.
/// Falls back to store read, then to the default extension API port if neither is available.
pub async fn read_extension_api_port(app: &AppHandle) -> u16 {
    // Primary: RuntimeConfigState (cached, always in sync)
    if let Some(rc_state) = app.try_state::<RuntimeConfigState>() {
        return rc_state.0.read().await.extension_api_port;
    }
    // Fallback: direct store read (during early startup before state is managed)
    read_extension_api_port_from_store(app)
}

pub async fn read_extension_api_allow_remote_access(app: &AppHandle) -> bool {
    if let Some(rc_state) = app.try_state::<RuntimeConfigState>() {
        return rc_state.0.read().await.allow_remote_access;
    }
    read_extension_api_allow_remote_access_from_store(app)
}

/// Direct store read — used only as a fallback during early startup.
fn read_extension_api_port_from_store(app: &AppHandle) -> u16 {
    app.store("config.json")
        .ok()
        .and_then(|s| s.get("preferences"))
        .and_then(|p| {
            p.get("extensionApiPort").and_then(|v| {
                v.as_u64()
                    .map(|n| n as u16)
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
        })
        .unwrap_or(DEFAULT_EXTENSION_API_PORT)
}

fn read_extension_api_allow_remote_access_from_store(app: &AppHandle) -> bool {
    app.store("config.json")
        .ok()
        .and_then(|s| s.get("preferences"))
        .and_then(|p| {
            p.get("allowRemoteAccess")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    // ── validate_bearer_token ───────────────────────────────────────

    #[test]
    fn auth_accepts_correct_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer my-secret"),
        );
        assert!(validate_bearer_token(&headers, "my-secret").is_ok());
    }

    #[test]
    fn auth_rejects_wrong_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer wrong-secret"),
        );
        assert_eq!(
            validate_bearer_token(&headers, "my-secret"),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn auth_rejects_missing_header() {
        let headers = HeaderMap::new();
        assert_eq!(
            validate_bearer_token(&headers, "my-secret"),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn auth_rejects_non_bearer_scheme() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Basic my-secret"));
        assert_eq!(
            validate_bearer_token(&headers, "my-secret"),
            Err(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn auth_allows_any_request_when_secret_is_empty() {
        let headers = HeaderMap::new();
        assert!(validate_bearer_token(&headers, "").is_ok());
    }

    #[test]
    fn auth_allows_with_header_when_secret_is_empty() {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static("Bearer anything"));
        assert!(validate_bearer_token(&headers, "").is_ok());
    }

    #[test]
    fn extension_route_requires_confirmation_when_auto_submit_is_disabled() {
        assert_eq!(
            extension_input_route_url(
                "https://example.com/file.zip",
                false,
                true,
                true,
                false,
                true,
            ),
            external_input::ExternalInputRoute::DownloadConfirmation
        );
    }

    #[test]
    fn extension_route_uses_main_window_when_independent_window_is_disabled() {
        assert_eq!(
            extension_input_route_url(
                "https://example.com/file.zip",
                false,
                false,
                true,
                false,
                true,
            ),
            external_input::ExternalInputRoute::MainWindow
        );
    }

    #[test]
    fn extension_route_keeps_non_silent_auto_submit_in_main_window() {
        assert_eq!(
            extension_input_route_url(
                "https://example.com/file.zip",
                true,
                true,
                false,
                false,
                true,
            ),
            external_input::ExternalInputRoute::MainWindow
        );
    }

    // ── AddRequest deserialization ───────────────────────────────────

    #[test]
    fn deserialize_add_request_full() {
        let json = serde_json::json!({
            "url": "https://example.com/file.zip",
            "finalUrl": "https://cdn.example.com/file.zip",
            "referer": "https://example.com/page",
            "cookie": "sid=abc",
            "userAgent": "Mozilla/5.0",
            "requestHeaders": [
                { "name": "Accept", "value": "application/octet-stream" },
                { "name": "Accept-Language", "value": "en-US,en;q=0.9" }
            ],
            "filename": "file.zip"
        });
        let req: AddRequest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(req.url, "https://example.com/file.zip");
        assert_eq!(
            req.final_url.as_deref(),
            Some("https://cdn.example.com/file.zip")
        );
        assert_eq!(req.referer.as_deref(), Some("https://example.com/page"));
        assert_eq!(req.cookie.as_deref(), Some("sid=abc"));
        assert_eq!(req.user_agent.as_deref(), Some("Mozilla/5.0"));
        assert_eq!(
            req.request_headers,
            vec![
                ExternalRequestHeader {
                    name: "Accept".to_string(),
                    value: "application/octet-stream".to_string()
                },
                ExternalRequestHeader {
                    name: "Accept-Language".to_string(),
                    value: "en-US,en;q=0.9".to_string()
                }
            ]
        );
        assert_eq!(req.filename.as_deref(), Some("file.zip"));
    }

    #[test]
    fn deserialize_add_request_minimal() {
        let json = serde_json::json!({ "url": "https://example.com/file.zip" });
        let req: AddRequest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(req.url, "https://example.com/file.zip");
        assert!(req.final_url.is_none());
        assert!(req.referer.is_none());
        assert!(req.cookie.is_none());
        assert!(req.user_agent.is_none());
        assert!(req.request_headers.is_empty());
        assert!(req.filename.is_none());
    }

    #[test]
    fn deserialize_add_request_with_filename() {
        let json = serde_json::json!({
            "url": "https://cdn.quark.cn/hash123",
            "filename": "ghost-sample-v0.1.xmgic"
        });
        let req: AddRequest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(req.filename.as_deref(), Some("ghost-sample-v0.1.xmgic"));
    }

    #[test]
    fn deserialize_add_request_rejects_missing_url() {
        let json = serde_json::json!({ "referer": "https://example.com" });
        assert!(serde_json::from_value::<AddRequest>(json).is_err());
    }

    // ── AddResponse serialization ───────────────────────────────────

    #[test]
    fn serialize_submitted_response_includes_gid() {
        let resp = AddResponse {
            action: "submitted".to_string(),
            gid: Some("abc123".to_string()),
            message: None,
        };
        let json = serde_json::to_value(resp).expect("serialize");
        assert_eq!(json["action"], "submitted");
        assert_eq!(json["gid"], "abc123");
        assert!(json.get("message").is_none());
    }

    #[test]
    fn serialize_queued_response_omits_gid() {
        let resp = AddResponse {
            action: "queued".to_string(),
            gid: None,
            message: None,
        };
        let json = serde_json::to_value(resp).expect("serialize");
        assert_eq!(json["action"], "queued");
        assert!(json.get("gid").is_none());
    }

    // ── PingResponse serialization ──────────────────────────────────

    #[test]
    fn serialize_ping_response() {
        let resp = PingResponse {
            status: "ok".to_string(),
            version: "3.7.3".to_string(),
        };
        let json = serde_json::to_value(resp).expect("serialize");
        assert_eq!(json["status"], "ok");
        assert_eq!(json["version"], "3.7.3");
    }

    // ── VersionResponse serialization ───────────────────────────────

    #[test]
    fn serialize_version_response() {
        let resp = VersionResponse {
            app: "3.7.3".to_string(),
            engine: "running".to_string(),
        };
        let json = serde_json::to_value(resp).expect("serialize");
        assert_eq!(json["app"], "3.7.3");
        assert_eq!(json["engine"], "running");
    }

    // ── StatResponse serialization ─────────────────────────────────

    #[test]
    fn serialize_stat_response_uses_camel_case() {
        let resp = StatResponse {
            download_speed: "1048576".to_string(),
            upload_speed: "524288".to_string(),
            num_active: "2".to_string(),
            num_waiting: "3".to_string(),
            num_stopped: "5".to_string(),
            num_stopped_total: "10".to_string(),
        };
        let json = serde_json::to_value(&resp).expect("serialize");
        // Must use camelCase to match aria2's getGlobalStat format
        assert_eq!(json["downloadSpeed"], "1048576");
        assert_eq!(json["uploadSpeed"], "524288");
        assert_eq!(json["numActive"], "2");
        assert_eq!(json["numWaiting"], "3");
        assert_eq!(json["numStopped"], "5");
        assert_eq!(json["numStoppedTotal"], "10");
    }

    #[test]
    fn stat_response_roundtrip() {
        let resp = StatResponse {
            download_speed: "0".to_string(),
            upload_speed: "0".to_string(),
            num_active: "0".to_string(),
            num_waiting: "0".to_string(),
            num_stopped: "0".to_string(),
            num_stopped_total: "0".to_string(),
        };
        let json_str = serde_json::to_string(&resp).expect("serialize");
        let deserialized: StatResponse = serde_json::from_str(&json_str).expect("deserialize");
        assert_eq!(resp, deserialized);
    }

    // ── ActionResponse serialization ───────────────────────────────

    #[test]
    fn serialize_action_response_success() {
        let resp = ActionResponse {
            status: "ok".to_string(),
            error: None,
        };
        let json = serde_json::to_value(&resp).expect("serialize");
        assert_eq!(json["status"], "ok");
        assert!(json.get("error").is_none()); // skip_serializing_if
    }

    #[test]
    fn serialize_action_response_with_error() {
        let resp = ActionResponse {
            status: "error".to_string(),
            error: Some("Engine not running".to_string()),
        };
        let json = serde_json::to_value(&resp).expect("serialize");
        assert_eq!(json["status"], "error");
        assert_eq!(json["error"], "Engine not running");
    }

    // ── is_allowed_extension_origin ────────────────────────────────

    #[test]
    fn chrome_extension_origin_is_allowed() {
        assert!(is_allowed_extension_origin(
            "chrome-extension://abcdefghijklmnop"
        ));
    }

    #[test]
    fn firefox_extension_origin_is_allowed() {
        assert!(is_allowed_extension_origin(
            "moz-extension://abcdef-1234-5678"
        ));
    }

    #[test]
    fn http_origin_is_rejected() {
        assert!(!is_allowed_extension_origin("http://localhost:3000"));
    }

    #[test]
    fn https_origin_is_rejected() {
        assert!(!is_allowed_extension_origin("https://evil.com"));
    }

    #[test]
    fn empty_origin_is_rejected() {
        assert!(!is_allowed_extension_origin(""));
    }

    #[test]
    fn null_origin_is_rejected() {
        assert!(!is_allowed_extension_origin("null"));
    }

    // ── show_add_task_in_main_window URL builder ───────────────────

    #[test]
    fn deep_link_url_encodes_basic_url() {
        let mut deep_link = url::Url::parse("motrixnext://new").unwrap();
        deep_link
            .query_pairs_mut()
            .append_pair("url", "https://example.com/file.zip");
        assert!(deep_link.to_string().contains("url=https"));
        assert!(deep_link.to_string().starts_with("motrixnext://new?"));
    }

    #[test]
    fn deep_link_url_encodes_special_characters() {
        let mut deep_link = url::Url::parse("motrixnext://new").unwrap();
        deep_link
            .query_pairs_mut()
            .append_pair("url", "https://example.com/file name.zip?token=abc&v=1");
        let result = deep_link.to_string();
        // Ampersand in the value must be percent-encoded, not treated as separator
        assert!(result.contains("file+name.zip") || result.contains("file%20name.zip"));
        assert!(!result.contains("&v=1")); // inner & must be encoded
    }

    #[test]
    fn deep_link_url_includes_referer_and_cookie() {
        let mut deep_link = url::Url::parse("motrixnext://new").unwrap();
        {
            let mut q = deep_link.query_pairs_mut();
            q.append_pair("url", "https://example.com/file.zip");
            q.append_pair("referer", "https://example.com/page");
            q.append_pair("cookie", "sid=abc123; token=xyz");
        }
        let result = deep_link.to_string();
        assert!(result.contains("referer="));
        assert!(result.contains("cookie="));
    }

    #[test]
    fn deep_link_url_includes_filename() {
        let req = AddRequest {
            url: "https://cdn.quark.cn/hash123".to_string(),
            final_url: None,
            referer: None,
            cookie: None,
            user_agent: None,
            request_headers: Vec::new(),
            filename: Some("ghost-sample-v0.1.xmgic".to_string()),
        };
        let result = build_deep_link_url(&req);
        assert!(result.starts_with("motrixnext://new?"));
        assert!(result.contains("filename="));
        // Filename characters must be percent-encoded when needed
        assert!(result.contains("ghost-sample-v0.1.xmgic"));
    }

    #[test]
    fn deep_link_url_omits_empty_filename() {
        let req = AddRequest {
            url: "https://example.com/file.zip".to_string(),
            final_url: None,
            referer: None,
            cookie: None,
            user_agent: None,
            request_headers: Vec::new(),
            filename: Some(String::new()),
        };
        let result = build_deep_link_url(&req);
        assert!(!result.contains("filename="));
    }

    #[test]
    fn deep_link_url_omits_none_filename() {
        let req = AddRequest {
            url: "https://example.com/file.zip".to_string(),
            final_url: None,
            referer: None,
            cookie: None,
            user_agent: None,
            request_headers: Vec::new(),
            filename: None,
        };
        let result = build_deep_link_url(&req);
        assert!(!result.contains("filename="));
    }

    #[test]
    fn url_log_summary_excludes_sensitive_query_values() {
        let summary = summarize_url_for_log(
            "https://example.com/download/file.zip?jwt=secret-token&response-content-disposition=attachment",
        );
        assert_eq!(
            summary,
            "scheme=https host=example.com ext=zip has_query=true length=94"
        );
        assert!(!summary.contains("secret-token"));
        assert!(!summary.contains("jwt"));
    }

    #[test]
    fn url_log_summary_redacts_ed2k_file_link_details() {
        let summary = summarize_url_for_log(
            "ed2k://|file|Private%20File.iso|123|0123456789abcdef0123456789abcdef|/",
        );

        assert_eq!(summary, "scheme=ed2k length=70");
        assert!(!summary.contains("Private"));
        assert!(!summary.contains("0123456789abcdef"));
    }
}
