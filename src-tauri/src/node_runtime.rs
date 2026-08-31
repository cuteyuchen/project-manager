use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const NODE_DIST_HOST: &str = "https://nodejs.org";
const VERSION_RE: &str = r"^v?\d+\.\d+\.\d+$";
const FS_RETRY_BACKOFF_MS: &[u64] = &[0, 80, 160, 320, 640, 1000];

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeArchiveKind {
    Zip,
    TarGz,
}

#[derive(Debug, Clone)]
struct NodeArtifact {
    file_name: String,
    kind: NodeArchiveKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntimeInfo {
    pub runtime_id: String,
    pub version: String,
    pub path: String,
    pub source: String,
    pub status: String,
    pub runtime_root: Option<String>,
    #[serde(default)]
    pub canonical_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManagedRuntimeLocationSetting {
    mode: String,
    #[serde(default)]
    custom_path: Option<String>,
}

impl Default for ManagedRuntimeLocationSetting {
    fn default() -> Self {
        Self {
            mode: "app-data".to_string(),
            custom_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeLocationInfo {
    pub mode: String,
    pub custom_path: Option<String>,
    pub root_path: String,
    pub writable: bool,
    pub portable_available: bool,
    pub installed_count: usize,
    pub size_bytes: u64,
    pub size_status: String,
    pub warnings: Vec<String>,
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

async fn run_node_runtime_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Background Node runtime task failed: {error}"))?
}

/// 规范化为 `vX.Y.Z`，拒绝 nightly / 路径注入。
pub fn validate_node_version(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
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

fn current_artifact(version: &str) -> Result<NodeArtifact, String> {
    let file_name = node_artifact_name(version, std::env::consts::OS, std::env::consts::ARCH)?;
    let kind = if file_name.ends_with(".zip") {
        NodeArchiveKind::Zip
    } else if file_name.ends_with(".tar.gz") || file_name.ends_with(".tgz") {
        NodeArchiveKind::TarGz
    } else {
        return Err(format!("Unsupported Node archive: {file_name}"));
    };
    Ok(NodeArtifact { file_name, kind })
}

fn default_managed_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    dir.push("runtimes");
    dir.push("node");
    Ok(dir)
}

fn resolve_managed_runtime_root_from_paths(
    setting: &ManagedRuntimeLocationSetting,
    app_data_dir: Option<&Path>,
    executable_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    match setting.mode.as_str() {
        "app-data" => Ok(app_data_dir
            .ok_or_else(|| "Application data directory is unavailable".to_string())?
            .join("runtimes")
            .join("node")),
        "custom" => Ok(PathBuf::from(setting.custom_path.as_deref().ok_or_else(
            || "Custom Managed Node runtime location is empty".to_string(),
        )?)),
        "portable" => Ok(executable_dir
            .ok_or_else(|| "Application directory is unavailable".to_string())?
            .join("data")
            .join("runtimes")
            .join("node")),
        other => Err(format!(
            "Unsupported Managed Node runtime location mode: {other}"
        )),
    }
}

fn normalize_managed_location_setting(
    mode: &str,
    custom_path: Option<&str>,
) -> Result<ManagedRuntimeLocationSetting, String> {
    let mode = mode.trim();
    match mode {
        "app-data" => Ok(ManagedRuntimeLocationSetting::default()),
        "portable" => Ok(ManagedRuntimeLocationSetting {
            mode: "portable".to_string(),
            custom_path: None,
        }),
        "custom" => {
            let path = custom_path.unwrap_or_default().trim();
            if path.is_empty() {
                return Err("Custom Managed Node runtime location is empty".to_string());
            }
            if !Path::new(path).is_absolute() {
                return Err(format!(
                    "Custom Managed Node runtime location must be absolute: {path}"
                ));
            }
            Ok(ManagedRuntimeLocationSetting {
                mode: "custom".to_string(),
                custom_path: Some(path.to_string()),
            })
        }
        other => Err(format!(
            "Unsupported Managed Node runtime location mode: {other}"
        )),
    }
}

fn read_managed_location(app: &AppHandle) -> Result<ManagedRuntimeLocationSetting, String> {
    let content = crate::read_config_file_contents(app, "data.json")?;
    if content.trim().is_empty() {
        return Ok(ManagedRuntimeLocationSetting::default());
    }

    let data: Value = serde_json::from_str(&content).map_err(|error| {
        format!("Failed to parse data.json while resolving Node runtime location: {error}")
    })?;
    let Some(raw) = data
        .get("settings")
        .and_then(|settings| settings.get("managedNodeRuntimeLocation"))
    else {
        return Ok(ManagedRuntimeLocationSetting::default());
    };

    let setting: ManagedRuntimeLocationSetting = serde_json::from_value(raw.clone())
        .map_err(|error| format!("Invalid managed Node runtime location setting: {error}"))?;
    normalize_managed_location_setting(&setting.mode, setting.custom_path.as_deref())
}

fn resolve_managed_runtime_root_for_setting(
    app: &AppHandle,
    setting: &ManagedRuntimeLocationSetting,
) -> Result<PathBuf, String> {
    if setting.mode == "app-data" {
        return default_managed_root(app);
    }
    let executable_dir = if setting.mode == "portable" {
        Some(
            app.path()
                .executable_dir()
                .map_err(|e| format!("Failed to resolve application directory: {e}"))?,
        )
    } else {
        None
    };
    resolve_managed_runtime_root_from_paths(setting, None, executable_dir.as_deref())
}

fn resolve_managed_runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    let setting = read_managed_location(app)?;
    resolve_managed_runtime_root_for_setting(app, &setting)
}

fn normalized_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(target_os = "windows")]
    {
        value.trim_end_matches('/').to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        value.trim_end_matches('/').to_string()
    }
}

fn canonicalize_runtime_path(path: &Path) -> Option<String> {
    fs::canonicalize(path).ok().map(|value| {
        #[cfg(target_os = "windows")]
        if let Ok(stripped) = value.strip_prefix(r"\\?\") {
            return stripped.to_string_lossy().to_string();
        }
        value.to_string_lossy().to_string()
    })
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    normalized_path_key(left) == normalized_path_key(right)
}

fn path_is_within(path: &Path, parent: &Path) -> bool {
    let path_key = normalized_path_key(path);
    let parent_key = normalized_path_key(parent);
    path_key == parent_key || path_key.starts_with(&(parent_key + "/"))
}

fn writable_probe(path: &Path) -> bool {
    let mut created_dirs = Vec::new();
    let mut probe_dir = path.to_path_buf();
    while !probe_dir.exists() {
        created_dirs.push(probe_dir.clone());
        let Some(parent) = probe_dir.parent() else {
            return false;
        };
        if parent == probe_dir {
            return false;
        }
        probe_dir = parent.to_path_buf();
    }

    if !probe_dir.is_dir() {
        for created in created_dirs {
            let _ = fs::remove_dir(created);
        }
        return false;
    }
    if fs::create_dir_all(path).is_err() || !path.is_dir() {
        for created in created_dirs {
            let _ = fs::remove_dir(created);
        }
        return false;
    }
    let Ok(metadata) = fs::metadata(path) else {
        for created in created_dirs {
            let _ = fs::remove_dir(created);
        }
        return false;
    };
    if metadata.permissions().readonly() {
        for created in created_dirs {
            let _ = fs::remove_dir(created);
        }
        return false;
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let probe = path.join(format!(".project-manager-write-test-{stamp}"));
    let result = (|| -> io::Result<()> {
        let mut file = File::create(&probe)?;
        file.write_all(b"project-manager")?;
        file.sync_all()?;
        drop(file);
        fs::remove_file(&probe)
    })()
    .is_ok();

    if !result {
        let _ = fs::remove_file(&probe);
    }
    for created in created_dirs {
        let _ = fs::remove_dir(created);
    }
    result
}

fn ensure_writable_directory(path: &Path) -> Result<(), String> {
    if path.exists() && !path.is_dir() {
        return Err(format!(
            "Managed Node runtime path is not a directory: {}",
            path.display()
        ));
    }
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "Failed to create Managed Node runtime directory {}: {error}",
            path.display()
        )
    })?;
    if !writable_probe(path) {
        return Err(format!(
            "Managed Node runtime directory is not writable: {}",
            path.display()
        ));
    }
    Ok(())
}

fn runtime_directory_entries(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut result = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let version = entry.file_name().to_string_lossy().to_string();
            validate_node_version(&version)
                .ok()
                .map(|version| (version, path))
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| left.0.cmp(&right.0));
    result
}

