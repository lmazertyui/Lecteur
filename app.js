(() => {
'use strict';
const $ = s => document.querySelector(s);
const P = $('#player'), V = $('#v'), menu = $('#menu');

/* ---------- Icônes ---------- */
const I = {
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor" stroke="none"/>',
  vol: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9a4 4 0 010 6M18 6.5a8 8 0 010 11"/>',
  mute: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M16 9.5l4 5M20 9.5l-4 5"/>',
  cc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10.5a2 2 0 100 3M16.5 10.5a2 2 0 100 3"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/>',
  fs: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  fsx: '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>'
};
const icon = (el, n) => el.innerHTML =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
document.querySelectorAll('[data-i]').forEach(b => icon(b, b.dataset.i));

const fmt = t => {
  if (!isFinite(t)) return '0:00';
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/* ---------- État (chargement / erreur) ---------- */
const stEl = $('#state');
function setState(kind, msg = '', title = '') {
  stEl.className = 'state' + (kind ? ' on ' + kind : '');
  $('#stateTitle').textContent = title;
  $('#stateMsg').textContent = msg;
}

/* ---------- TMDB ---------- */
const TMDB = {
  async movie(id, key) {
    const bearer = key.length > 40; // jeton v4 (Bearer) ou clé v3
    const url = `https://api.themoviedb.org/3/movie/${id}?language=fr-FR` + (bearer ? '' : `&api_key=${encodeURIComponent(key)}`);
    let r;
    try { r = await fetch(url, bearer ? { headers: { Authorization: 'Bearer ' + key } } : {}); }
    catch { throw new Error('Connexion à TMDB impossible. Vérifie ta connexion.'); }
    if (r.status === 401) throw new Error('Clé API TMDB invalide.');
    if (r.status === 404) throw new Error(`Aucun film avec l'ID ${id} sur TMDB.`);
    if (!r.ok) throw new Error('TMDB est indisponible, réessaie dans un instant.');
    return r.json();
  },
  img: (p, size = 'w500') => p ? `https://image.tmdb.org/t/p/${size}${p}` : ''
};

function renderInfo(m) {
  const y = (m.release_date || '').slice(0, 4);
  const poster = TMDB.img(m.poster_path);
  if (poster) $('#poster').src = poster; else $('#poster').removeAttribute('src');
  $('#poster').alt = `Affiche de ${m.title}`;
  $('#iTitle').textContent = m.title + (y ? ` (${y})` : '');
  $('#iMeta').textContent = [
    m.runtime ? `${Math.floor(m.runtime / 60)} h ${String(m.runtime % 60).padStart(2, '0')} min` : '',
    (m.genres || []).map(g => g.name).join(', '),
    m.vote_average ? `${m.vote_average.toFixed(1)}/10` : ''
  ].filter(Boolean).join(' • ');
  $('#iTag').textContent = m.tagline || '';
  $('#iText').textContent = m.overview || 'Aucun synopsis disponible.';
  $('#info').hidden = false;
  $('#pTitle').textContent = m.title;
  $('#pSub').textContent = y;
  V.poster = TMDB.img(m.backdrop_path || m.poster_path, 'w1280');
}

/* ---------- Chargement d'une source ---------- */
let hls;
const loadHls = () => window.Hls ? Promise.resolve() : new Promise((ok, ko) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
  s.onload = ok; s.onerror = ko; document.head.append(s);
});

function reset() {
  if (hls) { hls.destroy(); hls = null; }
  P.querySelectorAll('iframe').forEach(f => f.remove());
  V.pause(); V.removeAttribute('src');
  V.querySelectorAll('track').forEach(t => t.remove());
  V.load();
  P.classList.remove('ready', 'playing');
  menu.hidden = true;
  $('#time').textContent = '0:00 / 0:00';
  fill.style.width = buf.style.width = '0'; knob.style.left = '0';
}

async function addTrack(s, show) {
  let src = s.src;
  if (s.blob || /\.srt$/i.test(src)) { // SRT → WebVTT
    const txt = s.blob ? await s.blob.text() : await (await fetch(src)).text();
    const vtt = /^\s*WEBVTT/.test(txt) ? txt
      : 'WEBVTT\n\n' + txt.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
    src = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  }
  const t = document.createElement('track');
  Object.assign(t, { kind: 'subtitles', label: s.label || 'Sous-titres', srclang: s.lang || 'und', src });
  V.append(t);
  t.track.mode = show ? 'showing' : 'disabled';
  if (show) [...V.textTracks].forEach(x => { if (x !== t.track) x.mode = 'disabled'; });
}

/* Source de type iframe : le fournisseur gère lui-même la lecture. */
function embed(url) {
  const f = document.createElement('iframe');
  f.src = url;
  f.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  f.allowFullscreen = true;
  f.referrerPolicy = 'origin';
  f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;z-index:0';
  P.append(f);
  P.classList.add('ready');
}

async function load(src) {
  if (src.type === 'iframe') return embed(src.url);
  if (src.type === 'hls' && !V.canPlayType('application/vnd.apple.mpegurl')) {
    await loadHls();
    hls = new Hls(); hls.loadSource(src.url); hls.attachMedia(V);
  } else {
    V.src = src.url;
  }
  for (const s of src.subtitles || []) { try { await addTrack(s); } catch (e) { console.warn('Sous-titres ignorés', e); } }
  P.classList.add('ready');
}

/* ---------- Lecture / progression ---------- */
const fill = $('.fill'), buf = $('.buf'), knob = $('.knob');
const toggle = () => V.paused ? V.play().catch(() => {}) : V.pause();
$('#play').onclick = $('#big').onclick = V.onclick = toggle;
V.ondblclick = () => fs();

const sync = () => {
  P.classList.toggle('playing', !V.paused && !V.ended);
  icon($('#play'), V.paused ? 'play' : 'pause');
};
['play', 'pause', 'ended'].forEach(e => V.addEventListener(e, sync));

const tick = () => {
  const d = V.duration || 0;
  fill.style.width = knob.style.left = (d ? V.currentTime / d * 100 : 0) + '%';
  $('#time').textContent = `${fmt(V.currentTime)} / ${fmt(d)}`;
};
['timeupdate', 'loadedmetadata', 'durationchange'].forEach(e => V.addEventListener(e, tick));
V.addEventListener('progress', () => {
  const b = V.buffered;
  if (b.length && V.duration) buf.style.width = b.end(b.length - 1) / V.duration * 100 + '%';
});
V.addEventListener('waiting', () => stEl.classList.contains('error') || setState('loading'));
['canplay', 'playing'].forEach(e => V.addEventListener(e, () => stEl.classList.contains('loading') && setState('')));
V.addEventListener('error', () => {
  if (!V.currentSrc) return;
  setState('error', 'Ce navigateur ne peut pas lire ce fichier (format ou accès refusé).', 'Lecture impossible');
});

const seek = $('#seek');
const seekTo = e => {
  const r = seek.getBoundingClientRect();
  if (V.duration) V.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * V.duration;
};
seek.onpointerdown = e => { seek.setPointerCapture(e.pointerId); seekTo(e); seek.onpointermove = seekTo; };
seek.onpointerup = () => seek.onpointermove = null;

/* ---------- Volume ---------- */
const vol = $('#vol');
vol.oninput = () => { V.volume = +vol.value; V.muted = V.volume === 0; };
$('#mute').onclick = () => V.muted = !V.muted;
V.addEventListener('volumechange', () => {
  icon($('#mute'), V.muted || V.volume === 0 ? 'mute' : 'vol');
  vol.value = V.muted ? 0 : V.volume;
});

/* ---------- Plein écran / mini-lecteur ---------- */
function fs() {
  if (document.fullscreenElement || document.webkitFullscreenElement)
    return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  const f = P.requestFullscreen || P.webkitRequestFullscreen;
  if (f) f.call(P); else if (V.webkitEnterFullscreen) V.webkitEnterFullscreen(); // iPhone
}
document.querySelectorAll('.fsb').forEach(b => b.onclick = fs);
const onFs = () => document.querySelectorAll('.fsb').forEach(b =>
  icon(b, document.fullscreenElement || document.webkitFullscreenElement ? 'fsx' : 'fs'));
document.addEventListener('fullscreenchange', onFs);
document.addEventListener('webkitfullscreenchange', onFs);

if (!document.pictureInPictureEnabled) $('#pip').hidden = true;
$('#pip').onclick = () => document.pictureInPictureElement
  ? document.exitPictureInPicture() : V.requestPictureInPicture().catch(() => {});

/* ---------- Menus : vitesse et sous-titres ---------- */
function openMenu(title, items) {
  if (!menu.hidden && menu.dataset.t === title) { menu.hidden = true; return; }
  menu.dataset.t = title;
  menu.innerHTML = '';
  const h = document.createElement('h4'); h.textContent = title; menu.append(h);
  items.forEach(it => {
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.on) b.className = 'on';
    b.onclick = () => { it.run(); menu.hidden = true; };
    menu.append(b);
  });
  menu.hidden = false;
}
document.addEventListener('pointerdown', e => {
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('#cc,#speed')) menu.hidden = true;
});

