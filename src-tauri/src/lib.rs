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
    time::{SystemTime, UNIX_EPOCH},
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
    let has_drive_prefix = filename.as_bytes().get(1) == Some(&b':')
        && filename
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic);
    if filename.is_empty()
        || filename.contains('\0')
        || filename.contains(['/', '\\', ':'])
        || path.is_absolute()
        || has_drive_prefix
        || filename == "."
        || filename == ".."
        || path.file_name().and_then(|name| name.to_str()) != Some(filename)
    {
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

fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("Failed to sync config directory {}: {e}", parent.display()))?;
    }
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

fn atomic_replace_temp(temp: &Path, target: &Path) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("Config path has no parent: {}", target.display()))?;

    match fs::rename(temp, target) {
        Ok(()) => {
            sync_parent_directory(parent)?;
            return Ok(());
        }
        Err(first_error) if !target.exists() || !target.is_file() => {
            return Err(format!(
                "Failed to replace config file {}: {first_error}",
                target.display()
            ));
        }
        Err(_) => {}
    }

    // Windows cannot rename over an existing file. Move the old target aside,
    // replace it, and restore the old file if the second rename fails.
    let backup = parent.join(format!(
        ".{}.replace-backup-{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config"),
        std::process::id()
    ));
    let _ = fs::remove_file(&backup);
    fs::rename(target, &backup).map_err(|e| {
        format!(
            "Failed to stage existing config file {} for replacement: {e}",
            target.display()
        )
    })?;

    match fs::rename(temp, target) {
        Ok(()) => {
            let _ = fs::remove_file(&backup);
            sync_parent_directory(parent)
        }
        Err(replace_error) => {
            let restore_result = fs::rename(&backup, target);
            if let Err(restore_error) = restore_result {
                return Err(format!(
                    "Failed to replace config file {}: {replace_error}; failed to restore original: {restore_error}",
                    target.display()
                ));
            }
            Err(format!(
                "Failed to replace config file {}: {replace_error}",
                target.display()
            ))
        }
    }
}

fn atomic_write_bytes(path: &Path, content: &[u8]) -> Result<(), String> {
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
        .write_all(content)
        .map_err(|e| format!("Failed to write temporary config file: {e}"))?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary config file: {e}"))?;
    let temp_path = temp_file.into_temp_path();
    let result = atomic_replace_temp(&temp_path, path);
    if result.is_err() {
        let _ = temp_path.close();
    }
    result
}

pub(crate) fn atomic_write_config(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_bytes(path, content.as_bytes())
}

fn config_backup_path(path: &Path) -> Result<PathBuf, String> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Config path has no filename: {}", path.display()))?;
    Ok(path.with_file_name(format!("{filename}.bak")))
}

pub(crate) fn write_config_with_backup(path: &Path, content: &str) -> Result<(), String> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Config path has no filename: {}", path.display()))?;
    validate_config_content(filename, content.as_bytes())?;

    let is_primary_data_file = filename == "data.json";
    if is_primary_data_file && path.is_file() {
        let backup_path = config_backup_path(path)?;
        let previous = fs::read(path).map_err(|e| {
            format!(
                "Failed to read existing config before backup {}: {e}",
                path.display()
            )
        })?;
        validate_config_content(filename, &previous)?;
        atomic_write_bytes(&backup_path, &previous)?;
    }
    atomic_write_config(path, content)
}

fn validate_config_content(filename: &str, content: &[u8]) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(content)
        .map_err(|e| format!("Config content is not valid JSON: {e}"))?;
    if filename == "data.json" {
        let object = value
            .as_object()
            .ok_or_else(|| "Config must contain a JSON object".to_string())?;
        if !object
            .get("projects")
            .is_some_and(serde_json::Value::is_array)
            || !object
                .get("settings")
                .is_some_and(serde_json::Value::is_object)
        {
            return Err("Config does not have the expected persisted data shape".to_string());
        }
    }
    Ok(())
}

fn corrupt_snapshot_path(path: &Path) -> PathBuf {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data.json");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    path.with_file_name(format!("{filename}.corrupt-{timestamp}"))
}

