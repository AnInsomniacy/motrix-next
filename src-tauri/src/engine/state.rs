use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

/// Converts a [`Path`] to a string safe for passing to external processes.
///
/// On Windows, Tauri's `path().resolve()` and `app_data_dir()` return
/// extended-length paths prefixed with `\\?\` (see [tauri-apps/tauri#5850]).
/// External processes like aria2c (MinGW-compiled) cannot parse this prefix —
/// their `_wstat()` / file-open calls fail, causing immediate exit.
///
/// Uses [`dunce::simplified`] — the Rust ecosystem's standard solution
/// (50M+ downloads) — to strip the `\\?\` prefix when the path can be
/// safely expressed in legacy Win32 format.  On non-Windows platforms
/// this is a zero-cost no-op.
///
/// [tauri-apps/tauri#5850]: https://github.com/tauri-apps/tauri/issues/5850
/// [`dunce::simplified`]: https://docs.rs/dunce/latest/dunce/fn.simplified.html
pub(crate) fn path_to_safe_string(path: &std::path::Path) -> String {
    dunce::simplified(path).to_string_lossy().to_string()
}

/// Strips ANSI escape sequences (color codes) from a string.
/// Aria2 Next emits colored output (e.g., `\x1b[1;31mERROR\x1b[0m`) which
/// produces garbage in log files.
pub(crate) fn strip_ansi(input: &str) -> String {
    strip_ansi_escapes::strip_str(input)
}

const STDERR_TAIL_LINES: usize = 24;

/// Low-level process state owned by the engine supervisor.
pub struct EngineState {
    pub(crate) child: Mutex<Option<CommandChild>>,
    stderr_tail: Mutex<VecDeque<String>>,
    gen: AtomicU32,
}

