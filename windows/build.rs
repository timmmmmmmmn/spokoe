// Het icoon in Spokoe.exe (alleen als er op Windows zelf gebouwd wordt).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") && cfg!(windows) {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icon.ico");
        res.set("ProductName", "Spokoe");
        res.set("FileDescription", "Spokoe");
        let _ = res.compile();
    }
}
