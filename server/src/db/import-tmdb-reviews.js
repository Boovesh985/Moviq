// Imports real user reviews from TMDB (https://www.themoviedb.org) for films in the catalog.
// TMDB's API terms allow displaying this content with attribution; each review links back to its
// original page. Reviewers become read-only accounts (source 'tmdb'); a review's 1–10 score maps to stars.
//
//   npm run import:tmdb-reviews               up to 10 reviews per film
//   npm run import:tmdb-reviews -- --per 20
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool, query, many, one } from './pool.js';
import { hasTmdbKey, pool8, tmdb } from '../lib/tmdb.js';

if (!hasTmdbKey()) {
  console.error('TMDB_API_KEY is empty. Add it to server/.env first.');
  process.exit(1);
}
const argPer = process.argv.indexOf('--per');
const PER_FILM = argPer > -1 ? Number(process.argv[argPer + 1]) : 10;

// TMDB review bodies are loosely Markdown/HTML; keep plain text with paragraph breaks.
function clean(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|\*|_|~~|#+\s)/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '’').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 5000);
}

const toStars = (score) => (score == null ? null : Math.min(5, Math.max(0.5, Math.round(score) / 2)));

function usernameFor(author) {
  const base = author.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'reviewer';
  return `tmdb_${base}_${crypto.createHash('md5').update(author).digest('hex').slice(0, 4)}`;
}

async function main() {
  const films = await many('SELECT id, tmdb_id, title FROM movies WHERE tmdb_id IS NOT NULL ORDER BY popularity DESC');
  console.log(`→ fetching reviews for ${films.length} films (up to ${PER_FILM} each)`);
  const lockedHash = await bcrypt.hash(`locked-${Math.random()}`, 10);
  const userIds = new Map((await many(`SELECT id, username FROM users WHERE source = 'tmdb'`)).map((u) => [u.username, u.id]));
  let added = 0;
  let done = 0;

  await pool8(films, async (film) => {
    const data = await tmdb(`/movie/${film.tmdb_id}/reviews`, { page: 1 });
    const reviews = (data?.results || [])
      .filter((r) => r.content && r.content.length >= 60)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, PER_FILM);
    for (const r of reviews) {
      const author = r.author_details?.username || r.author;
      const username = usernameFor(author);
      let uid = userIds.get(username);
      if (!uid) {
        uid = (await one(
          `INSERT INTO users (username, email, password_hash, display_name, bio, avatar_hue, source)
           VALUES ($1, $2, $3, $4, 'Reviews imported from TMDB.', $5, 'tmdb')
           ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
          [username, `${username}@tmdb.invalid`, lockedHash, (r.author_details?.name || r.author || author).slice(0, 60),
            parseInt(crypto.createHash('md5').update(username).digest('hex').slice(0, 6), 16) % 360],
        )).id;
        userIds.set(username, uid);
      }
      const inserted = await one(
        `INSERT INTO reviews (user_id, movie_id, rating, body, watched_on, created_at, updated_at, source_url, external_id)
         VALUES ($1, $2, $3, $4, $5::timestamptz::date, $5::timestamptz, $6::timestamptz, $7, $8)
         ON CONFLICT DO NOTHING RETURNING id`,
        [uid, film.id, toStars(r.author_details?.rating), clean(r.content), r.created_at, r.updated_at || r.created_at, r.url, `tmdb:${r.id}`],
      );
      if (inserted) {
        added++;
        await query(`INSERT INTO watch_history (user_id, movie_id, completed, started_at, last_watched_at)
                     VALUES ($1, $2, TRUE, $3, $3) ON CONFLICT DO NOTHING`, [uid, film.id, r.created_at]);
      }
    }
    process.stdout.write(`\r   ${++done}/${films.length} films, ${added} reviews`);
  }, 6);
  console.log();

  const c = await one(`SELECT (SELECT COUNT(*) FROM users WHERE source = 'tmdb') reviewers,
                              (SELECT COUNT(*) FROM reviews WHERE external_id LIKE 'tmdb:%') reviews,
                              (SELECT COUNT(*) FROM reviews WHERE external_id LIKE 'tmdb:%' AND rating IS NOT NULL) rated`);
  console.log('✓ imported', c);
  console.log('  The ML learner scores them for spoilers and sentiment within a few minutes.');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
