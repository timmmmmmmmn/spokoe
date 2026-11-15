//! Alleen om te testen (SPOTIMFY_DEV=1): op 127.0.0.1:7357 voert POST /js de body uit als
//! async JavaScript in de pagina (met `return` voor een antwoord), en GET /shot?pad maakt een plaatje.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;

use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::NSImage;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::WKContentWorld;

pub fn start() {
    if std::env::var("SPOTIMFY_DEV").is_err() {
        return;
    }
    std::thread::spawn(|| {
        let Ok(listener) = TcpListener::bind("127.0.0.1:7357") else { return };
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                let mut len = 0;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; len];
                let _ = reader.read_exact(&mut body);
                let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let answer = if let Some(path) = target.strip_prefix("/shot?") { shot(path.to_string()) } else { js(String::from_utf8_lossy(&body).into_owned()) };
                let mut stream = stream;
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", answer.len(), answer);
            });
        }
    });
}

fn js(source: String) -> String {
    let (tx, rx) = mpsc::channel::<String>();
    dispatch2::DispatchQueue::main().exec_async(move || {
        let Some(web) = crate::ui::web() else { return };
        let body = format!("try {{ const r = await (async () => {{ {source}\n }})(); return JSON.stringify(r ?? null); }} catch (e) {{ return 'FOUT: ' + e + '\\n' + e.stack; }}");
        let tx = tx.clone();
        let done = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
            let text = unsafe { result.as_ref() }
                .and_then(|r| r.downcast_ref::<NSString>().map(|s| s.to_string()))
                .or_else(|| unsafe { error.as_ref() }.map(|e| format!("FOUT: {}", e.localizedDescription())))
                .unwrap_or_default();
            let _ = tx.send(text);
        });
        let world = unsafe { WKContentWorld::pageWorld(MainThreadMarker::new().unwrap()) };
        unsafe { web.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(&NSString::from_str(&body), None, None, &world, Some(&done)) };
    });
    rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or_else(|_| "FOUT: geen antwoord".into())
}

fn shot(path: String) -> String {
    let (tx, rx) = mpsc::channel::<String>();
    dispatch2::DispatchQueue::main().exec_async(move || {
        let Some(web) = crate::ui::web() else { return };
        let tx = tx.clone();
        let path = path.clone();
        let done = RcBlock::new(move |image: *mut NSImage, _e: *mut NSError| {
            let ok = unsafe { image.as_ref() }.and_then(|i| i.TIFFRepresentation()).map(|d| std::fs::write(&path, d.to_vec()).is_ok());
            let _ = tx.send(if ok == Some(true) { "ok".into() } else { "FOUT".into() });
        });
        unsafe { web.takeSnapshotWithConfiguration_completionHandler(None, &done) };
    });
    rx.recv_timeout(std::time::Duration::from_secs(20)).unwrap_or_else(|_| "FOUT".into())
}
