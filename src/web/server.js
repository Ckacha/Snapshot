import http from 'node:http';
import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { saveUserToken, canStoreTokens } from '../tokens.js';
import { serveStatic, serveNotFound, SECURITY_HEADERS } from './static.js';

export const USER_SCOPES = [
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'users:read', 'stars:read',
];

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 500;

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

export function startWebServer({ config, teamId, onInstalled }) {
  const pending = new Map();
  const oauthClient = new WebClient();

  function newState() {
    const now = Date.now();
    for (const [s, at] of pending) if (now - at > STATE_TTL_MS) pending.delete(s);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    const state = crypto.randomBytes(16).toString('hex');
    pending.set(state, now);
    return state;
  }

  function takeState(state, cookieState) {
    const at = state && pending.get(state);
    pending.delete(state);
    return Boolean(at) && Date.now() - at <= STATE_TTL_MS && cookieState === state;
  }

  function redirect(res, location, headers = {}) {
    res.writeHead(302, { Location: location, ...SECURITY_HEADERS, ...headers });
    res.end();
  }

  function sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end(text);
  }

  async function handleCallback(url, req, res) {
    const cookieState = /(?:^|;\s*)snapshot_state=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
    const clearCookie = { 'Set-Cookie': 'snapshot_state=; Path=/slack; Max-Age=0; HttpOnly; Secure; SameSite=Lax' };
    if (url.searchParams.get('error')) {
      return redirect(res, '/error?reason=cancelled', clearCookie);
    }
    if (!takeState(url.searchParams.get('state'), cookieState)) {
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

    saveUserToken(userId, token, teamId);
    console.log(`User ${userId} connected their account.`);
    await onInstalled(userId).catch((err) => console.error('Welcome DM failed:', err?.data?.error || err));
    redirect(res, '/connected', clearCookie);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', config.baseUrl);
    try {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      if (url.pathname === '/healthz') return sendText(res, 200, 'ok');
      if (serveStatic(url.pathname, res)) return;
      if (url.pathname === '/slack/install') {
        const state = newState();
        const authorize = new URL('https://slack.com/oauth/v2/authorize');
        authorize.searchParams.set('client_id', config.clientId);
        authorize.searchParams.set('user_scope', USER_SCOPES.join(','));
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
      console.error('Web request failed:', err);
      if (!res.headersSent) redirect(res, '/error');
    }
  });

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Install page listening on 127.0.0.1:${config.port} (public: ${config.baseUrl})`);
  });
  return server;
}
