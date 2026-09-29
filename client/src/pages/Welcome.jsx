import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import Poster from '../components/Poster.jsx';
import { Check } from '../components/Icons.jsx';

// Cold-start onboarding: pick films you love so the recommender has something to go on.
export default function Welcome() {
  const [items, setItems] = useState([]);
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  const [error, setError] = useState('');

  useEffect(() => { api.get('/movies/onboarding').then((d) => setItems(d.items)).catch((e) => setError(e.message)); }, []);

  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const done = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/users/me/onboarding', { movie_ids: [...picked] });
      nav('/');
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <main className="journal page-pad">
      <div className="welcome">
        <h1 className="j-h1">Pick three or more films you love</h1>
        <p className="j-sub">Moviq uses them to shape your first recommendations. You can rate and review everything later.
          {' '}Already on Letterboxd or Netflix? <Link to="/import">Import your history instead</Link>.</p>
        <div className="poster-grid picker">
          {items.map((m) => (
            <button key={m.id} className={`pick ${picked.has(m.id) ? 'on' : ''}`} onClick={() => toggle(m.id)} aria-pressed={picked.has(m.id)}>
              <Poster movie={m} />
              <span className="pick-check"><Check /></span>
            </button>
          ))}
        </div>
        <div className="welcome-bar">
          <span>{error ? <span className="error-note" role="alert">{error}</span> : `${picked.size} selected`}</span>
          <button className="btn btn-green" disabled={picked.size < 3 || busy} onClick={done}>
            {picked.size < 3 ? `Pick ${3 - picked.size} more` : 'Show my recommendations'}
          </button>
        </div>
      </div>
    </main>
  );
}
