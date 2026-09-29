import { Router } from 'express';
import { one, query } from '../db/pool.js';
import { requireAuth, HttpError, intParam } from '../middleware/auth.js';
import { mlRefresh } from '../lib/ml.js';
import { analyzeText, rescoreReview } from '../lib/analysis.js';
import { fetchReviews } from '../lib/reviews.js';

const r = Router();
r.param('id', intParam('review'));

// Live Spoiler Shield + sentiment preview while writing
r.post('/spoiler-check', requireAuth, async (req, res) => {
  const { spoiler, sentiment } = await analyzeText(String(req.body?.text || '').slice(0, 5000));
  res.json({ ...spoiler, sentiment: sentiment?.score ?? null });
});

// Log / rate / review a film (one entry per user per film, like a Letterboxd log you can edit)
r.post('/', requireAuth, async (req, res) => {
  const { movie_id, rating = null, liked = false, body = '', watched_on, rewatch = false, author_spoiler = false, not_spoilers = [] } = req.body ?? {};
  if (!Number.isInteger(Number(movie_id)) || !(await one('SELECT 1 FROM movies WHERE id=$1', [Number(movie_id)]))) throw new HttpError(404, 'We couldn’t find that film.');
  if (rating !== null && !(typeof rating === 'number' && rating >= 0.5 && rating <= 5 && (rating * 2) % 1 === 0)) throw new HttpError(400, 'Ratings go from ½ to 5 stars.');
  if (typeof body !== 'string' || body.length > 5000) throw new HttpError(400, 'Reviews can be up to 5,000 characters.');
  if (watched_on && !(/^\d{4}-\d{2}-\d{2}$/.test(watched_on) && !Number.isNaN(Date.parse(watched_on)))) throw new HttpError(400, 'That date isn’t valid.');
  const text = body.trim();

  const review = await one(
    `INSERT INTO reviews (user_id, movie_id, rating, liked, body, watched_on, rewatch, author_spoiler)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8)
     ON CONFLICT (user_id, movie_id) DO UPDATE SET rating=$3, liked=$4, body=$5,
       watched_on=COALESCE($6::date, reviews.watched_on), rewatch=$7, author_spoiler=$8, updated_at=NOW(),
       -- new text: old blur spans and aspect quotes point into the old text, so drop them until it's rescored;
       -- new text or rating: mark the scores stale so the learner rescores even if the ML service is down now
       spoiler_sentences = CASE WHEN reviews.body IS DISTINCT FROM $5 THEN '[]'::jsonb ELSE reviews.spoiler_sentences END,
       aspects = CASE WHEN reviews.body IS DISTINCT FROM $5 THEN '[]'::jsonb ELSE reviews.aspects END,
       scored_by = CASE WHEN reviews.body IS DISTINCT FROM $5 OR reviews.rating IS DISTINCT FROM $3::numeric THEN NULL ELSE reviews.scored_by END
     RETURNING id`,
    [req.user.id, Number(movie_id), rating, !!liked, text, watched_on || null, !!rewatch, !!author_spoiler],
  );
  // The author knows their own review best: sentences they mark "not a spoiler" become training labels.
  for (const sentence of (Array.isArray(not_spoilers) ? not_spoilers : []).filter((s) => typeof s === 'string' && s.trim() && text.includes(s.trim())).slice(0, 20)) {
    await query(`INSERT INTO spoiler_labels (review_id, user_id, sentence, label, source) VALUES ($1,$2,$3,0,'author')
                 ON CONFLICT (review_id, user_id, sentence) DO UPDATE SET label = 0, created_at = NOW()`, [review.id, req.user.id, sentence.trim()]);
  }
  // Logging a film counts as watching it.
  await query(
    `INSERT INTO watch_history (user_id, movie_id, completed) VALUES ($1,$2,TRUE)
     ON CONFLICT (user_id, movie_id) DO UPDATE SET completed=TRUE, last_watched_at=NOW()`,
    [req.user.id, Number(movie_id)],
  );
  await query('DELETE FROM watchlist WHERE user_id=$1 AND movie_id=$2', [req.user.id, Number(movie_id)]);
  if (text) await rescoreReview(review.id, req.user.id);
  else mlRefresh(req.user.id);
  const [saved] = await fetchReviews('r.id = $2', [review.id], req.user.id);
  res.status(201).json({ review: saved ?? { id: review.id } });
});

r.delete('/:id', requireAuth, async (req, res) => {
  const { rowCount } = await query('DELETE FROM reviews WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!rowCount) throw new HttpError(404, 'That review doesn’t exist or isn’t yours.');
  mlRefresh(req.user.id);
  res.json({ ok: true });
});

r.get('/:id', async (req, res) => {
  const [review] = await fetchReviews('r.id = $2', [req.params.id], req.user?.id);
  if (!review) throw new HttpError(404, 'We couldn’t find that review.');
  res.json({ review });
});

r.post('/:id/like', requireAuth, async (req, res) => {
  const del = await query('DELETE FROM review_likes WHERE user_id=$1 AND review_id=$2', [req.user.id, req.params.id]);
  if (!del.rowCount) await query('INSERT INTO review_likes (user_id, review_id) VALUES ($1,$2)', [req.user.id, req.params.id]);
  const { n } = await one('SELECT COUNT(*)::int n FROM review_likes WHERE review_id=$1', [req.params.id]);
  res.json({ liked: !del.rowCount, likes: n });
});

// Review-level report: two reports hide the whole review behind a warning.
r.post('/:id/report-spoiler', requireAuth, async (req, res) => {
  const review = await one('SELECT user_id FROM reviews WHERE id=$1', [req.params.id]);
  if (!review) throw new HttpError(404, 'We couldn’t find that review.');
  if (review.user_id === req.user.id) throw new HttpError(400, 'You can’t report your own review. Tick “Contains spoilers” when you edit it instead.');
  const del = await query('DELETE FROM spoiler_reports WHERE user_id=$1 AND review_id=$2', [req.user.id, req.params.id]);
  if (!del.rowCount) await query('INSERT INTO spoiler_reports (user_id, review_id) VALUES ($1,$2)', [req.user.id, req.params.id]);
  const { n } = await one('SELECT COUNT(*)::int n FROM spoiler_reports WHERE review_id=$1', [req.params.id]);
  res.json({ reported: !del.rowCount, reports: n });
});

// Sentence-level label from a reader: "this sentence is / isn't a spoiler".
// This is the Spoiler Shield's main source of live training data; the review is re-scored at once.
r.post('/:id/spoiler-label', requireAuth, async (req, res) => {
  const { sentence = '', label, source = 'reader' } = req.body ?? {};
  const review = await one('SELECT id, user_id, body FROM reviews WHERE id=$1', [req.params.id]);
  if (!review) throw new HttpError(404, 'We couldn’t find that review.');
  const text = String(sentence).trim();
  if (!text || !review.body.includes(text)) throw new HttpError(400, 'That sentence isn’t part of this review.');
  if (![0, 1].includes(label) || !['reader', 'flag'].includes(source)) throw new HttpError(400, 'That label isn’t valid.');
  await query(`INSERT INTO spoiler_labels (review_id, user_id, sentence, label, source) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (review_id, user_id, sentence) DO UPDATE SET label = $4, source = $5, created_at = NOW()`,
  [review.id, req.user.id, text, label, review.user_id === req.user.id ? 'reader' : source]);
  await rescoreReview(review.id);
  const [updated] = await fetchReviews('r.id = $2', [review.id], req.user.id);
  res.json({ ok: true, review: updated });
});

export default r;
