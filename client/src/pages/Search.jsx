import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useLoad } from '../lib/useLoad.js';
import { MovieCard } from '../components/MovieCard.jsx';

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const { data: results, error } = useLoad(() => api.get(`/movies/search?q=${encodeURIComponent(q)}`).then((d) => d.results), [q]);

  return (
    <main className="screen search-page">
      <h1 className="row-title search-title">Results for “{q}”</h1>
      {error && <p className="empty">{error}</p>}
      {results && !results.length && <p className="empty">No films match “{q}”. Try a title, a director, an actor or a genre.</p>}
      <div className="search-grid">{results?.map((m) => <MovieCard key={m.id} movie={m} />)}</div>
    </main>
  );
}
