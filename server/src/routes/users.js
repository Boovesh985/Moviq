import { Router } from 'express';
import { one, many, query } from '../db/pool.js';
import { requireAuth, HttpError } from '../middleware/auth.js';
import { ml, mlRefresh } from '../lib/ml.js';
import { cardsByIds, CARD, CARD_FROM } from '../lib/movies.js';
import { fetchReviews } from '../lib/reviews.js';

const r = Router();
export const SERVICES = ['Netflix', 'Amazon Prime Video', 'Disney Plus Hotstar', 'JioCinema', 'Apple TV Plus', 'Zee5', 'SonyLIV', 'MUBI', 'Hulu', 'Max'];

// Common services plus every service that appears in the catalog's where-to-watch data
r.get('/services', async (_req, res) => {
  const fromCatalog = await many(`SELECT p, COUNT(*) n FROM movies, unnest(providers) p GROUP BY p ORDER BY n DESC`);
  res.json([...new Set([...SERVICES, ...fromCatalog.map((x) => x.p)])]);
});

r.put('/me', requireAuth, async (req, res) => {
  const { display_name, bio, services, favorite_ids } = req.body ?? {};
  if (display_name !== undefined && !String(display_name).trim()) throw new HttpError(400, 'Display name can’t be empty.');
  if (favorite_ids && favorite_ids.length > 4) throw new HttpError(400, 'Pick up to four favourites.');
  const user = await one(
    `UPDATE users SET display_name=COALESCE($2, display_name), bio=COALESCE($3, bio),
       services=COALESCE($4, services), favorite_ids=COALESCE($5, favorite_ids)
     WHERE id=$1 RETURNING id, username, email, display_name, bio, avatar_hue, services, favorite_ids, is_admin`,
    [req.user.id, display_name?.trim() ?? null, bio ?? null, services?.filter((s) => typeof s === 'string').slice(0, 30) ?? null, favorite_ids ?? null],
  );
  res.json({ user });
});

// Cold start: new members pick a few films they love so recommendations work from day one.
r.post('/me/onboarding', requireAuth, async (req, res) => {
  const ids = (req.body?.movie_ids ?? []).map(Number).filter(Boolean).slice(0, 20);
  for (const id of ids) {
    await query(`INSERT INTO reviews (user_id, movie_id, liked) VALUES ($1,$2,TRUE) ON CONFLICT (user_id, movie_id) DO UPDATE SET liked=TRUE`, [req.user.id, id]);
    await query(`INSERT INTO watch_history (user_id, movie_id, completed) VALUES ($1,$2,TRUE) ON CONFLICT DO NOTHING`, [req.user.id, id]);
  }
  mlRefresh();
  res.json({ ok: true, count: ids.length });
});

async function findUser(username) {
  const u = await one(`SELECT id, username, display_name, bio, avatar_hue, favorite_ids, created_at FROM users WHERE username=$1`, [username]);
  if (!u) throw new HttpError(404, 'No member with that username.');
  return u;
}

// Letterboxd-style profile
r.get('/:username', async (req, res) => {
  const u = await findUser(req.params.username);
  const viewer = req.user?.id ?? null;
  const [stats, histogram, recent, reviews, taste, following, favs] = await Promise.all([
    one(`SELECT
          (SELECT COUNT(*)::int FROM watch_history WHERE user_id=$1 AND completed) AS films,
          (SELECT COUNT(*)::int FROM reviews WHERE user_id=$1 AND watched_on >= date_trunc('year', NOW())) AS this_year,
          (SELECT COUNT(*)::int FROM reviews WHERE user_id=$1 AND body <> '') AS reviews,
          (SELECT COUNT(*)::int FROM watchlist WHERE user_id=$1) AS watchlist,
          (SELECT COUNT(*)::int FROM follows WHERE followee_id=$1) AS followers,
          (SELECT COUNT(*)::int FROM follows WHERE follower_id=$1) AS following,
          (SELECT ROUND(AVG(rating),2) FROM reviews WHERE user_id=$1) AS avg_rating`, [u.id]),
    many(`SELECT rating, COUNT(*)::int n FROM reviews WHERE user_id=$1 AND rating IS NOT NULL GROUP BY rating ORDER BY rating`, [u.id]),
    many(`SELECT ${CARD}, r.rating AS my_rating, r.liked AS my_liked, r.watched_on, (r.body <> '') AS has_review
          FROM reviews r JOIN ${CARD_FROM} ON m.id = r.movie_id WHERE r.user_id=$1 ORDER BY r.watched_on DESC, r.id DESC LIMIT 8`, [u.id]),
    fetchReviews('r.user_id = $2', [u.id], viewer, { order: 'r.created_at DESC', limit: 6 }),
    ml(`/taste/${u.id}`, undefined, { fallback: null }),
    viewer ? one('SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2', [viewer, u.id]) : null,
    cardsByIds(u.favorite_ids ?? []),
  ]);
  res.json({ user: u, stats, histogram, favorites: favs, recent, reviews, taste, isFollowing: !!following, isMe: viewer === u.id });
});

r.get('/:username/films', async (req, res) => {
  const u = await findUser(req.params.username);
  const items = await many(`SELECT ${CARD}, r.rating AS my_rating, r.liked AS my_liked, r.watched_on
                            FROM reviews r JOIN ${CARD_FROM} ON m.id = r.movie_id WHERE r.user_id=$1 ORDER BY r.watched_on DESC, r.id DESC`, [u.id]);
  res.json({ items });
});

r.get('/:username/diary', async (req, res) => {
  const u = await findUser(req.params.username);
  const items = await many(`SELECT r.id AS review_id, r.watched_on, r.rating, r.liked, r.rewatch, (r.body <> '') AS has_review,
                                   m.id, m.title, m.year, m.poster_url, m.genres
                            FROM reviews r JOIN movies m ON m.id = r.movie_id WHERE r.user_id=$1 ORDER BY r.watched_on DESC, r.id DESC`, [u.id]);
  res.json({ items });
});

r.get('/:username/reviews', async (req, res) => {
  const u = await findUser(req.params.username);
  res.json({ reviews: await fetchReviews('r.user_id = $2', [u.id], req.user?.id, { order: 'r.created_at DESC', limit: 50 }) });
});

r.get('/:username/watchlist', async (req, res) => {
  const u = await findUser(req.params.username);
  res.json({ items: await many(`SELECT ${CARD} FROM watchlist wl JOIN ${CARD_FROM} ON m.id = wl.movie_id WHERE wl.user_id=$1 ORDER BY wl.added_at DESC`, [u.id]) });
});

r.post('/:username/follow', requireAuth, async (req, res) => {
  const u = await findUser(req.params.username);
  if (u.id === req.user.id) throw new HttpError(400, 'You can’t follow yourself.');
  const del = await query('DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2', [req.user.id, u.id]);
  if (!del.rowCount) await query('INSERT INTO follows VALUES ($1,$2)', [req.user.id, u.id]);
  res.json({ following: !del.rowCount });
});

export default r;
