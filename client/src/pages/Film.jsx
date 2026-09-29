import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtRuntime } from '../api.js';
import Poster from '../components/Poster.jsx';
import Avatar from '../components/Avatar.jsx';
import ReviewCard from '../components/ReviewCard.jsx';
import ReviewComposer from '../components/ReviewComposer.jsx';
import { StarInput, Stars } from '../components/Stars.jsx';
import { Clock, Eye, HeartFill, Pencil, Play, Shield } from '../components/Icons.jsx';

function Histogram({ stats }) {
  const buckets = Array.from({ length: 10 }, (_, i) => (i + 1) / 2);
  const counts = Object.fromEntries(stats.histogram.map((h) => [h.rating, h.n]));
  const max = Math.max(1, ...Object.values(counts));
  return (
    <section className="hist" aria-label="Ratings">
      <h3 className="j-label">Ratings <span>{stats.ratings} ratings · {stats.likes} likes</span></h3>
      <div className="hist-body">
        <span className="hist-star">★</span>
        <div className="hist-bars">
          {buckets.map((b) => (
            <span key={b} className="hist-bar" style={{ height: `${Math.max(3, ((counts[b] || 0) / max) * 100)}%` }} title={`${counts[b] || 0} × ${b}★`} />
          ))}
        </div>
        <span className="hist-star">★★★★★</span>
        <span className="hist-avg">{stats.avg ? Number(stats.avg).toFixed(1) : '–'}</span>
      </div>
    </section>
  );
}

/** "What people say": aspect-level sentiment from reviews, never quoting a blurred spoiler. */
function Insights({ insights }) {
  if (!insights?.aspects?.length) return null;
  return (
    <section className="insights" aria-label="What people say">
      <h3 className="j-label">What people say <span>{insights.reviews} {insights.reviews === 1 ? 'review' : 'reviews'} · {insights.positive_share}% positive</span></h3>
      <ul className="insight-list">
        {insights.aspects.slice(0, 6).map((a) => (
          <li key={a.aspect} className={`insight ${a.verdict}`}>
            <div className="insight-head">
              <span className="insight-name">{a.label}</span>
              <span className="insight-verdict">{a.verdict === 'loved' ? 'Loved' : a.verdict === 'disliked' ? 'Not a fan' : 'Mixed'}</span>
              <span className="insight-count">{a.mentions} {a.mentions === 1 ? 'mention' : 'mentions'}</span>
            </div>
            <span className="insight-bar"><span style={{ width: `${a.positive_share}%` }} /></span>
            {a.quote && <q className="insight-quote">{a.quote.text}</q>}
          </li>
        ))}
      </ul>
      <p className="insight-note">From Moviq’s sentiment model, which reads every review clause by clause and keeps learning from new ratings.</p>
    </section>
  );
}

