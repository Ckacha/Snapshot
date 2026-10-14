import 'dotenv/config';
import { SocketModeClient } from '@slack/socket-mode';
import { userClient, botClient } from '../clients.js';
import { loadWatchlist } from './watchlist.js';
import { createHandlers } from './handlers.js';
import { reconcile } from './reconcile.js';

const appToken = process.env.SLACK_APP_TOKEN;
if (!appToken) {
  console.error('Missing SLACK_APP_TOKEN in environment (.env). Needed for Socket Mode.');
  process.exit(1);
}
if (!botClient) {
  console.error('Missing SLACK_BOT_TOKEN in environment (.env). Needed to send you DMs.');
  process.exit(1);
}

const MAX_DOWNTIME_MS = 90_000;
const WATCHDOG_INTERVAL_MS = 15_000;

let connected = false;
let wasDown = false;
let lastAliveAt = Date.now();
const markAlive = () => { lastAliveAt = Date.now(); };

function bail(reason) {
  console.error(`[watchdog] ${reason} — exiting for pm2 to restart.`);
  process.exit(1);
}

process.on('unhandledRejection', (err) => bail(`unhandledRejection: ${err?.stack || err}`));
process.on('uncaughtException', (err) => bail(`uncaughtException: ${err?.stack || err}`));

let cachedDmChannelId;
async function getDmChannelId() {
  if (cachedDmChannelId) return cachedDmChannelId;
  const auth = await userClient.auth.test();
  const res = await botClient.conversations.open({ users: auth.user_id });
  cachedDmChannelId = res.channel.id;
  return cachedDmChannelId;
}

async function main() {
  const watchlist = new Map(Object.entries(loadWatchlist()));
  console.log(`Watching ${watchlist.size} message(s) for deletion.`);

  const { onInteractive, onStarAdded, onStarRemoved, onMessage, handleDeletion } = createHandlers({ watchlist, getDmChannelId });

  const socket = new SocketModeClient({ appToken });

  socket.on('connected', () => { connected = true; markAlive(); console.log('Socket Mode connected.'); });
  socket.on('authenticated', markAlive);
  socket.on('slack_event', markAlive);
  socket.on('reconnecting', () => { connected = false; console.warn('Socket Mode reconnecting...'); });
  socket.on('disconnected', () => { connected = false; console.warn('Socket Mode disconnected.'); });
  socket.on('error', (err) => console.error('Socket Mode error:', err?.stack || err));

  socket.on('interactive', async ({ body, ack }) => {
    markAlive();
    await ack();
    await onInteractive({ body }).catch((err) => console.error('onInteractive error:', err));
  });
  socket.on('star_added', async ({ event, ack }) => {
    markAlive();
    await ack();
    await onStarAdded({ event }).catch((err) => console.error('onStarAdded error:', err));
  });
  socket.on('star_removed', async ({ event, ack }) => {
    markAlive();
    await ack();
    await onStarRemoved({ event }).catch((err) => console.error('onStarRemoved error:', err));
  });
  socket.on('message', async ({ event, ack }) => {
    markAlive();
    await ack();
    await onMessage({ event }).catch((err) => console.error('onMessage error:', err));
  });

  setInterval(async () => {
    if (connected || Date.now() - lastAliveAt <= MAX_DOWNTIME_MS) return;
    let net = 'unknown';
    try {
      await Promise.race([
        botClient.auth.test(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8_000)),
      ]);
      net = 'slack API reachable';
    } catch {
      net = 'slack API unreachable';
    }
    bail(`no Socket Mode connection for ${Math.round((Date.now() - lastAliveAt) / 1000)}s (${net})`);
  }, WATCHDOG_INTERVAL_MS);

  await socket.start();
  connected = true;
  markAlive();
  console.log('Connected via Socket Mode.');
  console.log('Right-click a message -> More actions -> "Watch for deletion" to start tracking it.');

  const catchUp = (force = false) => reconcile({ watchlist, handleDeletion, force });
  socket.on('connected', () => { if (wasDown) { wasDown = false; catchUp(true); } });
  socket.on('reconnecting', () => { wasDown = true; });
  setInterval(() => catchUp(true), 15 * 60_000);
  catchUp();
}

main().catch((err) => {
  console.error('Bot failed to start:', err);
  process.exit(1);
});
