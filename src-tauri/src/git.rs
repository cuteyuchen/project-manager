use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use tempfile::NamedTempFile;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct GitOperationState {
    pub processes: Arc<Mutex<HashMap<String, u32>>>,
    pub cancelled: Arc<Mutex<HashSet<String>>>,
}

impl GitOperationState {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            cancelled: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"
    pub staged: bool,
    pub old_path: Option<String>, // for renames
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitBranch {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    pub upstream: Option<String>,
    pub ahead: i32,
    pub behind: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub committer: String,
    pub date: String,
    pub message: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub graph_prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOwnCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitAuthorIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitOwnCommitResult {
    pub identity: GitAuthorIdentity,
    pub commits: Vec<GitOwnCommit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
    pub remote_type: String, // "fetch" | "push"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStashEntry {
    pub index: i32,
    pub message: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitTag {
    pub name: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatusResult {
    pub staged: Vec<GitFileStatus>,
    pub unstaged: Vec<GitFileStatus>,
    pub untracked: Vec<GitFileStatus>,
    pub conflicted: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitSummary {
    pub branch: String,
    pub is_detached: bool,
    pub ahead: i32,
    pub behind: i32,
    pub has_remote: bool,
    pub remote_name: Option<String>,
    /// 跟踪分支，如 origin/main
    #[serde(default)]
    pub upstream: Option<String>,
    #[serde(default)]
    pub has_conflicts: bool,
    #[serde(default)]
    pub conflicted_count: i32,
    #[serde(default)]
    pub staged_count: i32,
    #[serde(default)]
    pub unstaged_count: i32,
    #[serde(default)]
    pub untracked_count: i32,
    /// merge | rebase | cherry-pick | revert
    #[serde(default)]
    pub operation_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitImageSide {
    pub mime: String,
    pub base64: String,
    pub size: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitImageDiffPayload {
    pub kind: String,
    pub before: Option<GitImageSide>,
    pub after: Option<GitImageSide>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBinaryDiffMeta {
    pub kind: String,
    pub before_size: Option<u64>,
    pub after_size: Option<u64>,
    pub before_exists: bool,
    pub after_exists: bool,
}

#[derive(Debug, Clone, Copy)]
enum GitIgnoreKind {
    File,
    Filename,
    Extension,
    Directory,
}

#[derive(Debug, Clone)]
enum GitBlobSource {
    Worktree,
    Index,
    Head,
    Commit(String),
}

const IMAGE_SIDE_MAX_SIZE: u64 = 10 * 1024 * 1024;
const IMAGE_TOTAL_MAX_SIZE: u64 = 20 * 1024 * 1024;

// ─── Helper ──────────────────────────────────────────────────────────────────

fn git_command(path: Option<&str>, args: &[&str]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new("git");
    if let Some(current_dir) = path {
        cmd.current_dir(current_dir);
    }
    cmd.arg("-c")
        .arg("core.quotePath=false")
        .args(args)
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.output()
        .map_err(|e| format!("Failed to execute git: {}", e))
}

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command(Some(path), args)?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        // Some git commands output useful info to stderr even on success-ish scenarios
        if stderr.is_empty() {
            Ok(stdout)
        } else {
            Err(stderr)
        }
    }
}

/// Run git and return stdout regardless of exit code (for commands like status)
fn run_git_relaxed(path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command(Some(path), args)?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_git_global(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if stderr.is_empty() {
            Err(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(stderr)
        }
    }
}

fn run_git_bytes(path: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = git_command(Some(path), args)?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn parse_git_ignore_kind(kind: &str) -> Result<GitIgnoreKind, String> {
    match kind {
        "file" => Ok(GitIgnoreKind::File),
        "filename" => Ok(GitIgnoreKind::Filename),
        "extension" => Ok(GitIgnoreKind::Extension),
        "directory" => Ok(GitIgnoreKind::Directory),
        _ => Err(format!("Unsupported ignore kind: {kind}")),
    }
}

fn normalize_repo_relative_path(raw: &str) -> Result<String, String> {
    let replaced = raw.replace('\\', "/");
    let bytes = replaced.as_bytes();
    if replaced.is_empty()
        || replaced.starts_with('/')
        || (bytes.len() >= 2 && bytes[1] == b':')
        || replaced.contains('\0')
    {
        return Err(format!("Invalid repository-relative path: {raw}"));
    }

    let mut parts = Vec::new();
    for part in replaced.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(format!("Path escapes repository root: {raw}")),
            value => parts.push(value),
        }
    }

    if parts.is_empty() {
        return Err(format!("Invalid repository-relative path: {raw}"));
    }

    Ok(parts.join("/"))
}

fn repository_root(path: &str) -> Result<PathBuf, String> {
    let root = run_git(path, &["rev-parse", "--show-toplevel"])?;
    fs::canonicalize(root.trim()).map_err(|e| format!("Failed to resolve repository root: {e}"))
}

fn resolve_worktree_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let candidate = root.join(relative);
    if !candidate.exists() {
        return Ok(candidate);
    }

    let canonical_root =
        fs::canonicalize(root).map_err(|e| format!("Failed to resolve repository root: {e}"))?;
    let canonical_candidate = fs::canonicalize(&candidate).map_err(|e| {
        format!(
            "Failed to resolve repository path {}: {e}",
            candidate.display()
        )
    })?;
    if !canonical_candidate.starts_with(&canonical_root) {
        return Err(format!("Path escapes repository root: {relative}"));
    }
    Ok(canonical_candidate)
}

fn escape_gitignore_component(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut escaped = String::with_capacity(value.len());
    for (index, ch) in chars.iter().enumerate() {
        if (index == 0 && (*ch == '#' || *ch == '!'))
            || *ch == '\\'
            || *ch == '*'
            || *ch == '?'
            || *ch == '['
            || *ch == ']'
            || (index + 1 == chars.len() && (*ch == ' ' || *ch == '\t'))
        {
            escaped.push('\\');
        }
        escaped.push(*ch);
    }
    escaped
}

fn escape_gitignore_path(relative: &str) -> String {
    relative
        .split('/')
        .map(escape_gitignore_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn build_ignore_pattern(
    root: &Path,
    raw_path: &str,
    kind: GitIgnoreKind,
) -> Result<String, String> {
    let relative = normalize_repo_relative_path(raw_path)?;
    let full_path = root.join(&relative);

    match kind {
        GitIgnoreKind::File => Ok(format!("/{}", escape_gitignore_path(&relative))),
        GitIgnoreKind::Filename => {
            let name = relative.rsplit('/').next().unwrap_or(&relative);
            Ok(escape_gitignore_component(name))
        }
        GitIgnoreKind::Extension => {
            let name = relative.rsplit('/').next().unwrap_or(&relative);
            let Some(dot) = name.rfind('.') else {
                return Err(format!("File has no extension: {relative}"));
            };
            if dot == 0 || dot + 1 >= name.len() {
                return Err(format!("File has no extension: {relative}"));
            }
            let extension = &name[dot + 1..];
            Ok(format!("*.{}", escape_gitignore_component(extension)))
        }
        GitIgnoreKind::Directory => {
            let directory = if full_path.is_dir() {
                relative
            } else {
                let Some((parent, _)) = relative.rsplit_once('/') else {
                    return Err(format!("File is in repository root: {relative}"));
                };
                parent.to_string()
            };
            Ok(format!("/{}/", escape_gitignore_path(&directory)))
        }
    }
}

fn ignore_target_path(repo_path: &str, root: &Path, local: bool) -> Result<PathBuf, String> {
    if !local {
        return Ok(root.join(".gitignore"));
    }

    let git_path = run_git(repo_path, &["rev-parse", "--git-path", "info/exclude"])?;
    let path = PathBuf::from(git_path.trim());
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(root.join(path))
    }
}

fn atomic_write_utf8(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;

    let mut temp_file = NamedTempFile::new_in(parent)
        .map_err(|e| format!("Failed to create temporary ignore file: {e}"))?;
    temp_file
        .write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write temporary ignore file: {e}"))?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|e| format!("Failed to sync temporary ignore file: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        if path.exists() {
            if !path.is_file() {
                return Err(format!("Ignore path is not a file: {}", path.display()));
            }

            let backup_file = NamedTempFile::new_in(parent)
                .map_err(|e| format!("Failed to prepare ignore file replacement: {e}"))?;
            let backup_path = backup_file.path().to_path_buf();
            drop(backup_file);

            fs::rename(path, &backup_path).map_err(|e| {
                format!(
                    "Failed to move existing ignore file {}: {e}",
                    path.display()
                )
            })?;

            return match temp_file.persist(path) {
                Ok(_) => {
                    let _ = fs::remove_file(&backup_path);
                    Ok(())
                }
                Err(error) => {
                    let restore_result = fs::rename(&backup_path, path);
                    if let Err(restore_error) = restore_result {
                        return Err(format!(
                            "Failed to replace ignore file {}: {}; failed to restore original: {}",
                            path.display(),
                            error.error,
                            restore_error
                        ));
                    }
                    Err(format!(
                        "Failed to replace ignore file {}: {}",
                        path.display(),
                        error.error
                    ))
                }
            };
        }
    }

    temp_file.persist(path).map_err(|e| {
        format!(
            "Failed to replace ignore file {}: {}",
            path.display(),
            e.error
        )
    })?;
    Ok(())
}

fn append_ignore_patterns(path: &Path, patterns: &[String]) -> Result<Vec<String>, String> {
    let original = if path.exists() {
        let bytes = fs::read(path)
            .map_err(|e| format!("Failed to read ignore file {}: {e}", path.display()))?;
        String::from_utf8(bytes)
            .map_err(|_| format!("Ignore file is not valid UTF-8: {}", path.display()))?
    } else {
        String::new()
    };

    let eol = if original.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut content = original.clone();
    let mut added = Vec::new();

    for pattern in patterns {
        if pattern.is_empty() || added.iter().any(|item: &String| item == pattern) {
            continue;
        }
        let exists = original
            .lines()
            .map(|line| line.trim_end_matches('\r'))
            .any(|line| line == pattern);
        if exists {
            continue;
        }
        if !content.is_empty() && !content.ends_with('\n') {
            content.push_str(eol);
        }
        content.push_str(pattern);
        content.push_str(eol);
        added.push(pattern.clone());
    }

    if !added.is_empty() {
        atomic_write_utf8(path, &content)?;
    }
    Ok(added)
}

fn normalize_file_list(files: &[String]) -> Result<Vec<String>, String> {
    if files.is_empty() {
        return Err("At least one file is required".to_string());
    }
    files
        .iter()
        .map(|file| normalize_repo_relative_path(file))
        .collect()
}

#[cfg(unix)]
fn terminate_git_process_tree(pid: u32) {
    let script = format!(
        "target={pid}; \
         kill -TERM -- -$target 2>/dev/null || kill -TERM $target 2>/dev/null; \
         sleep 2; \
         kill -KILL -- -$target 2>/dev/null || kill -KILL $target 2>/dev/null"
    );

    let _ = Command::new("sh")
        .arg("-c")
        .arg(script)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn();
}

fn register_git_process(
    state: &GitOperationState,
    operation_id: &str,
    pid: u32,
) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    processes.insert(operation_id.to_string(), pid);
    Ok(())
}

fn unregister_git_process(state: &GitOperationState, operation_id: &str) -> Result<(), String> {
    let mut processes = state.processes.lock().map_err(|e| e.to_string())?;
    processes.remove(operation_id);
    Ok(())
}

fn mark_git_operation_cancelled(
    state: &GitOperationState,
    operation_id: &str,
) -> Result<(), String> {
    let mut cancelled = state.cancelled.lock().map_err(|e| e.to_string())?;
    cancelled.insert(operation_id.to_string());
    Ok(())
}

fn take_git_operation_cancelled(
    state: &GitOperationState,
    operation_id: &str,
) -> Result<bool, String> {
    let mut cancelled = state.cancelled.lock().map_err(|e| e.to_string())?;
    Ok(cancelled.remove(operation_id))
}

fn kill_git_process(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    #[cfg(not(target_os = "windows"))]
    {
        terminate_git_process_tree(pid);
    }
}

fn run_git_cancellable(
    state: &GitOperationState,
    operation_id: &str,
    path: Option<&str>,
    args: &[&str],
    combine_stderr_on_success: bool,
) -> Result<String, String> {
    let mut cmd = Command::new("git");
    if let Some(current_dir) = path {
        cmd.current_dir(current_dir);
    }
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute git: {}", e))?;
    let pid = child.id();
    register_git_process(state, operation_id, pid)?;

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read git output: {}", e));

    let unregister_result = unregister_git_process(state, operation_id);
    let cancelled = take_git_operation_cancelled(state, operation_id)?;

    unregister_result?;
    let output = output?;

    if cancelled {
        return Err("Operation cancelled.".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        if combine_stderr_on_success && !stderr.is_empty() {
            Ok(format!("{}{}", stdout, stderr))
        } else {
            Ok(stdout)
        }
    } else if stderr.is_empty() {
        Err(stdout)
    } else {
        Err(stderr)
    }
}

pub fn cleanup_git_processes(state: &GitOperationState) {
    let lock_result = state.processes.lock();
    if let Ok(mut lock) = lock_result {
        for (_, pid) in lock.iter() {
            kill_git_process(*pid);
        }
        lock.clear();
    }

    if let Ok(mut cancelled) = state.cancelled.lock() {
        cancelled.clear();
    }
}

async fn run_git_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Background git task failed: {}", e))?
}

#[tauri::command]
pub async fn git_cancel_operation(
    state: tauri::State<'_, GitOperationState>,
    operation_id: String,
) -> Result<(), String> {
    mark_git_operation_cancelled(&state, &operation_id)?;

    let pid = {
        let processes = state.processes.lock().map_err(|e| e.to_string())?;
        processes.get(&operation_id).copied()
    };

    if let Some(pid) = pid {
        kill_git_process(pid);
    }

    Ok(())
}

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_check(path: String) -> Result<bool, String> {
    run_git_task(move || {
        let repo_root = match run_git(&path, &["rev-parse", "--show-toplevel"]) {
            Ok(output) => output,
            Err(_) => return Ok(false),
        };
        let requested_path = match fs::canonicalize(&path) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        let repo_root_path = match fs::canonicalize(repo_root.trim()) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        Ok(requested_path == repo_root_path)
    })
    .await
}

#[tauri::command]
pub async fn git_init(path: String) -> Result<String, String> {
    run_git_task(move || run_git(&path, &["init"])).await
}

#[tauri::command]
pub async fn git_list_remote_branches(url: String) -> Result<Vec<String>, String> {
    run_git_task(move || {
        let output = run_git_global(&["ls-remote", "--heads", "--", &url])?;
        let mut branches = Vec::new();

        for line in output.lines() {
            let Some(reference) = line.split_whitespace().nth(1) else {
                continue;
            };

            if let Some(name) = reference.strip_prefix("refs/heads/") {
                if !name.is_empty() {
                    branches.push(name.to_string());
                }
            }
        }

        branches.sort();
        branches.dedup();
        Ok(branches)
    })
    .await
}

fn clone_branch_args<'a>(url: &'a str, branch: &'a str, destination: &'a str) -> [&'a str; 6] {
    ["clone", "--branch", branch, "--", url, destination]
}

fn all_branch_fetch_refspec(remote: &str) -> String {
    format!("+refs/heads/*:refs/remotes/{remote}/*")
}

fn is_legacy_single_branch_fetch_refspec(refspec: &str, remote: &str) -> bool {
    let Some((source, destination)) = refspec.split_once(':') else {
        return false;
    };

    source.starts_with("+refs/heads/")
        && !source.contains('*')
        && destination.starts_with(&format!("refs/remotes/{remote}/"))
        && !destination.contains('*')
}

fn restore_all_remote_branch_fetches(path: &str, remote: Option<&str>) -> Result<(), String> {
    let remotes = match remote {
        Some(remote) => vec![remote.to_string()],
        None => run_git(path, &["remote"])?
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
    };

    for remote in remotes {
        let key = format!("remote.{remote}.fetch");
        let refspecs = match run_git(path, &["config", "--get-all", &key]) {
            Ok(output) => output
                .lines()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>(),
            Err(_) => continue,
        };

        if refspecs.len() == 1 && is_legacy_single_branch_fetch_refspec(&refspecs[0], &remote) {
            let all_branches = all_branch_fetch_refspec(&remote);
            run_git(path, &["config", "--replace-all", &key, &all_branches])?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn git_clone_branch(
    state: tauri::State<'_, GitOperationState>,
    url: String,
    branch: String,
    destination: String,
    operation_id: Option<String>,
) -> Result<String, String> {
    let git_state = GitOperationState {
        processes: state.processes.clone(),
        cancelled: state.cancelled.clone(),
    };

    run_git_task(move || {
        let destination_path = std::path::Path::new(&destination);

        if destination_path.exists() {
            let mut entries = fs::read_dir(destination_path).map_err(|e| e.to_string())?;
            if entries.next().is_some() {
                return Err("Destination directory must be empty".to_string());
            }
        }

        let args = clone_branch_args(&url, &branch, &destination);

        if let Some(operation_id) = operation_id.as_deref() {
            run_git_cancellable(&git_state, operation_id, None, &args, true)
        } else {
            run_git_global(&args)
        }
    })
    .await
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatusResult, String> {
    run_git_task(move || {
        let output = run_git_relaxed(&path, &["status", "--porcelain=v1", "-uall"])?;

        let mut staged = Vec::new();
        let mut unstaged = Vec::new();
        let mut untracked = Vec::new();
        let mut conflicted = Vec::new();

        for line in output.lines() {
            if line.len() < 3 {
                continue;
            }

            let x = line.chars().nth(0).unwrap_or(' ');
            let y = line.chars().nth(1).unwrap_or(' ');
            let file_path = line[3..].to_string();

            let (actual_path, old_path) = if file_path.contains(" -> ") {
                let parts: Vec<&str> = file_path.splitn(2, " -> ").collect();
                (parts[1].to_string(), Some(parts[0].to_string()))
            } else {
                (file_path.clone(), None)
            };

            if (x == 'U' || y == 'U') || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
                conflicted.push(GitFileStatus {
                    path: actual_path,
                    status: "conflicted".to_string(),
                    staged: false,
                    old_path,
                });
                continue;
            }

            if x == '?' && y == '?' {
                untracked.push(GitFileStatus {
                    path: actual_path,
                    status: "untracked".to_string(),
                    staged: false,
                    old_path: None,
                });
                continue;
            }

            if x != ' ' && x != '?' {
                let status = match x {
                    'M' => "modified",
                    'A' => "added",
                    'D' => "deleted",
                    'R' => "renamed",
                    'C' => "copied",
                    _ => "modified",
                };
                staged.push(GitFileStatus {
                    path: actual_path.clone(),
                    status: status.to_string(),
                    staged: true,
                    old_path: old_path.clone(),
                });
            }

            if y != ' ' && y != '?' {
                let status = match y {
                    'M' => "modified",
                    'D' => "deleted",
                    _ => "modified",
                };
                unstaged.push(GitFileStatus {
                    path: actual_path,
                    status: status.to_string(),
                    staged: false,
                    old_path,
                });
            }
        }

        Ok(GitStatusResult {
            staged,
            unstaged,
            untracked,
            conflicted,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<String, String> {
    run_git_task(move || {
        let mut args = vec!["add", "--"];
        let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
        args.extend(file_refs);
        run_git(&path, &args)
    })
    .await
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<String, String> {
    run_git_task(move || {
        let mut args = vec!["restore", "--staged", "--"];
        let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
        args.extend(file_refs);
        run_git(&path, &args)
    })
    .await
}

#[tauri::command]
pub async fn git_stage_all(path: String) -> Result<String, String> {
    run_git_task(move || run_git(&path, &["add", "-A"])).await
}

#[tauri::command]
pub async fn git_unstage_all(path: String) -> Result<String, String> {
    run_git_task(move || run_git(&path, &["restore", "--staged", "."])).await
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    run_git_task(move || run_git(&path, &["commit", "-m", &message])).await
}

/// 修改最近一次提交信息（--amend）
#[tauri::command]
pub async fn git_amend(path: String, message: Option<String>) -> Result<String, String> {
    run_git_task(move || {
        if let Some(ref msg) = message {
            if !msg.trim().is_empty() {
                return run_git(&path, &["commit", "--amend", "-m", msg.trim()]);
            }
        }
        run_git(&path, &["commit", "--amend", "--no-edit"])
    })
    .await
}

#[tauri::command]
pub async fn git_pull(
    state: tauri::State<'_, GitOperationState>,
    path: String,
    remote: Option<String>,
    branch: Option<String>,
    operation_id: Option<String>,
    // strategy: "ff-only" | 其他/空 表示默认 pull
    strategy: Option<String>,
) -> Result<String, String> {
    let git_state = GitOperationState {
        processes: state.processes.clone(),
        cancelled: state.cancelled.clone(),
    };

    run_git_task(move || {
        let mut args = vec!["pull"];
        if strategy.as_deref() == Some("ff-only") {
            args.push("--ff-only");
        }
        if let Some(ref r) = remote {
            args.push(r.as_str());
        }
        if let Some(ref b) = branch {
            args.push(b.as_str());
        }

        if let Some(operation_id) = operation_id.as_deref() {
            run_git_cancellable(&git_state, operation_id, Some(&path), &args, false)
        } else {
            run_git(&path, &args)
        }
    })
    .await
}

#[tauri::command]
pub async fn git_push(
    state: tauri::State<'_, GitOperationState>,
    path: String,
    remote: Option<String>,
    branch: Option<String>,
    force: Option<bool>,
    set_upstream: Option<bool>,
    operation_id: Option<String>,
    // force_with_lease 优先于 force：使用 --force-with-lease
    force_with_lease: Option<bool>,
) -> Result<String, String> {
    let git_state = GitOperationState {
        processes: state.processes.clone(),
        cancelled: state.cancelled.clone(),
    };

    run_git_task(move || {
        let mut args = vec!["push"];
        if force_with_lease.unwrap_or(false) {
            args.push("--force-with-lease");
        } else if force.unwrap_or(false) {
            args.push("--force");
        }
        if set_upstream.unwrap_or(false) {
            args.push("-u");
        }
        if let Some(ref r) = remote {
            args.push(r.as_str());
        }
        if let Some(ref b) = branch {
            args.push(b.as_str());
        }

        if let Some(operation_id) = operation_id.as_deref() {
            run_git_cancellable(&git_state, operation_id, Some(&path), &args, false)
        } else {
            run_git(&path, &args)
        }
    })
    .await
}

#[tauri::command]
pub async fn git_fetch(
    state: tauri::State<'_, GitOperationState>,
    path: String,
    remote: Option<String>,
    operation_id: Option<String>,
) -> Result<String, String> {
    let git_state = GitOperationState {
        processes: state.processes.clone(),
        cancelled: state.cancelled.clone(),
    };

    run_git_task(move || {
        restore_all_remote_branch_fetches(&path, remote.as_deref())?;

        let mut args = vec!["fetch"];
        if let Some(ref r) = remote {
            args.push(r.as_str());
        } else {
            args.push("--all");
        }

        if let Some(operation_id) = operation_id.as_deref() {
            run_git_cancellable(&git_state, operation_id, Some(&path), &args, true)
        } else {
            let mut cmd = Command::new("git");
            cmd.current_dir(&path)
                .args(&args)
                .env("LANG", "en_US.UTF-8")
                .env("LC_ALL", "en_US.UTF-8")
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);

            let output = cmd
                .output()
                .map_err(|e| format!("Failed to execute git: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            if output.status.success() {
                Ok(format!("{}{}", stdout, stderr))
            } else {
                Err(stderr)
            }
        }
    })
    .await
}

#[tauri::command]
pub fn git_delete_branch(
    path: String,
    name: String,
    force: Option<bool>,
) -> Result<String, String> {
    let flag = if force.unwrap_or(false) { "-D" } else { "-d" };
    run_git(&path, &["branch", flag, &name])
}

#[tauri::command]
pub fn git_rename_branch(
    path: String,
    old_name: String,
    new_name: String,
) -> Result<String, String> {
    run_git(&path, &["branch", "-m", &old_name, &new_name])
}

#[tauri::command]
pub fn git_merge(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["merge", &branch])
}

#[tauri::command]
pub fn git_rebase(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["rebase", &branch])
}

#[tauri::command]
pub async fn git_add_ignore_pattern(
    path: String,
    files: Vec<String>,
    kind: String,
    local: Option<bool>,
) -> Result<Vec<String>, String> {
    run_git_task(move || {
        let root = repository_root(&path)?;
        let kind = parse_git_ignore_kind(&kind)?;
        let normalized_files = normalize_file_list(&files)?;
        if local.unwrap_or(false) {
            for file in &normalized_files {
                if run_git(&path, &["ls-files", "--error-unmatch", "--", file]).is_ok() {
                    return Err(format!("Tracked file cannot use local-only ignore: {file}"));
                }
            }
        }
        let patterns = normalized_files
            .iter()
            .map(|file| build_ignore_pattern(&root, file, kind))
            .collect::<Result<Vec<_>, _>>()?;
        let target = ignore_target_path(&path, &root, local.unwrap_or(false))?;
        append_ignore_patterns(&target, &patterns)
    })
    .await
}

#[tauri::command]
pub async fn git_stop_tracking(
    path: String,
    files: Vec<String>,
    kind: String,
    local: Option<bool>,
) -> Result<String, String> {
    run_git_task(move || {
        let root = repository_root(&path)?;
        let kind = parse_git_ignore_kind(&kind)?;
        let normalized_files = normalize_file_list(&files)?;
        for file in &normalized_files {
            run_git(&path, &["ls-files", "--error-unmatch", "--", file])
                .map_err(|_| format!("File is not tracked by Git: {file}"))?;
        }

        if local.unwrap_or(false) {
            return Err(
                "Tracked files cannot use local-only ignore; refusing to change Git index"
                    .to_string(),
            );
        }

        let patterns = normalized_files
            .iter()
            .map(|file| build_ignore_pattern(&root, file, kind))
            .collect::<Result<Vec<_>, _>>()?;
        let target = ignore_target_path(&path, &root, local.unwrap_or(false))?;

        // Validate the complete removal before changing the ignore file. The actual
        // command still uses --cached, so the worktree files remain untouched.
        let mut dry_run_args = vec!["rm", "--cached", "--dry-run", "--"];
        dry_run_args.extend(normalized_files.iter().map(|file| file.as_str()));
        run_git(&path, &dry_run_args)?;

        let added = append_ignore_patterns(&target, &patterns)?;
        let mut args = vec!["rm", "--cached", "--"];
        args.extend(normalized_files.iter().map(|file| file.as_str()));
        let result = run_git(&path, &args).map_err(|error| {
            if added.is_empty() {
                error
            } else {
                format!("Ignore rule was written, but stopping tracking failed: {error}")
            }
        })?;

        Ok(result)
    })
    .await
}

fn apply_patch_from_stdin(path: &str, patch: &str, mode: &str) -> Result<String, String> {
    if patch.len() as u64 > IMAGE_TOTAL_MAX_SIZE
        || !patch.contains("diff --git")
        || !patch.lines().any(|line| line.starts_with("index "))
        || !patch.contains("@@")
        || !patch.contains("--- ")
        || !patch.contains("+++ ")
    {
        return Err("Patch does not contain a safe file diff header".to_string());
    }

    let mut args = vec!["apply", "--whitespace=nowarn"];
    match mode {
        "stage" => args.push("--cached"),
        "unstage" => {
            args.push("--cached");
            args.push("--reverse");
        }
        "discard" => args.push("--reverse"),
        _ => return Err(format!("Unsupported hunk mode: {mode}")),
    }
    args.push("-");

    let mut command = Command::new("git");
    command
        .current_dir(path)
        .arg("-c")
        .arg("core.quotePath=false")
        .args(&args)
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to execute git apply: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| format!("Failed to write patch: {e}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read git apply output: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() {
            if stdout.is_empty() {
                "Failed to apply patch".to_string()
            } else {
                stdout
            }
        } else {
            stderr
        })
    }
}

#[tauri::command]
pub async fn git_apply_hunk(path: String, patch: String, mode: String) -> Result<String, String> {
    run_git_task(move || apply_patch_from_stdin(&path, &patch, &mode)).await
}

const DIFF_BINARY_MARKER: &str = "__BINARY_FILE__";
const DIFF_TOO_LARGE_MARKER: &str = "__FILE_TOO_LARGE__";
const DIFF_MAX_FILE_SIZE: u64 = 5 * 1024 * 1024; // 5MB

fn image_mime(path: &str) -> Option<&'static str> {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        Some("bmp") => Some("image/bmp"),
        Some("svg") => Some("image/svg+xml"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}

fn is_image_file_path(path: &str) -> bool {
    image_mime(path).is_some() || path.to_ascii_lowercase().ends_with(".ico")
}

fn validate_commit_hash(hash: &str) -> Result<(), String> {
    if !(4..=64).contains(&hash.len()) || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("Invalid Git commit hash".to_string());
    }
    Ok(())
}

fn git_blob_spec(source: &GitBlobSource, relative: &str) -> String {
    match source {
        GitBlobSource::Index => format!(":{relative}"),
        GitBlobSource::Head => format!("HEAD:{relative}"),
        GitBlobSource::Commit(hash) => format!("{hash}:{relative}"),
        GitBlobSource::Worktree => unreachable!("worktree has no Git blob spec"),
    }
}

fn read_blob_bytes(
    repo_path: &str,
    root: &Path,
    source: &GitBlobSource,
    relative: &str,
) -> Result<Option<Vec<u8>>, String> {
    match source {
        GitBlobSource::Worktree => {
            let full_path = resolve_worktree_path(root, relative)?;
            if !full_path.exists() {
                return Ok(None);
            }
            if full_path.is_dir() {
                return Err(format!("Cannot read directory as a file: {relative}"));
            }
            fs::read(&full_path)
                .map(Some)
                .map_err(|e| format!("Failed to read worktree file {relative}: {e}"))
        }
        _ => {
            let spec = git_blob_spec(source, relative);
            let exists = git_command(Some(repo_path), &["cat-file", "-e", &spec])?;
            if !exists.status.success() {
                return Ok(None);
            }
            run_git_bytes(repo_path, &["show", &spec]).map(Some)
        }
    }
}

fn read_blob_size(
    repo_path: &str,
    root: &Path,
    source: &GitBlobSource,
    relative: &str,
) -> Result<Option<u64>, String> {
    match source {
        GitBlobSource::Worktree => {
            let full_path = resolve_worktree_path(root, relative)?;
            if !full_path.exists() {
                return Ok(None);
            }
            if full_path.is_dir() {
                return Err(format!("Cannot read directory as a file: {relative}"));
            }
            fs::metadata(&full_path)
                .map(|metadata| Some(metadata.len()))
                .map_err(|e| format!("Failed to stat worktree file {relative}: {e}"))
        }
        _ => {
            let spec = git_blob_spec(source, relative);
            let output = git_command(Some(repo_path), &["cat-file", "-s", &spec])?;
            if !output.status.success() {
                return Ok(None);
            }
            let value = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u64>()
                .map_err(|e| format!("Failed to parse Git blob size: {e}"))?;
            Ok(Some(value))
        }
    }
}

fn resolve_diff_sources(
    repo_path: &str,
    file: &str,
    staged: bool,
    commit: Option<&str>,
    old_path: Option<&str>,
) -> Result<(Option<GitBlobSource>, String, Option<GitBlobSource>, String), String> {
    let file = normalize_repo_relative_path(file)?;
    let old_path = old_path.map(normalize_repo_relative_path).transpose()?;

    if let Some(commit) = commit {
        validate_commit_hash(commit)?;
        let commit_ref = format!("{commit}^{{commit}}");
        run_git(repo_path, &["rev-parse", "--verify", &commit_ref])?;
        let parents = run_git(repo_path, &["rev-list", "--parents", "-n", "1", commit])?;
        let parent = parents.split_whitespace().nth(1).map(str::to_string);
        let before_path = old_path.clone().unwrap_or_else(|| file.clone());
        let before_source = parent.map(GitBlobSource::Commit);
        return Ok((
            before_source,
            before_path,
            Some(GitBlobSource::Commit(commit.to_string())),
            file,
        ));
    }

    repository_root(repo_path)?;
    let tracked = run_git(repo_path, &["ls-files", "--error-unmatch", "--", &file]).is_ok();
    let before_path = old_path.unwrap_or_else(|| file.clone());

    if !staged && !tracked {
        return Ok((None, before_path, Some(GitBlobSource::Worktree), file));
    }

    if staged {
        Ok((
            Some(GitBlobSource::Head),
            before_path,
            Some(GitBlobSource::Index),
            file,
        ))
    } else {
        Ok((
            Some(GitBlobSource::Index),
            before_path,
            Some(GitBlobSource::Worktree),
            file,
        ))
    }
}

fn make_image_side(
    repo_path: &str,
    root: &Path,
    source: &GitBlobSource,
    relative: &str,
) -> Result<Option<GitImageSide>, String> {
    let Some(size) = read_blob_size(repo_path, root, source, relative)? else {
        return Ok(None);
    };
    if size > IMAGE_SIDE_MAX_SIZE {
        return Err("too_large: image side exceeds 10 MB".to_string());
    }
    let Some(bytes) = read_blob_bytes(repo_path, root, source, relative)? else {
        return Ok(None);
    };
    if bytes.len() as u64 > IMAGE_SIDE_MAX_SIZE {
        return Err("too_large: image side exceeds 10 MB".to_string());
    }
    let mime = image_mime(relative)
        .ok_or_else(|| format!("Unsupported image format: {relative}"))?
        .to_string();
    Ok(Some(GitImageSide {
        mime,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes.as_slice()),
        size: bytes.len() as u64,
        width: None,
        height: None,
    }))
}

fn is_binary_file(path: &std::path::Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 8192];
    let Ok(n) = std::io::Read::read(&mut file, &mut buf) else {
        return false;
    };
    buf[..n].contains(&0)
}

fn build_added_file_diff(repo_path: &str, file: &str) -> Result<String, String> {
    let full_path = std::path::Path::new(repo_path).join(file);

    if let Ok(meta) = std::fs::metadata(&full_path) {
        if meta.len() > DIFF_MAX_FILE_SIZE && !is_image_file_path(file) {
            return Ok(DIFF_TOO_LARGE_MARKER.to_string());
        }
    }

    if is_binary_file(&full_path) {
        return Ok(DIFF_BINARY_MARKER.to_string());
    }

    let content = std::fs::read_to_string(&full_path)
        .map_err(|e| format!("Failed to read file diff content: {}", e))?;
    let clean = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = clean.split('\n').collect();
    let total = if clean.ends_with('\n') && !lines.is_empty() {
        lines.len() - 1
    } else {
        lines.len()
    };
    let mut result = format!(
        "diff --git a/{file} b/{file}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{total} @@\n"
    );

    for line in &lines[..total] {
        result.push('+');
        result.push_str(line);
        result.push('\n');
    }

    Ok(result)
}

pub fn git_diff_sync(path: &str, file: Option<&str>, staged: bool) -> Result<String, String> {
    if let Some(f) = file {
        let full_path = std::path::Path::new(path).join(f);

        if let Ok(meta) = std::fs::metadata(&full_path) {
            if meta.len() > DIFF_MAX_FILE_SIZE && !is_image_file_path(f) {
                return Ok(DIFF_TOO_LARGE_MARKER.to_string());
            }
        }

        /***********************未追踪文件差异兜底*********************/
        if !staged {
            let ls_output = run_git(path, &["ls-files", "--error-unmatch", "--", f]);
            if ls_output.is_err() {
                return build_added_file_diff(path, f);
            }
        }
    }

    let mut args = vec!["diff", "--patch", "--find-renames", "--find-copies"];
    if staged {
        args.push("--cached");
    }
    if let Some(f) = file {
        args.push("--");
        args.push(f);
    }
    let result = run_git_relaxed(path, &args)?;

    if result.contains("Binary files") && result.contains("differ") {
        return Ok(DIFF_BINARY_MARKER.to_string());
    }

    Ok(result)
}

#[tauri::command]
pub async fn git_diff(
    path: String,
    file: Option<String>,
    staged: Option<bool>,
) -> Result<String, String> {
    run_git_task(move || git_diff_sync(&path, file.as_deref(), staged.unwrap_or(false))).await
}

fn list_staged_files(path: &str) -> Result<Vec<String>, String> {
    let output = run_git_relaxed(path, &["diff", "--cached", "--name-only", "-z"])?;
    Ok(output
        .split('\0')
        .filter(|item| !item.trim().is_empty())
        .map(|item| item.to_string())
        .collect())
}

fn git_diff_for_ai_sync(path: &str) -> Result<String, String> {
    let staged_files = list_staged_files(path)?;
    if staged_files.is_empty() {
        return Ok(String::new());
    }

    let mut args = vec!["diff", "--cached", "--"];
    let staged_refs: Vec<&str> = staged_files.iter().map(|item| item.as_str()).collect();
    args.extend(staged_refs);
    run_git_relaxed(path, &args)
}

#[tauri::command]
pub async fn git_diff_for_ai(path: String) -> Result<String, String> {
    run_git_task(move || git_diff_for_ai_sync(&path)).await
}

#[tauri::command]
pub async fn git_diff_commit(path: String, hash: String) -> Result<String, String> {
    run_git_task(move || run_git_relaxed(&path, &["show", "--format=", "--patch", &hash])).await
}

#[tauri::command]
pub async fn git_discard(path: String, files: Vec<String>) -> Result<String, String> {
    run_git_task(move || {
        let mut args = vec!["restore", "--"];
        let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
        args.extend(file_refs);
        run_git(&path, &args)
    })
    .await
}

#[tauri::command]
pub async fn git_discard_untracked(path: String, files: Vec<String>) -> Result<String, String> {
    run_git_task(move || {
        let mut args = vec!["clean", "-f", "--"];
        let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
        args.extend(file_refs);
        run_git(&path, &args)
    })
    .await
}

#[tauri::command]
pub fn git_stash_save(path: String, message: Option<String>) -> Result<String, String> {
    let mut args = vec!["stash", "push"];
    if let Some(ref m) = message {
        args.push("-m");
        args.push(m.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_stash_pop(path: String, index: Option<i32>) -> Result<String, String> {
    let idx = format!("stash@{{{}}}", index.unwrap_or(0));
    run_git(&path, &["stash", "pop", &idx])
}

#[tauri::command]
pub fn git_stash_apply(path: String, index: Option<i32>) -> Result<String, String> {
    let idx = format!("stash@{{{}}}", index.unwrap_or(0));
    run_git(&path, &["stash", "apply", &idx])
}

#[tauri::command]
pub fn git_stash_drop(path: String, index: i32) -> Result<String, String> {
    let idx = format!("stash@{{{}}}", index);
    run_git(&path, &["stash", "drop", &idx])
}

#[tauri::command]
pub fn git_stash_list(path: String) -> Result<Vec<GitStashEntry>, String> {
    let output = run_git_relaxed(
        &path,
        &["stash", "list", "--format=%gd%n%gs%n%aI%n---END---"],
    )?;
    let mut entries = Vec::new();
    let mut lines: Vec<&str> = Vec::new();

    for line in output.lines() {
        if line == "---END---" {
            if lines.len() >= 3 {
                let index_str = lines[0].trim_start_matches("stash@{").trim_end_matches('}');
                let index = index_str.parse::<i32>().unwrap_or(0);
                let message = lines[1].to_string();
                let date = lines[2].to_string();
                entries.push(GitStashEntry {
                    index,
                    message,
                    date,
                });
            }
            lines.clear();
        } else {
            lines.push(line);
        }
    }

    Ok(entries)
}

#[tauri::command]
pub async fn git_remote_list(path: String) -> Result<Vec<GitRemote>, String> {
    run_git_task(move || {
        let output = run_git(&path, &["remote", "-v"])?;
        let mut remotes = Vec::new();

        for line in output.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                let remote_type = parts[2].trim_start_matches('(').trim_end_matches(')');
                remotes.push(GitRemote {
                    name: parts[0].to_string(),
                    url: parts[1].to_string(),
                    remote_type: remote_type.to_string(),
                });
            }
        }

        Ok(remotes)
    })
    .await
}

#[tauri::command]
pub async fn git_remote_add(path: String, name: String, url: String) -> Result<String, String> {
    run_git_task(move || run_git(&path, &["remote", "add", &name, &url])).await
}

#[tauri::command]
pub async fn git_remote_set_url(path: String, name: String, url: String) -> Result<String, String> {
    run_git_task(move || run_git(&path, &["remote", "set-url", &name, &url])).await
}

#[tauri::command]
pub async fn git_remote_remove(path: String, name: String) -> Result<String, String> {
    run_git_task(move || run_git(&path, &["remote", "remove", &name])).await
}

#[tauri::command]
pub async fn git_current_branch(path: String) -> Result<String, String> {
    run_git_task(move || {
        let output = run_git(&path, &["branch", "--show-current"])?;
        Ok(output.trim().to_string())
    })
    .await
}

#[tauri::command]
pub fn git_tags(path: String) -> Result<Vec<GitTag>, String> {
    let output = run_git_relaxed(
        &path,
        &[
            "tag",
            "-l",
            "--format=%(refname:short)\t%(objectname:short)",
        ],
    )?;
    let mut tags = Vec::new();

    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        let name = parts.get(0).unwrap_or(&"").to_string();
        let hash = parts.get(1).unwrap_or(&"").to_string();
        tags.push(GitTag { name, hash });
    }

    Ok(tags)
}

#[tauri::command]
pub fn git_delete_tag(path: String, name: String) -> Result<String, String> {
    run_git(&path, &["tag", "-d", &name])
}

#[tauri::command]
pub fn git_create_tag(
    path: String,
    name: String,
    message: Option<String>,
    target: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["tag".to_string()];
    if let Some(ref msg) = message {
        if !msg.trim().is_empty() {
            args.push("-a".to_string());
            args.push(name.clone());
            args.push("-m".to_string());
            args.push(msg.trim().to_string());
        } else {
            args.push(name.clone());
        }
    } else {
        args.push(name.clone());
    }
    if let Some(ref t) = target {
        if !t.is_empty() {
            args.push(t.clone());
        }
    }
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git(&path, &arg_refs)
}

#[tauri::command]
pub fn git_merge_continue(path: String) -> Result<String, String> {
    run_git(&path, &["merge", "--continue"])
}

#[tauri::command]
pub fn git_merge_abort(path: String) -> Result<String, String> {
    run_git(&path, &["merge", "--abort"])
}

/// soft | mixed | hard，默认 target 为 HEAD~1
#[tauri::command]
pub fn git_reset(path: String, mode: String, target: Option<String>) -> Result<String, String> {
    let mode_flag = match mode.as_str() {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    let rev = target.unwrap_or_else(|| "HEAD~1".to_string());
    run_git(&path, &["reset", mode_flag, &rev])
}

#[tauri::command]
pub fn git_cherry_pick(path: String, hash: String) -> Result<String, String> {
    run_git(&path, &["cherry-pick", &hash])
}

#[tauri::command]
pub fn git_revert_commit(path: String, hash: String) -> Result<String, String> {
    // 非交互：自动生成默认 revert 信息
    run_git(&path, &["revert", "--no-edit", &hash])
}

// ─── New Commands (Phase 1 Refactor) ─────────────────────────────────────────

/// 探测仓库是否处于 merge/rebase/cherry-pick/revert 进行中
fn detect_operation_state(path: &str) -> Option<String> {
    let git_dir = match run_git(path, &["rev-parse", "--git-dir"]) {
        Ok(dir) => dir.trim().to_string(),
        Err(_) => return None,
    };
    let base = std::path::Path::new(path).join(&git_dir);
    if base.join("MERGE_HEAD").exists() {
        return Some("merge".to_string());
    }
    if base.join("CHERRY_PICK_HEAD").exists() {
        return Some("cherry-pick".to_string());
    }
    if base.join("REVERT_HEAD").exists() {
        return Some("revert".to_string());
    }
    if base.join("REBASE_HEAD").exists()
        || base.join("rebase-merge").exists()
        || base.join("rebase-apply").exists()
    {
        return Some("rebase".to_string());
    }
    None
}

/// 从 porcelain status 统计变更数量（与 git_status 分类一致）
fn count_status_buckets(path: &str) -> (i32, i32, i32, i32, bool) {
    let output = run_git_relaxed(path, &["status", "--porcelain=v1", "-uall"]).unwrap_or_default();
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;
    let mut conflicted = 0;

    for line in output.lines() {
        if line.len() < 3 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;

        if (x == 'U' || y == 'U') || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            conflicted += 1;
            continue;
        }
        if x == '?' && y == '?' {
            untracked += 1;
            continue;
        }
        if x != ' ' && x != '?' {
            staged += 1;
        }
        if y != ' ' && y != '?' {
            unstaged += 1;
        }
    }

    (staged, unstaged, untracked, conflicted, conflicted > 0)
}

#[tauri::command]
pub async fn git_summary(path: String) -> Result<GitSummary, String> {
    run_git_task(move || {
        let branch_output = run_git(&path, &["branch", "--show-current"])?;
        let branch_raw = branch_output.trim().to_string();
        let is_detached = branch_raw.is_empty();

        let branch = if is_detached {
            run_git(&path, &["rev-parse", "--short", "HEAD"])
                .unwrap_or_else(|_| "HEAD".to_string())
                .trim()
                .to_string()
        } else {
            branch_raw.clone()
        };

        let mut ahead = 0;
        let mut behind = 0;
        let mut has_remote = false;
        let mut remote_name = None;
        let mut upstream_name = None;

        if !is_detached {
            if let Ok(upstream) =
                run_git(&path, &["config", &format!("branch.{}.remote", branch_raw)])
            {
                let remote = upstream.trim().to_string();
                if !remote.is_empty() {
                    has_remote = true;
                    remote_name = Some(remote.clone());
                    // 解析完整 upstream ref
                    if let Ok(up_ref) = run_git(
                        &path,
                        &[
                            "rev-parse",
                            "--abbrev-ref",
                            &format!("{}@{{upstream}}", branch_raw),
                        ],
                    ) {
                        let up = up_ref.trim().to_string();
                        if !up.is_empty() {
                            upstream_name = Some(up);
                        }
                    }
                    if let Ok(track) = run_git(
                        &path,
                        &[
                            "rev-list",
                            "--left-right",
                            "--count",
                            &format!("{}@{{upstream}}...HEAD", branch_raw),
                        ],
                    ) {
                        let parts: Vec<&str> = track.trim().split_whitespace().collect();
                        if parts.len() == 2 {
                            behind = parts[0].parse().unwrap_or(0);
                            ahead = parts[1].parse().unwrap_or(0);
                        }
                    }
                }
            }
        }

        let (staged_count, unstaged_count, untracked_count, conflicted_count, has_conflicts) =
            count_status_buckets(&path);
        let operation_state = detect_operation_state(&path);

        Ok(GitSummary {
            branch,
            is_detached,
            ahead,
            behind,
            has_remote,
            remote_name,
            upstream: upstream_name,
            has_conflicts,
            conflicted_count,
            staged_count,
            unstaged_count,
            untracked_count,
            operation_state,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_switch_branch(path: String, branch: String) -> Result<String, String> {
    run_git_task(move || {
        if branch.contains('/') {
            let parts: Vec<&str> = branch.splitn(2, '/').collect();
            if parts.len() == 2 {
                let local_name = parts[1];
                match run_git(&path, &["switch", local_name]) {
                    Ok(output) => return Ok(output),
                    Err(_) => {
                        return run_git(&path, &["switch", "-c", local_name, "--track", &branch]);
                    }
                }
            }
        }
        run_git(&path, &["switch", &branch])
    })
    .await
}

#[tauri::command]
pub async fn git_create_and_switch_branch(
    path: String,
    name: String,
    start_point: Option<String>,
) -> Result<String, String> {
    run_git_task(move || {
        let mut args = vec!["switch", "-c", &name];
        if let Some(ref sp) = start_point {
            args.push(sp.as_str());
        }
        run_git(&path, &args)
    })
    .await
}

#[tauri::command]
pub async fn git_list_branches(path: String) -> Result<Vec<GitBranch>, String> {
    run_git_task(move || {
        let mut branches = Vec::new();

        let current = run_git(&path, &["branch", "--show-current"])
            .unwrap_or_default()
            .trim()
            .to_string();

        let local_output = run_git(
            &path,
            &[
                "branch",
                "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)",
            ],
        )?;
        for line in local_output.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.split('\t').collect();
            let name = parts.get(0).unwrap_or(&"").to_string();
            let upstream = parts.get(1).and_then(|s| {
                if s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                }
            });
            let track = parts.get(2).unwrap_or(&"").to_string();
            let (ahead, behind) = parse_track_info(&track);

            branches.push(GitBranch {
                is_current: name == current,
                name,
                is_remote: false,
                upstream,
                ahead,
                behind,
            });
        }

        let remote_output = run_git(&path, &["branch", "-r", "--format=%(refname:short)"])?;
        for line in remote_output.lines() {
            let name = line.trim().to_string();
            if name.is_empty() || name.contains("HEAD") {
                continue;
            }
            branches.push(GitBranch {
                name,
                is_remote: true,
                is_current: false,
                upstream: None,
                ahead: 0,
                behind: 0,
            });
        }

        Ok(branches)
    })
    .await
}

fn parse_track_info(track: &str) -> (i32, i32) {
    let mut ahead = 0;
    let mut behind = 0;

    for part in track
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
    {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("ahead ") {
            if let Ok(value) = value.trim().parse::<i32>() {
                ahead = value;
            }
        } else if let Some(value) = part.strip_prefix("behind ") {
            if let Ok(value) = value.trim().parse::<i32>() {
                behind = value;
            }
        }
    }

    (ahead, behind)
}

#[tauri::command]
pub async fn git_history(path: String, max_count: Option<i32>) -> Result<Vec<GitCommit>, String> {
    run_git_task(move || {
        let count_str = max_count.unwrap_or(100).to_string();
        let max_count_arg = format!("--max-count={}", count_str);
        let args = vec![
            "log",
            "--all",
            "--graph",
            max_count_arg.as_str(),
            "--format=%x1f%H%x1f%h%x1f%an%x1f%ae%x1f%cn%x1f%aI%x1f%s%x1f%P%x1f%D",
        ];

        let output = run_git_relaxed(&path, &args)?;
        let mut commits = Vec::new();
        for line in output.lines() {
            let Some(separator_idx) = line.find('\u{1f}') else {
                continue;
            };

            let graph_prefix = line[..separator_idx].to_string();
            let payload = &line[separator_idx + '\u{1f}'.len_utf8()..];
            let parts: Vec<&str> = payload.split('\u{1f}').collect();
            if parts.len() < 9 {
                continue;
            }

            let hash = parts[0].to_string();
            let short_hash = parts[1].to_string();
            let author = parts[2].to_string();
            let email = parts[3].to_string();
            let committer = parts[4].to_string();
            let date = parts[5].to_string();
            let message = parts[6].to_string();
            let parents: Vec<String> = if parts[7].trim().is_empty() {
                vec![]
            } else {
                parts[7].split(' ').map(|s| s.to_string()).collect()
            };
            let refs: Vec<String> = if parts[8].trim().is_empty() {
                vec![]
            } else {
                parts[8].split(", ").map(|s| s.trim().to_string()).collect()
            };

            commits.push(GitCommit {
                hash,
                short_hash,
                author,
                email,
                committer,
                date,
                message,
                parents,
                refs,
                graph_prefix: if graph_prefix.is_empty() {
                    None
                } else {
                    Some(graph_prefix)
                },
            });
        }

        Ok(commits)
    })
    .await
}

pub fn git_own_commits_sync(
    path: &str,
    since: &str,
    until: &str,
) -> Result<GitOwnCommitResult, String> {
    let identity = resolve_git_author_identity(path)?;
    // Git's --since/--before filter by committer date, while this view and the
    // returned `date` field are based on the author's date. Fetch the refs and
    // apply the range below so the two stay consistent.
    let output = run_git_relaxed(
        path,
        &[
            "log",
            "--all",
            "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s",
        ],
    )?;

    let mut commits = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = line.split('\u{1f}').collect();
        if parts.len() < 6 {
            continue;
        }

        let author = parts[2].to_string();
        let email = parts[3].to_string();
        let date = parts[4].to_string();
        if date.as_str() < since || date.as_str() >= until {
            continue;
        }

        if !is_own_author(&author, &email, &identity) {
            continue;
        }

        commits.push(GitOwnCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            author,
            email,
            date,
            message: parts[5].to_string(),
        });
    }

    commits.sort_by(|a, b| a.date.cmp(&b.date));

    Ok(GitOwnCommitResult { identity, commits })
}

#[tauri::command]
pub async fn git_own_commits(
    path: String,
    since: String,
    until: String,
) -> Result<GitOwnCommitResult, String> {
    run_git_task(move || git_own_commits_sync(&path, &since, &until)).await
}

#[tauri::command]
pub async fn git_commit_detail(path: String, hash: String) -> Result<GitCommit, String> {
    run_git_task(move || {
        let output = run_git_relaxed(
            &path,
            &[
                "show",
                "-s",
                "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%cn%x1f%aI%x1f%P%x1f%D%x1e%B",
                &hash,
            ],
        )?;

        let Some((meta, body)) = output.split_once('\u{1e}') else {
            return Err("Failed to parse commit detail".to_string());
        };

        let parts: Vec<&str> = meta.trim_end().split('\u{1f}').collect();
        if parts.len() < 8 {
            return Err("Failed to parse commit detail metadata".to_string());
        }

        Ok(GitCommit {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            author: parts[2].to_string(),
            email: parts[3].to_string(),
            committer: parts[4].to_string(),
            date: parts[5].to_string(),
            message: body.trim_end_matches('\n').to_string(),
            parents: if parts[6].trim().is_empty() {
                vec![]
            } else {
                parts[6].split(' ').map(|s| s.to_string()).collect()
            },
            refs: if parts[7].trim().is_empty() {
                vec![]
            } else {
                parts[7].split(", ").map(|s| s.trim().to_string()).collect()
            },
            graph_prefix: None,
        })
    })
    .await
}

// ─── Commit File List ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitFile {
    pub path: String,
    pub status: String, // "A" | "M" | "D" | "R" | "C"
    pub old_path: Option<String>,
}

#[tauri::command]
pub async fn git_commit_files(path: String, hash: String) -> Result<Vec<GitCommitFile>, String> {
    run_git_task(move || {
        let output = run_git_relaxed(&path, &["show", "--name-status", "--format=", &hash])?;
        let mut files = Vec::new();

        for line in output.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.is_empty() {
                continue;
            }
            let status_raw = parts[0];
            let status_char = &status_raw[..1];

            match status_char {
                "R" | "C" => {
                    if parts.len() >= 3 {
                        files.push(GitCommitFile {
                            path: parts[2].to_string(),
                            status: status_char.to_string(),
                            old_path: Some(parts[1].to_string()),
                        });
                    }
                }
                _ => {
                    if parts.len() >= 2 {
                        files.push(GitCommitFile {
                            path: parts[1].to_string(),
                            status: status_char.to_string(),
                            old_path: None,
                        });
                    }
                }
            }
        }

        Ok(files)
    })
    .await
}

#[tauri::command]
pub async fn git_diff_commit_file(
    path: String,
    hash: String,
    file: String,
) -> Result<String, String> {
    run_git_task(move || {
        run_git_relaxed(&path, &["show", "--format=", "--patch", &hash, "--", &file])
    })
    .await
}

#[tauri::command]
pub async fn git_get_image_diff(
    path: String,
    file: String,
    staged: Option<bool>,
    commit: Option<String>,
    old_path: Option<String>,
) -> Result<GitImageDiffPayload, String> {
    run_git_task(move || {
        let root = repository_root(&path)?;
        let (before_source, before_path, after_source, after_path) = resolve_diff_sources(
            &path,
            &file,
            staged.unwrap_or(false),
            commit.as_deref(),
            old_path.as_deref(),
        )?;

        let before = match before_source.as_ref() {
            Some(source) => make_image_side(&path, &root, source, &before_path)?,
            None => None,
        };
        let after = match after_source.as_ref() {
            Some(source) => make_image_side(&path, &root, source, &after_path)?,
            None => None,
        };
        let total_size = before.as_ref().map(|side| side.size).unwrap_or(0)
            + after.as_ref().map(|side| side.size).unwrap_or(0);
        if total_size > IMAGE_TOTAL_MAX_SIZE {
            return Err("too_large: image payload exceeds 20 MB".to_string());
        }

        Ok(GitImageDiffPayload {
            kind: "image".to_string(),
            before,
            after,
        })
    })
    .await
}

#[tauri::command]
pub async fn git_get_binary_diff_meta(
    path: String,
    file: String,
    staged: Option<bool>,
    commit: Option<String>,
    old_path: Option<String>,
) -> Result<GitBinaryDiffMeta, String> {
    run_git_task(move || {
        let root = repository_root(&path)?;
        let (before_source, before_path, after_source, after_path) = resolve_diff_sources(
            &path,
            &file,
            staged.unwrap_or(false),
            commit.as_deref(),
            old_path.as_deref(),
        )?;

        let before_size = match before_source.as_ref() {
            Some(source) => read_blob_size(&path, &root, source, &before_path)?,
            None => None,
        };
        let after_size = match after_source.as_ref() {
            Some(source) => read_blob_size(&path, &root, source, &after_path)?,
            None => None,
        };

        Ok(GitBinaryDiffMeta {
            kind: "binary".to_string(),
            before_size,
            after_size,
            before_exists: before_size.is_some(),
            after_exists: after_size.is_some(),
        })
    })
    .await
}

#[tauri::command]
pub async fn git_file_history(
    path: String,
    file: String,
    max_count: Option<i32>,
) -> Result<Vec<GitCommit>, String> {
    run_git_task(move || {
        let file = normalize_repo_relative_path(&file)?;
        let count = max_count.unwrap_or(100).max(1).to_string();
        let max_count_arg = format!("--max-count={count}");
        let output = run_git_relaxed(
            &path,
            &[
                "log",
                "--follow",
                max_count_arg.as_str(),
                "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%cn%x1f%aI%x1f%s%x1f%P%x1f%D",
                "--",
                &file,
            ],
        )?;

        let mut commits = Vec::new();
        for line in output.lines() {
            let parts: Vec<&str> = line.split('\u{1f}').collect();
            if parts.len() < 9 {
                continue;
            }
            let parents = if parts[7].trim().is_empty() {
                Vec::new()
            } else {
                parts[7].split(' ').map(str::to_string).collect()
            };
            let refs = if parts[8].trim().is_empty() {
                Vec::new()
            } else {
                parts[8]
                    .split(", ")
                    .map(|value| value.trim().to_string())
                    .collect()
            };
            commits.push(GitCommit {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                author: parts[2].to_string(),
                email: parts[3].to_string(),
                committer: parts[4].to_string(),
                date: parts[5].to_string(),
                message: parts[6].to_string(),
                parents,
                refs,
                graph_prefix: None,
            });
        }
        Ok(commits)
    })
    .await
}

#[tauri::command]
pub async fn git_revert_hunk(
    path: String,
    patch: String,
    staged: Option<bool>,
) -> Result<String, String> {
    let mode = if staged.unwrap_or(false) {
        "unstage"
    } else {
        "discard"
    };
    run_git_task(move || apply_patch_from_stdin(&path, &patch, mode)).await
}

#[cfg(test)]
mod tests {
    use super::all_branch_fetch_refspec;
    use super::append_ignore_patterns;
    use super::apply_patch_from_stdin;
    use super::build_ignore_pattern;
    use super::clone_branch_args;
    use super::git_diff_for_ai_sync;
    use super::git_diff_sync;
    use super::git_own_commits_sync;
    use super::is_image_file_path;
    use super::is_legacy_single_branch_fetch_refspec;
    use super::make_image_side;
    use super::normalize_repo_relative_path;
    use super::read_blob_bytes;
    use super::resolve_diff_sources;
    use super::run_git;
    use super::run_git_relaxed;
    use super::GitBlobSource;
    use super::IMAGE_SIDE_MAX_SIZE;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    /***********************测试仓库辅助函数*********************/

    fn create_temp_repo_dir() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let repo_dir = std::env::temp_dir().join(format!(
            "project-manager-git-tests-{}-{}",
            std::process::id(),
            timestamp,
        ));
        fs::create_dir_all(&repo_dir).expect("temp repo dir should be created");
        repo_dir
    }

    fn write_file(repo_dir: &PathBuf, relative_path: &str, content: &str) {
        fs::write(repo_dir.join(relative_path), content).expect("file should be written");
    }

    fn write_bytes(repo_dir: &Path, relative_path: &str, content: &[u8]) {
        fs::write(repo_dir.join(relative_path), content).expect("bytes should be written");
    }

    fn hunk_patches(diff: &str) -> Vec<String> {
        let lines: Vec<&str> = diff.lines().collect();
        let header_end = lines
            .iter()
            .position(|line| line.starts_with("@@"))
            .expect("diff should contain a hunk");
        let headers = lines[..header_end].join("\n");
        let starts: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter_map(|(index, line)| line.starts_with("@@").then_some(index))
            .collect();

        starts
            .iter()
            .enumerate()
            .map(|(index, start)| {
                let end = starts.get(index + 1).copied().unwrap_or(lines.len());
                format!("{}\n{}\n", headers, lines[*start..end].join("\n"))
            })
            .collect()
    }

    fn source_bytes(
        repo_path: &str,
        root: &Path,
        source: &GitBlobSource,
        relative: &str,
    ) -> Vec<u8> {
        read_blob_bytes(repo_path, root, source, relative)
            .expect("blob should be readable")
            .expect("blob should exist")
    }

    fn setup_repo(repo_dir: &PathBuf) {
        let repo_path = repo_dir.to_string_lossy().to_string();
        run_git(&repo_path, &["init"]).expect("git init should succeed");
        run_git(&repo_path, &["config", "user.name", "Project Manager Test"])
            .expect("git config user.name should succeed");
        run_git(&repo_path, &["config", "user.email", "test@example.com"])
            .expect("git config user.email should succeed");
    }

    #[test]
    fn clone_branch_keeps_all_remote_branch_refs() {
        let args = clone_branch_args(
            "https://github.com/example/project.git",
            "main",
            "C:/projects/example",
        );

        assert_eq!(
            args,
            [
                "clone",
                "--branch",
                "main",
                "--",
                "https://github.com/example/project.git",
                "C:/projects/example",
            ]
        );
        assert!(!args.contains(&"--single-branch"));
    }

    #[test]
    fn legacy_single_branch_fetch_refspec_is_upgraded_to_all_branches() {
        assert!(is_legacy_single_branch_fetch_refspec(
            "+refs/heads/main:refs/remotes/origin/main",
            "origin",
        ));
        assert!(!is_legacy_single_branch_fetch_refspec(
            "+refs/heads/*:refs/remotes/origin/*",
            "origin",
        ));
        assert_eq!(
            all_branch_fetch_refspec("origin"),
            "+refs/heads/*:refs/remotes/origin/*",
        );
    }

    /***********************AI diff 只包含暂存改动*********************/

    #[test]
    fn git_diff_for_ai_excludes_unstaged_changes() {
        let repo_dir = create_temp_repo_dir();
        let repo_path = repo_dir.to_string_lossy().to_string();

        setup_repo(&repo_dir);
        write_file(&repo_dir, "tracked.txt", "line-1\n");
        write_file(&repo_dir, "other.txt", "base\n");
        run_git(&repo_path, &["add", "."]).expect("git add should succeed");
        run_git(&repo_path, &["commit", "-m", "init"]).expect("git commit should succeed");

        write_file(&repo_dir, "tracked.txt", "line-1\nstaged-line\n");
        run_git(&repo_path, &["add", "tracked.txt"]).expect("git add tracked.txt should succeed");

        write_file(
            &repo_dir,
            "tracked.txt",
            "line-1\nstaged-line\nunstaged-same-file\n",
        );
        write_file(&repo_dir, "other.txt", "base\nunstaged-only-file\n");
        write_file(&repo_dir, "new.txt", "untracked-file\n");

        let diff = git_diff_for_ai_sync(&repo_path).expect("ai diff should be generated");

        assert!(diff.contains("tracked.txt"));
        assert!(diff.contains("staged-line"));
        assert!(!diff.contains("unstaged-same-file"));
        assert!(!diff.contains("other.txt"));
        assert!(!diff.contains("unstaged-only-file"));
        assert!(!diff.contains("new.txt"));

        let _ = fs::remove_dir_all(&repo_dir);
    }

    #[test]
    fn git_diff_for_ai_returns_empty_when_nothing_is_staged() {
        let repo_dir = create_temp_repo_dir();
        let repo_path = repo_dir.to_string_lossy().to_string();

        setup_repo(&repo_dir);
        write_file(&repo_dir, "tracked.txt", "line-1\n");
        run_git(&repo_path, &["add", "."]).expect("git add should succeed");
        run_git(&repo_path, &["commit", "-m", "init"]).expect("git commit should succeed");

        write_file(&repo_dir, "tracked.txt", "line-1\nunstaged-only\n");

        let diff = git_diff_for_ai_sync(&repo_path).expect("ai diff should be generated");

        assert!(diff.is_empty());

        let _ = fs::remove_dir_all(&repo_dir);
    }

    /***********************选中文件差异可显示*********************/

    #[test]
    fn git_diff_shows_staged_added_file_content() {
        let repo_dir = create_temp_repo_dir();
        let repo_path = repo_dir.to_string_lossy().to_string();

        setup_repo(&repo_dir);
        write_file(&repo_dir, "added.txt", "first\nsecond\n");
        run_git(&repo_path, &["add", "added.txt"]).expect("git add should succeed");

        let diff =
            git_diff_sync(&repo_path, Some("added.txt"), true).expect("diff should be generated");

        assert!(diff.contains("new file mode"));
        assert!(diff.contains("@@ -0,0 +1,2 @@"));
        assert!(diff.contains("+first"));
        assert!(diff.contains("+second"));

        let _ = fs::remove_dir_all(&repo_dir);
    }

    #[test]
    fn git_diff_shows_untracked_file_content() {
        let repo_dir = create_temp_repo_dir();
        let repo_path = repo_dir.to_string_lossy().to_string();

        setup_repo(&repo_dir);
        write_file(&repo_dir, "untracked.txt", "alpha\nbeta\n");

        let diff = git_diff_sync(&repo_path, Some("untracked.txt"), false)
            .expect("diff should be generated");

        assert!(diff.contains("new file mode"));
        assert!(diff.contains("@@ -0,0 +1,2 @@"));
        assert!(diff.contains("+alpha"));
        assert!(diff.contains("+beta"));

        let _ = fs::remove_dir_all(&repo_dir);
    }

    /***********************Ignore 文件安全写入***********************/

    #[test]
    fn ignore_patterns_preserve_eol_and_deduplicate() {
        let repo_dir = create_temp_repo_dir();
        let ignore_path = repo_dir.join(".gitignore");
        fs::write(&ignore_path, b"# keep\r\n*.log\r\nno-newline")
            .expect("ignore file should be written");

        let added = append_ignore_patterns(
            &ignore_path,
            &[
                "*.log".to_string(),
                "new.txt".to_string(),
                "new.txt".to_string(),
            ],
        )
        .expect("ignore patterns should be appended");

        assert_eq!(added, vec!["new.txt"]);
        assert_eq!(
            fs::read(&ignore_path).expect("ignore file should be readable"),
            b"# keep\r\n*.log\r\nno-newline\r\nnew.txt\r\n"
        );
        let _ = fs::remove_dir_all(&repo_dir);
    }

    #[test]
    fn ignore_patterns_normalize_paths_and_reject_escape() {
        let root = PathBuf::from("C:/repo");
        assert_eq!(
            normalize_repo_relative_path(r"src\logs\app.log")
                .expect("Windows path should normalize"),
            "src/logs/app.log"
        );
        assert!(normalize_repo_relative_path("../outside.txt").is_err());
        assert!(normalize_repo_relative_path("/outside.txt").is_err());
        assert!(normalize_repo_relative_path("C:/outside.txt").is_err());

        assert_eq!(
            build_ignore_pattern(&root, r"src\logs\app.log", super::GitIgnoreKind::File)
                .expect("file pattern should build"),
            "/src/logs/app.log"
        );
        assert_eq!(
            build_ignore_pattern(&root, "src/app.log", super::GitIgnoreKind::Filename)
                .expect("filename pattern should build"),
            "app.log"
        );
        assert_eq!(
            build_ignore_pattern(&root, "src/app.log", super::GitIgnoreKind::Extension)
                .expect("extension pattern should build"),
            "*.log"
        );
        assert!(build_ignore_pattern(&root, ".env", super::GitIgnoreKind::Extension).is_err());
        assert_eq!(
            build_ignore_pattern(&root, r"src\#cache[1]*?.log", super::GitIgnoreKind::File,)
                .expect("special characters should be escaped"),
            r"/src/\#cache\[1\]\*\?.log"
        );
    }

    /***********************Hunk patch 操作***********************/

    #[test]
    fn hunk_stage_unstage_and_discard_preserve_other_changes() {
        let repo_dir = create_temp_repo_dir();
        let repo_path = repo_dir.to_string_lossy().to_string();
        setup_repo(&repo_dir);
        let base = (1..=20)
            .map(|line| format!("line-{line}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        write_file(&repo_dir, "tracked.txt", &base);
        run_git(&repo_path, &["add", "."]).expect("git add should succeed");
        run_git(&repo_path, &["commit", "-m", "init"]).expect("git commit should succeed");

        let mut changed = base.replace("line-2\n", "first-change\n");
        changed = changed.replace("line-18\n", "second-change\n");
        write_file(&repo_dir, "tracked.txt", &changed);
        let original_worktree =
            fs::read(repo_dir.join("tracked.txt")).expect("worktree should exist");

        let diff = git_diff_sync(&repo_path, Some("tracked.txt"), false)
            .expect("unstaged diff should be generated");
        let patches = hunk_patches(&diff);
        assert_eq!(
            patches.len(),
            2,
            "two distant edits should produce two hunks"
        );

        apply_patch_from_stdin(&repo_path, &patches[0], "stage").expect("first hunk should stage");
        assert_eq!(
            fs::read(repo_dir.join("tracked.txt")).expect("worktree should remain unchanged"),
            original_worktree
        );
        let staged_diff = run_git_relaxed(&repo_path, &["diff", "--cached", "--", "tracked.txt"])
            .expect("staged diff should be readable");
        let unstaged_diff = git_diff_sync(&repo_path, Some("tracked.txt"), false)
            .expect("remaining unstaged diff should be readable");
        assert!(staged_diff.contains("first-change"));
        assert!(!staged_diff.contains("second-change"));
        assert!(unstaged_diff.contains("second-change"));
        assert!(!unstaged_diff.contains("first-change"));

        let staged_patch = hunk_patches(&staged_diff);
        assert_eq!(staged_patch.len(), 1);
        apply_patch_from_stdin(&repo_path, &staged_patch[0], "unstage")
            .expect("staged hunk should unstage");
        assert!(
            run_git_relaxed(&repo_path, &["diff", "--cached", "--", "tracked.txt"])
                .expect("index diff should be readable")
                .is_empty()
        );
        assert_eq!(
            fs::read(repo_dir.join("tracked.txt")).expect("worktree should remain unchanged"),
            original_worktree
        );

        let all_unstaged = git_diff_sync(&repo_path, Some("tracked.txt"), false)
            .expect("all unstaged diff should be readable");
        let all_patches = hunk_patches(&all_unstaged);
        assert_eq!(all_patches.len(), 2);
        apply_patch_from_stdin(&repo_path, &all_patches[1], "discard")
            .expect("second hunk should be discarded");
        let final_content =
            fs::read_to_string(repo_dir.join("tracked.txt")).expect("file should exist");
        assert!(final_content.contains("first-change"));
        assert!(final_content.contains("line-18"));
        assert!(!final_content.contains("second-change"));

        let _ = fs::remove_dir_all(&repo_dir);
    }

    #[test]
    fn synthetic_untracked_hunk_can_be_staged() {
        let repo_dir = create_temp_repo_dir();
        let repo_path = repo_dir.to_string_lossy().to_string();
        setup_repo(&repo_dir);
        write_file(&repo_dir, "new.txt", "first\nsecond\n");

        let diff = git_diff_sync(&repo_path, Some("new.txt"), false)
            .expect("untracked diff should be generated");
        let patch = hunk_patches(&diff)
            .pop()
            .expect("untracked diff should have a hunk");
        apply_patch_from_stdin(&repo_path, &patch, "stage").expect("untracked hunk should stage");
        let staged = run_git_relaxed(&repo_path, &["diff", "--cached", "--", "new.txt"])
            .expect("staged untracked diff should be readable");
        assert!(staged.contains("+first"));
        assert!(staged.contains("+second"));
        assert_eq!(
            fs::read_to_string(repo_dir.join("new.txt")).expect("file should remain"),
            "first\nsecond\n"
        );

        let _ = fs::remove_dir_all(&repo_dir);
    }

    #[test]
    fn hunk_patch_requires_git_index_header() {
        let repo_dir = create_temp_repo_dir();
        setup_repo(&repo_dir);
        let repo_path = repo_dir.to_string_lossy().to_string();
        let unsafe_patch =
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
        assert!(apply_patch_from_stdin(&repo_path, unsafe_patch, "stage").is_err());
        let _ = fs::remove_dir_all(&repo_dir);
    }

    /***********************Image blob 来源矩阵***********************/

    #[test]
    fn image_blob_sources_cover_worktree_index_head_commit_and_rename() {
        let repo_dir = create_temp_repo_dir();
        let repo_path = repo_dir.to_string_lossy().to_string();
        setup_repo(&repo_dir);
        write_bytes(&repo_dir, "old.png", b"root-image");
        run_git(&repo_path, &["add", "."]).expect("git add should succeed");
        run_git(&repo_path, &["commit", "-m", "root image"]).expect("root commit should succeed");
        let root = super::repository_root(&repo_path).expect("repository root should resolve");
        let root_hash = run_git(&repo_path, &["rev-parse", "HEAD"])
            .expect("root hash should be readable")
            .trim()
            .to_string();

        write_bytes(&repo_dir, "old.png", b"worktree-image");
        let (before, before_path, after, after_path) =
            resolve_diff_sources(&repo_path, "old.png", false, None, None)
                .expect("unstaged image sources should resolve");
        assert_eq!(before_path, "old.png");
        assert_eq!(after_path, "old.png");
        assert_eq!(
            source_bytes(&repo_path, &root, &before.unwrap(), "old.png"),
            b"root-image"
        );
        assert_eq!(
            source_bytes(&repo_path, &root, &after.unwrap(), "old.png"),
            b"worktree-image"
        );

        run_git(&repo_path, &["add", "old.png"]).expect("image should stage");
        write_bytes(&repo_dir, "old.png", b"second-worktree-image");
        let (before, _, after, _) = resolve_diff_sources(&repo_path, "old.png", true, None, None)
            .expect("staged image sources should resolve");
        assert_eq!(
            source_bytes(&repo_path, &root, &before.unwrap(), "old.png"),
            b"root-image"
        );
        assert_eq!(
            source_bytes(&repo_path, &root, &after.unwrap(), "old.png"),
            b"worktree-image"
        );

        write_bytes(&repo_dir, "untracked.png", b"untracked-image");
        let (before, _, after, _) =
            resolve_diff_sources(&repo_path, "untracked.png", false, None, None)
                .expect("untracked image sources should resolve");
        assert!(before.is_none());
        assert_eq!(
            source_bytes(&repo_path, &root, &after.unwrap(), "untracked.png"),
            b"untracked-image"
        );

        fs::remove_file(repo_dir.join("old.png")).expect("image should be deleted");
        let (before, _, after, _) = resolve_diff_sources(&repo_path, "old.png", false, None, None)
            .expect("deleted image sources should resolve");
        assert_eq!(
            source_bytes(&repo_path, &root, &before.unwrap(), "old.png"),
            b"worktree-image"
        );
        assert!(
            read_blob_bytes(&repo_path, &root, &after.unwrap(), "old.png")
                .expect("missing worktree side should be readable")
                .is_none()
        );

        run_git(&repo_path, &["mv", "old.png", "renamed.png"])
            .expect_err("old image is already deleted and cannot be renamed");
        write_bytes(&repo_dir, "old.png", b"rename-before");
        run_git(&repo_path, &["add", "old.png"]).expect("replacement image should stage");
        run_git(&repo_path, &["commit", "-m", "restore image"])
            .expect("restore commit should succeed");
        run_git(&repo_path, &["mv", "old.png", "renamed.png"]).expect("image should rename");
        write_bytes(&repo_dir, "renamed.png", b"rename-after");
        run_git(&repo_path, &["add", "renamed.png"]).expect("rename should stage");
        run_git(&repo_path, &["commit", "-m", "rename image"])
            .expect("rename commit should succeed");
        let rename_hash = run_git(&repo_path, &["rev-parse", "HEAD"])
            .expect("rename commit hash should be readable");
        let (before, before_path, after, after_path) = resolve_diff_sources(
            &repo_path,
            "renamed.png",
            false,
            Some(rename_hash.trim()),
            Some("old.png"),
        )
        .expect("commit rename sources should resolve");
        assert_eq!(before_path, "old.png");
        assert_eq!(after_path, "renamed.png");
        assert!(before.is_some());
        assert!(after.is_some());

        let (root_before, root_before_path, root_after, root_after_path) =
            resolve_diff_sources(&repo_path, "old.png", false, Some(&root_hash), None)
                .expect("root commit image sources should resolve");
        assert!(root_before.is_none());
        assert_eq!(root_before_path, "old.png");
        assert_eq!(root_after_path, "old.png");
        assert_eq!(
            source_bytes(&repo_path, &root, &root_after.unwrap(), "old.png"),
            b"root-image"
        );

        let oversized = vec![0u8; (IMAGE_SIDE_MAX_SIZE + 1) as usize];
        write_bytes(&repo_dir, "large.png", &oversized);
        let error = make_image_side(&repo_path, &root, &GitBlobSource::Worktree, "large.png")
            .expect_err("oversized image should be rejected before payload read");
        assert!(error.contains("too_large"));

        let _ = fs::remove_dir_all(&repo_dir);
    }

    #[test]
    fn image_paths_bypass_text_diff_size_guard_but_text_does_not() {
        assert!(is_image_file_path("assets/large.PNG"));
        assert!(is_image_file_path("assets/icon.ico"));
        assert!(!is_image_file_path("logs/large.txt"));
    }

    /***********************自己的提交按身份与日期过滤*********************/

    #[test]
    fn git_own_commits_filters_author_and_date_range() {
        let repo_dir = create_temp_repo_dir();
        let repo_path = repo_dir.to_string_lossy().to_string();

        setup_repo(&repo_dir);

        write_file(&repo_dir, "mine.txt", "mine\n");
        run_git(&repo_path, &["add", "."]).expect("git add should succeed");
        run_git(
            &repo_path,
            &[
                "-c",
                "user.name=Project Manager Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--date=2026-07-09T09:05:00+08:00",
                "-m",
                "mine in range",
            ],
        )
        .expect("own commit should succeed");

        write_file(&repo_dir, "other.txt", "other\n");
        run_git(&repo_path, &["add", "."]).expect("git add should succeed");
        run_git(
            &repo_path,
            &[
                "-c",
                "user.name=Other Author",
                "-c",
                "user.email=other@example.com",
                "commit",
                "--date=2026-07-10T09:05:00+08:00",
                "-m",
                "other author",
            ],
        )
        .expect("other author commit should succeed");

        write_file(&repo_dir, "old.txt", "old\n");
        run_git(&repo_path, &["add", "."]).expect("git add should succeed");
        run_git(
            &repo_path,
            &[
                "-c",
                "user.name=Project Manager Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--date=2026-06-30T23:59:00+08:00",
                "-m",
                "mine out of range",
            ],
        )
        .expect("out of range commit should succeed");

        let result = git_own_commits_sync(
            &repo_path,
            "2026-07-01T00:00:00+08:00",
            "2026-08-01T00:00:00+08:00",
        )
        .expect("own commits should be queried");

        assert_eq!(result.identity.email.as_deref(), Some("test@example.com"));
        assert_eq!(result.commits.len(), 1);
        assert_eq!(result.commits[0].message, "mine in range");

        let _ = fs::remove_dir_all(&repo_dir);
    }
}

fn read_git_config(path: &str, key: &str) -> Option<String> {
    run_git(path, &["config", "--get", key])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            run_git_global(&["config", "--global", "--get", key])
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

fn resolve_git_author_identity(path: &str) -> Result<GitAuthorIdentity, String> {
    let identity = GitAuthorIdentity {
        name: read_git_config(path, "user.name"),
        email: read_git_config(path, "user.email"),
    };

    if identity.name.is_none() && identity.email.is_none() {
        return Err("No Git author identity configured.".to_string());
    }

    Ok(identity)
}

fn is_own_author(author: &str, email: &str, identity: &GitAuthorIdentity) -> bool {
    if let Some(expected_email) = identity.email.as_deref() {
        return email.eq_ignore_ascii_case(expected_email);
    }

    if let Some(expected_name) = identity.name.as_deref() {
        return author == expected_name;
    }

    false
}
