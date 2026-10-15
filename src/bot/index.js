import 'dotenv/config';
import { SocketModeClient } from '@slack/socket-mode';
import { userClient, botClient } from '../clients.js';
import { registerOwner, installedCount } from '../tokens.js';
import { loadWatchlist, saveWatchlist, migrateWatchlist } from './watchlist.js';
import { createHandlers } from './handlers.js';
import { reconcile } from './reconcile.js';
import { webConfig, startWebServer } from '../web/server.js';

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

const dmChannelIds = new Map();
async function getDmChannelId(userId) {
  if (dmChannelIds.has(userId)) return dmChannelIds.get(userId);
  const res = await botClient.conversations.open({ users: userId });
  dmChannelIds.set(userId, res.channel.id);
  return res.channel.id;
}

async function main() {
  const owner = await userClient.auth.test();
  registerOwner(owner.user_id, userClient);

  const watchlist = new Map(Object.entries(loadWatchlist()));
  const migrated = migrateWatchlist(watchlist, owner.user_id);
  if (migrated) {
    saveWatchlist(Object.fromEntries(watchlist));
    console.log(`Assigned ${migrated} existing watch(es) to the owner (${owner.user_id}).`);
  }
  console.log(`Watching ${watchlist.size} message(s) for deletion, for ${installedCount()} connected user(s).`);

  const web = webConfig();
  const installUrl = web.missing ? null : `${web.baseUrl}/`;

  const { onInteractive, onStarAdded, onStarRemoved, onMessage, onTokensRevoked, handleDeletion, backfill } =
    createHandlers({ watchlist, getDmChannelId, installUrl });

  if (web.missing) {
    console.warn(`Install page disabled (missing ${web.missing.join(', ')}); only the owner can use the bot.`);
  } else {
    startWebServer({
      config: web,
      teamId: owner.team_id,
      onInstalled: async (userId) => {
        await botClient.chat.postMessage({
          channel: await getDmChannelId(userId),
          text: ":wave: You're connected. Right-click any message → More actions → *Watch for deletion*, and I'll DM you its text if it's ever deleted. Messages you \"Save for later\" are watched too.",
        });
        if (userId !== owner.user_id) {
          await botClient.chat.postMessage({
            channel: await getDmChannelId(owner.user_id),
            text: `:bust_in_silhouette: <@${userId}> connected their Slack account to Snapshot.`,
          });
        }
      },
    });
  }

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
  socket.on('star_added', async ({ event, body, ack }) => {
    markAlive();
    await ack();
    await onStarAdded({ event, body }).catch((err) => console.error('onStarAdded error:', err));
  });
  socket.on('star_removed', async ({ event, body, ack }) => {
    markAlive();
    await ack();
    await onStarRemoved({ event, body }).catch((err) => console.error('onStarRemoved error:', err));
  });
  socket.on('tokens_revoked', async ({ event, ack }) => {
    markAlive();
    await ack();
    await onTokensRevoked({ event }).catch((err) => console.error('onTokensRevoked error:', err));
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

  const catchUp = (force = false) => reconcile({ watchlist, handleDeletion, backfill, force });
  socket.on('connected', () => { if (wasDown) { wasDown = false; catchUp(true); } });
  socket.on('reconnecting', () => { wasDown = true; });
  setInterval(() => catchUp(true), 15 * 60_000);
  catchUp();
}

main().catch((err) => {
  console.error('Bot failed to start:', err);
  process.exit(1);
});
