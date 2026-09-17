#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::io::{stdin, stdout};
use std::process::ExitCode;

use rayburst_browser_launcher::{run_session, write_error_response, ACTIVATION_URL};

fn activate() -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        run_activation_commands(open::commands(ACTIVATION_URL))
    }
    #[cfg(not(target_os = "linux"))]
    {
        open::that(ACTIVATION_URL)
    }
}

#[cfg(any(target_os = "linux", test))]
fn run_activation_commands(
    commands: impl IntoIterator<Item = std::process::Command>,
) -> std::io::Result<()> {
    use std::io;
    use std::process::Stdio;

    let mut last_error = io::Error::new(io::ErrorKind::NotFound, "No desktop opener available");
    for mut command in commands {
        // Browser EGL overrides must not select the desktop app's graphics backend.
        // Keep Native Messaging streams exclusive to the host protocol.
        match command
            .env_remove("EGL_PLATFORM")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => {
                return Err(io::Error::other(format!(
                    "Desktop opener exited with {status}"
                )))
            }
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut input = stdin().lock();
    let mut output = stdout().lock();
    match run_session(&args, &mut input, &mut output, || {
        activate().map_err(|error| error.to_string())
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = write_error_response(&mut output, &error);
            eprintln!("Native messaging request failed: {}", error.code());
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::run_activation_commands;
    use std::process::Command;

    fn fixture(name: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        command.args(["--ignored", "--exact", name, "--nocapture"]);
        command
    }

    #[test]
    fn filters_inherited_egl_without_changing_parent_or_protocol_streams() {
        let output = fixture("tests::inherited_environment_fixture")
            .env("EGL_PLATFORM", "wayland")
            .env("XDG_SESSION_TYPE", "wayland")
            .output()
            .expect("run isolated parent");
        assert!(output.status.success(), "{output:?}");
        for stream in [&output.stdout, &output.stderr] {
            assert!(!String::from_utf8_lossy(stream).contains("DESKTOP_OUTPUT"));
        }
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn inherited_environment_fixture() {
        let inherited = std::env::var_os("EGL_PLATFORM").expect("inherited EGL override");
        run_activation_commands([fixture("tests::desktop_environment_fixture")])
            .expect("activate with isolated environment");
        assert_eq!(std::env::var_os("EGL_PLATFORM"), Some(inherited));
    }

    #[test]
    #[ignore = "subprocess fixture"]
    fn desktop_environment_fixture() {
        assert!(std::env::var_os("EGL_PLATFORM").is_none());
        assert_eq!(std::env::var("XDG_SESSION_TYPE").as_deref(), Ok("wayland"));
        println!("DESKTOP_OUTPUT");
        eprintln!("DESKTOP_OUTPUT");
    }

    #[test]
    fn reports_missing_openers_and_nonzero_exit_status() {
        let missing = std::env::current_exe()
            .expect("test executable")
            .join("missing-opener");
        assert!(run_activation_commands([Command::new(missing)]).is_err());

        let mut failing = Command::new(std::env::current_exe().expect("test executable"));
        failing.arg("--invalid-test-harness-option");
        let error = run_activation_commands([failing]).expect_err("opener failure");
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
    }
}
