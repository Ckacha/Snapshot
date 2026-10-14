import fs from 'node:fs';
import path from 'node:path';
import { loadWatchlist } from './bot/watchlist.js';

const DELETED_LOG_PATH = path.resolve('data', 'deleted_log.json');

function loadDeletedLog() {
  if (!fs.existsSync(DELETED_LOG_PATH)) return [];
  return JSON.parse(fs.readFileSync(DELETED_LOG_PATH, 'utf8'));
}

function preview(text) {
  if (!text) return '(no text)';
  return text.length > 80 ? text.slice(0, 77) + '...' : text;
}

const [, , command, ...rest] = process.argv;

switch (command) {
  case 'list': {
    const entries = Object.entries(loadWatchlist());
    if (entries.length === 0) {
      console.log('Nothing currently watched. Use the "Watch for deletion" message shortcut in Slack to add one.');
      break;
    }
    for (const [key, entry] of entries) {
      console.log(`[watching] ${entry.saved_at?.slice(0, 10)}  channel:${entry.channel}  user:${entry.user}`);
      console.log(`  ${preview(entry.text)}`);
      console.log(`  key: ${key}\n`);
    }
    console.log(`${entries.length} message(s) currently watched.`);
    break;
  }
  case 'removed': {
    const log = loadDeletedLog();
    if (log.length === 0) {
      console.log('No deletions recorded yet.');
      break;
    }
    for (const entry of log) {
      console.log(`[DELETED] ${entry.logged_at?.slice(0, 10)}  ${entry.author_name}  ${entry.channel_name}`);
      console.log(`  ${preview(entry.text)}`);
      if (entry.context?.permalink) console.log(`  context: ${entry.context.permalink}`);
      console.log('');
    }
    console.log(`${log.length} deleted-and-recovered message(s).`);
    break;
  }
  case 'search': {
    const term = rest.join(' ').toLowerCase();
    if (!term) {
      console.log('Usage: npm run search -- <term>');
      process.exit(1);
    }
    const watchMatches = Object.entries(loadWatchlist()).filter(([, e]) =>
      (e.text ?? '').toLowerCase().includes(term)
    );
    const logMatches = loadDeletedLog().filter((e) => (e.text ?? '').toLowerCase().includes(term));

    for (const [key, entry] of watchMatches) {
      console.log(`[watching] ${preview(entry.text)}`);
      console.log(`  key: ${key}\n`);
    }
    for (const entry of logMatches) {
      console.log(`[DELETED] ${preview(entry.text)}`);
      if (entry.context?.permalink) console.log(`  context: ${entry.context.permalink}`);
      console.log('');
    }
    console.log(`${watchMatches.length + logMatches.length} match(es) for "${term}".`);
    break;
  }
  default: {
    console.log('Usage: node src/cli.js <list|removed|search> [term]');
    process.exit(1);
  }
}
