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
    // 部署/对外暴露的纯静态资源目录：只含 index.html 和资源文件，
    // 既无构建系统也无源码组织，不应被识别为项目。
    "public", "static", "www", "htdocs", "public_html", "httpdocs",
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

/** 嵌套导入树节点。容器目录作为 `kind="unknown"` 占位节点保留，其下可挂子节点。 */
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportNode {
    name: String,
    path: String,
    /// 模块类型：frontend / backend / node / go / rust / python / dotnet / static / unknown（容器）
    kind: String,
    /// 具体框架（如 Vue / React / Spring Boot / Gradle）
    framework: Option<String>,
    /// 是否为 Git 仓库
    has_git: bool,
    /// 是否含 package.json
    has_package_json: bool,
    /// 该目录下的 npm scripts（仅 node/前端项目有值）
    scripts: Vec<String>,
    /// 子节点（仅容器目录会继续下沉；已识别模块节点不再递归）
    children: Vec<ImportNode>,
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
 * 递归扫描导入候选。
 *
 * 当一个目录自身不能被识别为模块（既没有 package.json / go.mod / Cargo.toml
 * 等项目标识，也不是 Git 仓库）但其下存在可识别的子目录时，跳过该目录，
 * 继续向其子孙目录下沉——以确保候选项是真实项目，而非纯粹的容器文件夹。
 *
 * 识别为候选目录的条件：
 *   - `identify_module(dir)` 返回 Some，或
 *   - 目录下存在 `.git`（已初始化的 Git 仓库，即便没有可识别的框架标记文件）。
 *
 * `depth` 表示当前正在处理的目录相对于扫描根的层数，根的直接子目录为 1。
 * 超过 `max_depth` 时停止下沉，直接返回（不再加入候选）。
 */
fn scan_import_preview_dir(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    candidates: &mut Vec<ImportCandidate>,
    seen: &mut std::collections::HashSet<String>,
) {
    if depth > max_depth {
        return;
    }

    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    if name.starts_with('.') || SCAN_IGNORED_DIRS.contains(&name.as_str()) {
        return;
    }

    // 将路径归一化后做去重，防止不同扫描根产出同一目录的重复候选。
    let path_key = dir.to_string_lossy().replace('\\', "/");
    if !seen.insert(path_key) {
        return;
    }

    let is_module = identify_module(dir).is_some();
    let has_git = dir.join(".git").exists();

    if is_module || has_git {
        let mut modules = Vec::new();
        scan_modules_recursive(dir, 1, 3, &mut modules);
        candidates.push(ImportCandidate {
            name,
            path: dir.to_string_lossy().to_string(),
            sub_module_count: modules.len(),
            has_git,
        });
        return;
    }

    // 容器目录：跳过自身，向子目录继续下沉。
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue };
        if !file_type.is_dir() {
            continue;
        }
        scan_import_preview_dir(&entry.path(), depth + 1, max_depth, candidates, seen);
    }
}

/**
 * 预扫描一个根目录下的导入候选。
 *
 * 直接子目录中可识别为项目的目录作为候选；不能识别但包含可识别项目
 * 的容器目录会被跳过，向其孙目录下沉（至多 3 层）——避免把空容器
 * 文件夹当成项目导入。
 */
#[command]
pub async fn scan_import_preview(path: String) -> Result<Vec<ImportCandidate>, String> {
    run_project_task(move || {
        let root = Path::new(&path);
        if !root.exists() || !root.is_dir() {
            return Err("Directory does not exist".to_string());
        }

        let mut candidates = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let entries = fs::read_dir(root).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if !file_type.is_dir() {
                continue;
            }
            scan_import_preview_dir(&entry.path(), 1, 3, &mut candidates, &mut seen);
        }

        Ok(candidates)
    })
    .await
}

/** 递归扫描导入候选，返回嵌套树结构。容器目录作为 `kind="unknown"` 占位节点保留，其下挂子节点；已识别模块节点不再递归。 */
fn scan_import_tree_dir(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    seen: &mut std::collections::HashSet<String>,
) -> Vec<ImportNode> {
    if depth > max_depth {
        return Vec::new();
    }

    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    if name.starts_with('.') || SCAN_IGNORED_DIRS.contains(&name.as_str()) {
        return Vec::new();
    }

    // 路径去重，防止不同扫描根产出同一目录的重复节点。
    let path_key = dir.to_string_lossy().replace('\\', "/");
    if !seen.insert(path_key) {
        return Vec::new();
    }

    let identified = identify_module(dir);
    let has_git = dir.join(".git").exists();
    let has_pkg = dir.join("package.json").exists();
    let scripts = if has_pkg { read_package_scripts(dir) } else { Vec::new() };

    if let Some((kind, framework)) = identified {
        // 已识别为模块 → 不再递归子目录
        vec![ImportNode {
            name,
            path: dir.to_string_lossy().to_string(),
            kind,
            framework,
            has_git,
            has_package_json: has_pkg,
            scripts,
            children: Vec::new(),
        }]
    } else {
        // 容器目录：保留为 unknown 占位节点，并递归构建其子节点
        let mut children = Vec::new();
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else { continue };
                if !file_type.is_dir() {
                    continue;
                }
                let mut sub_nodes = scan_import_tree_dir(&entry.path(), depth + 1, max_depth, seen);
                children.append(&mut sub_nodes);
            }
        }
        // 没有任何子节点的空容器目录不入结果，避免产生无意义的占位项目
        if children.is_empty() {
            return Vec::new();
        }
        vec![ImportNode {
            name,
            path: dir.to_string_lossy().to_string(),
            kind: "unknown".into(),
            framework: None,
            has_git,
            has_package_json: has_pkg,
            scripts,
            children,
        }]
    }
}

/**
 * 扫描所选目录下子项目，返回嵌套树结构（最多 max_depth 层）。
 * 容器目录作为 `kind="unknown"` 占位节点保留；已识别模块节点不再递归。
 * 等价于 scan_import_preview 的"保留层级"版本。
 */
#[command]
pub async fn scan_import_tree(path: String) -> Result<Vec<ImportNode>, String> {
    run_project_task(move || {
        let root = Path::new(&path);
        if !root.exists() || !root.is_dir() {
            return Err("Directory does not exist".to_string());
        }

        let mut tree = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let entries = fs::read_dir(root).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            if !file_type.is_dir() {
                continue;
            }
            let mut sub_nodes = scan_import_tree_dir(&entry.path(), 1, 3, &mut seen);
            tree.append(&mut sub_nodes);
        }

        Ok(tree)
    })
    .await
}
