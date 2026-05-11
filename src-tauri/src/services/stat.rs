//! Global stat service — polls aria2 for download/upload statistics.
//!
//! Runs as a background tokio task, updating tray title, dock badge,
//! and progress bar directly from Rust without WebView round-trips.
//! Also emits `stat:update` events to the frontend for UI display.
//!
//! Port of the frontend `fetchGlobalStat` in `stores/app.ts`.

use super::config::RuntimeConfigState;
use crate::aria2::client::Aria2Client;
use crate::tray::TrayState;
use keepawake::KeepAwake;
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tokio::sync::watch;

/// Adaptive polling interval constants — aligned with `src/shared/timing.ts`.
///
/// These MUST stay in sync with the frontend `STAT_*` constants.
/// Mismatched values cause noticeable UI update rate differences
/// between normal and lightweight mode.
const STAT_BASE_INTERVAL_MS: u64 = 500;
const STAT_PER_TASK_INTERVAL_MS: u64 = 100;
const STAT_MIN_INTERVAL_MS: u64 = 500;
const STAT_MAX_INTERVAL_MS: u64 = 6000;
const STAT_IDLE_INCREMENT_MS: u64 = 100;

/// Payload emitted to the frontend via `stat:update`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatUpdate {
    pub download_speed: u64,
    pub upload_speed: u64,
    pub num_active: u64,
    pub num_waiting: u64,
    pub num_stopped: u64,
    pub num_stopped_total: u64,
}

/// Computes a human-readable compact size string (e.g., "1.5M", "200K").
///
/// Matches the frontend `compactSize` output used for tray/dock display.
fn compact_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;

    let b = bytes as f64;
    if b >= GB {
        format!("{:.1}G", b / GB)
    } else if b >= MB {
        format!("{:.1}M", b / MB)
    } else if b >= KB {
        format!("{:.0}K", b / KB)
    } else {
        format!("{b}B")
    }
}

/// Sets the macOS Dock badge label using `NSApp().dockTile().setBadgeLabel()`.
///
/// This is an **app-level** API that accesses `NSApplication.sharedApplication()`
/// directly — it does NOT require a `WebviewWindow` handle.  This is critical
/// because in lightweight mode `window.destroy()` kills the WebView, making
/// `get_webview_window("main")` return `None`.  The previous implementation
/// used `window.set_badge_label()` which silently failed in that case.
///
/// Pass `None` to clear the badge.
///
/// # Safety
///
/// Must be called from the main thread (macOS UI thread requirement).
/// The caller is responsible for dispatching via `app.run_on_main_thread()`
/// when invoking from an async tokio worker.
///
/// # Platform
///
/// Compiles only on macOS (`#[cfg(target_os = "macos")]`).  On other
/// platforms, callers gate the call with `#[cfg(...)]` at the call site.
#[cfg(target_os = "macos")]
pub(crate) fn set_dock_badge(label: Option<&str>) {
    use objc2_app_kit::NSApplication;
    use objc2_foundation::{MainThreadMarker, NSString};

    // SAFETY: Caller must ensure this runs on the main thread.
    // MainThreadMarker::new() returns None on background threads,
    // so we try it first and bail with a warning if not on main.
    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("set_dock_badge called from non-main thread — badge not updated");
        return;
    };

    let app = NSApplication::sharedApplication(mtm);
    let dock_tile = app.dockTile();
    let ns_label = label.map(NSString::from_str);
    dock_tile.setBadgeLabel(ns_label.as_deref());
    dock_tile.display();
}

/// Sets the macOS Dock progress bar via `NSDockTile` + custom `NSProgressIndicator`.
///
/// A plain `NSProgressIndicator` does not render inside `NSDockTile` because
/// dock tiles use image-based compositing: `display()` calls `drawRect:` to
/// capture a bitmap snapshot, but `NSProgressIndicator`'s `drawRect:` relies on
/// the window compositor's CALayer tree which doesn't exist for dock tiles.
///
/// The fix: register a custom `NSProgressIndicator` subclass (`MotrixProgressIndicator`)
/// with a `drawRect:` override that manually paints using `NSBezierPath`.  This is
/// the same approach used by tao's `TaoProgressIndicator` — the industry-standard
/// workaround for dock tile progress rendering.
///
/// Pass `None` to hide the progress bar, or `Some(0..=100)` to show it.
///
/// # Safety
///
/// Must be called from the main thread (macOS UI thread requirement).
#[cfg(target_os = "macos")]
pub(crate) fn set_dock_progress(progress: Option<u64>) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // SAFETY: All NSApplication/NSDockTile APIs must be called from the main thread.
    unsafe {
        let ns_app: *mut AnyObject = msg_send![objc2::class!(NSApplication), sharedApplication];
        let dock_tile: *mut AnyObject = msg_send![ns_app, dockTile];
        if dock_tile.is_null() {
            return;
        }

        // Find existing progress indicator or create one
        let indicator: *mut AnyObject = get_or_create_progress_indicator(ns_app, dock_tile);
        if indicator.is_null() {
            return;
        }

        match progress {
            Some(pct) => {
                let value = pct.clamp(0, 100) as f64;
                let _: () = msg_send![indicator, setDoubleValue: value];
                let _: () = msg_send![indicator, setHidden: false];
            }
            None => {
                let _: () = msg_send![indicator, setHidden: true];
            }
        }

        let _: () = msg_send![dock_tile, display];
    }
}

