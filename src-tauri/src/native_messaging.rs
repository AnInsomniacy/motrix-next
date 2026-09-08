use std::fs;
use std::io;
#[cfg(not(windows))]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use motrix_next_browser_launcher::{
    chromium_manifest_json, firefox_manifest_json, HOST_NAME, LAUNCHER_FILE_STEM,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManifestKind {
    Chromium,
    Firefox,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManifestDestination {
    browser: &'static str,
    kind: ManifestKind,
    path: PathBuf,
    #[cfg(windows)]
    registry_key: String,
}

impl ManifestDestination {
    fn content(&self, launcher: &Path) -> Result<Vec<u8>, RegistrationError> {
        #[cfg(windows)]
        let launcher = {
            let _ = launcher;
            Path::new(r"..\..\motrix-next-browser-launcher.exe")
        };
        let content = match self.kind {
            ManifestKind::Chromium => chromium_manifest_json(launcher),
            ManifestKind::Firefox => firefox_manifest_json(launcher),
        };
        operation(
            "serialize_manifest",
            &self.path,
            content.map_err(io::Error::other),
        )
    }

    fn repair(&self, launcher: &Path) -> Result<bool, RegistrationError> {
        let content = self.content(launcher)?;
        #[cfg(not(windows))]
        {
            write_if_changed(&self.path, &content)
        }
        #[cfg(windows)]
        {
            let actual = read_optional(&self.path)?;
            if actual
                .as_deref()
                .map(parse_manifest)
                .transpose()
                .map_err(|error| RegistrationError::new("parse_manifest", &self.path, error))?
                != Some(
                    parse_manifest(&content).map_err(|error| {
                        RegistrationError::new("parse_manifest", &self.path, error)
                    })?,
                )
            {
                return Err(RegistrationError::new(
                    "validate_manifest",
                    &self.path,
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Bundled manifest does not match the compiled contract",
                    ),
                ));
            }
            let expected = path_to_string(&self.path)?;
            if self.registry_value()?.as_deref() == Some(expected.as_str()) {
                return Ok(false);
            }
            use winreg::{
                enums::{HKEY_CURRENT_USER, KEY_WOW64_64KEY, KEY_WRITE},
                RegKey,
            };
            let (key, _) = operation(
                "create_registry_key",
                Path::new(&self.registry_key),
                RegKey::predef(HKEY_CURRENT_USER)
                    .create_subkey_with_flags(&self.registry_key, KEY_WRITE | KEY_WOW64_64KEY),
            )?;
            operation(
                "write_registry_value",
                Path::new(&self.registry_key),
                key.set_value("", &expected),
            )?;
            Ok(true)
        }
    }

    #[cfg(windows)]
    fn registry_value(&self) -> Result<Option<String>, RegistrationError> {
        use winreg::{
            enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WOW64_64KEY},
            RegKey,
        };
        let key = match RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(&self.registry_key, KEY_READ | KEY_WOW64_64KEY)
        {
            Ok(key) => key,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(RegistrationError::new(
                    "read_registry_key",
                    Path::new(&self.registry_key),
                    error,
                ))
            }
        };
        match key.get_value("") {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(RegistrationError::new(
                "read_registry_value",
                Path::new(&self.registry_key),
                error,
            )),
        }
    }

    fn inspect(&self, launcher: &Path) -> Value {
        let result = (|| {
            let actual = read_optional(&self.path)?;
            let Some(actual) = actual else {
                return Ok(json!({ "status": "missing" }));
            };
            let actual = operation("parse_manifest", &self.path, parse_manifest(&actual))?;
            let expected = operation(
                "parse_manifest",
                &self.path,
                parse_manifest(&self.content(launcher)?),
            )?;
            Ok::<_, RegistrationError>(json!({
                "status": if actual == expected { "valid" } else { "mismatch" },
                "launcher_path": actual.get("path").and_then(Value::as_str).map(redact),
            }))
        })();
        let mut state = match result {
            Ok(state) => state,
            Err(error) => json!({ "status": "error", "error": error.details() }),
        };
        state["browser"] = json!(self.browser);
        state["path"] = json!(redact(&self.path.to_string_lossy()));
        #[cfg(windows)]
        {
            // Inspect the registry even when the bundled manifest is missing or invalid.
            state["registry"] = match self
                .registry_value()
                .and_then(|value| Ok((value, path_to_string(&self.path)?)))
            {
                Ok((value, expected)) => json!({
                    "hive": "HKCU", "view": "64-bit", "key": self.registry_key,
                    "matches": value.as_deref() == Some(expected.as_str()),
                    "value": value.as_deref().map(redact),
                }),
                Err(error) => json!({ "hive": "HKCU", "view": "64-bit", "error": error.details() }),
            };
        }
        state
    }
}

