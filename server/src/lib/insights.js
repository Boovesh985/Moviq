import { many } from '../db/pool.js';

const LABELS = { acting: 'Acting', story: 'Story & writing', visuals: 'Visuals', music: 'Music & sound', pacing: 'Pacing',
  ending: 'Ending', humour: 'Humour', direction: 'Direction' };

const overlaps = (a, spans) => spans.some((s) => a.start < s.end && s.start < a.end);
const clip = (s) => (s.length > 170 ? `${s.slice(0, 167).trimEnd()}…` : s);

/**
 * "What people say" for a film, built from the sentiment model's per-sentence aspect scores.
 * Quotes never come from sentences the Spoiler Shield blurred, or from hidden reviews.
 */
export async function filmInsights(movieId) {
  const rows = await many(
    `SELECT r.body, r.sentiment, r.aspects, r.spoiler_sentences, r.author_spoiler,
            (SELECT COUNT(*) FROM spoiler_reports s WHERE s.review_id = r.id) AS reports
     FROM reviews r WHERE r.movie_id = $1 AND r.body <> '' AND r.sentiment IS NOT NULL`, [movieId]);
  if (!rows.length) return null;

  const byAspect = {};
  for (const r of rows) {
    const hidden = r.author_spoiler || r.reports >= 2;
    for (const a of r.aspects ?? []) {
      const agg = (byAspect[a.aspect] ??= { mentions: 0, pos: 0, neg: 0, best: null, worst: null });
      agg.mentions++;
      if (a.score >= 0.6) agg.pos++;
      if (a.score <= 0.4) agg.neg++;
      if (hidden || overlaps(a, r.spoiler_sentences ?? [])) continue;
      const quote = { text: clip(r.body.slice(a.start, a.end)), score: a.score };
      if (a.score >= 0.6 && (!agg.best || a.score > agg.best.score)) agg.best = quote;
      if (a.score <= 0.4 && (!agg.worst || a.score < agg.worst.score)) agg.worst = quote;
    }
  }
  const aspects = Object.entries(byAspect).map(([key, a]) => {
    const share = a.pos + a.neg ? a.pos / (a.pos + a.neg) : 0.5;
    return {
      aspect: key, label: LABELS[key] ?? key, mentions: a.mentions, positive_share: Math.round(share * 100),
      verdict: share >= 0.67 ? 'loved' : share <= 0.33 ? 'disliked' : 'mixed',
      quote: share >= 0.5 ? a.best ?? a.worst : a.worst ?? a.best,
    };
  }).sort((x, y) => y.mentions - x.mentions);

  const positive = rows.filter((r) => r.sentiment >= 0.5).length;
  return { reviews: rows.length, positive_share: Math.round((positive / rows.length) * 100), aspects };
}
