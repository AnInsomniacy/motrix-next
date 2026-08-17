//! System idle-sleep prevention for runtime services.
//!
//! The stat service owns this guard while aria2 reports active tasks.  Windows
//! uses a process handle based Power Request so acquisition and release are not
//! tied to the tokio worker thread that happens to poll stats.  macOS and Linux
//! keep using `keepawake`, whose backends are already assertion/inhibitor based.

use crate::error::AppError;

const DOWNLOAD_REASON: &str = "Active downloads in progress";
#[cfg(not(target_os = "android"))]
const APP_NAME: &str = "Motrix Next";
#[cfg(not(target_os = "android"))]
const APP_REVERSE_DOMAIN: &str = "com.motrix.next";

pub struct PowerGuard {
    inner: PlatformPowerGuard,
}

impl PowerGuard {
    pub fn acquire_download() -> Result<Self, AppError> {
        PlatformPowerGuard::acquire_download().map(|inner| Self { inner })
    }

    pub fn backend_name(&self) -> &'static str {
        self.inner.backend_name()
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{AppError, DOWNLOAD_REASON};
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
        pub fn acquire_download() -> Result<Self, AppError> {
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

    fn last_power_error(operation: &str) -> AppError {
        let code = unsafe { GetLastError() };
        AppError::Engine(format!("{operation} failed with Win32 error {code}"))
    }
}

#[cfg(not(target_os = "windows"))]
#[cfg(not(target_os = "android"))]
mod platform {
    use super::{AppError, APP_NAME, APP_REVERSE_DOMAIN, DOWNLOAD_REASON};

    pub struct PlatformPowerGuard {
        _guard: keepawake::KeepAwake,
    }

    impl PlatformPowerGuard {
        pub fn acquire_download() -> Result<Self, AppError> {
            keepawake::Builder::default()
                .idle(true)
                .reason(DOWNLOAD_REASON)
                .app_name(APP_NAME)
                .app_reverse_domain(APP_REVERSE_DOMAIN)
                .create()
                .map(|guard| Self { _guard: guard })
                .map_err(|e| AppError::Engine(format!("keepawake failed: {e}")))
        }

        pub fn backend_name(&self) -> &'static str {
            "keepawake"
        }
    }
}

// Android: no keepawake backend — a no-op guard keeps the stat service
// compiling and keeps the "keep awake during downloads" preference harmless.
#[cfg(target_os = "android")]
mod platform {
    use super::AppError;

    pub struct PlatformPowerGuard;

    impl PlatformPowerGuard {
        pub fn acquire_download() -> Result<Self, AppError> {
            Ok(Self)
        }

        pub fn backend_name(&self) -> &'static str {
            "android-noop"
        }
    }
}

use platform::PlatformPowerGuard;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_download_has_expected_signature() {
        let _: fn() -> Result<PowerGuard, AppError> = PowerGuard::acquire_download;
    }

    #[test]
    fn power_guard_can_be_owned_by_tokio_spawned_services() {
        fn assert_send<T: Send>() {}

        assert_send::<PowerGuard>();
    }
}
