import { createRequire } from 'node:module';
import { botClient } from './clients.js';

const require = createRequire(import.meta.url);

const CUSTOM_TTL_MS = 60 * 60_000;
const IMAGE_HOSTS = new Set(['emoji.slack-edge.com']);
export const EMOJI_PATTERN = /:([a-z0-9_+'-]{1,100}):/g;

const standard = new Map();
for (const e of require('emoji-datasource/emoji.json')) {
  const char = e.unified.split('-').map((hex) => String.fromCodePoint(parseInt(hex, 16))).join('');
  for (const name of e.short_names) standard.set(name, char);
}

let custom = new Map();
let customAt = 0;
let loading = null;

function loadCustom() {
  if (!botClient || Date.now() - customAt < CUSTOM_TTL_MS) return Promise.resolve(custom);
  loading ??= botClient.emoji.list()
    .then((res) => {
      custom = new Map(Object.entries(res.emoji ?? {}));
      console.log(`Loaded ${custom.size} custom emoji.`);
      return custom;
    })
    .catch((err) => {
      console.warn('Custom emoji unavailable:', err?.data?.error || err?.message || err);
      return custom;
    })
    .finally(() => {
      customAt = Date.now();
      loading = null;
    });
  return loading;
}

function resolveOne(name, depth = 0) {
  if (standard.has(name)) return { char: standard.get(name) };
  const value = custom.get(name);
  if (!value || depth > 3) return null;
  if (value.startsWith('alias:')) return resolveOne(value.slice(6), depth + 1);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname) ? { url: url.href } : null;
  } catch {
    return null;
  }
}

export async function resolveEmoji(names) {
  const wanted = [...new Set(names)];
  if (wanted.some((n) => !standard.has(n))) await loadCustom();
  const out = {};
  for (const name of wanted) {
    const hit = resolveOne(name);
    if (hit) out[name] = hit;
  }
  return out;
}
