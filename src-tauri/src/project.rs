use tauri::command;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use encoding_rs::Encoding;

async fn run_project_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Background project task failed: {}", e))?
}

#[derive(Serialize, Deserialize)]
pub struct ProjectInfo {
    name: String,
    scripts: Vec<String>,
    path: String,
    #[serde(rename = "packageManager")]
    package_manager: Option<String>,
    #[serde(rename = "nvmVersion")]
    nvm_version: Option<String>,
    #[serde(rename = "projectType")]
    project_type: String,
}

#[derive(Deserialize)]
struct PackageJson {
    name: Option<String>,
    scripts: Option<std::collections::HashMap<String, String>>,
}

#[derive(Serialize, Deserialize)]
pub struct DirEntry {
    name: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
}

#[command]
pub async fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    run_project_task(move || {
        let mut entries = Vec::new();
        let dir = fs::read_dir(&path).map_err(|e| e.to_string())?;

        for entry in dir {
            if let Ok(entry) = entry {
                if let Ok(file_type) = entry.file_type() {
                    entries.push(DirEntry {
                        name: entry.file_name().to_string_lossy().to_string(),
                        is_directory: file_type.is_dir(),
                    });
                }
            }
        }

        Ok(entries)
    })
    .await
}

#[command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    run_project_task(move || {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;

        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            let (text, _, _) = Encoding::for_label(b"utf-8")
                .ok_or_else(|| "UTF-8 decoder unavailable".to_string())?
                .decode(&bytes[3..]);
            return Ok(text.into_owned());
        }

        if bytes.starts_with(&[0xFF, 0xFE]) {
            let (text, _, _) = Encoding::for_label(b"utf-16le")
                .ok_or_else(|| "UTF-16LE decoder unavailable".to_string())?
                .decode(&bytes[2..]);
            return Ok(text.into_owned());
        }

        if bytes.starts_with(&[0xFE, 0xFF]) {
            let (text, _, _) = Encoding::for_label(b"utf-16be")
                .ok_or_else(|| "UTF-16BE decoder unavailable".to_string())?
                .decode(&bytes[2..]);
            return Ok(text.into_owned());
        }

        if let Ok(text) = String::from_utf8(bytes.clone()) {
            return Ok(text);
        }

        for label in [b"gb18030".as_slice(), b"gbk".as_slice(), b"utf-16le".as_slice(), b"utf-16be".as_slice()] {
            if let Some(encoding) = Encoding::for_label(label) {
                let (text, _, had_errors) = encoding.decode(&bytes);
                if !had_errors {
                    return Ok(text.into_owned());
                }
            }
        }

        let (text, _, _) = Encoding::for_label(b"gb18030")
            .ok_or_else(|| "GB18030 decoder unavailable".to_string())?
            .decode(&bytes);
        Ok(text.into_owned())
    })
    .await
}

#[command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    run_project_task(move || fs::write(&path, content).map_err(|e| e.to_string())).await
}

#[command]
pub async fn read_binary_file_base64(path: String) -> Result<String, String> {
    run_project_task(move || {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        Ok(STANDARD.encode(bytes))
    })
    .await
}

#[command]
pub async fn scan_project(path: String) -> Result<ProjectInfo, String> {
    run_project_task(move || {
        let project_path = Path::new(&path);
        let package_json_path = project_path.join("package.json");

        if !project_path.exists() || !project_path.is_dir() {
            return Err("Directory does not exist".to_string());
        }

        let dir_name = project_path
            .file_name()
            .unwrap_or_default()
            .to_str()
            .unwrap_or("Unknown")
            .to_string();

        if !package_json_path.exists() {
            return Ok(ProjectInfo {
                name: dir_name,
                scripts: Vec::new(),
                path,
                package_manager: None,
                nvm_version: None,
                project_type: "other".to_string(),
            });
        }

        let content = fs::read_to_string(&package_json_path).map_err(|e| e.to_string())?;
        let pkg: PackageJson = serde_json::from_str(&content).map_err(|e| e.to_string())?;

        let mut scripts: Vec<String> = pkg.scripts.unwrap_or_default().keys().cloned().collect();
        scripts.sort();

        let name = pkg.name.unwrap_or_else(|| dir_name.clone());

        let mut package_manager = None;
        if project_path.join("pnpm-lock.yaml").exists() {
            package_manager = Some("pnpm".to_string());
        } else if project_path.join("yarn.lock").exists() {
            package_manager = Some("yarn".to_string());
        } else if project_path.join("package-lock.json").exists() {
            package_manager = Some("npm".to_string());
        }

        let mut nvm_version = None;
        let nvmrc_path = project_path.join(".nvmrc");
        if nvmrc_path.exists() {
            if let Ok(content) = fs::read_to_string(nvmrc_path) {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    nvm_version = Some(trimmed.to_string());
                }
            }
        }

        Ok(ProjectInfo {
            name,
            scripts,
            path,
            package_manager,
            nvm_version,
            project_type: "node".to_string(),
        })
    })
    .await
}

// ─── 子项目 / 前后端识别 ──────────────────────────────────────────────

/** 扫描时忽略的目录名 */
const SCAN_IGNORED_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
    ".idea", ".vscode", "__pycache__", ".next", ".nuxt", "target",
    "vendor", "coverage", ".cache", "tmp", "temp", ".gradle",
];

/** 识别出的子项目候选 */
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubProjectCandidate {
    /// 目录名（显示名）
    name: String,
    /// 绝对路径
    path: String,
    /// 模块类型：frontend / backend / node / go / rust / python / dotnet / static / unknown
    kind: String,
    /// 具体框架（如 Vue / React / Spring Boot / Gradle）
    framework: Option<String>,
    /// 是否含 package.json
    has_package_json: bool,
    /// 该目录下的 npm scripts（仅 node/前端项目有值）
    scripts: Vec<String>,
}

