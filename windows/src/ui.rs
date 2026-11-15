//! Berichten naar de pagina en het venster: via de event loop (alles in het venster gebeurt op de hoofdthread).

use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tao::event_loop::EventLoopProxy;

pub enum UserEvent {
    Js(String),
    Ready,
    Media(crate::nowplaying::Update),
    Theme(bool),
    Quit,
}

static PROXY: OnceLock<Mutex<EventLoopProxy<UserEvent>>> = OnceLock::new();
/// De laatste status, voor een pagina die opnieuw laadt.
pub static LAST_STATUS: Mutex<Option<String>> = Mutex::new(None);

pub fn set_proxy(p: EventLoopProxy<UserEvent>) {
    let _ = PROXY.set(Mutex::new(p));
}

pub fn event(e: UserEvent) {
    if let Some(p) = PROXY.get().and_then(|p| p.lock().ok()) {
        let _ = p.send_event(e);
    }
}

pub fn send(msg: Value) {
    if msg["type"] == "status" {
        if let Ok(mut last) = LAST_STATUS.lock() {
            *last = Some(msg.to_string());
        }
    }
    event(UserEvent::Js(format!("window.spokoe&&spokoe.recv({msg})")));
}
