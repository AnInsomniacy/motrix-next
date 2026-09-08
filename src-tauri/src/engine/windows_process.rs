//! Native Windows discovery and cleanup for an orphaned engine listener.
//!
//! The implementation uses IP Helper and process handles directly. It never
//! launches or parses output from `cmd.exe`, `netstat`, or `taskkill`.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::mem::size_of;
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, HANDLE, NO_ERROR, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

use super::cleanup::decode_windows_tcp_port;

const PROCESS_EXIT_TIMEOUT_MS: u32 = 1_000;
const MAX_WINDOWS_PATH_CHARS: usize = 32_768;

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: OwnedHandle is created only from a non-null OpenProcess result
        // and is never duplicated, so this is the single matching close.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn tcp_table(family: u32) -> Result<(Vec<u32>, usize), String> {
    let mut byte_len = 0_u32;
    // SAFETY: The null buffer is the documented size-query form. byte_len is
    // valid writable storage and all remaining values are plain input values.
    let initial_status = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut byte_len,
            0,
            family,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if initial_status != ERROR_INSUFFICIENT_BUFFER && initial_status != NO_ERROR {
        return Err(format!(
            "GetExtendedTcpTable size query failed with Windows error {initial_status}"
        ));
    }
    if byte_len < size_of::<u32>() as u32 {
        return Ok((Vec::new(), 0));
    }

    for _ in 0..3 {
        let word_count = (byte_len as usize).div_ceil(size_of::<u32>());
        let mut buffer = vec![0_u32; word_count];
        let mut actual_len = byte_len;
        // SAFETY: buffer owns at least byte_len bytes and remains alive for the
        // call. actual_len is writable and the table class matches the parser.
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut actual_len,
                0,
                family,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status == NO_ERROR {
            return Ok((buffer, actual_len as usize));
        }
        if status != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "GetExtendedTcpTable failed with Windows error {status}"
            ));
        }
        byte_len = actual_len;
    }
    Err("GetExtendedTcpTable changed size repeatedly".to_string())
}

/// # Safety
///
/// `T` must be the `repr(C)` row type associated with the table class passed
/// to `GetExtendedTcpTable`, have alignment no greater than `u32`, and accept
/// every bit pattern returned by Windows.
unsafe fn table_rows<T>(buffer: &[u32], byte_len: usize) -> Result<&[T], String> {
    if byte_len < size_of::<u32>() || buffer.is_empty() {
        return Ok(&[]);
    }
    let count = buffer[0] as usize;
    let capacity = (byte_len - size_of::<u32>()) / size_of::<T>();
    if count > capacity {
        return Err(format!(
            "Windows TCP table reported {count} rows but only {capacity} fit"
        ));
    }
    debug_assert!(std::mem::align_of::<T>() <= std::mem::align_of::<u32>());
    // SAFETY: Enforced by this function's caller contract. The count was
    // bounded against byte_len above and the u32 allocation supplies alignment.
    let rows = unsafe {
        std::slice::from_raw_parts(
            buffer
                .as_ptr()
                .cast::<u8>()
                .add(size_of::<u32>())
                .cast::<T>(),
            count,
        )
    };
    Ok(rows)
}

fn listener_pids(port: u16) -> Result<BTreeSet<u32>, String> {
    let mut pids = BTreeSet::new();

    let (ipv4, ipv4_len) = tcp_table(AF_INET as u32)?;
    // SAFETY: This is the documented row type for the IPv4 owner-PID table.
    for row in unsafe { table_rows::<MIB_TCPROW_OWNER_PID>(&ipv4, ipv4_len) }? {
        if decode_windows_tcp_port(row.dwLocalPort) == port {
            pids.insert(row.dwOwningPid);
        }
    }

    let (ipv6, ipv6_len) = tcp_table(AF_INET6 as u32)?;
    // SAFETY: This is the documented row type for the IPv6 owner-PID table.
    for row in unsafe { table_rows::<MIB_TCP6ROW_OWNER_PID>(&ipv6, ipv6_len) }? {
        if decode_windows_tcp_port(row.dwLocalPort) == port {
            pids.insert(row.dwOwningPid);
        }
    }

    Ok(pids)
}

