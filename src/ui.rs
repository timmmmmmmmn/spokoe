//! Het venster: een WKWebView met de eigen (meegebakken) pagina, de menubalk van de app en
//! het icoontje rechtsboven. Alles hier draait op de hoofdthread.

use std::cell::RefCell;

use block2::DynBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject, Sel};
use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAppearanceCustomization,
    NSApplication, NSApplicationDelegate, NSAutoresizingMaskOptions, NSBackingStoreType, NSColor, NSEvent, NSEventModifierFlags,
    NSImage, NSMenu, NSMenuItem, NSPasteboard, NSPasteboardTypeString, NSStatusBar, NSStatusItem, NSVariableStatusItemLength, NSView,
    NSWindow, NSWindowDelegate, NSWindowStyleMask, NSWindowTitleVisibility, NSWorkspace,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{ns_string, NSNotification, NSNumber, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationType, WKScriptMessage, WKScriptMessageHandler,
    WKUIDelegate, WKUserContentController, WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};
use serde_json::{json, Value};

use crate::player::{self, Cmd};

/// Hoe hoog de titelbalk is: daar sleep je het venster (de pagina houdt die strook vrij).
const STRIP: f64 = 38.0;

struct Ui {
    window: Retained<NSWindow>,
    web: Retained<WKWebView>,
    status: Retained<NSStatusItem>,
    now: Retained<NSMenuItem>,
    toggle: Retained<NSMenuItem>,
    ready: bool,
    /// Het grote venster van voor de minispeler.
    big: Option<CGRect>,
    /// Berichten van voordat de pagina klaar was.
    queue: Vec<String>,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

fn with_ui<R>(f: impl FnOnce(&mut Ui) -> R) -> Option<R> {
    UI.with(|ui| ui.try_borrow_mut().ok().and_then(|mut ui| ui.as_mut().map(f)))
}

fn run_js(web: &WKWebView, js: &str) {
    unsafe { web.evaluateJavaScript_completionHandler(&NSString::from_str(js), None) };
}

/// De laatste status (ingelogd, verbinden…): opnieuw naar een vers geladen pagina.
static LAST_STATUS: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Een bericht naar de pagina (vanaf elke thread).
pub fn send(msg: Value) {
    if msg["type"] == "status" {
        if let Ok(mut last) = LAST_STATUS.lock() {
            *last = Some(msg.to_string());
        }
    }
    let js = format!("window.spotimfy&&spotimfy.recv({msg})");
    dispatch2::DispatchQueue::main().exec_async(move || {
        with_ui(|ui| {
            if ui.ready {
                run_js(&ui.web, &js);
            } else {
                ui.queue.push(js);
            }
        });
    });
}

/// Een knop buiten de pagina (mediatoets, menu): de pagina beslist wat ermee gebeurt.
pub fn remote(cmd: &str, ms: Option<u64>) {
    send(json!({ "type": "remote", "cmd": cmd, "ms": ms }));
}

/// Het icoontje in de menubalk bijwerken.
pub fn status_item((title, artist, playing): &(String, String, bool)) {
    with_ui(|ui| {
        let line = if title.is_empty() { "Er speelt niets".to_string() } else { format!("{title} — {artist}") };
        ui.now.setTitle(&NSString::from_str(&line));
        ui.toggle.setTitle(&NSString::from_str(if *playing { "Pauzeer" } else { "Speel af" }));
    });
}

thread_local! {
    static STATUS_COVER: RefCell<Option<Retained<NSImage>>> = const { RefCell::new(None) };
}

/// Het menubalk-icoon: een plaatje vinyl met heel klein de hoes in het midden (of een gaatje).
pub fn status_cover(cover: Option<&NSImage>) {
    STATUS_COVER.with_borrow_mut(|c| *c = cover.map(|i| objc2::Message::retain(i)));
    let mtm = MainThreadMarker::new().unwrap();
    let draw = block2::RcBlock::new(|rect: objc2_foundation::NSRect| -> objc2::runtime::Bool {
        let size = rect.size.width.min(rect.size.height);
        let c = CGPoint::new(rect.origin.x + rect.size.width / 2.0, rect.origin.y + rect.size.height / 2.0);
        let oval = |r: f64| objc2_app_kit::NSBezierPath::bezierPathWithOvalInRect(CGRect::new(CGPoint::new(c.x - r, c.y - r), CGSize::new(2.0 * r, 2.0 * r)));
        let ink = NSColor::labelColor();
        // De plaat, met twee dunne groeven.
        ink.colorWithAlphaComponent(0.85).setFill();
        oval(size / 2.0 - 0.5).fill();
        let groove = NSColor::windowBackgroundColor().colorWithAlphaComponent(0.35);
        groove.setStroke();
        for r in [size * 0.36, size * 0.28] {
            let g = oval(r);
            g.setLineWidth(0.5);
            g.stroke();
        }
        // Het label: de hoes als die er is, anders een gaatje.
        let label = size * 0.2;
        STATUS_COVER.with_borrow(|cover| match cover {
            Some(img) => {
                objc2_app_kit::NSGraphicsContext::saveGraphicsState_class();
                oval(label).addClip();
                img.drawInRect(CGRect::new(CGPoint::new(c.x - label, c.y - label), CGSize::new(2.0 * label, 2.0 * label)));
                objc2_app_kit::NSGraphicsContext::restoreGraphicsState_class();
            }
            None => {
                NSColor::windowBackgroundColor().setFill();
                oval(size * 0.07).fill();
            }
        });
        objc2::runtime::Bool::YES
    });
    let image = NSImage::imageWithSize_flipped_drawingHandler(CGSize::new(18.0, 18.0), false, &draw);
    with_ui(|ui| {
        if let Some(button) = ui.status.button(mtm) {
            button.setImage(Some(&image));
            button.setTitle(ns_string!(""));
        }
    });
}

/// Een bericht van de pagina: { cmd, ... }.
fn handle(text: &str) {
    let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
    let num = |k: &str| msg[k].as_f64().unwrap_or(0.0);
    match msg["cmd"].as_str().unwrap_or("") {
        "ready" => {
            let queued = with_ui(|ui| {
                ui.ready = true;
                std::mem::take(&mut ui.queue)
            });
            let web = with_ui(|ui| ui.web.clone());
            if let (Some(queued), Some(web)) = (queued, web) {
                for js in queued {
                    run_js(&web, &js);
                }
            }
            if let Some(status) = LAST_STATUS.lock().ok().and_then(|l| l.clone()) {
                if let Ok(v) = serde_json::from_str(&status) {
                    send(v);
                }
            }
            send(json!({
                "type": "config",
                "clientId": crate::settings::get("clientId"),
                "redirect": player::REDIRECT,
            }));
        }
        "login" => player::send(Cmd::Login),
        "reconnect" => player::send(Cmd::Retry),
        "devLose" if std::env::var("SPOTIMFY_DEV").is_ok() => player::send(Cmd::DevLose),
        "check" => player::send(Cmd::Check { deep: true }),
        "openLog" => {
            let path = player::data_dir().join("spotimfy.log");
            NSWorkspace::sharedWorkspace().openURL(&NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy())));
        }
        "logout" => player::send(Cmd::Logout),
        "setClientId" => {
            crate::settings::set("clientId", msg["id"].clone());
            crate::settings::set("refresh", Value::Null);
        }
        "token" => player::send(Cmd::Token { id: num("id") as u64 }),
        "lyrics" => player::send(Cmd::Lyrics { id: num("id") as u64, track: msg["track"].as_str().unwrap_or("").into() }),
        "meta" => player::send(Cmd::Meta {
            id: num("id") as u64,
            kind: msg["kind"].as_str().unwrap_or("").into(),
            arg: msg["arg"].as_str().unwrap_or("").into(),
        }),
        "play" => player::send(Cmd::Play(msg.clone())),
        "toggle" => player::send(Cmd::Toggle),
        "pause" => player::send(Cmd::Pause),
        "resume" => player::send(Cmd::Resume),
        "next" => player::send(Cmd::Next),
        "prev" => player::send(Cmd::Prev),
        "seek" => player::send(Cmd::Seek(num("ms") as u32)),
        "volume" => player::send(Cmd::Volume(num("v"))),
        "shuffle" => player::send(Cmd::Shuffle(msg["on"].as_bool().unwrap_or(false))),
        "repeat" => player::send(Cmd::Repeat {
            context: msg["context"].as_bool().unwrap_or(false),
            track: msg["track"].as_bool().unwrap_or(false),
        }),
        "open" => {
            if let Some(url) = msg["url"].as_str().and_then(|u| NSURL::URLWithString(&NSString::from_str(u))) {
                NSWorkspace::sharedWorkspace().openURL(&url);
            }
        }
        "copy" => {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            pb.setString_forType(&NSString::from_str(msg["text"].as_str().unwrap_or("")), unsafe { NSPasteboardTypeString });
        }
        "show" => show_window(),
        "log" => log::warn!("pagina: {}", msg["msg"].as_str().unwrap_or("")),
        "mini" => set_mini(msg["on"].as_bool().unwrap_or(false)),
        "island" => crate::settings::set("island", msg["on"].clone()),
        "setting" => crate::settings::set(msg["key"].as_str().unwrap_or("x"), msg["value"].clone()),
        "theme" => {
            let dark = msg["dark"].as_bool().unwrap_or(true);
            with_ui(|ui| {
                let name = unsafe { if dark { objc2_app_kit::NSAppearanceNameDarkAqua } else { objc2_app_kit::NSAppearanceNameAqua } };
                ui.window.setAppearance(objc2_app_kit::NSAppearance::appearanceNamed(name).as_deref());
                let (r, g, b) = if dark { (0.039, 0.059, 0.247) } else { (0.965, 0.969, 1.0) };
                ui.window.setBackgroundColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(r, g, b, 1.0)));
            });
        }
        _ => {}
    }
}

