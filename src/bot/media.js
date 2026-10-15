import fs from 'node:fs';
import path from 'node:path';

const MEDIA_DIR = path.resolve('data', 'media');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const RETRY_MS = 24 * 60 * 60_000;

const dirFor = (key) => path.join(MEDIA_DIR, key.replace(/[^\w.-]/g, '_'));
const safeName = (name) => String(name || 'file').replace(/[^\w.-]/g, '_').slice(-120) || 'file';

export function describeFiles(files) {
  return (files ?? [])
    .filter((f) => f && f.mode !== 'tombstone' && f.mode !== 'hidden_by_limit')
    .slice(0, MAX_FILES)
    .map((f) => ({
      name: f.name || f.title || 'file',
      size: f.size ?? null,
      url: f.url_private_download || f.url_private || null,
    }));
}

export function needsCapture(entry) {
  if (!entry.files?.length) return false;
  if (entry.media?.length) return false;
  return !entry.media_tried_at || Date.now() - Date.parse(entry.media_tried_at) > RETRY_MS;
}

export async function captureMedia(key, entry, client) {
  const token = client?.token;
  entry.media_tried_at = new Date().toISOString();
  if (!token) return;
  const dir = dirFor(key);
  const saved = [];
  for (const f of entry.files) {
    if (!f.url || (f.size && f.size > MAX_FILE_BYTES)) continue;
    try {
      const res = await fetch(f.url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok || (res.headers.get('content-type') ?? '').startsWith('text/html')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FILE_BYTES) continue;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${saved.length}-${safeName(f.name)}`);
      fs.writeFileSync(file, buf, { mode: 0o600 });
      saved.push({ name: f.name, path: file });
    } catch {
    }
  }
  if (saved.length) entry.media = saved;
}

export function storedMedia(entry) {
  return (entry.media ?? []).filter((m) => fs.existsSync(m.path));
}

export function removeMedia(key) {
  fs.rmSync(dirFor(key), { recursive: true, force: true });
}