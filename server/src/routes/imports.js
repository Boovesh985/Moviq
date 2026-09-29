// Bring your real history: a Letterboxd export (ratings, diary, reviews, likes, watchlist)
// or Netflix viewing history. Files are parsed in the browser; this receives clean rows.
import { Router } from 'express';
import { many, one, query } from '../db/pool.js';
import { requireAuth, HttpError } from '../middleware/auth.js';
import { details, hasTmdbKey, insertFromTmdb, pool8, tmdb } from '../lib/tmdb.js';
import { mlRefresh } from '../lib/ml.js';

const r = Router();
r.use(requireAuth);

const MAX_NEW_FILMS = 600;
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/^(the|a|an) /, '').replace(/[^a-z0-9]/g, '');

/** Resolves titles to catalog films, adding missing ones from TMDB when a key is configured. */
async function resolver() {
  const catalog = await many('SELECT id, title, year, tmdb_id FROM movies');
  const byTitleYear = new Map();
  const byTitle = new Map();
  for (const m of catalog) {
    byTitleYear.set(`${norm(m.title)}|${m.year}`, m.id);
    byTitle.set(norm(m.title), [...(byTitle.get(norm(m.title)) || []), m]);
  }
  const byTmdb = new Map(catalog.filter((m) => m.tmdb_id).map((m) => [m.tmdb_id, m.id]));
  let added = 0;

  return {
    added: () => added,
    async find(title, year, { strict = false } = {}) {
      const key = norm(title);
      if (!key) return null;
      if (year) {
        const hit = byTitleYear.get(`${key}|${year}`) ?? byTitleYear.get(`${key}|${year - 1}`) ?? byTitleYear.get(`${key}|${year + 1}`);
        if (hit) return hit;
      } else if (byTitle.get(key)?.length === 1) {
        return byTitle.get(key)[0].id;
      }
      if (!hasTmdbKey() || added >= MAX_NEW_FILMS) return null;
      const found = await tmdb('/search/movie', year ? { query: title, year } : { query: title });
      const hit = (found?.results || []).find((x) => !strict || norm(x.title) === key || norm(x.original_title) === key);
      if (!hit) return null;
      if (byTmdb.has(hit.id)) return byTmdb.get(hit.id);
      const d = await details(hit.id);
      if (!d?.id) return null;
      const id = await insertFromTmdb(d, { imdb_id: d.imdb_id });
      byTmdb.set(d.id, id);
      byTitleYear.set(`${key}|${Number(d.release_date?.slice(0, 4))}`, id);
      added++;
      return id;
    },
  };
}

const validDate = (s) => {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!d) return null;
  const date = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
  return date.getUTCMonth() === +d[2] - 1 && date.getUTCDate() === +d[3] ? d[0] : null;
};
const validRating = (v) => {
  const n = Number(v);
  return n >= 0.5 && n <= 5 ? Math.round(n * 2) / 2 : null;
};

