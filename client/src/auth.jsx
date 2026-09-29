import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still checking

  useEffect(() => {
    api.get('/auth/me').then((d) => setUser(d.user)).catch(() => setUser(null));
  }, []);

  const value = {
    user,
    setUser,
    login: async (login, password) => setUser((await api.post('/auth/login', { login, password })).user),
    register: async (form) => setUser((await api.post('/auth/register', form)).user),
    logout: async () => {
      await api.post('/auth/logout');
      setUser(null);
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
