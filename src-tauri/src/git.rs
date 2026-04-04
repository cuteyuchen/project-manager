use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,     // "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted"
    pub staged: bool,
    pub old_path: Option<String>,  // for renames
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
pub struct GitRemote {
    pub name: String,
    pub url: String,
    pub remote_type: String,  // "fetch" | "push"
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
}

// ─── Helper ──────────────────────────────────────────────────────────────────

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.current_dir(path)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("Failed to execute git: {}", e))?;

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
    let mut cmd = Command::new("git");
    cmd.current_dir(path)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("Failed to execute git: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_git_global(args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("Failed to execute git: {}", e))?;

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

// ─── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn git_check(path: String) -> Result<bool, String> {
    match run_git(&path, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(output) => Ok(output.trim() == "true"),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub fn git_init(path: String) -> Result<String, String> {
    run_git(&path, &["init"])
}

#[tauri::command]
pub fn git_list_remote_branches(url: String) -> Result<Vec<String>, String> {
    let output = run_git_global(&["ls-remote", "--heads", &url])?;
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
}

#[tauri::command]
pub fn git_clone_branch(url: String, branch: String, destination: String) -> Result<String, String> {
    let destination_path = std::path::Path::new(&destination);

    if destination_path.exists() {
        let mut entries = fs::read_dir(destination_path).map_err(|e| e.to_string())?;
        if entries.next().is_some() {
            return Err("Destination directory must be empty".to_string());
        }
    }

    run_git_global(&[
        "clone",
        "--branch",
        &branch,
        "--single-branch",
        &url,
        &destination,
    ])
}

#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatusResult, String> {
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

        // Handle renames (format: "R  old -> new")
        let (actual_path, old_path) = if file_path.contains(" -> ") {
            let parts: Vec<&str> = file_path.splitn(2, " -> ").collect();
            (parts[1].to_string(), Some(parts[0].to_string()))
        } else {
            (file_path.clone(), None)
        };

        // Check for conflicts
        if (x == 'U' || y == 'U') || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            conflicted.push(GitFileStatus {
                path: actual_path,
                status: "conflicted".to_string(),
                staged: false,
                old_path,
            });
            continue;
        }

        // Untracked
        if x == '?' && y == '?' {
            untracked.push(GitFileStatus {
                path: actual_path,
                status: "untracked".to_string(),
                staged: false,
                old_path: None,
            });
            continue;
        }

        // Staged changes (index column)
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

        // Unstaged changes (worktree column)
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
}

