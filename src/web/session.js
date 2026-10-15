import crypto from 'node:crypto';

const COOKIE = 'snapshot_session';
const MAX_AGE_S = 7 * 86400;

const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
const key = keyHex && /^[0-9a-f]{64}$/i.test(keyHex)
  ? crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update('snapshot-session').digest()
  : null;

const sign = (value) => crypto.createHmac('sha256', key).update(value).digest('base64url');

export function sessionCookie(userId) {
  const value = `${userId}.${Math.floor(Date.now() / 1000) + MAX_AGE_S}`;
  return `${COOKIE}=${value}.${sign(value)}; Path=/; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearSessionCookie = `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export function readSession(req) {
  if (!key) return null;
  const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9._-]+)`).exec(req.headers.cookie ?? '')?.[1];
  const [userId, exp, mac] = raw?.split('.') ?? [];
  if (!userId || !exp || !mac) return null;
  const expected = Buffer.from(sign(`${userId}.${exp}`));
  const given = Buffer.from(mac);

  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (Number(exp) * 1000 < Date.now()) return null;
  
  return { userId, csrf: sign(`csrf.${raw}`) };
}
