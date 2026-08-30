use base64::{engine::general_purpose::STANDARD, Engine as _};
use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

const MAX_BINARY_PREVIEW_SIZE: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStat {
    pub exists: bool,
    pub is_directory: bool,
    pub size: u64,
    pub disk_version: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileSnapshot {
    pub content: String,
    pub size: u64,
    pub disk_version: String,
    pub encoding: String,
    pub eol: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorWriteResult {
    pub disk_version: String,
    pub size: u64,
}

async fn run_workspace_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Workspace operation failed: {error}"))?
}

fn validate_relative_path(relative: &str, allow_empty: bool) -> Result<PathBuf, String> {
    let replaced = relative.replace('\\', "/");
    let bytes = replaced.as_bytes();
    if replaced.contains('\0')
        || replaced.starts_with('/')
        || (bytes.len() >= 2 && bytes[1] == b':')
    {
        return Err(format!("Invalid workspace-relative path: {relative}"));
    }

    let mut result = PathBuf::new();
    for part in replaced.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(format!("Path escapes workspace root: {relative}")),
            value => result.push(value),
        }
    }

    if !allow_empty && result.as_os_str().is_empty() {
        return Err(format!("Workspace-relative path is required: {relative}"));
    }
    Ok(result)
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root);
    if !path.is_absolute() {
        return Err("Workspace root must be an absolute directory".to_string());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|e| format!("Failed to resolve workspace root {}: {e}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("Workspace root is not a directory: {}", path.display()));
    }
    Ok(canonical)
}

fn ensure_within(root: &Path, candidate: &Path) -> Result<(), String> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err(format!("Path escapes workspace root: {}", candidate.display()))
    }
}

fn secure_existing_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = validate_relative_path(relative, true)?;
    let candidate = root.join(relative_path);
    let canonical = fs::canonicalize(&candidate)
        .map_err(|e| format!("Failed to resolve workspace path {}: {e}", candidate.display()))?;
    ensure_within(root, &canonical)?;
    Ok(canonical)
}

fn secure_new_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative_path = validate_relative_path(relative, false)?;
    let candidate = root.join(relative_path);
    if candidate.exists() {
        return secure_existing_path(root, relative);
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| "Workspace path has no parent".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|e| format!("Failed to resolve workspace parent {}: {e}", parent.display()))?;
    ensure_within(root, &canonical_parent)?;
    Ok(canonical_parent.join(candidate.file_name().ok_or_else(|| {
        "Workspace path has no file name".to_string()
    })?))
}

fn workspace_root_and_path(root: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_root(root)?;
    let path = secure_existing_path(&root, relative)?;
    Ok((root, path))
}

fn metadata_version(path: &Path, metadata: &fs::Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    format!(
        "{}:{}:{}:{}",
        path.to_string_lossy(),
        metadata.len(),
        modified,
        metadata.permissions().readonly()
    )
}

fn stat_path(path: &Path) -> Result<WorkspaceStat, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(WorkspaceStat {
        exists: true,
        is_directory: metadata.is_dir(),
        size: metadata.len(),
        disk_version: metadata_version(path, &metadata),
        read_only: metadata.permissions().readonly(),
    })
}

fn missing_stat(path: &Path) -> WorkspaceStat {
    WorkspaceStat {
        exists: false,
        is_directory: false,
        size: 0,
        disk_version: format!("missing:{}", path.to_string_lossy()),
        read_only: false,
    }
}

fn eol_name(bytes: &[u8]) -> &'static str {
    if bytes.windows(2).any(|window| window == b"\r\n") {
        "crlf"
    } else {
        "lf"
    }
}