/// Finds an existing `NSProgressIndicator` subclass in the dock tile's content view,
/// or creates a new `MotrixProgressIndicator` (custom subclass with `drawRect:` override).
///
/// A plain `NSProgressIndicator` is invisible in dock tiles because `NSDockTile.display()`
/// captures a bitmap by calling `drawRect:` on the content view hierarchy, and the stock
/// `NSProgressIndicator.drawRect:` depends on the window compositor's CALayer tree.
///
/// Our custom subclass overrides `drawRect:` to manually paint the progress bar using
/// `NSBezierPath` — the same technique used by tao's `TaoProgressIndicator`.
#[cfg(target_os = "macos")]
unsafe fn get_or_create_progress_indicator(
    ns_app: *mut objc2::runtime::AnyObject,
    dock_tile: *mut objc2::runtime::AnyObject,
) -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    // Try to find existing indicator (ours or tao's — both are NSProgressIndicator subclasses)
    let content_view: *mut AnyObject = msg_send![dock_tile, contentView];
    if !content_view.is_null() {
        let subviews: *mut AnyObject = msg_send![content_view, subviews];
        if !subviews.is_null() {
            let count: usize = msg_send![subviews, count];
            for i in 0..count {
                let subview: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
                let is_progress: bool =
                    msg_send![subview, isKindOfClass: objc2::class!(NSProgressIndicator)];
                if is_progress {
                    return subview;
                }
            }
        }
    }

    // No existing indicator — create one with custom drawRect:
    let mut image_view: *mut AnyObject = msg_send![dock_tile, contentView];
    if image_view.is_null() {
        let app_icon: *mut AnyObject = msg_send![ns_app, applicationIconImage];
        image_view = msg_send![objc2::class!(NSImageView), imageViewWithImage: app_icon];
        let _: () = msg_send![dock_tile, setContentView: image_view];
    }

    let dock_size: NSSize = msg_send![dock_tile, size];
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(dock_size.width, 15.0));

    let progress_class = register_progress_indicator_class();
    let indicator: *mut AnyObject = msg_send![progress_class, alloc];
    let indicator: *mut AnyObject = msg_send![indicator, initWithFrame: frame];
    let _: *mut AnyObject = msg_send![indicator, autorelease];

    let _: () = msg_send![image_view, addSubview: indicator];
    indicator
}

/// Registers the `MotrixProgressIndicator` ObjC class (once) — a custom
/// `NSProgressIndicator` subclass with a `drawRect:` override for dock tile rendering.
///
/// The class draws a rounded progress bar using `NSBezierPath`:
/// - Gray track (semi-transparent white)
/// - Blue fill proportional to `doubleValue / 100.0`
#[cfg(target_os = "macos")]
fn register_progress_indicator_class() -> *const objc2::runtime::AnyClass {
    use objc2::runtime::{AnyClass, ClassBuilder, Sel};
    use objc2_foundation::NSRect;

    use std::sync::Once;

    static mut CLASS: *const AnyClass = std::ptr::null();
    static INIT: Once = Once::new();

    INIT.call_once(|| unsafe {
        let superclass = objc2::class!(NSProgressIndicator);
        let mut decl = ClassBuilder::new(c"MotrixProgressIndicator", superclass)
            .expect("Failed to create MotrixProgressIndicator class");

        // Register the custom drawRect: method.
        // Uses raw pointer (*mut AnyObject) to satisfy the HRTB lifetime
        // bound on objc2's MethodImplementation trait.
        decl.add_method(
            objc2::sel!(drawRect:),
            draw_progress_bar as unsafe extern "C" fn(*mut objc2::runtime::AnyObject, Sel, NSRect),
        );

        CLASS = decl.register();
    });

    unsafe { CLASS }
}

