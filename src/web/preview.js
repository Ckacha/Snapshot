import http from 'node:http';
import { serveStatic, serveNotFound } from './static.js';

const port = Number(process.env.PREVIEW_PORT) || 3941;

http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (!serveStatic(pathname, res)) serveNotFound(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Preview: http://localhost:${port}/  (also /connected and /error?reason=expired). Refresh to see edits in src/web/public.`);
});
