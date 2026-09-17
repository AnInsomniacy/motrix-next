//! Media wire types and the single native representation boundary.
use super::error::Error;
use crate::aria2::types::Aria2Task;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;
use uuid::Uuid;

pub const LEASE_MS: i64 = 300_000;
pub const RECEIPT_MS: i64 = 86_400_000;
pub const HISTORY_OPTIONS: &[&str] = &[
    "media",
    "media-format",
    "media-video",
    "media-audio",
    "media-subtitles",
    "media-record-time",
    "media-pause-after-probe",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Hls,
    Dash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Mp4,
    Mkv,
}
impl Format {
    pub fn parse(value: &str) -> Result<Self, Error> {
        match value {
            "mp4" => Ok(Self::Mp4),
            "mkv" => Ok(Self::Mkv),
            _ => Err(Error::UnsupportedSelection),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeRequest {
    pub id: Uuid,
    pub source: Source,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub url: String,
    pub kind: SourceKind,
    pub page_url: String,
    pub title: String,
    pub filename: String,
    pub mime: String,
    pub request_contexts: Vec<RequestContext>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestContext {
    pub url: String,
    pub headers: Vec<RequestHeader>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestHeader {
    pub name: String,
    pub value: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub video_id: Option<String>,
    pub audio_id: Option<String>,
    pub subtitle_id: Option<String>,
    pub format: Format,
    pub record_time_seconds: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitRequest {
    pub submission_id: Uuid,
    pub selection: Selection,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Track {
    pub id: String,
    pub r#type: String,
    pub language: String,
    pub codec: String,
    pub width: u64,
    pub height: u64,
    pub bandwidth: u64,
    pub frame_rate: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Presentation {
    pub kind: SourceKind,
    pub title: String,
    pub live: bool,
    pub duration_ms: Option<u64>,
    pub size: Option<u64>,
    pub tracks: Vec<Track>,
    pub formats: Vec<Format>,
    pub defaults: Selection,
}

fn http_url(value: &str) -> Result<Url, Error> {
    if value.len() > 16_384 {
        return Err(Error::UnsupportedSource);
    }
    let url = Url::parse(value).map_err(|_| Error::UnsupportedSource)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::UnsupportedSource);
    }
    Ok(url)
}

impl Source {
    pub fn filename_hint(&self) -> &str {
        if self.title.trim().is_empty() {
            &self.filename
        } else {
            self.title.trim()
        }
    }

    pub fn validate(&self) -> Result<(), Error> {
        http_url(&self.url)?;
        http_url(&self.page_url)?;
        if self.title.encode_utf16().count() > 512
            || self.filename.encode_utf16().count() > 255
            || self.mime.len() > 128
            || self.request_contexts.len() > 8
        {
            return Err(Error::UnsupportedSource);
        }
        let mut origins = std::collections::HashSet::new();
        for context in &self.request_contexts {
            let origin = http_url(&context.url)?.origin().ascii_serialization();
            if !origins.insert(origin) || context.headers.len() > 32 {
                return Err(Error::UnsupportedSource);
            }
            let mut names = std::collections::HashSet::new();
            let mut bytes = 0;
            for field in &context.headers {
                bytes += field.name.len() + field.value.len();
                let name = field.name.to_ascii_lowercase();
                if bytes > 16_384
                    || name.len() > 128
                    || field.value.len() > 8192
                    || !names.insert(name.clone())
                    || axum::http::HeaderName::from_bytes(name.as_bytes()).is_err()
                    || axum::http::HeaderValue::from_str(&field.value).is_err()
                    || name.starts_with("proxy-")
                    || name.starts_with("if-")
                    || matches!(
                        name.as_str(),
                        "host"
                            | "connection"
                            | "content-length"
                            | "transfer-encoding"
                            | "range"
                            | "accept-encoding"
                            | "keep-alive"
                            | "if-range"
                            | "if-match"
                            | "if-none-match"
                            | "if-modified-since"
                            | "if-unmodified-since"
                            | "proxy-authorization"
                            | "proxy-connection"
                            | "upgrade"
                            | "te"
                            | "trailer"
                    )
                {
                    return Err(Error::UnsupportedSource);
                }
            }
        }
        Ok(())
    }
}

fn number(value: &str) -> Result<u64, Error> {
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or(Error::ProbeFailed)
}

fn frame_rate(value: &str) -> Result<f64, Error> {
    value
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && (0.0..=1000.0).contains(n))
        .ok_or(Error::ProbeFailed)
}

impl Presentation {
    pub fn from_task(task: &Aria2Task, format: Format) -> Result<Self, Error> {
        let title = task
            .files
            .first()
            .and_then(|f| f.path.rsplit(['/', '\\']).next())
            .unwrap_or("Media")
            .to_string();
        let media = task.media.as_ref().ok_or(Error::UnsupportedSource)?;
        if !matches!(media.protocol.as_str(), "hls" | "dash") || media.tracks.len() > 256 {
            return Err(Error::UnsupportedSource);
        }
        let mut ids = std::collections::HashSet::new();
        if media.tracks.iter().any(|track| {
            !ids.insert(&track.id)
                || track.id.is_empty()
                || track.id.len() > 128
                || !matches!(
                    track.r#type.as_str(),
                    "video" | "audio" | "muxed" | "subtitle"
                )
        }) {
            return Err(Error::ProbeFailed);
        }
        let live = match media.live.as_str() {
            "true" => true,
            "false" => false,
            _ => return Err(Error::ProbeFailed),
        };
        let duration = number(&media.duration)?;
        let selected = |kind: &str| {
            media
                .tracks
                .iter()
                .find(|t| t.r#type == kind && t.selected == "true")
                .map(|t| t.id.clone())
        };
        let muxed = selected("muxed");
        let value = Self {
            kind: match media.protocol.as_str() {
                "hls" => SourceKind::Hls,
                "dash" => SourceKind::Dash,
                _ => return Err(Error::UnsupportedSource),
            },
            title,
            live,
            duration_ms: (duration > 0).then_some(duration),
            size: None,
            tracks: media
                .tracks
                .iter()
                .map(|t| {
                    Ok(Track {
                        id: t.id.clone(),
                        r#type: t.r#type.clone(),
                        language: t.language.clone(),
                        codec: t.codec.clone(),
                        width: number(&t.width)?,
                        height: number(&t.height)?,
                        bandwidth: number(&t.bandwidth)?,
                        frame_rate: frame_rate(&t.frame_rate)?,
                    })
                })
                .collect::<Result<_, Error>>()?,
            formats: vec![Format::Mp4, Format::Mkv],
            defaults: Selection {
                video_id: selected("video").or(muxed.clone()),
                audio_id: selected("audio").or(muxed),
                subtitle_id: selected("subtitle"),
                format,
                record_time_seconds: 0,
            },
        };
        value.validate_selection(&value.defaults)?;
        Ok(value)
    }

    pub fn validate_selection(&self, value: &Selection) -> Result<(), Error> {
        let invalid = || Err(Error::UnsupportedSelection);
        if !self.formats.contains(&value.format)
            || value.record_time_seconds > 31_536_000
            || (!self.live && value.record_time_seconds != 0)
        {
            return invalid();
        }
        if value.video_id.is_none() && value.audio_id.is_none() {
            return invalid();
        }
        for (id, kinds) in [
            (&value.video_id, &["video", "muxed"][..]),
            (&value.audio_id, &["audio", "muxed"][..]),
            (&value.subtitle_id, &["subtitle"][..]),
        ] {
            if let Some(id) = id {
                if !self
                    .tracks
                    .iter()
                    .any(|t| t.id == *id && kinds.contains(&t.r#type.as_str()))
                {
                    return invalid();
                }
            }
        }
        if let (Some(v), Some(a)) = (&value.video_id, &value.audio_id) {
            if v != a
                && self
                    .tracks
                    .iter()
                    .any(|t| (t.id == *v || t.id == *a) && t.r#type == "muxed")
            {
                return invalid();
            }
        }
        Ok(())
    }
}

impl Selection {
    pub fn options(&self) -> Value {
        json!({"media-format":self.format, "media-video":self.video_id.as_deref().unwrap_or("none"),
            "media-audio":self.audio_id.as_deref().unwrap_or("none"), "media-subtitles":self.subtitle_id.as_deref().unwrap_or("none"),
            "media-record-time":self.record_time_seconds.to_string(), "media-pause-after-probe":"false"})
    }
}
