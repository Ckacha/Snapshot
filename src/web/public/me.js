const $ = (id) => document.getElementById(id);

const state = { csrf: null, users: {}, items: [], selected: new Set(), query: '' };

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
    [it.display, it.channel, it.author, ...it.files].some((s) => s && s.toLowerCase().includes(q)));
}

function renderItem(it) {
  const box = el('input', { type: 'checkbox', checked: state.selected.has(it.key) });
  box.setAttribute('aria-label', 'Select message');
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(it.key);
    else state.selected.delete(it.key);
    updateToolbar();
  });

  const meta = [it.channel, it.author, it.savedAt && `saved ${dateFmt.format(new Date(it.savedAt))}`].filter(Boolean).join(' · ');
  const text = it.display
    ? el('p', { className: 'text', textContent: it.display })
    : el('p', { className: 'text muted', textContent: '(no text)' });

  const extras = el('div', { className: 'extras' });
  if (it.files.length) {
    const label = `${it.files.length} attachment${it.files.length === 1 ? '' : 's'}`;
    extras.append(el('span', {
      textContent: it.savedFiles ? `${label}, copy saved` : label,
      title: it.files.join(', '),
    }));
  }

  if (it.link) extras.append(el('a', { href: it.link, target: '_blank', rel: 'noopener', textContent: 'Open in Slack ↗' }));

  return el('li', { className: 'item' },
    el('label', { className: 'pick' }, box),
    el('div', { className: 'body' }, el('p', { className: 'meta', textContent: meta }), text, extras));
}

function render() {
  const items = visibleItems();
  $('list').replaceChildren(...items.map(renderItem));
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
