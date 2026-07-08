use std::io::{BufRead, BufReader, Read};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{channel, Sender};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri::{AppHandle, Emitter, Window};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

async fn run_blocking<T, F>(task_name: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("{} task failed: {}", task_name, e))?
}

// ─────────────────────────────────────────────
//  Odin Binary Path Resolver
// ─────────────────────────────────────────────

fn get_odin_binary(app: &AppHandle) -> String {
    let resource_path = if cfg!(target_os = "windows") {
        app.path().resolve(
            "../bin/windows/odin4.exe",
            tauri::path::BaseDirectory::Resource,
        )
    } else {
        app.path()
            .resolve("../bin/linux/odin4", tauri::path::BaseDirectory::Resource)
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

fn extract_percentage(line: &str) -> Option<u32> {
    if let Some(start) = line.rfind('(') {
        if let Some(end) = line[start..].find("%)") {
            let num_str = &line[start + 1..start + end];
            if let Ok(pct) = num_str.parse::<u32>() {
                return Some(pct);
            }
        }
    }
    None
}

fn drain_pipe<R>(mut reader: R) -> thread::JoinHandle<String>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = String::new();
        let _ = reader.read_to_string(&mut output);
        output
    })
}

fn join_pipe_output(handle: Option<thread::JoinHandle<String>>) -> String {
    handle.and_then(|h| h.join().ok()).unwrap_or_default()
}

// ─────────────────────────────────────────────
//  IPC - Shared Progress mechanism via TCP Loopback
// ─────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct IpcProgressMessage {
    device: String,
    line: String,
}

static IPC_SENDER: Mutex<Option<Sender<String>>> = Mutex::new(None);

fn broadcast_progress(device_id: &str, line: &str) {
    let msg = IpcProgressMessage {
        device: device_id.to_string(),
        line: line.to_string(),
    };
    if let Ok(serialized) = serde_json::to_string(&msg) {
        if let Ok(guard) = IPC_SENDER.lock() {
            if let Some(tx) = &*guard {
                let _ = tx.send(serialized);
            }
        }
    }
}

fn broadcast_to_clients(
    clients: &Arc<Mutex<Vec<TcpStream>>>,
    msg: &str,
    exclude: Option<&TcpStream>,
) {
    use std::io::Write;
    if let Ok(mut guard) = clients.lock() {
        let mut to_remove = Vec::new();
        for (i, client) in guard.iter_mut().enumerate() {
            if let Some(exc) = exclude {
                if let (Ok(addr1), Ok(addr2)) = (client.peer_addr(), exc.peer_addr()) {
                    if addr1 == addr2 {
                        continue;
                    }
                }
            }
            if writeln!(client, "{}", msg).is_err() {
                to_remove.push(i);
            }
        }
        for &idx in to_remove.iter().rev() {
            guard.remove(idx);
        }
    }
}

fn remove_client(clients: &Arc<Mutex<Vec<TcpStream>>>, client_to_remove: &TcpStream) {
    if let Ok(mut guard) = clients.lock() {
        if let Ok(addr_to_remove) = client_to_remove.peer_addr() {
            if let Some(pos) = guard.iter().position(|c| {
                if let Ok(addr) = c.peer_addr() {
                    addr == addr_to_remove
                } else {
                    false
                }
            }) {
                guard.remove(pos);
            }
        }
    }
}

fn emit_progress_locally(app: &AppHandle, msg_json: &str) {
    if let Ok(msg) = serde_json::from_str::<IpcProgressMessage>(msg_json) {
        let _ = app.emit("flash-progress-ipc", msg);
    }
}

