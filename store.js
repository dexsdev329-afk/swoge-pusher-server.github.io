'use strict';
/*
 * Tiny JSON persistence for the game state (balances, jackpot, dedupe set,
 * deposit watermark). Written atomically (tmp + rename) so a crash mid-write
 * can't corrupt the file.
 *
 * IMPORTANT (Railway): the container filesystem is wiped on every redeploy.
 * Mount a persistent VOLUME at cfg.DATA_DIR so this file survives restarts —
 * otherwise balances reset to zero each deploy.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.DATA_DIR, 'state.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return null; } // no file yet (first run) or unreadable
}

function save(obj) {
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, FILE); // atomic replace
    return true;
  } catch (e) { console.warn('[store] save failed:', e.message); return false; }
}

module.exports = { load, save, FILE };
