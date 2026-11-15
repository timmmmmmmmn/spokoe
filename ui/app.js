'use strict';
// Spotimfy: de interface. Afspelen gebeurt in de Rust-kern (post → webkit), bibliotheek en zoeken
// via de Web API (rechtstreeks met fetch, met een token van de kern).

// Fouten in de pagina naar het log van de app.
addEventListener('error', e => window.webkit?.messageHandlers?.spotimfy?.postMessage(JSON.stringify({ cmd: 'log', msg: `${e.message} (regel ${e.lineno})` })));
addEventListener('unhandledrejection', e => window.webkit?.messageHandlers?.spotimfy?.postMessage(JSON.stringify({ cmd: 'log', msg: 'promise: ' + (e.reason?.message || e.reason) })));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const post = (cmd, o = {}) => window.webkit?.messageHandlers?.spotimfy?.postMessage(JSON.stringify({ cmd, ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = ms => {
  if (!(ms >= 0)) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('spotimfy:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spotimfy:' + k, JSON.stringify(v)); } catch {} },
};
const idOf = uri => String(uri || '').split(':').pop();
const icon = (id, cls = '') => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;

// ——— toestand ———
const S = {
  user: null, me: store.get('me', null),
  track: null, playing: false, pos: 0, at: 0, dur: 0,
  shuffle: false, repeat: 0, volume: 0.5,
  local: false, remote: null, device: null,
  liked: new Map(), stopAfter: false, sleep: null,
  ctx: null, ready: false, clientId: '', redirect: '',
};
const position = () => Math.min(S.dur || Infinity, S.pos + (S.playing ? Date.now() - S.at : 0));

// ——— de brug met de kern ———
let rpcId = 0;
const waiting = new Map();
function rpc(cmd, extra = {}) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    post(cmd, { id, ...extra });
    setTimeout(() => waiting.has(id) && (waiting.delete(id), reject(new Error('geen antwoord'))), 120000);
  });
}

window.spotimfy = {
  recv(m) {
    switch (m.type) {
      case 'token': case 'lyrics': case 'meta': case 'audioInfo': {
        const w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        m.error ? w.reject(new Error(m.error)) : w.resolve(m);
        return;
      }
      case 'config': S.clientId = m.clientId || ''; S.redirect = m.redirect; return;
      case 'status': return onStatus(m);
      case 'track': S.asked = null; return onTrack({ uri: m.uri, name: m.name, artists: m.artists || [], album: { name: m.album, images: m.cover ? [{ url: m.cover }] : [] }, duration: m.duration, explicit: m.explicit }, true);
      case 'play':
        S.asked = null;
        S.local = true; S.remote = null; S.playing = m.playing; S.pos = m.position; S.at = m.at;
        return renderPlay();
      case 'position': S.pos = m.position; S.at = m.at; return;
      case 'loading': S.local = true; return;
      case 'stopped': S.local = false; S.playing = false; renderPlay(); return pollRemote(true);
      case 'volume': S.volume = m.volume; return renderVolume();
      case 'shuffle': S.shuffle = m.on; return renderModes();
      case 'repeat': S.repeat = m.track ? 2 : m.context ? 1 : 0; return renderModes();
      case 'unavailable': return toast('Dit nummer is hier niet beschikbaar');
      case 'remote': return onRemote(m.cmd, m.ms);
      case 'reconnected': return onReconnected();
      case 'island': store.set('island', m.on); return;
      case 'toast': return toast(m.text);
      case 'fullscreen': return;
    }
  },
};

function onStatus(m) {
  const login = $('#login');
  if (m.state === 'ready') {
    login.hidden = true;
    S.user = m.user;
    if (typeof m.volume === 'number') { S.volume = m.volume; renderVolume(); }
    if (!S.ready) { S.ready = true; start(); }
  } else if (m.state === 'needs-login') {
    login.hidden = false;
    $('#login-btn').disabled = false;
    $('#login-btn').textContent = 'Inloggen met Spotify';
    $('#login-msg').textContent = m.message ? `Dat lukte niet (${m.message}). Probeer het nog eens.` : 'Log in met je Spotify Premium-account. Je browser opent even; daarna speelt alles hier op je Mac.';
  } else if (m.state === 'connecting') {
    if (!S.ready) {
      login.hidden = false;
      $('#login-btn').disabled = true;
      $('#login-btn').textContent = 'Verbinden…';
    }
  } else if (m.state === 'offline') {
    if (!S.ready) {
      login.hidden = false;
      $('#login-btn').disabled = true;
      $('#login-btn').textContent = 'Wachten op verbinding…';
      $('#login-msg').textContent = 'Spotimfy kan Spotify nu niet bereiken. Zodra je internet het weer doet, gaat het vanzelf verder.';
    } else {
      // Bewaren wat er speelde, om straks verder te gaan.
      if (!S.offline) S.lost = { ctx: S.ctx, track: S.track, pos: Math.round(position()), playing: S.playing && S.local };
      S.offline = true;
      S.playing = false;
      renderPlay();
      if (!S.rebuilding) $('#offline').hidden = false;
    }
  } else if (m.state === 'error') {
    toast(m.message || 'Er ging iets mis');
  }
  if (m.state === 'ready') { S.offline = false; $('#offline').hidden = true; }
}
$('#offline button').onclick = () => { post('reconnect'); toast('Opnieuw verbinden…'); };

/** Weer verbonden: verder waar de muziek was. */
function onReconnected() {
  const l = S.lost;
  S.lost = null;
  if (!l?.playing || !l.track) return;
  if (!S.rebuilding) toast('Weer verbonden');
  if (l.ctx) resumeAt(l.ctx, l.track, l.pos);
  else resumeMix(l.track, l.pos);
}
$('#login-btn').onclick = () => { post('login'); $('#login-btn').disabled = true; $('#login-btn').textContent = 'Kijk in je browser…'; };

// ——— Web API ———
let tok = null, tokExp = 0, tokP = null;
function token(fresh) {
  if (!fresh && tok && Date.now() < tokExp - 30000) return Promise.resolve(tok);
  if (!tokP) tokP = rpc('token').then(r => { tok = r.token; tokExp = r.expires; tokP = null; return tok; }, e => { tokP = null; throw e; });
  return tokP;
}

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, { method = 'GET', body, retry = 2 } = {}) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  const t = await token();
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry > 0) { tok = null; await token(true); return api(path, { method, body, retry: retry - 1 }); }
  if (res.status === 429 && retry > 0) {
    await sleep(Math.min(10, +res.headers.get('Retry-After') || 1) * 1000);
    return api(path, { method, body, retry: retry - 1 });
  }
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new ApiError(res.status, data?.error?.message || data?.error_description || `HTTP ${res.status}`);
  return data;
}

const memo = new Map();
/** GET met geheugen: binnen `ttl` meteen het oude antwoord. */
function get(path, ttl = 300000) {
  const hit = memo.get(path);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = api(path);
  memo.set(path, { t: Date.now(), p });
  p.catch(() => memo.delete(path));
  return p;
}
const soft = p => p.catch(() => null);

/** Alle pagina's van een lijst, per pagina terug via `each`. */
async function pages(path, each, max = 10000) {
  let url = path, all = [];
  while (url && all.length < max) {
    const d = await get(url, 120000);
    const page = d.items ? d : (d.tracks || d.artists || d.albums || d);
    all = all.concat(page.items || []);
    each?.(page.items || [], all);
    url = page.next;
  }
  return all;
}

/** Een playlist-pagina: eerst het nieuwe /items, anders het oude /tracks. */
async function playlistItems(id, each) {
  try { return await pages(`/playlists/${id}/items?limit=50`, each); }
  catch (e) { if (e.status === 404 || e.status === 403 || e.status === 400) return pages(`/playlists/${id}/tracks?limit=50`, each); throw e; }
}

