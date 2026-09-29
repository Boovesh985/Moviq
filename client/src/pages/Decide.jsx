import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtRuntime } from '../api.js';
import Poster from '../components/Poster.jsx';
import { Cert } from '../components/MovieCard.jsx';
import { Play, Shuffle, X } from '../components/Icons.jsx';

const TIMES = [[100, 'Under 1h 40m'], [120, 'About 2 hours'], [150, '2½ hours'], [null, 'No limit']];
const MOODS = ['feel-good', 'funny', 'thrilling', 'mind-bending', 'romantic', 'emotional', 'scary', 'epic', 'cozy', 'dark', 'inspiring', 'action-packed'];
const COMPANY = [['solo', 'Just me'], ['date', 'Date night'], ['friends', 'Friends'], ['family', 'Family (kid-safe)']];
const LIMIT = 60;

/** Retry a request that failed in transit or on the server (not one that was refused), with a short backoff. */
async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || (e.status && e.status < 500)) throw e;
      await new Promise((r) => setTimeout(r, 600 * i));
    }
  }
}

/** Film-leader countdown: the signature of decide mode. */
function Leader({ left, done }) {
  const pct = (left / LIMIT) * 100;
  return (
    <div className={`leader ${done ? 'done' : ''} ${left <= 10 && !done ? 'urgent' : ''}`} role="timer" aria-label={`${left} seconds left`}>
      <div className="leader-sweep" style={{ '--p': `${pct}%` }} />
      <span className="leader-cross" />
      <span className="leader-ring" />
      <span className="leader-num">{done ? '✓' : left}</span>
    </div>
  );
}

function Chip({ on, onClick, children, mood }) {
  return <button type="button" className={`dchip ${mood ? 'mood' : ''} ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick}>{children}</button>;
}

export default function Decide() {
  const nav = useNavigate();
  const [left, setLeft] = useState(LIMIT);
  const [time, setTime] = useState(120);
  const [moods, setMoods] = useState([]);
  const [company, setCompany] = useState('solo');
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [picks, setPicks] = useState(null);
  const [seen, setSeen] = useState([]);
  const [busy, setBusy] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(Date.now());
  const [tookSec, setTookSec] = useState(null);
  const state = useRef({});
  state.current = { time, moods, company, onlyAvailable };

  const decide = async (exclude = [], auto = false) => {
    setBusy(true);
    setError('');
    const s = state.current;
    const ask = (loosen) => retry(() => api.post('/decide', {
      max_runtime: s.time, moods: s.moods, company: s.company, only_available: s.onlyAvailable, exclude_ids: exclude, ...loosen,
    }));
    // When the clock runs out nobody pressed anything, so always land on picks: drop answers that rule everything out.
    const steps = auto ? [{}, { moods: [] }, { moods: [], max_runtime: null, only_available: false }] : [{}];
    try {
      let p = [];
      for (const loosen of steps) {
        ({ picks: p } = await ask(loosen));
        if (p.length) break;
      }
      if (!p.length) throw new Error('Nothing fits all of that. Loosen the time limit or pick a different mood.');
      setPicks(p);
      setSeen((x) => [...new Set([...x, ...p.map((m) => m.id)])]);
      setTookSec((t) => t ?? Math.round((Date.now() - started.current) / 1000));
      if (auto) setTimedOut(true);
    } catch (e) {
      setError(e.status && e.status < 500 ? e.message : 'Couldn’t reach Moviq just now. Press the button to try again.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (picks) return;
    if (left <= 0) { decide([], true); return; }
    const t = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(t);
  }, [left, picks]);

  const swap = async (id) => {
    const { picks: p } = await api.post('/decide', {
      max_runtime: time, moods, company, only_available: onlyAvailable, exclude_ids: [...seen, ...picks.map((x) => x.id)],
    });
    if (!p.length) return;
    setSeen((x) => [...x, p[0].id]);
    setPicks((cur) => cur.map((x) => (x.id === id ? p[0] : x)));
  };

  const restart = () => {
    setPicks(null); setSeen([]); setTimedOut(false); setTookSec(null); setLeft(LIMIT); started.current = Date.now();
  };

  const toggleMood = (m) => setMoods((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur.slice(-1), m]));

  if (picks) {
    return (
      <main className="screen decide">
        <header className="decide-result-head">
          <Leader left={0} done />
          <div>
            <p className="decide-kicker">{timedOut ? 'Time’s up. Here’s what we’d watch.' : `Decided in ${tookSec}s`}</p>
            <h1 className="decide-h1">Tonight, pick one of these</h1>
            <p className="decide-sub">
              {TIMES.find(([v]) => v === time)?.[1]} · {moods.length ? moods.join(' + ') : 'any mood'} · {COMPANY.find(([v]) => v === company)[1]}
            </p>
          </div>
          <button className="btn btn-line btn-sm" onClick={restart}><Shuffle /> Start over</button>
        </header>
        <div className="picks">
          {picks.map((m, i) => (
            <article key={m.id} className="pick-card" style={{ '--i': i }}>
              <Link to={`/film/${m.id}`} className="pick-art"><Poster movie={m} wide showTitle={false} /></Link>
              <div className="pick-body">
                <div className="pick-meta">
                  <span className="match">{m.match}% match</span>
                  <span>{m.year}</span>
                  <Cert value={m.certification} />
                  <span>{fmtRuntime(m.runtime)}</span>
                </div>
                <h2 className="pick-title">{m.title}</h2>
                <ul className="pick-reasons">{m.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                <div className="pick-actions">
                  <button className="btn btn-play btn-sm" onClick={() => nav(`/watch/${m.id}`)}><Play /> {m.free ? 'Watch free' : 'Trailer'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => swap(m.id)}><X /> Not tonight</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="screen decide">
      <div className="decide-grid">
        <div className="decide-clock">
          <Leader left={left} />
          <p className="decide-kicker">Three picks in under a minute</p>
          <p className="decide-note">No endless scrolling. Answer what you can. When the clock runs out, Moviq picks for you.</p>
        </div>

        <form className="decide-form" onSubmit={(e) => { e.preventDefault(); decide(); }}>
          <fieldset>
            <legend>How long have you got?</legend>
            <div className="chip-row">{TIMES.map(([v, label]) => <Chip key={label} on={time === v} onClick={() => setTime(v)}>{label}</Chip>)}</div>
          </fieldset>
          <fieldset>
            <legend>What are you in the mood for? <span>Pick up to two</span></legend>
            <div className="chip-row">{MOODS.map((m) => <Chip key={m} mood on={moods.includes(m)} onClick={() => toggleMood(m)}>{m}</Chip>)}</div>
          </fieldset>
          <fieldset>
            <legend>Who’s watching?</legend>
            <div className="chip-row">{COMPANY.map(([v, label]) => <Chip key={v} on={company === v} onClick={() => setCompany(v)}>{label}</Chip>)}</div>
          </fieldset>
          <label className="decide-toggle">
            <input type="checkbox" checked={onlyAvailable} onChange={(e) => setOnlyAvailable(e.target.checked)} />
            <span>Only films I can stream right now <em>(free on Moviq + <Link to="/settings">your services</Link>)</em></span>
          </label>
          {error && <p className="error-note" role="alert">{error}</p>}
          <button className="btn btn-red decide-go" disabled={busy}>{busy ? 'Picking…' : error ? 'Try again' : 'Decide for me'}</button>
        </form>
      </div>
    </main>
  );
}
