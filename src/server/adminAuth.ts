import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** The cookie holding a signed-in browser's session. */
export const ADMIN_COOKIE = 'ta_admin';
const DEFAULT_SESSION_MS = 30 * 24 * 60 * 60_000;
/** Failed sign-ins from one address within `FAILURE_WINDOW_MS` before it has to wait. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;

export interface AdminAuthOptions {
  /** How long a sign-in lasts. Defaults to 30 days. */
  sessionMs?: number;
  now?: () => number;
}

/**
 * The Admin password (ADMIN_PASSWORD). With one set, the Admin API and
 * everything that changes the server (cameras, analysis settings, accuracy
 * checks, the availability check) need a signed-in browser; the dashboard,
 * statistics and live video stay open. Without one, nothing changes from
 * before and the Admin page warns that it is open to anyone.
 *
 * A session is a cookie holding its expiry, signed with a key derived from
 * the password: nothing to store, it survives a restart, and changing the
 * password signs every browser out.
 */
export class AdminAuth {
  private readonly key: Buffer | null;
  private readonly passwordHash: Buffer | null;
  private readonly sessionMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();

  constructor(password: string | undefined, options: AdminAuthOptions = {}) {
    const value = password?.trim() ? password : null;
    this.key = value === null ? null : crypto.createHash('sha256').update(`trafficanalyzer-admin:${value}`).digest();
    this.passwordHash = value === null ? null : crypto.createHash('sha256').update(value).digest();
    this.sessionMs = options.sessionMs ?? DEFAULT_SESSION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether a password is set at all. */
  get required(): boolean {
    return this.key !== null;
  }

  /** Whether this request comes from a signed-in browser (always true without a password). */
  isSignedIn(req: Request): boolean {
    if (!this.key) return true;
    const token = readCookie(req.headers.cookie, ADMIN_COOKIE);
    if (!token) return false;
    const [expires, signature] = token.split('.');
    if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) <= this.now()) return false;
    return safeEqual(signature, this.sign(expires));
  }

  /** Express middleware: lets signed-in requests through, answers the rest with 401. */
  readonly guard = (req: Request, res: Response, next: NextFunction): void => {
    if (this.isSignedIn(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Admin password required.' });
  };

  /**
   * Checks a sign-in attempt. On success it returns the cookie to set; on
   * failure null, or 'blocked' once this address has failed too often lately.
   */
  signIn(address: string, password: unknown): { cookie: string } | null | 'blocked' {
    if (!this.key || !this.passwordHash) return { cookie: '' };
    const now = this.now();
    const recent = (this.failures.get(address) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
    if (recent.length >= MAX_FAILURES) return 'blocked';
    const given = crypto.createHash('sha256').update(typeof password === 'string' ? password : '').digest();
    if (!crypto.timingSafeEqual(given, this.passwordHash)) {
      recent.push(now);
      this.failures.set(address, recent);
      return null;
    }
    this.failures.delete(address);
    const expires = String(now + this.sessionMs);
    return { cookie: `${expires}.${this.sign(expires)}` };
  }

  /** Cookie attributes for a session set now. */
  cookieOptions(secure: boolean) {
    return { httpOnly: true, sameSite: 'strict' as const, secure, path: '/', maxAge: this.sessionMs };
  }

  private sign(expires: string): string {
    return crypto.createHmac('sha256', this.key!).update(expires).digest('base64url');
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of header?.split(';') ?? []) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
