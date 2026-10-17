fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["open_fenbi", "capture_current", "capture_report", "print_reader", "load_demo", "read_latest", "export_pdf", "smoke_finish"])
    )).expect("Tauri build failed");
}