fn directory_size_stats(path: &Path) -> (u64, Vec<String>) {
    let mut total = 0_u64;
    let mut warnings = Vec::new();
    let mut pending = vec![path.to_path_buf()];

    while let Some(current) = pending.pop() {
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                warnings.push(format!("{}: {error}", current.display()));
                continue;
            }
        };
        let file_type = metadata.file_type();
        if file_type.is_file() || file_type.is_symlink() {
            total = total.saturating_add(metadata.len());
            continue;
        }
        if !file_type.is_dir() {
            continue;
        }

        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                warnings.push(format!("{}: {error}", current.display()));
                continue;
            }
        };
        for entry in entries {
            match entry {
                Ok(entry) => pending.push(entry.path()),
                Err(error) => warnings.push(format!("{}: {error}", current.display())),
            }
        }
    }

    (total, warnings)
}

fn portable_root(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_managed_runtime_root_for_setting(
        app,
        &ManagedRuntimeLocationSetting {
            mode: "portable".to_string(),
            custom_path: None,
        },
    )
}

fn managed_location_info_sync(
    setting: &ManagedRuntimeLocationSetting,
    root: PathBuf,
    portable: PathBuf,
    mut warnings: Vec<String>,
) -> Result<ManagedRuntimeLocationInfo, String> {
    let writable = writable_probe(&root);
    let portable_available = writable_probe(&portable);
    if !writable {
        warnings.push(format!(
            "Managed Node runtime directory is not writable: {}",
            root.display()
        ));
    }
    if setting.mode == "portable" && !portable_available {
        warnings.push("当前安装目录不可写，请选择应用数据目录或自定义目录。".to_string());
    }
    let (size_bytes, size_warnings) = directory_size_stats(&root);
    let size_status = if size_warnings.is_empty() {
        "ready"
    } else {
        for warning in size_warnings {
            warnings.push(format!("无法完整计算 Managed Node 目录大小：{warning}"));
        }
        "error"
    };

    Ok(ManagedRuntimeLocationInfo {
        mode: setting.mode.clone(),
        custom_path: setting.custom_path.clone(),
        root_path: root.to_string_lossy().to_string(),
        writable,
        portable_available,
        installed_count: runtime_directory_entries(&root).len(),
        size_bytes,
        size_status: size_status.to_string(),
        warnings,
    })
}

async fn managed_location_info(
    app: &AppHandle,
    setting: &ManagedRuntimeLocationSetting,
    warnings: Vec<String>,
) -> Result<ManagedRuntimeLocationInfo, String> {
    let root = resolve_managed_runtime_root_for_setting(app, setting)?;
    let portable = portable_root(app)?;
    let setting = setting.clone();
    run_node_runtime_task(move || managed_location_info_sync(&setting, root, portable, warnings))
        .await
}

fn write_managed_location(
    app: &AppHandle,
    setting: &ManagedRuntimeLocationSetting,
) -> Result<(), String> {
    let content = crate::read_config_file_contents(app, "data.json")?;
    let mut data = if content.trim().is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str::<Value>(&content).map_err(|error| {
            format!("Failed to parse data.json before updating Node runtime location: {error}")
        })?
    };
    let object = data
        .as_object_mut()
        .ok_or_else(|| "data.json root must be an object".to_string())?;
    let settings = object
        .entry("settings".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| "data.json settings must be an object".to_string())?;
    settings.insert(
        "managedNodeRuntimeLocation".to_string(),
        serde_json::to_value(setting).map_err(|error| error.to_string())?,
    );
    let serialized = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?;
    let path = crate::app_config_file_path(app, "data.json")?;
    crate::atomic_write_config(&path, &serialized)
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
        Some(_exe) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = fs::metadata(_exe) {
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
    let Ok(relative) = candidate.strip_prefix(root) else {
        return true;
    };
    let mut depth = 0_usize;
    for component in relative.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => return true,
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return true;
                }
                depth -= 1;
            }
            Component::Normal(_) => depth += 1,
        }
    }
    false
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

#[derive(Clone, Copy)]
enum FsTarget<'a> {
    Path(&'a Path),
    Rename { from: &'a Path, to: &'a Path },
}

fn format_fs_error(
    phase: &str,
    operation: &str,
    target: FsTarget<'_>,
    error: &io::Error,
) -> String {
    let raw_os_error = error
        .raw_os_error()
        .map(|value| value.to_string())
        .unwrap_or_else(|| "none".to_string());
    let mut message = format!("Node install failed\nphase: {phase}\noperation: {operation}");
    match target {
        FsTarget::Path(path) => message.push_str(&format!("\npath: {}", path.display())),
        FsTarget::Rename { from, to } => {
            message.push_str(&format!("\nfrom: {}\nto: {}", from.display(), to.display()))
        }
    }
    message.push_str(&format!("\nerror: {error}\nraw_os_error: {raw_os_error}"));
    message
}

fn fs_error(phase: &str, operation: &str, path: &Path, error: &io::Error) -> String {
    format_fs_error(phase, operation, FsTarget::Path(path), error)
}

fn is_transient_fs_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(5)
}

fn retry_fs_operation_with_sleep<T, F, S>(
    phase: &str,
    operation: &str,
    target: FsTarget<'_>,
    mut operation_fn: F,
    mut sleep: S,
) -> Result<T, String>
where
    F: FnMut() -> io::Result<T>,
    S: FnMut(Duration),
{
    for (attempt, delay_ms) in FS_RETRY_BACKOFF_MS.iter().enumerate() {
        if *delay_ms > 0 {
            sleep(Duration::from_millis(*delay_ms));
        }
        match operation_fn() {
            Ok(value) => return Ok(value),
            Err(error)
                if is_transient_fs_error(&error) && attempt + 1 < FS_RETRY_BACKOFF_MS.len() => {}
            Err(error) => return Err(format_fs_error(phase, operation, target, &error)),
        }
    }
    unreachable!("filesystem retry schedule must contain at least one attempt")
}

fn retry_fs_operation<T, F>(
    phase: &str,
    operation: &str,
    target: FsTarget<'_>,
    operation_fn: F,
) -> Result<T, String>
where
    F: FnMut() -> io::Result<T>,
{
    retry_fs_operation_with_sleep(phase, operation, target, operation_fn, std::thread::sleep)
}

fn rename_with_retry(phase: &str, operation: &str, from: &Path, to: &Path) -> Result<(), String> {
    retry_fs_operation(phase, operation, FsTarget::Rename { from, to }, || {
        fs::rename(from, to)
    })
}

fn remove_file_with_retry(phase: &str, operation: &str, path: &Path) -> Result<(), String> {
    retry_fs_operation(
        phase,
        operation,
        FsTarget::Path(path),
        || match fs::remove_file(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        },
    )
}

fn remove_dir_all_with_retry(phase: &str, operation: &str, path: &Path) -> Result<(), String> {
    retry_fs_operation(
        phase,
        operation,
        FsTarget::Path(path),
        || match fs::remove_dir_all(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        },
    )
}

fn remove_runtime_path_with_retry(phase: &str, operation: &str, path: &Path) -> Result<(), String> {
    if path.is_dir() {
        remove_dir_all_with_retry(phase, operation, path)
    } else {
        remove_file_with_retry(phase, operation, path)
    }
}

fn runtime_error(phase: &str, operation: &str, path: &Path, detail: &str) -> String {
    format!(
        "Node install failed\nphase: {phase}\noperation: {operation}\npath: {}\nerror: {detail}",
        path.display()
    )
}

fn hoist_single_directory(dir: &Path) -> Result<(), String> {
    let entries: Vec<_> = fs::read_dir(dir)
        .map_err(|error| fs_error("extracting", "read extracted runtime", dir, &error))?
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
    rename_with_retry("extracting", "prepare extracted runtime", &inner, &staging)?;
    for entry in fs::read_dir(&staging)
        .map_err(|error| fs_error("extracting", "read extracted runtime", &staging, &error))?
    {
        let entry = entry
            .map_err(|error| fs_error("extracting", "read extracted entry", &staging, &error))?;
        let name = entry.file_name();
        let target = dir.join(name);
        rename_with_retry(
            "extracting",
            "hoist extracted runtime entry",
            &entry.path(),
            &target,
        )?;
    }
    remove_dir_all_with_retry("extracting", "remove hoist staging directory", &staging)?;
    Ok(())
}

