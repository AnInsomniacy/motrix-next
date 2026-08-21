use std::path::Path;

use url::Url;

use crate::aria2::types::{Aria2File, Aria2FileUri, Aria2HlsInfo, Aria2Task};
use crate::commands::aria2::sanitize_out_option;
use crate::hls::types::{HlsEncryptMethod, HlsJob, HlsMediaKind, HlsPhase};

fn strip_known_ext(name: &str) -> &str {
    let lower = name.to_ascii_lowercase();
    for ext in [".m3u8", ".m3u", ".mp4", ".ts"] {
        if lower.ends_with(ext) {
            return &name[..name.len() - ext.len()];
        }
    }
    name
}

/// File-stem used for HLS output names: sanitized `out`, else playlist basename, else `playlist`.
pub(crate) fn output_stem(out: &str, playlist_url: &str) -> String {
    if let Some(sanitized) = sanitize_out_option(out) {
        let stem = strip_known_ext(&sanitized);
        if !stem.is_empty() {
            return stem.to_string();
        }
    }
    if let Ok(parsed) = Url::parse(playlist_url) {
        if let Some(last) = parsed.path_segments().and_then(|mut segs| segs.next_back()) {
            if !last.is_empty() {
                if let Some(sanitized) = sanitize_out_option(last) {
                    let stem = strip_known_ext(&sanitized);
                    if !stem.is_empty() {
                        return stem.to_string();
                    }
                }
            }
        }
    }
    "playlist".into()
}

fn media_ext(kind: HlsMediaKind) -> &'static str {
    match kind {
        HlsMediaKind::Fmp4 => "mp4",
        HlsMediaKind::Mpegts => "ts",
    }
}

/// Final display / merge filename (`stem.ts` or `stem.mp4`) for an HLS job.
pub(crate) fn resolved_out(out: &str, playlist_url: &str, media_kind: HlsMediaKind) -> String {
    format!(
        "{}.{}",
        output_stem(out, playlist_url),
        media_ext(media_kind)
    )
}

fn media_kind_str(kind: HlsMediaKind) -> &'static str {
    match kind {
        HlsMediaKind::Mpegts => "mpegts",
        HlsMediaKind::Fmp4 => "fmp4",
    }
}

fn encrypt_method_str(method: HlsEncryptMethod) -> &'static str {
    match method {
        HlsEncryptMethod::None => "none",
        HlsEncryptMethod::Aes128 => "aes-128",
        HlsEncryptMethod::Aes128Ecb => "aes-128-ecb",
    }
}

fn phase_str(phase: HlsPhase) -> &'static str {
    match phase {
        HlsPhase::Download => "download",
        HlsPhase::Merge => "merge",
        HlsPhase::Remux => "remux",
    }
}

fn file_path(job: &HlsJob) -> String {
    match job.output_path.as_ref() {
        Some(path) => path.clone(),
        None => {
            let name = if job.out.is_empty() {
                resolved_out("", &job.playlist_url, job.media_kind)
            } else {
                job.out.clone()
            };
            Path::new(&job.dir)
                .join(name)
                .to_string_lossy()
                .into_owned()
        }
    }
}

