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
const OPERATION_SCHEMA_VERSION: u32 = 2;
const OPERATION_ARGUMENT: &str = "--elevated-node-operation";
#[cfg(windows)]
const ELEVATED_OPERATION_TIMEOUT_MS: u32 = 45_000;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNodeCandidate {
    pub path: String,
    pub version: Option<String>,
    pub canonical_path: Option<String>,
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
    pub canonical_node_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    /// Kept for API compatibility. Elevated Controller operations repair priority internally.
    #[serde(default)]
    #[allow(dead_code)]
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
    controller_mode: Option<String>,
    controller_link_path: Option<String>,
    previous_target: Option<String>,
    managed_path_entry: Option<String>,
    /// Legacy R2.2 entries. They are only used for one-time safe cleanup.
    user_path_entry: Option<String>,
    machine_path_entry: Option<String>,
    user_path_backup: Option<String>,
    machine_path_backup: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SystemNodeControllerKind {
    ExistingNodeLink,
    ProjectManagerLink,
}

#[derive(Debug, Clone)]
struct SystemNodeController {
    link_path: PathBuf,
    kind: SystemNodeControllerKind,
}

#[derive(Debug, Clone)]
struct ResolvedTarget {
    runtime_id: Option<String>,
    version: String,
    source: String,
    directory: PathBuf,
    executable: PathBuf,
}

#[derive(Debug, Clone)]
struct LinkSnapshot {
    existed: bool,
    target: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct PathIntegrationResult {
    state: SystemNodeIntegrationState,
    user_backup: Option<PathSnapshot>,
    machine_backup: Option<PathSnapshot>,
}

#[derive(Debug, Clone)]
enum SwitchFailure {
    RuntimeUnavailable(String),
    Permission(String),
    Controller(String),
    PathWrite { scope: &'static str, detail: String },
    MachinePathConflict(String),
    Verification(String),
    IntegrationState(String),
    Rollback(String),
    ElevatedOperationTimeout(String),
    Unsupported,
}

impl SwitchFailure {
    fn message(&self) -> String {
        match self {
            Self::RuntimeUnavailable(detail)
            | Self::Permission(detail)
            | Self::Controller(detail)
            | Self::MachinePathConflict(detail)
            | Self::Verification(detail)
            | Self::IntegrationState(detail)
            | Self::Rollback(detail)
            | Self::ElevatedOperationTimeout(detail) => detail.clone(),
            Self::PathWrite { scope, detail } => format!("Failed to write {scope} PATH: {detail}"),
            Self::Unsupported => {
                "System Node switching is only supported on Windows desktop".to_string()
            }
        }
    }

    fn error_code(&self) -> &'static str {
        match self {
            Self::RuntimeUnavailable(_) => "runtime_unavailable",
            Self::Permission(_) => "elevation_required",
            Self::Controller(_) => "controller_link_failed",
            Self::MachinePathConflict(_) => "machine_path_conflict",
            Self::PathWrite { scope: "user", .. } => "user_path_write_failed",
            Self::PathWrite {
                scope: "machine", ..
            } => "machine_path_write_failed",
            Self::PathWrite { .. } => "path_write_failed",
            Self::Verification(_) => "verification_failed",
            Self::IntegrationState(_) => "integration_state_failed",
            Self::Rollback(_) => "rollback_failed",
            Self::ElevatedOperationTimeout(_) => "elevated_operation_timeout",
            Self::Unsupported => "unsupported_platform",
        }
    }

    fn requires_elevation(&self) -> bool {
        matches!(self, Self::Permission(_) | Self::MachinePathConflict(_))
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

/// Fixed, non-shell operation schema for the one-shot elevated helper.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "kebab-case")]
enum ElevatedNodeOperation {
    Switch {
        schema_version: u32,
        operation_id: String,
        target_runtime_id: Option<String>,
        target_version: String,
        target_path: String,
        target_source: String,
        target_runtime_root: Option<String>,
    },
}

pub fn system_node_switch_supported() -> bool {
    cfg!(target_os = "windows")
}

fn unavailable_system_node_state() -> SystemNodeState {
    SystemNodeState {
        available: false,
        version: None,
        node_path: None,
        runtime_id: None,
        source: Some("unknown".to_string()),
        candidates: Vec::new(),
        path_scope: Some("unknown".to_string()),
        nvm_symlink: None,
        nvm_target_path: None,
        canonical_node_path: None,
    }
}

#[tauri::command]
pub async fn get_system_node_state() -> SystemNodeState {
    match tauri::async_runtime::spawn_blocking(detect_system_node_state).await {
        Ok(state) => state,
        Err(error) => {
            eprintln!("System Node detection worker failed: {error}");
            unavailable_system_node_state()
        }
    }
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
            version: run_node_version(path)
                .ok()
                .and_then(|raw| normalize_version(&raw)),
            canonical_path: canonicalize_for_compare(path)
                .map(|value| value.to_string_lossy().to_string()),
        })
        .collect::<Vec<_>>();

    let nvm_symlink = discover_nvm_symlink();
    let nvm_target_path = nvm_symlink
        .as_deref()
        .and_then(|path| canonicalize_for_compare(Path::new(path)))
        .map(|path| path.to_string_lossy().to_string());
    let first = candidates.first();
    let first_path = first.map(|candidate| candidate.path.clone());
    let canonical_node_path = first.and_then(|candidate| candidate.canonical_path.clone());
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
        available: first
            .and_then(|candidate| candidate.version.as_ref())
            .is_some(),
        version: first.and_then(|candidate| candidate.version.clone()),
        node_path: first_path,
        runtime_id: None,
        source,
        candidates,
        path_scope,
        nvm_symlink,
        nvm_target_path,
        canonical_node_path,
    }
}

#[cfg(windows)]
fn latest_windows_path() -> String {
    let machine = read_machine_path()
        .ok()
        .map(|snapshot| snapshot.text)
        .unwrap_or_default();
    let user = read_user_path()
        .ok()
        .map(|snapshot| snapshot.text)
        .unwrap_or_default();
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

    parse_node_candidate_paths(
        &String::from_utf8_lossy(&output.stdout),
        env::current_dir().ok().as_deref(),
    )
}

#[cfg(windows)]
fn resolve_node_candidate_for_path_entry(entry: &str) -> Option<PathBuf> {
    let expanded = expand_windows_environment(entry.trim().trim_matches('"'));
    if expanded.is_empty() {
        return None;
    }
    let expected = Path::new(&expanded).join("node.exe");
    find_node_candidates(&expanded)
        .into_iter()
        .find(|candidate| path_strings_equal(candidate, &expected))
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
    command
        .arg("-v")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start node executable: {error}"))?;
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

fn canonicalize_for_compare(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok().map(|value| {
        let mut normalized = value;
        #[cfg(windows)]
        {
            if let Ok(stripped) = normalized.strip_prefix(r"\\?\") {
                normalized = stripped.to_path_buf();
            }
        }
        normalized
    })
}

fn path_strings_equal(left: &Path, right: &Path) -> bool {
    match (
        canonicalize_for_compare(left),
        canonicalize_for_compare(right),
    ) {
        (Some(left), Some(right)) => normalize_path_string(&left) == normalize_path_string(&right),
        _ => normalize_path_string(left) == normalize_path_string(right),
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
    if path_value_contains_executable(
        &read_machine_path()
            .ok()
            .map(|value| value.text)
            .unwrap_or_default(),
        executable,
    ) {
        return "machine".to_string();
    }
    if path_value_contains_executable(
        &read_user_path()
            .ok()
            .map(|value| value.text)
            .unwrap_or_default(),
        executable,
    ) {
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
            let entry = expand_windows_environment(entry.trim())
                .trim_matches('"')
                .to_string();
            let path = Path::new(&entry);
            let candidate = if path.extension().is_some() && path_strings_equal(path, executable) {
                path.to_path_buf()
            } else {
                path.join("node.exe")
            };
            path_strings_equal(&candidate, executable)
        })
}

#[cfg(not(windows))]
fn path_value_contains_executable(_path_value: &str, _executable: &Path) -> bool {
    false
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
    let mut normalized = value
        .trim()
        .trim_matches('"')
        .replace('/', "\\")
        .to_lowercase();
    while normalized.ends_with('\\') && normalized.len() > 3 {
        normalized.pop();
    }
    normalized
}

fn path_entries_equal(left: &str, right: &str) -> bool {
    normalize_path_entry(left) == normalize_path_entry(right)
}

fn find_machine_path_node_before_controller<F>(
    machine_path: &str,
    controller_entry: &str,
    mut resolve_node: F,
) -> Option<PathBuf>
where
    F: FnMut(&str) -> Option<PathBuf>,
{
    // Only an actual Node candidate before the controller can shadow it.
    let entries = split_path_entries(machine_path);
    let limit = entries
        .iter()
        .position(|entry| path_entries_equal(entry, controller_entry))
        .unwrap_or(entries.len());

    for entry in entries.into_iter().take(limit) {
        let entry = entry.trim();
        if !entry.is_empty() {
            if let Some(candidate) = resolve_node(entry) {
                return Some(candidate);
            }
        }
    }
    None
}

fn remove_owned_path_entries(entries: &mut Vec<String>, owned: &[Option<&str>]) -> bool {
    let before = entries.len();
    entries.retain(|entry| {
        !owned
            .iter()
            .flatten()
            .any(|value| path_entries_equal(entry, value))
    });
    entries.len() != before
}

fn integrate_path_value_with_owned(
    original: &str,
    owned: &[Option<&str>],
    target: &str,
) -> (String, bool, bool) {
    let mut entries = split_path_entries(original);
    let removed = remove_owned_path_entries(&mut entries, owned);
    let existing_index = entries
        .iter()
        .position(|entry| path_entries_equal(entry, target));
    let already_present = existing_index.is_some();
    if !already_present {
        entries.insert(0, target.to_string());
    } else if existing_index != Some(0) {
        let existing = entries.remove(existing_index.expect("existing target index"));
        entries.insert(0, existing);
    }
    let value = join_path_entries(&entries);
    (
        value.clone(),
        value != original,
        removed || !already_present,
    )
}

#[cfg(test)]
fn integrate_path_value(original: &str, owned: Option<&str>, target: &str) -> (String, bool) {
    let (value, changed, _) = integrate_path_value_with_owned(original, &[owned], target);
    (value, changed)
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
    if !matches!(
        target.source.as_str(),
        "managed" | "nvm" | "custom" | "system"
    ) {
        return Err(SwitchFailure::RuntimeUnavailable(format!(
            "Unsupported Node Runtime source: {}",
            target.source
        )));
    }
    let expected =
        validate_node_version(&target.version).map_err(SwitchFailure::RuntimeUnavailable)?;
    let raw_path = target.path.trim();
    if raw_path.is_empty() {
        return Err(SwitchFailure::RuntimeUnavailable(
            "Node Runtime path is empty".to_string(),
        ));
    }
    let path = PathBuf::from(raw_path);
    let executable = if path.is_file() {
        path.clone()
    } else {
        node_executable(&path).ok_or_else(|| {
            SwitchFailure::RuntimeUnavailable(format!(
                "Node executable was not found: {}",
                path.display()
            ))
        })?
    };
    let directory = executable.parent().map(Path::to_path_buf).ok_or_else(|| {
        SwitchFailure::RuntimeUnavailable("Node executable has no parent directory".to_string())
    })?;
    let directory = canonicalize_for_compare(&directory).unwrap_or(directory);
    let executable = canonicalize_for_compare(&executable).unwrap_or(executable);
    let actual = run_node_version(&executable)
        .map_err(SwitchFailure::RuntimeUnavailable)
        .and_then(|raw| {
            normalize_version(&raw).ok_or_else(|| {
                SwitchFailure::RuntimeUnavailable(format!(
                    "Invalid Node version returned by {}",
                    executable.display()
                ))
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
        directory,
        executable,
    })
}

fn target_is_active(state: &SystemNodeState, target: &ResolvedTarget) -> bool {
    if !state.available || state.version.as_deref() != Some(target.version.as_str()) {
        return false;
    }
    let Some(current_path) = state
        .canonical_node_path
        .as_deref()
        .or(state.node_path.as_deref())
    else {
        return false;
    };
    path_strings_equal(Path::new(current_path), &target.executable)
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
    result(
        false,
        if failure.requires_elevation() {
            "elevation-required"
        } else {
            "failed"
        },
        previous,
        current.clone(),
        operation,
        Some(failure.error_code()),
        Some(failure.message()),
        if matches!(failure, SwitchFailure::MachinePathConflict(_)) {
            current.node_path
        } else {
            None
        },
    )
}

fn integration_path(app: &AppHandle) -> Result<PathBuf, SwitchFailure> {
    crate::app_config_file_path(app, INTEGRATION_FILE).map_err(SwitchFailure::IntegrationState)
}

fn read_integration_state_at(path: &Path) -> Result<SystemNodeIntegrationState, SwitchFailure> {
    if !path.exists() {
        return Ok(SystemNodeIntegrationState::default());
    }
    let content = fs::read_to_string(path).map_err(|error| {
        SwitchFailure::IntegrationState(format!("failed to read {}: {error}", path.display()))
    })?;
    if content.trim().is_empty() {
        return Ok(SystemNodeIntegrationState::default());
    }
    serde_json::from_str(&content).map_err(|error| {
        SwitchFailure::IntegrationState(format!("invalid integration state: {error}"))
    })
}

fn write_integration_state_at(
    path: &Path,
    state: &SystemNodeIntegrationState,
) -> Result<(), SwitchFailure> {
    let content = serde_json::to_string_pretty(state)
        .map_err(|error| SwitchFailure::IntegrationState(error.to_string()))?;
    crate::atomic_write_config(path, &content).map_err(SwitchFailure::IntegrationState)
}

#[cfg(windows)]
fn read_user_path() -> Result<PathSnapshot, String> {
    use winreg::types::FromRegValue;
    let key =
        match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey("Environment") {
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
    read_registry_path(
        winreg::enums::HKEY_LOCAL_MACHINE,
        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    )
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
fn read_registry_path(
    root: windows_sys::Win32::System::Registry::HKEY,
    key_name: &str,
) -> Result<PathSnapshot, String> {
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
        (winreg::enums::HKEY_CURRENT_USER, "Environment"),
        (
            winreg::enums::HKEY_LOCAL_MACHINE,
            "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        ),
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
        .create_subkey("Environment")?
        .0;
    key.set_raw_value(
        "Path",
        &registry_path_value(&snapshot.text, &snapshot.value_type.0),
    )
}

#[cfg(windows)]
fn write_machine_path(snapshot: &PathSnapshot) -> Result<(), io::Error> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE};
    let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(
        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        KEY_QUERY_VALUE | KEY_SET_VALUE,
    )?;
    key.set_raw_value(
        "Path",
        &registry_path_value(&snapshot.text, &snapshot.value_type.0),
    )
}

#[cfg(not(windows))]
fn write_user_path(_snapshot: &PathSnapshot) -> Result<(), io::Error> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "registry PATH is only available on Windows",
    ))
}

#[cfg(not(windows))]
fn write_machine_path(_snapshot: &PathSnapshot) -> Result<(), io::Error> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "registry PATH is only available on Windows",
    ))
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
        let value: Vec<u16> = "Environment"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
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

