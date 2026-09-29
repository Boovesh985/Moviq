import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Poster from './Poster.jsx';
import { StarInput } from './Stars.jsx';
import { HeartFill, Shield, X } from './Icons.jsx';

// Local calendar date (toISOString alone would give the UTC date)
const today = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

/** Letterboxd-style "I watched…" dialog with a live Spoiler Shield check. */
export default function ReviewComposer({ movie, existing, onClose, onSaved }) {
  const [rating, setRating] = useState(existing?.rating ?? null);
  const [liked, setLiked] = useState(existing?.liked ?? false);
  const [body, setBody] = useState(existing?.body ?? '');
  const [watchedOn, setWatchedOn] = useState(existing?.watched_on?.slice(0, 10) ?? today());
  const [rewatch, setRewatch] = useState(existing?.rewatch ?? false);
  const [tagged, setTagged] = useState(existing?.author_spoiler ?? false);
  const [check, setCheck] = useState(null);
  const [notSpoilers, setNotSpoilers] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Debounced spoiler analysis while typing
  useEffect(() => {
    if (body.trim().length < 12) return setCheck(null);
    const t = setTimeout(() => api.post('/reviews/spoiler-check', { text: body }).then(setCheck).catch(() => {}), 450);
    return () => clearTimeout(t);
  }, [body]);

  const flagged = check?.sentences?.filter((s) => s.spoiler) ?? [];
  const sentence = (s) => body.slice(s.start, s.end).trim();
  const blurredCount = flagged.filter((s) => !notSpoilers.has(sentence(s))).length;
  const toggleNotSpoiler = (text) => setNotSpoilers((cur) => {
    const next = new Set(cur);
    next.has(text) ? next.delete(text) : next.add(text);
    return next;
  });
  const tone = check?.sentiment == null ? null : check.sentiment >= 0.65 ? 'positive' : check.sentiment <= 0.35 ? 'negative' : 'mixed';

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { review } = await api.post('/reviews', {
        movie_id: movie.id, rating, liked, body, watched_on: watchedOn, rewatch, author_spoiler: tagged,
        not_spoilers: flagged.map(sentence).filter((t) => notSpoilers.has(t)),
      });
      onSaved?.(review);
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialog} className="composer" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <form onSubmit={save} className="composer-inner">
        <button type="button" className="composer-close" onClick={onClose} aria-label="Close"><X width={20} /></button>
        <div className="composer-poster"><Poster movie={movie} /></div>
        <div className="composer-form">
          <p className="composer-kicker">I watched…</p>
          <h2 className="composer-title">{movie.title} <span>{movie.year}</span></h2>

          <div className="composer-line">
            <label className="check"><input type="checkbox" checked={!!watchedOn} onChange={(e) => setWatchedOn(e.target.checked ? today() : '')} /> Watched on</label>
            <input type="date" value={watchedOn} max={today()} onChange={(e) => setWatchedOn(e.target.value)} aria-label="Date watched" />
            <label className="check"><input type="checkbox" checked={rewatch} onChange={(e) => setRewatch(e.target.checked)} /> I’ve watched this before</label>
          </div>

          <label className="sr-only" htmlFor="review-body">Review</label>
          <textarea id="review-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a review…" rows={7} maxLength={5000} />

          <div className={`shield-live ${blurredCount ? 'warn' : check ? 'ok' : ''}`} aria-live="polite">
            <Shield width={16} />
            {!check && <span>Spoiler Shield checks your review as you write.</span>}
            {check && !flagged.length && <span>No spoilers detected. Readers will see your whole review.</span>}
            {flagged.length > 0 && (
              <span>
                {flagged.length === 1 ? 'One sentence looks' : `${flagged.length} sentences look`} like a spoiler. Readers will see {blurredCount === 1 ? 'it' : 'them'} blurred unless you say otherwise:
                {flagged.map((s) => {
                  const text = sentence(s);
                  const cleared = notSpoilers.has(text);
                  return (
                    <span key={s.start} className={`flagged-line ${cleared ? 'cleared' : ''}`}>
                      <q>{text}</q>
                      <button type="button" className="link-btn" onClick={() => toggleNotSpoiler(text)} aria-pressed={cleared}>
                        {cleared ? 'Blur it after all' : 'Not a spoiler'}
                      </button>
                    </span>
                  );
                })}
              </span>
            )}
          </div>
          {tone && <p className="tone-note">Reads as <strong className={`tone-${tone}`}>{tone}</strong> to Moviq’s sentiment model{rating ? '' : ', which helps your recommendations even without a star rating'}.</p>}
          <label className="check"><input type="checkbox" checked={tagged} onChange={(e) => setTagged(e.target.checked)} /> Contains spoilers (hide the whole review behind a warning)</label>

          <div className="composer-bottom">
            <div>
              <span className="composer-label">Rating</span>
              <StarInput value={rating} onChange={setRating} />
            </div>
            <div>
              <span className="composer-label">Like</span>
              <button type="button" className={`heart-toggle ${liked ? 'on' : ''}`} onClick={() => setLiked(!liked)} aria-pressed={liked} aria-label="Like this film">
                <HeartFill width={30} />
              </button>
            </div>
            <button className="btn btn-green" disabled={saving}>{saving ? 'Saving…' : existing ? 'Update' : 'Save'}</button>
          </div>
          {error && <p className="error-note">{error}</p>}
        </div>
      </form>
    </dialog>
  );
}
