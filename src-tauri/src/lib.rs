mod git;
mod node_runtime;
mod nvm;
mod project;
mod runner;
mod system;
mod system_node;
mod workspace;

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager};
use tempfile::NamedTempFile;

#[cfg(windows)]
fn disable_browser_accelerator_keys<R: tauri::Runtime>(webview: tauri::Webview<R>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let label = webview.label().to_string();
    let callback_label = label.clone();
    if let Err(error) = webview.with_webview(move |platform| unsafe {
        let result = platform
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
            .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false));
        if let Err(error) = result {
            eprintln!(
                "Failed to disable WebView2 browser accelerator keys for {callback_label}: {error}"
            );
        }
    }) {
        eprintln!("Failed to access WebView2 for {label}: {error}");
    }
}

#[cfg(not(windows))]
fn disable_browser_accelerator_keys<R: tauri::Runtime>(_webview: tauri::Webview<R>) {}

fn webview_shortcut_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webview-shortcuts")
        .on_webview_ready(disable_browser_accelerator_keys)
        .build()
}

fn validate_config_filename(filename: &str) -> Result<(), String> {
    let path = Path::new(filename);
    if filename.is_empty() || path.file_name().and_then(|name| name.to_str()) != Some(filename) {
        return Err(format!("Invalid config filename: {filename}"));
    }
    Ok(())
}

pub(crate) fn app_config_file_path(
    app: &tauri::AppHandle,
    filename: &str,
) -> Result<PathBuf, String> {
    validate_config_filename(filename)?;
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    path.push(filename);
    Ok(path)
}

fn legacy_config_file_path(filename: &str) -> Result<PathBuf, String> {
    validate_config_filename(filename)?;
    let mut path = std::env::current_exe().map_err(|e| e.to_string())?;
    path.pop();
    path.push(filename);
    Ok(path)
}

pub(crate) fn atomic_write_config(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Config path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| {
        format!(
            "Failed to create config directory {}: {e}",
            parent.display()
        )
    })?;

    let mut temp_file = NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary config file: {e}"))?;
    temp_file
        .write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write temporary config file: {e}"))?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary config file: {e}"))?;
    temp_file.persist(path).map_err(|e| {
        format!(
            "Failed to replace config file {}: {}",
            path.display(),
            e.error
        )
    })?;
    Ok(())
}

fn read_config_from_paths(data_path: &Path, legacy_path: &Path) -> Result<String, String> {
    if data_path.exists() {
        return fs::read_to_string(data_path)
            .map_err(|e| format!("Failed to read config file {}: {e}", data_path.display()));
    }

    if !legacy_path.exists() {
        return Ok(String::new());
    }

    let content = fs::read_to_string(legacy_path).map_err(|e| {
        format!(
            "Failed to read legacy config file {}: {e}",
            legacy_path.display()
        )
    })?;
    atomic_write_config(data_path, &content)?;
    Ok(content)
}

pub(crate) fn read_config_file_contents(
    app: &tauri::AppHandle,
    filename: &str,
) -> Result<String, String> {
    let data_path = app_config_file_path(app, filename)?;
    if data_path.exists() {
        return fs::read_to_string(&data_path)
            .map_err(|e| format!("Failed to read config file {}: {e}", data_path.display()));
    }

    let legacy_path = legacy_config_file_path(filename)?;
    read_config_from_paths(&data_path, &legacy_path)
}

#[tauri::command]
fn read_config_file(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    read_config_file_contents(&app, &filename)
}

