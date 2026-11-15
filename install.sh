#!/bin/sh
# Bouwt Draai en zet hem in /Programma's (/Applications).
set -e
cd "$(dirname "$0")"
./bundle.sh
pkill -x Draai 2>/dev/null || true
rm -rf /Applications/Draai.app
cp -R target/Draai.app /Applications/
touch /Applications/Draai.app
echo "Geïnstalleerd: /Applications/Draai.app"
