//! Het mediapaneel van Windows (en de mediatoetsen): titel, hoes, afspelen/pauze, volgende, vorige.

use souvlaki::{MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig};
use tao::window::Window;

use crate::ui::{self, UserEvent};

pub enum Update {
    Track { title: String, artist: String, album: String, duration_ms: u32, cover: String },
    State { playing: bool, position_ms: u32 },
}

pub fn track(title: &str, artist: &str, album: &str, duration_ms: u32, cover: &str) {
    ui::event(UserEvent::Media(Update::Track { title: title.into(), artist: artist.into(), album: album.into(), duration_ms, cover: cover.into() }));
}

pub fn state(playing: bool, position_ms: u32) {
    ui::event(UserEvent::Media(Update::State { playing, position_ms }));
}

pub fn position(_position_ms: u32) {}

pub struct Media {
    controls: Option<MediaControls>,
}

impl Media {
    pub fn new(window: &Window) -> Self {
        #[cfg(windows)]
        let hwnd = {
            use tao::platform::windows::WindowExtWindows;
            Some(window.hwnd() as *mut std::ffi::c_void)
        };
        #[cfg(not(windows))]
        let hwnd = {
            let _ = window;
            None
        };
        let controls = MediaControls::new(PlatformConfig { display_name: "Spokoe", dbus_name: "nl.timvanbergen.spokoe", hwnd }).ok().map(|mut c| {
            // De knoppen gaan via de pagina: die weet of deze pc speelt of een ander apparaat.
            let _ = c.attach(|e| {
                let cmd = match e {
                    MediaControlEvent::Play => "resume",
                    MediaControlEvent::Pause => "pause",
                    MediaControlEvent::Toggle => "toggle",
                    MediaControlEvent::Next => "next",
                    MediaControlEvent::Previous => "prev",
                    _ => return,
                };
                ui::send(serde_json::json!({ "type": "remote", "cmd": cmd }));
            });
            c
        });
        Self { controls }
    }

    pub fn update(&mut self, u: Update) {
        let Some(c) = self.controls.as_mut() else { return };
        match u {
            Update::Track { title, artist, album, duration_ms, cover } => {
                let _ = c.set_metadata(MediaMetadata {
                    title: Some(&title),
                    artist: Some(&artist),
                    album: Some(&album),
                    cover_url: (!cover.is_empty()).then_some(cover.as_str()),
                    duration: Some(std::time::Duration::from_millis(duration_ms as u64)),
                });
            }
            Update::State { playing, position_ms } => {
                let progress = Some(MediaPosition(std::time::Duration::from_millis(position_ms as u64)));
                let _ = c.set_playback(if playing { MediaPlayback::Playing { progress } } else { MediaPlayback::Paused { progress } });
            }
        }
    }
}
