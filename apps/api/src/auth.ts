import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export type Role = 'org_admin' | 'asset_manager' | 'assessor' | 'client_viewer' | 'contractor';

export interface TokenClaims {
  sub: string;
  org: string;
  role: Role;
  /** Client restriction; empty means all clients in the organisation. */
  clients: string[];
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signToken(claims: Omit<TokenClaims, 'exp'>, secret: string, ttlSeconds = 8 * 3600): string {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${h}.${b}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString()) as TokenClaims;
    return claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  } catch {
    return null;
  }
}

const scryptAsync = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scryptAsync(pw, salt)).toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'));
  return got.length === expected.length && timingSafeEqual(got, expected);
}
