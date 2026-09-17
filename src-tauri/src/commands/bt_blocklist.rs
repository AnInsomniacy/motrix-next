use crate::error::AppError;
use crate::services::tasks::{TaskService, TaskServiceState};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

const BLOCKLIST_DIR: &str = "bt";
const BLOCKLIST_FILE: &str = "peer-blocklist.txt";
const BUNDLED_BLOCKLIST_FILE: &str = "data/bt-peer-blocklist.txt";
const MAX_BLOCKLIST_SIZE: u64 = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const SOURCE_PREFIX: &str = "# Source: ";
const SNAPSHOT_BUNDLED: &str = "# Snapshot: bundled";
const DEFAULT_BLOCKLIST_URL: &str = "https://bcr.pbh-btn.com/combine/all.txt";
const PROXY_SCOPE_UPDATE_TRACKERS: &str = "update-trackers";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlocklistProxyConfig {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    server: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    scope: Vec<String>,
}

impl BlocklistProxyConfig {
    fn network_source_url(&self) -> Option<String> {
        if self.mode != "manual"
            || self.server.trim().is_empty()
            || !self
                .scope
                .iter()
                .any(|scope| scope == PROXY_SCOPE_UPDATE_TRACKERS)
        {
            return None;
        }
        let mut url = url::Url::parse(self.server.trim()).ok()?;
        if !self.username.trim().is_empty() || !self.password.is_empty() {
            url.set_username(self.username.trim()).ok()?;
            url.set_password(Some(&self.password)).ok()?;
        }
        Some(url.to_string())
    }
}

#[derive(Debug, Clone, Deserialize)]
struct BtPeerBlocklistConfig {
    #[serde(rename = "btPeerBlocklistEnabled", default = "default_true")]
    enabled: bool,
    #[serde(rename = "btPeerBlocklistUrl", default = "default_blocklist_url")]
    url: String,
    #[serde(rename = "btPeerBlocklistAutoSync", default = "default_true")]
    auto_sync: bool,
    #[serde(
        rename = "btPeerBlocklistSyncIntervalHours",
        default = "default_sync_interval_hours"
    )]
    sync_interval_hours: u64,
    #[serde(default)]
    proxy: BlocklistProxyConfig,
}

fn default_true() -> bool {
    true
}

fn default_blocklist_url() -> String {
    DEFAULT_BLOCKLIST_URL.to_string()
}

fn default_sync_interval_hours() -> u64 {
    24
}

pub struct BtPeerBlocklistUpdateState(pub Arc<tokio::sync::Mutex<()>>);

impl BtPeerBlocklistUpdateState {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(())))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BtPeerBlocklistStatus {
    pub rule_count: usize,
    pub file_size: u64,
    pub modified: u64,
    pub source: String,
    pub bundled: bool,
}

fn normalize_blocklist_with_snapshot(
    content: &str,
    source: &str,
    snapshot: &str,
) -> Result<(String, usize), AppError> {
    let mut rules = Vec::new();
    let mut seen = HashSet::new();

    for (index, line) in content.lines().enumerate() {
        let value = line.trim();
        if value.is_empty() || value.starts_with('#') {
            continue;
        }

        let normalized = if value.contains('/') {
            IpNet::from_str(value)
                .map(|network| network.trunc().to_string())
                .map_err(|e| e.to_string())
        } else {
            IpAddr::from_str(value)
                .map(|address| address.to_string())
                .map_err(|e| e.to_string())
        }
        .map_err(|e| {
            AppError::Io(format!(
                "Invalid BT peer blocklist rule at line {}: {e}",
                index + 1
            ))
        })?;

        if seen.insert(normalized.clone()) {
            rules.push(normalized);
        }
    }

    if rules.is_empty() {
        return Err(AppError::Io(
            "BT peer blocklist contains no valid rules".into(),
        ));
    }

    let source = source.replace(['\r', '\n'], " ");
    let mut output = format!(
        "# Managed by Rayburst\n# Source: {source}\n# License: CC-BY 4.0 https://creativecommons.org/licenses/by/4.0/\n# Snapshot: {snapshot}\n# Modified: normalized and deduplicated by Rayburst\n# Rules normalized to IPv4, IPv6, or CIDR\n"
    );
    for rule in &rules {
        output.push_str(rule);
        output.push('\n');
    }

    Ok((output, rules.len()))
}

pub(crate) fn normalize_blocklist(
    content: &str,
    source: &str,
) -> Result<(String, usize), AppError> {
    normalize_blocklist_with_snapshot(content, source, "downloaded")
}

fn blocklist_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("Failed to get app data dir: {e}")))?
        .join(BLOCKLIST_DIR)
        .join(BLOCKLIST_FILE))
}

fn bundled_blocklist_path(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .resolve(BUNDLED_BLOCKLIST_FILE, tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError::Io(format!("Failed to resolve bundled BT peer blocklist: {e}")))
}