#[tauri::command]
fn write_config_file(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<(), String> {
    let path = app_config_file_path(&app, &filename)?;
    atomic_write_config(&path, &content)
}

#[tauri::command]
fn get_startup_args() -> Vec<String> {
    std::env::args().collect()
}

#[tauri::command]
fn exit_app(
    app: tauri::AppHandle,
    state: tauri::State<'_, runner::ProcessState>,
    git_state: tauri::State<'_, git::GitOperationState>,
) {
    runner::cleanup_processes(&state);
    git::cleanup_git_processes(&git_state);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 3 && args[1] == "--elevated-node-operation" {
        std::process::exit(system_node::run_elevated_node_operation(&args[2]));
    }

    let app = tauri::Builder::default()
        // Windows WebView2 默认会优先处理 Ctrl+F/F5/Ctrl+数字/Alt+方向键。
        // 关闭浏览器专用加速键后，这些产品快捷键才能进入前端 keydown 链路。
        .plugin(webview_shortcut_plugin())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.len() > 1 {
                let path = args[1].clone();
                if !path.starts_with('-') {
                    let _ = app.emit("single-instance-args", path);
                }
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(runner::ProcessState::new())
        .manage(node_runtime::NodeRuntimeState::new())
        .manage(git::GitOperationState::new())
        .invoke_handler(tauri::generate_handler![
            node_runtime::list_installed_node_runtimes,
            node_runtime::list_available_node_releases,
            node_runtime::install_managed_node,
            node_runtime::cancel_managed_node_install,
            node_runtime::uninstall_managed_node,
            node_runtime::get_system_node_path,
            node_runtime::get_node_version,
            node_runtime::managed_node_runtime_supported,
            node_runtime::scan_nvm_node_runtimes,
            node_runtime::get_managed_node_runtime_location,
            node_runtime::get_managed_node_runtime_size,
            node_runtime::open_managed_node_runtime_root,
            node_runtime::migrate_managed_node_runtime_location,
            system_node::get_system_node_state,
            system_node::system_node_switch_supported_command,
            system_node::switch_system_node,
            nvm::get_nvm_list,
            nvm::install_node,
            nvm::uninstall_node,
            nvm::use_node,
            project::scan_project,
            project::scan_sub_projects,
            project::scan_import_tree,
            project::read_dir,
            project::read_text_file,
            project::write_text_file,
            project::read_binary_file_base64,
            workspace::workspace_read_dir,
            workspace::workspace_create_file,
            workspace::workspace_create_directory,
            workspace::workspace_rename,
            workspace::workspace_trash,
            workspace::workspace_stat,
            workspace::workspace_read_editor_file,
            workspace::workspace_read_binary_file_base64,
            workspace::workspace_write_editor_file,
            workspace::workspace_trash_mode,
            runner::run_project_command,
            runner::run_custom_command,
            runner::stop_project_command,
            runner::send_project_input,
            runner::close_project_input,
            runner::open_in_editor,
            runner::open_in_terminal,
            runner::install_pm,
            runner::resolve_pm,
            runner::open_folder,
            runner::reveal_in_folder,
            runner::open_url,
            system::set_context_menu,
            system::check_context_menu,
            system::is_context_menu_supported,
            system::get_platform_info,
            system::get_home_directory,
            system::detect_available_terminals,
            system::detect_available_editors,
            system::list_used_ports,
            system::terminate_process_by_pid,
            exit_app,
            git::git_check,
            git::git_init,
            git::git_list_remote_branches,
            git::git_clone_branch,
            git::git_cancel_operation,
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
            git::git_diff_for_ai,
            git::git_diff_commit,
            git::git_discard,
            git::git_discard_untracked,
            git::git_current_branch,
            git::git_list_branches,
            git::git_switch_branch,
            git::git_create_and_switch_branch,
            git::git_delete_branch,
            git::git_rename_branch,
            git::git_merge,
            git::git_merge_continue,
            git::git_merge_abort,
            git::git_rebase,
            git::git_amend,
            git::git_reset,
            git::git_cherry_pick,
            git::git_revert_commit,
            git::git_stash_list,
            git::git_stash_save,
            git::git_stash_pop,
            git::git_stash_apply,
            git::git_stash_drop,
            git::git_tags,
            git::git_create_tag,
            git::git_delete_tag,
            git::git_history,
            git::git_own_commits,
            git::git_commit_detail,
            git::git_commit_files,
            git::git_diff_commit_file,
            git::git_get_image_diff,
            git::git_get_binary_diff_meta,
            git::git_file_history,
            git::git_add_ignore_pattern,
            git::git_stop_tracking,
            git::git_apply_hunk,
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
            let git_state = app_handle.state::<git::GitOperationState>();
            runner::cleanup_processes(&state);
            git::cleanup_git_processes(&git_state);
        }
    });
}

#[cfg(test)]
mod config_file_tests {
    use super::{atomic_write_config, read_config_from_paths, validate_config_filename};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn writes_and_replaces_config_atomically() {
        let temp = tempdir().expect("temp directory");
        let path = temp.path().join("nested").join("data.json");

        atomic_write_config(&path, "first").expect("initial write");
        atomic_write_config(&path, "second").expect("replacement write");

        assert_eq!(fs::read_to_string(path).expect("read config"), "second");
    }

    #[test]
    fn migrates_legacy_config_without_deleting_it() {
        let temp = tempdir().expect("temp directory");
        let data_path = temp.path().join("data").join("data.json");
        let legacy_path = temp.path().join("legacy-data.json");
        fs::write(&legacy_path, "legacy").expect("write legacy config");

        let content = read_config_from_paths(&data_path, &legacy_path).expect("migrate config");

        assert_eq!(content, "legacy");
        assert_eq!(
            fs::read_to_string(&data_path).expect("read migrated config"),
            "legacy"
        );
        assert_eq!(
            fs::read_to_string(&legacy_path).expect("read legacy config"),
            "legacy"
        );
    }

    #[test]
    fn prefers_existing_app_data_config() {
        let temp = tempdir().expect("temp directory");
        let data_path = temp.path().join("data.json");
        let legacy_path = temp.path().join("legacy-data.json");
        fs::write(&data_path, "current").expect("write current config");
        fs::write(&legacy_path, "legacy").expect("write legacy config");

        let content = read_config_from_paths(&data_path, &legacy_path).expect("read config");

        assert_eq!(content, "current");
        assert_eq!(
            fs::read_to_string(legacy_path).expect("read legacy config"),
            "legacy"
        );
    }

    #[test]
    fn failed_replace_does_not_remove_existing_target() {
        let temp = tempdir().expect("temp directory");
        let target = temp.path().join("data.json");
        fs::create_dir(&target).expect("create target directory");
        let sentinel = target.join("keep.txt");
        fs::write(&sentinel, "keep").expect("write sentinel");

        assert!(atomic_write_config(&target, "replacement").is_err());
        assert_eq!(fs::read_to_string(sentinel).expect("read sentinel"), "keep");
    }

    #[test]
    fn rejects_nested_config_paths() {
        assert!(validate_config_filename("../data.json").is_err());
        assert!(validate_config_filename("nested/data.json").is_err());
        assert!(validate_config_filename("").is_err());
        assert!(validate_config_filename("data.json").is_ok());
    }
}
