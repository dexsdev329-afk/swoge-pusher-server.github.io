'use strict';
/* ==========================================================================
 * L'OBSERVATOIRE : SOLANA ET ETHEREUM, AVANT TOUTE COLONIE
 *
 * Demande du proprietaire, 27 septembre 2026 : trois colonies — Robinhood
 * (celle qui tourne), Solana, Ethereum. Etape 1, decidee le meme jour : OBSERVER
 * SEULEMENT, zero argent, meme pas de papier. La regle du depot : une regle de
 * decision porte la mesure qui l'a decidee. Sur ces deux chaines, on n'en a
 * aucune. Cet observatoire les produit : pour chaque nouveau jeton, ses traits
 * a la decouverte, et ce que son prix a fait TRENTE MINUTES plus tard — les
 * memes definitions que la colonie (ai_colonie : monte a +20 % ou plus,
 * effondre a -30 % ou pire), pour que les trois chaines se comparent.
 *
 * ---- LES SOURCES, VERIFIEES EN DIRECT LE 27/09 ----
 *   decouverte   GeckoTerminal /networks/{solana|eth}/new_pools (20 pools,
 *                sans cle) — UN appel par chaine et par cycle de 3 min : le
 *                quota libre (~30/min) est partage avec la colonie Robinhood.
 *   prix         DexScreener /tokens/v1/{solana|ethereum}/<30 adresses> : le
 *                MEME service au depart et a 30 min, sinon on mesurerait l'ecart
 *                entre deux sources.
 *   Solana       getAccountInfo jsonParsed : autorite de frappe, autorite de
 *                GEL (le piege n°1 de Solana : geler le compte de l'acheteur),
 *                programme SPL ou Token-2022, frais de transfert. Les plus gros
 *                porteurs (getTokenLargestAccounts) : 429 immediat sur le noeud
 *                public — lus seulement avec SOLANA_RPC_URL, « unknown » sinon.
 *   Ethereum     honeypot.is /v2/IsHoneypot?chainID=1 : simulation d'achat et
 *                de vente, taxes. « pair not found » sur un pool tout neuf :
 *                redemande au cycle suivant, « unknown » au bout de 5 essais.
 *   GoPlus : PAS utilise ici. La colonie Robinhood recoit deja des « 4029
 *   too many requests » (188 sur 629 appels le 27/09) ; ce quota lui revient.
 *
 * ---- CE QUE L'OBSERVATOIRE NE FAIT PAS ----
 * Aucun achat, aucun papier, aucune cle, aucune signature. Il lit, il attend
 * trente minutes, il relit, il compte. Tout est garde : la ligne complete de
 * chaque jeton observe dans observatoire/<chaine>/AAAA-MM-JJ.jsonl (« toutes
 * les donnees sont utiles a garder », proprietaire, 27/09), les bilans par
 * trait dans observatoire/<chaine>.json.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');

const CHAINES = {
  solana: { gt: 'solana', dex: 'solana', nom: 'Solana' },
  eth: { gt: 'eth', dex: 'ethereum', nom: 'Ethereum' },
};
const HORIZON_MIN = 30;             /* la colonie juge a 30 min */
const MONTE = 20, EFFONDRE = -30;   /* ai_colonie, memes seuils */
const ASSEZ = 30;                   /* sous 30 observations, une case ne conclut pas (BANCS_ASSEZ, le meme ordre) */
const CYCLE_MS = 3 * 60e3;
const SECU_PAR_CYCLE = 6;           /* lectures de securite par chaine et par cycle */
const LOTS_PAR_CYCLE = 3;           /* lots DexScreener (30 jetons) par chaine et par cycle */
const EN_COURS_MAX = 1500;          /* jetons suivis a la fois, par chaine */
const JAMAIS_INDEXE_MIN = 60;       /* au-dela, un jeton que DexScreener ignore sort du suivi */
const FINIS_MAX = 5000;             /* adresses deja observees, pour ne pas les recompter */
const HP_ESSAIS = 5;              /* honeypot.is ignore les pools tout neufs : 5 essais, un par cycle (15 min) */

