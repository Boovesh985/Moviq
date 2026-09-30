// Thin client for the Python ML service. Every call has a timeout and a fallback,
// so the site keeps working (with simpler rankings) if the ML service is down.
import { waitUntil } from '@vercel/functions';

const ML_URL = (process.env.ML_URL || 'http://localhost:8000').replace(/\/+$/, '');
// When the ML service is on the public internet (e.g. Render), it only answers requests carrying this token.
const ML_TOKEN = process.env.ML_TOKEN;
let warned = false;
// Circuit breaker: once the service times out or can't be reached (asleep on a free host, restarting),
// later calls go straight to their fallbacks for a while, so a page making several ML calls waits once,
// not once per call. Probes (the wake-up call) always go through.
const COOL_OFF_MS = 20_000;
let downUntil = 0;

export async function ml(pathname, body, { timeout = 4000, fallback = null, probe = false } = {}) {
  if (!probe && Date.now() < downUntil) return fallback;
  try {
    let res;
    try {
      res = await fetch(ML_URL + pathname, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(ML_TOKEN ? { 'X-Moviq-Token': ML_TOKEN } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      downUntil = Date.now() + COOL_OFF_MS;   // unreachable or too slow, not just one bad request
      throw e;
    }
    if (!res.ok) throw new Error(`${pathname} → ${res.status}`);
    warned = false;
    downUntil = 0;
    return await res.json();
  } catch (e) {
    if (!warned) console.warn(`[ml] unavailable (${e.message}); using fallbacks`);
    warned = true;
    return fallback;
  }
}

// Tell the recommender new data arrived. It refits in the background, except that the next request from
// the person whose data changed waits for the refit, so it reflects what they just did.
// Nobody waits on this; waitUntil keeps a serverless function (Vercel) alive until it's sent.
export const mlRefresh = (userId = null) => {
  const sent = ml('/refresh', { user_id: userId }, { timeout: 1500 });
  waitUntil(sent);
  return sent;
};
