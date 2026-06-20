/// Network utility commands: remote file fetching and filename resolution.
///
/// `resolve_filename` — Resolves trustworthy filenames for extensionless HTTP
/// URLs before forwarding them to aria2.
/// It also handles opaque CDN-style path filenames when response headers
/// expose a better name.
///
/// The command deliberately avoids deriving a filename from URL placeholders
/// such as `/attachment/u/0/`. Stable URL basenames from media/CDN paths may be
/// combined with a MIME-derived extension; weak placeholders still receive a
/// neutral English fallback.
use crate::error::AppError;

const MAX_TORRENT_SIZE: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRequestHeader {
    pub name: String,
    pub value: String,
}

/// Timeout for HEAD requests in `resolve_filename`.  Short enough to avoid
/// blocking the UI, long enough for CDN edge nodes to respond.
pub(crate) const HEAD_TIMEOUT_SECS: u64 = 5;
pub(crate) const UNRESOLVED_FILENAME: &str = "unresolved-filename";

// ── Filename resolution ─────────────────────────────────────────────────

/// Sends a HEAD request to `url` and infers the correct filename (with
/// extension) from HTTP response metadata.
///
/// Returns `Ok(Some("filename.ext"))` on successful resolution, `Ok(None)`
/// when a URL with an existing extension has no better response filename, or
/// `Ok(Some("unresolved-filename"))` when an extensionless URL exposes no
/// trustworthy filename.
///
/// The frontend calls this for extensionless URLs and opaque CDN-style
/// basenames before `aria2.addUri`, setting the returned name as aria2 `out`.
#[tauri::command]
pub async fn resolve_filename(
    url: String,
    proxy: Option<String>,
    referer: Option<String>,
    cookie: Option<String>,
) -> Result<Option<String>, AppError> {
    // 1. Extract basename from the URL path
    let basename = extract_basename(&url);
    let basename_has_extension = has_extension(&basename);

    if basename.is_empty() {
        log::debug!("resolve_filename: no URL basename, sending HEAD");
    } else if basename_has_extension {
        log::debug!("resolve_filename: basename={basename:?} has extension, probing headers");
    } else {
        log::debug!("resolve_filename: basename={basename:?} has no extension, sending HEAD");
    }

    // 2. HEAD request (follows redirects, respects user proxy settings)
    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HEAD_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(5));
    let client =
        crate::commands::http_client::apply_explicit_proxy(builder, &proxy, "resolve_filename")
            .build()
            .map_err(|e| AppError::Io(format!("HEAD client init failed: {e}")))?;

    let req =
        apply_download_request_headers(client.head(&url), referer.as_deref(), cookie.as_deref());

    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Io(format!("HEAD request failed: {e}")))?;

    // 3a. Level 1 — Content-Disposition filename
    if let Some(name) = parse_content_disposition_filename(resp.headers()) {
        if has_extension(&name) {
            log::debug!("resolve_filename: resolved via Content-Disposition → {name}");
            return Ok(Some(name));
        }
    }

    // 3b. Level 2 — Redirect target URL path extension
    let final_basename = extract_basename(resp.url().as_str());
    if !basename.is_empty() && !basename_has_extension && has_extension(&final_basename) {
        if let Some(ext) = final_basename.rsplit('.').next() {
            let resolved = format!("{basename}.{ext}");
            log::debug!("resolve_filename: resolved via redirect URL → {resolved}");
            return Ok(Some(resolved));
        }
    }

    // 3c. Level 3 — GET header probe for servers that only expose
    // Content-Disposition on the actual download request.
    if let Some(name) =
        probe_get_content_disposition(&client, &url, referer.as_deref(), cookie.as_deref()).await
    {
        if has_extension(&name) {
            log::debug!("resolve_filename: resolved via GET Content-Disposition → {name}");
            return Ok(Some(name));
        }
    }

    // 3d. Level 4 — Content-Type MIME → URL basename plus extension, or neutral fallback.
    if basename_has_extension || basename.is_empty() {
        log::debug!("resolve_filename: no better response filename; using aria2 native name");
        return Ok(None);
    }

    if let Some(ct) = resp.headers().get(reqwest::header::CONTENT_TYPE) {
        let mime_str = ct.to_str().unwrap_or("");
        // Strip parameters: "image/jpeg; charset=utf-8" → "image/jpeg"
        let mime_core = mime_str.split(';').next().unwrap_or("").trim();
        if let Some(ext) = mime2ext::mime2ext(mime_core) {
            let resolved = resolve_mime_fallback_filename(&basename, ext);
            if resolved.starts_with(UNRESOLVED_FILENAME) {
                log::debug!(
                    "resolve_filename: Content-Type ({mime_core}) has no trusted filename; using {resolved}"
                );
            } else {
                log::debug!(
                    "resolve_filename: resolved via URL basename + Content-Type ({mime_core}) → {resolved}"
                );
            }
            return Ok(Some(resolved));
        }
    }

    log::debug!(
        "resolve_filename: no trusted filename source for {}; using {UNRESOLVED_FILENAME}",
        summarize_url_for_log(&url)
    );
    Ok(Some(UNRESOLVED_FILENAME.to_string()))
}

