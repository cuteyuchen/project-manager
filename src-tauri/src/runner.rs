use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

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

        let new_path = if !node_dir_str.is_empty() {
            format!("{};{}", node_dir_str, current_path)
        } else {
            current_path
        };

        // Try to resolve absolute path to package manager if node_path is provided
        let pm_cmd = if !node_dir_str.is_empty() {
            let node_dir = std::path::Path::new(&node_dir_str);
            let npm_cli_js = node_dir
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js");

            if npm_cli_js.exists() {
                format!(
                    "\"{}\" \"{}\"",
                    node_dir
                        .join("node.exe")
                        .to_string_lossy(),
                    npm_cli_js.to_string_lossy()
                )
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

        let node_executable = if !node_dir_str.is_empty() {
            let p = std::path::Path::new(&node_dir_str).join("node.exe");
            format!("\"{}\"", p.to_string_lossy())
        } else {
            "node".to_string()
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

        let new_path = if !node_dir_str.is_empty() {
            format!("{}:{}", node_dir_str, current_path)
        } else {
            current_path
        };

        let pm_cmd = if !node_dir_str.is_empty() {
            let node_dir = std::path::Path::new(&node_dir_str);
            // Check for node_modules/npm/bin/npm-cli.js pattern (common in nvm installs)
            // Note: on Unix nvm, sometimes it's lib/node_modules/npm/bin/npm-cli.js
            // But if node_path is the bin dir, we might need to go up.
            // Let's assume standard nvm structure:
            // bin/node
            // lib/node_modules/npm/bin/npm-cli.js
            
            let npm_cli_js_bin = node_dir
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js");
                
            let npm_cli_js_lib = node_dir
                .parent() // up from bin
                .map(|p| p.join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"))
                .unwrap_or_else(|| std::path::PathBuf::from(""));

            if npm_cli_js_bin.exists() {
                 format!(
                    "\"{}\" \"{}\"",
                    node_dir.join("node").to_string_lossy(),
                    npm_cli_js_bin.to_string_lossy()
                )
            } else if npm_cli_js_lib.exists() {
                 format!(
                    "\"{}\" \"{}\"",
                    node_dir.join("node").to_string_lossy(),
                    npm_cli_js_lib.to_string_lossy()
                )
            } else {
                package_manager.clone()
            }
        } else {
            package_manager.clone()
        };

        let node_executable = if !node_dir_str.is_empty() {
            let p = std::path::Path::new(&node_dir_str).join("node");
            format!("\"{}\"", p.to_string_lossy())
        } else {
            "node".to_string()
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

#[tauri::command]
pub fn open_in_terminal(path: String, terminal: String) -> Result<(), String> {
    let terminal = terminal.trim().to_lowercase();

    #[cfg(target_os = "windows")]
    {
        let win_path = path.replace('/', "\\");

        match terminal.as_str() {
            "powershell" => {
                Command::new("cmd")
                    .args(&["/C", "start", "/D", &win_path, "powershell", "-NoExit"])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "pwsh" => {
                Command::new("cmd")
                    .args(&["/C", "start", "/D", &win_path, "pwsh", "-NoExit"])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "windows-terminal" => {
                Command::new("wt")
                    .args(&["-d", &win_path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "git-bash" => {
                if let Some(git_bash_path) = get_git_bash_path() {
                     Command::new(git_bash_path)
                         .arg(format!("--cd={}", win_path))
                         .spawn()
                         .map_err(|e| e.to_string())?;
                } else {
                     // Fallback: try to run bash in a new CMD window that stays open if bash fails
                     Command::new("cmd")
                        .args(&["/C", "start", "/D", &win_path, "cmd", "/K", "bash"])
                        .spawn()
                        .map_err(|e| e.to_string())?;
                }
            }
            "cmder" => {
                Command::new("cmd")
                    .args(&["/C", "start", "/D", &win_path, "cmder"])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            _ => {
                // Check if terminal is a custom executable path
                if terminal.contains('\\') || terminal.contains('/') || terminal.ends_with(".exe") {
                    Command::new(&terminal)
                        .current_dir(&win_path)
                        .creation_flags(CREATE_NO_WINDOW)
                        .spawn()
                        .map_err(|e| format!("Failed to launch custom terminal '{}': {}", terminal, e))?;
                } else {
                    // CMD (Default)
                    Command::new("cmd")
                        .args(&["/C", "start", "/D", &win_path, "cmd"])
                        .spawn()
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        match terminal.as_str() {
            "iterm2" => {
                Command::new("open")
                    .args(&["-a", "iTerm", &path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            _ => {
                if terminal.contains('/') {
                    Command::new(&terminal)
                        .current_dir(&path)
                        .spawn()
                        .map_err(|e| format!("Failed to launch custom terminal '{}': {}", terminal, e))?;
                } else {
                    Command::new("open")
                        .args(&["-a", "Terminal", &path])
                        .spawn()
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let shell_command = format!("cd '{}' ; exec bash", path.replace('\'', "'\\''"));
        match terminal.as_str() {
            "gnome-terminal" => {
                Command::new("gnome-terminal")
                    .args(&["--working-directory", &path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "konsole" => {
                Command::new("konsole")
                    .args(&["--workdir", &path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "xfce4-terminal" => {
                Command::new("xfce4-terminal")
                    .args(&["--working-directory", &path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "alacritty" => {
                Command::new("alacritty")
                    .args(&["--working-directory", &path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            "kitty" => {
                Command::new("kitty")
                    .args(&["--directory", &path])
                    .spawn()
                    .map_err(|e| e.to_string())?;
            }
            _ => {
                if terminal.contains('/') {
                    Command::new(&terminal)
                        .current_dir(&path)
                        .spawn()
                        .map_err(|e| format!("Failed to launch custom terminal '{}': {}", terminal, e))?;
                } else {
                    Command::new("x-terminal-emulator")
                        .args(&["-e", "bash", "-lc", &shell_command])
                        .spawn()
                        .map_err(|e| e.to_string())?;
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