fn owned_path_values(state: &SystemNodeIntegrationState) -> [Option<&str>; 3] {
    [
        state.managed_path_entry.as_deref(),
        state.user_path_entry.as_deref(),
        state.machine_path_entry.as_deref(),
    ]
}

fn apply_controller_path_integration(
    state: &SystemNodeIntegrationState,
    controller: &SystemNodeController,
    force_machine: bool,
) -> Result<PathIntegrationResult, SwitchFailure> {
    let user_original = read_user_path().map_err(|detail| SwitchFailure::PathWrite {
        scope: "user",
        detail,
    })?;
    let machine_original = read_machine_path().map_err(|detail| SwitchFailure::PathWrite {
        scope: "machine",
        detail,
    })?;
    let owned = owned_path_values(state);
    let controller_entry = controller.link_path.to_string_lossy().to_string();
    let machine_has_controller = split_path_entries(&machine_original.text)
        .iter()
        .position(|entry| path_entries_equal(entry, &controller_entry));

    #[cfg(windows)]
    if !force_machine {
        if let Some(conflict) = find_machine_path_node_before_controller(
            &machine_original.text,
            &controller_entry,
            resolve_node_candidate_for_path_entry,
        ) {
            return Err(SwitchFailure::MachinePathConflict(format!(
                "Another Machine PATH Node has higher priority than the Project Manager Controller: {}",
                conflict.display()
            )));
        }
    }

    let mut user_clean = split_path_entries(&user_original.text);
    let mut machine_clean = split_path_entries(&machine_original.text);
    remove_owned_path_entries(&mut user_clean, &owned);
    remove_owned_path_entries(&mut machine_clean, &owned);

    let use_machine = force_machine || machine_has_controller.is_some();
    let (user_next, user_changed_by_controller) = if use_machine {
        (join_path_entries(&user_clean), false)
    } else {
        let clean = join_path_entries(&user_clean);
        let (value, _, inserted) = integrate_path_value_with_owned(&clean, &[], &controller_entry);
        (value, inserted)
    };
    let (machine_next, machine_changed_by_controller) = if use_machine {
        let clean = join_path_entries(&machine_clean);
        let (value, _, inserted) = integrate_path_value_with_owned(&clean, &[], &controller_entry);
        (value, inserted)
    } else {
        (join_path_entries(&machine_clean), false)
    };

    if !force_machine && machine_next != machine_original.text {
        return Err(SwitchFailure::Permission(
            "Project Manager PATH cleanup requires administrator permission".to_string(),
        ));
    }

    let user_changed = user_next != user_original.text;
    let machine_changed = machine_next != machine_original.text;
    if user_changed {
        write_user_path(&path_snapshot_with_text(&user_original, user_next.clone())).map_err(
            |error| {
                if is_permission_error(&error) {
                    SwitchFailure::Permission(error.to_string())
                } else {
                    SwitchFailure::PathWrite {
                        scope: "user",
                        detail: error.to_string(),
                    }
                }
            },
        )?;
        broadcast_environment();
    }
    if machine_changed {
        if let Err(error) = write_machine_path(&path_snapshot_with_text(
            &machine_original,
            machine_next.clone(),
        )) {
            let rollback = if user_changed {
                rollback_path_snapshot(Some(&user_original), None)
            } else {
                Ok(())
            };
            if let Err(rollback_error) = rollback {
                return Err(rollback_error);
            }
            return Err(if is_permission_error(&error) {
                SwitchFailure::Permission(error.to_string())
            } else {
                SwitchFailure::PathWrite {
                    scope: "machine",
                    detail: error.to_string(),
                }
            });
        }
        broadcast_environment();
    }

    // An existing NVM/system link belongs to its owner, not to Project Manager.
    // Only mark its PATH entry as owned when this operation actually inserted or
    // restored that entry. The PM-owned controller path is always managed by PM.
    let pm_owns_entry = matches!(
        controller.kind,
        SystemNodeControllerKind::ProjectManagerLink
    ) || user_changed_by_controller
        || machine_changed_by_controller
        || state
            .managed_path_entry
            .as_deref()
            .is_some_and(|entry| path_entries_equal(entry, &controller_entry));
    let mut next_state = state.clone();
    next_state.managed_path_entry = pm_owns_entry.then_some(controller_entry);
    next_state.user_path_entry = None;
    next_state.machine_path_entry = None;
    next_state.user_path_backup = if user_changed {
        Some(user_original.text.clone())
    } else {
        state.user_path_backup.clone()
    };
    next_state.machine_path_backup = if machine_changed {
        Some(machine_original.text.clone())
    } else {
        state.machine_path_backup.clone()
    };

    Ok(PathIntegrationResult {
        state: next_state,
        user_backup: user_changed.then_some(user_original),
        machine_backup: machine_changed.then_some(machine_original),
    })
}

