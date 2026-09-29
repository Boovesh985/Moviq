// Thin client for the Python ML service. Every call has a timeout and a fallback,
// so the site keeps working (with simpler rankings) if the ML service is down.
const ML_URL = process.env.ML_URL || 'http://localhost:8000';
let warned = false;

export async function ml(pathname, body, { timeout = 6000, fallback = null } = {}) {
  try {
    const res = await fetch(ML_URL + pathname, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`${pathname} → ${res.status}`);
    warned = false;
    return await res.json();
  } catch (e) {
    if (!warned) console.warn(`[ml] unavailable (${e.message}); using fallbacks`);
    warned = true;
    return fallback;
  }
}

// Tell the recommender new data arrived. It refits in the background, except that the next request from
// the person whose data changed waits for the refit, so it reflects what they just did.
export const mlRefresh = (userId = null) => ml('/refresh', { user_id: userId }, { timeout: 1000 });
