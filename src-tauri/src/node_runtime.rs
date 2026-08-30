use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const NODE_DIST_HOST: &str = "https://nodejs.org";
const VERSION_RE: &str = r"^v?\d+\.\d+\.\d+$";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntimeInfo {
    pub version: String,
    pub path: String,
    pub source: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeReleaseInfo {
    pub version: String,
    pub date: String,
    #[serde(default)]
    pub lts: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInstallProgress {
    pub operation_id: String,
    pub version: String,
    pub phase: String,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub percent: Option<u32>,
}

pub struct NodeRuntimeState {
    installing: Mutex<HashSet<String>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl NodeRuntimeState {
    pub fn new() -> Self {
        Self {
            installing: Mutex::new(HashSet::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }
}

/// 规范化为 `vX.Y.Z`，拒绝 nightly / 路径注入。
pub fn validate_node_version(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..")
    {
        return Err(format!("Invalid Node version: {raw}"));
    }
    let normalized = if trimmed.starts_with('v') || trimmed.starts_with('V') {
        format!("v{}", &trimmed[1..])
    } else {
        format!("v{trimmed}")
    };
    let rest = &normalized[1..];
    let mut parts = rest.split('.');
    let mut count = 0;
    for part in parts.by_ref() {
        if part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()) {
            return Err(format!("Invalid Node version: {raw}"));
        }
        count += 1;
        if count > 3 {
            return Err(format!("Invalid Node version: {raw}"));
        }
    }
    if count != 3 {
        return Err(format!("Invalid Node version: {raw}"));
    }
    let _ = VERSION_RE;
    Ok(normalized)
}

pub fn node_artifact_name(version: &str, os: &str, arch: &str) -> Result<String, String> {
    let version = validate_node_version(version)?;
    let mapped_os = match os {
        "windows" | "win32" => "win",
        "macos" | "darwin" => "darwin",
        "linux" => "linux",
        other => return Err(format!("Unsupported OS: {other}")),
    };
    let mapped_arch = match arch {
        "x86_64" | "x64" | "amd64" => "x64",
        "aarch64" | "arm64" => "arm64",
        other => return Err(format!("Unsupported architecture: {other}")),
    };
    let ext = if mapped_os == "win" { "zip" } else { "tar.gz" };
    Ok(format!("node-{version}-{mapped_os}-{mapped_arch}.{ext}"))
}

pub fn parse_shasums256(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (hash, name) = if let Some((hash, name)) = line.split_once("  ") {
            (hash, name)
        } else if let Some((hash, name)) = line.split_once(" *") {
            (hash, name)
        } else {
            continue;
        };
        let hash = hash.trim().to_ascii_lowercase();
        if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
            map.insert(name.trim().to_string(), hash);
        }
    }
    map
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn current_artifact(version: &str) -> Result<String, String> {
    node_artifact_name(version, std::env::consts::OS, std::env::consts::ARCH)
}

fn managed_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    dir.push("runtimes");
    dir.push("node");
    Ok(dir)
}

fn version_dir(root: &Path, version: &str) -> PathBuf {
    root.join(version)
}

pub fn node_executable(root: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let direct = root.join("node.exe");
        if direct.exists() {
            return Some(direct);
        }
        let bin = root.join("bin").join("node.exe");
        if bin.exists() {
            return Some(bin);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let bin = root.join("bin").join("node");
        if bin.exists() {
            return Some(bin);
        }
        let direct = root.join("node");
        if direct.exists() {
            return Some(direct);
        }
    }
    None
}

pub fn runtime_status(root: &Path) -> &'static str {
    match node_executable(root) {
        Some(exe) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(&exe) {
                    if meta.permissions().mode() & 0o111 == 0 {
                        return "broken";
                    }
                }
            }
            "available"
        }
        None => "broken",
    }
}

fn path_escapes(root: &Path, candidate: &Path) -> bool {
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => return true,
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return true;
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    !normalized.starts_with(root) && candidate.is_absolute()
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    let replaced = name.replace('\\', "/");
    if replaced.starts_with('/') || replaced.contains('\0') {
        return Err(format!("Archive entry escapes runtime root: {name}"));
    }
    for part in replaced.split('/') {
        if part == ".." {
            return Err(format!("Archive entry escapes runtime root: {name}"));
        }
        if part.len() >= 2 && part.as_bytes()[1] == b':' {
            return Err(format!("Archive entry escapes runtime root: {name}"));
        }
    }
    Ok(())
}