/// Preserve the native error until the logging/diagnostic boundary.
#[derive(Debug, thiserror::Error)]
#[error("{stage}: {source}")]
struct RegistrationError {
    stage: &'static str,
    path: PathBuf,
    #[source]
    source: io::Error,
}

impl RegistrationError {
    fn new(stage: &'static str, path: &Path, source: io::Error) -> Self {
        Self {
            stage,
            path: path.to_path_buf(),
            source,
        }
    }

    fn details(&self) -> Failure {
        Failure {
            stage: self.stage,
            path: redact(&self.path.to_string_lossy()),
            error_kind: format!("{:?}", self.source.kind()),
            os_code: self.source.raw_os_error(),
            message: redact(&self.source.to_string()),
        }
    }
}

fn operation<T>(
    stage: &'static str,
    path: &Path,
    result: io::Result<T>,
) -> Result<T, RegistrationError> {
    result.map_err(|error| RegistrationError::new(stage, path, error))
}

fn redact(value: &str) -> String {
    let value = match dirs::home_dir() {
        Some(home) => value.replace(home.to_string_lossy().as_ref(), "~"),
        None => value.to_string(),
    };
    value
        .chars()
        .take(1024)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
struct Failure {
    stage: &'static str,
    path: String,
    error_kind: String,
    os_code: Option<i32>,
    message: String,
}

impl Failure {
    fn log(&self, browser: &str) {
        log::warn!(
            target: "native_messaging",
            event = "registration_failed", browser, stage = self.stage,
            path = self.path.as_str(), error_kind = self.error_kind.as_str(),
            os_code = self.os_code, error = self.message.as_str();
            "registration_failed"
        );
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum RegistrationStatus {
    Unchanged,
    Repaired,
    Failed,
}

#[derive(Debug, Serialize)]
struct BrowserResult {
    browser: &'static str,
    status: RegistrationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Failure>,
}

#[derive(Debug, Serialize)]
struct RegistrationReport {
    checked_at: String,
    targets: Vec<BrowserResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shared_error: Option<Failure>,
}

#[derive(Default)]
struct RegistrationState(OnceLock<RegistrationReport>);

struct Installation {
    bundled: PathBuf,
    launcher: PathBuf,
    targets: Vec<ManifestDestination>,
}

pub fn schedule_repair(app: &AppHandle) {
    app.manage(RegistrationState::default());
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let report = match installation(&app).and_then(|installation| {
            check_executable(&installation.bundled)?;
            #[cfg(target_os = "linux")]
            if installation.bundled != installation.launcher {
                copy_executable_if_changed(&installation.bundled, &installation.launcher)?;
                check_executable(&installation.launcher)?;
            }
            Ok(repair_targets(
                &installation.targets,
                &installation.launcher,
            ))
        }) {
            Ok(report) => report,
            Err(error) => {
                let failure = error.details();
                failure.log("shared");
                RegistrationReport {
                    checked_at: chrono::Utc::now().to_rfc3339(),
                    targets: Vec::new(),
                    shared_error: Some(failure),
                }
            }
        };
        let _ = app.state::<RegistrationState>().0.set(report);
    });
}

fn repair_targets(targets: &[ManifestDestination], launcher: &Path) -> RegistrationReport {
    let results: Vec<_> = targets
        .iter()
        .map(|target| {
            let (status, error) = match target.repair(launcher) {
                Ok(true) => (RegistrationStatus::Repaired, None),
                Ok(false) => (RegistrationStatus::Unchanged, None),
                Err(error) => {
                    let failure = error.details();
                    failure.log(target.browser);
                    (RegistrationStatus::Failed, Some(failure))
                }
            };
            BrowserResult {
                browser: target.browser,
                status,
                error,
            }
        })
        .collect();
    let repaired = results
        .iter()
        .filter(|r| matches!(r.status, RegistrationStatus::Repaired))
        .count();
    let failed = results
        .iter()
        .filter(|r| matches!(r.status, RegistrationStatus::Failed))
        .count();
    log::info!(
        target: "native_messaging", event = "registration_checked",
        repaired, failed, unchanged = results.len() - repaired - failed;
        "registration_checked"
    );
    RegistrationReport {
        checked_at: chrono::Utc::now().to_rfc3339(),
        targets: results,
        shared_error: None,
    }
}

/// Inspect only our own files. Export must never perform registration or activation.
pub async fn diagnostic_snapshot(app: &AppHandle) -> Value {
    let app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || {
        let startup = app.try_state::<RegistrationState>().and_then(|state| {
            state.0.get().map(|report| json!({
                "status": if report.shared_error.is_some() { "not_attempted" } else { "completed" },
                "report": report,
            }))
        }).unwrap_or_else(|| json!({ "status": "pending" }));
        let current = match installation(&app) {
            Ok(installation) => json!({
                "launcher": inspect_executable(&installation.launcher),
                "manifests": installation.targets.iter().map(|t| t.inspect(&installation.launcher)).collect::<Vec<_>>(),
            }),
            Err(error) => json!({ "error": error.details() }),
        };
        json!({ "host": HOST_NAME, "startup": startup, "current": current })
    }).await {
        Ok(value) => value,
        Err(error) => json!({ "error": { "stage": "inspect_registration", "message": redact(&error.to_string()) } }),
    }
}

