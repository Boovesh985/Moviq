// Replaces the synthetic demo community with real people: the MovieLens latest-small dataset
// (GroupLens, 610 raters, 0.5–5★ — the same scale as Moviq). Films they rated often enough are
// added to the catalog with TMDB metadata. Handwritten demo reviews are kept so the Spoiler Shield
// still has examples; they're attached to a real rater of that film with the closest rating when
// possible, otherwise to an editorial account that the recommender ignores.
//
//   npm run import:movielens              films with ≥ 20 ratings
//   npm run import:movielens -- --min 10  more films
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { pool, query, many, one } from './pool.js';
import { details, extract, hasTmdbKey, insertFromTmdb, moodsFor, pool8 } from '../lib/tmdb.js';
import { handwrittenReviews } from './reviews.data.js';

const DIR = new URL('../../../ml/data/external/movielens/', import.meta.url);
const argMin = process.argv.indexOf('--min');
const MIN_RATINGS = argMin > -1 ? Number(process.argv[argMin + 1]) : 20;
const ML_GENRES = { Children: 'Family', 'Film-Noir': 'Crime', Musical: 'Music' };

function readCsv(name) {
  const path = new URL(name, DIR);
  if (!fs.existsSync(path)) {
    console.error(`Missing ${name}. Run "python download_data.py" in ml/ first.`);
    process.exit(1);
  }
  const rows = [];
  const text = fs.readFileSync(path, 'utf8');
  const re = /("([^"]|"")*"|[^,\r\n]*)(,|\r?\n|$)/g;
  let row = [];
  let m;
  while ((m = re.exec(text)) && m[0] !== '') {
    let v = m[1];
    if (v.startsWith('"')) v = v.slice(1, -1).replace(/""/g, '"');
    row.push(v);
    if (m[3] !== ',') { rows.push(row); row = []; }
  }
  const [header, ...data] = rows;
  return data.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// "Matrix, The (1999)" → { title: "The Matrix", year: 1999 }
function parseTitle(raw) {
  const m = raw.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  let title = (m ? m[1] : raw).replace(/\s*\(.*?\)\s*$/, '').trim();
  const art = title.match(/^(.*), (The|A|An|Les|La|Le|Il|El|Das|Die)$/);
  if (art) title = `${art[2]} ${art[1]}`;
  return { title, year: m ? Number(m[2]) : null };
}
const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

async function batchInsert(sql, columns, rows, size = 4000) {
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    await query(sql, columns.map((_, c) => chunk.map((r) => r[c])));
  }
}

