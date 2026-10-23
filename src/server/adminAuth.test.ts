import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { ADMIN_COOKIE, AdminAuth } from './adminAuth';

function request(cookie?: string): Request {
  return { headers: cookie ? { cookie } : {} } as Request;
}

describe('AdminAuth', () => {
  it('lets everything through without a password', () => {
    const auth = new AdminAuth(undefined);
    expect(auth.required).toBe(false);
    expect(auth.isSignedIn(request())).toBe(true);
    expect(new AdminAuth('   ').required).toBe(false);
  });

  it('signs in with the right password and accepts the cookie until it expires', () => {
    let now = 1_000_000;
    const auth = new AdminAuth('tajna', { sessionMs: 60_000, now: () => now });
    expect(auth.required).toBe(true);
    expect(auth.isSignedIn(request())).toBe(false);
    expect(auth.signIn('1.2.3.4', 'pogresno')).toBeNull();
    const result = auth.signIn('1.2.3.4', 'tajna');
    expect(result).toEqual({ cookie: expect.any(String) });
    const cookie = `other=1; ${ADMIN_COOKIE}=${(result as { cookie: string }).cookie}`;
    expect(auth.isSignedIn(request(cookie))).toBe(true);
    now += 61_000;
    expect(auth.isSignedIn(request(cookie))).toBe(false);
  });

  it('rejects a forged or foreign cookie', () => {
    const auth = new AdminAuth('tajna');
    const other = new AdminAuth('druga');
    const foreign = (other.signIn('x', 'druga') as { cookie: string }).cookie;
    expect(auth.isSignedIn(request(`${ADMIN_COOKIE}=${foreign}`))).toBe(false);
    const own = (auth.signIn('x', 'tajna') as { cookie: string }).cookie;
    const [, signature] = own.split('.');
    expect(auth.isSignedIn(request(`${ADMIN_COOKIE}=${Date.now() + 10 ** 12}.${signature}`))).toBe(false);
    expect(auth.isSignedIn(request(`${ADMIN_COOKIE}=garbage`))).toBe(false);
  });

  it('blocks an address after too many wrong passwords', () => {
    let now = 0;
    const auth = new AdminAuth('tajna', { now: () => now });
    for (let i = 0; i < 10; i++) expect(auth.signIn('a', 'x')).toBeNull();
    expect(auth.signIn('a', 'tajna')).toBe('blocked');
    expect(auth.signIn('b', 'tajna')).not.toBe('blocked');
    now += 16 * 60_000;
    expect(auth.signIn('a', 'tajna')).toEqual({ cookie: expect.any(String) });
  });

  it('answers 401 from the guard when not signed in', () => {
    const auth = new AdminAuth('tajna');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    auth.guard(request(), res as never, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  describe('password set on the Admin page', () => {
    let dir: string;
    let storePath: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-auth-'));
      storePath = path.join(dir, 'admin-password.json');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('sets, keeps across a restart, changes and removes the password', () => {
      const auth = new AdminAuth(undefined, { storePath });
      expect(auth.source).toBeNull();
      expect(auth.changePassword('', 'kratk').result).toBe('short');
      const set = auth.changePassword('', 'tajna123');
      expect(set.result).toBe('ok');
      expect(auth.source).toBe('admin');
      expect(fs.readFileSync(storePath, 'utf8')).not.toContain('tajna123');
      const cookie = `${ADMIN_COOKIE}=${set.cookie}`;
      expect(auth.isSignedIn(request(cookie))).toBe(true);

      const restarted = new AdminAuth(undefined, { storePath });
      expect(restarted.required).toBe(true);
      expect(restarted.isSignedIn(request(cookie))).toBe(true);
      expect(restarted.signIn('a', 'tajna123')).toEqual({ cookie: expect.any(String) });

      expect(restarted.changePassword('pogresno', 'nova-lozinka').result).toBe('wrong');
      expect(restarted.changePassword('tajna123', 'nova-lozinka').result).toBe('ok');
      expect(restarted.isSignedIn(request(cookie))).toBe(false);
      expect(restarted.signIn('a', 'tajna123')).toBeNull();

      expect(restarted.changePassword('nova-lozinka', '').result).toBe('ok');
      expect(restarted.required).toBe(false);
      expect(fs.existsSync(storePath)).toBe(false);
    });

    it('lets ADMIN_PASSWORD win and refuses changes on the page', () => {
      new AdminAuth(undefined, { storePath }).changePassword('', 'sa-stranice');
      const auth = new AdminAuth('iz-compose', { storePath });
      expect(auth.source).toBe('env');
      expect(auth.signIn('a', 'sa-stranice')).toBeNull();
      expect(auth.signIn('a', 'iz-compose')).toEqual({ cookie: expect.any(String) });
      expect(auth.changePassword('iz-compose', 'nesto-novo').result).toBe('env');
    });
  });
});