fn run_ipc_loop(app: AppHandle) {
    let (tx, rx) = channel::<String>();
    if let Ok(mut guard) = IPC_SENDER.lock() {
        *guard = Some(tx);
    }

    loop {
        match TcpListener::bind("127.0.0.1:9912") {
            Ok(listener) => {
                let clients = Arc::new(Mutex::new(Vec::new()));
                let clients_clone = clients.clone();

                let accept_handle = {
                    let listener = listener.try_clone().unwrap();
                    let clients = clients.clone();
                    let app = app.clone();
                    thread::spawn(move || {
                        listener.set_nonblocking(false).ok();
                        for stream in listener.incoming() {
                            if let Ok(stream) = stream {
                                let clients_list = clients.clone();
                                let app_h = app.clone();
                                {
                                    if let Ok(mut guard) = clients.lock() {
                                        guard.push(stream.try_clone().unwrap());
                                    }
                                }
                                thread::spawn(move || {
                                    let mut reader = BufReader::new(stream);
                                    let mut line = String::new();
                                    while reader.read_line(&mut line).is_ok() {
                                        if line.is_empty() {
                                            break;
                                        }
                                        let trimmed = line.trim().to_string();
                                        broadcast_to_clients(&clients_list, &trimmed, Some(reader.get_ref()));
                                        emit_progress_locally(&app_h, &trimmed);
                                        line.clear();
                                    }
                                    remove_client(&clients_list, reader.get_ref());
                                });
                            }
                        }
                    })
                };

                while let Ok(msg) = rx.recv() {
                    broadcast_to_clients(&clients_clone, &msg, None);
                }
                let _ = accept_handle.join();
                break;
            }
            Err(_) => {
                match TcpStream::connect("127.0.0.1:9912") {
                    Ok(stream) => {
                        let app_clone = app.clone();
                        let stream_clone = stream.try_clone().unwrap();

                        let read_handle = thread::spawn(move || {
                            let mut reader = BufReader::new(stream_clone);
                            let mut line = String::new();
                            while reader.read_line(&mut line).is_ok() {
                                if line.is_empty() {
                                    break;
                                }
                                emit_progress_locally(&app_clone, line.trim());
                                line.clear();
                            }
                        });

                        let mut writer = stream;
                        use std::io::Write;
                        while let Ok(msg) = rx.recv() {
                            if writeln!(writer, "{}", msg).is_err() {
                                break;
                            }
                        }
                        let _ = read_handle.join();
                    }
                    Err(_) => {
                        thread::sleep(std::time::Duration::from_secs(2));
                    }
                }
            }
        }
    }
}

// ─────────────────────────────────────────────
//  Odin Commands (integrated from odin-clone)
// ─────────────────────────────────────────────

#[tauri::command]
async fn odin_list_devices(app: AppHandle) -> Result<Vec<String>, String> {
    run_blocking("Odin list devices", move || odin_list_devices_blocking(app)).await
}

fn odin_list_devices_blocking(app: AppHandle) -> Result<Vec<String>, String> {
    let binary = get_odin_binary(&app);
    let mut cmd = Command::new(&binary);
    cmd.arg("-l");

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| format!("{}: {}", binary, e))?;

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



#[tauri::command]
async fn resolve_usb_paths(
    devices: Vec<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    run_blocking("Resolve USB paths", move || {
        Ok(devices
            .into_iter()
            .map(|dev| {
                let port = resolve_usb_path_blocking(dev.clone());
                (dev, port)
            })
            .collect())
    })
    .await
}

