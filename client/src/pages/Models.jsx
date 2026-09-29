import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const KEY = { spoiler: 'f1', sentiment: 'accuracy', recommender: 'ndcg@10' };
const NAMES = { spoiler: 'Spoiler Shield', sentiment: 'Sentiment', recommender: 'Recommender' };
const SOURCE_NAMES = { movielens: 'MovieLens raters', moviq: 'Moviq members', tmdb: 'TMDB reviewers' };
const SIGNAL_NAMES = { content: 'Similar films', collab: 'People like you', latent: 'Taste patterns (SVD)', crowd: 'Community favourites' };

function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
// The number the deploy gate compared: the model's combined objective when it has one, else its main metric.
const decisive = (h, m) => (h.metrics.objective != null ? m?.objective : m?.[KEY[h.model]]) ?? null;
const pct = (v) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
const n = (v) => (v ?? 0).toLocaleString();

function Metric({ label, value, hint }) {
  return (
    <div className="metric" title={hint}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Pending({ have, need, what }) {
  return (
    <div className="pending">
      <span className="pending-bar"><span style={{ width: `${Math.min(100, (have / need) * 100)}%` }} /></span>
      <span>{have} of {need} {what} until the next retrain</span>
    </div>
  );
}

function ModelCard({ name, live, pending, threshold, isAdmin, onRetrain, busy, children }) {
  return (
    <section className="model-card">
      <header>
        <h2>{NAMES[name]} <span className="model-version">v{live.version || '–'}</span></h2>
        {isAdmin && <button className="btn btn-sm btn-line" disabled={busy} onClick={() => onRetrain(name)}>{busy === name ? 'Training…' : 'Retrain now'}</button>}
      </header>
      {children}
      <Pending have={pending} need={threshold} what={name === 'spoiler' ? 'new sentence labels' : name === 'sentiment' ? 'new rated reviews' : 'new ratings'} />
    </section>
  );
}

export default function Models() {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState('');

  const load = () => api.get('/models').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, []);

  const retrain = async (name) => {
    setBusy(name);
    setNotice('');
    try {
      const r = await api.post(`/models/${name}/retrain`);
      setNotice(`${NAMES[name]} v${r.version}: ${r.deployed ? 'deployed' : 'not deployed, the current version scored better'}.`);
      load();
    } catch (e) { setNotice(e.message); } finally { setBusy(null); }
  };

  if (error) return <main className="journal page-pad"><p className="empty">{error}</p></main>;
  if (!d) return <main className="journal" />;
  const { live, learner, history, data } = d;
  const sp = live.spoiler.metrics || {};
  const se = live.sentiment.metrics || {};
  const recRun = history.find((h) => h.model === 'recommender' && h.deployed);
  const rm = recRun?.metrics || {};
  const signals = rm.signals || {};
  const maxRecall = Math.max(rm['recall@10'] || 0, ...Object.values(signals).map((s) => s['recall@10'] || 0), 0.001);

  return (
    <main className="journal page-pad models-page">
      <h1 className="j-h1">How Moviq learns</h1>
      <p className="j-sub">
        Every model retrains from what people do here. A retrain only replaces the live model if it scores at least as well on examples it has never seen.
      </p>
      <div className="provenance">
        <span><strong>{n(data.movielens_members)}</strong> MovieLens {data.movielens_members === 1 ? 'member' : 'members'}</span>
        <span><strong>{n(data.ratings)}</strong> ratings</span>
        <span><strong>{n(data.moviq_members)}</strong> Moviq {data.moviq_members === 1 ? 'member' : 'members'}</span>
        <span><strong>{n(data.moviq_ratings)}</strong> Moviq ratings</span>
        <span><strong>{n(data.spoiler_labels)}</strong> spoiler {data.spoiler_labels === 1 ? 'label' : 'labels'}</span>
        <span><strong>{n(data.rated_reviews)}</strong> rated reviews</span>
      </div>
      <p className="learner-line">
        <span className={`dot ${learner.last_error ? 'err' : learner.activity === 'idle' ? '' : 'busy'}`} />
        Learner {learner.activity} · checks every {Math.round(learner.interval_seconds / 60)} min · last check {ago(learner.last_step)}
        {learner.last_error && <span className="error-note"> · last error: {learner.last_error}</span>}
      </p>
      {notice && <p className="saved-note" role="status">{notice}</p>}

      <div className="model-grid">
        <ModelCard name="spoiler" live={live.spoiler} pending={learner.pending.spoiler} threshold={learner.thresholds.spoiler} isAdmin={user.is_admin} onRetrain={retrain} busy={busy}>
          <div className="metrics">
            <Metric label="F1 (realistic)" value={pct(sp.f1_realistic ?? sp.f1)} hint="F1 if one sentence in ten were a spoiler, as in real reviews" />
            <Metric label="Precision" value={pct(sp.precision_realistic ?? sp.precision)} hint="Of the sentences it blurs, how many really are spoilers (at a realistic spoiler rate)" />
            <Metric label="Recall" value={pct(sp.recall)} hint="Of the real spoilers, how many it catches" />
          </div>
          <div className="subsets">
            {sp.film && <span>Film reviews: precision {pct(sp.film.precision)}, recall {pct(sp.film.recall)} ({n(sp.film.n)} sentences held out)</span>}
            {sp.goodreads && <span>Goodreads: precision {pct(sp.goodreads.precision)}, recall {pct(sp.goodreads.recall)} ({n(sp.goodreads.n)} sentences held out)</span>}
            {sp.live && <span>Moviq reader labels: F1 {pct(sp.live.f1)}</span>}
            {sp.threshold && <span>Blurs above {Math.round(sp.threshold * 100)}% confidence</span>}
          </div>
          <p className="model-note">
            Scored on {n(sp.validation)} held-out sentences. Trained on real spoiler labels from Goodreads reviewers plus hand-labelled film sentences, and keeps learning from readers answering “was this a spoiler?”, flagged sentences and authors’ corrections.
          </p>
        </ModelCard>

        <ModelCard name="sentiment" live={live.sentiment} pending={learner.pending.sentiment} threshold={learner.thresholds.sentiment} isAdmin={user.is_admin} onRetrain={retrain} busy={busy}>
          <div className="metrics">
            <Metric label="Accuracy" value={pct(se.accuracy)} hint="Positive/negative calls that were right (IMDb + film reviews held out)" />
            <Metric label="AUC" value={se.auc?.toFixed(3) ?? '–'} hint="How well it ranks positive above negative reviews (1.0 is perfect)" />
            <Metric label="Trained on" value={n(se.examples)} hint="Reviews in the training set" />
          </div>
          {se.live && (
            <div className="subsets">
              <span>On real film reviews it never saw: accuracy {pct(se.live.accuracy)}, AUC {se.live.auc?.toFixed(3)}</span>
            </div>
          )}
          <p className="model-note">
            Started from 50,000 IMDb reviews; every Moviq review with stars becomes a new labelled example, weighted 3× because it’s in-domain.
            Powers “What people say” on film pages and turns text-only reviews into a signal for recommendations.
          </p>
        </ModelCard>

        <ModelCard name="recommender" live={live.recommender} pending={learner.pending.recommender} threshold={learner.thresholds.recommender} isAdmin={user.is_admin} onRetrain={retrain} busy={busy}>
          <div className="metrics">
            <Metric label="Recall@10" value={pct(rm['recall@10'])} hint="Share of films people went on to love that appeared in their top 10" />
            <Metric label="nDCG@10" value={rm['ndcg@10']?.toFixed(3) ?? '–'} hint="Like recall, but rewards putting them near the top" />
            <Metric label="People tested" value={n(rm.users)} hint="Real people whose most recent ratings were hidden" />
          </div>
          <h3 className="mini-h">How each signal does alone, vs the learned blend</h3>
          <div className="signal-bars">
            {Object.entries(signals).map(([k, s]) => (
              <div key={k} className="signal-row">
                <span>{SIGNAL_NAMES[k]}</span>
                <span className="track"><span style={{ width: `${(s['recall@10'] / maxRecall) * 100}%` }} /></span>
                <span>{pct(s['recall@10'])}</span>
              </div>
            ))}
            {rm['recall@10'] != null && (
              <div className="signal-row blend">
                <span>Learned blend</span>
                <span className="track"><span style={{ width: `${(rm['recall@10'] / maxRecall) * 100}%` }} /></span>
                <span>{pct(rm['recall@10'])}</span>
              </div>
            )}
          </div>
          <h3 className="mini-h">Current weights</h3>
          <div className="weights">
            {Object.entries(live.recommender.weights).map(([k, v]) => (
              <span key={k} style={{ flexGrow: Math.max(v, 0.02) }} title={`${SIGNAL_NAMES[k]}: ${(v * 100).toFixed(0)}%`}>{SIGNAL_NAMES[k].split(' ')[0]} {(v * 100).toFixed(0)}%</span>
            ))}
          </div>
          {rm.by_source && (
            <>
              <h3 className="mini-h">By where people came from</h3>
              <div className="subsets">
                {Object.entries(rm.by_source).map(([src, m]) => (
                  <span key={src}>
                    {SOURCE_NAMES[src] || src}: {m.tuned.users >= 5
                      ? `recall@10 ${pct(m.tuned['recall@10'])} vs ${pct(m.popularity['recall@10'])} for popularity (${m.tuned.users} people)`
                      : `${m.tuned.users} of 5 people with 10+ ratings needed for a reliable score`}
                  </span>
                ))}
                {!rm.by_source.moviq && <span>Moviq members: scored separately once 5 members have rated 10+ films</span>}
              </div>
            </>
          )}
          <p className="model-note">
            Replays history: hides each person’s most recent ratings, then learns the weights that best predict what they loved next.
            Tuned on half the people, scored on the other half.
          </p>
        </ModelCard>
      </div>

      <h2 className="j-label" style={{ marginTop: 40 }}>Training history</h2>
      <div className="table-wrap">
        <table className="diary history">
          <thead><tr><th>Model</th><th>Version</th><th>When</th><th>Score</th><th>Previous</th><th>Outcome</th><th>Why</th></tr></thead>
          <tbody>
            {history.map((h) => (
              <tr key={`${h.model}-${h.version}`}>
                <td>{NAMES[h.model]}</td>
                <td>v{h.version}</td>
                <td>{ago(h.trained_at)}</td>
                <td>{h.metrics.objective != null ? 'score' : KEY[h.model]} {decisive(h, h.metrics)?.toFixed(3) ?? '–'}</td>
                <td>{decisive(h, h.baseline)?.toFixed(3) ?? '–'}</td>
                <td><span className={`outcome ${h.deployed ? 'ok' : 'kept'}`}>{h.deployed ? 'Deployed' : 'Kept previous'}</span></td>
                <td className="why">{h.reason}{h.n_live ? ` · ${n(h.n_live)} live examples` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