fn hoist_single_directory(dir: &Path) -> Result<(), String> {
    let entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .collect();
    if entries.len() != 1 {
        return Ok(());
    }
    let only = &entries[0];
    if !only.path().is_dir() {
        return Ok(());
    }
    let inner = only.path();
    let staging = dir.join(".hoist-staging");
    fs::rename(&inner, &staging).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(&staging).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        fs::rename(entry.path(), dir.join(name)).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_dir_all(staging);
    Ok(())
}

fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        validate_entry_name(&name)?;
        let Some(enclosed) = entry.enclosed_name() else {
            return Err(format!("Archive entry escapes runtime root: {name}"));
        };
        let out_path = dest.join(enclosed);
        if path_escapes(dest, &out_path) {
            return Err(format!("Archive entry escapes runtime root: {name}"));
        }
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = File::create(&out_path).map_err(|e| e.to_string())?;
        io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?;
        let name = path.to_string_lossy().to_string();
        validate_entry_name(&name)?;
        let out_path = dest.join(path.as_ref());
        if path_escapes(dest, &out_path) {
            return Err(format!("Archive entry escapes runtime root: {name}"));
        }
        match entry.header().entry_type() {
            tar::EntryType::Symlink | tar::EntryType::Link => {
                let target = entry
                    .link_name()
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("Archive link missing target: {name}"))?;
                if target.is_absolute() || validate_entry_name(&target.to_string_lossy()).is_err() {
                    return Err(format!("Archive link escapes runtime root: {name}"));
                }
                let resolved = out_path.parent().unwrap_or(dest).join(target.as_ref());
                let mut normalized = PathBuf::new();
                for component in resolved.components() {
                    match component {
                        Component::Prefix(_) | Component::RootDir => {
                            return Err(format!("Archive link escapes runtime root: {name}"));
                        }
                        Component::CurDir => {}
                        Component::ParentDir => {
                            if !normalized.pop() {
                                return Err(format!("Archive link escapes runtime root: {name}"));
                            }
                        }
                        Component::Normal(part) => normalized.push(part),
                    }
                }
                #[cfg(unix)]
                {
                    if let Some(parent) = out_path.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let _ = fs::remove_file(&out_path);
                    std::os::unix::fs::symlink(target.as_ref(), &out_path).map_err(|e| e.to_string())?;
                }
                #[cfg(not(unix))]
                {
                    let _ = normalized;
                }
            }
            _ => {
                entry.unpack_in(dest).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn extract_archive(archive_path: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let name = archive_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if name.ends_with(".zip") {
        extract_zip(archive_path, dest)?;
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_tar_gz(archive_path, dest)?;
    } else {
        return Err(format!("Unsupported archive: {name}"));
    }
    hoist_single_directory(dest)
}

fn run_node_version(exe: &Path) -> Result<String, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-v");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("node -v validation failed".to_string());
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if line.starts_with('v') {
        Ok(line)
    } else if line.is_empty() {
        Err("node -v validation failed".to_string())
    } else {
        Ok(format!("v{line}"))
    }
}

fn emit_progress(app: &AppHandle, progress: &NodeInstallProgress) {
    let _ = app.emit("node-runtime-progress", progress);
}

pub fn is_stale_runtime_temp(name: &str, busy_versions: &HashSet<String>) -> bool {
    let is_temp = name.ends_with(".part") || name.ends_with(".tmp") || name.starts_with("extract-");
    if !is_temp {
        return false;
    }
    !busy_versions.iter().any(|version| name.contains(version))
}

fn cleanup_stale(root: &Path, busy_versions: &HashSet<String>) {
    if !root.exists() {
        return;
    }
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let path = entry.path();
            if is_stale_runtime_temp(name.as_ref(), busy_versions) {
                let _ = if path.is_dir() {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
            }
        }
    }
}

fn lock_version(state: &NodeRuntimeState, version: &str) -> Result<(), String> {
    let mut installing = state.installing.lock().map_err(|e| e.to_string())?;
    if installing.contains(version) {
        return Err(format!("Node {version} is already being installed or uninstalled"));
    }
    installing.insert(version.to_string());
    Ok(())
}

fn unlock_version(state: &NodeRuntimeState, version: &str) {
    if let Ok(mut installing) = state.installing.lock() {
        installing.remove(version);
    }
}

#[tauri::command]
pub fn managed_node_runtime_supported() -> bool {
    true
}

