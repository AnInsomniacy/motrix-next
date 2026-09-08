//! System proxy detection for Windows, macOS, and Linux.
//!
//! Returns the OS-level HTTP proxy configuration without any external crate
//! dependencies. Each platform uses its native API:
//! - **Windows**: Registry `HKCU\..\Internet Settings` with multi-protocol
//!   `ProxyServer` parsing (`http=host:port;socks=host:port`)
//! - **macOS**: `scutil --proxy` (System Configuration framework)
//! - **Linux**: Environment variables (`http_proxy`, `https_proxy`) with
//!   `gsettings` (GNOME) fallback
//!
//! Note: SOCKS proxies are reported with `is_socks: true` so the frontend
//! can reject them at the UI level (aria2 does not support SOCKS).

use crate::error::AppError;
use serde::Serialize;

/// Information about the system-configured proxy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyInfo {
    /// Proxy URL, e.g. "http://127.0.0.1:7890"
    pub server: String,
    /// Bypass list from the OS (comma-separated domains/CIDRs)
    pub bypass: String,
    /// True if the detected proxy uses a SOCKS protocol
    pub is_socks: bool,
}

/// Detects the system-level HTTP proxy configuration.
///
/// Returns `Ok(Some(info))` when a proxy is configured and enabled,
/// `Ok(None)` when no proxy is detected or the platform is unsupported.
#[tauri::command]
pub fn get_system_proxy() -> Result<Option<SystemProxyInfo>, AppError> {
    log::info!("proxy:detect started");
    let result = get_system_proxy_impl();
    match &result {
        Ok(Some(info)) => log::info!(
            "proxy:detect result=found server={} is_socks={}",
            info.server,
            info.is_socks
        ),
        Ok(None) => log::info!("proxy:detect result=not-found"),
        Err(e) => log::warn!("proxy:detect result=error {:?}", e),
    }
    result
}

// ── Platform implementations ────────────────────────────────────────

#[cfg(target_os = "windows")]
fn get_system_proxy_impl() -> Result<Option<SystemProxyInfo>, AppError> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .map_err(|e| AppError::Io(format!("Failed to open proxy registry key: {e}")))?;

    let enabled: u32 = settings.get_value("ProxyEnable").unwrap_or(0);
    log::debug!("proxy:windows ProxyEnable={}", enabled);
    if enabled == 0 {
        return Ok(None);
    }

    let raw: String = match settings.get_value("ProxyServer") {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    log::debug!("proxy:windows ProxyServer={:?}", raw);

    if raw.trim().is_empty() {
        return Ok(None);
    }

    let bypass: String = settings.get_value("ProxyOverride").unwrap_or_default();
    log::debug!("proxy:windows ProxyOverride={:?}", bypass);

    let (server, is_socks) = parse_windows_proxy_server(&raw);
    if server.is_empty() {
        log::debug!("proxy:windows parsed server is empty → skip");
        return Ok(None);
    }

    Ok(Some(SystemProxyInfo {
        server,
        bypass,
        is_socks,
    }))
}

/// Parses the Windows `ProxyServer` registry value into `(server_url, is_socks)`.
///
/// Handles two formats:
/// 1. **Uniform**: `host:port` — a single proxy for all protocols
/// 2. **Per-protocol**: `http=host:port;https=host:port;socks=host:port`
///
/// In per-protocol mode, HTTP is preferred over HTTPS. If only SOCKS is
/// available, the result is flagged with `is_socks = true`.
#[cfg(target_os = "windows")]
fn parse_windows_proxy_server(raw: &str) -> (String, bool) {
    let raw = raw.trim();

    // Per-protocol format contains '=' (e.g. "http=127.0.0.1:7890")
    if raw.contains('=') {
        let mut http_val: Option<&str> = None;
        let mut https_val: Option<&str> = None;
        let mut socks_val: Option<&str> = None;

        for segment in raw.split(';') {
            let segment = segment.trim();
            if let Some((proto, addr)) = segment.split_once('=') {
                match proto.trim().to_lowercase().as_str() {
                    "http" => http_val = Some(addr.trim()),
                    "https" => https_val = Some(addr.trim()),
                    "socks" | "socks4" | "socks5" => socks_val = Some(addr.trim()),
                    _ => {}
                }
            }
        }

        // Prefer HTTP, then HTTPS, then SOCKS
        if let Some(addr) = http_val {
            return (format_proxy_url(addr, "http"), false);
        }
        if let Some(addr) = https_val {
            return (format_proxy_url(addr, "http"), false);
        }
        if let Some(addr) = socks_val {
            return (format_proxy_url(addr, "socks5"), true);
        }

        return (String::new(), false);
    }

    // Uniform format: bare host:port or already has scheme
    let lower = raw.to_lowercase();
    if lower.starts_with("socks") {
        (format_proxy_url(raw, "socks5"), true)
    } else {
        (format_proxy_url(raw, "http"), false)
    }
}

