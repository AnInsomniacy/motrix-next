/// Builds the CLI argument list for spawning the aria2c sidecar process.
///
/// Whitelists only valid aria2c options from the config object and handles
/// the `keep-seeding` app-level flag. Options managed exclusively by
/// `aria2.conf` (e.g., `bt-save-metadata`, `rpc-listen-all`) are excluded
/// from the whitelist to prevent store overrides.
pub(crate) fn build_start_args(
    config: &serde_json::Value,
    conf_path: Option<&str>,
    session_path: &str,
    session_exists: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    // Load bundled config file if available
    if let Some(path) = conf_path {
        args.push(format!("--conf-path={}", path));
    }

    // Session persistence: save active/paused downloads, restore on restart
    args.push(format!("--save-session={}", session_path));
    if session_exists {
        args.push(format!("--input-file={}", session_path));
    }

    // Whitelist: only valid aria2c CLI options (from configKeys.ts systemKeys)
    const VALID_ARIA2_KEYS: &[&str] = &[
        "all-proxy-passwd",
        "all-proxy-user",
        "all-proxy",
        "allow-overwrite",
        "allow-piece-length-change",
        "always-resume",
        "async-dns",
        "auto-file-renaming",
        "bt-enable-hook-after-hash-check",
        "bt-enable-lpd",
        "bt-exclude-tracker",
        "bt-external-ip",
        "bt-force-encryption",
        "bt-hash-check-seed",
        "bt-max-peers",
        "bt-metadata-only",
        "bt-min-crypto-level",
        "bt-prioritize-piece",
        "bt-remove-unselected-file",
        "bt-request-peer-speed-limit",
        "bt-require-crypto",
        "bt-seed-unverified",
        "bt-stop-timeout",
        "bt-tracker-connect-timeout",
        "bt-tracker-interval",
        "bt-tracker-timeout",
        "bt-tracker",
        "check-integrity",
        "checksum",
        "conditional-get",
        "connect-timeout",
        "content-disposition-default-utf8",
        "continue",
        "dht-file-path",
        "dht-file-path6",
        "dht-listen-port",
        "dir",
        "dry-run",
        "enable-dht",
        "enable-http-keep-alive",
        "enable-http-pipelining",
        "enable-mmap",
        "enable-peer-exchange",
        "file-allocation",
        "follow-metalink",
        "follow-torrent",
        "force-save",
        "force-sequential",
        "ftp-passwd",
        "ftp-pasv",
        "ftp-proxy-passwd",
        "ftp-proxy-user",
        "ftp-proxy",
        "ftp-reuse-connection",
        "ftp-type",
        "ftp-user",
        "gid",
        "hash-check-only",
        "header",
        "http-accept-gzip",
        "http-auth-challenge",
        "http-no-cache",
        "http-passwd",
        "http-proxy-passwd",
        "http-proxy-user",
        "http-proxy",
        "http-user",
        "https-proxy-passwd",
        "https-proxy-user",
        "https-proxy",
        "index-out",
        "listen-port",
        "log-level",
        "lowest-speed-limit",
        "max-concurrent-downloads",
        "max-connection-per-server",
        "max-download-limit",
        "max-file-not-found",
        "max-mmap-limit",
        "max-overall-download-limit",
        "max-overall-upload-limit",
        "max-resume-failure-tries",
        "max-tries",
        "max-upload-limit",
        "min-split-size",
        "no-file-allocation-limit",
        "no-netrc",
        "no-proxy",
        "no-want-digest-header",
        "out",
        "parameterized-uri",
        "pause-metadata",
        "pause",
        "piece-length",
        "proxy-method",
        "realtime-chunk-checksum",
        "referer",
        "remote-time",
        "remove-control-file",
        "retry-wait",
        "reuse-uri",
        "rpc-listen-port",
        "rpc-save-upload-metadata",
        "rpc-secret",
        "seed-ratio",
        "seed-time",
        "select-file",
        "split",
        "ssh-host-key-md",
        "stream-piece-selector",
        "timeout",
        "uri-selector",
        "use-head",
        "user-agent",
    ];

    // Check keep-seeding flag (app-level logic, not aria2c option)
    // Frontend sends String("true"/"false"), so handle both Bool and String
    let keep_seeding = config
        .get("keep-seeding")
        .map(|v| match v {
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::String(s) => s == "true",
            _ => false,
        })
        .unwrap_or(false);

    if let Some(obj) = config.as_object() {
        for (key, value) in obj {
            // Only pass whitelisted aria2c keys
            if !VALID_ARIA2_KEYS.contains(&key.as_str()) {
                continue;
            }

            // Handle keep-seeding: skip seed-time if keep_seeding is true
            if keep_seeding && key == "seed-time" {
                continue;
            }

            let val_str = match value {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                _ => continue,
            };

            // Skip empty values
            if val_str.is_empty() {
                continue;
            }

            // Handle keep-seeding: override seed-ratio to 0
            if keep_seeding && key == "seed-ratio" {
                args.push("--seed-ratio=0".to_string());
                continue;
            }

            args.push(format!("--{}={}", key, val_str));
        }
    }

    // If no conf file, ensure RPC is enabled
    if conf_path.is_none() {
        args.push("--enable-rpc=true".to_string());
        args.push("--rpc-allow-origin-all=true".to_string());
    }

    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_args_passes_whitelisted_keys() {
        let config = json!({ "dir": "/tmp", "split": 16 });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(args.iter().any(|a| a == "--dir=/tmp"));
        assert!(args.iter().any(|a| a == "--split=16"));
    }

    #[test]
    fn build_args_rejects_non_whitelisted_keys() {
        let config = json!({ "dir": "/tmp", "not-a-real-key": "value", "keep-seeding": true });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("not-a-real-key")));
        assert!(!args.iter().any(|a| a.contains("keep-seeding")));
    }

    #[test]
    fn build_args_excludes_conf_only_keys() {
        // bt-save-metadata and bt-load-saved-metadata are set in aria2.conf,
        // not in the CLI whitelist — store values must never override them
        let config = json!({
            "bt-save-metadata": "false",
            "bt-load-saved-metadata": "false"
        });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("bt-save-metadata")));
        assert!(!args.iter().any(|a| a.contains("bt-load-saved-metadata")));
    }

    #[test]
    fn build_args_keep_seeding_skips_seed_time() {
        let config = json!({ "keep-seeding": true, "seed-time": "60" });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("seed-time")));
    }

    #[test]
    fn build_args_keep_seeding_overrides_seed_ratio() {
        let config = json!({ "keep-seeding": true, "seed-ratio": "1.0" });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(args.iter().any(|a| a == "--seed-ratio=0"));
    }

    #[test]
    fn build_args_skips_empty_values() {
        let config = json!({ "dir": "" });
        let args = build_start_args(&config, None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("--dir=")));
    }

    #[test]
    fn build_args_loads_session_on_exists() {
        let args = build_start_args(&json!({}), None, "/tmp/s.session", true);
        assert!(args.iter().any(|a| a == "--input-file=/tmp/s.session"));
        assert!(args.iter().any(|a| a == "--save-session=/tmp/s.session"));
    }

    #[test]
    fn build_args_no_input_file_when_no_session() {
        let args = build_start_args(&json!({}), None, "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("input-file")));
        assert!(args.iter().any(|a| a == "--save-session=/tmp/s.session"));
    }

    #[test]
    fn build_args_includes_conf_path() {
        let args = build_start_args(&json!({}), Some("/etc/aria2.conf"), "/tmp/s.session", false);
        assert!(args.iter().any(|a| a == "--conf-path=/etc/aria2.conf"));
    }

    #[test]
    fn build_args_enables_rpc_without_conf() {
        let args = build_start_args(&json!({}), None, "/tmp/s.session", false);
        assert!(args.iter().any(|a| a == "--enable-rpc=true"));
        assert!(args.iter().any(|a| a == "--rpc-allow-origin-all=true"));
    }

    #[test]
    fn build_args_no_rpc_enable_with_conf() {
        let args = build_start_args(&json!({}), Some("/etc/aria2.conf"), "/tmp/s.session", false);
        assert!(!args.iter().any(|a| a.contains("enable-rpc")));
    }

    #[test]
    fn build_args_keep_seeding_string_true() {
        // Frontend sends String("true"), not Bool(true)
        let config = json!({ "keep-seeding": "true", "seed-time": "30", "seed-ratio": "1.5" });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(!args.iter().any(|a| a.starts_with("--seed-time")));
        assert!(args.iter().any(|a| a == "--seed-ratio=0"));
    }

    #[test]
    fn build_args_keep_seeding_string_false_passes_seed_values() {
        let config = json!({ "keep-seeding": "false", "seed-time": "30", "seed-ratio": "1.5" });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(args.iter().any(|a| a == "--seed-time=30"));
        assert!(args.iter().any(|a| a == "--seed-ratio=1.5"));
    }

    #[test]
    fn build_args_no_keep_seeding_passes_seed_values() {
        // When keep-seeding is absent entirely, seed values should pass through
        let config = json!({ "seed-time": "60", "seed-ratio": "2.0" });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(args.iter().any(|a| a == "--seed-time=60"));
        assert!(args.iter().any(|a| a == "--seed-ratio=2.0"));
    }

    #[test]
    fn build_args_boolean_true_value_coerced() {
        let config = json!({ "continue": true });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(args.iter().any(|a| a == "--continue=true"));
    }

    #[test]
    fn build_args_boolean_false_value_coerced() {
        let config = json!({ "continue": false });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(args.iter().any(|a| a == "--continue=false"));
    }

    #[test]
    fn build_args_numeric_value_coerced() {
        let config = json!({ "max-concurrent-downloads": 5 });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(args.iter().any(|a| a == "--max-concurrent-downloads=5"));
    }

    #[test]
    fn build_args_excludes_conf_path_when_none() {
        let args = build_start_args(&json!({}), None, "/tmp/s", false);
        assert!(!args.iter().any(|a| a.starts_with("--conf-path")));
    }

    #[test]
    fn build_args_null_and_array_values_skipped() {
        let config = json!({ "dir": null, "header": ["X-Custom: val"] });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(!args.iter().any(|a| a.contains("--dir=")));
        // Arrays are not handled by the match — skipped via `_ => continue`
        assert!(!args.iter().any(|a| a.contains("--header=")));
    }

    #[test]
    fn build_args_force_save_true_persists_seeding_tasks() {
        // force-save=true is essential for BT seeding persistence.
        // Without it, aria2's SessionSerializer skips FINISHED (seeding) tasks.
        let config = json!({ "force-save": true });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(args.iter().any(|a| a == "--force-save=true"));
    }

    #[test]
    fn build_args_force_save_string_true_also_works() {
        // Frontend may send String("true") instead of Bool(true)
        let config = json!({ "force-save": "true" });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(args.iter().any(|a| a == "--force-save=true"));
    }

    #[test]
    fn build_args_no_force_save_when_absent() {
        let config = json!({ "dir": "/tmp" });
        let args = build_start_args(&config, None, "/tmp/s", false);
        assert!(!args.iter().any(|a| a.contains("force-save")));
    }
}
