use tauri::Manager;
use std::process::Command;
use std::path::PathBuf;
use std::process::Stdio;
use std::io::BufReader;
use tauri::{Emitter, Window, AppHandle};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ─────────────────────────────────────────────
//  Odin Binary Path Resolver
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
//  Odin Commands (integrated from odin-clone)
// ─────────────────────────────────────────────

#[tauri::command]
fn odin_list_devices(app: AppHandle) -> Result<Vec<String>, String> {
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
        if trimmed.starts_with("/dev/")
            || trimmed.contains("bus/usb")
            || (cfg!(target_os = "windows") && trimmed.contains("COM"))
        {
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
async fn odin_flash_device(
    app: AppHandle,
    window: Window,
    params: FlashParams,
) -> Result<String, String> {
    let binary = get_odin_binary(&app);
    let mut cmd = Command::new(&binary);

    // Skip internal MD5 check since we already verified it during file selection
    cmd.arg("--ignore-md5");

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
async fn odin_check_file(
    app: AppHandle,
    window: Window,
    path: String,
    slot: String,
) -> Result<String, String> {
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

        // Read byte by byte to handle both \n and \r (odin4 uses \r for progress)
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

// ─────────────────────────────────────────────
//  ADB / FlashKit Provisioning Commands
// ─────────────────────────────────────────────

#[tauri::command]
fn get_resource_path(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let resolver = app.path();
    let resource_dir = resolver.resource_dir().map_err(|e| e.to_string())?;
    let exe_dir = get_exe_dir();

    let mut paths = vec![];

    // 1. Cek folder resources (Lokasi Standard Tauri)
    paths.push(resource_dir.join(&name));
    paths.push(resource_dir.join("assets").join(&name));
    paths.push(resource_dir.join("_up_").join("assets").join(&name));

    // 2. Jalur Spesifik Linux (Instalasi Sistem)
    #[cfg(target_os = "linux")]
    {
        paths.push(PathBuf::from("/usr/lib/flashkit/resources").join(&name));
        paths.push(PathBuf::from("/usr/lib/flashkit/resources/assets").join(&name));
        paths.push(PathBuf::from("/usr/share/flashkit/resources").join(&name));
    }

    // 3. Cek folder exe_dir (Lokasi Portable)
    paths.push(exe_dir.join("assets").join(&name));
    paths.push(exe_dir.join("_up_").join("assets").join(&name));

    for path in paths {
        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
    }

    Err(format!(
        "Resource '{}' not found. Jalur resource_dir: {:?}, exe_dir: {:?}",
        name, resource_dir, exe_dir
    ))
}

#[tauri::command]
fn get_device_info(serial: String) -> Result<std::collections::HashMap<String, String>, String> {
    let mut info = std::collections::HashMap::new();
    let val = run_adb(vec![
        "-s".to_string(),
        serial.clone(),
        "shell".to_string(),
        "getprop".to_string(),
        "ro.product.model".to_string(),
    ])?;
    info.insert("ro.product.model".to_string(), val);
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
            paths.push(
                PathBuf::from(&local)
                    .join("Android")
                    .join("Sdk")
                    .join("platform-tools")
                    .join("adb.exe"),
            );
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            paths.push(
                PathBuf::from(&home)
                    .join("Android")
                    .join("Sdk")
                    .join("platform-tools")
                    .join("adb.exe"),
            );
        }
        paths.push(PathBuf::from(
            "C:\\Program Files\\Android\\platform-tools\\adb.exe",
        ));
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
    let mut cmd = Command::new(&adb_path);
    cmd.arg("version");

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output();
    match output {
        Ok(out) => format!(
            "Path: {}\n{}",
            adb_path,
            String::from_utf8_lossy(&out.stdout)
        ),
        Err(e) => format!("Error finding ADB: {}", e),
    }
}

#[tauri::command]
fn get_app_dir() -> String {
    get_exe_dir().to_string_lossy().to_string()
}

#[tauri::command]
#[derive(serde::Serialize)]
struct AdbDevice {
    serial: String,
    usb: String,
}

#[tauri::command]
fn get_devices_with_usb() -> Result<Vec<AdbDevice>, String> {
    let adb_path = find_adb();
    let mut cmd = Command::new(&adb_path);
    cmd.arg("devices").arg("-l");

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in stdout.lines().skip(1) {
        if line.is_empty() { continue; }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 && parts[1] == "device" {
            let serial = parts[0].to_string();
            let mut usb = String::new();
            for p in parts {
                if p.starts_with("usb:") {
                    usb = p.replace("usb:", "");
                }
            }
            devices.push(AdbDevice { serial, usb });
        }
    }
    Ok(devices)
}

#[tauri::command]
fn get_devices() -> Result<Vec<String>, String> {
    let list = get_devices_with_usb()?;
    Ok(list.into_iter().map(|d| d.serial).collect())
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

        last_err = if !stderr.is_empty() {
            stderr.clone()
        } else {
            stdout.clone()
        };

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
fn get_samsung_ports() -> Result<Vec<String>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let mut samsung_ports = vec![];
    for p in ports {
        if let serialport::SerialPortType::UsbPort(info) = p.port_type {
            if info.vid == 0x04e8 {
                // Samsung VID
                samsung_ports.push(p.port_name);
            }
        }
    }
    Ok(samsung_ports)
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

    let mut port = serialport::new(&port_name, 115200)
        .timeout(Duration::from_secs(5))
        .open()
        .map_err(|e| format!("Failed to open port {}: {}", port_name, e))?;

    let cmd = format!("{}\r\n", command);
    port.write_all(cmd.as_bytes())
        .map_err(|e| format!("Failed to write to port: {}", e))?;

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

// ─────────────────────────────────────────────
//  Busy Device Tracking (Cross-Instance)
// ─────────────────────────────────────────────

const BUSY_FILE: &str = if cfg!(target_os = "windows") {
    "C:\\Windows\\Temp\\flashkit_busy.json"
} else {
    "/tmp/flashkit_busy.json"
};

fn read_busy_set() -> std::collections::HashSet<String> {
    if let Ok(data) = std::fs::read_to_string(BUSY_FILE) {
        if let Ok(v) = serde_json::from_str::<std::collections::HashSet<String>>(&data) {
            return v;
        }
    }
    std::collections::HashSet::new()
}

fn write_busy_set(set: &std::collections::HashSet<String>) {
    if let Ok(json) = serde_json::to_string(set) {
        let _ = std::fs::write(BUSY_FILE, json);
    }
}

#[tauri::command]
fn mark_busy(serials: Vec<String>) {
    let mut set = read_busy_set();
    for s in serials { set.insert(s); }
    write_busy_set(&set);
}

#[tauri::command]
fn clear_busy(serials: Vec<String>) {
    let mut set = read_busy_set();
    for s in &serials { set.remove(s); }
    write_busy_set(&set);
}

#[tauri::command]
fn get_busy_devices() -> Vec<String> {
    read_busy_set().into_iter().collect()
}

#[tauri::command]
fn emergency_stop() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Kill odin4.exe and adb.exe on Windows
        let _ = Command::new("taskkill").args(&["/F", "/IM", "odin4.exe", "/T"]).creation_flags(0x08000000).output();
        let _ = Command::new("taskkill").args(&["/F", "/IM", "adb.exe", "/T"]).creation_flags(0x08000000).output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Kill odin4 and adb on Linux/macOS
        let _ = Command::new("pkill").arg("-9").arg("odin4").output();
        let _ = Command::new("pkill").arg("-9").arg("adb").output();
    }
    Ok(())
}

// ─────────────────────────────────────────────
//  App Entry Point
// ─────────────────────────────────────────────

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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // ADB / Provisioning commands
            get_devices,
            get_devices_with_usb,
            run_adb,
            get_adb_version,
            get_app_dir,
            get_serial_ports,
            send_at_command,
            get_resource_path,
            get_samsung_ports,
            get_device_info,
            // Odin flash commands
            odin_list_devices,
            odin_flash_device,
            odin_check_file,
            // Cross-instance busy tracking
            mark_busy,
            clear_busy,
            get_busy_devices,
            emergency_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
