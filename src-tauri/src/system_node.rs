use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::node_runtime::{node_executable, validate_node_version};

const INTEGRATION_FILE: &str = "system-node-integration.json";
const OPERATION_DIRECTORY: &str = "node-system";
const APP_DATA_DIRECTORY_IDENTIFIER: &str = "com.cuteyuchen.project-manager";
const OPERATION_SCHEMA_VERSION: u32 = 1;
const OPERATION_ARGUMENT: &str = "--elevated-node-operation";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNodeCandidate {
    pub path: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNodeState {
    pub available: bool,
    pub version: Option<String>,
    pub node_path: Option<String>,
    pub runtime_id: Option<String>,
    pub source: Option<String>,
    pub candidates: Vec<SystemNodeCandidate>,
    pub path_scope: Option<String>,
    pub nvm_symlink: Option<String>,
    pub nvm_target_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRuntimeTarget {
    pub runtime_id: Option<String>,
    pub version: String,
    pub path: String,
    pub source: String,
    pub runtime_root: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNodeSwitchOptions {
    #[serde(default)]
    pub elevated: bool,
    #[serde(default)]
    pub repair_path_priority: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNodeSwitchResult {
    pub success: bool,
    pub status: String,
    pub previous: Option<SystemNodeState>,
    pub current: Option<SystemNodeState>,
    pub conflicting_path: Option<String>,
    pub operation: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemNodeIntegrationState {
    managed_runtime_id: Option<String>,
    user_path_entry: Option<String>,
    machine_path_entry: Option<String>,
    user_path_backup: Option<String>,
    machine_path_backup: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedTarget {
    runtime_id: Option<String>,
    version: String,
    source: String,
    runtime_root: Option<String>,
    directory: PathBuf,
    executable: PathBuf,
}

#[derive(Debug, Clone)]
enum SwitchFailure {
    RuntimeUnavailable(String),
    NvmNotFound,
    Permission(String),
    NvmSwitchFailed(String),
    PathWrite { scope: &'static str, detail: String },
    Verification(String),
    IntegrationState(String),
    Rollback(String),
    Unsupported,
}

impl SwitchFailure {
    fn message(&self) -> String {
        match self {
            Self::RuntimeUnavailable(detail)
            | Self::Permission(detail)
            | Self::NvmSwitchFailed(detail)
            | Self::Verification(detail)
            | Self::IntegrationState(detail)
            | Self::Rollback(detail) => detail.clone(),
            Self::NvmNotFound => "NVM for Windows executable was not found".to_string(),
            Self::PathWrite { scope, detail } => format!("Failed to write {scope} PATH: {detail}"),
            Self::Unsupported => "System Node switching is only supported on Windows desktop".to_string(),
        }
    }

    fn error_code(&self) -> &'static str {
        match self {
            Self::RuntimeUnavailable(_) => "runtime_unavailable",
            Self::NvmNotFound => "nvm_not_found",
            Self::Permission(_) => "elevation_required",
            Self::NvmSwitchFailed(_) => "nvm_switch_failed",
            Self::PathWrite { scope: "user", .. } => "user_path_write_failed",
            Self::PathWrite { scope: "machine", .. } => "machine_path_write_failed",
            Self::PathWrite { .. } => "path_write_failed",
            Self::Verification(_) => "verification_failed",
            Self::IntegrationState(_) => "integration_state_failed",
            Self::Rollback(_) => "rollback_failed",
            Self::Unsupported => "unsupported_platform",
        }
    }
}

#[derive(Debug, Clone)]
struct PathSnapshot {
    text: String,
    value_type: RegistryStringType,
}

#[cfg(windows)]
#[derive(Debug, Clone)]
struct RegistryStringType(winreg::enums::RegType);

#[cfg(not(windows))]
#[derive(Debug, Clone)]
struct RegistryStringType;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case")]
enum ElevatedNodeOperation {
    NvmUse {
        schema_version: u32,
        operation_id: String,
        target_version: String,
        runtime_root: Option<String>,
        remove_machine_path_entry: Option<String>,
    },
    MachinePathApply {
        schema_version: u32,
        operation_id: String,
        target_path: String,
        target_version: String,
        previous_machine_path_entry: Option<String>,
    },
}

pub fn system_node_switch_supported() -> bool {
    cfg!(target_os = "windows")
}

#[tauri::command]
pub fn get_system_node_state() -> SystemNodeState {
    detect_system_node_state()
}

#[tauri::command]
pub fn system_node_switch_supported_command() -> bool {
    system_node_switch_supported()
}

pub(crate) fn latest_effective_path() -> String {
    #[cfg(target_os = "windows")]
    {
        return latest_windows_path();
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var("PATH").unwrap_or_default()
    }
}

pub(crate) fn detect_system_node_state() -> SystemNodeState {
    let effective_path = latest_effective_path();
    let paths = find_node_candidates(&effective_path);
    let candidates = paths
        .iter()
        .map(|path| SystemNodeCandidate {
            path: path.to_string_lossy().to_string(),
            version: run_node_version(path).ok().and_then(|raw| normalize_version(&raw)),
        })
        .collect::<Vec<_>>();

    let nvm_symlink = discover_nvm_symlink();
    let nvm_target_path = nvm_symlink
        .as_deref()
        .and_then(|path| fs::canonicalize(path).ok())
        .map(|path| path.to_string_lossy().to_string());
    let first = candidates.first();
    let first_path = first.map(|candidate| candidate.path.clone());
    let path_scope = first_path
        .as_deref()
        .map(|path| classify_path_scope(Path::new(path), nvm_symlink.as_deref()));
    let source = if path_scope.as_deref() == Some("nvm") {
        Some("nvm".to_string())
    } else if first.is_some() {
        Some("unknown".to_string())
    } else {
        None
    };

    SystemNodeState {
        available: first.and_then(|candidate| candidate.version.as_ref()).is_some(),
        version: first.and_then(|candidate| candidate.version.clone()),
        node_path: first_path,
        runtime_id: None,
        source,
        candidates,
        path_scope,
        nvm_symlink,
        nvm_target_path,
    }
}

#[cfg(windows)]
fn latest_windows_path() -> String {
    let machine = read_machine_path().ok().map(|snapshot| snapshot.text).unwrap_or_default();
    let user = read_user_path().ok().map(|snapshot| snapshot.text).unwrap_or_default();
    let raw = join_registry_paths(&machine, &user);
    if raw.is_empty() {
        return env::var("PATH").unwrap_or_default();
    }
    expand_windows_environment(&raw)
}

#[cfg(windows)]
fn discover_nvm_symlink() -> Option<String> {
    registry_environment_value("NVM_SYMLINK")
        .or_else(|| env::var("NVM_SYMLINK").ok())
        .map(|value| expand_windows_environment(&value))
        .filter(|value| !value.trim().is_empty())
}

#[cfg(not(windows))]
fn discover_nvm_symlink() -> Option<String> {
    None
}

fn find_node_candidates(path_value: &str) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    let locator = env::var_os("WINDIR")
        .map(|root| PathBuf::from(root).join("System32").join("where.exe"))
        .filter(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from("where.exe"));
    #[cfg(not(target_os = "windows"))]
    let locator = PathBuf::from("which");

    let mut command = Command::new(locator);
    command.arg("node").env("PATH", path_value);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let Ok(output) = command.output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }

    parse_node_candidate_paths(&String::from_utf8_lossy(&output.stdout), env::current_dir().ok().as_deref())
}

fn parse_node_candidate_paths(output: &str, current_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for line in output.lines() {
        let value = line.trim();
        if value.is_empty() || value.starts_with("INFO:") {
            continue;
        }
        let path = PathBuf::from(value);
        let path = if path.is_absolute() {
            path
        } else if let Some(cwd) = current_dir {
            cwd.join(&path)
        } else {
            path
        };
        let key = normalize_path_string(&path);
        if seen.insert(key) {
            paths.push(path);
        }
    }
    paths
}

fn run_node_version(executable: &Path) -> Result<String, String> {
    let mut command = Command::new(executable);
    command.arg("-v").stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| format!("failed to start node executable: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
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
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn normalize_version(raw: &str) -> Option<String> {
    validate_node_version(raw).ok()
}

fn normalize_path_string(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('/', "\\").to_lowercase();
    while value.starts_with("\\\\?\\") {
        value = value[4..].to_string();
    }
    while value.ends_with('\\') && value.len() > 3 {
        value.pop();
    }
    value
}

fn path_strings_equal(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        normalize_path_string(left) == normalize_path_string(right)
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

#[cfg(windows)]
fn classify_path_scope(executable: &Path, nvm_symlink: Option<&str>) -> String {
    if let Some(symlink) = nvm_symlink {
        let symlink_executable = Path::new(symlink).join("node.exe");
        if path_strings_equal(executable, &symlink_executable) {
            return "nvm".to_string();
        }
    }
    if path_value_contains_executable(&read_machine_path().ok().map(|value| value.text).unwrap_or_default(), executable) {
        return "machine".to_string();
    }
    if path_value_contains_executable(&read_user_path().ok().map(|value| value.text).unwrap_or_default(), executable) {
        return "user".to_string();
    }
    "unknown".to_string()
}

#[cfg(not(windows))]
fn classify_path_scope(_executable: &Path, _nvm_symlink: Option<&str>) -> String {
    "unknown".to_string()
}

#[cfg(windows)]
fn path_value_contains_executable(path_value: &str, executable: &Path) -> bool {
    path_value
        .split(';')
        .filter(|entry| !entry.trim().is_empty())
        .any(|entry| {
            let entry = expand_windows_environment(entry.trim()).trim_matches('"').to_string();
            let path = Path::new(&entry);
            let candidate = if path.extension().is_some() && path_strings_equal(path, executable) {
                path.to_path_buf()
            } else {
                path.join("node.exe")
            };
            path_strings_equal(&candidate, executable)
        })
}

#[cfg(windows)]
fn expand_windows_environment(value: &str) -> String {
    let mut current = value.to_string();
    for _ in 0..16 {
        let Some(start) = current.find('%') else {
            break;
        };
        let Some(relative_end) = current[start + 1..].find('%') else {
            break;
        };
        let end = start + 1 + relative_end;
        let name = &current[start + 1..end];
        if name.is_empty() {
            break;
        }
        let Ok(replacement) = env::var(name) else {
            break;
        };
        current.replace_range(start..=end, &replacement);
    }
    current
}

fn split_path_entries(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    value.split(';').map(ToString::to_string).collect()
}

fn join_path_entries(entries: &[String]) -> String {
    entries.join(";")
}

fn normalize_path_entry(value: &str) -> String {
    let mut normalized = value.trim().trim_matches('"').replace('/', "\\").to_lowercase();
    while normalized.ends_with('\\') && normalized.len() > 3 {
        normalized.pop();
    }
    normalized
}

fn path_entries_equal(left: &str, right: &str) -> bool {
    normalize_path_entry(left) == normalize_path_entry(right)
}

fn remove_owned_path_entry(entries: &mut Vec<String>, owned: Option<&str>) -> bool {
    let Some(owned) = owned else {
        return false;
    };
    let Some(index) = entries.iter().position(|entry| path_entries_equal(entry, owned)) else {
        return false;
    };
    entries.remove(index);
    true
}

fn integrate_path_value(original: &str, owned: Option<&str>, target: &str) -> (String, bool) {
    let mut entries = split_path_entries(original);
    remove_owned_path_entry(&mut entries, owned);
    let existing_index = entries.iter().position(|entry| path_entries_equal(entry, target));
    let already_present = existing_index.is_some();
    if !already_present {
        entries.insert(0, target.to_string());
    } else if existing_index != Some(0) {
        let existing = entries.remove(existing_index.expect("existing target index"));
        entries.insert(0, existing);
    }
    (join_path_entries(&entries), !already_present)
}

fn remove_path_entry_value(original: &str, owned: Option<&str>) -> (String, bool) {
    let mut entries = split_path_entries(original);
    let changed = remove_owned_path_entry(&mut entries, owned);
    (join_path_entries(&entries), changed)
}

fn join_registry_paths(machine: &str, user: &str) -> String {
    match (machine.trim().is_empty(), user.trim().is_empty()) {
        (true, true) => String::new(),
        (true, false) => user.to_string(),
        (false, true) => machine.to_string(),
        (false, false) => format!("{machine};{user}"),
    }
}

fn resolve_target(target: &NodeRuntimeTarget) -> Result<ResolvedTarget, SwitchFailure> {
    if !matches!(target.source.as_str(), "managed" | "nvm" | "custom" | "system") {
        return Err(SwitchFailure::RuntimeUnavailable(format!(
            "Unsupported Node Runtime source: {}",
            target.source
        )));
    }
    let expected = validate_node_version(&target.version)
        .map_err(|error| SwitchFailure::RuntimeUnavailable(error.to_string()))?;
    let raw_path = target.path.trim();
    if raw_path.is_empty() {
        return Err(SwitchFailure::RuntimeUnavailable("Node Runtime path is empty".to_string()));
    }
    let path = PathBuf::from(raw_path);
    let executable = if path.is_file() {
        path.clone()
    } else {
        node_executable(&path).ok_or_else(|| {
            SwitchFailure::RuntimeUnavailable(format!("Node executable was not found: {}", path.display()))
        })?
    };
    let directory = executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| SwitchFailure::RuntimeUnavailable("Node executable has no parent directory".to_string()))?;
    let actual = run_node_version(&executable)
        .map_err(|error| SwitchFailure::RuntimeUnavailable(error.to_string()))
        .and_then(|raw| {
            normalize_version(&raw).ok_or_else(|| {
                SwitchFailure::RuntimeUnavailable(format!("Invalid Node version returned by {}", executable.display()))
            })
        })?;
    if actual != expected {
        return Err(SwitchFailure::RuntimeUnavailable(format!(
            "Node Runtime version mismatch: expected {expected}, actual {actual}"
        )));
    }
    Ok(ResolvedTarget {
        runtime_id: target.runtime_id.clone(),
        version: expected,
        source: target.source.clone(),
        runtime_root: target.runtime_root.clone(),
        directory,
        executable,
    })
}

fn target_is_active(state: &SystemNodeState, target: &ResolvedTarget) -> bool {
    if !state.available || state.version.as_deref() != Some(target.version.as_str()) {
        return false;
    }
    let Some(current_path) = state.node_path.as_deref() else {
        return false;
    };
    let current = Path::new(current_path);
    if target.source == "nvm" {
        if state.path_scope.as_deref() == Some("nvm") {
            if let Some(nvm_target) = state.nvm_target_path.as_deref() {
                if path_strings_equal(Path::new(nvm_target), &target.directory) {
                    return true;
                }
            }
            return path_strings_equal(current, &target.executable);
        }
        return path_strings_equal(current, &target.executable);
    }
    path_strings_equal(current, &target.executable)
}

#[cfg(windows)]
fn nvm_path_target(target: &ResolvedTarget) -> Option<ResolvedTarget> {
    let symlink = discover_nvm_symlink()?;
    let directory = PathBuf::from(&symlink);
    let executable = node_executable(&directory)?;
    let actual = run_node_version(&executable)
        .ok()
        .and_then(|raw| normalize_version(&raw))?;
    if actual != target.version {
        return None;
    }
    Some(ResolvedTarget {
        runtime_id: target.runtime_id.clone(),
        version: target.version.clone(),
        source: "nvm".to_string(),
        runtime_root: target.runtime_root.clone(),
        directory,
        executable,
    })
}

#[cfg(not(windows))]
fn nvm_path_target(_target: &ResolvedTarget) -> Option<ResolvedTarget> {
    None
}

fn result(
    success: bool,
    status: &str,
    previous: SystemNodeState,
    current: SystemNodeState,
    operation: Option<&str>,
    error_code: Option<&str>,
    message: Option<String>,
    conflicting_path: Option<String>,
) -> SystemNodeSwitchResult {
    SystemNodeSwitchResult {
        success,
        status: status.to_string(),
        previous: Some(previous),
        current: Some(current),
        conflicting_path,
        operation: operation.map(ToString::to_string),
        error_code: error_code.map(ToString::to_string),
        message,
    }
}

fn failure_result(
    previous: SystemNodeState,
    operation: Option<&str>,
    failure: &SwitchFailure,
) -> SystemNodeSwitchResult {
    let current = detect_system_node_state();
    let status = if matches!(failure, SwitchFailure::Permission(_)) {
        "elevation-required"
    } else {
        "failed"
    };
    result(
        false,
        status,
        previous,
        current,
        operation,
        Some(failure.error_code()),
        Some(failure.message()),
        None,
    )
}

fn conflict_result(
    previous: SystemNodeState,
    operation: &str,
    target: &ResolvedTarget,
    error_code: &str,
) -> SystemNodeSwitchResult {
    let current = detect_system_node_state();
    let conflict = current.node_path.clone();
    result(
        false,
        "path-conflict",
        previous,
        current,
        Some(operation),
        Some(error_code),
        Some(format!(
            "Windows PATH resolves another Node before {}",
            target.executable.display()
        )),
        conflict,
    )
}

fn read_integration_state(app: &AppHandle) -> Result<SystemNodeIntegrationState, SwitchFailure> {
    let path = crate::app_config_file_path(app, INTEGRATION_FILE)
        .map_err(SwitchFailure::IntegrationState)?;
    if !path.exists() {
        return Ok(SystemNodeIntegrationState::default());
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        SwitchFailure::IntegrationState(format!("failed to read {}: {error}", path.display()))
    })?;
    if content.trim().is_empty() {
        return Ok(SystemNodeIntegrationState::default());
    }
    serde_json::from_str(&content).map_err(|error| {
        SwitchFailure::IntegrationState(format!("invalid integration state: {error}"))
    })
}

fn write_integration_state(
    app: &AppHandle,
    state: &SystemNodeIntegrationState,
) -> Result<(), SwitchFailure> {
    let path = crate::app_config_file_path(app, INTEGRATION_FILE)
        .map_err(SwitchFailure::IntegrationState)?;
    let content = serde_json::to_string_pretty(state)
        .map_err(|error| SwitchFailure::IntegrationState(error.to_string()))?;
    crate::atomic_write_config(&path, &content).map_err(SwitchFailure::IntegrationState)
}

#[cfg(windows)]
fn read_user_path() -> Result<PathSnapshot, String> {
    use winreg::types::FromRegValue;
    let key = match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(USER_ENVIRONMENT_KEY)
    {
        Ok(key) => key,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(PathSnapshot {
                text: String::new(),
                value_type: RegistryStringType(winreg::enums::REG_EXPAND_SZ),
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    match key.get_raw_value("Path") {
        Ok(value) => Ok(PathSnapshot {
            text: String::from_reg_value(&value).map_err(|error| error.to_string())?,
            value_type: RegistryStringType(value.vtype),
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PathSnapshot {
            text: String::new(),
            value_type: RegistryStringType(winreg::enums::REG_EXPAND_SZ),
        }),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(windows)]
fn read_machine_path() -> Result<PathSnapshot, String> {
    read_registry_path(winreg::enums::HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT_KEY)
}

#[cfg(not(windows))]
fn read_user_path() -> Result<PathSnapshot, String> {
    Ok(PathSnapshot {
        text: env::var("PATH").unwrap_or_default(),
        value_type: RegistryStringType,
    })
}

#[cfg(not(windows))]
fn read_machine_path() -> Result<PathSnapshot, String> {
    Ok(PathSnapshot {
        text: String::new(),
        value_type: RegistryStringType,
    })
}

#[cfg(windows)]
const USER_ENVIRONMENT_KEY: &str = "Environment";

#[cfg(windows)]
const MACHINE_ENVIRONMENT_KEY: &str = "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";

#[cfg(windows)]
fn read_registry_path(root: windows_sys::Win32::System::Registry::HKEY, key_name: &str) -> Result<PathSnapshot, String> {
    use winreg::types::FromRegValue;
    let key = winreg::RegKey::predef(root)
        .open_subkey(key_name)
        .map_err(|error| error.to_string())?;
    match key.get_raw_value("Path") {
        Ok(value) => Ok(PathSnapshot {
            text: String::from_reg_value(&value).map_err(|error| error.to_string())?,
            value_type: RegistryStringType(value.vtype),
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PathSnapshot {
            text: String::new(),
            value_type: RegistryStringType(winreg::enums::REG_EXPAND_SZ),
        }),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(windows)]
fn registry_environment_value(name: &str) -> Option<String> {
    use winreg::types::FromRegValue;
    for (root, key_name) in [
        (winreg::enums::HKEY_CURRENT_USER, USER_ENVIRONMENT_KEY),
        (winreg::enums::HKEY_LOCAL_MACHINE, MACHINE_ENVIRONMENT_KEY),
    ] {
        let Ok(key) = winreg::RegKey::predef(root).open_subkey(key_name) else {
            continue;
        };
        let Ok(value) = key.get_raw_value(name) else {
            continue;
        };
        if let Ok(value) = String::from_reg_value(&value) {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    None
}

#[cfg(windows)]
fn write_user_path(snapshot: &PathSnapshot) -> Result<(), io::Error> {
    use winreg::enums::HKEY_CURRENT_USER;
    let key = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(USER_ENVIRONMENT_KEY)?
        .0;
    key.set_raw_value("Path", &registry_path_value(&snapshot.text, &snapshot.value_type.0))
}

#[cfg(windows)]
fn write_machine_path(snapshot: &PathSnapshot) -> Result<(), io::Error> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE};
    let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(MACHINE_ENVIRONMENT_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)?;
    key.set_raw_value("Path", &registry_path_value(&snapshot.text, &snapshot.value_type.0))
}

#[cfg(not(windows))]
fn write_user_path(_snapshot: &PathSnapshot) -> Result<(), io::Error> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "registry PATH is only available on Windows"))
}

#[cfg(not(windows))]
fn write_machine_path(_snapshot: &PathSnapshot) -> Result<(), io::Error> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "registry PATH is only available on Windows"))
}

#[cfg(windows)]
fn registry_path_value(text: &str, value_type: &winreg::enums::RegType) -> winreg::RegValue {
    let mut bytes = Vec::with_capacity((text.encode_utf16().count() + 1) * 2);
    for unit in text.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    winreg::RegValue {
        bytes,
        vtype: value_type.clone(),
    }
}

fn path_snapshot_with_text(snapshot: &PathSnapshot, text: String) -> PathSnapshot {
    PathSnapshot {
        text,
        value_type: snapshot.value_type.clone(),
    }
}

fn broadcast_environment() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };
        let value: Vec<u16> = "Environment".encode_utf16().chain(std::iter::once(0)).collect();
        let mut result = 0_usize;
        unsafe {
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                value.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );
        }
    }
}

fn apply_user_integration(
    state: &SystemNodeIntegrationState,
    target: &ResolvedTarget,
) -> Result<(SystemNodeIntegrationState, PathSnapshot), SwitchFailure> {
    let original = read_user_path().map_err(|detail| SwitchFailure::PathWrite {
        scope: "user",
        detail,
    })?;
    let (next_value, inserted) = integrate_path_value(
        &original.text,
        state.user_path_entry.as_deref(),
        &target.directory.to_string_lossy(),
    );
    if next_value != original.text {
        let next = path_snapshot_with_text(&original, next_value.clone());
        write_user_path(&next).map_err(|error| {
            if is_permission_error(&error) {
                SwitchFailure::Permission(error.to_string())
            } else {
                SwitchFailure::PathWrite {
                    scope: "user",
                    detail: error.to_string(),
                }
            }
        })?;
        broadcast_environment();
    }
    let mut next_state = state.clone();
    next_state.managed_runtime_id = target.runtime_id.clone();
    next_state.user_path_entry = inserted.then(|| target.directory.to_string_lossy().to_string());
    if next_value != original.text {
        next_state.user_path_backup = Some(original.text.clone());
    }
    Ok((next_state, original))
}

fn apply_machine_integration(
    state: &SystemNodeIntegrationState,
    target: &ResolvedTarget,
) -> Result<(SystemNodeIntegrationState, PathSnapshot, bool), SwitchFailure> {
    let original = read_machine_path().map_err(|detail| SwitchFailure::PathWrite {
        scope: "machine",
        detail,
    })?;
    let (next_value, inserted) = integrate_path_value(
        &original.text,
        state.machine_path_entry.as_deref(),
        &target.directory.to_string_lossy(),
    );
    if next_value != original.text {
        let next = path_snapshot_with_text(&original, next_value.clone());
        write_machine_path(&next).map_err(|error| {
            if is_permission_error(&error) {
                SwitchFailure::Permission(error.to_string())
            } else {
                SwitchFailure::PathWrite {
                    scope: "machine",
                    detail: error.to_string(),
                }
            }
        })?;
        broadcast_environment();
    }
    let mut next_state = state.clone();
    next_state.managed_runtime_id = target.runtime_id.clone();
    next_state.machine_path_entry = inserted.then(|| target.directory.to_string_lossy().to_string());
    if next_value != original.text {
        next_state.machine_path_backup = Some(original.text.clone());
    }
    Ok((next_state, original.clone(), next_value != original.text))
}

fn remove_user_integration(
    state: &SystemNodeIntegrationState,
) -> Result<(SystemNodeIntegrationState, PathSnapshot, bool), SwitchFailure> {
    let original = read_user_path().map_err(|detail| SwitchFailure::PathWrite {
        scope: "user",
        detail,
    })?;
    let (next_value, changed) = remove_path_entry_value(&original.text, state.user_path_entry.as_deref());
    if changed {
        let next = path_snapshot_with_text(&original, next_value);
        write_user_path(&next).map_err(|error| {
            if is_permission_error(&error) {
                SwitchFailure::Permission(error.to_string())
            } else {
                SwitchFailure::PathWrite {
                    scope: "user",
                    detail: error.to_string(),
                }
            }
        })?;
        broadcast_environment();
    }
    let mut next_state = state.clone();
    next_state.user_path_entry = None;
    Ok((next_state, original, changed))
}

fn remove_machine_integration(
    state: &SystemNodeIntegrationState,
) -> Result<(SystemNodeIntegrationState, PathSnapshot, bool), SwitchFailure> {
    let original = read_machine_path().map_err(|detail| SwitchFailure::PathWrite {
        scope: "machine",
        detail,
    })?;
    let (next_value, changed) = remove_path_entry_value(&original.text, state.machine_path_entry.as_deref());
    if changed {
        let next = path_snapshot_with_text(&original, next_value);
        write_machine_path(&next).map_err(|error| {
            if is_permission_error(&error) {
                SwitchFailure::Permission(error.to_string())
            } else {
                SwitchFailure::PathWrite {
                    scope: "machine",
                    detail: error.to_string(),
                }
            }
        })?;
        broadcast_environment();
    }
    let mut next_state = state.clone();
    next_state.machine_path_entry = None;
    Ok((next_state, original, changed))
}

fn rollback_path_snapshot(
    user: Option<&PathSnapshot>,
    machine: Option<&PathSnapshot>,
) -> Result<(), SwitchFailure> {
    if let Some(snapshot) = user {
        write_user_path(snapshot).map_err(|error| SwitchFailure::Rollback(error.to_string()))?;
    }
    if let Some(snapshot) = machine {
        write_machine_path(snapshot).map_err(|error| SwitchFailure::Rollback(error.to_string()))?;
    }
    if user.is_some() || machine.is_some() {
        broadcast_environment();
    }
    Ok(())
}

fn switch_nvm(
    app: &AppHandle,
    previous: SystemNodeState,
    target: ResolvedTarget,
    options: &SystemNodeSwitchOptions,
) -> SystemNodeSwitchResult {
    let state = match read_integration_state(app) {
        Ok(state) => state,
        Err(error) => return failure_result(previous, Some("nvm-use"), &error),
    };
    let previous_state = state.clone();
    let (mut working_state, user_backup, _) = match remove_user_integration(&state) {
        Ok(value) => value,
        Err(error) => return failure_result(previous, Some("nvm-use"), &error),
    };

    let machine_entry_exists = state.machine_path_entry.as_deref().is_some_and(|entry| {
        read_machine_path()
            .ok()
            .map(|path| split_path_entries(&path.text).iter().any(|item| path_entries_equal(item, entry)))
            .unwrap_or(false)
    });

    let mut machine_backup: Option<PathSnapshot> = None;
    if machine_entry_exists && !options.elevated {
        match remove_machine_integration(&working_state) {
            Ok((next_state, backup, _)) => {
                working_state = next_state;
                machine_backup = Some(backup);
            }
            Err(SwitchFailure::Permission(_)) => {
                let rollback = rollback_path_snapshot(Some(&user_backup), None);
                let _ = write_integration_state(app, &previous_state);
                if let Err(rollback_error) = rollback {
                    return failure_result(previous, Some("nvm-use"), &rollback_error);
                }
                return result(
                    false,
                    "elevation-required",
                    previous,
                    detect_system_node_state(),
                    Some("nvm-use"),
                    Some("elevation_required"),
                    Some("NVM switch requires administrator permission to remove Project Manager PATH integration".to_string()),
                    None,
                );
            }
            Err(error) => {
                let rollback = rollback_path_snapshot(Some(&user_backup), None);
                let _ = write_integration_state(app, &previous_state);
                if let Err(rollback_error) = rollback {
                    return failure_result(previous, Some("nvm-use"), &rollback_error);
                }
                return failure_result(previous, Some("nvm-use"), &error);
            }
        }
    }

    let nvm_result = if options.elevated {
        let operation = ElevatedNodeOperation::NvmUse {
            schema_version: OPERATION_SCHEMA_VERSION,
            operation_id: operation_id(),
            target_version: target.version.clone(),
            runtime_root: target.runtime_root.clone(),
            remove_machine_path_entry: state.machine_path_entry.clone(),
        };
        match run_elevated_operation(app, &operation) {
            Ok(()) => Ok(()),
            Err(ElevatedFailure::Cancelled) => {
                let _ = rollback_path_snapshot(Some(&user_backup), machine_backup.as_ref());
                let _ = write_integration_state(app, &previous_state);
                return result(
                    false,
                    "cancelled",
                    previous,
                    detect_system_node_state(),
                    Some("nvm-use"),
                    Some("uac_cancelled"),
                    Some("User cancelled the administrator permission request".to_string()),
                    None,
                );
            }
            Err(ElevatedFailure::Operation(failure)) => Err(failure),
        }
    } else {
        run_nvm_use(&target)
    };

    if let Err(error) = nvm_result {
        if matches!(error, SwitchFailure::Permission(_)) && !options.elevated {
            let rollback = rollback_path_snapshot(Some(&user_backup), machine_backup.as_ref());
            let _ = write_integration_state(app, &previous_state);
            if let Err(rollback_error) = rollback {
                return failure_result(previous, Some("nvm-use"), &rollback_error);
            }
            return result(
                false,
                "elevation-required",
                previous,
                detect_system_node_state(),
                Some("nvm-use"),
                Some("elevation_required"),
                Some("切换系统 Node 需要管理员权限".to_string()),
                None,
            );
        }
        let rollback = rollback_path_snapshot(Some(&user_backup), machine_backup.as_ref());
        let _ = write_integration_state(app, &previous_state);
        if let Err(rollback_error) = rollback {
            return failure_result(previous, Some("nvm-use"), &rollback_error);
        }
        return failure_result(previous, Some("nvm-use"), &error);
    }

    working_state.managed_runtime_id = None;
    working_state.user_path_entry = None;
    working_state.machine_path_entry = None;
    if let Err(error) = write_integration_state(app, &working_state) {
        return failure_result(previous, Some("nvm-use"), &error);
    }
    broadcast_environment();

    let current = detect_system_node_state();
    if target_is_active(&current, &target) {
        return result(
            true,
            "switched",
            previous,
            current,
            Some("nvm-use"),
            None,
            None,
            None,
        );
    }

    if options.repair_path_priority {
        if let Some(path_target) = nvm_path_target(&target) {
            return switch_path_runtime(app, previous, path_target, options);
        }
    }
    conflict_result(previous, "nvm-use", &target, "path_conflict")
}

fn switch_path_runtime(
    app: &AppHandle,
    previous: SystemNodeState,
    target: ResolvedTarget,
    options: &SystemNodeSwitchOptions,
) -> SystemNodeSwitchResult {
    let original_state = match read_integration_state(app) {
        Ok(state) => state,
        Err(error) => return failure_result(previous, Some("user-path"), &error),
    };
    let (working_state, user_backup) = match apply_user_integration(&original_state, &target) {
        Ok(value) => value,
        Err(error) => return failure_result(previous, Some("user-path"), &error),
    };
    if let Err(error) = write_integration_state(app, &working_state) {
        let _ = rollback_path_snapshot(Some(&user_backup), None);
        return failure_result(previous, Some("user-path"), &error);
    }

    let current_after_user = detect_system_node_state();
    if target_is_active(&current_after_user, &target) {
        return result(
            true,
            "switched",
            previous,
            current_after_user,
            Some("user-path"),
            None,
            None,
            None,
        );
    }

    if !options.repair_path_priority {
        let rollback = rollback_path_snapshot(Some(&user_backup), None);
        let _ = write_integration_state(app, &original_state);
        if let Err(rollback_error) = rollback {
            return failure_result(previous, Some("user-path"), &rollback_error);
        }
        return conflict_result(previous, "user-path", &target, "machine_path_conflict");
    }

    if !options.elevated {
        let (machine_state, machine_backup, _) = match apply_machine_integration(&working_state, &target) {
            Ok(value) => value,
            Err(SwitchFailure::Permission(_)) => {
                return result(
                    false,
                    "elevation-required",
                    previous,
                    current_after_user.clone(),
                    Some("machine-path"),
                    Some("elevation_required"),
                    Some("修改系统 PATH 优先级需要管理员权限".to_string()),
                    current_after_user.node_path,
                );
            }
            Err(error) => {
                let rollback = rollback_path_snapshot(Some(&user_backup), None);
                let _ = write_integration_state(app, &original_state);
                if let Err(rollback_error) = rollback {
                    return failure_result(previous, Some("machine-path"), &rollback_error);
                }
                return failure_result(previous, Some("machine-path"), &error);
            }
        };
        return finish_machine_path_switch(
            app,
            previous,
            target,
            original_state,
            working_state,
            user_backup,
            machine_state,
            machine_backup,
        );
    }

    let machine_backup = match read_machine_path() {
        Ok(value) => value,
        Err(error) => {
            let failure = SwitchFailure::PathWrite {
                scope: "machine",
                detail: error,
            };
            let rollback = rollback_path_snapshot(Some(&user_backup), None);
            let _ = write_integration_state(app, &original_state);
            if let Err(rollback_error) = rollback {
                return failure_result(previous, Some("machine-path"), &rollback_error);
            }
            return failure_result(previous, Some("machine-path"), &failure);
        }
    };
    let operation = ElevatedNodeOperation::MachinePathApply {
        schema_version: OPERATION_SCHEMA_VERSION,
        operation_id: operation_id(),
        target_path: target.directory.to_string_lossy().to_string(),
        target_version: target.version.clone(),
        previous_machine_path_entry: working_state.machine_path_entry.clone(),
    };
    match run_elevated_operation(app, &operation) {
        Ok(()) => {
            let (machine_path_after, machine_entry_inserted) = integrate_path_value(
                &machine_backup.text,
                working_state.machine_path_entry.as_deref(),
                &target.directory.to_string_lossy(),
            );
            let mut machine_state = working_state.clone();
            machine_state.machine_path_entry = machine_entry_inserted.then(|| target.directory.to_string_lossy().to_string());
            if machine_path_after != machine_backup.text {
                machine_state.machine_path_backup = Some(machine_backup.text.clone());
            }
            finish_machine_path_switch(
                app,
                previous,
                target,
                original_state,
                working_state,
                user_backup,
                machine_state,
                machine_backup,
            )
        }
        Err(ElevatedFailure::Cancelled) => {
            let rollback = rollback_path_snapshot(Some(&user_backup), None);
            let _ = write_integration_state(app, &original_state);
            if let Err(rollback_error) = rollback {
                return failure_result(previous, Some("machine-path"), &rollback_error);
            }
            result(
                false,
                "cancelled",
                previous,
                current_after_user.clone(),
                Some("machine-path"),
                Some("uac_cancelled"),
                Some("User cancelled the administrator permission request".to_string()),
                current_after_user.node_path,
            )
        }
        Err(ElevatedFailure::Operation(error)) => {
            let rollback = rollback_path_snapshot(Some(&user_backup), None);
            let _ = write_integration_state(app, &original_state);
            if let Err(rollback_error) = rollback {
                return failure_result(previous, Some("machine-path"), &rollback_error);
            }
            failure_result(previous, Some("machine-path"), &error)
        }
    }
}

fn finish_machine_path_switch(
    app: &AppHandle,
    previous: SystemNodeState,
    target: ResolvedTarget,
    original_state: SystemNodeIntegrationState,
    working_state: SystemNodeIntegrationState,
    user_backup: PathSnapshot,
    machine_state: SystemNodeIntegrationState,
    machine_backup: PathSnapshot,
) -> SystemNodeSwitchResult {
    let user_after_machine = match read_user_path() {
        Ok(value) => value,
        Err(error) => {
            let rollback = rollback_path_snapshot(Some(&user_backup), Some(&machine_backup));
            let _ = write_integration_state(app, &original_state);
            if let Err(rollback_error) = rollback {
                return failure_result(previous, Some("machine-path"), &rollback_error);
            }
            return failure_result(
                previous,
                Some("machine-path"),
                &SwitchFailure::PathWrite {
                    scope: "user",
                    detail: error,
                },
            );
        }
    };
    let (user_value, user_changed) = remove_path_entry_value(
        &user_after_machine.text,
        working_state.user_path_entry.as_deref(),
    );
    if user_changed {
        let next = path_snapshot_with_text(&user_after_machine, user_value);
        if let Err(error) = write_user_path(&next) {
            let rollback = rollback_path_snapshot(Some(&user_backup), Some(&machine_backup));
            let _ = write_integration_state(app, &original_state);
            if let Err(rollback_error) = rollback {
                return failure_result(previous, Some("machine-path"), &rollback_error);
            }
            return failure_result(
                previous,
                Some("machine-path"),
                &SwitchFailure::PathWrite {
                    scope: "user",
                    detail: error.to_string(),
                },
            );
        }
        broadcast_environment();
    }

    let mut final_state = machine_state;
    final_state.user_path_entry = None;
    final_state.managed_runtime_id = target.runtime_id.clone();
    if let Err(error) = write_integration_state(app, &final_state) {
        let rollback = rollback_path_snapshot(Some(&user_backup), Some(&machine_backup));
        let _ = write_integration_state(app, &original_state);
        if let Err(rollback_error) = rollback {
            return failure_result(previous, Some("machine-path"), &rollback_error);
        }
        return failure_result(previous, Some("machine-path"), &error);
    }

    let current = detect_system_node_state();
    if target_is_active(&current, &target) {
        return result(
            true,
            "switched",
            previous,
            current,
            Some("machine-path"),
            None,
            None,
            None,
        );
    }

    let rollback = rollback_path_snapshot(Some(&user_backup), Some(&machine_backup));
    let _ = write_integration_state(app, &original_state);
    if let Err(error) = rollback {
        return failure_result(previous, Some("machine-path"), &error);
    }
    result(
        false,
        "failed",
        previous,
        detect_system_node_state(),
        Some("machine-path"),
        Some("verification_failed"),
        Some(format!("System Node verification failed for {}", target.executable.display())),
        None,
    )
}

#[tauri::command]
pub fn switch_system_node(
    app: AppHandle,
    runtime: NodeRuntimeTarget,
    options: Option<SystemNodeSwitchOptions>,
) -> SystemNodeSwitchResult {
    let previous = detect_system_node_state();
    let options = options.unwrap_or_default();
    if !system_node_switch_supported() {
        return failure_result(previous, None, &SwitchFailure::Unsupported);
    }
    let target = match resolve_target(&runtime) {
        Ok(target) => target,
        Err(error) => return failure_result(previous, None, &error),
    };
    if target.source == "system" {
        if target_is_active(&previous, &target) {
            return result(
                true,
                "already-active",
                previous.clone(),
                previous,
                None,
                None,
                Some("System Node is already active".to_string()),
                None,
            );
        }
        return failure_result(
            previous,
            None,
            &SwitchFailure::RuntimeUnavailable("The selected System runtime is not the current OS Node".to_string()),
        );
    }
    if target_is_active(&previous, &target) {
        return result(
            true,
            "already-active",
            previous.clone(),
            previous,
            Some(if target.source == "nvm" { "nvm-use" } else { "user-path" }),
            None,
            Some("System Node is already active".to_string()),
            None,
        );
    }
    if target.source == "nvm" {
        switch_nvm(&app, previous, target, &options)
    } else {
        switch_path_runtime(&app, previous, target, &options)
    }
}

fn run_nvm_use(target: &ResolvedTarget) -> Result<(), SwitchFailure> {
    #[cfg(not(windows))]
    {
        let _ = target;
        return Err(SwitchFailure::Unsupported);
    }

    #[cfg(windows)]
    {
        let Some(nvm_executable) = find_nvm_executable(target.runtime_root.as_deref()) else {
            return Err(SwitchFailure::NvmNotFound);
        };
        let version = target.version.trim_start_matches(['v', 'V']);
        let mut command = Command::new(nvm_executable);
        command.args(["use", version]).stdout(Stdio::piped()).stderr(Stdio::piped());
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command.output().map_err(|error| {
            if is_permission_error(&error) {
                SwitchFailure::Permission(error.to_string())
            } else {
                SwitchFailure::NvmSwitchFailed(error.to_string())
            }
        })?;
        if output.status.success() {
            return Ok(());
        }
        let detail = format_command_failure(&output);
        if output_looks_permission(&detail) {
            Err(SwitchFailure::Permission(detail))
        } else {
            Err(SwitchFailure::NvmSwitchFailed(detail))
        }
    }
}

#[cfg(windows)]
fn find_nvm_executable(runtime_root: Option<&str>) -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(root) = runtime_root {
        roots.push(PathBuf::from(root));
    }
    if let Some(root) = registry_environment_value("NVM_HOME").or_else(|| env::var("NVM_HOME").ok()) {
        roots.push(PathBuf::from(expand_windows_environment(&root)));
    }
    if let Some(root) = env::var_os("APPDATA") {
        roots.push(PathBuf::from(root).join("nvm"));
    }
    if let Some(root) = env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(root).join("nvm"));
    }
    let mut seen = HashSet::new();
    for root in roots {
        let candidate = if root.is_file() {
            root
        } else {
            root.join("nvm.exe")
        };
        let key = normalize_path_string(&candidate);
        if seen.insert(key) && candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn format_command_failure(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    format!("process exited with {}", output.status)
}

fn is_permission_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || error.raw_os_error() == Some(5)
        || output_looks_permission(&error.to_string())
}

