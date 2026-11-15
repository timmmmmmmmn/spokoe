//! De afspeler: librespot als Spotify Connect-apparaat ("Spokoe op deze Mac"), plus de
//! tokens voor de Web API. Spokoet op een eigen tokio-thread; praat met de pagina via `ui::send`.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use librespot::connect::{ConnectConfig, LoadContextOptions, LoadRequest, LoadRequestOptions, Options, PlayingTrack, Spirc};
use librespot::core::authentication::Credentials;
use librespot::core::cache::Cache;
use librespot::core::config::{DeviceType, SessionConfig};
use librespot::core::session::Session;
use librespot::core::error::ErrorKind;
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

/// Zo heet dit apparaat in Spotify Connect.
#[cfg(target_os = "android")]
pub const DEVICE_NAME: &str = "Spokoe op deze telefoon";
#[cfg(not(target_os = "android"))]
pub const DEVICE_NAME: &str = "Spokoe op deze Mac";

/// Het adres dat je bij je eigen app in het Spotify-dashboard invult.
pub const REDIRECT: &str = "http://127.0.0.1:8888/callback";

pub enum Cmd {
    Login,
    Logout,
    Token { id: u64 },
    Lyrics { id: u64, track: String },
    /// "playlist" of "artistTop" via meta.rs.
    Meta { id: u64, kind: String, arg: String },
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
    /// Leeft de verbinding nog? (waakhond, na slaapstand)
    Check { deep: bool },
    /// De verbinding van generatie `gen` is weg.
    Lost(u64),
    /// Opnieuw proberen te verbinden.
    Retry,
    /// Alleen in testmodus: doen alsof de verbinding wegvalt.
    DevLose,
    /// Geluid opnieuw opbouwen (ander apparaat, kwaliteit, bit-perfect); de muziek gaat daarna verder.
    Rebuild,
}

static TX: OnceLock<UnboundedSender<Cmd>> = OnceLock::new();

pub fn send(cmd: Cmd) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(cmd);
    }
}

/// Op Android geeft de app zijn eigen map door; op de Mac is het Application Support.
pub static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn data_dir() -> PathBuf {
    if let Some(dir) = DATA_DIR.get() {
        return dir.clone();
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Library/Application Support/Spokoe")
}

/// Van de eerdere namen (Draai, Spotimfy): login, cache en instellingen meenemen.
/// Vóór al het andere aanroepen, anders bestaat de nieuwe map al (bijv. door het logboek).
pub fn migrate() {
    for name in ["Spotimfy", "Draai"] {
        let old = data_dir().with_file_name(name);
        let fresh = !data_dir().join("credentials.json").exists();
        if old.join("credentials.json").exists() && fresh {
            let _ = std::fs::remove_dir_all(data_dir());
            let _ = std::fs::rename(&old, data_dir());
        }
    }
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
    /// Telt elke verbinding; een oud "weg"-bericht van een vorige verbinding telt niet.
    generation: u64,
    /// Hoe vaak opnieuw verbinden al mislukte (voor het wachten ertussen).
    failures: u32,
    /// Er wacht al een nieuwe poging.
    retry_pending: bool,
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
    let mut st = State { live: None, generation: 0, failures: 0, retry_pending: false, api: None, active: false };
    // Waakhond: elke paar seconden kijken of de verbinding nog leeft.
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(4)).await;
            send(Cmd::Check { deep: false });
        }
    });
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
    // Nummers bewaren (standaard 2 GB): een tweede keer afspelen begint meteen.
    let gb = settings::get("cacheGB").as_f64().unwrap_or(2.0).clamp(0.5, 50.0);
    Cache::new(Some(&dir), Some(&dir), Some(&audio), Some((gb * 1024.0 * 1024.0 * 1024.0) as u64))
}

/// Speelt er nu iets (voor pauzeren met een fade).
static PLAYING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn bitperfect() -> bool {
    settings::get("bitperfect").as_bool().unwrap_or(false)
}

