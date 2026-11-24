'use strict';
// Spokoe: de interface. Afspelen gebeurt in de Rust-kern (post → webkit), bibliotheek en zoeken
// via de Web API (rechtstreeks met fetch, met een token van de kern).

// Fouten in de pagina naar het log van de app.
addEventListener('error', e => window.webkit?.messageHandlers?.spokoe?.postMessage(JSON.stringify({ cmd: 'log', msg: `${e.message} (regel ${e.lineno})` })));
addEventListener('unhandledrejection', e => window.webkit?.messageHandlers?.spokoe?.postMessage(JSON.stringify({ cmd: 'log', msg: 'promise: ' + (e.reason?.message || e.reason) })));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const post = (cmd, o = {}) => window.webkit?.messageHandlers?.spokoe?.postMessage(JSON.stringify({ cmd, ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = ms => {
  if (!(ms >= 0)) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
// Opslag onder de oude naam "spotimfy:", zodat geschiedenis en instellingen bewaard blijven.
const store = {
  get(k, d) { try { const v = localStorage.getItem('spotimfy:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spotimfy:' + k, JSON.stringify(v)); } catch {} },
};
const idOf = uri => String(uri || '').split(':').pop();
const isMobile = () => document.documentElement.classList.contains('mobile');
/** Tablet: een breed scherm in de app (ook een telefoon die je dwars houdt is breed genoeg niet). */
function layout() {
  const tablet = isMobile() && Math.min(screen.width, screen.height) >= 600 && innerWidth >= 760;
  document.documentElement.classList.toggle('tablet', tablet);
}
layout();
addEventListener('resize', () => { layout(); setupGlisse.sync?.(); });
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

window.spokoe = {
  recv(m) {
    switch (m.type) {
      case 'token': case 'lyrics': case 'meta': case 'audioInfo': case 'fetchText': case 'update': {
        const w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        m.error ? w.reject(new Error(m.error)) : w.resolve(m);
        return;
      }
      case 'config':
        S.clientId = m.clientId || ''; S.redirect = m.redirect; S.deviceName = m.deviceName || 'Spokoe op deze Mac';
        if (m.platform === 'android' && !S.androidInit) { S.androidInit = true; post('volume', { v: 1 }); }
        return;
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
      case 'unavailable': {
        const u = new Set(store.get('unavailable', []));
        u.add(m.uri);
        store.set('unavailable', [...u].slice(-2000));
        lists.forEach(L => L.tracks.forEach(t => { if (t.uri === m.uri) t.playable = false; }));
        lists.forEach(L => L.body?.isConnected && L.paint(true));
        return toast('Dit nummer is niet beschikbaar en wordt overgeslagen');
      }
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
    $('#login-msg').textContent = m.message ? `Dat lukte niet (${m.message}). Probeer het nog eens.` : 'Log in met je Spotify Premium-account. Je browser opent even; daarna speelt alles hier.';
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
      $('#login-msg').textContent = 'Spokoe kan Spotify nu niet bereiken. Zodra je internet het weer doet, gaat het vanzelf verder.';
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
  if (!tokP) tokP = rpc('token').then(r => { tok = r.token; tokExp = r.expires; tokP = null; return tok; }, e => {
    tokP = null;
    // Niet stil falen: laten zien waarom de bibliotheek niet laadt.
    if (Date.now() - (token.warned || 0) > 60000) { token.warned = Date.now(); toast('Bibliotheek laden lukt niet: ' + e.message + '. Vul eventueel een eigen Client ID in (Instellingen).'); }
    throw e;
  });
  return tokP;
}

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, { method = 'GET', body, retry = 2, raw, type } = {}) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  const t = await token();
  const res = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : raw ? { 'Content-Type': type } : {}) },
    body: body ? JSON.stringify(body) : raw,
  });
  if (res.status === 401 && retry > 0) { tok = null; await token(true); return api(path, { method, body, raw, type, retry: retry - 1 }); }
  if (res.status === 429 && retry > 0) {
    await sleep(Math.min(10, +res.headers.get('Retry-After') || 1) * 1000);
    return api(path, { method, body, raw, type, retry: retry - 1 });
  }
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    if ((res.status === 401 || res.status === 403) && Date.now() - (api.warned || 0) > 60000 && /\/me\b/.test(path)) { api.warned = Date.now(); toast(`Spotify weigert de toegang (${res.status}). Probeer een eigen Client ID in Instellingen.`); }
    throw new ApiError(res.status, data?.error?.message || data?.error_description || `HTTP ${res.status}`);
  }
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
  try { return await pages(`/playlists/${id}/items?limit=50&market=from_token`, each); }
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

const withAdded = (t, x) => t && { ...t, ...(x?.added_at ? { added: Date.parse(x.added_at) } : {}), ...(x?.added_by?.id ? { by: x.added_by.id } : {}) };

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
    nowplaying: () => $('#lyrics-full').hidden ? openLyricsFull() : closeLyricsFull(),
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
    if (local) queueOnTrack(t);
    if (local && S.mix) setTimeout(mixRefill, 1500);
    checkLiked([t]);
    lyricsFor(t);
    if (S.panel === 'queue') setTimeout(renderQueue, 600);
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

/** Een kleine, al wazige versie van de hoes (op Android knipt Chrome een CSS-blur af onder de statusbalk). */
function blurredCover(url, done) {
  if (!url) return;
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 96;
      const x = c.getContext('2d');
      x.filter = 'blur(10px) saturate(1.6) brightness(.5)';
      x.drawImage(im, -24, -24, 144, 144);
      done(c.toDataURL('image/jpeg', .8));
    } catch { done(url); }
  };
  im.src = url;
}