fn extract_zip(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| {
        fs_error(
            "extracting",
            "open downloaded archive",
            archive_path,
            &error,
        )
    })?;
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
            fs::create_dir_all(&out_path).map_err(|error| {
                fs_error("extracting", "create archive directory", &out_path, &error)
            })?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                fs_error(
                    "extracting",
                    "create archive parent directory",
                    parent,
                    &error,
                )
            })?;
        }
        let mut outfile = File::create(&out_path)
            .map_err(|error| fs_error("extracting", "create extracted file", &out_path, &error))?;
        io::copy(&mut entry, &mut outfile)
            .map_err(|error| fs_error("extracting", "write extracted file", &out_path, &error))?;
    }
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|error| {
        fs_error(
            "extracting",
            "open downloaded archive",
            archive_path,
            &error,
        )
    })?;
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
                if path_escapes(dest, &resolved) {
                    return Err(format!("Archive link escapes runtime root: {name}"));
                }
                #[cfg(unix)]
                {
                    if let Some(parent) = out_path.parent() {
                        fs::create_dir_all(parent).map_err(|error| {
                            fs_error(
                                "extracting",
                                "create archive link parent directory",
                                parent,
                                &error,
                            )
                        })?;
                    }
                    remove_file_with_retry("extracting", "replace archive link", &out_path)?;
                    std::os::unix::fs::symlink(target.as_ref(), &out_path).map_err(|error| {
                        fs_error("extracting", "create archive link", &out_path, &error)
                    })?;
                }
                #[cfg(not(unix))]
                {
                    let _ = resolved;
                }
            }
            _ => {
                entry.unpack_in(dest).map_err(|error| {
                    fs_error("extracting", "write extracted archive entry", dest, &error)
                })?;
            }
        }
    }
    Ok(())
}

fn extract_archive(archive_path: &Path, kind: NodeArchiveKind, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| {
        fs_error(
            "extracting",
            "create runtime staging directory",
            dest,
            &error,
        )
    })?;
    match kind {
        NodeArchiveKind::Zip => extract_zip(archive_path, dest)?,
        NodeArchiveKind::TarGz => extract_tar_gz(archive_path, dest)?,
    }
    hoist_single_directory(dest)
}

fn checksum_matches(expected: &str, actual: &str) -> bool {
    expected.trim().eq_ignore_ascii_case(actual.trim())
}

fn promote_downloaded_archive(part_path: &Path, archive_path: &Path) -> Result<(), String> {
    rename_with_retry(
        "archive_promotion",
        "promote downloaded archive",
        part_path,
        archive_path,
    )
}

fn sync_and_close_download(file: File) -> Result<(), String> {
    file.sync_all()
        .map_err(|error| format!("Failed to sync downloaded archive: {error}"))?;
    drop(file);
    Ok(())
}

fn cleanup_install_temp_with<FFile, FDir, SSleep>(
    phase: &str,
    part_path: &Path,
    archive_path: &Path,
    extract_dir: &Path,
    mut remove_file: FFile,
    mut remove_dir: FDir,
    mut sleep: SSleep,
) -> Vec<String>
where
    FFile: FnMut(&Path) -> io::Result<()>,
    FDir: FnMut(&Path) -> io::Result<()>,
    SSleep: FnMut(Duration),
{
    let mut warnings = Vec::new();
    let file_targets = [
        ("remove downloaded archive part", part_path),
        ("remove downloaded archive", archive_path),
    ];
    for (operation, path) in file_targets {
        if let Err(error) = retry_fs_operation_with_sleep(
            phase,
            operation,
            FsTarget::Path(path),
            || match remove_file(path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                result => result,
            },
            &mut sleep,
        ) {
            warnings.push(error);
        }
    }
    if let Err(error) = retry_fs_operation_with_sleep(
        phase,
        "remove runtime staging directory",
        FsTarget::Path(extract_dir),
        || match remove_dir(extract_dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        },
        &mut sleep,
    ) {
        warnings.push(error);
    }
    warnings
}

fn cleanup_install_temp_with_warnings(
    phase: &str,
    part_path: &Path,
    archive_path: &Path,
    extract_dir: &Path,
) -> Vec<String> {
    cleanup_install_temp_with(
        phase,
        part_path,
        archive_path,
        extract_dir,
        |path: &Path| fs::remove_file(path),
        |path: &Path| fs::remove_dir_all(path),
        std::thread::sleep,
    )
}

fn cleanup_install_temp(part_path: &Path, archive_path: &Path, extract_dir: &Path) {
    let _ = cleanup_install_temp_with_warnings("cleanup", part_path, archive_path, extract_dir);
}

fn run_node_version(exe: &Path) -> Result<String, String> {
    let mut cmd = Command::new(exe);
    cmd.arg("-v");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("failed to start node executable: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("node -v validation timed out".to_string());
            }
            Err(error) => return Err(format!("node -v validation failed: {error}")),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("node -v validation failed: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "node -v validation failed".to_string()
        } else {
            detail
        });
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

fn normalize_detected_version(raw: &str) -> Option<String> {
    let line = raw.trim();
    let normalized = if line.starts_with('v') || line.starts_with('V') {
        format!("v{}", &line[1..])
    } else {
        format!("v{line}")
    };
    validate_node_version(&normalized).ok()
}

fn runtime_id(source: &str, version: &str, path: &Path) -> String {
    if source == "managed" {
        return format!("managed:{version}");
    }
    format!("{source}:{}", normalized_path_key(path))
}

fn emit_progress(app: &AppHandle, progress: &NodeInstallProgress) {
    let _ = app.emit("node-runtime-progress", progress);
}

pub fn is_stale_runtime_temp(name: &str, busy_versions: &HashSet<String>) -> bool {
    let is_temp = name.ends_with(".part")
        || name.ends_with(".tmp")
        || name.ends_with(".zip")
        || name.ends_with(".tar.gz")
        || name.ends_with(".tgz")
        || name.starts_with("extract-");
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
                    remove_dir_all_with_retry(
                        "cleanup_stale",
                        "remove stale runtime directory",
                        &path,
                    )
                } else {
                    remove_file_with_retry("cleanup_stale", "remove stale runtime file", &path)
                };
            }
        }
    }
}

fn push_unique_path(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if candidate.as_os_str().is_empty() || paths.iter().any(|path| paths_equal(path, &candidate)) {
        return;
    }
    paths.push(candidate);
}

fn discover_nvm_roots(app: &AppHandle) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    let _ = app;
    let mut roots = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Some(value) = std::env::var_os("NVM_HOME") {
            push_unique_path(&mut roots, PathBuf::from(value));
        }
        if let Some(value) = std::env::var_os("NVM_SYMLINK") {
            // NVM_SYMLINK is normally the active version directory. It is a
            // useful fallback when NVM_HOME is absent, but it is not scanned
            // recursively.
            push_unique_path(&mut roots, PathBuf::from(value));
        }
        if let Some(value) = std::env::var_os("APPDATA") {
            push_unique_path(&mut roots, PathBuf::from(value).join("nvm"));
        }
        if let Some(value) = std::env::var_os("LOCALAPPDATA") {
            push_unique_path(&mut roots, PathBuf::from(value).join("nvm"));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(value) = std::env::var_os("NVM_DIR") {
            push_unique_path(&mut roots, PathBuf::from(value));
        }
        if let Ok(home) = app.path().home_dir() {
            push_unique_path(&mut roots, home.join(".nvm"));
        }
    }

    roots
}

fn nvm_candidates(root: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if node_executable(root).is_some() {
        candidates.push(root.to_path_buf());
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && node_executable(&path).is_some() {
                    candidates.push(path);
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let versions_root = root.join("versions").join("node");
        if let Ok(entries) = fs::read_dir(versions_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && node_executable(&path).is_some() {
                    candidates.push(path);
                }
            }
        }
    }

    candidates.sort_by(|left, right| normalized_path_key(left).cmp(&normalized_path_key(right)));
    candidates.dedup_by(|left, right| paths_equal(left, right));
    candidates
}

