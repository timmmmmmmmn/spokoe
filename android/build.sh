#!/bin/sh
# Bouwt de Rust-kern voor Android en daarna de APK (app/build/outputs/apk/release/app-release.apk).
set -e
cd "$(dirname "$0")"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/29.0.14206865}"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
(cd core && cargo ndk -t arm64-v8a --platform 26 -o ../app/src/main/jniLibs build --release)
./gradlew assembleRelease --console=plain -q
ls -la app/build/outputs/apk/release/*.apk
