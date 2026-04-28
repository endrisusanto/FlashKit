use tauri::Manager;
use std::process::Command;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[tauri::command]
fn get_resource_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let resolver = app.path();
    let resource_dir = resolver.resource_dir().map_err(|e| e.to_string())?;
    let exe_dir = get_exe_dir();
    
    let mut paths = vec![];
    
    // 1. Cek folder _up_/assets (Lokasi instalasi NSIS)
    paths.push(exe_dir.join("_up_").join("assets").join(&name));
    
    // 2. Cek folder assets (Lokasi Portable/Standard)
    paths.push(exe_dir.join("assets").join(&name));
    paths.push(resource_dir.join("assets").join(&name));
    
    // 3. Cek folder resource_dir langsung
    paths.push(resource_dir.join(&name));

    for path in paths {
        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
    }
    
    Err(format!("Resource '{}' not found. Tried: {:?}", name, exe_dir))
}

#[tauri::command]
fn get_device_info(serial: String) -> Result<std::collections::HashMap<String, String>, String> {
    let props = vec![
        "ro.product.model",
        "ro.build.PDA",
        "ro.csc.sales_code",
        "ro.csc.country_code",
    ];
    
    let mut info = std::collections::HashMap::new();
    for prop in props {
        let val = run_adb(vec!["-s".to_string(), serial.clone(), "shell".to_string(), "getprop".to_string(), prop.to_string()])?;
        info.insert(prop.to_string(), val);
    }
    Ok(info)
}
fn get_exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap())
}

fn find_adb() -> String {
    let exe_dir = get_exe_dir();

    // 1. Check next to the executable (portable distribution)
    #[cfg(target_os = "windows")]
    let adb_names = ["adb.exe"];
    #[cfg(not(target_os = "windows"))]
    let adb_names = ["adb"];

    for name in adb_names {
        let local_adb = exe_dir.join(name);
        if local_adb.exists() {
            return local_adb.to_string_lossy().to_string();
        }
    }

    // 2. Check common system locations
    #[cfg(target_os = "windows")]
    let system_paths: Vec<PathBuf> = {
        let mut paths = vec![];
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            paths.push(PathBuf::from(&local).join("Android").join("Sdk").join("platform-tools").join("adb.exe"));
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            paths.push(PathBuf::from(&home).join("Android").join("Sdk").join("platform-tools").join("adb.exe"));
        }
        paths.push(PathBuf::from("C:\\Program Files\\Android\\platform-tools\\adb.exe"));
        paths
    };

    #[cfg(not(target_os = "windows"))]
    let system_paths: Vec<PathBuf> = vec![
        PathBuf::from("/home/endri-pro/Android/Sdk/platform-tools/adb"),
        PathBuf::from("/usr/bin/adb"),
        PathBuf::from("/usr/local/bin/adb"),
    ];

    for path in system_paths {
        if path.exists() {
            return path.to_string_lossy().to_string();
        }
    }

    // 3. Fallback to PATH
    #[cfg(target_os = "windows")]
    return "adb.exe".to_string();
    #[cfg(not(target_os = "windows"))]
    return "adb".to_string();
}

#[tauri::command]
fn get_adb_version() -> String {
    let adb_path = find_adb();
    let output = Command::new(&adb_path).arg("version").output();
    match output {
        Ok(out) => format!("Path: {}\n{}", adb_path, String::from_utf8_lossy(&out.stdout)),
        Err(e) => format!("Error finding ADB: {}", e),
    }
}

#[tauri::command]
fn get_app_dir() -> String {
    get_exe_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn get_devices() -> Result<Vec<String>, String> {
    let adb_path = find_adb();
    let output = Command::new(&adb_path)
        .arg("devices")
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in stdout.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() == 2 && parts[1] == "device" {
            devices.push(parts[0].to_string());
        }
    }

    Ok(devices)
}

#[tauri::command]
fn run_adb(args: Vec<String>) -> Result<String, String> {
    let adb_path = find_adb();
    let mut last_err = String::new();

    // Stabilization delay to prevent "error: closed"
    std::thread::sleep(std::time::Duration::from_millis(300));

    for attempt in 1..=3 {
        let mut cmd = Command::new(&adb_path);
        cmd.args(&args);

        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let output = cmd.output().map_err(|e| e.to_string())?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if output.status.success() {
            return Ok(stdout);
        }

        last_err = if !stderr.is_empty() { stderr.clone() } else { stdout.clone() };

        // If it's a connection error, wait and retry
        if last_err.contains("closed") || last_err.contains("device not found") {
            std::thread::sleep(std::time::Duration::from_millis(1000 * attempt));
            continue;
        } else {
            break; // Other errors don't need retry
        }
    }

    Err(last_err)
}

#[tauri::command]
fn get_samsung_port() -> Option<String> {
    if let Ok(ports) = serialport::available_ports() {
        for p in ports {
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                let manufacturer = info.manufacturer.as_deref().unwrap_or("").to_lowercase();
                let product = info.product.as_deref().unwrap_or("").to_lowercase();
                if manufacturer.contains("samsung") || product.contains("samsung") || product.contains("modem") {
                    return Some(p.port_name);
                }
            }
        }
    }
    None
}

#[tauri::command]
fn get_serial_ports() -> Vec<String> {
    match serialport::available_ports() {
        Ok(ports) => ports.into_iter().map(|p| p.port_name).collect(),
        Err(_) => vec![],
    }
}

#[tauri::command]
fn send_at_command(port_name: String, command: String) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::time::Duration;

    // Tingkatkan Baud Rate ke 115200 dan Timeout ke 5 detik
    let mut port = serialport::new(&port_name, 115200)
        .timeout(Duration::from_secs(5))
        .open()
        .map_err(|e| format!("Failed to open port {}: {}", port_name, e))?;

    let cmd = format!("{}\r\n", command);
    port.write_all(cmd.as_bytes())
        .map_err(|e| format!("Failed to write to port: {}", e))?;

    // Tunggu sedikit agar device sempat memproses
    std::thread::sleep(Duration::from_millis(500));

    let mut buffer: Vec<u8> = vec![0; 1024];
    match port.read(buffer.as_mut_slice()) {
        Ok(t) => {
            let response = String::from_utf8_lossy(&buffer[..t]).to_string();
            Ok(response)
        }
        Err(e) => Err(format!("AT Command Timeout: {}", e)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Fix for Wayland crashes on Linux
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_devices, run_adb, get_adb_version, get_app_dir, get_serial_ports, send_at_command, get_resource_path, get_samsung_port, get_device_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
