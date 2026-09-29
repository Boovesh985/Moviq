import { Router } from 'express';
import { one, query } from '../db/pool.js';
import { requireAuth, HttpError } from '../middleware/auth.js';
import { mlRefresh } from '../lib/ml.js';
import { CARD, CARD_FROM, withMatch } from '../lib/movies.js';
import { many } from '../db/pool.js';

const r = Router();
r.use(requireAuth);

// Player heartbeat: saves position so "Continue watching" works.
r.post('/:movieId/progress', async (req, res) => {
  const position = Math.max(0, Math.floor(Number(req.body?.position) || 0));
  const duration = Math.max(0, Math.floor(Number(req.body?.duration) || 0));
  const completed = duration > 0 && position / duration > 0.92;
  const row = await one(
    `INSERT INTO watch_history (user_id, movie_id, position_seconds, duration_seconds, completed)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, movie_id) DO UPDATE SET position_seconds=$3, duration_seconds=$4,
       completed = watch_history.completed OR $5, last_watched_at=NOW()
     RETURNING completed`,
    [req.user.id, req.params.movieId, position, duration, completed],
  );
  if (completed) mlRefresh();
  res.json({ completed: row.completed });
});

r.post('/:movieId/watched', async (req, res) => {
  if (!(await one('SELECT 1 FROM movies WHERE id=$1', [req.params.movieId]))) throw new HttpError(404, 'We couldn’t find that film.');
  await query(
    `INSERT INTO watch_history (user_id, movie_id, completed) VALUES ($1,$2,TRUE)
     ON CONFLICT (user_id, movie_id) DO UPDATE SET completed=TRUE, last_watched_at=NOW()`,
    [req.user.id, req.params.movieId],
  );
  mlRefresh();
  res.json({ ok: true });
});

r.get('/list', async (req, res) => {
  const items = await many(`SELECT ${CARD} FROM watchlist wl JOIN ${CARD_FROM} ON m.id = wl.movie_id WHERE wl.user_id=$1 ORDER BY wl.added_at DESC`, [req.user.id]);
  res.json({ items: await withMatch(req.user.id, items) });
});

r.post('/list/:movieId', async (req, res) => {
  const del = await query('DELETE FROM watchlist WHERE user_id=$1 AND movie_id=$2', [req.user.id, req.params.movieId]);
  if (!del.rowCount) await query('INSERT INTO watchlist (user_id, movie_id) VALUES ($1,$2)', [req.user.id, req.params.movieId]);
  mlRefresh();
  res.json({ onWatchlist: !del.rowCount });
});

export default r;