function pic(images, size = 300) {
  if (!images?.length) return '';
  const sorted = [...images].filter(i => i?.url).sort((a, b) => (a.width || 640) - (b.width || 640));
  return (sorted.find(i => (i.width || 640) >= size) || sorted[sorted.length - 1])?.url || '';
}
const img = (images, size, cls = '', name = '') => {
  const u = pic(images, size);
  if (u) return `<img src="${esc(u)}" class="${cls}" loading="lazy" alt="">`;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<div class="ph art ${cls}" style="--h:${h}">${icon('note')}</div>`;
};

/** Een nummer uit de Web API naar een vaste vorm. */
function norm(t, album) {
  if (!t) return null;
  if (t.type === 'episode') {
    return { uri: t.uri, id: t.id, name: t.name, artists: [{ name: t.show?.name || '', id: null }], album: { name: t.show?.name || '', images: t.images || t.show?.images || [] }, duration: t.duration_ms, explicit: t.explicit, playable: true, episode: true };
  }
  return {
    uri: t.uri, id: t.id, name: t.name,
    artists: (t.artists || []).map(a => ({ name: a.name, id: a.id, uri: a.uri })),
    album: album || { name: t.album?.name || '', id: t.album?.id, images: t.album?.images || [] },
    duration: t.duration_ms, explicit: t.explicit, playable: t.is_playable !== false && !t.is_local,
  };
}

/** Playlists op schijf (de laatste 50): openen direct, ook zonder internet. */
const plCache = {
  get: id => store.get('pl:' + id, null),
  set(id, tracks) {
    const slim = tracks.slice(0, 3000).map(t => ({ uri: t.uri, id: t.id, name: t.name, artists: t.artists.map(a => ({ name: a.name, id: a.id })), album: { name: t.album.name, id: t.album.id, images: t.album.images?.slice(0, 1) || [] }, duration: t.duration, explicit: t.explicit || undefined, added: t.added || undefined, playable: t.playable === false ? false : undefined }));
    let index = store.get('plIndex', []).filter(x => x !== id);
    index.unshift(id);
    for (const old of index.slice(50)) { try { localStorage.removeItem('spotimfy:pl:' + old); } catch {} }
    store.set('plIndex', index.slice(0, 50));
    store.set('pl:' + id, slim);
  },
};

const coreLists = new Map();
/** De inhoud van een playlist via de kern (vijf minuten onthouden). */
function corePlaylist(id) {
  const hit = coreLists.get(id);
  if (hit && Date.now() - hit.t < 300000) return hit.p;
  const p = rpc('meta', { kind: 'playlist', arg: id }).then(r => r.data.tracks);
  coreLists.set(id, { t: Date.now(), p });
  p.catch(() => coreLists.delete(id));
  return p;
}

/** Even met de muis op een playlist, album of artiest: alvast ophalen, zodat klikken meteen is. */
let hoverT = null;
document.addEventListener('mouseover', e => {
  const el = e.target.closest?.('[data-go]');
  clearTimeout(hoverT);
  if (!el || !S.ready) return;
  hoverT = setTimeout(() => {
    const [kind, id] = [el.dataset.go.slice(0, el.dataset.go.indexOf(':')), el.dataset.go.slice(el.dataset.go.indexOf(':') + 1)];
    if (kind === 'playlist') {
      soft(get(`/playlists/${id}`, 120000)).then(p => {
        if (!p) return;
        if (p.owner?.id === S.me?.id) soft(get(`/playlists/${id}/items?limit=50`, 120000));
        else soft(corePlaylist(id));
      });
    } else if (kind === 'album') soft(get(`/albums/${id}`, 3600000));
    else if (kind === 'artist') { soft(get(`/artists/${id}`, 3600000)); soft(get(`/artists/${id}/albums?include_groups=album,single&limit=10`, 3600000)); }
  }, 120);
});

const withAdded = (t, x) => t && (x?.added_at ? { ...t, added: Date.parse(x.added_at) } : t);

// ——— afspelen ———
/** Afspelen via de kern. Komt er binnen 6 s niets op gang, dan de verbinding nakijken en het nog één keer proberen. */
function play(o, retried) {
  S.local = true;
  const asked = S.asked = Date.now();
  post('play', o);
  setTimeout(() => {
    if (S.asked !== asked) return;
    S.asked = null;
    if (retried) return toast('Afspelen lukt niet. Kijk je internetverbinding na.');
    post('check');
    setTimeout(() => play(o, true), 1500);
  }, 6000);
}

/** Knoppen: hier op de Mac via de kern, anders via de Web API op het andere apparaat. */
async function ctl(cmd, arg) {
  const here = S.local || !S.remote;
  if (here) {
    if ((cmd === 'toggle' || cmd === 'resume') && S.resumable) return resumeSomething();
    if (cmd === 'toggle' && !S.track) return;
    if (cmd === 'toggle') { S.pos = position(); S.at = Date.now(); S.playing = !S.playing; renderPlay(); }
    if (cmd === 'seek') { S.pos = arg; S.at = Date.now(); }
    post(cmd, cmd === 'seek' ? { ms: arg } : cmd === 'volume' ? { v: arg } : cmd === 'shuffle' ? { on: arg } : cmd === 'repeat' ? { context: arg >= 1, track: arg === 2 } : {});
    return;
  }
  try {
    const map = {
      toggle: S.playing ? ['PUT', '/me/player/pause'] : ['PUT', '/me/player/play'],
      pause: ['PUT', '/me/player/pause'], resume: ['PUT', '/me/player/play'],
      next: ['POST', '/me/player/next'], prev: ['POST', '/me/player/previous'],
      seek: ['PUT', `/me/player/seek?position_ms=${Math.round(arg)}`],
      volume: ['PUT', `/me/player/volume?volume_percent=${Math.round(arg * 100)}`],
      shuffle: ['PUT', `/me/player/shuffle?state=${!!arg}`],
      repeat: ['PUT', `/me/player/repeat?state=${['off', 'context', 'track'][arg]}`],
    }[cmd];
    if (!map) return;
    if (cmd === 'toggle') { S.pos = position(); S.at = Date.now(); S.playing = !S.playing; renderPlay(); }
    await api(map[1], { method: map[0] });
    setTimeout(() => pollRemote(true), 350);
  } catch (e) { toast(e.message); }
}

function onRemote(cmd, ms) {
  const acts = {
    toggle: () => ctl('toggle'), pause: () => ctl('pause'), resume: () => ctl('resume'),
    next: () => ctl('next'), prev: () => ctl('prev'), seek: () => ctl('seek', ms),
    volup: () => setVolume(S.volume + 0.08), voldown: () => setVolume(S.volume - 0.08),
    shuffle: () => ctl('shuffle', !S.shuffle), repeat: () => ctl('repeat', (S.repeat + 1) % 3),
    like: () => S.track && toggleLike(S.track),
    search: () => openPalette(), home: () => go('home'), library: () => go('library'), stats: () => go('stats'),
    settings: () => go('settings'), lyrics: () => togglePanel('lyrics'), queue: () => togglePanel('queue'),
    back: () => back(), forward: () => forward(),
    stopafter: () => { S.stopAfter = !S.stopAfter; toast(S.stopAfter ? 'Stopt na dit nummer' : 'Speelt gewoon door'); },
    sleep: () => sleepMenu($('#b-sleep')),
    mini: () => toggleMini(),
    find: () => { const f = $('#c-filter') || $('#lib-filter') || $('#s-in'); f ? (f.focus(), f.select()) : openPalette(); },
    nowplaying: () => $('#lyrics-full').hidden ? openLyricsFull() : ($('#lyrics-full').hidden = true),
  };
  acts[cmd]?.();
}

function setVolume(v) {
  S.volume = Math.max(0, Math.min(1, v));
  renderVolume();
  clearTimeout(setVolume.t);
  setVolume.t = setTimeout(() => ctl('volume', S.volume), S.local || !S.remote ? 0 : 200);
}

let lastTrackUri = null;
function onTrack(t, local) {
  if (local) S.local = true;
  const changed = t.uri !== lastTrackUri;
  lastTrackUri = t.uri;
  S.track = t;
  S.dur = t.duration || 0;
  if (changed) {
    S.pos = 0; S.at = Date.now();
    if (local && S.stopAfter) { S.stopAfter = false; post('pause'); post('seek', { ms: 0 }); toast('Gestopt na het vorige nummer'); }
    if (local) remember(t);
    if (local && S.mix) setTimeout(mixRefill, 1500);
    checkLiked([t]);
    lyricsFor(t);
    if (S.panel === 'queue') renderQueue();
    // Volledige gegevens (album-id, artiest-id's) via de Web API.
    if (local && t.uri.startsWith('spotify:track:')) {
      soft(get(`/tracks/${idOf(t.uri)}`, 3600000)).then(full => {
        // Alleen de id's van album en artiesten overnemen; naam en hoes van wat echt speelt blijven.
        if (!full || S.track?.uri !== t.uri) return;
        const n = norm(full);
        S.track = { ...t, artists: t.artists.map((a, i) => ({ ...a, id: a.id || n.artists.find(x => x.name === a.name)?.id || n.artists[i]?.id })), album: { ...t.album, id: n.album.id, images: t.album.images.length ? t.album.images : n.album.images } };
        renderTrack();
      });
    }
  }
  renderTrack();
  markNow();
}

// ——— spelerbalk ———
function renderTrack() {
  const t = S.track;
  $('#np-cover').src = t ? pic(t.album.images, 128) : '';
  if (!t) $('#np-cover').removeAttribute('src');
  $('#np-title').textContent = t?.name || '';
  $('#np-title').dataset.go = t?.album?.id ? 'album:' + t.album.id : '';
  $('#np-artist').innerHTML = t ? t.artists.map(a => a.id ? `<a data-go="artist:${esc(a.id)}">${esc(a.name)}</a>` : esc(a.name)).join(', ') + (S.remote && !S.local && S.device ? ` · <span style="color:var(--accent)">${esc(S.device)}</span>` : '') : '';
  $('#np-like').hidden = !t;
  renderLike();
  $('#t-dur').textContent = fmt(S.dur);
  document.title = t ? `${t.name} · ${t.artists.map(a => a.name).join(', ')}` : 'Spotimfy';
  if (t) {
    const big = pic(t.album.images, 640);
    $('.lf-bg').style.backgroundImage = `url("${big}")`;
    $('.lf-cover').src = big;
    $('.lf-title').textContent = t.name;
    $('.lf-artist').textContent = t.artists.map(a => a.name).join(', ');
    $('#lf-dur').textContent = fmt(S.dur);
  }
}
function renderPlay() {
  const b = $('#b-play');
  b.innerHTML = icon(S.playing ? 'pause' : 'play');
  b.classList.toggle('paused', !S.playing);
  b.title = S.playing ? 'Pauzeer (spatie)' : 'Speel af (spatie)';
  $('#lf-play').innerHTML = icon(S.playing ? 'pause' : 'play');
  $('#lf-play').classList.toggle('paused', !S.playing);
  $('#bar').classList.toggle('remote', !!S.remote && !S.local);
  const bp = $('.big-play[data-ctx]');
  if (bp) updateBigPlay(bp);
  markNow();
}
function renderModes() {
  $('#b-shuffle').classList.toggle('on', S.shuffle);
  const r = $('#b-repeat');
  r.classList.toggle('on', S.repeat > 0);
  r.innerHTML = icon('repeat') + (S.repeat === 2 ? '<b style="position:absolute;font-size:8px;top:7px;right:5px">1</b>' : '');
}
function renderVolume() {
  $('#vol').classList.toggle('fixed', store.get('bitperfect', false));
  $('#vol').title = store.get('bitperfect', false) ? 'Bit-perfect: volume op je versterker of DAC' : '';
  $('#vol .fill').style.width = S.volume * 100 + '%';
  $('#vol .knob').style.left = S.volume * 100 + '%';
}
function renderLike() {
  const on = S.track && S.liked.get(S.track.uri);
  const b = $('#np-like');
  b.classList.toggle('on', !!on);
  b.innerHTML = icon(on ? 'heart-on' : 'heart');
}

function range(el, onMove, onDone) {
  el.addEventListener('mousedown', e => {
    e.preventDefault();
    el.classList.add('drag');
    const r = el.getBoundingClientRect();
    const f = ev => Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    onMove(f(e));
    const mm = ev => onMove(f(ev));
    const mu = ev => { el.classList.remove('drag'); removeEventListener('mousemove', mm); removeEventListener('mouseup', mu); onDone(f(ev)); };
    addEventListener('mousemove', mm);
    addEventListener('mouseup', mu);
  });
}
let seeking = null;
$('#seek-bar').addEventListener('mousemove', e => {
  const r = e.currentTarget.getBoundingClientRect();
  const tip = $('#seek-tip');
  tip.textContent = fmt(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.dur);
  tip.style.left = e.clientX - r.left + 'px';
  tip.hidden = !S.dur;
});
$('#seek-bar').addEventListener('mouseleave', () => $('#seek-tip').hidden = true);
range($('#seek-bar'), f => { seeking = f * S.dur; tick(); }, f => { const ms = f * S.dur; seeking = null; ctl('seek', ms); S.pos = ms; S.at = Date.now(); });
range($('#lf-seek-bar'), f => { seeking = f * S.dur; tick(); }, f => { const ms = f * S.dur; seeking = null; ctl('seek', ms); S.pos = ms; S.at = Date.now(); });
range($('#vol'), f => { S.volume = f; renderVolume(); }, f => setVolume(f));
$('#vol').addEventListener('wheel', e => { e.preventDefault(); setVolume(S.volume - e.deltaY / 800); }, { passive: false });

$('#b-play').onclick = () => S.track ? ctl('toggle') : resumeSomething();
$('#b-next').onclick = () => ctl('next');
$('#b-prev').onclick = () => position() > 3000 && (S.local || !S.remote) ? ctl('seek', 0) : ctl('prev');
$('#b-shuffle').onclick = () => ctl('shuffle', !S.shuffle);
$('#b-repeat').onclick = () => ctl('repeat', (S.repeat + 1) % 3);
$('#np-like').onclick = () => S.track && toggleLike(S.track);
$('#b-lyrics').onclick = () => togglePanel('lyrics');
$('#b-queue').onclick = () => togglePanel('queue');
$('#b-devices').onclick = e => devicesMenu(e.currentTarget);
$('#b-sleep').onclick = e => sleepMenu(e.currentTarget);
$('#np-cover').onclick = () => document.body.classList.contains('mini') ? toggleMini() : openLyricsFull();
$('#b-mini').onclick = () => toggleMini();
$('#b-big').onclick = () => toggleMini();
function toggleMini() {
  const on = !document.body.classList.contains('mini');
  closeOverlays();
  $('#lyrics-full').hidden = true;
  // Eerst het venster laten krimpen, dan pas de indeling: geen gepiep van een te kleine pagina.
  if (on) { post('mini', { on }); setTimeout(() => document.body.classList.add('mini'), 60); }
  else { document.body.classList.remove('mini'); post('mini', { on }); }
}
$('#lf-play').onclick = () => ctl('toggle');
$('#lf-next').onclick = () => ctl('next');
$('#lf-prev').onclick = () => $('#b-prev').onclick();

/** Niets geladen en op ▶︎ gedrukt: verder waar je was, of je favorieten. */
async function resumeSomething() {
  S.resumable = false;
  const last = store.get('last', null);
  if (last?.mix) resumeMix(last.track, last.position || 0);
  else if (last?.context) resumeAt(last.context, last.track || { uri: last.uri, name: '', artists: [] }, last.position || 0);
  else play({ context: `spotify:user:${S.user}:collection` });
}

/** Een context weer starten bij een bepaald nummer: de plek zoeken (de ID kan een andere versie zijn). */
async function resumeAt(context, track, position = 0) {
  S.ctx = context;
  let list = null;
  const [, kind, id] = context.split(':');
  try {
    if (kind === 'playlist') list = await corePlaylist(id);
    else if (kind === 'album') list = (await get(`/albums/${id}`)).tracks.items.map(t => norm(t));
  } catch {}
  const index = list ? list.findIndex(t => sameSong(t, track)) : -1;
  if (index >= 0) return play({ context, index, position });
  // Niet (meer) in die lijst: dan dit nummer, en daarna een mix die erbij past.
  S.ctx = null;
  resumeMix(track, position);
}

/** Verder met de mix (na een herstart of herverbinding), of een nieuwe mix vanaf dit nummer. */
function resumeMix(track, position = 0) {
  const m = store.get('mix', null);
  const at = m ? m.list.findIndex(t => sameSong(t, track)) : -1;
  if (at >= 0) {
    S.mix = { ...m, refilling: false };
    play({ tracks: m.list.slice(at).map(t => t.uri), position });
  } else {
    playMix(track, { position });
  }
}

function tick() {
  const pos = seeking ?? position();
  const f = S.dur ? Math.min(1, pos / S.dur) : 0;
  $('#seek-bar .fill').style.width = f * 100 + '%';
  $('#seek-bar .knob').style.left = f * 100 + '%';
  const txt = fmt(pos);
  if ($('#t-pos').textContent !== txt) $('#t-pos').textContent = txt;
  if (!$('#lyrics-full').hidden) {
    $('#lf-seek-bar .fill').style.width = f * 100 + '%';
    $('#lf-seek-bar .knob').style.left = f * 100 + '%';
    $('#lf-pos').textContent = fmt(pos);
  }
  lyricsTick(pos);
  sleepTick();
}


// Luistertijd bijhouden (voor de statistieken), alleen wat hier speelt.
setInterval(() => {
  if (!S.playing || !S.local || !S.track) return;
  const day = new Date().toISOString().slice(0, 10);
  const t = store.get('time', {});
  t[day] = (t[day] || 0) + 10;
  store.set('time', t);
  const a = store.get('artistTime', {});
  for (const ar of S.track.artists.slice(0, 1)) a[ar.name] = (a[ar.name] || 0) + 10;
  store.set('artistTime', a);
  if (S.mix && !S.ctx) store.set('last', { mix: true, track: { uri: S.track.uri, name: S.track.name, artists: S.track.artists, album: S.track.album, duration: S.track.duration }, position: Math.round(position()) });
  else if (S.ctx) store.set('last', { context: S.ctx, uri: S.track.uri, track: { uri: S.track.uri, name: S.track.name, artists: S.track.artists, album: S.track.album, duration: S.track.duration }, position: Math.round(position()) });
}, 10000);

function remember(t) {
  const h = store.get('hist', []);
  if (h[0]?.uri === t.uri) return;
  h.unshift({ uri: t.uri, name: t.name, artists: t.artists.map(a => a.name), cover: pic(t.album.images, 64), t: Date.now() });
  store.set('hist', h.slice(0, 3000));
}

// ——— ander apparaat (telefoon, speaker) ———
let pollT = null;
async function pollRemote(now) {
  clearTimeout(pollT);
  if (!S.ready) return;
  if (!S.local) {
    try {
      const p = await api('/me/player');
      if (p?.device && !S.local) {
        const mine = p.device.name === 'Spotimfy op deze Mac';
        if (!mine) {
          S.remote = p; S.device = p.device.name;
          S.playing = p.is_playing; S.pos = p.progress_ms || 0; S.at = Date.now();
          S.shuffle = p.shuffle_state; S.repeat = { off: 0, context: 1, track: 2 }[p.repeat_state] || 0;
          if (typeof p.device.volume_percent === 'number') { S.volume = p.device.volume_percent / 100; renderVolume(); }
          if (p.item) onTrack(norm(p.item), false);
          renderPlay(); renderModes(); renderTrack();
        }
      } else if (!p) { S.remote = null; S.device = null; renderPlay(); }
    } catch {}
  }
  pollT = setTimeout(pollRemote, document.hidden ? 20000 : 5000);
}

async function devicesMenu(anchor) {
  let list = [];
  try { list = (await api('/me/player/devices'))?.devices || []; } catch (e) { return toast(e.message); }
  const items = [{ label: 'Speel af op', header: true }];
  for (const d of list) {
    items.push({ label: d.name === 'Spotimfy op deze Mac' ? 'Deze Mac' : d.name, check: d.is_active, fn: async () => {
      if (d.name === 'Spotimfy op deze Mac') { if (S.track) play({ tracks: [S.track.uri], position: Math.round(position()) }); return; }
      try { await api('/me/player', { method: 'PUT', body: { device_ids: [d.id], play: true } }); S.local = false; setTimeout(() => pollRemote(true), 600); } catch (e) { toast(e.message); }
    } });
  }
  if (list.length === 0) items.push({ label: 'Geen apparaten gevonden', fn: () => {} });
  menuAt(anchor, items, 'up');
}

// ——— vind ik leuk ———
async function checkLiked(tracks) {
  const uris = [...new Set(tracks.filter(t => t?.uri?.startsWith('spotify:track:')).map(t => t.uri))].filter(u => !S.liked.has(u));
  for (let i = 0; i < uris.length; i += 40) {
    const chunk = uris.slice(i, i + 40);
    const r = await soft(api('/me/library/contains?uris=' + chunk.join(',')));
    if (Array.isArray(r)) chunk.forEach((u, j) => S.liked.set(u, r[j]));
  }
  renderLike();
  $$('.tr[data-uri]').forEach(row => { const on = S.liked.get(row.dataset.uri); const b = $('.like', row); if (b) { b.classList.toggle('on', !!on); b.innerHTML = icon(on ? 'heart-on' : 'heart'); } });
}
async function toggleLike(t) {
  const on = !S.liked.get(t.uri);
  S.liked.set(t.uri, on);
  renderLike();
  checkLiked([]);
  try {
    await api('/me/library?uris=' + t.uri, { method: on ? 'PUT' : 'DELETE' }).catch(e => {
      if (e.status === 403 || e.status === 404) return api('/me/tracks?ids=' + idOf(t.uri), { method: on ? 'PUT' : 'DELETE' });
      throw e;
    });
    memo.forEach((v, k) => k.startsWith('/me/tracks') && memo.delete(k));
    toast(on ? 'Toegevoegd aan Nummers die je leuk vindt' : 'Verwijderd uit Nummers die je leuk vindt');
  } catch (e) { S.liked.set(t.uri, !on); renderLike(); toast(e.message); }
}

// ——— navigatie ———
const hist = [], ahead = [];
let cur = null;
function go(where, arg, push = true) {
  if (typeof where === 'string' && where.includes(':') && arg === undefined) [where, arg] = [where.slice(0, where.indexOf(':')), where.slice(where.indexOf(':') + 1)];
  if (push && cur) { cur.scroll = $('#view').scrollTop; hist.push(cur); ahead.length = 0; }
  cur = { where, arg, scroll: 0 };
  store.set('page', { where, arg: typeof arg === 'string' ? arg : null });
  return show(cur);
}
function back() { if (!hist.length) return; cur.scroll = $('#view').scrollTop; ahead.push(cur); cur = hist.pop(); show(cur); }
function forward() { if (!ahead.length) return; cur.scroll = $('#view').scrollTop; hist.push(cur); cur = ahead.pop(); show(cur); }
$('#back').onclick = back;
$('#side-new').onclick = () => newPlaylist();
$('#fwd').onclick = forward;

let renderId = 0;
let restoreScroll = 0;
async function show(entry) {
  const id = ++renderId;
  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;
  $('#top-title').textContent = '';
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.go === entry.where));
  $$('#side-lists button').forEach(b => b.classList.toggle('on', b.dataset.go === `${entry.where}:${entry.arg}`));
  $('#back').disabled = !hist.length;
  $('#fwd').disabled = !ahead.length;
  const el = document.createElement('div');
  view.append(el);
  try {
    await (views[entry.where] || views.home)(el, entry.arg, () => id === renderId);
  } catch (e) {
    if (id === renderId) el.innerHTML = `<div class="empty">Kon dit niet laden: ${esc(e.message)}</div>`;
  }
  if (id === renderId && entry.scroll) view.scrollTop = entry.scroll;
  markNow();
}

$('#view').addEventListener('scroll', () => {
  $('#top').classList.toggle('solid', $('#view').scrollTop > 140);
  const more = $('#view .more-rows');
  if (more && $('#view').scrollTop + $('#view').clientHeight > $('#view').scrollHeight - 900) more.click();
}, { passive: true });

// ——— lijsten met nummers ———
let lists = new Map(), listSeq = 0;
/** Een nummerlijst. ctx = { uri } (afspelen in die context) of null (als losse lijst). */
function trackList(el, tracks, { ctx, album = true, numbers = false, cover = true } = {}) {
  const key = 'l' + (++listSeq);
  const L = { tracks, shown: tracks, ctx, key, sort: null, q: '' };
  lists.set(key, L);
  el.classList.add('tracks');
  if (!album) el.classList.add('no-album');
  el.dataset.list = key;
  const added = () => L.tracks.some(t => t.added);
  const arrow = k => L.sort?.k === k ? (L.sort.dir > 0 ? ' ↑' : ' ↓') : '';
  const head = () => `<div class="tr head"><div class="n">#</div><div data-sort="name">Titel${arrow('name')}</div><div class="al" data-sort="album">Album${arrow('album')}</div>${added() ? `<div class="ad" data-sort="added">Toegevoegd${arrow('added')}</div>` : ''}<div></div><div class="d" data-sort="duration">${arrow('duration')}${icon('clock')}</div></div>`;
  const day = ms => new Date(ms).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  const row = (t, i) => `<div class="tr${t.playable === false ? ' unplayable' : ''}${L.sel === i ? ' sel' : ''}" data-i="${i}" data-uri="${esc(t.uri)}" draggable="true" style="top:${i * ROW}px">
    <div class="n"><span>${numbers && t.number ? t.number : i + 1}</span><i class="eq"><b></b><b></b><b></b></i></div>
    <div class="main">${cover ? img(t.album.images, 64) : ''}<div><div class="t">${t.explicit ? '<span class="E">E</span>' : ''}${esc(t.name)}</div>
    <div class="a">${t.artists.map(a => a.id ? `<a data-go="artist:${esc(a.id)}">${esc(a.name)}</a>` : esc(a.name)).join(', ')}</div></div></div>
    <div class="al">${t.album.id ? `<a data-go="album:${esc(t.album.id)}">${esc(t.album.name)}</a>` : esc(t.album.name)}</div>
    ${added() ? `<div class="ad">${t.added ? day(t.added) : ''}</div>` : ''}
    <button class="icon like${S.liked.get(t.uri) ? ' on' : ''}" data-like>${icon(S.liked.get(t.uri) ? 'heart-on' : 'heart')}</button>
    <div class="d">${fmt(t.duration)}</div></div>`;
  // Alleen de rijen die je ziet bestaan echt: ook 10.000 nummers blijven soepel.
  L.render = () => {
    el.classList.toggle('with-added', added());
    el.innerHTML = head() + `<div class="vbody" style="height:${L.shown.length * ROW}px"></div>`;
    L.body = $('.vbody', el);
    L.painted = null;
    L.paint(true);
  };
  L.paint = force => {
    const view = $('#view');
    if (!L.body?.isConnected) return;
    const top = L.body.getBoundingClientRect().top - view.getBoundingClientRect().top;
    const first = Math.max(0, Math.floor(-top / ROW) - 12);
    const last = Math.min(L.shown.length, Math.ceil((view.clientHeight - top) / ROW) + 12);
    if (!force && L.painted && first === L.painted[0] && last === L.painted[1]) return;
    L.painted = [first, last];
    L.body.innerHTML = L.shown.slice(first, last).map((t, k) => row(t, first + k)).join('');
    markNow();
    checkLiked(L.shown.slice(first, last));
  };
  L.filter = q => {
    if (q !== undefined) L.q = q.trim().toLowerCase();
    let list = !L.q ? L.tracks : L.tracks.filter(t => (t.name + ' ' + t.artists.map(a => a.name).join(' ') + ' ' + t.album.name).toLowerCase().includes(L.q));
    if (L.sort) {
      const { k, dir } = L.sort;
      const val = t => k === 'name' ? t.name.toLowerCase() : k === 'album' ? t.album.name.toLowerCase() : k === 'added' ? t.added || 0 : t.duration || 0;
      list = [...list].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * dir);
    }
    L.shown = list;
    L.sel = null;
    L.render();
  };
  // Op een kolomkop klikken: oplopend, aflopend, weer zoals het was.
  el.addEventListener('click', e => {
    const h = e.target.closest('.head [data-sort]');
    if (!h) return;
    const k = h.dataset.sort;
    L.sort = L.sort?.k !== k ? { k, dir: k === 'added' ? -1 : 1 } : L.sort.dir === (k === 'added' ? -1 : 1) ? { k, dir: -L.sort.dir } : null;
    L.filter();
  });
  L.render();
  return L;
}
const ROW = 54;
// Bij scrollen en groter/kleiner maken: de zichtbare rijen bijwerken.
const paintLists = () => requestAnimationFrame(() => lists.forEach(L => L.body?.isConnected && L.paint()));
$('#view').addEventListener('scroll', paintLists, { passive: true });
$('#view').addEventListener('scroll', () => {
  clearTimeout(paintLists.t);
  paintLists.t = setTimeout(() => cur && store.set('page', { where: cur.where, arg: typeof cur.arg === 'string' ? cur.arg : null, scroll: $('#view').scrollTop }), 400);
}, { passive: true });
addEventListener('resize', paintLists);