const SOL_RPC_PUBLIC = 'https://api.mainnet-beta.solana.com';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/* ---- les cases, lisibles en anglais (texte montre) ---- */
function caseAge(m) { return m == null ? null : m < 5 ? '0-5 min' : m < 15 ? '5-15 min' : m < 60 ? '15-60 min' : '1 h+'; }
function caseLiq(x) { return !(x > 0) ? null : x < 5e3 ? 'pool <$5k' : x < 2e4 ? 'pool $5-20k' : x < 1e5 ? 'pool $20-100k' : 'pool $100k+'; }
function caseMc(x) { return !(x > 0) ? null : x < 1e4 ? 'cap <$10k' : x < 5e4 ? 'cap $10-50k' : x < 2.5e5 ? 'cap $50-250k' : 'cap $250k+'; }
function caseSociaux(n) { return n == null ? null : n === 0 ? 'no socials' : n < 3 ? '1-2 socials' : '3+ socials'; }
function caseTaxe(t) { return t == null ? 'tax unknown' : t === 0 ? 'no tax' : t <= 10 ? 'tax up to 10%' : 'tax above 10%'; }

/** Les traits d'une observation, { trait: case } — une case null n'est pas comptee. */
function traitsDe(o) {
  const t = { 'Age at first price': caseAge(o.age0), 'Pool size': caseLiq(o.liq0), 'Market cap': caseMc(o.mc0),
              'Venue': o.dexId || null, 'Quoted in': o.quote || null, 'Social links': caseSociaux(o.sociaux) };
  const s = o.secu || {};
  if (o.chaine === 'solana') {
    t['Mint authority'] = s.lu ? (s.frappe ? 'mint authority active' : 'mint renounced') : 'mint unknown';
    t['Freeze authority'] = s.lu ? (s.gel ? 'freeze authority active' : 'freeze renounced') : 'freeze unknown';
    t['Token program'] = s.lu ? (s.t22 ? 'Token-2022' : 'SPL Token') : null;
    t['Transfer fee'] = s.lu && s.t22 ? (s.frais ? 'transfer fee' : 'no transfer fee') : null;
    t['Top 10 holders'] = s.top10 == null ? 'holders unknown' : s.top10 < 20 ? 'top 10 under 20%' : s.top10 < 50 ? 'top 10 20-50%' : 'top 10 50%+';
  } else {
    t['Sell simulation'] = !s.lu ? 'sell unknown' : s.piege ? 'honeypot' : 'sell simulated OK';
    t['Sell tax'] = caseTaxe(s.lu ? s.taxeVente : null);
  }
  return t;
}

function jourUtc(t) { return new Date(t).toISOString().slice(0, 10); }
const arr1 = (x) => Math.round(x * 10) / 10;

/**
 * deps : { dossier, fetch?, maintenant?, solanaRpc?, chaines? ['solana','eth'], journal? (console) }
 */
