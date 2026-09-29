// The Letterboxd-style side of Moviq: what the community is watching and writing.
import { Router } from 'express';
import { many } from '../db/pool.js';
import { CARD, CARD_FROM, cardsByIds } from '../lib/movies.js';
import { fetchReviews } from '../lib/reviews.js';
import { trending } from './movies.js';

const r = Router();

r.get('/', async (req, res) => {
  const uid = req.user?.id ?? null;
  const [popularWeek, topRated, popularReviews, friendsReviews, friendsActivity, members] = await Promise.all([
    trending(12),
    many(`SELECT ${CARD} FROM ${CARD_FROM} WHERE s.n_ratings >= 8
          ORDER BY (s.n_ratings * s.avg_rating + 10 * 3.6) / (s.n_ratings + 10) DESC LIMIT 12`),
    fetchReviews('TRUE', [], uid, { limit: 8 }),
    uid ? fetchReviews(`r.user_id IN (SELECT followee_id FROM follows WHERE follower_id = $2)`, [uid], uid, { order: 'r.created_at DESC', limit: 6 }) : [],
    uid ? many(`SELECT u.username, u.display_name, u.avatar_hue, r.rating, r.liked, r.watched_on, (r.body <> '') AS has_review,
                       m.id, m.title, m.year, m.poster_url, m.genres
                FROM follows f JOIN reviews r ON r.user_id = f.followee_id JOIN users u ON u.id = r.user_id JOIN movies m ON m.id = r.movie_id
                WHERE f.follower_id=$1 ORDER BY r.watched_on DESC, r.id DESC LIMIT 12`, [uid]) : [],
    many(`SELECT u.username, u.display_name, u.avatar_hue,
                 (SELECT COUNT(*)::int FROM reviews r WHERE r.user_id = u.id) AS films,
                 (SELECT COUNT(*)::int FROM reviews r WHERE r.user_id = u.id AND r.body <> '') AS reviews
          FROM users u WHERE u.source <> 'editorial' ORDER BY reviews DESC, films DESC LIMIT 8`),
  ]);
  const popular = await cardsByIds(popularWeek.ids);
  res.json({ popularWeek: popular, popularThisWeek: popularWeek.thisWeek, topRated, popularReviews, friendsReviews, friendsActivity, members });
});

export default r;
