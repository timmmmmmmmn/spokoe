// spokoe.timvanbergen.nl: de pagina (public/) en /download/{mac,windows,android}. Die sturen door
// naar vaste GitHub-links (geen API nodig): Mac en Windows uit de nieuwste release, Android uit
// de release "android-latest", die de workflow bij elke nieuwe APK bijwerkt.

const BASE = 'https://github.com/timmmmmmmmn/spokoe/releases';
const DOWNLOADS = {
  mac: `${BASE}/latest/download/Spokoe.zip`,
  windows: `${BASE}/latest/download/Spokoe-windows.zip`,
  android: `${BASE}/download/android-latest/Spokoe.apk`,
};

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/download\/(mac|windows|android)\/?$/);
    if (m) return Response.redirect(DOWNLOADS[m[1]], 302);
    return env.ASSETS.fetch(req);
  },
};
