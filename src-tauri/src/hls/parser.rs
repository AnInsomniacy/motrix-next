use url::Url;

use crate::error::AppError;

use super::key::parse_key_line;
use super::types::EncryptInfo;

const LIVE_NOT_SUPPORTED: &str = "live-not-supported";
const INVALID_PLAYLIST: &str = "invalid-playlist";

#[derive(Debug, Clone, PartialEq)]
pub struct MediaSegment {
    pub index: i64,
    pub duration: f64,
    pub url: String,
    pub start_range: Option<u64>,
    pub expect_length: Option<u64>,
    pub encrypt: EncryptInfo,
    pub init_index: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InitSegment {
    pub index: u32,
    pub url: String,
    pub start_range: Option<u64>,
    pub expect_length: Option<u64>,
    pub encrypt: EncryptInfo,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMedia {
    pub is_vod: bool,
    pub media_sequence: i64,
    pub segments: Vec<MediaSegment>,
    pub init: Option<InitSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantStream {
    pub url: String,
    pub bandwidth: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedPlaylist {
    Master { variants: Vec<VariantStream> },
    Media(ParsedMedia),
}

#[derive(Default)]
struct PendingSegment {
    duration: Option<f64>,
    index: Option<i64>,
    start_range: Option<u64>,
    expect_length: Option<u64>,
}

pub fn parse_playlist(text: &str, playlist_url: &str) -> Result<ParsedPlaylist, AppError> {
    let text = strip_bom_and_leading_ws(text);
    if !text.starts_with("#EXTM3U") {
        return Err(hls_err(INVALID_PLAYLIST));
    }
    if is_master_playlist(text) {
        parse_master(text, playlist_url)
    } else {
        parse_media(text, playlist_url)
    }
}

pub fn select_best_variant(variants: &[VariantStream]) -> Option<&VariantStream> {
    variants.iter().max_by_key(|variant| variant.bandwidth)
}

pub fn combine_url(base: &str, rel: &str) -> Result<String, AppError> {
    let base_url = Url::parse(base).map_err(|_| hls_err(INVALID_PLAYLIST))?;
    let joined = base_url.join(rel).map_err(|_| hls_err(INVALID_PLAYLIST))?;
    Ok(joined.to_string())
}

fn hls_err(code: &str) -> AppError {
    AppError::Hls(code.into())
}

fn strip_bom_and_leading_ws(text: &str) -> &str {
    text.trim_start_matches(|c: char| c == '\u{feff}' || c.is_whitespace())
}

fn is_tag(line: &str, tag: &str) -> bool {
    let Some(rest) = line.strip_prefix(tag) else {
        return false;
    };
    rest.is_empty() || rest.starts_with(':') || rest.starts_with(char::is_whitespace)
}

fn is_master_playlist(text: &str) -> bool {
    text.lines()
        .any(|line| is_tag(line.trim(), "#EXT-X-STREAM-INF"))
}

fn parse_master(text: &str, playlist_url: &str) -> Result<ParsedPlaylist, AppError> {
    let mut variants = Vec::new();
    let mut pending_bandwidth: Option<u64> = None;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if is_tag(line, "#EXT-X-STREAM-INF") {
            pending_bandwidth = Some(parse_variant_bandwidth(&parse_attributes(line))?);
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        if let Some(bandwidth) = pending_bandwidth.take() {
            variants.push(VariantStream {
                url: combine_url(playlist_url, line)?,
                bandwidth,
            });
        }
    }

    Ok(ParsedPlaylist::Master { variants })
}

fn parse_media(text: &str, playlist_url: &str) -> Result<ParsedPlaylist, AppError> {
    let mut media_sequence: i64 = 0;
    let mut next_index: i64 = 0;
    let mut has_endlist = false;
    let mut current_encrypt = EncryptInfo::default();
    let mut init: Option<InitSegment> = None;
    let mut segments: Vec<MediaSegment> = Vec::new();
    let mut pending = PendingSegment::default();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if is_tag(line, "#EXT-X-MEDIA-SEQUENCE") {
            media_sequence = parse_i64(colon_value(line))?;
            if segments.is_empty() && pending.index.is_none() {
                next_index = media_sequence;
            }
            continue;
        }
        if is_tag(line, "#EXT-X-KEY") {
            current_encrypt = parse_key_line(line, playlist_url)?;
            continue;
        }
        if is_tag(line, "#EXT-X-MAP") {
            if init.is_none() {
                init = Some(parse_map_line(line, playlist_url, &current_encrypt)?);
            }
            continue;
        }
        if is_tag(line, "#EXT-X-BYTERANGE") {
            let (length, offset) = parse_byterange(colon_value(line))?;
            pending.expect_length = Some(length);
            pending.start_range = Some(resolve_start_range(offset, &segments));
            continue;
        }
        if is_tag(line, "#EXTINF") {
            pending.duration = Some(parse_extinf_duration(line)?);
            pending.index = Some(next_index);
            next_index += 1;
            continue;
        }
        if is_tag(line, "#EXT-X-ENDLIST") {
            has_endlist = true;
            continue;
        }
        if is_tag(line, "#EXT-X-DISCONTINUITY") {
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        let Some(duration) = pending.duration else {
            return Err(hls_err(INVALID_PLAYLIST));
        };
        let Some(index) = pending.index else {
            return Err(hls_err(INVALID_PLAYLIST));
        };
        segments.push(MediaSegment {
            index,
            duration,
            url: combine_url(playlist_url, line)?,
            start_range: pending.start_range,
            expect_length: pending.expect_length,
            encrypt: current_encrypt.clone(),
            init_index: init.as_ref().map(|segment| segment.index),
        });
        pending = PendingSegment::default();
    }

    if !has_endlist {
        return Err(hls_err(LIVE_NOT_SUPPORTED));
    }

    Ok(ParsedPlaylist::Media(ParsedMedia {
        is_vod: true,
        media_sequence,
        segments,
        init,
    }))
}

fn parse_variant_bandwidth(attrs: &[(String, String)]) -> Result<u64, AppError> {
    if let Some(raw) = attr(attrs, "BANDWIDTH") {
        return parse_u64(raw);
    }
    if let Some(raw) = attr(attrs, "AVERAGE-BANDWIDTH") {
        return parse_u64(raw);
    }
    Ok(0)
}

fn parse_map_line(
    line: &str,
    playlist_url: &str,
    encrypt: &EncryptInfo,
) -> Result<InitSegment, AppError> {
    let attrs = parse_attributes(line);
    let uri = attr(&attrs, "URI").ok_or_else(|| hls_err(INVALID_PLAYLIST))?;
    let (start_range, expect_length) = match attr(&attrs, "BYTERANGE") {
        Some(spec) => {
            let (length, offset) = parse_byterange(spec)?;
            (Some(offset.unwrap_or(0)), Some(length))
        }
        None => (None, None),
    };
    Ok(InitSegment {
        index: 0,
        url: combine_url(playlist_url, uri)?,
        start_range,
        expect_length,
        encrypt: encrypt.clone(),
    })
}

fn parse_byterange(spec: &str) -> Result<(u64, Option<u64>), AppError> {
    let spec = spec.trim();
    if let Some((length_raw, offset_raw)) = spec.split_once('@') {
        Ok((parse_u64(length_raw)?, Some(parse_u64(offset_raw)?)))
    } else {
        Ok((parse_u64(spec)?, None))
    }
}

fn resolve_start_range(explicit: Option<u64>, segments: &[MediaSegment]) -> u64 {
    if let Some(offset) = explicit {
        return offset;
    }
    match segments.last() {
        Some(prev) => match (prev.start_range, prev.expect_length) {
            (Some(start), Some(len)) => start.saturating_add(len),
            _ => 0,
        },
        None => 0,
    }
}

fn parse_extinf_duration(line: &str) -> Result<f64, AppError> {
    let value = colon_value(line);
    let duration_str = match value.split_once(',') {
        Some((duration, _)) => duration.trim(),
        None => value.trim(),
    };
    duration_str
        .parse::<f64>()
        .map_err(|_| hls_err(INVALID_PLAYLIST))
}

fn colon_value(line: &str) -> &str {
    line.split_once(':')
        .map(|(_, value)| value.trim())
        .unwrap_or("")
}

fn parse_u64(raw: &str) -> Result<u64, AppError> {
    raw.trim()
        .parse::<u64>()
        .map_err(|_| hls_err(INVALID_PLAYLIST))
}

fn parse_i64(raw: &str) -> Result<i64, AppError> {
    raw.trim()
        .parse::<i64>()
        .map_err(|_| hls_err(INVALID_PLAYLIST))
}

pub(crate) fn parse_attributes(line: &str) -> Vec<(String, String)> {
    let Some((_, rest)) = line.split_once(':') else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut rest = rest;
    loop {
        rest = rest.trim_start_matches([',', ' ', '\t']);
        if rest.is_empty() {
            break;
        }
        let Some(eq) = rest.find('=') else {
            break;
        };
        let key = rest[..eq].trim().to_string();
        rest = &rest[eq + 1..];
        let value = if let Some(quoted) = rest.strip_prefix('"') {
            match quoted.find('"') {
                Some(end) => {
                    let value = quoted[..end].to_string();
                    rest = &quoted[end + 1..];
                    value
                }
                None => {
                    rest = "";
                    quoted.to_string()
                }
            }
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            let value = rest[..end].trim().to_string();
            rest = if end < rest.len() { &rest[end..] } else { "" };
            value
        };
        if !key.is_empty() {
            out.push((key, value));
        }
    }
    out
}

pub(crate) fn attr<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hls::types::HlsEncryptMethod;

    #[test]
    fn master_selects_highest_bandwidth_variant() {
        let text = "\
#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",URI=\"audio.m3u8\"
#EXT-X-STREAM-INF:BANDWIDTH=800000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000
high.m3u8
";
        let parsed = parse_playlist(text, "https://ex.com/p/index.m3u8").expect("master playlist");
        let ParsedPlaylist::Master { variants } = parsed else {
            panic!("expected master playlist");
        };
        assert_eq!(variants.len(), 2);
        let best = select_best_variant(&variants).expect("best variant");
        assert_eq!(best.url, "https://ex.com/p/high.m3u8");
        assert_eq!(best.bandwidth, 2_500_000);
    }

    #[test]
    fn media_vod_resolves_relative_ts_urls() {
        let text = "\
#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.0,
seg0.ts
#EXTINF:9.0,
seg1.ts
#EXT-X-ENDLIST
";
        let parsed = parse_playlist(text, "https://ex.com/p/index.m3u8").expect("media playlist");
        let ParsedPlaylist::Media(media) = parsed else {
            panic!("expected media playlist");
        };
        assert!(media.is_vod);
        assert_eq!(media.media_sequence, 0);
        assert_eq!(media.segments.len(), 2);
        assert_eq!(media.segments[0].url, "https://ex.com/p/seg0.ts");
        assert_eq!(media.segments[1].url, "https://ex.com/p/seg1.ts");
        assert_eq!(media.segments[0].index, 0);
        assert_eq!(media.segments[1].index, 1);
        assert_eq!(media.segments[0].duration, 9.0);
    }

    #[test]
    fn media_parses_key_map_and_byterange() {
        let text = "\
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-KEY:METHOD=AES-128,URI=\"https://ex.com/key.bin\",IV=0x00000000000000000000000000000001
#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"720@0\"
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@720
seg.mp4
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000
seg.mp4
#EXT-X-ENDLIST
";
        let parsed = parse_playlist(text, "https://ex.com/p/index.m3u8").expect("fmp4 playlist");
        let ParsedPlaylist::Media(media) = parsed else {
            panic!("expected media playlist");
        };
        let init = media.init.expect("init segment");
        assert_eq!(init.url, "https://ex.com/p/init.mp4");
        assert_eq!(init.start_range, Some(0));
        assert_eq!(init.expect_length, Some(720));
        assert_eq!(init.encrypt.method, HlsEncryptMethod::Aes128);
        assert_eq!(
            init.encrypt.key_uri.as_deref(),
            Some("https://ex.com/key.bin")
        );
        assert_eq!(
            init.encrypt.iv,
            Some([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
        );
        assert!(init.encrypt.key.is_none());

        assert_eq!(media.media_sequence, 1);
        assert_eq!(media.segments.len(), 2);
        assert_eq!(media.segments[0].index, 1);
        assert_eq!(media.segments[0].url, "https://ex.com/p/seg.mp4");
        assert_eq!(media.segments[0].start_range, Some(720));
        assert_eq!(media.segments[0].expect_length, Some(1000));
        assert_eq!(media.segments[0].init_index, Some(init.index));
        assert_eq!(media.segments[0].encrypt.method, HlsEncryptMethod::Aes128);
        assert_eq!(
            media.segments[0].encrypt.iv,
            Some([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
        );
        assert_eq!(media.segments[1].index, 2);
        assert_eq!(media.segments[1].start_range, Some(1720));
        assert_eq!(media.segments[1].expect_length, Some(1000));
        assert_eq!(media.segments[1].url, "https://ex.com/p/seg.mp4");
        assert_eq!(media.segments[1].init_index, Some(init.index));
    }

    #[test]
    fn media_without_endlist_is_live_not_supported() {
        let text = "\
#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.0,
seg0.ts
";
        let err = parse_playlist(text, "https://ex.com/p/index.m3u8").expect_err("live");
        assert!(
            err.to_string().contains("live-not-supported"),
            "expected live-not-supported in '{err}'"
        );
    }

    #[test]
    fn text_not_extm3u_is_invalid_playlist() {
        let err =
            parse_playlist("not a playlist", "https://ex.com/p/index.m3u8").expect_err("invalid");
        assert!(
            err.to_string().contains("invalid-playlist"),
            "expected invalid-playlist in '{err}'"
        );
    }

    #[test]
    fn unknown_key_method_is_encrypt_not_supported() {
        let text = "\
#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"https://ex.com/key.bin\"
#EXTINF:9.0,
seg0.ts
#EXT-X-ENDLIST
";
        let err = parse_playlist(text, "https://ex.com/p/index.m3u8").expect_err("encrypt");
        assert!(
            err.to_string().contains("encrypt-not-supported"),
            "expected encrypt-not-supported in '{err}'"
        );
    }

    #[test]
    fn variant_without_bandwidth_uses_average_bandwidth() {
        let text = "\
#EXTM3U
#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=800000
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,AVERAGE-BANDWIDTH=9000000
high.m3u8
";
        let parsed = parse_playlist(text, "https://ex.com/p/index.m3u8").expect("master playlist");
        let ParsedPlaylist::Master { variants } = parsed else {
            panic!("expected master playlist");
        };
        assert_eq!(variants[0].bandwidth, 800_000);
        assert_eq!(variants[1].bandwidth, 2_500_000);
        let best = select_best_variant(&variants).expect("best variant");
        assert_eq!(best.url, "https://ex.com/p/high.m3u8");
    }

    #[test]
    fn bom_and_leading_whitespace_before_extm3u_is_valid() {
        let text = "\u{feff}  \n#EXTM3U\n#EXTINF:1.0,\nseg0.ts\n#EXT-X-ENDLIST\n";
        let parsed = parse_playlist(text, "https://ex.com/p/index.m3u8").expect("bom playlist");
        assert!(matches!(parsed, ParsedPlaylist::Media(_)));
    }

    #[test]
    fn discontinuity_keeps_a_single_segment_list() {
        let text = "\
#EXTM3U
#EXTINF:9.0,
a.ts
#EXT-X-DISCONTINUITY
#EXTINF:9.0,
b.ts
#EXT-X-ENDLIST
";
        let parsed = parse_playlist(text, "https://ex.com/p/index.m3u8").expect("media playlist");
        let ParsedPlaylist::Media(media) = parsed else {
            panic!("expected media playlist");
        };
        assert_eq!(media.segments.len(), 2);
        assert_eq!(media.segments[0].url, "https://ex.com/p/a.ts");
        assert_eq!(media.segments[1].url, "https://ex.com/p/b.ts");
    }

    #[test]
    fn aes128_key_without_iv_leaves_iv_none() {
        let text = "\
#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI=\"base64:AAAAAAAAAAAAAAAAAAAAAA==\"
#EXTINF:9.0,
seg0.ts
#EXT-X-ENDLIST
";
        let parsed = parse_playlist(text, "https://ex.com/p/index.m3u8").expect("media playlist");
        let ParsedPlaylist::Media(media) = parsed else {
            panic!("expected media playlist");
        };
        assert_eq!(media.segments[0].encrypt.method, HlsEncryptMethod::Aes128);
        assert_eq!(
            media.segments[0].encrypt.key.as_deref(),
            Some([0u8; 16].as_slice())
        );
        assert!(media.segments[0].encrypt.iv.is_none());
        assert!(media.segments[0].encrypt.key_uri.is_none());
    }
}