fn decode_editor_bytes(bytes: &[u8]) -> (String, &'static str, bool) {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return match String::from_utf8(bytes[3..].to_vec()) {
            Ok(text) => (text, "utf-8-bom", false),
            Err(error) => (String::from_utf8_lossy(error.as_bytes()).into_owned(), "other", true),
        };
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = Encoding::for_label(b"utf-16le")
            .expect("utf-16le decoder should exist")
            .decode(&bytes[2..]);
        return (text.into_owned(), "other", true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = Encoding::for_label(b"utf-16be")
            .expect("utf-16be decoder should exist")
            .decode(&bytes[2..]);
        return (text.into_owned(), "other", true);
    }
    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        return (text, "utf-8", false);
    }

    for label in [b"gb18030".as_slice(), b"gbk".as_slice()] {
        if let Some(encoding) = Encoding::for_label(label) {
            let (text, _, had_errors) = encoding.decode(bytes);
            if !had_errors {
                return (text.into_owned(), "other", true);
            }
        }
    }

    (
        String::from_utf8_lossy(bytes).into_owned(),
        "other",
        true,
    )
}

fn normalize_editor_content(content: &str, eol: &str, bom: bool) -> Vec<u8> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let content = if eol.eq_ignore_ascii_case("crlf") {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    let mut bytes = Vec::with_capacity(content.len() + usize::from(bom) * 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(content.as_bytes());
    bytes
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.display()))?;
    let original_permissions = fs::metadata(path).ok().map(|metadata| metadata.permissions());
    let mut temp = NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create editor temporary file: {e}"))?;
    temp.write_all(bytes)
        .map_err(|e| format!("Failed to write editor temporary file: {e}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync editor temporary file: {e}"))?;
    if let Some(permissions) = original_permissions.as_ref() {
        fs::set_permissions(temp.path(), permissions.clone())
            .map_err(|e| format!("Failed to preserve editor file permissions: {e}"))?;
    }

    #[cfg(target_os = "windows")]
    {
        if path.exists() {
            let backup = NamedTempFile::new_in(parent)
                .map_err(|e| format!("Failed to prepare editor backup: {e}"))?;
            let backup_path = backup.path().to_path_buf();
            drop(backup);
            fs::rename(path, &backup_path)
                .map_err(|e| format!("Failed to move existing editor file: {e}"))?;
            return match temp.persist(path) {
                Ok(_) => {
                    let _ = fs::remove_file(&backup_path);
                    if let Some(permissions) = original_permissions {
                        let _ = fs::set_permissions(path, permissions);
                    }
                    Ok(())
                }
                Err(error) => {
                    let restore = fs::rename(&backup_path, path);
                    if let Err(restore_error) = restore {
                        return Err(format!(
                            "Failed to replace editor file: {}; restore failed: {}",
                            error.error, restore_error
                        ));
                    }
                    Err(format!("Failed to replace editor file: {}", error.error))
                }
            };
        }
    }

    temp.persist(path)
        .map_err(|e| format!("Failed to replace editor file: {}", e.error))?;
    if let Some(permissions) = original_permissions {
        let _ = fs::set_permissions(path, permissions);
    }
    Ok(())
}

fn workspace_read_dir_sync(root: &str, relative: &str) -> Result<Vec<WorkspaceDirEntry>, String> {
    let (workspace_root, directory) = workspace_root_and_path(root, relative)?;
    if !directory.is_dir() {
        return Err(format!("Workspace path is not a directory: {relative}"));
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            // Symlinks are deliberately omitted from the Explorer. This keeps a lazy
            // directory listing from exposing a path outside the project root.
            continue;
        }
        let path = entry.path();
        if let Ok(canonical) = fs::canonicalize(&path) {
            ensure_within(&workspace_root, &canonical)?;
        } else {
            continue;
        }
        let size = fs::metadata(&path).ok().map(|metadata| metadata.len());
        entries.push(WorkspaceDirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_directory: file_type.is_dir(),
            size,
        });
    }
    entries.sort_by_key(|entry| (!entry.is_directory, entry.name.to_lowercase()));
    Ok(entries)
}

