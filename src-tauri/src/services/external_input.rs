use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const DOWNLOAD_CONFIRMATION_WINDOW_LABEL: &str = "download-confirmation";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExternalInputRoute {
    Silent,
    MainWindow,
    DownloadConfirmation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExternalInputSurface {
    MainWindow,
    DownloadConfirmation,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRequestHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDownloadInput {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookie: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub request_headers: Vec<ExternalRequestHeader>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingExternalInputsPayload {
    pub inputs: Vec<ExternalDownloadInput>,
    pub silent: bool,
}

#[derive(Debug, Default)]
struct PendingExternalInputs {
    queue: Vec<ExternalDownloadInput>,
    confirmation_queue: Vec<ExternalDownloadInput>,
    frontend_ready: bool,
    confirmation_frontend_ready: bool,
    silent: bool,
}

pub struct PendingExternalInputState(Mutex<PendingExternalInputs>);

impl PendingExternalInputState {
    pub fn new() -> Self {
        Self(Mutex::new(PendingExternalInputs::default()))
    }

    fn set_frontend_ready(&self, ready: bool) {
        match self.0.lock() {
            Ok(mut inner) => inner.frontend_ready = ready,
            Err(poisoned) => poisoned.into_inner().frontend_ready = ready,
        }
    }

    fn frontend_ready(&self) -> bool {
        self.0
            .lock()
            .map(|inner| inner.frontend_ready)
            .unwrap_or(false)
    }

    fn set_confirmation_frontend_ready(&self, ready: bool) {
        match self.0.lock() {
            Ok(mut inner) => inner.confirmation_frontend_ready = ready,
            Err(poisoned) => poisoned.into_inner().confirmation_frontend_ready = ready,
        }
    }

    fn confirmation_frontend_ready(&self) -> bool {
        self.0
            .lock()
            .map(|inner| inner.confirmation_frontend_ready)
            .unwrap_or(false)
    }
}

pub fn take_pending_external_inputs(
    state: &PendingExternalInputState,
) -> PendingExternalInputsPayload {
    match state.0.lock() {
        Ok(mut inner) => {
            inner.frontend_ready = true;
            take_pending_payload(&mut inner)
        }
        Err(poisoned) => {
            let mut inner = poisoned.into_inner();
            inner.frontend_ready = true;
            take_pending_payload(&mut inner)
        }
    }
}

pub fn take_pending_confirmation_inputs(
    state: &PendingExternalInputState,
) -> PendingExternalInputsPayload {
    match state.0.lock() {
        Ok(mut inner) => {
            inner.confirmation_frontend_ready = true;
            take_pending_confirmation_payload(&mut inner)
        }
        Err(poisoned) => {
            let mut inner = poisoned.into_inner();
            inner.confirmation_frontend_ready = true;
            take_pending_confirmation_payload(&mut inner)
        }
    }
}

pub fn peek_pending_external_inputs_silent(state: &PendingExternalInputState) -> bool {
    state.0.lock().map(|inner| inner.silent).unwrap_or(false)
}

pub fn mark_frontend_unready(app: &AppHandle) {
    if let Some(state) = app.try_state::<PendingExternalInputState>() {
        state.set_frontend_ready(false);
    }
}

pub fn route_external_inputs(
    app: &AppHandle,
    inputs: Vec<ExternalDownloadInput>,
    source: &'static str,
    route: ExternalInputRoute,
) {
    if inputs.is_empty() {
        log::debug!("external_input:route source={source} count=0 skipped=true");
        return;
    }

    let main_window = app.get_webview_window("main");
    let main_window_was_alive = main_window.is_some();
    let main_window_visible = main_window
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let main_frontend_ready = is_frontend_ready(app);
    let surface = choose_external_input_surface(route, main_window_visible, main_frontend_ready);
    log::info!(
        "external_input:route source={source} count={} route={route:?} surface={surface:?} main_window_alive={main_window_was_alive} main_window_visible={main_window_visible} main_frontend_ready={main_frontend_ready}",
        inputs.len(),
    );

    if surface == ExternalInputSurface::DownloadConfirmation {
        route_to_download_confirmation(app, inputs, source);
        return;
    }

    let silent = route == ExternalInputRoute::Silent;
    if main_window_was_alive && main_frontend_ready {
        wake_main_window(app, source, silent);
        let payload = PendingExternalInputsPayload {
            inputs: inputs.clone(),
            silent,
        };
        match app.emit_to("main", "external-input-open", payload) {
            Ok(()) => return,
            Err(e) => log::warn!("external_input:emit-failed source={source} error={e}"),
        }
    }

    queue_pending_external_inputs(app, &inputs, source, silent);
    schedule_main_window_wake(app, source, silent);
}

fn take_pending_payload(inner: &mut PendingExternalInputs) -> PendingExternalInputsPayload {
    PendingExternalInputsPayload {
        inputs: std::mem::take(&mut inner.queue),
        silent: std::mem::take(&mut inner.silent),
    }
}

fn take_pending_confirmation_payload(
    inner: &mut PendingExternalInputs,
) -> PendingExternalInputsPayload {
    PendingExternalInputsPayload {
        inputs: std::mem::take(&mut inner.confirmation_queue),
        silent: false,
    }
}

fn choose_external_input_surface(
    route: ExternalInputRoute,
    _main_window_visible: bool,
    _main_frontend_ready: bool,
) -> ExternalInputSurface {
    if route == ExternalInputRoute::DownloadConfirmation {
        ExternalInputSurface::DownloadConfirmation
    } else {
        ExternalInputSurface::MainWindow
    }
}

fn is_frontend_ready(app: &AppHandle) -> bool {
    app.try_state::<PendingExternalInputState>()
        .map(|state| state.frontend_ready())
        .unwrap_or(false)
}

fn is_confirmation_frontend_ready(app: &AppHandle) -> bool {
    app.try_state::<PendingExternalInputState>()
        .map(|state| state.confirmation_frontend_ready())
        .unwrap_or(false)
}

fn route_to_download_confirmation(
    app: &AppHandle,
    inputs: Vec<ExternalDownloadInput>,
    source: &'static str,
) {
    if app
        .get_webview_window(DOWNLOAD_CONFIRMATION_WINDOW_LABEL)
        .is_some()
        && is_confirmation_frontend_ready(app)
    {
        activate_download_confirmation_window(app, source);
        let payload = PendingExternalInputsPayload {
            inputs: inputs.clone(),
            silent: false,
        };
        match app.emit_to(
            DOWNLOAD_CONFIRMATION_WINDOW_LABEL,
            "external-input-open",
            payload,
        ) {
            Ok(()) => return,
            Err(e) => {
                log::warn!("external_input:confirmation-emit-failed source={source} error={e}")
            }
        }
    }

    queue_pending_confirmation_inputs(app, &inputs, source);
    schedule_download_confirmation_window(app, source);
}

fn queue_pending_external_inputs(
    app: &AppHandle,
    inputs: &[ExternalDownloadInput],
    source: &'static str,
    silent: bool,
) {
    match app.try_state::<PendingExternalInputState>() {
        Some(state) => match state.0.lock() {
            Ok(mut inner) => {
                inner.queue.extend(inputs.iter().cloned());
                inner.silent = inner.silent || silent;
                log::info!(
                    "external_input:queued source={source} count={} pending={} silent={}",
                    inputs.len(),
                    inner.queue.len(),
                    inner.silent
                );
            }
            Err(poisoned) => {
                let mut inner = poisoned.into_inner();
                inner.queue.extend(inputs.iter().cloned());
                inner.silent = inner.silent || silent;
                log::warn!(
                    "external_input:queued-after-poison source={source} count={} pending={} silent={}",
                    inputs.len(),
                    inner.queue.len(),
                    inner.silent
                );
            }
        },
        None => log::error!(
            "external_input:queue-unavailable source={source} count={}",
            inputs.len()
        ),
    }
}

fn queue_pending_confirmation_inputs(
    app: &AppHandle,
    inputs: &[ExternalDownloadInput],
    source: &'static str,
) {
    match app.try_state::<PendingExternalInputState>() {
        Some(state) => match state.0.lock() {
            Ok(mut inner) => {
                inner.confirmation_queue.extend(inputs.iter().cloned());
                log::info!(
                    "external_input:confirmation-queued source={source} count={} pending={}",
                    inputs.len(),
                    inner.confirmation_queue.len()
                );
            }
            Err(poisoned) => {
                let mut inner = poisoned.into_inner();
                inner.confirmation_queue.extend(inputs.iter().cloned());
                log::warn!(
                    "external_input:confirmation-queued-after-poison source={source} count={} pending={}",
                    inputs.len(),
                    inner.confirmation_queue.len()
                );
            }
        },
        None => log::error!(
            "external_input:confirmation-queue-unavailable source={source} count={}",
            inputs.len()
        ),
    }
}

fn schedule_main_window_wake(app: &AppHandle, source: &'static str, silent: bool) {
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let app_for_main = app_for_task.clone();
        if let Err(e) = app_for_task.run_on_main_thread(move || {
            wake_main_window(&app_for_main, source, silent);
        }) {
            log::error!("external_input:wake-schedule-failed source={source} error={e}");
        }
    });
}

fn schedule_download_confirmation_window(app: &AppHandle, source: &'static str) {
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let app_for_main = app_for_task.clone();
        if let Err(e) = app_for_task.run_on_main_thread(move || {
            activate_download_confirmation_window(&app_for_main, source);
        }) {
            log::error!("external_input:confirmation-schedule-failed source={source} error={e}");
        }
    });
}

