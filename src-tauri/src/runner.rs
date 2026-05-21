use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

/// 包管理器解析结果
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmResolveResult {
    pub available: bool,
    pub command_path: Option<String>,
    pub reason: Option<String>,
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::os::windows::io::AsRawHandle;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "windows")]
struct WindowsJobObject {
    handle: HANDLE,
}

#[cfg(target_os = "windows")]
unsafe impl Send for WindowsJobObject {}
#[cfg(target_os = "windows")]
unsafe impl Sync for WindowsJobObject {}

#[cfg(target_os = "windows")]
impl WindowsJobObject {
    fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!("Failed to create Windows job object: {}", std::io::Error::last_os_error()));
        }

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };

        if result == 0 {
            unsafe { CloseHandle(handle) };
            return Err(format!(
                "Failed to configure Windows job object: {}",
                std::io::Error::last_os_error()
            ));
        }

        Ok(Self { handle })
    }

    fn assign_child(&self, child: &std::process::Child) -> Result<(), String> {
        let process_handle = child.as_raw_handle() as HANDLE;
        let result = unsafe { AssignProcessToJobObject(self.handle, process_handle) };
        if result == 0 {
            return Err(format!(
                "Failed to assign child process to Windows job object: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsJobObject {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { CloseHandle(self.handle) };
        }
    }
}

pub struct ProcessState {
    pub processes: Arc<Mutex<HashMap<String, u32>>>,
    #[cfg(target_os = "windows")]
    job_object: Option<WindowsJobObject>,
}

impl ProcessState {
    pub fn new() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(target_os = "windows")]
            job_object: WindowsJobObject::new()
                .map(Some)
                .unwrap_or_else(|error| {
                    eprintln!("{}", error);
                    None
                }),
        }
    }
}

