// The Express app, without starting a server: index.js listens on a port for local and container
// hosting, and api/index.js (repo root) hands it to Vercel as a serverless function.
import express from 'express';
import cookieParser from 'cookie-parser';
import { optionalAuth } from './middleware/auth.js';
import { ml } from './lib/ml.js';
import auth from './routes/auth.js';
import moviesRouter from './routes/movies.js';
import reviews from './routes/reviews.js';
import users from './routes/users.js';
import watch from './routes/watch.js';
import decide from './routes/decide.js';
import rooms from './routes/rooms.js';
import journal from './routes/journal.js';
import models from './routes/models.js';
import imports from './routes/imports.js';

const app = express();
// Behind a hosting proxy (Vercel, Render…), req.ip should be the visitor's address, not the proxy's.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.use('/api/import', express.json({ limit: '8mb' })); // history exports can be large
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(optionalAuth);

app.use('/api/auth', auth);
app.use('/api/movies', moviesRouter);
app.use('/api/reviews', reviews);
app.use('/api/users', users);
app.use('/api/watch', watch);
app.use('/api/decide', decide);
app.use('/api/rooms', rooms);
app.use('/api/journal', journal);
app.use('/api/models', models);
app.use('/api/import', imports);
app.get('/api/health', (_req, res) => res.json({ ok: true }));
// The client calls this on load. On a free host the ML service sleeps when idle, and this request is what
// starts waking it, so recommendations are ready by the time someone reaches them.
app.get('/api/wake', async (_req, res) => {
  res.json({ ml: !!(await ml('/health', undefined, { timeout: 2500, probe: true })) });
});

// Postgres errors that mean the request itself was bad (a malformed id or date, a film that doesn't exist).
const PG_CLIENT_ERRORS = {
  '22P02': [400, 'That request has a value in the wrong format.'],
  '22007': [400, 'That date isn’t valid.'],
  '22008': [400, 'That date isn’t valid.'],
  '22003': [400, 'That number is out of range.'],
  '23503': [404, 'We couldn’t find what that refers to. It may have been deleted.'],
  '23505': [409, 'That already exists.'],
};

export function errorHandler(err, _req, res, _next) {
  const pg = PG_CLIENT_ERRORS[err.code];
  if (pg) return res.status(pg[0]).json({ error: pg[1] });
  if (!err.expose) console.error(err);   // expected 4xx answers aren't worth a stack trace
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong on our side. Try again.' });
}

app.use('/api', errorHandler);

export default app;
