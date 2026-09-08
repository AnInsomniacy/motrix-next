//! System idle-sleep prevention for runtime services.
//!
//! The stat service owns this guard while aria2 reports active tasks. Windows
//! uses a Power Request, macOS uses an IOPM assertion through `keepawake`, and
//! Linux uses the desktop-native XDG Inhibit portal.

const DOWNLOAD_REASON: &str = "Active downloads in progress";
pub const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct PowerError(String);

pub struct PowerGuard {
    inner: PlatformPowerGuard,
}

impl PowerGuard {
    pub async fn acquire_download() -> Result<Self, PowerError> {
        PlatformPowerGuard::acquire_download()
            .await
            .map(|inner| Self { inner })
    }

    pub fn backend_name(&self) -> &'static str {
        self.inner.backend_name()
    }

    pub async fn release(self) -> Result<(), PowerError> {
        self.inner.release().await
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{PowerError, DOWNLOAD_REASON};
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };

    pub struct PlatformPowerGuard {
        handle: HANDLE,
    }

    // SAFETY: the power request is owned by this guard as a kernel HANDLE.
    // PowerClearRequest and CloseHandle operate on the handle value and are not
    // tied to the thread that created the request, so moving the owner between
    // tokio worker threads does not change the ownership or release semantics.
    unsafe impl Send for PlatformPowerGuard {}

    impl PlatformPowerGuard {
        pub async fn acquire_download() -> Result<Self, PowerError> {
            let mut reason = DOWNLOAD_REASON
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<u16>>();
            let context = REASON_CONTEXT {
                Version: 0,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: reason.as_mut_ptr(),
                },
            };

            let handle = unsafe { PowerCreateRequest(&context) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(last_power_error("PowerCreateRequest"));
            }

            if unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } == 0 {
                let err = last_power_error("PowerSetRequest(PowerRequestSystemRequired)");
                unsafe {
                    CloseHandle(handle);
                }
                return Err(err);
            }

            Ok(Self { handle })
        }

        pub fn backend_name(&self) -> &'static str {
            "windows-power-request"
        }

        pub async fn release(self) -> Result<(), PowerError> {
            drop(self);
            Ok(())
        }
    }

    impl Drop for PlatformPowerGuard {
        fn drop(&mut self) {
            if self.handle.is_null() || self.handle == INVALID_HANDLE_VALUE {
                return;
            }

            unsafe {
                if PowerClearRequest(self.handle, PowerRequestSystemRequired) == 0 {
                    log::warn!(
                        "keep_awake: PowerClearRequest(PowerRequestSystemRequired) failed: {}",
                        GetLastError()
                    );
                }
                if CloseHandle(self.handle) == 0 {
                    log::warn!("keep_awake: CloseHandle failed: {}", GetLastError());
                }
            }
            self.handle = null_mut();
        }
    }

    fn last_power_error(operation: &str) -> PowerError {
        let code = unsafe { GetLastError() };
        PowerError(format!("{operation} failed with Win32 error {code}"))
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{PowerError, DOWNLOAD_REASON};

    pub struct PlatformPowerGuard {
        _guard: keepawake::KeepAwake,
    }

    impl PlatformPowerGuard {
        pub async fn acquire_download() -> Result<Self, PowerError> {
            keepawake::Builder::default()
                .idle(true)
                .reason(DOWNLOAD_REASON)
                .create()
                .map(|guard| Self { _guard: guard })
                .map_err(|e| PowerError(format!("IOPM assertion failed: {e}")))
        }

        pub fn backend_name(&self) -> &'static str {
            "macos-iopm-assertion"
        }

        pub async fn release(self) -> Result<(), PowerError> {
            drop(self);
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::{PowerError, DOWNLOAD_REASON};
    use ashpd::desktop::{
        inhibit::{InhibitFlags, InhibitOptions, InhibitProxy},
        Request,
    };

    pub struct PlatformPowerGuard {
        request: Request<()>,
    }

    impl PlatformPowerGuard {
        pub async fn acquire_download() -> Result<Self, PowerError> {
            let proxy = InhibitProxy::new()
                .await
                .map_err(|e| portal_error("connect", e))?;
            let request = proxy
                .inhibit(
                    None,
                    InhibitFlags::Suspend.into(),
                    InhibitOptions::default().set_reason(DOWNLOAD_REASON),
                )
                .await
                .map_err(|e| portal_error("acquire", e))?;
            Ok(Self { request })
        }

        pub fn backend_name(&self) -> &'static str {
            "linux-xdg-inhibit-portal"
        }

        pub async fn release(self) -> Result<(), PowerError> {
            self.request
                .close()
                .await
                .map_err(|e| portal_error("release", e))
        }
    }

    fn portal_error(operation: &str, error: ashpd::Error) -> PowerError {
        PowerError(format!("XDG inhibit portal {operation} failed: {error}"))
    }
}

use platform::PlatformPowerGuard;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn power_guard_can_be_owned_by_tokio_spawned_services() {
        fn assert_send<T: Send>() {}

        assert_send::<PowerGuard>();
    }
}