fn wake_main_window(app: &AppHandle, source: &'static str, silent: bool) {
    log::debug!("external_input:wake-start source={source} silent={silent}");
    let outcome = if silent {
        crate::tray::ensure_main_window(app, source)
    } else {
        crate::tray::activate_main_window(app, source)
    };
    if outcome == crate::tray::WindowActivationOutcome::Activated {
        log::debug!("external_input:wake-done source={source} silent={silent}");
    } else {
        log::error!("external_input:wake-failed source={source}");
    }
}

fn activate_download_confirmation_window(app: &AppHandle, source: &'static str) {
    log::info!("external_input:confirmation-activate-start source={source}");

    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        if let Err(e) = app.set_activation_policy(ActivationPolicy::Regular) {
            log::warn!(
                "external_input:confirmation-activation-policy-failed source={source} error={e}"
            );
        }
    }

    if let Some(window) = app.get_webview_window(DOWNLOAD_CONFIRMATION_WINDOW_LABEL) {
        if !is_confirmation_frontend_ready(app) {
            log::debug!("external_input:confirmation-window-waiting-for-frontend source={source}");
            return;
        }
        if let Err(e) = window.unminimize() {
            log::warn!("external_input:confirmation-unminimize-failed source={source} error={e}");
        }
        if let Err(e) = window.show() {
            log::warn!("external_input:confirmation-show-failed source={source} error={e}");
        }
        if let Err(e) = window.set_focus() {
            log::warn!("external_input:confirmation-focus-failed source={source} error={e}");
        }
        return;
    }

    if let Some(state) = app.try_state::<PendingExternalInputState>() {
        state.set_confirmation_frontend_ready(false);
    }

    let builder = WebviewWindowBuilder::new(
        app,
        DOWNLOAD_CONFIRMATION_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("Motrix Next")
    .inner_size(760.0, 720.0)
    .min_inner_size(560.0, 480.0)
    .center()
    .prevent_overflow()
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .resizable(true)
    .maximizable(false)
    .minimizable(false)
    .visible(false)
    .focused(true);

    #[cfg(target_os = "windows")]
    let builder = match app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.as_deref())
    {
        Some(additional_browser_args) => builder.additional_browser_args(additional_browser_args),
        None => builder,
    };

    match builder.build() {
        Ok(_) => log::info!("external_input:confirmation-window-created source={source}"),
        Err(e) => log::error!(
            "external_input:confirmation-window-create-failed source={source} error={e}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        choose_external_input_surface, peek_pending_external_inputs_silent,
        take_pending_external_inputs, ExternalDownloadInput, ExternalInputRoute,
        ExternalInputSurface, ExternalRequestHeader, PendingExternalInputState,
    };

    #[test]
    fn non_silent_extension_input_uses_confirmation_when_main_window_is_hidden() {
        assert_eq!(
            choose_external_input_surface(ExternalInputRoute::DownloadConfirmation, false, true),
            ExternalInputSurface::DownloadConfirmation
        );
    }

    #[test]
    fn confirmation_route_stays_independent_when_main_window_is_visible() {
        assert_eq!(
            choose_external_input_surface(ExternalInputRoute::DownloadConfirmation, true, true),
            ExternalInputSurface::DownloadConfirmation
        );
    }

    #[test]
    fn take_pending_external_inputs_preserves_structured_context_and_order() {
        let state = PendingExternalInputState::new();
        {
            let mut inner = state
                .0
                .lock()
                .expect("pending external input state poisoned");
            inner.queue.push(ExternalDownloadInput {
                url: "https://example.com/file.zip".to_string(),
                final_url: Some("https://cdn.example.com/file.zip".to_string()),
                referer: Some("https://example.com/page".to_string()),
                cookie: Some("sid=abc".to_string()),
                filename: Some("file.zip".to_string()),
                user_agent: Some("BrowserUA/1.0".to_string()),
                request_headers: vec![
                    ExternalRequestHeader {
                        name: "Accept".to_string(),
                        value: "application/octet-stream".to_string(),
                    },
                    ExternalRequestHeader {
                        name: "Accept-Language".to_string(),
                        value: "en-US,en;q=0.9".to_string(),
                    },
                ],
                source: Some("http-api".to_string()),
            });
            inner.silent = true;
        }

        let payload = take_pending_external_inputs(&state);

        assert!(payload.silent);
        assert_eq!(payload.inputs.len(), 1);
        assert_eq!(
            payload.inputs[0].user_agent.as_deref(),
            Some("BrowserUA/1.0")
        );
        assert_eq!(
            payload.inputs[0].request_headers[0].name,
            "Accept".to_string()
        );
        assert!(take_pending_external_inputs(&state).inputs.is_empty());
    }

    #[test]
    fn peek_pending_external_inputs_silent_clears_after_drain() {
        let state = PendingExternalInputState::new();
        {
            let mut inner = state
                .0
                .lock()
                .expect("pending external input state poisoned");
            inner.queue.push(ExternalDownloadInput {
                url: "https://example.com/file.zip".to_string(),
                final_url: None,
                referer: None,
                cookie: None,
                filename: None,
                user_agent: None,
                request_headers: vec![],
                source: Some("http-api".to_string()),
            });
            inner.silent = true;
        }

        assert!(peek_pending_external_inputs_silent(&state));

        let payload = take_pending_external_inputs(&state);

        assert!(payload.silent);
        assert!(!peek_pending_external_inputs_silent(&state));
    }
}
