import { Link, useNavigate } from 'react-router-dom';
import Poster from './Poster.jsx';
import { Play, Plus, Check, Info } from './Icons.jsx';
import { fmtRuntime } from '../api.js';

export function MatchBadge({ match }) {
  if (match == null) return null;
  return <span className="match">{match}% match</span>;
}

export function Cert({ value }) {
  return value && value !== 'NR' ? <span className="cert">{value}</span> : null;
}

/** Netflix-style landscape card with a hover panel. */
export function MovieCard({ movie, onToggleList, onList, progress }) {
  const nav = useNavigate();
  return (
    <article className="card">
      <Link to={`/film/${movie.id}`} className="card-art" aria-label={movie.title}>
        <Poster movie={movie} wide />
        {movie.free && <span className="free-tag">Free</span>}
        {progress != null && <span className="progress"><span style={{ width: `${Math.min(100, progress * 100)}%` }} /></span>}
      </Link>
      <div className="card-panel">
        <div className="card-actions">
          <button className="icon-btn on" onClick={() => nav(`/watch/${movie.id}`)} aria-label={movie.free ? `Play ${movie.title}` : `Watch trailer for ${movie.title}`}><Play /></button>
          {onToggleList && (
            <button className={`icon-btn ${onList ? 'on' : ''}`} onClick={() => onToggleList(movie.id)} aria-label={onList ? 'Remove from My List' : 'Add to My List'}>
              {onList ? <Check /> : <Plus />}
            </button>
          )}
          <Link className="icon-btn push" to={`/film/${movie.id}`} aria-label="Film details"><Info /></Link>
        </div>
        <div className="card-meta">
          <MatchBadge match={movie.match} />
          <Cert value={movie.certification} />
          <span>{fmtRuntime(movie.runtime)}</span>
        </div>
        <div className="card-genres">{(movie.moods?.length ? movie.moods : movie.genres).slice(0, 3).join(' · ')}</div>
        {movie.reason && <div className="card-reason">{movie.reason}</div>}
      </div>
    </article>
  );
}

/** Top 10 card: big outlined rank number beside a poster. */
export function TopTenCard({ movie, rank }) {
  return (
    <Link to={`/film/${movie.id}`} className="top10" aria-label={`Number ${rank}: ${movie.title}`}>
      <span className="top10-rank" aria-hidden="true">{rank}</span>
      <Poster movie={movie} className="top10-poster" />
    </Link>
  );
}
