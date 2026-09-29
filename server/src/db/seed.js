// Rebuilds the database: schema, movie catalog, and a synthetic community of demo users
// whose ratings follow taste profiles, so the recommender has signal to learn from.
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { pool, query } from './pool.js';
import { movies } from './movies.data.js';
import { handwrittenReviews, reviewPhrases } from './reviews.data.js';
import { migrate } from './migrate.js';

// Deterministic PRNG so every seed produces the same community.
let s = 42;
const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand());
const hash = (str) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const ARCHETYPES = {
  cinephile:  { Drama: 1, Romance: 0.6, History: 0.5, Mystery: 0.4, Music: 0.3, Action: -0.4, Family: -0.3 },
  blockbuster:{ Action: 1, 'Sci-Fi': 0.8, Adventure: 0.8, Fantasy: 0.5, Drama: -0.2, Romance: -0.5 },
  horror:     { Horror: 1.2, Thriller: 0.6, Mystery: 0.4, Family: -0.6, Romance: -0.4, Music: -0.3 },
  family:     { Animation: 1.1, Family: 1, Comedy: 0.4, Fantasy: 0.5, Horror: -1, Crime: -0.5 },
  comedy:     { Comedy: 1, Romance: 0.3, Adventure: 0.3, Horror: -0.4, History: -0.3 },
  crime:      { Crime: 1, Thriller: 0.9, Mystery: 0.7, Drama: 0.3, Family: -0.5, Animation: -0.3 },
  romance:    { Romance: 1.1, Drama: 0.5, Music: 0.5, Comedy: 0.3, Horror: -0.7, Action: -0.3 },
  thinker:    { 'Sci-Fi': 1, Mystery: 0.6, Thriller: 0.4, Drama: 0.2, Family: -0.3 },
};
const MOOD_BONUS = { thinker: { 'mind-bending': 0.6 }, cinephile: { emotional: 0.3 }, comedy: { 'feel-good': 0.3 } };

const FIRST = ['maya', 'arjun', 'leo', 'nila', 'sam', 'priya', 'omar', 'zoe', 'kiran', 'lena', 'ravi', 'june', 'theo', 'aditi', 'marco',
  'isha', 'noah', 'yuki', 'dev', 'ana', 'felix', 'meera', 'jonas', 'tara', 'kabir', 'elena', 'hugo', 'divya', 'sofia', 'vikram',
  'ines', 'rohan', 'clara', 'nikhil', 'amara', 'luca', 'pooja', 'eli', 'sana', 'max', 'kavya', 'oscar'];
const SUFFIX = ['films', 'watches', 'reels', 'cinema', 'frames', 'reviews', 'popcorn', 'scenes', 'lens', 'credits'];

function affinity(movie, tastes) {
  let a = 0;
  for (const [arch, w] of tastes) {
    const prefs = ARCHETYPES[arch];
    const g = movie.genres.map((x) => prefs[x] ?? 0);
    a += w * (g.reduce((p, c) => p + c, 0) / Math.max(1, g.length) * 1.6);
    for (const m of movie.moods) a += w * (MOOD_BONUS[arch]?.[m] ?? 0);
  }
  return a;
}

async function resolveStream(identifier) {
  try {
    const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { signal: AbortSignal.timeout(8000) });
    const meta = await res.json();
    const files = (meta.files || []).filter((f) => /\.mp4$/i.test(f.name));
    // Prefer the browser-friendly h.264 derivatives, largest (full film, not a chapter) first.
    const ranked = files.sort((a, b) => {
      const score = (f) => (/h\.264|512kb/i.test(f.format + f.name) ? 0 : 1);
      return score(a) - score(b) || Number(b.size || 0) - Number(a.size || 0);
    });
    const f = ranked.find((x) => Number(x.size || 0) > 1_000_000) || ranked[0];
    return f ? `https://archive.org/download/${identifier}/${encodeURIComponent(f.name).replace(/%2F/g, '/')}` : null;
  } catch {
    return null;
  }
}

const daysAgo = (d) => new Date(Date.now() - d * 86400000);

