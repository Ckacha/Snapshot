const style = `
  :root { --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --card: #fff; --line: #e7e5e4; --accent: #4a154b; --accent-fg: #fff; --ok: #15803d; --bad: #b91c1c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --card: #292524; --line: #44403c; --accent: #e9d5ff; --accent-fg: #2e1065; --ok: #4ade80; --bad: #f87171; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 3rem 1rem; }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; }
  .lede { color: var(--muted); margin: 0 0 2rem; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem 1.25rem .5rem; margin-bottom: 1.5rem; }
  .card h2 { font-size: 1rem; margin: 0 0 .5rem; }
  ol, ul { padding-left: 1.25rem; margin: 0 0 1rem; }
  li { margin-bottom: .35rem; }
  .button { display: inline-block; background: var(--accent); color: var(--accent-fg); text-decoration: none; font-weight: 600; padding: .75rem 1.25rem; border-radius: 8px; }
  .fine { color: var(--muted); font-size: .875rem; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${style}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function landingPage() {
  return page('Snapshot', `
<h1>Snapshot</h1>
<p class="lede">Get a DM with the text of a Slack message if someone deletes it.</p>
<div class="card">
  <h2>How it works</h2>
  <ol>
    <li>Connect your Slack account below.</li>
    <li>On any message: right-click → More actions → <strong>Watch for deletion</strong>. "Save for later" also adds it.</li>
    <li>If that message is deleted, Snapshot DMs you what it said.</li>
  </ol>
</div>
<div class="card">
  <h2>What connecting allows</h2>
  <ul>
    <li>Reading messages in channels and DMs <em>you</em> can already see, to check whether watched ones still exist.</li>
    <li>Seeing what you save for later, so saved messages get watched automatically.</li>
  </ul>
  <p class="fine">Your token is stored encrypted on the bot's server. To disconnect, remove Snapshot from your Slack apps; your watchlist is deleted with it.</p>
</div>
<p><a class="button" href="/slack/install">Connect with Slack</a></p>
`);
}

export function resultPage({ ok, message }) {
  return ok
    ? page('Connected · Snapshot', `
<h1 class="ok">You're connected</h1>
<p class="lede">Check your Slack DMs for a message from Snapshot.</p>
<p>Next: right-click any message → More actions → <strong>Watch for deletion</strong>.</p>
<p class="fine">You can close this tab.</p>
`)

    : page('Snapshot', `
<h1 class="bad">That didn't work</h1>
<p class="lede">${message}</p>
<p><a class="button" href="/">Back to start</a></p>
`);

}
