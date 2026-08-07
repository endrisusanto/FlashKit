use std::sync::atomic::{AtomicBool, Ordering};

static IS_BRIDGE_LEADER: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn is_bridge_leader() -> bool {
    IS_BRIDGE_LEADER.load(Ordering::Relaxed)
}