fn workspace_stat_sync(root: &str, relative: &str) -> Result<WorkspaceStat, String> {
    let workspace_root = canonical_root(root)?;
    let relative_path = validate_relative_path(relative, true)?;
    let candidate = workspace_root.join(relative_path);
    if candidate.exists() {
        let path = secure_existing_path(&workspace_root, relative)?;
        return stat_path(&path);
    }

    // 文件缺失时不能只 canonicalize 直接父目录：父目录也被删时会 error。
    // 向上找最近存在的祖先，canonicalize 后确认仍在 workspace root 内，再返回 exists=false。
    let mut cursor = candidate.as_path();
    loop {
        let Some(parent) = cursor.parent() else {
            return Err(format!("Failed to resolve missing workspace path: {relative}"));
        };
        if parent.exists() {
            let canonical_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
            ensure_within(&workspace_root, &canonical_parent)?;
            return Ok(missing_stat(&candidate));
        }
        cursor = parent;
    }
}

fn workspace_read_editor_file_sync(root: &str, relative: &str) -> Result<EditorFileSnapshot, String> {
    let (workspace_root, path) = workspace_root_and_path(root, relative)?;
    if path.is_dir() {
        return Err("Cannot open a directory in the editor".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    let (content, encoding, read_only) = decode_editor_bytes(&bytes);
    ensure_within(&workspace_root, &path)?;
    Ok(EditorFileSnapshot {
        content: content.replace("\r\n", "\n").replace('\r', "\n"),
        size: metadata.len(),
        disk_version: metadata_version(&path, &metadata),
        encoding: encoding.to_string(),
        eol: eol_name(&bytes).to_string(),
        read_only: read_only || metadata.permissions().readonly(),
    })
}

fn workspace_write_editor_file_sync(
    root: &str,
    relative: &str,
    content: &str,
    expected_disk_version: Option<&str>,
    eol: Option<&str>,
    bom: Option<bool>,
    force: bool,
) -> Result<EditorWriteResult, String> {
    let workspace_root = canonical_root(root)?;
    let path = secure_new_path(&workspace_root, relative)?;
    if path.is_dir() {
        return Err("Cannot write a directory as an editor file".to_string());
    }

    let current_version = if path.exists() {
        let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
        metadata_version(&path, &metadata)
    } else {
        String::new()
    };
    if !force && expected_disk_version.unwrap_or_default() != current_version {
        return Err("external_modified".to_string());
    }

    let bytes = normalize_editor_content(content, eol.unwrap_or("lf"), bom.unwrap_or(false));
    atomic_replace(&path, &bytes)?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(EditorWriteResult {
        disk_version: metadata_version(&path, &metadata),
        size: metadata.len(),
    })
}

fn workspace_create_file_sync(root: &str, relative: &str) -> Result<(), String> {
    let workspace_root = canonical_root(root)?;
    let path = secure_new_path(&workspace_root, relative)?;
    if path.exists() {
        return Err(format!("Path already exists: {relative}"));
    }
    File::create_new(path).map(|_| ()).map_err(|e| e.to_string())
}

fn workspace_create_directory_sync(root: &str, relative: &str) -> Result<(), String> {
    let workspace_root = canonical_root(root)?;
    let path = secure_new_path(&workspace_root, relative)?;
    if path.exists() {
        return Err(format!("Path already exists: {relative}"));
    }
    fs::create_dir(path).map_err(|e| e.to_string())
}

fn workspace_rename_sync(root: &str, from: &str, to: &str) -> Result<(), String> {
    let workspace_root = canonical_root(root)?;
    let from_path = secure_existing_path(&workspace_root, from)?;
    if from_path == workspace_root {
        return Err("Cannot rename workspace root".to_string());
    }
    let to_path = secure_new_path(&workspace_root, to)?;
    if to_path.exists() {
        return Err(format!("Target path already exists: {to}"));
    }
    fs::rename(from_path, to_path).map_err(|e| e.to_string())
}

fn workspace_trash_sync(root: &str, relative: &str) -> Result<(), String> {
    let workspace_root = canonical_root(root)?;
    let path = secure_existing_path(&workspace_root, relative)?;
    if path == workspace_root {
        return Err("Cannot delete workspace root".to_string());
    }
    trash::delete(&path).map_err(|e| format!("Failed to move item to Trash: {e}"))
}

fn workspace_read_binary_sync(root: &str, relative: &str) -> Result<String, String> {
    let (_, path) = workspace_root_and_path(root, relative)?;
    if path.is_dir() {
        return Err("Cannot read a directory as binary data".to_string());
    }
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_BINARY_PREVIEW_SIZE {
        return Err("file_too_large".to_string());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn workspace_read_dir(root: String, relative_path: String) -> Result<Vec<WorkspaceDirEntry>, String> {
    run_workspace_task(move || workspace_read_dir_sync(&root, &relative_path)).await
}

#[tauri::command]
pub async fn workspace_create_file(root: String, relative_path: String) -> Result<(), String> {
    run_workspace_task(move || workspace_create_file_sync(&root, &relative_path)).await
}

#[tauri::command]
pub async fn workspace_create_directory(root: String, relative_path: String) -> Result<(), String> {
    run_workspace_task(move || workspace_create_directory_sync(&root, &relative_path)).await
}

#[tauri::command]
pub async fn workspace_rename(
    root: String,
    from_relative: String,
    to_relative: String,
) -> Result<(), String> {
    run_workspace_task(move || workspace_rename_sync(&root, &from_relative, &to_relative)).await
}

#[tauri::command]
pub async fn workspace_trash(root: String, relative_path: String) -> Result<(), String> {
    run_workspace_task(move || workspace_trash_sync(&root, &relative_path)).await
}

#[tauri::command]
pub async fn workspace_stat(root: String, relative_path: String) -> Result<WorkspaceStat, String> {
    run_workspace_task(move || workspace_stat_sync(&root, &relative_path)).await
}

#[tauri::command]
pub async fn workspace_read_editor_file(
    root: String,
    relative_path: String,
) -> Result<EditorFileSnapshot, String> {
    run_workspace_task(move || workspace_read_editor_file_sync(&root, &relative_path)).await
}

#[tauri::command]
pub async fn workspace_read_binary_file_base64(
    root: String,
    relative_path: String,
) -> Result<String, String> {
    run_workspace_task(move || workspace_read_binary_sync(&root, &relative_path)).await
}

#[tauri::command]
pub async fn workspace_write_editor_file(
    root: String,
    relative_path: String,
    content: String,
    expected_disk_version: Option<String>,
    eol: Option<String>,
    bom: Option<bool>,
    force: Option<bool>,
) -> Result<EditorWriteResult, String> {
    run_workspace_task(move || {
        workspace_write_editor_file_sync(
            &root,
            &relative_path,
            &content,
            expected_disk_version.as_deref(),
            eol.as_deref(),
            bom,
            force.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub fn workspace_trash_mode() -> String {
    "recycle_bin".to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        validate_relative_path, workspace_create_directory_sync, workspace_create_file_sync,
        workspace_read_editor_file_sync, workspace_rename_sync, workspace_stat_sync,
        workspace_write_editor_file_sync,
    };
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rejects_escape_and_absolute_paths() {
        assert!(validate_relative_path("../outside", false).is_err());
        assert!(validate_relative_path("C:/outside", false).is_err());
        assert!(validate_relative_path("/outside", false).is_err());
    }

    #[test]
    fn creates_stats_and_renames_without_touching_root() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().to_string_lossy().to_string();
        workspace_create_directory_sync(&root, "src").expect("directory should be created");
        workspace_create_file_sync(&root, "src/App.vue").expect("file should be created");
        let stat = workspace_stat_sync(&root, "src/App.vue").expect("stat should work");
        assert!(stat.exists);
        assert!(!stat.is_directory);
        workspace_rename_sync(&root, "src/App.vue", "src/Main.vue").expect("rename should work");
        assert!(workspace_stat_sync(&root, "src/Main.vue").expect("new stat").exists);
        assert!(workspace_rename_sync(&root, "", "renamed").is_err());
    }

    #[test]
    fn atomic_editor_save_preserves_crlf_and_bom() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().to_string_lossy().to_string();
        workspace_create_file_sync(&root, "file.ts").expect("file should be created");
        let first = workspace_read_editor_file_sync(&root, "file.ts").expect("snapshot");
        let saved = workspace_write_editor_file_sync(
            &root,
            "file.ts",
            "one\ntwo\n",
            Some(&first.disk_version),
            Some("crlf"),
            Some(true),
            false,
        )
        .expect("save should work");
        assert!(!saved.disk_version.is_empty());
        let bytes = fs::read(temp.path().join("file.ts")).expect("saved bytes");
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert!(bytes.windows(2).any(|window| window == b"\r\n"));
        let second = workspace_read_editor_file_sync(&root, "file.ts").expect("second snapshot");
        assert_eq!(second.encoding, "utf-8-bom");
        assert_eq!(second.eol, "crlf");
    }

    #[test]
    fn external_modified_and_force_save() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().to_string_lossy().to_string();
        workspace_create_file_sync(&root, "file.txt").expect("file should be created");
        let first = workspace_read_editor_file_sync(&root, "file.txt").expect("snapshot");
        fs::write(temp.path().join("file.txt"), "external").expect("external write");
        assert!(workspace_write_editor_file_sync(
            &root,
            "file.txt",
            "local",
            Some(&first.disk_version),
            Some("lf"),
            Some(false),
            false,
        )
        .expect_err("stale save should fail")
        .contains("external_modified"));
        workspace_write_editor_file_sync(
            &root,
            "file.txt",
            "local",
            Some(&first.disk_version),
            Some("lf"),
            Some(false),
            true,
        )
        .expect("force save should work");
    }

    #[test]
    fn missing_nested_parent_returns_exists_false() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().to_string_lossy().to_string();
        workspace_create_directory_sync(&root, "src").expect("directory should be created");
        workspace_create_directory_sync(&root, "src/nested").expect("nested directory");
        workspace_create_file_sync(&root, "src/nested/file.ts").expect("file");
        fs::remove_dir_all(temp.path().join("src")).expect("remove parent tree");
        let stat = workspace_stat_sync(&root, "src/nested/file.ts").expect("missing ancestor should still stat");
        assert!(!stat.exists);
        assert!(stat.disk_version.starts_with("missing:"));
    }

    #[test]
    fn rename_updates_disk_version_path() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().to_string_lossy().to_string();
        workspace_create_file_sync(&root, "old.ts").expect("file");
        let before = workspace_stat_sync(&root, "old.ts").expect("stat");
        workspace_rename_sync(&root, "old.ts", "new.ts").expect("rename");
        let after = workspace_stat_sync(&root, "new.ts").expect("new stat");
        assert!(after.exists);
        assert_ne!(before.disk_version, after.disk_version);
        assert!(after.disk_version.contains("new.ts") || after.disk_version.to_lowercase().contains("new.ts"));
    }

    #[cfg(unix)]
    #[test]
    fn atomic_save_preserves_unix_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempdir().expect("temp directory");
        let root = temp.path().to_string_lossy().to_string();
        workspace_create_file_sync(&root, "run.sh").expect("file");
        let path = temp.path().join("run.sh");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
        let first = workspace_read_editor_file_sync(&root, "run.sh").expect("snapshot");
        workspace_write_editor_file_sync(
            &root,
            "run.sh",
            "#!/bin/sh\necho hi\n",
            Some(&first.disk_version),
            Some("lf"),
            Some(false),
            false,
        )
        .expect("save");
        let mode = fs::metadata(&path).expect("meta").permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }

    #[cfg(windows)]
    #[test]
    fn atomic_save_preserves_windows_readonly() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().to_string_lossy().to_string();
        workspace_create_file_sync(&root, "locked.txt").expect("file");
        let path = temp.path().join("locked.txt");
        let mut permissions = fs::metadata(&path).expect("meta").permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).expect("readonly");
        // 只读文件在 Windows 上可能无法直接替换；这里验证保存失败或保存后仍只读。
        let first = workspace_read_editor_file_sync(&root, "locked.txt").expect("snapshot");
        let result = workspace_write_editor_file_sync(
            &root,
            "locked.txt",
            "changed\n",
            Some(&first.disk_version),
            Some("lf"),
            Some(false),
            false,
        );
        if result.is_ok() {
            assert!(fs::metadata(&path).expect("meta").permissions().readonly());
        }
    }
}