/// Map an HLS job to the aria2 task DTO used by the existing task list.
pub fn job_to_aria2_task(job: &HlsJob) -> Aria2Task {
    let path = file_path(job);
    Aria2Task {
        gid: job.gid.clone(),
        status: job.status.clone(),
        total_length: job.total_length.to_string(),
        completed_length: job.completed_length.to_string(),
        upload_length: "0".into(),
        download_speed: job.download_speed.to_string(),
        upload_speed: "0".into(),
        connections: "0".into(),
        dir: job.dir.clone(),
        files: vec![Aria2File {
            index: "1".into(),
            path,
            length: job.total_length.to_string(),
            completed_length: job.completed_length.to_string(),
            selected: "true".into(),
            uris: vec![Aria2FileUri {
                uri: job.playlist_url.clone(),
                status: "used".into(),
            }],
        }],
        hls: Some(Aria2HlsInfo {
            playlist_url: job.playlist_url.clone(),
            media_kind: media_kind_str(job.media_kind).to_string(),
            segment_count: job.segment_count,
            segment_total: job.segment_total,
            encrypt_method: encrypt_method_str(job.encrypt_method).to_string(),
            phase: phase_str(job.phase).to_string(),
            output_path: job.output_path.clone(),
            fallback_ts_path: job.fallback_ts_path.clone(),
        }),
        error_message: job.error_message.clone(),
        ..Aria2Task::default()
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::job_to_aria2_task;
    use crate::hls::detect::new_hls_gid;
    use crate::hls::types::{HlsEncryptMethod, HlsJob, HlsMediaKind, HlsPhase};

    fn minimal_job() -> HlsJob {
        HlsJob {
            gid: new_hls_gid(),
            playlist_url: "https://cdn.example/vod.m3u8".into(),
            dir: "downloads".into(),
            out: "vod.ts".into(),
            ..HlsJob::default()
        }
    }

    #[test]
    fn maps_minimal_job_to_aria2_task() {
        let job = minimal_job();
        let task = job_to_aria2_task(&job);
        assert!(task.gid.starts_with("hls-"), "gid={}", task.gid);
        assert_eq!(task.total_length, "0");
        assert!(task.hls.is_some());
        assert_eq!(task.download_speed, "0");
        let json = serde_json::to_value(&task).expect("serialize task");
        assert!(
            json["downloadSpeed"].as_str().is_some(),
            "downloadSpeed must be a JSON string, got {json:?}"
        );
    }

    #[test]
    fn maps_file_path_from_dir_and_out_and_playlist_uri() {
        let job = minimal_job();
        let task = job_to_aria2_task(&job);
        let expected_path = Path::new(&job.dir).join(&job.out);
        assert_eq!(task.files[0].path, expected_path.to_string_lossy());
        assert_eq!(task.files[0].uris[0].uri, job.playlist_url);
        assert_eq!(task.dir, job.dir);
    }

    #[test]
    fn maps_playlist_stem_filename_when_out_is_empty() {
        let job = HlsJob {
            out: String::new(),
            dir: "downloads/".into(),
            playlist_url: "https://cdn.example/vod/show.m3u8?token=1".into(),
            ..minimal_job()
        };
        let task = job_to_aria2_task(&job);
        let name = Path::new(&task.files[0].path)
            .file_name()
            .and_then(|n| n.to_str());
        assert_eq!(
            name,
            Some("show.ts"),
            "empty out must not map to the download directory, got {}",
            task.files[0].path
        );
    }

    #[test]
    fn maps_fmp4_extension_when_out_is_empty() {
        let job = HlsJob {
            out: String::new(),
            media_kind: HlsMediaKind::Fmp4,
            playlist_url: "https://cdn.example/vod/index.m3u8".into(),
            ..minimal_job()
        };
        let task = job_to_aria2_task(&job);
        let name = Path::new(&task.files[0].path)
            .file_name()
            .and_then(|n| n.to_str());
        assert_eq!(name, Some("index.mp4"));
    }

    #[test]
    fn maps_file_path_from_output_path_when_set() {
        let job = HlsJob {
            output_path: Some("/videos/final.mp4".into()),
            ..minimal_job()
        };
        let task = job_to_aria2_task(&job);
        assert_eq!(task.files[0].path, "/videos/final.mp4");
    }

    #[test]
    fn maps_hls_info_and_decimal_length_fields() {
        let job = HlsJob {
            status: "active".into(),
            media_kind: HlsMediaKind::Fmp4,
            encrypt_method: HlsEncryptMethod::Aes128,
            phase: HlsPhase::Merge,
            segment_count: 3,
            segment_total: 10,
            completed_length: 128,
            total_length: 1024,
            download_speed: 512,
            output_path: Some("/videos/out.mp4".into()),
            fallback_ts_path: Some("/videos/out.ts".into()),
            error_message: Some("hls-invalid-playlist".into()),
            ..minimal_job()
        };
        let task = job_to_aria2_task(&job);
        assert_eq!(task.status, "active");
        assert_eq!(task.completed_length, "128");
        assert_eq!(task.total_length, "1024");
        assert_eq!(task.download_speed, "512");
        assert_eq!(task.upload_length, "0");
        assert_eq!(task.upload_speed, "0");
        assert_eq!(task.error_message.as_deref(), Some("hls-invalid-playlist"));
        let hls = task.hls.as_ref().expect("hls info");
        assert_eq!(hls.playlist_url, job.playlist_url);
        assert_eq!(hls.media_kind, "fmp4");
        assert_eq!(hls.segment_count, 3);
        assert_eq!(hls.segment_total, 10);
        assert_eq!(hls.encrypt_method, "aes-128");
        assert_eq!(hls.phase, "merge");
        assert_eq!(hls.output_path.as_deref(), Some("/videos/out.mp4"));
        assert_eq!(hls.fallback_ts_path.as_deref(), Some("/videos/out.ts"));
        let json = serde_json::to_value(&task).expect("serialize task");
        assert_eq!(json["hls"]["playlistUrl"], job.playlist_url);
        assert_eq!(json["hls"]["segmentCount"], 3);
        assert_eq!(json["totalLength"], "1024");
    }
}
