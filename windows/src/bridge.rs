//! Berichten van de pagina (zelfde als op de Mac); wat op de Mac AppKit doet, doet hier Windows zelf.

use serde_json::{json, Value};

use crate::player::{self, Cmd};
use crate::ui::send;

pub fn handle(text: &str) {
    let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
    let num = |k: &str| msg[k].as_f64().unwrap_or(0.0);
    match msg["cmd"].as_str().unwrap_or("") {
        "ready" => {
            crate::ui::event(crate::ui::UserEvent::Ready);
            if let Some(status) = crate::ui::LAST_STATUS.lock().ok().and_then(|l| l.clone()) {
                if let Ok(v) = serde_json::from_str(&status) {
                    send(v);
                }
            }
            send(json!({ "type": "config", "clientId": crate::settings::get("clientId"), "redirect": player::REDIRECT, "deviceName": player::DEVICE_NAME, "platform": "windows" }));
        }
        "login" => player::send(Cmd::Login),
        "logout" => player::send(Cmd::Logout),
        "reconnect" => player::send(Cmd::Retry),
        "check" => player::send(Cmd::Check { deep: true }),
        "setClientId" => {
            crate::settings::set("clientId", msg["id"].clone());
            crate::settings::set("refresh", Value::Null);
        }
        "token" => player::send(Cmd::Token { id: num("id") as u64 }),
        "lyrics" => player::send(Cmd::Lyrics { id: num("id") as u64, track: msg["track"].as_str().unwrap_or("").into() }),
        "meta" => player::send(Cmd::Meta { id: num("id") as u64, kind: msg["kind"].as_str().unwrap_or("").into(), arg: msg["arg"].as_str().unwrap_or("").into() }),
        "play" => player::send(Cmd::Play(msg.clone())),
        "toggle" => player::send(Cmd::Toggle),
        "pause" => player::send(Cmd::Pause),
        "resume" => player::send(Cmd::Resume),
        "next" => player::send(Cmd::Next),
        "prev" => player::send(Cmd::Prev),
        "seek" => player::send(Cmd::Seek(num("ms") as u32)),
        "volume" => player::send(Cmd::Volume(num("v"))),
        "shuffle" => player::send(Cmd::Shuffle(msg["on"].as_bool().unwrap_or(false))),
        "repeat" => player::send(Cmd::Repeat { context: msg["context"].as_bool().unwrap_or(false), track: msg["track"].as_bool().unwrap_or(false) }),
        "setting" => crate::settings::set(msg["key"].as_str().unwrap_or("x"), msg["value"].clone()),
        "island" => crate::settings::set("island", msg["on"].clone()),
        "dsp" => {
            crate::dsp::set(&msg["dsp"]);
            let mut all = crate::settings::get("dsp");
            if !all.is_object() {
                all = json!({});
            }
            if let (Some(o), Some(n)) = (all.as_object_mut(), msg["dsp"].as_object()) {
                o.extend(n.clone());
            }
            crate::settings::set("dsp", all);
        }
        "rebuild" => player::send(Cmd::Rebuild),
        "audioInfo" => {
            let id = msg["id"].clone();
            std::thread::spawn(move || {
                send(json!({ "type": "audioInfo", "id": id, "devices": player::devices(), "cache": player::dir_size(&player::data_dir().join("audio")), "dsp": crate::settings::get("dsp") }));
            });
        }
        "clearCache" => {
            let freed = player::clear_cache();
            send(json!({ "type": "toast", "text": format!("Cache geleegd ({} MB vrij)", freed / 1_000_000) }));
        }
        "fetchText" => {
            let id = msg["id"].clone();
            let url = msg["url"].as_str().unwrap_or("").to_string();
            std::thread::spawn(move || {
                let got = reqwest::blocking::Client::new().get(&url).header("User-Agent", "Mozilla/5.0 Spokoe").send().and_then(|r| r.text());
                send(match got {
                    Ok(text) => json!({ "type": "fetchText", "id": id, "text": text }),
                    Err(e) => json!({ "type": "fetchText", "id": id, "error": e.to_string() }),
                });
            });
        }
        "checkUpdate" => {
            let id = msg["id"].clone();
            std::thread::spawn(move || send(json!({ "type": "update", "id": id, "data": crate::update::check() })));
        }
        "installUpdate" => {
            let url = msg["url"].as_str().unwrap_or("").to_string();
            std::thread::spawn(move || {
                if let Err(e) = crate::update::install(&url) {
                    send(json!({ "type": "toast", "text": format!("Bijwerken lukte niet: {e}") }));
                }
            });
        }
        "open" => {
            let _ = open::that(msg["url"].as_str().unwrap_or(""));
        }
        "copy" => {
            if let Ok(mut c) = arboard::Clipboard::new() {
                let _ = c.set_text(msg["text"].as_str().unwrap_or("").to_string());
            }
        }
        "saveFile" => {
            let name = msg["name"].as_str().unwrap_or("export.csv").to_string();
            let text = msg["text"].as_str().unwrap_or("").to_string();
            std::thread::spawn(move || {
                if let Some(path) = rfd::FileDialog::new().set_file_name(&name).save_file() {
                    let ok = std::fs::write(path, text).is_ok();
                    send(json!({ "type": "toast", "text": if ok { "Opgeslagen" } else { "Opslaan lukte niet" } }));
                }
            });
        }
        "openLog" => {
            let _ = open::that(player::data_dir().join("spokoe.log"));
        }
        "theme" => crate::ui::event(crate::ui::UserEvent::Theme(msg["dark"].as_bool().unwrap_or(true))),
        "log" => log::warn!("pagina: {}", msg["msg"].as_str().unwrap_or("")),
        _ => {}
    }
}