/// Minispeler: een klein venstertje rechtsboven dat boven alles blijft.
fn set_mini(on: bool) {
    let mtm = MainThreadMarker::new().unwrap();
    with_ui(|ui| {
        let w = &ui.window;
        if on {
            if ui.big.is_none() {
                ui.big = Some(w.frame());
            }
            w.setMinSize(CGSize::new(300.0, 116.0));
            w.setLevel(3); // NSFloatingWindowLevel
            w.setCollectionBehavior(objc2_app_kit::NSWindowCollectionBehavior::CanJoinAllSpaces);
            let screen = w.screen().or_else(|| objc2_app_kit::NSScreen::mainScreen(mtm));
            let size = CGSize::new(380.0, 128.0);
            let origin = screen.map(|s| {
                let v = s.visibleFrame();
                CGPoint::new(v.origin.x + v.size.width - size.width - 16.0, v.origin.y + v.size.height - size.height - 16.0)
            });
            w.setFrame_display_animate(CGRect::new(origin.unwrap_or(CGPoint::ZERO), size), true, true);
        } else {
            w.setLevel(0);
            w.setCollectionBehavior(objc2_app_kit::NSWindowCollectionBehavior::Default);
            w.setMinSize(CGSize::new(720.0, 520.0));
            if let Some(f) = ui.big.take() {
                w.setFrame_display_animate(f, true, true);
            }
        }
    });
}

