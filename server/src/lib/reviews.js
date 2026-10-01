import { many } from '../db/pool.js';

// $1 is always the viewer's user id (or null).
export const REVIEW_SELECT = `
  SELECT r.id, r.movie_id, r.rating, r.liked, r.body, r.watched_on, r.rewatch, r.created_at,
         r.author_spoiler, r.spoiler_score, r.spoiler_sentences, r.sentiment, r.source_url, (r.scored_by IS NULL) AS unchecked,
         (SELECT json_object_agg(sl.sentence, sl.label) FROM spoiler_labels sl WHERE sl.review_id = r.id AND sl.user_id = $1) AS my_labels,
         json_build_object('id', u.id, 'username', u.username, 'display_name', u.display_name, 'avatar_hue', u.avatar_hue) AS author,
         (SELECT COUNT(*)::int FROM review_likes l WHERE l.review_id = r.id) AS likes,
         (SELECT COUNT(*)::int FROM spoiler_reports sr WHERE sr.review_id = r.id) AS reports,
         EXISTS (SELECT 1 FROM review_likes l WHERE l.review_id = r.id AND l.user_id = $1) AS liked_by_me,
         EXISTS (SELECT 1 FROM spoiler_reports sr WHERE sr.review_id = r.id AND sr.user_id = $1) AS reported_by_me,
         json_build_object('id', m.id, 'title', m.title, 'year', m.year, 'poster_url', m.poster_url, 'genres', m.genres) AS movie
  FROM reviews r
  JOIN users u ON u.id = r.user_id
  JOIN movies m ON m.id = r.movie_id`;

/** Shapes the spoiler information the client needs to render the Spoiler Shield. */
export function shapeReview(row, viewerId) {
  const { author_spoiler, spoiler_score, spoiler_sentences, reports, my_labels, unchecked, ...rest } = row;
  const mine = viewerId && row.author.id === viewerId;
  return {
    ...rest,
    reports,
    spoiler: {
      // whole review hidden: author tagged it, or 2+ people reported it
      hidden: !mine && (author_spoiler || reports >= 2),
      // written while the ML service was asleep: not checked for spoilers yet, so readers get a warning first
      unchecked: !mine && !!unchecked,
      author_tagged: author_spoiler,
      community_reports: reports,
      score: spoiler_score,
      // sentence-level blur from the ML model
      sentences: mine ? [] : spoiler_sentences ?? [],
      my_labels: my_labels ?? {},   // sentence -> 0/1 this viewer already gave
    },
  };
}

export async function fetchReviews(where, params, viewerId, { order = 'likes DESC, r.created_at DESC', limit = 20, offset = 0 } = {}) {
  const rows = await many(
    `${REVIEW_SELECT} WHERE r.body <> '' AND ${where} ORDER BY ${order} LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    [viewerId ?? null, ...params],
  );
  return rows.map((r) => shapeReview(r, viewerId));
}
