//! "Nu speelt" van macOS: titel en hoes in het Bedieningspaneel, en de mediatoetsen
//! (▶︎⏸ ⏭ ⏮ op het toetsenbord, AirPods) bedienen Spokoe.

use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_app_kit::NSImage;
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSData, NSMutableDictionary, NSNumber, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPMediaItemPropertyAlbumTitle, MPMediaItemPropertyArtist,
    MPMediaItemPropertyArtwork, MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle, MPNowPlayingInfoCenter,
    MPNowPlayingInfoPropertyElapsedPlaybackTime, MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState,
    MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
};

use crate::ui;

#[derive(Default)]
struct Info {
    title: String,
    artist: String,
    album: String,
    duration_ms: u32,
    position_ms: u32,
    playing: bool,
    cover_url: String,
    artwork: Option<Retained<MPMediaItemArtwork>>,
}

thread_local! {
    static INFO: RefCell<Info> = RefCell::new(Info::default());
}

fn main(f: impl FnOnce() + Send + 'static) {
    dispatch2::DispatchQueue::main().exec_async(f);
}

/// De mediatoetsen gaan via de pagina: die weet of deze Mac speelt of een ander apparaat.
pub fn setup() {
    let center = unsafe { MPRemoteCommandCenter::sharedCommandCenter() };
    let add = |command: Retained<objc2_media_player::MPRemoteCommand>, name: &'static str| {
        let block = RcBlock::new(move |_e: NonNull<MPRemoteCommandEvent>| {
            ui::remote(name, None);
            MPRemoteCommandHandlerStatus::Success
        });
        unsafe {
            command.setEnabled(true);
            let _ = command.addTargetWithHandler(&block);
        }
    };
    unsafe {
        add(center.togglePlayPauseCommand(), "toggle");
        add(center.playCommand(), "resume");
        add(center.pauseCommand(), "pause");
        add(center.nextTrackCommand(), "next");
        add(center.previousTrackCommand(), "prev");
        let seek = center.changePlaybackPositionCommand();
        seek.setEnabled(true);
        let block = RcBlock::new(|e: NonNull<MPRemoteCommandEvent>| {
            let e: &MPChangePlaybackPositionCommandEvent = &*(e.as_ptr() as *const MPChangePlaybackPositionCommandEvent);
            ui::remote("seek", Some((e.positionTime() * 1000.0) as u64));
            MPRemoteCommandHandlerStatus::Success
        });
        let _ = seek.addTargetWithHandler(&block);
    }
}

pub fn track(title: &str, artist: &str, album: &str, duration_ms: u32, cover: &str) {
    let (title, artist, album, cover) = (title.to_string(), artist.to_string(), album.to_string(), cover.to_string());
    main(move || {
        INFO.with_borrow_mut(|i| {
            i.title = title;
            i.artist = artist;
            i.album = album;
            i.duration_ms = duration_ms;
            i.position_ms = 0;
            if i.cover_url != cover {
                i.artwork = None;
                i.cover_url = cover.clone();
            }
        });
        publish();
        if cover.is_empty() {
            INFO.with_borrow(|i| crate::island::show(&i.title, &i.artist, None));
            crate::ui::status_cover(None);
        } else {
            std::thread::spawn(move || fetch_cover(cover));
        }
    });
}

fn fetch_cover(url: String) {
    let Ok(bytes) = reqwest::blocking::get(&url).and_then(|r| r.bytes()) else { return };
    main(move || {
        let data = NSData::with_bytes(&bytes);
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else { return };
        let size = image.size();
        let for_island = image.clone();
        let block = RcBlock::new(move |_s: CGSize| NonNull::from(&*image));
        let artwork = unsafe { MPMediaItemArtwork::initWithBoundsSize_requestHandler(MPMediaItemArtwork::alloc(), size, &block) };
        let fresh = INFO.with_borrow_mut(|i| {
            if i.cover_url == url {
                i.artwork = Some(artwork);
                true
            } else {
                false
            }
        });
        if fresh {
            publish();
            INFO.with_borrow(|i| crate::island::show(&i.title, &i.artist, Some(&for_island)));
            crate::ui::status_cover(Some(&for_island));
        }
    });
}

pub fn state(playing: bool, position_ms: u32) {
    main(move || {
        INFO.with_borrow_mut(|i| {
            i.playing = playing;
            i.position_ms = position_ms;
        });
        publish();
    });
}

pub fn position(position_ms: u32) {
    main(move || {
        INFO.with_borrow_mut(|i| i.position_ms = position_ms);
        publish();
    });
}

fn publish() {
    INFO.with_borrow(|i| {
        let dict = NSMutableDictionary::<NSString, AnyObject>::new();
        let put = |key: &NSString, value: &AnyObject| unsafe { dict.setObject_forKey(value, objc2::runtime::ProtocolObject::from_ref(key)) };
        unsafe {
            put(MPMediaItemPropertyTitle, &NSString::from_str(&i.title));
            put(MPMediaItemPropertyArtist, &NSString::from_str(&i.artist));
            put(MPMediaItemPropertyAlbumTitle, &NSString::from_str(&i.album));
            put(MPMediaItemPropertyPlaybackDuration, &NSNumber::new_f64(i.duration_ms as f64 / 1000.0));
            put(MPNowPlayingInfoPropertyElapsedPlaybackTime, &NSNumber::new_f64(i.position_ms as f64 / 1000.0));
            put(MPNowPlayingInfoPropertyPlaybackRate, &NSNumber::new_f64(if i.playing { 1.0 } else { 0.0 }));
            if let Some(art) = &i.artwork {
                put(MPMediaItemPropertyArtwork, art);
            }
            let center = MPNowPlayingInfoCenter::defaultCenter();
            center.setNowPlayingInfo(Some(&dict));
            center.setPlaybackState(if i.playing { MPNowPlayingPlaybackState::Playing } else { MPNowPlayingPlaybackState::Paused });
        }
    });
    ui::status_item(&INFO.with_borrow(|i| (i.title.clone(), i.artist.clone(), i.playing)));
}