fn resolve_mime_fallback_filename(basename: &str, ext: &str) -> String {
    if is_trustworthy_extensionless_basename(basename) {
        format!("{basename}.{ext}")
    } else {
        format!("{UNRESOLVED_FILENAME}.{ext}")
    }
}

fn is_trustworthy_extensionless_basename(basename: &str) -> bool {
    let name = basename.trim();
    if name.is_empty() || name != basename || name == "." || name == ".." {
        return false;
    }
    if name.contains('\0')
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(char::is_control)
    {
        return false;
    }
    if name.chars().all(|ch| ch.is_ascii_digit()) {
        return false;
    }

    let lower = name.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "attachment" | "download" | "file" | "index" | "default" | UNRESOLVED_FILENAME
    )
}

async fn probe_get_content_disposition(
    client: &reqwest::Client,
    url: &str,
    referer: Option<&str>,
    cookie: Option<&str>,
) -> Option<String> {
    let req = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .header(reqwest::header::ACCEPT_ENCODING, "identity");
    let req = apply_download_request_headers(req, referer, cookie);

    let resp = match req.send().await {
        Ok(resp) => resp,
        Err(e) => {
            log::debug!("resolve_filename: GET header probe failed: {e}");
            return None;
        }
    };

    parse_content_disposition_filename(resp.headers())
}

fn apply_download_request_headers(
    mut req: reqwest::RequestBuilder,
    referer: Option<&str>,
    cookie: Option<&str>,
) -> reqwest::RequestBuilder {
    if let Some(referer) = referer.filter(|v| !v.trim().is_empty()) {
        req = req.header(reqwest::header::REFERER, referer);
    }
    if let Some(cookie) = cookie.filter(|v| !v.trim().is_empty()) {
        req = req.header(reqwest::header::COOKIE, cookie);
    }
    req
}

fn apply_remote_request_headers(
    mut req: reqwest::RequestBuilder,
    referer: Option<&str>,
    cookie: Option<&str>,
    user_agent: Option<&str>,
    request_headers: &[RemoteRequestHeader],
) -> reqwest::RequestBuilder {
    for header in request_headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(header.name.as_bytes()),
            reqwest::header::HeaderValue::from_str(&header.value),
        ) {
            req = req.header(name, value);
        }
    }
    if let Some(user_agent) = user_agent.filter(|v| !v.trim().is_empty()) {
        req = req.header(reqwest::header::USER_AGENT, user_agent);
    }
    apply_download_request_headers(req, referer, cookie)
}

#[tauri::command]
pub async fn fetch_remote_bytes(
    url: String,
    proxy: Option<String>,
    referer: Option<String>,
    cookie: Option<String>,
    user_agent: Option<String>,
    request_headers: Vec<RemoteRequestHeader>,
) -> Result<Vec<u8>, AppError> {
    log::info!("fetch_remote_bytes: url={}", summarize_url_for_log(&url));

    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5));
    let client =
        crate::commands::http_client::apply_explicit_proxy(builder, &proxy, "fetch_remote_bytes")
            .build()
            .map_err(|e| AppError::Io(format!("GET client init failed: {e}")))?;

    let req = apply_remote_request_headers(
        client.get(&url),
        referer.as_deref(),
        cookie.as_deref(),
        user_agent.as_deref(),
        &request_headers,
    );
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Io(format!("GET request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Io(format!(
            "GET request failed with HTTP {}",
            resp.status()
        )));
    }
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_TORRENT_SIZE {
            return Err(AppError::Io(format!(
                "Response too large: {len} bytes (max {MAX_TORRENT_SIZE})"
            )));
        }
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Io(format!("Failed to read response body: {e}")))?;
    if bytes.len() > MAX_TORRENT_SIZE {
        return Err(AppError::Io(format!(
            "Response too large: {} bytes (max {MAX_TORRENT_SIZE})",
            bytes.len()
        )));
    }

    log::info!("fetch_remote_bytes: downloaded {} bytes", bytes.len());
    Ok(bytes.to_vec())
}

