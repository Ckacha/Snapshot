const $ = (id) => document.getElementById(id);

const state = { csrf: null, users: {}, emoji: {}, items: [], selected: new Set(), query: '' };

const EMOJI_PATTERN = /:([a-z0-9_+'-]{1,100}):/g;
const EMPHASIS = /(^|[^\w*_~])([*_~])(?!\s)([^\n]*?\S)\2(?![\w*_~])/;
const EMPHASIS_TAGS = { '*': 'strong', _: 'em', '~': 's' };

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function withEmoji(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(EMOJI_PATTERN)) {
    const hit = state.emoji[m[1]];
    if (!hit) continue;
    parts.push(text.slice(last, m.index));
    if (hit.char) {
      parts.push(hit.char);
    } else {
      const img = el('img', { className: 'emoji', src: hit.url, alt: m[0], title: m[0], loading: 'lazy' });
      img.addEventListener('error', () => img.replaceWith(m[0]), { once: true });
      parts.push(img);
    }

    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function withEmphasis(text) {
  const m = EMPHASIS.exec(text);
  if (!m) return withEmoji(text);
  const start = m.index + m[1].length;
  return [
    ...withEmoji(text.slice(0, start)),
    el(EMPHASIS_TAGS[m[2]], {}, ...withEmphasis(m[3])),
    ...withEmphasis(text.slice(start + m[3].length + 2)),
  ];
}

const mention = (text) => el('span', { className: 'mention', textContent: text });

function entity(inner) {
  let m;
  if ((m = /^@([UW][A-Z0-9]+)(?:\|(.*))?$/.exec(inner))) return mention(`@${state.users[m[1]] || m[2] || 'someone'}`);
  if ((m = /^#([CG][A-Z0-9]+)(?:\|(.*))?$/.exec(inner))) return mention(`#${m[2] || 'channel'}`);
  if ((m = /^!subteam\^[A-Z0-9]+(?:\|(.*))?$/.exec(inner))) return mention(m[1] || '@group');
  if ((m = /^!(here|channel|everyone)\b/.exec(inner))) return mention(`@${m[1]}`);
  if ((m = /^!date\^[^|]*\|(.*)$/.exec(inner))) return decode(m[1]);
  const bar = inner.indexOf('|');
  const url = decode(bar === -1 ? inner : inner.slice(0, bar));
  const label = bar === -1 ? url.replace(/^mailto:/i, '') : decode(inner.slice(bar + 1));
  if (/^(https?:|mailto:)/i.test(url)) return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: label });
  return label;
}

function inline(text) {
  const out = [];
  text.split(/(`[^`\n]+`)/).forEach((part, i) => {
    if (i % 2) {
      out.push(el('code', { textContent: decode(part.slice(1, -1)) }));
      return;
    }
    part.split(/<([^<>\n]+)>/).forEach((piece, j) => {
      out.push(...(j % 2 ? [entity(piece)] : withEmphasis(decode(piece))));
    });
  });
  return out;
}

function mrkdwn(text) {
  const out = [];
  const chunks = text.split(/```([\s\S]*?)```/);
  chunks.forEach((chunk, i) => {
    if (i % 2) {
      out.push(el('pre', { textContent: decode(chunk.replace(/^\n|\n$/g, '')) }));
      return;
    }
    if (i > 0) chunk = chunk.replace(/^\n/, '');
    if (i < chunks.length - 1) chunk = chunk.replace(/\n$/, '');
    if (!chunk) return;
    let quote = null;
    const lines = chunk.split('\n');
    lines.forEach((line, n) => {
      const q = /^(?:&gt;|>) ?(.*)$/.exec(line);
      if (q) {
        if (!quote) out.push((quote = el('blockquote')));
        else quote.append('\n');
        quote.append(...inline(q[1]));
        return;
      }
      quote = null;
      out.push(...inline(line));
      if (n < lines.length - 1 && !/^(?:&gt;|>)/.test(lines[n + 1])) out.push('\n');
    });
  });
  return out;
}

function formatText(text) {
  if (!text) return '';
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, name) => `@${state.users[id] || name || 'someone'}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<#[A-Z0-9]+>/g, '#channel')
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name) => name || '@group')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

function postedLabel(ms) {
  const d = new Date(ms);
  const day = d.getFullYear() === new Date().getFullYear() ? shortDateFmt.format(d) : dateFmt.format(d);
  return `${day} at ${timeFmt.format(d)}`;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function visibleItems() {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.items;
  return state.items.filter((it) =>
    [it.display, it.channel, it.author?.displayName, it.author?.name, ...it.files].some((s) => s && s.toLowerCase().includes(q)));
}

function avatar(author) {
  const initial = el('div', { className: 'face initial', textContent: (author?.displayName || '?').trim().charAt(0).toUpperCase() || '?' });
  if (!author?.avatar) return initial;
  const img = el('img', { className: 'face', src: author.avatar, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(initial), { once: true });
  return img;
}

function renderItem(it) {
  const box = el('input', { type: 'checkbox', checked: state.selected.has(it.key) });
  box.setAttribute('aria-label', 'Select message');
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(it.key);
    else state.selected.delete(it.key);
    updateToolbar();
  });

  const head = el('p', { className: 'head' },
    el('strong', { className: 'name', textContent: it.author ? it.author.displayName || 'Unknown user' : 'App or bot', title: it.author?.name || '' }),
    el('span', { className: 'chan', textContent: it.inThread ? `${it.channel} · thread` : it.channel }));

  const dates = el('p', { className: 'dates' });
  if (it.postedAt) {
    const time = el('time', { textContent: `Sent ${postedLabel(it.postedAt)}`, title: fullFmt.format(new Date(it.postedAt)) });
    time.dateTime = new Date(it.postedAt).toISOString();
    dates.append(time);
  }
  if (it.savedAt) {
    const saved = el('time', { textContent: `Saved ${postedLabel(Date.parse(it.savedAt))}`, title: fullFmt.format(new Date(it.savedAt)) });
    saved.dateTime = it.savedAt;
    dates.append(saved);
  }

  const text = it.text
    ? el('div', { className: 'text collapsed' }, ...mrkdwn(it.text))
    : el('div', { className: 'text muted', textContent: '(no text)' });

  const media = it.media ?? [];
  const fileUrl = (m, download) => `/api/me/file?key=${encodeURIComponent(it.key)}&i=${m.i}${download ? '&download=1' : ''}`;
  const images = media.filter((m) => m.image);
  const gallery = images.length
    ? el('div', { className: 'gallery' }, ...images.map((m) => {
     const img = el('img', { src: fileUrl(m), alt: m.name, title: m.name, loading: 'lazy' });
      img.addEventListener('error', () => img.closest('a')?.remove(), { once: true });
      return el('a', { href: fileUrl(m), target: '_blank', rel: 'noopener' }, img);
    }))
    : null;
     
  const savedNames = new Set(media.map((m) => m.name));
  const files = it.files.length || media.length
    ? el('div', { className: 'files' },
      ...media.map((m) => el('a', { className: 'file saved', href: fileUrl(m, true), download: m.name, textContent: `↓ ${m.name}`, title: `Download ${m.name}` })),
      ...it.files.filter((name) => !savedNames.has(name)).map((name) => el('span', { className: 'file', textContent: name, title: `${name} (no copy saved)` })))
    : null;

  const foot = el('p', { className: 'foot' });
  if (it.link) foot.append(el('a', { href: it.link, target: '_blank', rel: 'noopener', textContent: 'Open in Slack ↗' }));
  const stop = el('button', { type: 'button', className: 'stop', textContent: 'Stop watching' });
  stop.addEventListener('click', () => unwatchOne(it.key, stop));
  foot.append(stop);

  return el('li', { className: 'item' },
    el('label', { className: 'pick' }, box),
    avatar(it.author),
    el('div', { className: 'body' }, head, dates, text, gallery, files, foot));
}

function addShowMore() {
  for (const text of document.querySelectorAll('.text.collapsed')) {
    if (text.scrollHeight <= text.clientHeight + 2 || text.nextElementSibling?.classList.contains('more')) continue;
    const more = el('button', { type: 'button', className: 'more', textContent: 'Show more' });
    more.addEventListener('click', () => {
      const open = text.classList.toggle('collapsed');
      more.textContent = open ? 'Show more' : 'Show less';
    });
    text.after(more);
  }
}

function render() {
  const items = visibleItems();
  $('list').replaceChildren(...items.map(renderItem));
  requestAnimationFrame(addShowMore);
  $('empty').hidden = state.items.length > 0;
  const n = state.items.length;
  $('summary').textContent = `${n} message${n === 1 ? '' : 's'} watched${state.userName ? ` · signed in as ${state.userName}` : ''}`;
  updateToolbar();
}

function updateToolbar() {
  const visible = visibleItems();
  const n = state.selected.size;
  $('remove').disabled = n === 0;
  $('remove').textContent = n ? `Stop watching ${n}` : 'Stop watching';
  $('select-all').checked = visible.length > 0 && visible.every((it) => state.selected.has(it.key));
}

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Snapshot-CSRF': state.csrf ?? '' },
      body: JSON.stringify(body),
    });
    
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) showSignedOut();
  return { ok: res.ok, status: res.status, data };
}

