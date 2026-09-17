//! Linux associations use the installed desktop identity and GIO's XDG implementation.

use crate::error::AppError;
use gio::{glib, prelude::*, AppInfo, DesktopAppInfo};
use std::path::{Path, PathBuf};

pub const DESKTOP_ID: &str = "Rayburst.desktop";
pub const PROTOCOLS: [&str; 4] = ["magnet", "ed2k", "thunder", "rayburst"];
const DEFAULTS: &str = "Default Applications";

fn failure(context: &str, error: impl std::fmt::Display) -> AppError {
    AppError::Protocol(format!("{context}: {error}"))
}

pub struct Associations {
    executable: PathBuf,
    command: String,
}

impl Associations {
    pub fn new(executable: &Path) -> Result<Self, AppError> {
        let executable = executable
            .canonicalize()
            .map_err(|error| failure("resolve application executable", error))?;
        let command = desktop_command(&executable)?;
        Ok(Self {
            executable,
            command,
        })
    }

    fn owns(&self, info: &AppInfo) -> bool {
        // AppInfo::executable does not reliably unquote Exec. Use GLib's parser,
        // as DesktopAppInfo does, without executing the command or matching names.
        info.commandline()
            .and_then(|command| glib::shell_parse_argv(command).ok())
            .and_then(|arguments| arguments.into_iter().next())
            .and_then(glib::find_program_in_path)
            .and_then(|path| path.canonicalize().ok())
            .is_some_and(|path| path == self.executable)
    }

    pub fn is_default(&self, protocol: &str) -> Result<bool, AppError> {
        validate(protocol)?;
        let actual = AppInfo::default_for_uri_scheme(protocol);
        let enabled = actual.as_ref().is_some_and(|info| self.owns(info));
        log::debug!(
            "protocol:query scheme={protocol} expected={DESKTOP_ID} actual={:?} enabled={enabled}",
            actual.and_then(|info| info.id())
        );
        Ok(enabled)
    }

    fn entry(&self) -> Result<DesktopAppInfo, AppError> {
        if let Some(info) = DesktopAppInfo::new(DESKTOP_ID) {
            if self.owns(info.upcast_ref()) {
                return Ok(info);
            }
        }

        // Portable builds need a persistent user entry, never an AppImage mount path.
        let path = glib::user_data_dir().join("applications").join(DESKTOP_ID);
        if path
            .try_exists()
            .map_err(|error| failure("inspect desktop entry", error))?
        {
            // Read ownership even when a portable executable has moved and GIO
            // can no longer resolve the old entry's Exec field.
            let saved = glib::KeyFile::new();
            saved
                .load_from_file(&path, glib::KeyFileFlags::NONE)
                .map_err(|error| failure("read desktop entry", error))?;
            // Never overwrite a different application or a user's custom launcher.
            if !saved
                .boolean("Desktop Entry", "X-Rayburst-Managed")
                .unwrap_or(false)
            {
                return Err(failure(
                    "desktop entry belongs to another executable",
                    path.display(),
                ));
            }
        }
        std::fs::create_dir_all(
            path.parent()
                .ok_or_else(|| failure("desktop entry", "missing directory"))?,
        )
        .map_err(|error| failure("create desktop entry directory", error))?;
        let keyfile = glib::KeyFile::new();
        for (key, value) in [
            ("Type", "Application"), ("Name", "Rayburst"), ("Exec", self.command.as_str()),
            ("Icon", "rayburst"), ("Terminal", "false"), ("NoDisplay", "true"),
            ("X-Rayburst-Managed", "true"),
            ("MimeType", "application/x-bittorrent;x-scheme-handler/magnet;x-scheme-handler/ed2k;x-scheme-handler/thunder;x-scheme-handler/rayburst;"),
        ] {
            keyfile.set_string("Desktop Entry", key, value);
        }
        DesktopAppInfo::from_keyfile(&keyfile).ok_or_else(|| {
            failure(
                "create desktop entry",
                "GIO cannot resolve the executable path",
            )
        })?;
        gio::File::for_path(&path)
            .replace_contents(
                keyfile.to_data().as_bytes(),
                None,
                false,
                gio::FileCreateFlags::NONE,
                gio::Cancellable::NONE,
            )
            .map_err(|error| failure("save desktop entry", error))?;
        DesktopAppInfo::from_filename(&path)
            .ok_or_else(|| failure("load saved desktop entry", path.display()))
    }