/// Verbinden; `true` als het lukte. Mislukt het door het netwerk, dan volgt vanzelf een nieuwe poging.
async fn connect(st: &mut State, browser: bool) -> bool {
    status(if st.failures > 0 { "offline" } else { "connecting" }, json!({}));
    let cache = match cache() {
        Ok(c) => c,
        Err(e) => {
            status("error", json!({ "message": e.to_string() }));
            return false;
        }
    };
    let mut session_config = SessionConfig::default();
    // Overal het Client ID van de desktop-app: dat van Android hoort bij een andere redirect-URL,
    // waardoor Spotify het inloggen weigert ("redirect_uri: Not matching configuration").
    session_config.client_id = "65b708073fc0480ea92a077233ca87bd".into();
    let credentials = match cache.credentials() {
        Some(c) if !browser => c,
        _ => {
            // Inloggen via de browser met het Client ID van de desktop-app (alleen dat mag afspelen).
            let client_id = session_config.client_id.clone();
            #[cfg(not(target_os = "android"))]
            let got = tokio::task::spawn_blocking(move || {
                librespot_oauth::OAuthClientBuilder::new(&client_id, "http://127.0.0.1:8898/login", vec!["streaming"])
                    .open_in_browser()
                    .with_custom_message(DONE_PAGE)
                    .build()
                    .and_then(|c| c.get_access_token())
                    .map(|t| t.access_token)
            })
            .await;
            // Android: de app opent de inlogpagina zelf (librespot kan dat daar niet).
            #[cfg(target_os = "android")]
            let got = tokio::task::spawn_blocking(move || crate::oauth::authorize(&client_id, "http://127.0.0.1:8898/login", &["streaming"], None).map(|t| t.0)).await;
            match got {
                Ok(Ok(t)) => Credentials::with_access_token(t),
                Ok(Err(e)) => {
                    status("needs-login", json!({ "message": e.to_string() }));
                    return false;
                }
                Err(e) => {
                    status("needs-login", json!({ "message": e.to_string() }));
                    return false;
                }
            }
        }
    };

    let session = Session::new(session_config, Some(cache));
    let bp = bitperfect();
    let player_config = PlayerConfig {
        bitrate: match settings::get("bitrate").as_u64() {
            Some(96) => Bitrate::Bitrate96,
            Some(160) => Bitrate::Bitrate160,
            // Automatisch: hoog, tenzij de vorige keer bleek dat de verbinding traag was.
            None if settings::get("slowNet").as_bool().unwrap_or(false) => Bitrate::Bitrate160,
            _ => Bitrate::Bitrate320,
        },
        // Bit-perfect: niets aan het geluid veranderen, ook geen normalisatie of dither.
        normalisation: !bp && settings::get("normalise").as_bool().unwrap_or(true),
        ditherer: if bp { None } else { PlayerConfig::default().ditherer },
        position_update_interval: Some(Duration::from_secs(5)),
        ..PlayerConfig::default()
    };
    let Some(sink) = audio_backend::find(None) else {
        status("error", json!({ "message": "geen geluid" }));
        return false;
    };
    let Some(mixer_builder) = mixer::find(None) else {
        status("error", json!({ "message": "geen mixer" }));
        return false;
    };
    let mixer = match mixer_builder(MixerConfig::default()) {
        Ok(m) => m,
        Err(e) => {
            status("error", json!({ "message": e.to_string() }));
            return false;
        }
    };
    let device = settings::get("device").as_str().filter(|d| !d.is_empty()).map(String::from);
    // 32-bit float naar de uitgang: geen afronding tussendoor.
    let player = Player::new(player_config, session.clone(), mixer.get_soft_volume(), move || {
        Box::new(crate::dsp::DspSink::new(sink(device.clone(), AudioFormat::F32))) as Box<dyn librespot::playback::audio_backend::Sink>
    });
    let events = player.get_player_event_channel();
    let volume = if bp { u16::MAX } else { settings::get("volume").as_u64().map(|v| v as u16).unwrap_or(u16::MAX / 2) };
    let connect_config = ConnectConfig {
        name: DEVICE_NAME.into(),
        device_type: DeviceType::Computer,
        initial_volume: volume,
        ..ConnectConfig::default()
    };
    let made = tokio::time::timeout(Duration::from_secs(20), Spirc::new(connect_config, session.clone(), credentials, player, mixer)).await;
    let (spirc, task) = match made {
        Ok(Ok(x)) => x,
        // Spotify weigert de opgeslagen login (verlopen, of van een ander apparaat): opnieuw inloggen.
        Ok(Err(e)) if matches!(e.kind, ErrorKind::Unauthenticated | ErrorKind::PermissionDenied) || e.to_string().contains("INVALID_CREDENTIALS") || e.to_string().contains("denied") => {
            // Opgeslagen inlog werkt niet meer: opnieuw via de browser.
            status("needs-login", json!({ "message": e.to_string() }));
            return false;
        }
        other => {
            // Geen netwerk (of Spotify even weg): straks opnieuw.
            let why = match other {
                Ok(Err(e)) => e.to_string(),
                _ => "verbinden duurt te lang".into(),
            };
            log::warn!("verbinden mislukt: {why}");
            session.shutdown();
            st.failures += 1;
            status("offline", json!({ "message": why }));
            schedule_retry(st);
            return false;
        }
    };
    st.generation += 1;
    let generation = st.generation;
    tokio::spawn(async move {
        task.await;
        log::warn!("verbinding {generation} gestopt");
        send(Cmd::Lost(generation));
    });
    tokio::spawn(forward_events(events));
    let user = session.username();
    st.live = Some(Live { session, spirc: Arc::new(spirc) });
    if settings::get("bitrate").is_null() {
        let probe_session = st.live.as_ref().map(|l| l.session.clone());
        tokio::spawn(async move {
            let Some(session) = probe_session else { return };
            let t0 = std::time::Instant::now();
            let probe = tokio::time::timeout(Duration::from_secs(3), session.spclient().get_user_profile(&session.username(), Some(1), Some(1))).await;
            let slow = !matches!(probe, Ok(Ok(_))) || t0.elapsed() > Duration::from_millis(900);
            log::info!("verbinding: {} ms{}", t0.elapsed().as_millis(), if slow { " (traag: volgende keer 160 kbps)" } else { "" });
            settings::set("slowNet", json!(slow));
        });
    }
    let was_offline = st.failures > 0;
    st.failures = 0;
    status("ready", json!({ "user": user, "volume": volume as f64 / u16::MAX as f64 }));
    if was_offline {
        ui::send(json!({ "type": "reconnected" }));
    }
    true
}

