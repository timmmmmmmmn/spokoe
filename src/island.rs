//! Het eiland: bij een nieuw nummer schuift bovenaan het scherm (onder de notch) even een zwarte
//! pil in met de hoes, de titel en de artiest. Alleen als Spotimfy niet voorop staat.

use std::cell::{Cell, RefCell};

use objc2::rc::Retained;
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAnimatablePropertyContainer, NSAnimationContext, NSApplication, NSBackingStoreType, NSColor, NSEvent, NSFont, NSImage, NSImageScaling, NSImageView,
    NSLineBreakMode, NSPanel, NSScreen, NSTextField, NSView, NSWindowCollectionBehavior, NSWindowStyleMask,
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::NSString;

const W: f64 = 360.0;
const H: f64 = 64.0;

struct Island {
    panel: Retained<NSPanel>,
    cover: Retained<NSImageView>,
    title: Retained<NSTextField>,
    artist: Retained<NSTextField>,
}

thread_local! {
    static ISLAND: RefCell<Option<Island>> = const { RefCell::new(None) };
    static SHOWN: Cell<u64> = const { Cell::new(0) };
}

define_class!(
    /// Klikken op de pil opent Spotimfy.
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "SpotimfyIslandView"]
    struct IslandView;

    impl IslandView {
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, _event: &NSEvent) {
            hide();
            crate::ui::show_window();
        }
    }
);

fn label(mtm: MainThreadMarker, size: f64, bold: bool, alpha: f64) -> Retained<NSTextField> {
    let l = NSTextField::labelWithString(&NSString::from_str(""), mtm);
    let font = if bold { NSFont::boldSystemFontOfSize(size) } else { NSFont::systemFontOfSize(size) };
    l.setFont(Some(&font));
    l.setTextColor(Some(&NSColor::colorWithWhite_alpha(1.0, alpha)));
    l.setLineBreakMode(NSLineBreakMode::ByTruncatingTail);
    l
}

fn build(mtm: MainThreadMarker) -> Island {
    let frame = CGRect::new(CGPoint::ZERO, CGSize::new(W, H));
    let panel = NSPanel::initWithContentRect_styleMask_backing_defer(
        mtm.alloc(),
        frame,
        NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel,
        NSBackingStoreType::Buffered,
        false,
    );
    panel.setOpaque(false);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHasShadow(true);
    panel.setLevel(25); // NSStatusWindowLevel: boven de menubalk
    panel.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary | NSWindowCollectionBehavior::FullScreenAuxiliary);
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setHidesOnDeactivate(false);

    let root: Retained<IslandView> = unsafe { msg_send![IslandView::alloc(mtm), initWithFrame: frame] };
    root.setWantsLayer(true);
    if let Some(layer) = root.layer() {
        layer.setCornerRadius(H / 2.0);
        layer.setMasksToBounds(true);
        let black = NSColor::blackColor();
        layer.setBackgroundColor(Some(&black.CGColor()));
    }
    let cover = NSImageView::initWithFrame(mtm.alloc(), CGRect::new(CGPoint::new(12.0, 10.0), CGSize::new(44.0, 44.0)));
    cover.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
    cover.setWantsLayer(true);
    if let Some(layer) = cover.layer() {
        layer.setCornerRadius(9.0);
        layer.setMasksToBounds(true);
    }
    let title = label(mtm, 14.0, true, 1.0);
    title.setFrame(CGRect::new(CGPoint::new(68.0, 32.0), CGSize::new(W - 68.0 - 46.0, 19.0)));
    let artist = label(mtm, 12.5, false, 0.6);
    artist.setFrame(CGRect::new(CGPoint::new(68.0, 13.0), CGSize::new(W - 68.0 - 46.0, 17.0)));
    // Rechts het icoontje van Spotimfy, zoals bij het echte eiland.
    let mark = NSImageView::initWithFrame(mtm.alloc(), CGRect::new(CGPoint::new(W - 40.0, 20.0), CGSize::new(24.0, 24.0)));
    if let Some(img) = NSImage::imageWithSystemSymbolName_accessibilityDescription(&NSString::from_str("waveform"), None) {
        mark.setImage(Some(&img));
        mark.setContentTintColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(0.45, 0.5, 1.0, 1.0)));
    }
    root.addSubview(&cover);
    root.addSubview(&title);
    root.addSubview(&artist);
    root.addSubview(&mark);
    panel.setContentView(Some(&root));
    Island { panel, cover, title, artist }
}

/// Vanaf de hoofdthread aanroepen.
pub fn show(title: &str, artist: &str, image: Option<&NSImage>) {
    let mtm = MainThreadMarker::new().unwrap();
    if NSApplication::sharedApplication(mtm).isActive() || !crate::settings::get("island").as_bool().unwrap_or(true) {
        return;
    }
    let Some(screen) = NSScreen::mainScreen(mtm) else { return };
    ISLAND.with_borrow_mut(|i| {
        let island = i.get_or_insert_with(|| build(mtm));
        island.title.setStringValue(&NSString::from_str(title));
        island.artist.setStringValue(&NSString::from_str(artist));
        island.cover.setImage(image);
        // Net onder de menubalk (en dus de notch), in het midden.
        let f = screen.frame();
        let top = screen.visibleFrame().origin.y + screen.visibleFrame().size.height;
        let x = f.origin.x + (f.size.width - W) / 2.0;
        let shown = CGRect::new(CGPoint::new(x, top - H - 8.0), CGSize::new(W, H));
        let start = CGRect::new(CGPoint::new(x + 30.0, top - H + 10.0), CGSize::new(W - 60.0, H - 6.0));
        let panel = island.panel.clone();
        if !panel.isVisible() {
            panel.setFrame_display(start, false);
            panel.setAlphaValue(0.0);
        }
        panel.orderFrontRegardless();
        NSAnimationContext::runAnimationGroup(&block2::RcBlock::new(move |ctx: std::ptr::NonNull<NSAnimationContext>| {
            unsafe { ctx.as_ref() }.setDuration(0.35);
            let a = panel.animator();
            a.setFrame_display(shown, true);
            a.setAlphaValue(1.0);
        }));
    });
    let n = SHOWN.get() + 1;
    SHOWN.set(n);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(3800));
        dispatch2::DispatchQueue::main().exec_async(move || {
            if SHOWN.get() == n {
                hide();
            }
        });
    });
}

pub fn hide() {
    ISLAND.with_borrow(|i| {
        let Some(island) = i else { return };
        let panel = island.panel.clone();
        let f = panel.frame();
        let end = CGRect::new(CGPoint::new(f.origin.x + 30.0, f.origin.y + 14.0), CGSize::new(f.size.width - 60.0, f.size.height - 6.0));
        let p2 = panel.clone();
        NSAnimationContext::runAnimationGroup_completionHandler(
            &block2::RcBlock::new(move |ctx: std::ptr::NonNull<NSAnimationContext>| {
                unsafe { ctx.as_ref() }.setDuration(0.3);
                let a = panel.animator();
                a.setFrame_display(end, true);
                a.setAlphaValue(0.0);
            }),
            Some(&block2::RcBlock::new(move || p2.orderOut(None))),
        );
    });
}