/// Ensures a proxy address has a `scheme://` prefix.
///
/// If the address already contains `://`, it is returned as-is.
/// Otherwise, `{default_scheme}://{address}` is returned.
#[cfg(target_os = "windows")]
fn format_proxy_url(addr: &str, default_scheme: &str) -> String {
    if addr.contains("://") {
        addr.to_string()
    } else {
        format!("{default_scheme}://{addr}")
    }
}

#[cfg(target_os = "macos")]
fn get_system_proxy_impl() -> Result<Option<SystemProxyInfo>, AppError> {
    use std::process::Command;

    if let Some(info) = get_system_proxy_from_dynamic_store() {
        log::debug!("proxy:macos found proxy via SystemConfiguration");
        return Ok(Some(info));
    }

    // `scutil --proxy` returns the system-wide effective proxy settings from
    // the System Configuration framework — the same source browsers use,
    // regardless of which network service is active.
    let output = Command::new("scutil")
        .args(["--proxy"])
        .output()
        .map_err(|e| AppError::Io(format!("Failed to run scutil: {e}")))?;

    let text = String::from_utf8_lossy(&output.stdout);
    log::debug!("proxy:macos scutil output:\n{}", text);

    let props = parse_scutil_dict(&text);

    // Try HTTP proxy first (HTTPEnable + HTTPProxy + HTTPPort)
    if scutil_bool(&props, "HTTPEnable") {
        if let Some(info) = build_proxy_from_scutil(&props, "HTTPProxy", "HTTPPort", false) {
            log::debug!("proxy:macos found HTTP proxy");
            return Ok(Some(info));
        }
    }

    // Try HTTPS proxy (HTTPSEnable + HTTPSProxy + HTTPSPort)
    if scutil_bool(&props, "HTTPSEnable") {
        if let Some(info) = build_proxy_from_scutil(&props, "HTTPSProxy", "HTTPSPort", false) {
            log::debug!("proxy:macos found HTTPS proxy");
            return Ok(Some(info));
        }
    }

    // Try SOCKS proxy (SOCKSEnable + SOCKSProxy + SOCKSPort)
    if scutil_bool(&props, "SOCKSEnable") {
        if let Some(info) = build_proxy_from_scutil(&props, "SOCKSProxy", "SOCKSPort", true) {
            log::debug!("proxy:macos found SOCKS proxy");
            return Ok(Some(info));
        }
    }

    Ok(None)
}

#[cfg(target_os = "macos")]
type MacProxyDictionary = system_configuration::core_foundation::dictionary::CFDictionary<
    system_configuration::core_foundation::string::CFString,
    system_configuration::core_foundation::base::CFType,
>;