#[cfg(windows)]
fn is_reparse_directory(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0010;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    let Ok(link_metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    let attributes = link_metadata.file_attributes();
    attributes & FILE_ATTRIBUTE_DIRECTORY != 0 && attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_directory(_path: &Path) -> bool {
    false
}

fn read_link_snapshot(path: &Path) -> Result<LinkSnapshot, SwitchFailure> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LinkSnapshot {
                existed: false,
                target: None,
            });
        }
        Err(error) => return Err(SwitchFailure::Controller(error.to_string())),
    }
    if !is_reparse_directory(path) {
        return Err(SwitchFailure::Controller(format!(
            "Controller path is an ordinary directory and will not be taken over: {}",
            path.display()
        )));
    }
    let target = canonicalize_for_compare(path).ok_or_else(|| {
        SwitchFailure::Controller(format!(
            "Controller link target cannot be resolved: {}",
            path.display()
        ))
    })?;
    if !target.is_dir() {
        return Err(SwitchFailure::Controller(format!(
            "Controller link target is not a directory: {}",
            target.display()
        )));
    }
    Ok(LinkSnapshot {
        existed: true,
        target: Some(target),
    })
}

#[cfg(windows)]
fn create_directory_link(link_path: &Path, target_path: &Path) -> Result<(), io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    if !target_path.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Junction target is not a directory: {}",
                target_path.display()
            ),
        ));
    }

    // A mount-point reparse buffer is the native representation used by a
    // directory junction. The substitute name is an NT path; the print name
    // is only for display and diagnostics.
    let target = target_path.to_string_lossy().to_string();
    let target_without_extended_prefix = target.strip_prefix(r"\\?\").unwrap_or(&target);
    let substitute = if let Some(unc_path) = target_without_extended_prefix.strip_prefix(r"\\") {
        format!(r"\??\UNC\{unc_path}")
    } else {
        format!(r"\??\{target_without_extended_prefix}")
    };
    let substitute_units: Vec<u16> = substitute.encode_utf16().collect();
    let print_units: Vec<u16> = target_without_extended_prefix.encode_utf16().collect();
    let mut path_units = Vec::with_capacity(substitute_units.len() + print_units.len() + 2);
    path_units.extend_from_slice(&substitute_units);
    path_units.push(0);
    path_units.extend_from_slice(&print_units);
    path_units.push(0);

    let substitute_length = substitute_units
        .len()
        .checked_mul(2)
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Junction target path is too long",
            )
        })?;
    let print_offset = substitute_units
        .len()
        .checked_add(1)
        .and_then(|value| value.checked_mul(2))
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Junction target path is too long",
            )
        })?;
    let print_length = print_units
        .len()
        .checked_mul(2)
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Junction target path is too long",
            )
        })?;
    let reparse_data_length = 8usize
        .checked_add(path_units.len().saturating_mul(2))
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Junction target path is too long",
            )
        })?;
    let buffer_length = 8usize
        .checked_add(usize::from(reparse_data_length))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Junction target path is too long",
            )
        })?;
    let mut buffer = vec![0u8; buffer_length];
    buffer[0..4].copy_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer[4..6].copy_from_slice(&reparse_data_length.to_le_bytes());
    buffer[8..10].copy_from_slice(&0u16.to_le_bytes());
    buffer[10..12].copy_from_slice(&substitute_length.to_le_bytes());
    buffer[12..14].copy_from_slice(&print_offset.to_le_bytes());
    buffer[14..16].copy_from_slice(&print_length.to_le_bytes());
    for (index, unit) in path_units.iter().enumerate() {
        let offset = 16 + index * 2;
        buffer[offset..offset + 2].copy_from_slice(&unit.to_le_bytes());
    }

    fs::create_dir(link_path)?;
    let link: Vec<u16> = link_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `link` is a NUL-terminated UTF-16 path. All optional pointers
    // are null, and the returned handle is checked before it is used.
    let handle = unsafe {
        CreateFileW(
            link.as_ptr(),
            FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::from_raw_os_error(unsafe { GetLastError() } as i32);
        let _ = fs::remove_dir(link_path);
        return Err(error);
    }

    let mut bytes_returned = 0u32;
    // SAFETY: the reparse buffer is alive and immutable for the duration of
    // the synchronous call; the output and OVERLAPPED pointers are null.
    let result = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            null_mut(),
            0,
            &mut bytes_returned,
            null_mut(),
        )
    };
    let error = if result == 0 {
        Some(io::Error::from_raw_os_error(
            unsafe { GetLastError() } as i32
        ))
    } else {
        None
    };
    // SAFETY: `handle` was returned by CreateFileW and has not been closed.
    unsafe { CloseHandle(handle) };

    if let Some(error) = error {
        let _ = fs::remove_dir(link_path);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
fn create_directory_link(_link_path: &Path, _target_path: &Path) -> Result<(), io::Error> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory links are only managed on Windows",
    ))
}

