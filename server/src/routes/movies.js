import { Router } from 'express';
import { one, many } from '../db/pool.js';
import { requireAuth, HttpError, intParam } from '../middleware/auth.js';
import { ml } from '../lib/ml.js';
import { CARD, CARD_FROM, cardsByIds, withMatch } from '../lib/movies.js';
import { fetchReviews } from '../lib/reviews.js';
import { filmInsights } from '../lib/insights.js';

const r = Router();
r.param('id', intParam('film'));

// Most watched this week; when the site is quiet, topped up from the last 90 days, then all-time logs.
export async function trending(limit = 10) {
  const week = (await many(`SELECT w.movie_id FROM watch_history w JOIN users u ON u.id = w.user_id
                            WHERE w.last_watched_at > NOW() - INTERVAL '7 days' AND u.source = 'moviq'
                            GROUP BY w.movie_id ORDER BY COUNT(*) DESC LIMIT $1`, [limit])).map((x) => x.movie_id);
  if (week.length >= limit) return { ids: week, thisWeek: true };
  const more = (await many(`SELECT movie_id FROM watch_history WHERE NOT (movie_id = ANY($2))
                            GROUP BY movie_id ORDER BY COUNT(*) FILTER (WHERE last_watched_at > NOW() - INTERVAL '90 days') DESC, COUNT(*) DESC
                            LIMIT $1`, [limit - week.length, week])).map((x) => x.movie_id);
  return { ids: [...week, ...more], thisWeek: week.length >= limit / 2 };
}
const trendingIds = async (limit = 10) => (await trending(limit)).ids;

// Browse page rows (Netflix-style). The ML service can be slow on a free host, so its calls run in
// parallel with everything else, and /recommend returns match scores for the whole catalogue so no
// second call is needed to label the rows.
const GENRE_ROWS = [['Sci-Fi', 'Sci-fi & mind-benders'], ['Comedy', 'Comedies'], ['Horror', 'Horror'], ['Romance', 'Romance'],
  ['Crime', 'Crime & thrillers'], ['Animation', 'Animation for everyone']];

