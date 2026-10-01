// Group mode: everyone joins a room with a code, swipes on films picked for the whole group,
// and the room reveals the films everyone said yes to.
import { Router } from 'express';
import { one, many, query } from '../db/pool.js';
import { requireAuth, HttpError } from '../middleware/auth.js';
import { ml } from '../lib/ml.js';
import { cardsByIds, CARD_FROM } from '../lib/movies.js';

const r = Router();
r.use(requireAuth);

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

async function loadRoom(code) {
  const room = await one('SELECT * FROM watch_rooms WHERE code=$1', [String(code).toUpperCase()]);
  if (!room) throw new HttpError(404, 'No room with that code. Check the code and try again.');
  return room;
}

async function members(roomId) {
  return many(
    `SELECT u.id, u.username, u.display_name, u.avatar_hue, u.is_demo, rm.finished,
            (SELECT COUNT(*)::int FROM room_votes v WHERE v.room_id = rm.room_id AND v.user_id = u.id) AS votes
     FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id=$1 ORDER BY rm.joined_at`, [roomId]);
}

function tally(room, mem, votes) {
  const byMovie = {};
  for (const v of votes) (byMovie[v.movie_id] ??= []).push(v);
  // If the host ends voting early, "everyone" means everyone who took part.
  const voters = new Set(votes.map((v) => v.user_id)).size || mem.length;
  return room.candidate_ids.map((id) => {
    const vs = byMovie[id] ?? [];
    const love = vs.filter((v) => v.vote === 2).length;
    const yes = vs.filter((v) => v.vote === 1).length;
    const nope = vs.filter((v) => v.vote === -1).length;
    const matches = room.scores[id] ?? {};
    const avgMatch = Object.values(matches).reduce((a, b) => a + b, 0) / Math.max(1, Object.values(matches).length);
    return {
      movie_id: id, love, yes, nope,
      everyone: love + yes === voters,
      score: love * 3 + yes * 2 - nope * 2 + avgMatch / 100,
      voters: vs.map((v) => ({ user_id: v.user_id, vote: v.vote })),
    };
  }).sort((a, b) => Number(b.everyone) - Number(a.everyone) || b.score - a.score);
}

r.post('/', async (req, res) => {
  let code;
  do code = newCode(); while (await one('SELECT 1 FROM watch_rooms WHERE code=$1', [code]));
  const room = await one('INSERT INTO watch_rooms (code, host_id) VALUES ($1,$2) RETURNING *', [code, req.user.id]);
  await query('INSERT INTO room_members (room_id, user_id) VALUES ($1,$2)', [room.id, req.user.id]);
  res.status(201).json({ code });
});

