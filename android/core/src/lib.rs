#![allow(dead_code)]
//! Spokoe voor Android: dezelfde kern als op de Mac (afspelen, geluidslaag, mixen), als
//! bibliotheek voor de app. De app praat ermee via `post` (berichten van de pagina) en `next`
//! (gebeurtenissen voor de pagina en de mediabediening).

#[path = "../../../src/dsp.rs"]
mod dsp;
#[path = "../../../src/meta.rs"]
mod meta;
#[path = "../../../src/player.rs"]
mod player;
#[path = "../../../src/settings.rs"]
mod settings;
mod bridge;
mod nowplaying;
mod oauth;
mod ui;

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;

#[unsafe(no_mangle)]
pub extern "system" fn Java_nl_timvanbergen_spokoe_Core_start(mut env: JNIEnv, _class: JClass, dir: JString) {
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("Spokoe"));
    let dir: String = env.get_string(&dir).map(|s| s.into()).unwrap_or_default();
    let _ = player::DATA_DIR.set(dir.into());
    dsp::set(&settings::get("dsp"));
    player::start();
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_nl_timvanbergen_spokoe_Core_post(mut env: JNIEnv, _class: JClass, message: JString) {
    if let Ok(text) = env.get_string(&message) {
        bridge::handle(&String::from(text));
    }
}

/// Wacht op de volgende gebeurtenis (JSON). De app roept dit in een eigen thread steeds opnieuw aan.
#[unsafe(no_mangle)]
pub extern "system" fn Java_nl_timvanbergen_spokoe_Core_next(env: JNIEnv, _class: JClass) -> jstring {
    let msg = ui::next();
    env.new_string(msg).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}
