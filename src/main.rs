//! Spotimfy: een snelle Spotify-speler voor de Mac. De Rust-kern speelt zelf af (librespot, als
//! Spotify Connect-apparaat); de interface is een lokale pagina in een WKWebView.

mod dev;
mod dsp;
mod island;
mod meta;
mod nowplaying;
mod player;
mod settings;
mod ui;
mod update;

use objc2::runtime::ProtocolObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

/// Naar het bestand én naar stderr (in testmodus).
struct Tee(std::fs::File);

impl std::io::Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        self.0.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

fn main() {
    let mtm = MainThreadMarker::new().expect("moet op de hoofdthread draaien");
    // Logboek in een bestand (Instellingen › Open logboek), en ook op de terminal.
    let dir = player::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("spotimfy.log");
    if std::fs::metadata(&path).map(|m| m.len() > 2_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("spotimfy.vorige.log"));
    }
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&path);
    let mut logger = env_logger::Builder::new();
    logger.parse_filters(&std::env::var("SPOTIMFY_LOG").unwrap_or_else(|_| "warn,librespot=info,spotimfy=info".into()));
    if let Ok(file) = file {
        if std::env::var("SPOTIMFY_DEV").is_err() {
            logger.target(env_logger::Target::Pipe(Box::new(file)));
        } else {
            logger.target(env_logger::Target::Pipe(Box::new(Tee(file))));
        }
    }
    logger.init();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let host = ui::Host::new(mtm);
    app.setDelegate(Some(ProtocolObject::from_ref(&*host)));
    ui::build(mtm, &host);
    nowplaying::setup();
    dsp::set(&settings::get("dsp"));
    player::start();
    dev::start();
    std::mem::forget(host);
    app.run();
}
