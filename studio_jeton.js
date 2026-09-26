'use strict';
/* ==================================================================
 * SWOLEMIND — UNE ADRESSE DE JETON DANS LE CHAT
 * ==================================================================
 *
 * Demande du propriétaire, le 26 septembre 2026 : « je colle l'adresse d'un
 * jeton → prix et liquidité DexScreener, scan de sécurité (honeypot,
 * concentration des porteurs), et ce que la colonie SWOGE AI a observé
 * dessus ». Aucune des applis de chat ne le fait avec des chiffres LUS : elles
 * devinent, ou cherchent un article.
 *
 * Trois lectures, toutes sans clé, relues le même jour sur les vrais services :
 *   - DexScreener `GET /latest/dex/tokens/{adresse}` : toutes les chaînes,
 *     une entrée par piscine (chainId, priceUsd, liquidity.usd, fdv,
 *     marketCap, volume.h24, priceChange, txns.h24, pairCreatedAt, url) ;
 *   - GoPlus `GET /api/v1/token_security/{chaine}?contract_addresses=` : des
 *     chaînes « "0" / "1" » (is_honeypot, cannot_sell_all, buy_tax…), et
 *     `holders[].percent` en FRACTION (0,088 = 8,8 %). Les identifiants de
 *     chaîne viennent de `/api/v1/supported_chains` (Robinhood = 4663) ;
 *   - la colonie (`ai_colonie.scanJeton`) pour un jeton de Robinhood Chain :
 *     les cases de ce jeton et ce qu'elles ont rendu, chacune avec son effectif.
 *
 * Aucune logique d'argent ici : lire ne coûte rien au joueur, seuls les jetons
 * d'entrée que la fiche ajoute à la question sont facturés (par `usage`).
 * Ce n'est JAMAIS un avis d'achat, et le modèle reçoit la consigne de le dire.
 * ================================================================== */

const MAX_ADRESSES = 2;
/* Le pire cas de ce qu'une fiche ajoute à la question, en jetons : mesuré sur
   la fiche la plus longue de l'essai (~2 400 caractères) à un jeton pour deux
   caractères, arrondi au-dessus. La réserve de `studio_chat` le compte. */
const JETONS_PAR_FICHE = 1500;
/* En dessous, une case de la colonie se montre, mais comme « trop peu pour
   conclure » : un écart sur une poignée de jetons est de la chance. */
const OBS_ASSEZ = 30;
const TTL_MS = 60000;

/* DexScreener `chainId` → GoPlus `chain_id` (liste relue sur supported_chains). */
const GOPLUS_CHAINES = { ethereum: '1', bsc: '56', arbitrum: '42161', polygon: '137', base: '8453',
  optimism: '10', avalanche: '43114', robinhood: '4663' };

const DEX = () => (process.env.DEXSCREENER_BASE_URL || 'https://api.dexscreener.com').replace(/\/$/, '');
const GOPLUS = () => (process.env.GOPLUS_BASE_URL || 'https://api.gopluslabs.io').replace(/\/$/, '');
const SITE = () => String(process.env.SITE_URL || 'https://swoleeswoge.dog').replace(/\/+$/, '');

