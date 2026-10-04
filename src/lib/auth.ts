export type AuthUser = {
  userId: string;
  email: string;
  role?: string | null;
};

export const readStoredUser = (): AuthUser | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('user');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const userId = parsed.user_id || parsed.oauth_id;
    const email = parsed.email;
    if (!userId || !email) return null;
    return { userId, email, role: parsed.role || null };
  } catch {
    return null;
  }
};

/** The session token the magic-link login stored (same value other Vegvisr APIs take as X-API-Token). */
export const readStoredToken = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('user');
    if (!raw) return null;
    return JSON.parse(raw).emailVerificationToken || null;
  } catch {
    return null;
  }
};