function cree(deps) {
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const chercher = deps.fetch || ((u, o) => fetch(u, Object.assign({ signal: AbortSignal.timeout(15000) }, o || {})));
  const noms = (deps.chaines || Object.keys(CHAINES)).filter((c) => CHAINES[c]);
  const solRpc = deps.solanaRpc || process.env.SOLANA_RPC_URL || SOL_RPC_PUBLIC;
  const solPrive = !!(deps.solanaRpc || process.env.SOLANA_RPC_URL);
  const E = {};
  let minuteur = null, enCours = false;

  const fichier = (c) => path.join(deps.dossier, c + '.json');
  function neuf(c) {
    return { chaine: c, depuis: maintenant(), cycles: 0, suivis: {}, finis: [], bilans: {},
             compte: { decouverts: 0, observes: 0, jamaisIndexes: 0, disparus: 0, pleins: 0, erreurs: {} }, derniers: [] };
  }
  function charge(c) {
    try { const e = JSON.parse(fs.readFileSync(fichier(c), 'utf8')); if (e && e.chaine === c && e.suivis && e.bilans) return e; } catch (e) { /* neuf */ }
    return neuf(c);
  }
  function sauve(c) {
    try {
      fs.mkdirSync(deps.dossier, { recursive: true });
      const f = fichier(c);
      fs.writeFileSync(f + '.tmp', JSON.stringify(E[c]));
      fs.renameSync(f + '.tmp', f);
    } catch (e) { erreur(c, 'disque'); }
  }
  function garde(c, ligne) {
    try {
      const d = path.join(deps.dossier, c);
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(path.join(d, jourUtc(ligne.t1 || maintenant()) + '.jsonl'), JSON.stringify(ligne) + '\n');
    } catch (e) { erreur(c, 'disque'); }
  }
  function erreur(c, k) { const x = E[c].compte.erreurs; x[k] = (x[k] || 0) + 1; }
  for (const c of noms) E[c] = charge(c);

  async function json(u, o) {
    const r = await chercher(u, o);
    if (r.status === 429) { const e = new Error('429'); e.quota = true; throw e; }
    if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
    return { status: r.status, j: await r.json() };
  }

  /* ---- 1. la decouverte ---- */
  async function decouvre(c) {
    const S = E[c];
    let r;
    try { r = await json('https://api.geckoterminal.com/api/v2/networks/' + CHAINES[c].gt + '/new_pools?page=1'); }
    catch (e) { erreur(c, e.quota ? 'gecko429' : 'gecko'); return; }
    const finis = new Set(S.finis);
    for (const p of ((r.j && r.j.data) || [])) {
      const a = p.attributes || {}, rel = p.relationships || {};
      const id = (((rel.base_token || {}).data) || {}).id || '';
      const addr = id.slice(id.indexOf('_') + 1);
      if (!addr || S.suivis[addr] || finis.has(addr)) continue;
      if (Object.keys(S.suivis).length >= EN_COURS_MAX) { S.compte.pleins++; continue; }
      S.suivis[addr] = { addr, pool: a.address || null, cree: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
                         decouvert: maintenant(), gtDex: (((rel.dex || {}).data) || {}).id || null };
      S.compte.decouverts++;
    }
  }

  /* ---- 2. la securite ---- */
  async function secuSolana(o) {
    const q = (method, params) => json(solRpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const r = await q('getAccountInfo', [o.addr, { encoding: 'jsonParsed' }]);
    const v = r.j && r.j.result && r.j.result.value;
    if (r.j && r.j.error && /429|too many/i.test(JSON.stringify(r.j.error))) { const e = new Error('429'); e.quota = true; throw e; }
    const info = v && v.data && v.data.parsed && v.data.parsed.info;
    if (!info) return { lu: false };
    const ext = (info.extensions || []).map((x) => x.extension);
    const s = { lu: true, frappe: !!info.mintAuthority, gel: !!info.freezeAuthority, t22: v.owner === TOKEN_2022,
                frais: ext.includes('transferFeeConfig'), top10: null };
    /* Les porteurs : seulement sur un noeud prive (le public rend 429 a la premiere demande). */
    if (solPrive && Number(info.supply) > 0) {
      try {
        const h = await q('getTokenLargestAccounts', [o.addr]);
        const l = (h.j && h.j.result && h.j.result.value) || [];
        const somme = l.slice(0, 10).reduce((x, y) => x + Number(y.amount || 0), 0);
        s.top10 = arr1(somme / Number(info.supply) * 100);
      } catch (e) { /* inconnu */ }
    }
    return s;
  }
  async function secuEth(o) {
    const r = await json('https://api.honeypot.is/v2/IsHoneypot?address=' + o.addr + '&chainID=1');
    if (r.status === 404 || !r.j || !r.j.honeypotResult) return { lu: false, attendre: true };
    const sim = r.j.simulationResult || {};
    return { lu: true, piege: !!r.j.honeypotResult.isHoneypot, taxeVente: typeof sim.sellTax === 'number' ? arr1(sim.sellTax) : null,
             taxeAchat: typeof sim.buyTax === 'number' ? arr1(sim.buyTax) : null };
  }
  async function securise(c) {
    const S = E[c];
    let n = 0;
    for (const o of Object.values(S.suivis)) {
      if (n >= SECU_PAR_CYCLE) break;
      if (o.secu && (o.secu.lu || (o.secu.essais || 0) >= HP_ESSAIS)) continue;
      n++;
      try {
        const s = c === 'solana' ? await secuSolana(o) : await secuEth(o);
        const essais = ((o.secu && o.secu.essais) || 0) + 1;
        o.secu = Object.assign(s, { essais });
      } catch (e) { erreur(c, e.quota ? (c === 'solana' ? 'rpc429' : 'honeypot429') : (c === 'solana' ? 'rpc' : 'honeypot')); if (e.quota) break; }
    }
  }

  /* ---- 3. les prix : au depart, puis a 30 min, par le meme service ---- */
  function choisisPaire(o, paires) {
    const mien = paires.filter((p) => String(p.baseToken && p.baseToken.address).toLowerCase() === o.addr.toLowerCase());
    return mien.find((p) => o.pool && String(p.pairAddress).toLowerCase() === String(o.pool).toLowerCase())
      || mien.sort((x, y) => ((y.liquidity && y.liquidity.usd) || 0) - ((x.liquidity && x.liquidity.usd) || 0))[0] || null;
  }
  async function lot(c, liste) {
    let r;
    try { r = await json('https://api.dexscreener.com/tokens/v1/' + CHAINES[c].dex + '/' + liste.map((o) => o.addr).join(',')); }
    catch (e) { erreur(c, e.quota ? 'dex429' : 'dex'); return null; }
    return Array.isArray(r.j) ? r.j : [];
  }
  async function prix(c) {
    const S = E[c], t = maintenant();
    const tous = Object.values(S.suivis);
    const departs = tous.filter((o) => o.p0 == null);
    const echus = tous.filter((o) => o.p0 != null && t - o.t0 >= HORIZON_MIN * 60e3);
    let lots = 0;
    /* Les echeances d'abord : une lecture en retard fausse la mesure, un depart en retard non. */
    for (const groupe of [echus, departs]) {
      for (let i = 0; i < groupe.length && lots < LOTS_PAR_CYCLE; i += 30) {
        const liste = groupe.slice(i, i + 30);
        const paires = await lot(c, liste);
        lots++;
        if (!paires) return;
        for (const o of liste) {
          const p = choisisPaire(o, paires);
          if (o.p0 == null) {
            if (p && Number(p.priceUsd) > 0) {
              const so = p.info ? ((p.info.socials || []).length + (p.info.websites || []).length) : 0;
              /* L'age du JETON : sa plus ancienne paire. Un jeton sorti d'une courbe de
                 lancement (pump.fun, Meteora DBC) ouvre un pool neuf, mais il a deja vecu. */
              const nes = paires.filter((x) => String(x.baseToken && x.baseToken.address).toLowerCase() === o.addr.toLowerCase() && x.pairCreatedAt > 0)
                .map((x) => x.pairCreatedAt).concat(o.cree ? [o.cree] : []);
              const ne = nes.length ? Math.min(...nes) : null;
              Object.assign(o, { p0: Number(p.priceUsd), t0: t, liq0: (p.liquidity && p.liquidity.usd) || null, mc0: p.marketCap || p.fdv || null,
                age0: ne ? arr1((t - ne) / 60e3) : null,
                dexId: p.dexId || o.gtDex, quote: (p.quoteToken && p.quoteToken.symbol) || null, sociaux: so, pool: o.pool || p.pairAddress });
            } else if (t - o.decouvert > JAMAIS_INDEXE_MIN * 60e3) {
              S.compte.jamaisIndexes++; termine(c, o, null, 'never indexed');
            }
          } else if (p && Number(p.priceUsd) > 0) {
            termine(c, o, (Number(p.priceUsd) / o.p0 - 1) * 100, null, p);
          } else {
            /* Le pool a disparu de DexScreener en trente minutes : compte a part, jamais invente en -100 %. */
            S.compte.disparus++; termine(c, o, null, 'vanished');
          }
        }
      }
    }
  }

  function termine(c, o, r, sansPrix, p) {
    const S = E[c], t = maintenant();
    delete S.suivis[o.addr];
    S.finis.push(o.addr);
    if (S.finis.length > FINIS_MAX) S.finis.splice(0, S.finis.length - FINIS_MAX);
    const ligne = Object.assign({ chaine: c }, o, { t1: t, r: r == null ? null : arr1(r), sansPrix: sansPrix || null,
      liq1: p && p.liquidity ? p.liquidity.usd : null, mc1: p ? (p.marketCap || p.fdv || null) : null });
    garde(c, ligne);
    if (sansPrix === 'never indexed') return;          /* aucun trait fiable : pas dans les bilans */
    const traits = traitsDe(Object.assign({ chaine: c }, o));
    const note = (cle) => {
      const b = S.bilans[cle] || (S.bilans[cle] = { n: 0, s: 0, montes: 0, effondres: 0, disparus: 0 });
      if (r == null) { b.disparus++; return; }
      b.n++; b.s += r;
      if (r >= MONTE) b.montes++;
      if (r <= EFFONDRE) b.effondres++;
    };
    note('all tokens');
    for (const [k, v] of Object.entries(traits)) if (v) note(k + ' = ' + v);
    if (r != null) S.compte.observes++;
    S.derniers.unshift({ addr: o.addr, dex: o.dexId || null, r: r == null ? null : arr1(r), sansPrix: sansPrix || null, t: t });
    S.derniers = S.derniers.slice(0, 20);
  }

  async function cycle() {
    if (enCours) return;
    enCours = true;
    try {
      for (const c of noms) {
        E[c].cycles++;
        await decouvre(c);
        await securise(c);
        await prix(c);
        sauve(c);
      }
    } finally { enCours = false; }
  }

  function vue() {
    const out = { note: 'Observation only: no buy, no paper trade, no key. Each new token is read at its first price and again 30 minutes later. '
      + 'Rise = +' + MONTE + '% or more, collapse = ' + EFFONDRE + '% or worse, the same definitions as the Robinhood colony. '
      + 'A case under ' + ASSEZ + ' observations does not conclude.', horizonMin: HORIZON_MIN, chaines: {} };
    for (const c of noms) {
      const S = E[c];
      const cases = Object.entries(S.bilans).map(([cle, b]) => {
        const i = cle.indexOf(' = ');
        return { trait: i > 0 ? cle.slice(0, i) : cle, case: i > 0 ? cle.slice(i + 3) : cle, n: b.n,
                 moyenne: b.n ? arr1(b.s / b.n) : null, partMontes: b.n ? Math.round(b.montes / b.n * 100) : null,
                 partEffondres: b.n ? Math.round(b.effondres / b.n * 100) : null, disparus: b.disparus, assez: b.n >= ASSEZ };
      }).sort((x, y) => (x.trait === 'all tokens' ? -1 : y.trait === 'all tokens' ? 1 : x.trait.localeCompare(y.trait) || y.n - x.n));
      out.chaines[c] = { nom: CHAINES[c].nom, depuis: new Date(S.depuis).toISOString(), cycles: S.cycles,
        enCours: Object.keys(S.suivis).length, compte: S.compte, holders: c === 'solana' ? (solPrive ? 'read (SOLANA_RPC_URL)' : 'unknown: the public Solana node refuses holder reads — set SOLANA_RPC_URL') : null,
        cases, derniers: S.derniers };
    }
    return out;
  }

  function demarre() {
    if (minuteur) return;
    const tour = () => { cycle().catch(() => {}); };
    tour();
    minuteur = setInterval(tour, deps.cycleMs || CYCLE_MS);
    if (minuteur.unref) minuteur.unref();
  }
  function arrete() { if (minuteur) clearInterval(minuteur); minuteur = null; }

  return { cycle, vue, demarre, arrete, _etat: (c) => E[c] };
}

module.exports = { cree, traitsDe, CHAINES, HORIZON_MIN, MONTE, EFFONDRE, ASSEZ };