fn modified_millis(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn status_from_content(path: &Path, content: &str) -> Result<BtPeerBlocklistStatus, AppError> {
    let mut rule_count = 0;
    let mut source = String::new();
    let mut bundled = false;

    for line in content.lines() {
        let value = line.trim();
        if let Some(value) = value.strip_prefix(SOURCE_PREFIX) {
            source = value.trim().to_string();
        } else if value == SNAPSHOT_BUNDLED {
            bundled = true;
        } else if !value.is_empty() && !value.starts_with('#') {
            rule_count += 1;
        }
    }

    if rule_count == 0 {
        return Err(AppError::Io(
            "BT peer blocklist cache contains no rules".into(),
        ));
    }

    Ok(BtPeerBlocklistStatus {
        rule_count,
        file_size: std::fs::metadata(path)?.len(),
        modified: modified_millis(path),
        source,
        bundled,
    })
}

fn read_status(path: &Path) -> Result<BtPeerBlocklistStatus, AppError> {
    let content = std::fs::read_to_string(path)?;
    status_from_content(path, &content)
}

fn write_cache(path: &Path, content: &str) -> Result<(), AppError> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::Io("Invalid BT peer blocklist cache path".into()))?;
    std::fs::create_dir_all(dir)?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir)?;
    temporary.write_all(content.as_bytes())?;
    temporary.as_file_mut().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| AppError::Io(error.error.to_string()))?;
    Ok(())
}

pub(crate) fn ensure_bundled_cache(app: &AppHandle, source: &str) -> Result<PathBuf, AppError> {
    let target = blocklist_path(app)?;
    if target.is_file() && read_status(&target).is_ok() {
        return Ok(target);
    }

    let bundled = bundled_blocklist_path(app)?;
    let content = std::fs::read_to_string(&bundled).map_err(|e| {
        AppError::Io(format!(
            "Failed to read bundled BT peer blocklist {}: {e}",
            bundled.display()
        ))
    })?;
    let (normalized, rule_count) = normalize_blocklist_with_snapshot(&content, source, "bundled")?;
    write_cache(&target, &normalized)?;
    log::info!("bt_blocklist: installed bundled snapshot rules={rule_count}");
    Ok(target)
}

fn valid_http_url(value: &str) -> Result<url::Url, AppError> {
    let url = url::Url::parse(value.trim())
        .map_err(|e| AppError::Io(format!("Invalid BT peer blocklist URL: {e}")))?;
    if matches!(url.scheme(), "http" | "https") {
        Ok(url)
    } else {
        Err(AppError::Io(
            "BT peer blocklist URL must use HTTP or HTTPS".into(),
        ))
    }
}

async fn download_blocklist(url: &str, proxy: Option<String>) -> Result<String, AppError> {
    let url = valid_http_url(url)?;
    let builder = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::limited(5));
    let client =
        crate::commands::http_client::apply_explicit_proxy(builder, &proxy, "bt-peer-blocklist")
            .build()
            .map_err(|e| AppError::Io(format!("Failed to build BT peer blocklist client: {e}")))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("Failed to fetch BT peer blocklist: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::Io(format!(
            "BT peer blocklist returned HTTP {}",
            response.status()
        )));
    }
    if let Some(length) = response.content_length() {
        if length == 0 || length > MAX_BLOCKLIST_SIZE {
            return Err(AppError::Io(format!(
                "Invalid BT peer blocklist size: {length}"
            )));
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::Io(format!("Failed to read BT peer blocklist: {e}")))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_BLOCKLIST_SIZE {
        return Err(AppError::Io(format!(
            "Invalid BT peer blocklist size: {}",
            bytes.len()
        )));
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|e| AppError::Io(format!("BT peer blocklist is not valid UTF-8: {e}")))
}

async fn set_engine_blocklist(aria2: &TaskService, path: Option<&Path>) -> Result<(), AppError> {
    let value = path.map_or_else(String::new, crate::engine::path_to_safe_string);
    let mut options = serde_json::Map::new();
    options.insert(
        "bt-peer-blocklist".to_string(),
        serde_json::Value::String(value),
    );
    aria2.change_global_option(options).await?;
    Ok(())
}

fn read_config(app: &AppHandle) -> Result<BtPeerBlocklistConfig, AppError> {
    let store = app
        .store("config.json")
        .map_err(|e| AppError::Store(format!("Failed to open config.json: {e}")))?;
    let preferences = store
        .get("preferences")
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
    serde_json::from_value(preferences)
        .map_err(|e| AppError::Store(format!("Failed to parse BT peer blocklist config: {e}")))
}

fn update_is_due(status: &BtPeerBlocklistStatus, config: &BtPeerBlocklistConfig) -> bool {
    if status.bundled || status.source != config.url.trim() {
        return true;
    }
    let interval = config.sync_interval_hours;
    if interval == 0 || status.modified == 0 {
        return false;
    }
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64);
    now.saturating_sub(status.modified) >= interval.saturating_mul(60 * 60 * 1000)
}

