'use strict';
// Draai: de interface. Afspelen gebeurt in de Rust-kern (post → webkit), bibliotheek en zoeken
// via de Web API (rechtstreeks met fetch, met een token van de kern).

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const post = (cmd, o = {}) => window.webkit?.messageHandlers?.draai?.postMessage(JSON.stringify({ cmd, ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = ms => {
  if (!(ms >= 0)) return '0:00';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('draai:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('draai:' + k, JSON.stringify(v)); } catch {} },
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

window.draai = {
  recv(m) {
    switch (m.type) {
      case 'token': case 'lyrics': {
        const w = waiting.get(m.id);
        if (!w) return;
        waiting.delete(m.id);
        m.error ? w.reject(new Error(m.error)) : w.resolve(m);
        return;
      }
      case 'config': S.clientId = m.clientId || ''; S.redirect = m.redirect; return;
      case 'status': return onStatus(m);
      case 'track': return onTrack({ uri: m.uri, name: m.name, artists: m.artists || [], album: { name: m.album, images: m.cover ? [{ url: m.cover }] : [] }, duration: m.duration, explicit: m.explicit }, true);
      case 'play':
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
  } else if (m.state === 'error') {
    toast(m.message || 'Er ging iets mis');
  }
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
const img = (images, size, cls = '') => {
  const u = pic(images, size);
  return u ? `<img src="${esc(u)}" class="${cls}" loading="lazy" alt="">` : `<div class="ph ${cls}"></div>`;
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

// ——— afspelen ———
function play(o) { S.local = true; post('play', o); }

/** Knoppen: hier op de Mac via de kern, anders via de Web API op het andere apparaat. */
async function ctl(cmd, arg) {
  const here = S.local || !S.remote;
  if (here) {
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
    checkLiked([t]);
    lyricsFor(t);
    if (S.panel === 'queue') renderQueue();
    // Volledige gegevens (album-id, artiest-id's) via de Web API.
    if (local && t.uri.startsWith('spotify:track:')) {
      soft(get(`/tracks/${idOf(t.uri)}`, 3600000)).then(full => {
        if (full && S.track?.uri === t.uri) { S.track = { ...norm(full), album: { ...norm(full).album, images: full.album?.images?.length ? full.album.images : t.album.images } }; renderTrack(); }
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
  document.title = t ? `${t.name} · ${t.artists.map(a => a.name).join(', ')}` : 'Draai';
  const bg = $('.lf-bg');
  if (bg && t) bg.style.backgroundImage = `url("${pic(t.album.images, 640)}")`;
}
function renderPlay() {
  const b = $('#b-play');
  b.innerHTML = icon(S.playing ? 'pause' : 'play');
  b.classList.toggle('paused', !S.playing);
  b.title = S.playing ? 'Pauzeer (spatie)' : 'Speel af (spatie)';
  $('#bar').classList.toggle('remote', !!S.remote && !S.local);
  const bp = $('.big-play[data-ctx]');
  if (bp) updateBigPlay(bp);
}
function renderModes() {
  $('#b-shuffle').classList.toggle('on', S.shuffle);
  const r = $('#b-repeat');
  r.classList.toggle('on', S.repeat > 0);
  r.innerHTML = icon('repeat') + (S.repeat === 2 ? '<b style="position:absolute;font-size:8px;top:7px;right:5px">1</b>' : '');
}
function renderVolume() {
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
range($('#seek-bar'), f => { seeking = f * S.dur; tick(); }, f => { const ms = f * S.dur; seeking = null; ctl('seek', ms); S.pos = ms; S.at = Date.now(); });
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
$('#np-cover').onclick = () => openLyricsFull();

/** Niets geladen en op ▶︎ gedrukt: verder waar je was, of je favorieten. */
async function resumeSomething() {
  const last = store.get('last', null);
  if (last?.context) play({ context: last.context, uri: last.uri, position: last.position || 0 });
  else play({ context: `spotify:user:${S.user}:collection` });
}

function tick() {
  const pos = seeking ?? position();
  const f = S.dur ? Math.min(1, pos / S.dur) : 0;
  $('#seek-bar .fill').style.width = f * 100 + '%';
  $('#seek-bar .knob').style.left = f * 100 + '%';
  $('#t-pos').textContent = fmt(pos);
  lyricsTick(pos);
  sleepTick();
}
setInterval(tick, 250);

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
  if (S.ctx) store.set('last', { context: S.ctx, uri: S.track.uri, position: Math.round(position()) });
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
        const mine = p.device.name === 'Draai op deze Mac';
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
    items.push({ label: d.name === 'Draai op deze Mac' ? 'Deze Mac' : d.name, check: d.is_active, fn: async () => {
      if (d.name === 'Draai op deze Mac') { if (S.track) play({ tracks: [S.track.uri], position: Math.round(position()) }); return; }
      try { await api('/me/player', { method: 'PUT', body: { device_ids: [d.id], play: true } }); S.local = false; setTimeout(() => pollRemote(true), 600); } catch (e) { toast(e.message); }
    } });
  }
  if (list.length === 0) items.push({ label: 'Geen apparaten gevonden', fn: () => {} });
  menuAt(anchor, items, 'up');
}

// ——— vind ik leuk ———
async function checkLiked(tracks) {
  const ids = tracks.filter(t => t?.id || t?.uri?.startsWith('spotify:track:')).map(t => t.id || idOf(t.uri)).filter(id => !S.liked.has('spotify:track:' + id));
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await soft(api('/me/tracks/contains?ids=' + chunk.join(',')));
    if (Array.isArray(r)) chunk.forEach((id, j) => S.liked.set('spotify:track:' + id, r[j]));
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
    await api('/me/tracks?ids=' + idOf(t.uri), { method: on ? 'PUT' : 'DELETE' }).catch(async e => {
      if (e.status === 403 || e.status === 404 || e.status === 410) return api('/me/library?uris=' + encodeURIComponent(t.uri), { method: on ? 'PUT' : 'DELETE' });
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
  return show(cur);
}
function back() { if (!hist.length) return; cur.scroll = $('#view').scrollTop; ahead.push(cur); cur = hist.pop(); show(cur); }
function forward() { if (!ahead.length) return; cur.scroll = $('#view').scrollTop; hist.push(cur); cur = ahead.pop(); show(cur); }
$('#back').onclick = back;
$('#fwd').onclick = forward;

let renderId = 0;
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
  const L = { tracks, shown: tracks, ctx, key };
  lists.set(key, L);
  el.classList.add('tracks');
  if (!album) el.classList.add('no-album');
  el.dataset.list = key;
  const head = `<div class="tr head"><div class="n">#</div><div>Titel</div><div class="al">Album</div><div></div><div class="d">${icon('clock')}</div></div>`;
  let n = 0;
  const row = (t, i) => `<div class="tr${t.playable === false ? ' unplayable' : ''}" data-i="${i}" data-uri="${esc(t.uri)}">
    <div class="n"><span>${numbers && t.number ? t.number : i + 1}</span></div>
    <div class="main">${cover ? img(t.album.images, 64) : ''}<div><div class="t">${t.explicit ? '<span class="E">E</span>' : ''}${esc(t.name)}</div>
    <div class="a">${t.artists.map(a => a.id ? `<a data-go="artist:${esc(a.id)}">${esc(a.name)}</a>` : esc(a.name)).join(', ')}</div></div></div>
    <div class="al">${t.album.id ? `<a data-go="album:${esc(t.album.id)}">${esc(t.album.name)}</a>` : esc(t.album.name)}</div>
    <button class="icon like${S.liked.get(t.uri) ? ' on' : ''}" data-like>${icon(S.liked.get(t.uri) ? 'heart-on' : 'heart')}</button>
    <div class="d">${fmt(t.duration)}</div></div>`;
  L.render = () => {
    const list = L.shown;
    n = Math.min(list.length, Math.max(n, 80));
    el.innerHTML = head + list.slice(0, n).map((t, i) => row(t, i)).join('') + (n < list.length ? '<button class="more-rows loading-more">Meer…</button>' : '');
    const m = $('.more-rows', el);
    if (m) m.onclick = () => {
      const from = n;
      n = Math.min(list.length, n + 200);
      m.insertAdjacentHTML('beforebegin', list.slice(from, n).map((t, i) => row(t, from + i)).join(''));
      if (n >= list.length) m.remove();
      markNow();
      checkLiked(list.slice(from, n));
    };
    markNow();
  };
  L.filter = q => {
    q = q.trim().toLowerCase();
    L.shown = !q ? L.tracks : L.tracks.filter(t => (t.name + ' ' + t.artists.map(a => a.name).join(' ') + ' ' + t.album.name).toLowerCase().includes(q));
    n = 0;
    L.render();
  };
  L.render();
  checkLiked(tracks.slice(0, 80));
  return L;
}

function playFromList(L, i) {
  const t = L.shown[i];
  if (!t || t.playable === false) return;
  if (L.ctx?.uri) { S.ctx = L.ctx.uri; play({ context: L.ctx.uri, uri: t.uri }); }
  else {
    // Losse lijst: alles vanaf hier (en wat ervoor stond achteraan), zoals in de officiële app.
    S.ctx = null;
    const uris = L.shown.filter(x => x.playable !== false).map(x => x.uri);
    const at = uris.indexOf(t.uri);
    play({ tracks: uris.slice(0, 500), index: Math.max(0, at) });
  }
}

function markNow() {
  const uri = S.track?.uri;
  $$('.tr.now').forEach(r => r.classList.remove('now'));
  if (uri) $$(`.tr[data-uri="${CSS.escape(uri)}"]`).forEach(r => r.classList.add('now'));
  $$('.q.now').forEach(r => r.classList.remove('now'));
}

let selRow = null;
$('#view').addEventListener('click', e => {
  const like = e.target.closest('[data-like]');
  const row = e.target.closest('.tr[data-i]');
  if (like && row) { const L = lists.get(row.closest('[data-list]').dataset.list); toggleLike(L.shown[+row.dataset.i]).then(() => checkLiked([])); return; }
  if (row && !e.target.closest('a')) { selRow?.classList.remove('sel'); selRow = row; row.classList.add('sel'); }
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
  if (S.ctx === uri && S.track && S.local && !track) return ctl('toggle');
  if (uri.startsWith('spotify:track:') || uri.startsWith('spotify:episode:')) { S.ctx = null; return play({ tracks: [uri] }); }
  S.ctx = uri;
  play({ context: uri, ...(track ? { uri: track } : {}) });
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
    trackMenu(e.clientX, e.clientY, L.shown[+row.dataset.i], () => playFromList(L, +row.dataset.i));
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

function trackMenu(x, y, t, playFn) {
  const liked = S.liked.get(t.uri);
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
  S.ctx = null;
  play({ context: 'spotify:station:track:' + idOf(t.uri) });
  toast('Radio gestart');
}
function copyLink(uri) {
  const [, kind, id] = uri.split(':');
  post('copy', { text: `https://open.spotify.com/${kind}/${id}` });
  toast('Link gekopieerd');
}
async function addToPlaylistMenu(x, y, t) {
  const mine = (await myPlaylists()).filter(p => p.owner?.id === S.me?.id || p.collaborative);
  menu(x, y, [{ label: 'Toevoegen aan', header: true }, ...mine.slice(0, 40).map(p => ({ label: p.name, fn: async () => {
    try {
      await api(`/playlists/${p.id}/items`, { method: 'POST', body: { uris: [t.uri] } })
        .catch(e => e.status === 404 || e.status === 403 ? api(`/playlists/${p.id}/tracks`, { method: 'POST', body: { uris: [t.uri] } }) : Promise.reject(e));
      memo.forEach((v, k) => k.includes(p.id) && memo.delete(k));
      toast(`Toegevoegd aan ${p.name}`);
    } catch (e) { toast(e.message); }
  } }))]);
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
    list.map(p => `<button data-go="playlist:${esc(p.id)}" data-card="${esc(p.uri)}" title="${esc(p.name)}">${img(p.images, 64)}<span>${esc(p.name)}</span></button>`).join('');
}

// ——— de pagina's ———
const card = (o, round) => `<div class="card${round ? ' round' : ''}" data-go="${esc(o.go)}" data-card="${esc(o.uri)}">
  ${img(o.images, 300, 'cover')}
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
    const tiles = list => { $('#h-quick', el).innerHTML = list.slice(0, 8).map(o => `<div class="tile" data-go="${esc(o.go)}" data-card="${esc(o.uri)}">${o.go === 'liked:' ? `<div class="ph liked-ph">${icon('heart-on')}</div>` : img(o.images, 64)}<span>${esc(o.name)}</span><button class="play" data-play="${esc(o.uri)}">${icon('play')}</button></div>`).join(''); };
    const fromLists = playlists.slice(0, 8).map(p => ({ go: 'playlist:' + p.id, uri: p.uri, images: p.images, name: p.name }));
    tiles([{ go: 'liked:', uri: `spotify:user:${S.user}:collection`, images: [], name: 'Nummers die je leuk vindt' }, ...fromLists]);
    const [recent, top, albums] = await Promise.all([
      soft(get('/me/player/recently-played?limit=50', 60000)),
      soft(get('/me/top/artists?time_range=short_term&limit=12', 3600000)),
      soft(get('/me/albums?limit=20', 600000)),
    ]);
    if (!alive()) return;
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
    if (albums?.items?.length) $('#h-albums', el).innerHTML = `<h2>Albums uit je bibliotheek</h2><div class="row-scroll">${albums.items.map(x => albumCard(x.album)).join('')}</div>`;
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
      const types = type === 'all' ? 'track,artist,album,playlist' : type;
      const r = await soft(get(`/search?q=${encodeURIComponent(qv)}&type=${types}&limit=10`, 600000));
      if (my !== seq || !alive()) return;
      if (!r) { out.innerHTML = '<div class="empty">Zoeken lukt nu niet.</div>'; return; }
      const tracks = (r.tracks?.items || []).filter(Boolean).map(t => norm(t));
      const artists = (r.artists?.items || []).filter(Boolean), albums = (r.albums?.items || []).filter(Boolean), pls = (r.playlists?.items || []).filter(Boolean);
      if (type === 'all') {
        const best = artists[0] && artists[0].name.toLowerCase() === qv.toLowerCase() ? { kind: 'Artiest', o: artists[0], round: true, go: 'artist:' + artists[0].id }
          : tracks[0] ? { kind: 'Nummer', o: { ...r.tracks.items[0], images: tracks[0].album.images }, go: 'album:' + tracks[0].album.id, sub: tracks[0].artists.map(a => a.name).join(', ') }
          : artists[0] ? { kind: 'Artiest', o: artists[0], round: true, go: 'artist:' + artists[0].id } : null;
        out.innerHTML = `<div class="search-top">${best ? `<div><h2>Beste resultaat</h2><div class="top-hit${best.round ? ' round' : ''}" data-go="${esc(best.go)}" data-card="${esc(best.o.uri)}">${img(best.o.images, 200)}<div class="t">${esc(best.o.name)}</div><div class="s">${best.kind}${best.sub ? ' · ' + esc(best.sub) : ''}</div><button class="play" data-play="${esc(best.o.uri)}">${icon('play')}</button></div></div>` : '<div></div>'}
          <div><h2>Nummers</h2><div id="s-tracks"></div></div></div>
          ${artists.length ? `<h2>Artiesten</h2><div class="row-scroll">${artists.map(artistCard).join('')}</div>` : ''}
          ${albums.length ? `<h2>Albums</h2><div class="row-scroll">${albums.map(albumCard).join('')}</div>` : ''}
          ${pls.length ? `<h2>Playlists</h2><div class="row-scroll">${pls.map(playlistCard).join('')}</div>` : ''}`;
        trackList($('#s-tracks', out), tracks.slice(0, 5), { album: false });
      } else if (type === 'track') {
        out.innerHTML = '<div id="s-tracks"></div>';
        trackList($('#s-tracks', out), tracks);
      } else {
        const list = type === 'artist' ? artists.map(artistCard) : type === 'album' ? albums.map(albumCard) : pls.map(playlistCard);
        out.innerHTML = `<div class="grid">${list.join('') || '<div class="empty">Niets gevonden</div>'}</div>`;
      }
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
    const p = await get(`/playlists/${id}?fields=${encodeURIComponent('id,uri,name,description,images,owner(id,display_name),followers(total),collaborative,public')}`, 120000).catch(() => cached);
    if (!alive() || !p) return;
    const L = await collection(el, {
      kind: 'Playlist', title: p.name, images: p.images, uri: p.uri, desc: p.description,
      meta: `<b>${esc(p.owner?.display_name || '')}</b>${p.followers?.total ? ` · ${p.followers.total.toLocaleString('nl-NL')} volgers` : ''}`,
    }, alive);
    await playlistItems(id, (_, all) => alive() && L.set(all.map(x => norm(x.item || x.track)).filter(Boolean)));
  },

  async liked(el, _, alive) {
    const L = await collection(el, { kind: 'Playlist', title: 'Nummers die je leuk vindt', liked: true, uri: `spotify:user:${S.user}:collection`, meta: `<b>${esc(S.me?.display_name || '')}</b>` }, alive);
    await pages('/me/tracks?limit=50', (_, all) => alive() && L.set(all.map(x => norm(x.track)).filter(Boolean)));
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
  },

  async artist(el, id, alive) {
    const [a, top, albums] = await Promise.all([
      get(`/artists/${id}`, 3600000),
      soft(get(`/artists/${id}/top-tracks?market=from_token`, 3600000)),
      soft(get(`/artists/${id}/albums?include_groups=album,single&limit=50`, 3600000).catch(() => get(`/artists/${id}/albums?include_groups=album,single&limit=10`, 3600000))),
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
    $('#a-radio', el).onclick = () => { S.ctx = null; play({ context: 'spotify:station:artist:' + a.id }); toast('Radio gestart'); };
    const fb = $('#a-follow', el);
    soft(api(`/me/following/contains?type=artist&ids=${a.id}`)).then(r => { if (Array.isArray(r)) { fb.classList.toggle('on', r[0]); fb.textContent = r[0] ? 'Volgend' : 'Volgen'; } });
    fb.onclick = async () => {
      const on = !fb.classList.contains('on');
      try { await api(`/me/following?type=artist&ids=${a.id}`, { method: on ? 'PUT' : 'DELETE' }); fb.classList.toggle('on', on); fb.textContent = on ? 'Volgend' : 'Volgen'; } catch (e) { toast(e.message); }
    };
    if (top?.tracks?.length) {
      $('#a-top', el).innerHTML = '<h2>Populair</h2><div></div>';
      trackList($('#a-top div', el), top.tracks.slice(0, 10).map(t => norm(t)), { ctx: { uri: a.uri }, album: true });
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
    // Wat Draai zelf heeft bijgehouden.
    const time = store.get('time', {});
    const days = [...Array(7)].map((_, i) => { const d = new Date(Date.now() - (6 - i) * 864e5); return { k: d.toISOString().slice(0, 10), label: d.toLocaleDateString('nl-NL', { weekday: 'long' }) }; });
    const max = Math.max(60, ...days.map(d => time[d.k] || 0));
    const week = days.reduce((s, d) => s + (time[d.k] || 0), 0);
    const at = Object.entries(store.get('artistTime', {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
    $('#st-time', el).innerHTML = `<h2>Luistertijd in Draai <span class="sub" style="font-size:13px;font-weight:500">${Math.round(week / 60)} minuten deze week</span></h2>
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
      <div class="box"><h3>Account</h3><p>Ingelogd als <b style="color:var(--ink)">${esc(S.me?.display_name || S.user || '')}</b>${S.me?.product ? ` (${esc(S.me.product)})` : ''}. Deze Mac heet in Spotify Connect <b style="color:var(--ink)">Draai op deze Mac</b>.</p>
        <div class="field"><button class="ghost" id="set-logout">Uitloggen</button></div></div>
      <div class="box"><h3>Eigen Client ID</h3>
        <p>Voor de bibliotheek, zoeken en statistieken gebruikt Draai de Web API. Met een eigen app in het Spotify-dashboard heb je daar een eigen limiet voor.</p>
        <ol><li>Ga naar <a class="link" style="color:var(--accent)" href="https://developer.spotify.com/dashboard">developer.spotify.com/dashboard</a> en kies <b>Create app</b>.</li>
        <li>Redirect URI: <code>${esc(S.redirect || 'http://127.0.0.1:8888/callback')}</code>, en vink <b>Web API</b> aan.</li>
        <li>Kopieer het <b>Client ID</b> hieronder. De eerste keer opent je browser één keer om toestemming te vragen.</li></ol>
        <div class="field"><input id="set-cid" placeholder="Client ID (leeg = ingebouwd)" value="${esc(S.clientId)}" spellcheck="false"><button class="primary" id="set-save">Opslaan</button></div></div>
      <div class="box"><h3>Uiterlijk</h3><div class="seg" id="set-theme"><button data-t="system">Systeem</button><button data-t="light">Licht</button><button data-t="dark">Donker</button></div></div>
      <div class="box"><h3>Sneltoetsen</h3><p>
        <kbd>spatie</kbd> afspelen/pauzeren · <kbd>⌘K</kbd> of <kbd>/</kbd> zoeken · <kbd>⌘→</kbd> <kbd>⌘←</kbd> volgende/vorige · <kbd>⇧→</kbd> <kbd>⇧←</kbd> 10 s verder/terug ·
        <kbd>⌘↑</kbd> <kbd>⌘↓</kbd> volume · <kbd>⌘L</kbd> songtekst · <kbd>⌘J</kbd> wachtrij · <kbd>⌘D</kbd> vind ik leuk · <kbd>⌘S</kbd> shuffle · <kbd>F</kbd> songtekst op volledig scherm</p></div>
      <div class="box"><h3>Over Draai</h3><p>Een eigen speler voor Spotify Premium, gebouwd in Rust met librespot. Liedjes die je vaker draait worden lokaal bewaard (tot 2 GB), zodat ze meteen beginnen.</p></div>
    </div>`;
    $$('#set-theme button', el).forEach(b => b.classList.toggle('on', b.dataset.t === theme));
    $('#set-theme', el).onclick = e => { const b = e.target.closest('button'); if (!b) return; store.set('theme', b.dataset.t); applyTheme(); $$('#set-theme button', el).forEach(x => x.classList.toggle('on', x === b)); };
    $('#set-save', el).onclick = () => { S.clientId = $('#set-cid', el).value.trim(); post('setClientId', { id: S.clientId }); tok = null; memo.clear(); toast('Opgeslagen'); };
    $('#set-logout', el).onclick = () => { post('logout'); S.ready = false; };
  },
};

/** De kop + knoppen + nummerlijst van een playlist, album of favorieten. */
async function collection(el, o, alive) {
  $('#top-title').textContent = o.title;
  el.innerHTML = `<div class="hero">${o.liked ? `<div class="ph liked-ph" style="width:210px;height:210px;border-radius:12px">${icon('heart-on')}</div>` : img(o.images, 300)}
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
  return {
    set(list) {
      tracks = list;
      if (!L) { listEl.innerHTML = ''; L = trackList(listEl, list, { ctx: { uri: o.uri }, album: o.album !== false, numbers: o.numbers, cover: o.cover !== false }); }
      else { const scroll = $('#view').scrollTop; L.tracks = list; L.filter($('#c-filter', el).value); $('#view').scrollTop = scroll; }
      $('.c-count', el).textContent = extraMeta || `· ${list.length} nummers`;
    },
    meta(t) { extraMeta = t; $('.c-count', el).textContent = t; },
  };
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

/** Slim shuffelen: echt willekeurig, recent gehoorde nummers achteraan, niet twee keer dezelfde artiest na elkaar. */
async function smartShuffle(uri, tracks) {
  if (!tracks?.length) {
    const [, kind, id] = uri.split(':');
    toast('Even alles ophalen…');
    if (kind === 'playlist') tracks = (await playlistItems(id)).map(x => norm(x.item || x.track)).filter(Boolean);
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
  body.innerHTML = `<h4>Speelt nu</h4>${row(q.currently_playing, true)}<h4>Hierna</h4>${(q.queue || []).map(t => row(t)).join('') || '<div class="empty">Niets meer</div>'}`;
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
async function palRun() {
  const q = $('#pal-input').value.trim();
  const my = ++pal.seq;
  let items = palLocal(q);
  if (q) for (const [n, w] of views_go.pages) if (n.toLowerCase().startsWith(q.toLowerCase())) items.push({ kind: 'Ga naar', t: n, s: 'Pagina', go: w, page: true });
  palDraw(items);
  if (q.length < 2) return;
  await sleep(110);
  if (my !== pal.seq) return;
  const r = await soft(get(`/search?q=${encodeURIComponent(q)}&type=track,artist,album,playlist&limit=5`, 600000));
  if (my !== pal.seq || !r) return;
  const tr = (r.tracks?.items || []).filter(Boolean).map(t => ({ kind: 'Nummers', t: t.name, s: t.artists.map(a => a.name).join(', '), uri: t.uri, images: t.album.images, track: true, go: 'album:' + t.album.id, raw: norm(t) }));
  const ar = (r.artists?.items || []).filter(Boolean).slice(0, 3).map(a => ({ kind: 'Artiesten', t: a.name, s: 'Artiest', uri: a.uri, images: a.images, go: 'artist:' + a.id, round: true }));
  const al = (r.albums?.items || []).filter(Boolean).slice(0, 3).map(a => ({ kind: 'Albums', t: a.name, s: a.artists.map(x => x.name).join(', '), uri: a.uri, images: a.images, go: 'album:' + a.id }));
  const pl = (r.playlists?.items || []).filter(Boolean).slice(0, 3).map(p => ({ kind: 'Playlists', t: p.name, s: p.owner?.display_name || '', uri: p.uri, images: p.images, go: 'playlist:' + p.id }));
  // Een artiest die precies zo heet, gaat bovenaan.
  const exact = ar.find(a => a.t.toLowerCase() === q.toLowerCase());
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
  if (x.page) return go(x.go);
  if (mode === 'open' && x.go) return go(x.go);
  if (mode === 'queue' && x.track) return queueTrack(x.raw || { uri: x.uri, name: x.t });
  if (x.track) { S.ctx = null; return play({ tracks: [x.uri] }); }
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
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && $('#view .tr[data-i]')) {
    e.preventDefault();
    const rows = $$('#view .tr[data-i]');
    let i = selRow ? rows.indexOf(selRow) : -1;
    i = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    selRow?.classList.remove('sel');
    selRow = rows[i];
    selRow.classList.add('sel');
    selRow.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter' && selRow?.isConnected) return playFromList(lists.get(selRow.closest('[data-list]').dataset.list), +selRow.dataset.i);
});

// ——— thema ———
function applyTheme() {
  const t = store.get('theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}
applyTheme();

// ——— opstarten ———
async function start() {
  const cachedLists = store.get('playlists', null);
  if (cachedLists) renderSide(cachedLists);
  go('home', undefined, false);
  soft(api('/me')).then(me => { if (me) { S.me = me; store.set('me', me); } });
  myPlaylists(true).then(renderSide).catch(e => toast('Bibliotheek laden lukte niet: ' + e.message));
  pollRemote(true);
  renderModes();
  renderVolume();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready && !S.local) pollRemote(true); });

renderPlay();
renderModes();
post('ready');
