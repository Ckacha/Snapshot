import { botClient, resolveUserName, resolveChannelName, channelMention } from '../clients.js';
import { watchlistKey, saveWatchlist, appendDeletedLog } from './watchlist.js';
import { findContextMessage } from './context.js';
import { checkExists } from './reconcile.js';

export const WATCH_CALLBACK_ID = 'watch_message';

/**
 * @param {object} deps
 * @param {Map<string, object>} deps.watchlist 
 * @param {() => Promise<string>} deps.getDmChannelId
 */
export function createHandlers({ watchlist, getDmChannelId }) {
  function persist() {
    saveWatchlist(Object.fromEntries(watchlist));
  }

  async function onInteractive({ body }) {
    if (body.type !== 'message_action' || body.callback_id !== WATCH_CALLBACK_ID) return;

    const msg = body.message ?? {};
    const channel = body.channel?.id;
    const key = watchlistKey(channel, msg.ts);

    let confirmationText;
    if (watchlist.has(key)) {
      watchlist.delete(key);
      confirmationText = ':white_check_mark: Stopped watching this message.';
    } else {
      watchlist.set(key, {
        channel,
        ts: msg.ts,
        thread_ts: msg.thread_ts,
        text: msg.text,
        user: msg.user,
        saved_at: new Date().toISOString(),
      });
      confirmationText = ":floppy_disk: Watching this message — I'll DM you if it gets deleted.";
    }
    persist();

    if (body.response_url) {
      await fetch(body.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: confirmationText, response_type: 'ephemeral' }),
      }).catch((err) => console.error('Failed to post response_url confirmation:', err));
    }
  }

  async function onStarAdded({ event }) {
    const item = event.item;
    if (item?.type !== 'message' || !item.message) return;
    const key = watchlistKey(item.channel, item.message.ts);
    watchlist.set(key, {
      channel: item.channel,
      ts: item.message.ts,
      thread_ts: item.message.thread_ts,
      text: item.message.text,
      user: item.message.user,
      saved_at: new Date().toISOString(),
    });
    persist();
  }

  async function onStarRemoved({ event }) {
    const item = event.item;
    if (item?.type !== 'message' || !item.message) return;
    const saved = { channel: item.channel, ts: item.message.ts, thread_ts: item.message.thread_ts };
    const state = await checkExists(saved).catch(() => 'unknown');
    if (state === 'gone') {
      await handleDeletion({ channel: saved.channel, ts: saved.ts, previous: item.message, missed: true });
      return;
    }
    // present or unknown (can't tell): treat as a real unwatch, same as before.
    const key = watchlistKey(item.channel, item.message.ts);
    watchlist.delete(key);
    persist();
  }

  async function onMessage({ event }) {
    if (event.subtype !== 'message_deleted') return;
    await handleDeletion({ channel: event.channel, ts: event.deleted_ts, previous: event.previous_message });
  }

  async function handleDeletion({ channel, ts, previous, missed = false }) {
    const key = watchlistKey(channel, ts);
    const saved = watchlist.get(key);
    if (!saved) return;
    watchlist.delete(key);
    persist();

    const prev = previous ?? {};
    const authorId = prev.user ?? saved.user;
    const text = prev.text || saved.text || '(no text — may have been a file or attachment-only message)';
    const threadTs = prev.thread_ts ?? saved.thread_ts;

    const [authorName, channelName, channelLink, context] = await Promise.all([
      resolveUserName(authorId),
      resolveChannelName(channel),
      channelMention(channel),
      findContextMessage({ channel, ts, thread_ts: threadTs }),
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
    });

    if (!botClient) {
      console.warn('SLACK_BOT_TOKEN not set — skipping DM, but logged to data/deleted_log.json:', dmText);
      return;
    }

    const channelId = await getDmChannelId();
    await botClient.chat.postMessage({ channel: channelId, text: dmText });
  }

  return { onInteractive, onStarAdded, onStarRemoved, onMessage, handleDeletion };
}
