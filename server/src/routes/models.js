// Model health: what the ML models learned, from how much live data, and whether each retrain shipped.
import { Router } from 'express';
import { one } from '../db/pool.js';
import { requireAuth, HttpError } from '../middleware/auth.js';
import { ml } from '../lib/ml.js';

const r = Router();

r.get('/', async (_req, res) => {
  const [models, data] = await Promise.all([
    ml('/models', undefined, { timeout: 5000 }),
    one(`SELECT
           (SELECT COUNT(*)::int FROM spoiler_labels) AS spoiler_labels,
           (SELECT COUNT(*)::int FROM spoiler_labels WHERE label = 1) AS spoiler_yes,
           (SELECT COUNT(*)::int FROM spoiler_reports) AS spoiler_reports,
           (SELECT COUNT(*)::int FROM reviews WHERE body <> '' AND rating IS NOT NULL) AS rated_reviews,
           (SELECT COUNT(*)::int FROM reviews WHERE rating IS NOT NULL) AS ratings,
           (SELECT COUNT(*)::int FROM reviews r JOIN users u ON u.id = r.user_id WHERE u.source = 'moviq' AND r.rating IS NOT NULL) AS moviq_ratings,
           (SELECT COUNT(*)::int FROM users WHERE source = 'moviq') AS moviq_members,
           (SELECT COUNT(*)::int FROM users WHERE source = 'movielens') AS movielens_members`),
  ]);
  if (!models) throw new HttpError(503, 'The ML service isn’t responding. Start it and refresh.');
  res.json({ ...models, data });
});

r.post('/:model/retrain', requireAuth, async (req, res) => {
  const me = await one('SELECT is_admin FROM users WHERE id=$1', [req.user.id]);
  if (!me?.is_admin) throw new HttpError(403, 'Only admins can start a retrain.');
  const result = await ml(`/learn/${encodeURIComponent(req.params.model)}`, {}, { timeout: 180000 });
  if (!result) throw new HttpError(503, 'The retrain didn’t finish. The learner may be busy; try again in a minute.');
  res.json(result);
});

export default r;
