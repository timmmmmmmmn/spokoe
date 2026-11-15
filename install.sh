#!/bin/sh
# Bouwt Spotimfy en zet hem in /Programma's (/Applications).
set -e
cd "$(dirname "$0")"
./bundle.sh
pkill -x Spotimfy 2>/dev/null || true
rm -rf /Applications/Spotimfy.app
cp -R target/Spotimfy.app /Applications/
touch /Applications/Spotimfy.app
echo "Geïnstalleerd: /Applications/Spotimfy.app"
