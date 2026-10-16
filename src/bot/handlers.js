import { botClient, resolveUserName, resolveUserProfile, resolveChannelName, channelMention } from '../clients.js';
import { getClient, removeUser } from '../tokens.js';
import { watchlistKey, saveWatchlist, appendDeletedLog, watcherIds } from './watchlist.js';
import { findContextMessage } from './context.js';
import { checkExists, lookupMessage } from './reconcile.js';
import { describeFiles, needsCapture, captureMedia, storedMedia, removeMedia } from './media.js';
import { resolveEmoji, EMOJI_PATTERN } from '../emoji.js';

export const WATCH_CALLBACK_ID = 'watch_message';
const NAME_LOOKUP_BUDGET_MS = 5000;

function fallbackChannelName(channelId) {
  if (channelId.startsWith('D')) return 'DM';
  if (channelId.startsWith('G')) return 'private channel';
  return channelId;
}

const GREETINGS = [
  (m) => `hey ${m}`,
  (m) => `yo ${m}`,
  (m) => m,
  (m) => `${m} ${m} ${m}`,
];

export function greeting(userId) {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)](`<@${userId}>`);
}

export function createHandlers({ watchlist, getDmChannelId, installUrl, slackUrl }) {
  function persist() {
    saveWatchlist(Object.fromEntries(watchlist));
  }

  function addWatch(userId, { channel, ts, thread_ts, text, user, files }) {
    const key = watchlistKey(channel, ts);
    const now = new Date().toISOString();
    const entry = watchlist.get(key) ?? { channel, ts, thread_ts, text, user, saved_at: now, watchers: {} };
    if (!entry.files?.length) entry.files = describeFiles(files);
    entry.watchers[userId] = now;
    watchlist.set(key, entry);
    return key;
  }

  async function captureFor(key, client) {
    const entry = watchlist.get(key);
    if (!entry || !client || !needsCapture(entry)) return;
    await captureMedia(key, entry, client);
    if (watchlist.has(key)) persist();
    else removeMedia(key);
  }

  async function backfill(saved, message, client) {
    if (!saved.user && message.user) {
      saved.user = message.user;
      persist();
    }
    if (!saved.files?.length) {
      const files = describeFiles(message.files);
      if (!saved.files || files.length) {
        saved.files = files;
        persist();
      }
    }
    await captureFor(watchlistKey(saved.channel, saved.ts), client);
  }

  function removeWatch(userId, key) {
    const entry = watchlist.get(key);
    if (!entry) return;
    delete entry.watchers[userId];
    if (watcherIds(entry).length === 0) {
      watchlist.delete(key);
      removeMedia(key);
    }
  }

  const notConnectedText = installUrl
    ? `Connect your Slack account first so I can check on messages for you: ${installUrl}`
    : "This bot isn't set up for you yet. Ask whoever runs it to add you.";

  async function onInteractive({ body }) {
    if (body.type !== 'message_action' || body.callback_id !== WATCH_CALLBACK_ID) return;

    const userId = body.user?.id;
    const msg = body.message ?? {};
    const channel = body.channel?.id;
    const key = watchlistKey(channel, msg.ts);

    let confirmationText;
    if (!getClient(userId)) {
      confirmationText = notConnectedText;
    } else if (watchlist.get(key)?.watchers[userId]) {
      removeWatch(userId, key);
      persist();
      confirmationText = 'Stopped watching this message.';
    } else {
      addWatch(userId, { ...msg, channel });
      persist();
      confirmationText = `Watching this message — I'll DM you if it gets deleted.${installUrl ? ` See everything you're watching: ${installUrl}me` : ''}`;
    }

    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: confirmationText, response_type: 'ephemeral' }),
      }).catch((err) => console.error('Failed to post response_url confirmation:', err));
    }
    await captureFor(key, getClient(userId));
  }

  const starUser = (event, body) => event.user ?? body?.authorizations?.[0]?.user_id;

  async function onStarAdded({ event, body }) {
    const item = event.item;
    const userId = starUser(event, body);
    const client = getClient(userId);
    if (item?.type !== 'message' || !item.message || !client) return;
    const key = addWatch(userId, { ...item.message, channel: item.channel });
    persist();
    await captureFor(key, client);
  }

  async function onStarRemoved({ event, body }) {
    const item = event.item;
    const userId = starUser(event, body);
    if (item?.type !== 'message' || !item.message) return;
    const saved = { channel: item.channel, ts: item.message.ts, thread_ts: item.message.thread_ts };
    const client = getClient(userId);
    const state = client ? await checkExists(saved, client).catch(() => 'unknown') : 'unknown';
    if (state === 'gone') {
      await handleDeletion({ channel: saved.channel, ts: saved.ts, previous: item.message, missed: true });
      return;
    }
    removeWatch(userId, watchlistKey(item.channel, item.message.ts));
    persist();
  }

  async function onMessage({ event }) {
    if (event.subtype !== 'message_deleted') return;
    await handleDeletion({ channel: event.channel, ts: event.deleted_ts, previous: event.previous_message });
  }

  async function onTokensRevoked({ event }) {
    const userIds = event.tokens?.oauth ?? [];
    if (userIds.length === 0) return;
    for (const userId of userIds) {
      removeUser(userId);
      for (const [key, entry] of watchlist) if (entry.watchers?.[userId]) removeWatch(userId, key);
    }
    persist();
    console.log(`Tokens revoked for ${userIds.length} user(s); removed their watches.`);
  }

  async function handleDeletion({ channel, ts, previous, missed = false }) {
    const key = watchlistKey(channel, ts);
    const saved = watchlist.get(key);
    if (!saved) return;
    watchlist.delete(key);
    persist();

    const watchers = watcherIds(saved);
    const client = watchers.map(getClient).find(Boolean) ?? undefined;
    const prev = previous ?? {};
    const authorId = prev.user ?? saved.user;
    const text = prev.text || saved.text || '';
    const threadTs = prev.thread_ts ?? saved.thread_ts;
    const media = storedMedia(saved);
    const fileNames = (saved.files?.length ? saved.files : describeFiles(prev.files)).map((f) => f.name);

    const [authorName, channelName, channelLink, context] = await Promise.all([
      resolveUserName(authorId, client),
      resolveChannelName(channel, client),
      channelMention(channel, client),
      findContextMessage({ channel, ts, thread_ts: threadTs, client }),
    ]);

    const quoted = text
      ? text.split('\n').map((line) => `> ${line}`).join('\n')
      : '> _(no text)_';

    let contextLine = 'No other messages found nearby to link to.';
    if (context) {
      const label = context.direction === 'before' ? 'Message before it' : 'Message after it (nothing before it)';
      const by = context.userId ? ` by <@${context.userId}>` : '';
      contextLine = context.permalink
        ? `<${context.permalink}|${label}>${by}`
        : `${label}${by} (couldn't get a link)`;
    }

    let filesLine = null;
    if (media.length) {
      filesLine = `${media.length === 1 ? 'Its attachment is' : `Its ${media.length} attachments are`} below.`;
    } else if (fileNames.length) {
      filesLine = `It had ${fileNames.length === 1 ? 'an attachment' : `${fileNames.length} attachments`} I couldn't save a copy of: ${fileNames.join(', ')}`;
    }

    const bodyText = [
      `*Originally said by:* ${authorId ? `<@${authorId}>` : prev.username || 'unknown (a bot or app)'}${missed ? ' _(caught on a catch-up check, so it may have been deleted a while ago)_' : ''}`,
      quoted,
      filesLine,
      contextLine,
    ].filter(Boolean).join('\n');

    appendDeletedLog({
      channel,
      channel_name: channelName,
      ts,
      text,
      files: fileNames,
      author_id: authorId,
      author_name: authorName,
      context,
      missed,
      watchers,
    });

    if (!botClient) {
      console.warn('SLACK_BOT_TOKEN not set — skipping DM, but logged to data/deleted_log.json:', bodyText);
      removeMedia(key);
      return;
    }

    let allSent = true;
    for (const userId of watchers) {
      const dmText = `${greeting(userId)}, a message you saved in ${channelLink} got deleted\n${bodyText}`;
      try {
        const dm = await getDmChannelId(userId);
        await botClient.chat.postMessage({ channel: dm, text: dmText });
        if (media.length && !(await sendMedia(dm, media))) allSent = false;
      } catch (err) {
        allSent = false;
        console.error(`Failed to DM ${userId} about a deletion:`, err?.data?.error || err);
      }
    }
    if (allSent) removeMedia(key);
    else if (media.length) console.warn(`Kept saved attachments for ${key} in data/media/ since not every DM got them.`);
  }

  async function sendMedia(dm, media) {
    try {
      await botClient.files.uploadV2({
        channel_id: dm,
        file_uploads: media.map((m) => ({ file: m.path, filename: m.name })),
      });
      return true;
    } catch (err) {
      console.error('Failed to attach saved files:', err?.data?.error || err);
      await botClient.chat.postMessage({
        channel: dm,
        text: `I saved its attachments but couldn't send them here: ${media.map((m) => m.name).join(', ')}`,
      }).catch(() => {});
      return false;
    }
  }

  function messageLink({ channel, ts, thread_ts }) {
    if (!slackUrl) return null;
    const link = `${slackUrl}archives/${channel}/p${ts.replace('.', '')}`;
    return thread_ts && thread_ts !== ts ? `${link}?thread_ts=${thread_ts}&cid=${channel}` : link;
  }

  async function listFor(userId) {
    const client = getClient(userId);
    const mine = [...watchlist.entries()].filter(([, e]) => e.watchers?.[userId]);
    const userIds = new Set([userId]);
    const channelIds = new Set();

    for (const [, e] of mine) { 
      if (e.user) userIds.add(e.user);
      channelIds.add(e.channel);
      for (const [, id] of (e.text ?? '').matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) userIds.add(id);
    }

    const deadline = new Promise((r) => setTimeout(r, NAME_LOOKUP_BUDGET_MS));
    const lookup = (ids, resolve) => Promise.all([...ids].map(async (id) =>
      [id, await Promise.race([resolve(id, client), deadline.then(() => null)])])).then(Object.fromEntries);
    const emojiNames = mine.flatMap(([, e]) => [...(e.text ?? '').matchAll(EMOJI_PATTERN)].map((m) => m[1]));
    const [profiles, channels, emoji] = await Promise.all([
      lookup(userIds, resolveUserProfile),
      lookup(channelIds, resolveChannelName),
      Promise.race([resolveEmoji(emojiNames), deadline.then(() => ({}))]),
    ]);
    const items = mine.map(([key, e]) => ({
      key,
      channel: channels[e.channel] && channels[e.channel] !== e.channel ? channels[e.channel] : fallbackChannelName(e.channel),
      author: e.user ? profiles[e.user] ?? { id: e.user, displayName: null, avatar: null } : null,
      postedAt: Math.round(Number(e.ts) * 1000) || null,
      inThread: Boolean(e.thread_ts && e.thread_ts !== e.ts),
      text: e.text ?? '',
      files: (e.files ?? []).map((f) => f.name),
      savedFiles: storedMedia(e).length,
      savedAt: e.watchers[userId],
      link: messageLink(e),
    })).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));

    const users = Object.fromEntries(Object.entries(profiles).filter(([, p]) => p).map(([id, p]) => [id, p.displayName]));
    return { userName: users[userId], users, emoji, items };
  }

  function unwatch(userId, keys) {
    let removed = 0;
    for (const key of new Set(keys)) {
      if (!watchlist.get(key)?.watchers?.[userId]) continue;
      removeWatch(userId, key);
      removed++;
    }

    if (removed) persist();
    return removed;
  }

  async function watchLink(userId, link) {
    const m = /\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(link);
    if (!m) return { error: "That doesn't look like a Slack message link. In Slack: hover the message → ⋮ → Copy link." };
    const channel = m[1];
    const ts = `${m[2]}.${m[3]}`;
    let thread_ts;
    
    try {
      thread_ts = new URL(link).searchParams.get('thread_ts') ?? undefined;
    } catch {
    }

    const client = getClient(userId);
    const { state, message } = await lookupMessage({ channel, ts, thread_ts }, client);
    
    if (state !== 'present') return { error: "Couldn't find that message. Make sure you can see it in Slack." };
    
    const key = watchlistKey(channel, ts);
    const already = Boolean(watchlist.get(key)?.watchers?.[userId]);
    
    if (!already) {
      addWatch(userId, { ...message, channel, thread_ts: message.thread_ts ?? thread_ts });
      persist();
      captureFor(key, client).catch((err) => console.error('Media capture failed:', err));
    }
    return { ok: true, already };
  }

  return { onInteractive, onStarAdded, onStarRemoved, onMessage, onTokensRevoked, handleDeletion, backfill, listFor, unwatch, watchLink };
}