fn resolve_usb_path_blocking(dev: String) -> String {
    #[cfg(target_os = "linux")]
    {
        let parts: Vec<&str> = dev.split('/').collect();
        if parts.len() >= 3 {
            let bus = parts[parts.len() - 2].parse::<u32>().unwrap_or(0);
            let devnum = parts[parts.len() - 1].parse::<u32>().unwrap_or(0);

            if bus > 0 && devnum > 0 {
                if let Ok(entries) = std::fs::read_dir("/sys/bus/usb/devices/") {
                    for entry in entries.filter_map(Result::ok) {
                        let path = entry.path();
                        if let (Ok(b), Ok(d)) = (
                            std::fs::read_to_string(path.join("busnum")),
                            std::fs::read_to_string(path.join("devnum")),
                        ) {
                            if b.trim().parse::<u32>().unwrap_or(0) == bus
                                && d.trim().parse::<u32>().unwrap_or(0) == devnum
                            {
                                if let Some(name) = path.file_name() {
                                    return format!("USB:{}", name.to_string_lossy());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let parts: Vec<&str> = dev.split('/').collect();
    if parts.len() >= 2 {
        format!("USB:{}-{}", parts[parts.len() - 2], parts[parts.len() - 1])
    } else {
        dev
    }
}

#[derive(serde::Serialize)]
pub struct AdbDeviceExt {
    pub serial: String,
    pub usb_port: String,
    pub model: String,
    pub info: std::collections::HashMap<String, String>,
}

#[derive(serde::Serialize)]
pub struct SamsungPortInfo {
    pub port_name: String,
    pub usb_port: String,
    pub serial_number: Option<String>,
}

fn parse_getprop_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let split = trimmed.find("]: [")?;
    let key = trimmed.get(1..split)?;
    let value_start = split + 4;
    let value_end = trimmed.len().checked_sub(1)?;
    let value = trimmed.get(value_start..value_end)?;
    Some((key.to_string(), value.to_string()))
}

fn adb_props_blocking(adb: &str, serial: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let mut cmd = Command::new(adb);
    cmd.args(["-s", serial, "shell", "getprop"]);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut props = std::collections::HashMap::new();
    for line in stdout.lines() {
        if let Some((key, value)) = parse_getprop_line(line) {
            props.insert(key, value);
        }
    }
    Ok(props)
}

#[tauri::command]
async fn get_adb_devices_advanced() -> Result<Vec<AdbDeviceExt>, String> {
    run_blocking("ADB device scan", get_adb_devices_advanced_blocking).await
}

fn get_adb_devices_advanced_blocking() -> Result<Vec<AdbDeviceExt>, String> {
    let adb_path = find_adb();
    let output = Command::new(&adb_path)
        .arg("devices")
        .arg("-l")
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut threads = Vec::new();

    for line in stdout.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 && parts[1] == "device" {
            let serial = parts[0].to_string();
            let mut usb_port = "".to_string();
            let mut model_token = "".to_string();

            for p in &parts[2..] {
                if p.starts_with("usb:") {
                    usb_port = p.replace("usb:", "USB:");
                } else if p.starts_with("model:") {
                    model_token = p.replace("model:", "");
                }
            }

            let adb_path_clone = adb_path.clone();
            let serial_clone = serial.clone();
            let handle = std::thread::spawn(move || {
                let props = adb_props_blocking(&adb_path_clone, &serial_clone).unwrap_or_default();
                (props, usb_port, model_token)
            });
            threads.push((serial, handle));
        }
    }

    let mut devices = Vec::new();
    for (serial, handle) in threads {
        if let Ok((props, usb_port, model_token)) = handle.join() {
            let model = if let Some(m) = props.get("ro.product.model") {
                if !m.trim().is_empty() {
                    m.clone()
                } else {
                    model_token.clone()
                }
            } else {
                model_token.clone()
            };

            devices.push(AdbDeviceExt {
                serial,
                usb_port,
                model,
                info: props,
            });
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
    tauri::async_runtime::spawn_blocking(move || odin_flash_device_blocking(app, window, params))
        .await
        .map_err(|e| format!("Odin flash task failed: {}", e))?
}

fn odin_flash_device_blocking(
    app: AppHandle,
    window: Window,
    params: FlashParams,
) -> Result<String, String> {
    let binary = get_odin_binary(&app);
    let mut cmd = Command::new(&binary);

    // Skip internal MD5 check since we already verified it during file selection
    cmd.arg("--ignore-md5");

    if !params.bl.is_empty() {
        cmd.arg("-b").arg(&params.bl);
    }
    if !params.ap.is_empty() {
        cmd.arg("-a").arg(&params.ap);
    }
    if !params.cp.is_empty() {
        cmd.arg("-c").arg(&params.cp);
    }
    if !params.csc.is_empty() {
        cmd.arg("-s").arg(&params.csc);
    }
    if !params.userdata.is_empty() {
        cmd.arg("-u").arg(&params.userdata);
    }

    if !params.device.is_empty() {
        cmd.arg("-d").arg(&params.device);
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("{}: {}", binary, e))?;
    let stdout = child.stdout.take().unwrap();
    let stderr_reader = child.stderr.take().map(drain_pipe);
    let mut reader = BufReader::new(stdout);

    let device_id = params.device.clone();
    let mut buffer = Vec::new();
    let mut byte_buf = [0u8; 1];
    let mut last_pct = None;

    // Broadcast start of flash
    broadcast_progress(&device_id, "=====================\nSTARTING ODIN ENGINE\n=====================");

    while reader.read_exact(&mut byte_buf).is_ok() {
        let b = byte_buf[0];
        if b == b'\n' || b == b'\r' {
            if !buffer.is_empty() {
                let line = String::from_utf8_lossy(&buffer).to_string();
                if let Some(pct) = extract_percentage(&line) {
                    if Some(pct) != last_pct {
                        last_pct = Some(pct);
                        let _ = window.emit(&format!("flash-progress-{}", device_id), line.clone());
                        broadcast_progress(&device_id, &line);
                    }
                } else {
                    let _ = window.emit(&format!("flash-progress-{}", device_id), line.clone());
                    broadcast_progress(&device_id, &line);
                }
                buffer.clear();
            }
        } else {
            buffer.push(b);
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer).to_string();
        if let Some(pct) = extract_percentage(&line) {
            if Some(pct) != last_pct {
                let _ = window.emit(&format!("flash-progress-{}", device_id), line.clone());
                broadcast_progress(&device_id, &line);
            }
        } else {
            let _ = window.emit(&format!("flash-progress-{}", device_id), line.clone());
            broadcast_progress(&device_id, &line);
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = join_pipe_output(stderr_reader);

    if status.success() {
        let success_msg = format!("Flashing {} completed successfully.", params.device);
        broadcast_progress(&device_id, &format!("STATUS:Pass:{}", success_msg));
        Ok(success_msg)
    } else {
        let err_msg = if stderr.trim().is_empty() {
            format!("Flashing {} failed with status: {}", params.device, status)
        } else {
            format!(
                "Flashing {} failed with status: {}\n{}",
                params.device,
                status,
                stderr.trim()
            )
        };
        broadcast_progress(&device_id, &format!("STATUS:Fail:{}", err_msg));
        Err(err_msg)
    }
}

#[tauri::command]
async fn odin_check_file(
    app: AppHandle,
    window: Window,
    path: String,
    slot: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || odin_check_file_blocking(app, window, path, slot))
        .await
        .map_err(|e| format!("Odin check task failed: {}", e))?
}

fn odin_check_file_blocking(
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
    let stderr_reader = child.stderr.take().map(drain_pipe);

    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        let mut last_pct = None;

        // Read byte by byte to handle both \n and \r (odin4 uses \r for progress)
        let mut byte_buf = [0u8; 1];
        while reader.read_exact(&mut byte_buf).is_ok() {
            let b = byte_buf[0];
            if b == b'\n' || b == b'\r' {
                if !buffer.is_empty() {
                    let line = String::from_utf8_lossy(&buffer).to_string();
                    if let Some(pct) = extract_percentage(&line) {
                        if Some(pct) != last_pct {
                            last_pct = Some(pct);
                            let _ = window.emit(&format!("md5-progress-{}", slot), line);
                        }
                    } else {
                        let _ = window.emit(&format!("md5-progress-{}", slot), line);
                    }
                    buffer.clear();
                }
            } else {
                buffer.push(b);
            }
        }

        if !buffer.is_empty() {
            let line = String::from_utf8_lossy(&buffer).to_string();
            if let Some(pct) = extract_percentage(&line) {
                if Some(pct) != last_pct {
                    let _ = window.emit(&format!("md5-progress-{}", slot), line);
                }
            } else {
                let _ = window.emit(&format!("md5-progress-{}", slot), line);
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = join_pipe_output(stderr_reader);

    if status.success() {
        Ok("Valid".to_string())
    } else if stderr.trim().is_empty() {
        Err("Invalid file or MD5 mismatch".to_string())
    } else {
        Err(format!("Invalid file or MD5 mismatch\n{}", stderr.trim()))
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
async fn get_device_info(
    serial: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    run_blocking("ADB device info", move || get_device_info_blocking(serial)).await
}

fn get_device_info_blocking(
    serial: String,
) -> Result<std::collections::HashMap<String, String>, String> {
    let props = [
        "ro.product.model",
        "ro.build.PDA",
        "ro.csc.sales_code",
        "ro.csc.country_code",
        "ro.build.fingerprint",
    ];

    let prop_list = props.join(" ");
    let script = format!("for p in {}; do echo \"$p=$(getprop $p)\"; done", prop_list);
    let output = run_adb_blocking(vec!["-s".to_string(), serial, "shell".to_string(), script])?;

    let mut info = std::collections::HashMap::new();
    for line in output.lines() {
        if let Some((key, value)) = line.split_once('=') {
            info.insert(key.trim().to_string(), value.trim().to_string());
        }
    }

    for prop in props {
        info.entry(prop.to_string()).or_default();
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
async fn get_devices() -> Result<Vec<String>, String> {
    run_blocking("ADB devices", get_devices_blocking).await
}

fn get_devices_blocking() -> Result<Vec<String>, String> {
    let adb_path = find_adb();
    let mut cmd = Command::new(&adb_path);
    cmd.arg("devices");

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| e.to_string())?;

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
async fn run_adb(args: Vec<String>) -> Result<String, String> {
    run_blocking("ADB command", move || run_adb_blocking(args)).await
}

fn run_adb_blocking(args: Vec<String>) -> Result<String, String> {
    let adb_path = find_adb();
    let mut last_err = String::new();

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
            std::thread::sleep(std::time::Duration::from_millis(250 * attempt));
            continue;
        } else {
            break; // Other errors don't need retry
        }
    }

    Err(last_err)
}

#[tauri::command]
async fn get_samsung_ports() -> Result<Vec<String>, String> {
    run_blocking("Samsung port scan", get_samsung_ports_blocking).await
}

fn get_samsung_ports_blocking() -> Result<Vec<String>, String> {
    Ok(get_samsung_ports_detailed_blocking()?
        .into_iter()
        .map(|p| p.port_name)
        .collect())
}

fn tty_usb_path(port_name: &str) -> String {
    #[cfg(target_os = "linux")]
    {
        let tty_name = port_name.rsplit('/').next().unwrap_or(port_name);
        let sys_path = PathBuf::from("/sys/class/tty").join(tty_name).join("device");
        if let Ok(real_path) = std::fs::canonicalize(sys_path) {
            for component in real_path.components().rev() {
                let name = component.as_os_str().to_string_lossy();
                let base = name.split(':').next().unwrap_or(&name);
                if base
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false)
                    && base.contains('-')
                {
                    return format!("USB:{}", base);
                }
            }
        }
    }

    String::new()
}

#[tauri::command]
async fn get_samsung_ports_detailed() -> Result<Vec<SamsungPortInfo>, String> {
    run_blocking("Samsung detailed port scan", get_samsung_ports_detailed_blocking).await
}

fn get_samsung_ports_detailed_blocking() -> Result<Vec<SamsungPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let mut samsung_ports = vec![];
    for p in ports {
        if let serialport::SerialPortType::UsbPort(info) = p.port_type {
            if info.vid == 0x04e8 {
                samsung_ports.push(SamsungPortInfo {
                    usb_port: tty_usb_path(&p.port_name),
                    port_name: p.port_name,
                    serial_number: info.serial_number,
                });
            }
        }
    }
    Ok(samsung_ports)
}



#[tauri::command]
async fn send_at_command(port_name: String, command: String) -> Result<String, String> {
    run_blocking("AT command", move || {
        send_at_command_blocking(port_name, command)
    })
    .await
}

fn send_at_command_blocking(port_name: String, command: String) -> Result<String, String> {
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
//  Busy Device Tracking & Cache (Cross-Instance)
// ─────────────────────────────────────────────

const BUSY_FILE: &str = if cfg!(target_os = "windows") {
    "C:\\Windows\\Temp\\flashkit_busy.json"
} else {
    "/tmp/flashkit_busy.json"
};

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct CachedAdbDevice {
    serial: String,
    usb_port: String,
    model: String,
    info: std::collections::HashMap<String, String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct BusyState {
    busy_devices: std::collections::HashSet<String>,
    adb_devices: Vec<CachedAdbDevice>,
    updated_at_ms: u128,
}

#[derive(serde::Serialize)]
struct DeviceCache {
    devices: Vec<CachedAdbDevice>,
    updated_at_ms: u128,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn read_busy_state() -> BusyState {
    if let Ok(data) = std::fs::read_to_string(BUSY_FILE) {
        if let Ok(state) = serde_json::from_str::<BusyState>(&data) {
            return state;
        }
        if let Ok(set) = serde_json::from_str::<std::collections::HashSet<String>>(&data) {
            return BusyState {
                busy_devices: set,
                ..Default::default()
            };
        }
    }
    BusyState::default()
}

fn write_busy_state(state: &BusyState) {
    if let Ok(json) = serde_json::to_string(state) {
        let _ = std::fs::write(BUSY_FILE, json);
    }
}

#[tauri::command]
fn mark_busy(serials: Vec<String>) {
    let mut state = read_busy_state();
    for s in serials {
        state.busy_devices.insert(s);
    }
    write_busy_state(&state);
}

#[tauri::command]
fn clear_busy(serials: Vec<String>) {
    let mut state = read_busy_state();
    for s in &serials {
        state.busy_devices.remove(s);
    }
    write_busy_state(&state);
}

#[tauri::command]
fn get_busy_devices() -> Vec<String> {
    read_busy_state().busy_devices.into_iter().collect()
}

#[tauri::command]
fn reset_busy_devices() {
    let mut state = read_busy_state();
    state.busy_devices.clear();
    write_busy_state(&state);
}

#[tauri::command]
fn reset_device_cache() {
    let mut state = read_busy_state();
    state.adb_devices.clear();
    state.updated_at_ms = now_ms();
    write_busy_state(&state);
}

#[tauri::command]
fn save_device_cache(devices: Vec<CachedAdbDevice>) {
    let mut state = read_busy_state();
    state.adb_devices = devices;
    state.updated_at_ms = now_ms();
    write_busy_state(&state);
}

#[tauri::command]
fn get_device_cache() -> DeviceCache {
    let state = read_busy_state();
    DeviceCache {
        devices: state.adb_devices,
        updated_at_ms: state.updated_at_ms,
    }
}

#[tauri::command]
async fn emergency_stop() -> Result<(), String> {
    run_blocking("Emergency stop", emergency_stop_blocking).await
}

fn emergency_stop_blocking() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Kill odin4.exe and adb.exe on Windows
        let _ = Command::new("taskkill")
            .args(&["/F", "/IM", "odin4.exe", "/T"])
            .creation_flags(0x08000000)
            .output();
        let _ = Command::new("taskkill")
            .args(&["/F", "/IM", "adb.exe", "/T"])
            .creation_flags(0x08000000)
            .output();
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
        .setup(|app| {
            let handle = app.handle().clone();
            thread::spawn(move || {
                run_ipc_loop(handle);
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            // ADB / Provisioning commands
            get_devices,
            run_adb,
            get_samsung_ports,
            get_samsung_ports_detailed,
            resolve_usb_paths,
            get_adb_devices_advanced,
            send_at_command,
            get_resource_path,
            get_device_info,
            // Odin flash commands
            odin_list_devices,
            odin_flash_device,
            odin_check_file,
            // Cross-instance busy tracking
            mark_busy,
            clear_busy,
            get_busy_devices,
            reset_busy_devices,
            reset_device_cache,
            save_device_cache,
            get_device_cache,
            emergency_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
