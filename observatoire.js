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
 *
 * ---- ET LES DEVS (meme jour) ----
 * « Des gens notent les devs et collectionnent les donnees pour avoir une
 * moyenne des ATH qu'ils font » (proprietaire, 27/09). Sur Robinhood et
 * Ethereum : le dev d'un jeton est l'expediteur de la transaction de sa
 * premiere frappe (Transfer depuis 0x0, lu par eth_getLogs sur les 9 999
 * derniers blocs, puis eth_getTransactionByHash) — verifie le 27/09 sur un
 * jeton lance par un contrat lanceur : tx.from est bien le dev, tx.to le
 * lanceur. Un jeton dont le dev est connu est suivi 24 h (30 min, 2 h, 6 h,
 * 24 h) : son plus haut OBSERVE a ces jalons (une borne basse de l'ATH, dite
 * comme telle), et s'il a disparu (rug). Par dev : ses jetons, la moyenne de
 * leurs plus hauts, combien ont passe 100 k$, combien ont disparu. Et au
 * moment ou il lance un nouveau jeton, son passe devient un TRAIT (« Dev
 * history ») mesure a 30 min comme les autres : la note d'un dev ne servira a
 * decider que si ce trait separe vraiment ce qui monte de ce qui tombe.
 * Robinhood : la securite reste a la colonie ; l'observatoire y ajoute les devs.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');

const CHAINES = {
  robinhood: { gt: 'robinhood', dex: 'robinhood', nom: 'Robinhood Chain', evm: true, rpc: 'https://rpc.mainnet.chain.robinhood.com', env: 'RPC_URL' },
  solana: { gt: 'solana', dex: 'solana', nom: 'Solana' },
  eth: { gt: 'eth', dex: 'ethereum', nom: 'Ethereum', evm: true, rpc: 'https://ethereum-rpc.publicnode.com', env: 'ETH_RPC_URL' },
};
/* Les jalons du plus haut : 30 min (le jugement de la colonie), puis 2 h, 6 h, 24 h. */
const JALONS = [30, 120, 360, 1440];
const BLOCS_FRAPPE = 9999;          /* la plage que les noeuds acceptent (ai_colonie : 10 000 blocs, les deux bouts compris) */
/* Devs cherches par chaine et par cycle (2 appels chacun). Cycle reel du 27/09 : 20
   pools Robinhood decouverts par cycle, 8 devs cherches, 8 trouves (Ethereum : 7/8).
   15 par cycle ~ 10 appels/min sur le noeud Robinhood, que la colonie partage. */