$('#speed').onclick = () => openMenu('Vitesse',
  [0.5, 0.75, 1, 1.25, 1.5, 2].map(r => ({
    label: r === 1 ? 'Normale' : r + 'x', on: V.playbackRate === r,
    run: () => { V.playbackRate = r; $('#speed').textContent = r + 'x'; }
  })));

const subFile = $('#subFile');
$('#cc').onclick = () => {
  const tr = [...V.textTracks];
  openMenu('Sous-titres', [
    { label: 'Désactivés', on: !tr.some(t => t.mode === 'showing'), run: () => tr.forEach(t => t.mode = 'disabled') },
    ...tr.map(t => ({ label: t.label || 'Piste', on: t.mode === 'showing', run: () => tr.forEach(x => x.mode = x === t ? 'showing' : 'disabled') })),
    { label: 'Ajouter un fichier…', run: () => subFile.click() }
  ]);
};
subFile.onchange = async () => {
  const f = subFile.files[0];
  if (f) await addTrack({ label: f.name.replace(/\.\w+$/, ''), blob: f }, true);
  subFile.value = '';
};

/* ---------- Masquage auto des contrôles + clavier ---------- */
let hideT;
const wake = () => {
  P.classList.remove('idle');
  clearTimeout(hideT);
  hideT = setTimeout(() => { if (!V.paused && menu.hidden) P.classList.add('idle'); }, 2800);
};
['pointermove', 'pointerdown', 'keydown'].forEach(e => P.addEventListener(e, wake));

