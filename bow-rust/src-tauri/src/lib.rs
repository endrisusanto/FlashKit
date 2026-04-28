use std::process::Command;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

    #[cfg(target_os = "windows")]
    let output = Command::new(&adb_path)
        .args(&args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "windows"))]
    let output = Command::new(&adb_path)
        .args(&args)
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        if !stderr.is_empty() {
            return Err(stderr);
        }
        return Err(stdout);
    }

    Ok(stdout)
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
        .invoke_handler(tauri::generate_handler![get_devices, run_adb, get_adb_version, get_app_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
