//! Spotimfy: een snelle Spotify-speler voor de Mac. De Rust-kern speelt zelf af (librespot, als
//! Spotify Connect-apparaat); de interface is een lokale pagina in een WKWebView.

mod dev;
mod island;
mod meta;
mod nowplaying;
mod player;
mod settings;
mod ui;

use objc2::runtime::ProtocolObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

fn main() {
    let mtm = MainThreadMarker::new().expect("moet op de hoofdthread draaien");
    env_logger::Builder::new().parse_filters(&std::env::var("SPOTIMFY_LOG").unwrap_or_else(|_| "warn,librespot=info".into())).init();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let host = ui::Host::new(mtm);
    app.setDelegate(Some(ProtocolObject::from_ref(&*host)));
    ui::build(mtm, &host);
    nowplaying::setup();
    player::start();
    dev::start();
    std::mem::forget(host);
    app.run();
}