pub fn show_window() {
    let mtm = MainThreadMarker::new().unwrap();
    with_ui(|ui| ui.window.makeKeyAndOrderFront(None));
    NSApplication::sharedApplication(mtm).activate();
}

define_class!(
    /// De titelbalk-strook: daarmee sleep je het venster (de pagina ligt eronder).
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "SpotimfyDragStrip"]
    struct DragStrip;

    impl DragStrip {
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            let Some(window) = self.window() else { return };
            if event.clickCount() == 2 {
                window.performZoom(None);
            } else {
                window.performWindowDragWithEvent(event);
            }
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SpotimfyHost"]
    pub struct Host;

    impl Host {
        /// Menu-items en het menubalk-icoon: hun naam gaat als "remote" naar de pagina.
        #[unsafe(method(remoteItem:))]
        fn remote_item(&self, sender: &NSMenuItem) {
            if let Some(cmd) = sender.representedObject().and_then(|o| o.downcast::<NSString>().ok()) {
                let cmd = cmd.to_string();
                 if matches!(cmd.as_str(), "search" | "nowplaying" | "lyrics" | "queue" | "settings" | "back" | "forward" | "home" | "library" | "stats") {
                    show_window();
                }
                remote(&cmd, None);
            }
        }

        /// Uit de slaapstand: even later echt nagaan of de verbinding nog leeft.
        #[unsafe(method(didWake:))]
        fn did_wake(&self, _n: &NSNotification) {
            std::thread::spawn(|| {
                std::thread::sleep(std::time::Duration::from_secs(2));
                player::send(Cmd::Check { deep: true });
            });
        }

        #[unsafe(method(showWindow:))]
        fn show_window_action(&self, _sender: Option<&AnyObject>) {
            show_window();
        }

        #[unsafe(method(reloadPage:))]
        fn reload_page(&self, _sender: Option<&AnyObject>) {
            with_ui(|ui| {
                ui.ready = false;
                unsafe { ui.web.reload() };
            });
        }
    }

    unsafe impl NSObjectProtocol for Host {}

    unsafe impl NSApplicationDelegate for Host {
        /// Rechtsklik op het Dock-icoon.
        #[unsafe(method(applicationDockMenu:))]
        fn dock_menu(&self, _app: &NSApplication) -> *mut NSMenu {
            let mtm = MainThreadMarker::new().unwrap();
            let none = NSEventModifierFlags::empty();
            let menu = NSMenu::new(mtm);
            if let Some(now) = with_ui(|ui| ui.now.title()) {
                let line = plain(mtm, &now.to_string(), None, "");
                line.setEnabled(false);
                menu.addItem(&line);
            }
            let playing = with_ui(|ui| ui.toggle.title().to_string()).unwrap_or_else(|| "Speel af".into());
            menu.addItem(&item(mtm, self, &playing, "toggle", "", none));
            menu.addItem(&item(mtm, self, "Volgende", "next", "", none));
            menu.addItem(&item(mtm, self, "Vorige", "prev", "", none));
            menu.addItem(&item(mtm, self, "Vind ik leuk", "like", "", none));
            menu.addItem(&item(mtm, self, "Minispeler", "mini", "", none));
            Retained::autorelease_return(menu)
        }

        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn should_reopen(&self, _app: &NSApplication, _visible: bool) -> bool {
            show_window();
            true
        }
    }

    unsafe impl NSWindowDelegate for Host {
        /// Sluiten verbergt alleen het venster: de muziek speelt door.
        #[unsafe(method(windowShouldClose:))]
        fn window_should_close(&self, window: &NSWindow) -> bool {
            window.orderOut(None);
            false
        }

        #[unsafe(method(windowDidEnterFullScreen:))]
        fn did_enter_full_screen(&self, _n: &NSNotification) {
            send(json!({ "type": "fullscreen", "on": true }));
        }

        #[unsafe(method(windowDidExitFullScreen:))]
        fn did_exit_full_screen(&self, _n: &NSNotification) {
            send(json!({ "type": "fullscreen", "on": false }));
        }
    }

    unsafe impl WKScriptMessageHandler for Host {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            if let Ok(text) = unsafe { message.body() }.downcast::<NSString>() {
                handle(&text.to_string());
            }
        }
    }

    unsafe impl WKNavigationDelegate for Host {
        /// Links naar buiten (Spotify, songteksten) gaan naar de browser.
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(&self, _web: &WKWebView, action: &WKNavigationAction, decision: &DynBlock<dyn Fn(WKNavigationActionPolicy)>) {
            let click = unsafe { action.navigationType() } == WKNavigationType::LinkActivated;
            if click {
                if let Some(url) = unsafe { action.request() }.URL() {
                    NSWorkspace::sharedWorkspace().openURL(&url);
                }
                decision.call((WKNavigationActionPolicy::Cancel,));
            } else {
                decision.call((WKNavigationActionPolicy::Allow,));
            }
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn did_terminate(&self, web: &WKWebView) {
            with_ui(|ui| ui.ready = false);
            load_page(web);
        }
    }

    unsafe impl WKUIDelegate for Host {
        #[unsafe(method(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_web_view(
            &self,
            _web: &WKWebView,
            _config: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> *mut WKWebView {
            if let Some(url) = unsafe { action.request() }.URL() {
                NSWorkspace::sharedWorkspace().openURL(&url);
            }
            std::ptr::null_mut()
        }
    }
);