fn output_looks_permission(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.contains("access is denied")
        || lower.contains("access denied")
        || lower.contains("permission denied")
        || lower.contains("os error 5")
        || lower.contains("symlink") && lower.contains("permission")
}

fn operation_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{}-{}", std::process::id(), nanos)
}

fn operation_id_of(operation: &ElevatedNodeOperation) -> &str {
    match operation {
        ElevatedNodeOperation::NvmUse { operation_id, .. }
        | ElevatedNodeOperation::MachinePathApply { operation_id, .. } => operation_id,
    }
}

#[derive(Debug)]
enum ElevatedFailure {
    Cancelled,
    Operation(SwitchFailure),
}

fn operation_path(app: &AppHandle, operation: &ElevatedNodeOperation) -> Result<PathBuf, SwitchFailure> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| SwitchFailure::IntegrationState(error.to_string()))?
        .join("tmp")
        .join(OPERATION_DIRECTORY);
    fs::create_dir_all(&directory)
        .map_err(|error| SwitchFailure::IntegrationState(error.to_string()))?;
    let path = directory.join(format!("node-operation-{}.json", operation_id_of(operation)));
    let content = serde_json::to_string(operation)
        .map_err(|error| SwitchFailure::IntegrationState(error.to_string()))?;
    crate::atomic_write_config(&path, &content).map_err(SwitchFailure::IntegrationState)?;
    Ok(path)
}

