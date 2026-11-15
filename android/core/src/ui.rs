//! Gebeurtenissen voor de app: een wachtrij die `Core.next()` leegt.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

struct Queue {
    tx: Sender<String>,
    rx: Mutex<Receiver<String>>,
}

static QUEUE: OnceLock<Queue> = OnceLock::new();
/// De laatste status, voor een pagina die opnieuw laadt.
pub static LAST_STATUS: Mutex<Option<String>> = Mutex::new(None);

fn queue() -> &'static Queue {
    QUEUE.get_or_init(|| {
        let (tx, rx) = channel();
        Queue { tx, rx: Mutex::new(rx) }
    })
}

pub fn send(msg: Value) {
    let text = msg.to_string();
    if msg["type"] == "status" {
        if let Ok(mut last) = LAST_STATUS.lock() {
            *last = Some(text.clone());
        }
    }
    let _ = queue().tx.send(text);
}

pub fn next() -> String {
    queue().rx.lock().ok().and_then(|rx| rx.recv().ok()).unwrap_or_default()
}
