import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

/** The cookie holding a signed-in browser's session. */
export const ADMIN_COOKIE = 'ta_admin';
const DEFAULT_SESSION_MS = 30 * 24 * 60 * 60_000;
/** Failed sign-ins from one address within `FAILURE_WINDOW_MS` before it has to wait. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
export const MIN_PASSWORD_LENGTH = 6;

/** Where the password comes from: the ADMIN_PASSWORD variable, the Admin page, or nowhere. */
export type PasswordSource = 'env' | 'admin' | null;

export interface AdminAuthOptions {
  /** File in the data volume holding a password set on the Admin page (salted scrypt hash). */
  storePath?: string;
  /** How long a sign-in lasts. Defaults to 30 days. */
  sessionMs?: number;
  now?: () => number;
}

interface StoredPassword {
  salt: string;
  hash: string;
}

interface Secret {
  /** Signs session cookies; derived from the password, so changing it signs every browser out. */
  key: Buffer;
  matches(password: string): boolean;
}

export type ChangeResult = 'ok' | 'env' | 'wrong' | 'short';

/**
 * The Admin password. It comes from ADMIN_PASSWORD when that is set (which
 * then can't be changed on the page), otherwise from one set on the Admin
 * page and kept hashed in the data volume. With a password, the Admin API and
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
  private secret: Secret | null;
  private readonly fromEnv: boolean;
  private stored: boolean;
  private readonly storePath: string | undefined;
  private readonly sessionMs: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, number[]>();

  constructor(envPassword: string | undefined, options: AdminAuthOptions = {}) {
    this.storePath = options.storePath;
    this.sessionMs = options.sessionMs ?? DEFAULT_SESSION_MS;
    this.now = options.now ?? (() => Date.now());
    if (envPassword?.trim()) {
      this.fromEnv = true;
      this.secret = envSecret(envPassword);
      this.stored = false;
    } else {
      this.fromEnv = false;
      const stored = this.readStore();
      this.secret = stored ? storedSecret(stored) : null;
      this.stored = stored !== null;
    }
  }

  /** Whether a password is set at all. */
  get required(): boolean {
    return this.secret !== null;
  }

  /** Where the password in force comes from; null when there is none. */
  get source(): PasswordSource {
    if (this.fromEnv) return 'env';
    return this.stored ? 'admin' : null;
  }

  /** Whether this request comes from a signed-in browser (always true without a password). */
  isSignedIn(req: Request): boolean {
    if (!this.secret) return true;
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
    if (!this.secret) return { cookie: '' };
    const now = this.now();
    const recent = (this.failures.get(address) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
    if (recent.length >= MAX_FAILURES) return 'blocked';
    if (!this.secret.matches(typeof password === 'string' ? password : '')) {
      recent.push(now);
      this.failures.set(address, recent);
      return null;
    }
    this.failures.delete(address);
    return { cookie: this.newSession() };
  }

  /**
   * Sets, changes or (with an empty `password`) removes the Admin page's
   * password. A password already set has to be given as `current`. On success
   * with a new password, `cookie` keeps the browser that changed it signed in.
   */
  changePassword(current: unknown, password: unknown): { result: ChangeResult; cookie?: string } {
    if (this.fromEnv) return { result: 'env' };
    if (this.secret && !this.secret.matches(typeof current === 'string' ? current : '')) return { result: 'wrong' };
    const next = typeof password === 'string' ? password : '';
    if (next === '') {
      this.removeStore();
      this.secret = null;
      this.stored = false;
      return { result: 'ok' };
    }
    if (next.length < MIN_PASSWORD_LENGTH) return { result: 'short' };
    const salt = crypto.randomBytes(16);
    const stored = { salt: salt.toString('base64'), hash: crypto.scryptSync(next, salt, 32).toString('base64') };
    this.writeStore(stored);
    this.secret = storedSecret(stored);
    this.stored = true;
    return { result: 'ok', cookie: this.newSession() };
  }

  /** Cookie attributes for a session set now. */
  cookieOptions(secure: boolean) {
    return { httpOnly: true, sameSite: 'strict' as const, secure, path: '/', maxAge: this.sessionMs };
  }

  private newSession(): string {
    const expires = String(this.now() + this.sessionMs);
    return `${expires}.${this.sign(expires)}`;
  }

  private sign(expires: string): string {
    return crypto.createHmac('sha256', this.secret!.key).update(expires).digest('base64url');
  }

  private readStore(): StoredPassword | null {
    if (!this.storePath) return null;
    try {
      const value = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Partial<StoredPassword>;
      return typeof value.salt === 'string' && typeof value.hash === 'string' && value.hash ? { salt: value.salt, hash: value.hash } : null;
    } catch {
      return null;
    }
  }

  /** Writes to a temporary file first, so a crash mid-write can't leave a truncated file behind. */
  private writeStore(stored: StoredPassword): void {
    if (!this.storePath) return;
    const tmp = `${this.storePath}.tmp`;
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.storePath);
  }

  private removeStore(): void {
    if (this.storePath) fs.rmSync(this.storePath, { force: true });
  }
}

function envSecret(password: string): Secret {
  const digest = crypto.createHash('sha256').update(password).digest();
  return {
    key: crypto.createHash('sha256').update(`trafficanalyzer-admin:${password}`).digest(),
    matches: (given) => crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), digest),
  };
}

function storedSecret(stored: StoredPassword): Secret {
  const salt = Buffer.from(stored.salt, 'base64');
  const hash = Buffer.from(stored.hash, 'base64');
  return {
    key: crypto.createHash('sha256').update(`trafficanalyzer-admin:${stored.hash}`).digest(),
    matches: (given) => {
      const candidate = crypto.scryptSync(given, salt, hash.length);
      return candidate.length === hash.length && crypto.timingSafeEqual(candidate, hash);
    },
  };
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
