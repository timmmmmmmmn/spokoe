// spokoe.timvanbergen.nl: de pagina (public/) en /download/{mac,windows,android}, dat altijd
// doorstuurt naar de nieuwste release op GitHub.

const RELEASES = 'https://api.github.com/repos/timmmmmmmmn/spokoe/releases?per_page=30';
const KIND = {
  mac: n => n.endsWith('.zip') && !n.includes('windows'),
  windows: n => n.endsWith('windows.zip'),
  android: n => n.endsWith('.apk'),
};

async function latest(kind, ctx) {
  // Tien minuten onthouden, zodat GitHub niet bij elke klik wordt gevraagd.
  const cache = caches.default;
  const key = new Request('https://spokoe.timvanbergen.nl/__releases');
  let res = await cache.match(key);
  if (!res) {
    const gh = await fetch(RELEASES, { headers: { 'User-Agent': 'spokoe-site', Accept: 'application/vnd.github+json' } });
    if (!gh.ok) return null;
    res = new Response(await gh.text(), { headers: { 'Cache-Control': 'max-age=600', 'Content-Type': 'application/json' } });
    ctx.waitUntil(cache.put(key, res.clone()));
  }
  for (const r of await res.json()) {
    const a = (r.assets || []).find(a => KIND[kind](a.name));
    if (a) return a.browser_download_url;
  }
  return null;
}

export default {
  async fetch(req, env, ctx) {
    const m = new URL(req.url).pathname.match(/^\/download\/(mac|windows|android)\/?$/);
    if (m) {
      const url = await latest(m[1], ctx);
      return Response.redirect(url || 'https://github.com/timmmmmmmmn/spokoe/releases', 302);
    }
    return env.ASSETS.fetch(req);
  },
};