function playFromList(L, i) {
  const t = L.shown[i];
  if (!t || t.playable === false) return;
  S.mix = null;
  // Een los nummer uit een zoeklijst: dat nummer, dan een mix die erbij past.
  if (!L.ctx?.uri && L.mix) return playMix(t);
  if (L.ctx?.uri) {
    S.ctx = L.ctx.uri;
    // Op plek in de lijst: de ID die Spotify hier gebruikt kan een andere versie van het nummer zijn.
    const index = L.ctx.uri.includes(':artist:') ? -1 : L.tracks.indexOf(t);
    play(index >= 0 ? { context: L.ctx.uri, index, uri: t.uri } : { context: L.ctx.uri, uri: t.uri });
  }
  else {
    // Losse lijst: alles vanaf hier (en wat ervoor stond achteraan), zoals in de officiële app.
    S.ctx = null;
    const uris = L.shown.filter(x => x.playable !== false).map(x => x.uri);
    const at = uris.indexOf(t.uri);
    play({ tracks: uris.slice(0, 500), index: Math.max(0, at) });
  }
}

const sameSong = (a, b) => a && b && (a.uri === b.uri || (a.name.toLowerCase() === b.name.toLowerCase() && a.artists[0]?.name === b.artists[0]?.name));
function markNow() {
  const t = S.track;
  $$('.tr.now').forEach(r => r.classList.remove('now', 'paused'));
  if (t) {
    for (const el of $$('[data-list]')) {
      const L = lists.get(el.dataset.list);
      if (!L) continue;
      $$('.tr[data-i]', el).forEach(r => { if (sameSong(L.shown[+r.dataset.i], t)) r.classList.add('now'); });
    }
    $$('.tr.now').forEach(r => r.classList.toggle('paused', !S.playing));
  }
  // De playlist die speelt, in de zijbalk.
  $$('#side-lists button').forEach(b => b.classList.toggle('playing', !!S.ctx && b.dataset.card === S.ctx && S.local));
}

let selList = null;
$('#view').addEventListener('click', e => {
  const like = e.target.closest('[data-like]');
  const row = e.target.closest('.tr[data-i]');
  if (like && row) { const L = lists.get(row.closest('[data-list]').dataset.list); toggleLike(L.shown[+row.dataset.i]).then(() => checkLiked([])); return; }
  if (row && !e.target.closest('a')) {
    $$('.tr.sel').forEach(r => r.classList.remove('sel'));
    lists.forEach(x => x.sel = null);
    const L = lists.get(row.closest('[data-list]').dataset.list);
    L.sel = +row.dataset.i;
    selList = L;
    row.classList.add('sel');
  }
});
$('#view').addEventListener('dblclick', e => {
  const row = e.target.closest('.tr[data-i]');
  if (row && !e.target.closest('a,button')) playFromList(lists.get(row.closest('[data-list]').dataset.list), +row.dataset.i);
});
document.addEventListener('click', e => {
  const n = e.target.closest('.tr .n');
  if (n) { const row = n.closest('.tr[data-i]'); if (row) return playFromList(lists.get(row.closest('[data-list]').dataset.list), +row.dataset.i); }
  const p = e.target.closest('[data-play]');
  if (p) { e.stopPropagation(); return playUri(p.dataset.play, p.dataset.track); }
  const g = e.target.closest('[data-go]');
  if (g && g.dataset.go) { e.preventDefault(); closeOverlays(); return go(g.dataset.go); }
}, true);

/** Een album, playlist of artiest afspelen (of een los nummer). */
function playUri(uri, track) {
  S.mix = null;
  if ((uri.startsWith('spotify:track:') || uri.startsWith('spotify:episode:')) && !track) {
    const t = findTrack(uri);
    if (t && uri.startsWith('spotify:track:')) return playMix(t);
    if (uri.startsWith('spotify:track:')) return soft(get(`/tracks/${idOf(uri)}`, 3600000)).then(full => full ? playMix(norm(full)) : play({ tracks: [uri] }));
  }
  if (S.ctx === uri && S.track && S.local && !track) return ctl('toggle');
  if (uri.startsWith('spotify:track:') || uri.startsWith('spotify:episode:')) { S.ctx = null; return play({ tracks: [uri] }); }
  S.ctx = uri;
  play({ context: uri, ...(track ? { uri: track } : {}) });
}

function findTrack(uri) {
  for (const L of lists.values()) { const t = L.tracks.find(x => x.uri === uri); if (t) return t; }
  const h = store.get('hist', []).find(x => x.uri === uri);
  return h ? { uri, name: h.name, artists: h.artists.map(name => ({ name })), album: { name: '', images: [{ url: h.cover }] } } : null;
}

function updateBigPlay(b) {
  const on = S.ctx === b.dataset.ctx && S.playing;
  b.innerHTML = icon(on ? 'pause' : 'play');
  b.classList.toggle('pausing', on);
}

// rechtsklikmenu
document.addEventListener('contextmenu', e => {
  const row = e.target.closest('.tr[data-i], .q[data-uri], .pi[data-uri]');
  const card = e.target.closest('[data-card]');
  if (!row && !card) return;
  e.preventDefault();
  if (row?.dataset.i) {
    const L = lists.get(row.closest('[data-list]').dataset.list);
    trackMenu(e.clientX, e.clientY, L.shown[+row.dataset.i], () => playFromList(L, +row.dataset.i), L);
  } else if (row) {
    const t = row._track;
    if (t) trackMenu(e.clientX, e.clientY, t, () => play({ tracks: [t.uri] }));
  } else {
    const uri = card.dataset.card;
    const kind = uri.split(':')[1];
    const items = [
      { label: 'Afspelen', fn: () => playUri(uri) },
      { label: 'Slim shuffelen', fn: () => smartShuffle(uri) },
      '-',
      { label: 'Kopieer link', fn: () => copyLink(uri) },
    ];
    if (kind === 'artist') items.splice(1, 1);
    menu(e.clientX, e.clientY, items);
  }
});

function trackMenu(x, y, t, playFn, L) {
  const liked = S.liked.get(t.uri);
  const own = L?.ctx?.uri?.startsWith('spotify:playlist:') && (myPlaylists.list || []).find(p => p.uri === L.ctx.uri && p.owner?.id === S.me?.id);
  const items = [
    { label: 'Afspelen', fn: playFn },
    { label: 'Speel hierna', fn: () => queueTrack(t) },
    '-',
    ...(t.album?.id ? [{ label: 'Naar album', fn: () => go('album', t.album.id) }] : []),
    ...t.artists.filter(a => a.id).slice(0, 3).map(a => ({ label: `Naar ${a.name}`, fn: () => go('artist', a.id) })),
    '-',
    { label: liked ? 'Verwijder uit leuk' : 'Vind ik leuk', fn: () => toggleLike(t) },
    { label: 'Aan playlist toevoegen…', fn: () => addToPlaylistMenu(x, y, t) },
    { label: 'Radio op basis van dit nummer', fn: () => radio(t) },
    ...(own ? [{ label: `Verwijder uit ${own.name}`, fn: () => removeFromPlaylist(own, t, L) }] : []),
    '-',
    { label: 'Kopieer link', fn: () => copyLink(t.uri) },
  ];
  menu(x, y, items);
}

async function queueTrack(t) {
  try { await api('/me/player/queue?uri=' + encodeURIComponent(t.uri), { method: 'POST' }); toast(`“${t.name}” speelt hierna`); if (S.panel === 'queue') setTimeout(renderQueue, 300); }
  catch (e) { toast(e.status === 404 ? 'Speel eerst iets af' : e.message); }
}
function radio(t) {
  toast('Radio wordt gemaakt…');
  playMix(t, { label: `Radio: ${t.name}` });
}
function copyLink(uri) {
  const [, kind, id] = uri.split(':');
  post('copy', { text: `https://open.spotify.com/${kind}/${id}` });
  toast('Link gekopieerd');
}
async function addToPlaylistMenu(x, y, t) {
  const mine = (await myPlaylists()).filter(p => p.owner?.id === S.me?.id || p.collaborative);
  menu(x, y, [{ label: 'Toevoegen aan', header: true }, { label: 'Nieuwe playlist…', fn: () => newPlaylist([t.uri]) }, '-', ...mine.slice(0, 40).map(p => ({ label: p.name, fn: async () => {
    try {
      await addToPlaylist(p, [t.uri]);
      toast(`Toegevoegd aan ${p.name}`);
    } catch (e) { toast(e.message); }
  } }))]);
}

async function addToPlaylist(p, uris) {
  await api(`/playlists/${p.id}/items`, { method: 'POST', body: { uris } })
    .catch(e => e.status === 404 || e.status === 403 ? api(`/playlists/${p.id}/tracks`, { method: 'POST', body: { uris } }) : Promise.reject(e));
  memo.forEach((v, k) => k.includes(p.id) && memo.delete(k));
}
async function removeFromPlaylist(p, t, L) {
  try {
    await api(`/playlists/${p.id}/items`, { method: 'DELETE', body: { items: [{ uri: t.uri }] } })
      .catch(e => e.status === 404 || e.status === 403 ? api(`/playlists/${p.id}/tracks`, { method: 'DELETE', body: { tracks: [{ uri: t.uri }] } }) : Promise.reject(e));
    memo.forEach((v, k) => k.includes(p.id) && memo.delete(k));
    L.tracks = L.tracks.filter(x => x.uri !== t.uri);
    L.filter();
    toast(`Verwijderd uit ${p.name}`);
  } catch (e) { toast(e.message); }
}