fn parse_content_disposition_filename(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let cd = headers.get(reqwest::header::CONTENT_DISPOSITION)?;
    let cd_str = String::from_utf8_lossy(cd.as_bytes());
    parse_cd_filename(&cd_str)
}

/// Extracts the last non-empty path segment from a URL, percent-decoded.
///
/// Returns an empty string for URLs without a usable path (bare domain,
/// trailing slash, data URIs, etc.).
pub(crate) fn extract_basename(url: &str) -> String {
    let pathname = match url::Url::parse(url) {
        Ok(parsed) => parsed.path().to_string(),
        Err(_) => url.split('?').next().unwrap_or("").to_string(),
    };
    let raw = pathname.split('/').rfind(|s| !s.is_empty()).unwrap_or("");

    // Percent-decode (e.g. "r%C3%A9sum%C3%A9" -> "résumé")
    match urlencoding::decode(raw) {
        Ok(decoded) => decoded.to_string(),
        Err(_) => raw.to_string(),
    }
}

/// Returns true if `name` contains a commonly-recognized file extension.
///
/// Uses a simple heuristic: a dot followed by 1–10 alphanumeric characters
/// at the end of the string.  This covers all standard extensions without
/// false-positive matching on filenames like "v1.2" (which would need two
/// consecutive dot-segments — extremely rare for actual filenames).
pub(crate) fn has_extension(name: &str) -> bool {
    // Find the last dot — must not be the first character (dotfiles like
    // .gitignore are hidden files, not extensions)
    if let Some(dot_pos) = name.rfind('.') {
        if dot_pos == 0 {
            return false; // Dotfile, not an extension
        }
        let ext = &name[dot_pos + 1..];
        // Extension must be 1–10 chars, all alphanumeric
        !ext.is_empty() && ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric())
    } else {
        false
    }
}

/// Parses the `filename` or `filename*` parameter from a Content-Disposition
/// header value.
///
/// Supports two formats per RFC 6266:
///   - `filename="report.pdf"` (quoted)
///   - `filename*=UTF-8''resume.pdf` (encoded)
///
/// Also decodes RFC 2047 MIME encoded-words when real-world servers place
/// them inside `filename=` despite RFC 6266 discouraging that format.
///
/// `filename*` takes precedence over `filename` when both are present.
pub(crate) fn parse_cd_filename(header: &str) -> Option<String> {
    if let Some(filename_star) = extract_content_disposition_param(header, "filename*") {
        if let Some(decoded) = decode_rfc5987_filename_value(&filename_star) {
            return normalize_content_disposition_filename(
                &decoded,
                FilenameEncodingSource::Extended,
            );
        }
    }

    let parsed = content_disposition::parse_content_disposition(header);
    let candidate = select_content_disposition_filename(&parsed)?;
    normalize_content_disposition_filename(&candidate.value, candidate.source)
}

#[derive(Clone, Copy)]
pub(crate) enum FilenameEncodingSource {
    Legacy,
    Extended,
}

pub(crate) fn decode_filename_encoding(filename: &str) -> String {
    decode_filename_encoding_for_source(filename, FilenameEncodingSource::Legacy)
}

fn decode_filename_encoding_for_source(filename: &str, source: FilenameEncodingSource) -> String {
    let trimmed = filename.trim();

    if matches!(source, FilenameEncodingSource::Extended) {
        if looks_like_rfc2047_encoded_word(trimmed) {
            let decoded = decode_rfc2047_filename(trimmed.to_string());
            if decoded != trimmed && !decoded.trim().is_empty() {
                return decoded.trim().to_string();
            }
        }
        return trimmed.to_string();
    }

    let percent_decoded = urlencoding::decode(trimmed)
        .ok()
        .map(|value| value.to_string());

    let mut candidates = vec![trimmed.to_string()];
    if let Some(decoded) = percent_decoded.filter(|decoded| decoded != trimmed) {
        candidates.push(decoded);
    }

    for candidate in &candidates {
        if looks_like_rfc2047_encoded_word(candidate) {
            let decoded = decode_rfc2047_filename(candidate.clone());
            if decoded != *candidate && !decoded.trim().is_empty() {
                return decoded.trim().to_string();
            }
        }
    }

    if matches!(source, FilenameEncodingSource::Legacy) {
        if let Some(decoded) = candidates
            .get(1)
            .filter(|decoded| !decoded.trim().is_empty())
        {
            return decoded.trim().to_string();
        }
    }

    trimmed.to_string()
}

