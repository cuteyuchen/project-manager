use std::path::PathBuf;
use std::process::Command;
use std::collections::HashMap;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

use serde::de::DeserializeOwned;
use serde_json::Value;
#[cfg(target_os = "windows")]
use encoding_rs::{GBK, UTF_16BE, UTF_16LE};

#[cfg(target_os = "windows")]
use winreg::enums::*;
#[cfg(target_os = "windows")]
use winreg::RegKey;

#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::io::Write;
#[cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;

#[derive(serde::Serialize)]
pub struct PlatformInfo {
    os: String,
    arch: String,
}

#[derive(serde::Serialize, Clone)]
pub struct TerminalInfo {
    id: String,
    name: String,
}

#[derive(serde::Serialize, Clone)]
pub struct PortEntry {
    protocol: String,
    local_address: String,
    local_port: u16,
    remote_address: Option<String>,
    remote_port: Option<u16>,
    state: String,
    pid: Option<u32>,
    process_name: Option<String>,
    executable_path: Option<String>,
    command_line: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsPortRow {
    protocol: Option<String>,
    local_address: Option<String>,
    local_port: Option<u16>,
    remote_address: Option<String>,
    remote_port: Option<u16>,
    state: Option<String>,
    owning_process: Option<u32>,
}

#[cfg(target_os = "windows")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsProcessRow {
    process_id: u32,
    name: Option<String>,
    executable_path: Option<String>,
    command_line: Option<String>,
}

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

async fn run_system_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Background system task failed: {}", e))
}

fn get_exe_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn decode_command_bytes(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (decoded, _, _) = UTF_16LE.decode(&bytes[2..]);
        return decoded.trim().to_string();
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (decoded, _, _) = UTF_16BE.decode(&bytes[2..]);
        return decoded.trim().to_string();
    }

    let likely_utf16_le = bytes.len() > 2
        && bytes.len() % 2 == 0
        && bytes.iter().skip(1).step_by(2).filter(|byte| **byte == 0).count() > bytes.len() / 4;
    if likely_utf16_le {
        let (decoded, _, _) = UTF_16LE.decode(bytes);
        return decoded.trim().to_string();
    }

    match String::from_utf8(bytes.to_vec()) {
        Ok(decoded) => decoded.trim().to_string(),
        Err(_) => {
            let (decoded, _, _) = GBK.decode(bytes);
            decoded.trim().to_string()
        }
    }
}

#[cfg(target_os = "windows")]
fn command_output_to_string(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(decode_command_bytes(&output.stdout))
    } else {
        let stderr = decode_command_bytes(&output.stderr);
        let stdout = decode_command_bytes(&output.stdout);
        Err(if !stderr.is_empty() { stderr } else { stdout })
    }
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
    let wrapped_script = format!(
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); {}",
        script
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &wrapped_script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {}", e))?;

    command_output_to_string(output)
}

#[cfg(target_os = "windows")]
fn parse_json_rows<T: DeserializeOwned>(raw: &str) -> Result<Vec<T>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(Vec::new());
    }

    let value: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("Failed to parse command output: {}", e))?;

    match value {
        Value::Array(items) => items
            .into_iter()
            .map(|item| serde_json::from_value(item).map_err(|e| e.to_string()))
            .collect(),
        Value::Object(_) => serde_json::from_value(value)
            .map(|item| vec![item])
            .map_err(|e| e.to_string()),
        _ => Ok(Vec::new()),
    }
}

//************* 终端检测功能 *************

fn check_command_exists(cmd: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("where")
            .arg(cmd)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        Command::new("which")
            .arg(cmd)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}

#[cfg(target_os = "macos")]
fn check_terminal_app() -> bool {
    std::path::Path::new("/System/Applications/Utilities/Terminal.app").exists()
}

