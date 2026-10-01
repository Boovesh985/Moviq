import { Router } from 'express';
import { one, many } from '../db/pool.js';
import { requireAuth, HttpError } from '../middleware/auth.js';
import { ml } from '../lib/ml.js';
import { cardsByIds, CARD, CARD_FROM } from '../lib/movies.js';

const r = Router();
const MOODS = ['feel-good', 'funny', 'romantic', 'mind-bending', 'thrilling', 'dark', 'scary', 'emotional', 'epic', 'cozy', 'inspiring', 'action-packed'];
const COMPANY = ['solo', 'date', 'friends', 'family'];

r.get('/options', (_req, res) => res.json({ moods: MOODS, company: COMPANY }));

// 60-second decide mode: three picks, no endless scrolling.
r.post('/', requireAuth, async (req, res) => {
  const body = req.body ?? {};
  const { company = 'solo', only_available = false } = body;
  if (!COMPANY.includes(company)) throw new HttpError(400, 'Choose who you’re watching with.');
  const maxRuntime = Number(body.max_runtime) > 0 ? Math.floor(Number(body.max_runtime)) : null;
  const moods = (Array.isArray(body.moods) ? body.moods : []).filter((m) => MOODS.includes(m));
  const exclude = (Array.isArray(body.exclude_ids) ? body.exclude_ids : []).map(Number).filter(Number.isInteger);
  const me = await one('SELECT services FROM users WHERE id=$1', [req.user.id]);
  const picks = await ml('/decide', {
    user_id: req.user.id, max_runtime: maxRuntime, moods, company, services: me.services, only_available: !!only_available, exclude_ids: exclude,
  }, { fallback: null });

  if (!picks) {
    // ML asleep or slow: well-rated films (Bayesian average, so one 5★ rating doesn't win) that fit the time
    // limit, kid-safe for family night, streamable if asked, not already seen; mood matches first.
    const rows = await many(
      `SELECT ${CARD} FROM ${CARD_FROM}
       WHERE ($1::int IS NULL OR m.runtime <= $1) AND NOT (m.id = ANY($2::int[]))
         AND (NOT $4 OR (m.certification IN ('G', 'PG', 'PG-13') AND NOT 'Horror' = ANY(m.genres)))
         AND (NOT $5 OR m.stream_url IS NOT NULL OR m.providers && $6::text[])
         AND NOT EXISTS (SELECT 1 FROM watch_history w WHERE w.user_id = $7 AND w.movie_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.user_id = $7 AND rv.movie_id = m.id)
       ORDER BY m.moods && $3::text[] DESC, (COALESCE(s.n_ratings, 0) * COALESCE(s.avg_rating, 0) + 10 * 3.6) / (COALESCE(s.n_ratings, 0) + 10) DESC
       LIMIT 3`,
      [maxRuntime, exclude, moods, company === 'family', !!only_available, me.services ?? [], req.user.id]);
    return res.json({ picks: rows.map((m) => ({ ...m, reasons: [m.free ? 'Free to watch on Moviq' : 'Highly rated by the community'] })) });
  }
  const cards = await cardsByIds(picks.map((p) => p.movie_id));
  const extra = new Map(picks.map((p) => [p.movie_id, p]));
  res.json({ picks: cards.map((c) => ({ ...c, match: extra.get(c.id).match, reasons: extra.get(c.id).reasons })) });
});

export default r;
