import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Nav from './components/Nav.jsx';
import Auth from './pages/Auth.jsx';
import Welcome from './pages/Welcome.jsx';
import Browse from './pages/Browse.jsx';
import Film from './pages/Film.jsx';
import Watch from './pages/Watch.jsx';
import Decide from './pages/Decide.jsx';
import Party from './pages/Party.jsx';
import Journal from './pages/Journal.jsx';
import Profile from './pages/Profile.jsx';
import Films from './pages/Films.jsx';
import Search from './pages/Search.jsx';
import Settings from './pages/Settings.jsx';
import Models from './pages/Models.jsx';
import Import from './pages/Import.jsx';

function Private({ children }) {
  const { user } = useAuth();
  const loc = useLocation();
  if (user === undefined) return <div className="page-loading" aria-label="Loading" />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return children;
}

export default function App() {
  const loc = useLocation();
  const bare = /^\/(login|register|watch\/)/.test(loc.pathname);
  return (
    <>
      {!bare && <Nav />}
      <Routes>
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/register" element={<Auth mode="register" />} />
        <Route path="/welcome" element={<Private><Welcome /></Private>} />
        <Route path="/" element={<Private><Browse /></Private>} />
        <Route path="/film/:id" element={<Private><Film /></Private>} />
        <Route path="/watch/:id" element={<Private><Watch /></Private>} />
        <Route path="/decide" element={<Private><Decide /></Private>} />
        <Route path="/group" element={<Private><Party /></Private>} />
        <Route path="/group/:code" element={<Private><Party /></Private>} />
        <Route path="/journal" element={<Private><Journal /></Private>} />
        <Route path="/films" element={<Private><Films /></Private>} />
        <Route path="/u/:username" element={<Private><Profile /></Private>} />
        <Route path="/u/:username/:tab" element={<Private><Profile /></Private>} />
        <Route path="/search" element={<Private><Search /></Private>} />
        <Route path="/settings" element={<Private><Settings /></Private>} />
        <Route path="/models" element={<Private><Models /></Private>} />
        <Route path="/import" element={<Private><Import /></Private>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
