#!/bin/sh
# Bouwt target/Spotimfy.app.
set -e
cd "$(dirname "$0")"
cargo build --release
APP=target/Spotimfy.app
VERSION=$(grep -m1 "^version" Cargo.toml | cut -d\" -f2)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/spotimfy "$APP/Contents/MacOS/Spotimfy"
[ -f icon/Spotimfy.icns ] && cp icon/Spotimfy.icns "$APP/Contents/Resources/Spotimfy.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Spotimfy</string>
  <key>CFBundleDisplayName</key><string>Spotimfy</string>
  <key>CFBundleIdentifier</key><string>nl.timvanbergen.spotimfy</string>
  <key>CFBundleExecutable</key><string>Spotimfy</string>
  <key>CFBundleIconFile</key><string>Spotimfy</string>
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
