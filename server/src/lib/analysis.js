import { ml, mlRefresh } from './ml.js';

/** Live check while someone writes a review: spoiler spans + sentiment, nothing stored. */
export async function analyzeText(text) {
  if (!text?.trim()) return { spoiler: { score: 0, sentences: [] }, sentiment: { score: null, aspects: [] } };
  // unavailable: the ML service is asleep or busy, so nothing was checked (not "no spoilers found")
  return ml('/analyze', { text }, { fallback: { spoiler: { score: 0, sentences: [], unavailable: true }, sentiment: { score: null, aspects: [] } } });
}

/**
 * Has the ML service (re)score a stored review: spoiler spans (with human votes applied),
 * sentiment and aspects. If the ML service is down, its learner picks the review up later.
 */
export async function rescoreReview(reviewId, authorId = null) {
  const r = await ml(`/reviews/${reviewId}/rescore`, {}, { timeout: 5000 });
  mlRefresh(authorId);
  return r;
}
