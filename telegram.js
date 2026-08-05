'use strict';
/*
 * Fire-and-forget Telegram notifications (deposits / big wins / stakes).
 * Uses Node 18's global fetch. Sends are serialized with a small gap so we
 * never trip Telegram's rate limit, and every failure is swallowed — a bad
 * token or network blip must never crash or slow the game.
 */
const cfg = require('./config');

let chain = Promise.resolve();
const enabled = () => !!(cfg.TG_BOT_TOKEN && cfg.TG_CHAT_ID);

function notify(text) {
  if (!enabled()) return;
  chain = chain.then(async () => {
    try {
      await fetch(`https://api.telegram.org/bot${cfg.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
    } catch (e) { console.warn('[tg] send failed:', e.message); }
    await new Promise((r) => setTimeout(r, 400)); // stay under the rate limit
  }).catch(() => {});
}

module.exports = { notify, enabled };
