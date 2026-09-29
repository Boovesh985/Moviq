import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import Avatar from './Avatar.jsx';
import { Logo, Menu, Search } from './Icons.jsx';

export default function Nav() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const [links, setLinks] = useState(false);
  const inputRef = useRef(null);
  const journal = /^\/(film|journal|u|films|settings|welcome|models|import)/.test(loc.pathname);

  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 10);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  useEffect(() => { setMenu(false); setLinks(false); }, [loc.pathname]);

  if (!user) return null;

  const submit = (e) => {
    e.preventDefault();
    if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <header className={`nav ${journal ? 'journal-nav' : scrolled ? 'solid' : ''}`}>
      <button className="nav-burger" onClick={() => setLinks(!links)} aria-label="Menu" aria-expanded={links}><Menu width={22} /></button>
      <Link to="/" className="logo" aria-label="Moviq home">MOVIQ<Logo /></Link>
      <nav className={`nav-links ${links ? 'open' : ''}`} aria-label="Main">
        <NavLink to="/" end>Home</NavLink>
        <NavLink to="/films">Films</NavLink>
        <NavLink to="/decide" className="feature">Decide in 60s</NavLink>
        <NavLink to="/group" className="feature">Group pick</NavLink>
        <NavLink to="/journal">Journal</NavLink>
        <NavLink to={`/u/${user.username}/watchlist`}>My List</NavLink>
      </nav>
      <div className="nav-right">
        <form className={`nav-search ${searchOpen ? 'open' : ''}`} onSubmit={submit} role="search">
          <button type="button" aria-label="Search" onClick={() => { setSearchOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }}>
            <Search width={20} />
          </button>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => !q && setSearchOpen(false)}
            placeholder="Titles, people, genres" aria-label="Search titles, people, genres" />
        </form>
        <div className="menu">
          <button onClick={() => setMenu(!menu)} aria-expanded={menu} aria-label="Account menu"><Avatar user={user} size={32} /></button>
          {menu && (
            <div className="menu-panel" onMouseLeave={() => setMenu(false)}>
              <Link to={`/u/${user.username}`}>Profile</Link>
              <Link to={`/u/${user.username}/diary`}>Diary</Link>
              <Link to={`/u/${user.username}/reviews`}>Reviews</Link>
              <Link to="/import">Import Letterboxd / Netflix</Link>
              <Link to="/settings">Settings & services</Link>
              <Link to="/models">How Moviq learns</Link>
              <hr />
              <button onClick={async () => { await logout(); nav('/login'); }}>Sign out of Moviq</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
