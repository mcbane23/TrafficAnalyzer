import { ref } from 'vue';

export interface AuthStatus {
  /** Whether the server has an Admin password (ADMIN_PASSWORD) at all. */
  required: boolean;
  signedIn: boolean;
  /** 'env' when ADMIN_PASSWORD sets it (not changeable here), 'admin' when set on the Admin page. */
  source: 'env' | 'admin' | null;
}

/** The last status the server reported; null until the first check. */
export const authStatus = ref<AuthStatus | null>(null);

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  authStatus.value = await res.json();
  return authStatus.value!;
}

export type SignInResult = 'ok' | 'wrong' | 'blocked' | 'error';

export async function signIn(password: string): Promise<SignInResult> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      if (authStatus.value) authStatus.value = { ...authStatus.value, signedIn: true };
      return 'ok';
    }
    if (res.status === 401) return 'wrong';
    if (res.status === 429) return 'blocked';
    return 'error';
  } catch {
    return 'error';
  }
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  if (authStatus.value) authStatus.value = { ...authStatus.value, signedIn: false };
}

export type ChangePasswordResult = 'ok' | 'wrong' | 'short' | 'env' | 'error';

/** Sets, changes or (empty `password`) removes the Admin page's password. */
export async function changePassword(current: string, password: string): Promise<ChangePasswordResult> {
  try {
    const res = await fetch('/api/admin/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, password }),
    });
    if (res.ok) {
      await fetchAuthStatus();
      return 'ok';
    }
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    return body.code === 'wrong' || body.code === 'short' || body.code === 'env' ? body.code : 'error';
  } catch {
    return 'error';
  }
}

/**
 * Sends the browser to the sign-in page when an Admin request comes back 401,
 * e.g. after the session expired or the password changed while a page was open.
 */
export function redirectOnAdminUnauthorized(onUnauthorized: () => void): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (res.status === 401 && /^(https?:\/\/[^/]+)?\/api\/(admin|cameras\/revalidate)/.test(url)) {
      if (authStatus.value) authStatus.value = { ...authStatus.value, signedIn: false };
      onUnauthorized();
    }
    return res;
  };
}
