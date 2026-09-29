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
  const { max_runtime = null, moods = [], company = 'solo', only_available = false, exclude_ids = [] } = req.body ?? {};
  if (!COMPANY.includes(company)) throw new HttpError(400, 'Choose who you’re watching with.');
  const me = await one('SELECT services FROM users WHERE id=$1', [req.user.id]);
  const picks = await ml('/decide', {
    user_id: req.user.id,
    max_runtime: max_runtime ? Number(max_runtime) : null,
    moods: moods.filter((m) => MOODS.includes(m)),
    company,
    services: me.services,
    only_available,
    exclude_ids,
  }, { fallback: null });

  if (!picks) {
    // ML offline or slow: well-rated films that fit the time limit, kid-safe for family night, mood matches first.
    const rows = await many(
      `SELECT ${CARD} FROM ${CARD_FROM}
       WHERE ($1::int IS NULL OR m.runtime <= $1) AND NOT (m.id = ANY($2::int[]))
         AND (NOT $4 OR (m.certification IN ('G', 'PG', 'PG-13') AND NOT 'Horror' = ANY(m.genres)))
       ORDER BY m.moods && $3::text[] DESC, s.avg_rating DESC NULLS LAST LIMIT 3`,
      [max_runtime ? Number(max_runtime) : null, exclude_ids, moods.filter((m) => MOODS.includes(m)), company === 'family']);
    return res.json({ picks: rows.map((m) => ({ ...m, reasons: ['Highly rated by the community'] })) });
  }
  const cards = await cardsByIds(picks.map((p) => p.movie_id));
  const extra = new Map(picks.map((p) => [p.movie_id, p]));
  res.json({ picks: cards.map((c) => ({ ...c, match: extra.get(c.id).match, reasons: extra.get(c.id).reasons })) });
});

export default r;
