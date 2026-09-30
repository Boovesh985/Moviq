// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json) and handled by the
// same Express app that runs locally. The React app is served as static files from client/dist.
export { default } from '../server/src/app.js';
