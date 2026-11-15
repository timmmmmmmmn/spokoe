# Spokoe

Een eigen, snelle Spotify-speler voor Mac, Windows en Android (Spotify Premium nodig). Site: https://spokoe.timvanbergen.nl
De kern is Rust ([librespot](https://github.com/librespot-org/librespot)): Spokoe speelt zelf af
en is een Spotify Connect-apparaat. De interface is één gedeelde pagina (`ui/`).

**Wat het anders doet dan de officiële app**
- Mixen buiten playlists: Spotify's eigen radio, gefilterd en gerangschikt op jouw smaak
- Geluid: 10-bands equalizer, echte crossfade, balans, podcastsnelheid zonder hogere stem,
  uitvoerapparaat kiezen, bit-perfect, signaalpad
- Eigen wachtrij (slepen, bewaren, delen), slimme shuffle, Gemaakt voor jou, slimme playlists
- Mappen, playlists bewerken/samenvoegen/importeren/exporteren, duplicaten opruimen
- Songteksten die meelopen, Nu speelt, minispeler, eiland, ⌘K-opdrachtbalk, vinyl-thema's

## Bouwen
- **Mac:** `./install.sh` (zet Spokoe.app in /Applications)
- **Android:** `android/build.sh` (Rust-kern via cargo-ndk, daarna de APK)
- **Windows:** `cd windows && cargo build --release` (op Windows; WebView2, Mica, mediapaneel)
- **Site:** `cd site && npx wrangler deploy` (spokoe.timvanbergen.nl)

Releases: een tag `v*` maakt een Mac-zip en een Windows-zip, een push naar `main` een Android-APK. Beide apps
werken zichzelf bij vanaf de releases in deze repo.

Spokoe is een privéproject en niet verbonden aan Spotify.