impl Host {
    pub fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

/// De pagina zit in de app zelf: geen netwerk nodig om hem te tonen.
fn page() -> String {
    include_str!("../ui/index.html")
        .replace("/*CSS*/", include_str!("../ui/app.css"))
        .replace("//JS", include_str!("../ui/app.js"))
}

fn load_page(web: &WKWebView) {
    let base = NSURL::URLWithString(ns_string!("https://spotimfy.app/"));
    unsafe { web.loadHTMLString_baseURL(&NSString::from_str(&page()), base.as_deref()) };
}

fn item(mtm: MainThreadMarker, host: &Host, title: &str, cmd: &str, key: &str, mods: NSEventModifierFlags) -> Retained<NSMenuItem> {
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(mtm.alloc(), &NSString::from_str(title), Some(sel!(remoteItem:)), &NSString::from_str(key))
    };
    item.setKeyEquivalentModifierMask(mods);
    unsafe { item.setTarget(Some(host)) };
    unsafe { item.setRepresentedObject(Some(&NSString::from_str(cmd))) };
    item
}

fn plain(mtm: MainThreadMarker, title: &str, action: Option<Sel>, key: &str) -> Retained<NSMenuItem> {
    unsafe { NSMenuItem::initWithTitle_action_keyEquivalent(mtm.alloc(), &NSString::from_str(title), action, &NSString::from_str(key)) }
}

