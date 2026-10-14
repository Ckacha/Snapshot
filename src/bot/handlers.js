import { botClient, resolveUserName, resolveChannelName, channelMention } from '../clients.js';
import { getClient, removeUser } from '../tokens.js';
import { watchlistKey, saveWatchlist, appendDeletedLog, watcherIds } from './watchlist.js';
import { findContextMessage } from './context.js';
import { checkExists } from './reconcile.js';

export const WATCH_CALLBACK_ID = 'watch_message';

export function createHandlers({ watchlist, getDmChannelId, installUrl }) {
  function persist() {
    saveWatchlist(Object.fromEntries(watchlist));
  }

  function addWatch(userId, { channel, ts, thread_ts, text, user }) {
    const key = watchlistKey(channel, ts);
    const now = new Date().toISOString();
    const entry = watchlist.get(key) ?? { channel, ts, thread_ts, text, user, saved_at: now, watchers: {} };
    entry.watchers[userId] = now;
    watchlist.set(key, entry);
  }

  function removeWatch(userId, key) {
    const entry = watchlist.get(key);
    if (!entry) return;
    delete entry.watchers[userId];
    if (watcherIds(entry).length === 0) watchlist.delete(key);
  }

  const notConnectedText = installUrl
    ? `:wave: Connect your Slack account first so I can check on messages for you: ${installUrl}`
    : ":wave: This bot isn't set up for you yet. Ask whoever runs it to add you.";

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
      confirmationText = ':white_check_mark: Stopped watching this message.';
    } else {
      addWatch(userId, { ...msg, channel });
      persist();
      confirmationText = ":floppy_disk: Watching this message — I'll DM you if it gets deleted.";
    }

    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: confirmationText, response_type: 'ephemeral' }),
      }).catch((err) => console.error('Failed to post response_url confirmation:', err));
    }
  }

  const starUser = (event, body) => event.user ?? body?.authorizations?.[0]?.user_id;

  async function onStarAdded({ event, body }) {
    const item = event.item;
    const userId = starUser(event, body);
    if (item?.type !== 'message' || !item.message || !getClient(userId)) return;
    addWatch(userId, { ...item.message, channel: item.channel });
    persist();
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
    const text = prev.text || saved.text || '(no text — may have been a file or attachment-only message)';
    const threadTs = prev.thread_ts ?? saved.thread_ts;

    const [authorName, channelName, channelLink, context] = await Promise.all([
      resolveUserName(authorId, client),
      resolveChannelName(channel, client),
      channelMention(channel, client),
      findContextMessage({ channel, ts, thread_ts: threadTs, client }),
    ]);

    let contextLine = 'Context: no earlier message found.';
    if (context) {
      const contextAuthorMention = context.userId ? `<@${context.userId}>` : 'someone';
      contextLine = context.permalink
        ? `Context (By ${contextAuthorMention}) ${context.permalink}`
        : `Context (By ${contextAuthorMention}) (couldn't get a link)`;
    }

    const dmText = [
      `*A watched message was deleted* in ${channelLink}`,
      `*From:* <@${authorId}>`,
      `> ${text}`,
      '',
      contextLine,
    ].join('\n');

    appendDeletedLog({
      channel,
      channel_name: channelName,
      ts,
      text,
      author_id: authorId,
      author_name: authorName,
      context,
      missed,
      watchers,
    });

    if (!botClient) {
      console.warn('SLACK_BOT_TOKEN not set — skipping DM, but logged to data/deleted_log.json:', dmText);
      return;
    }

    for (const userId of watchers) {
      try {
        await botClient.chat.postMessage({ channel: await getDmChannelId(userId), text: dmText });
      } catch (err) {
        console.error(`Failed to DM ${userId} about a deletion:`, err?.data?.error || err);
      }
    }
  }

  return { onInteractive, onStarAdded, onStarRemoved, onMessage, onTokensRevoked, handleDeletion };
}