/** Een klein venstertje met één tekstveld (prompt() werkt niet in de app). */
function ask(title, placeholder = '', value = '') {
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.id = 'ask';
    box.innerHTML = `<form class="ask-box"><h3>${esc(title)}</h3><input placeholder="${esc(placeholder)}" value="${esc(value)}" spellcheck="false"><div class="ask-btns"><button type="button" class="ghost">Annuleer</button><button class="primary">OK</button></div></form>`;
    document.body.append(box);
    const input = $('input', box);
    input.focus();
    input.select();
    const done = v => { box.remove(); resolve(v); };
    $('form', box).onsubmit = e => { e.preventDefault(); done(input.value.trim() || null); };
    $('.ghost', box).onclick = () => done(null);
    input.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
  });
}
async function newPlaylist(uris = []) {
  const name = await ask('Nieuwe playlist', 'Naam');
  if (!name) return;
  try {
    const p = await api('/me/playlists', { method: 'POST', body: { name, public: false } })
      .catch(e => e.status === 404 || e.status === 403 ? api(`/users/${S.me.id}/playlists`, { method: 'POST', body: { name, public: false } }) : Promise.reject(e));
    if (uris.length) await addToPlaylist(p, uris);
    renderSide(await myPlaylists(true));
    go('playlist', p.id);
  } catch (e) { toast(e.message); }
}

// ——— menu en melding ———
function menu(x, y, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.insertAdjacentHTML('beforeend', '<hr>'); continue; }
    if (it.header) { m.insertAdjacentHTML('beforeend', `<div class="label">${esc(it.label)}</div>`); continue; }
    const b = document.createElement('button');
    b.innerHTML = esc(it.label) + (it.check ? '<span class="chk">✓</span>' : '');
    b.onclick = e => { e.stopPropagation(); m.hidden = true; it.fn(); };
    m.append(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function menuAt(anchor, items, dir) {
  const r = anchor.getBoundingClientRect();
  menu(r.left, r.top, items);
  const m = $('#menu'), mr = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.right - mr.width, innerWidth - mr.width - 8)) + 'px';
  m.style.top = (dir === 'up' ? r.top - mr.height - 6 : r.bottom + 6) + 'px';
}
document.addEventListener('mousedown', e => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.hidden = true, 2600);
}

// ——— zijbalk ———
async function myPlaylists(fresh) {
  if (!fresh && myPlaylists.list) return myPlaylists.list;
  const list = await pages('/me/playlists?limit=50');
  myPlaylists.list = list.filter(Boolean);
  store.set('playlists', myPlaylists.list.map(p => ({ id: p.id, uri: p.uri, name: p.name, images: (p.images || []).slice(-1), owner: { id: p.owner?.id, display_name: p.owner?.display_name }, collaborative: p.collaborative })));
  return myPlaylists.list;
}
function renderSide(list) {
  $('#side-lists').innerHTML =
    `<button data-go="liked:" data-card="spotify:user:${esc(S.user)}:collection"><div class="ph liked-ph">${icon('heart-on')}</div><span>Nummers die je leuk vindt</span></button>` +
    list.map(p => `<button data-go="playlist:${esc(p.id)}" data-card="${esc(p.uri)}" title="${esc(p.name)}">${img(p.images, 64, '', p.name)}<span>${esc(p.name)}</span></button>`).join('');
}

let dragged = null;
document.addEventListener('dragstart', e => {
  const row = e.target.closest?.('.tr[data-i]');
  if (!row) return;
  const L = lists.get(row.closest('[data-list]').dataset.list);
  dragged = L.shown[+row.dataset.i];
  e.dataTransfer.setData('text/plain', dragged.uri);
  e.dataTransfer.effectAllowed = 'copy';
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = dragged.name;
  document.body.append(ghost);
  e.dataTransfer.setDragImage(ghost, 10, 14);
  setTimeout(() => ghost.remove());
  document.body.classList.add('dragging');
});
document.addEventListener('dragend', () => { dragged = null; document.body.classList.remove('dragging'); $$('.drop').forEach(b => b.classList.remove('drop')); });
$('#side-lists').addEventListener('dragover', e => {
  const b = e.target.closest('button');
  if (!dragged || !b || !canDrop(b)) return;
  e.preventDefault();
  $$('.drop').forEach(x => x !== b && x.classList.remove('drop'));
  b.classList.add('drop');
});
$('#side-lists').addEventListener('dragleave', e => e.target.closest('button')?.classList.remove('drop'));
$('#side-lists').addEventListener('drop', async e => {
  const b = e.target.closest('button');
  if (!dragged || !b) return;
  e.preventDefault();
  b.classList.remove('drop');
  const t = dragged;
  if (b.dataset.go === 'liked:') { if (!S.liked.get(t.uri)) toggleLike(t); return; }
  const p = (myPlaylists.list || []).find(x => x.uri === b.dataset.card);
  try { await addToPlaylist(p, [t.uri]); toast(`Toegevoegd aan ${p.name}`); } catch (err) { toast(err.message); }
});
function canDrop(b) {
  if (b.dataset.go === 'liked:') return true;
  const p = (myPlaylists.list || []).find(x => x.uri === b.dataset.card);
  return p && (p.owner?.id === S.me?.id || p.collaborative);
}

// ——— de pagina's ———
const card = (o, round) => `<div class="card${round ? ' round' : ''}" data-go="${esc(o.go)}" data-card="${esc(o.uri)}">
  ${img(o.images, 300, 'cover', o.name)}
  ${o.uri && !o.noPlay ? `<button class="play" data-play="${esc(o.uri)}" title="Afspelen">${icon('play')}</button>` : ''}
  <div class="t">${esc(o.name)}</div><div class="s">${esc(o.sub || '')}</div></div>`;
const albumCard = a => card({ go: 'album:' + a.id, uri: a.uri, images: a.images, name: a.name, sub: `${(a.release_date || '').slice(0, 4)} · ${(a.artists || []).map(x => x.name).join(', ')}` });
const playlistCard = p => card({ go: 'playlist:' + p.id, uri: p.uri, images: p.images, name: p.name, sub: p.owner?.display_name ? `Van ${p.owner.display_name}` : '' });
const artistCard = a => card({ go: 'artist:' + a.id, uri: a.uri, images: a.images, name: a.name, sub: 'Artiest' }, true);

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? 'Goedenacht' : h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
}

