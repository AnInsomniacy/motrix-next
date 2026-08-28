//! Native Aria2 Next WebSocket lifecycle integration.

use super::monitor::{self, events};
use crate::aria2::client::Aria2Client;
use crate::error::AppError;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::watch;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;

pub const DOWNLOAD_PAUSE: &str = "aria2-event:download-pause";
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPauseEvent {
    pub gid: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeEventKind {
    DownloadStart,
    DownloadPause,
    DownloadComplete,
    DownloadError,
    BtDownloadComplete,
}

impl NativeEventKind {
    fn from_method(method: &str) -> Option<Self> {
        match method {
            "aria2.onDownloadStart" => Some(Self::DownloadStart),
            "aria2.onDownloadPause" => Some(Self::DownloadPause),
            "aria2.onDownloadComplete" => Some(Self::DownloadComplete),
            "aria2.onDownloadError" => Some(Self::DownloadError),
            "aria2.onBtDownloadComplete" => Some(Self::BtDownloadComplete),
            _ => None,
        }
    }

    fn lifecycle_event(self) -> Option<&'static str> {
        match self {
            Self::DownloadStart => Some(events::TASK_START),
            Self::DownloadPause => None,
            Self::DownloadComplete => Some(events::TASK_COMPLETE),
            Self::DownloadError => Some(events::TASK_ERROR),
            Self::BtDownloadComplete => Some(events::P2P_DOWNLOAD_COMPLETE),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NativeEvent {
    kind: NativeEventKind,
    gid: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Aria2EventGid {
    gid: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct Aria2Notification {
    method: String,
    #[serde(default)]
    params: Vec<Aria2EventGid>,
}

pub struct Aria2EventHandle {
    stop_tx: watch::Sender<bool>,
}

impl Aria2EventHandle {
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

pub struct Aria2EventState(pub Arc<tokio::sync::Mutex<Option<Aria2EventHandle>>>);

impl Aria2EventState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(None)))
    }
}

pub fn spawn_aria2_event_listener(
    app: tauri::AppHandle,
    aria2: Arc<Aria2Client>,
) -> Aria2EventHandle {
    let (stop_tx, stop_rx) = watch::channel(false);
    tokio::spawn(async move {
        event_loop(app, aria2, stop_rx).await;
    });
    Aria2EventHandle { stop_tx }
}

async fn event_loop(
    app: tauri::AppHandle,
    aria2: Arc<Aria2Client>,
    mut stop_rx: watch::Receiver<bool>,
) {
    loop {
        if *stop_rx.borrow() {
            return;
        }

        let (port, secret) = aria2.credentials().await;
        let url = format!("ws://127.0.0.1:{port}/jsonrpc");
        let connection = connect_async(&url).await;
        let Ok((mut socket, _)) = connection else {
            log::warn!("aria2_events: failed to connect websocket");
            if wait_for_retry(&mut stop_rx).await {
                return;
            }
            continue;
        };

        let authorization = tokio::time::timeout(
            AUTHORIZATION_TIMEOUT,
            authorize_socket(&mut socket, &secret),
        )
        .await;
        if let Err(error) = authorization.unwrap_or_else(|_| {
            Err(AppError::Aria2(
                "Aria2 Next WebSocket authorization timed out".into(),
            ))
        }) {
            log::warn!("aria2_events: websocket authorization failed: {error}");
            if wait_for_retry(&mut stop_rx).await {
                return;
            }
            continue;
        }

        match monitor::reconcile_stopped_tasks(&app, &aria2).await {
            Ok(0) => {}
            Ok(count) => log::info!("aria2_events: reconciled {count} lifecycle records"),
            Err(error) => log::warn!("aria2_events: lifecycle reconciliation failed: {error}"),
        }
        log::info!("aria2_events: websocket listening");

        let disconnected = receive_events(&app, &aria2, &mut socket, &mut stop_rx).await;
        if !disconnected {
            return;
        }
        log::warn!("aria2_events: websocket disconnected, reconnecting");
        if wait_for_retry(&mut stop_rx).await {
            return;
        }
    }
}

async fn receive_events(
    app: &tauri::AppHandle,
    aria2: &Aria2Client,
    socket: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    stop_rx: &mut watch::Receiver<bool>,
) -> bool {
    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    log::info!("aria2_events: stopped");
                    let _ = socket.close(None).await;
                    return false;
                }
            }
            message = socket.next() => {
                let Some(Ok(message)) = message else {
                    return true;
                };
                let Some(event) = native_event_from_message(&message) else {
                    continue;
                };
                if let Err(error) = handle_native_event(app, aria2, event).await {
                    log::warn!("aria2_events: lifecycle event failed: {error}");
                }
            }
        }
    }
}