fn submenu(mtm: MainThreadMarker, bar: &NSMenu, title: &str, items: Vec<Retained<NSMenuItem>>) {
    let menu = NSMenu::initWithTitle(mtm.alloc(), &NSString::from_str(title));
    for i in items {
        menu.addItem(&i);
    }
    let top = plain(mtm, title, None, "");
    top.setSubmenu(Some(&menu));
    bar.addItem(&top);
}

/// De vaste toetsen, behalve spatie (die regelt de pagina, zodat typen in een veld gewoon werkt).
fn main_menu(mtm: MainThreadMarker, host: &Host) {
    let cmd = NSEventModifierFlags::Command;
    let cmd_shift = NSEventModifierFlags::Command | NSEventModifierFlags::Shift;
    let sep = || NSMenuItem::separatorItem(mtm);
    let bar = NSMenu::new(mtm);

    let quit = plain(mtm, "Stop Spotimfy", Some(sel!(terminate:)), "q");
    let hide = plain(mtm, "Verberg Spotimfy", Some(sel!(hide:)), "h");
    let settings = item(mtm, host, "Instellingen…", "settings", ",", cmd);
    submenu(mtm, &bar, "Spotimfy", vec![settings, sep(), hide, sep(), quit]);

    submenu(mtm, &bar, "Wijzig", vec![
        plain(mtm, "Herstel", Some(sel!(undo:)), "z"),
        plain(mtm, "Opnieuw", Some(sel!(redo:)), "Z"),
        sep(),
        plain(mtm, "Knip", Some(sel!(cut:)), "x"),
        plain(mtm, "Kopieer", Some(sel!(copy:)), "c"),
        plain(mtm, "Plak", Some(sel!(paste:)), "v"),
        plain(mtm, "Selecteer alles", Some(sel!(selectAll:)), "a"),
    ]);

    let reload = plain(mtm, "Laad opnieuw", Some(sel!(reloadPage:)), "r");
    unsafe { reload.setTarget(Some(host)) };
    submenu(mtm, &bar, "Weergave", vec![
        item(mtm, host, "Zoeken", "search", "k", cmd),
        item(mtm, host, "Zoek in deze lijst", "find", "f", cmd),
        item(mtm, host, "Home", "home", "1", cmd),
        item(mtm, host, "Bibliotheek", "library", "2", cmd),
        item(mtm, host, "Statistieken", "stats", "3", cmd),
        sep(),
        item(mtm, host, "Songtekst", "lyrics", "l", cmd),
        item(mtm, host, "Wachtrij", "queue", "j", cmd),
        item(mtm, host, "Nu speelt", "nowplaying", "f", NSEventModifierFlags::Command | NSEventModifierFlags::Shift),
        item(mtm, host, "Minispeler", "mini", "m", NSEventModifierFlags::Command | NSEventModifierFlags::Option),
        sep(),
        item(mtm, host, "Terug", "back", "[", cmd),
        item(mtm, host, "Vooruit", "forward", "]", cmd),
        reload,
    ]);

    let left = "\u{F702}";
    let right = "\u{F703}";
    let up = "\u{F700}";
    let down = "\u{F701}";
    submenu(mtm, &bar, "Afspelen", vec![
        item(mtm, host, "Speel af / pauzeer", "toggle", "p", cmd_shift),
        item(mtm, host, "Volgende", "next", right, cmd),
        item(mtm, host, "Vorige", "prev", left, cmd),
        sep(),
        item(mtm, host, "Harder", "volup", up, cmd),
        item(mtm, host, "Zachter", "voldown", down, cmd),
        sep(),
        item(mtm, host, "Shuffle", "shuffle", "s", cmd),
        item(mtm, host, "Herhaal", "repeat", "r", cmd_shift),
        item(mtm, host, "Vind ik leuk", "like", "d", cmd),
        sep(),
        item(mtm, host, "Stop na dit nummer", "stopafter", "", cmd),
        item(mtm, host, "Slaaptimer…", "sleep", "", cmd),
    ]);

    submenu(mtm, &bar, "Venster", vec![
        plain(mtm, "Minimaliseer", Some(sel!(performMiniaturize:)), "m"),
        plain(mtm, "Zoom", Some(sel!(performZoom:)), ""),
        plain(mtm, "Volledig scherm", Some(sel!(toggleFullScreen:)), "f"),
        sep(),
        plain(mtm, "Sluit venster", Some(sel!(performClose:)), "w"),
    ]);
    // Volledig scherm is ⌃⌘F, zoals overal op de Mac.
    if let Some(full) = bar.itemArray().iter().last().and_then(|m| m.submenu()).and_then(|m| m.itemWithTitle(ns_string!("Volledig scherm"))) {
        full.setKeyEquivalentModifierMask(NSEventModifierFlags::Command | NSEventModifierFlags::Control);
    }
    NSApplication::sharedApplication(mtm).setMainMenu(Some(&bar));
}

