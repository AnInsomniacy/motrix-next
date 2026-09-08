use std::io::{Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const HOST_NAME: &str = "com.motrix.next.browser";
pub const LAUNCHER_FILE_STEM: &str = "motrix-next-browser-launcher";
pub const ACTIVATION_URL: &str = "motrixnext://";
pub const CHROME_ORIGIN: &str = "chrome-extension://ofeajdebdjajhkmcmamagokecnbephhl/";
pub const EDGE_ORIGIN: &str = "chrome-extension://loojjolhejmakcdlbidigoniobfanjlb/";
pub const FIREFOX_EXTENSION_ID: &str = "motrix-next-extension@aninsomniacy.dev";
pub const MAX_MESSAGE_SIZE: usize = 4 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("untrusted browser caller")]
    UntrustedCaller,
    #[error("message frame is incomplete")]
    IncompleteFrame,
    #[error("message size is invalid")]
    InvalidSize,
    #[error("request is invalid")]
    InvalidRequest,
    #[error("failed to activate Motrix Next")]
    ActivationFailed,
    #[error("failed to write response")]
    ResponseFailed,
}

impl HostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UntrustedCaller => "untrusted_caller",
            Self::IncompleteFrame => "incomplete_frame",
            Self::InvalidSize => "invalid_size",
            Self::InvalidRequest => "invalid_request",
            Self::ActivationFailed => "activation_failed",
            Self::ResponseFailed => "response_failed",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivationRequest {
    action: ActivationAction,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActivationAction {
    Activate,
}

#[derive(Debug, Serialize)]
struct SuccessResponse {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct ErrorResponse<'a> {
    ok: bool,
    error: &'a str,
}

#[derive(Debug, Serialize)]
struct ChromiumManifest<'a> {
    name: &'static str,
    description: &'static str,
    path: &'a str,
    r#type: &'static str,
    allowed_origins: [&'static str; 2],
}

#[derive(Debug, Serialize)]
struct FirefoxManifest<'a> {
    name: &'static str,
    description: &'static str,
    path: &'a str,
    r#type: &'static str,
    allowed_extensions: [&'static str; 1],
}

pub fn chromium_manifest_json(path: &Path) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec_pretty(&ChromiumManifest {
        name: HOST_NAME,
        description: "Activate Motrix Next",
        path: &path.to_string_lossy(),
        r#type: "stdio",
        allowed_origins: [CHROME_ORIGIN, EDGE_ORIGIN],
    })
}

pub fn firefox_manifest_json(path: &Path) -> Result<Vec<u8>, serde_json::Error> {
    serde_json::to_vec_pretty(&FirefoxManifest {
        name: HOST_NAME,
        description: "Activate Motrix Next",
        path: &path.to_string_lossy(),
        r#type: "stdio",
        allowed_extensions: [FIREFOX_EXTENSION_ID],
    })
}

pub fn run_session<R, W, F>(
    browser_args: &[String],
    reader: &mut R,
    writer: &mut W,
    activate: F,
) -> Result<(), HostError>
where
    R: Read,
    W: Write,
    F: FnOnce() -> Result<(), String>,
{
    validate_browser_caller(browser_args)?;
    read_activation_request(reader)?;
    activate().map_err(|_| HostError::ActivationFailed)?;
    write_json_frame(writer, &SuccessResponse { ok: true })
}

pub fn write_error_response<W: Write>(writer: &mut W, error: &HostError) -> Result<(), HostError> {
    write_json_frame(
        writer,
        &ErrorResponse {
            ok: false,
            error: error.code(),
        },
    )
}

fn validate_browser_caller(args: &[String]) -> Result<(), HostError> {
    match args {
        [origin] if is_allowed_chromium_origin(origin) => Ok(()),
        [origin, parent_window]
            if cfg!(windows)
                && is_allowed_chromium_origin(origin)
                && valid_parent_window_arg(parent_window) =>
        {
            Ok(())
        }
        [manifest_path, extension_id]
            if extension_id == FIREFOX_EXTENSION_ID
                && manifest_file_name(manifest_path) == format!("{HOST_NAME}.json") =>
        {
            Ok(())
        }
        _ => Err(HostError::UntrustedCaller),
    }
}

fn is_allowed_chromium_origin(origin: &str) -> bool {
    matches!(origin, CHROME_ORIGIN | EDGE_ORIGIN)
}