#[tauri::command]
pub async fn list_installed_node_runtimes(
    app: AppHandle,
    state: State<'_, NodeRuntimeState>,
) -> Result<Vec<NodeRuntimeInfo>, String> {
    let root = managed_root(&app)?;
    let busy = state
        .installing
        .lock()
        .map(|set| set.clone())
        .unwrap_or_default();
    cleanup_stale(&root, &busy);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if validate_node_version(&name).is_err() {
            continue;
        }
        result.push(NodeRuntimeInfo {
            version: name,
            path: path.to_string_lossy().to_string(),
            source: "managed".to_string(),
            status: runtime_status(&path).to_string(),
        });
    }
    result.sort_by(|a, b| b.version.cmp(&a.version));
    Ok(result)
}

#[tauri::command]
pub async fn list_available_node_releases() -> Result<Vec<NodeReleaseInfo>, String> {
    let url = format!("{NODE_DIST_HOST}/dist/index.json");
    let response = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch Node releases: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Failed to fetch Node releases: HTTP {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Node releases: {e}"))
}

#[tauri::command]
pub async fn cancel_managed_node_install(
    state: State<'_, NodeRuntimeState>,
    operation_id: String,
) -> Result<(), String> {
    let cancels = state.cancels.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = cancels.get(&operation_id) {
        flag.store(true, Ordering::SeqCst);
        Ok(())
    } else {
        Err("Install operation not found".to_string())
    }
}

#[tauri::command]
pub async fn install_managed_node(
    app: AppHandle,
    state: State<'_, NodeRuntimeState>,
    version: String,
    operation_id: Option<String>,
) -> Result<String, String> {
    let version = validate_node_version(&version)?;
    let operation_id = operation_id.unwrap_or_else(|| format!("install-{version}"));
    lock_version(&state, &version)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut cancels = state.cancels.lock().map_err(|e| e.to_string())?;
        cancels.insert(operation_id.clone(), cancel.clone());
    }

    let result = install_managed_node_inner(&app, &version, &operation_id, cancel.clone()).await;

    {
        if let Ok(mut cancels) = state.cancels.lock() {
            cancels.remove(&operation_id);
        }
    }
    unlock_version(&state, &version);
    result
}