/// Na een pauze (1, 2, 4 … tot 30 s) opnieuw proberen te verbinden.
fn schedule_retry(st: &mut State) {
    if st.retry_pending {
        return;
    }
    st.retry_pending = true;
    let wait = Duration::from_secs((1u64 << st.failures.min(5)).min(30));
    tokio::spawn(async move {
        tokio::time::sleep(wait).await;
        send(Cmd::Retry);
    });
}

/// De verbinding is weg: opruimen en opnieuw beginnen.
fn lose(st: &mut State) {
    if let Some(live) = st.live.take() {
        log::warn!("verbinding kwijt, opnieuw verbinden");
        let _ = live.spirc.shutdown();
        live.session.shutdown();
        st.failures = st.failures.max(1);
        status("offline", json!({}));
        schedule_retry(st);
    }
}

const DONE_PAGE: &str = "Ingelogd! Je kunt dit tabblad sluiten en teruggaan naar Spokoe.";

async fn handle(st: &mut State, cmd: Cmd) {
    match cmd {
        Cmd::Login => {
            connect(st, true).await;
        }
        Cmd::Check { deep } => {
            let Some(live) = &st.live else { return };
            if live.session.is_invalid() {
                return lose(st);
            }
            if deep {
                // Na slaapstand kan de verbinding er nog "goed" uitzien terwijl hij dood is: echt iets vragen.
                let session = live.session.clone();
                let generation = st.generation;
                tokio::spawn(async move {
                    let probe = tokio::time::timeout(Duration::from_secs(6), session.spclient().get_user_profile(&session.username(), Some(1), Some(1))).await;
                    if !matches!(probe, Ok(Ok(_))) {
                        send(Cmd::Lost(generation));
                    }
                });
            }
        }
        Cmd::DevLose => lose(st),
        Cmd::Rebuild => {
            if st.live.is_some() {
                lose(st);
                st.retry_pending = false;
                send(Cmd::Retry);
            }
        }
        Cmd::Lost(generation) => {
            if generation == st.generation {
                lose(st);
            }
        }
        Cmd::Retry => {
            st.retry_pending = false;
            if st.live.is_none() && cache().ok().and_then(|c| c.credentials()).is_some() {
                connect(st, false).await;
            }
        }
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
            // Zonder eigen Client ID: het login5-token van de sessie, op de achtergrond (nooit de rest ophouden).
            let client_id = settings::get("clientId").as_str().unwrap_or("").trim().to_string();
            if client_id.is_empty() {
                let Some(live) = &st.live else { return ui::send(json!({ "type": "token", "id": id, "error": "niet ingelogd" })) };
                let session = live.session.clone();
                tokio::spawn(async move {
                    let got = tokio::time::timeout(Duration::from_secs(15), session.login5().auth_token()).await;
                    ui::send(match got {
                        Ok(Ok(t)) => json!({ "type": "token", "id": id, "token": t.access_token, "expires": now_ms() + t.expires_in.as_millis() as u64 }),
                        Ok(Err(e)) => json!({ "type": "token", "id": id, "error": e.to_string() }),
                        Err(_) => json!({ "type": "token", "id": id, "error": "token duurt te lang" }),
                    });
                });
                return;
            }
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
        Cmd::Meta { id, kind, arg } => {
            let Some(live) = &st.live else { return };
            let session = live.session.clone();
            // Op de achtergrond: een grote playlist houdt de knoppen niet op.
            tokio::spawn(async move {
                let got = match kind.as_str() {
                    "playlist" => crate::meta::playlist(&session, &arg).await,
                    "artistTop" => crate::meta::artist_top(&session, &arg).await,
                    "rootlist" => crate::meta::rootlist(&session).await,
                    "radio" => {
                        let req: Value = serde_json::from_str(&arg).unwrap_or_default();
                        let previous = req["previous"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
                        crate::meta::radio(&session, req["seed"].as_str().unwrap_or(""), req["count"].as_u64().unwrap_or(50) as usize, previous).await
                    }
                    _ => Err("onbekend".into()),
                };
                ui::send(match got {
                    Ok(v) => json!({ "type": "meta", "id": id, "data": v }),
                    Err(e) => json!({ "type": "meta", "id": id, "error": e }),
                });
            });
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
        Cmd::Pause | Cmd::Toggle if PLAYING.load(std::sync::atomic::Ordering::Relaxed) && !bitperfect() && crate::dsp::params().fade_ms > 0.0 => {
            // Pauzeren met een heel korte fade, geen klik.
            let Some(live) = &st.live else { return };
            crate::dsp::fade_out();
            let spirc = live.spirc.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(130)).await;
                let _ = spirc.pause();
            });
        }
        Cmd::Volume(_) if bitperfect() => {}
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
        // Liever de plek in de lijst: een nummer-ID kan in de context een andere versie zijn.
        playing_track: if let Some(i) = req["index"].as_u64() {
            Some(PlayingTrack::Index(i as u32))
        } else {
            req["uri"].as_str().map(|uri| PlayingTrack::Uri(uri.into()))
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
    if let Some(api) = &st.api {
        if let Ok(left) = api.expires.duration_since(SystemTime::now()) {
            if left > Duration::from_secs(60) {
                return Ok((api.access.clone(), left.as_secs()));
            }
        }
    }
    // Eerst met de refresh-token (snel), dan stil via de sessie, en anders eenmalig via de browser.
    let refresh = settings::get("refresh").as_str().map(String::from).filter(|r| !r.is_empty());
    if refresh.is_none() {
        let quick = live.session.token_provider().get_token_with_client_id(&scopes, &client_id);
        if let Ok(Ok(t)) = tokio::time::timeout(Duration::from_secs(4), quick).await {
            return Ok((t.access_token, t.expires_in.as_secs()));
        }
    }
    #[cfg(target_os = "android")]
    {
        let (access, refresh_new, secs) = tokio::task::spawn_blocking(move || crate::oauth::authorize(&client_id, REDIRECT, SCOPES, refresh))
            .await
            .map_err(|e| e.to_string())??;
        if !refresh_new.is_empty() {
            settings::set("refresh", json!(refresh_new));
        }
        st.api = Some(ApiToken { access: access.clone(), expires: SystemTime::now() + Duration::from_secs(secs) });
        return Ok((access, secs));
    }
    #[cfg(not(target_os = "android"))]
    {
    let got = tokio::task::spawn_blocking(move || {
        let client = librespot_oauth::OAuthClientBuilder::new(&client_id, REDIRECT, SCOPES.to_vec())
            .open_in_browser()
            .with_custom_message(DONE_PAGE)
            .build()
            .map_err(|e| e.to_string())?;
        if let Some(r) = refresh {
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
                        artists
                            .iter()
                            .map(|a| {
                                let uri = a.id.to_uri().unwrap_or_default();
                                json!({ "name": a.name, "id": uri.rsplit(':').next(), "uri": uri })
                            })
                            .collect(),
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
                crate::dsp::track_changed(item.duration_ms, matches!(item.unique_fields, UniqueFields::Episode { .. }));
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
                PLAYING.store(true, std::sync::atomic::Ordering::Relaxed);
                nowplaying::state(true, position_ms);
                json!({ "type": "play", "playing": true, "position": position_ms, "at": now_ms() })
            }
            PlayerEvent::Paused { position_ms, .. } => {
                PLAYING.store(false, std::sync::atomic::Ordering::Relaxed);
                nowplaying::state(false, position_ms);
                json!({ "type": "play", "playing": false, "position": position_ms, "at": now_ms() })
            }
            PlayerEvent::Stopped { .. } => {
                nowplaying::state(false, 0);
                json!({ "type": "stopped" })
            }
            PlayerEvent::Loading { position_ms, .. } => json!({ "type": "loading", "position": position_ms }),
            PlayerEvent::Seeked { position_ms, .. } | PlayerEvent::PositionCorrection { position_ms, .. } => {
                crate::dsp::seeked(position_ms);
                nowplaying::position(position_ms);
                position(position_ms)
            }
            PlayerEvent::PositionChanged { position_ms, .. } => {
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

/// De uitvoerapparaten (voor Instellingen), met wat ze kunnen.
pub fn devices() -> Value {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.name().ok());
    let list: Vec<Value> = host
        .output_devices()
        .map(|it| {
            it.filter_map(|d| {
                let name = d.name().ok()?;
                let rate = d.default_output_config().ok().map(|c| c.sample_rate().0);
                // Kan het apparaat zelf 44,1 kHz (de bron van Spotify)? Dan hoeft er niets omgerekend te worden.
                let native = d.supported_output_configs().ok().is_some_and(|mut c| c.any(|c| c.channels() == 2 && c.min_sample_rate().0 <= 44100 && c.max_sample_rate().0 >= 44100));
                Some(json!({ "name": name, "rate": rate, "native441": native, "default": Some(&name) == default.as_ref() }))
            })
            .collect()
        })
        .unwrap_or_default();
    json!(list)
}

/// De cache met nummers legen.
pub fn clear_cache() -> u64 {
    let dir = data_dir().join("audio");
    let size = dir_size(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::create_dir_all(&dir);
    size
}

pub fn dir_size(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|it| it.flatten().map(|e| e.metadata().map(|m| if m.is_dir() { dir_size(&e.path()) } else { m.len() }).unwrap_or(0)).sum())
        .unwrap_or(0)
}