// Letterboxd: one entry per film, already merged across the export's CSVs by the client.
r.post('/letterboxd', async (req, res) => {
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || !entries.length) throw new HttpError(400, 'No films found in that export. Upload the ZIP from Letterboxd → Settings → Import & Export.');
  if (entries.length > 8000) throw new HttpError(400, 'That export is larger than Moviq can import at once (8,000 films).');
  const uid = req.user.id;
  const find = await resolver();
  const stats = { films: entries.length, matched: 0, ratings: 0, reviews: 0, likes: 0, watched: 0, watchlist: 0, not_found: [] };

  await pool8(entries, async (e) => {
    const movieId = await find.find(e.name, Number(e.year) || null);
    if (!movieId) {
      if (stats.not_found.length < 40) stats.not_found.push(`${e.name}${e.year ? ` (${e.year})` : ''}`);
      return;
    }
    stats.matched++;
    const rating = validRating(e.rating);
    const body = String(e.review || '').trim().slice(0, 5000);
    const watchedOn = validDate(e.watched_on);
    if (e.watchlist && !e.watched && rating == null && !body) {
      await query('INSERT INTO watchlist (user_id, movie_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [uid, movieId]);
      stats.watchlist++;
      return;
    }
    if (rating != null || body || e.liked) {
      await query(
        `INSERT INTO reviews (user_id, movie_id, rating, liked, body, watched_on, rewatch, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,COALESCE($6::date, NOW()),NOW())
         ON CONFLICT (user_id, movie_id) DO UPDATE SET
           rating = COALESCE(EXCLUDED.rating, reviews.rating), liked = reviews.liked OR EXCLUDED.liked,
           body = CASE WHEN EXCLUDED.body <> '' THEN EXCLUDED.body ELSE reviews.body END,
           watched_on = COALESCE($6::date, reviews.watched_on), rewatch = EXCLUDED.rewatch, updated_at = NOW(),
           spoiler_sentences = CASE WHEN EXCLUDED.body <> '' AND EXCLUDED.body IS DISTINCT FROM reviews.body THEN '[]'::jsonb ELSE reviews.spoiler_sentences END,
           aspects = CASE WHEN EXCLUDED.body <> '' AND EXCLUDED.body IS DISTINCT FROM reviews.body THEN '[]'::jsonb ELSE reviews.aspects END,
           scored_by = CASE WHEN (EXCLUDED.body <> '' AND EXCLUDED.body IS DISTINCT FROM reviews.body)
                              OR (EXCLUDED.rating IS NOT NULL AND EXCLUDED.rating IS DISTINCT FROM reviews.rating) THEN NULL ELSE reviews.scored_by END`,
        [uid, movieId, rating, !!e.liked, body, watchedOn, !!e.rewatch],
      );
      if (rating != null) stats.ratings++;
      if (body) stats.reviews++;
      if (e.liked) stats.likes++;
    }
    await query(
      `INSERT INTO watch_history (user_id, movie_id, completed, started_at, last_watched_at) VALUES ($1,$2,TRUE,COALESCE($3::date, NOW()),COALESCE($3::date, NOW()))
       ON CONFLICT (user_id, movie_id) DO UPDATE SET completed = TRUE`, [uid, movieId, watchedOn]);
    await query('DELETE FROM watchlist WHERE user_id=$1 AND movie_id=$2', [uid, movieId]);
    stats.watched++;
  }, 6);

  mlRefresh(uid);
  res.json({ ...stats, added_films: find.added() });
});

// Netflix: film titles with the date watched (series episodes are filtered out by the client).
r.post('/netflix', async (req, res) => {
  const titles = req.body?.titles;
  if (!Array.isArray(titles) || !titles.length) throw new HttpError(400, 'No films found in that file. Upload NetflixViewingHistory.csv or ViewingActivity.csv.');
  if (titles.length > 5000) throw new HttpError(400, 'That history is larger than Moviq can import at once (5,000 titles).');
  const uid = req.user.id;
  const find = await resolver();
  const stats = { titles: titles.length, matched: 0, not_found: [] };

  await pool8(titles, async (t) => {
    // No year in Netflix exports, so only accept exact title matches.
    const movieId = await find.find(t.title, null, { strict: true });
    if (!movieId) {
      if (stats.not_found.length < 40) stats.not_found.push(t.title);
      return;
    }
    stats.matched++;
    const when = validDate(t.date);
    await query(
      `INSERT INTO watch_history (user_id, movie_id, completed, started_at, last_watched_at) VALUES ($1,$2,TRUE,COALESCE($3::date, NOW()),COALESCE($3::date, NOW()))
       ON CONFLICT (user_id, movie_id) DO UPDATE SET completed = TRUE,
         last_watched_at = GREATEST(watch_history.last_watched_at, COALESCE($3::date, watch_history.last_watched_at))`, [uid, movieId, when]);
  }, 6);

  mlRefresh(uid);
  const unrated = await one(`SELECT COUNT(*)::int n FROM watch_history w WHERE w.user_id = $1 AND w.completed
                             AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.user_id = w.user_id AND r.movie_id = w.movie_id)`, [uid]);
  res.json({ ...stats, added_films: find.added(), unrated: unrated.n });
});

export default r;
