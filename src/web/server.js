import http from 'node:http';
import crypto from 'node:crypto';
import { WebClient } from '@slack/web-api';
import { saveUserToken, canStoreTokens } from '../tokens.js';
import { landingPage, resultPage } from './pages.js';

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

  function send(res, status, html, headers = {}) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https://platform.slack-edge.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(html);
  }

  async function handleCallback(url, req, res) {
    const cookieState = /(?:^|;\s*)snapshot_state=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
    const clearCookie = { 'Set-Cookie': 'snapshot_state=; Path=/slack; Max-Age=0; HttpOnly; Secure; SameSite=Lax' };
    if (url.searchParams.get('error')) {
      return send(res, 400, resultPage({ ok: false, message: 'Slack sign-in was cancelled.' }), clearCookie);
    }
    if (!takeState(url.searchParams.get('state'), cookieState)) {
      return send(res, 400, resultPage({ ok: false, message: 'That sign-in link expired. Start again from the home page.' }), clearCookie);
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
      return send(res, 502, resultPage({ ok: false, message: "Slack didn't accept the sign-in. Try again." }), clearCookie);
    }

    const userId = result.authed_user?.id;
    const token = result.authed_user?.access_token;
    const granted = new Set((result.authed_user?.scope ?? '').split(','));
    if (!userId || !token || result.team?.id !== teamId) {
      return send(res, 403, resultPage({ ok: false, message: 'This bot only works in its own Slack workspace.' }), clearCookie);
    }
    const missingScopes = USER_SCOPES.filter((s) => !granted.has(s));
    if (missingScopes.length) {
      return send(res, 400, resultPage({ ok: false, message: `Some permissions weren't granted (${missingScopes.join(', ')}). Try again and approve all of them.` }), clearCookie);
    }

    saveUserToken(userId, token, teamId);
    console.log(`User ${userId} connected their account.`);
    await onInstalled(userId).catch((err) => console.error('Welcome DM failed:', err?.data?.error || err));
    send(res, 200, resultPage({ ok: true }), clearCookie);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', config.baseUrl);
    try {
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      if (url.pathname === '/') return send(res, 200, landingPage());
      if (url.pathname === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
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
      send(res, 404, resultPage({ ok: false, message: 'Page not found.' }));
    } catch (err) {
      console.error('Web request failed:', err);
      if (!res.headersSent) send(res, 500, resultPage({ ok: false, message: 'Something went wrong. Try again.' }));
    }
  });

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`Install page listening on 127.0.0.1:${config.port} (public: ${config.baseUrl})`);
  });
  return server;
}