/// Het icoontje rechtsboven: wat er speelt, en de knoppen.
fn status_bar(mtm: MainThreadMarker, host: &Host) -> (Retained<NSStatusItem>, Retained<NSMenuItem>, Retained<NSMenuItem>) {
    let status = NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
    if let Some(button) = status.button(mtm) {
        button.setImagePosition(objc2_app_kit::NSCellImagePosition::ImageOnly);
    }
    let menu = NSMenu::new(mtm);
    let none = NSEventModifierFlags::empty();
    let now = plain(mtm, "Er speelt niets", None, "");
    now.setEnabled(false);
    let toggle = item(mtm, host, "Speel af", "toggle", "", none);
    menu.addItem(&now);
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    menu.addItem(&toggle);
    menu.addItem(&item(mtm, host, "Volgende", "next", "", none));
    menu.addItem(&item(mtm, host, "Vorige", "prev", "", none));
    menu.addItem(&item(mtm, host, "Vind ik leuk", "like", "", none));
    menu.addItem(&NSMenuItem::separatorItem(mtm));
    let show = plain(mtm, "Open Spotimfy", Some(sel!(showWindow:)), "");
    unsafe { show.setTarget(Some(host)) };
    menu.addItem(&show);
    menu.addItem(&plain(mtm, "Stop Spotimfy", Some(sel!(terminate:)), ""));
    status.setMenu(Some(&menu));
    (status, now, toggle)
}

