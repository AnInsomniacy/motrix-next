use crate::error::AppError;
use serde::{Deserialize, Serialize};

/// A single tracker source URL that failed to fetch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedTrackerSource {
    pub url: String,
    pub reason: String,
}

/// Structured result from fetching multiple tracker source URLs.
/// Captures both successful response bodies and per-URL failure details
/// so the frontend can show granular feedback to the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchTrackerSourcesResult {
    pub data: Vec<String>,
    pub failures: Vec<FailedTrackerSource>,
}

/// Fetches tracker lists from external source URLs via the Rust HTTP client,
/// bypassing browser CORS restrictions that block webview-based requests.
///
/// Each URL is fetched sequentially (typical source count is 1–5).
/// Failed URLs are logged individually and captured in `failures`;
/// successful response bodies are returned in `data`.
#[tauri::command]
pub async fn fetch_tracker_sources(
    urls: Vec<String>,
    proxy_server: Option<String>,
) -> Result<FetchTrackerSourcesResult, AppError> {
    if urls.is_empty() {
        return Ok(FetchTrackerSourcesResult {
            data: vec![],
            failures: vec![],
        });
    }

    log::info!("TrackerSync: fetching from {} source(s)", urls.len());

    let builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30));
    let client =
        crate::commands::http_client::apply_explicit_proxy(builder, &proxy_server, "TrackerSync")
            .build()
            .map_err(|e| AppError::Io(format!("failed to build HTTP client: {}", e)))?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    let mut data = Vec::new();
    let mut failures = Vec::new();

    for url in &urls {
        let request_url = format!("{}?t={}", url, now);
        match client.get(&request_url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if !status.is_success() {
                    let reason = format!("HTTP {}", status.as_u16());
                    log::warn!("TrackerSync: {} returned {}", url, reason);
                    failures.push(FailedTrackerSource {
                        url: url.clone(),
                        reason,
                    });
                    continue;
                }
                match resp.text().await {
                    Ok(body) => data.push(body),
                    Err(e) => {
                        let reason = e.to_string();
                        log::warn!("TrackerSync: failed to read body from {}: {}", url, reason);
                        failures.push(FailedTrackerSource {
                            url: url.clone(),
                            reason,
                        });
                    }
                }
            }
            Err(e) => {
                let reason = e.to_string();
                log::warn!("TrackerSync: failed to fetch {}: {}", url, reason);
                failures.push(FailedTrackerSource {
                    url: url.clone(),
                    reason,
                });
            }
        }
    }

    log::info!(
        "TrackerSync: completed {}/{} succeeded",
        data.len(),
        urls.len()
    );

    Ok(FetchTrackerSourcesResult { data, failures })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── fetch_tracker_sources ───────────────────────────────────────

    #[test]
    fn test_fetch_empty_urls_returns_empty_result() {
        let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
        let result = rt
            .block_on(fetch_tracker_sources(vec![], None))
            .expect("should succeed");
        assert!(result.data.is_empty());
        assert!(result.failures.is_empty());
    }

    #[test]
    fn test_fetch_unreachable_url_returns_failure() {
        let urls = vec!["http://192.0.2.1:1/trackers.txt".to_string()];
        let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
        let result = rt
            .block_on(fetch_tracker_sources(urls, None))
            .expect("should succeed — individual failures are captured, not errors");
        assert!(result.data.is_empty(), "no data from unreachable URL");
        assert_eq!(result.failures.len(), 1);
        assert_eq!(result.failures[0].url, "http://192.0.2.1:1/trackers.txt");
        assert!(
            !result.failures[0].reason.is_empty(),
            "failure reason must not be empty"
        );
    }

    #[test]
    fn test_fetch_result_serializes_to_camel_case() {
        let result = FetchTrackerSourcesResult {
            data: vec!["body1".to_string()],
            failures: vec![FailedTrackerSource {
                url: "http://example.com".to_string(),
                reason: "timeout".to_string(),
            }],
        };
        let json = serde_json::to_value(&result).expect("should serialize");
        assert_eq!(json["data"][0], "body1");
        assert_eq!(json["failures"][0]["url"], "http://example.com");
        assert_eq!(json["failures"][0]["reason"], "timeout");
    }

    #[test]
    fn test_fetch_result_empty_serializes_correctly() {
        let result = FetchTrackerSourcesResult {
            data: vec![],
            failures: vec![],
        };
        let json = serde_json::to_value(&result).expect("should serialize");
        assert!(json["data"]
            .as_array()
            .expect("data should be array")
            .is_empty());
        assert!(json["failures"]
            .as_array()
            .expect("failures should be array")
            .is_empty());
    }

    #[test]
    fn test_fetch_with_empty_proxy_ignores_proxy() {
        // Should not error when proxy_server is Some("") — treated as no proxy
        let rt = tokio::runtime::Runtime::new().expect("create tokio runtime");
        let result = rt
            .block_on(fetch_tracker_sources(
                vec!["http://192.0.2.1:1/trackers.txt".to_string()],
                Some("".to_string()),
            ))
            .expect("empty proxy should not cause error");
        // URL itself will fail, but the command itself should succeed
        assert_eq!(result.failures.len(), 1);
    }
}