fn normalize_content_disposition_filename(
    filename: &str,
    source: FilenameEncodingSource,
) -> Option<String> {
    let decoded = decode_filename_encoding_for_source(filename, source);
    validate_content_disposition_filename(&decoded)
}

fn validate_content_disposition_filename(filename: &str) -> Option<String> {
    let name = filename.trim();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    if name.contains('\0')
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(char::is_control)
        || looks_like_rfc2047_encoded_word(name)
        || looks_like_corrupt_question_mark_filename(name)
    {
        return None;
    }
    Some(name.to_string())
}

fn looks_like_rfc2047_encoded_word(value: &str) -> bool {
    value.contains("=?") && value.contains("?=")
}

fn looks_like_corrupt_question_mark_filename(value: &str) -> bool {
    let question_marks = value.chars().filter(|ch| *ch == '?').count();
    if question_marks < 3 {
        return false;
    }
    let visible = value.chars().filter(|ch| !ch.is_whitespace()).count();
    question_marks * 3 >= visible
}

struct ContentDispositionFilename {
    value: String,
    source: FilenameEncodingSource,
}

fn select_content_disposition_filename(
    parsed: &content_disposition::ParsedContentDisposition,
) -> Option<ContentDispositionFilename> {
    parsed
        .filename_full()
        .filter(|name| !name.is_empty())
        .map(|value| ContentDispositionFilename {
            value,
            source: FilenameEncodingSource::Legacy,
        })
}

fn extract_content_disposition_param(header: &str, wanted_name: &str) -> Option<String> {
    let mut in_quote = false;
    let mut escaped = false;
    let mut segment_start = 0;

    for (index, ch) in header.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_quote => escaped = true,
            '"' => in_quote = !in_quote,
            ';' if !in_quote => {
                if let Some(value) =
                    extract_param_from_segment(&header[segment_start..index], wanted_name)
                {
                    return Some(value);
                }
                segment_start = index + ch.len_utf8();
            }
            _ => {}
        }
    }

    extract_param_from_segment(&header[segment_start..], wanted_name)
}

fn extract_param_from_segment(segment: &str, wanted_name: &str) -> Option<String> {
    let (name, value) = segment.split_once('=')?;
    if !name.trim().eq_ignore_ascii_case(wanted_name) {
        return None;
    }
    Some(unquote_header_param_value(value.trim()))
}

