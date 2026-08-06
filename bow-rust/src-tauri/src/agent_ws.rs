use tauri::{AppHandle, Manager};
use std::sync::Mutex;
use std::time::Duration;
use futures_util::{StreamExt, SinkExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::protocol::Message;

use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

// Static channel sender to communicate with the WebSocket client thread
static AGENT_WS_TX: Mutex<Option<UnboundedSender<String>>> = Mutex::new(None);

pub fn send_to_cloud_ws(msg: String) {
    if let Ok(guard) = AGENT_WS_TX.lock() {
        if let Some(tx) = &*guard {
            let _ = tx.send(msg);
        }
    }
}

fn url_encode(input: &str) -> String {
    let mut encoded = String::new();
    for b in input.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(b as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", b));
            }
        }
    }
    encoded
}

pub fn run_cloud_agent_loop(app: AppHandle) {
    // Start tokio runtime to run async client
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let (tx, mut rx) = unbounded_channel::<String>();
        
        // Save sender to global static
        if let Ok(mut guard) = AGENT_WS_TX.lock() {
            *guard = Some(tx);
        }

        // Get Configuration from Environment
        let broker_url = std::env::var("FLASHKIT_BROKER_URL")
            .unwrap_or_else(|_| "wss://flashkit.endrisusanto.my.id/ws/agent".to_string());
        let token = std::env::var("FLASHKIT_AGENT_TOKEN")
            .unwrap_or_else(|_| "flashkit-secure-token-2026".to_string());
        
        // Generate or get Agent ID
        let hostname = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .unwrap_or_else(|_| "workstation".to_string());
        
        let agent_id = std::env::var("FLASHKIT_AGENT_ID")
            .unwrap_or_else(|_| hostname.clone());
        let agent_name = std::env::var("FLASHKIT_AGENT_NAME")
            .unwrap_or_else(|_| hostname.clone());

        let connect_url = format!(
            "{}?token={}&agent_id={}&name={}",
            broker_url,
            url_encode(&token),
            url_encode(&agent_id),
            url_encode(&agent_name)
        );

        println!("🔌 Cloud Agent: Target url: {}", broker_url);
        println!("🔌 Cloud Agent: Registration ID: {}", agent_id);

        let mut backoff = 1;

        loop {
            println!("🔌 Cloud Agent: Connecting to cloud server...");
            match connect_async(&connect_url).await {
                Ok((ws_stream, _)) => {
                    println!("🔌 Cloud Agent: Successfully connected to cloud server!");
                    backoff = 1; // Reset backoff
                    let (mut write, mut read) = ws_stream.split();

                    // Active ws loop
                    loop {
                        tokio::select! {
                            // 1. Handle messages sent from dashboard (commands)
                            incoming = read.next() => {
                                match incoming {
                                    Some(Ok(Message::Text(text))) => {
                                        let app_h = app.clone();
                                        tokio::task::spawn_blocking(move || {
                                            if let Err(e) = handle_dashboard_command(app_h, &text) {
                                                eprintln!("Error executing dashboard command: {}", e);
                                            }
                                        });
                                    }
                                    Some(Ok(Message::Close(_))) | None => {
                                        println!("🔌 Cloud Agent: Server closed connection");
                                        break;
                                    }
                                    _ => {}
                                }
                            }
                            // 2. Handle outgoing progress messages & shared UI states from channel
                            outgoing = rx.recv() => {
                                if let Some(msg_str) = outgoing {
                                    if write.send(Message::Text(msg_str)).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                Err(err) => {
                    eprintln!("🔌 Cloud Agent connection error: {}", err);
                }
            }

            // Retry reconnect with backoff
            let sleep_secs = std::cmp::min(backoff * 2, 60);
            println!("🔌 Cloud Agent: Reconnecting in {} seconds...", sleep_secs);
            tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
            backoff = std::cmp::min(backoff + 1, 6);
        }
    });
}

fn handle_dashboard_command(app: AppHandle, raw_json: &str) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(raw_json).map_err(|e| e.to_string())?;
    let command = parsed.get("command").and_then(|c| c.as_str()).ok_or("Missing command field")?;

    println!("📥 Cloud Agent: Received command '{}'", command);

    match command {
        "save_shared_ui_state" => {
            let firmware_files = parsed.get("firmware_files").cloned();
            let selected_devices = parsed.get("selected_devices")
                .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok());
            let automation_state = parsed.get("automation_state").cloned();
            let odin_devices = parsed.get("odin_devices").cloned();

            super::save_shared_ui_state(
                app,
                firmware_files,
                selected_devices,
                automation_state,
                odin_devices
            );
        }
        "odin_flash_device" => {
            let params_val = parsed.get("params").ok_or("Missing params")?;
            let params: super::FlashParams = serde_json::from_value(params_val.clone()).map_err(|e| e.to_string())?;
            let window = app.get_webview_window("main").ok_or("Main window not available")?;
            
            // Execute in background
            tauri::async_runtime::spawn(async move {
                let dev_id = params.device.clone();
                let res = super::odin_flash_device(app, window, params).await;
                println!("Flash result for {}: {:?}", dev_id, res);
            });
        }
        "odin_check_file" => {
            let path = parsed.get("path").and_then(|p| p.as_str()).ok_or("Missing path")?.to_string();
            let slot = parsed.get("slot").and_then(|s| s.as_str()).ok_or("Missing slot")?.to_string();
            let window = app.get_webview_window("main").ok_or("Main window not available")?;

            tauri::async_runtime::spawn(async move {
                let res = super::odin_check_file(app, window, path, slot).await;
                println!("File check result: {:?}", res);
            });
        }
        "emergency_stop" => {
            tauri::async_runtime::spawn(async move {
                let _ = super::emergency_stop().await;
            });
        }
        _ => {
            return Err(format!("Unknown command: {}", command));
        }
    }

    Ok(())
}
