mod git;
mod nvm;
mod project;
mod runner;
mod updater;
mod system;

use tauri::{Manager, Emitter};

#[tauri::command]
fn read_config_file(filename: String) -> Result<String, String> {
    let mut path = std::env::current_exe().map_err(|e| e.to_string())?;
    path.pop();
    path.push(filename);
    
    if !path.exists() {
        return Ok("".to_string());
    }
    
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_config_file(filename: String, content: String) -> Result<(), String> {
    let mut path = std::env::current_exe().map_err(|e| e.to_string())?;
    path.pop();
    path.push(filename);
    
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_startup_args() -> Vec<String> {
    std::env::args().collect()
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle, state: tauri::State<'_, runner::ProcessState>) {
    runner::cleanup_processes(&state);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None
        ))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.len() > 1 {
                let path = args[1].clone();
                if !path.starts_with('-') {
                    let _ = app.emit("single-instance-args", path);
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(runner::ProcessState::new())
        .manage(updater::UpdateState::new())
        .invoke_handler(tauri::generate_handler![
            nvm::get_nvm_list,
            nvm::get_node_version,
            nvm::get_system_node_path,
            nvm::install_node,
            nvm::uninstall_node,
            nvm::use_node,
            project::scan_project,
            project::read_dir,
            project::read_text_file,
            project::write_text_file,
            project::read_binary_file_base64,
            runner::run_project_command,
            runner::run_custom_command,
            runner::stop_project_command,
            runner::open_in_editor,
            runner::open_in_terminal,
            runner::open_folder,
            runner::open_url,
            updater::install_update,
            updater::cancel_update,
            system::set_context_menu,
            system::check_context_menu,
            system::is_context_menu_supported,
            system::get_platform_info,
            system::detect_available_terminals,
            exit_app,
            git::git_check,
            git::git_init,
            git::git_list_remote_branches,
            git::git_clone_branch,
            git::git_summary,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_pull,
            git::git_push,
            git::git_fetch,
            git::git_diff,
            git::git_diff_commit,
            git::git_discard,
            git::git_discard_untracked,
            git::git_current_branch,
            git::git_list_branches,
            git::git_switch_branch,
            git::git_create_and_switch_branch,
            git::git_delete_branch,
            git::git_rename_branch,
            git::git_history,
            git::git_commit_detail,
            git::git_commit_files,
            git::git_diff_commit_file,
            git::git_revert_hunk,
            git::git_remote_list,
            git::git_remote_add,
            git::git_remote_set_url,
            git::git_remote_remove,
            read_config_file,
            write_config_file,
            get_startup_args
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
             let state = app_handle.state::<runner::ProcessState>();
             runner::cleanup_processes(&state);
        }
    });
}