const views = {
  async home(el, _, alive) {
    const name = S.me?.display_name?.split(' ')[0];
    el.innerHTML = `<h1 class="page">${greeting()}${name ? ', ' + esc(name) : ''}</h1>
      <div class="quick" id="h-quick"></div>
      <section id="h-recent"></section><section id="h-top"></section><section id="h-lists"></section><section id="h-albums"></section>`;
    $('#top-title').textContent = 'Home';
    const playlists = myPlaylists.list || store.get('playlists', []);
    const tiles = list => { $('#h-quick', el).innerHTML = list.slice(0, 8).map(o => `<div class="tile" data-go="${esc(o.go)}" data-card="${esc(o.uri)}">${o.go === 'liked:' ? `<div class="ph liked-ph">${icon('heart-on')}</div>` : img(o.images, 64, '', o.name)}<span>${esc(o.name)}</span><button class="play" data-play="${esc(o.uri)}">${icon('play')}</button></div>`).join(''); };
    const fromLists = playlists.slice(0, 8).map(p => ({ go: 'playlist:' + p.id, uri: p.uri, images: p.images, name: p.name }));
    tiles([{ go: 'liked:', uri: `spotify:user:${S.user}:collection`, images: [], name: 'Nummers die je leuk vindt' }, ...fromLists]);
    const fill = ([recent, top, albums]) => {
    if (recent?.items) recent = { items: recent.items.filter(it => it?.track?.album) };
    if (recent?.items?.length) {
      const seen = new Set(), ctxs = [];
      for (const it of recent.items) {
        const c = it.context;
        if (!c || seen.has(c.uri)) continue;
        seen.add(c.uri);
        if (c.type === 'playlist') { const p = playlists.find(p => p.uri === c.uri); if (p) ctxs.push({ go: 'playlist:' + p.id, uri: p.uri, images: p.images, name: p.name }); }
        else if (c.type === 'album') ctxs.push({ go: 'album:' + it.track.album.id, uri: c.uri, images: it.track.album.images, name: it.track.album.name });
        else if (c.type === 'collection') ctxs.push({ go: 'liked:', uri: `spotify:user:${S.user}:collection`, images: [], name: 'Nummers die je leuk vindt' });
      }
      tiles([...ctxs, ...fromLists.filter(f => !seen.has(f.uri))]);
      const tracks = [], ts = new Set();
      for (const it of recent.items) if (!ts.has(it.track.id)) { ts.add(it.track.id); tracks.push(it.track); }
      $('#h-recent', el).innerHTML = `<h2>Onlangs gespeeld</h2><div class="row-scroll">${tracks.slice(0, 16).map(t => card({ go: 'album:' + t.album.id, uri: t.uri, images: t.album.images, name: t.name, sub: t.artists.map(a => a.name).join(', ') })).join('')}</div>`;
    }
    if (top?.items?.length) $('#h-top', el).innerHTML = `<h2>Jouw toppers van deze maand <a class="more" data-go="stats">Alles</a></h2><div class="row-scroll">${top.items.map(artistCard).join('')}</div>`;
    if (playlists.length) $('#h-lists', el).innerHTML = `<h2>Jouw playlists <a class="more" data-go="library">Bibliotheek</a></h2><div class="row-scroll">${playlists.slice(0, 20).map(playlistCard).join('')}</div>`;
    const libAlbums = (albums?.items || []).filter(x => x?.album);
    if (libAlbums.length) $('#h-albums', el).innerHTML = `<h2>Albums uit je bibliotheek</h2><div class="row-scroll">${libAlbums.map(x => albumCard(x.album)).join('')}</div>`;
    };
    // Eerst wat we de vorige keer hadden (meteen), dan vers van Spotify.
    const old = store.get('home', null);
    if (old) fill(old);
    const fresh = await Promise.all([
      soft(get('/me/player/recently-played?limit=50', 60000)),
      soft(get('/me/top/artists?time_range=short_term&limit=12', 3600000)),
      soft(get('/me/albums?limit=20', 600000)),
    ]);
    if (!alive()) return;
    const scroll = $('#view').scrollTop;
    fill(fresh);
    $('#view').scrollTop = scroll;
    // Klein houden: alleen wat de pagina gebruikt.
    const slim = ([r, t, a]) => [
      r && { items: (r.items || []).slice(0, 30).map(it => it?.track && { context: it.context, track: { id: it.track.id, uri: it.track.uri, name: it.track.name, artists: it.track.artists.map(x => ({ name: x.name, id: x.id })), album: { id: it.track.album.id, name: it.track.album.name, images: it.track.album.images.slice(-2) } } }).filter(Boolean) },
      t && { items: t.items.map(x => ({ id: x.id, uri: x.uri, name: x.name, images: x.images.slice(-2) })) },
      a && { items: (a.items || []).filter(x => x?.album).map(x => ({ album: { id: x.album.id, uri: x.album.uri, name: x.album.name, release_date: x.album.release_date, artists: x.album.artists.map(y => ({ name: y.name })), images: x.album.images.slice(-2) } })) },
    ];
    store.set('home', slim(fresh));
  },

  async search(el, q, alive) {
    $('#top-title').textContent = 'Zoeken';
    el.innerHTML = `<div class="search-box"><input id="s-in" placeholder="Wat wil je horen?" value="${esc(q || '')}" spellcheck="false" autocomplete="off"></div>
      <div class="chips" id="s-chips"><button data-t="all" class="on">Alles</button><button data-t="track">Nummers</button><button data-t="artist">Artiesten</button><button data-t="album">Albums</button><button data-t="playlist">Playlists</button></div>
      <div id="s-out"></div>`;
    const input = $('#s-in', el);
    let type = 'all', seq = 0;
    const run = async () => {
      const qv = input.value.trim();
      cur.arg = qv;
      const my = ++seq;
      const out = $('#s-out', el);
      if (!qv) { out.innerHTML = searchHistory(); return; }
      // Meteen: wat je zelf hebt (playlists en nummers uit onthouden lijsten), terwijl Spotify zoekt.
      const local = localSearch(qv);
      if (type === 'all' && local) out.innerHTML = local;
      const types = type === 'all' ? 'track,artist,album,playlist' : type;
      const r = await soft(get(`/search?q=${encodeURIComponent(qv)}&type=${types}&limit=10`, 600000));
      if (my !== seq || !alive()) return;
      if (!r) { out.innerHTML = '<div class="empty">Zoeken lukt nu niet.</div>'; return; }
      const tracks = (r.tracks?.items || []).filter(Boolean).map(t => norm(t));
      const artists = (r.artists?.items || []).filter(Boolean), albums = (r.albums?.items || []).filter(Boolean), pls = (r.playlists?.items || []).filter(Boolean);
      if (type === 'all') {
        const best = artists[0] && artists[0].name.toLowerCase().includes(qv.toLowerCase()) ? { kind: 'Artiest', o: artists[0], round: true, go: 'artist:' + artists[0].id }
          : tracks[0] ? { kind: 'Nummer', o: { ...r.tracks.items[0], images: tracks[0].album.images }, go: 'album:' + tracks[0].album.id, sub: tracks[0].artists.map(a => a.name).join(', ') }
          : artists[0] ? { kind: 'Artiest', o: artists[0], round: true, go: 'artist:' + artists[0].id } : null;
        out.innerHTML = `<div class="search-top">${best ? `<div><h2>Beste resultaat</h2><div class="top-hit${best.round ? ' round' : ''}" data-go="${esc(best.go)}" data-card="${esc(best.o.uri)}">${img(best.o.images, 200)}<div class="t">${esc(best.o.name)}</div><div class="s">${best.kind}${best.sub ? ' · ' + esc(best.sub) : ''}</div><button class="play" data-play="${esc(best.o.uri)}">${icon('play')}</button></div></div>` : '<div></div>'}
          <div><h2>Nummers</h2><div id="s-tracks"></div></div></div>
          ${artists.length ? `<h2>Artiesten</h2><div class="row-scroll">${artists.map(artistCard).join('')}</div>` : ''}
          ${albums.length ? `<h2>Albums</h2><div class="row-scroll">${albums.map(albumCard).join('')}</div>` : ''}
          ${pls.length ? `<h2>Playlists</h2><div class="row-scroll">${pls.map(playlistCard).join('')}</div>` : ''}`;
        trackList($('#s-tracks', out), tracks.slice(0, 5), { album: false }).mix = true;
      } else if (type === 'track') {
        out.innerHTML = '<div id="s-tracks"></div>';
        trackList($('#s-tracks', out), tracks).mix = true;
      } else {
        const list = type === 'artist' ? artists.map(artistCard) : type === 'album' ? albums.map(albumCard) : pls.map(playlistCard);
        out.innerHTML = `<div class="grid">${list.join('') || '<div class="empty">Niets gevonden</div>'}</div>`;
      }
      if (type === 'all' && local) out.insertAdjacentHTML('beforeend', local);
      const sh = store.get('searches', []).filter(s => s !== qv);
      sh.unshift(qv);
      store.set('searches', sh.slice(0, 12));
    };
    let t;
    input.oninput = () => { clearTimeout(t); t = setTimeout(run, 160); };
    $('#s-chips', el).onclick = e => { const b = e.target.closest('button'); if (!b) return; type = b.dataset.t; $$('#s-chips button', el).forEach(x => x.classList.toggle('on', x === b)); run(); };
    $('#s-out', el).addEventListener('click', e => { const s = e.target.closest('[data-q]'); if (s) { input.value = s.dataset.q; run(); } });
    input.focus();
    run();
  },

  async library(el, tab = 'playlists', alive) {
    $('#top-title').textContent = 'Bibliotheek';
    el.innerHTML = `<h1 class="page">Bibliotheek</h1>
      <div class="actions" style="padding-top:0"><div class="seg" id="lib-tabs"><button data-t="playlists">Playlists</button><button data-t="albums">Albums</button><button data-t="artists">Artiesten</button></div>
      <input class="filter" id="lib-filter" placeholder="Filter…"></div><div class="grid" id="lib-grid" style="margin-top:14px"></div>`;
    $$('#lib-tabs button', el).forEach(b => b.classList.toggle('on', b.dataset.t === tab));
    $('#lib-tabs', el).onclick = e => { const b = e.target.closest('button'); if (b) { cur.arg = b.dataset.t; views.library(el, b.dataset.t, alive); } };
    let items = [];
    const draw = () => {
      const q = $('#lib-filter', el).value.toLowerCase();
      const f = items.filter(x => !q || x.name.toLowerCase().includes(q) || (x.sub || '').toLowerCase().includes(q));
      $('#lib-grid', el).innerHTML = f.map(x => x.html).join('') || '<div class="empty">Niets gevonden</div>';
    };
    $('#lib-filter', el).oninput = draw;
    $('#lib-grid', el).innerHTML = Array.from({ length: 12 }, () => '<div class="card"><div class="cover skel"></div></div>').join('');
    if (tab === 'playlists') {
      const list = await myPlaylists();
      items = [{ name: 'Nummers die je leuk vindt', html: card({ go: 'liked:', uri: `spotify:user:${S.user}:collection`, images: [], name: 'Nummers die je leuk vindt', sub: 'Jouw favorieten' }) },
        ...list.map(p => ({ name: p.name, sub: p.owner?.display_name, html: playlistCard(p) }))];
    } else if (tab === 'albums') {
      const list = await pages('/me/albums?limit=50');
      items = list.map(x => ({ name: x.album.name, sub: x.album.artists.map(a => a.name).join(' '), html: albumCard(x.album) }));
    } else {
      const list = await pages('/me/following?type=artist&limit=50');
      items = list.map(a => ({ name: a.name, html: artistCard(a) }));
    }
    if (alive()) draw();
  },

  async playlist(el, id, alive) {
    const cached = (myPlaylists.list || store.get('playlists', [])).find(p => p.id === id);
    const offline = plCache.get(id);
    const p = await get(`/playlists/${id}`, 120000).catch(() => cached || (offline && { id, uri: 'spotify:playlist:' + id, name: 'Playlist', images: [] }));
    if (!alive() || !p) return;
    const L = await collection(el, {
      kind: 'Playlist', title: p.name, images: p.images, uri: p.uri, desc: p.description,
      meta: `<b>${esc(p.owner?.display_name || '')}</b>${p.followers?.total ? ` · ${p.followers.total.toLocaleString('nl-NL')} volgers` : ''}`,
    }, alive);
    if (offline) L.set(offline);
    if (p.owner?.id === S.me?.id) {
      try {
        const all = await playlistItems(id, (_, all) => alive() && all.length > (offline?.length || 0) && L.set(all.map(x => withAdded(norm(x.item || x.track), x)).filter(Boolean)));
        const tracks = all.map(x => withAdded(norm(x.item || x.track), x)).filter(Boolean);
        if (alive()) L.set(tracks);
        plCache.set(id, tracks);
        return;
      } catch {}
    }
    // Van iemand anders: de Web API geeft de inhoud niet meer, de kern wel.
    const tracks = await corePlaylist(id);
    if (alive()) L.set(tracks);
    plCache.set(id, tracks);
  },

  async liked(el, _, alive) {
    const L = await collection(el, { kind: 'Playlist', title: 'Nummers die je leuk vindt', liked: true, uri: `spotify:user:${S.user}:collection`, meta: `<b>${esc(S.me?.display_name || '')}</b>` }, alive);
    const offline = plCache.get('liked');
    if (offline) L.set(offline);
    const all = await pages('/me/tracks?limit=50', (_, all) => alive() && all.length > (offline?.length || 0) && L.set(all.map(x => withAdded(norm(x.track), x)).filter(Boolean)));
    const tracks = all.map(x => withAdded(norm(x.track), x)).filter(Boolean);
    if (alive()) L.set(tracks);
    plCache.set('liked', tracks);
  },

  async album(el, id, alive) {
    const a = await get(`/albums/${id}`, 3600000);
    if (!alive()) return;
    const albumInfo = { name: a.name, id: a.id, images: a.images };
    const L = await collection(el, {
      kind: a.album_type === 'single' ? 'Single' : a.album_type === 'compilation' ? 'Compilatie' : 'Album', title: a.name, images: a.images, uri: a.uri,
      meta: `${a.artists.map(x => `<a data-go="artist:${esc(x.id)}"><b>${esc(x.name)}</b></a>`).join(', ')} · ${(a.release_date || '').slice(0, 4)}`,
      album: false, numbers: true, cover: false,
    }, alive);
    let items = a.tracks.items, next = a.tracks.next;
    const set = () => L.set(items.map(t => ({ ...norm(t, albumInfo), number: t.track_number })));
    set();
    while (next && alive()) { const d = await get(next); items = items.concat(d.items); next = d.next; set(); }
    L.meta(`· ${items.length} nummers · ${fmt(items.reduce((s, t) => s + t.duration_ms, 0))}`);
    const ar = a.artists[0];
    const more = ar && await soft(pages(`/artists/${ar.id}/albums?include_groups=album,single&limit=10`, null, 30));
    const others = (more || []).filter(x => x.id !== a.id && x.name !== a.name);
    if (alive() && others.length) el.insertAdjacentHTML('beforeend', `<h2>Meer van ${esc(ar.name)} <a class="more" data-go="artist:${esc(ar.id)}">Alles</a></h2><div class="row-scroll">${others.map(albumCard).join('')}</div>`);
  },

  async artist(el, id, alive) {
    const [a, top, albums] = await Promise.all([
      get(`/artists/${id}`, 3600000),
      soft(rpc('meta', { kind: 'artistTop', arg: id }).then(r => r.data)),
      soft(pages(`/artists/${id}/albums?include_groups=album,single&limit=10`, null, 60).then(items => ({ items }))),
    ]);
    if (!alive()) return;
    $('#top-title').textContent = a.name;
    el.innerHTML = `<div class="hero artist">${img(a.images, 300)}<div><div class="kind">Artiest</div><h1>${esc(a.name)}</h1>
      <div class="meta">${a.followers?.total ? a.followers.total.toLocaleString('nl-NL') + ' volgers' : ''}${a.genres?.length ? ' · ' + esc(a.genres.slice(0, 3).join(', ')) : ''}</div></div></div>
      <div class="actions"><button class="big-play" data-ctx="${esc(a.uri)}" data-play="${esc(a.uri)}">${icon('play')}</button>
      <button class="pill" id="a-radio">Artiestenradio</button><button class="pill" id="a-follow">Volgen</button></div>
      <section id="a-top"></section><section id="a-albums"></section><section id="a-singles"></section>`;
    tint(el, a.images);
    updateBigPlay($('.big-play', el));
    $('#a-radio', el).onclick = () => { toast('Radio wordt gemaakt…'); playMix({ uri: a.uri, name: a.name, artists: [{ name: a.name, id: a.id }] }); };
    const fb = $('#a-follow', el);
    soft(api(`/me/library/contains?uris=${a.uri}`)).then(r => { if (Array.isArray(r)) { fb.classList.toggle('on', r[0]); fb.textContent = r[0] ? 'Volgend' : 'Volgen'; } });
    fb.onclick = async () => {
      const on = !fb.classList.contains('on');
      try { await api(`/me/library?uris=${a.uri}`, { method: on ? 'PUT' : 'DELETE' }).catch(() => api(`/me/following?type=artist&ids=${a.id}`, { method: on ? 'PUT' : 'DELETE' })); fb.classList.toggle('on', on); fb.textContent = on ? 'Volgend' : 'Volgen'; } catch (e) { toast(e.message); }
    };
    if (top?.length) {
      $('#a-top', el).innerHTML = '<h2>Populair</h2><div></div>';
      trackList($('#a-top div', el), top, { ctx: { uri: a.uri }, album: true });
    }
    const all = albums?.items || [];
    const al = all.filter(x => x.album_type === 'album'), si = all.filter(x => x.album_type !== 'album');
    if (al.length) $('#a-albums', el).innerHTML = `<h2>Albums</h2><div class="row-scroll">${al.map(albumCard).join('')}</div>`;
    if (si.length) $('#a-singles', el).innerHTML = `<h2>Singles en EP's</h2><div class="row-scroll">${si.map(albumCard).join('')}</div>`;
  },

  async stats(el, range = 'short_term', alive) {
    $('#top-title').textContent = 'Statistieken';
    el.innerHTML = `<h1 class="page">Statistieken</h1>
      <div class="seg" id="st-range"><button data-r="short_term">4 weken</button><button data-r="medium_term">6 maanden</button><button data-r="long_term">Altijd</button></div>
      <section id="st-time"></section><section id="st-artists"></section><section id="st-tracks"></section>`;
    $$('#st-range button', el).forEach(b => b.classList.toggle('on', b.dataset.r === range));
    $('#st-range', el).onclick = e => { const b = e.target.closest('button'); if (b) { cur.arg = b.dataset.r; views.stats(el, b.dataset.r, alive); } };
    // Wat Spotimfy zelf heeft bijgehouden.
    const time = store.get('time', {});
    const days = [...Array(7)].map((_, i) => { const d = new Date(Date.now() - (6 - i) * 864e5); return { k: d.toISOString().slice(0, 10), label: d.toLocaleDateString('nl-NL', { weekday: 'long' }) }; });
    const max = Math.max(60, ...days.map(d => time[d.k] || 0));
    const week = days.reduce((s, d) => s + (time[d.k] || 0), 0);
    const at = Object.entries(store.get('artistTime', {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
    $('#st-time', el).innerHTML = `<h2>Luistertijd in Spotimfy <span class="sub" style="font-size:13px;font-weight:500">${Math.round(week / 60)} minuten deze week</span></h2>
      <div class="bars">${days.map(d => `<div><span>${d.label}</span><i style="width:${Math.max(2, (time[d.k] || 0) / max * 100)}%"></i><span>${Math.round((time[d.k] || 0) / 60)}m</span></div>`).join('')}</div>
      ${at.length ? `<p class="sub" style="margin-top:14px">Meest gedraaid: ${at.map(([n, s]) => `<b style="color:var(--ink)">${esc(n)}</b> (${Math.round(s / 60)}m)`).join(', ')}</p>` : ''}`;
    const [ar, tr] = await Promise.all([soft(get(`/me/top/artists?time_range=${range}&limit=20`, 3600000)), soft(get(`/me/top/tracks?time_range=${range}&limit=50`, 3600000))]);
    if (!alive()) return;
    if (ar?.items?.length) {
      $('#st-artists', el).innerHTML = `<h2>Top-artiesten</h2><div class="rank">${ar.items.map(artistCard).join('')}</div>`;
      $$('#st-artists .card', el).forEach((c, i) => c.insertAdjacentHTML('afterbegin', `<span class="no">${i + 1}</span>`));
    }
    if (tr?.items?.length) {
      $('#st-tracks', el).innerHTML = '<h2>Top-nummers <button class="pill" id="st-play" style="margin-left:8px">Speel deze lijst</button></h2><div></div>';
      const tracks = tr.items.map(t => norm(t));
      trackList($('#st-tracks div', el), tracks);
      $('#st-play', el).onclick = () => { S.ctx = null; play({ tracks: tracks.map(t => t.uri) }); };
    }
    if (!ar && !tr) $('#st-artists', el).innerHTML = '<div class="empty">Spotify geeft nu geen toplijsten.</div>';
  },

  async settings(el) {
    $('#top-title').textContent = 'Instellingen';
    const theme = store.get('theme', 'system');
    el.innerHTML = `<h1 class="page">Instellingen</h1><div class="settings">
      <div class="box"><h3>Account</h3><p>Ingelogd als <b style="color:var(--ink)">${esc(S.me?.display_name || S.user || '')}</b>${S.me?.product ? ` (${esc(S.me.product)})` : ''}. Deze Mac heet in Spotify Connect <b style="color:var(--ink)">Spotimfy op deze Mac</b>.</p>
        <div class="field"><button class="ghost" id="set-logout">Uitloggen</button></div></div>
      <div class="box"><h3>Eigen Client ID</h3>
        <p>Voor de bibliotheek, zoeken en statistieken gebruikt Spotimfy de Web API. Met een eigen app in het Spotify-dashboard heb je daar een eigen limiet voor.</p>
        <ol><li>Ga naar <a class="link" style="color:var(--accent)" href="https://developer.spotify.com/dashboard">developer.spotify.com/dashboard</a> en kies <b>Create app</b>.</li>
        <li>Redirect URI: <code>${esc(S.redirect || 'http://127.0.0.1:8888/callback')}</code>, en vink <b>Web API</b> aan.</li>
        <li>Kopieer het <b>Client ID</b> hieronder. De eerste keer opent je browser één keer om toestemming te vragen.</li></ol>
        <div class="field"><input id="set-cid" placeholder="Client ID (leeg = ingebouwd)" value="${esc(S.clientId)}" spellcheck="false"><button class="primary" id="set-save">Opslaan</button></div></div>
      <div class="box"><h3>Uiterlijk</h3><div class="seg" id="set-theme"><button data-t="system">Systeem</button><button data-t="light">Licht</button><button data-t="dark">Donker</button></div></div>
      <div class="box" id="audio-box"><h3>Geluid</h3><div class="empty" style="padding:10px 0">Laden…</div></div>
      <div class="box"><h3>Eiland</h3><p>Bij een nieuw nummer schuift bovenaan je scherm even een pil in met de hoes en de titel, als Spotimfy niet voorop staat.</p>
        <div class="seg" id="set-island"><button data-v="1">Aan</button><button data-v="0">Uit</button></div></div>
      <div class="box"><h3>Sneltoetsen</h3><p>
        <kbd>spatie</kbd> afspelen/pauzeren · <kbd>⌘K</kbd> of <kbd>/</kbd> zoeken · <kbd>⌘→</kbd> <kbd>⌘←</kbd> volgende/vorige · <kbd>⇧→</kbd> <kbd>⇧←</kbd> 10 s verder/terug ·
        <kbd>⌘↑</kbd> <kbd>⌘↓</kbd> volume · <kbd>⌘L</kbd> songtekst · <kbd>⌘J</kbd> wachtrij · <kbd>⌘D</kbd> vind ik leuk · <kbd>⌘S</kbd> shuffle · <kbd>F</kbd> Nu speelt · <kbd>⌥⌘M</kbd> minispeler · sleep nummers naar een playlist in de zijbalk</p></div>
      <div class="box"><h3>Over Spotimfy</h3><p>Een eigen speler voor Spotify Premium, gebouwd in Rust met librespot. Liedjes die je vaker draait worden lokaal bewaard (tot 2 GB), zodat ze meteen beginnen.</p></div>
    </div>`;
    $$('#set-theme button', el).forEach(b => b.classList.toggle('on', b.dataset.t === theme));
    const segPick = (id, key, cur, toVal) => {
      $$(`#${id} button`, el).forEach(b => b.classList.toggle('on', b.dataset.v === String(cur)));
      $('#' + id, el).onclick = e => { const b = e.target.closest('button'); if (!b) return; const v = toVal(b.dataset.v); store.set(key, v); post('setting', { key, value: v }); $$(`#${id} button`, el).forEach(x => x.classList.toggle('on', x === b)); toast('Geldt vanaf de volgende start'); };
    };
    audioSettings($('#audio-box', el));
    const isl = store.get('island', true);
    $$('#set-island button', el).forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === isl));
    $('#set-island', el).onclick = e => { const b = e.target.closest('button'); if (!b) return; const on = b.dataset.v === '1'; store.set('island', on); post('island', { on }); $$('#set-island button', el).forEach(x => x.classList.toggle('on', x === b)); };
    $('#set-theme', el).onclick = e => { const b = e.target.closest('button'); if (!b) return; store.set('theme', b.dataset.t); applyTheme(); $$('#set-theme button', el).forEach(x => x.classList.toggle('on', x === b)); };
    $('#set-save', el).onclick = () => { S.clientId = $('#set-cid', el).value.trim(); post('setClientId', { id: S.clientId }); tok = null; memo.clear(); toast('Opgeslagen'); };
    $('#set-logout', el).onclick = () => { post('logout'); S.ready = false; };
  },
};

// ——— geluid ———
const EQ_BANDS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const EQ_PRESETS = {
  'Vlak': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Meer bas': [5, 4.5, 3.5, 2, 0.5, 0, 0, 0, 0, 0],
  'Minder bas': [-5, -4, -3, -1.5, 0, 0, 0, 0, 0, 0],
  'Stemmen': [-2, -2, -1, 1, 3, 4, 3.5, 2, 0, -1],
  'Helder': [0, 0, 0, 0, 0, 0.5, 1.5, 3, 4, 4.5],
  'V-vorm': [4, 3.5, 2, 0, -1.5, -2, -1, 1, 3, 4],
  'Laptop-speakers': [-6, -4, -1, 1, 2, 2, 2, 2.5, 2, 1],
  'AirPods': [1.5, 1, 0, -1, -1, 0, 1, 1.5, 1, 0],
  'Klassiek': [3, 2.5, 2, 1, -1, -1, 0, 2, 2.5, 3],
  'Elektronisch': [4.5, 4, 1, 0, -2, 1.5, 0.5, 1, 4, 4.5],
  'Akoestisch': [3, 3, 2.5, 1, 1.5, 1.5, 2.5, 3, 2.5, 1.5],
  'Hiphop': [5, 4, 1.5, 3, -1, -1, 1.5, -0.5, 2, 3],
  'Nachtmodus': [-6, -5, -3, -1, 0, 1, 1, 0, -2, -4],
};
let dspState = null;
function dspSend(patch) {
  Object.assign(dspState, patch);
  clearTimeout(dspSend.t);
  dspSend.t = setTimeout(() => post('dsp', { dsp: patch.eq ? { ...patch, eq: dspState.eq } : patch }), 40);
}

/** Het geluid-blok in Instellingen. Gewone dingen bovenaan; de rest onder "Voor audiofielen". */
async function audioSettings(box) {
  const info = await rpc('audioInfo').catch(() => ({ devices: [], cache: 0, dsp: {} }));
  const d = dspState = { eqOn: false, eq: Array(10).fill(0), preamp: 0, balance: 0, fadeMs: 40, crossfade: 0, speed: 1, ...(info.dsp || {}) };
  const bp = store.get('bitperfect', false);
  const rate = store.get('bitrate', null);
  const dev = store.get('device', '');
  const devices = info.devices || [];
  const curDev = devices.find(x => x.name === dev) || devices.find(x => x.default) || {};
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label)}</option>`;
  box.innerHTML = `<h3>Geluid</h3>
    <div class="row-set"><span>Kwaliteit</span><select id="a-rate">${opt('', 'Automatisch (aanbevolen)', rate ?? '')}${opt(320, 'Zeer hoog · 320 kbps', rate)}${opt(160, 'Normaal · 160 kbps', rate)}${opt(96, 'Laag · 96 kbps (bespaart data)', rate)}</select></div>
    <div class="row-set"><span>Crossfade</span><input type="range" id="a-xf" min="0" max="12" step="1" value="${d.crossfade}"><b id="a-xf-v"></b></div>
    <div class="row-set"><span>Balans</span><input type="range" id="a-bal" min="-1" max="1" step="0.05" value="${d.balance}"><b id="a-bal-v"></b></div>
    <div class="row-set"><span>Snelheid podcasts</span><select id="a-speed">${[0.75, 1, 1.25, 1.5, 1.75, 2].map(x => opt(x, x === 1 ? 'Normaal' : `${String(x).replace('.', ',')}×`, d.speed)).join('')}</select></div>
    <div class="eq${d.eqOn ? '' : ' off'}">
      <div class="eq-head"><b>Equalizer</b><label class="switch"><input type="checkbox" id="a-eq-on"${d.eqOn ? ' checked' : ''}><span></span></label>
        <select id="a-eq-preset"><option value="">Voorinstelling…</option>${Object.keys(EQ_PRESETS).map(k => opt(k, k, '')).join('')}</select></div>
      <div class="eq-bands">${EQ_BANDS.map((b, i) => `<div><span class="eq-val" id="a-eqv-${i}"></span><input type="range" orient="vertical" min="-12" max="12" step="0.5" value="${d.eq[i]}" data-band="${i}"><span>${b}</span></div>`).join('')}
        <div class="pre"><span class="eq-val" id="a-prev"></span><input type="range" orient="vertical" min="-12" max="6" step="0.5" value="${d.preamp}" id="a-pre"><span>Pre</span></div></div>
    </div>
    <details class="audiophile"${bp ? ' open' : ''}><summary>Voor audiofielen</summary>
      <div class="row-set"><span>Uitvoer</span><select id="a-dev">${opt('', 'Systeemstandaard', dev)}${devices.map(x => opt(x.name, x.name + (x.native441 ? ' · 44,1 kHz' : x.rate ? ` · ${x.rate / 1000} kHz` : ''), dev)).join('')}</select></div>
      <div class="row-set"><span>Bit-perfect</span><label class="switch"><input type="checkbox" id="a-bp"${bp ? ' checked' : ''}><span></span></label>
        <small>Geen equalizer, normalisatie, volume of andere bewerking: het gedecodeerde signaal gaat onaangeroerd naar je DAC. Regel het volume op je versterker.</small></div>
      <div class="row-set"><span>Normaliseren</span><label class="switch"><input type="checkbox" id="a-norm"${store.get('normalise', true) ? ' checked' : ''}${bp ? ' disabled' : ''}><span></span></label><small>Alle nummers ongeveer even hard.</small></div>
      <div class="row-set"><span>Zachte start</span><input type="range" id="a-fade" min="0" max="300" step="10" value="${d.fadeMs}"><b id="a-fade-v"></b></div>
      <div class="signal"><b>Signaalpad</b><ol>
        <li>Spotify · Ogg Vorbis · ${rate ? rate + ' kbps' : 'automatisch (320 kbps)'}</li>
        <li>Gedecodeerd naar 44,1 kHz · 32-bit float</li>
        <li>${bp ? 'Bit-perfect: geen bewerking' : [d.eqOn ? 'equalizer' : '', store.get('normalise', true) ? 'normalisatie' : '', d.crossfade ? `crossfade ${d.crossfade} s` : '', 'softwarevolume'].filter(Boolean).join(' · ')}</li>
        <li>${esc(curDev.name || 'Systeemstandaard')} · ${curDev.native441 ? '44,1 kHz, zonder omrekenen' : curDev.rate ? `${curDev.rate / 1000} kHz (omgerekend)` : ''}</li></ol></div>
      <div class="row-set"><span>Cache</span><select id="a-cache">${[1, 2, 5, 10, 20].map(g => opt(g, `${g} GB`, store.get('cacheGB', 2))).join('')}</select>
        <button class="ghost" id="a-clear">Leeg cache (${Math.round((info.cache || 0) / 1e6)} MB)</button></div>
      <div class="row-set"><span>Logboek</span><button class="ghost" id="a-log">Open logboek</button></div>
    </details>`;
  const $b = q => $(q, box);
  const label = () => {
    $b('#a-xf-v').textContent = d.crossfade ? `${d.crossfade} s` : 'Uit';
    $b('#a-bal-v').textContent = Math.abs(d.balance) < 0.03 ? 'Midden' : d.balance < 0 ? `L ${Math.round(-d.balance * 100)}%` : `R ${Math.round(d.balance * 100)}%`;
    $b('#a-fade-v').textContent = d.fadeMs ? `${d.fadeMs} ms` : 'Uit';
    EQ_BANDS.forEach((_, i) => $b('#a-eqv-' + i).textContent = (d.eq[i] > 0 ? '+' : '') + d.eq[i]);
    $b('#a-prev').textContent = (d.preamp > 0 ? '+' : '') + d.preamp;
  };
  label();
  const rebuild = msg => { S.rebuilding = true; post('rebuild'); toast(msg || 'Geluid opnieuw instellen…'); setTimeout(() => S.rebuilding = false, 8000); };
  const setting = (key, value) => { store.set(key, value); post('setting', { key, value }); };
  $b('#a-rate').onchange = e => { setting('bitrate', e.target.value ? +e.target.value : null); rebuild(); };
  $b('#a-xf').oninput = e => { dspSend({ crossfade: +e.target.value }); label(); };
  $b('#a-bal').oninput = e => { let v = +e.target.value; if (Math.abs(v) < 0.06) v = 0; dspSend({ balance: v }); label(); };
  $b('#a-speed').onchange = e => dspSend({ speed: +e.target.value });
  $b('#a-fade').oninput = e => { dspSend({ fadeMs: +e.target.value }); label(); };
  $b('#a-eq-on').onchange = e => { dspSend({ eqOn: e.target.checked }); $b('.eq').classList.toggle('off', !e.target.checked); };
  $$('[data-band]', box).forEach(r => r.oninput = () => { d.eq[+r.dataset.band] = +r.value; dspSend({ eq: d.eq }); label(); });
  $b('#a-pre').oninput = e => { dspSend({ preamp: +e.target.value }); label(); };
  $b('#a-eq-preset').onchange = e => {
    const p = EQ_PRESETS[e.target.value];
    if (!p) return;
    d.eq = [...p];
    // Voorversterking omlaag zodat het niet gaat clippen.
    const peak = Math.max(0, ...p);
    dspSend({ eq: d.eq, eqOn: true, preamp: -Math.round(peak * 0.8 * 2) / 2 });
    $b('#a-eq-on').checked = true;
    $b('.eq').classList.remove('off');
    $$('[data-band]', box).forEach(r => r.value = d.eq[+r.dataset.band]);
    $b('#a-pre').value = d.preamp;
    label();
    e.target.value = '';
  };
  $b('#a-dev').onchange = e => { setting('device', e.target.value); rebuild('Overschakelen naar ' + (e.target.value || 'systeemstandaard') + '…'); setTimeout(() => audioSettings(box), 2500); };
  $b('#a-bp').onchange = e => { setting('bitperfect', e.target.checked); dspSend({ bitperfect: e.target.checked }); renderVolume(); rebuild(e.target.checked ? 'Bit-perfect aan' : 'Bit-perfect uit'); setTimeout(() => audioSettings(box), 300); };
  $b('#a-norm').onchange = e => { setting('normalise', e.target.checked); rebuild(); };
  $b('#a-cache').onchange = e => { setting('cacheGB', +e.target.value); toast('Geldt vanaf de volgende start'); };
  $b('#a-clear').onclick = () => { post('clearCache'); setTimeout(() => audioSettings(box), 600); };
  $b('#a-log').onclick = () => post('openLog');
}

/** De kop + knoppen + nummerlijst van een playlist, album of favorieten. */
async function collection(el, o, alive) {
  $('#top-title').textContent = o.title;
  el.innerHTML = `<div class="hero">${o.liked ? `<div class="ph liked-ph" style="width:210px;height:210px;border-radius:12px">${icon('heart-on')}</div>` : img(o.images, 300, '', o.title)}
    <div style="min-width:0"><div class="kind">${esc(o.kind)}</div><h1>${esc(o.title)}</h1>${o.desc ? `<div class="desc">${o.desc.replace(/<[^>]+>/g, '')}</div>` : ''}<div class="meta">${o.meta || ''} <span class="c-count"></span></div></div></div>
    <div class="actions"><button class="big-play" data-ctx="${esc(o.uri)}">${icon('play')}</button>
    <button class="pill" id="c-smart" title="Shuffle die echt husselt, en wat je net hoorde naar achteren schuift">${icon('shuffle')} Slim shuffelen</button>
    <input class="filter" id="c-filter" placeholder="Zoek in de lijst…"></div><div id="c-list"><div class="loading-more">Laden…</div></div>`;
  tint(el, o.images);
  const bp = $('.big-play', el);
  updateBigPlay(bp);
  bp.onclick = () => playUri(o.uri);
  let L = null, tracks = [];
  $('#c-smart', el).onclick = () => smartShuffle(o.uri, tracks);
  $('#c-filter', el).oninput = e => L?.filter(e.target.value);
  const listEl = $('#c-list', el);
  let extraMeta = '';
  const coll = {
    set(list) {
      tracks = list;
      if (!L) { listEl.innerHTML = ''; L = coll.L = trackList(listEl, list, { ctx: { uri: o.uri }, album: o.album !== false, numbers: o.numbers, cover: o.cover !== false }); }
      else { const scroll = $('#view').scrollTop; L.tracks = list; L.filter(); $('#view').scrollTop = scroll; }
      $('.c-count', el).textContent = extraMeta || `· ${list.length} nummers`;
      // Na een herstart: terug naar waar je was in de lijst.
      if (restoreScroll && list.length * ROW > restoreScroll) { $('#view').scrollTop = restoreScroll; restoreScroll = 0; }
    },
    meta(t) { extraMeta = t; $('.c-count', el).textContent = t; },
  };
  return coll;
}

/** Een zachte kleur uit de hoes achter de kop. */
function tint(el, images) {
  const u = pic(images, 64);
  if (!u) return;
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const x = c.getContext('2d');
      x.drawImage(im, 0, 0, 8, 8);
      const d = x.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      const n = d.length / 4;
      $('.hero', el)?.style.setProperty('--tint', `rgb(${r / n | 0},${g / n | 0},${b / n | 0})`);
    } catch {}
  };
  im.src = u;
}

// ——— Mix: wat er speelt als je geen playlist luistert ———
// Kandidaten uit Spotify's eigen radio (op het nummer én de artiest), daarna gefilterd en
// gerangschikt op jouw smaak: niets wat je net hoorde, geen dubbele versies, artiesten
// verspreid, en een balans tussen ontdekken en vertrouwd (Instellingen).
const songKey = t => (t.name.toLowerCase().replace(/\s*[-(\[].*$/, '') + '|' + (t.artists[0]?.name || '').toLowerCase());
const noShuffle = () => new Set(store.get('noShuffle', []));

/** Jouw smaak: top-artiesten en artiesten uit je liked songs (een dag onthouden). */
async function taste() {
  const t = store.get('taste', null);
  if (t && Date.now() - t.at < 864e5) return { top: new Set(t.top), liked: new Map(t.liked) };
  const [a, b, l] = await Promise.all([
    soft(get('/me/top/artists?time_range=short_term&limit=10', 864e5)),
    soft(get('/me/top/artists?time_range=medium_term&limit=10', 864e5)),
    soft(pages('/me/tracks?limit=50', null, 400)),
  ]);
  const top = [...(a?.items || []), ...(b?.items || [])].map(x => x.name.toLowerCase());
  const liked = new Map();
  for (const x of l || []) for (const ar of x.track?.artists || []) liked.set(ar.name.toLowerCase(), (liked.get(ar.name.toLowerCase()) || 0) + 1);
  store.set('taste', { at: Date.now(), top, liked: [...liked] });
  return { top: new Set(top), liked };
}

const radioCore = (seed, count, previous) => rpc('meta', { kind: 'radio', arg: JSON.stringify({ seed, count, previous }) }).then(r => r.data, () => []);

/** Een rij nummers die past bij `seeds` (nummers of artiesten), zonder wat in `skip` staat. */
async function mixFor(seeds, { count = 40, skip = [] } = {}) {
  const hist = store.get('hist', []);
  const recent = new Set(hist.filter(h => Date.now() - h.t < 3 * 864e5).map(h => songKey({ name: h.name, artists: [{ name: h.artists[0] }] })));
  const previous = hist.slice(0, 80).map(h => h.uri);
  const lists = await Promise.all([
    ...seeds.filter(x => x.uri.startsWith('spotify:track:')).slice(0, 3).map(t => radioCore(t.uri, 50, previous)),
    ...[...new Set(seeds.map(x => x.artists?.[0]?.id ? 'spotify:artist:' + x.artists[0].id : x.uri.startsWith('spotify:artist:') ? x.uri : null).filter(Boolean))].slice(0, 2).map(u => radioCore(u, 25, previous)),
  ]);
  const me = await taste();
  const balance = store.get('mixBalance', 0.5); // 0 = vertrouwd, 1 = ontdekken
  const banned = noShuffle();
  const seen = new Set([...skip.map(songKey), ...seeds.filter(x => x.name).map(songKey)]);
  const cand = new Map();
  lists.forEach((list, li) => list.forEach((t, rank) => {
    const k = songKey(t);
    if (seen.has(k) || banned.has(t.uri)) return;
    const c = cand.get(k) || { t, rank, hits: 0 };
    c.rank = Math.min(c.rank, rank + li * 2);
    c.hits++;
    cand.set(k, c);
  }));
  const scored = [...cand.values()].map(c => {
    const ar = (c.t.artists[0]?.name || '').toLowerCase();
    const known = recent.has(songKey(c.t));
    let score = 100 - c.rank * 1.6 + (c.hits - 1) * 14;
    if (me.top.has(ar)) score += 10 * (1 - balance) + 4;
    if (me.liked.has(ar)) score += Math.min(12, me.liked.get(ar) * 2) * (1 - balance);
    if (!me.liked.has(ar) && !me.top.has(ar)) score += 14 * balance;
    if (known) score -= 60;
    // Live- en remaster-versies alleen als je zelf ook zoiets startte.
    if (/\blive\b/i.test(c.t.name) && !seeds.some(x => /\blive\b/i.test(x.name || ''))) score -= 18;
    return { ...c, score };
  }).sort((a, b) => b.score - a.score);
  // Artiesten verspreiden: niet twee keer dezelfde binnen 4 nummers.
  const out = [];
  const pool = scored.map(x => x.t);
  while (out.length < count && pool.length) {
    const recentArtists = out.slice(-4).map(t => t.artists[0]?.name);
    let i = pool.findIndex(t => !recentArtists.includes(t.artists[0]?.name));
    if (i < 0) i = 0;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

/** Een los nummer (of artiest) starten en daarna doorspelen met een passende mix. */
async function playMix(seed, { label, position = 0 } = {}) {
  S.ctx = null;
  const isArtist = seed.uri.startsWith('spotify:artist:');
  const timeout = new Promise(r => setTimeout(() => r(null), isArtist ? 4000 : 900));
  const first = mixFor([seed], { count: 40 });
  const mix = await Promise.race([first, timeout]);
  const list = isArtist ? mix || await first : [seed, ...(mix || [])];
  S.mix = { list: list.map(t => ({ uri: t.uri, name: t.name, artists: t.artists })), label: label || (isArtist ? `Radio: ${seed.name}` : `Mix: ${seed.name}`), refilling: false };
  store.set('mix', S.mix);
  play({ tracks: list.map(t => t.uri), ...(position && !isArtist ? { position } : {}) });
  if (!mix && !isArtist) first.then(more => { S.mix.list.push(...more.map(t => ({ uri: t.uri, name: t.name, artists: t.artists }))); queueUris(more.slice(0, 15).map(t => t.uri)); });
}

/** Bijna aan het eind van de mix: aanvullen op basis van wat je net hoorde. */
async function mixRefill() {
  const m = S.mix;
  if (!m || m.refilling || !S.track) return;
  const at = m.list.findIndex(t => sameSong(t, S.track));
  if (at < 0 || m.list.length - at > 4) return;
  m.refilling = true;
  const seeds = m.list.slice(Math.max(0, at - 2), at + 1);
  const more = await mixFor(seeds, { count: 20, skip: m.list });
  m.list.push(...more.map(t => ({ uri: t.uri, name: t.name, artists: t.artists })));
  store.set('mix', { list: m.list.slice(-120), label: m.label });
  await queueUris(more.map(t => t.uri));
  m.refilling = false;
}

/** Nummers achter de huidige zetten (via de wachtrij van Spotify). */
async function queueUris(uris) {
  for (const u of uris) await soft(api('/me/player/queue?uri=' + encodeURIComponent(u), { method: 'POST' }));
}

/** Slim shuffelen: echt willekeurig, recent gehoorde nummers achteraan, niet twee keer dezelfde artiest na elkaar. */
async function smartShuffle(uri, tracks) {
  if (!tracks?.length) {
    const [, kind, id] = uri.split(':');
    toast('Even alles ophalen…');
    if (kind === 'playlist') tracks = await playlistItems(id).then(l => l.map(x => norm(x.item || x.track)).filter(Boolean), async () => (await rpc('meta', { kind: 'playlist', arg: id })).data.tracks);
    else if (kind === 'album') { const a = await get(`/albums/${id}`); tracks = a.tracks.items.map(t => norm(t, { name: a.name, id: a.id, images: a.images })); }
    else if (uri.endsWith(':collection')) tracks = (await pages('/me/tracks?limit=50')).map(x => norm(x.track)).filter(Boolean);
  }
  tracks = tracks.filter(t => t.playable !== false && !t.episode);
  if (!tracks.length) return;
  const recent = new Map(store.get('hist', []).map((h, i) => [h.uri, i]));
  const a = [...tracks];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  const fresh = a.filter(t => !recent.has(t.uri) || recent.get(t.uri) > 400);
  const heard = a.filter(t => recent.has(t.uri) && recent.get(t.uri) <= 400).sort((x, y) => recent.get(y.uri) - recent.get(x.uri));
  const out = [...fresh, ...heard];
  for (let i = 1; i < out.length; i++) {
    if (out[i].artists[0]?.name === out[i - 1].artists[0]?.name) {
      const j = out.findIndex((t, k) => k > i && t.artists[0]?.name !== out[i - 1].artists[0]?.name);
      if (j > 0) [out[i], out[j]] = [out[j], out[i]];
    }
  }
  S.ctx = null;
  if (S.shuffle) post('shuffle', { on: false });
  play({ tracks: out.slice(0, 700).map(t => t.uri) });
  toast(`Slim geshuffeld: ${Math.min(700, out.length)} nummers`);
}

/** Zoeken in wat Spotimfy al weet: je playlists en de nummers daarin. */
function localSearch(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const hit = s => words.every(w => s.toLowerCase().includes(w));
  const pls = (myPlaylists.list || store.get('playlists', [])).filter(p => hit(p.name)).slice(0, 4);
  const seen = new Set(), tracks = [];
  for (const id of store.get('plIndex', [])) {
    for (const t of plCache.get(id) || []) {
      if (tracks.length >= 6) break;
      const k = songKey(t);
      if (!seen.has(k) && hit(t.name + ' ' + t.artists.map(a => a.name).join(' '))) { seen.add(k); tracks.push(t); }
    }
  }
  if (!pls.length && !tracks.length) return '';
  return `<section class="local"><h2>In je bibliotheek</h2>
    ${pls.length ? `<div class="row-scroll">${pls.map(playlistCard).join('')}</div>` : ''}
    ${tracks.length ? `<div class="grid">${tracks.map(t => card({ go: t.album.id ? 'album:' + t.album.id : '', uri: t.uri, images: t.album.images, name: t.name, sub: t.artists.map(a => a.name).join(', ') })).join('')}</div>` : ''}</section>`;
}

function searchHistory() {
  const sh = store.get('searches', []);
  const recent = store.get('hist', []).slice(0, 8);
  return (sh.length ? `<h2>Recent gezocht</h2><div class="chips">${sh.map(s => `<button data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : '') +
    (recent.length ? `<h2>Net gehoord</h2><div class="grid">${recent.map(h => `<div class="card" data-card="${esc(h.uri)}"><img class="cover" src="${esc(h.cover)}" alt=""><button class="play" data-play="${esc(h.uri)}">${icon('play')}</button><div class="t">${esc(h.name)}</div><div class="s">${esc(h.artists.join(', '))}</div></div>`).join('')}</div>` : '');
}

// ——— paneel: wachtrij en songtekst ———
function togglePanel(which) {
  if (S.panel === which) { S.panel = null; $('#panel').hidden = true; }
  else { S.panel = which; $('#panel').hidden = false; }
  $('#b-lyrics').classList.toggle('on', S.panel === 'lyrics');
  $('#b-queue').classList.toggle('on', S.panel === 'queue');
  $$('#panel-tabs button').forEach(b => b.classList.toggle('on', b.dataset.p === S.panel));
  if (S.panel === 'queue') renderQueue();
  if (S.panel === 'lyrics') renderLyricsPanel();
}
$('#panel-close').onclick = () => togglePanel(S.panel);
$('#panel-tabs').onclick = e => { const b = e.target.closest('button'); if (b && b.dataset.p !== S.panel) togglePanel(b.dataset.p); };

async function renderQueue() {
  const body = $('#panel-body');
  if (S.panel !== 'queue') return;
  let q = null;
  try { q = await api('/me/player/queue'); } catch {}
  if (S.panel !== 'queue') return;
  const row = (t, now) => {
    const n = norm(t);
    return n ? `<div class="q${now ? ' now' : ''}" data-uri="${esc(n.uri)}">${img(n.album.images, 64)}<div><div class="t">${esc(n.name)}</div><div class="a">${esc(n.artists.map(a => a.name).join(', '))}</div></div></div>` : '';
  };
  if (!q?.currently_playing) { body.innerHTML = '<div class="empty">Speel iets af om de wachtrij te zien.</div>'; return; }
  const from = S.ctx && ((myPlaylists.list || []).find(p => p.uri === S.ctx)?.name || $('.hero h1')?.textContent);
  body.innerHTML = `<h4>Speelt nu${from ? ` · uit ${esc(from)}` : ''}</h4>${row(q.currently_playing, true)}<h4>Hierna</h4>${(q.queue || []).map(t => row(t)).join('') || '<div class="empty">Niets meer</div>'}`;
  const all = [q.currently_playing, ...(q.queue || [])];
  $$('.q', body).forEach((el, i) => { el._track = norm(all[i]); el.ondblclick = () => play({ tracks: [el.dataset.uri] }); });
}

const lyricsCache = new Map();
let lyr = null;
async function lyricsFor(t) {
  lyr = null;
  if (S.panel === 'lyrics') renderLyricsPanel();
  if (!$('#lyrics-full').hidden) renderLyricsFull();
  if (!t || (S.panel !== 'lyrics' && $('#lyrics-full').hidden)) return;
  const got = await loadLyrics(t);
  if (S.track?.uri !== t.uri) return;
  lyr = got;
  if (S.panel === 'lyrics') renderLyricsPanel();
  if (!$('#lyrics-full').hidden) renderLyricsFull();
}
async function loadLyrics(t) {
  if (lyricsCache.has(t.uri)) return lyricsCache.get(t.uri);
  let out = null;
  if (t.uri.startsWith('spotify:track:')) {
    try {
      const r = await rpc('lyrics', { track: t.uri });
      const l = r.data?.lyrics;
      if (l?.lines?.length) out = { synced: l.syncType === 'LINE_SYNCED', lines: l.lines.map(x => ({ t: +x.startTimeMs, text: x.words })).filter(x => x.text !== '♪' || true), src: 'Spotify' };
    } catch {}
  }
  if (!out) {
    try {
      const q = new URLSearchParams({ artist_name: t.artists[0]?.name || '', track_name: t.name, album_name: t.album.name || '', duration: Math.round((t.duration || 0) / 1000) });
      let r = await fetch('https://lrclib.net/api/get?' + q);
      let d = r.ok ? await r.json() : null;
      if (!d) { r = await fetch('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: t.name, artist_name: t.artists[0]?.name || '' })); d = r.ok ? (await r.json())[0] : null; }
      if (d?.syncedLyrics) out = { synced: true, src: 'LRCLIB', lines: d.syncedLyrics.split('\n').map(l => { const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/); return m ? { t: (+m[1] * 60 + +m[2]) * 1000, text: m[3] } : null; }).filter(Boolean) };
      else if (d?.plainLyrics) out = { synced: false, src: 'LRCLIB', lines: d.plainLyrics.split('\n').map(text => ({ t: 0, text })) };
    } catch {}
  }
  out = out || { none: true };
  lyricsCache.set(t.uri, out);
  return out;
}
function lyricsHtml(cls) {
  if (!S.track) return '<div class="empty">Er speelt niets.</div>';
  if (!lyr) return '<div class="empty">Songtekst zoeken…</div>';
  if (lyr.none) return '<div class="empty">Geen songtekst gevonden.</div>';
  return lyr.lines.map((l, i) => `<p data-l="${i}">${esc(l.text || '♪')}</p>`).join('') + (cls ? '' : `<div class="src">Songtekst: ${esc(lyr.src)}</div>`);
}
function renderLyricsPanel() {
  if (S.panel !== 'lyrics') return;
  const body = $('#panel-body');
  body.innerHTML = `<div class="ly${lyr?.synced ? ' synced' : ''}">${lyricsHtml()}</div>${lyr && !lyr.none ? '<button class="pill ly-full-btn" id="ly-full">Volledig scherm (F)</button>' : ''}`;
  const f = $('#ly-full'); if (f) f.onclick = openLyricsFull;
  if (!lyr && S.track) lyricsFor(S.track);
  lastLine = -2;
}
function openLyricsFull() {
  if (!S.track) return;
  $('#lyrics-full').hidden = false;
  renderLyricsFull();
  if (!lyr) lyricsFor(S.track);
}
function renderLyricsFull() {
  const box = $('#lyrics-full .lf-lines');
  box.className = 'lf-lines' + (lyr?.synced ? ' synced' : '');
  $('#lyrics-full').classList.toggle('no-lyrics', !!lyr?.none);
  box.innerHTML = lyricsHtml(true);
  renderTrack();
  lastLine = -2;
}
$('#lyrics-full .lf-close').onclick = () => $('#lyrics-full').hidden = true;
document.addEventListener('click', e => {
  const p = e.target.closest('.synced p[data-l]');
  if (p && lyr?.synced) ctl('seek', lyr.lines[+p.dataset.l].t);
});
let lastLine = -2;
function lyricsTick(pos) {
  if (!lyr?.synced) return;
  const panelOpen = S.panel === 'lyrics', fullOpen = !$('#lyrics-full').hidden;
  if (!panelOpen && !fullOpen) return;
  let i = -1;
  for (let k = 0; k < lyr.lines.length; k++) { if (lyr.lines[k].t <= pos + 150) i = k; else break; }
  if (i === lastLine) return;
  lastLine = i;
  for (const box of [panelOpen && $('#panel-body .ly'), fullOpen && $('#lyrics-full .lf-lines')].filter(Boolean)) {
    $$('p[data-l]', box).forEach((p, k) => { p.classList.toggle('cur', k === i); p.classList.toggle('past', k < i); });
    const curP = $(`p[data-l="${i}"]`, box);
    const scroller = box.classList.contains('lf-lines') ? box : $('#panel-body');
    if (curP) scroller.scrollTo({ top: curP.offsetTop - scroller.clientHeight * (fullOpen && box.classList.contains('lf-lines') ? 0.38 : 0.3), behavior: 'smooth' });
  }
}

// ——— slaaptimer ———
function sleepMenu(anchor) {
  const set = (min, end) => {
    S.sleep = min ? { until: Date.now() + min * 60000, vol: S.volume } : end ? { end: true, uri: S.track?.uri } : null;
    $('#b-sleep').classList.toggle('on', !!S.sleep);
    toast(min ? `Slaaptimer: ${min} minuten` : end ? 'Stopt aan het eind van dit nummer' : 'Slaaptimer uit');
  };
  menuAt(anchor, [{ label: 'Slaaptimer', header: true },
    ...[10, 15, 30, 45, 60, 90].map(m => ({ label: `${m} minuten`, fn: () => set(m) })),
    { label: 'Einde van dit nummer', fn: () => set(0, true) },
    ...(S.sleep ? ['-', { label: 'Uit', fn: () => set(0) }] : [])], 'up');
}
function sleepTick() {
  const b = $('#sleep-badge');
  if (!S.sleep) { b.hidden = true; return; }
  if (S.sleep.end) {
    b.hidden = false; b.textContent = 'einde nummer';
    if (S.track?.uri !== S.sleep.uri || S.dur - position() < 600) { ctl('pause'); S.sleep = null; $('#b-sleep').classList.remove('on'); }
    return;
  }
  const left = S.sleep.until - Date.now();
  b.hidden = false;
  b.textContent = fmt(Math.max(0, left));
  // De laatste 20 seconden zachtjes uitfaden, daarna stoppen en het volume terugzetten.
  if (left < 20000 && left > 0 && (S.local || !S.remote)) post('volume', { v: S.sleep.vol * left / 20000 });
  if (left <= 0) {
    ctl('pause');
    const vol = S.sleep.vol;
    S.sleep = null;
    $('#b-sleep').classList.remove('on');
    setTimeout(() => post('volume', { v: vol }), 800);
  }
}

// ——— opdrachtbalk (⌘K) ———
let pal = { items: [], i: 0, seq: 0 };
function openPalette() {
  $('#palette').hidden = false;
  const inp = $('#pal-input');
  inp.value = '';
  inp.focus();
  palRun();
}
function closeOverlays() {
  $('#palette').hidden = true;
  $('#menu').hidden = true;
}
$('#palette').addEventListener('mousedown', e => { if (e.target.id === 'palette') closeOverlays(); });
function palLocal(q) {
  q = q.toLowerCase();
  const out = [];
  const lists = myPlaylists.list || store.get('playlists', []);
  const hit = s => s.toLowerCase().includes(q);
  if (!q || hit('nummers die je leuk vindt') || hit('favorieten')) out.push({ kind: 'Jouw bibliotheek', t: 'Nummers die je leuk vindt', s: 'Playlist', uri: `spotify:user:${S.user}:collection`, go: 'liked:', liked: true });
  for (const p of lists) if (!q || hit(p.name)) out.push({ kind: 'Jouw bibliotheek', t: p.name, s: 'Playlist', uri: p.uri, go: 'playlist:' + p.id, images: p.images });
  if (!q) {
    const seen = new Set();
    for (const h of store.get('hist', [])) {
      if (seen.has(h.uri) || seen.size >= 6) continue;
      seen.add(h.uri);
      out.push({ kind: 'Net gehoord', t: h.name, s: h.artists.join(', '), uri: h.uri, images: [{ url: h.cover }], track: true });
    }
  }
  return q ? out.slice(0, 6) : out.filter(x => x.kind === 'Net gehoord').concat(out.filter(x => x.kind !== 'Net gehoord').slice(0, 6));
}
const views_go = { pages: [['Home', 'home'], ['Bibliotheek', 'library'], ['Statistieken', 'stats'], ['Instellingen', 'settings']] };
/** Opdrachten in ⌘K: [naam, extra zoekwoorden, actie]. */
const commands = () => [
  [S.playing ? 'Pauzeer' : 'Speel af', 'play pause afspelen', () => ctl('toggle')],
  ['Volgende nummer', 'next skip', () => ctl('next')],
  ['Vorige nummer', 'prev terug', () => ctl('prev')],
  [`Shuffle ${S.shuffle ? 'uit' : 'aan'}`, 'shuffle willekeurig', () => ctl('shuffle', !S.shuffle)],
  ['Herhalen: ' + ['alles', 'dit nummer', 'uit'][S.repeat], 'repeat herhaal', () => ctl('repeat', (S.repeat + 1) % 3)],
  [S.track && S.liked.get(S.track.uri) ? 'Verwijder uit leuk' : 'Vind ik leuk', 'like hartje favoriet', () => S.track && toggleLike(S.track)],
  ['Nu speelt', 'songtekst lyrics volledig scherm', () => openLyricsFull()],
  ['Minispeler', 'mini klein', () => toggleMini()],
  ['Wachtrij', 'queue', () => togglePanel('queue')],
  ['Stop na dit nummer', 'stop', () => onRemote('stopafter')],
  ...[15, 30, 45, 60].map(m => [`Slaaptimer ${m} minuten`, 'slaap sleep timer ' + m, () => { S.sleep = { until: Date.now() + m * 60000, vol: S.volume }; $('#b-sleep').classList.add('on'); toast(`Slaaptimer: ${m} minuten`); }]),
  ['Thema: donker', 'dark donker thema', () => { store.set('theme', 'dark'); applyTheme(); }],
  ['Thema: licht', 'light licht thema', () => { store.set('theme', 'light'); applyTheme(); }],
  ['Thema: systeem', 'system systeem thema', () => { store.set('theme', 'system'); applyTheme(); }],
  ['Nieuwe playlist', 'playlist maken nieuw', () => newPlaylist()],
  [store.get('island', true) ? 'Eiland uitzetten' : 'Eiland aanzetten', 'eiland dynamic island melding pil', () => setIsland(!store.get('island', true))],
  ...(S.track ? [['Radio op basis van dit nummer', 'radio', () => radio(S.track)]] : []),
];
async function palRun() {
  const q = $('#pal-input').value.trim();
  const my = ++pal.seq;
  let items = palLocal(q);
  if (q) {
    const ql = q.toLowerCase();
    const words = ql.split(/\s+/);
    const cmds = commands().filter(([n, k]) => words.every(w => (n + ' ' + k).toLowerCase().includes(w))).slice(0, 4);
    // Een opdracht die met de zoekterm begint, gaat bovenaan.
    const cmdItems = cmds.map(([n, , fn]) => ({ kind: 'Opdrachten', t: n, s: 'Opdracht', run: fn, page: true }));
    items = cmdItems.length && cmds[0][0].toLowerCase().startsWith(words[0]) ? [...cmdItems, ...items] : [...items, ...cmdItems];
    for (const [n, w] of views_go.pages) if (n.toLowerCase().startsWith(ql)) items.push({ kind: 'Ga naar', t: n, s: 'Pagina', go: w, page: true });
  }
  palDraw(items);
  if (q.length < 2) return;
  await sleep(110);
  if (my !== pal.seq) return;
  const r = await soft(get(`/search?q=${encodeURIComponent(q)}&type=track,artist,album,playlist&limit=5`, 600000));
  if (my !== pal.seq || !r) return;
  const seenT = new Set();
  const tr = (r.tracks?.items || []).filter(t => t && !seenT.has(t.name.toLowerCase() + t.artists[0]?.name) && seenT.add(t.name.toLowerCase() + t.artists[0]?.name)).map(t => ({ kind: 'Nummers', t: t.name, s: t.artists.map(a => a.name).join(', '), uri: t.uri, images: t.album.images, track: true, go: 'album:' + t.album.id, raw: norm(t) }));
  const ar = (r.artists?.items || []).filter(Boolean).slice(0, 3).map(a => ({ kind: 'Artiesten', t: a.name, s: 'Artiest', uri: a.uri, images: a.images, go: 'artist:' + a.id, round: true }));
  const al = (r.albums?.items || []).filter(Boolean).slice(0, 3).map(a => ({ kind: 'Albums', t: a.name, s: a.artists.map(x => x.name).join(', '), uri: a.uri, images: a.images, go: 'album:' + a.id }));
  const pl = (r.playlists?.items || []).filter(Boolean).slice(0, 3).map(p => ({ kind: 'Playlists', t: p.name, s: p.owner?.display_name || '', uri: p.uri, images: p.images, go: 'playlist:' + p.id }));
  // Een artiest die precies zo heet, gaat bovenaan.
  const exact = ar.find(a => a.t.toLowerCase().includes(q.toLowerCase()));
  palDraw([...(exact ? [{ ...exact, kind: 'Beste resultaat' }] : []), ...items, ...tr, ...ar.filter(a => a !== exact), ...al, ...pl]);
}
function palDraw(items) {
  pal.items = items;
  pal.i = 0;
  let last = '';
  $('#pal-list').innerHTML = items.map((x, i) => {
    const h = x.kind !== last ? `<div class="h">${esc(x.kind)}</div>` : '';
    last = x.kind;
    const pic_ = x.liked ? `<div class="ph liked-ph">${icon('heart-on')}</div>` : x.page ? `<div class="ph" style="display:grid;place-items:center">${icon('right')}</div>` : img(x.images, 64);
    return `${h}<div class="pi${x.round ? ' round' : ''}${i === 0 ? ' on' : ''}" data-n="${i}" ${x.track ? `data-uri="${esc(x.uri)}"` : ''}>${pic_}<div><div class="t">${esc(x.t)}</div><div class="s">${esc(x.s)}</div></div></div>`;
  }).join('') || '<div class="empty">Niets gevonden</div>';
  $$('#pal-list .pi').forEach(el => { const x = items[+el.dataset.n]; if (x.raw) el._track = x.raw; });
}
function palMove(d) {
  if (!pal.items.length) return;
  pal.i = (pal.i + d + pal.items.length) % pal.items.length;
  $$('#pal-list .pi').forEach(el => el.classList.toggle('on', +el.dataset.n === pal.i));
  $(`#pal-list .pi[data-n="${pal.i}"]`)?.scrollIntoView({ block: 'nearest' });
}
function palPick(mode) {
  const x = pal.items[pal.i];
  if (!x) return;
  closeOverlays();
  if (x.run) return x.run();
  if (x.page) return go(x.go);
  if (mode === 'open' && x.go) return go(x.go);
  if (mode === 'queue' && x.track) return queueTrack(x.raw || { uri: x.uri, name: x.t });
  if (x.track) return playMix(x.raw || { uri: x.uri, name: x.t, artists: [{ name: x.s.split(', ')[0] }] });
  playUri(x.uri);
}
$('#pal-input').addEventListener('input', palRun);
$('#pal-input').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); palPick(e.altKey ? 'queue' : e.shiftKey ? 'open' : 'play'); }
  else if (e.key === 'Escape') closeOverlays();
});
$('#pal-list').addEventListener('mousemove', e => { const el = e.target.closest('.pi'); if (el && +el.dataset.n !== pal.i) { pal.i = +el.dataset.n; $$('#pal-list .pi').forEach(x => x.classList.toggle('on', x === el)); } });
$('#pal-list').addEventListener('click', e => { if (e.target.closest('.pi')) palPick(e.altKey ? 'queue' : e.shiftKey ? 'open' : 'play'); });

