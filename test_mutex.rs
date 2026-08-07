use std::sync::Mutex;
use std::net::TcpListener;

static LEADER_LOCK: Mutex<Option<TcpListener>> = Mutex::new(None);

fn main() {
    let mut lock = LEADER_LOCK.lock().unwrap();
    if let Ok(listener) = TcpListener::bind("127.0.0.1:44321") {
        *lock = Some(listener);
        println!("Got lock!");
    }
}