#[cfg(unix)]
fn spawn_parent_watchdog(child_pid: u32) {
    let parent_pid = std::process::id();
    let script = format!(
        "parent={parent_pid}; target={child_pid}; \
         while kill -0 \"$parent\" 2>/dev/null; do sleep 1; done; \
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

#[cfg(unix)]
fn terminate_process_tree(pid: u32) {
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

pub fn cleanup_processes(state: &ProcessState) {
    let processes = state.processes.clone();
    // Use unwrap_or_else to handle poisoned mutex gracefully, though panic on exit is also acceptable
    // Assign lock result to a variable to ensure correct drop order and avoid "borrowed value does not live long enough" error
    let lock_result = processes.lock();
    if let Ok(mut lock) = lock_result {
        for (id, pid) in lock.iter() {
            println!("Killing process {} (PID: {})", id, pid);
            #[cfg(target_os = "windows")]
            {
                let _ = Command::new("taskkill")
                    .args(&["/PID", &pid.to_string(), "/F", "/T"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
            }
            #[cfg(not(target_os = "windows"))]
            {
                terminate_process_tree(*pid);
            }
        }
        lock.clear();
    }
}

// Log Manager to handle 500 lines limit
struct LogManager {
    file: File,
    buffer: VecDeque<String>,
    lines_since_rewrite: usize,
}

impl LogManager {
    fn new(path: &std::path::Path) -> Result<Self, String> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(true)
            .open(path)
            .map_err(|e| e.to_string())?;

        Ok(Self {
            file,
            buffer: VecDeque::with_capacity(500),
            lines_since_rewrite: 0,
        })
    }

    fn append(&mut self, line: String) {
        // Add to memory buffer
        if self.buffer.len() >= 500 {
            self.buffer.pop_front();
        }
        self.buffer.push_back(line.clone());

        // Append to file
        if let Err(e) = writeln!(self.file, "{}", line) {
            eprintln!("Failed to write to log file: {}", e);
        }
        
        self.lines_since_rewrite += 1;

        // Periodic rewrite to keep file size in check (every 500 new lines)
        if self.lines_since_rewrite >= 500 {
            self.rewrite_file();
            self.lines_since_rewrite = 0;
        }
    }

    fn rewrite_file(&mut self) {
        if let Err(e) = self.file.set_len(0) {
            eprintln!("Failed to truncate log file: {}", e);
            return;
        }
        if let Err(e) = self.file.seek(SeekFrom::Start(0)) {
            eprintln!("Failed to seek log file: {}", e);
            return;
        }
        
        for line in &self.buffer {
            if let Err(e) = writeln!(self.file, "{}", line) {
                eprintln!("Failed to write to log file during rewrite: {}", e);
            }
        }
        
        // Ensure we are back at the end for future appends (though writeln moves cursor, explicit seek is safer if mixed)
        // Actually writeln moves the cursor. set_len(0) + seek(0) + writeln... leaves cursor at end.
    }
}

#[tauri::command]
pub fn run_project_command(
    app: AppHandle,
    state: State<'_, ProcessState>,
    id: String,
    path: String,
    script: String,
    package_manager: String,
    node_path: String,
    command_path: Option<String>,
    pm_node_path: Option<String>,
) -> Result<(), String> {
    let processes = state.processes.clone();
    let mut processes_lock = processes.lock().map_err(|e| e.to_string())?;

    if processes_lock.contains_key(&id) {
        return Err("Project is already running".to_string());
    }

    // Setup Log File
    // Use logs directory relative to executable
    let base_log_dir = if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            parent.join("logs")
        } else {
            app.path().app_log_dir().unwrap_or_else(|_| std::path::PathBuf::from("logs"))
        }
    } else {
        app.path().app_log_dir().unwrap_or_else(|_| std::path::PathBuf::from("logs"))
    };

    // Determine Project Name
    let project_path_buf = std::path::Path::new(&path);
    let mut project_name = project_path_buf
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown_project".to_string());

    // Try to read package.json for a better name
    let pkg_path = project_path_buf.join("package.json");
    if pkg_path.exists() {
        if let Ok(content) = fs::read_to_string(&pkg_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(name) = json.get("name").and_then(|v| v.as_str()) {
                    project_name = name.to_string();
                }
            }
        }
    }

    // Sanitize Project Name for directory
    let safe_project_name = project_name.replace(|c: char| {
        matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }, "_");

    let project_log_dir = base_log_dir.join(&safe_project_name);

    if !project_log_dir.exists() {
        fs::create_dir_all(&project_log_dir).map_err(|e| e.to_string())?;
    }

    // Sanitize script name for filename
    let safe_script = script.replace(|c: char| {
        matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }, "_");
    
    let log_file_path = project_log_dir.join(format!("{}.log", safe_script));

    let log_manager = Arc::new(Mutex::new(LogManager::new(&log_file_path)?));

    // Construct full command and environment
    let full_cmd_str: String;
    let mut command_builder: Command;

    #[cfg(target_os = "windows")]
    {
        let current_path = std::env::var("PATH").unwrap_or_default();
        
        // Handle if node_path is a file (e.g. node.exe) instead of directory
        let mut node_dir_str = node_path.clone();
        if !node_path.is_empty() {
             let p = std::path::Path::new(&node_path);
             if p.is_file() {
                 if let Some(parent) = p.parent() {
                     node_dir_str = parent.to_string_lossy().to_string();
                 }
             }
        }

        // Ensure node.exe exists (nvm-windows compat for node64.exe)
        if !node_dir_str.is_empty() {
            ensure_node_exe_in_dir(std::path::Path::new(&node_dir_str));
        }

        // 构建 PATH：项目 Node 目录优先，其次 PM 所在 Node 目录（source='default' 时）
        let mut new_path = if !node_dir_str.is_empty() {
            format!("{};{}", node_dir_str, current_path)
        } else {
            current_path.clone()
        };

        // 如果 PM 来自不同的 Node 目录（default source），将其也加入 PATH
        if let Some(ref pm_np) = pm_node_path {
            if !pm_np.is_empty() && pm_np != &node_dir_str {
                new_path = if !node_dir_str.is_empty() {
                    format!("{};{};{}", node_dir_str, pm_np, current_path)
                } else {
                    format!("{};{}", pm_np, current_path)
                };
            }
        }

        // 包管理器路径由前端解析结果明确传入；后端只检查当前 Node 目录，不扫描其它 NVM 版本兜底。
        let node_executable = if !node_dir_str.is_empty() {
            let p = std::path::Path::new(&node_dir_str).join("node.exe");
            format!("\"{}\"", p.to_string_lossy())
        } else {
            "node".to_string()
        };

        let pm_cmd = if let Some(ref cp) = command_path {
            if !cp.is_empty() {
                if package_manager == "npm" && cp.to_ascii_lowercase().ends_with("npm-cli.js") {
                    format!("{} \"{}\"", node_executable, cp)
                } else {
                    cp.clone()
                }
            } else if !node_dir_str.is_empty() {
                let node_dir = std::path::Path::new(&node_dir_str);
                let node_exe_path = node_dir.join("node.exe");
                let npm_cli_js = node_dir
                    .join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js");
                if npm_cli_js.exists() {
                    format!("\"{}\" \"{}\"", node_exe_path.to_string_lossy(), npm_cli_js.to_string_lossy())
                } else {
                    let pm_path_cmd = node_dir.join(format!("{}.cmd", package_manager));
                    if pm_path_cmd.exists() {
                        format!("\"{}\"", pm_path_cmd.to_string_lossy())
                    } else {
                        package_manager.clone()
                    }
                }
            } else {
                if package_manager == "npm" || package_manager == "pnpm" || package_manager == "yarn" {
                    format!("{}.cmd", package_manager)
                } else {
                    package_manager.clone()
                }
            }
        } else if !node_dir_str.is_empty() {
            let node_dir = std::path::Path::new(&node_dir_str);
            let node_exe_path = node_dir.join("node.exe");
            let npm_cli_js = node_dir
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js");
            if npm_cli_js.exists() {
                format!("\"{}\" \"{}\"", node_exe_path.to_string_lossy(), npm_cli_js.to_string_lossy())
            } else {
                let pm_path_cmd = node_dir.join(format!("{}.cmd", package_manager));
                if pm_path_cmd.exists() {
                    format!("\"{}\"", pm_path_cmd.to_string_lossy())
                } else {
                    package_manager.clone()
                }
            }
        } else {
            if package_manager == "npm" || package_manager == "pnpm" || package_manager == "yarn" {
                format!("{}.cmd", package_manager)
            } else {
                package_manager.clone()
            }
        };

        // Quote the script name to handle special characters (e.g. "build:prod")
        full_cmd_str = format!("{} -v && {} run \"{}\"", node_executable, pm_cmd, script);
        
        command_builder = Command::new("cmd");
        command_builder
            .raw_arg(format!(" /C \"{}\"", full_cmd_str))
            .env("PATH", new_path)
            .env_remove("SASS_BINARY_PATH")
            .creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let current_path = std::env::var("PATH").unwrap_or_default();
        
        let mut node_dir_str = node_path.clone();
        if !node_path.is_empty() {
             let p = std::path::Path::new(&node_path);
             // On Unix, nodePath is usually .../bin/node
             if p.is_file() {
                 if let Some(parent) = p.parent() {
                     node_dir_str = parent.to_string_lossy().to_string();
                 }
             } else if !p.exists() {
                 // Maybe it is a dir but checks failed? Or user provided bad path.
                 // We keep it as is or try to append bin?
                 // Let's assume user might provide version root instead of bin
                 // But for now let's stick to simple file check
             }
        }

        // 构建 PATH：项目 Node 目录优先，其次 PM 所在 Node 目录（source='default' 时）
        let mut new_path = if !node_dir_str.is_empty() {
            format!("{}:{}", node_dir_str, current_path)
        } else {
            current_path.clone()
        };

        // 如果 PM 来自不同的 Node 目录（default source），将其也加入 PATH
        if let Some(ref pm_np) = pm_node_path {
            if !pm_np.is_empty() && pm_np != &node_dir_str {
                new_path = if !node_dir_str.is_empty() {
                    format!("{}:{}:{}", node_dir_str, pm_np, current_path)
                } else {
                    format!("{}:{}", pm_np, current_path)
                };
            }
        }

        // If command_path is explicitly provided (from frontend PM resolution), use it directly
        let node_executable = if !node_dir_str.is_empty() {
            let p = std::path::Path::new(&node_dir_str).join("node");
            format!("\"{}\"", p.to_string_lossy())
        } else {
            "node".to_string()
        };

        let pm_cmd = if let Some(ref cp) = command_path {
            if !cp.is_empty() {
                if package_manager == "npm" && cp.ends_with("npm-cli.js") {
                    format!("{} \"{}\"", node_executable, cp)
                } else {
                    cp.clone()
                }
            } else if !node_dir_str.is_empty() {
                let node_dir = std::path::Path::new(&node_dir_str);
                let npm_cli_js_bin = node_dir
                    .join("node_modules")
                    .join("npm")
                    .join("bin")
                    .join("npm-cli.js");
                let npm_cli_js_lib = node_dir
                    .parent()
                    .map(|p| p.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"))
                    .unwrap_or_else(|| std::path::PathBuf::from(""));
                if npm_cli_js_bin.exists() {
                    format!("\"{}\" \"{}\"", node_dir.join("node").to_string_lossy(), npm_cli_js_bin.to_string_lossy())
                } else if npm_cli_js_lib.exists() {
                    format!("\"{}\" \"{}\"", node_dir.join("node").to_string_lossy(), npm_cli_js_lib.to_string_lossy())
                } else {
                    package_manager.clone()
                }
            } else {
                package_manager.clone()
            }
        } else if !node_dir_str.is_empty() {
            let node_dir = std::path::Path::new(&node_dir_str);
            let npm_cli_js_bin = node_dir
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js");
            let npm_cli_js_lib = node_dir
                .parent()
                .map(|p| p.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"))
                .unwrap_or_else(|| std::path::PathBuf::from(""));
            if npm_cli_js_bin.exists() {
                format!("\"{}\" \"{}\"", node_dir.join("node").to_string_lossy(), npm_cli_js_bin.to_string_lossy())
            } else if npm_cli_js_lib.exists() {
                format!("\"{}\" \"{}\"", node_dir.join("node").to_string_lossy(), npm_cli_js_lib.to_string_lossy())
            } else {
                package_manager.clone()
            }
        } else {
            package_manager.clone()
        };

        full_cmd_str = format!("{} -v && {} run \"{}\"", node_executable, pm_cmd, script);

        command_builder = Command::new("sh");
        command_builder
            .arg("-c")
            .arg(&full_cmd_str)
            .env("PATH", new_path);
    }

    // Common Env Vars
    // Check if Node version < 17 (legacy provider check)
    let use_legacy_provider = !node_path.contains("v14.")
        && !node_path.contains("v16.")
        && !node_path.contains("v12.")
        && !node_path.contains("v10.");

    if use_legacy_provider {
        command_builder.env("NODE_OPTIONS", "--openssl-legacy-provider");
    } else {
        command_builder.env_remove("NODE_OPTIONS");
    }

    command_builder
        .current_dir(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    command_builder.process_group(0);

    // Emit initial log
    let _ = app.emit(
        "project-output",
        serde_json::json!({
            "id": id,
            "type": "stdout",
            "data": format!("Executing: {}", full_cmd_str)
        }),
    );

    if let Ok(mut manager) = log_manager.lock() {
        manager.append(format!("Executing: {}", full_cmd_str));
    }

    let mut child = command_builder.spawn().map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    if let Some(job_object) = &state.job_object {
        if let Err(error) = job_object.assign_child(&child) {
            eprintln!("{}", error);
        }
    }

    let pid = child.id();

    #[cfg(unix)]
    spawn_parent_watchdog(pid);

    processes_lock.insert(id.clone(), pid);
    drop(processes_lock);

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let id_clone1 = id.clone();
    let app_clone1 = app.clone();
    let log_manager1 = log_manager.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        while let Ok(n) = reader.read_until(b'\n', &mut buf) {
            if n == 0 { break; }
            let line = String::from_utf8_lossy(&buf);
            let line_str = line.trim_end();

            let _ = app_clone1.emit(
                "project-output",
                serde_json::json!({
                    "id": id_clone1,
                    "type": "stdout",
                    "data": line_str
                }),
            );

            if let Ok(mut manager) = log_manager1.lock() {
                manager.append(line_str.to_string());
            }
            buf.clear();
        }
    });

    let id_clone2 = id.clone();
    let app_clone2 = app.clone();
    let log_manager2 = log_manager.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        while let Ok(n) = reader.read_until(b'\n', &mut buf) {
            if n == 0 { break; }
            let line = String::from_utf8_lossy(&buf);
            let line_str = line.trim_end();

            let _ = app_clone2.emit(
                "project-output",
                serde_json::json!({
                    "id": id_clone2,
                    "type": "stderr",
                    "data": line_str
                }),
            );

            if let Ok(mut manager) = log_manager2.lock() {
                manager.append(format!("ERR: {}", line_str));
            }
            buf.clear();
        }
    });

    let id_clone3 = id.clone();
    let app_clone3 = app.clone();
    let processes_clone = state.processes.clone();
    let log_manager3 = log_manager.clone();
    thread::spawn(move || {
        let _ = child.wait();
        if let Ok(mut lock) = processes_clone.lock() {
            lock.remove(&id_clone3);
        }
        
        // Final rewrite to ensure exact 500 lines at end
        if let Ok(mut manager) = log_manager3.lock() {
            manager.rewrite_file();
        }

        let _ = app_clone3.emit(
            "project-exit",
            serde_json::json!({ "id": id_clone3 }),
        );
    });

    Ok(())
}