fn scan_nvm_root(root: &Path) -> Vec<NodeRuntimeInfo> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for candidate in nvm_candidates(root) {
        let Some(executable) = node_executable(&candidate) else {
            continue;
        };
        let Ok(raw_version) = run_node_version(&executable) else {
            continue;
        };
        let Some(version) = normalize_detected_version(&raw_version) else {
            continue;
        };
        let canonical_path = canonicalize_runtime_path(&candidate);
        let physical_key = canonical_path
            .clone()
            .unwrap_or_else(|| candidate.to_string_lossy().to_string());
        let key = format!(
            "{version}:{}",
            normalized_path_key(Path::new(&physical_key))
        );
        if !seen.insert(key) {
            continue;
        }
        let id = runtime_id(
            "nvm",
            &version,
            canonical_path
                .as_deref()
                .map(Path::new)
                .unwrap_or(candidate.as_path()),
        );
        result.push(NodeRuntimeInfo {
            runtime_id: id,
            version,
            path: candidate.to_string_lossy().to_string(),
            source: "nvm".to_string(),
            status: "available".to_string(),
            runtime_root: Some(root.to_string_lossy().to_string()),
            canonical_path,
        });
    }
    result.sort_by(|left, right| {
        right
            .version
            .cmp(&left.version)
            .then_with(|| left.path.cmp(&right.path))
    });
    result
}

fn scan_nvm_runtimes(app: &AppHandle) -> Vec<NodeRuntimeInfo> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for root in discover_nvm_roots(app) {
        for runtime in scan_nvm_root(&root) {
            if seen.insert(runtime.runtime_id.clone()) {
                result.push(runtime);
            }
        }
    }
    result.sort_by(|left, right| {
        right
            .version
            .cmp(&left.version)
            .then_with(|| left.path.cmp(&right.path))
    });
    result
}

fn lock_version(state: &NodeRuntimeState, version: &str) -> Result<(), String> {
    let mut installing = state.installing.lock().map_err(|e| e.to_string())?;
    if installing.contains(version) {
        return Err(format!(
            "Node {version} is already being installed or uninstalled"
        ));
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

fn list_installed_node_runtimes_sync(
    root: PathBuf,
    busy: HashSet<String>,
) -> Result<Vec<NodeRuntimeInfo>, String> {
    cleanup_stale(&root, &busy);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for (version, path) in runtime_directory_entries(&root) {
        let status = match node_executable(&path)
            .and_then(|executable| run_node_version(&executable).ok())
        {
            Some(actual)
                if normalize_detected_version(&actual).as_deref() == Some(version.as_str()) =>
            {
                "available"
            }
            _ => "broken",
        };
        result.push(NodeRuntimeInfo {
            runtime_id: runtime_id("managed", &version, &path),
            version,
            path: path.to_string_lossy().to_string(),
            source: "managed".to_string(),
            status: status.to_string(),
            runtime_root: Some(root.to_string_lossy().to_string()),
            canonical_path: canonicalize_runtime_path(&path),
        });
    }
    result.sort_by(|a, b| b.version.cmp(&a.version));
    Ok(result)
}

#[tauri::command]
pub async fn list_installed_node_runtimes(
    app: AppHandle,
    state: State<'_, NodeRuntimeState>,
) -> Result<Vec<NodeRuntimeInfo>, String> {
    let root = resolve_managed_runtime_root(&app)?;
    let busy = state
        .installing
        .lock()
        .map(|set| set.clone())
        .unwrap_or_default();
    run_node_runtime_task(move || list_installed_node_runtimes_sync(root, busy)).await
}

#[tauri::command]
pub async fn scan_nvm_node_runtimes(app: AppHandle) -> Result<Vec<NodeRuntimeInfo>, String> {
    run_node_runtime_task(move || Ok(scan_nvm_runtimes(&app))).await
}

#[tauri::command]
pub async fn get_managed_node_runtime_location(
    app: AppHandle,
) -> Result<ManagedRuntimeLocationInfo, String> {
    let setting = read_managed_location(&app)?;
    managed_location_info(&app, &setting, Vec::new()).await
}

fn open_managed_runtime_root_with<F>(root: &Path, opener: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    if root.as_os_str().is_empty() {
        return Err("Managed Node runtime root is empty".to_string());
    }
    if root.exists() && !root.is_dir() {
        return Err(format!(
            "Managed Node runtime root is not a directory: {}",
            root.display()
        ));
    }
    if !root.exists() {
        fs::create_dir_all(root).map_err(|error| {
            format!(
                "Failed to create Managed Node runtime root {}: {error}",
                root.display()
            )
        })?;
    }
    opener(root)
}

#[tauri::command]
pub async fn open_managed_node_runtime_root(app: AppHandle) -> Result<(), String> {
    let root = resolve_managed_runtime_root(&app)?;
    run_node_runtime_task(move || {
        open_managed_runtime_root_with(&root, |path| {
            crate::runner::open_folder(path.to_string_lossy().to_string())
        })
    })
    .await
}

fn copy_directory_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        if !target.is_dir() {
            return Err(format!(
                "Migration target is not a directory: {}",
                target.display()
            ));
        }
    } else {
        fs::create_dir_all(target).map_err(|error| {
            format!(
                "Failed to create migration directory {}: {error}",
                target.display()
            )
        })?;
    }

    let entries = fs::read_dir(source).map_err(|error| {
        format!(
            "Failed to read Managed Node runtime {}: {error}",
            source.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "Failed to copy {} to {}: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn validate_runtime_directory(path: &Path, expected_version: &str) -> Result<(), String> {
    let executable = node_executable(path).ok_or_else(|| {
        format!(
            "Managed Node runtime is missing node executable: {}",
            path.display()
        )
    })?;
    let actual = run_node_version(&executable)?;
    let actual = normalize_detected_version(&actual)
        .ok_or_else(|| format!("Invalid node -v output from {}", executable.display()))?;
    if actual != expected_version {
        return Err(format!(
            "Managed Node runtime version mismatch: expected {expected_version}, got {actual}"
        ));
    }
    Ok(())
}

fn migration_stage_name() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!(".project-manager-runtime-migration-{stamp}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeMigrationPhase {
    Prepare,
    Scan,
    Copy,
    Verify,
    Switch,
    Cleanup,
    Complete,
}

impl RuntimeMigrationPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "prepare",
            Self::Scan => "scan",
            Self::Copy => "copy",
            Self::Verify => "verify",
            Self::Switch => "switch",
            Self::Cleanup => "cleanup",
            Self::Complete => "complete",
        }
    }
}

fn migration_error(phase: RuntimeMigrationPhase, operation: &str, detail: &str) -> String {
    format!(
        "Managed Node runtime migration failed\nphase: {}\noperation: {operation}\nerror: {detail}",
        phase.as_str()
    )
}

#[derive(Debug)]
struct RuntimeMigrationExecution {
    warnings: Vec<String>,
    phase: RuntimeMigrationPhase,
}

fn execute_runtime_migration<FCopy, FVerify, FPromote, FSwitch, FCleanup>(
    installed: &[(String, PathBuf)],
    stage_root: &Path,
    new_root: &Path,
    mut copy_runtime: FCopy,
    mut verify_runtime: FVerify,
    mut promote_runtime: FPromote,
    mut switch_location: FSwitch,
    mut cleanup_runtime: FCleanup,
) -> Result<RuntimeMigrationExecution, String>
where
    FCopy: FnMut(&Path, &Path) -> Result<(), String>,
    FVerify: FnMut(&Path, &str) -> Result<(), String>,
    FPromote: FnMut(&Path, &Path) -> Result<(), String>,
    FSwitch: FnMut() -> Result<(), String>,
    FCleanup: FnMut(&Path) -> Result<(), String>,
{
    for (version, source_path) in installed {
        let target_path = new_root.join(version);
        if target_path.exists() {
            verify_runtime(&target_path, version).map_err(|error| {
                migration_error(
                    RuntimeMigrationPhase::Verify,
                    &format!("verify existing target for {version}"),
                    &error,
                )
            })?;
            continue;
        }

        let staged_path = stage_root.join(version);
        copy_runtime(source_path, &staged_path).map_err(|error| {
            migration_error(
                RuntimeMigrationPhase::Copy,
                &format!("copy {version}"),
                &error,
            )
        })?;
        verify_runtime(&staged_path, version).map_err(|error| {
            migration_error(
                RuntimeMigrationPhase::Verify,
                &format!("verify copied {version}"),
                &error,
            )
        })?;
    }

    for (version, _) in installed {
        let target_path = new_root.join(version);
        if target_path.exists() {
            continue;
        }
        let staged_path = stage_root.join(version);
        promote_runtime(&staged_path, &target_path).map_err(|error| {
            migration_error(
                RuntimeMigrationPhase::Switch,
                &format!("promote {version}"),
                &error,
            )
        })?;
    }

    switch_location().map_err(|error| {
        migration_error(
            RuntimeMigrationPhase::Switch,
            "save Managed Runtime location",
            &error,
        )
    })?;

    let mut warnings = Vec::new();
    for (_, source_path) in installed {
        if !source_path.exists() {
            continue;
        }
        if let Err(error) = cleanup_runtime(source_path) {
            warnings.push(format!(
                "迁移成功，但旧文件未完全删除：{} ({error})",
                source_path.display()
            ));
        }
    }

    Ok(RuntimeMigrationExecution {
        warnings,
        phase: RuntimeMigrationPhase::Complete,
    })
}

