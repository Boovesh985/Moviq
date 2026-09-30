import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking
  const [offline, setOffline] = useState(false);

  // Only a 401 means "signed out". If the API is briefly unreachable (restarting, network blip),
  // keep checking instead of sending a signed-in person to the login page.
  useEffect(() => {
    let timer;
    const check = () => api.get('/auth/me')
      .then((d) => { setUser(d.user); setOffline(false); })
      .catch((e) => {
        if (e.status === 401) { setUser(null); setOffline(false); return; }
        setOffline(true);
        timer = setTimeout(check, 3000);
      });
    check();
    // On free hosting the ML service sleeps when idle; start waking it now, not when someone needs a pick.
    api.get('/wake').catch(() => {});
    return () => clearTimeout(timer);
  }, []);

  const value = {
    user,
    offline,
    setUser,
    login: async (login, password) => setUser((await api.post('/auth/login', { login, password })).user),
    register: async (form) => setUser((await api.post('/auth/register', form)).user),
    guest: async () => setUser((await api.post('/auth/guest')).user),
    logout: async () => {
      await api.post('/auth/logout');
      setUser(null);
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