#[tauri::command]
pub fn git_stage(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["add", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["restore", "--staged", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_stage_all(path: String) -> Result<String, String> {
    run_git(&path, &["add", "-A"])
}

#[tauri::command]
pub fn git_unstage_all(path: String) -> Result<String, String> {
    run_git(&path, &["restore", "--staged", "."])
}

#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<String, String> {
    run_git(&path, &["commit", "-m", &message])
}

#[tauri::command]
pub fn git_pull(path: String, remote: Option<String>, branch: Option<String>) -> Result<String, String> {
    let mut args = vec!["pull"];
    if let Some(ref r) = remote {
        args.push(r.as_str());
    }
    if let Some(ref b) = branch {
        args.push(b.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_push(path: String, remote: Option<String>, branch: Option<String>, force: Option<bool>, set_upstream: Option<bool>) -> Result<String, String> {
    let mut args = vec!["push"];
    if force.unwrap_or(false) {
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
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_fetch(path: String, remote: Option<String>) -> Result<String, String> {
    let mut args = vec!["fetch"];
    if let Some(ref r) = remote {
        args.push(r.as_str());
    } else {
        args.push("--all");
    }
    // fetch often writes to stderr even on success
    let mut cmd = Command::new("git");
    cmd.current_dir(&path)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    
    let output = cmd.output().map_err(|e| format!("Failed to execute git: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    
    if output.status.success() {
        Ok(format!("{}{}", stdout, stderr))
    } else {
        Err(stderr)
    }
}

#[tauri::command]
pub fn git_branches(path: String) -> Result<Vec<GitBranch>, String> {
    let mut branches = Vec::new();

    // Get current branch
    let current = run_git(&path, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();

    // Get all local branches 
    let local_output = run_git(&path, &["branch", "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)"])?;
    for line in local_output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        let name = parts.get(0).unwrap_or(&"").to_string();
        let upstream = parts.get(1).and_then(|s| if s.is_empty() { None } else { Some(s.to_string()) });
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

    // Get remote branches
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
}

fn parse_track_info(track: &str) -> (i32, i32) {
    // Format: [ahead 3, behind 2] or [ahead 3] or [behind 2] or empty
    let mut ahead = 0;
    let mut behind = 0;
    
    if track.is_empty() {
        return (ahead, behind);
    }

    // Remove brackets
    let inner = track.trim_start_matches('[').trim_end_matches(']');
    
    for part in inner.split(',') {
        let part = part.trim();
        if part.starts_with("ahead ") {
            if let Ok(n) = part[6..].trim().parse::<i32>() {
                ahead = n;
            }
        } else if part.starts_with("behind ") {
            if let Ok(n) = part[7..].trim().parse::<i32>() {
                behind = n;
            }
        }
    }

    (ahead, behind)
}

#[tauri::command]
pub fn git_checkout(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["checkout", &branch])
}

#[tauri::command]
pub fn git_create_branch(path: String, name: String, start_point: Option<String>) -> Result<String, String> {
    let mut args = vec!["branch", &name];
    if let Some(ref sp) = start_point {
        args.push(sp.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_delete_branch(path: String, name: String, force: Option<bool>) -> Result<String, String> {
    let flag = if force.unwrap_or(false) { "-D" } else { "-d" };
    run_git(&path, &["branch", flag, &name])
}

#[tauri::command]
pub fn git_rename_branch(path: String, old_name: String, new_name: String) -> Result<String, String> {
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
pub fn git_rm_cached(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["rm", "--cached", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_apply_patch(path: String, patch: String, cached: Option<bool>, reverse: Option<bool>) -> Result<String, String> {
    use std::io::Write;
    let mut args = vec!["apply"];
    if cached.unwrap_or(false) {
        args.push("--cached");
    }
    if reverse.unwrap_or(false) {
        args.push("--reverse");
    }
    args.push("-");

    let mut child = std::process::Command::new("git")
        .args(&args)
        .current_dir(&path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(patch.as_bytes()).map_err(|e| e.to_string())?;
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_log(path: String, max_count: Option<i32>, all: Option<bool>) -> Result<Vec<GitCommit>, String> {
    let count_str = max_count.unwrap_or(200).to_string();
    let max_count_arg = format!("--max-count={}", count_str);
    let mut args = vec![
        "log",
        max_count_arg.as_str(),
        "--format=%H%n%h%n%an%n%ae%n%aI%n%s%n%P%n%D%n---END---",
    ];
    
    if all.unwrap_or(true) {
        args.push("--all");
    }

    let output = run_git(&path, &args)?;
    let mut commits = Vec::new();

    let mut lines: Vec<&str> = Vec::new();
    for line in output.lines() {
        if line == "---END---" {
            if lines.len() >= 7 {
                let hash = lines[0].to_string();
                let short_hash = lines[1].to_string();
                let author = lines[2].to_string();
                let email = lines[3].to_string();
                let committer = author.clone();
                let date = lines[4].to_string();
                let message = lines[5].to_string();
                let parents: Vec<String> = if lines[6].is_empty() {
                    vec![]
                } else {
                    lines[6].split(' ').map(|s| s.to_string()).collect()
                };
                let refs: Vec<String> = if lines.len() > 7 && !lines[7].is_empty() {
                    lines[7].split(", ").map(|s| s.trim().to_string()).collect()
                } else {
                    vec![]
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
                    graph_prefix: None,
                });
            }
            lines.clear();
        } else {
            lines.push(line);
        }
    }

    Ok(commits)
}

#[tauri::command]
pub fn git_diff(path: String, file: Option<String>, staged: Option<bool>) -> Result<String, String> {
    let mut args = vec!["diff"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }
    if let Some(ref f) = file {
        args.push("--");
        args.push(f.as_str());
    }
    run_git_relaxed(&path, &args)
}

#[tauri::command]
pub fn git_diff_commit(path: String, hash: String) -> Result<String, String> {
    // Use git show to handle all commits including root commits
    run_git_relaxed(&path, &["show", "--format=", "--patch", &hash])
}

#[tauri::command]
pub fn git_discard(path: String, files: Vec<String>) -> Result<String, String> {
    let mut args = vec!["restore", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_discard_untracked(path: String, files: Vec<String>) -> Result<String, String> {
    // For untracked files, we need to use `git clean` or just delete them
    let mut args = vec!["clean", "-f", "--"];
    let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
    args.extend(file_refs);
    run_git(&path, &args)
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
    let output = run_git_relaxed(&path, &["stash", "list", "--format=%gd%n%gs%n%aI%n---END---"])?;
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
pub fn git_remote_list(path: String) -> Result<Vec<GitRemote>, String> {
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
}

#[tauri::command]
pub fn git_remote_add(path: String, name: String, url: String) -> Result<String, String> {
    run_git(&path, &["remote", "add", &name, &url])
}

#[tauri::command]
pub fn git_remote_set_url(path: String, name: String, url: String) -> Result<String, String> {
    run_git(&path, &["remote", "set-url", &name, &url])
}

#[tauri::command]
pub fn git_remote_remove(path: String, name: String) -> Result<String, String> {
    run_git(&path, &["remote", "remove", &name])
}

#[tauri::command]
pub fn git_current_branch(path: String) -> Result<String, String> {
    let output = run_git(&path, &["branch", "--show-current"])?;
    Ok(output.trim().to_string())
}

#[tauri::command]
pub fn git_tags(path: String) -> Result<Vec<GitTag>, String> {
    let output = run_git_relaxed(&path, &["tag", "-l", "--format=%(refname:short)\t%(objectname:short)"])?;
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

// ─── New Commands (Phase 1 Refactor) ─────────────────────────────────────────

#[tauri::command]
pub fn git_summary(path: String) -> Result<GitSummary, String> {
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

    if !is_detached {
        if let Ok(upstream) = run_git(
            &path,
            &["config", &format!("branch.{}.remote", branch_raw)],
        ) {
            let remote = upstream.trim().to_string();
            if !remote.is_empty() {
                has_remote = true;
                remote_name = Some(remote);
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

    Ok(GitSummary {
        branch,
        is_detached,
        ahead,
        behind,
        has_remote,
        remote_name,
    })
}

#[tauri::command]
pub fn git_switch_branch(path: String, branch: String) -> Result<String, String> {
    // If it looks like a remote branch (e.g., "origin/feature"),
    // try to switch to the local name, or create a tracking branch
    if branch.contains('/') {
        let parts: Vec<&str> = branch.splitn(2, '/').collect();
        if parts.len() == 2 {
            let local_name = parts[1];
            // Try switching to existing local branch first
            match run_git(&path, &["switch", local_name]) {
                Ok(output) => return Ok(output),
                Err(_) => {
                    // Create tracking branch and switch
                    return run_git(
                        &path,
                        &["switch", "-c", local_name, "--track", &branch],
                    );
                }
            }
        }
    }
    run_git(&path, &["switch", &branch])
}

#[tauri::command]
pub fn git_create_and_switch_branch(
    path: String,
    name: String,
    start_point: Option<String>,
) -> Result<String, String> {
    let mut args = vec!["switch", "-c", &name];
    if let Some(ref sp) = start_point {
        args.push(sp.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_list_branches(path: String) -> Result<Vec<GitBranch>, String> {
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
        let upstream = parts
            .get(1)
            .and_then(|s| if s.is_empty() { None } else { Some(s.to_string()) });
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
}

#[tauri::command]
pub fn git_history(
    path: String,
    max_count: Option<i32>,
) -> Result<Vec<GitCommit>, String> {
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
            parts[8]
                .split(", ")
                .map(|s| s.trim().to_string())
                .collect()
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
            graph_prefix: if graph_prefix.is_empty() { None } else { Some(graph_prefix) },
        });
    }

    Ok(commits)
}

#[tauri::command]
pub fn git_commit_detail(path: String, hash: String) -> Result<GitCommit, String> {
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
}

// ─── Commit File List ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitCommitFile {
    pub path: String,
    pub status: String, // "A" | "M" | "D" | "R" | "C"
    pub old_path: Option<String>,
}

#[tauri::command]
pub fn git_commit_files(path: String, hash: String) -> Result<Vec<GitCommitFile>, String> {
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
}

#[tauri::command]
pub fn git_diff_commit_file(path: String, hash: String, file: String) -> Result<String, String> {
    run_git_relaxed(&path, &["show", "--format=", "--patch", &hash, "--", &file])
}

#[tauri::command]
pub fn git_revert_hunk(path: String, patch: String, staged: Option<bool>) -> Result<String, String> {
    let mut args = vec!["apply", "-R", "--whitespace=nowarn"];
    if staged.unwrap_or(false) {
        args.push("--cached");
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(&path)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to execute git apply: {}", e))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| format!("Failed to write patch: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to read git output: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if stderr.is_empty() {
            Err("Failed to revert hunk".to_string())
        } else {
            Err(stderr)
        }
    }
}