#[cfg(target_os = "macos")]
fn get_system_proxy_from_dynamic_store() -> Option<SystemProxyInfo> {
    use system_configuration::dynamic_store::SCDynamicStoreBuilder;

    let store = SCDynamicStoreBuilder::new("motrix-next").build()?;
    let proxies = store.get_proxies()?;

    if macos_cf_bool(&proxies, "HTTPEnable") {
        if let Some(info) = build_proxy_from_cf_dictionary(&proxies, "HTTPProxy", "HTTPPort", false)
        {
            return Some(info);
        }
    }

    if macos_cf_bool(&proxies, "HTTPSEnable") {
        if let Some(info) =
            build_proxy_from_cf_dictionary(&proxies, "HTTPSProxy", "HTTPSPort", false)
        {
            return Some(info);
        }
    }

    if macos_cf_bool(&proxies, "SOCKSEnable") {
        if let Some(info) =
            build_proxy_from_cf_dictionary(&proxies, "SOCKSProxy", "SOCKSPort", true)
        {
            return Some(info);
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn macos_cf_value<'a>(
    dict: &'a MacProxyDictionary,
    key: &str,
) -> Option<
    system_configuration::core_foundation::base::ItemRef<
        'a,
        system_configuration::core_foundation::base::CFType,
    >,
> {
    let key = system_configuration::core_foundation::string::CFString::new(key);
    dict.find(&key)
}

#[cfg(target_os = "macos")]
fn macos_cf_bool(dict: &MacProxyDictionary, key: &str) -> bool {
    macos_cf_i64(dict, key).is_some_and(|value| value == 1)
}

#[cfg(target_os = "macos")]
fn macos_cf_i64(dict: &MacProxyDictionary, key: &str) -> Option<i64> {
    macos_cf_value(dict, key)?
        .downcast::<system_configuration::core_foundation::number::CFNumber>()?
        .to_i64()
}

#[cfg(target_os = "macos")]
fn macos_cf_string(dict: &MacProxyDictionary, key: &str) -> Option<String> {
    Some(
        macos_cf_value(dict, key)?
            .downcast::<system_configuration::core_foundation::string::CFString>()?
            .to_string(),
    )
    .filter(|value| !value.trim().is_empty())
}

#[cfg(target_os = "macos")]
fn macos_cf_string_array(dict: &MacProxyDictionary, key: &str) -> Vec<String> {
    use system_configuration::core_foundation::array::CFArray;
    use system_configuration::core_foundation::base::{CFType, CFTypeRef, TCFType};
    use system_configuration::core_foundation::string::CFString;

    let Some(array) = macos_cf_value(dict, key).and_then(|value| value.downcast::<CFArray>())
    else {
        return Vec::new();
    };

    array
        .get_all_values()
        .into_iter()
        .filter_map(|value| {
            let cf_type = unsafe { CFType::wrap_under_get_rule(value as CFTypeRef) };
            cf_type
                .downcast::<CFString>()
                .map(|string| string.to_string())
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn format_macos_bypass(exceptions: Vec<String>, exclude_simple_hostnames: bool) -> String {
    let mut bypass = Vec::new();
    for exception in exceptions {
        let exception = exception.trim();
        if !exception.is_empty() && !bypass.iter().any(|item| item == exception) {
            bypass.push(exception.to_string());
        }
    }

    if exclude_simple_hostnames && !bypass.iter().any(|item| item == "<local>") {
        bypass.push("<local>".to_string());
    }

    bypass.join(",")
}

#[cfg(target_os = "macos")]
fn macos_cf_bypass(dict: &MacProxyDictionary) -> String {
    format_macos_bypass(
        macos_cf_string_array(dict, "ExceptionsList"),
        macos_cf_bool(dict, "ExcludeSimpleHostnames"),
    )
}

#[cfg(target_os = "macos")]
fn build_proxy_from_cf_dictionary(
    dict: &MacProxyDictionary,
    host_key: &str,
    port_key: &str,
    is_socks: bool,
) -> Option<SystemProxyInfo> {
    let host = macos_cf_string(dict, host_key)?;
    let port = macos_cf_i64(dict, port_key).unwrap_or_default();
    let scheme = if is_socks { "socks5" } else { "http" };
    let server = if port <= 0 {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    };

    Some(SystemProxyInfo {
        server,
        bypass: macos_cf_bypass(dict),
        is_socks,
    })
}

/// Parses `scutil --proxy` dictionary output into key-value pairs.
///
/// The format is `Key : Value`, one per line. Array entries and structural
/// lines (`<dictionary>`, `}`, numbered indices) are skipped.
#[cfg(target_os = "macos")]
fn parse_scutil_dict(text: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        // Skip structural and array-element lines
        if trimmed.starts_with('<') || trimmed == "}" {
            continue;
        }
        // Skip numbered array indices like "0 : 127.0.0.1"
        if trimmed.chars().next().is_none_or(|c| c.is_ascii_digit()) {
            continue;
        }
        if let Some((key, val)) = trimmed.split_once(':') {
            let key = key.trim().to_string();
            let val = val.trim().to_string();
            if !key.is_empty() {
                map.insert(key, val);
            }
        }
    }
    map
}

/// Returns `true` if the given key exists and equals `"1"`.
#[cfg(target_os = "macos")]
fn scutil_bool(props: &std::collections::HashMap<String, String>, key: &str) -> bool {
    props.get(key).is_some_and(|v| v == "1")
}

/// Builds a `SystemProxyInfo` from parsed scutil key-value pairs.
#[cfg(target_os = "macos")]
fn build_proxy_from_scutil(
    props: &std::collections::HashMap<String, String>,
    host_key: &str,
    port_key: &str,
    is_socks: bool,
) -> Option<SystemProxyInfo> {
    let host = props.get(host_key)?.trim().to_string();
    if host.is_empty() {
        return None;
    }
    let port = props
        .get(port_key)
        .map(|p| p.trim().to_string())
        .unwrap_or_default();
    let scheme = if is_socks { "socks5" } else { "http" };
    let server = if port.is_empty() || port == "0" {
        format!("{scheme}://{host}")
    } else {
        format!("{scheme}://{host}:{port}")
    };

    Some(SystemProxyInfo {
        server,
        bypass: String::new(),
        is_socks,
    })
}

#[cfg(target_os = "linux")]
fn get_system_proxy_impl() -> Result<Option<SystemProxyInfo>, AppError> {
    // Layer 1: Environment variables — universal across all distros / DEs
    if let Some(info) = proxy_from_env() {
        return Ok(Some(info));
    }

    // Layer 2: GNOME gsettings — desktop-specific, may not be available
    if let Some(info) = proxy_from_gsettings() {
        return Ok(Some(info));
    }

    // Layer 3: all_proxy / ALL_PROXY — catch-all fallback
    if let Some(val) = read_env_ci("all_proxy") {
        log::debug!("proxy:linux all_proxy={:?}", val);
        let is_socks = val.to_lowercase().starts_with("socks");
        return Ok(Some(SystemProxyInfo {
            server: val,
            bypass: read_env_ci("no_proxy").unwrap_or_default(),
            is_socks,
        }));
    }

    Ok(None)
}

/// Reads an environment variable case-insensitively (tries lowercase first,
/// then uppercase). Returns `None` if both are unset or empty.
#[cfg(target_os = "linux")]
fn read_env_ci(name: &str) -> Option<String> {
    use std::env;
    let lower = env::var(name).ok().filter(|s| !s.trim().is_empty());
    if lower.is_some() {
        return lower;
    }
    env::var(name.to_uppercase())
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// Attempts to detect proxy from `http_proxy` / `https_proxy` env vars.
#[cfg(target_os = "linux")]
fn proxy_from_env() -> Option<SystemProxyInfo> {
    let bypass = read_env_ci("no_proxy").unwrap_or_default();

    // Prefer http_proxy
    if let Some(val) = read_env_ci("http_proxy") {
        log::debug!("proxy:linux http_proxy={:?}", val);
        let is_socks = val.to_lowercase().starts_with("socks");
        return Some(SystemProxyInfo {
            server: val,
            bypass,
            is_socks,
        });
    }

    // Fall back to https_proxy
    if let Some(val) = read_env_ci("https_proxy") {
        log::debug!("proxy:linux https_proxy={:?}", val);
        let is_socks = val.to_lowercase().starts_with("socks");
        return Some(SystemProxyInfo {
            server: val,
            bypass,
            is_socks,
        });
    }

    None
}

/// Attempts to detect proxy from GNOME gsettings.
///
/// Returns `None` (instead of `Err`) when gsettings is unavailable — this
/// allows non-GNOME desktops (KDE, headless servers) to gracefully skip.
#[cfg(target_os = "linux")]
fn proxy_from_gsettings() -> Option<SystemProxyInfo> {
    let mode = try_gsettings_get("org.gnome.system.proxy", "mode")?;
    let mode = mode.trim().trim_matches('\'').to_string();
    log::debug!("proxy:linux gsettings mode={:?}", mode);
    if mode != "manual" {
        return None;
    }

    // HTTP proxy
    let host = try_gsettings_get("org.gnome.system.proxy.http", "host")?
        .trim()
        .trim_matches('\'')
        .to_string();
    if !host.is_empty() {
        let port = try_gsettings_get("org.gnome.system.proxy.http", "port")
            .unwrap_or_default()
            .trim()
            .trim_matches('\'')
            .to_string();
        let server = if port.is_empty() || port == "0" {
            format!("http://{host}")
        } else {
            format!("http://{host}:{port}")
        };
        let ignore_hosts =
            try_gsettings_get("org.gnome.system.proxy", "ignore-hosts").unwrap_or_default();
        let bypass = parse_gnome_ignore_hosts(&ignore_hosts);
        log::debug!(
            "proxy:linux gsettings HTTP server={} bypass={}",
            server,
            bypass
        );
        return Some(SystemProxyInfo {
            server,
            bypass,
            is_socks: false,
        });
    }

    // SOCKS proxy
    let socks_host = try_gsettings_get("org.gnome.system.proxy.socks", "host")?
        .trim()
        .trim_matches('\'')
        .to_string();
    if !socks_host.is_empty() {
        let socks_port = try_gsettings_get("org.gnome.system.proxy.socks", "port")
            .unwrap_or_default()
            .trim()
            .trim_matches('\'')
            .to_string();
        let server = if socks_port.is_empty() || socks_port == "0" {
            format!("socks5://{socks_host}")
        } else {
            format!("socks5://{socks_host}:{socks_port}")
        };
        log::debug!("proxy:linux gsettings SOCKS server={}", server);
        return Some(SystemProxyInfo {
            server,
            bypass: String::new(),
            is_socks: true,
        });
    }

    None
}

/// Runs `gsettings get <schema> <key>` and returns stdout.
///
/// Returns `None` if the command fails to execute (e.g. gsettings not installed
/// on KDE) or if it exits with a non-zero status. This is intentionally
/// non-fatal so the detection chain can continue to other sources.
#[cfg(target_os = "linux")]
fn try_gsettings_get(schema: &str, key: &str) -> Option<String> {
    use std::process::Command;
    let output = Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !output.status.success() {
        log::debug!(
            "proxy:linux gsettings {} {} → exit code {:?}",
            schema,
            key,
            output.status.code()
        );
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(target_os = "linux")]
fn parse_gnome_ignore_hosts(raw: &str) -> String {
    // gsettings returns: ['localhost', '127.0.0.0/8', '::1']
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().trim_matches('\'').trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

// Fallback for unsupported platforms (FreeBSD, etc.)
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn get_system_proxy_impl() -> Result<Option<SystemProxyInfo>, AppError> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_proxy_info_serializes_to_camel_case() {
        let info = SystemProxyInfo {
            server: "http://127.0.0.1:7890".into(),
            bypass: "*.local".into(),
            is_socks: false,
        };
        let json = serde_json::to_string(&info).expect("SystemProxyInfo should serialize");
        assert!(json.contains("\"isSocks\""));
        assert!(json.contains("\"server\""));
        assert!(json.contains("\"bypass\""));
    }

    #[test]
    fn get_system_proxy_does_not_panic() {
        // Must not panic on any platform, even if no proxy is configured
        let result = get_system_proxy();
        assert!(result.is_ok());
    }

    // ── Windows helper tests ────────────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_windows_uniform_bare_host_port() {
        let (server, is_socks) = parse_windows_proxy_server("127.0.0.1:7890");
        assert_eq!(server, "http://127.0.0.1:7890");
        assert!(!is_socks);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_windows_uniform_with_scheme() {
        let (server, is_socks) = parse_windows_proxy_server("http://10.0.0.1:8080");
        assert_eq!(server, "http://10.0.0.1:8080");
        assert!(!is_socks);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_windows_uniform_socks() {
        let (server, is_socks) = parse_windows_proxy_server("socks5://127.0.0.1:1080");
        assert_eq!(server, "socks5://127.0.0.1:1080");
        assert!(is_socks);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_windows_multi_protocol_extracts_http() {
        let raw = "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080";
        let (server, is_socks) = parse_windows_proxy_server(raw);
        assert_eq!(server, "http://127.0.0.1:7890");
        assert!(!is_socks);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_windows_multi_protocol_falls_back_to_https() {
        let raw = "https=10.0.0.1:443;custom=10.0.0.1:21";
        let (server, is_socks) = parse_windows_proxy_server(raw);
        assert_eq!(server, "http://10.0.0.1:443");
        assert!(!is_socks);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parse_windows_multi_protocol_socks_only() {
        let raw = "socks=192.168.1.1:1080";
        let (server, is_socks) = parse_windows_proxy_server(raw);
        assert_eq!(server, "socks5://192.168.1.1:1080");
        assert!(is_socks);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn format_proxy_url_adds_scheme_when_missing() {
        assert_eq!(format_proxy_url("1.2.3.4:80", "http"), "http://1.2.3.4:80");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn format_proxy_url_preserves_existing_scheme() {
        assert_eq!(
            format_proxy_url("socks5://1.2.3.4:1080", "http"),
            "socks5://1.2.3.4:1080"
        );
    }

    // ── macOS helper tests ──────────────────────────────────────────

    #[cfg(target_os = "macos")]
    #[test]
    fn parse_scutil_dict_extracts_proxy_keys() {
        let output = r#"<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}
"#;
        let props = parse_scutil_dict(output);
        assert_eq!(props.get("HTTPEnable").expect("HTTPEnable"), "1");
        assert_eq!(props.get("HTTPProxy").expect("HTTPProxy"), "127.0.0.1");
        assert_eq!(props.get("HTTPPort").expect("HTTPPort"), "7897");
        assert_eq!(props.get("SOCKSEnable").expect("SOCKSEnable"), "0");
        // Array indices should be skipped
        assert!(!props.contains_key("0"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_proxy_from_scutil_constructs_http_url() {
        let mut props = std::collections::HashMap::new();
        props.insert("HTTPProxy".into(), "10.0.0.1".into());
        props.insert("HTTPPort".into(), "8080".into());
        let info = build_proxy_from_scutil(&props, "HTTPProxy", "HTTPPort", false)
            .expect("HTTP proxy should be built");
        assert_eq!(info.server, "http://10.0.0.1:8080");
        assert!(!info.is_socks);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_proxy_from_scutil_returns_none_for_missing_host() {
        let props = std::collections::HashMap::new();
        assert!(build_proxy_from_scutil(&props, "HTTPProxy", "HTTPPort", false).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn format_macos_bypass_combines_exceptions_and_simple_hosts() {
        let bypass = format_macos_bypass(vec!["localhost".into(), "*.local".into()], true);
        assert_eq!(bypass, "localhost,*.local,<local>");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_proxy_from_cf_dictionary_includes_bypass_rules() {
        use system_configuration::core_foundation::array::CFArray;
        use system_configuration::core_foundation::base::TCFType;
        use system_configuration::core_foundation::dictionary::CFDictionary;
        use system_configuration::core_foundation::number::CFNumber;
        use system_configuration::core_foundation::string::CFString;

        let exceptions =
            CFArray::from_CFTypes(&[CFString::new("localhost"), CFString::new("*.local")]);
        let dict = CFDictionary::from_CFType_pairs(&[
            (
                CFString::new("HTTPProxy"),
                CFString::new("127.0.0.1").as_CFType(),
            ),
            (CFString::new("HTTPPort"), CFNumber::from(7890).as_CFType()),
            (CFString::new("ExceptionsList"), exceptions.as_CFType()),
            (
                CFString::new("ExcludeSimpleHostnames"),
                CFNumber::from(1).as_CFType(),
            ),
        ]);

        let info = build_proxy_from_cf_dictionary(&dict, "HTTPProxy", "HTTPPort", false)
            .expect("HTTP proxy should be built");

        assert_eq!(info.server, "http://127.0.0.1:7890");
        assert_eq!(info.bypass, "localhost,*.local,<local>");
        assert!(!info.is_socks);
    }

    // ── Linux helper tests ──────────────────────────────────────────

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_gnome_ignore_hosts_parses_array() {
        let raw = "['localhost', '127.0.0.0/8', '::1']";
        assert_eq!(parse_gnome_ignore_hosts(raw), "localhost,127.0.0.0/8,::1");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_gnome_ignore_hosts_handles_empty() {
        assert_eq!(parse_gnome_ignore_hosts("[]"), "");
    }
}
