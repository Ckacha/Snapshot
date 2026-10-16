import fs from 'node:fs';

const PUBLIC_DIR = new URL('./public/', import.meta.url);

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/connected': ['connected.html', 'text/html; charset=utf-8'],
  '/error': ['error.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/avatar.png': ['avatar.png', 'image/png'],
  '/me': ['me.html', 'text/html; charset=utf-8'],
  '/me.js': ['me.js', 'text/javascript; charset=utf-8'],
};

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' https://emoji.slack-edge.com https://avatars.slack-edge.com https://ca.slack-edge.com https://secure.gravatar.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function serveStatic(pathname, res, status = 200) {
  const file = FILES[pathname];
  if (!file) return false;
  res.writeHead(status, { 'Content-Type': file[1], 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  res.end(fs.readFileSync(new URL(file[0], PUBLIC_DIR)));
  return true;
}

export function serveNotFound(res) {
  serveStatic('/error', res, 404);
}
