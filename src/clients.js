import { WebClient } from '@slack/web-api';

const userToken = process.env.SLACK_USER_TOKEN;
const botToken = process.env.SLACK_BOT_TOKEN;

if (!userToken) {
  console.error('Missing SLACK_USER_TOKEN in environment (.env). Copy .env.example to .env and fill it in.');
  process.exit(1);
}

export const userClient = new WebClient(userToken);

export const botClient = botToken ? new WebClient(botToken) : null;

const userCache = new Map();
export async function resolveUserName(userId, client = userClient) {
  if (!userId) return null;
  if (userCache.has(userId)) return userCache.get(userId);
  try {
    const res = await client.users.info({ user: userId });
    const name = res.user?.real_name || res.user?.name || userId;
    userCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

const channelInfoCache = new Map();
async function getChannelInfo(channelId, client) {
  if (channelInfoCache.has(channelId)) return channelInfoCache.get(channelId);
  try {
    const res = await client.conversations.info({ channel: channelId });
    if (res.channel) channelInfoCache.set(channelId, res.channel);
    return res.channel ?? null;
  } catch {
    return null;
  }
}

export async function resolveChannelName(channelId, client = userClient) {
  if (!channelId) return null;
  const c = await getChannelInfo(channelId, client);
  if (!c) return channelId;
  return c.is_im ? 'DM' : c.is_mpim ? 'group-DM' : (c.name ? `#${c.name}` : channelId);
}

export async function channelMention(channelId, client = userClient) {
  if (!channelId) return null;
  const c = await getChannelInfo(channelId, client);
  if (!c) return channelId;
  if (c.is_im) return 'a DM';
  if (c.is_mpim) return 'a group DM';
  return `<#${channelId}>`;
}
