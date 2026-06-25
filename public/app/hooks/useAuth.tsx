import React, { createContext, useContext, useState, useEffect } from 'react';

interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  photo_url: string | null;
  role: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (data: AuthResponse) => void;
  logout: () => Promise<void>;
  isAuthenticated: boolean;
  isAdmin: boolean;
}

interface AuthResponse {
  access_token: string;
  expires_at: string;
  user: User;
}

const AuthContext = createContext<AuthContextType>(null!);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Session lives in an httpOnly cookie set by the OIDC callback (also sent
    // for same-origin requests), with a legacy Bearer token as fallback. Always
    // ask /me — the cookie may authenticate us even without a localStorage token.
    fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('Unauthorized');
      })
      .then((data: User) => {
        setUser(data);
        // Drop any ?login_error / OAuth params left in the URL after a redirect.
        if (window.location.search) {
          window.history.replaceState({}, '', window.location.pathname);
        }
      })
      .catch(() => {
        setToken(null);
        setUser(null);
        localStorage.removeItem('token');
      })
      .finally(() => setLoading(false));
  }, []);

  function login(data: AuthResponse) {
    setToken(data.access_token);
    setUser(data.user);
    localStorage.setItem('token', data.access_token);
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {}
    setToken(null);
    setUser(null);
    localStorage.removeItem('token');
  }

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, isAuthenticated: !!user, isAdmin: user?.role === 'admin' }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
