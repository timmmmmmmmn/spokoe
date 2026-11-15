#!/bin/sh
# Bouwt Spokoe en zet hem in /Programma's (/Applications).
set -e
cd "$(dirname "$0")"
./bundle.sh
pkill -x Spokoe 2>/dev/null || true
# De oude naam opruimen.
pkill -x Spotimfy 2>/dev/null || true
rm -rf /Applications/Spotimfy.app
rm -rf /Applications/Spokoe.app
cp -R target/Spokoe.app /Applications/
touch /Applications/Spokoe.app
echo "Geïnstalleerd: /Applications/Spokoe.app"