r.post('/join', async (req, res) => {
  const room = await loadRoom(req.body?.code || '');
  const already = await one('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [room.id, req.user.id]);
  if (!already && room.status !== 'lobby') throw new HttpError(409, 'This room has already started voting. Ask the host to start a new one.');
  await query('INSERT INTO room_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [room.id, req.user.id]);
  res.json({ code: room.code });
});

r.get('/:code', async (req, res) => {
  const room = await loadRoom(req.params.code);
  const mem = await members(room.id);
  if (!mem.some((m) => m.id === req.user.id)) throw new HttpError(403, 'Join this room with its code first.');
  const votes = await many('SELECT user_id, movie_id, vote FROM room_votes WHERE room_id=$1', [room.id]);
  const candidates = room.status === 'lobby' ? [] : await cardsByIds(room.candidate_ids);
  res.json({
    code: room.code,
    status: room.status,
    isHost: room.host_id === req.user.id,
    filters: room.filters,
    members: mem,
    candidates: candidates.map((c) => ({ ...c, members: room.scores[c.id] ?? {} })),
    myVotes: Object.fromEntries(votes.filter((v) => v.user_id === req.user.id).map((v) => [v.movie_id, v.vote])),
    results: room.status === 'done' ? tally(room, mem, votes) : null,
  });
});

// Adds a demo community member who votes automatically from their own taste — handy for trying group mode alone.
r.post('/:code/demo-member', async (req, res) => {
  const room = await loadRoom(req.params.code);
  if (room.host_id !== req.user.id || room.status !== 'lobby') throw new HttpError(403, 'Only the host can add people before voting starts.');
  const u = await one(`SELECT id FROM users WHERE is_demo AND source <> 'editorial' AND id NOT IN (SELECT user_id FROM room_members WHERE room_id=$1)
                       ORDER BY random() LIMIT 1`, [room.id]);
  if (!u) throw new HttpError(409, 'No more demo members available.');
  await query('INSERT INTO room_members (room_id, user_id) VALUES ($1,$2)', [room.id, u.id]);
  res.json({ ok: true });
});

r.post('/:code/start', async (req, res) => {
  const room = await loadRoom(req.params.code);
  if (room.host_id !== req.user.id) throw new HttpError(403, 'Only the host can start voting.');
  if (room.status !== 'lobby') throw new HttpError(409, 'Voting has already started.');
  const mem = await members(room.id);
  const body = req.body ?? {};
  const max_runtime = Number(body.max_runtime) > 0 ? Math.floor(Number(body.max_runtime)) : null;
  const moods = (Array.isArray(body.moods) ? body.moods : []).filter((m) => typeof m === 'string').slice(0, 2);
  const family = !!body.family;
  let ranked = await ml('/group', { user_ids: mem.map((m) => m.id), limit: 12, max_runtime, moods, family }, { timeout: 8000 });
  if (!ranked?.length) {
    // ML asleep or slow: a shortlist of well-rated films that fit the room's limits and that nobody here has
    // logged yet. No per-person match % in that case.
    const rows = await many(
      `SELECT m.id FROM ${CARD_FROM}
       WHERE ($1::int IS NULL OR m.runtime <= $1)
         AND (NOT $3 OR (m.certification IN ('G', 'PG', 'PG-13') AND NOT 'Horror' = ANY(m.genres)))
         AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.movie_id = m.id AND rv.user_id = ANY($4::int[]))
       ORDER BY m.moods && $2::text[] DESC, (COALESCE(s.n_ratings, 0) * COALESCE(s.avg_rating, 0) + 10 * 3.6) / (COALESCE(s.n_ratings, 0) + 10) DESC
       LIMIT 12`, [max_runtime, moods, family, mem.map((m) => m.id)]);
    ranked = rows.map((r) => ({ movie_id: r.id, members: {} }));
  }
  if (!ranked.length) throw new HttpError(409, 'No films fit those limits. Loosen the time limit or pick other moods.');

  const scores = Object.fromEntries(ranked.map((x) => [x.movie_id, x.members]));
  const ids = ranked.map((x) => x.movie_id);
  // Demo members vote from their predicted match; without one (ML asleep), from the community rating.
  const community = Object.fromEntries((await many(`SELECT movie_id, avg_rating FROM movie_stats WHERE movie_id = ANY($1::int[])`, [ids]))
    .map((s) => [s.movie_id, s.avg_rating]));
  await query(`UPDATE watch_rooms SET status='voting', candidate_ids=$2, scores=$3, filters=$4 WHERE id=$1`,
    [room.id, ids, JSON.stringify(scores), JSON.stringify({ max_runtime, moods, family })]);

  // Demo members vote from their predicted match.
  for (const m of mem.filter((x) => x.is_demo)) {
    for (const id of ids) {
      const pct = scores[id]?.[m.id];
      const stars = community[id] ?? 3.5;
      const vote = pct != null ? (pct >= 92 ? 2 : pct >= 82 ? 1 : -1) : stars >= 4.2 ? 2 : stars >= 3.8 ? 1 : -1;
      await query('INSERT INTO room_votes VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [room.id, m.id, id, vote]);
    }
    await query('UPDATE room_members SET finished=TRUE WHERE room_id=$1 AND user_id=$2', [room.id, m.id]);
  }
  res.json({ ok: true });
});

r.post('/:code/vote', async (req, res) => {
  const room = await loadRoom(req.params.code);
  const { movie_id, vote } = req.body ?? {};
  if (room.status !== 'voting') throw new HttpError(409, 'Voting isn’t open in this room.');
  if (![-1, 1, 2].includes(vote) || !room.candidate_ids.includes(movie_id)) throw new HttpError(400, 'That vote isn’t valid for this room.');
  if (!(await one('SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2', [room.id, req.user.id]))) throw new HttpError(403, 'Join this room first.');

  await query(`INSERT INTO room_votes VALUES ($1,$2,$3,$4) ON CONFLICT (room_id, user_id, movie_id) DO UPDATE SET vote=$4`,
    [room.id, req.user.id, movie_id, vote]);
  const { n } = await one('SELECT COUNT(*)::int n FROM room_votes WHERE room_id=$1 AND user_id=$2', [room.id, req.user.id]);
  if (n >= room.candidate_ids.length) {
    await query('UPDATE room_members SET finished=TRUE WHERE room_id=$1 AND user_id=$2', [room.id, req.user.id]);
    const pending = await one('SELECT COUNT(*)::int n FROM room_members WHERE room_id=$1 AND NOT finished', [room.id]);
    if (pending.n === 0) await query(`UPDATE watch_rooms SET status='done' WHERE id=$1`, [room.id]);
  }
  res.json({ ok: true });
});

// Someone wandered off mid-vote: the host can reveal results from the votes so far.
r.post('/:code/finish', async (req, res) => {
  const room = await loadRoom(req.params.code);
  if (room.host_id !== req.user.id) throw new HttpError(403, 'Only the host can end voting.');
  if (room.status !== 'voting') throw new HttpError(409, 'Voting isn’t open in this room.');
  const { n } = await one('SELECT COUNT(DISTINCT user_id)::int n FROM room_votes WHERE room_id=$1', [room.id]);
  if (!n) throw new HttpError(409, 'Nobody has voted yet.');
  await query(`UPDATE watch_rooms SET status='done' WHERE id=$1`, [room.id]);
  res.json({ ok: true });
});

export default r;