fn installation(app: &AppHandle) -> Result<Installation, RegistrationError> {
    let current = operation("resolve_executable", Path::new(""), std::env::current_exe())?;
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let bundled = current.with_file_name(format!("{LAUNCHER_FILE_STEM}{extension}"));
    #[cfg(target_os = "linux")]
    let launcher = if app.env().appimage.is_some() {
        operation(
            "resolve_app_data",
            &bundled,
            app.path().app_data_dir().map_err(io::Error::other),
        )?
        .join("native-messaging")
        .join(LAUNCHER_FILE_STEM)
    } else {
        bundled.clone()
    };
    #[cfg(not(target_os = "linux"))]
    let launcher = bundled.clone();

    #[cfg(not(windows))]
    let targets = {
        let _ = app;
        let home = dirs::home_dir().ok_or_else(|| {
            RegistrationError::new(
                "resolve_home",
                Path::new(""),
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "User home directory is unavailable",
                ),
            )
        })?;
        let config = dirs::config_dir().ok_or_else(|| {
            RegistrationError::new(
                "resolve_config",
                Path::new(""),
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "User config directory is unavailable",
                ),
            )
        })?;
        manifest_destinations(std::env::consts::OS, &home, &config)
    };
    #[cfg(windows)]
    let targets = {
        let resources = operation(
            "resolve_resources",
            &bundled,
            app.path().resource_dir().map_err(io::Error::other),
        )?;
        [
            (
                "chrome",
                ManifestKind::Chromium,
                "chromium.json",
                "Google\\Chrome",
            ),
            (
                "edge",
                ManifestKind::Chromium,
                "chromium.json",
                "Microsoft\\Edge",
            ),
            ("firefox", ManifestKind::Firefox, "firefox.json", "Mozilla"),
        ]
        .into_iter()
        .map(|(browser, kind, file, key)| ManifestDestination {
            browser,
            kind,
            path: resources.join("native-messaging/manifests").join(file),
            registry_key: format!("Software\\{key}\\NativeMessagingHosts\\{HOST_NAME}"),
        })
        .collect()
    };
    Ok(Installation {
        bundled,
        launcher,
        targets,
    })
}

