/// Returns true when `gid` is `hls-` plus exactly 32 lowercase hex digits.
pub fn is_hls_gid(gid: &str) -> bool {
    let Some(hex) = gid.strip_prefix("hls-") else {
        return false;
    };
    hex.len() == 32
        && hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Returns true when the URI pathname ends with `.m3u8` or `.m3u` (case-insensitive).
///
/// Matches the TypeScript `isHlsUri` rules: parse failure is false; trailing slashes
/// on the path are stripped before the suffix check.
pub fn is_hls_uri(uri: &str) -> bool {
    let Ok(parsed) = url::Url::parse(uri) else {
        return false;
    };
    let path = parsed.path().trim_end_matches('/').to_ascii_lowercase();
    path.ends_with(".m3u8") || path.ends_with(".m3u")
}

/// Allocates a new HLS task gid: `hls-` plus a UUID v4 in 32-char lowercase hex.
pub fn new_hls_gid() -> String {
    format!("hls-{}", uuid::Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::{is_hls_gid, is_hls_uri, new_hls_gid};

    #[test]
    fn gid_roundtrip_shape() {
        let gid = new_hls_gid();
        assert!(is_hls_gid(&gid), "{gid}");
        assert!(!is_hls_gid("0123456789abcdef"));
    }

    #[test]
    fn uri_matches_typescript_rules() {
        assert!(is_hls_uri("https://cdn.example/a/master.m3u8?token=1#x"));
        assert!(is_hls_uri("HTTPS://CDN.EXAMPLE/A/INDEX.M3U"));
        assert!(!is_hls_uri("https://cdn.example/video.mp4"));
        assert!(!is_hls_uri("https://cdn.example/m3u8/video.ts"));
    }

    #[test]
    fn uri_strips_trailing_slashes_like_typescript() {
        assert!(is_hls_uri("https://cdn.example/a/master.m3u8/"));
        assert!(!is_hls_uri(""));
        assert!(!is_hls_uri("magnet:?xt=urn:btih:abc"));
    }

    #[test]
    fn gid_matches_typescript_pattern() {
        assert!(is_hls_gid("hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!is_hls_gid("HLS-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!is_hls_gid("hls-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assert!(!is_hls_gid("hls-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    }
}