fn unquote_header_param_value(value: &str) -> String {
    let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else {
        return value.to_string();
    };

    let mut result = String::with_capacity(inner.len());
    let mut escaped = false;
    for ch in inner.chars() {
        if escaped {
            result.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else {
            result.push(ch);
        }
    }
    if escaped {
        result.push('\\');
    }
    result
}

fn decode_rfc5987_filename_value(value: &str) -> Option<String> {
    let unquoted = value.trim();
    let mut parts = unquoted.splitn(3, '\'');
    let charset = parts.next()?.trim();
    let _language = parts.next()?;
    let encoded = parts.next()?;

    if !charset.eq_ignore_ascii_case("utf-8") {
        return None;
    }

    urlencoding::decode(encoded)
        .ok()
        .map(|decoded| decoded.to_string())
        .filter(|decoded| !decoded.is_empty())
}

fn decode_rfc2047_filename(filename: String) -> String {
    if !filename.contains("=?") {
        return filename;
    }

    match rfc2047_decoder::Decoder::new()
        .too_long_encoded_word_strategy(rfc2047_decoder::RecoverStrategy::Decode)
        .decode(filename.as_bytes())
    {
        Ok(decoded) if !decoded.is_empty() => decoded,
        Ok(_) => filename,
        Err(error) => {
            log::warn!("parse_cd_filename: RFC 2047 decode failed: {error}");
            filename
        }
    }
}

fn summarize_url_for_log(value: &str) -> String {
    let lower = value.to_lowercase();
    if lower.starts_with("magnet:") {
        return format!("scheme=magnet length={}", value.len());
    }
    if lower.starts_with("ed2k://") {
        return format!("scheme=ed2k length={}", value.len());
    }
    if lower.starts_with("thunder://") {
        return format!("scheme=thunder length={}", value.len());
    }

    match url::Url::parse(value) {
        Ok(parsed) => {
            let scheme = parsed.scheme();
            let host = parsed.host_str().unwrap_or("none");
            let ext = parsed
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext))
                .filter(|ext| !ext.is_empty() && ext.len() <= 16)
                .unwrap_or("none");
            format!(
                "scheme={scheme} host={host} ext={} has_query={} length={}",
                ext.to_ascii_lowercase(),
                parsed.query().is_some(),
                value.len()
            )
        }
        Err(_) => format!("parseable=false length={}", value.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── extract_basename ────────────────────────────────────────────

    #[test]
    fn extract_basename_normal_url() {
        assert_eq!(
            extract_basename("https://example.com/path/file.zip"),
            "file.zip"
        );
    }

    #[test]
    fn extract_basename_strips_query() {
        assert_eq!(
            extract_basename(
                "https://pbs.twimg.com/media/HCo_0zsbkAEov7s?format=jpg&name=4096x4096"
            ),
            "HCo_0zsbkAEov7s"
        );
    }

    #[test]
    fn extract_basename_encoded() {
        assert_eq!(
            extract_basename("https://example.com/r%C3%A9sum%C3%A9.pdf"),
            "résumé.pdf"
        );
    }

    #[test]
    fn extract_basename_trailing_slash() {
        assert_eq!(extract_basename("https://example.com/"), "");
    }

    #[test]
    fn extract_basename_bare_domain() {
        assert_eq!(extract_basename("https://example.com"), "");
    }

    // ── has_extension ───────────────────────────────────────────────

    #[test]
    fn has_extension_with_ext() {
        assert!(has_extension("file.jpg"));
        assert!(has_extension("archive.tar.gz"));
        assert!(has_extension("report.PDF"));
    }

    #[test]
    fn has_extension_without_ext() {
        assert!(!has_extension("HCo_0zsbkAEov7s"));
        assert!(!has_extension("noext"));
        assert!(!has_extension(""));
    }

    #[test]
    fn has_extension_dot_only() {
        assert!(!has_extension("file."));
        assert!(!has_extension("."));
    }

    #[test]
    fn has_extension_hidden_file() {
        assert!(!has_extension(".gitignore")); // Unix hidden file, not an extension
    }

    // ── parse_cd_filename ───────────────────────────────────────────

    #[test]
    fn parse_cd_filename_quoted() {
        assert_eq!(
            parse_cd_filename("attachment; filename=\"report.pdf\""),
            Some("report.pdf".into())
        );
    }

    #[test]
    fn parse_cd_filename_unquoted() {
        assert_eq!(
            parse_cd_filename("attachment; filename=report.pdf"),
            Some("report.pdf".into())
        );
    }

    #[test]
    fn parse_cd_filename_star_utf8() {
        assert_eq!(
            parse_cd_filename("attachment; filename*=UTF-8''resume.pdf"),
            Some("resume.pdf".into())
        );
    }

    #[test]
    fn parse_cd_filename_decodes_rfc2047_base64_filename() {
        assert_eq!(
            parse_cd_filename("attachment; filename=\"=?UTF-8?B?0JjRgtC+0LPQuF8yMDI2LmRvY3g=?=\""),
            Some("Итоги_2026.docx".into())
        );
    }

    #[test]
    fn parse_cd_filename_decodes_percent_encoded_rfc2047_filename() {
        assert_eq!(
            parse_cd_filename(
                "attachment; filename=\"=%3FUTF-8%3FB%3F0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4%3F=\""
            ),
            Some("ИТОГИ ЛДУ 2026.xlsx".into())
        );
    }

    #[test]
    fn parse_cd_filename_decodes_legacy_percent_encoded_utf8_filename() {
        assert_eq!(
            parse_cd_filename(
                "attachment; filename=\"K430006866701%20%20%20%20%2020251022%20%20%20ASKO%20%20%20%20CW5937GCN%20%20%20%20%20CW51237GCN%E8%AF%B4%E6%98%8E%E4%B9%A6%28%E6%96%B0%E5%9B%BD%E6%A0%87%29.pdf\""
            ),
            Some("K430006866701     20251022   ASKO    CW5937GCN     CW51237GCN说明书(新国标).pdf".into())
        );
    }

    #[test]
    fn parse_cd_filename_star_does_not_double_decode_plain_percent_sequences() {
        assert_eq!(
            parse_cd_filename("attachment; filename*=UTF-8''100%2520done.pdf"),
            Some("100%20done.pdf".into())
        );
    }

    #[test]
    fn max_torrent_size_is_16_mib() {
        assert_eq!(MAX_TORRENT_SIZE, 16 * 1024 * 1024);
    }

    #[test]
    fn parse_cd_filename_rejects_percent_decoded_path_separators() {
        assert_eq!(
            parse_cd_filename("attachment; filename=\"safe%2Fevil.pdf\""),
            None
        );
    }

    #[test]
    fn parse_cd_filename_decodes_rfc2047_wrapped_in_filename_star() {
        assert_eq!(
            parse_cd_filename(
                "attachment; filename=\"????? ??? 2026.xlsx\"; filename*=UTF-8''%3D%3FUTF-8%3FB%3F0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4%3F%3D"
            ),
            Some("ИТОГИ ЛДУ 2026.xlsx".into())
        );
    }

    #[test]
    fn parse_cd_filename_rejects_irrecoverable_question_mark_filename() {
        assert_eq!(
            parse_cd_filename("attachment; filename=\"????? ??? 2026.xlsx\""),
            None
        );
    }

    #[test]
    fn parse_cd_filename_decodes_rfc2047_quoted_printable_filename() {
        assert_eq!(
            parse_cd_filename("attachment; filename=\"=?UTF-8?Q?r=C3=A9sum=C3=A9.pdf?=\""),
            Some("résumé.pdf".into())
        );
    }

    #[tokio::test]
    async fn resolve_filename_sends_referer_and_cookie_headers() {
        use axum::{extract::State, http::HeaderMap, routing::head, Router};
        use std::net::SocketAddr;
        use std::sync::{Arc, Mutex};
        use tokio::net::TcpListener;

        #[derive(Default)]
        struct CapturedHeaders {
            referer: Option<String>,
            cookie: Option<String>,
        }

        async fn handle_head(
            State(captured): State<Arc<Mutex<CapturedHeaders>>>,
            headers: HeaderMap,
        ) -> [(&'static str, &'static str); 1] {
            let mut captured = captured.lock().expect("captured headers mutex poisoned");
            captured.referer = headers
                .get(reqwest::header::REFERER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            captured.cookie = headers
                .get(reqwest::header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);

            [(
                "content-disposition",
                "attachment; filename*=UTF-8''%D0%98%D1%82%D0%BE%D0%B3%D0%B8_2026.docx",
            )]
        }

        let captured = Arc::new(Mutex::new(CapturedHeaders::default()));
        let app = Router::new()
            .route("/attachment", head(handle_head))
            .with_state(Arc::clone(&captured));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let resolved = resolve_filename(
            format!("http://{addr}/attachment"),
            None,
            Some("https://mail.google.com/mail/u/0/#inbox".to_string()),
            Some("COMPASS=gmail=abc".to_string()),
        )
        .await
        .unwrap();

        assert_eq!(resolved, Some("Итоги_2026.docx".to_string()));
        let captured = captured.lock().expect("captured headers mutex poisoned");
        assert_eq!(
            captured.referer.as_deref(),
            Some("https://mail.google.com/mail/u/0/#inbox")
        );
        assert_eq!(captured.cookie.as_deref(), Some("COMPASS=gmail=abc"));
    }

    #[tokio::test]
    async fn fetch_remote_bytes_sends_browser_context_headers() {
        use axum::{extract::State, http::HeaderMap, routing::get, Router};
        use std::net::SocketAddr;
        use std::sync::{Arc, Mutex};
        use tokio::net::TcpListener;

        #[derive(Default)]
        struct CapturedHeaders {
            referer: Option<String>,
            cookie: Option<String>,
            user_agent: Option<String>,
            accept_language: Option<String>,
        }

        async fn handle_get(
            State(captured): State<Arc<Mutex<CapturedHeaders>>>,
            headers: HeaderMap,
        ) -> &'static [u8] {
            let mut captured = captured.lock().expect("captured headers mutex poisoned");
            captured.referer = headers
                .get(reqwest::header::REFERER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            captured.cookie = headers
                .get(reqwest::header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            captured.user_agent = headers
                .get(reqwest::header::USER_AGENT)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            captured.accept_language = headers
                .get(reqwest::header::ACCEPT_LANGUAGE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);

            b"d4:infode"
        }

        let captured = Arc::new(Mutex::new(CapturedHeaders::default()));
        let app = Router::new()
            .route("/linux.torrent", get(handle_get))
            .with_state(Arc::clone(&captured));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let bytes = fetch_remote_bytes(
            format!("http://{addr}/linux.torrent"),
            None,
            Some("https://example.com/page".to_string()),
            Some("sid=1".to_string()),
            Some("Mozilla/5.0".to_string()),
            vec![RemoteRequestHeader {
                name: "Accept-Language".to_string(),
                value: "en-US".to_string(),
            }],
        )
        .await
        .unwrap();

        assert_eq!(bytes, b"d4:infode");
        let captured = captured.lock().expect("captured headers mutex poisoned");
        assert_eq!(
            captured.referer.as_deref(),
            Some("https://example.com/page")
        );
        assert_eq!(captured.cookie.as_deref(), Some("sid=1"));
        assert_eq!(captured.user_agent.as_deref(), Some("Mozilla/5.0"));
        assert_eq!(captured.accept_language.as_deref(), Some("en-US"));
    }

    #[tokio::test]
    async fn resolve_filename_decodes_rfc2047_content_disposition_filename() {
        use axum::{routing::head, Router};
        use std::net::SocketAddr;
        use tokio::net::TcpListener;

        async fn handle_head() -> [(&'static str, &'static str); 1] {
            [(
                "content-disposition",
                "attachment; filename=\"=?UTF-8?B?0JjRgtC+0LPQuF8yMDI2LmRvY3g=?=\"",
            )]
        }

        let app = Router::new().route("/attachment", head(handle_head));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let resolved = resolve_filename(format!("http://{addr}/attachment"), None, None, None)
            .await
            .unwrap();

        assert_eq!(resolved, Some("Итоги_2026.docx".to_string()));
    }

    #[tokio::test]
    async fn resolve_filename_probes_get_content_disposition_when_head_lacks_filename() {
        use axum::{routing::get, routing::head, Router};
        use std::net::SocketAddr;
        use tokio::net::TcpListener;

        async fn handle_head() -> [(&'static str, &'static str); 1] {
            [(
                "content-type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )]
        }

        async fn handle_get() -> [(&'static str, &'static str); 2] {
            [
                (
                    "content-type",
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ),
                (
                    "content-disposition",
                    "attachment; filename=\"=?UTF-8?B?0JjQotCe0JPQmCDQm9CU0KMgMjAyNi54bHN4?=\"",
                ),
            ]
        }

        let app = Router::new()
            .route("/attachment/u/0/", head(handle_head))
            .route("/attachment/u/0/", get(handle_get));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let resolved = resolve_filename(
            format!("http://{addr}/attachment/u/0/?ui=2&disp=safe"),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resolved, Some("ИТОГИ ЛДУ 2026.xlsx".to_string()));
    }

    #[tokio::test]
    async fn resolve_filename_get_probe_sends_download_headers() {
        use axum::{extract::State, http::HeaderMap, routing::get, routing::head, Router};
        use std::net::SocketAddr;
        use std::sync::{Arc, Mutex};
        use tokio::net::TcpListener;

        #[derive(Default)]
        struct CapturedProbeHeaders {
            referer: Option<String>,
            cookie: Option<String>,
            range: Option<String>,
        }

        async fn handle_head() -> [(&'static str, &'static str); 1] {
            [(
                "content-type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )]
        }

        async fn handle_get(
            State(captured): State<Arc<Mutex<CapturedProbeHeaders>>>,
            headers: HeaderMap,
        ) -> [(&'static str, &'static str); 1] {
            let mut captured = captured.lock().expect("captured headers mutex poisoned");
            captured.referer = headers
                .get(reqwest::header::REFERER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            captured.cookie = headers
                .get(reqwest::header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);
            captured.range = headers
                .get(reqwest::header::RANGE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string);

            [(
                "content-disposition",
                "attachment; filename*=UTF-8''%D0%98%D0%A2%D0%9E%D0%93%D0%98%20%D0%9B%D0%94%D0%A3%202026.xlsx",
            )]
        }

        let captured = Arc::new(Mutex::new(CapturedProbeHeaders::default()));
        let app = Router::new()
            .route("/attachment/u/0/", head(handle_head))
            .route("/attachment/u/0/", get(handle_get))
            .with_state(Arc::clone(&captured));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let resolved = resolve_filename(
            format!("http://{addr}/attachment/u/0/?ui=2&disp=safe"),
            None,
            Some("https://mail.google.com/mail/u/0/#inbox".to_string()),
            Some("COMPASS=gmail=abc".to_string()),
        )
        .await
        .unwrap();

        assert_eq!(resolved, Some("ИТОГИ ЛДУ 2026.xlsx".to_string()));
        let captured = captured.lock().expect("captured headers mutex poisoned");
        assert_eq!(
            captured.referer.as_deref(),
            Some("https://mail.google.com/mail/u/0/#inbox")
        );
        assert_eq!(captured.cookie.as_deref(), Some("COMPASS=gmail=abc"));
        assert_eq!(captured.range.as_deref(), Some("bytes=0-0"));
    }

    #[tokio::test]
    async fn resolve_filename_uses_neutral_fallback_for_content_type_without_trusted_name() {
        use axum::{routing::head, Router};
        use std::net::SocketAddr;
        use tokio::net::TcpListener;

        async fn handle_head() -> [(&'static str, &'static str); 1] {
            [(
                "content-type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )]
        }

        let app = Router::new().route("/attachment/u/0/", head(handle_head));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let resolved = resolve_filename(
            format!("http://{addr}/attachment/u/0/?ui=2&disp=safe"),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resolved, Some("unresolved-filename.xlsx".to_string()));
    }

    #[tokio::test]
    async fn resolve_filename_uses_url_basename_for_trusted_extensionless_media_url() {
        use axum::{routing::head, Router};
        use std::net::SocketAddr;
        use tokio::net::TcpListener;

        async fn handle_head() -> [(&'static str, &'static str); 1] {
            [("content-type", "image/jpeg")]
        }

        let app = Router::new().route("/media/HCo_0zsbkAEov7s", head(handle_head));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let resolved = resolve_filename(
            format!("http://{addr}/media/HCo_0zsbkAEov7s?format=jpg&name=4096x4096"),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resolved, Some("HCo_0zsbkAEov7s.jpg".to_string()));
    }

    #[tokio::test]
    async fn resolve_filename_uses_neutral_fallback_without_content_type_extension() {
        use axum::{routing::head, Router};
        use std::net::SocketAddr;
        use tokio::net::TcpListener;

        async fn handle_head() -> axum::http::StatusCode {
            axum::http::StatusCode::OK
        }

        let app = Router::new().route("/attachment/u/0/", head(handle_head));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let resolved = resolve_filename(
            format!("http://{addr}/attachment/u/0/?ui=2&disp=safe"),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resolved, Some("unresolved-filename".to_string()));
    }

    #[test]
    fn parse_cd_filename_star_takes_precedence() {
        let cd = "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''resume.pdf";
        assert_eq!(parse_cd_filename(cd), Some("resume.pdf".into()));
    }

    #[test]
    fn parse_cd_filename_missing() {
        assert_eq!(parse_cd_filename("inline"), None);
    }

    #[test]
    fn parse_cd_filename_empty() {
        assert_eq!(parse_cd_filename(""), None);
    }

    // ── has_extension edge cases for .gitignore-style ────────────────

    #[test]
    fn has_extension_rejects_too_long_ext() {
        assert!(!has_extension("file.abcdefghijk")); // 11 chars
    }

    #[test]
    fn has_extension_accepts_max_length() {
        assert!(has_extension("file.abcdefghij")); // 10 chars
    }

    // ── mime2ext integration ────────────────────────────────────────

    #[test]
    fn mime2ext_resolves_common_types() {
        // mime-db maps image/jpeg → "jpg" (the preferred short form)
        assert_eq!(mime2ext::mime2ext("image/jpeg"), Some("jpg"));
        assert_eq!(mime2ext::mime2ext("image/png"), Some("png"));
        assert_eq!(mime2ext::mime2ext("video/mp4"), Some("mp4"));
        assert_eq!(mime2ext::mime2ext("application/pdf"), Some("pdf"));
    }

    #[test]
    fn mime2ext_returns_none_for_unknown() {
        assert_eq!(mime2ext::mime2ext("application/x-unknown-test"), None);
    }
}
