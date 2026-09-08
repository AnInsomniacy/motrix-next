#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::io::{stdin, stdout};
use std::process::ExitCode;

use motrix_next_browser_launcher::{run_session, write_error_response, ACTIVATION_URL};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut input = stdin().lock();
    let mut output = stdout().lock();
    match run_session(&args, &mut input, &mut output, || {
        open::that(ACTIVATION_URL).map_err(|error| error.to_string())
    }) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = write_error_response(&mut output, &error);
            eprintln!("Native messaging request failed: {}", error.code());
            ExitCode::FAILURE
        }
    }
}
