import http from 'node:http';
import { serveStatic, serveNotFound } from './static.js';

const port = Number(process.env.PREVIEW_PORT) || 3941;

const day = 86400_000;
let signedIn = true;
let items = [
  { key: 'C1-1', channel: '#announcements', author: 'Zach', text: 'Big news: <!channel> the hackathon is moving to *Saturday*. Details in <https://example.com|this doc>.', files: [], savedFiles: 0, savedAt: new Date(Date.now() - day).toISOString(), link: 'https://slack.com' },
  { key: 'C2-2', channel: '#lounge', author: 'Alex', text: 'lol <@U2> look at this', files: ['image.png'], savedFiles: 1, savedAt: new Date(Date.now() - 3 * day).toISOString(), link: 'https://slack.com' },
  { key: 'C3-3', channel: 'DM', author: 'Sam', text: 'here is the password reset link, it expires in an hour\nsecond line\nthird line\nfourth line\nfifth line gets clamped', files: [], savedFiles: 0, savedAt: new Date(Date.now() - 20 * day).toISOString(), link: 'https://slack.com' },
  { key: 'C4-4', channel: '#ship', author: 'Ria', text: '', files: ['winter wonderland.zip'], savedFiles: 0, savedAt: new Date(Date.now() - 60 * day).toISOString(), link: 'https://slack.com' },
];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let s = '';
  for await (const c of req) s += c;
  return JSON.parse(s || '{}');
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/api/me') {
    return signedIn ? json(res, 200, { csrf: 'preview', userName: 'You', users: { U2: 'Jordan' }, items }) : json(res, 401, { error: 'signed_out' });
  }
  if (pathname === '/api/me/unwatch') {
    const { keys } = await body(req);
    items = items.filter((it) => !keys.includes(it.key));
    return json(res, 200, { removed: keys.length });
  }
  if (pathname === '/api/me/watch') {
    const { link } = await body(req);
    return /\/archives\//.test(link) ? json(res, 200, { ok: true, already: true }) : json(res, 400, { error: "That doesn't look like a Slack message link. In Slack: hover the message → ⋮ → Copy link." });
  }
  if (pathname === '/api/logout') {
    signedIn = false;
    return json(res, 200, { ok: true });
  }
  if (pathname === '/slack/install') {
    signedIn = true;
    res.writeHead(302, { Location: '/me' });
    return res.end();
  }
  if (!serveStatic(pathname, res)) serveNotFound(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Preview: http://localhost:${port}/  (also /me with sample data, /connected, /error?reason=expired). Refresh to see edits in src/web/public.`);
});
