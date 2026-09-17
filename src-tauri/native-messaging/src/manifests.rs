use rayburst_browser_launcher::{chromium_manifest_json, firefox_manifest_json};
use std::path::Path;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::args_os()
        .nth(1)
        .ok_or("manifest output directory is required")?;
    let directory = Path::new(&directory);
    std::fs::create_dir_all(directory)?;
    let launcher = Path::new(r"..\..\rayburst-browser-launcher.exe");
    std::fs::write(
        directory.join("chromium.json"),
        chromium_manifest_json(launcher)?,
    )?;
    std::fs::write(
        directory.join("firefox.json"),
        firefox_manifest_json(launcher)?,
    )?;
    Ok(())
}
