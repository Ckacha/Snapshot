import http from 'node:http';
import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { saveUserToken, canStoreTokens, getClient } from '../tokens.js';
import { serveStatic, serveNotFound, SECURITY_HEADERS } from './static.js';
import { sessionCookie, clearSessionCookie, readSession } from './session.js';

export const USER_SCOPES = [
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'users:read', 'stars:read',
];
const OPTIONAL_USER_SCOPES = ['files:read'];

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_UNWATCH = 1000;
const NEXT_PAGES = { me: '/me' };

export function webConfig() {
  const { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, PUBLIC_BASE_URL, PORT } = process.env;
  const missing = Object.entries({ SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, PUBLIC_BASE_URL })
    .filter(([, v]) => !v).map(([k]) => k);
  if (!canStoreTokens) missing.push('TOKEN_ENCRYPTION_KEY');
  if (missing.length) return { missing };
  const baseUrl = PUBLIC_BASE_URL.replace(/\/+$/, '');
  return {
    clientId: SLACK_CLIENT_ID,
    clientSecret: SLACK_CLIENT_SECRET,
    baseUrl,
    redirectUri: `${baseUrl}/slack/oauth/callback`,
    port: Number(PORT) || 3940,
  };
}

export function startWebServer({ config, teamId, onInstalled, api }) {
  const pending = new Map();
  const oauthClient = new WebClient();
  const origin = new URL(config.baseUrl).origin;

  function newState(next) {
    const now = Date.now();
    for (const [s, p] of pending) if (now - p.at > STATE_TTL_MS) pending.delete(s);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    const state = crypto.randomBytes(16).toString('hex');
    pending.set(state, { at: now, next });
    return state;
  }

  function takeState(state, cookieState) {
    const p = state && pending.get(state);
    pending.delete(state);
    return p && Date.now() - p.at <= STATE_TTL_MS && cookieState === state ? p : null;
  }

  function redirect(res, location, headers = {}) {
    res.writeHead(302, { Location: location, ...SECURITY_HEADERS, ...headers });
    res.end();
  }

  function sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end(text);
  }

  function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      throw Object.assign(new Error('bad json'), { status: 400 });
    }
  }

  async function handleCallback(url, req, res) {
    const cookieState = /(?:^|;\s*)snapshot_state=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
    const clearCookie = { 'Set-Cookie': 'snapshot_state=; Path=/slack; Max-Age=0; HttpOnly; Secure; SameSite=Lax' };
    if (url.searchParams.get('error')) {
      return redirect(res, '/error?reason=cancelled', clearCookie);
    }
    const state = takeState(url.searchParams.get('state'), cookieState);
    if (!state) {
      return redirect(res, '/error?reason=expired', clearCookie);
    }

    let result;
    try {
      result = await oauthClient.oauth.v2.access({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: url.searchParams.get('code') ?? '',
        redirect_uri: config.redirectUri,
      });
    } catch (err) {
      console.error('OAuth exchange failed:', err?.data?.error || err);
      return redirect(res, '/error?reason=exchange', clearCookie);
    }

    const userId = result.authed_user?.id;
    const token = result.authed_user?.access_token;
    const granted = new Set((result.authed_user?.scope ?? '').split(','));
    if (!userId || !token || result.team?.id !== teamId) {
      return redirect(res, '/error?reason=workspace', clearCookie);
    }
    const missingScopes = USER_SCOPES.filter((s) => !granted.has(s));
    if (missingScopes.length) {
      console.warn(`User ${userId} didn't grant: ${missingScopes.join(', ')}`);
      return redirect(res, '/error?reason=scopes', clearCookie);
    }

    const isNew = !getClient(userId);
    saveUserToken(userId, token, teamId);
    console.log(`User ${userId} ${isNew ? 'connected their account' : 'signed in'}.`);
    await onInstalled(userId, { isNew }).catch((err) => console.error('Welcome DM failed:', err?.data?.error || err));
    redirect(res, state.next ?? '/connected', { 'Set-Cookie': [clearCookie['Set-Cookie'], sessionCookie(userId)] });
  }

  async function handleApi(url, req, res) {
    const session = readSession(req);
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie });
    }
    if (!session || !getClient(session.userId)) {
      return sendJson(res, 401, { error: 'signed_out' }, session ? { 'Set-Cookie': clearSessionCookie } : {});
    }
    const { userId } = session;

    if (req.method === 'GET' && url.pathname === '/api/me') {
      return sendJson(res, 200, { csrf: session.csrf, ...(await api.listFor(userId)) });
    }

    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
    const reqOrigin = req.headers.origin;
    if ((reqOrigin && reqOrigin !== origin)
      || req.headers['x-snapshot-csrf'] !== session.csrf
      || !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    const body = await readJson(req);

    if (url.pathname === '/api/me/unwatch') {
      const keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string').slice(0, MAX_UNWATCH) : [];
      return sendJson(res, 200, { removed: api.unwatch(userId, keys) });
    }
    if (url.pathname === '/api/me/watch') {
      const result = await api.watchLink(userId, typeof body.link === 'string' ? body.link.slice(0, 500) : '');
      return sendJson(res, result.error ? 400 : 200, result);
    }
    return sendJson(res, 404, { error: 'not_found' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', config.baseUrl);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(url, req, res);
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      if (url.pathname === '/healthz') return sendText(res, 200, 'ok');
      if (serveStatic(url.pathname, res)) return;
      if (url.pathname === '/slack/install') {
        const state = newState(NEXT_PAGES[url.searchParams.get('next')]);
        const authorize = new URL('https://slack.com/oauth/v2/authorize');
        authorize.searchParams.set('client_id', config.clientId);
        authorize.searchParams.set('user_scope', [...USER_SCOPES, ...OPTIONAL_USER_SCOPES].join(','));
        authorize.searchParams.set('redirect_uri', config.redirectUri);
        authorize.searchParams.set('state', state);
        authorize.searchParams.set('team', teamId);
        res.writeHead(302, {
          Location: authorize.toString(),
          'Set-Cookie': `snapshot_state=${state}; Path=/slack; Max-Age=${STATE_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
        });
        return res.end();
      }
      if (url.pathname === '/slack/oauth/callback') return await handleCallback(url, req, res);
      serveNotFound(res);
    } catch (err) {
      if (err?.status) return sendJson(res, err.status, { error: err.message });
      console.error('Web request failed:', err);
      if (res.headersSent) return;
      if (url.pathname.startsWith('/api/')) sendJson(res, 500, { error: 'server' });
      else redirect(res, '/error');
    }
  });

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Install page listening on 127.0.0.1:${config.port} (public: ${config.baseUrl})`);
  });
  return server;
}
