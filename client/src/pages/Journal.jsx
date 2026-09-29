import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Poster from '../components/Poster.jsx';
import Avatar from '../components/Avatar.jsx';
import ReviewCard from '../components/ReviewCard.jsx';
import { Stars } from '../components/Stars.jsx';
import { HeartFill, Pencil } from '../components/Icons.jsx';

export function PosterStrip({ items, caption }) {
  return (
    <div className="poster-grid">
      {items.map((m) => (
        <div key={m.id}>
          <Link to={`/film/${m.id}`} className="poster-link" title={`${m.title} (${m.year})`}><Poster movie={m} /></Link>
          {caption && <div className="poster-caption">{caption(m)}</div>}
        </div>
      ))}
    </div>
  );
}

export default function Journal() {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  useEffect(() => { api.get('/journal').then(setD); }, []);
  if (!d) return <main className="journal" />;

  return (
    <main className="journal">
      <div className="journal-home">
        <header className="journal-hero">
          <h1>Welcome back, {user.display_name}. Here’s what your friends have been watching.</h1>
          <p>Log films, write reviews, and read what people thought, with spoilers kept out of your way.</p>
        </header>

        {d.friendsActivity.length > 0 && (
          <section className="j-section">
            <h2 className="j-label">New from friends</h2>
            <div className="activity-grid">
              {d.friendsActivity.map((a, i) => (
                <div key={i} className="activity">
                  <Link to={`/film/${a.id}`} className="poster-link" title={a.title}><Poster movie={a} /></Link>
                  <Link to={`/u/${a.username}`} className="who">
                    <Avatar user={a} size={18} /> <Stars value={a.rating} />
                    {a.liked && <HeartFill width={11} className="heart" />}
                    {a.has_review && <Pencil width={11} />}
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="j-section">
          <h2 className="j-label">{d.popularThisWeek ? 'Popular films this week' : 'Most watched on Moviq'} <Link to="/films">More</Link></h2>
          <PosterStrip items={d.popularWeek} caption={(m) => m.avg_rating && <Stars value={Math.round(m.avg_rating * 2) / 2} />} />
        </section>

        <div className="j-cols">
          <section className="j-section">
            <h2 className="j-label">Popular reviews</h2>
            {d.popularReviews.map((r) => <ReviewCard key={r.id} review={r} showFilm />)}
            {d.friendsReviews.length > 0 && (
              <>
                <h2 className="j-label" style={{ marginTop: 40 }}>New reviews from friends</h2>
                {d.friendsReviews.map((r) => <ReviewCard key={r.id} review={r} showFilm />)}
              </>
            )}
          </section>
          <aside>
            <section className="j-section">
              <h2 className="j-label">Highest rated</h2>
              <PosterStrip items={d.topRated.slice(0, 9)} caption={(m) => <Stars value={Math.round(m.avg_rating * 2) / 2} />} />
            </section>
            <section className="j-section">
              <h2 className="j-label">Popular members</h2>
              <div className="members">
                {d.members.map((m) => (
                  <Link key={m.username} to={`/u/${m.username}`} className="member">
                    <Avatar user={m} size={40} />
                    <span><strong>{m.display_name}</strong>{m.films} films · {m.reviews} reviews</span>
                  </Link>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