// ——— toetsen ———
document.addEventListener('keydown', e => {
  const typing = e.target.closest('input, textarea');
  if (e.key === 'Escape') {
    if (!$('#palette').hidden || !$('#menu').hidden) return closeOverlays();
    if (!$('#lyrics-full').hidden) return $('#lyrics-full').hidden = true;
    if (typing) return e.target.blur();
  }
  if (typing || !$('#palette').hidden) return;
  if (e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
  if (e.metaKey || e.ctrlKey) return;
  if (e.key === ' ') { e.preventDefault(); return S.track ? ctl('toggle') : resumeSomething(); }
  if (e.key === '/') { e.preventDefault(); return openPalette(); }
  if (e.key === 'f' || e.key === 'F') return $('#lyrics-full').hidden ? openLyricsFull() : ($('#lyrics-full').hidden = true);
  if (e.shiftKey && e.key === 'ArrowRight') return ctl('seek', Math.min(S.dur - 1000, position() + 10000));
  if (e.shiftKey && e.key === 'ArrowLeft') return ctl('seek', Math.max(0, position() - 10000));
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && $('#view [data-list]')) {
    e.preventDefault();
    let L = selList?.body?.isConnected ? selList : lists.get($('#view [data-list]').dataset.list);
    if (!L?.shown.length) return;
    const i = Math.max(0, Math.min(L.shown.length - 1, (L.sel ?? -1) + (e.key === 'ArrowDown' ? 1 : -1)));
    L.sel = i;
    selList = L;
    // In beeld scrollen, ook als die rij nog niet bestaat.
    const view = $('#view');
    const rowTop = L.body.getBoundingClientRect().top - view.getBoundingClientRect().top + i * ROW;
    if (rowTop < 100) view.scrollTop += rowTop - 100;
    else if (rowTop + ROW > view.clientHeight - 10) view.scrollTop += rowTop + ROW - view.clientHeight + 10;
    L.paint(true);
    return;
  }
  if (e.key === 'Enter' && selList?.body?.isConnected && selList.sel != null) return playFromList(selList, selList.sel);
});