pub fn build(mtm: MainThreadMarker, host: &Host) {
    main_menu(mtm, host);
    unsafe {
        NSWorkspace::sharedWorkspace().notificationCenter().addObserver_selector_name_object(
            host,
            sel!(didWake:),
            Some(objc2_app_kit::NSWorkspaceDidWakeNotification),
            None,
        )
    };
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let frame = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(1180.0, 780.0));
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(mtm.alloc(), frame, style, NSBackingStoreType::Buffered, false)
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(ns_string!("Spotimfy"));
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
    window.setMinSize(CGSize::new(720.0, 520.0));
    window.center();
    window.setFrameAutosaveName(ns_string!("Hoofdvenster"));
    window.setDelegate(Some(ProtocolObject::from_ref(host)));
    window.setTabbingMode(objc2_app_kit::NSWindowTabbingMode::Disallowed);
    window.setBackgroundColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(0.039, 0.059, 0.247, 1.0)));

    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    let content = unsafe { config.userContentController() };
    unsafe { content.addScriptMessageHandler_name(ProtocolObject::from_ref(host), ns_string!("spotimfy")) };
    // Geluid uit de pagina (voorbeeldjes) mag zonder eerst te klikken.
    unsafe { config.setMediaTypesRequiringUserActionForPlayback(objc2_web_kit::WKAudiovisualMediaTypes::None) };
    // Niet afremmen als het venster achter een ander ligt: timers (slaaptimer, tijdbalk) moeten doorlopen.
    unsafe { config.preferences().setInactiveSchedulingPolicy(objc2_web_kit::WKInactiveSchedulingPolicy::None) };
    let web = unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &config) };
    web.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
    unsafe {
        let _: () = msg_send![&web, setValue: &*NSNumber::new_bool(false), forKey: ns_string!("drawsBackground")];
        web.setNavigationDelegate(Some(ProtocolObject::from_ref(host)));
        web.setUIDelegate(Some(ProtocolObject::from_ref(host)));
        web.setAllowsBackForwardNavigationGestures(false);
        web.setInspectable(true);
    }

    let root = NSView::initWithFrame(mtm.alloc(), frame);
    root.addSubview(&web);
    // De strook ligt bovenop de pagina; die is niet "flipped", dus bovenaan = maxY.
    let strip: Retained<DragStrip> = unsafe {
        msg_send![DragStrip::alloc(mtm), initWithFrame: CGRect::new(CGPoint::new(0.0, frame.size.height - STRIP), CGSize::new(frame.size.width, STRIP))]
    };
    strip.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewMinYMargin);
    root.addSubview(&strip);
    window.setContentView(Some(&root));

    let (status, now, toggle) = status_bar(mtm, host);
    load_page(&web);
    UI.with(|cell| *cell.borrow_mut() = Some(Ui { window, web, status, now, toggle, ready: false, big: None, queue: Vec::new() }));
    status_cover(None);
    show_window();
}

/// De webview (voor het testkanaal in dev.rs).
pub fn web() -> Option<Retained<WKWebView>> {
    with_ui(|ui| ui.web.clone())
}