function showSignedOut() {
  $('signed-in').hidden = true;
  $('signout').hidden = true;
  $('signed-out').hidden = false;
  $('summary').textContent = 'Not signed in';
}

async function load() {
  const { ok, data } = await api('/api/me');
  if (!ok) {
    if (!$('signed-out').hidden) return;
    $('summary').textContent = "Couldn't load your list. Refresh to try again.";
    return;
  }
  state.csrf = data.csrf;
  state.users = data.users ?? {};
  state.emoji = data.emoji ?? {};
  state.userName = data.userName;
  state.items = (data.items ?? []).map((it) => ({ ...it, display: formatText(it.text) }));
  for (const key of state.selected) if (!state.items.some((it) => it.key === key)) state.selected.delete(key);
  $('signed-out').hidden = true;
  $('signed-in').hidden = false;
  $('signout').hidden = false;
  render();
}

$('search').addEventListener('input', (e) => {
  state.query = e.target.value;
  render();
});

$('select-all').addEventListener('change', (e) => {
  for (const it of visibleItems()) {
    if (e.target.checked) state.selected.add(it.key);
    else state.selected.delete(it.key);
  }
  render();
});

$('remove').addEventListener('click', async () => {
  const keys = [...state.selected];
  if (!keys.length || !confirm(`Stop watching ${keys.length} message${keys.length === 1 ? '' : 's'}? Snapshot won't DM you if they're deleted.`)) return;
  $('remove').disabled = true;
  const { ok } = await api('/api/me/unwatch', { keys });
  if (ok) {
    state.items = state.items.filter((it) => !state.selected.has(it.key));
    state.selected.clear();
    render();
  } else {
    updateToolbar();
    alert("Couldn't update your list. Refresh and try again.");
  }
});

async function unwatchOne(key, button) {
  button.disabled = true;
  button.textContent = 'Stopping…';
  const { ok } = await api('/api/me/unwatch', { keys: [key] });
  if (ok) {
    state.items = state.items.filter((it) => it.key !== key);
    state.selected.delete(key);
    render();
  } else {
    button.disabled = false;
    button.textContent = 'Stop watching';
    alert("Couldn't update your list. Refresh and try again.");
  }
}

$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('add-msg');
  const button = e.target.querySelector('button');
  button.disabled = true;
  msg.className = 'fine';
  msg.textContent = 'Checking…';
  const { ok, data } = await api('/api/me/watch', { link: $('link').value });
  button.disabled = false;
  if (ok) {
    msg.className = 'fine ok';
    msg.textContent = data.already ? 'You were already watching that one.' : 'Watching it now.';
    $('link').value = '';
    await load();
  } else {
    msg.className = 'fine bad';
    msg.textContent = data.error ?? "Couldn't add that message.";
  }
});

$('signout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  state.csrf = null;
  state.items = [];
  showSignedOut();
});

load();
