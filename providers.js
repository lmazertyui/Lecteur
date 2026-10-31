/*
 * Architecture des fournisseurs vidéo.
 *
 * Un fournisseur est un objet { name, find(movie) }.
 *  - movie : la réponse TMDB (id, title, original_title, release_date, ...)
 *  - find() renvoie une source ou null :
 *      { url, type: 'mp4' | 'hls', subtitles: [{ label, lang, src }] }
 *
 * Les fournisseurs sont essayés dans l'ordre d'enregistrement ;
 * le premier qui renvoie une source gagne.
 * Pour en ajouter un : Providers.register({ name, async find(movie) { ... } })
 */
const Providers = {
  list: [],
  register(p) { this.list.push(p); },
  async resolve(movie) {
    for (const p of this.list) {
      try {
        const s = await p.find(movie);
        if (s && s.url) return { ...s, provider: p.name };
      } catch (e) {
        console.warn(`[${p.name}] ignoré :`, e);
      }
    }
    return null;
  }
};

/* 1. Ta bibliothèque : sources.json, pour les vidéos que tu héberges
 *    et dont tu détiens les droits.
 *    Format : { "603": { "url": "https://.../film.mp4", "type": "mp4",
 *               "subtitles": [{ "label": "Français", "lang": "fr", "src": "fr.vtt" }] } }
 */
Providers.register({
  name: 'Ma bibliothèque',
  async find(m) {
    const r = await fetch('sources.json', { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json())[m.id] || null;
  }
});

/* 2. Internet Archive : films du domaine public (légal, sans clé). */
Providers.register({
  name: 'Internet Archive',
  async find(m) {
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const year = +(m.release_date || '').slice(0, 4);
    const names = [...new Set([m.original_title, m.title].filter(Boolean))];
    for (const name of names) {
      const q = `title:("${name.replace(/["\\]/g, '')}") AND mediatype:movies AND collection:feature_films`;
      const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=year&rows=10&output=json`;
      const docs = (await (await fetch(url)).json()).response.docs;
      // On exige le même titre (et la même année si elle est connue) : pas de film "à peu près".
      const hit = docs.find(d => norm(d.title) === norm(name) && (!d.year || !year || Math.abs(d.year - year) <= 1));
      if (!hit) continue;

      const meta = await (await fetch(`https://archive.org/metadata/${hit.identifier}`)).json();
      const files = meta.files || [];
      const mp4s = files.filter(f => /\.mp4$/i.test(f.name));
      const vid = mp4s.find(f => /264|mpeg4/i.test(f.format || '')) || mp4s[0];
      if (!vid) continue;
      const base = `https://archive.org/download/${hit.identifier}/`;
      return {
        url: base + encodeURIComponent(vid.name),
        type: 'mp4',
        subtitles: files.filter(f => /\.(vtt|srt)$/i.test(f.name)).slice(0, 5)
          .map(f => ({ label: f.name.replace(/\.\w+$/, ''), lang: '', src: base + encodeURIComponent(f.name) }))
      };
    }
    return null;
  }
});
