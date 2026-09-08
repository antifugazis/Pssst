use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("recordings");
            app.manage(pssst::commands::RecordingController::new(root).map_err(std::io::Error::other)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pssst::commands::list_capture_applications,
            pssst::commands::capture_application_icon,
            pssst::commands::capture_permission_status,
            pssst::commands::open_screen_recording_settings,
            pssst::commands::request_screen_recording_access,
            pssst::commands::validate_server_link,
            pssst::commands::start_recording,
            pssst::commands::stop_recording,
            pssst::commands::get_recording_session,
            pssst::commands::list_recording_sessions,
            pssst::commands::recording_track_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running pssst");
}