// ——— spelerbalk ———
function renderTrack() {
  const t = S.track;
  if (t && renderTrack.last !== t.uri) {
    renderTrack.last = t.uri;
    // Opnieuw starten van de animatie: class weg, reflow, class erbij.
    for (const el of [$('#np-text'), $('#np-cover'), $('.lf-side')]) { el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap'); }
  }
  const small = t ? pic(t.album.images, 128) : '';
  // Geen hoes: geen kapot plaatje, maar een nette vervanger.
  if (small) $('#np-cover').src = small; else $('#np-cover').removeAttribute('src');
  $('#np').classList.toggle('no-cover', !small);
  document.body.classList.toggle('has-track', !!t);
  $('#np-disc').style.setProperty('--cover', small ? `url('${small}')` : 'none');
  $('#np-title').textContent = t?.name || '';
  $('#np-title').dataset.go = t?.album?.id ? 'album:' + t.album.id : '';
  $('#np-artist').innerHTML = t ? t.artists.map(a => a.id ? `<a data-go="artist:${esc(a.id)}">${esc(a.name)}</a>` : esc(a.name)).join(', ') + (S.remote && !S.local && S.device ? ` · <span style="color:var(--accent)">${esc(S.device)}</span>` : '') : '';
  $('#np-like').hidden = !t;
  renderLike();
  $('#t-dur').textContent = fmt(S.dur);
  document.title = t ? `${t.name} · ${t.artists.map(a => a.name).join(', ')}` : 'Spokoe';
  if (t) {
    const big = pic(t.album.images, 640);
    // Telefoon: een <img> (een CSS-achtergrond hier laat Android een strook onder de statusbalk zien).
    if (isMobile()) blurredCover(pic(t.album.images, 64), url => {
      if (S.track !== t) return;
      const bg = $('.lf-bg');
      (bg.querySelector('img') || bg.appendChild(document.createElement('img'))).src = url;
    });
    else $('.lf-bg').style.backgroundImage = `url("${big}")`;
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
  document.body.classList.toggle('is-playing', !!S.playing);
  b.title = S.playing ? 'Pauzeer (spatie)' : 'Speel af (spatie)';
  $('#lf-play').innerHTML = icon(S.playing ? 'pause' : 'play');
  $('#lf-shuffle').classList.toggle('on', S.shuffle);
  $('#lf-repeat').classList.toggle('on', S.repeat > 0);
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
  if (on && renderLike.was === false) for (const b of [$('#np-like'), $('#lf-like')]) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  renderLike.was = !!on;
  $('#lf-like').classList.toggle('on', !!on);
  $('#lf-like').innerHTML = icon(on ? 'heart-on' : 'heart');
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
$('#bar').addEventListener('click', e => { if (isMobile() && !e.target.closest('button, a, .range')) openLyricsFull(); });
$('#lf-shuffle').onclick = () => ctl('shuffle', !S.shuffle);
$('#lf-repeat').onclick = () => ctl('repeat', (S.repeat + 1) % 3);
$('#lf-like').onclick = () => S.track && toggleLike(S.track);
$('#lf-lyr').onclick = () => { $('#lyrics-full').classList.toggle('show-lyrics'); if (!lyr && S.track) lyricsFor(S.track); };
$('#lf-queue').onclick = () => { closeLyricsFull(); togglePanel('queue'); };
$('#lf-dev').onclick = e => devicesMenu(e.currentTarget);
$('#lf-sleep').onclick = e => sleepMenu(e.currentTarget);
// Nu speelt: omlaag vegen om te sluiten.
(() => {
  let y0 = null;
  const lf = $('#lyrics-full');
  lf.addEventListener('touchstart', e => { if (!e.target.closest('.lf-lines, .range')) y0 = e.touches[0].clientY; }, { passive: true });
  lf.addEventListener('touchmove', e => { if (y0 != null) { const dy = Math.max(0, e.touches[0].clientY - y0); lf.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  lf.addEventListener('touchend', e => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    lf.style.transition = 'transform .25s';
    lf.style.transform = dy > 120 ? 'translateY(100%)' : '';
    setTimeout(() => { if (dy > 120) { lf.hidden = true; glisseSync(); } lf.style.transform = ''; lf.style.transition = ''; }, 250);
  });
})();
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
        const mine = p.device.name === S.deviceName;
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
    items.push({ label: d.name === S.deviceName ? (isMobile() ? 'Deze telefoon' : 'Deze Mac') : d.name, check: d.is_active, fn: async () => {
      if (d.name === S.deviceName) { if (S.track) play({ tracks: [S.track.uri], position: Math.round(position()) }); return; }
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
$('#side-new').onclick = e => menuAt(e.currentTarget, [
  { label: 'Nieuwe playlist…', fn: () => newPlaylist() },
  { label: 'Nieuwe map…', fn: async () => { const name = await ask('Nieuwe map', 'Naam'); if (!name) return; store.set('folders', [...store.get('folders', []), { id: 'f' + Date.now(), name, items: [] }]); renderSide(); } },
  { label: 'Importeren…', fn: () => importPlaylist() },
]);
$('#fwd').onclick = forward;

let renderId = 0;
let restoreScroll = 0;
async function show(entry) {
  const id = ++renderId;
  if (!$('#sleeve-big').hidden) closeSleeve();
  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;
  $('#top-title').textContent = '';
  $$('#nav button, #mnav [data-go]').forEach(b => b.classList.toggle('on', b.dataset.go === entry.where));
  glisseSync();
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
  // De hoes in de kop schuift en vervaagt een beetje mee (parallax).
  const hero = $('#view .hero');
  if (hero) { const y = Math.min(260, $('#view').scrollTop); hero.style.setProperty('--scroll', y); }
  const more = $('#view .more-rows');
  if (more && $('#view').scrollTop + $('#view').clientHeight > $('#view').scrollHeight - 900) more.click();
}, { passive: true });

// ——— lijsten met nummers ———
let lists = new Map(), listSeq = 0;
/** Een nummerlijst. ctx = { uri } (afspelen in die context) of null (als losse lijst). */
function trackList(el, tracks, { ctx, album = true, numbers = false, cover = true, reorder = null } = {}) {
  const key = 'l' + (++listSeq);
  const gone = new Set(store.get('unavailable', []));
  if (gone.size) tracks.forEach(t => { if (gone.has(t.uri)) t.playable = false; });
  const L = { tracks, shown: tracks, ctx, key, sort: null, q: '', reorder };
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
    <div class="a">${t.artists.map(a => a.id ? `<a data-go="artist:${esc(a.id)}">${esc(a.name)}</a>` : esc(a.name)).join(', ')}${L.multiBy && t.by ? ` · <span class="by">${esc(userName(t.by))}</span>` : ''}</div></div></div>
    <div class="al">${t.album.id ? `<a data-go="album:${esc(t.album.id)}">${esc(t.album.name)}</a>` : esc(t.album.name)}</div>
    ${added() ? `<div class="ad">${t.added ? day(t.added) : ''}</div>` : ''}
    <button class="icon like${S.liked.get(t.uri) ? ' on' : ''}" data-like>${icon(S.liked.get(t.uri) ? 'heart-on' : 'heart')}</button>
    <div class="d">${fmt(t.duration)}</div><button class="icon more-btn" data-more>${icon('more')}</button></div>`;
  // Alleen de rijen die je ziet bestaan echt: ook 10.000 nummers blijven soepel.
  L.render = () => {
    el.classList.toggle('with-added', added());
    // Gedeelde playlist: laten zien wie wat toevoegde.
    L.multiBy = new Set(L.tracks.map(t => t.by).filter(Boolean)).size > 1;
    if (L.multiBy) [...new Set(L.tracks.map(t => t.by))].forEach(id => id && !users.has(id) && users.set(id, soft(get(`/users/${id}`, 864e5)).then(u => { users.set(id, u?.display_name || id); L.paint(true); })));
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
    // De hoezen van de rijen hieronder alvast laden: scrollen blijft dan scherp.
    for (const t of L.shown.slice(last, last + 40)) { const u = pic(t.album.images, 64); if (u && !preloaded.has(u)) { preloaded.add(u); new Image().src = u; } }
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
const preloaded = new Set();
const users = new Map();
const userName = id => { const u = users.get(id); return typeof u === 'string' ? u : id === S.me?.id ? 'jij' : '…'; };

// Herschikken in je eigen playlist: een rij naar een andere plek slepen.
let rowDrag = null;
document.addEventListener('dragstart', e => {
  const row = e.target.closest?.('.tr[data-i]');
  const L = row && lists.get(row.closest('[data-list]').dataset.list);
  rowDrag = L?.reorder && !L.sort && !L.q ? { L, i: +row.dataset.i } : null;
});
$('#view').addEventListener('dragover', e => {
  if (!rowDrag) return;
  const row = e.target.closest('.tr[data-i]');
  if (!row || lists.get(row.closest('[data-list]')?.dataset.list) !== rowDrag.L) return;
  e.preventDefault();
  $$('.tr.drop-above').forEach(r => r !== row && r.classList.remove('drop-above'));
  row.classList.add('drop-above');
});
$('#view').addEventListener('drop', async e => {
  if (!rowDrag) return;
  const row = e.target.closest('.tr[data-i]');
  const { L, i: from } = rowDrag;
  rowDrag = null;
  $$('.tr.drop-above').forEach(r => r.classList.remove('drop-above'));
  if (!row) return;
  e.preventDefault();
  const to = +row.dataset.i;
  if (to === from || to === from + 1) return;
  const p = L.reorder;
  const [t] = L.tracks.splice(from, 1);
  L.tracks.splice(to > from ? to - 1 : to, 0, t);
  L.filter();
  try {
    await api(`/playlists/${p.id}/items`, { method: 'PUT', body: { range_start: from, insert_before: to } })
      .catch(e => e.status === 404 || e.status === 403 ? api(`/playlists/${p.id}/tracks`, { method: 'PUT', body: { range_start: from, insert_before: to } }) : Promise.reject(e));
    forget(p.id);
  } catch (err) { toast(err.message); }
});
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
  dropAuto();
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
  if (row && !e.target.closest('a,button') && isMobile()) return playFromList(lists.get(row.closest('[data-list]').dataset.list), +row.dataset.i);
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
function dropAuto() { Q.items = Q.items.filter(x => !x.auto); Q.save(); }

function playUri(uri, track) {
  S.mix = null;
  dropAuto();
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
  $('.sleeve')?.classList.toggle('spin', !!$('.sleeve') && S.playing && (S.ctx === $('.sleeve').dataset.ctx || (S.track?.album?.id && $('.sleeve').dataset.ctx.endsWith(S.track.album.id))));
  if (!$('#sleeve-big').hidden) sleeveSpin();
  b.innerHTML = icon(on ? 'pause' : 'play');
  b.classList.toggle('pausing', on);
}

// rechtsklikmenu
document.addEventListener('contextmenu', e => openContext(e) && e.preventDefault());
/** Het menu bij een nummer, kaart of playlist; geeft true als er een menu was. */
function openContext(e) {
  const side = e.target.closest('[data-side]');
  if (side) { sideMenu(e.clientX, e.clientY, side.dataset.side); return true; }
  const fold = e.target.closest('[data-fold]');
  if (fold && !fold.dataset.fold.startsWith('sp:')) { folderHeadMenu(e.clientX, e.clientY, fold.dataset.fold); return true; }
  const row = e.target.closest('.tr[data-i], .q[data-uri], .pi[data-uri]');
  const card = e.target.closest('[data-card]');
  if (!row && !card) return false;
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
      { label: 'In de wachtrij', fn: () => queueContext(uri) },
      '-',
      { label: 'Kopieer link', fn: () => copyLink(uri) },
    ];
    if (kind === 'artist') items.splice(1, 1);
    if (kind === 'album') items.splice(3, 0, { label: inSide(uri) ? 'Uit de zijbalk halen' : 'In de zijbalk zetten', fn: () => toggleSideAlbum(uri) });
    menu(e.clientX, e.clientY, items);
  }
  return true;
}
// Op de telefoon: lang drukken = rechtsklikken; ⋯ in een rij doet hetzelfde.
let pressT = null, pressAt = null;
document.addEventListener('touchstart', e => {
  const t = e.touches[0];
  pressAt = { x: t.clientX, y: t.clientY, target: e.target };
  clearTimeout(pressT);
  pressT = setTimeout(() => {
    if (!pressAt) return;
    if (openContext({ target: pressAt.target, clientX: pressAt.x, clientY: pressAt.y })) { navigator.vibrate?.(12); pressAt.done = true; }
  }, 480);
}, { passive: true });
document.addEventListener('touchmove', e => { const t = e.touches[0]; if (pressAt && Math.hypot(t.clientX - pressAt.x, t.clientY - pressAt.y) > 10) { clearTimeout(pressT); pressAt = null; } }, { passive: true });
document.addEventListener('touchend', e => { clearTimeout(pressT); if (pressAt?.done) e.preventDefault(); pressAt = null; });
document.addEventListener('click', e => {
  const m = e.target.closest('[data-more]');
  if (!m) return;
  e.stopPropagation();
  const r = m.getBoundingClientRect();
  openContext({ target: m, clientX: r.left, clientY: r.bottom });
}, true);

function trackMenu(x, y, t, playFn, L) {
  const liked = S.liked.get(t.uri);
  const own = L?.ctx?.uri?.startsWith('spotify:playlist:') && (myPlaylists.list || []).find(p => p.uri === L.ctx.uri && p.owner?.id === S.me?.id);
  const items = [
    { label: 'Afspelen', fn: playFn },
    { label: 'Speel hierna', fn: () => queueTrack(t) },
    { label: 'Achteraan in de wachtrij', fn: () => queueTrack(t, true) },
    '-',
    ...(t.album?.id ? [{ label: 'Naar album', fn: () => go('album', t.album.id) }] : []),
    ...t.artists.filter(a => a.id).slice(0, 3).map(a => ({ label: `Naar ${a.name}`, fn: () => go('artist', a.id) })),
    '-',
    { label: liked ? 'Verwijder uit leuk' : 'Vind ik leuk', fn: () => toggleLike(t) },
    { label: 'Aan playlist toevoegen…', fn: () => addToPlaylistMenu(x, y, t) },
    { label: 'Radio op basis van dit nummer', fn: () => radio(t) },
    { label: noShuffle().has(t.uri) ? 'Weer in shuffle en mixen' : 'Niet in shuffle en mixen', fn: () => toggleNoShuffle(t) },
    ...(own ? [{ label: `Verwijder uit ${own.name}`, fn: () => removeFromPlaylist(own, t, L) }] : []),
    '-',
    { label: 'Kopieer link', fn: () => copyLink(t.uri) },
  ];
  menu(x, y, items);
}

// ——— eigen wachtrij ———
// Spotify laat apps de wachtrij niet herschikken. Daarom houdt Spokoe zelf de wachtrij bij en
// zet steeds precies één nummer klaar bij Spotify; de rest kun je slepen, weghalen en bewaren.
// Jouw nummers gaan altijd voor wat de mix automatisch aanvult.
const Q = {
  // Wat bij een herstart nog klaarstond, gaat gewoon weer vooraan.
  items: [...(store.get('queueReady', null) ? [store.get('queueReady')] : []), ...store.get('queue', [])],
  ready: null, // het nummer dat al bij Spotify klaarstaat
  save() { store.set('queue', this.items); store.set('queueReady', this.ready); if (S.panel === 'queue') renderQueue(); },
};
const slimT = t => ({ uri: t.uri, id: t.id, name: t.name, artists: t.artists.map(a => ({ name: a.name, id: a.id })), album: { name: t.album?.name || '', id: t.album?.id, images: t.album?.images?.slice(0, 1) || [] }, duration: t.duration });

function queueAdd(tracks, { next = false, auto = false } = {}) {
  const items = tracks.filter(t => t?.uri).map(t => ({ ...slimT(t), auto }));
  if (next) Q.items.unshift(...items);
  else if (auto) Q.items.push(...items);
  else {
    // Achteraan bij jouw nummers, maar vóór wat de mix zelf aanvulde.
    const firstAuto = Q.items.findIndex(x => x.auto);
    Q.items.splice(firstAuto < 0 ? Q.items.length : firstAuto, 0, ...items);
  }
  Q.save();
  queueFeed();
}

/** Het eerstvolgende nummer bij Spotify klaarzetten (als er nog niets klaarstaat). */
async function queueFeed() {
  if (Q.ready || !Q.items.length || !S.local || !S.track) return;
  const t = Q.items.shift();
  Q.ready = t;
  Q.save();
  try { await api('/me/player/queue?uri=' + encodeURIComponent(t.uri), { method: 'POST' }); }
  catch { Q.items.unshift(t); Q.ready = null; Q.save(); }
}

/** Bij elk nieuw nummer: was het ons klaargezette nummer, dan het volgende klaarzetten. */
function queueOnTrack(t) {
  if (Q.ready && sameSong(Q.ready, t)) Q.ready = null;
  queueFeed();
}

async function queueTrack(t, end) {
  if (!S.track) return toast('Speel eerst iets af');
  queueAdd([t], { next: !end });
  toast(end ? `“${t.name}” staat achteraan in de wachtrij` : `“${t.name}” speelt hierna`);
}

/** Een album of playlist in de wachtrij. */
async function queueContext(uri) {
  const [, kind, id] = uri.split(':');
  let tracks = [];
  if (kind === 'album') { const a = await get(`/albums/${id}`); tracks = a.tracks.items.map(t => norm(t, { name: a.name, id: a.id, images: a.images })); }
  else if (kind === 'playlist') tracks = plCache.get(id) || await playlistItems(id).then(l => l.map(x => norm(x.item || x.track)).filter(Boolean), () => corePlaylist(id));
  else if (uri.endsWith(':collection')) tracks = plCache.get('liked') || [];
  if (!tracks.length) return toast('Niets om toe te voegen');
  queueAdd(tracks);
  toast(`${tracks.length} nummers in de wachtrij`);
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

// ——— playlists beheren ———
async function playlistTracks(p) {
  if (p.owner?.id === S.me?.id) {
    try { return (await playlistItems(p.id)).map(x => withAdded(norm(x.item || x.track), x)).filter(Boolean); } catch {}
  }
  return corePlaylist(p.id);
}
const forget = id => { memo.forEach((v, k) => k.includes(id) && memo.delete(k)); coreLists.delete(id); try { localStorage.removeItem('spotimfy:pl:' + id); } catch {} };

/** Naam, beschrijving en hoes. */
async function editPlaylist(p) {
  const r = await askForm('Playlist bewerken', [
    { key: 'name', label: 'Naam', value: p.name },
    { key: 'description', label: 'Beschrijving', value: (p.description || '').replace(/<[^>]+>/g, ''), area: true },
    { key: 'cover', label: 'Hoes (JPEG of PNG)', file: true },
  ]);
  if (!r) return;
  try {
    await api(`/playlists/${p.id}`, { method: 'PUT', body: { name: r.name || p.name, description: r.description } });
    if (r.cover) await api(`/playlists/${p.id}/images`, { method: 'PUT', raw: await coverJpeg(r.cover), type: 'image/jpeg' });
    forget(p.id);
    renderSide(await myPlaylists(true));
    toast('Opgeslagen');
    if (cur.where === 'playlist' && cur.arg === p.id) show(cur);
  } catch (e) { toast(e.message); }
}

/** Een gekozen afbeelding vierkant, maximaal 640 px en klein genoeg (onder 256 kB) als JPEG in base64. */
function coverJpeg(file) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const size = Math.min(640, im.width, im.height);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(im.width, im.height);
      c.getContext('2d').drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, size, size);
      let q = 0.9, data;
      do { data = c.toDataURL('image/jpeg', q).split(',')[1]; q -= 0.1; } while (data.length > 250000 && q > 0.2);
      resolve(data);
    };
    im.onerror = reject;
    im.src = URL.createObjectURL(file);
  });
}

async function removePlaylist(p) {
  const own = p.owner?.id === S.me?.id;
  if (!(await confirmBox(own ? `“${p.name}” verwijderen?` : `“${p.name}” niet meer volgen?`, own ? 'Spotify bewaart verwijderde playlists nog even; je kunt hem op spotify.com herstellen.' : ''))) return;
  try {
    await api('/me/library?uris=' + p.uri, { method: 'DELETE' }).catch(() => api(`/playlists/${p.id}/followers`, { method: 'DELETE' }));
    store.set('pins', store.get('pins', []).filter(u => u !== p.uri));
    renderSide(await myPlaylists(true));
    toast(own ? 'Verwijderd' : 'Niet meer gevolgd');
    if (cur.where === 'playlist' && cur.arg === p.id) go('library');
  } catch (e) { toast(e.message); }
}

/** Dubbele nummers (ook andere versies van hetzelfde nummer) eruit halen. */
async function dedupePlaylist(p) {
  if (p.owner?.id !== S.me?.id) return toast('Alleen bij je eigen playlists');
  toast('Zoeken naar dubbele nummers…');
  const tracks = await playlistTracks(p);
  const seen = new Set(), dupes = [];
  tracks.forEach((t, i) => { const k = songKey(t); if (seen.has(k)) dupes.push({ uri: t.uri, positions: [i] }); else seen.add(k); });
  if (!dupes.length) return toast('Geen dubbele nummers gevonden');
  if (!(await confirmBox(`${dupes.length} dubbele nummers gevonden`, 'De eerste keer blijft staan; de herhalingen gaan eruit.'))) return;
  try {
    for (let i = 0; i < dupes.length; i += 100) await api(`/playlists/${p.id}/items`, { method: 'DELETE', body: { items: dupes.slice(i, i + 100) } }).catch(e => api(`/playlists/${p.id}/tracks`, { method: 'DELETE', body: { tracks: dupes.slice(i, i + 100) } }));
    forget(p.id);
    toast(`${dupes.length} dubbele nummers verwijderd`);
    if (cur.where === 'playlist' && cur.arg === p.id) show(cur);
  } catch (e) { toast(e.message); }
}

/** Twee playlists samenvoegen tot een nieuwe (zonder dubbelen). */
function mergeMenu(x, y, p) {
  const others = (myPlaylists.list || []).filter(q => q.uri !== p.uri);
  menu(x, y, [{ label: `“${p.name}” samenvoegen met`, header: true }, ...others.slice(0, 40).map(q => ({ label: q.name, fn: async () => {
    toast('Samenvoegen…');
    const [a, b] = await Promise.all([playlistTracks(p), playlistTracks(q)]);
    const seen = new Set(), uris = [];
    for (const t of [...a, ...b]) { const k = songKey(t); if (!seen.has(k)) { seen.add(k); uris.push(t.uri); } }
    const made = await newPlaylist([], `${p.name} + ${q.name}`, { quiet: true });
    if (!made) return;
    for (let i = 0; i < uris.length; i += 100) await addToPlaylist(made, uris.slice(i, i + 100));
    toast(`Samengevoegd: ${uris.length} nummers`);
    go('playlist', made.id);
  } }))]);
}

/** Playlist als CSV (Excel en Numbers openen dat). */
async function exportPlaylist(p) {
  const tracks = p.tracks || await playlistTracks(p);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['Titel;Artiest;Album;Duur;Toegevoegd;Spotify-link', ...tracks.map(t => [t.name, t.artists.map(a => a.name).join(', '), t.album.name, fmt(t.duration), t.added ? new Date(t.added).toLocaleDateString('nl-NL') : '', 'https://open.spotify.com/track/' + idOf(t.uri)].map(q).join(';'))].join('\n');
  post('saveFile', { name: `${p.name.replace(/[\/:]/g, '-')}.csv`, text: '\ufeff' + csv });
}

/** Importeren: een lijst "artiest - titel" (of Spotify- en YouTube-links), één per regel. */
async function importPlaylist() {
  const r = await askForm('Playlist importeren', [
    { key: 'name', label: 'Naam van de nieuwe playlist', value: 'Geïmporteerd ' + new Date().toLocaleDateString('nl-NL') },
    { key: 'list', label: 'Eén nummer per regel: “artiest - titel”, of een Spotify- of YouTube-link', area: true, rows: 10 },
  ]);
  if (!r?.list?.trim()) return;
  const lines = r.list.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 500);
  const uris = [], missed = [];
  for (const [i, line] of lines.entries()) {
    toast(`Importeren… ${i + 1}/${lines.length}`);
    const sp = line.match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/) || line.match(/spotify:track:([A-Za-z0-9]{22})/);
    if (sp) { uris.push('spotify:track:' + sp[1]); continue; }
    let query = line;
    if (/youtu\.?be/.test(line)) {
      // De titel van de video opvragen en die zoeken.
      const got = await rpc('fetchText', { url: 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(line) }).catch(() => null);
      try { query = JSON.parse(got.text).title.replace(/\(.*?(official|video|audio|lyrics|clip).*?\)|\[.*?\]/gi, ''); } catch { missed.push(line); continue; }
    }
    const hit = await soft(get(`/search?q=${encodeURIComponent(query.replace(/[-–—]/g, ' '))}&type=track&limit=1`, 3600000));
    const t = hit?.tracks?.items?.[0];
    t ? uris.push(t.uri) : missed.push(line);
  }
  if (!uris.length) return toast('Niets gevonden om te importeren');
  const made = await newPlaylist([], r.name, { quiet: true, noAsk: true });
  if (!made) return;
  for (let i = 0; i < uris.length; i += 100) await addToPlaylist(made, uris.slice(i, i + 100));
  toast(`${uris.length} nummers geïmporteerd${missed.length ? `, ${missed.length} niet gevonden` : ''}`);
  go('playlist', made.id);
}

/** Een venstertje met meerdere velden. */
function askForm(title, fields) {
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.id = 'ask';
    box.innerHTML = `<form class="ask-box wide"><h3>${esc(title)}</h3>${fields.map(f => `<label class="ask-f"><span>${esc(f.label)}</span>${f.file ? `<input type="file" accept="image/jpeg,image/png" data-k="${f.key}">` : f.area ? `<textarea data-k="${f.key}" rows="${f.rows || 3}" spellcheck="false">${esc(f.value || '')}</textarea>` : `<input data-k="${f.key}" value="${esc(f.value || '')}" spellcheck="false">`}</label>`).join('')}
      <div class="ask-btns"><button type="button" class="ghost">Annuleer</button><button class="primary">OK</button></div></form>`;
    document.body.append(box);
    $('[data-k]', box).focus();
    const done = v => { box.remove(); resolve(v); };
    $('form', box).onsubmit = e => { e.preventDefault(); const out = {}; $$('[data-k]', box).forEach(x => out[x.dataset.k] = x.type === 'file' ? x.files[0] : x.value.trim()); done(out); };
    $('.ghost', box).onclick = () => done(null);
    box.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
  });
}
function confirmBox(title, text = '') {
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.id = 'ask';
    box.innerHTML = `<div class="ask-box"><h3>${esc(title)}</h3>${text ? `<p class="sub">${esc(text)}</p>` : ''}<div class="ask-btns"><button class="ghost">Annuleer</button><button class="primary">Doorgaan</button></div></div>`;
    document.body.append(box);
    $('.primary', box).focus();
    $('.ghost', box).onclick = () => { box.remove(); resolve(false); };
    $('.primary', box).onclick = () => { box.remove(); resolve(true); };
  });
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
async function newPlaylist(uris = [], suggest = '', { quiet, noAsk } = {}) {
  const name = noAsk ? suggest : await ask('Nieuwe playlist', 'Naam', suggest);
  if (!name) return null;
  try {
    const p = await api('/me/playlists', { method: 'POST', body: { name, public: false } })
      .catch(e => e.status === 404 || e.status === 403 ? api(`/users/${S.me.id}/playlists`, { method: 'POST', body: { name, public: false } }) : Promise.reject(e));
    if (uris.length) await addToPlaylist(p, uris);
    renderSide(await myPlaylists(true));
    if (!quiet) go('playlist', p.id);
    return p;
  } catch (e) { toast(e.message); return null; }
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
  m.classList.remove('in'); void m.offsetWidth; m.classList.add('in');
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
  t.classList.remove('in'); void t.offsetWidth; t.classList.add('in');
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
/** Albums die je zelf in de zijbalk hebt gezet (lokaal bewaard, nieuwste bovenaan). */
const sideAlbums = () => store.get('sideAlbums', []);
const inSide = uri => sideAlbums().some(a => a.uri === uri);
async function toggleSideAlbum(uri) {
  const list = sideAlbums();
  if (list.some(a => a.uri === uri)) {
    store.set('sideAlbums', list.filter(a => a.uri !== uri));
    store.set('pins', store.get('pins', []).filter(u => u !== uri));
    const folders = store.get('folders', []);
    folders.forEach(f => f.items = f.items.filter(u => u !== uri));
    store.set('folders', folders);
    toast('Uit de zijbalk');
  } else {
    try {
      const a = await get(`/albums/${uri.split(':')[2]}`, 3600000);
      store.set('sideAlbums', [{ id: a.id, uri: a.uri, name: a.name, images: (a.images || []).slice(-1), artist: (a.artists || []).map(x => x.name).join(', '), album: true }, ...list]);
      toast('In de zijbalk');
    } catch (e) { return toast(e.message); }
  }
  renderSide();
}
/** De zijbalk: vastgezet, mappen (van Spotify en van Spokoe), dan de rest in de volgorde van je bibliotheek. */
function renderSide(list) {
  list = list || myPlaylists.list || store.get('playlists', []);
  const albums = sideAlbums();
  const byUri = new Map([...list, ...albums].map(p => [p.uri, p]));
  const order = store.get('rootlist', null);
  // Volgorde en Spotify-mappen uit de rootlist (als die er is).
  const spotifyFolders = [], ordered = [];
  if (order) {
    let folder = null;
    for (const it of order) {
      if (it.type === 'start') { folder = { id: 'sp:' + it.id, name: it.name, items: [], spotify: true }; spotifyFolders.push(folder); }
      else if (it.type === 'end') folder = null;
      else if (byUri.has(it.uri)) (folder ? folder.items : ordered).push(it.uri);
    }
    for (const p of list) if (!order.some(o => o.uri === p.uri)) ordered.unshift(p.uri);
  } else ordered.push(...list.map(p => p.uri));
  ordered.unshift(...albums.map(a => a.uri));
  const pins = store.get('pins', []).filter(u => byUri.has(u));
  const folders = [...spotifyFolders, ...store.get('folders', [])];
  const inFolder = new Set(folders.flatMap(f => f.items));
  const open = store.get('openFolders', {});
  const btn = p => `<button data-go="${p.album ? 'album' : 'playlist'}:${esc(p.id)}" data-card="${esc(p.uri)}" data-side="${esc(p.uri)}"${p.album ? ' class="side-album"' : ''} title="${esc(p.album ? `${p.name} · ${p.artist}` : p.name)}">${img(p.images, 64, '', p.name)}<span>${esc(p.name)}${p.album ? `<small>Album · ${esc(p.artist)}</small>` : ''}</span>${pins.includes(p.uri) ? '<i class="pin">•</i>' : ''}</button>`;
  $('#side-lists').innerHTML =
    `<button data-go="liked:" data-card="spotify:user:${esc(S.user)}:collection"><div class="ph liked-ph">${icon('heart-on')}</div><span>Nummers die je leuk vindt</span></button>` +
    pins.map(u => btn(byUri.get(u))).join('') +
    folders.map(f => `<div class="folder${open[f.id] ? ' open' : ''}" data-folder="${esc(f.id)}"><button class="folder-head" data-fold="${esc(f.id)}"><div class="ph folder-ph">${icon('folder')}</div><span>${esc(f.name)}</span><i class="chev">${icon('right')}</i></button>
      <div class="folder-items">${f.items.filter(u => byUri.has(u) && !pins.includes(u)).map(u => btn(byUri.get(u))).join('') || '<div class="folder-empty">Sleep playlists of albums hierheen</div>'}</div></div>`).join('') +
    ordered.filter(u => !pins.includes(u) && !inFolder.has(u)).map(u => btn(byUri.get(u))).join('');
  markNow();
}
$('#side-lists').addEventListener('click', e => {
  const f = e.target.closest('[data-fold]');
  if (!f) return;
  e.stopPropagation();
  const open = store.get('openFolders', {});
  open[f.dataset.fold] = !open[f.dataset.fold];
  store.set('openFolders', open);
  f.parentElement.classList.toggle('open', open[f.dataset.fold]);
}, true);

/** Rootlist (volgorde + mappen) op de achtergrond verversen. */
async function refreshRootlist() {
  const r = await soft(rpc('meta', { kind: 'rootlist', arg: '' }));
  if (r?.data) { store.set('rootlist', r.data); renderSide(); }
}

/** Rechtsklik op een playlist in de zijbalk. */
function sideMenu(x, y, uri) {
  const pins = store.get('pins', []);
  const folders = store.get('folders', []);
  const inF = folders.find(f => f.items.includes(uri));
  const place = [
    { label: pins.includes(uri) ? 'Losmaken' : 'Vastzetten bovenaan', fn: () => { store.set('pins', pins.includes(uri) ? pins.filter(u => u !== uri) : [uri, ...pins]); renderSide(); } },
    { label: 'Naar map…', fn: () => folderMenu(x, y, uri) },
    ...(inF ? [{ label: `Uit map “${inF.name}”`, fn: () => { inF.items = inF.items.filter(u => u !== uri); store.set('folders', folders); renderSide(); } }] : []),
  ];
  if (inSide(uri)) return menu(x, y, [
    { label: 'Afspelen', fn: () => playUri(uri) },
    { label: 'Slim shuffelen', fn: () => smartShuffle(uri) },
    { label: 'In de wachtrij', fn: () => queueContext(uri) },
    '-', ...place, '-',
    { label: 'Kopieer link', fn: () => copyLink(uri) },
    { label: 'Uit de zijbalk halen', fn: () => toggleSideAlbum(uri) },
  ]);
  const p = (myPlaylists.list || []).find(q => q.uri === uri);
  if (!p) return;
  const own = p.owner?.id === S.me?.id;
  menu(x, y, [
    { label: 'Afspelen', fn: () => playUri(uri) },
    { label: 'Slim shuffelen', fn: () => smartShuffle(uri) },
    { label: 'In de wachtrij', fn: () => queueContext(uri) },
    '-', ...place, '-',
    ...(own ? [{ label: 'Bewerken…', fn: () => editPlaylist(p) }] : []),
    { label: 'Duplicaten opruimen', fn: () => dedupePlaylist(p) },
    { label: 'Samenvoegen met…', fn: () => mergeMenu(x, y, p) },
    { label: 'Exporteren (CSV)', fn: () => exportPlaylist(p) },
    { label: 'Kopieer link', fn: () => copyLink(uri) },
    '-',
    { label: own ? 'Verwijderen…' : 'Niet meer volgen', fn: () => removePlaylist(p) },
  ]);
}
function folderMenu(x, y, uri) {
  const folders = store.get('folders', []);
  menu(x, y, [{ label: 'Naar map', header: true },
    ...folders.map(f => ({ label: f.name, fn: () => { folders.forEach(g => g.items = g.items.filter(u => u !== uri)); f.items.push(uri); store.set('folders', folders); renderSide(); } })),
    '-', { label: 'Nieuwe map…', fn: async () => { const name = await ask('Nieuwe map', 'Naam'); if (!name) return; folders.forEach(g => g.items = g.items.filter(u => u !== uri)); folders.push({ id: 'f' + Date.now(), name, items: [uri] }); store.set('folders', folders); renderSide(); } }]);
}
function folderHeadMenu(x, y, id) {
  const folders = store.get('folders', []);
  const f = folders.find(g => g.id === id);
  if (!f) return;
  menu(x, y, [
    { label: 'Hernoemen…', fn: async () => { const n = await ask('Map hernoemen', 'Naam', f.name); if (n) { f.name = n; store.set('folders', folders); renderSide(); } } },
    { label: 'Map weghalen (playlists blijven)', fn: () => { store.set('folders', folders.filter(g => g !== f)); renderSide(); } },
  ]);
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
$('#side-lists').addEventListener('dragstart', e => {
  const b = e.target.closest?.('[data-side]');
  if (b) { sideDrag = b.dataset.side; e.dataTransfer.setData('text/plain', sideDrag); }
});
$('#side-lists').addEventListener('dragover', e => {
  const f = e.target.closest('.folder');
  if (sideDrag && f) { e.preventDefault(); $$('.drop').forEach(x => x.classList.remove('drop')); f.classList.add('drop'); return; }
  const b = e.target.closest('button');
  if (!dragged || !b || !canDrop(b)) return;
  e.preventDefault();
  $$('.drop').forEach(x => x !== b && x.classList.remove('drop'));
  b.classList.add('drop');
});
$('#side-lists').addEventListener('dragleave', e => e.target.closest('button')?.classList.remove('drop'));
let sideDrag = null;
$('#side-lists').addEventListener('dragend', () => { sideDrag = null; $$('.drop').forEach(x => x.classList.remove('drop')); });
$('#side-lists').addEventListener('drop', async e => {
  const f = e.target.closest('.folder');
  if (sideDrag && f) {
    e.preventDefault();
    const folders = store.get('folders', []);
    const target = folders.find(g => g.id === f.dataset.folder);
    if (target) { folders.forEach(g => g.items = g.items.filter(u => u !== sideDrag)); target.items.push(sideDrag); store.set('folders', folders); renderSide(); }
    sideDrag = null;
    return;
  }
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

// ——— gemaakt voor jou (door Spokoe) ———
// Spotify geeft zijn eigen Daily Mixes niet meer aan nieuwe apps; deze maakt Spokoe zelf.
const weekNo = () => Math.floor((Date.now() / 864e5 + 3) / 7);
const MADE = {
  async daily() {
    // Je top-artiesten in groepjes van drie: elk groepje een Dagmix.
    const top = await soft(get('/me/top/artists?time_range=medium_term&limit=10', 864e5));
    const artists = top?.items || [];
    const groups = [0, 1, 2, 3].map(g => artists.filter((_, i) => i % 4 === g).slice(0, 3)).filter(g => g.length);
    return groups.map((g, i) => ({ key: 'daily' + i, name: `Dagmix ${i + 1}`, sub: g.map(a => a.name).join(', '), images: g[0]?.images, seeds: g }));
  },
  async build(key) {
    const day = new Date().toISOString().slice(0, 10);
    const cached = store.get('made:' + key, null);
    const fresh = key === 'weekly' ? cached?.week === weekNo() : cached?.day === day;
    if (cached && fresh) return cached.tracks;
    let tracks = [];
    if (key.startsWith('daily')) {
      const d = (await MADE.daily())[+key.slice(5)];
      if (!d) return [];
      const seedTracks = (await Promise.all(d.seeds.map(a => rpc('meta', { kind: 'artistTop', arg: a.id }).then(r => r.data.slice(0, 2), () => [])))).flat();
      // Bekend en nieuw door elkaar: een paar van je favorieten, de rest erbij passend.
      const mix = await mixFor(seedTracks, { count: 40 });
      tracks = [];
      mix.forEach((t, i) => { tracks.push(t); if (i % 4 === 1 && seedTracks.length) tracks.push(seedTracks.shift()); });
    } else if (key === 'weekly') {
      const top = await soft(get('/me/top/tracks?time_range=short_term&limit=20', 864e5));
      const seeds = (top?.items || []).map(t => norm(t)).sort(() => Math.random() - 0.5).slice(0, 3);
      const old = store.get('mixBalance', 0.5);
      store.set('mixBalance', 1);
      const liked = new Set((plCache.get('liked') || []).map(songKey));
      const heard = new Set(store.get('hist', []).map(h => songKey({ name: h.name, artists: [{ name: h.artists[0] }] })));
      tracks = (await mixFor(seeds, { count: 60 })).filter(t => !liked.has(songKey(t)) && !heard.has(songKey(t))).slice(0, 30);
      store.set('mixBalance', old);
    } else if (key === 'radar') {
      // Nieuwe albums en singles (laatste 4 weken) van artiesten die je volgt of veel hoort.
      const [follow, top] = await Promise.all([soft(pages('/me/following?type=artist&limit=50', null, 100)), soft(get('/me/top/artists?time_range=short_term&limit=10', 864e5))]);
      const artists = [...new Map([...(follow || []), ...(top?.items || [])].map(a => [a.id, a])).values()].slice(0, 40);
      const since = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
      const albums = (await Promise.all(artists.map(a => soft(get(`/artists/${a.id}/albums?include_groups=album,single&limit=5`, 864e5)).then(r => r?.items || [])))).flat().filter(al => (al.release_date || '') >= since);
      albums.sort((a, b) => b.release_date.localeCompare(a.release_date));
      for (const al of albums.slice(0, 15)) {
        const full = await soft(get(`/albums/${al.id}`, 864e5));
        tracks.push(...(full?.tracks?.items || []).slice(0, al.album_type === 'single' ? 3 : 2).map(t => norm(t, { name: full.name, id: full.id, images: full.images })));
      }
    }
    store.set('made:' + key, { day, week: weekNo(), tracks: tracks.map(slimT) });
    return tracks;
  },
};
const SMART = {
  'deze-maand': ['Deze maand leuk gevonden', 'Wat je de afgelopen 30 dagen liked', ts => ts.filter(t => t.added && Date.now() - t.added < 30 * 864e5)],
  'nooit-gespeeld': ['Leuk, maar nooit gespeeld', 'Liked songs die je in Spokoe nog niet hoorde', ts => { const h = new Set(store.get('hist', []).map(x => x.uri)); return ts.filter(t => !h.has(t.uri)); }],
  'pareltjes': ['Vergeten pareltjes', 'Meer dan een jaar geleden liked', ts => ts.filter(t => t.added && Date.now() - t.added > 365 * 864e5).sort(() => Math.random() - 0.5).slice(0, 100)],
};

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
  async made(el, key, alive) {
    const daily = key.startsWith('daily') ? (await MADE.daily())[+key.slice(5)] : null;
    const title = daily?.name || { weekly: 'Ontdek wekelijks', radar: 'Releaseradar' }[key] || 'Mix';
    const sub = daily ? `Met ${daily.sub} en meer` : key === 'weekly' ? 'Nummers die je nog nooit hoorde, gekozen op jouw smaak. Elke week nieuw.' : 'Nieuwe albums en singles van artiesten die je volgt of veel hoort.';
    el.innerHTML = `<div class="hero"><div class="cover made-cover big" style="--h:${daily ? (key.slice(5) * 70 + 200) % 360 : key === 'weekly' ? 80 : 140}"><span>${esc(title)}</span></div><div><div class="kind">Gemaakt voor jou door Spokoe</div><h1>${esc(title)}</h1><div class="desc">${esc(sub)}</div></div></div>
      <div class="actions"><button class="big-play" id="m-play">${icon('play')}</button><button class="pill" id="m-save">Bewaar als playlist</button><button class="pill" id="m-new">Vernieuwen</button></div><div id="m-list"><div class="loading-more">Wordt gemaakt…</div></div>`;
    $('#top-title').textContent = title;
    const tracks = await MADE.build(key);
    if (!alive()) return;
    $('#m-list', el).innerHTML = '';
    const L = trackList($('#m-list', el), tracks);
    $('#m-play', el).onclick = () => { S.ctx = null; S.mix = { list: tracks.map(slimT), label: title }; store.set('mix', S.mix); play({ tracks: tracks.map(t => t.uri) }); };
    $('#m-save', el).onclick = () => newPlaylist(tracks.map(t => t.uri), title + ' · ' + new Date().toLocaleDateString('nl-NL'));
    $('#m-new', el).onclick = () => { localStorage.removeItem('spotimfy:made:' + key); show(cur); };
    return L;
  },

  async smart(el, key, alive) {
    const [title, sub, pick] = SMART[key] || [];
    if (!pick) return;
    const L = await collection(el, { kind: 'Slimme playlist', title, desc: sub, liked: true, uri: null }, alive);
    const tracks = pick(plCache.get('liked') || (await pages('/me/tracks?limit=50', null, 3000)).map(x => withAdded(norm(x.track), x)).filter(Boolean));
    if (alive()) L.set(tracks);
  },

  async home(el, _, alive) {
    const name = S.me?.display_name?.split(' ')[0];
    el.innerHTML = `<h1 class="page">${greeting()}${name ? ', ' + esc(name) : ''}</h1>
      <div class="actions" style="padding-top:0;margin:-8px 0 14px"><button class="pill" id="h-random">${icon('disc')} Willekeurig album</button><button class="pill" id="h-mix">${icon('shuffle')} Mix van mijn favorieten</button></div>
      <div class="quick" id="h-quick"></div>
      <section id="h-made"></section><section id="h-recent"></section><section id="h-top"></section><section id="h-lists"></section><section id="h-albums"></section>`;
    $('#top-title').textContent = 'Home';
    $('#h-random', el).onclick = randomAlbum;
    $('#h-mix', el).onclick = async () => {
      // Een mix op basis van een paar nummers die je vaak hoort.
      toast('Mix wordt gemaakt…');
      const top = await soft(get('/me/top/tracks?time_range=short_term&limit=10', 3600000));
      const seeds = (top?.items || []).sort(() => Math.random() - 0.5).slice(0, 3).map(t => norm(t));
      if (!seeds.length) return toast('Nog te weinig geluisterd voor een mix');
      const mix = await mixFor(seeds, { count: 50 });
      S.ctx = null;
      S.mix = { list: [...seeds.slice(0, 1), ...mix].map(t => ({ uri: t.uri, name: t.name, artists: t.artists })), label: 'Mix van je favorieten' };
      store.set('mix', S.mix);
      play({ tracks: S.mix.list.map(t => t.uri) });
    };
    const playlists = myPlaylists.list || store.get('playlists', []);
    const tiles = list => { $('#h-quick', el).innerHTML = list.slice(0, 8).map(o => `<div class="tile" data-go="${esc(o.go)}" data-card="${esc(o.uri)}">${o.go === 'liked:' ? `<div class="ph liked-ph">${icon('heart-on')}</div>` : img(o.images, 64, '', o.name)}<span>${esc(o.name)}</span><button class="play" data-play="${esc(o.uri)}">${icon('play')}</button></div>`).join(''); };
    const fromLists = playlists.slice(0, 8).map(p => ({ go: 'playlist:' + p.id, uri: p.uri, images: p.images, name: p.name }));
    tiles([{ go: 'liked:', uri: `spotify:user:${S.user}:collection`, images: [], name: 'Nummers die je leuk vindt' }, ...fromLists]);
    MADE.daily().then(daily => {
      if (!alive()) return;
      const cards = [...daily.map(d => ({ go: 'made:' + d.key, name: d.name, sub: d.sub, art: d.name, h: (d.key.slice(5) * 70 + 200) % 360 })),
        { go: 'made:weekly', name: 'Ontdek wekelijks', sub: 'Nieuw voor jou, elke week vers', art: 'Ontdek', h: 80 },
        { go: 'made:radar', name: 'Releaseradar', sub: 'Nieuw van jouw artiesten', art: 'Radar', h: 140 },
        ...Object.entries(SMART).map(([k, [n, sub]], i) => ({ go: 'smart:' + k, name: n, sub, art: n, h: 20 + i * 50 }))];
      $('#h-made', el).innerHTML = `<h2>Gemaakt voor jou</h2><div class="row-scroll">${cards.map(c => `<div class="card" data-go="${c.go}"><div class="cover made-cover" style="--h:${c.h}"><span>${esc(c.art)}</span></div><div class="t">${esc(c.name)}</div><div class="s">${esc(c.sub)}</div></div>`).join('')}</div>`;
    });
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
    const own = p.owner?.id === S.me?.id;
    const L = await collection(el, {
      kind: 'Playlist', title: p.name, images: p.images, uri: p.uri, desc: p.description,
      follow: !own && p.uri, reorder: own ? p : null,
      more: anchor => menuAt(anchor, [
        ...(own ? [{ label: 'Bewerken…', fn: () => editPlaylist(p) }, { label: 'Duplicaten opruimen', fn: () => dedupePlaylist(p) }] : []),
        { label: 'Samenvoegen met…', fn: () => { const r = anchor.getBoundingClientRect(); mergeMenu(r.left, r.bottom, p); } },
        { label: 'Exporteren (CSV)', fn: () => exportPlaylist({ ...p, tracks: L.L?.tracks }) },
        { label: 'In de wachtrij', fn: () => queueContext(p.uri) },
        { label: 'Kopieer link', fn: () => copyLink(p.uri) },
        ...(own ? ['-', { label: 'Verwijderen…', fn: () => removePlaylist(p) }] : []),
      ]),
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
      album: false, numbers: true, cover: false, save: a.uri, sleeve: true,
      more: anchor => menuAt(anchor, [{ label: 'In de wachtrij', fn: () => queueContext(a.uri) }, { label: inSide(a.uri) ? 'Uit de zijbalk halen' : 'In de zijbalk zetten', fn: () => toggleSideAlbum(a.uri) }, { label: 'Kopieer link', fn: () => copyLink(a.uri) }]),
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
      <button class="pill" id="a-radio">Artiestenradio</button><button class="pill" id="a-all">Alles van ${esc(a.name)}</button><button class="pill" id="a-disco">Discografie</button><button class="pill" id="a-follow">Volgen</button></div>
      <section id="a-top"></section><section id="a-albums"></section><section id="a-singles"></section>`;
    tint(el, a.images);
    updateBigPlay($('.big-play', el));
    $('#a-radio', el).onclick = () => { toast('Radio wordt gemaakt…'); playMix({ uri: a.uri, name: a.name, artists: [{ name: a.name, id: a.id }] }); };
    $('#a-all', el).onclick = e => menuAt(e.currentTarget, [
      { label: 'Op volgorde (nieuwste eerst)', fn: () => playArtistAll(a, { order: 'new' }) },
      { label: 'Geshuffeld', fn: () => playArtistAll(a, { order: 'shuffle' }) },
    ]);
    $('#a-disco', el).onclick = () => playArtistAll(a, { order: 'old', albumsOnly: true });
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
    // Wat Spokoe zelf heeft bijgehouden.
    const time = store.get('time', {});
    const days = [...Array(7)].map((_, i) => { const d = new Date(Date.now() - (6 - i) * 864e5); return { k: d.toISOString().slice(0, 10), label: d.toLocaleDateString('nl-NL', { weekday: 'long' }) }; });
    const max = Math.max(60, ...days.map(d => time[d.k] || 0));
    const week = days.reduce((s, d) => s + (time[d.k] || 0), 0);
    const at = Object.entries(store.get('artistTime', {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
    $('#st-time', el).innerHTML = `<h2>Luistertijd in Spokoe <span class="sub" style="font-size:13px;font-weight:500">${Math.round(week / 60)} minuten deze week</span></h2>
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
      <div class="box"><h3>Account</h3><p>Ingelogd als <b style="color:var(--ink)">${esc(S.me?.display_name || S.user || '')}</b>${S.me?.product ? ` (${esc(S.me.product)})` : ''}. Dit apparaat heet in Spotify Connect <b style="color:var(--ink)">${esc(S.deviceName || 'Spokoe')}</b>.</p>
        <div class="field"><button class="ghost" id="set-logout">Uitloggen</button></div></div>
      <div class="box"><h3>Eigen Client ID</h3>
        <p>Voor de bibliotheek, zoeken en statistieken gebruikt Spokoe de Web API. Met een eigen app in het Spotify-dashboard heb je daar een eigen limiet voor.</p>
        <ol><li>Ga naar <a class="link" style="color:var(--accent)" href="https://developer.spotify.com/dashboard">developer.spotify.com/dashboard</a> en kies <b>Create app</b>.</li>
        <li>Redirect URI: <code>${esc(S.redirect || 'http://127.0.0.1:8888/callback')}</code>, en vink <b>Web API</b> aan.</li>
        <li>Kopieer het <b>Client ID</b> hieronder. De eerste keer opent je browser één keer om toestemming te vragen.</li></ol>
        <div class="field"><input id="set-cid" placeholder="Client ID (leeg = ingebouwd)" value="${esc(S.clientId)}" spellcheck="false"><button class="primary" id="set-save">Opslaan</button></div></div>
      <div class="box"><h3>Uiterlijk</h3><div class="seg" id="set-theme"><button data-t="system">Systeem</button><button data-t="dark">Spokoe</button><button data-t="light">Licht</button><button data-t="vinyl">Vinyl</button><button data-t="vinyl-dark">Vinyl donker</button></div>
        <p style="margin-top:10px">De vinyl-thema's geven Spokoe de sfeer van een platenkast: papier of notenhout, schreefletters, en wat er speelt draait als plaat.</p></div>
      <div class="box"><h3>Mixen en shuffle</h3><p>Hoe Spokoe kiest als je geen playlist luistert, en bij slim shuffelen.</p>
        <div class="row-set"><span>Vertrouwd</span><input type="range" id="set-balance" min="0" max="1" step="0.05" value="${store.get('mixBalance', 0.5)}"><b>Ontdekken</b></div></div>
      <div class="box" id="audio-box"><h3>Geluid</h3><div class="empty" style="padding:10px 0">Laden…</div></div>
      <div class="box"><h3>Eiland</h3><p>Bij een nieuw nummer schuift bovenaan je scherm even een pil in met de hoes en de titel, als Spokoe niet voorop staat.</p>
        <div class="seg" id="set-island"><button data-v="1">Aan</button><button data-v="0">Uit</button></div></div>
      <div class="box"><h3>Sneltoetsen</h3><p>
        <kbd>spatie</kbd> afspelen/pauzeren · <kbd>⌘K</kbd> of <kbd>/</kbd> zoeken · <kbd>⌘→</kbd> <kbd>⌘←</kbd> volgende/vorige · <kbd>⇧→</kbd> <kbd>⇧←</kbd> 10 s verder/terug ·
        <kbd>⌘↑</kbd> <kbd>⌘↓</kbd> volume · <kbd>⌘L</kbd> songtekst · <kbd>⌘J</kbd> wachtrij · <kbd>⌘D</kbd> vind ik leuk · <kbd>⌘S</kbd> shuffle · <kbd>F</kbd> Nu speelt · <kbd>⌥⌘M</kbd> minispeler · sleep nummers naar een playlist in de zijbalk</p></div>
      <div class="box"><h3>Bijwerken</h3><p id="upd-text">Spokoe kijkt één keer per dag of er een nieuwe versie is.</p><div class="field"><button class="ghost" id="upd-check">Zoek nu naar updates</button><button class="primary" id="upd-go" hidden>Bijwerken en opnieuw openen</button></div></div>
      <div class="box"><h3>Over Spokoe</h3><p>Een eigen speler voor Spotify Premium, gebouwd in Rust met librespot. Liedjes die je vaker draait worden lokaal bewaard (tot 2 GB), zodat ze meteen beginnen.</p></div>
    </div>`;
    $$('#set-theme button', el).forEach(b => b.classList.toggle('on', b.dataset.t === theme));
    const segPick = (id, key, cur, toVal) => {
      $$(`#${id} button`, el).forEach(b => b.classList.toggle('on', b.dataset.v === String(cur)));
      $('#' + id, el).onclick = e => { const b = e.target.closest('button'); if (!b) return; const v = toVal(b.dataset.v); store.set(key, v); post('setting', { key, value: v }); $$(`#${id} button`, el).forEach(x => x.classList.toggle('on', x === b)); toast('Geldt vanaf de volgende start'); };
    };
    audioSettings($('#audio-box', el));
    const showUpdate = u => {
      $('#upd-text', el).textContent = u.error ? `Versie ${u.current}. ${u.error[0].toUpperCase() + u.error.slice(1)}.` : u.newer ? `Versie ${u.latest} is er (jij hebt ${u.current}).` : `Je hebt de nieuwste versie (${u.current}).`;
      $('#upd-go', el).hidden = !(u.newer && u.url);
      $('#upd-go', el).onclick = () => { toast('Bijwerken…'); post('installUpdate', { url: u.url }); };
    };
    $('#upd-check', el).onclick = async () => showUpdate((await rpc('checkUpdate')).data);
    $('#set-balance', el).onchange = e => { store.set('mixBalance', +e.target.value); toast('Opgeslagen'); };
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
  const art = o.liked ? `<div class="ph liked-ph" style="width:210px;height:210px;border-radius:12px">${icon('heart-on')}</div>`
    : o.sleeve ? `<div class="sleeve" data-ctx="${esc(o.uri)}"><div class="disc" style="--cover:url('${esc(pic(o.images, 300))}')"><i></i></div>${img(o.images, 300, 'jacket')}</div>`
    : img(o.images, 300, '', o.title);
  el.innerHTML = `<div class="hero${o.sleeve ? ' has-sleeve' : ''}">${art}
    <div style="min-width:0"><div class="kind">${esc(o.kind)}</div><h1>${esc(o.title)}</h1>${o.desc ? `<div class="desc">${o.desc.replace(/<[^>]+>/g, '')}</div>` : ''}<div class="meta">${o.meta || ''} <span class="c-count"></span></div></div></div>
    <div class="actions"><button class="big-play" data-ctx="${esc(o.uri)}">${icon('play')}</button>
    <button class="pill" id="c-smart" title="Shuffle die echt husselt, en wat je net hoorde naar achteren schuift">${icon('shuffle')} Slim shuffelen</button>
    ${o.follow ? `<button class="pill" id="c-follow">Volgen</button>` : ''}${o.save ? `<button class="pill" id="c-save">Bewaren</button>` : ''}
    ${o.more ? `<button class="icon" id="c-more" title="Meer">${icon('more')}</button>` : ''}
    <input class="filter" id="c-filter" placeholder="Zoek in de lijst…"></div><div id="c-list">${Array.from({ length: 8 }, () => '<div class="skel-row"><i class="skel"></i><div><b class="skel"></b><b class="skel short"></b></div></div>').join('')}</div>`;
  tint(el, o.images);
  $('.sleeve', el)?.addEventListener('click', () => openSleeve(o));
  // Volgen (playlist van een ander) of bewaren (album): via je bibliotheek.
  for (const [id, uri, on, off] of [['#c-follow', o.follow, 'Gevolgd', 'Volgen'], ['#c-save', o.save, 'Bewaard', 'Bewaren']]) {
    const b = $(id, el);
    if (!b) continue;
    soft(api('/me/library/contains?uris=' + uri)).then(r => { if (Array.isArray(r)) { b.classList.toggle('on', r[0]); b.textContent = r[0] ? on : off; } });
    b.onclick = async () => {
      const want = !b.classList.contains('on');
      try { await api('/me/library?uris=' + uri, { method: want ? 'PUT' : 'DELETE' }); b.classList.toggle('on', want); b.textContent = want ? on : off; toast(want ? on : 'Uit je bibliotheek'); if (o.follow) renderSide(await myPlaylists(true)); } catch (e) { toast(e.message); }
    };
  }
  $('#c-more', el)?.addEventListener('click', e => o.more(e.currentTarget));
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
      if (!L) { listEl.innerHTML = ''; L = coll.L = trackList(listEl, list, { ctx: { uri: o.uri }, album: o.album !== false, numbers: o.numbers, cover: o.cover !== false, reorder: o.reorder }); }
      else { const scroll = $('#view').scrollTop; L.tracks = list; L.filter(); $('#view').scrollTop = scroll; }
      $('.c-count', el).textContent = extraMeta || `· ${list.length} nummers`;
      // Na een herstart: terug naar waar je was in de lijst.
      if (restoreScroll && list.length * ROW > restoreScroll) { $('#view').scrollTop = restoreScroll; restoreScroll = 0; }
    },
    meta(t) { extraMeta = t; $('.c-count', el).textContent = t; },
  };
  return coll;
}

/** Klik op een albumhoes: de hoes en de plaat groot naast elkaar. */
function openSleeve(o) {
  const big = pic(o.images, 640);
  const box = $('#sleeve-big');
  box.innerHTML = `<div class="sb-bg" style="background-image:url('${esc(big)}')"></div>
    <div class="sb-stage"><img class="sb-jacket" src="${esc(big)}" alt="">
    <div class="disc sb-disc" style="--cover:url('${esc(big)}')"><i></i></div></div>
    <div class="sb-title">${esc(o.title)}</div>`;
  box.hidden = false;
  box.classList.remove('in'); void box.offsetWidth; box.classList.add('in');
  sleeveSpin();
}
function closeSleeve() { $('#sleeve-big').hidden = true; $('#sleeve-big').innerHTML = ''; }
/** Draait als dit album speelt, net als de kleine plaat op de albumpagina. */
function sleeveSpin() { $('#sleeve-big').classList.toggle('spin', !!$('.sleeve.spin')); }
$('#sleeve-big').addEventListener('click', closeSleeve);

/** Een zachte kleur uit de hoes achter de kop. */
function tint(el, images) {
  const u = pic(images, 64);
  const big = pic(images, 300);
  if (big) $('.hero', el)?.style.setProperty('--hero-img', `url("${big}")`);
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
  if (t && Date.now() - t.at < 864e5) return taste.cache = { top: new Set(t.top), liked: new Map(t.liked) };
  const [a, b, l] = await Promise.all([
    soft(get('/me/top/artists?time_range=short_term&limit=10', 864e5)),
    soft(get('/me/top/artists?time_range=medium_term&limit=10', 864e5)),
    soft(pages('/me/tracks?limit=50', null, 400)),
  ]);
  const top = [...(a?.items || []), ...(b?.items || [])].map(x => x.name.toLowerCase());
  const liked = new Map();
  for (const x of l || []) for (const ar of x.track?.artists || []) liked.set(ar.name.toLowerCase(), (liked.get(ar.name.toLowerCase()) || 0) + 1);
  store.set('taste', { at: Date.now(), top, liked: [...liked] });
  return taste.cache = { top: new Set(top), liked };
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
  if (!mix && !isArtist) first.then(more => { S.mix.list.push(...more.map(t => ({ uri: t.uri, name: t.name, artists: t.artists }))); queueAdd(more.slice(0, 20), { auto: true }); });
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
  queueAdd(more, { auto: true });
  m.refilling = false;
}

/** Nummers achter de huidige zetten (via de wachtrij van Spotify). */
async function queueUris(uris) {
  for (const u of uris) await soft(api('/me/player/queue?uri=' + encodeURIComponent(u), { method: 'POST' }));
}

/** Alle nummers van een artiest: nieuwste eerst, geshuffeld, of als discografie (eerste album tot laatste). */
async function playArtistAll(a, { order, albumsOnly } = {}) {
  toast(albumsOnly ? 'Discografie ophalen…' : 'Alles van ' + a.name + ' ophalen…');
  const groups = albumsOnly ? 'album' : 'album,single';
  const albums = (await pages(`/artists/${a.id}/albums?include_groups=${groups}&limit=10`, null, 80)).filter(Boolean);
  albums.sort((x, y) => (x.release_date || '').localeCompare(y.release_date || ''));
  if (order === 'new') albums.reverse();
  let tracks = [];
  const seen = new Set();
  for (const al of albums) {
    const full = await soft(get(`/albums/${al.id}`, 3600000));
    for (const t of full?.tracks?.items || []) {
      // Alleen nummers waar deze artiest echt op staat, en geen dubbele versies.
      if (!t.artists.some(x => x.id === a.id)) continue;
      const k = songKey(t);
      if (seen.has(k) && !albumsOnly) continue;
      seen.add(k);
      tracks.push(norm(t, { name: full.name, id: full.id, images: full.images }));
    }
  }
  if (!tracks.length) return toast('Niets gevonden');
  if (order === 'shuffle') return smartShuffle(a.uri, tracks);
  S.ctx = null; S.mix = null;
  play({ tracks: tracks.slice(0, 700).map(t => t.uri) });
  toast(`${albumsOnly ? 'Discografie' : 'Alles van ' + a.name}: ${tracks.length} nummers`);
}

/** Een willekeurig album uit je bibliotheek. */
async function randomAlbum() {
  const list = await pages('/me/albums?limit=50', null, 2000);
  const pick = list.filter(x => x?.album)[Math.floor(Math.random() * list.length)]?.album;
  if (!pick) return toast('Je hebt nog geen albums bewaard');
  go('album', pick.id);
  S.mix = null;
  playUri(pick.uri);
  toast(`Willekeurig album: ${pick.name}`);
}

/** Uit (of terug in) shuffle en mixen, zonder het te ontliken. */
function toggleNoShuffle(t) {
  const set = noShuffle();
  const on = !set.has(t.uri);
  on ? set.add(t.uri) : set.delete(t.uri);
  store.set('noShuffle', [...set]);
  toast(on ? `“${t.name}” komt niet meer in shuffle en mixen` : `“${t.name}” mag weer in shuffle en mixen`);
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
  const banned = noShuffle();
  tracks = tracks.filter(t => t.playable !== false && !t.episode && !banned.has(t.uri));
  if (!tracks.length) return;
  const recent = new Map(store.get('hist', []).map((h, i) => [h.uri, i]));
  const a = [...tracks];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  const fresh = a.filter(t => !recent.has(t.uri) || recent.get(t.uri) > 400);
  const heard = a.filter(t => recent.has(t.uri) && recent.get(t.uri) <= 400).sort((x, y) => recent.get(y.uri) - recent.get(x.uri));
  // Instelling: meer wat je weinig hoort (ontdekken) of meer je favorieten.
  const balance = store.get('mixBalance', 0.5);
  const favs = taste.cache;
  if (favs && balance !== 0.5) {
    const w = t => (favs.top.has((t.artists[0]?.name || '').toLowerCase()) ? 1 : 0) + Math.min(1, (favs.liked.get((t.artists[0]?.name || '').toLowerCase()) || 0) / 5);
    // Een zachte voorkeur: willekeurig blijft het, maar de kans schuift.
    fresh.sort((x, y) => (Math.random() + (balance < 0.5 ? -w(x) : w(x)) * Math.abs(balance - 0.5)) - (Math.random() + (balance < 0.5 ? -w(y) : w(y)) * Math.abs(balance - 0.5)));
  }
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

/** Zoeken in wat Spokoe al weet: je playlists en de nummers daarin. */
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
  $('#b-queue').classList.toggle('on', S.panel === 'queue' || S.panel === 'history');
  $$('#panel-tabs button').forEach(b => b.classList.toggle('on', b.dataset.p === S.panel));
  if (S.panel === 'queue' || S.panel === 'history') renderQueue();
  if (S.panel === 'lyrics') renderLyricsPanel();
}
$('#panel-close').onclick = () => togglePanel(S.panel);
$('#panel-tabs').onclick = e => { const b = e.target.closest('button'); if (b && b.dataset.p !== S.panel) togglePanel(b.dataset.p); };

async function renderQueue() {
  const body = $('#panel-body');
  if (S.panel !== 'queue' && S.panel !== 'history') return;
  if (S.panel === 'history') return renderHistory();
  const row = (t, extra = '') => `<div class="q${extra}" data-uri="${esc(t.uri)}">${img(t.album?.images, 64)}<div><div class="t">${esc(t.name)}</div><div class="a">${esc(t.artists.map(a => a.name).join(', '))}</div></div></div>`;
  if (!S.track) { body.innerHTML = '<div class="empty">Speel iets af om de wachtrij te zien.</div>'; return; }
  const from = S.mix?.label || (S.ctx && ((myPlaylists.list || []).find(p => p.uri === S.ctx)?.name || $('.hero h1')?.textContent));
  const mine = Q.items.map((t, i) => ({ t, i })).filter(x => !x.t.auto), auto = Q.items.map((t, i) => ({ t, i })).filter(x => x.t.auto);
  const item = ({ t, i }) => `<div class="q qi" data-qi="${i}" data-uri="${esc(t.uri)}" draggable="true">${img(t.album?.images, 64)}<div><div class="t">${esc(t.name)}</div><div class="a">${esc(t.artists.map(a => a.name).join(', '))}</div></div><button class="icon q-x" data-qx="${i}" title="Uit de wachtrij">${icon('x')}</button></div>`;
  // Wat Spotify daarna speelt (uit de playlist, het album of de mix), zonder wat hierboven al staat.
  const own = new Set([S.track, Q.ready, ...Q.items].filter(Boolean).map(songKey));
  const upcoming = (await soft(api('/me/player/queue')))?.queue?.map(t => norm(t)).filter(t => t && !own.has(songKey(t))) || [];
  if (S.panel !== 'queue') return;
  const seenUp = new Set();
  const later = upcoming.filter(t => !seenUp.has(songKey(t)) && seenUp.add(songKey(t))).slice(0, 30);
  body.innerHTML = `<h4>Speelt nu${from ? ` · ${esc(from)}` : ''}</h4>${row(S.track, ' now')}
    ${Q.ready ? `<h4>Staat klaar</h4>${row(Q.ready)}` : ''}
    <h4 class="q-head">Jouw wachtrij ${mine.length ? `<span><button class="link" id="q-share">Delen</button> · <button class="link" id="q-save">Bewaar als playlist</button> · <button class="link" id="q-clear">Wissen</button></span>` : ''}</h4>
    ${mine.map(item).join('') || '<div class="q-empty">Rechtsklik op een nummer › Speel hierna, of sleep een nummer hierheen.</div>'}
    ${auto.length ? `<h4>Daarna${S.mix ? ' · mix' : ''}</h4>${auto.slice(0, 30).map(item).join('')}` : ''}
    ${later.length ? `<h4>Daarna${from ? ` uit ${esc(from)}` : ''}</h4>${later.map(t => row(t, ' later')).join('')}` : ''}
    ${!mine.length && !auto.length && !later.length && !Q.ready ? '<div class="empty">Na dit nummer stopt het afspelen.</div>' : ''}`;
  const all = [S.track, Q.ready, ...Q.items, ...later];
  $$('.q', body).forEach(el => { el._track = Q.items[+el.dataset.qi] || all.find(t => t?.uri === el.dataset.uri); });
  $$('[data-qx]', body).forEach(b => b.onclick = e => { e.stopPropagation(); Q.items.splice(+b.dataset.qx, 1); Q.save(); });
  $$('.qi', body).forEach(el => el.ondblclick = () => { const t = Q.items.splice(+el.dataset.qi, 1)[0]; Q.save(); play({ tracks: [t.uri] }); });
  // Een nummer verderop: zoveel keer volgende tot je er bent.
  $$('.q.later', body).forEach((el, i) => el.ondblclick = async () => { const skips = (Q.ready ? 1 : 0) + Q.items.filter(x => !x.auto).length + i + 1; for (let k = 0; k < skips; k++) { post('next'); await sleep(120); } });
  const mineTracks = () => Q.items.filter(x => !x.auto);
  $('#q-clear')?.addEventListener('click', () => { Q.items = Q.items.filter(x => x.auto); Q.save(); });
  $('#q-save')?.addEventListener('click', () => newPlaylist(mineTracks().map(t => t.uri), 'Wachtrij ' + new Date().toLocaleDateString('nl-NL')));
  $('#q-share')?.addEventListener('click', async () => {
    // Delen = een playlist maken met je wachtrij en de link kopiëren.
    const p = await newPlaylist(mineTracks().map(t => t.uri), 'Wachtrij van ' + (S.me?.display_name || 'mij'), { quiet: true });
    if (p) { post('copy', { text: `https://open.spotify.com/playlist/${p.id}` }); toast('Link naar je wachtrij gekopieerd'); }
  });
}

/** Slepen binnen de wachtrij (volgorde) en nummers erheen slepen. */
let qDrag = null;
$('#panel-body').addEventListener('dragstart', e => { const el = e.target.closest?.('.qi'); if (el) { qDrag = +el.dataset.qi; e.dataTransfer.effectAllowed = 'move'; } });
$('#panel-body').addEventListener('dragover', e => { if (S.panel === 'queue' && (qDrag != null || dragged)) { e.preventDefault(); $$('.q-drop').forEach(x => x.classList.remove('q-drop')); e.target.closest('.qi')?.classList.add('q-drop'); } });
$('#panel-body').addEventListener('drop', e => {
  if (S.panel !== 'queue') return;
  e.preventDefault();
  const target = e.target.closest('.qi');
  const to = target ? +target.dataset.qi : Q.items.filter(x => !x.auto).length;
  if (qDrag != null) {
    const [t] = Q.items.splice(qDrag, 1);
    Q.items.splice(to > qDrag ? to - 1 : to, 0, { ...t, auto: target ? Q.items[Math.min(to, Q.items.length - 1)]?.auto && t.auto : false });
    Q.save();
  } else if (dragged) {
    Q.items.splice(to, 0, { ...slimT(dragged), auto: false });
    Q.save();
    queueFeed();
  }
  qDrag = null;
});
$('#panel-body').addEventListener('dragend', () => { qDrag = null; $$('.q-drop').forEach(x => x.classList.remove('q-drop')); });

/** Wat je de afgelopen 24 uur hoorde. */
function renderHistory() {
  const h = store.get('hist', []).filter(x => Date.now() - x.t < 864e5);
  $('#panel-body').innerHTML = `<h4>Afgelopen 24 uur · ${h.length} nummers</h4>` + (h.map(x => `<div class="q" data-uri="${esc(x.uri)}"><img src="${esc(x.cover)}" alt=""><div><div class="t">${esc(x.name)}</div><div class="a">${esc(x.artists.join(', '))} · ${new Date(x.t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}</div></div></div>`).join('') || '<div class="empty">Nog niets gehoord vandaag.</div>');
  $$('#panel-body .q').forEach(el => { const x = h.find(y => y.uri === el.dataset.uri); el._track = x && { uri: x.uri, name: x.name, artists: x.artists.map(name => ({ name })), album: { name: '', images: [{ url: x.cover }] } }; el.ondblclick = () => el._track && playMix(el._track); });
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
/** Nu speelt dichtschuiven (eerst de animatie, dan pas weg). */
function closeLyricsFull() {
  const lf = $('#lyrics-full');
  if (lf.hidden || lf.classList.contains('closing')) return;
  lf.classList.add('closing');
  setTimeout(() => { lf.hidden = true; lf.classList.remove('closing'); glisseSync(); }, 260);
}

function openLyricsFull() {
  if (!S.track) return;
  $('#lyrics-full').classList.remove('closing');
  $('#lyrics-full').hidden = false;
  glisseSync();
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
$('#lyrics-full .lf-close').onclick = () => closeLyricsFull();
new MutationObserver(() => glisseSync()).observe($('#lyrics-full'), { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(() => glisseSync()).observe($('#panel'), { attributes: true, attributeFilter: ['hidden'] });
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
  ['Thema: vinyl', 'vinyl klassiek retro thema plaat', () => { store.set('theme', 'vinyl'); applyTheme(); }],
  ['Thema: vinyl donker', 'vinyl donker hout retro thema', () => { store.set('theme', 'vinyl-dark'); applyTheme(); }],
  ['Nieuwe playlist', 'playlist maken nieuw', () => newPlaylist()],
  ['Willekeurig album', 'random album verras', () => randomAlbum()],
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
    if (!$('#sleeve-big').hidden) return closeSleeve();
    if (!$('#lyrics-full').hidden) return closeLyricsFull();
    if (typing) return e.target.blur();
  }
  if (typing || !$('#palette').hidden) return;
  if (e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
  if (e.metaKey || e.ctrlKey) return;
  if (e.key === ' ') { e.preventDefault(); return S.track ? ctl('toggle') : resumeSomething(); }
  if (e.key === '/') { e.preventDefault(); return openPalette(); }
  if (e.key === 'f' || e.key === 'F') return $('#lyrics-full').hidden ? openLyricsFull() : closeLyricsFull();
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

/** Terugknop (Android): eerst sluiten wat open staat, dan een pagina terug. */
window.spokoeBack = () => {
  const ask = $('#ask');
  if (ask) { ask.remove(); return true; }
  if (!$('#menu').hidden || !$('#palette').hidden) { closeOverlays(); return true; }
  if (!$('#lyrics-full').hidden) { closeLyricsFull(); return true; }
  if (S.panel) { togglePanel(S.panel); return true; }
  if (hist.length) { back(); return true; }
  if (cur?.where !== 'home') { go('home'); return true; }
  return false;
};

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
  document.documentElement.classList.toggle('vinyl', t.startsWith('vinyl'));
  // De titelbalk en schuifbalken van het venster in dezelfde kleur.
  post('theme', { dark: t === 'dark' || t === 'vinyl-dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches), vinyl: t.startsWith('vinyl') ? t : null });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();

// ——— opstarten ———
async function start() {
  setupGlisse();
  const cachedLists = store.get('playlists', null);
  if (cachedLists) renderSide(cachedLists);
  const was = store.get('page', null);
  restoreScroll = was?.scroll || 0;
  go(was?.where && was.where !== 'settings' ? was.where : 'home', was?.where ? was.arg ?? undefined : undefined, false);
  soft(api('/me')).then(me => { if (me) { S.me = me; store.set('me', me); } });
  myPlaylists(true).then(renderSide).catch(e => toast('Bibliotheek laden lukte niet: ' + e.message));
  refreshRootlist();
  // Eén keer per dag stil kijken of er een nieuwe versie is.
  if (Date.now() - store.get('updCheck', 0) > 864e5) setTimeout(async () => {
    store.set('updCheck', Date.now());
    const u = (await rpc('checkUpdate').catch(() => ({}))).data;
    if (u?.newer && u.url) toast(`Spokoe ${u.latest} is er: Instellingen › Bijwerken`);
  }, 8000);
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
// ——— Liquid Glass-navigatie (alleen de Android-app, zoals in de andere Tim-apps) ———
// Glisse (https://github.com/0kzh/glisse, MIT) tekent de zwevende balk met echte breking. Kan het
// toestel het niet aan (of hapert het scrollen), dan blijft de gewone balk.
async function setupGlisse() {
  if (!document.documentElement.classList.contains('android') || document.documentElement.classList.contains('tablet')) return;
  let g;
  try { g = await import('./lib/glisse.js'); } catch { return; }
  if (!g.kan()) return;
  const tabs = [...$$('.mnav-pill button')].map(b => ({ id: b.dataset.go, title: b.querySelector('span').textContent, svg: `<svg viewBox="0 0 24 24" fill="currentColor">${$(b.querySelector('use').getAttribute('href')).innerHTML}</svg>` }));
  const addSvg = `<svg viewBox="0 0 24 24" fill="currentColor">${$('#i-search').innerHTML}</svg>`;
  const bar = g.balk({ onNav: id => go(id === 'add' ? 'search' : id), onStop: () => document.documentElement.classList.remove('glisse'), z: 21 });
  document.documentElement.classList.add('glisse');
  const sync = () => {
    const p = $('.mnav-pill').getBoundingClientRect(), a = $('.mnav-add').getBoundingClientRect();
    const dark = getComputedStyle(document.documentElement).colorScheme !== 'light';
    bar.update({ pill: { x: p.left, y: p.top, w: p.width, h: p.height }, add: { x: a.left, y: a.top, w: a.width, h: a.height }, tabs, active: cur?.where, dark, visible: $('#lyrics-full').hidden && !S.panel, addSvg, addLabel: 'Zoeken' });
  };
  setupGlisse.sync = sync;
  sync();
  addEventListener('resize', sync);
}
const glisseSync = () => setupGlisse.sync?.();

// Vloeiend: elk beeldje bijwerken zolang het venster zichtbaar is, anders rustig.
(function frame() { tick(); document.hidden ? setTimeout(frame, 1000) : requestAnimationFrame(frame); })();

// Handdruk met de kern: blijven melden tot die antwoordt (het eerste bericht kan verloren gaan).
(function hello() { if (!S.redirect) { post('ready'); setTimeout(hello, 700); } })();
