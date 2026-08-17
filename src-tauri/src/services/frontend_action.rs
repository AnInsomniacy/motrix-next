use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Frontend actions waiting for a recreated WebView to finish booting.
///
/// Lightweight mode destroys the main WebView while keeping native tray and
/// menu callbacks alive. Any action that depends on a Vue listener must survive
/// the gap between native window activation and listener registration.
#[derive(Debug, Default)]
struct PendingFrontendActions {
    queue: Vec<PendingFrontendAction>,
    frontend_ready: bool,
}

pub struct PendingFrontendActionState(Mutex<PendingFrontendActions>);

impl PendingFrontendActionState {
    pub fn new() -> Self {
        Self(Mutex::new(PendingFrontendActions::default()))
    }

    fn set_frontend_ready(&self, ready: bool) {
        match self.0.lock() {
            Ok(mut inner) => {
                inner.frontend_ready = ready;
            }
            Err(poisoned) => {
                poisoned.into_inner().frontend_ready = ready;
            }
        }
    }

    fn frontend_ready(&self) -> bool {
        self.0
            .lock()
            .map(|inner| inner.frontend_ready)
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FrontendActionChannel {
    #[cfg(target_os = "macos")]
    MenuEvent,
    TrayMenuAction,
}

impl FrontendActionChannel {
    fn event_name(self) -> &'static str {
        match self {
            #[cfg(target_os = "macos")]
            Self::MenuEvent => "menu-event",
            Self::TrayMenuAction => "tray-menu-action",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FrontendActionKind {
    #[cfg(target_os = "macos")]
    About,
    NewTask,
    #[cfg(target_os = "macos")]
    OpenTorrent,
    #[cfg(target_os = "macos")]
    Preferences,
    #[cfg(target_os = "macos")]
    ReleaseNotes,
    #[cfg(target_os = "macos")]
    ReportIssue,
}

impl FrontendActionKind {
    fn as_str(self) -> &'static str {
        match self {
            #[cfg(target_os = "macos")]
            Self::About => "about",
            Self::NewTask => "new-task",
            #[cfg(target_os = "macos")]
            Self::OpenTorrent => "open-torrent",
            #[cfg(target_os = "macos")]
            Self::Preferences => "preferences",
            #[cfg(target_os = "macos")]
            Self::ReleaseNotes => "release-notes",
            #[cfg(target_os = "macos")]
            Self::ReportIssue => "report-issue",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFrontendAction {
    channel: FrontendActionChannel,
    action: FrontendActionKind,
}

impl PendingFrontendAction {
    fn new(channel: FrontendActionChannel, action: FrontendActionKind) -> Self {
        Self { channel, action }
    }
}

#[cfg(target_os = "macos")]
pub fn menu_action_from_id(id: &str) -> Option<FrontendActionKind> {
    match id {
        "about" => Some(FrontendActionKind::About),
        "new-task" => Some(FrontendActionKind::NewTask),
        "open-torrent" => Some(FrontendActionKind::OpenTorrent),
        "preferences" => Some(FrontendActionKind::Preferences),
        "release-notes" => Some(FrontendActionKind::ReleaseNotes),
        "report-issue" => Some(FrontendActionKind::ReportIssue),
        _ => None,
    }
}

pub fn take_pending_frontend_actions(
    state: &PendingFrontendActionState,
) -> Vec<PendingFrontendAction> {
    match state.0.lock() {
        Ok(mut inner) => {
            inner.frontend_ready = true;
            std::mem::take(&mut inner.queue)
        }
        Err(poisoned) => {
            let mut inner = poisoned.into_inner();
            inner.frontend_ready = true;
            std::mem::take(&mut inner.queue)
        }
    }
}

pub fn mark_frontend_actions_unready(app: &AppHandle) {
    if let Some(state) = app.try_state::<PendingFrontendActionState>() {
        state.set_frontend_ready(false);
    }
}

pub fn dispatch_frontend_action(
    app: &AppHandle,
    channel: FrontendActionChannel,
    action: FrontendActionKind,
    source: &'static str,
) {
    let window_was_alive = app.get_webview_window("main").is_some();
    let frontend_ready = is_frontend_ready(app);

    log::info!(
        "frontend_action:dispatch source={source} channel={} action={} window_alive={window_was_alive} frontend_ready={frontend_ready}",
        channel.event_name(),
        action.as_str()
    );

    if window_was_alive && frontend_ready {
        wake_main_window(app, source);
        match app.emit(channel.event_name(), action.as_str()) {
            Ok(()) => return,
            Err(e) => {
                log::warn!(
                    "frontend_action:emit-failed source={source} channel={} action={} error={e}",
                    channel.event_name(),
                    action.as_str()
                );
            }
        }
    }

    queue_pending_frontend_action(app, PendingFrontendAction::new(channel, action), source);
    schedule_main_window_wake(app, source);
}

fn queue_pending_frontend_action(
    app: &AppHandle,
    action: PendingFrontendAction,
    source: &'static str,
) {
    match app.try_state::<PendingFrontendActionState>() {
        Some(state) => match state.0.lock() {
            Ok(mut inner) => {
                inner.queue.push(action);
                log::info!(
                    "frontend_action:queued source={source} pending={}",
                    inner.queue.len()
                );
            }
            Err(poisoned) => {
                let mut inner = poisoned.into_inner();
                inner.queue.push(action);
                log::warn!(
                    "frontend_action:queued-after-poison source={source} pending={}",
                    inner.queue.len()
                );
            }
        },
        None => {
            log::error!("frontend_action:queue-unavailable source={source}");
        }
    }
}

fn is_frontend_ready(app: &AppHandle) -> bool {
    app.try_state::<PendingFrontendActionState>()
        .map(|state| state.frontend_ready())
        .unwrap_or(false)
}

fn schedule_main_window_wake(app: &AppHandle, source: &'static str) {
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let app_for_main = app_for_task.clone();
        if let Err(e) = app_for_task.run_on_main_thread(move || {
            wake_main_window(&app_for_main, source);
        }) {
            log::error!("frontend_action:wake-schedule-failed source={source} error={e}");
        }
    });
}

fn wake_main_window(app: &AppHandle, source: &'static str) {
    log::debug!("frontend_action:wake-start source={source}");
    #[cfg(desktop)]
    {
        if crate::tray::activate_main_window(app, source)
            == crate::tray::WindowActivationOutcome::Activated
        {
            log::debug!("frontend_action:wake-done source={source}");
        } else {
            log::error!("frontend_action:wake-failed source={source}");
        }
    }
    // On mobile the WebView is never destroyed, so there is no window to wake.
    #[cfg(not(desktop))]
    {
        let _ = app;
        log::debug!("frontend_action:wake-skipped source={source} (mobile)");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        take_pending_frontend_actions, FrontendActionChannel, FrontendActionKind,
        PendingFrontendAction, PendingFrontendActionState,
    };

    #[cfg(target_os = "macos")]
    use super::menu_action_from_id;

    #[test]
    fn take_pending_frontend_actions_drains_queue_once() {
        let state = PendingFrontendActionState::new();
        {
            let mut inner = state
                .0
                .lock()
                .expect("pending frontend action state poisoned");
            inner.queue.push(PendingFrontendAction::new(
                FrontendActionChannel::TrayMenuAction,
                FrontendActionKind::NewTask,
            ));
        }

        assert_eq!(
            take_pending_frontend_actions(&state),
            vec![PendingFrontendAction::new(
                FrontendActionChannel::TrayMenuAction,
                FrontendActionKind::NewTask,
            )]
        );
        assert!(take_pending_frontend_actions(&state).is_empty());
    }

    #[test]
    fn take_pending_frontend_actions_marks_frontend_ready() {
        let state = PendingFrontendActionState::new();
        assert!(!state.frontend_ready());

        let _ = take_pending_frontend_actions(&state);

        assert!(state.frontend_ready());
    }

    #[test]
    fn frontend_ready_flag_can_be_cleared_after_webview_destruction() {
        let state = PendingFrontendActionState::new();
        let _ = take_pending_frontend_actions(&state);
        assert!(state.frontend_ready());

        state.set_frontend_ready(false);

        assert!(!state.frontend_ready());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn maps_supported_native_menu_ids() {
        assert_eq!(
            menu_action_from_id("new-task"),
            Some(FrontendActionKind::NewTask)
        );
        assert_eq!(
            menu_action_from_id("open-torrent"),
            Some(FrontendActionKind::OpenTorrent)
        );
        assert_eq!(menu_action_from_id("unknown"), None);
    }
}
