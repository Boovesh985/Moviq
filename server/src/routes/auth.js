import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { one } from '../db/pool.js';
import { setAuthCookie, COOKIE, HttpError } from '../middleware/auth.js';

const r = Router();
const PUBLIC = 'id, username, email, display_name, bio, avatar_hue, services, favorite_ids, is_admin';

r.post('/register', async (req, res) => {
  const { username, email: rawEmail, password: rawPassword, displayName } = req.body ?? {};
  const uname = String(username ?? '').trim().toLowerCase();
  const email = String(rawEmail ?? '').trim();
  const password = String(rawPassword ?? '');
  if (!/^[a-z0-9_]{3,20}$/.test(uname)) throw new HttpError(400, 'Usernames are 3–20 characters: letters, numbers and underscores.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if (await one('SELECT 1 FROM users WHERE username=$1 OR email=$2', [uname, email.toLowerCase()])) {
    throw new HttpError(409, 'That username or email is already registered.');
  }
  const user = await one(
    `INSERT INTO users (username, email, password_hash, display_name, avatar_hue)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${PUBLIC}`,
    [uname, email.toLowerCase(), await bcrypt.hash(password, 10), String(displayName ?? '').trim().slice(0, 40) || uname, Math.floor(Math.random() * 360)],
  );
  setAuthCookie(res, user);
  res.status(201).json({ user });
});

r.post('/login', async (req, res) => {
  const login = String(req.body?.login ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const row = await one(`SELECT ${PUBLIC}, password_hash FROM users WHERE username=$1 OR email=$1`, [login]);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new HttpError(401, 'That username and password don’t match.');
  }
  delete row.password_hash;
  setAuthCookie(res, row);
  res.json({ user: row });
});

// One-click guest account for demos: no email or password. Capped per IP so the button can't be used to flood the database.
const guestsByIp = new Map();
r.post('/guest', async (req, res) => {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${req.ip}|${hour}`;
  if ((guestsByIp.get(key) ?? 0) >= 20) throw new HttpError(429, 'Too many guest accounts from here. Try again in an hour.');
  guestsByIp.set(key, (guestsByIp.get(key) ?? 0) + 1);
  for (const k of guestsByIp.keys()) if (!k.endsWith(`|${hour}`)) guestsByIp.delete(k);

  const tag = crypto.randomBytes(3).toString('hex');
  const user = await one(
    `INSERT INTO users (username, email, password_hash, display_name, avatar_hue)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${PUBLIC}`,
    [`guest_${tag}`, `guest_${tag}@guest.moviq`, await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), `Guest ${tag.toUpperCase()}`, Math.floor(Math.random() * 360)],
  );
  setAuthCookie(res, user);
  res.status(201).json({ user });
});

r.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

// "Who am I?" Signed out is a normal answer here (user: null), not an error, so the browser console
// stays clean on the sign-in page.
r.get('/me', async (req, res) => {
  const user = req.user ? await one(`SELECT ${PUBLIC} FROM users WHERE id=$1`, [req.user.id]) : null;
  if (req.user && !user) res.clearCookie(COOKIE);   // account deleted (e.g. a demo guest cleaned up)
  res.json({ user });
});

export default r;