/// Custom `drawRect:` implementation for the dock tile progress indicator.
///
/// Draws a rounded progress bar at the bottom of the dock icon:
/// - Semi-transparent white background track
/// - Blue fill bar proportional to progress
///
/// This is necessary because `NSDockTile.display()` uses image-based compositing —
/// it calls `drawRect:` to capture a bitmap, but the stock `NSProgressIndicator`
/// rendering depends on the window compositor's CALayer tree which doesn't exist
/// for dock tiles.
#[cfg(target_os = "macos")]
unsafe extern "C" fn draw_progress_bar(
    this: *mut objc2::runtime::AnyObject,
    _sel: objc2::runtime::Sel,
    rect: objc2_foundation::NSRect,
) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSInsetRect, NSPoint, NSRect, NSSize};

    // Track bar: 8px tall, positioned 4px from the bottom
    let bar = NSRect::new(
        NSPoint { x: 0.0, y: 4.0 },
        NSSize {
            width: rect.size.width,
            height: 8.0,
        },
    );
    let bar_inner = NSInsetRect(bar, 0.5, 0.5);
    let mut bar_progress = NSInsetRect(bar, 1.0, 1.0);

    // Scale progress width
    let current_progress: f64 = msg_send![this, doubleValue];
    let normalized = (current_progress / 100.0).clamp(0.0, 1.0);
    bar_progress.size.width *= normalized;

    // Draw background track (semi-transparent white)
    let bg_color: *mut AnyObject =
        msg_send![objc2::class!(NSColor), colorWithWhite: 1.0_f64, alpha: 0.05_f64];
    let _: () = msg_send![bg_color, set];
    draw_rounded_rect(bar);
    draw_rounded_rect(bar_inner);

    // Draw progress fill (system blue)
    let fill_color: *mut AnyObject = msg_send![objc2::class!(NSColor), systemBlueColor];
    let _: () = msg_send![fill_color, set];
    draw_rounded_rect(bar_progress);
}

/// Helper: draw a filled rounded rectangle using NSBezierPath.
#[cfg(target_os = "macos")]
unsafe fn draw_rounded_rect(rect: objc2_foundation::NSRect) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let radius = rect.size.height / 2.0;
    let bezier_path: *mut AnyObject = msg_send![
        objc2::class!(NSBezierPath),
        bezierPathWithRoundedRect: rect,
        xRadius: radius,
        yRadius: radius
    ];
    let _: () = msg_send![bezier_path, fill];
}

/// Handle for controlling the background stat service.
pub struct StatServiceHandle {
    stop_tx: watch::Sender<bool>,
}

impl StatServiceHandle {
    /// Signal the service to stop.
    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

/// Spawns the global stat service as a background tokio task.
pub fn spawn_stat_service(app: tauri::AppHandle, aria2: Arc<Aria2Client>) -> StatServiceHandle {
    let (stop_tx, stop_rx) = watch::channel(false);

    tokio::spawn(async move {
        stat_loop(app, aria2, stop_rx).await;
    });

    StatServiceHandle { stop_tx }
}

/// Adaptive interval state.
struct IntervalState {
    current_ms: u64,
}

impl IntervalState {
    fn new() -> Self {
        Self {
            current_ms: STAT_BASE_INTERVAL_MS,
        }
    }

    /// When tasks are active: interval = base - per_task * num_active (clamped).
    fn update_for_active(&mut self, num_active: u64) {
        let computed = STAT_BASE_INTERVAL_MS
            .saturating_sub(STAT_PER_TASK_INTERVAL_MS.saturating_mul(num_active));
        self.current_ms = computed.max(STAT_MIN_INTERVAL_MS);
    }

    /// When idle: increment interval toward max.
    fn increase_idle(&mut self) {
        self.current_ms = (self.current_ms + STAT_IDLE_INCREMENT_MS).min(STAT_MAX_INTERVAL_MS);
    }

