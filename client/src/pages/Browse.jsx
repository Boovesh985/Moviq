import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtRuntime } from '../api.js';
import Poster from '../components/Poster.jsx';
import Row from '../components/Row.jsx';
import { Cert, MatchBadge } from '../components/MovieCard.jsx';
import { Clock, Info, Play, Users } from '../components/Icons.jsx';

export default function Browse() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [watchlist, setWatchlist] = useState(new Set());
  const nav = useNavigate();

  useEffect(() => {
    api.get('/movies/home').then((d) => {
      setData(d);
      setWatchlist(new Set(d.rows.find((r) => r.id === 'list')?.items.map((m) => m.id) ?? []));
    }).catch((e) => setError(e.message));
  }, []);

  const toggleList = async (id) => {
    const { onWatchlist } = await api.post(`/watch/list/${id}`);
    setWatchlist((s) => {
      const n = new Set(s);
      onWatchlist ? n.add(id) : n.delete(id);
      return n;
    });
  };

  if (error) return <main className="screen"><p className="empty" style={{ paddingTop: 120 }}>{error}</p></main>;
  if (!data) return <main className="screen"><div className="hero skeleton" /></main>;
  const hero = data.hero;

  return (
    <main className="screen">
      {hero && (
        <section className="hero">
          <Poster movie={hero} wide showTitle={false} className="hero-art" eager />
          <div className="hero-shade" />
          <div className="hero-copy">
            {data.heroReason && <p className="hero-kicker">{data.heroReason}</p>}
            <h1 className="hero-title">{hero.title}</h1>
            <div className="hero-meta">
              <MatchBadge match={hero.match} />
              <span>{hero.year}</span>
              <Cert value={hero.certification} />
              <span>{fmtRuntime(hero.runtime)}</span>
              {hero.free && <span className="free-tag inline">Free on Moviq</span>}
            </div>
            <p className="hero-overview">{hero.overview}</p>
            <div className="hero-actions">
              <button className="btn btn-play" onClick={() => nav(`/watch/${hero.id}`)}><Play /> {hero.free ? 'Play' : 'Trailer'}</button>
              <Link className="btn btn-ghost" to={`/film/${hero.id}`}><Info /> More info</Link>
            </div>
          </div>
        </section>
      )}

      <div className="rows">
        <div className="shortcuts">
          <Link to="/decide" className="shortcut">
            <Clock /><span><strong>Can’t choose?</strong> Get three picks in 60 seconds</span>
          </Link>
          <Link to="/group" className="shortcut">
            <Users /><span><strong>Watching together?</strong> Swipe as a group and find the film everyone wants</span>
          </Link>
        </div>
        {data.rows.map((row) => <Row key={row.id} row={row} watchlist={watchlist} onToggleList={toggleList} />)}
      </div>
      <footer className="site-foot">
        Moviq. Free films stream from the Internet Archive’s public-domain collection.
      </footer>
    </main>
  );
}