#[tauri::command]
pub async fn detect_available_terminals() -> Result<Vec<TerminalInfo>, String> {
    run_system_task(move || {
        let mut terminals: Vec<TerminalInfo> = Vec::new();

        #[cfg(target_os = "windows")]
        {
            terminals.push(TerminalInfo {
                id: "cmd".to_string(),
                name: "Command Prompt (cmd.exe)".to_string(),
            });

            if check_command_exists("powershell") {
                terminals.push(TerminalInfo {
                    id: "powershell".to_string(),
                    name: "PowerShell".to_string(),
                });
            }
        }

        #[cfg(target_os = "macos")]
        {
            if check_terminal_app() {
                terminals.push(TerminalInfo {
                    id: "terminal".to_string(),
                    name: "Terminal.app".to_string(),
                });
            }
        }

        #[cfg(target_os = "linux")]
        {
            if check_command_exists("gnome-terminal") {
                terminals.push(TerminalInfo {
                    id: "gnome-terminal".to_string(),
                    name: "GNOME Terminal".to_string(),
                });
            }

            if check_command_exists("konsole") {
                terminals.push(TerminalInfo {
                    id: "konsole".to_string(),
                    name: "Konsole (KDE)".to_string(),
                });
            }

            if check_command_exists("xfce4-terminal") {
                terminals.push(TerminalInfo {
                    id: "xfce4-terminal".to_string(),
                    name: "XFCE Terminal".to_string(),
                });
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            if check_command_exists("bash") {
                terminals.push(TerminalInfo {
                    id: "bash".to_string(),
                    name: "Bash".to_string(),
                });
            }
        }

        terminals
    })
    .await
}

//************* 右键菜单功能 *************

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_context_menu(enable: bool, locale: String) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let exe_path = get_exe_path()?;
    let exe_str = exe_path.to_str().ok_or("Invalid path")?;
    
    let menu_text = if locale == "zh" {
        "在项目管理器中打开"
    } else {
        "Open in Project Manager"
    };
    
    let keys = vec![
        r"Software\Classes\Directory\shell\project-manager",
        r"Software\Classes\Directory\Background\shell\project-manager"
    ];
    
    for key_path in keys {
        if enable {
            let (key, _) = hkcu.create_subkey(key_path).map_err(|e| e.to_string())?;
            key.set_value("", &menu_text).map_err(|e| e.to_string())?;
            key.set_value("Icon", &exe_str).map_err(|e| e.to_string())?;
            let (cmd_key, _) = key.create_subkey("command").map_err(|e| e.to_string())?;
            let cmd_str = format!("\"{}\" \"%V\"", exe_str);
            cmd_key.set_value("", &cmd_str).map_err(|e| e.to_string())?;
        } else {
            let _ = hkcu.delete_subkey_all(key_path);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn check_context_menu() -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key_path = r"Software\Classes\Directory\shell\project-manager";
    hkcu.open_subkey(key_path).is_ok()
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub fn set_context_menu(enable: bool, locale: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set")?;
    let applications_dir = std::path::Path::new(&home).join(".local/share/applications");
    let desktop_file_path = applications_dir.join("project-manager-context.desktop");

    let menu_text = if locale == "zh" {
        "在项目管理器中打开"
    } else {
        "Open in Project Manager"
    };

    if enable {
        if !applications_dir.exists() {
             fs::create_dir_all(&applications_dir).map_err(|e| e.to_string())?;
        }

        let exe_path = get_exe_path()?;
        let exe_str = exe_path.to_str().ok_or("Invalid path")?;
        
        // Basic .desktop file for "Open With" support
        // MimeType=inode/directory registers it for folders
        let content = format!(r#"[Desktop Entry]
Type=Application
Name={}
Exec="{}" "%f"
Icon=folder-open
NoDisplay=true
MimeType=inode/directory;
"#, menu_text, exe_str);

        let mut file = fs::File::create(&desktop_file_path).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        
        // Make executable
        let mut perms = fs::metadata(&desktop_file_path).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&desktop_file_path, perms).map_err(|e| e.to_string())?;
        
        // Try to update desktop database (optional)
        std::process::Command::new("update-desktop-database")
            .arg(&applications_dir)
            .output()
            .ok();
            
    } else {
        if desktop_file_path.exists() {
            fs::remove_file(&desktop_file_path).map_err(|e| e.to_string())?;
            
             std::process::Command::new("update-desktop-database")
            .arg(&applications_dir)
            .output()
            .ok();
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub fn check_context_menu() -> bool {
     let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return false,
    };
    let path = std::path::Path::new(&home).join(".local/share/applications/project-manager-context.desktop");
    path.exists()
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
#[tauri::command]
pub fn set_context_menu(_enable: bool, _locale: String) -> Result<(), String> {
    Err("Not supported on this platform yet. Please use 'Open With' system configuration.".to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
#[tauri::command]
pub fn check_context_menu() -> bool {
    false
}

#[tauri::command]
pub fn is_context_menu_supported() -> bool {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        true
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
fn list_used_ports_windows() -> Result<Vec<PortEntry>, String> {
    let ports_script = r#"
    $ports = @()
    $ports += Get-NetTCPConnection -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{
        Protocol = 'TCP'
        LocalAddress = if ($_.LocalAddress) { $_.LocalAddress.ToString() } else { '' }
        LocalPort = $_.LocalPort
        RemoteAddress = if ($_.RemoteAddress) { $_.RemoteAddress.ToString() } else { '' }
        RemotePort = $_.RemotePort
        State = if ($_.State) { $_.State.ToString() } else { 'UNKNOWN' }
        OwningProcess = $_.OwningProcess
      }
    }
    $ports += Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{
        Protocol = 'UDP'
        LocalAddress = if ($_.LocalAddress) { $_.LocalAddress.ToString() } else { '' }
        LocalPort = $_.LocalPort
        RemoteAddress = ''
        RemotePort = $null
        State = 'LISTEN'
        OwningProcess = $_.OwningProcess
      }
    }
    $ports | Sort-Object Protocol, LocalPort, OwningProcess | ConvertTo-Json -Compress
    "#;
    let ports_raw = run_powershell(ports_script)?;
    let ports = parse_json_rows::<WindowsPortRow>(&ports_raw)?;

    let processes_script = r#"
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      ForEach-Object {
        [pscustomobject]@{
          ProcessId = $_.ProcessId
          Name = if ($_.Name) { $_.Name.ToString() } else { '' }
          ExecutablePath = if ($_.ExecutablePath) { $_.ExecutablePath.ToString() } else { '' }
          CommandLine = if ($_.CommandLine) { $_.CommandLine.ToString() } else { '' }
        }
      } |
      ConvertTo-Json -Compress
    "#;
    let processes_raw = run_powershell(processes_script)?;
    let process_map: HashMap<u32, WindowsProcessRow> = parse_json_rows::<WindowsProcessRow>(&processes_raw)?
        .into_iter()
        .map(|process| (process.process_id, process))
        .collect();

    let mut entries: Vec<PortEntry> = ports
        .into_iter()
        .filter_map(|row| {
            let local_port = row.local_port?;
            let pid = row.owning_process;
            let process = pid.and_then(|current_pid| process_map.get(&current_pid));

            Some(PortEntry {
                protocol: row.protocol.unwrap_or_else(|| "TCP".to_string()),
                local_address: row.local_address.unwrap_or_else(|| "0.0.0.0".to_string()),
                local_port,
                remote_address: row
                    .remote_address
                    .and_then(|value| if value.is_empty() { None } else { Some(value) }),
                remote_port: row.remote_port,
                state: row.state.unwrap_or_else(|| "UNKNOWN".to_string()).to_uppercase(),
                pid,
                process_name: process.and_then(|item| item.name.clone()),
                executable_path: process.and_then(|item| item.executable_path.clone()),
                command_line: process.and_then(|item| item.command_line.clone()),
            })
        })
        .collect();

    entries.sort_by(|left, right| {
        left.local_port
            .cmp(&right.local_port)
            .then(left.protocol.cmp(&right.protocol))
            .then(left.pid.unwrap_or_default().cmp(&right.pid.unwrap_or_default()))
            .then(left.local_address.cmp(&right.local_address))
    });

    Ok(entries)
}

#[cfg(target_os = "linux")]
fn list_used_ports_linux() -> Result<Vec<PortEntry>, String> {
    // Use `ss` command: ss -tunap
    let output = Command::new("ss")
        .args(["-tunap"])
        .output()
        .map_err(|e| format!("Failed to run ss: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ss command failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<PortEntry> = Vec::new();

    for line in stdout.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }

        let protocol = match parts[0].to_uppercase().as_str() {
            "tcp" | "tcp6" => "TCP".to_string(),
            "udp" | "udp6" => "UDP".to_string(),
            _ => continue,
        };

        let state = match parts[1] {
            "LISTEN" => "LISTEN".to_string(),
            "ESTAB" => "ESTABLISHED".to_string(),
            "TIME-WAIT" => "TIME_WAIT".to_string(),
            "CLOSE-WAIT" => "CLOSE_WAIT".to_string(),
            "SYN-SENT" => "SYN_SENT".to_string(),
            "SYN-RECV" => "SYN_RECV".to_string(),
            "FIN-WAIT-1" => "FIN_WAIT_1".to_string(),
            "FIN-WAIT-2" => "FIN_WAIT_2".to_string(),
            "LAST-ACK" => "LAST_ACK".to_string(),
            "CLOSING" => "CLOSING".to_string(),
            "UNCONN" => "LISTEN".to_string(),
            other => other.to_uppercase(),
        };

        let (local_address, local_port) = parse_ss_endpoint(parts[4]);
        let (remote_address, remote_port) = if parts.len() > 5 {
            let (addr, port) = parse_ss_endpoint(parts[5]);
            (Some(addr).filter(|a| !a.is_empty() && a != "*"), port)
        } else {
            (None, None)
        };

        // Parse process info from the last field, e.g. users:(("node",pid=1234,fd=5))
        let (pid, process_name) = if let Some(users_field) = parts.iter().find(|p| p.starts_with("users:")) {
            parse_ss_users(users_field)
        } else {
            (None, None)
        };

        let executable_path = pid.and_then(|p| {
            std::fs::read_link(format!("/proc/{}/exe", p))
                .ok()
                .map(|pb| pb.to_string_lossy().to_string())
        });

        let command_line = pid.and_then(|p| {
            std::fs::read_to_string(format!("/proc/{}/cmdline", p))
                .ok()
                .map(|s| s.replace('\0', " ").trim().to_string())
        });

        entries.push(PortEntry {
            protocol,
            local_address,
            local_port: local_port.unwrap_or(0),
            remote_address,
            remote_port,
            state,
            pid,
            process_name,
            executable_path,
            command_line,
        });
    }

    entries.sort_by(|a, b| {
        a.local_port.cmp(&b.local_port)
            .then(a.protocol.cmp(&b.protocol))
            .then(a.pid.unwrap_or(0).cmp(&b.pid.unwrap_or(0)))
    });

    Ok(entries)
}

#[cfg(target_os = "linux")]
fn parse_ss_endpoint(s: &str) -> (String, Option<u16>) {
    // Format: addr:port or [::1]:port or *:*
    if s == "*:*" {
        return ("*".to_string(), None);
    }
    if let Some(bracket_end) = s.rfind("]:") {
        let addr = &s[1..bracket_end];
        let port = s[bracket_end + 2..].parse::<u16>().ok();
        (addr.to_string(), port)
    } else if let Some(colon) = s.rfind(':') {
        let addr = &s[..colon];
        let port_str = &s[colon + 1..];
        if port_str == "*" {
            (addr.to_string(), None)
        } else {
            let port = port_str.parse::<u16>().ok();
            (addr.to_string(), port)
        }
    } else {
        (s.to_string(), None)
    }
}

#[cfg(target_os = "linux")]
fn parse_ss_users(field: &str) -> (Option<u32>, Option<String>) {
    // Format: users:(("name",pid=123,fd=4))
    let mut pid = None;
    let mut name = None;

    if let Some(start) = field.find("((") {
        let inner = &field[start + 2..];
        if let Some(end) = inner.find("))") {
            let content = &inner[..end];
            let parts: Vec<&str> = content.split(',').collect();
            if !parts.is_empty() {
                name = Some(parts[0].trim_matches('"').to_string());
            }
            for part in &parts {
                let trimmed = part.trim();
                if let Some(pid_str) = trimmed.strip_prefix("pid=") {
                    pid = pid_str.parse::<u32>().ok();
                }
            }
        }
    }

    (pid, name)
}

#[cfg(target_os = "macos")]
fn list_used_ports_macos() -> Result<Vec<PortEntry>, String> {
    // Use lsof -i -n -P on macOS
    let output = Command::new("lsof")
        .args(["-i", "-n", "-P", "-F", "pcnPtTf"])
        .output()
        .map_err(|e| format!("Failed to run lsof: {}", e))?;

    if !output.status.success() {
        // lsof may return 1 if no files found, which is ok
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.is_empty() && !output.stdout.is_empty() {
            // partial success
        } else if output.stdout.is_empty() {
            return Ok(Vec::new());
        }
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<PortEntry> = Vec::new();

    let mut current_pid: Option<u32> = None;
    let mut current_process_name: Option<String> = None;
    let mut current_protocol: Option<String> = None;
    let mut current_state: Option<String> = None;
    let mut current_name: Option<String> = None;

    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }

        let field_type = &line[..1];
        let value = &line[1..];

        match field_type {
            "p" => {
                current_pid = value.parse::<u32>().ok();
                current_process_name = None;
                current_protocol = None;
                current_state = None;
                current_name = None;
            }
            "c" => {
                current_process_name = Some(value.to_string());
            }
            "P" => {
                current_protocol = Some(value.to_uppercase());
            }
            "t" => {
                current_protocol = Some(value.to_uppercase());
            }
            "T" => {
                // TST=LISTEN etc.
                if let Some(st) = value.strip_prefix("ST=") {
                    current_state = Some(match st {
                        "LISTEN" => "LISTEN".to_string(),
                        "ESTABLISHED" => "ESTABLISHED".to_string(),
                        "TIME_WAIT" => "TIME_WAIT".to_string(),
                        "CLOSE_WAIT" => "CLOSE_WAIT".to_string(),
                        "SYN_SENT" => "SYN_SENT".to_string(),
                        "SYN_RECEIVED" => "SYN_RECV".to_string(),
                        "FIN_WAIT_1" => "FIN_WAIT_1".to_string(),
                        "FIN_WAIT_2" => "FIN_WAIT_2".to_string(),
                        "LAST_ACK" => "LAST_ACK".to_string(),
                        "CLOSING" => "CLOSING".to_string(),
                        other => other.to_uppercase(),
                    });
                }
            }
            "n" => {
                current_name = Some(value.to_string());
            }
            "f" => {
                // A new file descriptor line: emit previous entry if we have a valid name
                if let Some(ref name_str) = current_name {
                    if name_str.contains("->") || name_str.contains(':') {
                        if let Some(entry) = build_lsof_entry(
                            name_str,
                            &current_protocol,
                            &current_state,
                            current_pid,
                            &current_process_name,
                        ) {
                            entries.push(entry);
                        }
                    }
                }
                // Reset per-fd fields
                current_protocol = None;
                current_state = None;
                current_name = None;
            }
            _ => {}
        }
    }

    // Emit last entry
    if let Some(ref name_str) = current_name {
        if name_str.contains("->") || name_str.contains(':') {
            if let Some(entry) = build_lsof_entry(
                name_str,
                &current_protocol,
                &current_state,
                current_pid,
                &current_process_name,
            ) {
                entries.push(entry);
            }
        }
    }

    // Get executable paths for all unique PIDs
    let unique_pids: Vec<u32> = entries.iter().filter_map(|e| e.pid).collect::<std::collections::HashSet<_>>().into_iter().collect();
    let mut exe_map: HashMap<u32, (Option<String>, Option<String>)> = HashMap::new();

    for pid in unique_pids {
        let exe_path = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() { None } else { Some(s) }
                } else {
                    None
                }
            });
        let cmd_line = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() { None } else { Some(s) }
                } else {
                    None
                }
            });
        exe_map.insert(pid, (exe_path, cmd_line));
    }

    for entry in &mut entries {
        if let Some(pid) = entry.pid {
            if let Some((exe, cmd)) = exe_map.get(&pid) {
                entry.executable_path = exe.clone();
                entry.command_line = cmd.clone();
            }
        }
    }

    entries.sort_by(|a, b| {
        a.local_port.cmp(&b.local_port)
            .then(a.protocol.cmp(&b.protocol))
            .then(a.pid.unwrap_or(0).cmp(&b.pid.unwrap_or(0)))
    });

    Ok(entries)
}