fn remove_controller_link(path: &Path) -> Result<(), SwitchFailure> {
    if !is_reparse_directory(path) {
        return Err(SwitchFailure::Controller(format!(
            "Refusing to remove non-link Controller path: {}",
            path.display()
        )));
    }
    fs::remove_dir(path).map_err(|error| {
        if is_permission_error(&error) {
            SwitchFailure::Permission(error.to_string())
        } else {
            SwitchFailure::Controller(format!(
                "Failed to remove Controller link {}: {error}",
                path.display()
            ))
        }
    })
}

fn restore_link_snapshot(path: &Path, snapshot: &LinkSnapshot) -> Result<(), SwitchFailure> {
    if fs::symlink_metadata(path).is_ok() {
        if !is_reparse_directory(path) {
            return Err(SwitchFailure::Rollback(format!(
                "Cannot rollback Controller because {} is no longer a link",
                path.display()
            )));
        }
        remove_controller_link(path)?;
    }
    if snapshot.existed {
        let target = snapshot.target.as_ref().ok_or_else(|| {
            SwitchFailure::Rollback(format!(
                "Previous Controller target is missing for {}",
                path.display()
            ))
        })?;
        create_directory_link(path, target).map_err(|error| {
            if is_permission_error(&error) {
                SwitchFailure::Rollback(error.to_string())
            } else {
                SwitchFailure::Rollback(format!("Failed to restore Controller link: {error}"))
            }
        })?;
    }
    Ok(())
}

