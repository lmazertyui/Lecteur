/* ============================================================================
 * providers.js — résolution de sources vidéo à partir d'un ID TMDB
 * ----------------------------------------------------------------------------
 * Deux familles de fournisseurs :
 *   kind:'direct' → renvoie { url, type:'mp4'|'hls' } → joué dans <video>
 *   kind:'embed'  → renvoie { url, type:'iframe' }   → joué dans <iframe>
 *
 * Les directs sont résolus en parallèle (timeout), les embeds sont générés
 * instantanément (simple construction d'URL, aucun fetch, donc aucun CORS).
 * On renvoie TOUS les candidats triés : le lecteur prend le premier et
 * bascule sur le suivant en cas d'échec.
 *
 * Ajouter un fournisseur :
 *   Providers.register({ name:'X', kind:'direct', priority:20,
 *                        async find(movie, ctx) { return { url, type:'hls' } } })
 *   Providers.registerEmbed({ name:'Y', priority:120,
 *                        movie:m=>`https://y.tld/movie/${m.id}`,
 *                        tv:(m,c)=>`https://y.tld/tv/${m.id}/${c.season}/${c.episode}` })
 * ========================================================================== */

const CONFIG = {
  tmdbKey: localStorage.getItem('vp:tmdbKey') || '',
  proxy: localStorage.getItem('vp:proxy') || '', // ex: 'https://mon-cors/?url='
  lang: 'fr-FR',
  directTimeout: 7000,
  verifyEmbeds: false,   // nécessite CONFIG.proxy
  debug: true,
};

const log = (...a) => CONFIG.debug && console.log('[providers]', ...a);

/* ---------------------------------------------------------------- utilitaires */
const norm = s => (s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function withTimeout(p, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    Promise.resolve(p).then(v => { clearTimeout(t); res(v); },
                               e => { clearTimeout(t); rej(e); });
  });
}

