use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::error::AppError;
use crate::hls::types::HlsJob;

fn is_restorable(status: &str) -> bool {
    matches!(status, "paused" | "waiting" | "active")
}

/// Persist HLS jobs to a JSON session file.
pub fn save(path: impl AsRef<Path>, jobs: &[HlsJob]) -> Result<(), AppError> {
    let json = serde_json::to_vec_pretty(jobs).map_err(|err| AppError::Hls(err.to_string()))?;
    fs::write(path, json)?;
    Ok(())
}

/// Load HLS jobs from a JSON session file.
///
/// Terminal statuses (`complete`, `error`, `removed`) are dropped.
/// `active` / `waiting` / `paused` are restored as stored.
pub fn load(path: impl AsRef<Path>) -> Result<Vec<HlsJob>, AppError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let jobs: Vec<HlsJob> =
        serde_json::from_slice(&bytes).map_err(|err| AppError::Hls(err.to_string()))?;
    Ok(jobs
        .into_iter()
        .filter(|job| is_restorable(&job.status))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{load, save};
    use crate::hls::detect::new_hls_gid;
    use crate::hls::types::HlsJob;

    fn job_with(status: &str, playlist_url: &str) -> HlsJob {
        HlsJob {
            gid: new_hls_gid(),
            playlist_url: playlist_url.into(),
            dir: "downloads".into(),
            out: "vod.ts".into(),
            status: status.into(),
            temp_dir: std::path::PathBuf::from("hls-temp"),
            ..HlsJob::default()
        }
    }

    #[test]
    fn roundtrip_preserves_playlist_url() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("hls-session.json");
        let jobs = vec![job_with(
            "waiting",
            "https://cdn.example/session-roundtrip.m3u8",
        )];
        save(&path, &jobs).expect("save");
        let loaded = load(&path).expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(
            loaded[0].playlist_url,
            "https://cdn.example/session-roundtrip.m3u8"
        );
    }

    #[test]
    fn load_restores_active_and_drops_complete() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("hls-session.json");
        let jobs = vec![
            job_with("active", "https://cdn.example/active.m3u8"),
            job_with("complete", "https://cdn.example/complete.m3u8"),
            job_with("error", "https://cdn.example/error.m3u8"),
            job_with("removed", "https://cdn.example/removed.m3u8"),
            job_with("paused", "https://cdn.example/paused.m3u8"),
            job_with("waiting", "https://cdn.example/waiting.m3u8"),
        ];
        save(&path, &jobs).expect("save");
        let loaded = load(&path).expect("load");
        let statuses: Vec<&str> = loaded.iter().map(|job| job.status.as_str()).collect();
        assert_eq!(statuses, vec!["active", "paused", "waiting"]);
        assert_eq!(loaded[0].playlist_url, "https://cdn.example/active.m3u8");
        assert!(!loaded
            .iter()
            .any(|job| { matches!(job.status.as_str(), "complete" | "error" | "removed") }));
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("missing-hls-session.json");
        let loaded = load(&path).expect("missing session is empty");
        assert!(loaded.is_empty());
    }
}
