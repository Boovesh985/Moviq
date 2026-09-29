import { useRef } from 'react';
import { Chevron } from './Icons.jsx';
import { MovieCard, TopTenCard } from './MovieCard.jsx';

export default function Row({ row, watchlist, onToggleList }) {
  const track = useRef(null);
  const scroll = (dir) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.85, behavior: 'smooth' });
  if (!row.items?.length) return null;
  return (
    <section className={`row row-${row.kind}`} aria-label={row.title}>
      <h2 className="row-title">{row.title}</h2>
      <div className="row-frame">
        <button className="row-arrow left" onClick={() => scroll(-1)} aria-label={`Scroll ${row.title} left`}><Chevron style={{ transform: 'scaleX(-1)' }} /></button>
        <div className="row-track" ref={track}>
          {row.items.map((m, i) =>
            row.kind === 'top10' ? (
              <TopTenCard key={m.id} movie={m} rank={i + 1} />
            ) : (
              <MovieCard
                key={m.id}
                movie={m}
                onList={watchlist?.has(m.id)}
                onToggleList={onToggleList}
                progress={row.kind === 'continue' && m.duration_seconds ? m.position_seconds / m.duration_seconds : null}
              />
            ),
          )}
        </div>
        <button className="row-arrow right" onClick={() => scroll(1)} aria-label={`Scroll ${row.title} right`}><Chevron /></button>
      </div>
    </section>
  );
}