/** 预扫描导入候选 */
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    name: String,
    path: String,
    /// 已识别到的子模块数量
    sub_module_count: usize,
    /// 是否为 Git 仓库
    has_git: bool,
}

/** 读取 package.json 判断是否依赖某个包（dependencies + devDependencies） */
fn package_json_has_dep(dir: &Path, dep: &str) -> bool {
    let pkg_path = dir.join("package.json");
    let Ok(content) = fs::read_to_string(&pkg_path) else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { return false };
    let in_deps = json
        .get("dependencies")
        .and_then(|d| d.get(dep))
        .is_some();
    let in_dev = json
        .get("devDependencies")
        .and_then(|d| d.get(dep))
        .is_some();
    in_deps || in_dev
}

/** 读取 package.json 的 scripts 名称列表 */
fn read_package_scripts(dir: &Path) -> Vec<String> {
    let pkg_path = dir.join("package.json");
    let Ok(content) = fs::read_to_string(&pkg_path) else { return Vec::new() };
    let Ok(pkg) = serde_json::from_str::<PackageJson>(&content) else { return Vec::new() };
    let mut scripts: Vec<String> = pkg.scripts.unwrap_or_default().keys().cloned().collect();
    scripts.sort();
    scripts
}

/**
 * 识别单个目录的模块类型（前后端识别）。
 * 返回 (kind, framework)；无法识别返回 None。
 */
fn identify_module(dir: &Path) -> Option<(String, Option<String>)> {
    let has = |name: &str| dir.join(name).exists();

    // 服务端 (Maven)
    if has("pom.xml") {
        return Some(("backend".into(), Some("Spring Boot".into())));
    }
    // 服务端 (Gradle)
    if has("build.gradle") || has("build.gradle.kts") {
        return Some(("backend".into(), Some("Gradle".into())));
    }
    // 含 package.json：区分 前端(Vue/React) / Node
    if has("package.json") {
        if package_json_has_dep(dir, "vue") {
            return Some(("frontend".into(), Some("Vue".into())));
        }
        if package_json_has_dep(dir, "react") {
            return Some(("frontend".into(), Some("React".into())));
        }
        return Some(("node".into(), Some("Node.js".into())));
    }
    // 纯静态前端（有 index.html 无 package.json）
    if has("index.html") {
        return Some(("static".into(), Some("Static".into())));
    }
    // Go
    if has("go.mod") {
        return Some(("go".into(), Some("Go".into())));
    }
    // Rust
    if has("Cargo.toml") {
        return Some(("rust".into(), Some("Rust".into())));
    }
    // Python
    if has("requirements.txt") || has("pyproject.toml") {
        return Some(("python".into(), Some("Python".into())));
    }
    // C# (.csproj)
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.to_lowercase().ends_with(".csproj") {
                    return Some(("dotnet".into(), Some(".NET".into())));
                }
            }
        }
    }
    None
}

/**
 * 递归扫描目录识别代码模块（最大深度 max_depth）。
 * 识别到模块的目录不再递归其子目录。
 */
fn scan_modules_recursive(dir: &Path, depth: usize, max_depth: usize, found: &mut Vec<SubProjectCandidate>) {
    if depth > max_depth {
        return;
    }

    // 先尝试识别当前目录
    if let Some((kind, framework)) = identify_module(dir) {
        let name = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();
        let has_pkg = dir.join("package.json").exists();
        let scripts = if has_pkg { read_package_scripts(dir) } else { Vec::new() };
        found.push(SubProjectCandidate {
            name,
            path: dir.to_string_lossy().to_string(),
            kind,
            framework,
            has_package_json: has_pkg,
            scripts,
        });
        // 已识别 → 不再递归子目录
        return;
    }

    // 未识别 → 递归子目录
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SCAN_IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        scan_modules_recursive(&entry.path(), depth + 1, max_depth, found);
    }
}

/**
 * 扫描一级项目目录，识别其下的子项目（前端/后端等）。
 * 只扫描直接子目录中的模块（每个子目录内递归至多 3 层）。
 */
#[command]
pub async fn scan_sub_projects(path: String) -> Result<Vec<SubProjectCandidate>, String> {
    run_project_task(move || {
        let root = Path::new(&path);
        if !root.exists() || !root.is_dir() {
            return Err("Directory does not exist".to_string());
        }

        let mut found = Vec::new();
        // 遍历一级子目录，对每个子目录做递归识别（不识别根目录自身）
        let entries = fs::read_dir(root).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SCAN_IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            scan_modules_recursive(&entry.path(), 1, 3, &mut found);
        }

        Ok(found)
    })
    .await
}

/**
 * 预扫描一个根目录下的一级子目录，返回导入候选列表。
 * 每个候选标注识别到的子模块数量与是否为 Git 仓库。
 */
#[command]
pub async fn scan_import_preview(path: String) -> Result<Vec<ImportCandidate>, String> {
    run_project_task(move || {
        let root = Path::new(&path);
        if !root.exists() || !root.is_dir() {
            return Err("Directory does not exist".to_string());
        }

        let mut candidates = Vec::new();
        let entries = fs::read_dir(root).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SCAN_IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            let dir_path = entry.path();
            let has_git = dir_path.join(".git").exists();
            let mut modules = Vec::new();
            scan_modules_recursive(&dir_path, 1, 3, &mut modules);
            candidates.push(ImportCandidate {
                name,
                path: dir_path.to_string_lossy().to_string(),
                sub_module_count: modules.len(),
                has_git,
            });
        }

        Ok(candidates)
    })
    .await
}
