import { userClient } from '../clients.js';

export async function findContextMessage({ channel, ts, thread_ts, client = userClient }) {
  if (thread_ts && thread_ts !== ts) {
    try {
      const res = await client.conversations.replies({ channel, ts: thread_ts, limit: 1 });
      const parent = res.messages?.[0];
      if (parent) {
        const permalink = await safePermalink(client, channel, parent.ts);
        return { text: parent.text, userId: parent.user, permalink, relation: 'thread it was replying in' };
      }
    } catch {
    }
    return null;
  }

  try {
    const res = await client.conversations.history({ channel, latest: ts, limit: 1, inclusive: false });
    const prev = res.messages?.[0];
    if (prev) {
      const permalink = await safePermalink(client, channel, prev.ts);
      return { text: prev.text, userId: prev.user, permalink, relation: 'message right before it' };
    }
  } catch {
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