fn repoint_controller(
    controller: &SystemNodeController,
    target: &ResolvedTarget,
) -> Result<LinkSnapshot, SwitchFailure> {
    let snapshot = read_link_snapshot(&controller.link_path)?;
    if snapshot
        .target
        .as_ref()
        .is_some_and(|current| path_strings_equal(current, &target.directory))
    {
        return Ok(snapshot);
    }
    if snapshot.existed {
        remove_controller_link(&controller.link_path)?;
    } else if let Some(parent) = controller.link_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            if is_permission_error(&error) {
                SwitchFailure::Permission(error.to_string())
            } else {
                SwitchFailure::Controller(error.to_string())
            }
        })?;
    }
    if let Err(error) = create_directory_link(&controller.link_path, &target.directory) {
        let failure = if is_permission_error(&error) {
            SwitchFailure::Permission(error.to_string())
        } else {
            SwitchFailure::Controller(format!("Failed to create Controller link: {error}"))
        };
        if snapshot.existed {
            restore_link_snapshot(&controller.link_path, &snapshot).map_err(|rollback| {
                SwitchFailure::Rollback(format!(
                    "{}; original switch error: {}",
                    rollback.message(),
                    failure.message()
                ))
            })?;
        }
        return Err(failure);
    }
    Ok(snapshot)
}

fn path_contains_controller(path: &Path) -> bool {
    let executable = path.join("node.exe");
    read_machine_path()
        .ok()
        .is_some_and(|snapshot| path_value_contains_executable(&snapshot.text, &executable))
        || read_user_path()
            .ok()
            .is_some_and(|snapshot| path_value_contains_executable(&snapshot.text, &executable))
}

fn safe_existing_node_link(path: &Path) -> bool {
    if !is_reparse_directory(path) {
        return false;
    }
    let Ok(snapshot) = read_link_snapshot(path) else {
        return false;
    };
    snapshot.existed && path_contains_controller(path)
}

fn project_manager_controller_path(app_data: &Path) -> PathBuf {
    app_data.join("system-node").join("current")
}

fn resolve_controller(app_data: &Path, state: &SystemNodeIntegrationState) -> SystemNodeController {
    let project_manager_path = project_manager_controller_path(app_data);
    if state.controller_mode.as_deref() == Some("project-manager-link")
        && state
            .controller_link_path
            .as_deref()
            .is_some_and(|path| path_strings_equal(Path::new(path), &project_manager_path))
    {
        return SystemNodeController {
            link_path: project_manager_path,
            kind: SystemNodeControllerKind::ProjectManagerLink,
        };
    }

    if state.controller_mode.as_deref() == Some("existing-link")
        && state
            .controller_link_path
            .as_deref()
            .is_some_and(|path| safe_existing_node_link(Path::new(path)))
    {
        return SystemNodeController {
            link_path: PathBuf::from(state.controller_link_path.as_deref().unwrap_or_default()),
            kind: SystemNodeControllerKind::ExistingNodeLink,
        };
    }

    #[cfg(windows)]
    if let Some(path) = discover_nvm_symlink()
        .map(PathBuf::from)
        .filter(|path| safe_existing_node_link(path))
    {
        return SystemNodeController {
            link_path: path,
            kind: SystemNodeControllerKind::ExistingNodeLink,
        };
    }

    SystemNodeController {
        link_path: project_manager_path,
        kind: SystemNodeControllerKind::ProjectManagerLink,
    }
}

fn controller_mode(controller: &SystemNodeController) -> &'static str {
    match controller.kind {
        SystemNodeControllerKind::ExistingNodeLink => "existing-link",
        SystemNodeControllerKind::ProjectManagerLink => "project-manager-link",
    }
}

fn perform_controller_switch(
    state_path: &Path,
    target: &ResolvedTarget,
    force_machine_path: bool,
) -> Result<SystemNodeState, SwitchFailure> {
    let original_state = read_integration_state_at(state_path)?;
    let app_data = state_path.parent().ok_or_else(|| {
        SwitchFailure::IntegrationState("System Node state has no parent directory".to_string())
    })?;
    let controller = resolve_controller(app_data, &original_state);
    let link_snapshot = match repoint_controller(&controller, target) {
        Ok(snapshot) => snapshot,
        Err(error) => return Err(error),
    };

    let path_result =
        match apply_controller_path_integration(&original_state, &controller, force_machine_path) {
            Ok(value) => value,
            Err(error) => {
                if let Err(rollback) = restore_link_snapshot(&controller.link_path, &link_snapshot)
                {
                    return Err(rollback);
                }
                return Err(error);
            }
        };

    let mut next_state = path_result.state;
    next_state.managed_runtime_id = target.runtime_id.clone();
    next_state.controller_mode = Some(controller_mode(&controller).to_string());
    next_state.controller_link_path = Some(controller.link_path.to_string_lossy().to_string());
    next_state.previous_target = link_snapshot
        .target
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());

    if let Err(error) = write_integration_state_at(state_path, &next_state) {
        let path_rollback = rollback_path_snapshot(
            path_result.user_backup.as_ref(),
            path_result.machine_backup.as_ref(),
        );
        let link_rollback = restore_link_snapshot(&controller.link_path, &link_snapshot);
        let _ = write_integration_state_at(state_path, &original_state);
        let mut rollback_errors = Vec::new();
        if let Err(rollback_error) = path_rollback {
            rollback_errors.push(rollback_error.message());
        }
        if let Err(rollback_error) = link_rollback {
            rollback_errors.push(rollback_error.message());
        }
        if !rollback_errors.is_empty() {
            return Err(SwitchFailure::Rollback(rollback_errors.join("; ")));
        }
        return Err(error);
    }

    broadcast_environment();
    let current = detect_system_node_state();
    if target_is_active(&current, target) {
        return Ok(current);
    }

    let path_rollback = rollback_path_snapshot(
        path_result.user_backup.as_ref(),
        path_result.machine_backup.as_ref(),
    );
    let link_rollback = restore_link_snapshot(&controller.link_path, &link_snapshot);
    let state_rollback = write_integration_state_at(state_path, &original_state);
    let mut rollback_errors = Vec::new();
    if let Err(error) = path_rollback {
        rollback_errors.push(error.message());
    }
    if let Err(error) = link_rollback {
        rollback_errors.push(error.message());
    }
    if let Err(error) = state_rollback {
        rollback_errors.push(error.message());
    }
    if !rollback_errors.is_empty() {
        return Err(SwitchFailure::Rollback(rollback_errors.join("; ")));
    }
    Err(SwitchFailure::Verification(format!(
        "System Node verification failed for {}",
        target.executable.display()
    )))
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
        ElevatedNodeOperation::Switch { operation_id, .. } => operation_id,
    }
}

