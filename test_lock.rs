use std::fs::File;
use fs2::FileExt;

fn main() {
    let file = File::create("/tmp/flashkit_leader.lock").unwrap();
    let is_leader = file.try_lock_exclusive().is_ok();
    println!("Am I leader? {}", is_leader);
}
