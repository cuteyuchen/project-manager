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
    /// Java 构建工具："maven" | "gradle"；非 Java 项目为 None
    #[serde(rename = "buildTool", skip_serializing_if = "Option::is_none")]
    build_tool: Option<String>,
    /// 是否存在 wrapper（mvnw / gradlew）。有 wrapper 时优先用它，
    /// 免得机器上没装或装了不同版本的 mvn / gradle。
    #[serde(rename = "hasWrapper", skip_serializing_if = "Option::is_none")]
    has_wrapper: Option<bool>,
}

impl ProjectInfo {
    /// 非 Java 项目的构造：Java 专属字段留空
    fn without_build_tool(
        name: String,
        scripts: Vec<String>,
        path: String,
        package_manager: Option<String>,
        nvm_version: Option<String>,
        project_type: String,
    ) -> Self {
        ProjectInfo {
            name,
            scripts,
            path,
            package_manager,
            nvm_version,
            project_type,
            build_tool: None,
            has_wrapper: None,
        }
    }
}

/// 是否为 Maven 项目
fn detect_maven(dir: &Path) -> bool {
    dir.join("pom.xml").exists()
}

/// 是否为 Gradle 项目。
///
/// 多模块项目的根目录可能只有 settings.gradle 而没有 build.gradle，
/// 所以这两个文件名也要算上——只看 build.gradle 会漏掉整个仓库根。
fn detect_gradle(dir: &Path) -> bool {
    ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]
        .iter()
        .any(|name| dir.join(name).exists())
}