#[cfg(target_os = "macos")]
fn build_lsof_entry(
    name: &str,
    protocol: &Option<String>,
    state: &Option<String>,
    pid: Option<u32>,
    process_name: &Option<String>,
) -> Option<PortEntry> {
    let proto = protocol.as_deref().unwrap_or("TCP").to_string();
    let default_state = if proto == "UDP" { "LISTEN" } else { "UNKNOWN" };

    // name format: "local_addr:port->remote_addr:port" or "local_addr:port" or "*:port"
    if let Some(arrow_pos) = name.find("->") {
        let local = &name[..arrow_pos];
        let remote = &name[arrow_pos + 2..];
        let (local_addr, local_port) = parse_lsof_endpoint(local)?;
        let (remote_addr, remote_port) = parse_lsof_endpoint(remote)
            .map(|(a, p)| (Some(a), Some(p)))
            .unwrap_or((None, None));

        Some(PortEntry {
            protocol: proto,
            local_address: local_addr,
            local_port,
            remote_address: remote_addr,
            remote_port,
            state: state.clone().unwrap_or_else(|| default_state.to_string()),
            pid,
            process_name: process_name.clone(),
            executable_path: None,
            command_line: None,
        })
    } else {
        let (local_addr, local_port) = parse_lsof_endpoint(name)?;
        Some(PortEntry {
            protocol: proto,
            local_address: local_addr,
            local_port,
            remote_address: None,
            remote_port: None,
            state: state.clone().unwrap_or_else(|| default_state.to_string()),
            pid,
            process_name: process_name.clone(),
            executable_path: None,
            command_line: None,
        })
    }
}