#[tauri::command]
pub fn stop_project_command(state: State<'_, ProcessState>, id: String) -> Result<(), String> {
    let processes = state.processes.clone();
    let lock = processes.lock().map_err(|e| e.to_string())?;

    if let Some(pid) = lock.get(&id) {
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(&["/PID", &pid.to_string(), "/F", "/T"])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        #[cfg(not(target_os = "windows"))]
        {
            terminate_process_tree(*pid);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn run_custom_command(
    app: AppHandle,
    state: State<'_, ProcessState>,
    id: String,
    path: String,
    command: String,
) -> Result<(), String> {
    let processes = state.processes.clone();
    let mut processes_lock = processes.lock().map_err(|e| e.to_string())?;

    if processes_lock.contains_key(&id) {
        return Err("Command is already running".to_string());
    }

    // Setup Log File
    let base_log_dir = if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            parent.join("logs")
        } else {
            app.path().app_log_dir().unwrap_or_else(|_| std::path::PathBuf::from("logs"))
        }
    } else {
        app.path().app_log_dir().unwrap_or_else(|_| std::path::PathBuf::from("logs"))
    };

    let project_path_buf = std::path::Path::new(&path);
    let project_name = project_path_buf
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown_project".to_string());

    let safe_project_name = project_name.replace(|c: char| {
        matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }, "_");

    let project_log_dir = base_log_dir.join(&safe_project_name);
    if !project_log_dir.exists() {
        fs::create_dir_all(&project_log_dir).map_err(|e| e.to_string())?;
    }

    // Use a hash of the command as filename to avoid path issues
    let safe_cmd = command.replace(|c: char| {
        matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }, "_");
    let log_file_path = project_log_dir.join(format!("custom_{}.log", &safe_cmd[..safe_cmd.len().min(50)]));

    let log_manager = Arc::new(Mutex::new(LogManager::new(&log_file_path)?));

    let mut command_builder: Command;

    #[cfg(target_os = "windows")]
    {
        command_builder = Command::new("cmd");
        command_builder
            .raw_arg(format!(" /C \"{}\"", command))
            .creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(target_os = "windows"))]
    {
        command_builder = Command::new("sh");
        command_builder
            .arg("-c")
            .arg(&command);
    }

    command_builder
        .current_dir(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(unix)]
    command_builder.process_group(0);

    // Emit initial log
    let _ = app.emit(
        "project-output",
        serde_json::json!({
            "id": id,
            "type": "stdout",
            "data": format!("Executing: {}", command)
        }),
    );

    if let Ok(mut manager) = log_manager.lock() {
        manager.append(format!("Executing: {}", command));
    }

    let mut child = command_builder.spawn().map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    if let Some(job_object) = &state.job_object {
        if let Err(error) = job_object.assign_child(&child) {
            eprintln!("{}", error);
        }
    }

    let pid = child.id();

    #[cfg(unix)]
    spawn_parent_watchdog(pid);

    processes_lock.insert(id.clone(), pid);
    drop(processes_lock);

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let id_clone1 = id.clone();
    let app_clone1 = app.clone();
    let log_manager1 = log_manager.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        while let Ok(n) = reader.read_until(b'\n', &mut buf) {
            if n == 0 { break; }
            let line = String::from_utf8_lossy(&buf);
            let line_str = line.trim_end();

            let _ = app_clone1.emit(
                "project-output",
                serde_json::json!({
                    "id": id_clone1,
                    "type": "stdout",
                    "data": line_str
                }),
            );

            if let Ok(mut manager) = log_manager1.lock() {
                manager.append(line_str.to_string());
            }
            buf.clear();
        }
    });

    let id_clone2 = id.clone();
    let app_clone2 = app.clone();
    let log_manager2 = log_manager.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        while let Ok(n) = reader.read_until(b'\n', &mut buf) {
            if n == 0 { break; }
            let line = String::from_utf8_lossy(&buf);
            let line_str = line.trim_end();

            let _ = app_clone2.emit(
                "project-output",
                serde_json::json!({
                    "id": id_clone2,
                    "type": "stderr",
                    "data": line_str
                }),
            );

            if let Ok(mut manager) = log_manager2.lock() {
                manager.append(format!("ERR: {}", line_str));
            }
            buf.clear();
        }
    });

    let id_clone3 = id.clone();
    let app_clone3 = app.clone();
    let processes_clone = state.processes.clone();
    let log_manager3 = log_manager.clone();
    thread::spawn(move || {
        let _ = child.wait();
        if let Ok(mut lock) = processes_clone.lock() {
            lock.remove(&id_clone3);
        }

        if let Ok(mut manager) = log_manager3.lock() {
            manager.rewrite_file();
        }

        let _ = app_clone3.emit(
            "project-exit",
            serde_json::json!({ "id": id_clone3 }),
        );
    });

    Ok(())
}

