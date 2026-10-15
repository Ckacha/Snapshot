import fs from 'node:fs';
import path from 'node:path';
import { userClient } from '../clients.js';
import { getClient } from '../tokens.js';
import { watcherIds } from './watchlist.js';

const STATE_PATH = path.resolve('data', 'last_reconcile.txt');
const PACE_MS = 1200; 
const MIN_GAP_MS = 5 * 60_000; 
const GONE_ERRORS = new Set(['message_not_found', 'thread_not_found']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookup({ channel, ts, thread_ts }, client) {
  try {
    const res = thread_ts && thread_ts !== ts
      ? await client.conversations.replies({ channel, ts: thread_ts, oldest: ts, latest: ts, inclusive: true, limit: 1 })
      : await client.conversations.history({ channel, oldest: ts, latest: ts, inclusive: true, limit: 1 });
    const msg = res.messages?.find((m) => m.ts === ts);
    return !msg || msg.subtype === 'tombstone' ? { state: 'gone' } : { state: 'present', message: msg };
  } catch (err) {
    return { state: GONE_ERRORS.has(err?.data?.error) ? 'gone' : 'unknown' };
  }
}

export async function checkExists(saved, client = userClient) {
  return (await lookup(saved, client)).state;
}

function recentlyRan() {
  try {
    return Date.now() - Number(fs.readFileSync(STATE_PATH, 'utf8')) < MIN_GAP_MS;
  } catch {
    return false;
  }
}

let running = false;

export async function reconcile({ watchlist, handleDeletion, backfill, force = false }) {
  if (running || (!force && recentlyRan())) return;
  running = true;
  try {
    fs.writeFileSync(STATE_PATH, String(Date.now()));
    const entries = [...watchlist.values()];
    const gone = [];
    let unknown = 0;
    for (const saved of entries) {
      const client = watcherIds(saved).map(getClient).find(Boolean);
      const { state, message } = client ? await lookup(saved, client) : { state: 'unknown' };
      if (state === 'gone') gone.push(saved);
      else if (state === 'unknown') unknown++;
      else if (backfill) await backfill(saved, message, client).catch((err) => console.error('Media backfill failed:', err));
      await sleep(PACE_MS);
    }
    console.log(`Catch-up check: ${entries.length} watched, ${gone.length} gone, ${unknown} unverifiable.`);

    if (entries.length >= 10 && gone.length > entries.length / 2) {
      console.error('Catch-up check: over half the watchlist looks deleted; assuming a lookup problem and reporting nothing.');
      return;
    }
    for (const saved of gone) {
      await handleDeletion({ channel: saved.channel, ts: saved.ts, previous: null, missed: true })
        .catch((err) => console.error('Catch-up report failed:', err));
    }
  } catch (err) {
    console.error('Catch-up check error:', err);
  } finally {
    running = false;
  }
}