r.get('/home', requireAuth, async (req, res) => {
  const uid = req.user.id;
  // "Because you liked X": the user's most recent high rating, looked up first so /similar can run alongside /recommend
  const anchorQuery = one(`SELECT m.id, m.title FROM reviews r JOIN movies m ON m.id = r.movie_id
                           WHERE r.user_id=$1 AND (r.rating >= 4 OR r.liked) ORDER BY r.created_at DESC LIMIT 1`, [uid]);
  const similarQuery = anchorQuery.then((a) => (a ? ml(`/similar/${a.id}?limit=16`, undefined, { fallback: null }).then((ids) => ids ?? sameGenre(a.id)) : []));

  const [me, recs, trend, continueRows, freeRows, topRated, listRows, friends, anchor, similar, genreRows] = await Promise.all([
    one('SELECT display_name FROM users WHERE id=$1', [uid]),
    ml('/recommend', { user_id: uid, limit: 24, with_match: true }, { fallback: null }),
    trending(10),
    many(`SELECT ${CARD}, w.position_seconds, w.duration_seconds FROM watch_history w JOIN ${CARD_FROM} ON m.id = w.movie_id
          WHERE w.user_id=$1 AND NOT w.completed AND w.position_seconds > 30 ORDER BY w.last_watched_at DESC LIMIT 12`, [uid]),
    many(`SELECT ${CARD} FROM ${CARD_FROM} WHERE m.stream_url IS NOT NULL ORDER BY m.popularity DESC`),
    many(`SELECT ${CARD} FROM ${CARD_FROM} WHERE s.n_ratings >= 8
          ORDER BY (s.n_ratings * s.avg_rating + 10 * 3.6) / (s.n_ratings + 10) DESC LIMIT 20`),
    many(`SELECT ${CARD} FROM watchlist wl JOIN ${CARD_FROM} ON m.id = wl.movie_id WHERE wl.user_id=$1 ORDER BY wl.added_at DESC`, [uid]),
    many(`SELECT ${CARD}, MAX(r.created_at) AS last FROM follows f JOIN reviews r ON r.user_id = f.followee_id
          JOIN ${CARD_FROM} ON m.id = r.movie_id
          WHERE f.follower_id=$1 AND r.rating >= 4 AND r.created_at > NOW() - INTERVAL '120 days'
          GROUP BY m.id, s.avg_rating, s.n_ratings ORDER BY COUNT(*) DESC, last DESC LIMIT 20`, [uid]),
    anchorQuery,
    similarQuery,
    Promise.all(GENRE_ROWS.map(([g]) => many(`SELECT ${CARD} FROM ${CARD_FROM} WHERE $1 = ANY(m.genres) ORDER BY m.popularity DESC LIMIT 20`, [g]))),
  ]);

  // An ML service one deploy behind returns a plain list without match scores (Vercel redeploys in a
  // minute, Render in several): use its picks and fetch the scores separately.
  const legacy = Array.isArray(recs);
  const picked = legacy ? recs : recs?.picks ?? [];
  const [pickCards, trendCards, similarCards] = await Promise.all([
    cardsByIds(picked.length ? picked.map((x) => x.movie_id) : await trendingIds(20)),
    cardsByIds(trend.ids),
    cardsByIds(similar),
  ]);
  const reasons = new Map(picked.map((x) => [x.movie_id, x.reasons]));
  const picks = pickCards.map((c) => ({ ...c, reason: reasons.get(c.id)?.[0] }));

  const rows = [];
  if (continueRows.length) rows.push({ id: 'continue', title: `Continue watching for ${me.display_name}`, kind: 'continue', items: continueRows });
  rows.push({ id: 'picks', title: `Top picks for ${me.display_name}`, kind: 'picks', items: picks.slice(0, 20) });
  rows.push({ id: 'trending', title: trend.thisWeek ? 'Top 10 on Moviq this week' : 'Top 10 on Moviq', kind: 'top10', items: trendCards });
  rows.push({ id: 'free', title: 'Free to watch on Moviq', kind: 'free', items: freeRows });
  if (anchor && similarCards.length) rows.push({ id: 'because', title: `Because you liked ${anchor.title}`, kind: 'standard', items: similarCards });
  rows.push({ id: 'toprated', title: 'Highest rated by the Moviq community', kind: 'standard', items: topRated });
  if (friends.length) rows.push({ id: 'friends', title: 'Loved by people you follow', kind: 'standard', items: friends });
  if (listRows.length) rows.push({ id: 'list', title: 'My List', kind: 'standard', items: listRows });
  GENRE_ROWS.forEach(([g, title], i) => rows.push({ id: `genre-${g}`, title, kind: 'standard', items: genreRows[i] }));

  // Match % for every card, from the /recommend call (ML down: no labels)
  const match = legacy
    ? await ml('/match', { user_id: uid, movie_ids: [...new Set(rows.flatMap((row) => row.items.map((c) => c.id)))] }, { fallback: {} })
    : recs?.match ?? {};
  const scored = rows.map((row) => ({ ...row, items: row.items.map((c) => ({ ...c, match: match[c.id] ?? null })) }));
  // Hero: the best-matching pick that has artwork, else the top pick
  const hero = picks.find((p) => p.backdrop_url) || picks[0];
  res.json({ hero: hero ? { ...hero, match: match[hero.id] ?? null } : null, heroReason: hero?.reason ?? null, rows: scored });
});

r.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const results = await many(
    `SELECT ${CARD} FROM ${CARD_FROM}
     WHERE m.title ILIKE $1 OR m.director ILIKE $1 OR EXISTS (SELECT 1 FROM unnest(m.cast_names) c WHERE c ILIKE $1)
        OR EXISTS (SELECT 1 FROM unnest(m.genres) g WHERE g ILIKE $2)
     ORDER BY (m.title ILIKE $2) DESC, m.popularity DESC LIMIT 40`,
    [`%${q}%`, q],
  );
  res.json({ results: await withMatch(req.user?.id, results) });
});

// A varied grid of well-known films for new-member onboarding
r.get('/onboarding', async (_req, res) => {
  const items = await many(`
    SELECT * FROM (SELECT DISTINCT ON (m.genres[1]) ${CARD} FROM ${CARD_FROM} WHERE m.stream_url IS NULL ORDER BY m.genres[1], s.n_ratings DESC) a
    UNION
    SELECT * FROM (SELECT ${CARD} FROM ${CARD_FROM} WHERE m.stream_url IS NULL ORDER BY s.n_ratings DESC LIMIT 30) b`);
  res.json({ items: items.sort((a, b) => b.n_ratings - a.n_ratings).slice(0, 30) });
});

r.get('/genres', async (_req, res) => {
  res.json(await many(`SELECT g AS name, COUNT(*)::int AS count FROM movies, unnest(genres) g GROUP BY g ORDER BY count DESC`));
});

r.get('/genre/:genre', async (req, res) => {
  const items = await many(`SELECT ${CARD} FROM ${CARD_FROM} WHERE $1 = ANY(m.genres) ORDER BY m.popularity DESC`, [req.params.genre]);
  res.json({ items: await withMatch(req.user?.id, items) });
});

