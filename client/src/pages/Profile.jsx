import { useEffect, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { api } from '../api.js';
import Avatar from '../components/Avatar.jsx';
import Poster from '../components/Poster.jsx';
import ReviewCard from '../components/ReviewCard.jsx';
import { Stars } from '../components/Stars.jsx';
import { HeartFill } from '../components/Icons.jsx';
import { PosterStrip } from './Journal.jsx';

function TasteDNA({ taste }) {
  if (!taste || taste.genres.length < 2) return <p className="muted">Rate a few more films to see your taste profile.</p>;
  const rows = taste.genres.slice(0, 8);
  const max = Math.max(...rows.map((g) => Math.abs(g.score)), 0.01);
  return (
    <div>
      {rows.map((g) => (
        <div key={g.name} className="dna-bar" title={`${g.count} rated`}>
          <span>{g.name}</span>
          <span className="track"><span className={`fill ${g.score < 0 ? 'neg' : ''}`} style={{ width: `${(Math.abs(g.score) / max) * 100}%` }} /></span>
          <span>{g.score > 0 ? '+' : ''}{g.score.toFixed(1)}</span>
        </div>
      ))}
      <p className="dna-note">How much higher (or lower) than your own average you rate each genre. This is what powers your recommendations.</p>
    </div>
  );
}

function Diary({ username }) {
  const [items, setItems] = useState(null);
  useEffect(() => { api.get(`/users/${username}/diary`).then((d) => setItems(d.items)); }, [username]);
  if (!items) return null;
  if (!items.length) return <p className="empty">No films logged yet.</p>;
  let lastMonth = '';
  return (
    <table className="diary">
      <thead><tr><th>Month</th><th>Day</th><th>Film</th><th>Rating</th><th>Like</th></tr></thead>
      <tbody>
        {items.map((e) => {
          const [y, mo, day] = e.watched_on.split('-').map(Number);
          const d = new Date(y, mo - 1, day);
          const month = d.toLocaleString('en', { month: 'short', year: 'numeric' });
          const show = month !== lastMonth;
          lastMonth = month;
          return (
            <tr key={e.review_id}>
              <td className="month">{show ? month : ''}</td>
              <td className="day">{d.getDate()}</td>
              <td><Link to={`/film/${e.id}`} className="d-film"><Poster movie={e} showTitle={false} />{e.title} <span>{e.year}</span></Link></td>
              <td><Stars value={e.rating} /></td>
              <td>{e.liked && <HeartFill width={14} className="heart" />}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Tab({ username, tab }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    setData(null);
    if (tab === 'films' || tab === 'watchlist') api.get(`/users/${username}/${tab}`).then((d) => setData(d.items));
    if (tab === 'reviews') api.get(`/users/${username}/reviews`).then((d) => setData(d.reviews));
  }, [username, tab]);
  if (tab === 'diary') return <Diary username={username} />;
  if (!data) return null;
  if (!data.length) return <p className="empty">{tab === 'watchlist' ? 'Nothing on the watchlist yet.' : 'Nothing here yet.'}</p>;
  if (tab === 'reviews') return data.map((r) => <ReviewCard key={r.id} review={r} showFilm />);
  return <PosterStrip items={data} caption={tab === 'films' ? (m) => <><Stars value={m.my_rating} />{m.my_liked && <HeartFill width={11} className="heart" />}</> : null} />;
}

export default function Profile() {
  const { username, tab } = useParams();
  const [p, setP] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setP(null);
    setError('');
    api.get(`/users/${username}`).then((d) => live && setP(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [username]);

  if (error) return <main className="journal page-pad"><p className="empty">{error}</p></main>;
  if (!p) return <main className="journal" />;
  const follow = async () => {
    try {
      const { following } = await api.post(`/users/${username}/follow`);
      setP((cur) => ({ ...cur, isFollowing: following, stats: { ...cur.stats, followers: cur.stats.followers + (following ? 1 : -1) } }));
    } catch (e) { setError(e.message); }
  };
  const s = p.stats;

  return (
    <main className="journal page-pad">
      <header className="profile-head">
        <Avatar user={p.user} size={84} />
        <div>
          <h1>{p.user.display_name}
            {!p.isMe && <button className={`btn btn-sm follow-btn ${p.isFollowing ? 'btn-line' : 'btn-green'}`} onClick={follow}>{p.isFollowing ? 'Following' : 'Follow'}</button>}
            {p.isMe && <Link to="/settings" className="btn btn-sm btn-line follow-btn">Edit profile</Link>}
          </h1>
          <p>@{p.user.username}{p.user.bio ? ` · ${p.user.bio}` : ''}</p>
        </div>
        <div className="profile-stats">
          <div><strong>{s.films}</strong><span>Films</span></div>
          <div><strong>{s.this_year}</strong><span>This year</span></div>
          <div><strong>{s.reviews}</strong><span>Reviews</span></div>
          <div><strong>{s.following}</strong><span>Following</span></div>
          <div><strong>{s.followers}</strong><span>Followers</span></div>
        </div>
      </header>

      <nav className="tabs">
        <NavLink to={`/u/${username}`} end>Profile</NavLink>
        <NavLink to={`/u/${username}/films`}>Films</NavLink>
        <NavLink to={`/u/${username}/diary`}>Diary</NavLink>
        <NavLink to={`/u/${username}/reviews`}>Reviews</NavLink>
        <NavLink to={`/u/${username}/watchlist`}>Watchlist</NavLink>
      </nav>

      {tab ? (
        <div style={{ marginTop: 24 }}><Tab username={username} tab={tab} /></div>
      ) : (
        <div className="profile-cols">
          <div>
            <section className="j-section">
              <h2 className="j-label">Favourite films</h2>
              {p.favorites.length ? (
                <div className="favs">{p.favorites.map((m) => <Link key={m.id} to={`/film/${m.id}`} className="poster-link"><Poster movie={m} /></Link>)}</div>
              ) : <p className="muted">{p.isMe ? <>Pick your four favourites in <Link to="/settings">settings</Link>.</> : 'No favourites picked yet.'}</p>}
            </section>
            <section className="j-section">
              <h2 className="j-label">Recent activity <Link to={`/u/${username}/diary`}>All</Link></h2>
              {p.recent.length ? <PosterStrip items={p.recent} caption={(m) => <><Stars value={m.my_rating} />{m.my_liked && <HeartFill width={11} className="heart" />}</>} /> : <p className="muted">Nothing logged yet.</p>}
            </section>
            <section className="j-section">
              <h2 className="j-label">Recent reviews <Link to={`/u/${username}/reviews`}>All</Link></h2>
              {p.reviews.length ? p.reviews.map((r) => <ReviewCard key={r.id} review={r} showFilm />) : <p className="muted">No reviews yet.</p>}
            </section>
          </div>
          <aside>
            <section className="j-section">
              <h2 className="j-label">Taste DNA</h2>
              <TasteDNA taste={p.taste} />
            </section>
            <section className="j-section">
              <h2 className="j-label">Ratings <span>avg {s.avg_rating ?? '–'}</span></h2>
              <div className="hist-body">
                <span className="hist-star">★</span>
                <div className="hist-bars">
                  {Array.from({ length: 10 }, (_, i) => (i + 1) / 2).map((b) => {
                    const n = p.histogram.find((h) => h.rating === b)?.n || 0;
                    const max = Math.max(1, ...p.histogram.map((h) => h.n));
                    return <span key={b} className="hist-bar" style={{ height: `${Math.max(3, (n / max) * 100)}%` }} title={`${n} × ${b}★`} />;
                  })}
                </div>
                <span className="hist-star">★★★★★</span>
              </div>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