    pub fn set_enabled(&self, protocol: &str, enabled: bool) -> Result<(), AppError> {
        validate(protocol)?;
        let mime = format!("x-scheme-handler/{protocol}");
        let before = AppInfo::default_for_uri_scheme(protocol).and_then(|info| info.id());
        if enabled {
            let entry = self.entry()?;
            entry
                .set_as_default_for_type(&mime)
                .map_err(|error| failure("set default application", error))?;
            if AppInfo::default_for_uri_scheme(protocol)
                .and_then(|info| info.id())
                .as_deref()
                != Some(DESKTOP_ID)
                && update_user_defaults(&mime, Some(DESKTOP_ID), &[])?
            {
                // GIO invalidates its user-config cache when an association is changed.
                entry
                    .set_as_default_for_type(&mime)
                    .map_err(|error| failure("refresh default application", error))?;
            }
        } else {
            // Multiple desktop entries can launch the same executable. Remove only this
            // application's association, without resetting anyone else's default choices.
            let entries: Vec<AppInfo> = AppInfo::all()
                .into_iter()
                .filter(|info| self.owns(info))
                .collect();
            let ids: Vec<String> = entries
                .iter()
                .filter_map(|info| info.id().map(|id| id.to_string()))
                .collect();
            for info in &entries {
                info.remove_supports_type(&mime)
                    .map_err(|error| failure("remove application association", error))?;
            }
            if update_user_defaults(&mime, None, &ids)? {
                for info in &entries {
                    info.remove_supports_type(&mime)
                        .map_err(|error| failure("refresh application association", error))?;
                }
            }
        }
        let after = AppInfo::default_for_uri_scheme(protocol);
        let actual = after.as_ref().is_some_and(|info| self.owns(info));
        let after_id = after.and_then(|info| info.id());
        log::info!("protocol:change scheme={protocol} enabled={enabled} expected={DESKTOP_ID} before={before:?} after={after_id:?} actual={actual}");
        if actual != enabled {
            return Err(failure("association unchanged", format!("scheme={protocol}, handler={after_id:?}, expected={DESKTOP_ID}, enabled={enabled}")));
        }
        Ok(())
    }

    pub fn diagnostics(&self) -> serde_json::Value {
        let protocols: Vec<_> = PROTOCOLS
            .iter()
            .map(|protocol| {
                let handler = AppInfo::default_for_uri_scheme(protocol);
                serde_json::json!({
                    "scheme": protocol,
                    "is_default": handler.as_ref().is_some_and(|info| self.owns(info)),
                    "handler": handler.and_then(|info| info.id()).map(|id| id.to_string()),
                })
            })
            .collect();
        serde_json::json!({
            "desktop_id": DESKTOP_ID,
            "executable": self.executable,
            "current_desktop": std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default(),
            "config_directory": glib::user_config_dir(),
            "data_directory": glib::user_data_dir(),
            "protocols": protocols,
        })
    }
}

fn validate(protocol: &str) -> Result<(), AppError> {
    if PROTOCOLS.contains(&protocol) {
        Ok(())
    } else {
        Err(failure("unsupported protocol", protocol))
    }
}

/// Desktop Entry quoting is not shell quoting. GLib handles the outer key-file escaping.
fn desktop_command(executable: &Path) -> Result<String, AppError> {
    let path = executable
        .to_str()
        .ok_or_else(|| failure("desktop entry", "executable path is not UTF-8"))?;
    let mut command = String::from("\"");
    for character in path.chars() {
        match character {
            '\\' | '"' | '`' | '$' => {
                command.push('\\');
                command.push(character);
            }
            '%' => command.push_str("%%"),
            _ => command.push(character),
        }
    }
    command.push_str("\" %U");
    Ok(command)
}