#[derive(Debug)]
enum ElevatedFailure {
    Cancelled,
    Operation(SwitchFailure),
}

fn operation_path(
    app: &AppHandle,
    operation: &ElevatedNodeOperation,
) -> Result<PathBuf, SwitchFailure> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| SwitchFailure::IntegrationState(error.to_string()))?
        .join("tmp")
        .join(OPERATION_DIRECTORY);
    fs::create_dir_all(&directory)
        .map_err(|error| SwitchFailure::IntegrationState(error.to_string()))?;
    let path = directory.join(format!(
        "node-operation-{}.json",
        operation_id_of(operation)
    ));
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
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_CANCELLED, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };

    let executable = env::current_exe().map_err(|error| {
        ElevatedFailure::Operation(SwitchFailure::IntegrationState(error.to_string()))
    })?;
    let parent = executable.parent().unwrap_or_else(|| Path::new("."));
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();
    let file: Vec<u16> = executable
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let parameters_string = format!(
        "{} \"{}\"",
        OPERATION_ARGUMENT,
        operation_path.to_string_lossy()
    );
    let parameters: Vec<u16> = parameters_string
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let directory: Vec<u16> = parent
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

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
        return Err(ElevatedFailure::Operation(SwitchFailure::Permission(
            format!("ShellExecuteExW failed with Windows error {error}"),
        )));
    }
    if info.hProcess.is_null() {
        return Err(ElevatedFailure::Operation(SwitchFailure::Verification(
            "Elevated helper did not return a process handle".to_string(),
        )));
    }
    let wait_result = unsafe { WaitForSingleObject(info.hProcess, ELEVATED_OPERATION_TIMEOUT_MS) };
    match wait_result {
        WAIT_OBJECT_0 => {}
        WAIT_TIMEOUT => {
            let _ = unsafe { TerminateProcess(info.hProcess, 1) };
            unsafe { CloseHandle(info.hProcess) };
            return Err(ElevatedFailure::Operation(
                SwitchFailure::ElevatedOperationTimeout(
                    "Elevated Node operation timed out after 45 seconds".to_string(),
                ),
            ));
        }
        WAIT_FAILED => {
            let error = unsafe { GetLastError() };
            unsafe { CloseHandle(info.hProcess) };
            return Err(ElevatedFailure::Operation(SwitchFailure::Verification(
                format!("Failed to wait for elevated helper: Windows error {error}"),
            )));
        }
        other => {
            unsafe { CloseHandle(info.hProcess) };
            return Err(ElevatedFailure::Operation(SwitchFailure::Verification(
                format!("Elevated helper returned unexpected wait result {other}"),
            )));
        }
    }
    let mut exit_code = 1_u32;
    let exit_read = unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) };
    unsafe { CloseHandle(info.hProcess) };
    if exit_read == 0 {
        return Err(ElevatedFailure::Operation(SwitchFailure::Verification(
            "Failed to read elevated helper exit code".to_string(),
        )));
    }
    match exit_code {
        0 => Ok(()),
        12 => Err(ElevatedFailure::Operation(SwitchFailure::Permission(
            "Elevated Controller operation was denied".to_string(),
        ))),
        14 => Err(ElevatedFailure::Operation(SwitchFailure::PathWrite {
            scope: "machine",
            detail: "Elevated Machine PATH write failed".to_string(),
        })),
        15 => Err(ElevatedFailure::Operation(SwitchFailure::Rollback(
            "Elevated Controller rollback failed".to_string(),
        ))),
        17 => Err(ElevatedFailure::Operation(
            SwitchFailure::ElevatedOperationTimeout(
                "Elevated Node operation timed out after 45 seconds".to_string(),
            ),
        )),
        _ => Err(ElevatedFailure::Operation(SwitchFailure::Verification(
            format!("Elevated helper exited with code {exit_code}"),
        ))),
    }
}

#[tauri::command]
pub async fn switch_system_node(
    app: AppHandle,
    runtime: NodeRuntimeTarget,
    options: Option<SystemNodeSwitchOptions>,
) -> SystemNodeSwitchResult {
    let options = options.unwrap_or_default();
    match tauri::async_runtime::spawn_blocking(move || {
        switch_system_node_blocking(app, runtime, options)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => SystemNodeSwitchResult {
            success: false,
            status: "failed".to_string(),
            previous: None,
            current: None,
            conflicting_path: None,
            operation: None,
            error_code: Some("system_node_worker_failed".to_string()),
            message: Some(format!("System Node switch worker failed: {error}")),
        },
    }
}

fn switch_system_node_blocking(
    app: AppHandle,
    runtime: NodeRuntimeTarget,
    options: SystemNodeSwitchOptions,
) -> SystemNodeSwitchResult {
    let previous = detect_system_node_state();
    if !system_node_switch_supported() {
        return failure_result(previous, None, &SwitchFailure::Unsupported);
    }
    let target = match resolve_target(&runtime) {
        Ok(target) => target,
        Err(error) => return failure_result(previous, None, &error),
    };
    if target.source == "system" {
        return if target_is_active(&previous, &target) {
            result(
                true,
                "already-active",
                previous.clone(),
                previous,
                None,
                None,
                Some("System Node is already active".to_string()),
                None,
            )
        } else {
            failure_result(
                previous,
                None,
                &SwitchFailure::RuntimeUnavailable(
                    "The selected System runtime is not the current OS Node".to_string(),
                ),
            )
        };
    }
    if target_is_active(&previous, &target) {
        return result(
            true,
            "already-active",
            previous.clone(),
            previous,
            Some("controller"),
            None,
            Some("System Node is already active".to_string()),
            None,
        );
    }

    let state_path = match integration_path(&app) {
        Ok(path) => path,
        Err(error) => return failure_result(previous, Some("controller"), &error),
    };
    if options.elevated {
        let operation = ElevatedNodeOperation::Switch {
            schema_version: OPERATION_SCHEMA_VERSION,
            operation_id: operation_id(),
            target_runtime_id: target.runtime_id.clone(),
            target_version: target.version.clone(),
            target_path: target.directory.to_string_lossy().to_string(),
            target_source: target.source.clone(),
            target_runtime_root: runtime.runtime_root.clone(),
        };
        return match run_elevated_operation(&app, &operation) {
            Ok(()) => {
                let current = detect_system_node_state();
                if target_is_active(&current, &target) {
                    result(
                        true,
                        "switched",
                        previous,
                        current,
                        Some("controller"),
                        None,
                        None,
                        None,
                    )
                } else {
                    failure_result(
                        previous,
                        Some("controller"),
                        &SwitchFailure::Verification(
                            "Elevated Controller completed without verification".to_string(),
                        ),
                    )
                }
            }
            Err(ElevatedFailure::Cancelled) => result(
                false,
                "cancelled",
                previous,
                detect_system_node_state(),
                Some("controller"),
                Some("uac_cancelled"),
                Some("User cancelled the administrator permission request".to_string()),
                None,
            ),
            Err(ElevatedFailure::Operation(error)) => {
                failure_result(previous, Some("controller"), &error)
            }
        };
    }

    match perform_controller_switch(&state_path, &target, false) {
        Ok(current) => result(
            true,
            "switched",
            previous,
            current,
            Some("controller"),
            None,
            None,
            None,
        ),
        Err(error) => failure_result(previous, Some("controller"), &error),
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
            Err(SwitchFailure::Permission(_)) | Err(SwitchFailure::MachinePathConflict(_)) => 12,
            Err(SwitchFailure::PathWrite {
                scope: "machine", ..
            }) => 14,
            Err(SwitchFailure::Rollback(_)) => 15,
            Err(SwitchFailure::ElevatedOperationTimeout(_)) => 17,
            Err(error) => {
                eprintln!("{error:?}");
                16
            }
        }
    }
}

