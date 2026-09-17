//! Fetch small remote torrent files for native metainfo inspection.
use crate::error::AppError;

const MAX_TORRENT_SIZE: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRequestHeader {
    pub name: String,
    pub value: String,
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

pub(crate) fn summarize_url_for_log(value: &str) -> String {
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
}
