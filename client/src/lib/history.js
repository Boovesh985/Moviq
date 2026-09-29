// Parses Letterboxd and Netflix exports in the browser, so only clean rows are uploaded.
import { strFromU8, unzipSync } from 'fflate';

/** RFC 4180-ish CSV: quoted fields may contain commas, quotes ("") and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows.filter((r) => r.some((v) => v.trim()));
  return (data || []).map((r) => Object.fromEntries((header || []).map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const stripHtml = (s) => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, '’');

/** Merges a Letterboxd export (ZIP or individual CSVs) into one entry per film. */
export async function readLetterboxd(files) {
  const csvs = {};
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
      for (const [path, bytes] of Object.entries(zip)) if (/\.csv$/i.test(path)) csvs[path.toLowerCase()] = strFromU8(bytes);
    } else if (/\.csv$/i.test(file.name)) {
      csvs[file.name.toLowerCase()] = await file.text();
    }
  }
  // The export also holds deleted/, orphaned/ and lists/ folders with same-named CSVs: only read the top-level ones.
  const other = /(^|\/)(deleted|orphaned|lists)\//;
  const pick = (name) => Object.entries(csvs).filter(([p]) => (p === name || p.endsWith(`/${name}`)) && !other.test(p)).flatMap(([, t]) => parseCsv(t));
  const entries = new Map();
  const entry = (row) => {
    const key = `${row.Name}|${row.Year}`;
    if (!entries.has(key)) entries.set(key, { name: row.Name, year: row.Year });
    return entries.get(key);
  };
  const isLikes = (p) => /likes\/films\.csv$/.test(p);

  for (const row of pick('watched.csv')) entry(row).watched = true;
  for (const row of pick('ratings.csv')) Object.assign(entry(row), { watched: true, rating: Number(row.Rating) || null });
  for (const row of pick('diary.csv')) {
    const e = entry(row);
    Object.assign(e, { watched: true, watched_on: row['Watched Date'] || row.Date, rewatch: row.Rewatch === 'Yes' });
    if (row.Rating) e.rating = Number(row.Rating);
  }
  for (const row of pick('reviews.csv')) {
    const e = entry(row);
    Object.assign(e, { watched: true, review: stripHtml(row.Review || ''), watched_on: row['Watched Date'] || e.watched_on });
    if (row.Rating) e.rating = Number(row.Rating);
  }
  for (const [p, text] of Object.entries(csvs)) if (isLikes(p) && !other.test(p)) for (const row of parseCsv(text)) entry(row).liked = true;
  for (const row of pick('watchlist.csv')) {
    const e = entry(row);
    if (!e.watched) e.watchlist = true;
  }
  return [...entries.values()].filter((e) => e.name);
}

const EPISODE = /:\s*(season|series|episode|chapter|part|volume|limited series|book|collection)\b|\bseason \d|\bepisode \d/i;

const SHORT_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;

/**
 * Netflix writes short dates in the account's locale: 12/25/23 in the US, 25/12/23 in India and Europe.
 * Any date whose first part is over 12 settles it as day-first for the whole file (and one whose second
 * part is over 12 as month-first). If nothing settles it, day-first is the more common format worldwide.
 */
function dayFirst(values) {
  for (const v of values) {
    const m = SHORT_DATE.exec(v || '');
    if (m && +m[1] > 12) return true;
    if (m && +m[2] > 12) return false;
  }
  return true;
}

function parseNetflixDate(s, dmy) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = SHORT_DATE.exec(s);
  if (!m) return null;
  const [day, month] = dmy ? [m[1], m[2]] : [m[2], m[1]];
  if (+month < 1 || +month > 12 || +day < 1 || +day > 31) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/** Netflix history: NetflixViewingHistory.csv (Title, Date) or ViewingActivity.csv (full data export). */
export async function readNetflix(file) {
  const rows = parseCsv(await file.text());
  const dmy = dayFirst(rows.map((r) => r.Date));
  const films = new Map();
  for (const row of rows) {
    const title = row.Title;
    if (!title || EPISODE.test(title)) continue;
    if (row['Supplemental Video Type']) continue; // trailers, teasers, recaps
    if (row.Duration) {
      const [h, m] = row.Duration.split(':').map(Number);
      if (h * 60 + m < 20) continue; // sampled, not watched
    }
    const date = parseNetflixDate(row['Start Time'] || row.Date, dmy);
    const prev = films.get(title);
    if (!prev || (date && date > prev.date)) films.set(title, { title, date });
  }
  return [...films.values()];
}
