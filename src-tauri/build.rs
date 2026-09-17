fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("tauri.conf.json")).expect("valid Tauri configuration");
    println!(
        "cargo:rustc-env=RAYBURST_APP_ID={}",
        config["identifier"]
            .as_str()
            .expect("application identifier")
    );
    tauri_build::build();
}
