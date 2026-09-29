import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Avatar from './Avatar.jsx';
import Poster from './Poster.jsx';
import { Stars } from './Stars.jsx';
import { Flag, HeartFill, Shield } from './Icons.jsx';

const SENTENCE = /[^.!?]+(?:[.!?]+|$)/g;

/** Splits review text into sentences, marking the ones the Spoiler Shield blurred. */
function sentences(body, spans) {
  const out = [];
  const push = (from, to, spoiler) => {
    if (to > from) out.push({ text: body.slice(from, to), spoiler });
  };
  const plain = (from, to) => {           // sentences between spoiler spans, keeping every character
    let at = from;
    for (const m of body.slice(from, to).matchAll(SENTENCE)) {
      push(at, from + m.index, null);
      push(from + m.index, from + m.index + m[0].length, null);
      at = from + m.index + m[0].length;
    }
    push(at, to, null);
  };
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    plain(at, s.start);
    push(s.start, s.end, s);
    at = s.end;
  }
  plain(at, body.length);
  return out;
}

/** After revealing a blurred sentence, readers say whether it really was a spoiler: live training data. */
function Feedback({ review, sentence, onLabel }) {
  const given = review.spoiler.my_labels?.[sentence];
  if (given !== undefined) {
    return <span className="label-thanks">{given ? 'You marked this a spoiler.' : 'You marked this not a spoiler.'} Thanks, the Spoiler Shield learns from this.</span>;
  }
  return (
    <span className="label-ask">
      Was this a spoiler?
      <button type="button" onClick={() => onLabel(sentence, 1)}>Yes</button>
      <button type="button" onClick={() => onLabel(sentence, 0)}>No</button>
    </span>
  );
}

function SpoilerText({ seg, review, canLabel, onLabel }) {
  const [open, setOpen] = useState(false);
  const human = seg.spoiler.human;
  if (open) {
    return (
      <>
        <mark className="spoiler-open">{seg.text}</mark>
        {canLabel && <Feedback review={review} sentence={seg.text.trim()} onLabel={onLabel} />}
      </>
    );
  }
  return (
    <button type="button" className="spoiler-blur" onClick={() => setOpen(true)} aria-label="Hidden spoiler. Select to reveal.">
      <span className="spoiler-text" aria-hidden="true">{seg.text}</span>
      <span className="spoiler-chip">
        <Shield width={12} height={12} /> {human ? 'Flagged by readers' : `Spoiler · ${Math.round(seg.spoiler.score * 100)}%`}
      </span>
    </button>
  );
}

export function ReviewBody({ review, flagging = false, onFlag, canLabel = false, onLabel }) {
  const [reveal, setReveal] = useState(false);
  const { spoiler, body } = review;
  if (spoiler.hidden && !reveal) {
    return (
      <div className="review-hidden">
        <p>
          {spoiler.author_tagged ? 'The author says this review contains spoilers.' : `${spoiler.community_reports} members flagged spoilers in this review.`}
        </p>
        <button className="link-btn" onClick={() => setReveal(true)}>Show the review anyway</button>
      </div>
    );
  }
  const segs = reveal ? [{ text: body, spoiler: null }] : sentences(body, spoiler.sentences || []);
  return (
    <div className={`review-body ${flagging ? 'flagging' : ''}`}>
      {segs.map((s, i) => {
        if (s.spoiler) return <SpoilerText key={i} seg={s} review={review} canLabel={canLabel} onLabel={onLabel} />;
        if (flagging && s.text.trim()) {
          return <button key={i} type="button" className="flag-sentence" onClick={() => onFlag(s.text.trim())}>{s.text}</button>;
        }
        return <span key={i}>{s.text}</span>;
      })}
    </div>
  );
}

export default function ReviewCard({ review: initial, showFilm = false }) {
  const { user } = useAuth();
  const [review, setReview] = useState(initial);
  const [likes, setLikes] = useState(initial.likes);
  const [liked, setLiked] = useState(initial.liked_by_me);
  const [reported, setReported] = useState(initial.reported_by_me);
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState('');
  const mine = user && review.author.id === user.id;
  const blurred = review.spoiler.sentences?.length > 0 && !review.spoiler.hidden;

  const like = async () => {
    const r = await api.post(`/reviews/${review.id}/like`);
    setLiked(r.liked);
    setLikes(r.likes);
  };
  const label = async (sentence, value, source = 'reader') => {
    const r = await api.post(`/reviews/${review.id}/spoiler-label`, { sentence, label: value, source });
    setReview(r.review);
  };
  const flagSentence = async (sentence) => {
    await label(sentence, 1, 'flag');
    setFlagging(false);
    setNote('Thanks. That sentence is now blurred for other readers, and the Spoiler Shield will learn from it.');
  };
  const reportWhole = async () => {
    setReported((await api.post(`/reviews/${review.id}/report-spoiler`)).reported);
    setFlagging(false);
  };

  return (
    <article className={`review ${showFilm ? 'with-film' : ''}`}>
      {showFilm && (
        <Link to={`/film/${review.movie.id}`} className="review-film"><Poster movie={review.movie} showTitle={false} /></Link>
      )}
      <div className="review-main">
        {showFilm && (
          <h3 className="review-film-title"><Link to={`/film/${review.movie.id}`}>{review.movie.title}</Link> <span>{review.movie.year}</span></h3>
        )}
        <header className="review-head">
          <Link to={`/u/${review.author.username}`} className="review-author">
            <Avatar user={review.author} size={24} />
            <span>Review by <strong>{review.author.display_name}</strong></span>
          </Link>
          <Stars value={review.rating} />
          {review.liked && <HeartFill width={14} className="heart" aria-label="Liked the film" />}
          {blurred && <span className="shield-tag" title="The Spoiler Shield blurred part of this review"><Shield width={13} /> Shielded</span>}
        </header>
        {flagging && (
          <p className="flag-help">
            Select the sentence that gives the plot away. <button className="link-btn" onClick={reportWhole}>The whole review is a spoiler</button>
            {' · '}<button className="link-btn" onClick={() => setFlagging(false)}>Cancel</button>
          </p>
        )}
        <ReviewBody review={review} flagging={flagging} onFlag={flagSentence} canLabel={!!user && !mine} onLabel={label} />
        {note && <p className="label-thanks" role="status">{note}</p>}
        <footer className="review-foot">
          <button className={`like-btn ${liked ? 'on' : ''}`} onClick={like} aria-pressed={liked}>
            <HeartFill width={14} /> {liked ? 'Liked' : 'Like review'} {likes > 0 && <span>{likes}</span>}
          </button>
          {review.source_url && (
            <a className="source-link" href={review.source_url} target="_blank" rel="noreferrer">
              {review.source_url.includes('themoviedb.org') ? 'Originally on TMDB' : 'Original review'} ↗
            </a>
          )}
          {!mine && (
            <button className={`flag-btn ${reported || flagging ? 'on' : ''}`} onClick={() => (reported ? reportWhole() : setFlagging(!flagging))} aria-pressed={flagging}>
              <Flag width={13} /> {reported ? 'Reported as a spoiler review' : 'Flag a spoiler'}
            </button>
          )}
        </footer>
      </div>
    </article>
  );
}