#[cfg(windows)]
fn execute_elevated_operation(path: &Path) -> Result<(), SwitchFailure> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let Some(file_id) = file_name
        .strip_prefix("node-operation-")
        .and_then(|value| value.strip_suffix(".json"))
    else {
        return Err(SwitchFailure::Verification(
            "Invalid elevated operation file location".to_string(),
        ));
    };
    if file_id.is_empty()
        || !file_id
            .chars()
            .all(|value| value.is_ascii_digit() || value == '-')
    {
        return Err(SwitchFailure::Verification(
            "Invalid elevated operation file name".to_string(),
        ));
    }
    let canonical_path =
        fs::canonicalize(path).map_err(|error| SwitchFailure::Verification(error.to_string()))?;
    let canonical_parent = canonical_path.parent().ok_or_else(|| {
        SwitchFailure::Verification("Invalid elevated operation parent".to_string())
    })?;
    let expected_parent = expected_operation_directory().ok_or_else(|| {
        SwitchFailure::Verification("Application data directory is unavailable".to_string())
    })?;
    let expected_parent = fs::canonicalize(expected_parent)
        .map_err(|error| SwitchFailure::Verification(error.to_string()))?;
    if !path_strings_equal(canonical_parent, &expected_parent) {
        return Err(SwitchFailure::Verification(
            "Invalid elevated operation file location".to_string(),
        ));
    }
    let content =
        fs::read_to_string(path).map_err(|error| SwitchFailure::Verification(error.to_string()))?;
    let operation: ElevatedNodeOperation = serde_json::from_str(&content).map_err(|error| {
        SwitchFailure::Verification(format!("Invalid elevated operation: {error}"))
    })?;
    if operation_id_of(&operation) != file_id {
        return Err(SwitchFailure::Verification(
            "Elevated operation ID does not match its file name".to_string(),
        ));
    }

    match operation {
        ElevatedNodeOperation::Switch {
            schema_version,
            operation_id,
            target_runtime_id,
            target_version,
            target_path,
            target_source,
            target_runtime_root,
        } => {
            validate_operation_metadata(schema_version, &operation_id)?;
            if target_source == "system" {
                return Err(SwitchFailure::RuntimeUnavailable(
                    "System Node state cannot be used as an elevated switch target".to_string(),
                ));
            }
            let target = NodeRuntimeTarget {
                runtime_id: target_runtime_id,
                version: target_version,
                path: target_path,
                source: target_source,
                runtime_root: target_runtime_root,
            };
            let target = resolve_target(&target)?;
            let app_data = expected_parent
                .parent()
                .and_then(Path::parent)
                .ok_or_else(|| {
                    SwitchFailure::Verification(
                        "Application data directory is unavailable".to_string(),
                    )
                })?;
            let state_path = app_data.join(INTEGRATION_FILE);
            let current = perform_controller_switch(&state_path, &target, true)?;
            if target_is_active(&current, &target) {
                Ok(())
            } else {
                Err(SwitchFailure::Verification(
                    "Elevated Controller verification failed".to_string(),
                ))
            }
        }
    }
}

#[cfg(windows)]
fn expected_operation_directory() -> Option<PathBuf> {
    env::var_os("APPDATA").map(PathBuf::from).map(|root| {
        root.join(APP_DATA_DIRECTORY_IDENTIFIER)
            .join("tmp")
            .join(OPERATION_DIRECTORY)
    })
}

#[cfg(windows)]
fn validate_operation_metadata(
    schema_version: u32,
    operation_id: &str,
) -> Result<(), SwitchFailure> {
    if schema_version != OPERATION_SCHEMA_VERSION
        || operation_id.trim().is_empty()
        || operation_id.len() > 128
        || !operation_id
            .chars()
            .all(|value| value.is_ascii_digit() || value == '-')
    {
        return Err(SwitchFailure::Verification(
            "Invalid elevated operation metadata".to_string(),
        ));
    }
    Ok(())
}

fn is_permission_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
        || error.raw_os_error() == Some(5)
        || error.raw_os_error() == Some(1314)
        || output_looks_permission(&error.to_string())
}

