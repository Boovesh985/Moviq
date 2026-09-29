import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtRuntime } from '../api.js';
import { useAuth } from '../auth.jsx';
import Avatar from '../components/Avatar.jsx';
import Poster from '../components/Poster.jsx';
import { Cert } from '../components/MovieCard.jsx';
import { HeartFill, Play, Plus, Users, X, Check } from '../components/Icons.jsx';

const MOODS = ['feel-good', 'funny', 'thrilling', 'mind-bending', 'romantic', 'scary', 'epic', 'cozy'];

function Landing() {
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const create = async () => nav(`/group/${(await api.post('/rooms')).code}`);
  const join = async (e) => {
    e.preventDefault();
    try {
      nav(`/group/${(await api.post('/rooms/join', { code: code.trim().toUpperCase() })).code}`);
    } catch (err) { setError(err.message); }
  };
  return (
    <div className="party-landing">
      <Users className="party-icon" />
      <h1 className="decide-h1">Pick a film together</h1>
      <p className="decide-sub">Everyone swipes through a shortlist built from the whole group’s taste. Moviq shows the films you all said yes to.</p>
      <div className="party-options">
        <button className="btn btn-red" onClick={create}><Plus /> Start a room</button>
        <form onSubmit={join} className="party-join">
          <label className="sr-only" htmlFor="code">Room code</label>
          <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Room code" maxLength={5} autoComplete="off" />
          <button className="btn btn-ghost" disabled={code.trim().length < 5}>Join</button>
        </form>
      </div>
      {error && <p className="error-note" role="alert">{error}</p>}
    </div>
  );
}

