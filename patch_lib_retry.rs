fn run_web_bridge(app: AppHandle) {
    thread::spawn(move || {
        loop {
            if IS_BRIDGE_LEADER.load(Ordering::Relaxed) {
                thread::sleep(std::time::Duration::from_secs(5));
                continue;
            }
            if let Ok(listener) = TcpListener::bind("0.0.0.0:9977") {
                IS_BRIDGE_LEADER.store(true, Ordering::Relaxed);
                for stream in listener.incoming().flatten() {
                    let app_clone = app.clone();
                    thread::spawn(move || handle_web_bridge_request(app_clone, stream));
                }
                // If listener fails (e.g. dropped), we lost leadership
                IS_BRIDGE_LEADER.store(false, Ordering::Relaxed);
            } else {
                thread::sleep(std::time::Duration::from_secs(2));
            }
        }
    });
}
