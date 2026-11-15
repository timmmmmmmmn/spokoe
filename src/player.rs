//! De afspeler: librespot als Spotify Connect-apparaat ("Draai op deze Mac"), plus de
//! tokens voor de Web API. Draait op een eigen tokio-thread; praat met de pagina via `ui::send`.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use librespot::connect::{ConnectConfig, LoadContextOptions, LoadRequest, LoadRequestOptions, Options, PlayingTrack, Spirc};
use librespot::core::authentication::Credentials;
use librespot::core::cache::Cache;
use librespot::core::config::{DeviceType, SessionConfig};
use librespot::core::session::Session;
use librespot::core::{SpotifyId, SpotifyUri};
use librespot::metadata::audio::UniqueFields;
use librespot::playback::audio_backend;
use librespot::playback::config::{AudioFormat, Bitrate, PlayerConfig};
use librespot::playback::mixer::{self, MixerConfig};
use librespot::playback::player::{Player, PlayerEvent};
use serde_json::{json, Value};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::{nowplaying, settings, ui};

/// Wat de Web API mag; dezelfde lijst voor het eigen Client ID en de terugval.
const SCOPES: &[&str] = &[
    "user-read-private",
    "user-read-email",
    "user-library-read",
    "user-library-modify",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "user-read-recently-played",
    "user-top-read",
    "user-follow-read",
    "user-follow-modify",
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-private",
    "playlist-modify-public",
];

/// Het adres dat je bij je eigen app in het Spotify-dashboard invult.
pub const REDIRECT: &str = "http://127.0.0.1:8888/callback";

pub enum Cmd {
    Login,
    Logout,
    Token { id: u64 },
    Lyrics { id: u64, track: String },
    Play(Value),
    Toggle,
    Pause,
    Resume,
    Next,
    Prev,
    Seek(u32),
    Volume(f64),
    Shuffle(bool),
    Repeat { context: bool, track: bool },
}

static TX: OnceLock<UnboundedSender<Cmd>> = OnceLock::new();

pub fn send(cmd: Cmd) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(cmd);
    }
}

pub fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support/Draai")
}

pub fn start() {
    let (tx, rx) = unbounded_channel();
    let _ = TX.set(tx);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
        rt.block_on(run(rx));
    });
}

struct Live {
    session: Session,
    spirc: Arc<Spirc>,
}

/// Een Web API-token dat we zelf via de browser hebben gekregen (eigen Client ID).
struct ApiToken {
    access: String,
    expires: SystemTime,
}

struct State {
    live: Option<Live>,
    api: Option<ApiToken>,
    /// Of dit apparaat nu het actieve Connect-apparaat is (anders gaan knoppen via de Web API).
    active: bool,
}

