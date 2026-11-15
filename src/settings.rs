//! Instellingen (Client ID, refresh-token, volume) in één JSON-bestand.

use std::sync::Mutex;

use serde_json::{Map, Value};

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> std::path::PathBuf {
    crate::player::data_dir().join("instellingen.json")
}

fn read() -> Map<String, Value> {
    std::fs::read(path()).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn get(key: &str) -> Value {
    let _guard = LOCK.lock();
    read().remove(key).unwrap_or(Value::Null)
}

pub fn set(key: &str, value: Value) {
    let _guard = LOCK.lock();
    let mut all = read();
    if value.is_null() {
        all.remove(key);
    } else {
        all.insert(key.into(), value);
    }
    let _ = std::fs::create_dir_all(crate::player::data_dir());
    let _ = std::fs::write(path(), serde_json::to_vec_pretty(&all).unwrap_or_default());
}
