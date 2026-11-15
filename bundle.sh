#!/bin/sh
# Bouwt target/Spokoe.app.
set -e
cd "$(dirname "$0")"
cargo build --release
APP=target/Spokoe.app
VERSION=$(grep -m1 "^version" Cargo.toml | cut -d\" -f2)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/spokoe "$APP/Contents/MacOS/Spokoe"
[ -f icon/Spokoe.icns ] && cp icon/Spokoe.icns "$APP/Contents/Resources/Spokoe.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Spokoe</string>
  <key>CFBundleDisplayName</key><string>Spokoe</string>
  <!-- De bundle-ID van de oude naam: daaraan hangen de bewaarde gegevens van de pagina. -->
  <key>CFBundleIdentifier</key><string>nl.timvanbergen.spotimfy</string>
  <key>CFBundleExecutable</key><string>Spokoe</string>
  <key>CFBundleIconFile</key><string>Spokoe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.music</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" 2>/dev/null || true
echo "Gebouwd: $APP"