fn output_looks_permission(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.contains("access is denied")
        || lower.contains("access denied")
        || lower.contains("permission denied")
        || lower.contains("os error 5")
        || (lower.contains("reparse") && lower.contains("permission"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::fs;

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
    fn path_integration_keeps_environment_expressions() {
        let (value, _) = integrate_path_value(
            "%USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd",
            None,
            "D:\\system-node\\current",
        );
        assert_eq!(
            value,
            "D:\\system-node\\current;%USERPROFILE%\\bin;C:\\Program Files\\Git\\cmd"
        );
    }

    #[test]
    fn machine_path_conflict_ignores_non_node_entries_before_controller() {
        let result = find_machine_path_node_before_controller(
            r"C:\Windows\System32;C:\Program Files\Git\cmd;D:\pm-controller",
            r"D:\pm-controller",
            |entry| {
                entry
                    .eq_ignore_ascii_case(r"C:\OtherNode")
                    .then(|| PathBuf::from(r"C:\OtherNode\node.exe"))
            },
        );
        assert!(result.is_none());
    }

    #[test]
    fn machine_path_conflict_detects_node_before_controller() {
        let result = find_machine_path_node_before_controller(
            r"C:\OtherNode;C:\Program Files\Git\cmd;D:\pm-controller",
            r"D:\pm-controller",
            |entry| {
                entry
                    .eq_ignore_ascii_case(r"C:\OtherNode")
                    .then(|| PathBuf::from(r"C:\OtherNode\node.exe"))
            },
        );
        assert_eq!(result, Some(PathBuf::from(r"C:\OtherNode\node.exe")));
    }

    #[test]
    fn machine_path_conflict_does_not_inspect_controller_or_later_entries() {
        let result = find_machine_path_node_before_controller(
            r"C:\Windows\System32;D:\pm-controller;C:\OtherNode",
            r"D:\pm-controller",
            |entry| {
                if entry.eq_ignore_ascii_case(r"D:\pm-controller") {
                    Some(PathBuf::from(r"D:\pm-controller\node.exe"))
                } else if entry.eq_ignore_ascii_case(r"C:\OtherNode") {
                    Some(PathBuf::from(r"C:\OtherNode\node.exe"))
                } else {
                    None
                }
            },
        );
        assert!(result.is_none());
    }

    #[test]
    fn machine_path_without_controller_still_detects_a_machine_node() {
        let result = find_machine_path_node_before_controller(
            r"C:\OtherNode;C:\Program Files\Git\cmd",
            r"D:\pm-controller",
            |entry| {
                entry
                    .eq_ignore_ascii_case(r"C:\OtherNode")
                    .then(|| PathBuf::from(r"C:\OtherNode\node.exe"))
            },
        );
        assert_eq!(result, Some(PathBuf::from(r"C:\OtherNode\node.exe")));
    }

    #[test]
    fn controller_operation_has_no_nvm_switch_variant() {
        let operation = ElevatedNodeOperation::Switch {
            schema_version: OPERATION_SCHEMA_VERSION,
            operation_id: "1-2".to_string(),
            target_runtime_id: Some("nvm:v20.19.1".to_string()),
            target_version: "v20.19.1".to_string(),
            target_path: "D:\\nvm\\v20.19.1".to_string(),
            target_source: "nvm".to_string(),
            target_runtime_root: None,
        };
        let serialized = serde_json::to_string(&operation).expect("serialize operation");
        assert!(serialized.contains("switch"));
        assert!(!serialized.contains("nvm-use"));
    }

    #[cfg(windows)]
    #[test]
    fn directory_junction_snapshot_can_be_restored_after_repoint() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let old_target = temp.path().join("old-target");
        let new_target = temp.path().join("new-target");
        let link = temp.path().join("current");
        fs::create_dir_all(&old_target).expect("old target");
        fs::create_dir_all(&new_target).expect("new target");

        create_directory_link(&link, &old_target).expect("create initial junction");
        let snapshot = read_link_snapshot(&link).expect("read junction snapshot");
        remove_controller_link(&link).expect("remove initial junction");
        create_directory_link(&link, &new_target).expect("create replacement junction");

        restore_link_snapshot(&link, &snapshot).expect("restore junction snapshot");
        assert!(path_strings_equal(&link, &old_target));
    }

    #[cfg(windows)]
    #[test]
    fn controller_repoints_nvm_and_managed_targets_without_nvm_cli() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let nvm_old = temp.path().join("nvm-v24");
        let nvm_new = temp.path().join("nvm-v20");
        let managed = temp.path().join("managed-v24");
        let link = temp.path().join("current");
        fs::create_dir_all(&nvm_old).expect("old NVM target");
        fs::create_dir_all(&nvm_new).expect("new NVM target");
        fs::create_dir_all(&managed).expect("Managed target");
        create_directory_link(&link, &nvm_old).expect("create initial junction");

        let controller = SystemNodeController {
            link_path: link.clone(),
            kind: SystemNodeControllerKind::ExistingNodeLink,
        };
        let nvm_target = ResolvedTarget {
            runtime_id: Some("nvm:v20".to_string()),
            version: "v20.19.1".to_string(),
            source: "nvm".to_string(),
            directory: nvm_new.clone(),
            executable: nvm_new.join("node.exe"),
        };
        let snapshot = repoint_controller(&controller, &nvm_target).expect("repoint to NVM");
        assert!(path_strings_equal(&link, &nvm_new));
        restore_link_snapshot(&link, &snapshot).expect("rollback to old NVM target");
        assert!(path_strings_equal(&link, &nvm_old));

        let managed_target = ResolvedTarget {
            runtime_id: Some("managed:v24".to_string()),
            version: "v24.20.0".to_string(),
            source: "managed".to_string(),
            directory: managed.clone(),
            executable: managed.join("node.exe"),
        };
        repoint_controller(&controller, &managed_target).expect("repoint to Managed");
        assert!(path_strings_equal(&link, &managed));
    }

    #[cfg(windows)]
    #[test]
    fn controller_creation_failure_restores_previous_target() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let old_target = temp.path().join("old-target");
        let missing_target = temp.path().join("missing-target");
        let link = temp.path().join("current");
        fs::create_dir_all(&old_target).expect("old target");
        create_directory_link(&link, &old_target).expect("create initial junction");

        let controller = SystemNodeController {
            link_path: link.clone(),
            kind: SystemNodeControllerKind::ExistingNodeLink,
        };
        let target = ResolvedTarget {
            runtime_id: Some("nvm:v20".to_string()),
            version: "v20.19.1".to_string(),
            source: "nvm".to_string(),
            directory: missing_target.clone(),
            executable: missing_target.join("node.exe"),
        };

        assert!(repoint_controller(&controller, &target).is_err());
        assert!(path_strings_equal(&link, &old_target));
    }

    #[test]
    fn project_manager_controller_state_resolves_to_app_data_link() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let expected = project_manager_controller_path(temp.path());
        let state = SystemNodeIntegrationState {
            controller_mode: Some("project-manager-link".to_string()),
            controller_link_path: Some(expected.to_string_lossy().to_string()),
            ..SystemNodeIntegrationState::default()
        };

        let controller = resolve_controller(temp.path(), &state);
        assert_eq!(
            controller.kind,
            SystemNodeControllerKind::ProjectManagerLink
        );
        assert!(path_strings_equal(&controller.link_path, &expected));
    }

    #[cfg(windows)]
    #[test]
    fn ordinary_controller_directory_is_never_taken_over() {
        let temp = tempfile::tempdir().expect("temporary directory");
        let link = temp.path().join("current");
        fs::create_dir_all(&link).expect("ordinary controller directory");

        let error = read_link_snapshot(&link).expect_err("ordinary directory must be rejected");
        assert!(error.message().contains("ordinary directory"));
        assert!(
            link.is_dir(),
            "the ordinary user directory must remain intact"
        );
    }
}