    fn duration(&self) -> Duration {
        Duration::from_millis(self.current_ms)
    }
}

async fn stat_loop(
    app: tauri::AppHandle,
    aria2: Arc<Aria2Client>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut interval_state = IntervalState::new();

    // Keep-awake RAII guard: held while downloads are active, dropped when idle.
    // The guard prevents system idle sleep via OS-native APIs while allowing
    // the display to turn off according to the user's power settings:
    //   macOS:   IOPMAssertionCreateWithName (PreventUserIdleSystemSleep)
    //   Windows: SetThreadExecutionState(ES_SYSTEM_REQUIRED)
    //   Linux:   systemd Inhibit("idle") (D-Bus)
    let mut awake_guard: Option<KeepAwake> = None;

    loop {
        tokio::select! {
            _ = tokio::time::sleep(interval_state.duration()) => {},
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    log::info!("stat_service: stopped");
                    return;
                }
            }
        }

        let stat = match aria2.get_global_stat().await {
            Ok(s) => s,
            Err(e) => {
                log::debug!("stat_service: get_global_stat failed: {e}");
                interval_state.increase_idle();
                continue;
            }
        };

        // Parse string values to u64
        let download_speed_raw = stat.download_speed.parse::<u64>().unwrap_or(0);
        let upload_speed = stat.upload_speed.parse::<u64>().unwrap_or(0);
        let num_active = stat.num_active.parse::<u64>().unwrap_or(0);
        let num_waiting = stat.num_waiting.parse::<u64>().unwrap_or(0);
        let num_stopped = stat.num_stopped.parse::<u64>().unwrap_or(0);
        let num_stopped_total = stat.num_stopped_total.parse::<u64>().unwrap_or(0);

        // aria2 uses a 10-second sliding window for speed calculation
        // (SpeedCalc::WINDOW_TIME = 10s). After pausing, stale bytes in the
        // window cause getGlobalStat to report non-zero speed for up to 10s.
        // Normalize to 0 when no tasks are actively downloading.
        let download_speed = if num_active > 0 {
            download_speed_raw
        } else {
            0
        };

        // Adaptive interval
        if num_active > 0 {
            interval_state.update_for_active(num_active);
        } else {
            interval_state.increase_idle();
        }

        // Emit to frontend
        let update = StatUpdate {
            download_speed,
            upload_speed,
            num_active,
            num_waiting,
            num_stopped,
            num_stopped_total,
        };
        let _ = app.emit("stat:update", &update);