function MemberList({ members, total }) {
  return (
    <ul className="party-members">
      {members.map((m) => (
        <li key={m.id}>
          <Avatar user={m} size={36} />
          <span>{m.display_name}{m.is_demo && <em> demo</em>}</span>
          {total ? <span className="party-progress">{m.finished ? <Check width={16} /> : `${m.votes}/${total}`}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Lobby({ room, reload }) {
  const [time, setTime] = useState(null);
  const [moods, setMoods] = useState([]);
  const [family, setFamily] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/group/${room.code}`;

  const start = async () => {
    setBusy(true);
    try { await api.post(`/rooms/${room.code}/start`, { max_runtime: time, moods, family }); reload(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  const addDemo = async () => { try { await api.post(`/rooms/${room.code}/demo-member`); reload(); } catch (e) { setError(e.message); } };

  return (
    <div className="party-lobby">
      <div className="ticket">
        <span className="ticket-label">Room code</span>
        <span className="ticket-code">{room.code}</span>
        <button className="link-btn" onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); }}>{copied ? 'Invite link copied' : 'Copy invite link'}</button>
      </div>
      <div className="party-lobby-main">
        <h2 className="party-h2">In the room ({room.members.length})</h2>
        <MemberList members={room.members} />
        {room.isHost ? (
          <>
            <button className="btn btn-line btn-sm" onClick={addDemo}><Plus /> Add a demo member</button>
            <p className="party-hint">Demo members are sample Moviq users who vote from their own ratings, so you can try group mode alone.</p>
            <h2 className="party-h2">Tonight’s limits</h2>
            <div className="chip-row">
              {[[null, 'Any length'], [120, 'Under 2h'], [150, 'Under 2½h']].map(([v, l]) => (
                <button key={l} className={`dchip ${time === v ? 'on' : ''}`} onClick={() => setTime(v)} aria-pressed={time === v}>{l}</button>
              ))}
              <button className={`dchip ${family ? 'on' : ''}`} onClick={() => setFamily(!family)} aria-pressed={family}>Kid-safe</button>
            </div>
            <div className="chip-row" style={{ marginTop: 8 }}>
              {MOODS.map((m) => (
                <button key={m} className={`dchip mood ${moods.includes(m) ? 'on' : ''}`} aria-pressed={moods.includes(m)}
                  onClick={() => setMoods((c) => (c.includes(m) ? c.filter((x) => x !== m) : [...c.slice(-1), m]))}>{m}</button>
              ))}
            </div>
            {error && <p className="error-note">{error}</p>}
            <button className="btn btn-red party-start" disabled={busy} onClick={start}>{busy ? 'Building the shortlist…' : `Start voting with ${room.members.length} ${room.members.length === 1 ? 'person' : 'people'}`}</button>
          </>
        ) : (
          <p className="party-hint">Waiting for the host to start voting…</p>
        )}
      </div>
    </div>
  );
}

function Voting({ room, reload }) {
  const pending = room.candidates.filter((c) => room.myVotes[c.id] === undefined);
  const current = pending[0];
  const done = room.candidates.length - pending.length;

  const vote = useCallback(async (v) => {
    if (!current) return;
    await api.post(`/rooms/${room.code}/vote`, { movie_id: current.id, vote: v });
    reload();
  }, [current, room.code, reload]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') vote(-1);
      if (e.key === 'ArrowRight') vote(1);
      if (e.key === 'ArrowUp') vote(2);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vote]);

  if (!current) {
    return (
      <div className="party-wait">
        <h2 className="decide-h1">You’re done voting</h2>
        <p className="decide-sub">Waiting for everyone else to finish.</p>
        <MemberList members={room.members} total={room.candidates.length} />
      </div>
    );
  }

  const byId = Object.fromEntries(room.members.map((m) => [String(m.id), m]));
  return (
    <div className="swipe">
      <p className="swipe-count">{done + 1} of {room.candidates.length}</p>
      <article className="swipe-card" key={current.id}>
        <Poster movie={current} wide showTitle={false} />
        <div className="swipe-body">
          <div className="pick-meta"><span>{current.year}</span><Cert value={current.certification} /><span>{fmtRuntime(current.runtime)}</span><span className="swipe-genres">{current.genres.join(' · ')}</span></div>
          <h2 className="pick-title">{current.title}</h2>
          <p className="swipe-overview">{current.overview}</p>
          <div className="swipe-matches" aria-label="Predicted match for each member">
            {Object.entries(current.members).map(([uid, pct]) => byId[uid] && (
              <span key={uid} className="swipe-match" title={byId[uid].display_name}>
                <Avatar user={byId[uid]} size={22} /> {pct}%
              </span>
            ))}
          </div>
        </div>
      </article>
      <div className="swipe-actions">
        <button className="swipe-btn nope" onClick={() => vote(-1)} aria-label="Nope (left arrow)"><X /></button>
        <button className="swipe-btn love" onClick={() => vote(2)} aria-label="Love it (up arrow)"><HeartFill /></button>
        <button className="swipe-btn yes" onClick={() => vote(1)} aria-label="I’d watch it (right arrow)"><Check /></button>
      </div>
      <p className="swipe-keys">← nope · ↑ love · → yes</p>
    </div>
  );
}

function Results({ room }) {
  const nav = useNavigate();
  const byId = Object.fromEntries(room.candidates.map((c) => [c.id, c]));
  const people = Object.fromEntries(room.members.map((m) => [m.id, m]));
  const [top, ...rest] = room.results;
  const winner = byId[top.movie_id];
  return (
    <div className="results">
      <div className="winner">
        <Poster movie={winner} wide showTitle={false} />
        <div className="winner-copy">
          <p className="decide-kicker">{top.everyone ? 'It’s a match. Everyone said yes.' : 'Closest thing to a match'}</p>
          <h1 className="hero-title">{winner.title}</h1>
          <p className="decide-sub">{top.love} love · {top.yes} yes · {top.nope} nope</p>
          <div className="hero-actions">
            <button className="btn btn-play" onClick={() => nav(`/watch/${winner.id}`)}><Play /> {winner.free ? 'Watch free now' : 'Trailer'}</button>
            <Link className="btn btn-ghost" to={`/film/${winner.id}`}>Film page</Link>
          </div>
        </div>
      </div>
      <h2 className="party-h2">The rest of the shortlist</h2>
      <ol className="result-list">
        {rest.map((r) => {
          const m = byId[r.movie_id];
          return (
            <li key={r.movie_id}>
              <Link to={`/film/${m.id}`} className="result-art"><Poster movie={m} showTitle={false} /></Link>
              <div>
                <strong>{m.title}</strong> <span className="muted-s">{m.year}</span>
                {r.everyone && <span className="all-yes">Everyone’s in</span>}
                <div className="result-voters">
                  {r.voters.map((v) => people[v.user_id] && (
                    <span key={v.user_id} className={`voter v${v.vote}`} title={`${people[v.user_id].display_name}: ${v.vote === 2 ? 'love' : v.vote === 1 ? 'yes' : 'nope'}`}>
                      <Avatar user={people[v.user_id]} size={22} />
                    </span>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default function Party() {
  const { code } = useParams();
  const { user } = useAuth();
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');

  const reload = useCallback(() => {
    if (!code) return;
    api.get(`/rooms/${code}`).then(setRoom).catch(async (e) => {
      if (e.status === 403) { // opened an invite link: join, then load
        await api.post('/rooms/join', { code }).then(() => api.get(`/rooms/${code}`).then(setRoom)).catch((j) => setError(j.message));
      } else setError(e.message);
    });
  }, [code]);

  useEffect(() => {
    setRoom(null);
    reload();
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <main className="screen party">
      {!code && <Landing />}
      {code && error && <div className="party-landing"><p className="error-note">{error}</p><Link className="btn btn-ghost" to="/group">Back</Link></div>}
      {code && room && room.status === 'lobby' && <Lobby room={room} reload={reload} />}
      {code && room && room.status === 'voting' && <Voting room={room} reload={reload} me={user} />}
      {code && room && room.status === 'done' && <Results room={room} />}
    </main>
  );
}