// ——— thema ———
function setIsland(on) {
  store.set('island', on);
  post('island', { on });
  toast(on ? 'Eiland staat aan' : 'Eiland staat uit');
}

function applyTheme() {
  const t = store.get('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
  // De titelbalk en schuifbalken van het venster in dezelfde kleur.
  post('theme', { dark: t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// ——— opstarten ———
async function start() {
  const cachedLists = store.get('playlists', null);
  if (cachedLists) renderSide(cachedLists);
  const was = store.get('page', null);
  restoreScroll = was?.scroll || 0;
  go(was?.where && was.where !== 'settings' ? was.where : 'home', was?.where ? was.arg ?? undefined : undefined, false);
  soft(api('/me')).then(me => { if (me) { S.me = me; store.set('me', me); } });
  myPlaylists(true).then(renderSide).catch(e => toast('Bibliotheek laden lukte niet: ' + e.message));
  pollRemote(true);
  renderModes();
  renderVolume();
  // Verder waar je was: het laatste nummer staat klaar, ▶︎ gaat daar verder.
  const last = store.get('last', null);
  if (last?.track?.album && !S.track) {
    S.track = last.track; S.dur = last.track.duration || 0; S.pos = last.position || 0; S.at = Date.now(); S.playing = false; S.resumable = true;
    lastTrackUri = last.track.uri;
    renderTrack(); renderPlay();
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready && !S.local) pollRemote(true); });

renderPlay();
renderModes();
// Vloeiend: elk beeldje bijwerken zolang het venster zichtbaar is, anders rustig.
(function frame() { tick(); document.hidden ? setTimeout(frame, 1000) : requestAnimationFrame(frame); })();

// Handdruk met de kern: blijven melden tot die antwoordt (het eerste bericht kan verloren gaan).
(function hello() { if (!S.redirect) { post('ready'); setTimeout(hello, 700); } })();
