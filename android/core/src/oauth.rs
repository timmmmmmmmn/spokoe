//! Inloggen via de browser (OAuth met PKCE). De app opent de pagina; Spotify stuurt de browser
//! daarna terug naar 127.0.0.1, waar deze code meeluistert en de code inwisselt voor een token.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

use base64::Engine;
use rand::Rng;
use serde_json::{json, Value};
use sha2::Digest;

const DONE: &str = "<!doctype html><meta name=viewport content='width=device-width'><body style='font:18px -apple-system,sans-serif;background:#0a0f3f;color:#f3f5ff;display:grid;place-items:center;height:90vh;text-align:center'><div><h2>Ingelogd!</h2><p>Ga terug naar Spokoe.</p></div>";

fn token_request(form: &[(&str, &str)]) -> Result<(String, String, u64), String> {
    let r: Value = reqwest::blocking::Client::new()
        .post("https://accounts.spotify.com/api/token")
        .form(form)
        .send()
        .and_then(|r| r.text())
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))?;
    let access = r["access_token"].as_str().ok_or_else(|| r["error_description"].as_str().unwrap_or("geen token").to_string())?;
    Ok((access.into(), r["refresh_token"].as_str().unwrap_or("").into(), r["expires_in"].as_u64().unwrap_or(3600)))
}

/// (access-token, refresh-token, geldig in s). Met een refresh-token eerst zonder browser.
pub fn authorize(client_id: &str, redirect: &str, scopes: &[&str], refresh: Option<String>) -> Result<(String, String, u64), String> {
    if let Some(r) = refresh {
        if let Ok(t) = token_request(&[("grant_type", "refresh_token"), ("refresh_token", &r), ("client_id", client_id)]) {
            return Ok(t);
        }
    }
    let verifier: String = rand::thread_rng().sample_iter(&rand::distributions::Alphanumeric).take(64).map(char::from).collect();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
    let addr = redirect.trim_start_matches("http://").split('/').next().unwrap_or("127.0.0.1:8898");
    let listener = TcpListener::bind(addr).map_err(|e| e.to_string())?;
    let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    let url = format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&redirect_uri={}&code_challenge_method=S256&code_challenge={}&scope={}",
        client_id,
        enc(redirect),
        challenge,
        enc(&scopes.join(" "))
    );
    crate::ui::send(json!({ "type": "openUrl", "url": url }));
    // Wachten tot de browser terugkomt met ?code=…
    let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).map_err(|e| e.to_string())?;
    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}", DONE.len(), DONE);
    let code = line
        .split_whitespace()
        .nth(1)
        .and_then(|p| p.split_once('?'))
        .and_then(|(_, q)| q.split('&').find_map(|kv| kv.strip_prefix("code=")))
        .ok_or("geen code van Spotify (ingelogd geannuleerd?)")?
        .to_string();
    crate::ui::send(json!({ "type": "loggedIn" }));
    token_request(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", redirect), ("client_id", client_id), ("code_verifier", &verifier)])
}
