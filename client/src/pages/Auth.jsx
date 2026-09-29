import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { api } from '../api.js';
import Poster from '../components/Poster.jsx';
import { Logo } from '../components/Icons.jsx';

export default function Auth({ mode }) {
  const { user, login, register } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [form, setForm] = useState({ login: '', password: '', username: '', email: '', displayName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wall, setWall] = useState([]);

  useEffect(() => {
    api.get('/movies/onboarding').then((d) => setWall(d.items)).catch(() => {});
  }, []);

  if (user) return <Navigate to={loc.state?.from || '/'} replace />;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e, override) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') {
        await login(override?.login ?? form.login, override?.password ?? form.password);
        nav(loc.state?.from || '/');
      } else {
        await register({ username: form.username, email: form.email, password: form.password, displayName: form.displayName });
        nav('/welcome');
      }
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <div className="auth-wall" aria-hidden="true">
        {[...wall, ...wall, ...wall].slice(0, 48).map((m, i) => <Poster key={i} movie={m} />)}
      </div>
      <Link to="/" className="logo">MOVIQ<Logo /></Link>
      <form className="auth-card" onSubmit={submit}>
        <h1>{mode === 'login' ? 'Sign in' : 'Create your account'}</h1>
        <p className="sub">{mode === 'login' ? 'Watch, review and decide what’s next.' : 'Watch free classics, log every film, and get picks that actually fit you.'}</p>
        {mode === 'register' && (
          <>
            <label className="field"><span>Username</span><input value={form.username} onChange={set('username')} autoComplete="username" required /></label>
            <label className="field"><span>Display name</span><input value={form.displayName} onChange={set('displayName')} autoComplete="name" /></label>
            <label className="field"><span>Email</span><input type="email" value={form.email} onChange={set('email')} autoComplete="email" required /></label>
          </>
        )}
        {mode === 'login' && (
          <label className="field"><span>Username or email</span><input value={form.login} onChange={set('login')} autoComplete="username" required /></label>
        )}
        <label className="field">
          <span>Password</span>
          <input type="password" value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 8 : undefined} required />
        </label>
        {error && <p className="error-note" role="alert">{error}</p>}
        <button className="btn btn-red" disabled={busy}>{busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        <p className="auth-alt">
          {mode === 'login' ? <>New to Moviq? <Link to="/register">Create an account</Link></> : <>Already a member? <Link to="/login">Sign in</Link></>}
        </p>
        {mode === 'login' && (
          <p className="demo-hint">
            Exploring locally? <button type="button" onClick={() => submit(null, { login: 'demo', password: 'moviq123' })}>Sign in with the demo account</button>
          </p>
        )}
      </form>
    </main>
  );
}
