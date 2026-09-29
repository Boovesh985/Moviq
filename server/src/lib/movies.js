import { many } from '../db/pool.js';
import { ml } from './ml.js';

export const CARD = `
  m.id, m.title, m.year, m.runtime, m.genres, m.moods, m.certification, m.poster_url, m.backdrop_url,
  m.overview, m.director, m.trailer_key, m.providers, (m.stream_url IS NOT NULL) AS free,
  s.avg_rating, s.n_ratings`;
export const CARD_FROM = `movies m JOIN movie_stats s ON s.movie_id = m.id`;

/** Fetch movie cards by id, preserving the given order. */
export async function cardsByIds(ids) {
  if (!ids?.length) return [];
  const rows = await many(`SELECT ${CARD} FROM ${CARD_FROM} WHERE m.id = ANY($1)`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** Adds a personal "98% match" to each card (Netflix-style) when the ML service knows the user. */
export async function withMatch(userId, cards) {
  if (!userId || !cards.length) return cards;
  const ids = [...new Set(cards.map((c) => c.id))];
  const match = await ml('/match', { user_id: userId, movie_ids: ids }, { fallback: {} });
  return cards.map((c) => ({ ...c, match: match[c.id] ?? null }));
}

export async function withMatchRows(userId, rows) {
  const all = rows.flatMap((r) => r.items);
  const scored = await withMatch(userId, all);
  const byId = new Map(scored.map((c) => [c.id, c.match]));
  return rows.map((r) => ({ ...r, items: r.items.map((c) => ({ ...c, match: byId.get(c.id) ?? null, reason: c.reason })) }));
}
