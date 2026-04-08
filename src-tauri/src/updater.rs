use std::fs::File;
use std::process::Command;
use std::env;
use tauri::{AppHandle, Emitter, State};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub struct UpdateState {
    pub is_cancelling: Arc<AtomicBool>,
}

impl UpdateState {
    pub fn new() -> Self {
        Self {
            is_cancelling: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[tauri::command]
pub fn cancel_update(state: State<UpdateState>) {
    state.is_cancelling.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>, url: String) -> Result<(), String> {
    println!("Starting update download from: {}", url);
    
    // Reset cancellation state
    state.is_cancelling.store(false, Ordering::SeqCst);
    let is_cancelling = state.is_cancelling.clone();

    // Use blocking task to avoid blocking the async runtime with file I/O and synchronous download
    // But since we added blocking feature to reqwest, we can use it inside spawn_blocking
    
    let app_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e: reqwest::Error| e.to_string())?;

        let mut response = client.get(&url).send().map_err(|e: reqwest::Error| e.to_string())?;
        response.error_for_status_ref().map_err(|e: reqwest::Error| e.to_string())?;
        
        let total_size = response.content_length().unwrap_or(0);
        
        let mut temp_path = env::temp_dir();
        temp_path.push("frontend-manager-update.exe");
        
        println!("Downloading to: {:?}", temp_path);
        
        let mut dest = File::create(&temp_path).map_err(|e| e.to_string())?;
        
        let mut buffer = [0; 16384]; // 16KB buffer
        let mut downloaded: u64 = 0;
        let mut last_percentage: u64 = 0;

        loop {
            if is_cancelling.load(Ordering::SeqCst) {
                 return Err("Update cancelled by user".to_string());
            }

            let bytes_read = response.read(&mut buffer).map_err(|e: std::io::Error| e.to_string())?;
            if bytes_read == 0 {
                break;
            }
            dest.write_all(&buffer[..bytes_read]).map_err(|e| e.to_string())?;
            downloaded += bytes_read as u64;

            if total_size > 0 {
                let percentage = (downloaded as f64 / total_size as f64 * 100.0) as u64;
                if percentage > last_percentage {
                    let _ = app_handle.emit("download-progress", percentage);
                    last_percentage = percentage;
                }
            }
        }
        
        Ok::<std::path::PathBuf, String>(temp_path)
    }).await.map_err(|e| e.to_string())??;

    println!("Download complete. Launching installer...");

    // Launch the installer
    // Using cmd /c start to ensure it runs independently
    #[cfg(target_os = "windows")]
    Command::new("cmd")
        .args(["/C", "start", "", result.to_str().unwrap()])
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "windows"))]
    Command::new(result)
        .spawn()
        .map_err(|e| e.to_string())?;
        
    println!("Installer launched. Exiting app.");
    app.exit(0);
    
    Ok(())
}
