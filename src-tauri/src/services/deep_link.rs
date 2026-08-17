use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

/// Deep-link URLs waiting for a recreated WebView to finish booting.
///
/// Lightweight mode destroys the main WebView when the user minimizes to tray.
/// External inputs must therefore survive the gap between native wake-up and
/// frontend listener registration.
#[derive(Debug, Default)]
struct PendingDeepLinks {
    queue: Vec<String>,
    frontend_ready: bool,
    silent: bool,
}

pub struct PendingDeepLinkState(Mutex<PendingDeepLinks>);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeepLinksPayload {
    pub urls: Vec<String>,
    pub silent: bool,
}

impl PendingDeepLinkState {
    pub fn new() -> Self {
        Self(Mutex::new(PendingDeepLinks::default()))
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

/// Return only argv entries that represent external download inputs.
///
/// Used by the desktop single-instance callback. CLI flags are ignored; URL
/// schemes and supported local metadata/torrent files are forwarded.
pub fn filter_external_input_args(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|arg| {
            if arg.starts_with('-') {
                return false;
            }
            let lower = arg.to_lowercase();
            lower.contains("://")
                || lower.starts_with("magnet:")
                || lower.starts_with("ed2k://")
                || lower.ends_with(".torrent")
        })
        .cloned()
        .collect()
}

/// Returns true when argv belongs to the OS autostart path.
pub fn is_autostart_arg_launch(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg == "--autostart" || arg.starts_with("--autostart="))
}

/// Drain pending external inputs for the frontend boot path.
pub fn take_pending_deep_links(state: &PendingDeepLinkState) -> PendingDeepLinksPayload {
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

pub fn peek_pending_deep_links_silent(state: &PendingDeepLinkState) -> bool {
    state.0.lock().map(|inner| inner.silent).unwrap_or(false)
}

fn take_pending_payload(inner: &mut PendingDeepLinks) -> PendingDeepLinksPayload {
    PendingDeepLinksPayload {
        urls: std::mem::take(&mut inner.queue),
        silent: std::mem::take(&mut inner.silent),
    }
}

/// Mark the frontend event listeners as unavailable.
///
/// Lightweight mode destroys the WebView while keeping the process alive. The
/// next recreated WebView must register listeners and drain pending inputs
/// before native code can safely emit directly to it again.
pub fn mark_frontend_unready(app: &AppHandle) {
    if let Some(state) = app.try_state::<PendingDeepLinkState>() {
        state.set_frontend_ready(false);
    }
}

/// Route external inputs to the active frontend, or queue them before waking a
/// destroyed lightweight-mode window.
pub fn route_external_inputs(app: &AppHandle, urls: Vec<String>, source: &'static str) {
    route_external_inputs_with_intent(app, urls, source, false);
}

fn route_external_inputs_with_intent(
    app: &AppHandle,
    urls: Vec<String>,
    source: &'static str,
    silent: bool,
) {
    if urls.is_empty() {
        log::debug!("deep_link:route source={source} count=0 skipped=true");
        return;
    }

    let window_was_alive = app.get_webview_window("main").is_some();
    log::info!(
        "deep_link:route source={source} count={} window_alive={window_was_alive}",
        urls.len()
    );

    let frontend_ready = is_frontend_ready(app);
    if window_was_alive && frontend_ready {
        wake_main_window(app, source, silent);
        let payload = PendingDeepLinksPayload {
            urls: urls.clone(),
            silent,
        };
        match app.emit("deep-link-open", payload) {
            Ok(()) => return,
            Err(e) => {
                log::warn!("deep_link:emit-failed source={source} error={e}");
            }
        }
    }

    queue_pending_deep_links(app, &urls, source, silent);
    schedule_main_window_wake(app, source, silent);
}

fn queue_pending_deep_links(app: &AppHandle, urls: &[String], source: &'static str, silent: bool) {
    match app.try_state::<PendingDeepLinkState>() {
        Some(state) => match state.0.lock() {
            Ok(mut inner) => {
                let added = append_unique_pending(&mut inner.queue, urls);
                inner.silent = inner.silent || silent;
                log::info!(
                    "deep_link:queued source={source} count={} added={} pending={} silent={}",
                    urls.len(),
                    added,
                    inner.queue.len(),
                    inner.silent
                );
            }
            Err(poisoned) => {
                let mut inner = poisoned.into_inner();
                let added = append_unique_pending(&mut inner.queue, urls);
                inner.silent = inner.silent || silent;
                log::warn!(
                    "deep_link:queued-after-poison source={source} count={} added={} pending={} silent={}",
                    urls.len(),
                    added,
                    inner.queue.len(),
                    inner.silent
                );
            }
        },
        None => {
            log::error!(
                "deep_link:queue-unavailable source={source} count={}",
                urls.len()
            );
        }
    }
}

fn append_unique_pending(queue: &mut Vec<String>, urls: &[String]) -> usize {
    let mut added = 0;
    for url in urls {
        if queue.iter().any(|pending| pending == url) {
            continue;
        }
        queue.push(url.clone());
        added += 1;
    }
    added
}

fn is_frontend_ready(app: &AppHandle) -> bool {
    app.try_state::<PendingDeepLinkState>()
        .map(|state| state.frontend_ready())
        .unwrap_or(false)
}

fn schedule_main_window_wake(app: &AppHandle, source: &'static str, silent: bool) {
    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let app_for_main = app_for_task.clone();
        if let Err(e) = app_for_task.run_on_main_thread(move || {
            wake_main_window(&app_for_main, source, silent);
        }) {
            log::error!("deep_link:wake-schedule-failed source={source} error={e}");
        }
    });
}

