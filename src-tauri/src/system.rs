use std::path::PathBuf;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
