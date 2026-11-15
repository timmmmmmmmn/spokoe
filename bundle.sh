#!/bin/sh
# Bouwt target/Draai.app.
set -e
cd "$(dirname "$0")"
cargo build --release
APP=target/Draai.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/release/draai "$APP/Contents/MacOS/Draai"
[ -f icon/Draai.icns ] && cp icon/Draai.icns "$APP/Contents/Resources/Draai.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Draai</string>
  <key>CFBundleDisplayName</key><string>Draai</string>
  <key>CFBundleIdentifier</key><string>nl.timvanbergen.draai</string>
  <key>CFBundleExecutable</key><string>Draai</string>
  <key>CFBundleIconFile</key><string>Draai</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
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
