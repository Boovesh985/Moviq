import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Poster from '../components/Poster.jsx';
import { X } from '../components/Icons.jsx';

export default function Settings() {
  const { user, setUser } = useAuth();
  const [services, setServices] = useState([]);
  const [form, setForm] = useState({ display_name: user.display_name, bio: user.bio || '', services: user.services || [], favorite_ids: user.favorite_ids || [] });
  const [favs, setFavs] = useState([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/users/services').then(setServices).catch((e) => setError(e.message));
    api.get(`/users/${user.username}`).then((p) => setFavs(p.favorites)).catch((e) => setError(e.message));
  }, [user.username]);
  useEffect(() => {
    if (q.trim().length < 2) return setHits([]);
    let live = true;   // typing on: results for an older query never replace newer ones
    const t = setTimeout(() => api.get(`/movies/search?q=${encodeURIComponent(q)}`)
      .then((d) => live && setHits(d.results.slice(0, 6))).catch(() => {}), 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const toggleService = (s) => setForm((f) => ({ ...f, services: f.services.includes(s) ? f.services.filter((x) => x !== s) : [...f.services, s] }));
  const addFav = (m) => { if (favs.length < 4 && !favs.some((f) => f.id === m.id)) setFavs([...favs, m]); setQ(''); };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const { user: u } = await api.put('/users/me', { ...form, favorite_ids: favs.map((f) => f.id) });
      setUser(u);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err.message); }
  };

  return (
    <main className="journal page-pad">
      <form className="settings" onSubmit={save}>
        <h1 className="j-h1">Settings</h1>
        <p className="j-sub">Your profile, your four favourites, and the streaming services you pay for.</p>

        <label className="field"><span>Display name</span><input value={form.display_name} maxLength={40} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
        <label className="field"><span>Bio</span><textarea rows={3} maxLength={300} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></label>

        <h2 className="j-label">Favourite films</h2>
        <div className="favs" style={{ marginBottom: 12 }}>
          {favs.map((m) => (
            <div key={m.id} style={{ position: 'relative' }}>
              <Poster movie={m} />
              <button type="button" className="icon-btn" style={{ position: 'absolute', top: 4, right: 4, width: 26, height: 26 }} onClick={() => setFavs(favs.filter((f) => f.id !== m.id))} aria-label={`Remove ${m.title}`}><X width={14} /></button>
            </div>
          ))}
        </div>
        {favs.length < 4 && (
          <label className="field">
            <span>Add a favourite ({4 - favs.length} left)</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for a film" />
            {hits.length > 0 && (
              <div className="menu-panel" style={{ position: 'static', marginTop: 4 }}>
                {hits.map((m) => <button type="button" key={m.id} onClick={() => addFav(m)}>{m.title} ({m.year})</button>)}
              </div>
            )}
          </label>
        )}

        <h2 className="j-label" style={{ marginTop: 26 }}>Streaming services you have</h2>
        <p className="j-sub" style={{ fontSize: 14, marginTop: -6 }}>Decide mode can limit picks to films you can watch right now.</p>
        <div className="service-grid">
          {services.map((s) => (
            <label key={s} className="service"><input type="checkbox" checked={form.services.includes(s)} onChange={() => toggleService(s)} /> {s}</label>
          ))}
        </div>
        {error && <p className="error-note">{error}</p>}
        <button className="btn btn-green">Save changes</button>
        {saved && <span className="saved-note" role="status">Saved</span>}
      </form>
    </main>
  );
}
