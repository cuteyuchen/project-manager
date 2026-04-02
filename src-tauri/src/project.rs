use tauri::command;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use encoding_rs::Encoding;

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
pub fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
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
}

#[command]
pub fn read_text_file(path: String) -> Result<String, String> {
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
}

#[command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[command]
pub fn read_binary_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(bytes))
}

#[command]
pub fn scan_project(path: String) -> Result<ProjectInfo, String> {
    let project_path = Path::new(&path);
    let package_json_path = project_path.join("package.json");

    if !project_path.exists() || !project_path.is_dir() {
        return Err("Directory does not exist".to_string());
    }

    // Determine default name from directory
    let dir_name = project_path
        .file_name()
        .unwrap_or_default()
        .to_str()
        .unwrap_or("Unknown")
        .to_string();

    if !package_json_path.exists() {
        // Non-Node project: return basic info
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
}