// "More like this" when the ML service is asleep: well-rated films sharing the most genres.
const sameGenre = async (id) => (await many(
  `SELECT m.id FROM ${CARD_FROM}, (SELECT genres FROM movies WHERE id = $1) f
   WHERE m.id <> $1 AND m.genres && f.genres
   ORDER BY cardinality(ARRAY(SELECT unnest(m.genres) INTERSECT SELECT unnest(f.genres))) DESC,
            (COALESCE(s.n_ratings, 0) * COALESCE(s.avg_rating, 0) + 10 * 3.6) / (COALESCE(s.n_ratings, 0) + 10) DESC
   LIMIT 12`, [id])).map((r) => r.id);

// Film page (Letterboxd-style)
r.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const uid = req.user?.id ?? null;
  const movie = await one(`SELECT m.*, (m.stream_url IS NOT NULL) AS free, s.avg_rating, s.n_ratings, s.n_likes, s.n_reviews
                           FROM ${CARD_FROM} WHERE m.id=$1`, [id]);
  if (!movie) throw new HttpError(404, 'We couldn’t find that film.');

  const [histogram, watchers, mine, onList, progress, similarIds, friends, popular, recent, insights] = await Promise.all([
    many(`SELECT rating, COUNT(*)::int n FROM reviews WHERE movie_id=$1 AND rating IS NOT NULL GROUP BY rating ORDER BY rating`, [id]),
    one(`SELECT COUNT(*)::int n FROM watch_history WHERE movie_id=$1`, [id]),
    uid ? one(`SELECT id, rating, liked, body, watched_on, rewatch, author_spoiler FROM reviews WHERE user_id=$1 AND movie_id=$2`, [uid, id]) : null,
    uid ? one(`SELECT 1 FROM watchlist WHERE user_id=$1 AND movie_id=$2`, [uid, id]) : null,
    uid ? one(`SELECT position_seconds, duration_seconds, completed FROM watch_history WHERE user_id=$1 AND movie_id=$2`, [uid, id]) : null,
    ml(`/similar/${id}?limit=12`, undefined, { fallback: null }).then((ids) => ids ?? sameGenre(id)),
    uid ? many(`SELECT u.username, u.display_name, u.avatar_hue, r.rating, r.liked FROM follows f
                JOIN reviews r ON r.user_id = f.followee_id AND r.movie_id=$2 JOIN users u ON u.id = r.user_id
                WHERE f.follower_id=$1 ORDER BY r.created_at DESC LIMIT 12`, [uid, id]) : [],
    fetchReviews('r.movie_id = $2', [id], uid, { limit: 8 }),
    fetchReviews('r.movie_id = $2', [id], uid, { order: 'r.created_at DESC', limit: 8 }),
    filmInsights(id),
  ]);
  // One /match call labels both this film and the similar ones (each call is slow on a free ML host)
  const [scored, ...similarScored] = await withMatch(uid, [{ id }, ...(await cardsByIds(similarIds))]);
  const { stream_url, ...rest } = movie;

  res.json({
    movie: { ...rest, free: !!stream_url, match: scored?.match ?? null },
    stats: { histogram, watched: watchers.n, avg: movie.avg_rating, ratings: movie.n_ratings, likes: movie.n_likes, reviews: movie.n_reviews },
    me: uid ? { review: mine, onWatchlist: !!onList, progress } : null,
    friends,
    insights,
    reviews: { popular, recent },
    similar: similarScored,
  });
});

r.get('/:id/reviews', async (req, res) => {
  const id = Number(req.params.id);
  const sort = req.query.sort === 'recent' ? 'r.created_at DESC' : req.query.sort === 'highest' ? 'r.rating DESC NULLS LAST, likes DESC' : 'likes DESC, r.created_at DESC';
  const page = Math.max(0, Math.floor(Number(req.query.page) || 0));
  res.json({ reviews: await fetchReviews('r.movie_id = $2', [id], req.user?.id, { order: sort, limit: 20, offset: page * 20 }) });
});

// Playback source: free films stream in-app; everything else gets its trailer and where-to-watch.
r.get('/:id/play', requireAuth, async (req, res) => {
  const m = await one(`SELECT id, title, year, runtime, genres, director, poster_url, backdrop_url, stream_url, trailer_key, providers FROM movies WHERE id=$1`, [req.params.id]);
  if (!m) throw new HttpError(404, 'We couldn’t find that film.');
  const [progress, review] = await Promise.all([
    one(`SELECT position_seconds, duration_seconds, completed FROM watch_history WHERE user_id=$1 AND movie_id=$2`, [req.user.id, m.id]),
    one(`SELECT id, rating, liked, body, watched_on, rewatch, author_spoiler FROM reviews WHERE user_id=$1 AND movie_id=$2`, [req.user.id, m.id]),
  ]);
  res.json({ ...m, progress, review });
});

export default r;
