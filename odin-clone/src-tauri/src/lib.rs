// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::process::Command;
use std::process::Stdio;
use std::io::BufReader;
use tauri::{Emitter, Window, Manager, AppHandle};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn get_odin_binary(app: &AppHandle) -> String {
    let resource_path = if cfg!(target_os = "windows") {
        app.path().resolve("../bin/windows/odin4.exe", tauri::path::BaseDirectory::Resource)
    } else {
        app.path().resolve("../bin/linux/odin4", tauri::path::BaseDirectory::Resource)
    };

    match resource_path {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(_) => {
            // Fallback for development mode
            if cfg!(target_os = "windows") {
                "bin/windows/odin4.exe".to_string()
            } else {
                "bin/linux/odin4".to_string()
            }
        }
    }
}

#[tauri::command]
fn list_devices(app: AppHandle) -> Result<Vec<String>, String> {
    let binary = get_odin_binary(&app);
    let mut cmd = Command::new(&binary);
    cmd.arg("-l");

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output()
        .map_err(|e| format!("{}: {}", binary, e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();
    
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("/dev/") || trimmed.contains("bus/usb") || (cfg!(target_os = "windows") && trimmed.contains("COM")) {
            devices.push(trimmed.to_string());
        }
    }
    
    Ok(devices)
}

#[derive(serde::Deserialize)]
pub struct FlashParams {
    device: String,
    bl: String,
    ap: String,
    cp: String,
    csc: String,
    userdata: String,
}

#[tauri::command]
async fn flash_device(app: AppHandle, window: Window, params: FlashParams) -> Result<String, String> {
    let binary = get_odin_binary(&app);
    let mut cmd = Command::new(&binary);
    
    // Skip internal MD5 check since we already verified it during file selection
    cmd.arg("--no-md5");
    
    if !params.bl.is_empty() { cmd.arg("-b").arg(&params.bl); }
    if !params.ap.is_empty() { cmd.arg("-a").arg(&params.ap); }
    if !params.cp.is_empty() { cmd.arg("-c").arg(&params.cp); }
    if !params.csc.is_empty() { cmd.arg("-s").arg(&params.csc); }
    if !params.userdata.is_empty() { cmd.arg("-u").arg(&params.userdata); }
    
    if !params.device.is_empty() {
        cmd.arg("-d").arg(&params.device);
    }
    
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("{}: {}", binary, e))?;
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    
    let device_id = params.device.clone();
    let mut buffer = Vec::new();
    use std::io::Read;
    let mut byte_buf = [0u8; 1];

    while reader.read_exact(&mut byte_buf).is_ok() {
        let b = byte_buf[0];
        if b == b'\n' || b == b'\r' {
            if !buffer.is_empty() {
                let line = String::from_utf8_lossy(&buffer).to_string();
                let _ = window.emit(&format!("flash-progress-{}", device_id), line);
                buffer.clear();
            }
        } else {
            buffer.push(b);
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    
    if status.success() {
        Ok(format!("Flashing {} completed successfully.", params.device))
    } else {
        Err(format!("Flashing {} failed with status: {}", params.device, status))
    }
}

#[tauri::command]
async fn check_file(app: AppHandle, window: Window, path: String, slot: String) -> Result<String, String> {
    let binary = get_odin_binary(&app);
    let mut cmd = Command::new(&binary);
    cmd.arg("--md5sum-only").arg("-a").arg(&path);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("{}: {}", binary, e))?;

    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        
        // Read byte by byte to handle both \n and \r (carriage return) which odin4 uses for progress
        use std::io::Read;
        let mut byte_buf = [0u8; 1];
        while reader.read_exact(&mut byte_buf).is_ok() {
            let b = byte_buf[0];
            if b == b'\n' || b == b'\r' {
                if !buffer.is_empty() {
                    let line = String::from_utf8_lossy(&buffer).to_string();
                    let _ = window.emit(&format!("md5-progress-{}", slot), line);
                    buffer.clear();
                }
            } else {
                buffer.push(b);
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;

    if status.success() {
        Ok("Valid".to_string())
    } else {
        Err("Invalid file or MD5 mismatch".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![list_devices, flash_device, check_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


