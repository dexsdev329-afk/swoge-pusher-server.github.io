/*
 * SWOGE Spin — "Volcano" slot math (server-authoritative, provably fair).
 *
 * The client only ANIMATES what this module returns, so wins can't be faked.
 * All randomness comes from a deterministic PRNG seeded by the per-spin HMAC
 * hash (crypto.createHmac(serverSeed, clientSeed:nonce)), so every outcome is
 * reproducible + verifiable once the server seed is revealed.
 *
 * Values here are the "base" units. The credited payout in $SWOGE is
 * totalInternal × bet (see game.volcanoSpin). RTP ≈ 70% (3M-spin simulation).
 *
 * ── Design update ────────────────────────────────────────────────────────
 *  • CONTINUITY: when 3+ volcanoes trigger the Hold&Win, the coin (SWOGE)
 *    positions from the triggering spin CARRY into the bonus as locked coins;
 *    the volcanoes are removed and the reels keep filling the empty cells.
 *  • FULLER BOARDS: P_COIN is higher so bonuses often reach 8–9 cells (a full
 *    9/9 = grand jackpot feel, still rare). To keep RTP at ~70% the frequent
 *    VALUE coins are scaled by VALUE_SCALE (big jackpots keep their headline
 *    amounts). Tuned by simulation — DO re-simulate before changing anything.
 */
const crypto = require('crypto');

const SYM_W        = { SWOGE:40, DIAMOND:7, GOLD:8, OG:12, VOLCANO:3.5 };
const LINE_PAY     = { GOLD:8, DIAMOND:12 };
const LINES        = [ [0,1,2],[3,4,5],[6,7,8],[0,4,8],[2,4,6] ];
const JP           = { MINI:10, MINOR:50, MAJOR:500, GRAND:1000, OG:5000 };
const COIN_VALUES_W= { 2:38, 4:30, 6:17, 10:9, 16:4, 20:2 };
const COIN_TYPE_W  = { VALUE:100, MINI:0.5, MINOR:0.1, MAJOR:0.012, GRAND:0.004, MYSTERY:0.25, MULT:3.2, COLLECT:0.4, MOON:0.6, OGJP:0.0004 };
const MULT_W       = { 2:78, 3:20, 5:2 };
// Fuller boards + smaller frequent coins keep RTP ~70% (see _tune simulation).
const P_COIN = 0.14, RESPINS = 3, START_CAP = 3;
/*
 * L'echelle des pieces frequentes — et le seul reglage du retour.
 *
 * Il etait a 0,47, soit un retour de 70,5 % : en dessous de tout ce qui se
 * pratique, quand les machines physiques les plus dures tournent autour de
 * 85 %. Il passe a 0,74, soit environ 90,5 % (mesure sur trois millions de
 * tours, compteur reporte).
 *
 * ---- POURQUOI PAS PLUS ----
 *
 * Ce reglage n'est PAS un curseur, c'est une marche d'escalier, parce que la
 * valeur d'une piece est ARRONDIE apres mise a l'echelle. La piece de valeur 2
 * est la plus frequente du jeu (38 % des pieces) :
 *
 *     echelle 0,74 → round(1,48) = 1
 *     echelle 0,75 → round(1,50) = 2      ← elle DOUBLE
 *
 * Mesure de part et d'autre de cette limite, trois millions de tours chacune :
 *
 *     0,72 → 89,5 %      0,74 →  90,8 %
 *     0,73 → 90,4 %      0,75 → 103,6 %   ← le jeu paie plus qu'il ne prend
 *
 * Il n'existe donc rien entre 90,8 % et 103,6 % qui soit atteignable par ce
 * bouton. Viser 93 % en montant l'echelle donne un robinet ouvert sur le
 * coffre, et personne ne s'en apercoit avant qu'il soit vide. Pour aller
 * au-dela il faut changer les VALEURS des pieces, pas leur echelle.
 */
const VALUE_SCALE = 0.74;
const COLLECT_CAP = 300;    // SWOGE symbols to fill the volcano → eruption bonus

/* Deterministic PRNG from a hex hash; re-hashes to extend the stream if needed. */
function rngFrom(hashHex) {
  let pool = hashHex, idx = 0;
  return function next() {
    if (idx + 8 > pool.length) pool += crypto.createHash('sha256').update(pool).digest('hex');
    const v = parseInt(pool.slice(idx, idx + 8), 16); idx += 8;
    return v / 0x100000000; // [0,1)
  };
}
function pick(w, rng) { let t = 0; for (const k in w) t += w[k]; let r = rng() * t; for (const k in w) { r -= w[k]; if (r <= 0) return k; } return Object.keys(w)[0]; }

