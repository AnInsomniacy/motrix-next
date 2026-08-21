use base64::Engine as _;

use crate::error::AppError;

use super::parser::{attr, combine_url, parse_attributes};
use super::types::{EncryptInfo, HlsEncryptMethod};

const INVALID_PLAYLIST: &str = "invalid-playlist";
const ENCRYPT_NOT_SUPPORTED: &str = "encrypt-not-supported";

/// Parses `#EXT-X-KEY` without fetching HTTP key URIs.
///
/// Inline `base64:` / `data:;base64,` / `data:text/plain;base64,` URIs are
/// decoded immediately. http(s) and relative URIs are stored in `key_uri`.
/// Missing IV is left as `None`; callers use [`default_iv`] later.
pub fn parse_key_line(line: &str, playlist_url: &str) -> Result<EncryptInfo, AppError> {
    let attrs = parse_attributes(line);
    let method_raw = attr(&attrs, "METHOD").ok_or_else(|| hls_err(INVALID_PLAYLIST))?;
    let method = parse_encrypt_method(method_raw)?;
    let mut info = EncryptInfo {
        method,
        key: None,
        iv: None,
        key_uri: None,
    };
    if let Some(iv_raw) = attr(&attrs, "IV") {
        info.iv = Some(parse_iv(iv_raw)?);
    }
    if let Some(uri) = attr(&attrs, "URI") {
        let (key, key_uri) = parse_key_material(uri, playlist_url)?;
        info.key = key;
        info.key_uri = key_uri;
    }
    Ok(info)
}

/// 16-byte big-endian IV from a media sequence index.
///
/// Matches N_m3u8DL-RE: `HexToBytes(Convert.ToString(segIndex, 16).PadLeft(32, '0'))`.
pub fn default_iv(media_sequence: i64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..].copy_from_slice(&(media_sequence as u64).to_be_bytes());
    iv
}

fn hls_err(code: &str) -> AppError {
    AppError::Hls(code.into())
}

fn parse_encrypt_method(raw: &str) -> Result<HlsEncryptMethod, AppError> {
    match raw.trim().to_ascii_uppercase().as_str() {
        "NONE" => Ok(HlsEncryptMethod::None),
        "AES-128" => Ok(HlsEncryptMethod::Aes128),
        "AES-128-ECB" => Ok(HlsEncryptMethod::Aes128Ecb),
        _ => Err(hls_err(ENCRYPT_NOT_SUPPORTED)),
    }
}

fn parse_iv(raw: &str) -> Result<[u8; 16], AppError> {
    let trimmed = raw.trim();
    let hex_str = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
        .unwrap_or(trimmed);
    let bytes = hex::decode(hex_str).map_err(|_| hls_err(INVALID_PLAYLIST))?;
    <[u8; 16]>::try_from(bytes).map_err(|_| hls_err(INVALID_PLAYLIST))
}

fn parse_key_material(
    uri: &str,
    playlist_url: &str,
) -> Result<(Option<Vec<u8>>, Option<String>), AppError> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return Ok((None, None));
    }
    let lower = trimmed.to_ascii_lowercase();
    let prefix_len = if lower.starts_with("base64:") {
        Some("base64:".len())
    } else if lower.starts_with("data:;base64,") {
        Some("data:;base64,".len())
    } else if lower.starts_with("data:text/plain;base64,") {
        Some("data:text/plain;base64,".len())
    } else {
        None
    };
    if let Some(len) = prefix_len {
        let payload = trimmed
            .get(len..)
            .ok_or_else(|| hls_err(INVALID_PLAYLIST))?;
        let key = base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|_| hls_err(INVALID_PLAYLIST))?;
        return Ok((Some(key), None));
    }
    Ok((None, Some(combine_url(playlist_url, trimmed)?)))
}

#[cfg(test)]
mod tests {
    use super::{default_iv, parse_key_line};
    use crate::hls::types::HlsEncryptMethod;

    #[test]
    fn default_iv_zero_is_all_zeros() {
        assert_eq!(default_iv(0), [0u8; 16]);
    }

    #[test]
    fn default_iv_one_has_last_byte_one() {
        let mut expected = [0u8; 16];
        expected[15] = 1;
        assert_eq!(default_iv(1), expected);
    }

    #[test]
    fn parse_key_line_decodes_inline_base64_and_explicit_iv() {
        let info = parse_key_line(
            "#EXT-X-KEY:METHOD=AES-128,URI=\"base64:AAAAAAAAAAAAAAAAAAAAAA==\",IV=0x00000000000000000000000000000001",
            "https://x/a.m3u8",
        )
        .expect("inline AES-128 key");
        assert_eq!(info.method, HlsEncryptMethod::Aes128);
        assert_eq!(info.key.as_deref(), Some([0u8; 16].as_slice()));
        assert_eq!(
            info.iv,
            Some([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
        );
        assert!(info.key_uri.is_none());
    }

    #[test]
    fn parse_key_line_sample_aes_is_encrypt_not_supported() {
        let err = parse_key_line(
            "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"https://ex.com/key.bin\"",
            "https://x/a.m3u8",
        )
        .expect_err("SAMPLE-AES");
        assert!(
            err.to_string().contains("encrypt-not-supported"),
            "expected encrypt-not-supported in '{err}'"
        );
    }

    #[test]
    fn parse_key_line_keeps_http_uri_and_leaves_iv_none() {
        let info = parse_key_line(
            "#EXT-X-KEY:METHOD=AES-128,URI=\"https://ex.com/key.bin\"",
            "https://x/a.m3u8",
        )
        .expect("http key uri");
        assert_eq!(info.method, HlsEncryptMethod::Aes128);
        assert!(info.key.is_none());
        assert!(info.iv.is_none());
        assert_eq!(info.key_uri.as_deref(), Some("https://ex.com/key.bin"));
    }

    #[test]
    fn parse_key_line_resolves_relative_key_uri() {
        let info = parse_key_line(
            "#EXT-X-KEY:METHOD=AES-128,URI=\"keys/a.bin\"",
            "https://x/p/a.m3u8",
        )
        .expect("relative key uri");
        assert_eq!(info.key_uri.as_deref(), Some("https://x/p/keys/a.bin"));
    }

    #[test]
    fn parse_key_line_decodes_data_uri_variants() {
        let data = "#EXT-X-KEY:METHOD=AES-128,URI=\"data:;base64,AAAAAAAAAAAAAAAAAAAAAA==\"";
        let plain =
            "#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAAAAAAAAAAAAAAAAAAAA==\"";
        for line in [data, plain] {
            let info = parse_key_line(line, "https://x/a.m3u8").expect("data uri");
            assert_eq!(info.key.as_deref(), Some([0u8; 16].as_slice()));
            assert!(info.key_uri.is_none());
        }
    }
}