fn valid_parent_window_arg(value: &str) -> bool {
    value
        .strip_prefix("--parent-window=")
        .is_some_and(|handle| {
            !handle.is_empty() && handle.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn manifest_file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

fn read_activation_request<R: Read>(reader: &mut R) -> Result<(), HostError> {
    let mut length_bytes = [0_u8; 4];
    reader
        .read_exact(&mut length_bytes)
        .map_err(|_| HostError::IncompleteFrame)?;
    let length = u32::from_ne_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_MESSAGE_SIZE {
        return Err(HostError::InvalidSize);
    }

    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|_| HostError::IncompleteFrame)?;
    let request: ActivationRequest =
        serde_json::from_slice(&payload).map_err(|_| HostError::InvalidRequest)?;
    if !matches!(request.action, ActivationAction::Activate) {
        return Err(HostError::InvalidRequest);
    }
    Ok(())
}

fn write_json_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), HostError> {
    let payload = serde_json::to_vec(value).map_err(|_| HostError::ResponseFailed)?;
    let length = u32::try_from(payload.len()).map_err(|_| HostError::ResponseFailed)?;
    writer
        .write_all(&length.to_ne_bytes())
        .and_then(|()| writer.write_all(&payload))
        .and_then(|()| writer.flush())
        .map_err(|_| HostError::ResponseFailed)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::io::Cursor;
    use std::path::Path;

    use serde_json::{json, Value};

    use super::*;

    fn request_frame(value: Value) -> Vec<u8> {
        let payload = serde_json::to_vec(&value).expect("test JSON must serialize");
        let mut frame = Vec::with_capacity(4 + payload.len());
        frame.extend_from_slice(&(payload.len() as u32).to_ne_bytes());
        frame.extend_from_slice(&payload);
        frame
    }

    fn decode_frame(frame: &[u8]) -> Value {
        let length = u32::from_ne_bytes(frame[..4].try_into().expect("length prefix")) as usize;
        serde_json::from_slice(&frame[4..4 + length]).expect("response JSON")
    }

    #[test]
    fn accepts_exact_activate_request_from_chrome() {
        let mut input = Cursor::new(request_frame(json!({ "action": "activate" })));
        let mut output = Vec::new();
        let activated = Cell::new(false);

        run_session(
            &[CHROME_ORIGIN.to_string()],
            &mut input,
            &mut output,
            || {
                activated.set(true);
                Ok(())
            },
        )
        .expect("valid request must succeed");

        assert!(activated.get());
        assert_eq!(decode_frame(&output), json!({ "ok": true }));
    }

    #[test]
    fn accepts_edge_and_firefox_callers() {
        let firefox_manifest = format!("/tmp/{HOST_NAME}.json");
        for args in [
            vec![EDGE_ORIGIN.to_string()],
            vec![firefox_manifest, FIREFOX_EXTENSION_ID.to_string()],
        ] {
            let mut input = Cursor::new(request_frame(json!({ "action": "activate" })));
            let mut output = Vec::new();
            run_session(&args, &mut input, &mut output, || Ok(()))
                .expect("allowlisted caller must succeed");
        }
    }

    #[test]
    fn rejects_untrusted_callers() {
        let mut input = Cursor::new(request_frame(json!({ "action": "activate" })));
        let mut output = Vec::new();
        let error = run_session(
            &["chrome-extension://untrusted/".to_string()],
            &mut input,
            &mut output,
            || Ok(()),
        )
        .expect_err("unknown extension must be rejected");
        assert!(matches!(error, HostError::UntrustedCaller));
    }

    #[test]
    fn rejects_wrong_actions_and_extra_fields() {
        for request in [
            json!({ "action": "download" }),
            json!({ "action": "activate", "url": "https://example.com" }),
            json!({ "action": "activate", "cookie": "secret" }),
        ] {
            let mut input = Cursor::new(request_frame(request));
            let mut output = Vec::new();
            let error = run_session(
                &[CHROME_ORIGIN.to_string()],
                &mut input,
                &mut output,
                || Ok(()),
            )
            .expect_err("non-activate request must be rejected");
            assert!(matches!(error, HostError::InvalidRequest));
        }
    }

    #[test]
    fn rejects_zero_oversized_and_truncated_frames() {
        let cases = [
            0_u32.to_ne_bytes().to_vec(),
            ((MAX_MESSAGE_SIZE + 1) as u32).to_ne_bytes().to_vec(),
            {
                let mut frame = 10_u32.to_ne_bytes().to_vec();
                frame.extend_from_slice(b"{}");
                frame
            },
        ];

        for frame in cases {
            let mut input = Cursor::new(frame);
            let mut output = Vec::new();
            assert!(run_session(
                &[CHROME_ORIGIN.to_string()],
                &mut input,
                &mut output,
                || Ok(())
            )
            .is_err());
        }
    }

    #[test]
    fn reports_activation_failure_without_success_response() {
        let mut input = Cursor::new(request_frame(json!({ "action": "activate" })));
        let mut output = Vec::new();
        let error = run_session(
            &[CHROME_ORIGIN.to_string()],
            &mut input,
            &mut output,
            || Err("open failed".to_string()),
        )
        .expect_err("opener failure must propagate");
        assert!(matches!(error, HostError::ActivationFailed));
        assert!(output.is_empty());
    }

    #[test]
    fn manifests_contain_only_formal_extension_ids() {
        let chromium: Value = serde_json::from_slice(
            &chromium_manifest_json(Path::new("/app/launcher")).expect("Chromium manifest"),
        )
        .expect("valid Chromium JSON");
        let firefox: Value = serde_json::from_slice(
            &firefox_manifest_json(Path::new("/app/launcher")).expect("Firefox manifest"),
        )
        .expect("valid Firefox JSON");

        assert_eq!(
            chromium["allowed_origins"],
            json!([CHROME_ORIGIN, EDGE_ORIGIN])
        );
        assert_eq!(firefox["allowed_extensions"], json!([FIREFOX_EXTENSION_ID]));
        assert!(chromium.get("allowed_extensions").is_none());
        assert!(firefox.get("allowed_origins").is_none());
    }

    #[test]
    fn error_response_is_a_valid_native_message_frame() {
        let mut output = Vec::new();
        write_error_response(&mut output, &HostError::InvalidRequest)
            .expect("error response must serialize");
        assert_eq!(
            decode_frame(&output),
            json!({ "ok": false, "error": "invalid_request" })
        );
    }
}