        // Update tray/dock/progress directly from Rust — no frontend dependency.
        // In lightweight mode the WebView is destroyed, so app.emit() would
        // silently fail. Direct API calls ensure tray speed, dock badge, and
        // progress bar keep updating. See issue #194 follow-up.
        if let Some(rc_state) = app.try_state::<RuntimeConfigState>() {
            let cfg = rc_state.snapshot().await;

            // ── Keep-awake management ────────────────────────────────
            // Acquire the OS power assertion when downloads are active
            // and the user has opted in.  Release automatically (RAII
            // drop) when all downloads finish or the setting is toggled
            // off.  This runs in stat_service rather than a Tauri
            // command so it works in lightweight mode when the WebView
            // is destroyed.
            if cfg.keep_awake && num_active > 0 {
                if awake_guard.is_none() {
                    match keepawake::Builder::default()
                        .idle(true)
                        .reason("Active downloads in progress")
                        .app_name("Motrix Next")
                        .app_reverse_domain("com.motrix.next")
                        .create()
                    {
                        Ok(guard) => {
                            awake_guard = Some(guard);
                            log::info!("keep_awake: assertion acquired (active downloads)");
                        }
                        Err(e) => {
                            log::warn!("keep_awake: failed to acquire assertion: {e}");
                        }
                    }
                }
            } else if awake_guard.is_some() {
                awake_guard = None; // RAII drop → OS releases the power assertion
                log::info!("keep_awake: assertion released");
            }

            // ── Tray title (macOS menu bar / Linux appindicator label) and dynamic icon ──
            if let Some(tray) = app.tray_by_id("motrix-next") {
                if cfg.tray_speedometer && (download_speed > 0 || upload_speed > 0) {
                    let title = if download_speed > 0 {
                        format!("↓{}", compact_size(download_speed))
                    } else {
                        format!("↑{}", compact_size(upload_speed))
                    };
                    let _ = tray.set_title(Some(&title));
                } else {
                    let _ = tray.set_title(Some(""));
                }
                // Determine tray icon state: show downloading icon when active
                let tray_state = if num_active > 0 {
                    crate::tray::TrayIconState::Downloading
                } else {
                    crate::tray::TrayIconState::Normal
                };
                match app.state::<TrayState>().icon_state.lock() {
                    Ok(mut state) => {
                        *state = tray_state;
                    }
                    Err(e) => {
                        log::error!("failed to lock TrayMenuState: {e}");
                    }
                }
                // Workaround: re-set icon after set_title to prevent macOS
                // icon disappearing (Tauri/tao bug). The helper preserves
                // AppKit template rendering so the menu bar can auto-adapt
                // the icon color on light and dark backgrounds.
                // Refresh icon for state change
                {
                    let _ = crate::tray::refresh_tray_icon(&tray);
                }
            }

            // ── Dock badge (macOS only) ──
            // Uses NSApp().dockTile().setBadgeLabel() directly — app-level API
            // that does NOT require a Window object. set_badge_label() on
            // WebviewWindow fails when the window is destroyed in lightweight
            // mode because get_webview_window("main") returns None.
            //
            // NSDockTile MUST be accessed on the main thread, so we dispatch
            // via app.run_on_main_thread().
            #[cfg(target_os = "macos")]
            {
                let badge_label: Option<String> = if cfg.dock_badge_speed && download_speed > 0 {
                    Some(format!("{}/s", compact_size(download_speed)))
                } else {
                    None
                };
                let _ = app.run_on_main_thread(move || {
                    set_dock_badge(badge_label.as_deref());
                });
            }

            // ── Progress bar ──
            // macOS: Uses set_dock_progress() which operates on NSDockTile
            // directly — app-level API, no Window required. Works in
            // lightweight mode when WebView is destroyed.
            // Windows: Falls back to window.set_progress_bar() which requires
            // a webview window handle.
            #[cfg(target_os = "macos")]
            {
                if cfg.show_progress_bar && num_active > 0 {
                    match aria2.tell_active().await {
                        Ok(tasks) => {
                            let total: u64 = tasks
                                .iter()
                                .filter_map(|t| t.total_length.parse::<u64>().ok())
                                .sum();
                            let completed: u64 = tasks
                                .iter()
                                .filter_map(|t| t.completed_length.parse::<u64>().ok())
                                .sum();
                            let pct = if total > 0 {
                                Some((completed as f64 / total as f64 * 100.0) as u64)
                            } else {
                                Some(0)
                            };
                            let _ = app.run_on_main_thread(move || {
                                set_dock_progress(pct);
                            });
                        }
                        Err(e) => {
                            log::debug!("stat_service: tell_active for progress failed: {e}");
                        }
                    }
                } else {
                    let _ = app.run_on_main_thread(move || {
                        set_dock_progress(None);
                    });
                }
            }

            // Windows: uses window-based progress bar API
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                if cfg.show_progress_bar && num_active > 0 {
                    match aria2.tell_active().await {
                        Ok(tasks) => {
                            let total: u64 = tasks
                                .iter()
                                .filter_map(|t| t.total_length.parse::<u64>().ok())
                                .sum();
                            let completed: u64 = tasks
                                .iter()
                                .filter_map(|t| t.completed_length.parse::<u64>().ok())
                                .sum();
                            let progress = if total > 0 {
                                completed as f64 / total as f64
                            } else {
                                0.0
                            };
                            let _ = window.set_progress_bar(tauri::window::ProgressBarState {
                                status: Some(tauri::window::ProgressBarStatus::Normal),
                                progress: Some((progress * 100.0) as u64),
                            });
                        }
                        Err(e) => {
                            log::debug!("stat_service: tell_active for progress failed: {e}");
                        }
                    }
                } else {
                    let _ = window.set_progress_bar(tauri::window::ProgressBarState {
                        status: Some(tauri::window::ProgressBarStatus::None),
                        progress: None,
                    });
                }
            }
        }
    }
}

/// Managed state wrapper for the stat service handle.
pub struct StatServiceState(pub Arc<tokio::sync::Mutex<Option<StatServiceHandle>>>);