fn run_elevated_operation(
    app: &AppHandle,
    operation: &ElevatedNodeOperation,
) -> Result<(), ElevatedFailure> {
    let path = operation_path(app, operation).map_err(ElevatedFailure::Operation)?;
    #[cfg(not(windows))]
    {
        let _ = fs::remove_file(path);
        return Err(ElevatedFailure::Operation(SwitchFailure::Unsupported));
    }

    #[cfg(windows)]
    {
        let outcome = launch_elevated_helper(&path);
        let _ = fs::remove_file(&path);
        outcome
    }
}

#[cfg(windows)]
fn launch_elevated_helper(operation_path: &Path) -> Result<(), ElevatedFailure> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_CANCELLED};
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_NOCLOSEPROCESS};

    let executable = env::current_exe().map_err(|error| ElevatedFailure::Operation(SwitchFailure::IntegrationState(error.to_string())))?;
    let parent = executable.parent().unwrap_or_else(|| Path::new("."));
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();
    let file: Vec<u16> = executable.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let parameters_string = format!("{} \"{}\"", OPERATION_ARGUMENT, operation_path.to_string_lossy());
    let parameters: Vec<u16> = parameters_string.encode_utf16().chain(std::iter::once(0)).collect();
    let directory: Vec<u16> = parent.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();

    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.lpDirectory = directory.as_ptr();
    info.nShow = 0;
    let launched = unsafe { ShellExecuteExW(&mut info) };
    if launched == 0 {
        let error = unsafe { GetLastError() };
        if error == ERROR_CANCELLED {
            return Err(ElevatedFailure::Cancelled);
        }
        return Err(ElevatedFailure::Operation(SwitchFailure::Permission(format!(
            "ShellExecuteExW failed with Windows error {error}"
        ))));
    }
    if info.hProcess.is_null() {
        return Err(ElevatedFailure::Operation(SwitchFailure::Verification(
            "Elevated helper did not return a process handle".to_string(),
        )));
    }
    unsafe {
        WaitForSingleObject(info.hProcess, INFINITE);
    }
    let mut exit_code = 1_u32;
    let exit_read = unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) };
    unsafe {
        CloseHandle(info.hProcess);
    }
    if exit_read == 0 {
        return Err(ElevatedFailure::Operation(SwitchFailure::Verification(
            "Failed to read elevated helper exit code".to_string(),
        )));
    }
    match exit_code {
        0 => Ok(()),
        10 => Err(ElevatedFailure::Operation(SwitchFailure::Verification("Invalid elevated operation".to_string()))),
        11 => Err(ElevatedFailure::Operation(SwitchFailure::NvmNotFound)),
        12 => Err(ElevatedFailure::Operation(SwitchFailure::Permission("Elevated operation was denied".to_string()))),
        13 => Err(ElevatedFailure::Operation(SwitchFailure::NvmSwitchFailed("Elevated NVM switch failed".to_string()))),
        14 => Err(ElevatedFailure::Operation(SwitchFailure::PathWrite { scope: "machine", detail: "Elevated Machine PATH write failed".to_string() })),
        15 => Err(ElevatedFailure::Operation(SwitchFailure::Rollback("Elevated PATH rollback failed".to_string()))),
        _ => Err(ElevatedFailure::Operation(SwitchFailure::Verification(format!(
            "Elevated helper exited with code {exit_code}"
        )))),
    }
}

