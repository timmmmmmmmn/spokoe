# Spotimfy

Een eigen, snelle Spotify-speler voor de Mac en Android (Spotify Premium nodig).
De kern is Rust ([librespot](https://github.com/librespot-org/librespot)): Spotimfy speelt zelf af
en is een Spotify Connect-apparaat. De interface is één gedeelde pagina (`ui/`).

**Wat het anders doet dan de officiële app**
- Mixen buiten playlists: Spotify's eigen radio, gefilterd en gerangschikt op jouw smaak
- Geluid: 10-bands equalizer, echte crossfade, balans, podcastsnelheid zonder hogere stem,
  uitvoerapparaat kiezen, bit-perfect, signaalpad
- Eigen wachtrij (slepen, bewaren, delen), slimme shuffle, Gemaakt voor jou, slimme playlists
- Mappen, playlists bewerken/samenvoegen/importeren/exporteren, duplicaten opruimen
- Songteksten die meelopen, Nu speelt, minispeler, eiland, ⌘K-opdrachtbalk, vinyl-thema's

## Bouwen
- **Mac:** `./install.sh` (zet Spotimfy.app in /Applications)
- **Android:** `android/build.sh` (Rust-kern via cargo-ndk, daarna de APK)

Releases: een tag `v*` maakt een Mac-zip, een push naar `main` een Android-APK. Beide apps
werken zichzelf bij vanaf de releases in deze repo.

Spotimfy is een privéproject en niet verbonden aan Spotify.
