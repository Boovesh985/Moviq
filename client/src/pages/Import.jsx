import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { readLetterboxd, readNetflix } from '../lib/history.js';

function Result({ r, kind }) {
  if (!r) return null;
  return (
    <div className="import-result" role="status">
      {kind === 'letterboxd' ? (
        <p>
          Matched <strong>{r.matched}</strong> of {r.films} films: {r.ratings} ratings, {r.reviews} reviews, {r.likes} likes,
          {' '}{r.watchlist} on your watchlist{r.added_films ? `. Added ${r.added_films} films Moviq didn’t have yet` : ''}.
        </p>
      ) : (
        <p>
          Matched <strong>{r.matched}</strong> of {r.titles} films and marked them watched{r.added_films ? `. Added ${r.added_films} films Moviq didn’t have yet` : ''}.
          {r.unrated > 0 && <> You have {r.unrated} watched films without a rating; rating them is the fastest way to sharpen your picks.</>}
        </p>
      )}
      {r.not_found?.length > 0 && (
        <details>
          <summary>{r.not_found.length}{r.not_found.length === 40 ? '+' : ''} titles couldn’t be matched</summary>
          <p className="muted">{r.not_found.join(' · ')}</p>
        </details>
      )}
    </div>
  );
}

export default function Import() {
  const [busy, setBusy] = useState(null);
  const [results, setResults] = useState({});
  const [error, setError] = useState('');

  const run = async (kind, files) => {
    if (!files?.length) return;
    setBusy(kind);
    setError('');
    try {
      const r = kind === 'letterboxd'
        ? await api.post('/import/letterboxd', { entries: await readLetterboxd([...files]) })
        : await api.post('/import/netflix', { titles: await readNetflix(files[0]) });
      setResults((cur) => ({ ...cur, [kind]: r }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="journal page-pad">
      <div className="import-page">
        <h1 className="j-h1">Bring your film history</h1>
        <p className="j-sub">Import what you’ve already watched and rated, and your recommendations start from your real taste instead of a blank slate. Files are read in your browser; only film titles, dates, ratings and your review text are sent.</p>

        <section className="import-card">
          <h2>Letterboxd</h2>
          <ol>
            <li>On Letterboxd, open <strong>Settings → Import &amp; Export → Export your data</strong>.</li>
            <li>Upload the ZIP it gives you (or the CSV files inside it).</li>
          </ol>
          <p className="muted">Brings in ratings, diary dates, reviews, likes and your watchlist.</p>
          <label className={`btn btn-green ${busy ? 'disabled' : ''}`}>
            {busy === 'letterboxd' ? 'Importing…' : 'Choose Letterboxd export'}
            <input type="file" accept=".zip,.csv" multiple hidden disabled={!!busy} onChange={(e) => run('letterboxd', e.target.files)} />
          </label>
          <Result r={results.letterboxd} kind="letterboxd" />
        </section>

        <section className="import-card">
          <h2>Netflix</h2>
          <ol>
            <li>On Netflix, open <strong>Account → Profiles → your profile → Viewing activity</strong> and choose <strong>Download all</strong> (NetflixViewingHistory.csv).</li>
            <li>Or upload <strong>ViewingActivity.csv</strong> from a full “Download your personal information” request.</li>
          </ol>
          <p className="muted">Films are marked as watched; series episodes and trailers are skipped. Netflix doesn’t export ratings, so rate a few afterwards.</p>
          <label className={`btn btn-red ${busy ? 'disabled' : ''}`}>
            {busy === 'netflix' ? 'Importing…' : 'Choose Netflix history'}
            <input type="file" accept=".csv" hidden disabled={!!busy} onChange={(e) => run('netflix', e.target.files)} />
          </label>
          <Result r={results.netflix} kind="netflix" />
        </section>

        {error && <p className="error-note" role="alert">{error}</p>}
        {(results.letterboxd || results.netflix) && <Link to="/" className="btn btn-line">See my recommendations</Link>}
      </div>
    </main>
  );
}
