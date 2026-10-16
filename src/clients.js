import { WebClient } from '@slack/web-api';

const userToken = process.env.SLACK_USER_TOKEN;
const botToken = process.env.SLACK_BOT_TOKEN;

if (!userToken) {
  console.error('Missing SLACK_USER_TOKEN in environment (.env). Copy .env.example to .env and fill it in.');
  process.exit(1);
}

export const userClient = new WebClient(userToken);

export const botClient = botToken ? new WebClient(botToken) : null;

const AVATAR_HOSTS = new Set(['avatars.slack-edge.com', 'ca.slack-edge.com', 'secure.gravatar.com']);

function safeAvatar(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && AVATAR_HOSTS.has(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

const profileCache = new Map();
export async function resolveUserProfile(userId, client = userClient) {
  if (!userId) return null;
  if (profileCache.has(userId)) return profileCache.get(userId);
  try {
    const { user } = await client.users.info({ user: userId });
    const profile = {
      id: userId,
      name: user?.real_name || user?.name || userId,
      displayName: user?.profile?.display_name || user?.real_name || user?.name || userId,
      avatar: safeAvatar(user?.profile?.image_72 || user?.profile?.image_48),
    };
    profileCache.set(userId, profile);
    return profile;
  } catch {
    return null;
  }
}

export async function resolveUserName(userId, client = userClient) {
  if (!userId) return null;
  return (await resolveUserProfile(userId, client))?.name ?? userId;
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