/// GIO writes mimeapps.list. Only existing user desktop-specific overrides need
/// explicit adjustment; system policy and unrelated associations remain untouched.
fn update_user_defaults(
    mime: &str,
    preferred: Option<&str>,
    removed: &[String],
) -> Result<bool, AppError> {
    let directory = glib::user_config_dir();
    let mut paths = Vec::new();
    for desktop in std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
    {
        if !desktop.is_empty()
            && desktop
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            paths.push(directory.join(format!("{}-mimeapps.list", desktop.to_ascii_lowercase())));
        }
    }
    if preferred.is_none() {
        paths.push(directory.join("mimeapps.list"));
    }
    paths.sort();
    paths.dedup();
    let mut changed = false;
    for path in paths {
        let file = gio::File::for_path(&path);
        let (contents, etag) = match file.load_contents(gio::Cancellable::NONE) {
            Ok(contents) => contents,
            Err(error) if error.matches(gio::IOErrorEnum::NotFound) => continue,
            Err(error) => return Err(failure(&format!("read {}", path.display()), error)),
        };
        let keyfile = glib::KeyFile::new();
        let contents = std::str::from_utf8(&contents)
            .map_err(|error| failure("read MIME associations", error))?;
        keyfile
            .load_from_data(
                contents,
                glib::KeyFileFlags::KEEP_COMMENTS | glib::KeyFileFlags::KEEP_TRANSLATIONS,
            )
            .map_err(|error| failure(&format!("parse {}", path.display()), error))?;
        let current = match keyfile.string_list(DEFAULTS, mime) {
            Ok(values) => values.iter().map(ToString::to_string).collect::<Vec<_>>(),
            Err(error)
                if error.matches(glib::KeyFileError::KeyNotFound)
                    || error.matches(glib::KeyFileError::GroupNotFound) =>
            {
                continue
            }
            Err(error) => return Err(failure("read default application", error)),
        };
        let mut next: Vec<_> = current
            .iter()
            .filter(|id| !removed.contains(id) && preferred != Some(id.as_str()))
            .cloned()
            .collect();
        if let Some(id) = preferred {
            next.insert(0, id.to_string());
        }
        if next == current {
            continue;
        }
        if next.is_empty() {
            keyfile
                .remove_key(DEFAULTS, mime)
                .map_err(|error| failure("remove default application", error))?;
        } else {
            keyfile.set_string(DEFAULTS, mime, &format!("{};", next.join(";")));
        }
        file.replace_contents(
            keyfile.to_data().as_bytes(),
            etag.as_deref(),
            false,
            gio::FileCreateFlags::NONE,
            gio::Cancellable::NONE,
        )
        .map_err(|error| failure(&format!("update {}", path.display()), error))?;
        log::info!(
            "protocol:override-updated mime={mime} path={}",
            path.display()
        );
        changed = true;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_associations() {
        if let Ok(scenario) = std::env::var("RAYBURST_PROTOCOL_TEST") {
            exercise(&scenario);
            return;
        }
        // GLib caches XDG paths process-wide. Subprocesses isolate both those caches
        // and all writes from the real user's desktop configuration.
        let test = format!(
            "{}::native_associations",
            module_path!().split_once("::").unwrap().1
        );
        for desktop in ["KDE", "GNOME"] {
            for scenario in ["installed", "portable", "conflict", "invalid-config"] {
                let root = tempfile::tempdir().unwrap();
                for path in ["config", "data/applications", "system/applications"] {
                    std::fs::create_dir_all(root.path().join(path)).unwrap();
                }
                let result = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", &test, "--nocapture"])
                    .env("RAYBURST_PROTOCOL_TEST", scenario)
                    .env("HOME", root.path())
                    .env("XDG_CONFIG_HOME", root.path().join("config"))
                    .env("XDG_CONFIG_DIRS", root.path().join("system-config"))
                    .env("XDG_DATA_HOME", root.path().join("data"))
                    .env("XDG_DATA_DIRS", root.path().join("system"))
                    .env("XDG_CURRENT_DESKTOP", desktop)
                    .output()
                    .unwrap();
                assert!(
                    result.status.success(),
                    "{desktop}/{scenario}: {}\n{}",
                    String::from_utf8_lossy(&result.stdout),
                    String::from_utf8_lossy(&result.stderr)
                );
            }
        }
    }

    fn exercise(scenario: &str) {
        let root = PathBuf::from(std::env::var_os("HOME").unwrap());
        let config = root.join("config");
        let user_entry = root.join("data/applications").join(DESKTOP_ID);
        let desktop_defaults = config.join(format!(
            "{}-mimeapps.list",
            std::env::var("XDG_CURRENT_DESKTOP")
                .unwrap()
                .to_ascii_lowercase()
        ));
        let mimes = PROTOCOLS
            .map(|protocol| format!("x-scheme-handler/{protocol};"))
            .join("");
        let desktop_file = |executable: &str| {
            format!("[Desktop Entry]\nName=Test\nType=Application\nExec={executable} %U\nMimeType={mimes}\n")
        };
        std::fs::write(
            root.join("system/applications/other.desktop"),
            desktop_file("/usr/bin/false"),
        )
        .unwrap();
        std::fs::write(&desktop_defaults, "# Keep this comment\n[Default Applications]\nx-scheme-handler/magnet=other.desktop;\nx-scheme-handler/thunder=other.desktop;\n").unwrap();
        let executable = if scenario == "portable" {
            let executable = root.join("Rayburst $`'\" test.AppImage");
            std::fs::copy("/usr/bin/true", &executable).unwrap();
            executable
        } else {
            std::fs::write(
                root.join("system/applications").join(DESKTOP_ID),
                desktop_file("/usr/bin/true"),
            )
            .unwrap();
            PathBuf::from("/usr/bin/true")
        };
        std::fs::write(
            config.join("mimeapps.list"),
            format!("[Default Applications]\nx-scheme-handler/ed2k={DESKTOP_ID};\n"),
        )
        .unwrap();
        if scenario == "conflict" {
            std::fs::write(&user_entry, desktop_file("/usr/bin/false")).unwrap();
        } else if scenario == "invalid-config" {
            std::fs::write(&desktop_defaults, "invalid key file").unwrap();
        }
        let associations = Associations::new(&executable).unwrap();
        if scenario == "conflict" {
            let original = std::fs::read(&user_entry).unwrap();
            assert!(associations.set_enabled("magnet", true).is_err());
            assert_eq!(std::fs::read(&user_entry).unwrap(), original);
            return;
        }
        if scenario == "invalid-config" {
            assert!(
                update_user_defaults("x-scheme-handler/magnet", Some(DESKTOP_ID), &[]).is_err()
            );
            assert_eq!(
                std::fs::read_to_string(desktop_defaults).unwrap(),
                "invalid key file"
            );
            return;
        }
        if scenario == "installed" {
            // A user-created entry for this executable must not reappear as the
            // fallback after disabling the application's association.
            std::fs::write(
                root.join("data/applications/custom-launcher.desktop"),
                desktop_file("\"/usr/bin/true\"").replace("%U", "%u"),
            )
            .unwrap();
            assert!(associations.is_default("ed2k").unwrap());
        }
        assert!(!associations.is_default("magnet").unwrap());
        associations.set_enabled("magnet", true).unwrap();
        assert!(associations.is_default("magnet").unwrap());
        let overrides = std::fs::read_to_string(&desktop_defaults).unwrap();
        assert!(overrides.contains("# Keep this comment"));
        assert!(overrides.contains("x-scheme-handler/thunder=other.desktop;"));
        assert_eq!(user_entry.exists(), scenario == "portable");
        // Exercise actual GIO launching, including Desktop Entry escaping.
        DesktopAppInfo::new(DESKTOP_ID)
            .unwrap()
            .launch_uris(&["magnet:?xt=test"], gio::AppLaunchContext::NONE)
            .unwrap();
        for protocol in PROTOCOLS {
            associations.set_enabled(protocol, true).unwrap();
            assert!(associations.is_default(protocol).unwrap());
        }
        associations.set_enabled("magnet", false).unwrap();
        assert!(!associations.is_default("magnet").unwrap());
        for protocol in ["ed2k", "thunder", "rayburst"] {
            assert!(associations.is_default(protocol).unwrap());
        }
        associations.set_enabled("magnet", true).unwrap();
        assert!(associations.is_default("magnet").unwrap());
        assert!(associations.set_enabled("https", true).is_err());
        if scenario == "portable" {
            let moved = root.join("Moved Rayburst.AppImage");
            std::fs::rename(&executable, &moved).unwrap();
            let relocated = Associations::new(&moved).unwrap();
            relocated.set_enabled("magnet", true).unwrap();
            assert!(relocated.is_default("magnet").unwrap());
        }
    }
}
