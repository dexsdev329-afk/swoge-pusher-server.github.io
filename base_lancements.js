'use strict';
/* ==================================================================
 * LES LANCEMENTS DE BASE (CLANKER, ZORA), ET CE QU'ILS DEVIENNENT (28/09/2026)
 * ==================================================================
 *
 * Etape 3 du plan du 28/09. Catalogue PayAI du jour : ~5 services pour les
 * lancements de Base contre 47 pour pump.fun, alors que Base porte 74 % du
 * catalogue ; l'historique des deployeurs EVM tient en 2 ou 3 routes.
 *
 * Tout vient de la CHAINE, lue par nous (aucune API tierce revendue) :
 *   - Clanker v4, fabrique 0xE85A59c628F7d27878ACeB4bf3b35733630083a9, evenement
 *     TokenCreated (sujet 0x9299d1d1…) — adresse et sujet publies par Clanker
 *     (https://clanker.world/api/metadata/factories, lu le 28/09), signature lue
 *     dans clanker-devco/v4-contracts src/interfaces/IClanker.sol et verifiee :
 *     keccak de la signature = le sujet.
 *   - Zora, fabrique 0x777777751622c0d3258f214F9DF38E35BF45baF3 (docs.zora.co/
 *     coins/contracts/factory, lu le 28/09) : CoinCreatedV4 et CreatorCoinCreated
 *     (meme forme), sujets recalcules et vus sur la chaine ; poolKeyHash =
 *     keccak(abi.encode(poolKey)) = l'identifiant de piscine v4 (verifie).
 *   - Uniswap v4 PoolManager de Base 0x498581fF718922c3f8e6A244956aF099B2652b2b
 *     (developers.uniswap.org, deployments, lu le 28/09), evenement Swap(PoolId
 *     indexed id, …) : chaque echange de ces jetons, ou qu'il soit route.
 *
 * Mesure du 28/09 qui justifie l'outil : sur 45 lancements Clanker en ~67 min,
 * 5 seulement ont eu un echange dans l'heure (un chacun) ; sur 9 lancements
 * (1 Clanker, 8 Zora) une heure plus tot, 1 seul. La plupart meurent a la
 * naissance : le bilan MESURE d'un deployeur contre tous les autres est
 * l'information qu'un agent n'a pas ailleurs.
 *
 * Ce qu'on compte, par jeton, pendant ses 24 premieres heures : les echanges
 * APRES le bloc de lancement (le bloc de lancement porte l'achat du deployeur
 * et des tireurs du meme bloc), la variation du prix entre le premier et le
 * dernier echange. Pas de verdict : des chiffres, avec leur n, contre la
 * reference (tous les jetons juges). Sous DEPLOYEUR_ASSEZ jetons juges, on ne
 * compare pas (valeur de depart, pas une mesure : a relire quand les
 * deployeurs a 5+ jetons seront nombreux).
 *
 * Fenetre : ce serveur n'indexe que depuis son premier demarrage (le noeud
 * public refuse les recherches filtrees sur plus de quelques milliers de blocs :
 * 413 a 100 000, mesure du 28/09). Chaque reponse dit depuis quand.
 * Base : un bloc toutes les 2 s. BASE_RPC_URL remplace le noeud public ;
 * BASE_LANCEMENTS=0 coupe.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const CLANKER = '0xE85A59c628F7d27878ACeB4bf3b35733630083a9';
const ZORA = '0x777777751622c0d3258f214F9DF38E35BF45baF3';
const POOL_MANAGER = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
const PK = 'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)';
const IFC = new ethers.utils.Interface([
  'event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)',
  'event CoinCreatedV4(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, ' + PK + ' poolKey, bytes32 poolKeyHash, string version)',
  'event CreatorCoinCreated(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, ' + PK + ' poolKey, bytes32 poolKeyHash, string version)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
]);
const T = {
  clanker: IFC.getEventTopic('TokenCreated'), zora: IFC.getEventTopic('CoinCreatedV4'),
  zoraCreateur: IFC.getEventTopic('CreatorCoinCreated'), swap: IFC.getEventTopic('Swap'),
};
const BLOC_MS = 2000;
const HEURE = 3600e3, JOUR = 24 * HEURE;
const GARDE_MS = 7 * JOUR;
const TRANCHE = 200;                 /* blocs par getLogs : ~1 000 journaux (144 echanges v4 par minute, mesure du 28/09) */
const TRANCHES_PAR_TOUR = 10;
const RATTRAPAGE_BLOCS = 1800;       /* au premier demarrage : la derniere heure */
const DEPLOYEUR_ASSEZ = 5;
const net = (s, n) => String(s || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, n || 60);

