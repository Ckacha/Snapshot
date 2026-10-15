import { userClient } from '../clients.js';

const MAX_PAGES = 5;
const AFTER_WINDOWS_S = [3600, 7 * 86400, null];

export async function findContextMessage({ channel, ts, thread_ts, client = userClient }) {
  const inThread = thread_ts && thread_ts !== ts;
  const neighbors = inThread
    ? await threadNeighbors(client, channel, thread_ts, ts)
    : { before: await channelBefore(client, channel, ts), after: null };
  if (!inThread && !neighbors.before) neighbors.after = await channelAfter(client, channel, ts);

  const direction = neighbors.before ? 'before' : neighbors.after ? 'after' : null;
  if (!direction) return null;
  const msg = neighbors[direction];
  return {
    direction,
    text: msg.text,
    userId: msg.user ?? msg.bot_id ?? null,
    permalink: await safePermalink(client, channel, msg.ts),
  };
}

async function threadNeighbors(client, channel, thread_ts, ts) {
  const messages = [];
  let cursor;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.conversations.replies({ channel, ts: thread_ts, limit: 200, cursor });
      messages.push(...(res.messages ?? []));
      cursor = res.response_metadata?.next_cursor;
      if (!cursor) break;
    }
  } catch {
  }
  const others = messages.filter((m) => m.ts !== ts);
  return {
    before: others.filter((m) => m.ts < ts).at(-1) ?? null,
    after: others.find((m) => m.ts > ts) ?? null,
  };
}

async function channelBefore(client, channel, ts) {
  try {
    const res = await client.conversations.history({ channel, latest: ts, limit: 1, inclusive: false });
    return res.messages?.[0] ?? null;
  } catch {
    return null;
  }
}

async function channelAfter(client, channel, ts) {
  for (const windowS of AFTER_WINDOWS_S) {
    const latest = windowS ? (Number(ts) + windowS).toFixed(6) : undefined;
    let oldestSeen = null;
    let cursor;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await client.conversations.history({ channel, oldest: ts, latest, inclusive: false, limit: 200, cursor });
        oldestSeen = res.messages?.at(-1) ?? oldestSeen;
        cursor = res.response_metadata?.next_cursor;
        if (!cursor) break;
      }
    } catch {
      return null;
    }
    if (oldestSeen) return oldestSeen;
  }
  return null;
}

async function safePermalink(client, channel, ts) {
  try {
    const res = await client.chat.getPermalink({ channel, message_ts: ts });
    return res.permalink ?? null;
  } catch {
    return null;
  }
}