/* Passe à la source suivante. */
async function nextSource() {
  const s = Providers.next();
  if (!s) return;
  reset();
  $('#pSub').textContent = s.provider;
  try { await load(s); } catch { nextSource(); }
}

document.addEventListener('keydown', e => {
  if (!P.classList.contains('ready')) return;
  if (/INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
  const k = e.key;
  if (e.target.closest('button') && (k === ' ' || k === 'Enter')) return;
  if (k === ' ' || k === 'k') toggle();
  else if (k === 'ArrowRight') V.currentTime += 10;
  else if (k === 'ArrowLeft') V.currentTime -= 10;
  else if (k === 'ArrowUp') { V.muted = false; V.volume = Math.min(1, V.volume + .1); }
  else if (k === 'ArrowDown') V.volume = Math.max(0, V.volume - .1);
  else if (k === 'm') V.muted = !V.muted;
  else if (k === 'f') fs();
  else if (k === 'n') nextSource();
  else return;
  e.preventDefault();
});

/* ---------- Formulaire : ID TMDB → infos → source → lecture ---------- */
async function run(id, key) {
  reset();
  setState('loading', 'Récupération des informations…');
  let movie;
  try { movie = await TMDB.movie(id, key); }
  catch (err) { return setState('error', err.message, 'Film introuvable'); }

  renderInfo(movie);
  setState('loading', 'Recherche d’une source vidéo…');
  const src = await Providers.resolve(movie);
  if (!src) {
    return setState('error',
      `Aucune source vidéo n’est disponible pour « ${movie.title} ». Ajoute un fournisseur dans providers.js ou une entrée dans sources.json.`,
      'Aucune source trouvée');
  }
  $('#pSub').textContent = [(movie.release_date || '').slice(0, 4), src.provider].filter(Boolean).join(' • ');
  try { await load(src); }
  catch { return setState('error', 'La source a été trouvée mais n’a pas pu être chargée.', 'Lecture impossible'); }
  setState('');
  V.play().catch(() => {}); // le navigateur peut exiger un clic : le bouton central reste affiché
}

$('#form').onsubmit = e => {
  e.preventDefault();
  const id = $('#tmdbId').value.trim(), key = $('#key').value.trim();
  try { localStorage.setItem('tmdbKey', key); } catch {}
  run(id, key);
};

try { $('#key').value = localStorage.getItem('tmdbKey') || ''; } catch {}
const qid = new URLSearchParams(location.search).get('id');
if (qid) $('#tmdbId').value = qid;
setState('hint', 'Saisis un ID TMDB et ta clé API, puis appuie sur Lancer.', 'Prêt');
if (qid && $('#key').value) run(qid, $('#key').value);
})();
