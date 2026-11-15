//! Gegevens via de interne Spotify-route van librespot, voor wat de Web API nieuwe apps niet
//! meer geeft: de inhoud van playlists van anderen en de populaire nummers van een artiest.

use std::collections::HashMap;
use std::sync::Mutex;

use futures::stream::{self, StreamExt};
use librespot::core::session::Session;
use librespot::core::{SpotifyId, SpotifyUri};
use librespot::metadata::{Artist, Metadata, Playlist, Track};
use serde_json::{json, Value};

static TRACKS: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

fn cover_url(id: impl std::fmt::Display) -> String {
    format!("https://i.scdn.co/image/{id}")
}

/// Eén nummer in dezelfde vorm als `norm()` in de pagina.
async fn track(session: &Session, uri: &SpotifyUri) -> Option<Value> {
    let key = uri.to_uri().ok()?;
    if let Some(hit) = TRACKS.lock().ok()?.get_or_insert_with(HashMap::new).get(&key) {
        return Some(hit.clone());
    }
    let t = Track::get(session, uri).await.ok()?;
    let mut covers: Vec<_> = t.album.covers.iter().collect();
    covers.sort_by_key(|c| c.width);
    let images: Vec<Value> = covers.iter().map(|c| json!({ "url": cover_url(&c.id), "width": c.width })).collect();
    let artists: Vec<Value> = if t.artists_with_role.is_empty() {
        t.artists.iter().map(|a| artist_json(&a.id, &a.name)).collect()
    } else {
        t.artists_with_role.iter().map(|a| artist_json(&a.id, &a.name)).collect()
    };
    let album_id = t.album.id.to_uri().ok().and_then(|u| u.rsplit(':').next().map(String::from));
    let v = json!({
        "uri": key,
        "id": key.rsplit(':').next(),
        "name": t.name,
        "artists": artists,
        "album": { "name": t.album.name, "id": album_id, "images": images },
        "duration": t.duration,
        "explicit": t.is_explicit,
        "playable": true,
    });
    if let Ok(mut cache) = TRACKS.lock() {
        cache.get_or_insert_with(HashMap::new).insert(key, v.clone());
    }
    Some(v)
}

fn artist_json(id: &SpotifyUri, name: &str) -> Value {
    let uri = id.to_uri().unwrap_or_default();
    json!({ "name": name, "id": uri.rsplit(':').next(), "uri": uri })
}

/// Veel nummers tegelijk ophalen (32 verzoeken tegelijk), in de oorspronkelijke volgorde.
async fn tracks(session: &Session, uris: Vec<SpotifyUri>) -> Vec<Value> {
    stream::iter(uris)
        .map(|u| async move { track(session, &u).await })
        .buffered(32)
        .filter_map(|v| async move { v })
        .collect()
        .await
}

pub async fn playlist(session: &Session, id: &str) -> Result<Value, String> {
    let uri = SpotifyUri::Playlist { user: None, id: SpotifyId::from_base62(id).map_err(|e| e.to_string())? };
    let p = Playlist::get(session, &uri).await.map_err(|e| e.to_string())?;
    let items: Vec<_> = p.contents.items.iter().filter(|i| matches!(i.id, SpotifyUri::Track { .. })).collect();
    let added: HashMap<String, i64> =
        items.iter().filter_map(|i| Some((i.id.to_uri().ok()?, i.attributes.timestamp.as_timestamp_ms()))).collect();
    let mut list = tracks(session, items.iter().map(|i| i.id.clone()).collect()).await;
    for t in &mut list {
        if let Some(ms) = t["uri"].as_str().and_then(|u| added.get(u)) {
            t["added"] = json!(ms);
        }
    }
    Ok(json!({ "name": p.attributes.name, "description": p.attributes.description, "tracks": list }))
}

pub async fn artist_top(session: &Session, id: &str) -> Result<Value, String> {
    let uri = SpotifyUri::Artist { id: SpotifyId::from_base62(id).map_err(|e| e.to_string())? };
    let a = Artist::get(session, &uri).await.map_err(|e| e.to_string())?;
    let top = a.top_tracks.for_country(&session.country());
    Ok(json!(tracks(session, top.0.into_iter().take(10).collect()).await))
}

/// Kandidaten voor de radio: Spotify's eigen radio (apollo) voor een nummer of artiest,
/// zonder `previous` (al gehoord). Geeft de nummers met gegevens terug, in Spotify's volgorde.
pub async fn radio(session: &Session, seed: &str, count: usize, previous: Vec<String>) -> Result<Value, String> {
    let previous: Vec<SpotifyId> = previous.iter().filter_map(|u| SpotifyId::from_base62(u.rsplit(':').next()?).ok()).take(100).collect();
    let station = if seed.starts_with("spotify:station:") { seed.to_string() } else { format!("spotify:station:{}", seed.trim_start_matches("spotify:")) };
    let raw = session
        .spclient()
        .get_apollo_station("stations", &station, Some(count), previous, false)
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let uris: Vec<SpotifyUri> = v["tracks"]
        .as_array()
        .map(|a| a.iter().filter_map(|t| t["uri"].as_str().and_then(|u| SpotifyUri::from_uri(u).ok())).collect())
        .unwrap_or_default();
    if uris.is_empty() {
        return Err(format!("geen radio: {}", v.to_string().chars().take(200).collect::<String>()));
    }
    Ok(json!(tracks(session, uris).await))
}