impl EngineState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            stderr_tail: Mutex::new(VecDeque::with_capacity(STDERR_TAIL_LINES)),
            gen: AtomicU32::new(0),
        }
    }

    /// Returns the current generation value (used by tests).
    #[cfg(test)]
    pub fn generation(&self) -> u32 {
        self.gen.load(Ordering::SeqCst)
    }

    /// Atomically increments the generation counter and returns the new value.
    pub fn next_generation(&self) -> u32 {
        self.gen.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Returns `true` if `gen` matches the current generation.
    pub fn is_current_generation(&self, gen: u32) -> bool {
        self.gen.load(Ordering::SeqCst) == gen
    }

    pub fn invalidate_generation(&self) {
        self.next_generation();
    }

    pub fn is_running(&self) -> bool {
        self.child.lock().is_ok_and(|child| child.is_some())
    }

    pub fn push_stderr(&self, line: String) {
        if let Ok(mut tail) = self.stderr_tail.lock() {
            if tail.len() == STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    }

    pub fn clear_stderr(&self) {
        if let Ok(mut tail) = self.stderr_tail.lock() {
            tail.clear();
        }
    }

    pub fn stderr_tail(&self) -> Vec<String> {
        self.stderr_tail
            .lock()
            .map(|tail| tail.iter().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── strip_ansi tests ────────────────────────────────────────────────

    #[test]
    fn strip_ansi_removes_color_codes() {
        let input = "\x1b[1;31mERROR\x1b[0m Something went wrong";
        assert_eq!(strip_ansi(input), "ERROR Something went wrong");
    }

    #[test]
    fn strip_ansi_preserves_plain_text() {
        let input = "normal text";
        assert_eq!(strip_ansi(input), "normal text");
    }

    #[test]
    fn strip_ansi_handles_colored_level_tag() {
        let input =
            "2026-05-29 00:56:16.123 [\x1b[32minfo\x1b[0m] [RpcBeastServer.cc:241] IPv4 RPC: listening on TCP port 29100";
        let clean = strip_ansi(input);
        assert!(clean.contains("[info]"));
        assert!(!clean.contains("\x1b"));
    }

    #[test]
    fn strip_ansi_handles_error_tag() {
        let input = "2026-05-29 00:23:41.123 [\x1b[31merror\x1b[0m] [Uri.cc:10] Unrecognized URI";
        let clean = strip_ansi(input);
        assert!(clean.contains("[error]"));
        assert!(!clean.contains("\x1b"));
    }

    #[test]
    fn strip_ansi_empty_string() {
        assert_eq!(strip_ansi(""), "");
    }

    #[test]
    fn strip_ansi_multiple_sequences_in_one_line() {
        let input = "2026-05-29 01:00:00.000 [\x1b[32minfo\x1b[0m] [main.cc:1] downloading \x1b[1mfile.zip\x1b[0m";
        let clean = strip_ansi(input);
        assert_eq!(
            clean,
            "2026-05-29 01:00:00.000 [info] [main.cc:1] downloading file.zip"
        );
        assert!(!clean.contains('\x1b'));
    }

    #[test]
    fn strip_ansi_removes_osc_sequences() {
        let input = "title\x1b]0;aria2-next\x07 [info]";
        let clean = strip_ansi(input);
        assert_eq!(clean, "title [info]");
        assert!(!clean.contains('\x1b'));
    }

    #[test]
    fn strip_ansi_partial_escape_at_eof() {
        // Unterminated escape sequence: ESC [ but no closing alpha char
        let input = "trailing\x1b[";
        let clean = strip_ansi(input);
        assert_eq!(clean, "trailing");
    }

    // ── Generation counter tests ────────────────────────────────────────

    #[test]
    fn engine_state_starts_at_generation_zero() {
        let state = EngineState::new();
        assert_eq!(state.generation(), 0);
    }

    #[test]
    fn next_generation_increments_monotonically() {
        let state = EngineState::new();
        assert_eq!(state.next_generation(), 1);
        assert_eq!(state.next_generation(), 2);
        assert_eq!(state.next_generation(), 3);
        assert_eq!(state.generation(), 3);
    }

    #[test]
    fn is_current_generation_true_for_matching() {
        let state = EngineState::new();
        let gen = state.next_generation();
        assert!(state.is_current_generation(gen));
    }

    #[test]
    fn is_current_generation_false_for_stale() {
        let state = EngineState::new();
        let old_gen = state.next_generation();
        let _new_gen = state.next_generation();
        // Old generation must NOT match current
        assert!(!state.is_current_generation(old_gen));
    }

    #[test]
    fn is_current_generation_false_for_zero() {
        let state = EngineState::new();
        let _gen = state.next_generation();
        // Generation 0 (initial) is never "current" after any increment
        assert!(!state.is_current_generation(0));
    }

    #[test]
    fn stderr_tail_is_bounded() {
        let state = EngineState::new();
        for index in 0..40 {
            state.push_stderr(format!("line-{index}"));
        }
        let tail = state.stderr_tail();
        assert_eq!(tail.len(), STDERR_TAIL_LINES);
        assert_eq!(tail.first().map(String::as_str), Some("line-16"));
        assert_eq!(tail.last().map(String::as_str), Some("line-39"));
    }

    // ── path_to_safe_string tests ───────────────────────────────────────
    //
    // These tests verify that paths produced by Tauri's path() API are
    // normalized to a format that external processes (aria2c) can consume.
    // On Windows, Tauri returns \\?\ prefixed extended-length paths that
    // MinGW-compiled aria2c cannot parse (tauri-apps/tauri#5850).

    #[test]
    fn safe_string_strips_extended_length_prefix() {
        let p = std::path::Path::new(
            r"\\?\C:\Users\test\AppData\Local\com.motrix.next\engine\aria2.conf",
        );
        let result = path_to_safe_string(p);
        // On Windows: \\?\ prefix must be stripped for aria2c compatibility.
        // On non-Windows: \\?\ has no special meaning — dunce is a no-op.
        #[cfg(target_os = "windows")]
        assert!(
            !result.starts_with(r"\\?\"),
            "expected no \\\\?\\ prefix, got: {result}"
        );
        #[cfg(not(target_os = "windows"))]
        assert!(!result.is_empty(), "must not crash on non-Windows");
    }

    #[test]
    fn safe_string_produces_correct_windows_path_after_strip() {
        let p = std::path::Path::new(r"\\?\C:\Users\test\AppData\Local\download.session");
        let result = path_to_safe_string(p);
        // After stripping, the result must be a valid legacy Windows path
        #[cfg(target_os = "windows")]
        assert_eq!(result, r"C:\Users\test\AppData\Local\download.session");
        #[cfg(not(target_os = "windows"))]
        {
            // On non-Windows, dunce::simplified is a no-op on the Path as
            // constructed — it just returns the string representation.
            // The key invariant is that it does NOT crash.
            assert!(!result.is_empty());
        }
    }

    #[test]
    fn safe_string_preserves_normal_windows_path() {
        let p =
            std::path::Path::new(r"C:\Users\test\AppData\Local\com.motrix.next\engine\aria2.conf");
        let result = path_to_safe_string(p);
        assert_eq!(result, p.to_string_lossy().to_string());
    }

    #[test]
    fn safe_string_preserves_unix_path() {
        let p = std::path::Path::new("/home/test/.local/share/com.motrix.next/engine/aria2.conf");
        let result = path_to_safe_string(p);
        assert_eq!(
            result,
            "/home/test/.local/share/com.motrix.next/engine/aria2.conf"
        );
    }

    #[test]
    fn safe_string_handles_empty_path() {
        let p = std::path::Path::new("");
        let result = path_to_safe_string(p);
        assert_eq!(result, "");
    }

    #[test]
    fn safe_string_preserves_unc_network_path() {
        // UNC network paths (\\server\share) must NOT be mangled
        let p = std::path::Path::new(r"\\server\share\dir\file.conf");
        let result = path_to_safe_string(p);
        assert_eq!(result, p.to_string_lossy().to_string());
    }

    #[test]
    fn safe_string_handles_path_with_spaces() {
        let p = std::path::Path::new(r"\\?\C:\Program Files (x86)\My App\config.conf");
        let result = path_to_safe_string(p);
        #[cfg(target_os = "windows")]
        assert!(
            !result.starts_with(r"\\?\"),
            "prefix should be stripped even with spaces: {result}"
        );
        #[cfg(not(target_os = "windows"))]
        assert!(!result.is_empty(), "must not crash on non-Windows");
    }

    #[test]
    fn safe_string_handles_deeply_nested_path() {
        let p = std::path::Path::new(
            r"\\?\D:\a\very\deeply\nested\directory\structure\that\goes\on\aria2.conf",
        );
        let result = path_to_safe_string(p);
        #[cfg(target_os = "windows")]
        assert!(
            !result.starts_with(r"\\?\"),
            "deeply nested path should still strip prefix: {result}"
        );
        #[cfg(not(target_os = "windows"))]
        assert!(!result.is_empty(), "must not crash on non-Windows");
    }
}