async function main() {
  console.log('→ reading MovieLens');
  const ratings = readCsv('ratings.csv');
  const links = Object.fromEntries(readCsv('links.csv').map((l) => [l.movieId, l]));
  const mlMovies = Object.fromEntries(readCsv('movies.csv').map((m) => [m.movieId, m]));
  const counts = {};
  for (const r of ratings) counts[r.movieId] = (counts[r.movieId] || 0) + 1;
  console.log(`   ${ratings.length} ratings, ${Object.keys(mlMovies).length} films, ${new Set(ratings.map((r) => r.userId)).size} people`);

  // 1. Map MovieLens films onto the catalog (by TMDB id, then title + year)
  console.log('→ matching films');
  const catalog = await many('SELECT id, title, year, tmdb_id FROM movies');
  const byTmdb = new Map(catalog.filter((m) => m.tmdb_id).map((m) => [m.tmdb_id, m.id]));
  const byTitle = new Map(catalog.map((m) => [`${norm(m.title)}|${m.year}`, m.id]));
  const mlToMoviq = {};
  for (const [mlId, m] of Object.entries(mlMovies)) {
    const link = links[mlId];
    const { title, year } = parseTitle(m.title);
    const id = byTmdb.get(Number(link?.tmdbId)) ?? byTitle.get(`${norm(title)}|${year}`);
    if (id) mlToMoviq[mlId] = id;
  }
  console.log(`   ${Object.keys(mlToMoviq).length} already in the catalog`);

  // 2. Add films rated often enough
  const wanted = Object.keys(mlMovies).filter((id) => !mlToMoviq[id] && (counts[id] || 0) >= MIN_RATINGS);
  console.log(`→ adding ${wanted.length} films with ≥ ${MIN_RATINGS} ratings ${hasTmdbKey() ? '(TMDB metadata)' : '(no TMDB key: basic metadata)'}`);
  let done = 0;
  await pool8(wanted, async (mlId) => {
    const link = links[mlId];
    const imdb = link?.imdbId ? `tt${link.imdbId}` : null;
    try {
      if (hasTmdbKey() && link?.tmdbId) {
        const d = await details(Number(link.tmdbId));
        if (d?.id) {
          mlToMoviq[mlId] = await insertFromTmdb(d, { movielens_id: Number(mlId), imdb_id: imdb });
          return;
        }
      }
      const { title, year } = parseTitle(mlMovies[mlId].title);
      const genres = mlMovies[mlId].genres.split('|').map((g) => ML_GENRES[g] || g).filter((g) => !['(no genres listed)', 'IMAX'].includes(g));
      const row = await one(
        `INSERT INTO movies (title, year, genres, moods, movielens_id, imdb_id, popularity) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (movielens_id) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
        [title, year, genres, moodsFor(genres), Number(mlId), imdb, counts[mlId]],
      );
      mlToMoviq[mlId] = row.id;
    } finally {
      process.stdout.write(`\r   ${++done}/${wanted.length}`);
    }
  });
  console.log();
  // 2b. Retry films that only got basic metadata (e.g. TMDB rate-limited us on a previous run)
  if (hasTmdbKey()) {
    const thin = await many(`SELECT id, movielens_id FROM movies WHERE movielens_id IS NOT NULL AND poster_url IS NULL`);
    if (thin.length) console.log(`→ filling metadata for ${thin.length} films`);
    let fixed = 0;
    await pool8(thin, async (m) => {
      const link = links[m.movielens_id];
      const d = link?.tmdbId && (await details(Number(link.tmdbId)));
      if (!d?.id || (await one('SELECT 1 FROM movies WHERE tmdb_id = $1 AND id <> $2', [d.id, m.id]))) return;
      const x = extract(d);
      await query(
        `UPDATE movies SET tmdb_id=$2, title=$3, runtime=$4, overview=$5, tagline=$6, genres=$7, moods=$8, director=$9, cast_names=$10,
           certification=$11, poster_url=$12, backdrop_url=$13, trailer_key=$14, providers=$15, tmdb_rating=$16, popularity=$17 WHERE id=$1`,
        [m.id, d.id, d.title, d.runtime || null, d.overview || '', x.tagline, x.genres, moodsFor(x.genres), x.director, x.cast,
          x.cert || 'NR', x.poster, x.backdrop, x.trailer, x.providers, d.vote_average, d.popularity],
      );
      fixed++;
    }, 3);
    if (thin.length) console.log(`   filled ${fixed}`);
  }

  for (const [mlId, id] of Object.entries(mlToMoviq)) {
    await query('UPDATE movies SET movielens_id = COALESCE(movielens_id, $2) WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM movies WHERE movielens_id = $2 AND id <> $1)', [id, Number(mlId)]);
  }

  // 3. Replace the synthetic community (and any previous import) with MovieLens raters
  console.log('→ replacing synthetic members with MovieLens raters');
  await query(`DELETE FROM users WHERE source IN ('synthetic', 'movielens', 'editorial')`);
  const kept = ratings.filter((r) => mlToMoviq[r.movieId]);
  const perUser = {};
  for (const r of kept) (perUser[r.userId] ??= []).push(r);
  const people = Object.keys(perUser).filter((u) => perUser[u].length >= 5);
  const hash = await bcrypt.hash(`locked-${Math.random()}`, 10); // imported accounts can't sign in
  await batchInsert(
    `INSERT INTO users (username, email, password_hash, display_name, bio, avatar_hue, is_demo, source)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::bool[], $8::text[])`,
    Array(8).fill(0),
    people.map((u) => [`ml_${u}`, `ml${u}@movielens.invalid`, hash, `MovieLens #${u}`,
      'Real ratings from the MovieLens research dataset (GroupLens).', (Number(u) * 47) % 360, true, 'movielens']),
  );
  const idOf = Object.fromEntries((await many(`SELECT id, username FROM users WHERE source = 'movielens'`)).map((u) => [u.username.slice(3), u.id]));

  const rows = kept.filter((r) => idOf[r.userId]);
  await batchInsert(
    `INSERT INTO reviews (user_id, movie_id, rating, watched_on, created_at, updated_at)
     SELECT u, m, r, to_timestamp(t)::date, to_timestamp(t), to_timestamp(t)
     FROM unnest($1::int[], $2::int[], $3::numeric[], $4::bigint[]) AS x(u, m, r, t)
     ON CONFLICT (user_id, movie_id) DO NOTHING`,
    Array(4).fill(0), rows.map((r) => [idOf[r.userId], mlToMoviq[r.movieId], Number(r.rating), Number(r.timestamp)]),
  );
  await batchInsert(
    `INSERT INTO watch_history (user_id, movie_id, position_seconds, duration_seconds, completed, started_at, last_watched_at)
     SELECT u, m, 0, 0, TRUE, to_timestamp(t), to_timestamp(t) FROM unnest($1::int[], $2::int[], $3::bigint[]) AS x(u, m, t)
     ON CONFLICT DO NOTHING`,
    Array(3).fill(0), rows.map((r) => [idOf[r.userId], mlToMoviq[r.movieId], Number(r.timestamp)]),
  );
  await query(`UPDATE users u SET favorite_ids = COALESCE((SELECT array_agg(movie_id) FROM (
                 SELECT movie_id FROM reviews r WHERE r.user_id = u.id AND r.rating = 5 ORDER BY r.created_at DESC LIMIT 4) f), '{}')
               WHERE u.source = 'movielens'`);
  console.log(`   ${people.length} people, ${rows.length} ratings`);

  // 4. Keep the handwritten demo reviews (the Spoiler Shield's showcase)
  console.log('→ re-attaching handwritten reviews');
  const editors = [];
  for (const [name, display] of [['moviq_editors', 'Moviq Editors'], ['moviq_club', 'Moviq Film Club'], ['moviq_desk', 'Moviq Review Desk']]) {
    editors.push((await one(
      `INSERT INTO users (username, email, password_hash, display_name, bio, avatar_hue, is_demo, source)
       VALUES ($1, $2, $3, $4, 'Sample reviews written for the demo. Excluded from recommendations.', 20, TRUE, 'editorial') RETURNING id`,
      [name, `${name}@moviq.invalid`, hash, display])).id);
  }
  let attached = 0;
  for (const h of handwrittenReviews) {
    const film = await one('SELECT id FROM movies WHERE title = $1 ORDER BY movielens_id NULLS LAST LIMIT 1', [h.title]);
    if (!film) continue;
    const rater = await one(`SELECT r.id FROM reviews r JOIN users u ON u.id = r.user_id
                             WHERE r.movie_id = $1 AND u.source = 'movielens' AND r.body = ''
                             ORDER BY abs(r.rating - $2), random() LIMIT 1`, [film.id, h.rating]);
    if (rater) {
      await query('UPDATE reviews SET body = $2, author_spoiler = $3, spoiler_score = 0 WHERE id = $1', [rater.id, h.body, h.authorSpoiler ?? false]);
    } else {
      const editor = await one(`SELECT e FROM unnest($1::int[]) e WHERE NOT EXISTS (SELECT 1 FROM reviews WHERE user_id = e AND movie_id = $2) LIMIT 1`, [editors, film.id]);
      await query(`INSERT INTO reviews (user_id, movie_id, rating, liked, body, author_spoiler, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6, NOW() - random() * INTERVAL '20 days', NOW())`,
      [editor.e, film.id, h.rating, h.rating >= 4.5, h.body, h.authorSpoiler ?? false]);
    }
    attached++;
  }
  console.log(`   ${attached} reviews`);

  // 5. The demo account follows the most active raters so friend activity has something in it
  const demo = await one(`SELECT id FROM users WHERE username = 'demo'`);
  if (demo) {
    await query(`INSERT INTO follows (follower_id, followee_id)
                 SELECT $1, user_id FROM reviews r JOIN users u ON u.id = r.user_id WHERE u.source = 'movielens'
                 GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 12 ON CONFLICT DO NOTHING`, [demo.id]);
  }

  const c = await one(`SELECT (SELECT COUNT(*) FROM movies) films, (SELECT COUNT(*) FROM users WHERE source = 'movielens') people,
                              (SELECT COUNT(*) FROM reviews) ratings, (SELECT COUNT(*) FROM reviews WHERE body <> '') reviews`);
  console.log('✓ imported', c);
  console.log('  Restart the ML service so the recommender retrains on the real ratings.');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