fn status(state: &str, extra: Value) {
    let mut v = json!({ "type": "status", "state": state });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    ui::send(v);
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

async fn run(mut rx: UnboundedReceiver<Cmd>) {
    let mut st = State { live: None, api: None, active: false };
    // Al eens ingelogd: meteen verbinden, zonder browser.
    if cache().ok().and_then(|c| c.credentials()).is_some() {
        connect(&mut st, false).await;
    } else {
        status("needs-login", json!({}));
    }
    while let Some(cmd) = rx.recv().await {
        handle(&mut st, cmd).await;
    }
}

fn cache() -> Result<Cache, librespot::core::Error> {
    let dir = data_dir();
    let audio = dir.join("audio");
    // 2 GB aan nummers bewaren: een tweede keer afspelen begint meteen.
    Cache::new(Some(&dir), Some(&dir), Some(&audio), Some(2 * 1024 * 1024 * 1024))
}

async fn connect(st: &mut State, browser: bool) {
    status("connecting", json!({}));
    let cache = match cache() {
        Ok(c) => c,
        Err(e) => return status("error", json!({ "message": e.to_string() })),
    };
    let session_config = SessionConfig::default();
    let credentials = match cache.credentials() {
        Some(c) if !browser => c,
        _ => {
            // Inloggen via de browser met het Client ID van de desktop-app (alleen dat mag afspelen).
            let client_id = session_config.client_id.clone();
            let got = tokio::task::spawn_blocking(move || {
                librespot_oauth::OAuthClientBuilder::new(&client_id, "http://127.0.0.1:8898/login", vec!["streaming"])
                    .open_in_browser()
                    .with_custom_message(DONE_PAGE)
                    .build()
                    .and_then(|c| c.get_access_token())
            })
            .await;
            match got {
                Ok(Ok(t)) => Credentials::with_access_token(t.access_token),
                Ok(Err(e)) => return status("needs-login", json!({ "message": e.to_string() })),
                Err(e) => return status("needs-login", json!({ "message": e.to_string() })),
            }
        }
    };

    let session = Session::new(session_config, Some(cache));
    let player_config = PlayerConfig {
        bitrate: Bitrate::Bitrate320,
        normalisation: true,
        position_update_interval: Some(Duration::from_secs(5)),
        ..PlayerConfig::default()
    };
    let Some(sink) = audio_backend::find(None) else { return status("error", json!({ "message": "geen geluid" })) };
    let Some(mixer_builder) = mixer::find(None) else { return status("error", json!({ "message": "geen mixer" })) };
    let mixer = match mixer_builder(MixerConfig::default()) {
        Ok(m) => m,
        Err(e) => return status("error", json!({ "message": e.to_string() })),
    };
    let player = Player::new(player_config, session.clone(), mixer.get_soft_volume(), move || sink(None, AudioFormat::default()));
    let events = player.get_player_event_channel();
    let volume = settings::get("volume").as_u64().map(|v| v as u16).unwrap_or(u16::MAX / 2);
    let connect_config = ConnectConfig {
        name: "Draai op deze Mac".into(),
        device_type: DeviceType::Computer,
        initial_volume: volume,
        ..ConnectConfig::default()
    };
    let (spirc, task) = match Spirc::new(connect_config, session.clone(), credentials, player, mixer).await {
        Ok(x) => x,
        Err(e) => {
            // Opgeslagen inlog werkt niet meer: opnieuw via de browser.
            status("needs-login", json!({ "message": e.to_string() }));
            return;
        }
    };
    tokio::spawn(task);
    tokio::spawn(forward_events(events));
    let user = session.username();
    st.live = Some(Live { session, spirc: Arc::new(spirc) });
    status("ready", json!({ "user": user, "volume": volume as f64 / u16::MAX as f64 }));
}

const DONE_PAGE: &str = "Ingelogd! Je kunt dit tabblad sluiten en teruggaan naar Draai.";

async fn handle(st: &mut State, cmd: Cmd) {
    match cmd {
        Cmd::Login => connect(st, true).await,
        Cmd::Logout => {
            if let Some(live) = st.live.take() {
                let _ = live.spirc.shutdown();
                live.session.shutdown();
            }
            let _ = std::fs::remove_file(data_dir().join("credentials.json"));
            settings::set("refresh", Value::Null);
            st.api = None;
            status("needs-login", json!({}));
        }
        Cmd::Token { id } => {
            let reply = match token(st).await {
                Ok((token, secs)) => json!({ "type": "token", "id": id, "token": token, "expires": now_ms() + secs * 1000 }),
                Err(e) => json!({ "type": "token", "id": id, "error": e }),
            };
            ui::send(reply);
        }
        Cmd::Lyrics { id, track } => {
            let reply = match lyrics(st, &track).await {
                Ok(v) => json!({ "type": "lyrics", "id": id, "data": v }),
                Err(e) => json!({ "type": "lyrics", "id": id, "error": e }),
            };
            ui::send(reply);
        }
        Cmd::Play(req) => {
            let Some(live) = &st.live else { return };
            if let Some(load) = load_request(&req) {
                // Vanaf hier speelt deze Mac (ook als de telefoon net bezig was).
                let _ = live.spirc.activate();
                let _ = live.spirc.load(load);
                st.active = true;
            }
        }
        other => {
            let Some(live) = &st.live else { return };
            let s = &live.spirc;
            let _ = match other {
                Cmd::Toggle => s.play_pause(),
                Cmd::Pause => s.pause(),
                Cmd::Resume => s.play(),
                Cmd::Next => s.next(),
                Cmd::Prev => s.prev(),
                Cmd::Seek(ms) => s.set_position_ms(ms),
                Cmd::Volume(v) => {
                    let v = (v.clamp(0.0, 1.0) * u16::MAX as f64) as u16;
                    settings::set("volume", json!(v));
                    s.set_volume(v)
                }
                Cmd::Shuffle(on) => s.shuffle(on),
                Cmd::Repeat { context, track } => s.repeat(context).and_then(|_| s.repeat_track(track)),
                _ => Ok(()),
            };
        }
    }
}

/// { context, tracks, uri, index, shuffle, position }
fn load_request(req: &Value) -> Option<LoadRequest> {
    let shuffle = req["shuffle"].as_bool().unwrap_or(false);
    let options = LoadRequestOptions {
        start_playing: true,
        seek_to: req["position"].as_u64().unwrap_or(0) as u32,
        context_options: Some(LoadContextOptions::Options(Options { shuffle, ..Options::default() })),
        playing_track: if let Some(uri) = req["uri"].as_str() {
            Some(PlayingTrack::Uri(uri.into()))
        } else {
            req["index"].as_u64().map(|i| PlayingTrack::Index(i as u32))
        },
    };
    if let Some(context) = req["context"].as_str() {
        return Some(LoadRequest::from_context_uri(context.into(), options));
    }
    let tracks: Vec<String> = req["tracks"].as_array()?.iter().filter_map(|t| t.as_str().map(String::from)).collect();
    (!tracks.is_empty()).then(|| LoadRequest::from_tracks(tracks, options))
}

/// Een token voor api.spotify.com: met het eigen Client ID als dat er is, anders dat van de sessie.
async fn token(st: &mut State) -> Result<(String, u64), String> {
    let Some(live) = &st.live else { return Err("niet ingelogd".into()) };
    let scopes = SCOPES.join(",");
    let client_id = settings::get("clientId").as_str().unwrap_or("").trim().to_string();
    if client_id.is_empty() {
        let t = live.session.token_provider().get_token(&scopes).await.map_err(|e| e.to_string())?;
        return Ok((t.access_token, t.expires_in.as_secs()));
    }
    if let Some(api) = &st.api {
        if let Ok(left) = api.expires.duration_since(SystemTime::now()) {
            if left > Duration::from_secs(60) {
                return Ok((api.access.clone(), left.as_secs()));
            }
        }
    }
    // Eerst stil via de sessie; lukt dat niet, dan met de refresh-token of eenmalig via de browser.
    if let Ok(t) = live.session.token_provider().get_token_with_client_id(&scopes, &client_id).await {
        return Ok((t.access_token, t.expires_in.as_secs()));
    }
    let refresh = settings::get("refresh").as_str().map(String::from);
    let got = tokio::task::spawn_blocking(move || {
        let client = librespot_oauth::OAuthClientBuilder::new(&client_id, REDIRECT, SCOPES.to_vec())
            .open_in_browser()
            .with_custom_message(DONE_PAGE)
            .build()
            .map_err(|e| e.to_string())?;
        if let Some(r) = refresh.filter(|r| !r.is_empty()) {
            if let Ok(t) = client.refresh_token(&r) {
                return Ok(t);
            }
        }
        client.get_access_token().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    if !got.refresh_token.is_empty() {
        settings::set("refresh", json!(got.refresh_token));
    }
    let secs = got.expires_at.saturating_duration_since(std::time::Instant::now()).as_secs();
    st.api = Some(ApiToken { access: got.access_token.clone(), expires: SystemTime::now() + Duration::from_secs(secs) });
    Ok((got.access_token, secs))
}

/// De songtekst zoals de officiële app hem toont (met tijden per regel).
async fn lyrics(st: &State, track: &str) -> Result<Value, String> {
    let Some(live) = &st.live else { return Err("niet ingelogd".into()) };
    let id = match SpotifyUri::from_uri(track).map_err(|e| e.to_string())? {
        SpotifyUri::Track { id } => id,
        _ => SpotifyId::from_base62(track).map_err(|e| e.to_string())?,
    };
    let bytes = live.session.spclient().get_lyrics(&id).await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

async fn forward_events(mut events: librespot::playback::player::PlayerEventChannel) {
    while let Some(event) = events.recv().await {
        let position = |ms: u32| json!({ "type": "position", "position": ms, "at": now_ms() });
        let msg = match event {
            PlayerEvent::TrackChanged { audio_item } => {
                let item = *audio_item;
                let (artists, album) = match &item.unique_fields {
                    UniqueFields::Track { artists, album, .. } => (
                        artists.iter().map(|a| json!({ "name": a.name, "uri": a.id.to_uri().unwrap_or_default() })).collect(),
                        album.clone(),
                    ),
                    UniqueFields::Episode { show_name, .. } => (vec![json!({ "name": show_name })], String::new()),
                    UniqueFields::Local { artists, album, .. } => {
                        (vec![json!({ "name": artists.clone().unwrap_or_default() })], album.clone().unwrap_or_default())
                    }
                };
                // De grootste hoes eerst; de kleinste voor lijstjes.
                let cover = item.covers.first().map(|c| c.url.clone()).unwrap_or_default();
                let names: Vec<String> = artists.iter().filter_map(|a: &Value| a["name"].as_str().map(String::from)).collect();
                nowplaying::track(&item.name, &names.join(", "), &album, item.duration_ms, &cover);
                json!({
                    "type": "track",
                    "uri": item.uri,
                    "name": item.name,
                    "artists": artists,
                    "album": album,
                    "cover": cover,
                    "duration": item.duration_ms,
                    "explicit": item.is_explicit,
                })
            }
            PlayerEvent::Playing { position_ms, .. } => {
                nowplaying::state(true, position_ms);
                json!({ "type": "play", "playing": true, "position": position_ms, "at": now_ms() })
            }
            PlayerEvent::Paused { position_ms, .. } => {
                nowplaying::state(false, position_ms);
                json!({ "type": "play", "playing": false, "position": position_ms, "at": now_ms() })
            }
            PlayerEvent::Stopped { .. } => {
                nowplaying::state(false, 0);
                json!({ "type": "stopped" })
            }
            PlayerEvent::Loading { position_ms, .. } => json!({ "type": "loading", "position": position_ms }),
            PlayerEvent::Seeked { position_ms, .. }
            | PlayerEvent::PositionCorrection { position_ms, .. }
            | PlayerEvent::PositionChanged { position_ms, .. } => {
                nowplaying::position(position_ms);
                position(position_ms)
            }
            PlayerEvent::VolumeChanged { volume } => json!({ "type": "volume", "volume": volume as f64 / u16::MAX as f64 }),
            PlayerEvent::ShuffleChanged { shuffle } => json!({ "type": "shuffle", "on": shuffle }),
            PlayerEvent::RepeatChanged { context, track } => json!({ "type": "repeat", "context": context, "track": track }),
            PlayerEvent::Unavailable { track_id, .. } => {
                json!({ "type": "unavailable", "uri": track_id.to_uri().unwrap_or_default() })
            }
            PlayerEvent::SessionClientChanged { client_name, .. } => json!({ "type": "client", "name": client_name }),
            _ => continue,
        };
        ui::send(msg);
    }
}
