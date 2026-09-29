import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { PosterStrip } from './Journal.jsx';
import { Stars } from '../components/Stars.jsx';

export default function Films() {
  const [params, setParams] = useSearchParams();
  const genre = params.get('genre') || 'Drama';
  const [genres, setGenres] = useState([]);
  const [items, setItems] = useState(null);

  useEffect(() => { api.get('/movies/genres').then(setGenres); }, []);
  useEffect(() => { setItems(null); api.get(`/movies/genre/${encodeURIComponent(genre)}`).then((d) => setItems(d.items)); }, [genre]);

  return (
    <main className="journal page-pad">
      <h1 className="j-h1">Browse films</h1>
      <p className="j-sub">Sorted by what’s popular on Moviq. The percentage is how well each film matches your taste.</p>
      <div className="filter-bar" role="toolbar" aria-label="Genre">
        {genres.map((g) => (
          <button key={g.name} className={g.name === genre ? 'on' : ''} aria-pressed={g.name === genre} onClick={() => setParams({ genre: g.name })}>
            {g.name} <span className="muted">{g.count}</span>
          </button>
        ))}
      </div>
      {items && (
        <PosterStrip items={items} caption={(m) => (
          <>{m.avg_rating && <Stars value={Math.round(m.avg_rating * 2) / 2} />}{m.match != null && <span className="match" style={{ fontSize: 11 }}>{m.match}%</span>}</>
        )} />
      )}
    </main>
  );
}
