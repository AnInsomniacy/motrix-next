use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// HLS media container kind, serialized as the TypeScript `'mpegts' | 'fmp4'` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HlsMediaKind {
    Mpegts,
    Fmp4,
}

/// HLS encryption method, serialized as `'none' | 'aes-128' | 'aes-128-ecb'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HlsEncryptMethod {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "aes-128")]
    Aes128,
    #[serde(rename = "aes-128-ecb")]
    Aes128Ecb,
}

/// Per-segment or init encryption parameters parsed from `#EXT-X-KEY`.
///
/// `key` is filled only for inline `base64:` / `data:` URIs. HTTP key URIs are
/// stored in `key_uri` and fetched later. Default IV is not filled here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptInfo {
    pub method: HlsEncryptMethod,
    pub key: Option<Vec<u8>>,
    pub iv: Option<[u8; 16]>,
    pub key_uri: Option<String>,
}

impl Default for EncryptInfo {
    fn default() -> Self {
        Self {
            method: HlsEncryptMethod::None,
            key: None,
            iv: None,
            key_uri: None,
        }
    }
}

/// Current HLS job phase, serialized as `'download' | 'merge' | 'remux'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HlsPhase {
    Download,
    Merge,
    Remux,
}

/// HLS job status strings, matching frontend `TaskStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HlsJobStatus {
    Active,
    Waiting,
    Paused,
    Error,
    Complete,
    Removed,
}

impl HlsJobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Waiting => "waiting",
            Self::Paused => "paused",
            Self::Error => "error",
            Self::Complete => "complete",
            Self::Removed => "removed",
        }
    }
}

/// In-memory / session-persisted HLS VOD job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HlsJob {
    pub gid: String,
    pub playlist_url: String,
    pub dir: String,
    pub out: String,
    pub headers: Vec<(String, String)>,
    pub proxy: Option<String>,
    pub status: String,
    pub media_kind: HlsMediaKind,
    pub encrypt_method: HlsEncryptMethod,
    pub phase: HlsPhase,
    pub segment_count: u32,
    pub segment_total: u32,
    pub completed_length: u64,
    pub total_length: u64,
    pub download_speed: u64,
    pub error_message: Option<String>,
    pub output_path: Option<String>,
    pub fallback_ts_path: Option<String>,
    pub temp_dir: PathBuf,
    pub split: u32,
}

impl Default for HlsJob {
    fn default() -> Self {
        Self {
            gid: String::new(),
            playlist_url: String::new(),
            dir: String::new(),
            out: String::new(),
            headers: Vec::new(),
            proxy: None,
            status: "waiting".into(),
            media_kind: HlsMediaKind::Mpegts,
            encrypt_method: HlsEncryptMethod::None,
            phase: HlsPhase::Download,
            segment_count: 0,
            segment_total: 0,
            completed_length: 0,
            total_length: 0,
            download_speed: 0,
            error_message: None,
            output_path: None,
            fallback_ts_path: None,
            temp_dir: PathBuf::new(),
            split: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{HlsEncryptMethod, HlsJobStatus, HlsMediaKind, HlsPhase};

    fn json(value: impl serde::Serialize) -> String {
        serde_json::to_string(&value).expect("serialize HLS type")
    }

    #[test]
    fn media_kind_serializes_as_ts_union() {
        assert_eq!(json(HlsMediaKind::Mpegts), "\"mpegts\"");
        assert_eq!(json(HlsMediaKind::Fmp4), "\"fmp4\"");
    }

    #[test]
    fn encrypt_method_serializes_as_ts_union() {
        assert_eq!(json(HlsEncryptMethod::None), "\"none\"");
        assert_eq!(json(HlsEncryptMethod::Aes128), "\"aes-128\"");
        assert_eq!(json(HlsEncryptMethod::Aes128Ecb), "\"aes-128-ecb\"");
    }

    #[test]
    fn phase_serializes_as_ts_union() {
        assert_eq!(json(HlsPhase::Download), "\"download\"");
        assert_eq!(json(HlsPhase::Merge), "\"merge\"");
        assert_eq!(json(HlsPhase::Remux), "\"remux\"");
    }

    #[test]
    fn job_status_serializes_as_task_status_strings() {
        assert_eq!(json(HlsJobStatus::Active), "\"active\"");
        assert_eq!(json(HlsJobStatus::Waiting), "\"waiting\"");
        assert_eq!(json(HlsJobStatus::Paused), "\"paused\"");
        assert_eq!(json(HlsJobStatus::Error), "\"error\"");
        assert_eq!(json(HlsJobStatus::Complete), "\"complete\"");
        assert_eq!(json(HlsJobStatus::Removed), "\"removed\"");
        assert_eq!(HlsJobStatus::Active.as_str(), "active");
        assert_eq!(HlsJobStatus::Waiting.as_str(), "waiting");
    }
}