fn restore_config_backup_paths(
    path: &Path,
    backup_path: &Path,
    filename: &str,
) -> Result<String, String> {
    let backup = fs::read(backup_path).map_err(|e| {
        format!(
            "Failed to read config backup {}: {e}",
            backup_path.display()
        )
    })?;
    validate_config_content(filename, &backup)?;

    let snapshot = if path.is_file() {
        let mut candidate = corrupt_snapshot_path(path);
        while candidate.exists() {
            candidate = candidate.with_file_name(format!(
                "{}.corrupt-{}",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("data.json"),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_nanos())
                    .unwrap_or_default()
            ));
        }
        let current = fs::read(path)
            .map_err(|e| format!("Failed to snapshot damaged config {}: {e}", path.display()))?;
        atomic_write_bytes(&candidate, &current)?;
        Some(candidate)
    } else {
        None
    };

    atomic_write_bytes(path, &backup)?;
    Ok(snapshot
        .and_then(|snapshot_path| {
            snapshot_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default())
}

fn read_config_from_paths(data_path: &Path, legacy_path: &Path) -> Result<String, String> {
    if data_path.exists() {
        return fs::read_to_string(data_path)
            .map_err(|e| format!("Failed to read config file {}: {e}", data_path.display()));
    }

    // A missing primary with a backup is a recovery case, not a legacy
    // migration case. Let the frontend enter read-only mode and ask the user.
    if config_backup_path(data_path)?.is_file() {
        return Ok(String::new());
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
    write_config_with_backup(&path, &content)
}

#[tauri::command]
fn has_config_backup(app: tauri::AppHandle, filename: String) -> Result<bool, String> {
    let path = config_backup_path(&app_config_file_path(&app, &filename)?)?;
    Ok(path.is_file())
}

#[tauri::command]
fn read_config_backup(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let path = config_backup_path(&app_config_file_path(&app, &filename)?)?;
    fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read config backup {}: {e}", path.display()))
}

#[tauri::command]
fn restore_config_backup(app: tauri::AppHandle, filename: String) -> Result<String, String> {
    let primary = app_config_file_path(&app, &filename)?;
    let backup = config_backup_path(&primary)?;
    restore_config_backup_paths(&primary, &backup, &filename)?;
    fs::read_to_string(&backup).map_err(|e| {
        format!(
            "Failed to read restored config backup {}: {e}",
            backup.display()
        )
    })
}

#[tauri::command]
fn can_open_config_directory() -> bool {
    true
}

#[tauri::command]
fn open_config_directory(app: tauri::AppHandle) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    runner::open_folder(directory.to_string_lossy().into_owned())
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
    exit_state: tauri::State<'_, ExitState>,
) {
    if exit_state
        .requested
        .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        return;
    }
    runner::cleanup_processes(&state);
    git::cleanup_git_processes(&git_state);
    app.exit(0);
}

struct ExitState {
    requested: std::sync::atomic::AtomicBool,
}

impl Default for ExitState {
    fn default() -> Self {
        Self {
            requested: std::sync::atomic::AtomicBool::new(false),
        }
    }
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
        .manage(ExitState::default())
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
            runner::open_path,
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
            has_config_backup,
            read_config_backup,
            restore_config_backup,
            can_open_config_directory,
            open_config_directory,
            get_startup_args
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            // User-driven process exits have no exit code. Let the frontend
            // flush data/history and decide whether to retry, cancel, or exit.
            if code.is_none() {
                api.prevent_exit();
                let _ = app_handle.emit("native-exit-requested", ());
                return;
            }

            let exit_state = app_handle.state::<ExitState>();
            if exit_state
                .requested
                .swap(true, std::sync::atomic::Ordering::AcqRel)
            {
                return;
            }
            let state = app_handle.state::<runner::ProcessState>();
            let git_state = app_handle.state::<git::GitOperationState>();
            runner::cleanup_processes(&state);
            git::cleanup_git_processes(&git_state);
        }
    });
}

#[cfg(test)]
mod config_file_tests {
    use super::{
        atomic_write_config, read_config_from_paths, restore_config_backup_paths,
        validate_config_filename, write_config_with_backup,
    };
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
    fn does_not_migrate_legacy_config_when_primary_backup_exists() {
        let temp = tempdir().expect("temp directory");
        let data_path = temp.path().join("data.json");
        let legacy_path = temp.path().join("legacy-data.json");
        fs::write(data_path.with_file_name("data.json.bak"), "backup")
            .expect("write backup config");
        fs::write(&legacy_path, "legacy").expect("write legacy config");

        let content = read_config_from_paths(&data_path, &legacy_path).expect("read config");

        assert_eq!(content, "");
        assert!(!data_path.exists());
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
        assert!(validate_config_filename(r"nested\data.json").is_err());
        assert!(validate_config_filename(r"C:\data.json").is_err());
        assert!(validate_config_filename("C:data.json").is_err());
        assert!(validate_config_filename("data.json:stream").is_err());
        assert!(validate_config_filename("data\0.json").is_err());
        assert!(validate_config_filename("").is_err());
        assert!(validate_config_filename("data.json").is_ok());
    }

