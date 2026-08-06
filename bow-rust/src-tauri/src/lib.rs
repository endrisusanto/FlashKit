use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri::{AppHandle, Emitter, WebviewWindow, WindowEvent};

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
    if let Some(pct_idx) = line.find('%') {
        let prefix = &line[..pct_idx];
        let mut digits = String::new();
        for ch in prefix.chars().rev() {
            if ch.is_ascii_digit() {
                digits.insert(0, ch);
            } else if !digits.is_empty() {
                break;
            }
        }
        if let Ok(pct) = digits.parse::<u32>() {
            if pct <= 100 {
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
#[serde(tag = "kind")]
enum IpcMessage {
    Progress { device: String, line: String },
    BusyState { devices: Vec<String> },
    DeviceCache { cache: DeviceCache },
    SharedUiState { state: SharedUiState },
}

#[derive(serde::Serialize, Clone)]
struct WebProgressMessage {
    seq: u64,
    device: String,
    line: String,
}

static IPC_SENDER: Mutex<Option<Sender<String>>> = Mutex::new(None);
static WEB_PROGRESS: Mutex<Vec<WebProgressMessage>> = Mutex::new(Vec::new());
static WEB_PROGRESS_SEQ: Mutex<u64> = Mutex::new(0);
static WEB_SSE_STREAMS: Mutex<Vec<TcpStream>> = Mutex::new(Vec::new());
static SHARED_UI_MEMORY_STATE: Mutex<Option<SharedUiState>> = Mutex::new(None);

fn broadcast_shared_ui_state(state: &SharedUiState) {
    let Ok(json) = serde_json::to_string(state) else { return; };
    let frame = format!("event: message\ndata: {}\n\n", json);
    if let Ok(mut streams) = WEB_SSE_STREAMS.lock() {
        streams.retain_mut(|stream| {
            use std::io::Write;
            stream.write_all(frame.as_bytes()).is_ok()
        });
    }
    if let Ok(serialized) = serde_json::to_string(&IpcMessage::SharedUiState { state: state.clone() }) {
        send_ipc(serialized);
    }
}

fn update_verify_state(slot: &str, text: &str, progress: u32, verifying: bool) {
    let mut guard = SHARED_UI_MEMORY_STATE.lock().unwrap();
    let mut state = if let Some(cached) = &*guard {
        cached.clone()
    } else {
        std::fs::read_to_string(SHARED_UI_FILE)
            .ok()
            .and_then(|data| serde_json::from_str::<SharedUiState>(&data).ok())
            .unwrap_or_default()
    };

    if state.verify_state.is_null() || !state.verify_state.is_object() {
        state.verify_state = serde_json::json!({});
    }
    if let Some(map) = state.verify_state.as_object_mut() {
        map.insert(
            slot.to_string(),
            serde_json::json!({
                "text": text,
                "progress": progress,
                "verifying": verifying,
            }),
        );
    }
    state.updated_at_ms = now_ms();
    *guard = Some(state.clone());
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(SHARED_UI_FILE, json);
    }
    drop(guard);
    broadcast_shared_ui_state(&state);
}

fn update_odin_device_progress(device_id: &str, pct: u32, status: Option<&str>) {
    let mut guard = SHARED_UI_MEMORY_STATE.lock().unwrap();
    let mut state = if let Some(cached) = &*guard {
        cached.clone()
    } else {
        std::fs::read_to_string(SHARED_UI_FILE)
            .ok()
            .and_then(|data| serde_json::from_str::<SharedUiState>(&data).ok())
            .unwrap_or_default()
    };

    let mut changed = false;
    if state.odin_devices.is_null() || !state.odin_devices.is_object() {
        state.odin_devices = serde_json::json!({});
    }
    if let Some(map) = state.odin_devices.as_object_mut() {
        let dev_obj = map
            .entry(device_id.to_string())
            .or_insert_with(|| serde_json::json!({
                "path": device_id,
                "status": "Ready",
                "progress": 0,
                "checked": true,
            }));
        if let Some(obj) = dev_obj.as_object_mut() {
            obj.insert("progress".to_string(), serde_json::json!(pct));
            if let Some(st) = status {
                obj.insert("status".to_string(), serde_json::json!(st));
            }
            changed = true;
        }
    }
    if changed {
        state.updated_at_ms = now_ms();
        *guard = Some(state.clone());
        if let Ok(json) = serde_json::to_string(&state) {
            let _ = std::fs::write(SHARED_UI_FILE, json);
        }
        drop(guard);
        broadcast_shared_ui_state(&state);
    }
}

// ponytail: track active process IDs (PIDs) to kill only the current instance's processes during emergency stop instead of killing globally
static ACTIVE_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
// ponytail: track active MD5 check process per slot to auto-cancel previous check when a slot is overwritten
static ACTIVE_MD5_PIDS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn kill_pid(pid: u32) {
    #[cfg(target_os = "windows")]
    let _ = Command::new("taskkill")
        .args(&["/F", "/PID", &pid.to_string(), "/T"])
        .creation_flags(0x08000000)
        .output();
    #[cfg(not(target_os = "windows"))]
    let _ = Command::new("kill")
        .args(&["-9", &pid.to_string()])
        .output();
}

struct PidGuard(u32);

impl Drop for PidGuard {
    fn drop(&mut self) {
        if let Ok(mut pids) = ACTIVE_PIDS.lock() {
            pids.retain(|&x| x != self.0);
        }
    }
}

fn broadcast_progress(device_id: &str, line: &str) {
    let msg = IpcMessage::Progress {
        device: device_id.to_string(),
        line: line.to_string(),
    };
    if let Ok(mut seq) = WEB_PROGRESS_SEQ.lock() {
        *seq += 1;
        if let Ok(mut events) = WEB_PROGRESS.lock() {
            events.push(WebProgressMessage {
                seq: *seq,
                device: device_id.to_string(),
                line: line.to_string(),
            });
            if events.len() > 500 {
                let drain_count = events.len() - 500;
                events.drain(0..drain_count);
            }
        }
    }
    if let Ok(serialized) = serde_json::to_string(&msg) {
        send_ipc(serialized);
    }
}

fn send_ipc(serialized: String) {
    if let Ok(guard) = IPC_SENDER.lock() {
        if let Some(tx) = &*guard {
            let _ = tx.send(serialized);
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
    if let Ok(msg) = serde_json::from_str::<IpcMessage>(msg_json) {
        match msg {
            IpcMessage::Progress { device, line } => {
                let _ = app.emit("flash-progress-ipc", serde_json::json!({ "device": device, "line": line }));
            }
            IpcMessage::BusyState { devices } => {
                let _ = app.emit("busy-state-updated", devices);
            }
            IpcMessage::DeviceCache { cache } => {
                let _ = app.emit("device-cache-updated", cache);
            }
            IpcMessage::SharedUiState { state } => {
                let _ = app.emit("shared-ui-updated", state);
            }
        }
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
                                        broadcast_to_clients(
                                            &clients_list,
                                            &trimmed,
                                            Some(reader.get_ref()),
                                        );
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
            Err(_) => match TcpStream::connect("127.0.0.1:9912") {
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
            },
        }
    }
}

#[derive(serde::Deserialize)]
struct BridgeInvokeRequest {
    command: String,
    #[serde(default)]
    args: serde_json::Value,
}

#[derive(serde::Serialize)]
struct BridgeFileEntry {
    path: String,
    name: String,
    is_dir: bool,
}

fn run_web_bridge(app: AppHandle) {
    let listener = match TcpListener::bind("0.0.0.0:9977") {
        Ok(listener) => listener,
        Err(_) => return,
    };

    for stream in listener.incoming().flatten() {
        let app = app.clone();
        thread::spawn(move || handle_web_bridge_request(app, stream));
    }
}

fn handle_web_bridge_request(app: AppHandle, mut stream: TcpStream) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let read = stream.read(&mut chunk).unwrap_or(0);
    buffer.extend_from_slice(&chunk[..read]);
    let header_end = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
        .unwrap_or(buffer.len());
    let headers = String::from_utf8_lossy(&buffer[..header_end]);
    let content_length = headers
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    while buffer.len().saturating_sub(header_end) < content_length {
        let read = stream.read(&mut chunk).unwrap_or(0);
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let request = String::from_utf8_lossy(&buffer[..header_end]);
    let request_body = buffer.get(header_end..).unwrap_or_default();

    if request.starts_with("GET /events") || request.starts_with("GET /ws") {
        use std::io::Write;
        let response = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
        if stream.write_all(response.as_bytes()).is_ok() {
            let state = read_shared_ui_state();
            if let Ok(json) = serde_json::to_string(&state) {
                let initial_frame = format!("event: message\ndata: {}\n\n", json);
                let _ = stream.write_all(initial_frame.as_bytes());
            }
            if let Ok(cloned) = stream.try_clone() {
                if let Ok(mut streams) = WEB_SSE_STREAMS.lock() {
                    streams.push(cloned);
                }
            }
            // ponytail: Keep request thread alive so TcpStream socket is not dropped and closed
            while stream.write_all(b": ping\n\n").is_ok() {
                thread::sleep(std::time::Duration::from_secs(15));
            }
        }
        return;
    }

    let body = if request.starts_with("GET /status ") {
        r#"{"desktop":true,"app":"FlashKit"}"#.to_string()
    } else if request.starts_with("GET /progress") {
        let since = request
            .split_whitespace()
            .nth(1)
            .and_then(|path| path.split_once("since=").map(|(_, value)| value))
            .and_then(|value| value.split('&').next())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let seq = WEB_PROGRESS_SEQ.lock().map(|seq| *seq).unwrap_or(0);
        let events = WEB_PROGRESS
            .lock()
            .map(|events| {
                events
                    .iter()
                    .filter(|event| event.seq > since)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        serde_json::json!({ "seq": seq, "events": events }).to_string()
    } else if request.starts_with("POST /focus ") || request.starts_with("GET /focus ") {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        r#"{"focused":true}"#.to_string()
    } else if request.starts_with("OPTIONS ") {
        String::new()
    } else if request.starts_with("POST /invoke ") {
        match serde_json::from_slice::<BridgeInvokeRequest>(request_body) {
            Ok(payload) => bridge_invoke(app, payload),
            Err(err) => format!(r#"{{"ok":false,"error":"Invalid bridge request: {err}"}}"#),
        }
    } else {
        r#"{"ok":true}"#.to_string()
    };

    use std::io::Write;
    let response = format!(
        "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn bridge_ok<T: serde::Serialize>(value: T) -> String {
    serde_json::json!({ "ok": true, "value": value }).to_string()
}

fn bridge_result<T: serde::Serialize>(result: Result<T, String>) -> String {
    match result {
        Ok(value) => bridge_ok(value),
        Err(error) => serde_json::json!({ "ok": false, "error": error }).to_string(),
    }
}

fn bridge_arg_string(args: &serde_json::Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| format!("Missing {key}"))
}

fn list_server_files(path: Option<String>) -> Result<Vec<BridgeFileEntry>, String> {
    let base = Path::new("/run/media/endri-pro")
        .canonicalize()
        .map_err(|e| format!("/run/media/endri-pro: {e}"))?;
    let requested = path.unwrap_or_else(|| base.to_string_lossy().to_string());
    let requested = PathBuf::from(requested)
        .canonicalize()
        .map_err(|e| e.to_string())?;

    if !requested.starts_with(&base) {
        return Err("Path outside /run/media/endri-pro".to_string());
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&requested)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        let lower = name.to_ascii_lowercase();
        if is_dir
            || lower.ends_with(".tar.md5")
            || lower.ends_with(".tar")
            || lower.ends_with(".img")
            || lower.ends_with(".lz4")
        {
            entries.push(BridgeFileEntry {
                path: path.to_string_lossy().to_string(),
                name,
                is_dir,
            });
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn bridge_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window not available".to_string())
}

fn bridge_invoke(app: AppHandle, payload: BridgeInvokeRequest) -> String {
    match payload.command.as_str() {
        "get_busy_devices" => bridge_ok(get_busy_devices()),
        "get_device_cache" => bridge_ok(get_device_cache()),
        "get_shared_ui_state" => bridge_ok(get_shared_ui_state()),
        "save_shared_ui_state" => {
            let firmware_files = payload.args.get("firmware_files").cloned();
            let selected_devices = serde_json::from_value(
                payload
                    .args
                    .get("selected_devices")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .ok();
            let automation_state = payload.args.get("automation_state").cloned();
            let odin_devices = payload.args.get("odin_devices").cloned();
            bridge_ok(save_shared_ui_state(
                app,
                firmware_files,
                selected_devices,
                automation_state,
                odin_devices,
            ))
        }
        "get_devices" => bridge_result(get_devices_blocking()),
        "odin_list_devices" => bridge_result(odin_list_devices_blocking(app)),
        "resolve_usb_paths" => {
            let devices: Vec<String> = serde_json::from_value(payload.args.get("devices").cloned().unwrap_or_default()).unwrap_or_default();
            bridge_ok(devices.into_iter().map(|dev| {
                let port = resolve_usb_path_blocking(dev.clone());
                (dev, port)
            }).collect::<std::collections::HashMap<String, String>>())
        }
        "odin_check_file" => {
            let path = bridge_arg_string(&payload.args, "path");
            let slot = bridge_arg_string(&payload.args, "slot");
            bridge_result(path.and_then(|path| slot.and_then(|slot| bridge_window(&app).and_then(|window| odin_check_file_blocking(app, window, path, slot)))))
        }
        "odin_flash_device" => {
            let params = serde_json::from_value::<FlashParams>(payload.args.get("params").cloned().unwrap_or_default()).map_err(|e| e.to_string());
            bridge_result(params.and_then(|params| bridge_window(&app).and_then(|window| odin_flash_device_blocking(app, window, params))))
        }
        "emergency_stop" => bridge_result(emergency_stop_blocking()),
        "list_server_files" => bridge_result(list_server_files(payload.args.get("path").and_then(|value| value.as_str()).map(str::to_string))),
        "get_adb_devices_advanced" => bridge_result(get_adb_devices_advanced_blocking()),
        "get_samsung_ports" => bridge_result(get_samsung_ports_blocking()),
        "get_samsung_ports_detailed" => bridge_result(get_samsung_ports_detailed_blocking()),
        "reset_busy_devices" => {
            reset_busy_devices(app);
            bridge_ok(())
        }
        "reset_device_cache" => bridge_ok(reset_device_cache(app)),
        "mark_busy" => {
            let serials = serde_json::from_value(payload.args.get("serials").cloned().unwrap_or_default()).unwrap_or_default();
            mark_busy(app, serials);
            bridge_ok(())
        }
        "clear_busy" => {
            let serials = serde_json::from_value(payload.args.get("serials").cloned().unwrap_or_default()).unwrap_or_default();
            clear_busy(app, serials);
            bridge_ok(())
        }
        "save_device_cache" => {
            let devices = serde_json::from_value(payload.args.get("devices").cloned().unwrap_or_default()).unwrap_or_default();
            bridge_ok(save_device_cache(app, devices))
        }
        "run_adb" => {
            let args = serde_json::from_value(payload.args.get("args").cloned().unwrap_or_default()).unwrap_or_default();
            bridge_result(run_adb_blocking(args))
        }
        "send_at_command" => {
            let port_name = bridge_arg_string(&payload.args, "portName");
            let command = bridge_arg_string(&payload.args, "command");
            bridge_result(port_name.and_then(|port_name| command.and_then(|command| send_at_command_blocking(port_name, command))))
        }
        "get_resource_path" => bridge_result(bridge_arg_string(&payload.args, "name").and_then(|name| get_resource_path(app, name))),
        _ => serde_json::json!({ "ok": false, "error": format!("Unsupported bridge command: {}", payload.command) }).to_string(),
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

fn adb_props_blocking(
    adb: &str,
    serial: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let wanted = ["ro.product.model"];
    let script = wanted
        .iter()
        .map(|prop| format!("echo \"{}=$(getprop {})\"", prop, prop))
        .collect::<Vec<_>>()
        .join("; ");
    let mut cmd = Command::new(adb);
    cmd.args(["-s", serial, "shell", &script]);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut props = std::collections::HashMap::new();
    for line in stdout.lines() {
        if let Some((key, value)) = line.trim().split_once('=') {
            props.insert(key.to_string(), value.trim().to_string());
        }
    }
    for prop in wanted {
        props.entry(prop.to_string()).or_default();
    }
    Ok(props)
}

#[tauri::command]
async fn get_adb_devices_advanced() -> Result<Vec<AdbDeviceExt>, String> {
    run_blocking("ADB device scan", get_adb_devices_advanced_blocking).await
}

fn normalize_model_name(s: &str) -> String {
    let cleaned = s.trim().replace('_', "-").to_uppercase();
    if cleaned.starts_with("SM") && !cleaned.starts_with("SM-") {
        cleaned.replacen("SM", "SM-", 1)
    } else {
        cleaned
    }
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
            let raw_model = if let Some(m) = props.get("ro.product.model") {
                if !m.trim().is_empty() {
                    m.clone()
                } else {
                    model_token.clone()
                }
            } else {
                model_token.clone()
            };
            let model = normalize_model_name(&raw_model);

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
    window: WebviewWindow,
    params: FlashParams,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || odin_flash_device_blocking(app, window, params))
        .await
        .map_err(|e| format!("Odin flash task failed: {}", e))?
}

fn odin_flash_device_blocking(
    app: AppHandle,
    window: WebviewWindow,
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
    let pid = child.id();
    {
        if let Ok(mut pids) = ACTIVE_PIDS.lock() {
            pids.push(pid);
        }
    }
    let _guard = PidGuard(pid);

    let stdout = child.stdout.take().unwrap();
    let stderr_reader = child.stderr.take().map(drain_pipe);
    let mut reader = BufReader::new(stdout);

    let device_id = params.device.clone();
    let mut buffer = Vec::new();
    let mut byte_buf = [0u8; 1];
    let mut is_odin_success = false;

    // Broadcast start of flash
    broadcast_progress(
        &device_id,
        "=====================\nSTARTING ODIN ENGINE\n=====================",
    );

    let check_success_keyword = |line: &str| -> bool {
        let upper = line.to_uppercase();
        upper.contains("SUCCEEDED 1")
            || upper.contains("FAILED 0")
            || upper.contains("ALL THREADS COMPLETED")
            || upper.contains("PASS!")
            || upper.contains("COMPLETED SUCCESSFULLY")
    };

    let mut last_emitted_pct: u32 = 0;
    let mut last_emitted_ms: u128 = 0;

    while reader.read_exact(&mut byte_buf).is_ok() {
        let b = byte_buf[0];
        if b == b'\n' || b == b'\r' {
            if !buffer.is_empty() {
                let line = String::from_utf8_lossy(&buffer).to_string();
                if check_success_keyword(&line) {
                    is_odin_success = true;
                }
                
                let pct = extract_percentage(&line).unwrap_or(last_emitted_pct);
                let now = now_ms();

                let _ = window.emit(&format!("flash-progress-{}", device_id), line.clone());
                broadcast_progress(&device_id, &line);

                if pct != last_emitted_pct || now >= last_emitted_ms + 100 {
                    last_emitted_pct = pct;
                    last_emitted_ms = now;
                    update_odin_device_progress(&device_id, pct, Some("Flashing..."));
                }

                buffer.clear();
            }
        } else {
            buffer.push(b);
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer).to_string();
        if check_success_keyword(&line) {
            is_odin_success = true;
        }
        let pct = extract_percentage(&line).unwrap_or(last_emitted_pct);
        let _ = window.emit(&format!("flash-progress-{}", device_id), line.clone());
        broadcast_progress(&device_id, &line);
        update_odin_device_progress(&device_id, pct, Some("Flashing..."));
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = join_pipe_output(stderr_reader);

    let is_pass = status.success() || is_odin_success || last_emitted_pct == 100;

    if is_pass {
        let success_msg = format!("Flashing {} completed successfully.", params.device);
        broadcast_progress(&device_id, &format!("STATUS:Pass:{}", success_msg));
        update_odin_device_progress(&device_id, 100, Some("Pass"));
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
        update_odin_device_progress(&device_id, 0, Some("Fail"));
        Err(err_msg)
    }
}

#[tauri::command]
async fn odin_check_file(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    slot: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || odin_check_file_blocking(app, window, path, slot))
        .await
        .map_err(|e| format!("Odin check task failed: {}", e))?
}

fn odin_check_file_blocking(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    slot: String,
) -> Result<String, String> {
    // ponytail: auto-cancel previous MD5 check process for this slot if running
    if let Ok(mut lock) = ACTIVE_MD5_PIDS.lock() {
        let map = lock.get_or_insert_with(HashMap::new);
        if let Some(old_pid) = map.remove(&slot) {
            kill_pid(old_pid);
        }
    }

    let binary = get_odin_binary(&app);
    let mut cmd = Command::new(&binary);
    cmd.arg("--md5sum-only").arg("-a").arg(&path);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let fname = path.split(['/', '\\']).last().unwrap_or(&path).to_string();
    update_verify_state(&slot, &format!("Verifying MD5... 0% ({})", fname), 0, true);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("{}: {}", binary, e))?;
    let pid = child.id();
    {
        if let Ok(mut pids) = ACTIVE_PIDS.lock() {
            pids.push(pid);
        }
        if let Ok(mut lock) = ACTIVE_MD5_PIDS.lock() {
            lock.get_or_insert_with(HashMap::new)
                .insert(slot.clone(), pid);
        }
    }
    let _guard = PidGuard(pid);

    let stderr_reader = child.stderr.take().map(drain_pipe);

    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        let mut last_emitted_pct: u32 = 0;
        let mut last_emitted_ms: u128 = 0;

        // Read byte by byte to handle both \n and \r (odin4 uses \r for progress)
        let mut byte_buf = [0u8; 1];
        while reader.read_exact(&mut byte_buf).is_ok() {
            let b = byte_buf[0];
            if b == b'\n' || b == b'\r' {
                if !buffer.is_empty() {
                    let line = String::from_utf8_lossy(&buffer).to_string();
                    if let Some(pct) = extract_percentage(&line) {
                        let now = now_ms();
                        if pct != last_emitted_pct {
                            let _ = window.emit(&format!("md5-progress-{}", slot), line.clone());
                        }
                        if pct == 100 || pct >= last_emitted_pct + 3 || now >= last_emitted_ms + 150 {
                            last_emitted_pct = pct;
                            last_emitted_ms = now;
                            update_verify_state(&slot, &format!("Verifying MD5... {}% ({})", pct, fname), pct, true);
                        }
                    } else {
                        let _ = window.emit(&format!("md5-progress-{}", slot), line.clone());
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
                let _ = window.emit(&format!("md5-progress-{}", slot), line.clone());
                update_verify_state(&slot, &format!("Verifying MD5... {}% ({})", pct, fname), pct, true);
            } else {
                let _ = window.emit(&format!("md5-progress-{}", slot), line.clone());
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = join_pipe_output(stderr_reader);

    // ponytail: remove slot PID from active map when done
    if let Ok(mut lock) = ACTIVE_MD5_PIDS.lock() {
        if let Some(map) = lock.as_mut() {
            if map.get(&slot) == Some(&pid) {
                map.remove(&slot);
            }
        }
    }

    if status.success() {
        update_verify_state(&slot, &fname, 100, false);
        Ok("Valid".to_string())
    } else {
        update_verify_state(&slot, "ERROR: Invalid MD5!", 0, false);
        if stderr.trim().is_empty() {
            Err("Invalid file or MD5 mismatch".to_string())
        } else {
            Err(format!("Invalid file or MD5 mismatch\n{}", stderr.trim()))
        }
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
        let sys_path = PathBuf::from("/sys/class/tty")
            .join(tty_name)
            .join("device");
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
    run_blocking(
        "Samsung detailed port scan",
        get_samsung_ports_detailed_blocking,
    )
    .await
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

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct DeviceCache {
    devices: Vec<CachedAdbDevice>,
    updated_at_ms: u128,
}

const SHARED_UI_FILE: &str = if cfg!(target_os = "windows") {
    "C:\\Windows\\Temp\\flashkit_ui_state.json"
} else {
    "/tmp/flashkit_ui_state.json"
};

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct SharedFirmwareFiles {
    bl: String,
    ap: String,
    cp: String,
    csc: String,
    userdata: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct SharedAutomationState {
    seq_odin: bool,
    seq_skip_wz: bool,
    seq_gba: bool,
    seq_wifi: bool,
    loading: bool,
    current_step: Option<u32>,
    is_stopping: bool,
    logs: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct SharedUiState {
    firmware_files: SharedFirmwareFiles,
    #[serde(default)]
    verify_state: serde_json::Value,
    selected_devices: Vec<String>,
    automation_state: SharedAutomationState,
    #[serde(default)]
    odin_devices: serde_json::Value,
    updated_at_ms: u128,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn read_shared_ui_state() -> SharedUiState {
    if let Ok(guard) = SHARED_UI_MEMORY_STATE.lock() {
        if let Some(cached) = &*guard {
            return cached.clone();
        }
    }
    let mut state = std::fs::read_to_string(SHARED_UI_FILE)
        .ok()
        .and_then(|data| serde_json::from_str::<SharedUiState>(&data).ok())
        .unwrap_or_default();

    // ponytail: Never load historical log text or stale stopping/loading/flashing flags from disk file
    state.automation_state.logs.clear();
    state.automation_state.is_stopping = false;
    state.automation_state.loading = false;
    state.automation_state.current_step = None;

    if let Some(map) = state.odin_devices.as_object_mut() {
        for (_key, val) in map.iter_mut() {
            if let Some(obj) = val.as_object_mut() {
                if obj.get("status").and_then(|s| s.as_str()) == Some("Flashing...") {
                    obj.insert("status".to_string(), serde_json::json!("Ready"));
                    obj.insert("progress".to_string(), serde_json::json!(0));
                }
            }
        }
    }

    if let Ok(mut guard) = SHARED_UI_MEMORY_STATE.lock() {
        *guard = Some(state.clone());
    }
    state
}

fn write_shared_ui_state(state: &SharedUiState) {
    if let Ok(mut guard) = SHARED_UI_MEMORY_STATE.lock() {
        *guard = Some(state.clone());
    }
    if let Ok(json) = serde_json::to_string(state) {
        let _ = std::fs::write(SHARED_UI_FILE, json);
    }
}

fn clean_startup_cache() {
    let mut busy = read_busy_state();
    busy.busy_devices.clear();
    write_busy_state(&busy);

    // ponytail: Reset shared UI state on startup so UI starts with a clean slate
    let default_state = SharedUiState::default();
    write_shared_ui_state(&default_state);
}

#[tauri::command]
fn get_shared_ui_state() -> SharedUiState {
    read_shared_ui_state()
}

#[tauri::command(rename_all = "snake_case")]
fn save_shared_ui_state(
    app: AppHandle,
    firmware_files: Option<serde_json::Value>,
    selected_devices: Option<Vec<String>>,
    automation_state: Option<serde_json::Value>,
    odin_devices: Option<serde_json::Value>,
) -> SharedUiState {
    let mut guard = SHARED_UI_MEMORY_STATE.lock().unwrap();
    let mut state = if let Some(cached) = &*guard {
        cached.clone()
    } else {
        std::fs::read_to_string(SHARED_UI_FILE)
            .ok()
            .and_then(|data| serde_json::from_str::<SharedUiState>(&data).ok())
            .unwrap_or_default()
    };



    if let Some(val) = firmware_files {
        if !val.is_null() && val.is_object() {
            if let Ok(files) = serde_json::from_value::<SharedFirmwareFiles>(val) {
                if files.bl.is_empty() && files.ap.is_empty() && files.cp.is_empty() && files.csc.is_empty() && files.userdata.is_empty() {
                    state.verify_state = serde_json::json!({});
                }
                state.firmware_files = files;
            }
        }
    }
    if let Some(devices) = selected_devices {
        state.selected_devices = devices;
    }
    if let Some(patch) = automation_state {
        merge_automation_state(&mut state.automation_state, patch);
    }
    if let Some(incoming_devices) = odin_devices {
        if let (Some(existing_map), Some(incoming_map)) = (state.odin_devices.as_object_mut(), incoming_devices.as_object()) {
            for (key, inc_val) in incoming_map {
                if let Some(existing_val) = existing_map.get_mut(key) {
                    if let (Some(existing_obj), Some(inc_obj)) = (existing_val.as_object_mut(), inc_val.as_object()) {
                        let is_flashing = existing_obj.get("status").and_then(|s| s.as_str()) == Some("Flashing...");
                        for (k, v) in inc_obj {
                            if is_flashing && (k == "status" || k == "progress") {
                                continue;
                            }
                            existing_obj.insert(k.clone(), v.clone());
                        }
                    } else {
                        existing_map.insert(key.clone(), inc_val.clone());
                    }
                } else {
                    existing_map.insert(key.clone(), inc_val.clone());
                }
            }
        } else {
            state.odin_devices = incoming_devices;
        }
    }
    state.updated_at_ms = now_ms();
    
    // Save to memory cache
    *guard = Some(state.clone());
    
    // Save to disk file
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = std::fs::write(SHARED_UI_FILE, json);
    }
    
    // Drop lock before broadcasting to prevent deadlock risks
    drop(guard);

    broadcast_shared_ui_state(&state);
    let _ = app.emit("shared-ui-updated", state.clone());
    state
}

fn merge_automation_state(state: &mut SharedAutomationState, patch: serde_json::Value) {
    let Some(patch) = patch.as_object() else {
        return;
    };
    if let Some(value) = patch.get("seq_odin").and_then(|v| v.as_bool()) {
        state.seq_odin = value;
    }
    if let Some(value) = patch.get("seq_skip_wz").and_then(|v| v.as_bool()) {
        state.seq_skip_wz = value;
    }
    if let Some(value) = patch.get("seq_gba").and_then(|v| v.as_bool()) {
        state.seq_gba = value;
    }
    if let Some(value) = patch.get("seq_wifi").and_then(|v| v.as_bool()) {
        state.seq_wifi = value;
    }
    if let Some(value) = patch.get("loading").and_then(|v| v.as_bool()) {
        state.loading = value;
    }
    if let Some(value) = patch.get("current_step") {
        state.current_step = value.as_u64().map(|value| value as u32);
    }
    if let Some(value) = patch.get("is_stopping").and_then(|v| v.as_bool()) {
        state.is_stopping = value;
    }
    if let Some(logs) = patch
        .get("logs")
        .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
    {
        state.logs = logs;
    }
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

fn device_cache_from_state(state: &BusyState) -> DeviceCache {
    DeviceCache {
        devices: state.adb_devices.clone(),
        updated_at_ms: state.updated_at_ms,
    }
}

fn emit_busy_state(app: &AppHandle) {
    let devices = get_busy_devices();
    let _ = app.emit("busy-state-updated", devices.clone());
    if let Ok(serialized) = serde_json::to_string(&IpcMessage::BusyState { devices }) {
        send_ipc(serialized);
    }
}

fn emit_device_cache(app: &AppHandle, cache: DeviceCache) {
    let _ = app.emit("device-cache-updated", cache.clone());
    if let Ok(serialized) = serde_json::to_string(&IpcMessage::DeviceCache { cache }) {
        send_ipc(serialized);
    }
}

#[tauri::command]
fn mark_busy(app: AppHandle, serials: Vec<String>) {
    let mut state = read_busy_state();
    for s in serials {
        state.busy_devices.insert(s);
    }
    write_busy_state(&state);
    emit_busy_state(&app);
}

#[tauri::command]
fn clear_busy(app: AppHandle, serials: Vec<String>) {
    let mut state = read_busy_state();
    for s in &serials {
        state.busy_devices.remove(s);
    }
    write_busy_state(&state);
    emit_busy_state(&app);
}

#[tauri::command]
fn get_busy_devices() -> Vec<String> {
    read_busy_state().busy_devices.into_iter().collect()
}

#[tauri::command]
fn reset_busy_devices(app: AppHandle) {
    let mut state = read_busy_state();
    state.busy_devices.clear();
    state.adb_devices.clear();
    state.updated_at_ms = now_ms();
    write_busy_state(&state);
    emit_busy_state(&app);

    let mut ui_state = read_shared_ui_state();
    ui_state.odin_devices = serde_json::json!({});
    ui_state.verify_state = serde_json::json!({});
    ui_state.updated_at_ms = now_ms();
    write_shared_ui_state(&ui_state);
    let _ = app.emit("shared-ui-updated", ui_state.clone());
}

#[tauri::command]
fn reset_device_cache(app: AppHandle) -> DeviceCache {
    let mut state = read_busy_state();
    state.adb_devices.clear();
    state.busy_devices.clear();
    state.updated_at_ms = now_ms();
    write_busy_state(&state);

    let mut ui_state = read_shared_ui_state();
    ui_state.odin_devices = serde_json::json!({});
    ui_state.verify_state = serde_json::json!({});
    ui_state.automation_state.logs.clear();
    ui_state.automation_state.loading = false;
    ui_state.automation_state.current_step = None;
    ui_state.updated_at_ms = now_ms();
    write_shared_ui_state(&ui_state);

    let cache = device_cache_from_state(&state);
    emit_device_cache(&app, cache.clone());
    emit_busy_state(&app);
    let _ = app.emit("shared-ui-updated", ui_state.clone());
    cache
}

#[tauri::command]
fn save_device_cache(app: AppHandle, devices: Vec<CachedAdbDevice>) -> DeviceCache {
    let mut state = read_busy_state();
    state.adb_devices = devices;
    state.updated_at_ms = now_ms();
    write_busy_state(&state);
    let cache = device_cache_from_state(&state);
    emit_device_cache(&app, cache.clone());
    cache
}

#[tauri::command]
fn get_device_cache() -> DeviceCache {
    let state = read_busy_state();
    device_cache_from_state(&state)
}

#[tauri::command]
async fn emergency_stop() -> Result<(), String> {
    run_blocking("Emergency stop", emergency_stop_blocking).await
}

fn emergency_stop_blocking() -> Result<(), String> {
    let pids = {
        if let Ok(pids) = ACTIVE_PIDS.lock() {
            pids.clone()
        } else {
            Vec::new()
        }
    };

    for pid in pids {
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(&["/F", "/PID", &pid.to_string(), "/T"])
                .creation_flags(0x08000000)
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = Command::new("kill")
                .args(&["-9", &pid.to_string()])
                .output();
        }
    }
    Ok(())
}

static APP_TRAY_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn set_app_tray_enabled(app: tauri::AppHandle, enabled: bool) {
    APP_TRAY_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
    if let Some(tray) = app.tray_by_id("main_tray") {
        let _ = tray.set_visible(enabled);
    }
}

#[tauri::command]
fn get_app_tray_enabled() -> bool {
    APP_TRAY_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
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
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            clean_startup_cache();
            let show = MenuItem::with_id(app, "show", "Show FlashKit", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main_tray")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let created_tray = tray.build(app)?;
            let _ = created_tray.set_visible(APP_TRAY_ENABLED.load(std::sync::atomic::Ordering::Relaxed));

            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }
            let handle = app.handle().clone();
            thread::spawn(move || {
                run_ipc_loop(handle);
            });
            let bridge_handle = app.handle().clone();
            thread::spawn(move || {
                run_web_bridge(bridge_handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if APP_TRAY_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
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
            get_shared_ui_state,
            save_shared_ui_state,
            emergency_stop,
            set_app_tray_enabled,
            get_app_tray_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