/// pom.xml 里是否真的引了 Spring Boot（而不是所有 Maven 项目都算）
fn pom_has_spring_boot(dir: &Path) -> bool {
    fs::read_to_string(dir.join("pom.xml"))
        .map(|content| content.contains("spring-boot"))
        .unwrap_or(false)
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
            // Java：先于 "other" 判定。Maven / Gradle 项目扫不出可运行命令时，
            // 前端的「命令」页签整个不渲染，等于这个工具对 Java 项目只能开编辑器。
            let is_maven = detect_maven(project_path);
            let is_gradle = detect_gradle(project_path);
            if is_maven || is_gradle {
                let build_tool = if is_maven { "maven" } else { "gradle" };
                let has_wrapper = if is_maven {
                    project_path.join("mvnw").exists() || project_path.join("mvnw.cmd").exists()
                } else {
                    project_path.join("gradlew").exists() || project_path.join("gradlew.bat").exists()
                };

                return Ok(ProjectInfo {
                    name: dir_name,
                    // 具体命令由前端按 buildTool + hasWrapper 组装（见 utils/projectCommands.ts），
                    // 这里不返回脚本名：Maven 的 goal 与 Gradle 的 task 语义不同，
                    // 后端硬编码一份会和前端的预设重复。
                    scripts: Vec::new(),
                    path,
                    package_manager: None,
                    nvm_version: None,
                    project_type: "java".to_string(),
                    build_tool: Some(build_tool.to_string()),
                    has_wrapper: Some(has_wrapper),
                });
            }

            return Ok(ProjectInfo::without_build_tool(
                dir_name,
                Vec::new(),
                path,
                None,
                None,
                "other".to_string(),
            ));
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

        Ok(ProjectInfo::without_build_tool(
            name,
            scripts,
            path,
            package_manager,
            nvm_version,
            "node".to_string(),
        ))
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

/**
 * 扫描的最大层级，与前端项目树的 MAX_PROJECT_DEPTH（src/utils/projectTree.ts）保持一致。
 * 一级 → 二级 → 三级；超出该层级的目录直接丢弃，不会被上提压平到父级。
 */
pub const MAX_SCAN_DEPTH: usize = 3;

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
    /// Java 构建工具："maven" | "gradle"；非 Java 模块为 None。
    /// 前端据此把扫描出的后端模块建成 type: 'java' 的项目并预置命令。
    #[serde(rename = "buildTool", skip_serializing_if = "Option::is_none")]
    build_tool: Option<String>,
    /// 是否存在 mvnw / gradlew
    #[serde(rename = "hasWrapper", skip_serializing_if = "Option::is_none")]
    has_wrapper: Option<bool>,
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

    // 服务端 (Maven)：只有真的引了 spring-boot 才报 Spring Boot，
    // 否则一律报 Maven —— 原先所有带 pom.xml 的项目都被标成 Spring Boot。
    if has("pom.xml") {
        let framework = if pom_has_spring_boot(dir) { "Spring Boot" } else { "Maven" };
        return Some(("backend".into(), Some(framework.into())));
    }
    // 服务端 (Gradle)：settings.gradle(.kts) 也要算，
    // 多模块仓库的根目录可能只有 settings 而没有 build
    if detect_gradle(dir) {
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
 * 统一的项目树扫描：递归识别 `dir` 并返回**保留真实层级**的节点。
 *
 * 三种情况的处理（注意 Git 与构建清单的规则是非对称的）：
 *
 * | 条件                   | 是否项目节点     | 是否继续向内递归 | 理由                                       |
 * |------------------------|------------------|------------------|--------------------------------------------|
 * | 含 `.git`              | 是               | **是**           | 仓库根常同时承载多个模块（单仓多模块）     |
 * | 有构建清单但无 `.git`  | 是               | 否               | 单个完整包，避免把包内部目录误当子项目     |
 * | 两者都无               | `unknown` 占位   | 是               | 纯分组容器目录                             |
 *
 * `depth` 是该目录在**项目树中的绝对层级**（不是相对各分支重新起算），
 * 超过 `max_depth` 时直接返回空——即截断丢弃，绝不把深层模块上提压平到父级。
 *
 * 返回 `Vec` 而非 `Option` 只是为了让调用方能用 `extend` 平滑拼接：
 * 被忽略/去重/截断的目录返回空，正常目录返回恰好一个节点。
 */
fn scan_project_tree(
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

    // 路径归一化后去重，防止不同扫描根产出同一目录的重复节点。
    let path_key = dir.to_string_lossy().replace('\\', "/");
    if !seen.insert(path_key) {
        return Vec::new();
    }

    let has_git = dir.join(".git").exists();
    let identified = identify_module(dir);
    let has_pkg = dir.join("package.json").exists();
    let scripts = if has_pkg { read_package_scripts(dir) } else { Vec::new() };

    // Java 构建信息：与 scan_project 用同一套判定，避免两条导入路径识别不一致
    let is_maven = detect_maven(dir);
    let is_gradle = detect_gradle(dir);
    let build_tool = if is_maven {
        Some("maven".to_string())
    } else if is_gradle {
        Some("gradle".to_string())
    } else {
        None
    };
    let has_wrapper = build_tool.as_deref().map(|tool| {
        if tool == "maven" {
            dir.join("mvnw").exists() || dir.join("mvnw.cmd").exists()
        } else {
            dir.join("gradlew").exists() || dir.join("gradlew.bat").exists()
        }
    });

    let make_node = |kind: String, framework: Option<String>, children: Vec<ImportNode>| ImportNode {
        name: name.clone(),
        path: dir.to_string_lossy().to_string(),
        kind,
        framework,
        has_git,
        has_package_json: has_pkg,
        scripts: scripts.clone(),
        build_tool: build_tool.clone(),
        has_wrapper,
        children,
    };

    // Git 仓库：本身即项目边界，同时继续向内递归挂载其内部模块。
    if has_git {
        let children = scan_child_dirs(dir, depth + 1, max_depth, seen);
        let (kind, framework) = identified.unwrap_or_else(|| ("unknown".into(), None));
        // 注意：即使既无清单也无任何子模块（例如只有 README 的仓库），
        // 仍必须保留该节点——它是真实仓库，不能像空容器那样被丢弃。
        return vec![make_node(kind, framework, children)];
    }

    // 有构建清单但不是仓库根：视为一个完整项目，不再向内递归。
    if let Some((kind, framework)) = identified {
        return vec![make_node(kind, framework, Vec::new())];
    }

    // 纯容器目录：作为 unknown 占位节点保留层级，并递归其子目录。
    let children = scan_child_dirs(dir, depth + 1, max_depth, seen);
    // 子孙中没有任何模块的空容器不入结果，避免产生无意义的占位项目。
    if children.is_empty() {
        return Vec::new();
    }
    vec![make_node("unknown".into(), None, children)]
}

/**
 * 扫描 `dir` 的所有直接子目录并汇总为节点列表。
 *
 * 排序落实"优先扫描带有 git 仓库的"：同层内 Git 仓库排在前面，
 * 其余按目录名升序，保证结果稳定（`read_dir` 本身不保证顺序）。
 */
fn scan_child_dirs(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    seen: &mut std::collections::HashSet<String>,
) -> Vec<ImportNode> {
    // 超出层级时不必再读目录，直接返回。
    if depth > max_depth {
        return Vec::new();
    }

    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut child_dirs: Vec<std::path::PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|entry| entry.path())
        .collect();
    // 先按名称排序，保证同类节点顺序稳定。
    child_dirs.sort();

    let mut nodes = Vec::new();
    for child in child_dirs {
        nodes.extend(scan_project_tree(&child, depth, max_depth, seen));
    }
    // Git 仓库优先展示（sort_by_key 是稳定排序，同类保持上面的名称顺序）。
    nodes.sort_by_key(|node| !node.has_git);
    nodes
}

/**
 * 扫描一个**已存在项目**目录下的子项目，返回保留层级的嵌套树。
 *
 * `max_depth` 是本次扫描还可以向下延伸的层级数，由前端按
 * `MAX_PROJECT_DEPTH - 父项目当前深度` 算出后传入——后端不知道该项目在
 * 项目树中处于第几级，必须由调用方给出。省略时回退 `MAX_SCAN_DEPTH`。
 *
 * 根目录自身不作为候选，其直接子目录为本次扫描的层级 1。
 */
#[command]
pub async fn scan_sub_projects(
    path: String,
    max_depth: Option<usize>,
) -> Result<Vec<ImportNode>, String> {
    run_project_task(move || {
        let root = Path::new(&path);
        if !root.exists() || !root.is_dir() {
            return Err("Directory does not exist".to_string());
        }

        let limit = max_depth.unwrap_or(MAX_SCAN_DEPTH);
        let mut seen = std::collections::HashSet::new();
        Ok(scan_child_dirs(root, 1, limit, &mut seen))
    })
    .await
}

/**
 * 批量导入：扫描所选目录，返回保留真实层级的嵌套树（最多 `MAX_SCAN_DEPTH` 层）。
 *
 * 根目录自身不作为候选（它只是用户选中的扫描范围），其直接子目录为层级 1。
 */
#[command]
pub async fn scan_import_tree(path: String) -> Result<Vec<ImportNode>, String> {
    run_project_task(move || {
        let root = Path::new(&path);
        if !root.exists() || !root.is_dir() {
            return Err("Directory does not exist".to_string());
        }

        let mut seen = std::collections::HashSet::new();
        Ok(scan_child_dirs(root, 1, MAX_SCAN_DEPTH, &mut seen))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{scan_child_dirs, ImportNode, MAX_SCAN_DEPTH};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    /***********************测试目录辅助函数*********************/

    fn create_temp_dir(tag: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "project-manager-scan-tests-{}-{}-{}",
            tag,
            std::process::id(),
            timestamp,
        ));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    /** 在 root 下创建目录（relative 为多级路径），并写入若干标记文件 */
    fn make_dir(root: &Path, relative: &str, marker_files: &[&str]) {
        let dir = root.join(relative);
        fs::create_dir_all(&dir).expect("dir should be created");
        for file in marker_files {
            fs::write(dir.join(file), "{}").expect("marker file should be written");
        }
    }

    /** 伪造一个 Git 仓库：只需存在 .git 目录即可被识别为仓库边界 */
    fn make_git_repo(root: &Path, relative: &str, marker_files: &[&str]) {
        make_dir(root, relative, marker_files);
        fs::create_dir_all(root.join(relative).join(".git")).expect(".git should be created");
    }

    fn scan(root: &Path, max_depth: usize) -> Vec<ImportNode> {
        let mut seen = std::collections::HashSet::new();
        scan_child_dirs(root, 1, max_depth, &mut seen)
    }

    fn find<'a>(nodes: &'a [ImportNode], name: &str) -> &'a ImportNode {
        nodes
            .iter()
            .find(|node| node.name == name)
            .unwrap_or_else(|| panic!("节点 {} 应存在于结果中，实际为 {:?}", name, names(nodes)))
    }

    fn names(nodes: &[ImportNode]) -> Vec<String> {
        nodes.iter().map(|node| node.name.clone()).collect()
    }

    /** 递归收集整棵树中的所有路径，用于断言"某目录未被提升到任何层级" */
    fn collect_paths(nodes: &[ImportNode], out: &mut Vec<String>) {
        for node in nodes {
            out.push(node.path.replace('\\', "/"));
            collect_paths(&node.children, out);
        }
    }

    /***********************Git 仓库作为边界并继续向内递归*********************/

    #[test]
    fn git_repo_becomes_project_and_keeps_inner_modules_as_children() {
        let root = create_temp_dir("git-repo");
        // 仓库根没有构建清单，但内部有前端与后端两个模块
        make_git_repo(&root, "MyRepo", &[]);
        make_dir(&root, "MyRepo/frontend", &["package.json"]);
        make_dir(&root, "MyRepo/backend", &["pom.xml"]);

        let tree = scan(&root, MAX_SCAN_DEPTH);

        assert_eq!(tree.len(), 1, "仓库目录本身应作为唯一的顶层节点");
        let repo = find(&tree, "MyRepo");
        assert!(repo.has_git, "仓库节点应标记 has_git");
        assert_eq!(
            repo.children.len(),
            2,
            "仓库内部两个模块应作为其子节点，而不是被平铺到顶层"
        );

        let mut child_names = names(&repo.children);
        child_names.sort();
        assert_eq!(child_names, vec!["backend", "frontend"]);

        fs::remove_dir_all(&root).ok();
    }

    /***********************纯容器目录保留为占位层级*********************/

    #[test]
    fn plain_container_dir_is_kept_as_unknown_placeholder() {
        let root = create_temp_dir("container");
        // group 既无 .git 也无构建清单，仅用于分组
        make_dir(&root, "group", &[]);
        make_dir(&root, "group/ProjectA", &["package.json"]);
        make_dir(&root, "group/ProjectB", &["pom.xml"]);

        let tree = scan(&root, MAX_SCAN_DEPTH);

        assert_eq!(tree.len(), 1, "容器目录应作为唯一顶层节点保留层级");
        let group = find(&tree, "group");
        assert_eq!(group.kind, "unknown", "容器目录应为 unknown 占位节点");
        assert_eq!(group.children.len(), 2, "两个项目应挂在容器之下");

        fs::remove_dir_all(&root).ok();
    }

    /***********************超出层级直接截断而不是上提*********************/

    #[test]
    fn dirs_beyond_max_depth_are_dropped_not_flattened() {
        let root = create_temp_dir("depth");
        // a/b/c 均为纯容器，模块位于第 4 层的 d 处
        make_dir(&root, "a/b/c/d", &["pom.xml"]);

        let tree = scan(&root, MAX_SCAN_DEPTH);

        let mut paths = Vec::new();
        collect_paths(&tree, &mut paths);
        assert!(
            !paths.iter().any(|path| path.ends_with("/d")),
            "第 4 层的模块应被截断丢弃，不得出现在任何层级，实际为 {:?}",
            paths
        );
        // a/b/c 三层容器最终都没有可识别子孙，应作为空容器一并丢弃
        assert!(tree.is_empty(), "没有任何可识别模块时结果应为空，实际为 {:?}", names(&tree));

        fs::remove_dir_all(&root).ok();
    }

    /***********************孙级不得平铺到父级*********************/

    #[test]
    fn grandchild_never_appears_as_direct_child_of_root() {
        let root = create_temp_dir("nesting");
        // 用户报告的场景：一个文件夹下有两个子项目，中间还隔着一层 packages
        make_dir(&root, "MyApp/packages/web", &["package.json"]);
        make_dir(&root, "MyApp/packages/api", &["go.mod"]);

        let tree = scan(&root, MAX_SCAN_DEPTH);

        let my_app = find(&tree, "MyApp");
        assert_eq!(names(&my_app.children), vec!["packages"], "MyApp 的直接子级只应有 packages");

        let packages = find(&my_app.children, "packages");
        let mut leaf_names = names(&packages.children);
        leaf_names.sort();
        assert_eq!(leaf_names, vec!["api", "web"], "两个模块应挂在 packages 之下");

        fs::remove_dir_all(&root).ok();
    }

    /***********************空容器不入结果*********************/

    #[test]
    fn empty_container_without_any_module_is_skipped() {
        let root = create_temp_dir("empty");
        make_dir(&root, "empty-group/nested", &[]);

        let tree = scan(&root, MAX_SCAN_DEPTH);

        assert!(tree.is_empty(), "没有任何模块的空容器不应入结果");

        fs::remove_dir_all(&root).ok();
    }

    /***********************无清单无子模块的仓库仍需保留*********************/

    #[test]
    fn bare_git_repo_without_manifest_is_still_kept() {
        let root = create_temp_dir("bare-repo");
        // 只有 README 的仓库：既无构建清单，也无任何可识别子模块
        make_git_repo(&root, "DocsRepo", &["README.md"]);

        let tree = scan(&root, MAX_SCAN_DEPTH);

        assert_eq!(tree.len(), 1, "真实仓库即使没有清单也不能被当成空容器丢弃");
        let repo = find(&tree, "DocsRepo");
        assert!(repo.has_git);
        assert!(repo.children.is_empty(), "该仓库内部没有子模块");

        fs::remove_dir_all(&root).ok();
    }

    /***********************同层内 Git 仓库优先展示*********************/

    #[test]
    fn git_repos_are_sorted_before_non_git_siblings() {
        let root = create_temp_dir("git-order");
        // 名称上 aaa-plain 在前，但 zzz-repo 是仓库，应被排到前面
        make_dir(&root, "aaa-plain", &["package.json"]);
        make_git_repo(&root, "zzz-repo", &["package.json"]);

        let tree = scan(&root, MAX_SCAN_DEPTH);

        assert_eq!(
            names(&tree),
            vec!["zzz-repo", "aaa-plain"],
            "带 git 仓库的节点应优先排在同层前面"
        );

        fs::remove_dir_all(&root).ok();
    }

    /***********************有清单但非仓库根时不再向内递归*********************/

    #[test]
    fn identified_module_without_git_does_not_recurse_inward() {
        let root = create_temp_dir("no-recurse");
        // 单个完整包：内部的 examples 子包不应被当作子项目
        make_dir(&root, "SinglePkg", &["package.json"]);
        make_dir(&root, "SinglePkg/examples", &["package.json"]);

        let tree = scan(&root, MAX_SCAN_DEPTH);

        let pkg = find(&tree, "SinglePkg");
        assert!(
            pkg.children.is_empty(),
            "有构建清单但非仓库根的目录不应向内递归，实际子节点 {:?}",
            names(&pkg.children)
        );

        fs::remove_dir_all(&root).ok();
    }
}