async fn install_managed_node_inner(
    app: &AppHandle,
    version: &str,
    operation_id: &str,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let root = managed_root(app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    cleanup_stale(&root, &HashSet::from([version.to_string()]));

    let final_dir = version_dir(&root, version);
    if final_dir.exists() && runtime_status(&final_dir) == "available" {
        emit_progress(
            app,
            &NodeInstallProgress {
                operation_id: operation_id.to_string(),
                version: version.to_string(),
                phase: "complete".to_string(),
                downloaded_bytes: None,
                total_bytes: None,
                percent: Some(100),
            },
        );
        return Ok(final_dir.to_string_lossy().to_string());
    }

    let artifact = current_artifact(version)?;
    let dist_base = format!("{NODE_DIST_HOST}/dist/{version}");
    let shasum_url = format!("{dist_base}/SHASUMS256.txt");
    let artifact_url = format!("{dist_base}/{artifact}");
    if !artifact_url.starts_with(NODE_DIST_HOST) || !shasum_url.starts_with(NODE_DIST_HOST) {
        return Err("Refusing to download from non-official host".to_string());
    }

    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "resolving".to_string(),
            downloaded_bytes: None,
            total_bytes: None,
            percent: None,
        },
    );

    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let shasum_text = client
        .get(&shasum_url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch checksums: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Failed to fetch checksums: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read checksums: {e}"))?;
    let checksums = parse_shasums256(&shasum_text);
    let expected = checksums
        .get(&artifact)
        .cloned()
        .ok_or_else(|| format!("Checksum missing for {artifact}"))?;

    let part_path = root.join(format!("{artifact}.part"));
    let extract_dir = root.join(format!("extract-{version}"));
    let _ = fs::remove_file(&part_path);
    let _ = fs::remove_dir_all(&extract_dir);

    let cleanup = |part: &Path, extract: &Path| {
        let _ = fs::remove_file(part);
        let _ = fs::remove_dir_all(extract);
    };

    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "downloading".to_string(),
            downloaded_bytes: Some(0),
            total_bytes: None,
            percent: Some(0),
        },
    );

    let response = match client.get(&artifact_url).send().await {
        Ok(response) => response,
        Err(error) => {
            cleanup(&part_path, &extract_dir);
            return Err(format!("Download failed: {error}"));
        }
    };
    if response.status().as_u16() == 404 {
        cleanup(&part_path, &extract_dir);
        return Err(format!("Node artifact not found: {artifact}"));
    }
    if let Err(error) = response.error_for_status_ref() {
        cleanup(&part_path, &extract_dir);
        return Err(format!("Download failed: {error}"));
    }
    let total = response.content_length();
    let mut file = match File::create(&part_path) {
        Ok(file) => file,
        Err(error) => {
            cleanup(&part_path, &extract_dir);
            return Err(error.to_string());
        }
    };
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_emit = Instant::now();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            cleanup(&part_path, &extract_dir);
            return Err("cancelled".to_string());
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                cleanup(&part_path, &extract_dir);
                return Err(format!("Download failed: {error}"));
            }
        };
        if let Err(error) = file.write_all(&chunk) {
            cleanup(&part_path, &extract_dir);
            return Err(error.to_string());
        }
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            let percent = total.map(|value| ((downloaded as f64 / value as f64) * 100.0) as u32);
            emit_progress(
                app,
                &NodeInstallProgress {
                    operation_id: operation_id.to_string(),
                    version: version.to_string(),
                    phase: "downloading".to_string(),
                    downloaded_bytes: Some(downloaded),
                    total_bytes: total,
                    percent,
                },
            );
            last_emit = Instant::now();
        }
    }
    if let Err(error) = file.flush() {
        cleanup(&part_path, &extract_dir);
        return Err(error.to_string());
    }

    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "verifying".to_string(),
            downloaded_bytes: Some(downloaded),
            total_bytes: total,
            percent: Some(100),
        },
    );

    let actual = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if actual != expected {
        cleanup(&part_path, &extract_dir);
        return Err("Checksum mismatch".to_string());
    }

    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "extracting".to_string(),
            downloaded_bytes: Some(downloaded),
            total_bytes: total,
            percent: Some(100),
        },
    );

    if let Err(error) = extract_archive(&part_path, &extract_dir) {
        cleanup(&part_path, &extract_dir);
        return Err(error);
    }
    let _ = fs::remove_file(&part_path);

    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "validating".to_string(),
            downloaded_bytes: Some(downloaded),
            total_bytes: total,
            percent: Some(100),
        },
    );

    let exe = match node_executable(&extract_dir) {
        Some(exe) => exe,
        None => {
            cleanup(&part_path, &extract_dir);
            return Err("Extracted runtime is missing node executable".to_string());
        }
    };
    match run_node_version(&exe) {
        Ok(actual_version) if actual_version == version => {}
        Ok(actual_version) => {
            cleanup(&part_path, &extract_dir);
            return Err(format!("node -v mismatch: expected {version}, got {actual_version}"));
        }
        Err(error) => {
            cleanup(&part_path, &extract_dir);
            return Err(error);
        }
    }

    if final_dir.exists() {
        let _ = fs::remove_dir_all(&final_dir);
    }
    if let Err(error) = fs::rename(&extract_dir, &final_dir) {
        cleanup(&part_path, &extract_dir);
        return Err(error.to_string());
    }

    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "complete".to_string(),
            downloaded_bytes: Some(downloaded),
            total_bytes: total,
            percent: Some(100),
        },
    );
    Ok(final_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn uninstall_managed_node(
    app: AppHandle,
    state: State<'_, NodeRuntimeState>,
    version: String,
) -> Result<(), String> {
    let version = validate_node_version(&version)?;
    lock_version(&state, &version)?;
    let root = managed_root(&app);
    let result = (|| {
        let root = root?;
        let dir = version_dir(&root, &version);
        if !dir.exists() {
            return Ok(());
        }
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())
    })();
    unlock_version(&state, &version);
    result
}

fn strip_executable_name(path_str: String) -> String {
    let path = Path::new(&path_str);
    if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
        if file_name.eq_ignore_ascii_case("node.exe") || file_name.eq_ignore_ascii_case("node") {
            if let Some(parent) = path.parent() {
                return parent.to_string_lossy().to_string();
            }
        }
    }
    path_str
}

#[tauri::command]
pub fn get_system_node_path() -> String {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let output = Command::new("where")
            .arg("node")
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                let paths = String::from_utf8_lossy(&output.stdout);
                if let Some(first) = paths.lines().next() {
                    return strip_executable_name(first.trim().to_string());
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("which").arg("node").output();
        if let Ok(output) = output {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                return strip_executable_name(path);
            }
        }
    }
    "System Default".to_string()
}