fn expected_engine_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Failed to resolve current executable: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "Current executable has no parent directory".to_string())?;
    let sidecar_directory = if directory.ends_with("deps") {
        directory.parent().unwrap_or(directory)
    } else {
        directory
    };
    Ok(sidecar_directory.join("motrix-next-engine.exe"))
}

fn process_path(handle: HANDLE) -> Result<PathBuf, String> {
    let mut buffer = vec![0_u16; MAX_WINDOWS_PATH_CHARS];
    let mut len = buffer.len() as u32;
    // SAFETY: handle is owned and valid, and buffer/len describe writable
    // storage for the UTF-16 path exactly as required by the API.
    let succeeded = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut len) };
    if succeeded == 0 {
        return Err(format!(
            "QueryFullProcessImageNameW failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    buffer.truncate(len as usize);
    Ok(PathBuf::from(OsString::from_wide(&buffer)))
}

fn normalized_path(path: &Path) -> PathBuf {
    dunce::canonicalize(path).unwrap_or_else(|_| dunce::simplified(path).to_path_buf())
}

fn paths_match(actual: &Path, expected: &Path) -> bool {
    normalized_path(actual)
        .to_string_lossy()
        .eq_ignore_ascii_case(&normalized_path(expected).to_string_lossy())
}

fn terminate_engine_process(pid: u32, expected_path: &Path) -> Result<bool, String> {
    let access = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE;
    // SAFETY: OpenProcess takes value parameters only and returns an owned
    // handle, which is immediately wrapped for deterministic cleanup.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        return Err(format!(
            "OpenProcess failed for PID {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    let handle = OwnedHandle(handle);
    let actual_path = process_path(handle.0)?;
    if !paths_match(&actual_path, expected_path) {
        log::debug!(
            "port owner is not the bundled engine: pid={} path={}",
            pid,
            actual_path.display()
        );
        return Ok(false);
    }

    // SAFETY: handle remains valid for the complete wait/terminate sequence.
    if unsafe { WaitForSingleObject(handle.0, 0) } == WAIT_OBJECT_0 {
        return Ok(false);
    }
    // SAFETY: The full executable path was verified on this exact process
    // handle, avoiding PID-reuse and unrelated-process termination races.
    if unsafe { TerminateProcess(handle.0, 1) } == 0 {
        return Err(format!(
            "TerminateProcess failed for PID {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: handle remains owned and valid until this function returns.
    match unsafe { WaitForSingleObject(handle.0, PROCESS_EXIT_TIMEOUT_MS) } {
        WAIT_OBJECT_0 => Ok(true),
        WAIT_TIMEOUT => Err(format!(
            "Timed out waiting for engine PID {pid} to terminate"
        )),
        status => Err(format!(
            "WaitForSingleObject failed for engine PID {pid} with status {status}"
        )),
    }
}

pub(super) fn cleanup_listener(port: u16) -> Result<bool, String> {
    let expected_path = expected_engine_path()?;
    let mut terminated = false;
    for pid in listener_pids(port)? {
        match terminate_engine_process(pid, &expected_path) {
            Ok(true) => {
                log::debug!(
                    "terminated leftover engine process on port {}: PID {}",
                    port,
                    pid
                );
                terminated = true;
            }
            Ok(false) => {}
            Err(error) => {
                log::warn!(
                    "failed to inspect or terminate port owner: port={} pid={} error={}",
                    port,
                    pid,
                    error
                );
            }
        }
    }
    Ok(terminated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_matching_is_case_insensitive_but_requires_the_full_path() {
        let expected = Path::new(r"C:\Program Files\MotrixNext\motrix-next-engine.exe");
        assert!(paths_match(
            Path::new(r"c:\program files\motrixnext\MOTRIX-NEXT-ENGINE.EXE"),
            expected
        ));
        assert!(!paths_match(
            Path::new(r"C:\Other\motrix-next-engine.exe"),
            expected
        ));
    }

    #[test]
    fn table_parser_rejects_an_impossible_row_count() {
        let buffer = vec![2_u32, 0, 0, 0, 0, 0, 0];
        let byte_len = size_of::<u32>() + size_of::<MIB_TCPROW_OWNER_PID>();
        // SAFETY: The synthetic buffer is interpreted as the documented IPv4
        // row type; the function rejects the count before reading any row.
        assert!(unsafe { table_rows::<MIB_TCPROW_OWNER_PID>(&buffer, byte_len) }.is_err());
    }
}