pub fn run_elevated_node_operation(path: &str) -> i32 {
    #[cfg(not(windows))]
    {
        let _ = path;
        return 10;
    }

    #[cfg(windows)]
    {
        match execute_elevated_operation(Path::new(path)) {
            Ok(()) => 0,
            Err(SwitchFailure::NvmNotFound) => 11,
            Err(SwitchFailure::Permission(_)) => 12,
            Err(SwitchFailure::NvmSwitchFailed(_)) => 13,
            Err(SwitchFailure::PathWrite { .. }) => 14,
            Err(SwitchFailure::Rollback(_)) => 15,
            Err(error) => {
                eprintln!("{error:?}");
                16
            }
        }
    }
}

#[cfg(windows)]
fn execute_elevated_operation(path: &Path) -> Result<(), SwitchFailure> {
    let file_name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
    let Some(file_id) = file_name
        .strip_prefix("node-operation-")
        .and_then(|value| value.strip_suffix(".json"))
    else {
        return Err(SwitchFailure::Verification("Invalid elevated operation file location".to_string()));
    };
    if file_id.is_empty() || !file_id.chars().all(|value| value.is_ascii_digit() || value == '-') {
        return Err(SwitchFailure::Verification("Invalid elevated operation file name".to_string()));
    }
    let canonical_path = fs::canonicalize(path)
        .map_err(|error| SwitchFailure::Verification(error.to_string()))?;
    let canonical_parent = canonical_path
        .parent()
        .ok_or_else(|| SwitchFailure::Verification("Invalid elevated operation parent".to_string()))?;
    let expected_parent = expected_operation_directory()
        .ok_or_else(|| SwitchFailure::Verification("Application data directory is unavailable".to_string()))?;
    let expected_parent = fs::canonicalize(expected_parent)
        .map_err(|error| SwitchFailure::Verification(error.to_string()))?;
    if !path_strings_equal(canonical_parent, &expected_parent) {
        return Err(SwitchFailure::Verification("Invalid elevated operation file location".to_string()));
    }
    let content = fs::read_to_string(path).map_err(|error| SwitchFailure::Verification(error.to_string()))?;
    let operation: ElevatedNodeOperation = serde_json::from_str(&content)
        .map_err(|error| SwitchFailure::Verification(format!("Invalid elevated operation: {error}")))?;
    if operation_id_of(&operation) != file_id {
        return Err(SwitchFailure::Verification("Elevated operation ID does not match its file name".to_string()));
    }
    match operation {
        ElevatedNodeOperation::NvmUse {
            schema_version,
            operation_id,
            target_version,
            runtime_root,
            remove_machine_path_entry,
        } => {
            validate_operation_metadata(schema_version, &operation_id)?;
            let target_version = validate_node_version(&target_version)
                .map_err(|error| SwitchFailure::RuntimeUnavailable(error.to_string()))?;
            let target = ResolvedTarget {
                runtime_id: None,
                version: target_version,
                source: "nvm".to_string(),
                runtime_root,
                directory: PathBuf::new(),
                executable: PathBuf::new(),
            };
            let machine_backup = if remove_machine_path_entry.is_some() {
                Some(read_machine_path().map_err(|error| SwitchFailure::PathWrite {
                    scope: "machine",
                    detail: error,
                })?)
            } else {
                None
            };
            if let Some(entry) = remove_machine_path_entry {
                let Some(snapshot) = machine_backup.as_ref() else {
                    return Err(SwitchFailure::Verification(
                        "Missing Machine PATH backup for elevated NVM operation".to_string(),
                    ));
                };
                let (next, changed) = remove_path_entry_value(&snapshot.text, Some(&entry));
                if changed {
                    write_machine_path(&path_snapshot_with_text(&snapshot, next))
                        .map_err(|error| SwitchFailure::PathWrite { scope: "machine", detail: error.to_string() })?;
                    broadcast_environment();
                }
            }
            let result = run_nvm_use(&target);
            if result.is_err() {
                if let Some(snapshot) = machine_backup.as_ref() {
                    rollback_path_snapshot(None, Some(snapshot))?;
                }
            }
            result
        }
        ElevatedNodeOperation::MachinePathApply {
            schema_version,
            operation_id,
            target_path,
            target_version,
            previous_machine_path_entry,
        } => {
            validate_operation_metadata(schema_version, &operation_id)?;
            let expected = validate_node_version(&target_version)
                .map_err(|error| SwitchFailure::RuntimeUnavailable(error.to_string()))?;
            let directory = PathBuf::from(target_path);
            let executable = node_executable(&directory).ok_or_else(|| {
                SwitchFailure::RuntimeUnavailable("Elevated target Node executable was not found".to_string())
            })?;
            let actual = run_node_version(&executable)
                .map_err(SwitchFailure::RuntimeUnavailable)
                .and_then(|raw| normalize_version(&raw).ok_or_else(|| SwitchFailure::RuntimeUnavailable("Invalid target Node version".to_string())))?;
            if actual != expected {
                return Err(SwitchFailure::RuntimeUnavailable("Elevated target Node version mismatch".to_string()));
            }
            let snapshot = read_machine_path().map_err(|error| SwitchFailure::PathWrite { scope: "machine", detail: error })?;
            let (next, _) = integrate_path_value(&snapshot.text, previous_machine_path_entry.as_deref(), &directory.to_string_lossy());
            if next != snapshot.text {
                write_machine_path(&path_snapshot_with_text(&snapshot, next))
                    .map_err(|error| SwitchFailure::PathWrite { scope: "machine", detail: error.to_string() })?;
                broadcast_environment();
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
fn expected_operation_directory() -> Option<PathBuf> {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|root| root.join(APP_DATA_DIRECTORY_IDENTIFIER).join("tmp").join(OPERATION_DIRECTORY))
}

#[cfg(windows)]
fn validate_operation_metadata(schema_version: u32, operation_id: &str) -> Result<(), SwitchFailure> {
    if schema_version != OPERATION_SCHEMA_VERSION
        || operation_id.trim().is_empty()
        || operation_id.len() > 128
        || !operation_id.chars().all(|value| value.is_ascii_digit() || value == '-')
    {
        return Err(SwitchFailure::Verification("Invalid elevated operation metadata".to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_integration_preserves_unknown_entries_and_order() {
        let (value, inserted) = integrate_path_value(
            "%USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd;D:\\nvm\\nodejs;C:\\Custom Tool",
            None,
            "D:\\managed\\v24.20.0",
        );
        assert!(inserted);
        assert_eq!(
            value,
            "D:\\managed\\v24.20.0;%USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd;D:\\nvm\\nodejs;C:\\Custom Tool"
        );
    }

    #[test]
    fn path_integration_removes_only_previous_owned_entry() {
        let (value, inserted) = integrate_path_value(
            "C:\\old-pm;C:\\other-node;C:\\tool",
            Some("C:\\old-pm"),
            "D:\\new-pm",
        );
        assert!(inserted);
        assert_eq!(value, "D:\\new-pm;C:\\other-node;C:\\tool");
    }

    #[test]
    fn path_integration_does_not_duplicate_existing_target() {
        let (value, inserted) = integrate_path_value(
            "D:\\new-pm;C:\\tool",
            None,
            "d:/NEW-PM/",
        );
        assert!(!inserted);
        assert_eq!(value, "D:\\new-pm;C:\\tool");
    }

    #[test]
    fn path_integration_promotes_existing_target_without_duplicating_it() {
        let (value, inserted) = integrate_path_value(
            "C:\\other-node;D:\\target;C:\\tool",
            None,
            "d:/TARGET/",
        );
        assert!(!inserted);
        assert_eq!(value, "D:\\target;C:\\other-node;C:\\tool");
    }

    #[test]
    fn path_entry_removal_keeps_other_node_entries() {
        let (value, changed) = remove_path_entry_value(
            "C:\\pm-owned;C:\\Program Files\\nodejs;D:\\nvm\\nodejs",
            Some("c:/PM-OWNED/"),
        );
        assert!(changed);
        assert_eq!(value, "C:\\Program Files\\nodejs;D:\\nvm\\nodejs");
    }

    #[test]
    fn registry_paths_use_machine_then_user_order() {
        assert_eq!(join_registry_paths("MACHINE", "USER"), "MACHINE;USER");
        assert_eq!(join_registry_paths("", "USER"), "USER");
    }

    #[test]
    fn nvm_same_version_without_target_resolution_is_not_assumed_active() {
        let state = SystemNodeState {
            available: true,
            version: Some("v20.19.1".to_string()),
            node_path: Some("D:\\node\\node.exe".to_string()),
            runtime_id: None,
            source: Some("nvm".to_string()),
            candidates: Vec::new(),
            path_scope: Some("nvm".to_string()),
            nvm_symlink: Some("D:\\node".to_string()),
            nvm_target_path: None,
        };
        let target = ResolvedTarget {
            runtime_id: Some("nvm:d:/nvm/v20.19.1".to_string()),
            version: "v20.19.1".to_string(),
            source: "nvm".to_string(),
            runtime_root: Some("D:\\nvm\\nvm".to_string()),
            directory: PathBuf::from("D:\\nvm\\nvm\\v20.19.1"),
            executable: PathBuf::from("D:\\nvm\\nvm\\v20.19.1\\node.exe"),
        };
        assert!(!target_is_active(&state, &target));
    }

    #[cfg(windows)]
    #[test]
    fn where_output_keeps_first_candidate_and_deduplicates() {
        let paths = parse_node_candidate_paths(
            "D:\\node\\node.exe\r\nC:\\Program Files\\nodejs\\node.exe\r\nD:\\node\\node.exe\r\nINFO: Could not find files",
            Some(Path::new("C:\\workspace")),
        );
        assert_eq!(paths.len(), 2);
        assert_eq!(normalize_path_string(&paths[0]), "d:\\node\\node.exe");
        assert_eq!(normalize_path_string(&paths[1]), "c:\\program files\\nodejs\\node.exe");
        assert_eq!(normalize_version("v20.19.1"), Some("v20.19.1".to_string()));
    }
}