#[tauri::command]
pub fn get_node_version(path: String) -> Option<String> {
    let exe = if path == "System Default" {
        PathBuf::from("node")
    } else {
        let path = Path::new(&path);
        if path.is_file() {
            path.to_path_buf()
        } else {
            node_executable(path).unwrap_or_else(|| {
                #[cfg(target_os = "windows")]
                {
                    path.join("node.exe")
                }
                #[cfg(not(target_os = "windows"))]
                {
                    path.join("bin").join("node")
                }
            })
        }
    };
    run_node_version(&exe).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn version_validation_accepts_semver_only() {
        assert_eq!(validate_node_version("20.11.1").unwrap(), "v20.11.1");
        assert_eq!(validate_node_version("v22.0.0").unwrap(), "v22.0.0");
        assert!(validate_node_version("latest").is_err());
        assert!(validate_node_version("../v20.0.0").is_err());
        assert!(validate_node_version("v20").is_err());
        assert!(validate_node_version("v20.11.1-nightly").is_err());
    }

    #[test]
    fn artifact_mapping_covers_desktop_platforms() {
        assert_eq!(
            node_artifact_name("v20.11.1", "windows", "x86_64").unwrap(),
            "node-v20.11.1-win-x64.zip"
        );
        assert_eq!(
            node_artifact_name("20.11.1", "windows", "aarch64").unwrap(),
            "node-v20.11.1-win-arm64.zip"
        );
        assert_eq!(
            node_artifact_name("v20.11.1", "macos", "aarch64").unwrap(),
            "node-v20.11.1-darwin-arm64.tar.gz"
        );
        assert_eq!(
            node_artifact_name("v20.11.1", "linux", "x86_64").unwrap(),
            "node-v20.11.1-linux-x64.tar.gz"
        );
        assert!(node_artifact_name("v20.11.1", "windows", "mips").is_err());
    }

    #[test]
    fn shasum_parser_and_checksum_mismatch() {
        let text = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v20.11.1-win-x64.zip\n\
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *node-v20.11.1-linux-x64.tar.gz\n";
        let map = parse_shasums256(text);
        assert_eq!(
            map.get("node-v20.11.1-win-x64.zip").unwrap(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            map.get("node-v20.11.1-linux-x64.tar.gz").unwrap(),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert_ne!(sha256_hex(b"hello"), map["node-v20.11.1-win-x64.zip"]);
    }

    #[test]
    fn archive_entry_rejects_traversal() {
        assert!(validate_entry_name("../etc/passwd").is_err());
        assert!(validate_entry_name("/etc/passwd").is_err());
        assert!(validate_entry_name("C:/Windows/node.exe").is_err());
        assert!(validate_entry_name("bin/node").is_ok());
    }

    #[test]
    fn runtime_root_detection() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(runtime_status(temp.path()), "broken");
        #[cfg(target_os = "windows")]
        {
            File::create(temp.path().join("node.exe")).unwrap();
            assert_eq!(runtime_status(temp.path()), "available");
            assert!(node_executable(temp.path()).unwrap().ends_with("node.exe"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            let bin = temp.path().join("bin");
            fs::create_dir_all(&bin).unwrap();
            let exe = bin.join("node");
            File::create(&exe).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
            }
            assert_eq!(runtime_status(temp.path()), "available");
        }
    }

    #[test]
    #[test]
    fn stale_temp_cleanup_skips_busy_version() {
        let busy = HashSet::from(["v20.11.1".to_string()]);
        assert!(is_stale_runtime_temp("node-v22.0.0-win-x64.zip.part", &busy));
        assert!(!is_stale_runtime_temp("extract-v20.11.1", &busy));
        assert!(!is_stale_runtime_temp("node-v20.11.1-win-x64.zip.part", &busy));
        assert!(is_stale_runtime_temp("extract-v22.0.0", &busy));
        assert!(!is_stale_runtime_temp("v20.11.1", &busy));
    }

    #[test]
    fn zip_traversal_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let zip_path = temp.path().join("bad.zip");
        {
            let file = File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("../escape.txt", options).unwrap();
            zip.write_all(b"nope").unwrap();
            zip.finish().unwrap();
        }
        let dest = temp.path().join("out");
        fs::create_dir_all(&dest).unwrap();
        assert!(extract_zip(&zip_path, &dest).is_err());
        assert!(!temp.path().join("escape.txt").exists());
    }
}
