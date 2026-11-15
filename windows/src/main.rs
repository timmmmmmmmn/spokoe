//! Spokoe voor Windows: dezelfde kern en interface als op de Mac en Android, in een venster met
//! WebView2. Mica achter de zijbalk, mediatoetsen en het mediapaneel van Windows via souvlaki.
#![windows_subsystem = "windows"]

#[path = "../../src/dsp.rs"]
mod dsp;
#[path = "../../src/meta.rs"]
mod meta;
#[path = "../../src/player.rs"]
mod player;
#[path = "../../src/settings.rs"]
mod settings;
mod bridge;
mod nowplaying;
mod ui;
mod update;

use std::borrow::Cow;

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Icon, WindowBuilder};
use wry::http::{Request, Response};
use wry::WebViewBuilder;

use ui::UserEvent;

/// De pagina: dezelfde als op de Mac, met een dun laagje voor de brug.
fn page() -> String {
    let shim = "window.webkit={messageHandlers:{spokoe:{postMessage:s=>window.ipc.postMessage(s)}}};document.documentElement.classList.add('win');";
    include_str!("../../ui/index.html")
        .replace("/*CSS*/", include_str!("../../ui/app.css"))
        .replace("<script>//JS</script>", &format!("<script>{shim}</script><script>{}</script>", include_str!("../../ui/app.js")))
}

fn serve(req: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let (body, mime): (Cow<'static, [u8]>, &str) = match req.uri().path() {
        "/" | "/index.html" => (Cow::Owned(page().into_bytes()), "text/html; charset=utf-8"),
        _ => (Cow::Borrowed(b"" as &[u8]), "text/plain"),
    };
    Response::builder().header("Content-Type", mime).body(body).unwrap()
}

fn icon() -> Option<Icon> {
    // 64×64 RGBA, gemaakt uit het app-icoon (zie windows/icon.rgba).
    Icon::from_rgba(include_bytes!("../icon.rgba").to_vec(), 64, 64).ok()
}

fn main() {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    let _ = player::DATA_DIR.set(std::path::PathBuf::from(appdata).join("Spokoe"));
    let dir = player::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("spokoe.log")) {
        env_logger::Builder::new()
            .parse_filters("warn,librespot=info,spokoe=info")
            .target(env_logger::Target::Pipe(Box::new(file)))
            .init();
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    ui::set_proxy(event_loop.create_proxy());

    let window = WindowBuilder::new()
        .with_title("Spokoe")
        .with_inner_size(LogicalSize::new(1180.0, 780.0))
        .with_min_inner_size(LogicalSize::new(720.0, 520.0))
        .with_window_icon(icon())
        .with_transparent(true)
        .build(&event_loop)
        .expect("venster");
    // Windows 11: Mica achter de (doorschijnende) zijbalk.
    #[cfg(windows)]
    let _ = window_vibrancy::apply_mica(&window, Some(true));

    let webview = WebViewBuilder::new()
        .with_custom_protocol("spokoe".into(), |_id, req| serve(req))
        .with_url("http://spokoe.localhost/")
        .with_transparent(true)
        .with_devtools(std::env::var("SPOKOE_DEV").is_ok())
        .with_ipc_handler(|req: Request<String>| bridge::handle(req.body()))
        // Links naar buiten in de gewone browser.
        .with_navigation_handler(|url| {
            let own = url.starts_with("http://spokoe.localhost") || url.starts_with("about:");
            if !own {
                let _ = open::that(&url);
            }
            own
        })
        .with_new_window_req_handler(|url, _| {
            let _ = open::that(&url);
            wry::NewWindowResponse::Deny
        })
        .build(&window)
        .expect("webview");

    let mut media = nowplaying::Media::new(&window);
    dsp::set(&settings::get("dsp"));
    player::migrate();
    player::start();

    let mut ready = false;
    let mut waiting: Vec<String> = Vec::new();
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Js(js)) => {
                if ready {
                    let _ = webview.evaluate_script(&js);
                } else {
                    waiting.push(js);
                }
            }
            Event::UserEvent(UserEvent::Ready) => {
                ready = true;
                for js in waiting.drain(..) {
                    let _ = webview.evaluate_script(&js);
                }
            }
            Event::UserEvent(UserEvent::Media(m)) => media.update(m),
            Event::UserEvent(UserEvent::Theme(dark)) => {
                #[cfg(windows)]
                let _ = window_vibrancy::apply_mica(&window, Some(dark));
                let _ = dark;
            }
            Event::UserEvent(UserEvent::Quit) => *control_flow = ControlFlow::Exit,
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}