async fn update_cache(
    app: &AppHandle,
    aria2: &TaskService,
    config: &BtPeerBlocklistConfig,
) -> Result<BtPeerBlocklistStatus, AppError> {
    let source = config.url.trim();
    let raw = download_blocklist(source, config.proxy.network_source_url()).await?;
    let (normalized, rule_count) = normalize_blocklist(&raw, source)?;
    let target = blocklist_path(app)?;
    write_cache(&target, &normalized)?;
    set_engine_blocklist(aria2, Some(&target)).await?;

    log::info!("bt_blocklist: updated rules={rule_count} source={source}");
    read_status(&target)
}

pub(crate) async fn reconcile(
    app: &AppHandle,
    aria2: &TaskService,
    force_update: bool,
) -> Result<BtPeerBlocklistStatus, AppError> {
    let state = app.state::<BtPeerBlocklistUpdateState>();
    let _guard = state.0.lock().await;
    let config = read_config(app)?;

    if !config.enabled {
        set_engine_blocklist(aria2, None).await?;
        let path = ensure_bundled_cache(app, &config.url)?;
        return read_status(&path);
    }

    let path = ensure_bundled_cache(app, &config.url)?;
    let status = read_status(&path)?;
    let should_update = force_update || (config.auto_sync && update_is_due(&status, &config));
    if should_update {
        return update_cache(app, aria2, &config).await;
    }

    set_engine_blocklist(aria2, Some(&path)).await?;
    Ok(status)
}

pub(crate) fn startup_blocklist_path(app: &AppHandle) -> Result<Option<String>, AppError> {
    let store = app
        .store("config.json")
        .map_err(|e| AppError::Store(format!("Failed to open config.json: {e}")))?;
    let preferences = store.get("preferences");
    let enabled = preferences
        .as_ref()
        .and_then(|value| value.get("btPeerBlocklistEnabled"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return Ok(None);
    }
    let source = preferences
        .as_ref()
        .and_then(|value| value.get("btPeerBlocklistUrl"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(DEFAULT_BLOCKLIST_URL);
    let path = ensure_bundled_cache(app, source)?;
    Ok(Some(crate::engine::path_to_safe_string(&path)))
}

#[tauri::command]
pub async fn get_bt_peer_blocklist_status(
    app: AppHandle,
) -> Result<BtPeerBlocklistStatus, AppError> {
    let config = read_config(&app)?;
    let path = ensure_bundled_cache(&app, &config.url)?;
    read_status(&path)
}

#[tauri::command]
pub async fn sync_bt_peer_blocklist(
    app: AppHandle,
    aria2: State<'_, TaskServiceState>,
) -> Result<BtPeerBlocklistStatus, AppError> {
    reconcile(&app, &aria2.0, true).await
}

#[tauri::command]
pub async fn reconcile_bt_peer_blocklist(
    app: AppHandle,
    aria2: State<'_, TaskServiceState>,
) -> Result<BtPeerBlocklistStatus, AppError> {
    reconcile(&app, &aria2.0, false).await
}

pub(crate) fn remove_bt_peer_blocklist_cache(app: &AppHandle) -> Result<(), AppError> {
    let path = blocklist_path(app)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_rules_and_removes_duplicates() {
        let input = "# source comment\n203.0.113.7\n203.0.113.0/24\n2001:db8::7\n2001:db8::/32\n203.0.113.7\n";

        let (content, count) = normalize_blocklist(input, "https://example.test/blocklist.txt")
            .expect("valid blocklist");

        assert_eq!(count, 4);
        assert!(content.contains("# Source: https://example.test/blocklist.txt"));
        assert!(content.contains("203.0.113.7\n"));
        assert!(content.contains("203.0.113.0/24\n"));
        assert!(content.contains("2001:db8::7\n"));
        assert!(content.contains("2001:db8::/32\n"));
        assert_eq!(content.matches("203.0.113.7\n").count(), 1);
    }

    #[test]
    fn rejects_invalid_rules_without_partial_output() {
        let error = normalize_blocklist("203.0.113.7\ninvalid-rule\n", "memory")
            .expect_err("invalid rule must fail");

        assert!(error.to_string().contains("line 2"));
    }

    #[test]
    fn bundled_snapshot_matches_the_engine_rule_format() {
        let snapshot = include_str!("../../data/bt-peer-blocklist.txt");
        let (_, count) = normalize_blocklist(snapshot, "https://bcr.pbh-btn.com/combine/all.txt")
            .expect("bundled snapshot must remain valid");

        assert!(count > 0);
    }

    #[test]
    fn cache_update_replaces_the_previous_snapshot() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let path = dir.path().join(BLOCKLIST_FILE);
        std::fs::write(&path, "old").expect("write old cache");

        write_cache(&path, "new").expect("replace cache");

        assert_eq!(std::fs::read_to_string(path).expect("read cache"), "new");
    }
}