#[tauri::command]
pub fn open_in_editor(path: String, editor: String) -> Result<(), String> {
    let editor = editor.trim().trim_matches('"');
    let editor_cmd = if editor.is_empty() { "code" } else { editor };

    #[cfg(target_os = "windows")]
    Command::new("cmd")
        .args(&["/C", "start", "", editor_cmd, &path])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    Command::new("open")
        .args(&["-a", editor_cmd, &path])
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    Command::new(editor_cmd)
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn get_git_bash_path() -> Option<String> {
    let program_files = std::env::var("ProgramFiles").unwrap_or_default();
    let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();

    let paths = vec![
        format!("{}\\Git\\git-bash.exe", program_files),
        format!("{}\\Git\\git-bash.exe", program_files_x86),
        format!("{}\\Programs\\Git\\git-bash.exe", local_app_data),
    ];

    for path in paths {
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    None
}

/// On Windows, nvm-windows may store the executable as `node64.exe` (or `node32.exe`)
/// instead of `node.exe` for older Node versions. This function ensures a `node.exe`
/// exists in the given directory by creating a hard link when necessary.
#[cfg(target_os = "windows")]
fn ensure_node_exe_in_dir(dir: &std::path::Path) {
    let node_exe = dir.join("node.exe");
    if node_exe.exists() {
        return;
    }
    // Try node64.exe first (most common on 64-bit), then node32.exe
    for alt in &["node64.exe", "node32.exe"] {
        let alt_path = dir.join(alt);
        if alt_path.exists() {
            // Create a hard link so `node` resolves correctly in PATH
            if let Err(e) = fs::hard_link(&alt_path, &node_exe) {
                println!("[nvm-compat] Failed to hard-link {} -> node.exe: {}", alt, e);
                // Fallback: try a copy
                if let Err(e2) = fs::copy(&alt_path, &node_exe) {
                    println!("[nvm-compat] Failed to copy {} -> node.exe: {}", alt, e2);
                }
            }
            return;
        }
    }
}

fn resolve_terminal_node_dir(node_path: &str) -> Option<String> {
    let trimmed = node_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let path = std::path::Path::new(trimmed);
    if path.is_file() {
        return path.parent().map(|parent| parent.to_string_lossy().to_string());
    }

    if path.is_dir() {
        #[cfg(target_os = "windows")]
        {
            ensure_node_exe_in_dir(path);
            if path.join("node.exe").exists() {
                return Some(trimmed.to_string());
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if path.join("node").exists() {
                return Some(trimmed.to_string());
            }
        }

        let bin_dir = path.join("bin");
        #[cfg(target_os = "windows")]
        if bin_dir.is_dir() {
            ensure_node_exe_in_dir(&bin_dir);
            if bin_dir.join("node.exe").exists() {
                return Some(bin_dir.to_string_lossy().to_string());
            }
        }

        #[cfg(not(target_os = "windows"))]
        if bin_dir.join("node").exists() {
            return Some(bin_dir.to_string_lossy().to_string());
        }
    }

    Some(trimmed.to_string())
}

/// 判断某个 PATH 目录是否包含 Node/npm 相关工具入口。
/// 用于过滤原始 PATH 中其它 Node 版本的目录，防止 npm/npx 等命中错误的 Node。
fn dir_has_node_tools(dir: &str) -> bool {
    let p = std::path::Path::new(dir);
    if !p.is_dir() {
        return false;
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: 检查 node.exe / npm.cmd / npm.exe / npx.cmd / pnpm.cmd / yarn.cmd / cnpm.cmd
        let names = [
            "node.exe", "npm.cmd", "npm.exe", "npx.cmd",
            "pnpm.cmd", "yarn.cmd", "cnpm.cmd",
        ];
        names.iter().any(|n| p.join(n).exists())
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Unix: 检查 node / npm / npx / pnpm / yarn / cnpm
        let names = ["node", "npm", "npx", "pnpm", "yarn", "cnpm"];
        names.iter().any(|n| p.join(n).exists())
    }
}

/// 从 PATH 中过滤掉 Node/npm 工具目录，仅保留普通目录。
fn filter_path_entries(node_dir: &str, path_value: &str) -> String {
    #[cfg(target_os = "windows")]
    let separator = ";";
    #[cfg(not(target_os = "windows"))]
    let separator = ":";

    let node_dir_normalized = normalize_path_str(node_dir);

    let filtered: Vec<&str> = path_value
        .split(separator)
        .filter(|entry| {
            let entry_trimmed = entry.trim();
            if entry_trimmed.is_empty() {
                return false;
            }
            // 当前项目 nodeDir 会在最终 PATH 最前面单独注入，这里跳过避免重复。
            if normalize_path_str(entry_trimmed) == node_dir_normalized {
                return false;
            }
            // 含有 Node/npm 工具入口的目录 → 过滤
            if dir_has_node_tools(entry_trimmed) {
                return false;
            }
            // 普通目录 → 保留
            true
        })
        .collect();

    filtered.join(separator)
}

/// 标准化路径字符串用于比较（小写 + 统一分隔符，仅 Windows 需要）
fn normalize_path_str(s: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        s.to_lowercase().replace('/', "\\").trim_end_matches('\\').to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        s.trim_end_matches('/').to_string()
    }
}

fn build_terminal_path_env(node_path: &str) -> Option<String> {
    let node_dir = resolve_terminal_node_dir(node_path)?;
    let current_path = std::env::var("PATH").unwrap_or_default();

    #[cfg(target_os = "windows")]
    let separator = ";";
    #[cfg(not(target_os = "windows"))]
    let separator = ":";

    // 打开终端只注入项目 Node 路径，不再扫描其它 NVM 目录兜底包管理器。
    // 同时过滤原始 PATH 中其它 Node/npm 目录，避免 npm 版本错配。
    let filtered = filter_path_entries(&node_dir, &current_path);

    if filtered.is_empty() {
        node_dir.clone()
    } else {
        format!("{}{}{}", node_dir, separator, filtered)
    }
    .into()
}

#[cfg(target_os = "windows")]
fn escape_for_cmd_double_quotes(value: &str) -> String {
    value.replace('"', "\"\"")
}

#[cfg(target_os = "windows")]
fn escape_for_powershell_single_quotes(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn escape_for_bash_single_quotes(value: &str) -> String {
    value.replace('\'', "'\\''")
}

/// 解析项目 Node 目录下是否存在可用的 npm-cli.js（用于绕过被损坏的 npm.cmd / npm 软链）。
/// 在 nvm-windows 等环境下，npm.cmd 内部会指向 `%~dp0\node_modules\npm`，若该目录被其它版本的 junction 覆盖，
/// 直接 `npm -v` 会加载错误版本的 npm-cli.js。这里给出 npm-cli.js 的真实路径，让上层用 `node "<abs>" -v` 绕过。
fn resolve_npm_cli_js(node_dir: &str) -> Option<String> {
    if node_dir.is_empty() {
        return None;
    }
    let p = std::path::Path::new(node_dir);

    let primary = p.join("node_modules").join("npm").join("bin").join("npm-cli.js");
    if primary.exists() {
        return Some(primary.to_string_lossy().to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some(parent) = p.parent() {
            let lib_cli = parent
                .join("lib")
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js");
            if lib_cli.exists() {
                return Some(lib_cli.to_string_lossy().to_string());
            }
        }
    }

    None
}

#[derive(Clone, Copy)]
enum StartupShell {
    PowerShell,
    Cmd,
    Bash,
}

/// 构造打开终端时的版本检查命令，例如：`node -v && npm -v` 或 `node -v ; node "C:/.../npm-cli.js" -v`。
/// - 对 npm：若项目 Node 目录下能定位到 npm-cli.js 的真实路径，则用 `node "<abs>" -v` 直接调用，绕过 npm.cmd 软链问题。
/// - 其它 PM：使用 `<pm> -v`，依赖 PATH 已被注入为项目 Node 目录。
/// - 包管理器为空：仅输出 `node -v`。
fn build_startup_check(node_dir: &str, package_manager: &str, shell: StartupShell) -> String {
    let pm = package_manager.trim();
    let sep = match shell {
        StartupShell::PowerShell => "; ",
        StartupShell::Cmd => " && ",
        StartupShell::Bash => " && ",
    };

    if pm.is_empty() {
        return "node -v".to_string();
    }

    // 仅对 npm 做绝对路径绕过
    if pm.eq_ignore_ascii_case("npm") {
        if let Some(cli) = resolve_npm_cli_js(node_dir) {
            let cli_quoted = match shell {
                StartupShell::PowerShell => format!("'{}'", cli.replace('\'', "''")),
                StartupShell::Cmd => {
                    // CMD 下需要把单个 " 转义为 ""（在 cmd /C "..." 包裹中），上层会再做一层 escape_for_cmd_double_quotes
                    format!("\"{}\"", cli)
                }
                StartupShell::Bash => format!("'{}'", cli.replace('\'', "'\\''")),
            };
            return format!("node -v{}node {} -v", sep, cli_quoted);
        }
    }

    format!("node -v{}{} -v", sep, pm)
}

/// 构造 shell 别名命令，让用户手敲 `npm` 直接调用项目 Node 目录下的真实 npm-cli.js，
/// 绕过 npm.cmd（在 nvm-windows 软链损坏时会加载错版本的 npm-cli.js）。
/// 仅对 npm 生效；其它 PM 走 PATH 解析。
fn build_pm_alias(node_dir: &str, package_manager: &str, shell: StartupShell) -> String {
    let pm = package_manager.trim();
    if pm.is_empty() || !pm.eq_ignore_ascii_case("npm") {
        return String::new();
    }
    let cli = match resolve_npm_cli_js(node_dir) {
        Some(c) => c,
        None => return String::new(),
    };

    match shell {
        // PowerShell function 覆盖；$args 自动转发参数
        StartupShell::PowerShell => format!("function npm {{ node '{}' @args }}", cli.replace('\'', "''")),
        // CMD doskey 宏；$* 是 doskey 的全部参数占位符
        StartupShell::Cmd => format!("doskey npm=node \"{}\" $*", cli),
        // Bash/Git-Bash function
        StartupShell::Bash => format!("npm() {{ node '{}' \"$@\"; }}", cli.replace('\'', "'\\''")),
    }
}

/// 拼接 [别名 + 版本检查]：别名先生效，使后续 `npm` 也走正确 cli.js。
fn build_startup_script(node_dir: &str, package_manager: &str, shell: StartupShell) -> String {
    let alias = build_pm_alias(node_dir, package_manager, shell);
    let check = build_startup_check(node_dir, package_manager, shell);
    if alias.is_empty() {
        return check;
    }
    let sep = match shell {
        StartupShell::PowerShell => "; ",
        StartupShell::Cmd => " && ",
        StartupShell::Bash => " && ",
    };
    format!("{}{}{}", alias, sep, check)
}

#[tauri::command]
pub fn open_in_terminal(path: String, terminal: String, node_path: String, package_manager: String) -> Result<(), String> {
    let resolved_node_dir = resolve_terminal_node_dir(&node_path).unwrap_or_default();
    #[cfg(target_os = "windows")]
    let startup_check_ps = build_startup_script(&resolved_node_dir, &package_manager, StartupShell::PowerShell);
    #[cfg(target_os = "windows")]
    let startup_check_cmd = build_startup_script(&resolved_node_dir, &package_manager, StartupShell::Cmd);
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let startup_check_bash = build_startup_script(&resolved_node_dir, &package_manager, StartupShell::Bash);
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = &resolved_node_dir;

    let terminal = terminal.trim().to_string();
    let terminal_key = terminal.to_lowercase();
    let terminal_path_env = build_terminal_path_env(&node_path);

    #[cfg(target_os = "windows")]
    {
        let win_path = path.replace('/', "\\");
        let win_path_cmd = escape_for_cmd_double_quotes(&win_path);
        let path_env_cmd = terminal_path_env
            .as_ref()
            .map(|value| escape_for_cmd_double_quotes(value));
        let win_path_ps = escape_for_powershell_single_quotes(&win_path);
        let path_env_ps = terminal_path_env
            .as_ref()
            .map(|value| escape_for_powershell_single_quotes(value));

        let terminal_executable_name = std::path::Path::new(&terminal)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&terminal)
            .to_lowercase();
        let is_custom_executable = terminal.contains('\\') || terminal.contains('/') || terminal_key.ends_with(".exe");
        let is_windows_powershell = terminal_key == "powershell"
            || terminal_key == "powershell.exe"
            || terminal_executable_name == "powershell.exe";
        let is_pwsh = terminal_key == "pwsh"
            || terminal_key == "pwsh.exe"
            || terminal_executable_name == "pwsh.exe";

        match terminal_key.as_str() {
            _ if is_windows_powershell => {
                let startup_script = if let Some(path_env) = &path_env_ps {
                    format!("$env:PATH='{}'; Set-Location '{}'; {}", path_env, win_path_ps, startup_check_ps)
                } else {
                    format!("Set-Location '{}'; {}", win_path_ps, startup_check_ps)
                };
                let executable = if is_custom_executable { terminal.as_str() } else { "powershell" };
                let mut command = Command::new("cmd");
                command.args(["/C", "start", "", executable, "-NoExit", "-Command", &startup_script]);
                command.spawn().map_err(|e| e.to_string())?;
            }
            _ if is_pwsh => {
                let startup_script = if let Some(path_env) = &path_env_ps {
                    format!("$env:PATH='{}'; Set-Location '{}'; {}", path_env, win_path_ps, startup_check_ps)
                } else {
                    format!("Set-Location '{}'; {}", win_path_ps, startup_check_ps)
                };
                let executable = if is_custom_executable { terminal.as_str() } else { "pwsh" };
                let mut command = Command::new("cmd");
                command.args(["/C", "start", "", executable, "-NoExit", "-Command", &startup_script]);
                command.spawn().map_err(|e| e.to_string())?;
            }
            "windows-terminal" => {
                let mut command = Command::new("wt");
                if let Some(path_env) = &path_env_cmd {
                    let startup_command = format!("set \"PATH={}\" && cd /d \"{}\" && {}", path_env, win_path_cmd, startup_check_cmd);
                    command.args(["-d", &win_path, "cmd", "/K", &startup_command]);
                } else {
                    command.args(["-d", &win_path, "cmd", "/K", startup_check_cmd.as_str()]);
                }
                command.spawn().map_err(|e| e.to_string())?;
            }
            "git-bash" => {
                if let Some(git_bash_path) = get_git_bash_path() {
                    let mut command = Command::new("cmd");
                    command.args(["/C", "start", "", &git_bash_path, &format!("--cd={}", win_path)]);
                    if let Some(path_env) = &path_env_cmd {
                        command.env("PATH", path_env);
                    }
                    command.spawn().map_err(|e| e.to_string())?;
                } else {
                    // Fallback: try to run bash in a new CMD window that stays open if bash fails
                    let mut command = Command::new("cmd");
                    let bash_inner = format!("{}; exec bash", startup_check_bash);
                    let startup_command = if let Some(path_env) = &path_env_cmd {
                        format!("set \"PATH={}\" && cd /d \"{}\" && bash -c \"{}\"", path_env, win_path_cmd, bash_inner.replace('"', "\\\""))
                    } else {
                        format!("cd /d \"{}\" && bash -c \"{}\"", win_path_cmd, bash_inner.replace('"', "\\\""))
                    };
                    command.args(["/K", &startup_command]);
                    command.spawn().map_err(|e| e.to_string())?;
                }
            }
            "cmder" => {
                let mut command = Command::new("cmd");
                let startup_command = if let Some(path_env) = &path_env_cmd {
                    format!("set \"PATH={}\" && cd /d \"{}\" && cmder && {}", path_env, win_path_cmd, startup_check_cmd)
                } else {
                    format!("cd /d \"{}\" && cmder && {}", win_path_cmd, startup_check_cmd)
                };
                command.args(["/C", "start", "", "cmd", "/K", &startup_command]);
                command.spawn().map_err(|e| e.to_string())?;
            }
            _ => {
                // Check if terminal is a custom executable path
                if terminal.contains('\\') || terminal.contains('/') || terminal_key.ends_with(".exe") {
                    let mut command = Command::new(&terminal);
                    command.current_dir(&win_path);
                    if let Some(path_env) = &terminal_path_env {
                        command.env("PATH", path_env);
                    }
                    command
                        .spawn()
                        .map_err(|e| format!("Failed to launch custom terminal '{}': {}", terminal, e))?;
                } else {
                    // CMD (Default)
                    let mut command = Command::new("cmd");
                    let startup_command = if let Some(path_env) = &path_env_cmd {
                        format!("set \"PATH={}\" && cd /d \"{}\" && {}", path_env, win_path_cmd, startup_check_cmd)
                    } else {
                        format!("cd /d \"{}\" && {}", win_path_cmd, startup_check_cmd)
                    };
                    command.args(["/C", "start", "", "cmd", "/K", &startup_command]);
                    command.spawn().map_err(|e| e.to_string())?;
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        match terminal_key.as_str() {
            "iterm2" => {
                let mut command = Command::new("open");
                command.args(&["-a", "iTerm", &path]);
                if let Some(path_env) = &terminal_path_env {
                    command.env("PATH", path_env);
                }
                command.spawn().map_err(|e| e.to_string())?;
            }
            _ => {
                if terminal.contains('/') {
                    let mut command = Command::new(&terminal);
                    command.current_dir(&path);
                    if let Some(path_env) = &terminal_path_env {
                        command.env("PATH", path_env);
                    }
                    command
                        .spawn()
                        .map_err(|e| format!("Failed to launch custom terminal '{}': {}", terminal, e))?;
                } else {
                    let mut command = Command::new("open");
                    command.args(&["-a", "Terminal", &path]);
                    if let Some(path_env) = &terminal_path_env {
                        command.env("PATH", path_env);
                    }
                    command.spawn().map_err(|e| e.to_string())?;
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let bash_inner = format!("{}; exec bash", startup_check_bash);
        let shell_command = format!("cd '{}' ; {} ; exec bash", path.replace('\'', "'\\''"), startup_check_bash);
        let xfce_inline = format!("bash -c '{}'", bash_inner.replace('\'', "'\\''"));
        match terminal_key.as_str() {
            "gnome-terminal" => {
                let mut command = Command::new("gnome-terminal");
                command.args(&["--working-directory", &path, "--", "bash", "-c", &bash_inner]);
                if let Some(path_env) = &terminal_path_env {
                    command.env("PATH", path_env);
                }
                command.spawn().map_err(|e| e.to_string())?;
            }
            "konsole" => {
                let mut command = Command::new("konsole");
                command.args(&["--workdir", &path, "-e", "bash", "-c", &bash_inner]);
                if let Some(path_env) = &terminal_path_env {
                    command.env("PATH", path_env);
                }
                command.spawn().map_err(|e| e.to_string())?;
            }
            "xfce4-terminal" => {
                let mut command = Command::new("xfce4-terminal");
                command.args(&["--working-directory", &path, "-e", &xfce_inline]);
                if let Some(path_env) = &terminal_path_env {
                    command.env("PATH", path_env);
                }
                command.spawn().map_err(|e| e.to_string())?;
            }
            "alacritty" => {
                let mut command = Command::new("alacritty");
                command.args(&["--working-directory", &path, "-e", "bash", "-c", &bash_inner]);
                if let Some(path_env) = &terminal_path_env {
                    command.env("PATH", path_env);
                }
                command.spawn().map_err(|e| e.to_string())?;
            }
            "kitty" => {
                let mut command = Command::new("kitty");
                command.args(&["--directory", &path, "bash", "-c", &bash_inner]);
                if let Some(path_env) = &terminal_path_env {
                    command.env("PATH", path_env);
                }
                command.spawn().map_err(|e| e.to_string())?;
            }
            _ => {
                if terminal.contains('/') {
                    let mut command = Command::new(&terminal);
                    command.current_dir(&path);
                    if let Some(path_env) = &terminal_path_env {
                        command.env("PATH", path_env);
                    }
                    command
                        .spawn()
                        .map_err(|e| format!("Failed to launch custom terminal '{}': {}", terminal, e))?;
                } else {
                    let mut command = Command::new("x-terminal-emulator");
                    command.args(&["-e", "bash", "-lc", &shell_command]);
                    if let Some(path_env) = &terminal_path_env {
                        command.env("PATH", path_env);
                    }
                    command.spawn().map_err(|e| e.to_string())?;
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    Command::new("explorer")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("rundll32")
            .args(&["url.dll,FileProtocolHandler", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn install_pm(node_path: String, pm_name: String) -> Result<(), String> {
    let node_dir = resolve_terminal_node_dir(&node_path)
        .ok_or_else(|| "Invalid node path".to_string())?;

    // Build the npm command using the specific Node version's npm
    #[cfg(target_os = "windows")]
    let (cmd_name, cmd_args) = {
        let node_exe = std::path::Path::new(&node_dir).join("node.exe");
        let npm_cli = std::path::Path::new(&node_dir)
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");

        if node_exe.exists() && npm_cli.exists() {
            (
                node_exe.to_string_lossy().to_string(),
                vec![
                    npm_cli.to_string_lossy().to_string(),
                    "install".to_string(),
                    "-g".to_string(),
                    pm_name.clone(),
                ],
            )
        } else {
            (
                "npm".to_string(),
                vec!["install".to_string(), "-g".to_string(), pm_name.clone()],
            )
        }
    };

    #[cfg(not(target_os = "windows"))]
    let (cmd_name, cmd_args) = {
        let node_exe = std::path::Path::new(&node_dir).join("node");
        let npm_cli = std::path::Path::new(&node_dir)
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");

        if node_exe.exists() && npm_cli.exists() {
            (
                node_exe.to_string_lossy().to_string(),
                vec![
                    npm_cli.to_string_lossy().to_string(),
                    "install".to_string(),
                    "-g".to_string(),
                    pm_name.clone(),
                ],
            )
        } else {
            (
                "npm".to_string(),
                vec!["install".to_string(), "-g".to_string(), pm_name.clone()],
            )
        }
    };

    let output = std::process::Command::new(&cmd_name)
        .args(&cmd_args)
        .current_dir(&node_dir)
        .output()
        .map_err(|e| format!("Failed to run npm install: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format!("{}\n{}", stderr, stdout))
    }
}

/// 检查指定 Node 目录下是否安装了指定包管理器。
/// 返回 (found, command_path)。
fn check_pm_in_node_dir(node_dir: &str, pm: &str) -> (bool, Option<String>) {
    let dir = std::path::Path::new(node_dir);
    if !dir.exists() || !dir.is_dir() {
        return (false, None);
    }

    #[cfg(target_os = "windows")]
    {
        // 检查 {pm}.cmd 或 {pm}.exe
        let pm_cmd = dir.join(format!("{}.cmd", pm));
        if pm_cmd.exists() {
            return (true, Some(format!("\"{}\"", pm_cmd.to_string_lossy())));
        }
        let pm_exe = dir.join(format!("{}.exe", pm));
        if pm_exe.exists() {
            return (true, Some(format!("\"{}\"", pm_exe.to_string_lossy())));
        }
        // npm 特殊：node_modules/npm/bin/npm-cli.js
        if pm == "npm" {
            let npm_cli = dir.join("node_modules").join("npm").join("bin").join("npm-cli.js");
            if npm_cli.exists() {
                return (true, Some(npm_cli.to_string_lossy().to_string()));
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // 检查 bin 目录下是否有 pm 可执行文件
        let pm_bin = dir.join(pm);
        if pm_bin.exists() {
            return (true, Some(format!("\"{}\"", pm_bin.to_string_lossy())));
        }
        // npm 特殊：lib/node_modules/npm/bin/npm-cli.js
        if pm == "npm" {
            let npm_cli_bin = dir.join("node_modules").join("npm").join("bin").join("npm-cli.js");
            if npm_cli_bin.exists() {
                return (true, Some(npm_cli_bin.to_string_lossy().to_string()));
            }
            // 检查上级目录的 lib 结构（nvm 安装格式）
            if let Some(parent) = dir.parent() {
                let npm_cli_lib = parent.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js");
                if npm_cli_lib.exists() {
                    return (true, Some(npm_cli_lib.to_string_lossy().to_string()));
                }
            }
        }
    }

    (false, None)
}

/// 解析包管理器可用性。
/// 根据 source 决定在哪个 Node 目录中查找 PM。
#[tauri::command]
pub fn resolve_pm(
    node_path: String,
    default_node_path: String,
    package_manager: String,
    source: String,
) -> Result<PmResolveResult, String> {
    if package_manager.is_empty() {
        return Ok(PmResolveResult {
            available: true,
            command_path: None,
            reason: None,
        });
    }

    let check_path = if source == "default" {
        &default_node_path
    } else {
        &node_path
    };

    if check_path.is_empty() {
        let reason = if source == "default" {
            "default_node_unavailable".to_string()
        } else {
            "project_node_unavailable".to_string()
        };
        // npm 在无 Node 时仍不可用
        return Ok(PmResolveResult {
            available: false,
            command_path: None,
            reason: Some(reason),
        });
    }

    let (found, cmd_path) = check_pm_in_node_dir(check_path, &package_manager);

    if found {
        return Ok(PmResolveResult {
            available: true,
            command_path: cmd_path,
            reason: None,
        });
    }

    let reason = if source == "default" {
        "pm_not_installed_in_default_node".to_string()
    } else {
        "pm_not_installed_in_project_node".to_string()
    };

    Ok(PmResolveResult {
        available: false,
        command_path: None,
        reason: Some(reason),
    })
}