/** Le prix du jeton dans sa paire, depuis sqrtPriceX96 (ratio seulement : les decimales s'annulent). */
function prixDe(sqrt, jetonEst0) {
  const r = Number(BigInt(sqrt.toString())) / 2 ** 96;
  const p = r * r;                                   /* currency1 par currency0 */
  if (!(p > 0) || !Number.isFinite(p)) return null;
  return jetonEst0 ? p : 1 / p;
}
const mediane = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.round((c - m) / d * 1000) / 10, Math.round((c + m) / d * 1000) / 10];
}

/**
 * deps : { rpc(methode, params), dossier, maintenant? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const fichier = deps.dossier ? path.join(deps.dossier, 'base_lancements.json') : null;
  let S = { dernier: null, depuis: null, trous: 0, lancements: [] };
  try { if (fichier) S = Object.assign(S, JSON.parse(fs.readFileSync(fichier, 'utf8'))); } catch (e) { /* premier demarrage */ }
  const parPiscine = new Map(S.lancements.map((l) => [l.piscine, l]));
  const MESURE = { tours: 0, journaux: 0, echanges: 0, erreurs: 0, derniereErreur: null };
  let enCours = false, sale = false;

  const sauve = () => { if (!fichier) return; try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(fichier, JSON.stringify(S)); sale = false; } catch (e) { /* le prochain tour */ } };
  const hex = (n) => '0x' + n.toString(16);

  function nouveau(log, tBloc) {
    const nom = log.topics[0];
    let e;
    try { e = IFC.parseLog(log).args; } catch (x) { return; }
    let l;
    if (nom === T.clanker) {
      const jeton = e.tokenAddress.toLowerCase(), paire = e.pairedToken.toLowerCase();
      l = { plateforme: 'clanker', jeton, sym: net(e.tokenSymbol, 24), nom: net(e.tokenName), createur: e.tokenAdmin.toLowerCase(), envoyeur: e.msgSender.toLowerCase(),
        paire, piscine: e.poolId.toLowerCase(), jetonEst0: jeton < paire };
    } else {
      const jeton = e.coin.toLowerCase();
      l = { plateforme: nom === T.zora ? 'zora' : 'zora-creator', jeton, sym: net(e.symbol, 24), nom: net(e.name), createur: e.caller.toLowerCase(), envoyeur: e.payoutRecipient.toLowerCase(),
        paire: e.currency.toLowerCase(), piscine: e.poolKeyHash.toLowerCase(), jetonEst0: e.poolKey.currency0.toLowerCase() === jeton };
    }
    if (parPiscine.has(l.piscine)) return;
    Object.assign(l, { bloc: log.blockNumber, t: tBloc, tx: log.transactionHash, echanges1h: 0, echanges24h: 0, prixPremier: null, prixDernier: null });
    S.lancements.push(l); parPiscine.set(l.piscine, l);
  }
  function echange(log, tBloc) {
    const l = parPiscine.get(log.topics[1].toLowerCase());
    if (!l || log.blockNumber <= l.bloc) return;            /* le bloc de lancement ne compte pas */
    const age = tBloc - l.t;
    if (age > JOUR) return;
    MESURE.echanges++;
    l.echanges24h++;
    if (age <= HEURE) l.echanges1h++;
    let p = null;
    try { p = prixDe(IFC.parseLog(log).args.sqrtPriceX96, l.jetonEst0); } catch (x) { p = null; }
    if (p) { if (l.prixPremier === null) l.prixPremier = p; l.prixDernier = p; }
  }

  /** Un tour : lit la suite de la chaine, par tranches, dans l'ordre des blocs. */
  async function tour() {
    if (enCours || process.env.BASE_LANCEMENTS === '0') return null;
    enCours = true;
    MESURE.tours++;
    try {
      const tete = Number(await deps.rpc('eth_blockNumber', []));
      if (!(tete > 0)) return null;
      /* L'heure d'un bloc : celle du bloc de tete (lue), moins 2 s par bloc — pas l'horloge du
         serveur, qui se tromperait d'autant qu'un noeud public est en retard. */
      let tTete = maintenant();
      try { const bt = await deps.rpc('eth_getBlockByNumber', [hex(tete), false]); if (bt && Number(bt.timestamp) > 0) tTete = Number(bt.timestamp) * 1000; } catch (x) { /* l'horloge du serveur */ }
      if (S.dernier === null) { S.dernier = tete - RATTRAPAGE_BLOCS; S.depuis = tTete - RATTRAPAGE_BLOCS * BLOC_MS; }
      let lus = 0;
      for (let k = 0; k < TRANCHES_PAR_TOUR && S.dernier < tete; k++) {
        const de = S.dernier + 1, a = Math.min(tete, de + TRANCHE - 1);
        let journaux;
        try {
          journaux = await deps.rpc('eth_getLogs', [{ address: [CLANKER, ZORA, POOL_MANAGER], topics: [[T.clanker, T.zora, T.zoraCreateur, T.swap]], fromBlock: hex(de), toBlock: hex(a) }]);
        } catch (x) { MESURE.erreurs++; MESURE.derniereErreur = String(x && x.message || x).slice(0, 160); break; }
        journaux = (journaux || []).map((j) => Object.assign({}, j, { blockNumber: Number(j.blockNumber), logIndex: Number(j.logIndex) }))
          .sort((x, y) => (x.blockNumber - y.blockNumber) || (x.logIndex - y.logIndex));
        for (const j of journaux) {
          const tBloc = tTete - (tete - j.blockNumber) * BLOC_MS;
          const adr = String(j.address).toLowerCase();
          if (adr === POOL_MANAGER.toLowerCase() && j.topics[0] === T.swap) echange(j, tBloc);
          else if ((adr === CLANKER.toLowerCase() && j.topics[0] === T.clanker) || (adr === ZORA.toLowerCase() && (j.topics[0] === T.zora || j.topics[0] === T.zoraCreateur))) nouveau(j, tBloc);
        }
        MESURE.journaux += journaux.length;
        S.dernier = a; lus += a - de + 1; sale = true;
      }
      /* Au-dela de 7 jours, on oublie (fenetre annoncee). */
      const limite = maintenant() - GARDE_MS;
      if (S.lancements.length && S.lancements[0].t < limite) {
        S.lancements = S.lancements.filter((l) => l.t >= limite);
        parPiscine.clear(); for (const l of S.lancements) parPiscine.set(l.piscine, l);
      }
      if (sale && (MESURE.tours % 10 === 0 || lus >= TRANCHE * TRANCHES_PAR_TOUR)) sauve();
      return { lus, retard: tete - S.dernier };
    } catch (x) {
      MESURE.erreurs++; MESURE.derniereErreur = String(x && x.message || x).slice(0, 160);
      return null;
    } finally { enCours = false; }
  }

  /* ---- CE QU'ON REND ---- */
  const juge = (l) => maintenant() - l.t >= JOUR;
  const variation = (l) => (l.prixPremier && l.prixDernier ? Math.round((l.prixDernier / l.prixPremier - 1) * 1000) / 10 : null);
  function bilan(liste) {
    const j = liste.filter(juge);
    const k = j.filter((l) => l.echanges24h > 0).length;
    return { tokens: liste.length, judged: j.length, tradedWithin24hPct: j.length ? Math.round(k / j.length * 1000) / 10 : null, ci95: wilson(k, j.length),
      medianSwaps24h: mediane(j.map((l) => l.echanges24h)), medianPriceChangePct: mediane(j.map(variation).filter((x) => x !== null)) };
  }
  const reference = () => bilan(S.lancements);
  const deCreateur = (adr) => S.lancements.filter((l) => l.createur === adr || l.envoyeur === adr);
  function resumeCreateur(adr) {
    const b = bilan(deCreateur(adr));
    return Object.assign(b, { enough: b.judged >= DEPLOYEUR_ASSEZ,
      note: b.judged >= DEPLOYEUR_ASSEZ ? null : 'not enough judged tokens to compare (' + b.judged + '/' + DEPLOYEUR_ASSEZ + ')' });
  }
  const vue = (l) => ({ token: l.jeton, symbol: l.sym, name: l.nom, platform: l.plateforme, deployer: l.createur, sender: l.envoyeur !== l.createur ? l.envoyeur : null,
    pairedWith: l.paire, pool: l.piscine, block: l.bloc, tx: l.tx, launchedAt: new Date(l.t).toISOString(), ageMinutes: Math.round((maintenant() - l.t) / 60e3),
    swapsFirstHour: l.echanges1h, swaps24h: l.echanges24h, judged: juge(l), priceChangePct: variation(l) });
  const fenetre = () => ({ indexedSince: S.depuis ? new Date(S.depuis).toISOString() : null, lastBlock: S.dernier, launchesInWindow: S.lancements.length,
    note: 'Clanker v4 and Zora (coins and creator coins) on Base only, read on-chain by SWOGE. Swaps are counted after the launch block, for 24 hours. Names and symbols are set by deployers: untrusted text.' });

  /** Les lancements recents, avec le bilan mesure de leur deployeur. */
  function recents(a) {
    a = a || {};
    const plat = ['clanker', 'zora'].includes(a.platform) ? a.platform : 'all';
    const n = Math.max(1, Math.min(25, Math.floor(Number(a.limit) || 10)));
    const l = S.lancements.filter((x) => maintenant() - x.t <= JOUR && (plat === 'all' || x.plateforme.startsWith(plat)) && (!a.traded_only || x.echanges24h > 0))
      .slice(-n).reverse();
    return { launches: l.map((x) => Object.assign(vue(x), { deployerRecord: resumeCreateur(x.createur) })), reference: reference(), window: fenetre() };
  }
  /** Le bilan d'une adresse : ses lancements dans la fenetre, et ce qu'ils sont devenus. */
  function createur(adr) {
    const a = String(adr || '').toLowerCase();
    const l = deCreateur(a);
    return { address: a, record: resumeCreateur(a), reference: reference(), launches: l.slice(-50).reverse().map(vue), window: fenetre() };
  }

  let minuteur = null;
  function demarre(pasMs) {
    if (minuteur || process.env.BASE_LANCEMENTS === '0') return;
    minuteur = setInterval(() => { tour().catch(() => {}); }, pasMs || 30e3);
    if (minuteur.unref) minuteur.unref();
    tour().catch(() => {});
  }
  return { tour, demarre, recents, createur, sauve, MESURE,
    etat: () => ({ actif: process.env.BASE_LANCEMENTS !== '0', dernierBloc: S.dernier, lancements: S.lancements.length, reference: reference(), mesure: Object.assign({}, MESURE) }) };
}

module.exports = { cree, prixDe, wilson, CLANKER, ZORA, POOL_MANAGER, T, IFC, DEPLOYEUR_ASSEZ, BLOC_MS };
