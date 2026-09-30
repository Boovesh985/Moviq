import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import app, { errorHandler } from './app.js';

// In production (a single container), serve the built React app from the same origin.
const dist = path.resolve(import.meta.dirname, '../../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  app.use(errorHandler);
}

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, () => {
  console.log(`Moviq API on http://localhost:${port}`);
});
// Node clients (including the Vite dev proxy) drop idle keep-alive sockets after 5s, the same as Node's
// server default, so a request sent on a socket the server is closing gets ECONNRESET. Outlast them.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