fn check_executable(path: &Path) -> Result<fs::Metadata, RegistrationError> {
    let metadata = operation("inspect_launcher", path, fs::metadata(path))?;
    if !metadata.is_file() {
        return Err(RegistrationError::new(
            "inspect_launcher",
            path,
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Launcher is not a regular file",
            ),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(RegistrationError::new(
                "inspect_launcher",
                path,
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Launcher has no executable permission bits",
                ),
            ));
        }
    }
    Ok(metadata)
}

fn inspect_executable(path: &Path) -> Value {
    match check_executable(path) {
        Ok(metadata) => {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                Some(format!("{:o}", metadata.permissions().mode() & 0o777))
            };
            #[cfg(not(unix))]
            let mode: Option<String> = None;
            json!({ "path": redact(&path.to_string_lossy()), "status": "present", "bytes": metadata.len(), "mode": mode })
        }
        Err(error) => {
            json!({ "path": redact(&path.to_string_lossy()), "status": "error", "error": error.details() })
        }
    }
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, RegistrationError> {
    match fs::read(path) {
        Ok(content) => Ok(Some(content)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(RegistrationError::new("read_file", path, error)),
    }
}

fn parse_manifest(content: &[u8]) -> io::Result<Value> {
    serde_json::from_slice(content)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(not(windows))]
fn write_if_changed(path: &Path, content: &[u8]) -> Result<bool, RegistrationError> {
    if read_optional(path)?.as_deref() == Some(content) {
        return Ok(false);
    }
    write_atomic(path, content, false)?;
    Ok(true)
}

#[cfg(not(windows))]
fn write_atomic(path: &Path, content: &[u8], executable: bool) -> Result<(), RegistrationError> {
    let parent = path.parent().ok_or_else(|| {
        RegistrationError::new(
            "create_directory",
            path,
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Destination has no parent directory",
            ),
        )
    })?;
    operation("create_directory", parent, fs::create_dir_all(parent))?;
    let mut temporary = operation(
        "create_temporary_file",
        parent,
        tempfile::NamedTempFile::new_in(parent),
    )?;
    operation("write_file", path, temporary.write_all(content))?;
    if executable {
        use std::os::unix::fs::PermissionsExt;
        operation(
            "set_permissions",
            path,
            temporary
                .as_file()
                .set_permissions(fs::Permissions::from_mode(0o755)),
        )?;
    }
    operation("sync_file", path, temporary.as_file().sync_all())?;
    operation(
        "replace_file",
        path,
        temporary.persist(path).map_err(|error| error.error),
    )?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn copy_executable_if_changed(source: &Path, destination: &Path) -> Result<(), RegistrationError> {
    use std::os::unix::fs::PermissionsExt;
    let content = operation("read_launcher", source, fs::read(source))?;
    if read_optional(destination)?.as_deref() == Some(content.as_slice()) {
        let metadata = operation("inspect_launcher", destination, fs::metadata(destination))?;
        if metadata.permissions().mode() & 0o111 == 0 {
            operation(
                "set_permissions",
                destination,
                fs::set_permissions(destination, fs::Permissions::from_mode(0o755)),
            )?;
        }
        return Ok(());
    }
    write_atomic(destination, &content, true)
}

#[cfg(windows)]
fn path_to_string(path: &Path) -> Result<String, RegistrationError> {
    dunce::simplified(path)
        .to_str()
        .map(ToString::to_string)
        .ok_or_else(|| {
            RegistrationError::new(
                "resolve_path",
                path,
                io::Error::new(io::ErrorKind::InvalidData, "Path is not valid UTF-8"),
            )
        })
}

#[cfg(not(windows))]
fn manifest_destinations(os: &str, home: &Path, config: &Path) -> Vec<ManifestDestination> {
    let file_name = format!("{HOST_NAME}.json");
    match os {
        "macos" => vec![
            ManifestDestination {
                browser: "chrome",
                kind: ManifestKind::Chromium,
                path: home
                    .join("Library/Application Support/Google/Chrome/NativeMessagingHosts")
                    .join(&file_name),
            },
            ManifestDestination {
                browser: "edge",
                kind: ManifestKind::Chromium,
                path: home
                    .join("Library/Application Support/Microsoft Edge/NativeMessagingHosts")
                    .join(&file_name),
            },
            ManifestDestination {
                browser: "firefox",
                kind: ManifestKind::Firefox,
                path: home
                    .join("Library/Application Support/Mozilla/NativeMessagingHosts")
                    .join(&file_name),
            },
        ],
        "linux" => vec![
            ManifestDestination {
                browser: "chrome",
                kind: ManifestKind::Chromium,
                path: config
                    .join("google-chrome/NativeMessagingHosts")
                    .join(&file_name),
            },
            ManifestDestination {
                browser: "edge",
                kind: ManifestKind::Chromium,
                path: config
                    .join("microsoft-edge/NativeMessagingHosts")
                    .join(&file_name),
            },
            ManifestDestination {
                browser: "firefox",
                kind: ManifestKind::Firefox,
                path: home
                    .join(".mozilla/native-messaging-hosts")
                    .join(&file_name),
            },
        ],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn macos_uses_only_formal_browser_locations() {
        let destinations = manifest_destinations(
            "macos",
            Path::new("/Users/test"),
            Path::new("/Users/test/.config"),
        );
        let paths: Vec<String> = destinations
            .iter()
            .map(|destination| destination.path.to_string_lossy().into_owned())
            .collect();
        assert_eq!(destinations.len(), 3);
        assert!(paths.iter().any(|path| path.contains("Google/Chrome")));
        assert!(paths.iter().any(|path| path.contains("Microsoft Edge")));
        assert!(paths.iter().any(|path| path.contains("Mozilla")));
    }

    #[cfg(not(windows))]
    #[test]
    fn linux_uses_only_formal_browser_locations() {
        let destinations = manifest_destinations(
            "linux",
            Path::new("/home/test"),
            Path::new("/home/test/.config"),
        );
        let paths: Vec<String> = destinations
            .iter()
            .map(|destination| destination.path.to_string_lossy().into_owned())
            .collect();
        assert_eq!(destinations.len(), 3);
        assert!(paths.iter().any(|path| path.contains("google-chrome")));
        assert!(paths.iter().any(|path| path.contains("microsoft-edge")));
        assert!(paths.iter().any(|path| path.contains(".mozilla")));
    }

    #[cfg(not(windows))]
    #[test]
    fn manifest_repair_is_idempotent() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let manifest = directory.path().join("nested").join("manifest.json");
        let content = br#"{"name":"com.motrix.next.browser"}"#;

        assert!(write_if_changed(&manifest, content).expect("initial manifest write"));
        assert!(!write_if_changed(&manifest, content).expect("idempotent manifest check"));
        assert_eq!(fs::read(manifest).expect("saved manifest"), content);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_launcher_copy_is_stable_and_executable() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("bundled-launcher");
        let destination = directory.path().join("stable").join("launcher");
        fs::write(&source, b"launcher-v1").expect("source launcher");

        copy_executable_if_changed(&source, &destination).expect("initial launcher copy");
        copy_executable_if_changed(&source, &destination).expect("idempotent launcher copy");

        assert_eq!(
            fs::read(&destination).expect("stable launcher"),
            b"launcher-v1"
        );
        assert_ne!(
            fs::metadata(destination)
                .expect("launcher metadata")
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }

    #[test]
    fn windows_resource_manifests_match_the_shared_contract() {
        let relative_launcher = Path::new(r"..\..\motrix-next-browser-launcher.exe");
        let expected_chromium: serde_json::Value = serde_json::from_slice(
            &chromium_manifest_json(relative_launcher).expect("Chromium contract"),
        )
        .expect("Chromium JSON");
        let expected_firefox: serde_json::Value = serde_json::from_slice(
            &firefox_manifest_json(relative_launcher).expect("Firefox contract"),
        )
        .expect("Firefox JSON");
        let actual_chromium: serde_json::Value =
            serde_json::from_str(include_str!("../native-messaging/manifests/chromium.json"))
                .expect("bundled Chromium JSON");
        let actual_firefox: serde_json::Value =
            serde_json::from_str(include_str!("../native-messaging/manifests/firefox.json"))
                .expect("bundled Firefox JSON");
        assert_eq!(actual_chromium, expected_chromium);
        assert_eq!(actual_firefox, expected_firefox);
    }

    #[cfg(not(windows))]
    #[test]
    fn failed_browser_does_not_block_other_registrations_or_later_repair() {
        let root = tempfile::tempdir().expect("isolated home");
        let targets = manifest_destinations("macos", root.path(), root.path());
        let launcher = root.path().join("launcher");
        let blocked = targets[0]
            .path
            .parent()
            .expect("hosts")
            .parent()
            .expect("browser");
        fs::create_dir_all(blocked.parent().expect("vendor")).expect("vendor directory");
        fs::write(blocked, b"not a directory").expect("block only Chrome");
        let report = repair_targets(&targets, &launcher);
        assert!(matches!(
            report.targets[0].status,
            RegistrationStatus::Failed
        ));
        let failure = report.targets[0].error.as_ref().expect("contextual error");
        assert_eq!(failure.stage, "read_file");
        assert!(failure.os_code.is_some());
        assert!(failure
            .path
            .ends_with("Google/Chrome/NativeMessagingHosts/com.motrix.next.browser.json"));
        for target in &report.targets[1..] {
            assert!(matches!(target.status, RegistrationStatus::Repaired));
        }
        for target in &targets[1..] {
            assert_eq!(target.inspect(&launcher)["status"], "valid");
        }
        fs::remove_file(blocked).expect("remove isolated blocker");
        let report = repair_targets(&targets, &launcher);
        assert!(matches!(
            report.targets[0].status,
            RegistrationStatus::Repaired
        ));
        assert!(report.targets[1..]
            .iter()
            .all(|r| matches!(r.status, RegistrationStatus::Unchanged)));
    }

    #[cfg(not(windows))]
    #[test]
    fn inspection_is_read_only_and_reports_missing_invalid_and_stale_manifests() {
        let root = tempfile::tempdir().expect("isolated home");
        let targets = manifest_destinations("linux", root.path(), root.path());
        let target = &targets[0];
        let launcher = root.path().join("launcher");
        assert_eq!(target.inspect(&launcher)["status"], "missing");
        assert!(!target.path.parent().expect("parent").exists());
        target.repair(&launcher).expect("register");
        let before = fs::read(&target.path).expect("manifest");
        assert_eq!(
            target.inspect(&root.path().join("moved-launcher"))["status"],
            "mismatch"
        );
        assert_eq!(fs::read(&target.path).expect("unchanged manifest"), before);
        fs::write(&target.path, b"{").expect("invalid manifest");
        let snapshot = target.inspect(&launcher);
        assert_eq!(snapshot["status"], "error");
        assert_eq!(snapshot["error"]["stage"], "parse_manifest");
        assert_eq!(
            fs::read(&target.path).expect("not repaired by export"),
            b"{"
        );
        target.repair(&launcher).expect("explicit repair");
        assert_eq!(target.inspect(&launcher)["status"], "valid");
    }

    #[test]
    fn failure_details_preserve_native_code_and_redact_paths_and_control_characters() {
        let home = dirs::home_dir().expect("home");
        let path = home.join("Library/browser/manifest.json");
        let error =
            RegistrationError::new("create_directory", &path, io::Error::from_raw_os_error(1));
        let details = error.details();
        assert_eq!(details.os_code, Some(1));
        assert_eq!(details.stage, "create_directory");
        assert!(details
            .path
            .starts_with(&format!("~{}", std::path::MAIN_SEPARATOR)));
        assert!(!details.path.contains(home.to_string_lossy().as_ref()));
        let message = redact(&format!("{}\n{}", path.display(), "x".repeat(2000)));
        assert!(!message.contains('\n'));
        assert!(!message.contains(home.to_string_lossy().as_ref()));
        assert_eq!(message.chars().count(), 1024);
    }
}