const DEV_PAR_CYCLE = 15;
const DEVS_MAX = 20000, DEV_JETONS_MAX = 30;
const HORIZON_MIN = 30;             /* la colonie juge a 30 min */
const MONTE = 20, EFFONDRE = -30;   /* ai_colonie, memes seuils */
const ASSEZ = 30;                   /* sous 30 observations, une case ne conclut pas (BANCS_ASSEZ, le meme ordre) */
const CYCLE_MS = 3 * 60e3;
const SECU_PAR_CYCLE = 6;           /* lectures de securite par chaine et par cycle */
const LOTS_PAR_CYCLE = 6;           /* lots DexScreener (30 jetons) par chaine et par cycle — jalons de 24 h compris */
const EN_COURS_MAX = 6000;          /* jetons suivis a la fois, par chaine (24 h de suivi pour ceux dont le dev est connu) */
const JAMAIS_INDEXE_MIN = 60;       /* au-dela, un jeton que DexScreener ignore sort du suivi */
const FINIS_MAX = 20000;            /* adresses deja observees, pour ne pas les recompter */
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
  if (o.devHist) t['Dev history'] = o.devHist;
  const s = o.secu || {};
  if (o.chaine === 'robinhood') return t;      /* sa securite, c'est la colonie qui la lit */
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
    return { chaine: c, depuis: maintenant(), cycles: 0, suivis: {}, finis: [], bilans: {}, devs: {},
             compte: { decouverts: 0, observes: 0, jamaisIndexes: 0, disparus: 0, pleins: 0, erreurs: {} }, derniers: [] };
  }
  function charge(c) {
    try { const e = JSON.parse(fs.readFileSync(fichier(c), 'utf8')); if (e && e.chaine === c && e.suivis && e.bilans) { e.devs = e.devs || {}; return e; } } catch (e) { /* neuf */ }
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
  /* Le compte ET le dernier motif, pour qu'une panne se diagnostique d'ici. Le motif est
     un code HTTP ou un nom d'erreur : JAMAIS l'adresse appelee — celle d'un noeud prive
     (SOLANA_RPC_URL) porte sa cle. */
  function erreur(c, k, e) {
    const x = E[c].compte.erreurs; x[k] = (x[k] || 0) + 1;
    if (e) {
      const m = E[c].compte.motifs || (E[c].compte.motifs = {});
      const brut = String((e && (e.statut ? 'HTTP ' + e.statut : (e.cause && e.cause.code) || e.name || 'error')) || 'error');
      m[k] = brut.replace(/https?:\/\/\S+/g, '[url]').slice(0, 40);
    }
  }
  for (const c of noms) E[c] = charge(c);

  async function json(u, o) {
    const r = await chercher(u, o);
    if (r.status === 429) { const e = new Error('429'); e.quota = true; throw e; }
    if (!r.ok && r.status !== 404) { const e = new Error('HTTP ' + r.status); e.statut = r.status; throw e; }
    return { status: r.status, j: await r.json() };
  }

  /* ---- 1. la decouverte ---- */
  async function decouvre(c) {
    const S = E[c];
    let r;
    try { r = await json('https://api.geckoterminal.com/api/v2/networks/' + CHAINES[c].gt + '/new_pools?page=1'); }
    catch (e) { erreur(c, e.quota ? 'gecko429' : 'gecko', e); return; }
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
    if (c === 'robinhood') return;
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
      } catch (e) { erreur(c, e.quota ? (c === 'solana' ? 'rpc429' : 'honeypot429') : (c === 'solana' ? 'rpc' : 'honeypot'), e); if (e.quota) break; }
    }
  }

  /* ---- 3. le dev : l'expediteur de la premiere frappe (Robinhood, Ethereum) ---- */
  const rpcEvm = (c) => (deps.rpcEvm && deps.rpcEvm[c]) || process.env[CHAINES[c].env] || CHAINES[c].rpc;
  async function appelEvm(c, method, params) {
    const r = await json(rpcEvm(c), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.j && r.j.error) {
      const e = new Error(String(r.j.error.message || 'rpc error'));
      if (/429|too many|rate/i.test(JSON.stringify(r.j.error))) e.quota = true;
      throw e;
    }
    return r.j ? r.j.result : null;
  }
  const SUJET_TRANSFERT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const MOT_ZERO = '0x' + '0'.repeat(64);
  /** Ce que le passe d'un dev dit, au moment ou il lance un nouveau jeton. */
  function histoireDe(c, dev) {
    const d = E[c].devs[dev];
    if (!d || !d.n) return 'first token we see from this dev';
    const moy = d.athSomme / d.n;
    if (d.n >= 2 && d.rugs / d.n >= 0.5) return 'dev: half or more of past tokens vanished';
    return (d.n >= 3 ? '3+ past tokens' : '1-2 past tokens') + ', avg peak ' + (moy < 5e4 ? '<$50k' : moy < 2.5e5 ? '$50-250k' : '$250k+');
  }
  async function devs(c) {
    if (!CHAINES[c].evm) return;
    const S = E[c];
    let n = 0, bloc = null;
    for (const o of Object.values(S.suivis)) {
      if (n >= DEV_PAR_CYCLE) break;
      if (o.dev !== undefined) continue;
      n++;
      try {
        if (bloc === null) bloc = parseInt(await appelEvm(c, 'eth_blockNumber', []), 16);
        const logs = await appelEvm(c, 'eth_getLogs', [{ address: o.addr, topics: [SUJET_TRANSFERT, MOT_ZERO],
          fromBlock: '0x' + Math.max(0, bloc - BLOCS_FRAPPE).toString(16), toBlock: '0x' + bloc.toString(16) }]);
        if (!Array.isArray(logs) || !logs.length) { o.dev = null; continue; }   /* frappe plus ancienne que la plage : dev inconnu */
        const tx = await appelEvm(c, 'eth_getTransactionByHash', [logs[0].transactionHash]);
        o.dev = tx && tx.from ? String(tx.from).toLowerCase() : null;
        if (o.dev) { o.lanceur = tx.to ? String(tx.to).toLowerCase() : null; o.devHist = histoireDe(c, o.dev); }
      } catch (e) { erreur(c, e.quota ? 'rpc429' : 'rpc', e); if (e.quota) break; }
    }
  }

  /* ---- 4. les prix : au depart, puis aux jalons, par le meme service ---- */
  function choisisPaire(o, paires) {
    const mien = paires.filter((p) => String(p.baseToken && p.baseToken.address).toLowerCase() === o.addr.toLowerCase());
    return mien.find((p) => o.pool && String(p.pairAddress).toLowerCase() === String(o.pool).toLowerCase())
      || mien.sort((x, y) => ((y.liquidity && y.liquidity.usd) || 0) - ((x.liquidity && x.liquidity.usd) || 0))[0] || null;
  }
  async function lot(c, liste) {
    let r;
    try { r = await json('https://api.dexscreener.com/tokens/v1/' + CHAINES[c].dex + '/' + liste.map((o) => o.addr).join(',')); }
    catch (e) { erreur(c, e.quota ? 'dex429' : 'dex', e); return null; }
    return Array.isArray(r.j) ? r.j : [];
  }
  const echeance = (o) => o.t0 + JALONS[o.jalon || 0] * 60e3;
  async function prix(c) {
    const S = E[c], t = maintenant();
    const tous = Object.values(S.suivis);
    const departs = tous.filter((o) => o.p0 == null);
    const echus = tous.filter((o) => o.p0 != null && t >= echeance(o)).sort((a, b) => echeance(a) - echeance(b));
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
              /* L'age du JETON : sa plus ancienne paire. Un jeton sorti d'une courbe de
                 lancement (pump.fun, Meteora DBC) ouvre un pool neuf, mais il a deja vecu. */
              const nes = paires.filter((x) => String(x.baseToken && x.baseToken.address).toLowerCase() === o.addr.toLowerCase() && x.pairCreatedAt > 0)
                .map((x) => x.pairCreatedAt).concat(o.cree ? [o.cree] : []);
              const ne = nes.length ? Math.min(...nes) : null;
              const so = p.info ? ((p.info.socials || []).length + (p.info.websites || []).length) : 0;
              const mc = p.marketCap || p.fdv || null;
              Object.assign(o, { p0: Number(p.priceUsd), t0: t, jalon: 0, liq0: (p.liquidity && p.liquidity.usd) || null, mc0: mc, mcMax: mc,
                age0: ne ? arr1((t - ne) / 60e3) : null,
                dexId: p.dexId || o.gtDex, quote: (p.quoteToken && p.quoteToken.symbol) || null, sociaux: so, pool: o.pool || p.pairAddress });
            } else if (t - o.decouvert > JAMAIS_INDEXE_MIN * 60e3) {
              S.compte.jamaisIndexes++; sort(c, o, 'never indexed');
            }
            continue;
          }
          const j = o.jalon || 0;
          if (p && Number(p.priceUsd) > 0) {
            const r = (Number(p.priceUsd) / o.p0 - 1) * 100;
            const mc = p.marketCap || p.fdv || null;
            if (mc && !(o.mcMax >= mc)) o.mcMax = mc;
            (o.lus || (o.lus = [])).push({ min: JALONS[j], r: arr1(r), mc });
            if (j === 0) { o.r30 = arr1(r); o.liq1 = (p.liquidity && p.liquidity.usd) || null; noteBilans(c, o, r); }
            /* Au-dela de 30 min, on ne suit que les jetons dont le dev est connu : c'est pour lui que le plus haut compte. */
            if (j === 0 && !o.dev) { sort(c, o, null); continue; }
            if (j === JALONS.length - 1) { noteDev(c, o); sort(c, o, null); continue; }
            o.jalon = j + 1;
          } else {
            /* Le pool a disparu de DexScreener : compte a part, jamais invente en -100 %. */
            o.rug = true;
            (o.lus || (o.lus = [])).push({ min: JALONS[j], r: null, mc: null });
            if (j === 0) { S.compte.disparus++; noteBilans(c, o, null); }
            if (o.dev) noteDev(c, o);
            sort(c, o, 'vanished');
          }
        }
      }
    }
  }

  function noteBilans(c, o, r) {
    const S = E[c];
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
    S.derniers.unshift({ addr: o.addr, dex: o.dexId || null, r: r == null ? null : arr1(r), dev: o.dev || null, t: maintenant() });
    S.derniers = S.derniers.slice(0, 20);
  }

  /** Le registre : ce que chaque dev a lance, et jusqu'ou c'est monte (a nos jalons). */
  function noteDev(c, o) {
    const S = E[c];
    const d = S.devs[o.dev] || (S.devs[o.dev] = { n: 0, athSomme: 0, au100k: 0, rugs: 0, jetons: [], vu: 0 });
    const ath = o.rug && !(o.mcMax > 0) ? 0 : (o.mcMax || 0);
    d.n++; d.athSomme += ath; if (ath >= 1e5) d.au100k++; if (o.rug) d.rugs++;
    d.vu = maintenant();
    d.jetons.unshift({ addr: o.addr, mc0: o.mc0 || null, pic: ath || null, r30: o.r30 == null ? null : o.r30, rug: !!o.rug, t0: o.t0 });
    d.jetons = d.jetons.slice(0, DEV_JETONS_MAX);
    const cles = Object.keys(S.devs);
    if (cles.length > DEVS_MAX) {
      cles.sort((a, b) => S.devs[a].vu - S.devs[b].vu);
      for (const k of cles.slice(0, cles.length - DEVS_MAX)) delete S.devs[k];
    }
  }

  function sort(c, o, sansPrix) {
    const S = E[c];
    delete S.suivis[o.addr];
    S.finis.push(o.addr);
    if (S.finis.length > FINIS_MAX) S.finis.splice(0, S.finis.length - FINIS_MAX);
    garde(c, Object.assign({ chaine: c }, o, { t1: maintenant(), sansPrix: sansPrix || null }));
  }

  async function cycle() {
    if (enCours) return;
    enCours = true;
    try {
      for (const c of noms) {
        E[c].cycles++;
        await decouvre(c);
        await securise(c);
        await devs(c);
        await prix(c);
        sauve(c);
      }
    } finally { enCours = false; }
  }

  function ficheDev(c, d, adr) {
    return { dev: adr, tokens: d.n, avgPeakCapUsd: d.n ? Math.round(d.athSomme / d.n) : null, reached100k: d.au100k, vanished: d.rugs,
             latest: d.jetons.slice(0, 10).map((x) => ({ token: x.addr, capAtFirstPrice: x.mc0, peakCap: x.pic, move30mPct: x.r30, vanished: x.rug })) };
  }
  /** Un dev, sur une chaine : sa fiche, ou null. */
  function dev(c, adr) {
    const S = E[c]; const a = String(adr || '').toLowerCase();
    return S && S.devs[a] ? ficheDev(c, S.devs[a], a) : null;
  }

  function vue() {
    const out = { note: 'Observation only: no buy, no paper trade, no key. Each new token is read at its first price and again 30 minutes later. '
      + 'Rise = +' + MONTE + '% or more, collapse = ' + EFFONDRE + '% or worse, the same definitions as the Robinhood colony. '
      + 'A case under ' + ASSEZ + ' observations does not conclude. Dev records (Robinhood, Ethereum): the peak is the highest market cap seen at 30 min, 2 h, 6 h and 24 h — a lower bound of the real ATH.',
      horizonMin: HORIZON_MIN, jalonsMin: JALONS, chaines: {} };
    for (const c of noms) {
      const S = E[c];
      const cases = Object.entries(S.bilans).map(([cle, b]) => {
        const i = cle.indexOf(' = ');
        return { trait: i > 0 ? cle.slice(0, i) : cle, case: i > 0 ? cle.slice(i + 3) : cle, n: b.n,
                 moyenne: b.n ? arr1(b.s / b.n) : null, partMontes: b.n ? Math.round(b.montes / b.n * 100) : null,
                 partEffondres: b.n ? Math.round(b.effondres / b.n * 100) : null, disparus: b.disparus, assez: b.n >= ASSEZ };
      }).sort((x, y) => (x.trait === 'all tokens' ? -1 : y.trait === 'all tokens' ? 1 : x.trait.localeCompare(y.trait) || y.n - x.n));
      const lesDevs = Object.entries(S.devs);
      const classes = lesDevs.filter(([, d]) => d.n >= 3).map(([a, d]) => ficheDev(c, d, a))
        .sort((x, y) => y.avgPeakCapUsd - x.avgPeakCapUsd);
      out.chaines[c] = { nom: CHAINES[c].nom, depuis: new Date(S.depuis).toISOString(), cycles: S.cycles,
        enCours: Object.keys(S.suivis).length, compte: S.compte, holders: c === 'solana' ? (solPrive ? 'read (SOLANA_RPC_URL)' : 'unknown: the public Solana node refuses holder reads — set SOLANA_RPC_URL') : null,
        cases, derniers: S.derniers,
        devs: CHAINES[c].evm ? { recorded: lesDevs.length, withThreeTokensOrMore: classes.length,
          bestAvgPeak: classes.slice(0, 10), mostVanished: classes.filter((x) => x.vanished).sort((x, y) => y.vanished / y.tokens - x.vanished / x.tokens).slice(0, 10) } : null };
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

  return { cycle, vue, dev, demarre, arrete, _etat: (c) => E[c] };
}

module.exports = { cree, traitsDe, CHAINES, HORIZON_MIN, JALONS, MONTE, EFFONDRE, ASSEZ };
