import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const WATCHLIST_PATH = path.join(DATA_DIR, 'watchlist.json');
const DELETED_LOG_PATH = path.join(DATA_DIR, 'deleted_log.json');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadWatchlist() {
  if (!fs.existsSync(WATCHLIST_PATH)) return {};
  return JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
}

export function saveWatchlist(watchlist) {
  ensureDataDir();
  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(watchlist, null, 2), 'utf8');
}

export function watchlistKey(channel, ts) {
  return `${channel}-${ts}`;
}

export function appendDeletedLog(entry) {
  ensureDataDir();
  const log = fs.existsSync(DELETED_LOG_PATH) ? JSON.parse(fs.readFileSync(DELETED_LOG_PATH, 'utf8')) : [];
  log.push({ ...entry, logged_at: new Date().toISOString() });
  fs.writeFileSync(DELETED_LOG_PATH, JSON.stringify(log, null, 2), 'utf8');
}