fn wake_main_window(app: &AppHandle, source: &'static str, silent: bool) {
    log::debug!("deep_link:wake-start source={source} silent={silent}");
    #[cfg(desktop)]
    {
        let outcome = if silent {
            crate::tray::ensure_main_window(app, source)
        } else {
            crate::tray::activate_main_window(app, source)
        };
        if outcome == crate::tray::WindowActivationOutcome::Activated {
            log::debug!("deep_link:wake-done source={source} silent={silent}");
        } else {
            log::error!("deep_link:wake-failed source={source}");
        }
    }
    // On mobile the WebView is never destroyed, so there is no window to wake.
    #[cfg(not(desktop))]
    {
        let _ = (app, silent);
        log::debug!("deep_link:wake-skipped source={source} (mobile)");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_unique_pending, filter_external_input_args, is_autostart_arg_launch,
        take_pending_deep_links, PendingDeepLinkState,
    };

    #[test]
    fn filters_supported_external_inputs_from_argv() {
        let args = vec![
            "/Applications/MotrixNext.app".to_string(),
            "--flag".to_string(),
            "file:///Users/example/ubuntu.torrent".to_string(),
            "magnet:?xt=urn:btih:abc".to_string(),
            "ed2k://|file|ubuntu.iso|123|0123456789abcdef0123456789abcdef|/".to_string(),
            "notes.txt".to_string(),
        ];

        let filtered = filter_external_input_args(&args);

        assert_eq!(
            filtered,
            vec![
                "file:///Users/example/ubuntu.torrent".to_string(),
                "magnet:?xt=urn:btih:abc".to_string(),
                "ed2k://|file|ubuntu.iso|123|0123456789abcdef0123456789abcdef|/".to_string()
            ]
        );
    }

    #[test]
    fn detects_autostart_args_for_empty_single_instance_launches() {
        assert!(is_autostart_arg_launch(&[
            "MotrixNext.exe".to_string(),
            "--autostart".to_string(),
        ]));
        assert!(is_autostart_arg_launch(&[
            "MotrixNext.exe".to_string(),
            "--autostart=true".to_string(),
        ]));
        assert!(!is_autostart_arg_launch(&[
            "MotrixNext.exe".to_string(),
            "--flag".to_string(),
        ]));
    }

    #[test]
    fn pending_queue_deduplicates_urls_while_preserving_order() {
        let mut queue = vec!["file:///Users/example/ubuntu.torrent".to_string()];
        let added = append_unique_pending(
            &mut queue,
            &[
                "file:///Users/example/ubuntu.torrent".to_string(),
                "magnet:?xt=urn:btih:abc".to_string(),
                "magnet:?xt=urn:btih:abc".to_string(),
                "/Users/example/Fedora.torrent".to_string(),
            ],
        );

        assert_eq!(added, 2);
        assert_eq!(
            queue,
            vec![
                "file:///Users/example/ubuntu.torrent".to_string(),
                "magnet:?xt=urn:btih:abc".to_string(),
                "/Users/example/Fedora.torrent".to_string(),
            ]
        );
    }

    #[test]
    fn take_pending_deep_links_drains_queue_once() {
        let state = PendingDeepLinkState::new();
        {
            let mut inner = state.0.lock().expect("pending deep-link state poisoned");
            append_unique_pending(
                &mut inner.queue,
                &[
                    "file:///Users/example/ubuntu.torrent".to_string(),
                    "magnet:?xt=urn:btih:abc".to_string(),
                ],
            );
        }

        let first = take_pending_deep_links(&state);
        assert_eq!(
            first.urls,
            vec![
                "file:///Users/example/ubuntu.torrent".to_string(),
                "magnet:?xt=urn:btih:abc".to_string(),
            ]
        );
        assert!(!first.silent);
        let second = take_pending_deep_links(&state);
        assert!(second.urls.is_empty());
        assert!(!second.silent);
    }

    #[test]
    fn take_pending_deep_links_marks_frontend_ready() {
        let state = PendingDeepLinkState::new();
        assert!(!state.frontend_ready());

        let _ = take_pending_deep_links(&state);

        assert!(state.frontend_ready());
    }

    #[test]
    fn frontend_ready_flag_can_be_cleared_after_webview_destruction() {
        let state = PendingDeepLinkState::new();
        let _ = take_pending_deep_links(&state);
        assert!(state.frontend_ready());

        state.set_frontend_ready(false);

        assert!(!state.frontend_ready());
    }

    #[test]
    fn take_pending_deep_links_preserves_silent_intent() {
        let state = PendingDeepLinkState::new();
        {
            let mut inner = state.0.lock().expect("pending deep-link state poisoned");
            append_unique_pending(
                &mut inner.queue,
                &["motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip".to_string()],
            );
            inner.silent = true;
        }

        let payload = take_pending_deep_links(&state);

        assert_eq!(
            payload.urls,
            vec!["motrixnext://new?url=https%3A%2F%2Fexample.com%2Ffile.zip".to_string()]
        );
        assert!(payload.silent);
        assert!(!take_pending_deep_links(&state).silent);
    }
}
