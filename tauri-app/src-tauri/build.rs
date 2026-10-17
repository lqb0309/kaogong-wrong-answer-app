fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "service_ready",
            "service_call",
            "smoke_finish",
        ]),
    ))
    .expect("Tauri build failed");
}
