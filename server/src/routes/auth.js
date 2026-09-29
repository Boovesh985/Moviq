import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one } from '../db/pool.js';
import { setAuthCookie, COOKIE, requireAuth, HttpError } from '../middleware/auth.js';

const r = Router();
const PUBLIC = 'id, username, email, display_name, bio, avatar_hue, services, favorite_ids, is_admin';

r.post('/register', async (req, res) => {
  const { username = '', email = '', password = '', displayName } = req.body ?? {};
  const uname = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(uname)) throw new HttpError(400, 'Usernames are 3–20 characters: letters, numbers and underscores.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if (await one('SELECT 1 FROM users WHERE username=$1 OR email=$2', [uname, email.toLowerCase()])) {
    throw new HttpError(409, 'That username or email is already registered.');
  }
  const user = await one(
    `INSERT INTO users (username, email, password_hash, display_name, avatar_hue)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${PUBLIC}`,
    [uname, email.toLowerCase(), await bcrypt.hash(password, 10), displayName?.trim() || uname, Math.floor(Math.random() * 360)],
  );
  setAuthCookie(res, user);
  res.status(201).json({ user });
});

r.post('/login', async (req, res) => {
  const { login = '', password = '' } = req.body ?? {};
  const row = await one(`SELECT ${PUBLIC}, password_hash FROM users WHERE username=$1 OR email=$1`, [login.trim().toLowerCase()]);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new HttpError(401, 'That username and password don’t match.');
  }
  delete row.password_hash;
  setAuthCookie(res, row);
  res.json({ user: row });
});

r.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

r.get('/me', requireAuth, async (req, res) => {
  const user = await one(`SELECT ${PUBLIC} FROM users WHERE id=$1`, [req.user.id]);
  if (!user) throw new HttpError(401, 'Sign in to continue.');
  res.json({ user });
});

export default r;