export default function Film() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);
  const [tab, setTab] = useState('popular');

  const load = () => api.get(`/movies/${id}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { setData(null); load(); window.scrollTo(0, 0); }, [id]);

  if (error) return <main className="journal page-pad"><p className="empty">{error}</p></main>;
  if (!data) return <main className="journal"><div className="film-banner skeleton" /></main>;
  const { movie, stats, me, friends, reviews, similar, insights } = data;
  const mine = me?.review;

  const quickSave = async (patch) => {
    await api.post('/reviews', {
      movie_id: movie.id, rating: mine?.rating ?? null, liked: mine?.liked ?? false, body: mine?.body ?? '',
      watched_on: mine?.watched_on?.slice(0, 10), rewatch: mine?.rewatch ?? false, author_spoiler: mine?.author_spoiler ?? false, ...patch,
    });
    load();
  };
  const toggleList = async () => { await api.post(`/watch/list/${movie.id}`); load(); };
  const watched = !!mine || me?.progress?.completed;

  return (
    <main className="journal film">
      <div className="film-banner">
        <Poster movie={movie} wide showTitle={false} eager />
        <div className="film-banner-fade" />
      </div>

      <div className="film-grid">
        <aside className="film-poster">
          <Poster movie={movie} eager />
          <div className="film-counts">
            <span title="Watched by"><Eye width={14} /> {stats.watched}</span>
            <span title="Likes"><HeartFill width={14} /> {stats.likes}</span>
            <span title="Reviews"><Pencil width={14} /> {stats.reviews}</span>
          </div>
        </aside>

        <section className="film-main">
          <h1 className="film-title">{movie.title} <span className="film-year">{movie.year}</span></h1>
          <p className="film-by">Directed by <strong>{movie.director}</strong></p>
          {movie.tagline && <p className="film-tagline">{movie.tagline}</p>}
          <p className="film-synopsis">{movie.overview}</p>
          <dl className="film-facts">
            <div><dt>Runtime</dt><dd>{fmtRuntime(movie.runtime)}</dd></div>
            <div><dt>Rated</dt><dd>{movie.certification}</dd></div>
            <div><dt>Genres</dt><dd>{movie.genres.map((g) => <Link key={g} to={`/films?genre=${encodeURIComponent(g)}`} className="tag">{g}</Link>)}</dd></div>
            <div><dt>Mood</dt><dd>{movie.moods.map((m) => <span key={m} className="tag mood">{m}</span>)}</dd></div>
            {movie.cast_names.length > 0 && <div><dt>Cast</dt><dd>{movie.cast_names.map((c) => <Link key={c} to={`/search?q=${encodeURIComponent(c)}`} className="tag">{c}</Link>)}</dd></div>}
          </dl>

          {friends.length > 0 && (
            <section className="friends-rated">
              <h3 className="j-label">Activity from people you follow</h3>
              <div className="friend-row">
                {friends.map((f) => (
                  <Link key={f.username} to={`/u/${f.username}`} className="friend" title={f.display_name}>
                    <Avatar user={f} size={40} />
                    <Stars value={f.rating} />
                    {f.liked && <HeartFill width={11} className="heart" />}
                  </Link>
                ))}
              </div>
            </section>
          )}

          <Insights insights={insights} />

          <section className="film-reviews">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'popular'} className={tab === 'popular' ? 'on' : ''} onClick={() => setTab('popular')}>Popular reviews</button>
              <button role="tab" aria-selected={tab === 'recent'} className={tab === 'recent' ? 'on' : ''} onClick={() => setTab('recent')}>Recent reviews</button>
              <span className="tabs-note"><Shield width={14} /> Spoiler Shield on</span>
            </div>
            {reviews[tab].length === 0 && <p className="empty">No reviews yet. Watched it? Be the first to write one.</p>}
            {reviews[tab].map((r) => <ReviewCard key={r.id} review={r} />)}
          </section>
        </section>

        <aside className="film-side">
          <div className="side-panel">
            <button className="btn btn-red side-play" onClick={() => nav(`/watch/${movie.id}`)}>
              <Play /> {movie.free ? (me?.progress && !me.progress.completed && me.progress.position_seconds > 30 ? 'Resume' : 'Watch now, free') : movie.trailer_key ? 'Play trailer' : 'Where to watch'}
            </button>
            {movie.match != null && <p className="side-match"><span className="match">{movie.match}% match</span> for you</p>}
            <div className="side-actions">
              <button className={watched ? 'on watch' : ''} onClick={() => api.post(`/watch/${movie.id}/watched`).then(load)} aria-pressed={watched}>
                <Eye width={28} /><span>{watched ? 'Watched' : 'Watch'}</span>
              </button>
              <button className={mine?.liked ? 'on like' : ''} onClick={() => quickSave({ liked: !mine?.liked })} aria-pressed={!!mine?.liked}>
                <HeartFill width={28} /><span>{mine?.liked ? 'Liked' : 'Like'}</span>
              </button>
              <button className={me?.onWatchlist ? 'on list' : ''} onClick={toggleList} aria-pressed={!!me?.onWatchlist}>
                <Clock width={28} /><span>Watchlist</span>
              </button>
            </div>
            <div className="side-rate">
              <span>{mine?.rating ? 'Rated' : 'Rate'}</span>
              <StarInput value={mine?.rating ?? null} onChange={(v) => quickSave({ rating: v })} size={30} />
            </div>
            <button className="side-link" onClick={() => setComposing(true)}>{mine?.body ? 'Edit your review…' : 'Review or log…'}</button>
            <div className="side-where">
              <h4>Where to watch</h4>
              {movie.free && <p><span className="free-dot" /> Free on Moviq</p>}
              {movie.providers.map((p) => <p key={p}>{p}</p>)}
              {!movie.free && movie.providers.length === 0 && <p className="muted">No streaming data yet. Add a TMDB key to see services in your region.</p>}
            </div>
          </div>
          <Histogram stats={stats} />
        </aside>
      </div>

      {similar.length > 0 && (
        <section className="film-similar">
          <h3 className="j-label">More like this</h3>
          <div className="poster-grid">
            {similar.map((m) => (
              <Link key={m.id} to={`/film/${m.id}`} className="poster-link" title={m.title}>
                <Poster movie={m} />
                {m.match != null && <span className="poster-match">{m.match}%</span>}
              </Link>
            ))}
          </div>
        </section>
      )}

      {composing && <ReviewComposer movie={movie} existing={mine} onClose={() => setComposing(false)} onSaved={load} />}
    </main>
  );
}
