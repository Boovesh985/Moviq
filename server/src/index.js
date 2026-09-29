import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { optionalAuth } from './middleware/auth.js';
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

// In production, serve the built React app from the same origin.
const dist = path.resolve(import.meta.dirname, '../../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Postgres errors that mean the request itself was bad (a malformed id or date, a film that doesn't exist).
const PG_CLIENT_ERRORS = {
  '22P02': [400, 'That request has a value in the wrong format.'],
  '22007': [400, 'That date isn’t valid.'],
  '22008': [400, 'That date isn’t valid.'],
  '22003': [400, 'That number is out of range.'],
  '23503': [404, 'We couldn’t find what that refers to. It may have been deleted.'],
  '23505': [409, 'That already exists.'],
};

app.use((err, _req, res, _next) => {
  const pg = PG_CLIENT_ERRORS[err.code];
  if (pg) return res.status(pg[0]).json({ error: pg[1] });
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong on our side. Try again.' });
});

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => {
  console.log(`Moviq API on http://localhost:${port}`);
});
// Node clients (including the Vite dev proxy) drop idle keep-alive sockets after 5s, the same as Node's
// server default, so a request sent on a socket the server is closing gets ECONNRESET. Outlast them.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
