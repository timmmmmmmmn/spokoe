//! Zelf bijwerken vanaf GitHub-releases: kijken of er een nieuwere versie is, de zip ophalen,
//! en na het afsluiten de app in /Applications vervangen en opnieuw openen.

use serde_json::{json, Value};

const RELEASES: &str = "https://api.github.com/repos/timmmmmmmmn/spotimfy/releases/latest";

fn version_tuple(v: &str) -> Vec<u32> {
    v.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// { current, latest, newer, url, notes } of { error }.
pub fn check() -> Value {
    let current = env!("CARGO_PKG_VERSION");
    let got = reqwest::blocking::Client::new()
        .get(RELEASES)
        .header("User-Agent", "Spotimfy")
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .and_then(|r| r.text())
        .map(|t| serde_json::from_str::<Value>(&t).unwrap_or_default());
    let Ok(r) = got else { return json!({ "current": current, "error": "geen verbinding met GitHub" }) };
    let Some(tag) = r["tag_name"].as_str() else { return json!({ "current": current, "error": "nog geen release gevonden" }) };
    let url = r["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.ends_with(".zip"))))
        .and_then(|x| x["browser_download_url"].as_str());
    json!({
        "current": current,
        "latest": tag.trim_start_matches('v'),
        "newer": version_tuple(tag) > version_tuple(current),
        "url": url,
        "notes": r["body"],
    })
}

pub fn install(url: &str) -> Result<(), String> {
    let dir = std::env::temp_dir().join("spotimfy-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip = dir.join("Spotimfy.zip");
    let bytes = reqwest::blocking::Client::new()
        .get(url)
        .header("User-Agent", "Spotimfy")
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(&zip, &bytes).map_err(|e| e.to_string())?;
    let ok = std::process::Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(&zip).arg(&dir).status().map_err(|e| e.to_string())?;
    if !ok.success() || !dir.join("Spotimfy.app").exists() {
        return Err("de download is geen geldige app".into());
    }
    // Een klein script wacht tot deze app dicht is, zet de nieuwe neer en opent hem.
    let target = std::env::current_exe()
        .ok()
        .and_then(|p| p.ancestors().find(|a| a.extension().is_some_and(|e| e == "app")).map(|p| p.to_path_buf()))
        .unwrap_or_else(|| "/Applications/Spotimfy.app".into());
    let script = format!(
        "while kill -0 {pid} 2>/dev/null; do sleep 0.3; done; rm -rf '{t}'; mv '{n}' '{t}'; xattr -dr com.apple.quarantine '{t}' 2>/dev/null; open '{t}'",
        pid = std::process::id(),
        t = target.display(),
        n = dir.join("Spotimfy.app").display()
    );
    std::process::Command::new("/bin/sh").args(["-c", &script]).spawn().map_err(|e| e.to_string())?;
    dispatch2::DispatchQueue::main().exec_async(|| {
        let mtm = objc2::MainThreadMarker::new().unwrap();
        objc2_app_kit::NSApplication::sharedApplication(mtm).terminate(None);
    });
    Ok(())
}
