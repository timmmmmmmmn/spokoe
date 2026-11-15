//! Zelf bijwerken op Windows: de nieuwste release met een "-windows.zip" ophalen, uitpakken, en
//! na het afsluiten de bestanden naast Spokoe.exe vervangen en opnieuw starten.

use serde_json::{json, Value};

const RELEASES: &str = "https://api.github.com/repos/timmmmmmmmn/spokoe/releases?per_page=30";

fn version_tuple(v: &str) -> Vec<u32> {
    v.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

pub fn check() -> Value {
    let current = env!("CARGO_PKG_VERSION");
    let list: Value = reqwest::blocking::Client::new()
        .get(RELEASES)
        .header("User-Agent", "Spokoe")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .and_then(|r| r.text())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let zip = |r: &&Value| r["assets"].as_array().is_some_and(|a| a.iter().any(|x| x["name"].as_str().is_some_and(|n| n.ends_with("windows.zip"))));
    let Some(r) = list.as_array().and_then(|a| a.iter().find(zip)) else {
        return json!({ "current": current, "error": "nog geen release gevonden" });
    };
    let tag = r["tag_name"].as_str().unwrap_or("");
    let url = r["assets"].as_array().and_then(|a| a.iter().find(|x| x["name"].as_str().is_some_and(|n| n.ends_with("windows.zip")))).and_then(|x| x["browser_download_url"].as_str());
    json!({ "current": current, "latest": tag.trim_start_matches('v'), "newer": version_tuple(tag) > version_tuple(current), "url": url })
}

pub fn install(url: &str) -> Result<(), String> {
    let dir = std::env::temp_dir().join("spokoe-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let zip = dir.join("Spokoe.zip");
    let bytes = reqwest::blocking::Client::new()
        .get(url)
        .header("User-Agent", "Spokoe")
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .map_err(|e| e.to_string())?;
    std::fs::write(&zip, &bytes).map_err(|e| e.to_string())?;
    let new = dir.join("nieuw");
    let ok = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("Expand-Archive -Force -Path '{}' -DestinationPath '{}'", zip.display(), new.display())])
        .status()
        .map_err(|e| e.to_string())?;
    if !ok.success() {
        return Err("uitpakken mislukt".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = exe.parent().ok_or("geen map")?.to_path_buf();
    // Een klein script wacht tot Spokoe dicht is, zet de nieuwe bestanden neer en start opnieuw.
    let script = dir.join("bijwerken.cmd");
    std::fs::write(
        &script,
        format!(
            "@echo off\r\n:wacht\r\ntasklist /FI \"PID eq {pid}\" | find \"{pid}\" >nul && (timeout /t 1 /nobreak >nul & goto wacht)\r\nxcopy /E /Y /Q \"{new}\\*\" \"{target}\\\" >nul\r\nstart \"\" \"{exe}\"\r\n",
            pid = std::process::id(),
            new = new.display(),
            target = target.display(),
            exe = exe.display()
        ),
    )
    .map_err(|e| e.to_string())?;
    std::process::Command::new("cmd").args(["/C", "start", "", "/MIN"]).arg(&script).spawn().map_err(|e| e.to_string())?;
    crate::ui::event(crate::ui::UserEvent::Quit);
    Ok(())
}
