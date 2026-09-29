// TMDB client shared by the sync and MovieLens import scripts.
// Accepts either a v3 API key or a v4 read access token in TMDB_API_KEY.
import { one } from '../db/pool.js';

const KEY = process.env.TMDB_API_KEY?.trim();
export const REGION = process.env.TMDB_REGION || 'IN';
export const hasTmdbKey = () => Boolean(KEY);

const bearer = KEY?.length > 40;
const IMG = 'https://image.tmdb.org/t/p/';
const GENRES = { 28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller', 10752: 'War', 37: 'Western' };
const GENRE_MOOD = { Comedy: 'funny', Horror: 'scary', Romance: 'romantic', Thriller: 'thrilling', Action: 'action-packed', Family: 'feel-good',
  Animation: 'feel-good', 'Sci-Fi': 'mind-bending', Mystery: 'mind-bending', Drama: 'emotional', Adventure: 'epic', Fantasy: 'epic', History: 'epic', War: 'epic', Crime: 'dark' };

export const moodsFor = (genres) => [...new Set(genres.map((g) => GENRE_MOOD[g]).filter(Boolean))].slice(0, 3);

export async function tmdb(path, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!bearer) url.searchParams.set('api_key', KEY);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${KEY}` } : {} }).catch(() => null);
    if (!res || res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (res.status === 401) throw new Error('TMDB rejected the key (401). Check TMDB_API_KEY in server/.env.');
    if (!res.ok) return null;
    return res.json();
  }
  return null;
}

const normaliseProvider = (raw) => {
  const name = raw.replace(/\s+Amazon Channel$/i, '').trim(); // add-on channels need the same subscription
  return /hotstar/i.test(name) ? 'Disney Plus Hotstar' : /amazon prime/i.test(name) ? 'Amazon Prime Video' : /apple tv/i.test(name) ? 'Apple TV Plus'
    : /jio/i.test(name) ? 'JioCinema' : /^max$|hbo max/i.test(name) ? 'Max'
    : /sony ?liv/i.test(name) ? 'SonyLIV' : /zee ?5/i.test(name) ? 'Zee5' : name;
};

export const details = (tmdbId) => tmdb(`/movie/${tmdbId}`, { append_to_response: 'videos,watch/providers,credits,release_dates' });

export function extract(d) {
  const trailer = (d.videos?.results || [])
    .filter((v) => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type))
    .sort((a, b) => (b.type === 'Trailer') - (a.type === 'Trailer') || b.official - a.official)[0];
  const region = d['watch/providers']?.results?.[REGION];
  const us = d.release_dates?.results?.find((r) => r.iso_3166_1 === 'US');
  return {
    poster: d.poster_path ? `${IMG}w500${d.poster_path}` : null,
    backdrop: d.backdrop_path ? `${IMG}w1280${d.backdrop_path}` : null,
    trailer: trailer?.key || null,
    providers: [...new Set((region?.flatrate || []).map((p) => normaliseProvider(p.provider_name)))],
    cert: us?.release_dates?.map((x) => x.certification).find(Boolean) || null,
    tagline: d.tagline || '',
    director: d.credits?.crew?.find((c) => c.job === 'Director')?.name || '',
    cast: (d.credits?.cast || []).slice(0, 4).map((c) => c.name),
    genres: (d.genres || []).map((g) => GENRES[g.id]).filter(Boolean),
  };
}

/** Inserts a film from TMDB details; returns its Moviq id (existing or new). */
export async function insertFromTmdb(d, extra = {}) {
  const x = extract(d);
  const row = await one(
    `INSERT INTO movies (tmdb_id, title, year, runtime, overview, tagline, genres, moods, director, cast_names, certification,
                         poster_url, backdrop_url, trailer_key, providers, tmdb_rating, popularity, movielens_id, imdb_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (tmdb_id) DO UPDATE SET movielens_id = COALESCE(movies.movielens_id, EXCLUDED.movielens_id),
       imdb_id = COALESCE(movies.imdb_id, EXCLUDED.imdb_id)
     RETURNING id`,
    [d.id, d.title, Number(d.release_date?.slice(0, 4)) || null, d.runtime || null, d.overview || '', x.tagline, x.genres, moodsFor(x.genres),
      x.director, x.cast, x.cert || 'NR', x.poster, x.backdrop, x.trailer, x.providers, d.vote_average, d.popularity,
      extra.movielens_id ?? null, extra.imdb_id ?? null],
  );
  return row.id;
}

/** Runs async work over items with a small concurrency limit (TMDB allows ~40 req/s). */
export async function pool8(items, fn, concurrency = 8) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
