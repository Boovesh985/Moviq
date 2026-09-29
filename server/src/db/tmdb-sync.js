// Enriches the catalog from TMDB: posters, backdrops, trailers, where-to-watch, popularity.
//   npm run sync:tmdb                 enrich existing films
//   npm run sync:tmdb -- --discover 3 also import 3 pages of popular + top-rated films
import { pool, query, many, one } from './pool.js';
import { REGION, details, extract, hasTmdbKey, insertFromTmdb, tmdb } from '../lib/tmdb.js';

if (!hasTmdbKey()) {
  console.error('TMDB_API_KEY is empty. Get a free key at https://www.themoviedb.org/settings/api and add it to server/.env');
  process.exit(1);
}

async function enrichExisting() {
  const films = await many('SELECT id, title, year, tmdb_id FROM movies ORDER BY id');
  let ok = 0;
  for (const f of films) {
    let tmdbId = f.tmdb_id;
    if (!tmdbId) {
      const found = await tmdb('/search/movie', { query: f.title, year: f.year });
      const hit = found?.results?.[0] || (await tmdb('/search/movie', { query: f.title }))?.results?.find((x) => x.release_date?.startsWith(String(f.year)));
      if (!hit) { console.log(`   ✕ ${f.title} (${f.year}) not found`); continue; }
      tmdbId = hit.id;
    }
    const d = await details(tmdbId);
    if (!d) continue;
    const x = extract(d);
    await query(
      `UPDATE movies SET tmdb_id=$2, poster_url=COALESCE($3, poster_url), backdrop_url=COALESCE($4, backdrop_url), trailer_key=COALESCE($5, trailer_key),
         providers=$6, tagline=$7, tmdb_rating=$8, popularity=GREATEST(popularity, $9), imdb_id=COALESCE(imdb_id, $10) WHERE id=$1`,
      [f.id, tmdbId, x.poster, x.backdrop, x.trailer, x.providers, x.tagline, d.vote_average, d.popularity, d.imdb_id || null],
    ).catch((e) => console.log(`   ✕ ${f.title}: ${e.message}`));
    ok++;
    process.stdout.write(`\r   enriched ${ok}/${films.length}`);
  }
  console.log();
}

async function discover(pages) {
  let added = 0;
  for (const list of ['/movie/popular', '/movie/top_rated']) {
    for (let page = 1; page <= pages; page++) {
      const data = await tmdb(list, { page, region: REGION });
      for (const hit of data?.results || []) {
        if (await one('SELECT 1 FROM movies WHERE tmdb_id=$1', [hit.id])) continue;
        const d = await details(hit.id);
        if (!d || !d.runtime || !d.overview) continue;
        await insertFromTmdb(d, { imdb_id: d.imdb_id });
        added++;
        process.stdout.write(`\r   imported ${added}`);
      }
    }
  }
  console.log();
}

const i = process.argv.indexOf('--discover');
console.log(`→ enriching catalog from TMDB (region ${REGION})`);
await enrichExisting();
if (i > -1) {
  console.log('→ importing popular & top-rated films');
  await discover(Number(process.argv[i + 1]) || 2);
}
console.log('✓ done. Restart the ML service (or wait ~5 min) so new films enter the recommender.');
await pool.end();