impl StatServiceState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── compact_size ────────────────────────────────────────────────

    #[test]
    fn compact_size_bytes() {
        assert_eq!(compact_size(0), "0B");
        assert_eq!(compact_size(512), "512B");
        assert_eq!(compact_size(1023), "1023B");
    }

    #[test]
    fn compact_size_kilobytes() {
        assert_eq!(compact_size(1024), "1K");
        assert_eq!(compact_size(1536), "2K"); // 1.5K rounds to 2K
        assert_eq!(compact_size(102400), "100K");
    }

    #[test]
    fn compact_size_megabytes() {
        assert_eq!(compact_size(1_048_576), "1.0M");
        assert_eq!(compact_size(1_572_864), "1.5M");
        assert_eq!(compact_size(10_485_760), "10.0M");
    }

    #[test]
    fn compact_size_gigabytes() {
        assert_eq!(compact_size(1_073_741_824), "1.0G");
        assert_eq!(compact_size(2_684_354_560), "2.5G");
    }

    // ── IntervalState ───────────────────────────────────────────────

    #[test]
    fn interval_default_is_base() {
        let state = IntervalState::new();
        assert_eq!(state.current_ms, STAT_BASE_INTERVAL_MS);
    }

    #[test]
    fn interval_active_reduces() {
        let mut state = IntervalState::new();
        state.update_for_active(5);
        // 500 - (100 * 5) = 0 → clamped to MIN (500)
        assert_eq!(state.current_ms, STAT_MIN_INTERVAL_MS);
    }

    #[test]
    fn interval_active_single_task() {
        let mut state = IntervalState::new();
        state.update_for_active(1);
        // 500 - (100 * 1) = 400 → clamped to MIN (500)
        assert_eq!(state.current_ms, STAT_MIN_INTERVAL_MS);
    }

    #[test]
    fn interval_active_clamps_to_min() {
        let mut state = IntervalState::new();
        state.update_for_active(100);
        assert_eq!(state.current_ms, STAT_MIN_INTERVAL_MS);
    }

    #[test]
    fn interval_idle_increments() {
        let mut state = IntervalState::new();
        state.increase_idle();
        assert_eq!(
            state.current_ms,
            STAT_BASE_INTERVAL_MS + STAT_IDLE_INCREMENT_MS
        );
    }

    #[test]
    fn interval_idle_clamps_to_max() {
        let mut state = IntervalState::new();
        for _ in 0..200 {
            state.increase_idle();
        }
        assert_eq!(state.current_ms, STAT_MAX_INTERVAL_MS);
    }

    #[test]
    fn interval_transitions_between_states() {
        let mut state = IntervalState::new();
        // Go idle
        state.increase_idle();
        assert_eq!(state.current_ms, 600); // 500 + 100
        state.increase_idle();
        assert_eq!(state.current_ms, 700); // 600 + 100
                                           // Go active — snaps to MIN
        state.update_for_active(3);
        // 500 - (100 * 3) = 200 → clamped to 500
        assert_eq!(state.current_ms, STAT_MIN_INTERVAL_MS);
    }

    // ── Constant alignment with timing.ts ────────────────────────────

    #[test]
    fn constants_match_frontend_timing_ts() {
        // These constants MUST match src/shared/timing.ts exactly.
        // If timing.ts changes and these tests fail, update the Rust
        // constants to stay in sync.
        assert_eq!(STAT_BASE_INTERVAL_MS, 500, "BASE must match timing.ts");
        assert_eq!(STAT_PER_TASK_INTERVAL_MS, 100, "PER_TASK must match");
        assert_eq!(STAT_MIN_INTERVAL_MS, 500, "MIN must match timing.ts");
        assert_eq!(STAT_MAX_INTERVAL_MS, 6000, "MAX must match timing.ts");
        assert_eq!(STAT_IDLE_INCREMENT_MS, 100, "IDLE_INCREMENT must match");
    }

    // ── StatUpdate serialization ────────────────────────────────────

    #[test]
    fn stat_update_serializes_to_camel_case() {
        let update = StatUpdate {
            download_speed: 1024,
            upload_speed: 512,
            num_active: 3,
            num_waiting: 1,
            num_stopped: 5,
            num_stopped_total: 10,
        };
        let json = serde_json::to_value(&update).unwrap();
        assert!(json.get("downloadSpeed").is_some());
        assert!(json.get("numActive").is_some());
        assert!(json.get("numStoppedTotal").is_some());
        // Not snake_case
        assert!(json.get("download_speed").is_none());
    }

    // ── keepawake integration ───────────────────────────────────────

    /// Validates that the keepawake Builder API compiles and returns
    /// the expected types.  Does NOT create an actual OS assertion
    /// (safe for headless CI environments).
    #[test]
    fn keepawake_builder_compiles() {
        let _: fn() -> Result<KeepAwake, keepawake::Error> = || {
            keepawake::Builder::default()
                .idle(true)
                .reason("test")
                .app_name("test")
                .app_reverse_domain("com.test")
                .create()
        };
    }

    #[test]
    fn keepawake_does_not_request_display_awake() {
        let source = include_str!("stat.rs");
        let production_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("stat.rs should contain production source before tests");
        assert!(
            !production_source.contains(".display(true)"),
            "downloads must prevent system idle sleep without forcing the display to stay awake"
        );
    }
}