function newCoin(rng) {
  const t = pick(COIN_TYPE_W, rng);
  if (t === 'VALUE') return { type:'VALUE', value: Math.max(1, Math.round(+pick(COIN_VALUES_W, rng) * VALUE_SCALE)) };
  if (t === 'MINI')  return { type:'JP', jp:'MINI',  value:JP.MINI };
  if (t === 'MINOR') return { type:'JP', jp:'MINOR', value:JP.MINOR };
  if (t === 'MAJOR') return { type:'JP', jp:'MAJOR', value:JP.MAJOR };
  if (t === 'GRAND') return { type:'JP', jp:'GRAND', value:JP.GRAND };
  if (t === 'OGJP')  return { type:'JP', jp:'OG',    value:JP.OG };
  if (t === 'MYSTERY') { const j = pick({MINI:60,MINOR:28,MAJOR:10,GRAND:2}, rng); return { type:'JP', jp:j, value:JP[j], mystery:true }; }
  if (t === 'MULT')  return { type:'MULT', mult:+pick(MULT_W, rng) };
  if (t === 'COLLECT') return { type:'COLLECT' };
  if (t === 'MOON')  return { type:'MOON' };
  return { type:'VALUE', value: Math.max(1, Math.round(10 * VALUE_SCALE)) };
}

function bonusTotalOf(cells) {
  let valueSum = 0, jpSum = 0, multTotal = 1, collectors = 0;
  for (const c of cells) { if (!c) continue;
    if (c.type === 'VALUE') valueSum += c.value; else if (c.type === 'JP') jpSum += c.value;
    else if (c.type === 'MULT') multTotal *= c.mult; else if (c.type === 'COLLECT') collectors++; }
  let total = valueSum; if (collectors > 0) total += valueSum * collectors; total *= multTotal; total += jpSum;
  return Math.round(total);
}

/**
 * Core Hold&Win. `initCoins` is a 9-array of coin|null already locked on the
 * board (carried from the triggering spin, or the initial START_CAP coins).
 * Returns { cells, steps, total, filled }. The FIRST step lists the locked
 * coins so the client shows them in place, then the reels fill empty cells.
 */
function runBonusFrom(initCoins, rng) {
  const cells = initCoins.slice();
  let filled = cells.filter(Boolean).length;
  const steps = [];
  const init = []; cells.forEach((c, i) => { if (c) init.push({ idx: i, coin: c }); });
  steps.push({ placed: init, respins: RESPINS, reset: true, carried: true });
  let respins = RESPINS;
  while (respins > 0 && filled < 9) {
    const placed = [];
    for (let i = 0; i < 9; i++) { if (cells[i]) continue; if (rng() < P_COIN) { cells[i] = newCoin(rng); placed.push({ idx:i, coin:cells[i] }); filled++; if (filled >= 9) break; } }
    const reset = placed.length > 0; if (reset) respins = RESPINS; else respins--;
    steps.push({ placed, respins, reset });
  }
  const moons = cells.filter(c => c && c.type === 'MOON').length; const mp = [];
  for (let m = 0; m < moons; m++) { const add = 1 + Math.floor(rng() * 3); for (let a = 0; a < add; a++) { const idx = cells.indexOf(null); if (idx < 0) break; cells[idx] = newCoin(rng); mp.push({ idx, coin: cells[idx] }); filled++; } }
  if (mp.length) steps.push({ placed: mp, respins: 0, reset: false, moon: true });
  return { cells, steps, total: bonusTotalOf(cells), filled };
}

/** Bonus with `startCount` fresh coins (used by Buy Bonus + eruption). */
function runBonus(startCount, rng) {
  startCount = Math.min(startCount, START_CAP);
  const init = new Array(9).fill(null);
  for (let i = 0; i < startCount; i++) init[i] = newCoin(rng);
  return runBonusFrom(init, rng);
}

/* One full spin: grid + line wins + (3-volcano bonus) + collect-meter update + eruption bonus. */
function spinAll(rng, meter) {
  const grid = new Array(9); for (let i = 0; i < 9; i++) grid[i] = pick(SYM_W, rng);
  const lineWins = []; let baseWin = 0;
  for (const L of LINES) { const a = grid[L[0]]; if (a === grid[L[1]] && a === grid[L[2]] && LINE_PAY[a]) { lineWins.push({ line:L, sym:a, amount:LINE_PAY[a] }); baseWin += LINE_PAY[a]; } }
  const volc = grid.filter(s => s === 'VOLCANO').length;
  let bonus = null;
  if (volc >= 3) {
    // CONTINUITY: the coin (SWOGE) positions of the triggering spin carry into
    // the Hold&Win as locked coins; the volcanoes are dropped (empty → fill).
    const initCoins = new Array(9).fill(null);
    for (let i = 0; i < 9; i++) if (grid[i] === 'SWOGE') initCoins[i] = newCoin(rng);
    bonus = runBonusFrom(initCoins, rng);
  }
  const sw = grid.filter(s => s === 'SWOGE').length;
  let newMeter = (meter || 0) + sw, erupt = null;
  if (newMeter >= COLLECT_CAP) { newMeter -= COLLECT_CAP; erupt = runBonus(START_CAP, rng); }
  const totalInternal = baseWin + (bonus ? bonus.total : 0) + (erupt ? erupt.total : 0);
  return { grid, lineWins, baseWin, bonus, erupt, meter: newMeter, totalInternal };
}

module.exports = { rngFrom, runBonus, runBonusFrom, spinAll, COLLECT_CAP, SYM_W, JP };