async function getJSON(url, opts = {}) {
  const target = CONFIG.proxy ? CONFIG.proxy + encodeURIComponent(url) : url;
  const r = await fetch(target, { cache: 'no-store', ...opts });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* Statistiques : un fournisseur qui a déjà servi remonte dans le classement. */
const STATS = JSON.parse(localStorage.getItem('vp:stats') || '{}');
const saveStats = () => localStorage.setItem('vp:stats', JSON.stringify(STATS));
const bump = (id, d) => {
  STATS[id] = Math.max(-10, Math.min(10, (STATS[id] || 0) + d));
  saveStats();
};
const bonus = id => (STATS[id] || 0) * 5; // négatif = a déjà fonctionné = remonte

/* ------------------------------------------------------------ métadonnées TMDB */
const META_CACHE = new Map();

async function tmdbDetails(id, type) {
  const key = `${type}:${id}`;
  if (META_CACHE.has(key)) return META_CACHE.get(key);

  let movie = { id: Number(id), type };
  if (CONFIG.tmdbKey) {
    try {
      const path = type === 'tv' ? 'tv' : 'movie';
      const d = await getJSON(
        `https://api.themoviedb.org/3/${path}/${id}?api_key=${CONFIG.tmdbKey}` +
        `&language=${CONFIG.lang}&append_to_response=external_ids`);
      movie = {
        ...d,
        id: Number(id),
        type,
        title: d.title || d.name,
        original_title: d.original_title || d.original_name,
        release_date: d.release_date || d.first_air_date || '',
        year: +((d.release_date || d.first_air_date || '').slice(0, 4)) || null,
        imdb_id: d.external_ids?.imdb_id || d.imdb_id || null,
        runtime: d.runtime || d.episode_run_time?.[0] || null,
      };
    } catch (e) { log('TMDB KO', e.message); }
  }
  META_CACHE.set(key, movie);
  return movie;
}

/* ------------------------------------------------------------------- registre */
const Providers = {
  list: [],
  last: [],
  cursor: 0,

  register(p) {
    if (!p?.name || typeof p.find !== 'function') throw new Error('fournisseur invalide');
    const prov = {
      id: p.id || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      kind: 'direct', priority: 50, enabled: true, note: '', ...p,
    };
    this.list.push(prov);
    this.list.sort((a, b) => a.priority - b.priority);
    return prov;
  },

  registerEmbed(def) {
    const { id, name, priority, note, movie, tv, needsImdb } = def;
    return this.register({
      id, name, priority, note, kind: 'embed',
      async find(m, ctx) {
        if (needsImdb && !m.imdb_id) return null;
        const key = needsImdb ? m.imdb_id : m.id;
        const url = m.type === 'tv' && tv ? tv(m, ctx) : movie({ ...m, id: key });
        return url ? { url, type: 'iframe' } : null;
      },
    });
  },

  disable(x) { const p = this.list.find(p => p.id === x || p.name === x); if (p) p.enabled = false; },
  enable(x)  { const p = this.list.find(p => p.id === x || p.name === x); if (p) p.enabled = true; },

  /**
   * Renvoie le meilleur candidat, et garde toute la liste pour next().
   * @param {number|object} input  ID TMDB, ou objet movie déjà résolu
   * @param {{type?:'movie'|'tv', season?:number, episode?:number}} opts
   */
  async resolve(input, opts = {}) {
    const type = opts.type === 'tv' ? 'tv' : 'movie';
    const movie = (input && typeof input === 'object')
      ? { ...input, type }
      : await tmdbDetails(input, type);

    const q = new URLSearchParams(location.search);
    const ctx = {
      season: Number(opts.season || q.get('s')) || 1,
      episode: Number(opts.episode || q.get('e')) || 1,
    };

    const out = [];
    const seen = new Set();
    const push = (c, prov) => {
      if (!c?.url || seen.has(c.url)) return;
      seen.add(c.url);
      out.push({
        provider: prov.name, providerId: prov.id, kind: prov.kind,
        url: c.url, type: c.type || (prov.kind === 'embed' ? 'iframe' : 'mp4'),
        subtitles: c.subtitles || [],
        note: prov.note,
        score: prov.priority + bonus(prov.id),
      });
    };

    /* 1. directs, en parallèle */
    const direct = this.list.filter(p => p.enabled && p.kind === 'direct');
    const imdb = ensureImdb(movie);
    await Promise.allSettled(direct.map(async p => {
      try {
        const c = await withTimeout(p.find(movie, ctx), CONFIG.directTimeout);
        if (c?.url) { push(c, p); bump(p.id, -1); }
        else bump(p.id, 1);
      } catch (e) { log(`[${p.name}]`, e.message); bump(p.id, 1); }
    }));

    movie.imdb_id = (await imdb) || movie.imdb_id;

    /* 2. embeds, instantané */
    for (const p of this.list.filter(x => x.enabled && x.kind === 'embed')) {
      try {
        const c = await p.find(movie, ctx);
        if (c?.url) push(c, p);
      } catch (e) { log(`[${p.name}]`, e.message); }
    }

    out.sort((a, b) => a.score - b.score);

    /* 3. vérification optionnelle via proxy */
    if (CONFIG.verifyEmbeds && CONFIG.proxy) {
      await Promise.all(out.filter(c => c.kind === 'embed').map(async c => {
        try {
          const r = await withTimeout(fetch(CONFIG.proxy + encodeURIComponent(c.url)), 5000);
          const xfo = r.headers.get('x-frame-options') || '';
          if (!r.ok || /deny/i.test(xfo)) c.score += 1000;
        } catch { c.score += 500; }
      }));
      out.sort((a, b) => a.score - b.score);
    }

    this.last = out;
    this.cursor = 0;
    return out[0] || null;
  },

  async resolveBest(input, opts) { return this.resolve(input, opts); },

  /* Source suivante, pour la touche n. */
  next() {
    const s = this.last[++this.cursor];
    if (s) this.report(s.providerId, true);
    return s || null;
  },

  report(providerId, ok) { bump(providerId, ok ? -3 : 4); },
};

/* app.js ne demande pas external_ids : on le récupère pour MultiEmbed. */
async function ensureImdb(m) {
  if (m.imdb_id) return m.imdb_id;
  const key = localStorage.getItem('tmdbKey') || CONFIG.tmdbKey;
  if (!key) return null;
  const bearer = key.length > 40;
  const url = `https://api.themoviedb.org/3/movie/${m.id}/external_ids` +
    (bearer ? '' : `?api_key=${encodeURIComponent(key)}`);
  try {
    const r = await withTimeout(fetch(url, bearer ? { headers: { Authorization: 'Bearer ' + key } } : {}), 4000);
    return (await r.json()).imdb_id || null;
  } catch { return null; }
}

/* ============================================================================
 * FOURNISSEURS DIRECTS
 * ========================================================================== */

/* 1. Ta bibliothèque : sources.json (ce que tu héberges, droits maîtrisés).
 *    { "603": { "url":".../film.mp4", "type":"mp4",
 *               "subtitles":[{"label":"Français","lang":"fr","src":"fr.vtt"}] } }
 *    Clé "603" ou "603:2:5" pour un épisode. */
Providers.register({
  name: 'Ma bibliothèque', kind: 'direct', priority: 5,
  async find(m, c) {
    const r = await fetch('sources.json', { cache: 'no-store' });
    if (!r.ok) return null;
    const db = await r.json();
    return db[`${m.id}:${c.season}:${c.episode}`] || db[m.id] || null;
  },
});

/* 2. Internet Archive — domaine public / libre de droits. */
Providers.register({
  name: 'Internet Archive', kind: 'direct', priority: 10,
  note: 'Domaine public',
  async find(m) {
    if (m.type === 'tv') return null;
    const names = [...new Set([m.original_title, m.title].filter(Boolean))];
    for (const name of names) {
      const q = `title:("${name.replace(/["\\]/g, '')}") AND mediatype:movies`;
      const docs = (await getJSON(
        `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
        `&fl[]=identifier&fl[]=title&fl[]=year&rows=10&output=json`)).response.docs;

      const hit = docs.find(d => norm(d.title) === norm(name) &&
        (!d.year || !m.year || Math.abs(d.year - m.year) <= 1));
      if (!hit) continue;

      const meta = await getJSON(`https://archive.org/metadata/${hit.identifier}`);
      const files = meta.files || [];
      const mp4s = files.filter(f => /\.mp4$/i.test(f.name));
      const vid = mp4s.find(f => /264|mpeg4/i.test(f.format || '')) || mp4s[0];
      if (!vid) continue;

      const base = `https://archive.org/download/${hit.identifier}/`;
      return {
        url: base + encodeURIComponent(vid.name), type: 'mp4',
        subtitles: files.filter(f => /\.(vtt|srt)$/i.test(f.name)).slice(0, 5)
          .map(f => ({ label: f.name.replace(/\.\w+$/, ''), lang: '', src: base + encodeURIComponent(f.name) })),
      };
    }
    return null;
  },
});

/* 3. APIs JSON qui renvoient un flux HLS direct.
 *    Fragiles et souvent fermées au CORS → active CONFIG.proxy. */
Providers.register({
  name: 'VidLink API', kind: 'direct', priority: 20,
  note: 'HLS direct (proxy conseillé)',
  async find(m, c) {
    const u = m.type === 'tv'
      ? `https://vidlink.pro/api/b/tv/${m.id}/${c.season}/${c.episode}`
      : `https://vidlink.pro/api/b/movie/${m.id}`;
    const d = await getJSON(u);
    const p = d?.stream?.playlist || d?.playlist;
    if (!p) return null;
    return {
      url: p, type: 'hls',
      subtitles: (d?.stream?.subtitles || []).map(s => ({ label: s.label, lang: s.lang, src: s.url })),
    };
  },
});

Providers.register({
  name: 'SmashyStream API', kind: 'direct', priority: 25,
  note: 'HLS direct (proxy conseillé)',
  async find(m, c) {
    const u = m.type === 'tv'
      ? `https://api.smashystream.com/playere.php?tmdb=${m.id}&season=${c.season}&episode=${c.episode}`
      : `https://api.smashystream.com/playere.php?tmdb=${m.id}`;
    const d = await getJSON(u);
    const src = d?.sources?.[0] || d?.data?.sources?.[0];
    if (!src?.file) return null;
    return { url: src.file, type: /\.m3u8/.test(src.file) ? 'hls' : 'mp4' };
  },
});

/* ============================================================================
 * EMBEDS — aucune clé, aucun fetch. Ordre = priorité de repli.
 * ========================================================================== */
const EMBEDS = [
  { id: 'vidsrc-to',   name: 'VidSrc.to',      priority: 110,
    movie: m => `https://vidsrc.to/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidsrc.to/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidsrc-cc',   name: 'VidSrc.cc',      priority: 115,
    movie: m => `https://vidsrc.cc/v2/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidsrc.cc/v2/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidsrc-pro',  name: 'VidSrc.pro',     priority: 120,
    movie: m => `https://vidsrc.pro/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidsrc.pro/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidsrc-xyz',  name: 'VidSrc.xyz',     priority: 125,
    movie: m => `https://vidsrc.xyz/embed/movie?tmdb=${m.id}`,
    tv: (m, c) => `https://vidsrc.xyz/embed/tv?tmdb=${m.id}&season=${c.season}&episode=${c.episode}` },

  { id: 'vidsrc-in',   name: 'VidSrc.in',      priority: 130,
    movie: m => `https://vidsrc.in/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidsrc.in/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidsrc-vip',  name: 'VidSrc.vip',     priority: 135,
    movie: m => `https://vidsrc.vip/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidsrc.vip/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'embed-su',    name: 'Embed.su',       priority: 140,
    movie: m => `https://embed.su/embed/movie/${m.id}`,
    tv: (m, c) => `https://embed.su/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidlink',     name: 'VidLink',        priority: 145,
    movie: m => `https://vidlink.pro/movie/${m.id}`,
    tv: (m, c) => `https://vidlink.pro/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidfast',     name: 'VidFast',        priority: 150,
    movie: m => `https://vidfast.pro/movie/${m.id}`,
    tv: (m, c) => `https://vidfast.pro/tv/${m.id}/${c.season}/${c.episode}` },

  { id: '111movies',   name: '111Movies',      priority: 155,
    movie: m => `https://111movies.com/movie/${m.id}`,
    tv: (m, c) => `https://111movies.com/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vixsrc',      name: 'VixSrc',         priority: 160,
    movie: m => `https://vixsrc.to/movie/${m.id}`,
    tv: (m, c) => `https://vixsrc.to/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'videasy',     name: 'Videasy',        priority: 165,
    movie: m => `https://player.videasy.net/movie/${m.id}`,
    tv: (m, c) => `https://player.videasy.net/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'moviesapi',   name: 'MoviesAPI',      priority: 170,
    movie: m => `https://moviesapi.club/movie/${m.id}`,
    tv: (m, c) => `https://moviesapi.club/tv/${m.id}-${c.season}-${c.episode}` },

  { id: 'vidjoy',      name: 'VidJoy',         priority: 175,
    movie: m => `https://vidjoy.pro/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidjoy.pro/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'smashy',      name: 'SmashyStream',   priority: 180,
    movie: m => `https://player.smashy.stream/movie/${m.id}`,
    tv: (m, c) => `https://player.smashy.stream/tv/${m.id}?s=${c.season}&e=${c.episode}` },

  { id: '2embed',      name: '2Embed',         priority: 185,
    movie: m => `https://www.2embed.cc/embed/${m.id}`,
    tv: (m, c) => `https://www.2embed.cc/embedtv/${m.id}&s=${c.season}&e=${c.episode}` },

  { id: 'multiembed',  name: 'MultiEmbed',     priority: 190, needsImdb: true,
    movie: m => `https://multiembed.mov/?video_id=${m.id}&tmdb=1`,
    tv: (m, c) => `https://multiembed.mov/?video_id=${m.id}&tmdb=1&s=${c.season}&e=${c.episode}` },

  { id: 'vidbinge',    name: 'VidBinge',       priority: 195,
    movie: m => `https://vidbinge.com/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidbinge.com/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidsrc-me',   name: 'VidSrc.me',      priority: 200,
    movie: m => `https://vidsrc.me/embed/movie?tmdb=${m.id}`,
    tv: (m, c) => `https://vidsrc.me/embed/tv?tmdb=${m.id}&season=${c.season}&episode=${c.episode}` },

  { id: 'vidsrc-net',  name: 'VidSrc.net',     priority: 205,
    movie: m => `https://vidsrc.net/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidsrc.net/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidsrc-icu',  name: 'VidSrc.icu',     priority: 210,
    movie: m => `https://vidsrc.icu/embed/movie/${m.id}`,
    tv: (m, c) => `https://vidsrc.icu/embed/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'hexa',        name: 'Hexa',           priority: 215,
    movie: m => `https://hexa.watch/watch/movie/${m.id}`,
    tv: (m, c) => `https://hexa.watch/watch/tv/${m.id}/${c.season}/${c.episode}` },

  { id: 'vidora',      name: 'Vidora',         priority: 220,
    movie: m => `https://vidora.su/movie/${m.id}`,
    tv: (m, c) => `https://vidora.su/tv/${m.id}/${c.season}/${c.episode}` },

  { id: '2embed-to',   name: '2Embed.to',      priority: 225,
    movie: m => `https://2embed.to/embed/tmdb/movie?id=${m.id}`,
    tv: (m, c) => `https://2embed.to/embed/tmdb/tv?id=${m.id}&s=${c.season}&e=${c.episode}` },
];

EMBEDS.forEach(e => Providers.registerEmbed(e));

globalThis.Providers = Providers;
