use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// ffmpeg availability for settings UI and remux decisions.
///
/// `kind` is one of `configured`, `path`, or `missing`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfmpegStatus {
    pub kind: &'static str,
    pub path: Option<String>,
    pub version: Option<String>,
}

impl FfmpegStatus {
    /// Classify ffmpeg from a configured path without spawning the binary.
    ///
    /// Version is left empty in this task; Task 10 may fill it via `-version`.
    pub fn probe(configured: &str) -> Self {
        let trimmed = configured.trim();
        match resolve_ffmpeg_path(configured) {
            Some(path) => Self {
                kind: if trimmed.is_empty() {
                    "path"
                } else {
                    "configured"
                },
                path: Some(path.to_string_lossy().into_owned()),
                version: None,
            },
            None => Self {
                kind: "missing",
                path: None,
                version: None,
            },
        }
    }
}

fn ffmpeg_exe_name() -> &'static str {
    if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn find_ffmpeg_on_path() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var).find_map(|dir| {
        let candidate = dir.join(ffmpeg_exe_name());
        candidate.is_file().then_some(candidate)
    })
}

/// Resolve ffmpeg: a non-empty configured path if it exists, else PATH search.
pub fn resolve_ffmpeg_path(configured: &str) -> Option<PathBuf> {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        let path = PathBuf::from(trimmed);
        return path.exists().then_some(path);
    }
    find_ffmpeg_on_path()
}

/// Exact remux argv for MPEG-TS → MP4 copy (no spawn).
pub fn build_ts_remux_args(input_concat: &str, output: &Path) -> Vec<OsString> {
    vec![
        OsString::from("-loglevel"),
        OsString::from("warning"),
        OsString::from("-nostdin"),
        OsString::from("-i"),
        OsString::from(format!("concat:{input_concat}")),
        OsString::from("-map"),
        OsString::from("0:v?"),
        OsString::from("-map"),
        OsString::from("0:a?"),
        OsString::from("-c"),
        OsString::from("copy"),
        OsString::from("-bsf:a"),
        OsString::from("aac_adtstoasc"),
        OsString::from("-y"),
        output.as_os_str().to_os_string(),
    ]
}

/// Join **file names only** with `|` for ffmpeg concat protocol.
pub fn build_concat_protocol_list(files: &[PathBuf]) -> String {
    files
        .iter()
        .filter_map(|path| path.file_name())
        .map(|name| name.to_string_lossy())
        .collect::<Vec<_>>()
        .join("|")
}

/// Hidden-console flag for Task 10 `run_remux` (`CreateProcess` dwCreationFlags).
#[cfg(windows)]
#[allow(dead_code)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(test)]
mod tests {
    use super::{
        build_concat_protocol_list, build_ts_remux_args, resolve_ffmpeg_path, FfmpegStatus,
    };
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    #[test]
    fn remux_args_match_spec() {
        let output = Path::new("out.mp4");
        let args = build_ts_remux_args("a.ts|b.ts", output);
        let expected: Vec<OsString> = [
            "-loglevel",
            "warning",
            "-nostdin",
            "-i",
            "concat:a.ts|b.ts",
            "-map",
            "0:v?",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            "-y",
            "out.mp4",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn concat_list_uses_file_names_only() {
        let files = vec![
            PathBuf::from("/tmp/seg/file1.ts"),
            PathBuf::from("/tmp/seg/file2.ts"),
        ];
        assert_eq!(build_concat_protocol_list(&files), "file1.ts|file2.ts");
    }

    #[test]
    fn concat_list_windows_paths_use_file_names() {
        let files = vec![
            PathBuf::from(r"C:\downloads\hls\seg-000.ts"),
            PathBuf::from(r"C:\downloads\hls\seg-001.ts"),
        ];
        assert_eq!(build_concat_protocol_list(&files), "seg-000.ts|seg-001.ts");
    }

    #[test]
    fn concat_list_empty_is_empty_string() {
        assert_eq!(build_concat_protocol_list(&[]), "");
    }

    #[test]
    fn resolve_configured_existing_file_returns_some() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ffmpeg-stub");
        std::fs::write(&path, b"").expect("write stub");
        let configured = path.to_str().expect("utf8 tempfile path");
        let resolved = resolve_ffmpeg_path(configured);
        assert_eq!(resolved.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn resolve_configured_missing_path_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("no-such-ffmpeg");
        assert!(!missing.exists());
        let configured = missing.to_str().expect("utf8 tempfile path");
        assert_eq!(resolve_ffmpeg_path(configured), None);
    }

    #[test]
    fn resolve_trims_configured_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ffmpeg-stub");
        std::fs::write(&path, b"").expect("write stub");
        let padded = format!("  {}  ", path.display());
        let resolved = resolve_ffmpeg_path(&padded);
        assert_eq!(resolved.as_deref(), Some(path.as_path()));
    }

    #[test]
    fn status_configured_when_path_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("ffmpeg-stub");
        std::fs::write(&path, b"").expect("write stub");
        let configured = path.to_str().expect("utf8 tempfile path");
        let status = FfmpegStatus::probe(configured);
        assert_eq!(status.kind, "configured");
        assert_eq!(status.path.as_deref(), Some(configured));
        assert_eq!(status.version, None);
    }

    #[test]
    fn status_missing_when_configured_path_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("no-such-ffmpeg");
        let configured = missing.to_str().expect("utf8 tempfile path");
        let status = FfmpegStatus::probe(configured);
        assert_eq!(status.kind, "missing");
        assert!(status.path.is_none());
        assert_eq!(status.version, None);
    }

    #[test]
    fn status_empty_configured_is_path_or_missing() {
        let status = FfmpegStatus::probe("   ");
        assert!(
            status.kind == "path" || status.kind == "missing",
            "empty config must search PATH, got kind={}",
            status.kind
        );
        if status.kind == "path" {
            assert!(status.path.is_some());
        } else {
            assert!(status.path.is_none());
        }
        assert_eq!(status.version, None);
    }
}