    #[test]
    fn rotates_one_last_known_good_backup() {
        let temp = tempdir().expect("temp directory");
        let path = temp.path().join("data.json");
        let first = r#"{"projects":[],"settings":{},"customNodes":[],"marker":"A"}"#;
        let second = r#"{"projects":[],"settings":{},"customNodes":[],"marker":"B"}"#;
        let third = r#"{"projects":[],"settings":{},"customNodes":[],"marker":"C"}"#;

        write_config_with_backup(&path, first).expect("write A");
        write_config_with_backup(&path, second).expect("write B");
        assert_eq!(fs::read_to_string(&path).expect("read B"), second);
        assert_eq!(
            fs::read_to_string(path.with_file_name("data.json.bak")).expect("read A backup"),
            first
        );

        write_config_with_backup(&path, third).expect("write C");
        assert_eq!(fs::read_to_string(&path).expect("read C"), third);
        assert_eq!(
            fs::read_to_string(path.with_file_name("data.json.bak")).expect("read B backup"),
            second
        );
    }

    #[test]
    fn rejects_invalid_config_without_rotating_primary_or_backup() {
        let temp = tempdir().expect("temp directory");
        let path = temp.path().join("data.json");
        let first = r#"{"projects":[],"settings":{},"customNodes":[],"marker":"A"}"#;
        let second = r#"{"projects":[],"settings":{},"customNodes":[],"marker":"B"}"#;
        let third = r#"{"projects":[],"settings":{},"customNodes":[],"marker":"C"}"#;

        write_config_with_backup(&path, first).expect("write A");
        write_config_with_backup(&path, second).expect("write B");
        let backup_path = path.with_file_name("data.json.bak");
        assert!(write_config_with_backup(&path, "{invalid").is_err());
        assert_eq!(fs::read_to_string(&path).expect("read primary"), second);
        assert_eq!(
            fs::read_to_string(&backup_path).expect("read backup"),
            first
        );

        fs::write(&path, "{corrupt").expect("corrupt primary");

        assert!(write_config_with_backup(&path, third).is_err());
        assert_eq!(fs::read_to_string(&path).expect("read primary"), "{corrupt");
        assert_eq!(fs::read_to_string(backup_path).expect("read backup"), first);
    }

    #[test]
    fn auxiliary_run_history_does_not_create_config_backup() {
        let temp = tempdir().expect("temp directory");
        let path = temp.path().join("run-history.json");

        write_config_with_backup(&path, r#"{"entries":[]}"#).expect("write history A");
        write_config_with_backup(&path, r#"{"entries":[1]}"#).expect("write history B");

        assert_eq!(
            fs::read_to_string(&path).expect("read history"),
            r#"{"entries":[1]}"#
        );
        assert!(!path.with_file_name("run-history.json.bak").exists());
    }

    #[test]
    fn restore_snapshots_corrupt_primary_and_keeps_backup() {
        let temp = tempdir().expect("temp directory");
        let path = temp.path().join("data.json");
        let backup = temp.path().join("data.json.bak");
        fs::write(&path, "{broken").expect("write corrupt primary");
        fs::write(&backup, r#"{"projects":[],"settings":{}}"#).expect("write valid backup");

        let snapshot =
            restore_config_backup_paths(&path, &backup, "data.json").expect("restore backup");
        assert!(!snapshot.is_empty());
        assert_eq!(
            fs::read_to_string(&path).expect("read restored primary"),
            fs::read_to_string(&backup).expect("read backup")
        );
        assert_eq!(
            fs::read_to_string(&backup).expect("read unchanged backup"),
            r#"{"projects":[],"settings":{}}"#
        );
        let snapshots: Vec<_> = fs::read_dir(temp.path())
            .expect("list snapshots")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            fs::read_to_string(snapshots[0].path()).expect("read corrupt snapshot"),
            "{broken"
        );
    }

    #[test]
    fn invalid_backup_does_not_replace_primary() {
        let temp = tempdir().expect("temp directory");
        let path = temp.path().join("data.json");
        let backup = temp.path().join("data.json.bak");
        fs::write(&path, "{broken").expect("write corrupt primary");
        fs::write(&backup, "{also broken").expect("write corrupt backup");

        assert!(restore_config_backup_paths(&path, &backup, "data.json").is_err());
        assert_eq!(
            fs::read_to_string(&path).expect("read unchanged primary"),
            "{broken"
        );
    }
}
