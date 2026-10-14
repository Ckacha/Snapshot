import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';

const TOKENS_PATH = path.resolve('data', 'tokens.json');
const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
const key = keyHex && /^[0-9a-f]{64}$/i.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;

export const canStoreTokens = Boolean(key);

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

const stored = new Map();
const clients = new Map();

function load() {
  if (!fs.existsSync(TOKENS_PATH)) return;
  if (!key) {
    console.error('data/tokens.json exists but TOKEN_ENCRYPTION_KEY is missing or invalid; installed users are disabled.');
    return;
  }
  for (const [userId, rec] of Object.entries(JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')))) {
    try {
      stored.set(userId, { ...rec, token: decrypt(rec.token) });
    } catch {
      console.error(`Could not decrypt token for ${userId} (wrong TOKEN_ENCRYPTION_KEY?); skipping.`);
    }
  }
}

function save() {
  const out = {};
  for (const [userId, rec] of stored) out[userId] = { ...rec, token: encrypt(rec.token) };
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(TOKENS_PATH, 0o600);
}

load();

export function registerOwner(userId, client) {
  clients.set(userId, client);
}

export function saveUserToken(userId, token, teamId) {
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  stored.set(userId, { token, team_id: teamId, installed_at: new Date().toISOString() });
  clients.delete(userId);
  save();
}

export function removeUser(userId) {
  clients.delete(userId);
  if (stored.delete(userId)) save();
}

export function getClient(userId) {
  if (!userId) return null;
  if (clients.has(userId)) return clients.get(userId);
  const rec = stored.get(userId);
  if (!rec) return null;
  const client = new WebClient(rec.token);
  clients.set(userId, client);
  return client;
}

export function installedCount() {
  return new Set([...clients.keys(), ...stored.keys()]).size;
}
