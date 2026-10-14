# Snapshot
thing in case somone yoinks a slack message

Watch a Slack message (right-click → More actions → **Watch for deletion**, or just "Save for later"),
and if it gets deleted the bot DMs you what it said. Anyone in the workspace can connect their own
account at the install page and gets their own watchlist and DMs.

## Run it

```bash
npm install
cp .env.example .env   # fill in tokens
npm run bot
```

Only the three `SLACK_*_TOKEN` values are required. Without the shared-mode values it runs just for
the owner of `SLACK_USER_TOKEN`.

## Shared mode (other people can connect)

1. Slack app → **OAuth & Permissions** → Redirect URLs: add `https://<your host>/slack/oauth/callback`.
2. Slack app → **Event Subscriptions** → bot events: add `tokens_revoked` (so people who remove the app get cleaned up).
3. Copy the Client ID and Client Secret from **Basic Information** into `.env`, set `PUBLIC_BASE_URL`,
   and generate `TOKEN_ENCRYPTION_KEY` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. Point a reverse proxy at `127.0.0.1:$PORT` (default 3940), e.g. Caddy:
   ```
   snapshot.ckacha.dev {
       reverse_proxy localhost:3940
   }
   ```

Keep the app **not** publicly distributed. Slack heavily rate-limits message history reads for
distributed apps that aren't on the Marketplace, which would break the catch-up check.

User tokens are stored AES-256-GCM encrypted in `data/tokens.json`. The owner's token stays in `.env`.

## Deploy (hakos)

```bash
cd ~/snapshot && git checkout -- package-lock.json && git pull && npm ci && pm2 restart snapshot
```

## CLI

- `npm run list` — what's being watched, and by whom
- `npm run removed` — deleted messages that were caught
- `npm run search -- <term>`