fn managed_location_info_for_app(
    app: &AppHandle,
    setting: &ManagedRuntimeLocationSetting,
    warnings: Vec<String>,
) -> Result<ManagedRuntimeLocationInfo, String> {
    let root = resolve_managed_runtime_root_for_setting(app, setting)?;
    let portable = portable_root(app)?;
    managed_location_info_sync(setting, root, portable, warnings)
}

fn migrate_managed_node_runtime_location_sync(
    app: &AppHandle,
    setting: ManagedRuntimeLocationSetting,
    migrate: bool,
    running_runtime_paths: Vec<String>,
) -> Result<ManagedRuntimeLocationInfo, String> {
    let old_setting = read_managed_location(&app)?;
    let old_root = resolve_managed_runtime_root_for_setting(&app, &old_setting)?;
    let new_root = resolve_managed_runtime_root_for_setting(&app, &setting)?;

    if paths_equal(&old_root, &new_root) {
        ensure_writable_directory(&new_root).map_err(|error| {
            migration_error(
                RuntimeMigrationPhase::Prepare,
                "check target directory",
                &error,
            )
        })?;
        write_managed_location(&app, &setting).map_err(|error| {
            migration_error(
                RuntimeMigrationPhase::Switch,
                "save Managed Runtime location",
                &error,
            )
        })?;
        return managed_location_info_for_app(app, &setting, Vec::new());
    }

    if migrate && (path_is_within(&new_root, &old_root) || path_is_within(&old_root, &new_root)) {
        return Err(migration_error(
            RuntimeMigrationPhase::Prepare,
            "validate source and target directories",
            "Managed Node runtime migration cannot use nested source and target directories",
        ));
    }

    ensure_writable_directory(&new_root).map_err(|error| {
        migration_error(
            RuntimeMigrationPhase::Prepare,
            "check target directory",
            &error,
        )
    })?;

    if !migrate {
        write_managed_location(&app, &setting).map_err(|error| {
            migration_error(
                RuntimeMigrationPhase::Switch,
                "save Managed Runtime location",
                &error,
            )
        })?;
        return managed_location_info_for_app(app, &setting, Vec::new());
    }

    if old_root.exists() && !old_root.is_dir() {
        return Err(migration_error(
            RuntimeMigrationPhase::Scan,
            "inspect current Managed Runtime root",
            &format!(
                "Managed Node runtime path is not a directory: {}",
                old_root.display()
            ),
        ));
    }
    let installed = runtime_directory_entries(&old_root);
    if !installed.is_empty() {
        for running_path in running_runtime_paths {
            let running = Path::new(&running_path);
            if installed
                .iter()
                .any(|(_, runtime_path)| path_is_within(running, runtime_path))
            {
                return Err(migration_error(
                    RuntimeMigrationPhase::Scan,
                    "check running Managed Node runtimes",
                    "当前有项目正在使用 Managed Node，请先停止项目，再迁移运行时目录。",
                ));
            }
        }
    }

    if installed.is_empty() {
        write_managed_location(&app, &setting).map_err(|error| {
            migration_error(
                RuntimeMigrationPhase::Switch,
                "save Managed Runtime location",
                &error,
            )
        })?;
        return managed_location_info_for_app(app, &setting, Vec::new());
    }

    let stage_root = new_root.join(migration_stage_name());
    if stage_root.exists() {
        remove_runtime_path_with_retry(
            RuntimeMigrationPhase::Prepare.as_str(),
            "remove previous migration staging directory",
            &stage_root,
        )
        .map_err(|error| {
            migration_error(
                RuntimeMigrationPhase::Prepare,
                "remove previous migration staging directory",
                &error,
            )
        })?;
    }
    fs::create_dir_all(&stage_root).map_err(|error| {
        migration_error(
            RuntimeMigrationPhase::Prepare,
            "create migration staging directory",
            &format!("{}: {error}", stage_root.display()),
        )
    })?;

    let migration_result = execute_runtime_migration(
        &installed,
        &stage_root,
        &new_root,
        |source, staged| copy_directory_recursive(source, staged),
        |path, version| validate_runtime_directory(path, version),
        |staged, target| {
            rename_with_retry(
                RuntimeMigrationPhase::Switch.as_str(),
                "promote migrated Node runtime",
                staged,
                target,
            )
        },
        || write_managed_location(&app, &setting),
        |source| {
            remove_runtime_path_with_retry(
                RuntimeMigrationPhase::Cleanup.as_str(),
                "remove old Managed Node runtime",
                source,
            )
        },
    );

    let stage_cleanup_error = remove_dir_all_with_retry(
        RuntimeMigrationPhase::Cleanup.as_str(),
        "remove migration staging directory",
        &stage_root,
    )
    .err();

    let mut execution = match migration_result {
        Ok(execution) => execution,
        Err(mut error) => {
            if let Some(cleanup_error) = stage_cleanup_error {
                error.push_str(&format!("\ncleanup_error: {cleanup_error}"));
            }
            return Err(error);
        }
    };

    if let Some(error) = stage_cleanup_error {
        execution.warnings.push(format!(
            "迁移成功，但临时目录未完全删除：{} ({error})",
            stage_root.display()
        ));
    }

    if old_root.exists() && installed.iter().all(|(_, path)| !path.exists()) {
        if let Err(error) = remove_dir_all_with_retry(
            RuntimeMigrationPhase::Cleanup.as_str(),
            "remove old Managed Node root",
            &old_root,
        ) {
            execution.warnings.push(format!(
                "迁移成功，但旧根目录未完全删除：{} ({error})",
                old_root.display()
            ));
        }
    }

    debug_assert_eq!(execution.phase, RuntimeMigrationPhase::Complete);
    managed_location_info_for_app(app, &setting, execution.warnings)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn migrate_managed_node_runtime_location(
    app: AppHandle,
    mode: String,
    custom_path: Option<String>,
    migrate: bool,
    running_runtime_paths: Vec<String>,
) -> Result<ManagedRuntimeLocationInfo, String> {
    let setting = normalize_managed_location_setting(&mode, custom_path.as_deref())?;
    run_node_runtime_task(move || {
        migrate_managed_node_runtime_location_sync(&app, setting, migrate, running_runtime_paths)
    })
    .await
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
        return Err(format!(
            "Failed to fetch Node releases: HTTP {}",
            response.status()
        ));
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
    if let Err(error) = state.cancels.lock().map(|mut cancels| {
        cancels.insert(operation_id.clone(), cancel.clone());
    }) {
        unlock_version(&state, &version);
        return Err(error.to_string());
    }

    let busy_versions = state
        .installing
        .lock()
        .map(|installing| installing.clone())
        .unwrap_or_else(|_| HashSet::from([version.clone()]));
    let result = install_managed_node_inner(
        &app,
        &version,
        &operation_id,
        cancel.clone(),
        &busy_versions,
    )
    .await;

    {
        if let Ok(mut cancels) = state.cancels.lock() {
            cancels.remove(&operation_id);
        }
    }
    unlock_version(&state, &version);
    result
}

fn finalize_runtime(staging_dir: &Path, final_dir: &Path) -> Result<(), String> {
    if final_dir.exists() {
        if runtime_status(final_dir) == "available" {
            return Ok(());
        }
        remove_runtime_path_with_retry(
            "replace_broken_runtime",
            "remove broken managed runtime",
            final_dir,
        )?;
    }
    rename_with_retry(
        "finalize",
        "promote runtime staging directory",
        staging_dir,
        final_dir,
    )
}

fn validate_final_runtime(final_dir: &Path, expected_version: &str) -> Result<(), String> {
    let exe = node_executable(final_dir).ok_or_else(|| {
        runtime_error(
            "validating",
            "locate finalized node executable",
            final_dir,
            "finalized runtime is missing node executable",
        )
    })?;
    match run_node_version(&exe) {
        Ok(actual_version) if actual_version == expected_version => Ok(()),
        Ok(actual_version) => Err(runtime_error(
            "validating",
            "run node -v",
            &exe,
            &format!("node -v mismatch: expected {expected_version}, got {actual_version}"),
        )),
        Err(error) => Err(runtime_error("validating", "run node -v", &exe, &error)),
    }
}

async fn install_managed_node_inner(
    app: &AppHandle,
    version: &str,
    operation_id: &str,
    cancel: Arc<AtomicBool>,
    busy_versions: &HashSet<String>,
) -> Result<String, String> {
    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "preparing".to_string(),
            downloaded_bytes: None,
            total_bytes: None,
            percent: None,
        },
    );
    let root = resolve_managed_runtime_root(app)?;
    fs::create_dir_all(&root).map_err(|error| {
        fs_error(
            "preparing",
            "create managed runtime directory",
            &root,
            &error,
        )
    })?;
    cleanup_stale(&root, busy_versions);

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
    let part_path = root.join(format!("{}.part", artifact.file_name));
    let archive_path = root.join(&artifact.file_name);
    let extract_dir = root.join(format!("extract-{version}"));
    let prepare_cleanup_warnings =
        cleanup_install_temp_with_warnings("preparing", &part_path, &archive_path, &extract_dir);
    if !prepare_cleanup_warnings.is_empty() {
        return Err(format!(
            "Node install failed\nphase: preparing\noperation: clear previous temporary files\npath: {}\nerror: {}",
            root.display(),
            prepare_cleanup_warnings.join("\n")
        ));
    }

    let dist_base = format!("{NODE_DIST_HOST}/dist/{version}");
    let shasum_url = format!("{dist_base}/SHASUMS256.txt");
    let artifact_url = format!("{dist_base}/{}", artifact.file_name);
    if !artifact_url.starts_with(NODE_DIST_HOST) || !shasum_url.starts_with(NODE_DIST_HOST) {
        return Err("Refusing to download from non-official host".to_string());
    }

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
        .get(&artifact.file_name)
        .cloned()
        .ok_or_else(|| format!("Checksum missing for {}", artifact.file_name))?;

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
            cleanup_install_temp(&part_path, &archive_path, &extract_dir);
            return Err(format!("Download failed: {error}"));
        }
    };
    if response.status().as_u16() == 404 {
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(format!("Node artifact not found: {}", artifact.file_name));
    }
    if let Err(error) = response.error_for_status_ref() {
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(format!("Download failed: {error}"));
    }
    let total = response.content_length();
    let mut file = match File::create(&part_path) {
        Ok(file) => file,
        Err(error) => {
            cleanup_install_temp(&part_path, &archive_path, &extract_dir);
            return Err(fs_error(
                "downloading",
                "create archive part",
                &part_path,
                &error,
            ));
        }
    };
    let mut hasher = Sha256::new();
    let mut downloaded = 0_u64;
    let mut last_emit = Instant::now();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            cleanup_install_temp(&part_path, &archive_path, &extract_dir);
            return Err("cancelled".to_string());
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                cleanup_install_temp(&part_path, &archive_path, &extract_dir);
                return Err(format!("Download failed: {error}"));
            }
        };
        if let Err(error) = file.write_all(&chunk) {
            cleanup_install_temp(&part_path, &archive_path, &extract_dir);
            return Err(fs_error(
                "downloading",
                "write archive part",
                &part_path,
                &error,
            ));
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
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(fs_error(
            "downloading",
            "flush archive part",
            &part_path,
            &error,
        ));
    }
    if let Err(error) = sync_and_close_download(file) {
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(format!(
            "Node install failed\nphase: downloading\noperation: sync and close archive part\npath: {}\nerror: {error}",
            part_path.display()
        ));
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
    if !checksum_matches(&expected, &actual) {
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(runtime_error(
            "verifying",
            "verify SHA-256 checksum",
            &part_path,
            "checksum mismatch",
        ));
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

    if let Err(error) = extract_archive(&part_path, artifact.kind, &extract_dir) {
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(error);
    }
    if node_executable(&extract_dir).is_none() {
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(runtime_error(
            "extracting",
            "locate extracted node executable",
            &extract_dir,
            "extracted runtime is missing node executable",
        ));
    }

    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "finalizing".to_string(),
            downloaded_bytes: Some(downloaded),
            total_bytes: total,
            percent: Some(100),
        },
    );

    if cancel.load(Ordering::SeqCst) {
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err("cancelled".to_string());
    }
    if let Err(error) = finalize_runtime(&extract_dir, &final_dir) {
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(error);
    }

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
    if let Err(error) = validate_final_runtime(&final_dir, version) {
        let remove_error = remove_runtime_path_with_retry(
            "validating",
            "remove invalid finalized runtime",
            &final_dir,
        )
        .err();
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        return Err(match remove_error {
            Some(remove_error) => format!("{error}\ncleanup_error: {remove_error}"),
            None => error,
        });
    }

    emit_progress(
        app,
        &NodeInstallProgress {
            operation_id: operation_id.to_string(),
            version: version.to_string(),
            phase: "cleanup".to_string(),
            downloaded_bytes: Some(downloaded),
            total_bytes: total,
            percent: Some(100),
        },
    );
    let cleanup_warnings =
        cleanup_install_temp_with_warnings("cleanup", &part_path, &archive_path, &extract_dir);
    for warning in &cleanup_warnings {
        eprintln!("Node install cleanup warning: {warning}");
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
    let root = resolve_managed_runtime_root(&app);
    let version_for_task = version.clone();
    let result = match root {
        Err(error) => Err(error),
        Ok(root) => {
            run_node_runtime_task(move || {
                let dir = version_dir(&root, &version_for_task);
                if !dir.exists() {
                    return Ok(());
                }
                remove_runtime_path_with_retry("uninstall", "remove managed runtime", &dir)
            })
            .await
        }
    };
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
    fn current_artifact_keeps_archive_kind_separate_from_file_name() {
        let artifact = current_artifact("v20.11.1").unwrap();
        #[cfg(target_os = "windows")]
        {
            assert_eq!(artifact.file_name, "node-v20.11.1-win-x64.zip");
            assert_eq!(artifact.kind, NodeArchiveKind::Zip);
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(artifact.file_name.ends_with(".tar.gz"));
            assert_eq!(artifact.kind, NodeArchiveKind::TarGz);
        }
    }

    #[test]
    fn transient_permission_denied_retries_then_succeeds() {
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("staging");
        let to = temp.path().join("final");
        let mut calls = 0;
        let value = retry_fs_operation_with_sleep(
            "finalize",
            "rename staging runtime",
            FsTarget::Rename {
                from: &from,
                to: &to,
            },
            || {
                calls += 1;
                if calls == 1 {
                    Err(io::Error::from_raw_os_error(5))
                } else {
                    Ok("promoted")
                }
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(value, "promoted");
        assert_eq!(calls, 2);
    }

    #[test]
    fn exhausted_filesystem_retry_contains_phase_paths_and_raw_error() {
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("staging");
        let to = temp.path().join("final");
        let error = retry_fs_operation_with_sleep::<(), _, _>(
            "finalize",
            "rename staging runtime",
            FsTarget::Rename {
                from: &from,
                to: &to,
            },
            || Err(io::Error::from_raw_os_error(5)),
            |_| {},
        )
        .unwrap_err();

        assert!(error.contains("phase: finalize"));
        assert!(error.contains(&format!("from: {}", from.display())));
        assert!(error.contains(&format!("to: {}", to.display())));
        assert!(error.contains("raw_os_error: 5"));
    }

    #[test]
    fn broken_final_runtime_is_replaced_explicitly() {
        let temp = tempfile::tempdir().unwrap();
        let staging = temp.path().join("runtime-staging");
        let final_dir = temp.path().join("v20.11.1");
        fs::create_dir_all(&staging).unwrap();
        fs::create_dir_all(&final_dir).unwrap();
        #[cfg(target_os = "windows")]
        File::create(staging.join("node.exe")).unwrap();
        #[cfg(not(target_os = "windows"))]
        {
            let executable = staging.join("node");
            File::create(&executable).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }

        finalize_runtime(&staging, &final_dir).unwrap();
        assert!(!staging.exists());
        assert!(final_dir.exists());
        assert!(node_executable(&final_dir).is_some());
    }

    #[test]
    fn post_success_cleanup_failure_is_reported_as_warning_only() {
        let temp = tempfile::tempdir().unwrap();
        let part = temp.path().join("archive.part");
        let archive = temp.path().join("archive.zip");
        let staging = temp.path().join("runtime-staging");
        let warnings = cleanup_install_temp_with(
            "cleanup",
            &part,
            &archive,
            &staging,
            |path| {
                if path == part {
                    Err(io::Error::from_raw_os_error(5))
                } else {
                    Ok(())
                }
            },
            |_| Ok(()),
            |_| {},
        );

        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("phase: cleanup"));
        assert!(warnings[0].contains("archive.part"));
        assert!(warnings[0].contains("raw_os_error: 5"));
    }

    #[test]
    fn finalize_call_precedes_final_validation_call() {
        let source = include_str!("node_runtime.rs");
        let finalize = source
            .find("if let Err(error) = finalize_runtime(&extract_dir")
            .unwrap();
        let validate = source
            .find("if let Err(error) = validate_final_runtime(&final_dir")
            .unwrap();
        assert!(
            finalize < validate,
            "final runtime must be validated after promotion"
        );
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
        assert!(checksum_matches(
            &sha256_hex(b"hello"),
            &sha256_hex(b"hello")
        ));
        assert!(!checksum_matches(
            &sha256_hex(b"hello"),
            &sha256_hex(b"world")
        ));
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

    fn test_node_executable() -> Option<PathBuf> {
        #[cfg(target_os = "windows")]
        use std::os::windows::process::CommandExt;
        #[cfg(target_os = "windows")]
        let output = Command::new("where")
            .arg("node")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        #[cfg(not(target_os = "windows"))]
        let output = Command::new("which").arg("node").output().ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)
    }

    fn copy_test_node_runtime(root: &Path, source: &Path) {
        #[cfg(target_os = "windows")]
        let executable = root.join("node.exe");
        #[cfg(not(target_os = "windows"))]
        let executable = root.join("bin").join("node");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::copy(source, &executable).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn nvm_scan_uses_executable_version_and_skips_invalid_candidates() {
        let Some(source) = test_node_executable() else {
            return;
        };
        let temp = tempfile::tempdir().unwrap();
        #[cfg(target_os = "windows")]
        let scan_root = temp.path().to_path_buf();
        #[cfg(not(target_os = "windows"))]
        let scan_root = temp.path().join(".nvm");

        #[cfg(target_os = "windows")]
        {
            copy_test_node_runtime(&scan_root.join("v18.20.8"), &source);
            copy_test_node_runtime(&scan_root.join("v20.19.0"), &source);
            let invalid = scan_root.join("invalid");
            fs::create_dir_all(&invalid).unwrap();
            File::create(invalid.join("node.exe")).unwrap();
        }
        #[cfg(not(target_os = "windows"))]
        {
            copy_test_node_runtime(&scan_root.join("versions/node/v18.20.8"), &source);
            copy_test_node_runtime(&scan_root.join("versions/node/v20.19.0"), &source);
            let invalid = scan_root.join("versions/node/invalid");
            fs::create_dir_all(&invalid).unwrap();
            File::create(invalid.join("bin/node")).unwrap();
        }

        let runtimes = scan_nvm_root(&scan_root);
        assert_eq!(runtimes.len(), 2);
        assert!(runtimes.iter().all(|runtime| runtime.source == "nvm"));
        assert!(runtimes
            .iter()
            .all(|runtime| runtime.runtime_id.starts_with("nvm:")));
        assert!(runtimes.iter().all(|runtime| runtime.status == "available"));
    }

    #[test]
    fn runtime_ids_keep_same_version_sources_separate() {
        let managed = runtime_id("managed", "v20.19.0", Path::new("C:/managed/v20.19.0"));
        let nvm = runtime_id("nvm", "v20.19.0", Path::new("C:/nvm/v20.19.0"));
        assert_eq!(managed, "managed:v20.19.0");
        assert_ne!(managed, nvm);
        assert!(path_is_within(
            Path::new("C:/old/v20/node.exe"),
            Path::new("C:/old/v20")
        ));
        assert!(!path_is_within(
            Path::new("C:/old-other/v20"),
            Path::new("C:/old")
        ));
    }

    #[test]
    fn stale_temp_cleanup_skips_busy_version() {
        let busy = HashSet::from(["v20.11.1".to_string()]);
        assert!(is_stale_runtime_temp(
            "node-v22.0.0-win-x64.zip.part",
            &busy
        ));
        assert!(!is_stale_runtime_temp("extract-v20.11.1", &busy));
        assert!(!is_stale_runtime_temp(
            "node-v20.11.1-win-x64.zip.part",
            &busy
        ));
        assert!(is_stale_runtime_temp("extract-v22.0.0", &busy));
        assert!(!is_stale_runtime_temp("v20.11.1", &busy));
    }

    #[test]
    fn managed_runtime_directory_size_counts_empty_single_and_multiple_versions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("runtimes").join("node");
        assert_eq!(directory_size_stats(&root).0, 0);

        let first = root.join("v20.11.1");
        fs::create_dir_all(first.join("bin")).unwrap();
        fs::write(first.join("node.exe"), vec![1_u8; 7]).unwrap();
        fs::write(first.join("bin").join("npm"), vec![2_u8; 5]).unwrap();
        assert_eq!(directory_size_stats(&root).0, 12);

        let second = root.join("v22.0.0");
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join("node.exe"), vec![3_u8; 19]).unwrap();
        assert_eq!(directory_size_stats(&root).0, 31);
    }

    #[test]
    fn managed_runtime_root_resolver_covers_app_data_custom_and_portable() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let executable = temp.path().join("bin");
        let app_data_setting = ManagedRuntimeLocationSetting::default();
        let custom_setting = ManagedRuntimeLocationSetting {
            mode: "custom".to_string(),
            custom_path: Some(temp.path().join("custom").to_string_lossy().to_string()),
        };
        let portable_setting = ManagedRuntimeLocationSetting {
            mode: "portable".to_string(),
            custom_path: None,
        };

        assert_eq!(
            resolve_managed_runtime_root_from_paths(
                &app_data_setting,
                Some(&app_data),
                Some(&executable)
            ),
            Ok(app_data.join("runtimes").join("node"))
        );
        assert_eq!(
            resolve_managed_runtime_root_from_paths(
                &custom_setting,
                Some(&app_data),
                Some(&executable)
            ),
            Ok(PathBuf::from(custom_setting.custom_path.as_ref().unwrap()))
        );
        assert_eq!(
            resolve_managed_runtime_root_from_paths(
                &portable_setting,
                Some(&app_data),
                Some(&executable)
            ),
            Ok(executable.join("data").join("runtimes").join("node"))
        );
    }

    #[test]
    fn managed_runtime_root_open_covers_app_data_custom_and_portable() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        let executable = temp.path().join("bin");
        let settings = [
            ManagedRuntimeLocationSetting::default(),
            ManagedRuntimeLocationSetting {
                mode: "custom".to_string(),
                custom_path: Some(temp.path().join("custom").to_string_lossy().to_string()),
            },
            ManagedRuntimeLocationSetting {
                mode: "portable".to_string(),
                custom_path: None,
            },
        ];

        for setting in settings {
            let root = resolve_managed_runtime_root_from_paths(
                &setting,
                Some(&app_data),
                Some(&executable),
            )
            .unwrap();
            let mut opened = None;
            open_managed_runtime_root_with(&root, |path| {
                opened = Some(path.to_path_buf());
                Ok(())
            })
            .unwrap();
            assert_eq!(opened, Some(root.clone()));
            assert!(root.is_dir());
        }
    }

    #[test]
    fn managed_runtime_location_rejects_relative_custom_path() {
        assert!(normalize_managed_location_setting("custom", Some("relative/node")).is_err());
        assert_eq!(
            normalize_managed_location_setting("app-data", Some("ignored"))
                .unwrap()
                .mode,
            "app-data"
        );
    }

    #[test]
    fn writable_probe_creates_and_removes_a_real_probe_file() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("new").join("nested");
        assert!(writable_probe(&missing));
        assert!(
            !missing.exists(),
            "probe should remove directories it created"
        );

        let file = temp.path().join("not-a-directory");
        File::create(&file).unwrap();
        assert!(!writable_probe(&file));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let readonly = temp.path().join("readonly");
            fs::create_dir_all(&readonly).unwrap();
            fs::set_permissions(&readonly, fs::Permissions::from_mode(0o555)).unwrap();
            assert!(!writable_probe(&readonly));
            fs::set_permissions(&readonly, fs::Permissions::from_mode(0o755)).unwrap();
        }

        let readonly = temp.path().join("readonly-attribute");
        fs::create_dir_all(&readonly).unwrap();
        let mut permissions = fs::metadata(&readonly).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&readonly, permissions).unwrap();
        assert!(!writable_probe(&readonly));
        let mut permissions = fs::metadata(&readonly).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&readonly, permissions).unwrap();
    }

    #[test]
    fn managed_runtime_root_open_uses_the_resolved_directory() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("custom-root");
        let mut opened = None;
        open_managed_runtime_root_with(&root, |path| {
            opened = Some(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(opened, Some(root.clone()));
        assert!(root.is_dir());
    }

    #[test]
    fn migration_state_machine_success_runs_all_phases() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old").join("v20.11.1");
        let stage = temp.path().join("new").join(".stage");
        let target = temp.path().join("new");
        let installed = vec![("v20.11.1".to_string(), source.clone())];
        fs::create_dir_all(&source).unwrap();
        use std::sync::{Arc, Mutex};
        let phases = Arc::new(Mutex::new(Vec::new()));
        let copy_phases = Arc::clone(&phases);
        let verify_phases = Arc::clone(&phases);
        let promote_phases = Arc::clone(&phases);
        let switch_phases = Arc::clone(&phases);
        let cleanup_phases = Arc::clone(&phases);

        let result = execute_runtime_migration(
            &installed,
            &stage,
            &target,
            |_, _| {
                copy_phases.lock().unwrap().push("copy");
                Ok(())
            },
            |_, _| {
                verify_phases.lock().unwrap().push("verify");
                Ok(())
            },
            |_, _| {
                promote_phases.lock().unwrap().push("promote");
                Ok(())
            },
            || {
                switch_phases.lock().unwrap().push("switch");
                Ok(())
            },
            |_| {
                cleanup_phases.lock().unwrap().push("cleanup");
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(result.phase, RuntimeMigrationPhase::Complete);
        assert!(result.warnings.is_empty());
        assert_eq!(
            *phases.lock().unwrap(),
            ["copy", "verify", "promote", "switch", "cleanup"]
        );
    }

    #[test]
    fn migration_state_machine_copy_failure_keeps_error_phase() {
        let temp = tempfile::tempdir().unwrap();
        let installed = vec![("v20.11.1".to_string(), temp.path().join("old"))];
        let error = execute_runtime_migration(
            &installed,
            &temp.path().join("stage"),
            &temp.path().join("new"),
            |_, _| Err("copy failed".to_string()),
            |_, _| Ok(()),
            |_, _| Ok(()),
            || Ok(()),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("phase: copy"));
        assert!(error.contains("copy failed"));
    }

    #[test]
    fn migration_state_machine_verify_failure_keeps_error_phase() {
        let temp = tempfile::tempdir().unwrap();
        let installed = vec![("v20.11.1".to_string(), temp.path().join("old"))];
        let error = execute_runtime_migration(
            &installed,
            &temp.path().join("stage"),
            &temp.path().join("new"),
            |_, _| Ok(()),
            |_, _| Err("verify failed".to_string()),
            |_, _| Ok(()),
            || Ok(()),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("phase: verify"));
        assert!(error.contains("verify failed"));
    }

    #[test]
    fn migration_state_machine_cleanup_failure_is_a_warning_after_switch() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("old");
        fs::create_dir_all(&source).unwrap();
        let installed = vec![("v20.11.1".to_string(), source)];
        let result = execute_runtime_migration(
            &installed,
            &temp.path().join("stage"),
            &temp.path().join("new"),
            |_, _| Ok(()),
            |_, _| Ok(()),
            |_, _| Ok(()),
            || Ok(()),
            |_| Err("cleanup failed".to_string()),
        )
        .unwrap();
        assert_eq!(result.phase, RuntimeMigrationPhase::Complete);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("迁移成功"));
        assert!(result.warnings[0].contains("cleanup failed"));
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

    #[test]
    fn zip_part_is_extracted_with_explicit_archive_kind() {
        let temp = tempfile::tempdir().unwrap();
        let part_path = temp.path().join("node-v20.11.1-win-x64.zip.part");
        let archive_path = temp.path().join("node-v20.11.1-win-x64.zip");
        {
            let file = File::create(&part_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("node-v20.11.1-win-x64/node.exe", options)
                .unwrap();
            zip.write_all(b"node").unwrap();
            zip.finish().unwrap();
        }
        let dest = temp.path().join("extract-v20.11.1");
        extract_archive(&part_path, NodeArchiveKind::Zip, &dest).unwrap();
        assert!(part_path.exists());
        assert!(!archive_path.exists());
        assert!(dest.join("node.exe").exists());
        cleanup_install_temp(&part_path, &archive_path, &dest);
        assert!(!part_path.exists());
        assert!(!archive_path.exists());
        assert!(!dest.exists());
    }

    #[test]
    fn downloaded_archive_writer_is_closed_before_promotion() {
        let temp = tempfile::tempdir().unwrap();
        let part_path = temp.path().join("node-v20.11.1-win-x64.zip.part");
        let archive_path = temp.path().join("node-v20.11.1-win-x64.zip");
        let mut file = File::create(&part_path).unwrap();
        file.write_all(b"downloaded").unwrap();
        sync_and_close_download(file).unwrap();
        promote_downloaded_archive(&part_path, &archive_path).unwrap();
        assert!(archive_path.exists());
        cleanup_install_temp(
            &part_path,
            &archive_path,
            &temp.path().join("extract-v20.11.1"),
        );
    }

    #[test]
    fn tar_gz_part_is_extracted_with_explicit_archive_kind() {
        let temp = tempfile::tempdir().unwrap();
        let part_path = temp.path().join("node-v20.11.1-linux-x64.tar.gz.part");
        let archive_path = temp.path().join("node-v20.11.1-linux-x64.tar.gz");
        {
            let file = File::create(&part_path).unwrap();
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut tar = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_path("node-v20.11.1-linux-x64/bin/node").unwrap();
            header.set_size(4);
            header.set_mode(0o755);
            header.set_cksum();
            tar.append(&header, &b"node"[..]).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }
        let dest = temp.path().join("extract-v20.11.1");
        extract_archive(&part_path, NodeArchiveKind::TarGz, &dest).unwrap();
        assert!(part_path.exists());
        assert!(dest.join("bin").join("node").exists());
        cleanup_install_temp(&part_path, &archive_path, &dest);
        assert!(!archive_path.exists());
        assert!(!dest.exists());
    }

    #[test]
    fn checksum_failure_does_not_promote_or_extract() {
        let temp = tempfile::tempdir().unwrap();
        let part_path = temp.path().join("node-v20.11.1-win-x64.zip.part");
        let archive_path = temp.path().join("node-v20.11.1-win-x64.zip");
        let extract_dir = temp.path().join("extract-v20.11.1");
        fs::write(&part_path, b"bad archive").unwrap();
        assert!(!checksum_matches(
            &sha256_hex(b"expected"),
            &sha256_hex(b"bad archive")
        ));
        assert!(part_path.exists());
        assert!(!archive_path.exists());
        assert!(!extract_dir.exists());
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
    }

    #[test]
    fn extract_failure_cleans_temp_and_retry_can_succeed() {
        let temp = tempfile::tempdir().unwrap();
        let part_path = temp.path().join("node-v20.11.1-win-x64.zip.part");
        let archive_path = temp.path().join("node-v20.11.1-win-x64.zip");
        let extract_dir = temp.path().join("extract-v20.11.1");
        fs::write(&part_path, b"not a zip").unwrap();
        promote_downloaded_archive(&part_path, &archive_path).unwrap();
        assert!(extract_archive(&archive_path, NodeArchiveKind::Zip, &extract_dir).is_err());
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
        assert!(!part_path.exists());
        assert!(!archive_path.exists());
        assert!(!extract_dir.exists());

        {
            let file = File::create(&part_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("node-v20.11.1-win-x64/node.exe", options)
                .unwrap();
            zip.write_all(b"node").unwrap();
            zip.finish().unwrap();
        }
        promote_downloaded_archive(&part_path, &archive_path).unwrap();
        extract_archive(&archive_path, NodeArchiveKind::Zip, &extract_dir).unwrap();
        assert!(extract_dir.join("node.exe").exists());
        cleanup_install_temp(&part_path, &archive_path, &extract_dir);
    }
}