#[cfg(target_os = "macos")]
fn parse_lsof_endpoint(s: &str) -> Option<(String, u16)> {
    // Format: addr:port, [::1]:port, *:port
    if let Some(bracket_end) = s.rfind("]:") {
        let addr = &s[1..bracket_end];
        let port = s[bracket_end + 2..].parse::<u16>().ok()?;
        Some((addr.to_string(), port))
    } else if let Some(colon) = s.rfind(':') {
        let addr = &s[..colon];
        let port = s[colon + 1..].parse::<u16>().ok()?;
        Some((addr.to_string(), port))
    } else {
        None
    }
}

#[tauri::command]
pub async fn list_used_ports() -> Result<Vec<PortEntry>, String> {
    run_system_task(move || {
        #[cfg(target_os = "windows")]
        { list_used_ports_windows() }
        #[cfg(target_os = "linux")]
        { list_used_ports_linux() }
        #[cfg(target_os = "macos")]
        { list_used_ports_macos() }
        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        { Err("Port management is not supported on this platform".to_string()) }
    }).await?
}

#[cfg(target_os = "windows")]
fn terminate_process_by_pid_impl(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to terminate process {}: {}", pid, e))?;

    command_output_to_string(output).map(|_| ())
}

#[cfg(not(target_os = "windows"))]
fn terminate_process_by_pid_impl(pid: u32) -> Result<(), String> {
    let output = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .map_err(|e| format!("Failed to terminate process {}: {}", pid, e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Failed to terminate process {}: {}", pid, stderr))
    }
}

#[tauri::command]
pub async fn terminate_process_by_pid(pid: u32) -> Result<(), String> {
    run_system_task(move || terminate_process_by_pid_impl(pid)).await?
}