async function main() {
  console.log('→ schema');
  await query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  await migrate();

  console.log('→ movies');
  const movieRows = [];
  for (const m of movies) {
    const streamUrl = m.stream ? await resolveStream(m.stream) : null;
    if (m.stream) console.log(`   ${streamUrl ? '▶' : '✕'} ${m.title}`);
    const { rows } = await query(
      `INSERT INTO movies (title, year, runtime, overview, genres, moods, director, cast_names, certification, stream_source, stream_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [m.title, m.year, m.runtime, m.overview, m.genres, m.moods, m.director, m.cast, m.cert, m.stream, streamUrl],
    );
    movieRows.push({ ...m, id: rows[0].id, quality: ((hash(m.title) % 1000) / 1000 - 0.35) });
  }
  const byTitle = Object.fromEntries(movieRows.map((m) => [m.title, m]));

  console.log('→ users');
  const hashDemo = await bcrypt.hash('moviq123', 10);
  const demo = (await query(
    `INSERT INTO users (username, email, password_hash, display_name, bio, avatar_hue, services, is_demo)
     VALUES ('demo','demo@moviq.local',$1,'Demo Viewer','Trying out Moviq.',12,'{}',FALSE) RETURNING id`, [hashDemo],
  )).rows[0].id;

  const users = [];
  const archNames = Object.keys(ARCHETYPES);
  const usedNames = new Set();
  for (let i = 0; i < 48; i++) {
    let username;
    do username = `${pick(FIRST)}${rand() < 0.5 ? '_' + pick(SUFFIX) : Math.floor(rand() * 90 + 10)}`; while (usedNames.has(username));
    usedNames.add(username);
    const primary = archNames[i % archNames.length];
    const secondary = rand() < 0.6 ? pick(archNames.filter((a) => a !== primary)) : null;
    const tastes = [[primary, 1], ...(secondary ? [[secondary, 0.5]] : [])];
    const name = username.split(/[_\d]/)[0];
    const { rows } = await query(
      `INSERT INTO users (username, email, password_hash, display_name, bio, avatar_hue, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING id`,
      [username, `${username}@demo.moviq.local`, hashDemo, name[0].toUpperCase() + name.slice(1),
        `Mostly here for ${primary === 'thinker' ? 'mind-bending' : primary} films.`, Math.floor(rand() * 360)],
    );
    users.push({ id: rows[0].id, username, tastes });
  }

  console.log('→ ratings, reviews & watch history');
  const reviewIds = [];
  for (const u of users) {
    const target = 22 + Math.floor(rand() * 34);
    const scored = movieRows
      .map((m) => ({ m, a: affinity(m, u.tastes) }))
      .map((x) => ({ ...x, w: 1 / (1 + Math.exp(-(x.a * 2 + x.m.quality * 1.5))) + rand() * 0.6 }))
      .sort((a, b) => b.w - a.w)
      .slice(0, target);
    const favs = [];
    for (const { m, a } of scored) {
      const raw = 3.1 + 1.25 * a + 1.2 * m.quality + gauss() * 0.55;
      const rating = Math.min(5, Math.max(0.5, Math.round(raw * 2) / 2));
      const liked = rating >= 4.5 || (rating >= 4 && rand() < 0.4);
      const watched = daysAgo(Math.floor(rand() * rand() * 400));
      let body = '';
      if (rand() < 0.38) body = composeReview(m, rating);
      const { rows } = await query(
        `INSERT INTO reviews (user_id, movie_id, rating, liked, body, watched_on, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::timestamptz::date,$6::timestamptz,$6::timestamptz) RETURNING id`,
        [u.id, m.id, rating, liked, body, watched],
      );
      if (body) reviewIds.push(rows[0].id);
      if (rating >= 4.5 && favs.length < 4) favs.push(m.id);
      await query(
        `INSERT INTO watch_history (user_id, movie_id, position_seconds, duration_seconds, completed, started_at, last_watched_at)
         VALUES ($1,$2,$3,$3,TRUE,$4,$4)`, [u.id, m.id, m.runtime * 60, watched],
      );
    }
    await query('UPDATE users SET favorite_ids=$2 WHERE id=$1', [u.id, favs]);
  }

  // Handwritten reviews, several with spoilers, so the Spoiler Shield has something to catch.
  for (const [i, r] of handwrittenReviews.entries()) {
    const m = byTitle[r.title];
    if (!m) { console.warn('   ! unknown title', r.title); continue; }
    const u = users[(i * 7) % users.length];
    const watched = daysAgo(1 + (i % 9));
    const { rows } = await query(
      `INSERT INTO reviews (user_id, movie_id, rating, liked, body, watched_on, author_spoiler, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::timestamptz::date,$7,$6::timestamptz,$6::timestamptz)
       ON CONFLICT (user_id, movie_id) DO UPDATE SET rating=$3, liked=$4, body=$5, author_spoiler=$7, created_at=$6::timestamptz, updated_at=$6::timestamptz
       RETURNING id`,
      [u.id, m.id, r.rating, r.rating >= 4.5, r.body, watched, r.authorSpoiler ?? false],
    );
    reviewIds.push(rows[0].id);
  }

  // A "this week" burst of viewing so Trending has a shape.
  const hot = ['Dune: Part Two', 'Past Lives', 'Oppenheimer', 'Everything Everywhere All at Once', 'Night of the Living Dead', 'Parasite', 'Poor Things', 'Vikram', 'The Holdovers', 'Spider-Man: Into the Spider-Verse'];
  for (const [rank, title] of hot.entries()) {
    const viewers = users.filter(() => rand() < 0.45 - rank * 0.03);
    for (const u of viewers) {
      const when = daysAgo(rand() * 6);
      await query(
        `INSERT INTO watch_history (user_id, movie_id, position_seconds, duration_seconds, completed, started_at, last_watched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT (user_id, movie_id) DO UPDATE SET last_watched_at=$6`,
        [u.id, byTitle[title].id, Math.floor(byTitle[title].runtime * 60 * rand()), byTitle[title].runtime * 60, rand() < 0.6, when],
      );
    }
  }

  // Review likes, follows
  for (const rid of reviewIds) {
    const n = Math.floor(rand() * rand() * 30);
    const likers = [...users].sort(() => rand() - 0.5).slice(0, n);
    for (const l of likers) await query('INSERT INTO review_likes (user_id, review_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [l.id, rid]);
  }
  for (const u of users) {
    for (const f of [...users].sort(() => rand() - 0.5).slice(0, 3 + Math.floor(rand() * 8))) {
      if (f.id !== u.id) await query('INSERT INTO follows VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, f.id]);
    }
  }
  for (const f of users.slice(0, 10)) await query('INSERT INTO follows VALUES ($1,$2) ON CONFLICT DO NOTHING', [demo, f.id]);

  // Popularity = recent watches + total ratings (TMDB sync overwrites with real popularity)
  await query(`
    UPDATE movies m SET popularity =
      (SELECT COUNT(*) FROM reviews r WHERE r.movie_id = m.id) +
      3 * (SELECT COUNT(*) FROM watch_history w WHERE w.movie_id = m.id AND w.last_watched_at > NOW() - INTERVAL '7 days')`);

  const counts = (await query(`SELECT (SELECT COUNT(*) FROM movies) movies, (SELECT COUNT(*) FROM users) users,
    (SELECT COUNT(*) FROM reviews) ratings, (SELECT COUNT(*) FROM reviews WHERE body <> '') reviews`)).rows[0];
  console.log('✓ seeded', counts);
  console.log('  Demo login → username: demo  password: moviq123');
  await pool.end();
}

function composeReview(m, rating) {
  const P = reviewPhrases;
  const tier = rating >= 4 ? 'high' : rating >= 3 ? 'mid' : 'low';
  const lines = [pick(P.open[tier])];
  const mood = m.moods[0];
  if (P.mood[mood] && rand() < 0.8) lines.push(pick(P.mood[mood]));
  if (rand() < 0.5 && m.cast[0]) lines.push(pick(P.cast[tier]).replace('{cast}', m.cast[0]));
  if (rand() < 0.4) lines.push(pick(P.craft[tier]));
  if (rand() < 0.5) lines.push(pick(P.close[tier]));
  return lines.join(' ');
}

main().catch((e) => { console.error(e); process.exit(1); });
