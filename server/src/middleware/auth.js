import jwt from 'jsonwebtoken';

export const COOKIE = 'moviq_token';
const SECRET = process.env.JWT_SECRET;

export function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '30d' });
}

export function setAuthCookie(res, user) {
  res.cookie(COOKIE, signToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

export function optionalAuth(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      req.user = jwt.verify(token, SECRET);
    } catch {
      req.user = null;
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}