async fn handle_native_event(
    app: &tauri::AppHandle,
    aria2: &Aria2Client,
    event: NativeEvent,
) -> Result<(), AppError> {
    if event.kind == NativeEventKind::DownloadPause {
        if let Err(error) = app.emit(DOWNLOAD_PAUSE, DownloadPauseEvent { gid: event.gid }) {
            log::warn!("aria2_events: failed to emit download pause: {error}");
        }
        return Ok(());
    }

    let task = aria2.tell_status(&event.gid).await?;

    // A start is not a terminal event: it is announced but never persisted,
    // so it takes its own path rather than the history-writing one.
    if event.kind == NativeEventKind::DownloadStart {
        return monitor::process_download_start(app, &task).await;
    }

    let Some(event_name) = event.kind.lifecycle_event() else {
        return Ok(());
    };
    monitor::process_lifecycle_task(app, event_name, &task, true).await
}

async fn authorize_socket(
    socket: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    secret: &str,
) -> Result<(), AppError> {
    let params = if secret.is_empty() {
        Vec::new()
    } else {
        vec![serde_json::json!(format!("token:{secret}"))]
    };
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "motrix-next-events-auth",
        "method": "aria2.getVersion",
        "params": params,
    });
    socket
        .send(Message::Text(request.to_string().into()))
        .await
        .map_err(|error| AppError::Aria2(format!("Failed to authorize WebSocket: {error}")))?;

    let response = socket
        .next()
        .await
        .ok_or_else(|| {
            AppError::Aria2("Aria2 Next closed the WebSocket during authorization".into())
        })?
        .map_err(|error| AppError::Aria2(format!("WebSocket authorization failed: {error}")))?;
    let Message::Text(text) = response else {
        return Err(AppError::Aria2(
            "Aria2 Next returned an invalid WebSocket authorization response".into(),
        ));
    };
    let response: serde_json::Value = serde_json::from_str(&text).map_err(|error| {
        AppError::Aria2(format!("Invalid WebSocket authorization response: {error}"))
    })?;
    if let Some(error) = response.get("error") {
        return Err(AppError::Aria2(format!(
            "Aria2 Next rejected WebSocket authorization: {error}"
        )));
    }
    if response.get("result").is_none() {
        return Err(AppError::Aria2(
            "Aria2 Next omitted the WebSocket authorization result".into(),
        ));
    }
    Ok(())
}

async fn wait_for_retry(stop_rx: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(RECONNECT_DELAY) => false,
        _ = stop_rx.changed() => *stop_rx.borrow(),
    }
}

fn native_event_from_message(message: &Message) -> Option<NativeEvent> {
    let Message::Text(text) = message else {
        return None;
    };
    native_event_from_text(text)
}

fn native_event_from_text(text: &str) -> Option<NativeEvent> {
    let notification: Aria2Notification = serde_json::from_str(text).ok()?;
    let kind = NativeEventKind::from_method(&notification.method)?;
    let gid = notification.params.first()?.gid.clone();
    Some(NativeEvent { kind, gid })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_native_lifecycle_events() {
        let cases = [
            ("aria2.onDownloadStart", NativeEventKind::DownloadStart),
            ("aria2.onDownloadPause", NativeEventKind::DownloadPause),
            (
                "aria2.onDownloadComplete",
                NativeEventKind::DownloadComplete,
            ),
            ("aria2.onDownloadError", NativeEventKind::DownloadError),
            (
                "aria2.onBtDownloadComplete",
                NativeEventKind::BtDownloadComplete,
            ),
        ];

        for (method, kind) in cases {
            let text =
                format!(r#"{{"jsonrpc":"2.0","method":"{method}","params":[{{"gid":"abc123"}}]}}"#);
            assert_eq!(
                native_event_from_text(&text),
                Some(NativeEvent {
                    kind,
                    gid: "abc123".into(),
                })
            );
        }
    }

    #[test]
    fn ignores_non_lifecycle_messages() {
        assert_eq!(
            native_event_from_text(
                r#"{"jsonrpc":"2.0","method":"aria2.onDownloadStop","params":[{"gid":"abc123"}]}"#
            ),
            None
        );
        assert_eq!(
            native_event_from_text(
                r#"{"jsonrpc":"2.0","id":"motrix-next-events-auth","result":{"version":"2.6.1"}}"#
            ),
            None
        );
    }

    #[test]
    fn download_start_maps_to_the_start_lifecycle_event() {
        assert_eq!(
            NativeEventKind::DownloadStart.lifecycle_event(),
            Some(events::TASK_START)
        );
    }

    #[test]
    fn download_start_is_not_a_terminal_event() {
        // Terminal events are persisted to history. A start must not be, so it
        // has to stay distinguishable from them at the routing point.
        for kind in [
            NativeEventKind::DownloadComplete,
            NativeEventKind::DownloadError,
            NativeEventKind::BtDownloadComplete,
        ] {
            assert_ne!(kind, NativeEventKind::DownloadStart);
        }
    }
}