const nn = (x) => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const https = (u) => (/^https:\/\//i.test(String(u || '')) ? String(u) : null);

/** Les adresses EVM de la question, sans doublon, au plus MAX_ADRESSES. */
function adressesDe(texte) {
  const vues = [];
  for (const a of String(texte || '').match(/\b0x[0-9a-fA-F]{40}\b/g) || []) {
    const l = a.toLowerCase();
    if (!vues.includes(l)) vues.push(l);
  }
  return vues.slice(0, MAX_ADRESSES);
}

async function json(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(url.split('/')[2] + ' ' + r.status);
  return r.json();
}

/** Le marché : la piscine la plus profonde, toutes chaînes confondues. */
async function lisMarche(addr) {
  const j = await json(DEX() + '/latest/dex/tokens/' + addr);
  const p = (j.pairs || []).filter((x) => x && String((x.baseToken || {}).address || '').toLowerCase() === addr);
  if (!p.length) return null;
  const liq = (x) => nn(x.liquidity && x.liquidity.usd) || 0;
  p.sort((a, b) => liq(b) - liq(a));
  const q = p[0], bt = q.baseToken || {}, tx = (q.txns || {}).h24 || {};
  return {
    chaine: String(q.chainId || ''), dex: String(q.dexId || '').slice(0, 24),
    sym: String(bt.symbol || '').slice(0, 16), nom: String(bt.name || '').slice(0, 40),
    prixUsd: nn(q.priceUsd), liqUsd: q.liquidity && q.liquidity.usd != null ? nn(q.liquidity.usd) : null,
    mcUsd: nn(q.marketCap) || nn(q.fdv), vol24Usd: nn((q.volume || {}).h24),
    var1h: nn((q.priceChange || {}).h1), var24h: nn((q.priceChange || {}).h24),
    achats24: nn(tx.buys), ventes24: nn(tx.sells),
    ageJours: q.pairCreatedAt ? Math.max(0, Math.round((Date.now() - q.pairCreatedAt) / 864e5 * 10) / 10) : null,
    piscines: p.length, chaines: [...new Set(p.map((x) => String(x.chainId || '')))].slice(0, 5),
    url: https(q.url),
  };
}

/** La sécurité, tri-état : `null` quand GoPlus ne sait pas, jamais « non » par défaut. */
async function lisSecurite(chaine, addr) {
  const id = GOPLUS_CHAINES[chaine];
  if (!id) return { couverte: false };
  const j = await json(GOPLUS() + '/api/v1/token_security/' + id + '?contract_addresses=' + addr);
  const i = (j.result || {})[addr] || {};
  if (!Object.keys(i).length) return { couverte: true, connu: false };
  const tri = (x) => (x === '1' ? true : x === '0' ? false : null);
  const pct = (x) => (x === undefined || x === '' ? null : Math.round(Number(x) * 1000) / 10);
  /* Les porteurs : sans les contrats, les verrous et les brûlés — ce qui
     reste peut vendre. Même règle que la colonie (lisGoplus). */
  const libres = (i.holders || []).filter((h) => Number(h.is_contract) !== 1 && Number(h.is_locked) !== 1
    && !/lock|burn|null|dead/i.test(h.tag || '')).map((h) => Number(h.percent) * 100).filter(Number.isFinite);
  const lpVerrou = (i.lp_holders || []).reduce((s, h) =>
    s + ((Number(h.is_locked) === 1 || /lock|burn|null|dead/i.test(h.tag || '')) ? Number(h.percent) * 100 || 0 : 0), 0);
  return {
    couverte: true, connu: true,
    honeypot: tri(i.is_honeypot), venteBloquee: tri(i.cannot_sell_all), achatBloque: tri(i.cannot_buy),
    taxeAchat: pct(i.buy_tax), taxeVente: pct(i.sell_tax),
    mint: tri(i.is_mintable), pause: tri(i.transfer_pausable), listeNoire: tri(i.is_blacklisted),
    proxy: tri(i.is_proxy), codeOuvert: tri(i.is_open_source), proprioCache: tri(i.hidden_owner),
    reprendPropriete: tri(i.can_take_back_ownership), soldeModifiable: tri(i.owner_change_balance),
    memeCreateurHoneypot: tri(i.honeypot_with_same_creator),
    porteurs: i.holder_count ? parseInt(i.holder_count, 10) : null,
    premierPorteur: libres.length ? Math.round(Math.max(...libres) * 10) / 10 : null,
    dixPremiers: libres.length ? Math.round(libres.sort((a, b) => b - a).slice(0, 10).reduce((a, b) => a + b, 0) * 10) / 10 : null,
    lpVerrouillee: (i.lp_holders || []).length ? Math.round(lpVerrou) : null,
  };
}

/** Ce que la colonie a mesuré sur les cases de ce jeton (Robinhood Chain seulement). */
async function lisColonie(addr, scan) {
  if (!scan) return null;
  const d = await Promise.race([scan(addr), new Promise((_, n) => setTimeout(() => n(new Error('lent')), 8000))]);
  if (!d) return null;
  return {
    cases: (d.cases || []).slice(0, 6).map((c) => ({ trait: c.trait, case: c.case, n: c.n, moyenne: c.moyenne,
      assez: c.n >= OBS_ASSEZ })),
    faits: (d.faits || []).map((f) => f.quoi + ' (' + f.source + ')'),
    observations: (d.mesureSur && d.mesureSur.observations) || 0,
    echeance: (d.mesureSur && d.mesureSur.echeance) || null,
    scan: SITE() + '/swoge_scan.html?t=' + addr,
  };
}

const CACHE = new Map();   /* adresse → { t, p } : une promesse, pour que trois colonnes ne lisent qu'une fois */

/** La fiche d'un jeton : marché, sécurité, colonie. Chaque lecture ratée reste `null` et le dit. */
function fiche(addr, deps) {
  const c = CACHE.get(addr);
  if (c && Date.now() - c.t < TTL_MS) return c.p;
  const p = (async () => {
    const f = { adresse: addr, marche: null, securite: null, colonie: null, manque: [] };
    try { f.marche = await lisMarche(addr); } catch (e) { f.manque.push('DexScreener'); }
    if (!f.marche) return f;
    try { f.securite = await lisSecurite(f.marche.chaine, addr); } catch (e) { f.manque.push('GoPlus'); }
    if (f.marche.chaine === 'robinhood') {
      try { f.colonie = await lisColonie(addr, deps && deps.scan); } catch (e) { f.manque.push('SWOGE AI colony'); }
    }
    return f;
  })();
  CACHE.set(addr, { t: Date.now(), p });
  for (const [k, v] of CACHE) if (Date.now() - v.t > TTL_MS) CACHE.delete(k);
  return p;
}

const usd = (x) => (x == null ? 'unknown' : '$' + (x >= 1 ? Math.round(x).toLocaleString('en-US')
  : Number(x).toPrecision(4)));
const oui = (x, texte) => (x === true ? texte : null);

/** Les fiches, mises en texte pour le modèle. */
function contexte(fiches) {
  const blocs = fiches.map((f) => {
    const l = ['Token ' + f.adresse + ':'];
    const m = f.marche;
    if (!m) { l.push('- Not found on DexScreener' + (f.manque.length ? ' (the lookup failed)' : '') + '.'); return l.join('\n'); }
    l.push('- Market (DexScreener, deepest of ' + m.piscines + ' pool' + (m.piscines > 1 ? 's' : '') + '): $' + m.sym + ' "' + m.nom + '" on ' + m.chaine + ' (' + m.dex + ')'
      + ', price ' + usd(m.prixUsd) + ', liquidity ' + usd(m.liqUsd) + ', market cap ' + usd(m.mcUsd)
      + ', 24h volume ' + usd(m.vol24Usd) + ', 24h change ' + (m.var24h == null ? 'unknown' : m.var24h + '%')
      + ', 24h buys/sells ' + (m.achats24 == null ? '?' : m.achats24) + '/' + (m.ventes24 == null ? '?' : m.ventes24)
      + ', pool age ' + (m.ageJours == null ? 'unknown' : m.ageJours + ' days') + '.');
    const s = f.securite;
    if (!s) l.push('- Contract security: the GoPlus lookup failed — unknown, NOT safe.');
    else if (!s.couverte) l.push('- Contract security: GoPlus does not cover ' + m.chaine + ' — unknown.');
    else if (!s.connu) l.push('- Contract security: GoPlus has no record of this token yet — unknown, NOT safe.');
    else {
      const alertes = [oui(s.honeypot, 'flagged as a HONEYPOT'), oui(s.venteBloquee, 'holders cannot sell all'),
        oui(s.achatBloque, 'buying is blocked'), oui(s.mint, 'owner can mint'), oui(s.pause, 'transfers can be paused'),
        oui(s.listeNoire, 'has a blacklist'), oui(s.proxy, 'upgradeable proxy'), oui(s.proprioCache, 'hidden owner'),
        oui(s.reprendPropriete, 'ownership can be taken back'), oui(s.soldeModifiable, 'owner can change balances'),
        oui(s.memeCreateurHoneypot, 'creator made a honeypot before'), s.codeOuvert === false ? 'source code not verified' : null].filter(Boolean);
      l.push('- Contract security (GoPlus): ' + (alertes.length ? alertes.join('; ') : 'no red flag among the checks GoPlus returned')
        + '; buy/sell tax ' + (s.taxeAchat == null ? '?' : s.taxeAchat + '%') + '/' + (s.taxeVente == null ? '?' : s.taxeVente + '%') + '.');
      l.push('- Holders (GoPlus): ' + (s.porteurs == null ? 'unknown count' : s.porteurs.toLocaleString('en-US') + ' holders')
        + ', largest free wallet ' + (s.premierPorteur == null ? 'unknown' : s.premierPorteur + '%')
        + ', top 10 free wallets ' + (s.dixPremiers == null ? 'unknown' : s.dixPremiers + '%')
        + ' (contracts, locks and burns excluded), LP locked or burnt ' + (s.lpVerrouillee == null ? 'unknown' : s.lpVerrouillee + '%') + '.');
    }
    const c = f.colonie;
    if (c) {
      l.push('- SWOGE AI colony (' + c.observations.toLocaleString('en-US') + ' observations in memory; average ' + (c.echeance || 30) + '-minute move of past tokens that shared each trait):');
      if (!c.cases.length) l.push('  none of this token\'s traits has enough observations yet — no conclusion.');
      c.cases.forEach((x) => l.push('  ' + x.trait + ' = ' + x.case + ': ' + (x.moyenne > 0 ? '+' : '') + x.moyenne + '% average over ' + x.n + ' observations'
        + (x.assez ? '' : ' (too few to conclude)')));
      c.faits.forEach((x) => l.push('  fact: ' + x));
      l.push('  Full scan: ' + c.scan);
    } else if (m.chaine === 'robinhood' && f.manque.includes('SWOGE AI colony')) l.push('- SWOGE AI colony: its scan did not answer in time.');
    if (f.manque.length) l.push('- Not available right now: ' + f.manque.join(', ') + '.');
    return l.join('\n');
  });
  return ['Token data read live by SwoleMind (these are measurements, never a buy or sell signal: say so, quote the numbers with their source and sample size, '
    + 'never call a token safe, and treat "unknown" as unknown — not as good news):'].concat(blocs).join('\n\n');
}

/** Les pastilles de sources : la piscine DexScreener, et le scan de la colonie. */
function sources(fiches) {
  const s = [];
  for (const f of fiches) {
    if (f.marche && f.marche.url) s.push({ url: f.marche.url, titre: 'DexScreener · $' + (f.marche.sym || 'token') });
    if (f.colonie) s.push({ url: f.colonie.scan, titre: 'SWOGE Scan · $' + ((f.marche && f.marche.sym) || 'token') });
  }
  return s;
}

/** Ce que la page affiche en carte : les chiffres, jamais un verdict. */
function carte(f) {
  const m = f.marche || {}, s = f.securite || {}, c = f.colonie;
  return {
    adresse: f.adresse, trouve: !!f.marche, sym: m.sym || null, nom: m.nom || null, chaine: m.chaine || null,
    prixUsd: m.prixUsd ?? null, liqUsd: m.liqUsd ?? null, mcUsd: m.mcUsd ?? null, vol24Usd: m.vol24Usd ?? null,
    var24h: m.var24h ?? null, url: m.url || null,
    securite: !f.securite ? 'failed' : !s.couverte ? 'uncovered' : !s.connu ? 'unknown' : 'read',
    honeypot: s.honeypot ?? null, taxeAchat: s.taxeAchat ?? null, taxeVente: s.taxeVente ?? null,
    alertes: [oui(s.honeypot, 'Honeypot'), oui(s.venteBloquee, 'Cannot sell all'), oui(s.mint, 'Mintable'),
      oui(s.pause, 'Pausable'), oui(s.listeNoire, 'Blacklist'), oui(s.proprioCache, 'Hidden owner'),
      oui(s.soldeModifiable, 'Owner can change balances'), s.codeOuvert === false ? 'Unverified code' : null].filter(Boolean),
    porteurs: s.porteurs ?? null, premierPorteur: s.premierPorteur ?? null, dixPremiers: s.dixPremiers ?? null,
    colonie: c ? { observations: c.observations, scan: c.scan, cases: c.cases } : null,
  };
}

module.exports = { adressesDe, fiche, contexte, sources, carte, lisMarche, lisSecurite,
  MAX_ADRESSES, JETONS_PAR_FICHE, OBS_ASSEZ, GOPLUS_CHAINES, CACHE };
