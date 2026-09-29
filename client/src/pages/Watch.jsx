import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import Poster from '../components/Poster.jsx';
import ReviewComposer from '../components/ReviewComposer.jsx';
import { Back, Eye, Pencil } from '../components/Icons.jsx';

export default function Watch() {
  const { id } = useParams();
  const nav = useNavigate();
  const [film, setFilm] = useState(null);
  const [error, setError] = useState('');
  const [chrome, setChrome] = useState(true);
  const [finished, setFinished] = useState(false);
  const [composing, setComposing] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const video = useRef(null);
  const lastSent = useRef(0);
  const idle = useRef(null);

  useEffect(() => {
    api.get(`/movies/${id}/play`).then(setFilm).catch((e) => setError(e.message));
  }, [id]);

  // Netflix-style: controls chrome fades after a few idle seconds
  useEffect(() => {
    const wake = () => {
      setChrome(true);
      clearTimeout(idle.current);
      idle.current = setTimeout(() => setChrome(false), 3000);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', wake);
    return () => { window.removeEventListener('mousemove', wake); window.removeEventListener('keydown', wake); clearTimeout(idle.current); };
  }, []);

  // Last known position, kept outside the <video> so it can still be saved after the player unmounts.
  const position = useRef(null);

  const sendProgress = (force = false) => {
    const v = video.current;
    if (v?.duration) position.current = { position: v.currentTime, duration: v.duration };
    const p = position.current;
    if (!p) return;
    if (!force && Math.abs(p.position - lastSent.current) < 10) return;
    lastSent.current = p.position;
    api.post(`/watch/${id}/progress`, p).then((r) => {
      if (r.completed) setFinished(true);
    }).catch(() => {});
  };

  // Leaving the player (back button, another page) saves where you stopped.
  useEffect(() => () => {
    const p = position.current;
    if (p && p.position !== lastSent.current) {
      api.post(`/watch/${id}/progress`, p).catch(() => {});
    }
  }, [id]);

  const onLoaded = () => {
    const p = film?.progress;
    if (p && !p.completed && p.position_seconds > 30 && video.current) video.current.currentTime = p.position_seconds;
  };

  if (error) return <main className="player"><p className="empty">{error}</p><Link to="/" className="btn btn-line">Back to Moviq</Link></main>;
  if (!film) return <main className="player" />;

  const topBar = (
    <div className={`player-top ${chrome ? '' : 'hide'}`}>
      <button className="player-back" onClick={() => nav(-1)} aria-label="Back"><Back width={30} /></button>
      <span className="player-title">{film.title} <span>{film.year}</span></span>
    </div>
  );

  const afterPanel = (
    <div className="player-after">
      <p className="player-after-kicker">{finished ? 'You finished' : 'Watched it already?'}</p>
      <h2>{film.title}</h2>
      <p>Log it to your diary and tell people what you thought. Your rating also sharpens your recommendations.</p>
      <div className="player-after-actions">
        <button className="btn btn-green" onClick={() => setComposing(true)}><Pencil /> Rate & review</button>
        <Link className="btn btn-line" to={`/film/${film.id}`}>Film page</Link>
      </div>
    </div>
  );

  // Free film streaming in-app
  if (film.stream_url && !videoError) {
    return (
      <main className={`player ${chrome ? '' : 'idle'}`}>
        {topBar}
        <video
          ref={video}
          src={film.stream_url}
          controls
          autoPlay
          playsInline
          onLoadedMetadata={onLoaded}
          onTimeUpdate={() => sendProgress(false)}
          onPause={() => sendProgress(true)}
          onEnded={() => { sendProgress(true); setFinished(true); }}
          onError={() => setVideoError(true)}
        />
        {finished && <div className="player-overlay">{afterPanel}</div>}
        {composing && <ReviewComposer movie={film} existing={film.review} onClose={() => setComposing(false)} onSaved={() => nav(`/film/${film.id}`)} />}
      </main>
    );
  }

  // Trailer (from TMDB) for films Moviq can't stream
  if (film.trailer_key) {
    return (
      <main className="player">
        {topBar}
        <iframe
          className="player-frame"
          src={`https://www.youtube-nocookie.com/embed/${film.trailer_key}?autoplay=1&rel=0&modestbranding=1`}
          title={`${film.title} trailer`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
        <div className="trailer-bar">
          <span>Trailer. {film.providers?.length ? `Stream the full film on ${film.providers.join(', ')}.` : 'This film isn’t streaming on Moviq.'}</span>
          <button className="btn btn-sm btn-play" onClick={() => api.post(`/watch/${film.id}/watched`).then(() => setComposing(true))}><Eye /> I’ve watched it</button>
        </div>
        {composing && <ReviewComposer movie={film} existing={film.review} onClose={() => setComposing(false)} onSaved={() => nav(`/film/${film.id}`)} />}
      </main>
    );
  }

  // No stream, no trailer: where to watch + log it
  return (
    <main className="player unavailable">
      {topBar}
      <Poster movie={film} wide showTitle={false} className="player-bg" />
      <div className="player-overlay solid">
        <div className="player-after">
          <p className="player-after-kicker">{videoError ? 'The free stream didn’t load' : 'Not streaming on Moviq'}</p>
          <h2>{film.title}</h2>
          {film.providers?.length ? (
            <p>Watch it on <strong>{film.providers.join(', ')}</strong>, then come back to log it.</p>
          ) : (
            <p>{videoError ? 'The Internet Archive may be busy. Try again in a minute, or log it if you’ve seen it.' : 'Moviq only streams public-domain and open films. Add a TMDB key to show trailers and where this film is streaming.'}</p>
          )}
          <div className="player-after-actions">
            <button className="btn btn-green" onClick={() => setComposing(true)}><Pencil /> Log or review</button>
            <Link className="btn btn-line" to={`/film/${film.id}`}>Film page</Link>
          </div>
        </div>
      </div>
      {composing && <ReviewComposer movie={film} existing={film.review} onClose={() => setComposing(false)} onSaved={() => nav(`/film/${film.id}`)} />}
    </main>
  );
}
