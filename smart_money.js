'use strict';
/* ==================================================================
 * SMART MONEY ROBINHOOD CHAIN (13/10/2026) — LECTURE SEULE
 * ==================================================================
 *
 * Ce que fait le module (demande du proprietaire, smart_money.txt) :
 *  1. toutes les 30 min, une PASSE : decouverte des jetons qui ont depasse
 *     1 M$ (GeckoTerminal + DexScreener, sans cle), puis lecture sur la chaine
 *     de chacun (createur, piscine, lancement, 50 premiers acheteurs, ETH entre
 *     et sorti, solde, gain, marques d'initie), puis scores, createurs, liens ;
 *  2. toutes les 5 min, une VEILLE : les jetons qui naissent (Initialize v4,
 *     PoolCreated v3, PairCreated v2) et les achats des wallets smart ; alerte
 *     quand 2 smart ou plus achetent le meme nouveau jeton dans l'heure, ou
 *     quand un createur deja connu lance un jeton ;
 *  3. une fois par jour, un RAPPORT (top 20 smart, nouveaux jetons, groupes).
 *
 * Ce qu'il ne fait JAMAIS : signer, acheter, envoyer une transaction, lire une
 * cle. Le noeud ne recoit que des methodes de lecture (smart_rpc.METHODES).
 * Les alertes et le rapport partent par tg.notifyPrive (TG_BACKUP_CHAT_ID,
 * conversation privee verifiee) : jamais sur le canal public sans decision du
 * proprietaire. Un message separe TOUJOURS « Verified » (lu sur la chaine, avec
 * bloc et tx) de « Not verified » (prix d'une source exterieure, estimations).
 * On parle de WALLETS : rien n'est dit de la personne derriere.
 *
 * SMART_MONEY : vide = ETEINT (aucune minuterie, aucune requete, aucun
 * fichier ; viem et sql.js ne sont meme pas charges) ; « observe » = lit,
 * calcule, garde les alertes sans les envoyer ; « 1 » = envoie au proprietaire.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const K = require('./smart_calcul');
const SRC = require('./smart_sources');

const PASSE_MS = 30 * 60e3;          // « toutes les 30 min » (demande du proprietaire)
const VEILLE_MS = 5 * 60e3;          // 2 900 blocs : 1 appel sans adresse (200 wallets sur 30 000 blocs : 4,8 Mo en 348 ms, sonde du 13/10)
const PREMIERE_PASSE_MS = 90e3;      // apres le demarrage : laisser passer le reste du serveur
const HEURE_RAPPORT = '09:00';
const FUSEAU = 'Europe/Paris';
const CONFIRMATIONS = 20;            // ~2 s sous la pointe (les repliques reculent de 3 blocs au plus, sonde)
const VEILLE_RATTRAPAGE_MAX = 36000; // ~1 h : au-dela, l'ecart est saute et dit (CHOISI)
const HEURE_BLOCS = 36000;           // ~1 h : 34 800 a 35 900 blocs par heure (sonde) ; la borne exacte se LIT (dernierBlocAvant)
/* Lecture par acheteur : les 50 premiers DISTINCTS cherches dans les 4 h, puis
   24 h, 72 h, puis toute la vie, dans la limite du budget (la suite reprend sur
   le cache). Revue C5 du 13/10 : bornee a 24 h, NOVAAI n'avait que 7 premiers
   (le 8e au bloc 41 136 454, le 50e 1 077 643 blocs apres le lancement, ~30 h) :
   son taux de base reposait sur 5 issues. Le nombre lu est montre sous 50. */
const DEBUT_HEURES = [4, 24, 72, Infinity];
/* +/- autour de l'estimation, pour le seul Initialize v4 (unique par piscine).
   En v2/v3 la naissance est le 1er journal de la piscine, cherche depuis le bloc
   0 : revue INI-02, la fenetre de 400 000 blocs avait retenu pour astro le bloc
   58 434 470 au lieu de 57 852 996 (tx 0xb31ee728…), 16 h trop tard, et effacait
   toutes les marques du vrai lancement (13 wallets groupes dans son 1er bloc). */
const RECHERCHE_NAISSANCE = 400000;
/* Financement WETH lu sur les 65 536 blocs (~1 h 50) avant le lancement et la
   1re heure : CHOISI (revue INI-05 : aucune mesure ; 10 lectures reelles, toutes
   vides). L'ETH natif ne laisse aucun journal : il n'est PAS lu (dit). */
const FINANCEMENT_AVANT = 65536;
const LIGNES_TOUT_MAX = 60000;       // au-dela : lecture par acheteur. NILF = 28 387 Transfer = 17,4 Mo (sonde) ; CHOISI
const NOUVEAU_S = 24 * 3600;         // un « nouveau » jeton : piscine ETH nee depuis moins de 24 h (CHOISI)
const RETRAIT_RUG = 0.9;             // « liquidite retiree » : >= 90 % de ce qui a ete ajoute (CHOISI)
const SMART_VEILLE_MAX = 998;        // 1 000 valeurs par requete au plus (message du noeud, sonde) - 2 topics fixes
const VEILLE_CREUSE = 5;             // recherches de la 1re trace d'un jeton par veille (CHOISI : ~150 piscines/h, budget de 60 appels)
/* budget d'une veille de 5 min : CHOISI (l'essai de bout en bout en use 20 pour
   2 naissances et 4 achats ; 3 fois plus de marge) */
const VEILLE_APPELS = 60, VEILLE_OCTETS = 30e6;
const JOURNAL_MAX = 200;
const PURGE_VEILLE_MS = 24 * 3600e3; // recus et tx de la veille : inutiles apres 24 h (NOUVEAU_S ; revue N8)
/* Les rampes de lancement lues : l'evenement nomme le createur (topic 2).
   0x1eef… : 38 lancements de 0xa631… (LaunchMetadata, rapport verifie le 13/10). */
const RAMPES = [{ adresse: '0x1eef016f22a943abc7dd11422edee9d235942104', topic: '0x04c10fe2cc69507cbff4c84fc99414ca507db49d5c39eff84b67ea319f43ccf0' }];
/* Fabriques v3 et v2 qui emettent (sonde du 13/10 : F3 220 piscines / 24 h, une
   deuxieme fabrique v3 ; F2 2 037 paires / 24 h, une deuxieme fabrique v2). */
const FABRIQUES_V3 = ['0x1f7d7550b1b028f7571e69a784071f0205fd2efa', '0xe7fef2bc860b25bbdeb6f6ab96d88baaa77ddad7'];
const FABRIQUES_V2 = ['0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f', '0x0d1ebb179cdbca88d74c923c4255cb2b17474afd'];
const TOPIC_MODIFY_V4 = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';   // vu dans la tx de lancement de NILF (13/10)
const SOCLE = new Set([K.ADR.WETH, K.ADR.USDG, K.ADR.ETH_NATIF, K.ADR.ETH_GT]);

// ------------------------------------------------------------ reglages

function config(env) {
  const e = env || process.env;
  const brut = String(e.SMART_MONEY || '').trim();
  const mode = brut === '' ? 'off' : brut === 'observe' ? 'observe' : brut === '1' ? 'envoi' : 'inconnu';
  const h = String(e.SMART_MONEY_HEURE || HEURE_RAPPORT).trim();
  const heure = /^([01]?\d|2[0-3]):[0-5]\d$/.test(h) ? h : HEURE_RAPPORT;
  const url = String(e.SMART_RPC_URL || '').trim();
  return { brut, mode, heure, rpcPropre: !!url, rpcUrl: url || null };
}

function heureLocale(t) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: FUSEAU, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = {}; for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { jour: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const minutesDe = (h) => { const m = /^(\d{1,2}):(\d{2})$/.exec(h); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
const big = (x) => (x == null || x === '' ? null : BigInt(x));
const jsonOu = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };

// ------------------------------------------------------------ l'instance

/**
 * deps :
 *   tg          { notifyPrive(texte) -> Promise<bool> }
 *   prendre     fetch ; horloge ; dors
 *   dossier     DATA_DIR (le module ecrit dans DATA_DIR/smart_money/)
 *   env         remplace process.env (essais)
 *   explorer    pages humaines (config.EXPLORER)
 *   rpc, sources, base   instances injectees (essais) ; sinon creees a l'allumage
 *   actions     async () -> Map adresse -> fiche (registre officiel) ; defaut actions_rh
 *   minuteries  false : aucune minuterie (les essais appellent passe/veille)
 *   lignesToutMax  remplace LIGNES_TOUT_MAX (essais : forcer la lecture par acheteur)
 */
function cree(deps0) {
  const cfgG = (() => { try { return require('./config'); } catch (e) { return {}; } })();
  const deps = Object.assign({
    horloge: () => Date.now(),
    dors: (ms) => new Promise((r) => setTimeout(r, ms)),
    prendre: (...a) => fetch(...a),
    dossier: cfgG.DATA_DIR || './data',
    explorer: cfgG.EXPLORER || 'https://robinhoodchain.blockscout.com',
    tg: null,
  }, deps0 || {});
  const C = config(deps.env);
  const D = path.join(deps.dossier, 'smart_money');
  let B = null, R = null, RV = null, S = null;
  let enCours = null;
  const journal = [];
  /* tout ce qui est journalise ou servi passe par masque() : jamais l'URL du noeud (revue N5) */
  const masque = (x) => { let t = String(x == null ? '' : x); if (C.rpcUrl) t = t.split(C.rpcUrl).join('<node>'); return t.replace(/URL: \S+/g, 'URL: <node>'); };
  const note = (genre, texte) => { journal.push({ t: deps.horloge(), genre, texte: masque(texte).slice(0, 300) }); if (journal.length > JOURNAL_MAX) journal.shift(); };
  let instantane = null;

  async function allume() {
    if (B) return;
    if (C.mode !== 'observe' && C.mode !== 'envoi') throw new Error('smart money eteint');
    B = deps.base || await require('./smart_base').ouvre(path.join(D, 'base.sqlite'), { horloge: deps.horloge });
    /* deux clients du noeud : la passe (600 appels) et la veille (60), chacun son
       budget, un SEUL espacement (rythme partage) : la veille ne s'arrete plus
       pendant une passe de 15 a 20 min (GeckoTerminal a 60 s), et le noeud ne
       voit jamais deux appels plus rapproches que la regle. */
    const SR = require('./smart_rpc'), rythme = SR.nouveauRythme();
    const opts = Object.assign({ url: C.rpcUrl || SR.URL_DEFAUT, prendre: deps.prendre, horloge: deps.horloge, dors: deps.dors, dossier: D, rythme }, deps.rpcOptions || {});
    R = deps.rpc || SR.cree(opts);
    RV = deps.rpcVeille || deps.rpc || SR.cree(Object.assign({}, opts, { budgetAppels: VEILLE_APPELS, budgetOctets: VEILLE_OCTETS, prefixeHash: 'V' }));
    S = deps.sources || SRC.cree({ prendre: deps.prendre, horloge: deps.horloge, dors: deps.dors, dossier: D });
    if (!instantane) instantane = construitVue();
  }
  async function actionsOfficielles() {
    if (deps.actions) return deps.actions();
    const reg = await require('./actions_rh').cree({ fetch: deps.prendre }).registre();
    return reg.parAdr;
  }

  // ---------------------------------------------------------- envoyer
  async function envoie(genre, cle, jeton, texte) {
    const deja = B.un('SELECT id FROM alertes WHERE cle = ?', [cle]);
    if (deja) return false;
    let ok = false;
    if (C.mode === 'envoi' && deps.tg && typeof deps.tg.notifyPrive === 'function') {
      try { ok = !!(await deps.tg.notifyPrive(texte)); } catch (e) { ok = false; }
    }
    B.pose('alertes', { t: Math.floor(deps.horloge() / 1000), genre, cle, jeton, texte, envoye: ok ? 1 : 0 });
    note('alerte', `${genre} ${jeton || ''} ${C.mode === 'envoi' ? (ok ? 'envoyee' : 'REFUSEE par Telegram') : 'gardee (observe)'}`);
    return ok;
  }

  // ---------------------------------------------------------- 1. decouverte
  const ROTATION = [['vol', [1, 2, 3, 4, 5]], ['vol', [6, 7, 8, 9, 10]], ['tx', [1, 2, 3, 4, 5]], ['tx', [6, 7, 8, 9, 10]]];
  async function decouverte(bilan) {
    const vus = [];
    for (let p = 1; p <= 4; p++) { const l = await S.nouvelles(p); if (!l) break; vus.push(...l); }
    const r = (B.meta('rotation') || 0) % ROTATION.length;
    const [tri, pages] = ROTATION[r];
    for (const p of pages) { const l = await S.piscines(tri, p); if (!l) break; vus.push(...l); }
    B.meta('rotation', r + 1);
    let actions = new Map();
    try { actions = await actionsOfficielles(); } catch (e) { note('sources', 'registre des actions illisible : ' + e.message + ' — passe de decouverte sans exclusion des actions, rien n est retenu'); return 0; }
    const externes = new Set(B.meta('externes') || []);
    const x = { socle: SOCLE, actions, externes };
    /* le jeton d'une piscine : le cote qui n'est ni du socle ni une action */
    const parJeton = new Map();
    for (const p of vus) {
      const cote = !x.socle.has(p.base.adresse) && !actions.has(p.base.adresse) ? p.base : (!x.socle.has(p.quote.adresse) && !actions.has(p.quote.adresse) ? p.quote : null);
      if (!cote || !K.estAdresse(cote.adresse)) continue;
      const autre = cote === p.base ? p.quote : p.base;
      const v = Object.assign({}, p, { base: cote, quote: autre });
      if (!parJeton.has(cote.adresse)) parJeton.set(cote.adresse, []);
      parJeton.get(cote.adresse).push(v);
    }
    const copiesVues = SRC.copies([...parJeton.entries()].map(([a, l]) => ({ adresse: a, symbole: l[0].base.symbole, actifs24: Math.max(...l.map((p) => p.actifs24 || 0)) })));
    let nouveaux = 0, pics = 0;
    for (const [jeton, l] of parJeton) {
      if (SRC.exclu(jeton, x) || copiesVues.has(jeton)) continue;
      const deja = B.un('SELECT adresse, statut, pic_usd FROM jetons WHERE adresse = ?', [jeton]);
      let garde = null;
      for (const p of l) {
        const j = SRC.jugeActuel(p, x);
        if (j.externe) { externes.add(jeton); break; }
        if (j.garde) { garde = { cap: p.fdv, source: 'geckoterminal fdv (' + p.dex + ')', pool: p.pool }; break; }
      }
      if (externes.has(jeton)) continue;
      if (!garde && !deja) {
        const best = l.filter((p) => SRC.cotationSure(p.quote.adresse, x) && p.fdv != null && p.prixUsd > 0).sort((a, b) => b.fdv - a.fdv)[0];
        const vuPic = B.meta('pic:' + jeton);
        if (best && best.fdv >= SRC.PIC_CANDIDAT_USD && !vuPic) {
          const r = await S.pic(best.pool, jeton);
          if (r) {
            B.meta('pic:' + jeton, { t: deps.horloge(), ok: !!r.pic });
            pics++;
            const offre = best.fdv / best.prixUsd;           // offre implicite de la source (Not verified)
            if (r.pic && r.pic.prix * offre >= K.SEUIL_CAP_USD) garde = { pic: r.pic.prix * offre, picJour: new Date(r.pic.t * 1000).toISOString().slice(0, 10), source: 'geckoterminal daily close × implied supply', pool: best.pool };
          }
        }
      }
      if (!garde || deja) continue;
      nouveaux++;
      B.pose('jetons', { adresse: jeton, symbole: l[0].base.symbole, statut: 'a_lire', cap_usd: garde.cap || null, cap_source: garde.cap ? garde.source : null,
        pic_usd: garde.pic || null, pic_jour: garde.picJour || null, pic_source: garde.pic ? garde.source : null, vu_t: Math.floor(deps.horloge() / 1000), source: garde.pool });
    }
    B.meta('externes', [...externes]);
    bilan.retenus = nouveaux; bilan.pics = pics;
    return nouveaux;
  }

  // ---------------------------------------------------------- 2. lecture d'un jeton
  /** La table des migrations (MigratorCreated de la fabrique), avec l'operateur
   *  (tx.from) : nouveau -> { ancien, migrateur, operateur, bloc, tx }. */
  async function migrations(P) {
    const { logs } = await R.lisLogs({ address: K.ADR.FABRIQUE_MIGRATIONS, topics: [K.TOPIC.MIGRATOR_CREATED] }, 0, P.pointe, P);
    const ev = logs.map(K.decode).filter(Boolean);
    const txs = await R.transactions([...new Set(ev.map((e) => e.tx))], P.sure);
    const m = new Map();
    for (const e of ev) { const t = txs.get(e.tx); m.set(e.nouveau, { ancien: e.ancien, migrateur: e.migrateur, operateur: t ? String(t.from).toLowerCase() : null, bloc: e.bloc, tx: e.tx }); }
    return m;
  }

  /** La naissance d'une piscine : v4 = Initialize du PoolManager ; v2/v3 = 1er
   *  journal de la piscine (et token0/token1 lus par eth_call). Recherche
   *  autour de l'estimation, puis sur toute la chaine. */
  async function naissance(paire, jeton, P, estimation) {
    const fen = estimation != null ? [Math.max(0, estimation - RECHERCHE_NAISSANCE), Math.min(P.pointe, estimation + RECHERCHE_NAISSANCE)] : null;
    if (paire.version === 4 || K.estPool4(paire.pool)) {
      const f = { address: K.ADR.POOL_MANAGER_V4, topics: [K.TOPIC.INIT_V4, paire.pool] };
      let l = fen ? (await R.lisLogs(f, fen[0], fen[1], P)).logs : [];
      if (!l.length) l = (await R.lisLogs(f, 0, P.pointe, Object.assign({}, P, { premier: true }))).logs;
      const init = l.map(K.decode).find((e) => e && e.genre === 'init');
      return init ? K.piscineEth(init, jeton) : null;
    }
    if (!K.estAdresse(paire.pool)) return null;
    /* v2/v3 : le 1er journal de la piscine, depuis le bloc 0 (jamais dans une
       fenetre : rien ne prouverait qu'aucun journal n'existe avant) */
    const f = { address: paire.pool };
    const l = (await R.lisLogs(f, 0, P.pointe, Object.assign({}, P, { premier: true }))).logs;
    if (!l.length) return null;
    const premier = l[0];
    const [t0, t1] = await R.multicall([{ to: paire.pool, fn: 'token0' }, { to: paire.pool, fn: 'token1' }]);
    if (!t0 || !t1) return null;
    const init = { genre: 'init', version: paire.version || 3, pool: paire.pool, c0: String(t0).toLowerCase(), c1: String(t1).toLowerCase(), hook: null, bloc: parseInt(premier.blockNumber, 16), tx: String(premier.transactionHash).toLowerCase() };
    return K.piscineEth(init, jeton);
  }

  /** Le 1er journal d'un jeton -> sa tx de creation ; attribution du createur. */
  async function createurDe(jeton, avant, P, M, piscine) {
    let tx = null;
    if (piscine) {
      const rc = (await R.recus([piscine.tx], P.sure)).get(piscine.tx);
      if (rc && (String(rc.contractAddress || '').toLowerCase() === jeton || (rc.logs || []).some((l) => String(l.address).toLowerCase() === jeton && String(l.topics[0]).toLowerCase() === K.TOPIC.TRANSFER && K.adrDe(l.topics[1]) === K.ADR.ETH_NATIF))) tx = piscine.tx;
    }
    if (!tx) {
      const { logs } = await R.lisLogs({ address: jeton }, 0, avant, Object.assign({}, P, { premier: true }));
      if (!logs.length) return { role: 'inconnu', qui: null, verifie: false };
      tx = String(logs[0].transactionHash).toLowerCase();
    }
    const [rc, t] = [(await R.recus([tx], P.sure)).get(tx), (await R.transactions([tx], P.sure)).get(tx)];
    return Object.assign(K.attribueCreateur({ jeton, tx: t, recu: rc, migration: M.get(jeton) }), { jeton });
  }

  /** Le dernier bloc dont l'heure est <= t, a partir de `bloc` (dont l'heure
   *  est <= t) : recherche par lots de 19 en-tetes, l'intervalle divise par 20
   *  a chaque tour (40 000 blocs -> 1 en 4 a 5 lots), sans supposer la cadence. */
  async function dernierBlocAvant(bloc, t, P) {
    let bas = bloc, haut = Math.min(P.pointe, bloc + 40000);
    const th = (await R.horodatages([haut], P.sure)).get(haut);
    if (th != null && th <= t) return haut;
    while (haut - bas > 1) {
      const pas = Math.max(1, Math.ceil((haut - bas) / 20));
      const pts = []; for (let x = bas + pas; x < haut; x += pas) pts.push(x);
      const h = await R.horodatages(pts, P.sure);
      let nb = bas, nh = haut;
      for (const x of pts) { const tx = h.get(x); if (tx != null && tx <= t) nb = x; else { nh = x; break; } }
      bas = nb; haut = nh;
    }
    return bas;
  }

  /** Lit un jeton retenu. Leve BudgetEpuise/AbandonPasse : la passe s'arrete,
   *  le jeton reste « a_lire » et la suite reprend sur le cache. */
  async function litJeton(row, P, M) {
    const jeton = row.adresse;
    const infos = await R.infosJeton(jeton);
    if (infos.offre == null || infos.decimales == null) { B.ecris("UPDATE jetons SET statut = 'erreur', erreur = ? WHERE adresse = ?", ['totalSupply or decimals unreadable', jeton]); return; }
    /* les piscines ETH du jeton (DexScreener token-pairs : toutes les paires) */
    const paires = (await S.pairesDs(jeton)) || [];
    const ethP = paires.filter((p) => p.base.adresse === jeton && SOCLE.has(p.quote.adresse) && p.quote.adresse !== K.ADR.USDG || p.quote.adresse === jeton && SOCLE.has(p.base.adresse) && p.base.adresse !== K.ADR.USDG);
    /* DexScreener ne rend plus la paire (HM le 14/10 : « [] » alors que la piscine
       v4 0xa8119e5e… vit) : la piscine deja lue, puis celle de la decouverte */
    if (!ethP.length && row.piscine && (K.estPool4(row.piscine) || K.estAdresse(row.piscine))) ethP.push({ pool: row.piscine, version: row.version || (K.estPool4(row.piscine) ? 4 : null) });
    if (!ethP.length && row.source && K.estPool4(row.source)) ethP.push({ pool: row.source, version: 4 });
    const piscines = [];
    for (const p of ethP.slice(0, 4)) {
      const est = p.creee ? P.pointe - Math.round((deps.horloge() - p.creee) / 103.4) : null;   // 0,1034 s/bloc sur la derniere heure (sonde)
      const ps = await naissance(p, jeton, P, est);
      if (ps) piscines.push(ps);
    }
    if (!piscines.length) { B.ecris("UPDATE jetons SET statut = 'erreur', erreur = ? WHERE adresse = ?", ['no ETH pool found on chain', jeton]); return; }
    piscines.sort((a, b) => a.bloc - b.bloc);
    const lance = piscines[0];
    const [t0] = [(await R.horodatages([lance.bloc], P.sure)).get(lance.bloc)];
    const cr = await createurDe(jeton, lance.bloc, P, M, lance);
    const mig = M.get(jeton);
    let ancien = null;
    if (mig) {
      const ca = await createurDe(mig.ancien, P.pointe, P, new Map(), null);
      ancien = { jeton: mig.ancien, createur: ca.qui, role: ca.role, bloc: ca.bloc, tx: ca.tx, operateur: mig.operateur };
    }
    const proches = new Set([cr.qui, cr.via, mig && mig.operateur, mig && mig.migrateur, ancien && ancien.createur].filter((a) => a && K.estAdresse(a)));

    const filtresSwap = piscines.map((p) => (p.version === 4 ? { address: K.ADR.POOL_MANAGER_V4, topics: [K.TOPIC.SWAP_V4, p.pool] } : { address: p.pool, topics: [p.version === 2 ? K.TOPIC.SWAP_V2 : K.TOPIC.SWAP_V3] }));
    const fT = { address: jeton, topics: [K.TOPIC.TRANSFER] };
    /* les contrats du lancement (fabrique, migrateur) ne sont jamais beneficiaires ;
       les WALLETS proches (createur, operateur, createur de l'ancien jeton) le
       peuvent : leur achat va dans la recette, jamais dans les 50 premiers */
    const infra = [cr.via, mig && mig.migrateur].filter((a) => a && K.estAdresse(a));

    /* la vie : tout lire si elle tient, sinon par acheteur */
    let mode = 'tout', evts = [];
    try {
      const T = (await R.lisLogs(fT, lance.bloc, P.pointe, Object.assign({}, P, { maxLignes: deps.lignesToutMax || LIGNES_TOUT_MAX }))).logs;
      const Sw = [];
      for (const f of filtresSwap) Sw.push(...(await R.lisLogs(f, lance.bloc, P.pointe, Object.assign({}, P, { maxLignes: deps.lignesToutMax || LIGNES_TOUT_MAX }))).logs);
      evts = [...T, ...Sw].map(K.decode).filter(Boolean);
    } catch (e) {
      if (!e.tropDeLignes) throw e;
      mode = 'acheteur';
    }
    /* les 50 premiers acheteurs DISTINCTS (pas seulement ceux de la 1re heure :
       ceux de BRODIE s'etalent sur 97 min, calibrage du 13/10) */
    let debut = evts;
    if (mode === 'acheteur') {
      for (const h of DEBUT_HEURES) {
        const haut = h === Infinity ? P.pointe : Math.min(P.pointe, lance.bloc + h * HEURE_BLOCS);
        const T = (await R.lisLogs(fT, lance.bloc, haut, P)).logs;
        const Sw = []; for (const f of filtresSwap) Sw.push(...(await R.lisLogs(f, lance.bloc, haut, P)).logs);
        debut = [...T, ...Sw].map(K.decode).filter(Boolean);
        if (K.premiersAcheteurs(K.echanges({ jeton, piscines, evts: debut, infra }), { exclus: [...proches] }).length >= K.N_ACHETEURS || haut >= P.pointe) break;
      }
    }
    const tradesDebut = K.echanges({ jeton, piscines, evts: debut, infra });
    const premiers = K.premiersAcheteurs(tradesDebut, { exclus: [...proches] });
    /* la 1re heure : son dernier bloc, LU dans les en-tetes (34 800 a 35 900
       blocs par heure selon le mois, sonde du 13/10 : jamais 36 000 fixe) */
    const finHeure = t0 == null ? null : await dernierBlocAvant(lance.bloc, t0 + K.TOT_S, P);
    const tradesHeure = finHeure == null ? [] : tradesDebut.filter((t) => t.bloc <= finHeure);
    const achatsHeure = tradesHeure.filter((t) => t.sens === 'achat' && t.eth >= K.MISE_MIN_WEI);
    const finMinute = t0 == null ? null : await dernierBlocAvant(lance.bloc, t0 + K.ROBOTS_S, P);
    const blocsT = await R.horodatages([...new Set(premiers.map((p) => p.bloc))], P.sure);
    const tDe = (b) => blocsT.get(b);

    /* les evenements de la vie des 50 */
    let txLues = null;
    if (mode === 'acheteur') {
      const txs = new Set();
      for (const p of premiers) {
        for (const topics of [[K.TOPIC.TRANSFER, K.pad32(p.qui)], [K.TOPIC.TRANSFER, null, K.pad32(p.qui)]]) {
          const { logs } = await R.lisLogs({ address: jeton, topics }, lance.bloc, P.pointe, P);
          for (const l of logs) txs.add(String(l.transactionHash).toLowerCase());
        }
      }
      const rcs = await R.recus([...txs], P.sure);
      evts = [];
      for (const rc of rcs.values()) for (const l of rc.logs || []) { const e = K.decode(l); if (e) evts.push(e); }
      txLues = new Set([...rcs.keys()].map((h) => String(h).toLowerCase()));
    } else {
      /* en lecture « tout », les FRAIS (crochet, routeur) ne sont que dans les
         recus : on lit ceux des echanges des 50 premiers (revue C1) */
      const P50 = new Set(premiers.map((p) => p.qui));
      const leurs = [...new Set(K.echanges({ jeton, piscines, evts, infra }).filter((t) => P50.has(t.qui)).map((t) => t.tx))];
      const rcs = await R.recus(leurs, P.sure);
      for (const rc of rcs.values()) for (const l of rc.logs || []) { const e = K.decode(l); if (e && (e.genre === 'frais_crochet' || e.genre === 'frais_routeur')) evts.push(e); }
      txLues = new Set([...rcs.keys()].map((h) => String(h).toLowerCase()));
    }
    const trades = K.echanges({ jeton, piscines, evts, infra, txLues });
    /* le prix : le dernier Swap lu de la piscine principale */
    let dernierSwap = null;
    if (mode === 'tout') {
      for (const e of evts) if (e.genre === 'swap' && e.pool === lance.pool && (!dernierSwap || e.bloc > dernierSwap.bloc || (e.bloc === dernierSwap.bloc && e.i > dernierSwap.i))) dernierSwap = e;
    } else {
      /* par acheteur, les recus des 50 ne disent PAS le dernier prix (essai du
         13/10 : un vieux prix de leurs ventes, -0,01 ETH au lieu de -0,99) :
         on lit les Swap de la piscine depuis la pointe, fenetre elargie tant
         qu'elle est vide (2^20, 2^23 blocs, puis toute la vie) */
      const f = filtresSwap[piscines.indexOf(lance)];
      for (const largeur of [2 ** 20, 2 ** 23, Infinity]) {
        const de = largeur === Infinity ? lance.bloc : Math.max(lance.bloc, P.pointe - largeur);
        const l = (await R.lisLogs(f, de, P.pointe, P)).logs.map(K.decode).filter(Boolean);
        if (l.length) { dernierSwap = l[l.length - 1]; break; }
        if (de === lance.bloc) break;
      }
    }
    let prix = null;
    if (dernierSwap && dernierSwap.sqrtP != null) prix = K.prixDepuisSqrt(dernierSwap.sqrtP, lance.ethEst0);
    else if (lance.version === 2) {
      /* v2 : le Swap ne porte pas de prix ; les soldes de la paire (= reserves apres Sync) */
      const [rEth, rJ] = await R.multicall([{ to: K.ADR.WETH, fn: 'balanceOf', args: [lance.pool] }, { to: jeton, fn: 'balanceOf', args: [lance.pool] }]);
      if (rEth != null && rJ != null) prix = K.prixDepuisReserves(rEth, rJ);
    }
    const soldes = await R.soldes(jeton, premiers.map((p) => p.qui));

    /* les financements lus (WETH du createur — et, pour une migration, du
       createur de l'ANCIEN jeton : revue INI-05 — vers les 50, avant leur achat) */
    let financements = [];
    const financeurs = [...new Set([cr.qui, ancien && ancien.createur].filter((a) => a && K.estAdresse(a)))];
    if (financeurs.length && premiers.length) {
      const { logs } = await R.lisLogs({ address: K.ADR.WETH, topics: [K.TOPIC.TRANSFER, financeurs.map(K.pad32), premiers.map((p) => K.pad32(p.qui))] }, Math.max(0, lance.bloc - FINANCEMENT_AVANT), Math.min(P.pointe, lance.bloc + HEURE_BLOCS), P);
      financements = logs.map(K.decode).filter(Boolean);
    }
    const groupes = K.marqueGroupes(achatsHeure);
    const pairesH = K.marquePaires(achatsHeure.map((a) => ({ qui: a.qui, cle: a.bloc, bloc: a.bloc, eth: a.eth, tx: a.tx, jeton })));
    /* le drapeau « contrat » (revue INI-14 : 1 contrat sur 291 beneficiaires, NILF
       #13) : eth_getCode ni '0x' ni 0xef0100… (delegation EIP-7702) */
    const codesW = premiers.length ? await R.codes(premiers.map((p) => p.qui)) : new Map();
    const parW = new Map();
    for (const e of evts) if (e.genre === 'transfer' && e.jeton === jeton) for (const a of [e.de, e.vers]) { if (!parW.has(a)) parW.set(a, []); parW.get(a).push(e); }
    const exclusSorties = new Set([K.ADR.POOL_MANAGER_V4, ...piscines.map((p) => p.pool).filter(K.estAdresse), ...K.BRULES]);
    const lignes = [];
    let rang = 0;
    for (const p of premiers) {
      rang++;
      const tr = parW.get(p.qui) || [];
      const pos = K.position(p.qui, trades, tr);
      const solde = soldes.get(p.qui);
      const g = K.gain({ entre: pos.entre, sorti: pos.sorti, solde: solde == null ? null : BigInt(solde), prix });
      const txEch = new Set(trades.filter((t) => t.qui === p.qui).map((t) => t.tx));
      const sorties = tr.filter((t) => t.de === p.qui && !txEch.has(t.tx) && !exclusSorties.has(t.vers));
      const relais = K.marqueRelais(pos, sorties);
      if (relais && pos.premierAchat) {
        /* le nonce de la tx d'achat (revue INI-11) : montre, pas une condition */
        const t1 = (await R.transactions([pos.premierAchat.tx], P.sure)).get(pos.premierAchat.tx);
        if (t1 && t1.nonce != null) relais.nonceAchat = parseInt(t1.nonce, 16);
      }
      const mq = K.marques({
        qui: p.qui, groupes, paires: pairesH,
        relais,
        renvoi: K.marqueRenvoi(p.qui, tr, proches, txEch),
        finance: pos.premierAchat ? K.marqueFinance(p.qui, pos.premierAchat.bloc, financements, proches) : null,
      });
      const t = tDe(p.bloc);
      const code = codesW.get(p.qui);
      lignes.push({ jeton, wallet: p.qui, rang, bloc: p.bloc, t: t == null ? null : t, minutes: K.minutesApres(t, t0), tot: finHeure != null && p.bloc <= finHeure, tx: p.tx,
        entre: pos.entre, sorti: pos.sorti, solde: solde == null ? null : BigInt(solde), gain: g, issue: K.issue(pos, g), cout_connu: pos.coutConnu, marques: mq,
        mise: p.eth, frais: pos.frais, frais_lus: pos.fraisLus, contrat: code == null ? null : (code !== '0x' && !/^0xef0100/i.test(code)) });
    }
    /* la recette */
    const achatCreateur = tradesHeure.some((t) => t.sens === 'achat' && proches.has(t.qui));
    let bruleParCreateur = false;
    if (cr.qui) {
      const { logs } = await R.lisLogs({ address: jeton, topics: [K.TOPIC.TRANSFER, K.pad32(cr.qui)] }, lance.bloc, Math.min(P.pointe, lance.bloc + 24 * HEURE_BLOCS), P);
      bruleParCreateur = logs.map(K.decode).some((e) => e && K.BRULES.has(e.vers));
    }
    const robots = finMinute == null ? null : new Set(tradesHeure.filter((t) => t.sens === 'achat' && t.bloc <= finMinute).map((t) => t.qui)).size;   // acheteurs lus ; « robots » : deduit
    const prof = await S.profilDs(jeton);
    const recette = K.recette({ achatCreateur, bruleParCreateur, robots, profilApresS: prof && prof.t && t0 != null ? Math.round(prof.t / 1000 - t0) : null });

    /* drapeaux et liquidite */
    const drapeaux = [];
    {
      const { logs } = await R.lisLogs({ address: jeton, topics: [K.TOPIC.TRANSFER, K.pad32(K.ADR.MORT)] }, lance.bloc, P.pointe, P);
      const sorties = logs.map(K.decode).filter(Boolean);
      if (sorties.length) {
        const plus = sorties.reduce((a, b) => (b.valeur > a.valeur ? b : a));
        drapeaux.push({ type: 'sortie_de_dead', valeur: plus.valeur.toString(), decimales: infos.decimales, bloc: plus.bloc, tx: plus.tx, vers: plus.vers, n: sorties.length });
      }
    }
    const liquidite = await liquiditeDe(lance, P);

    /* le pic : cloture journaliere x totalSupply LU (Not verified : prix exterieur) */
    let pic = row.pic_usd != null ? { usd: row.pic_usd, jour: row.pic_jour, source: row.pic_source } : null;
    const offreUnites = K.unites(infos.offre, infos.decimales);
    const r = await S.pic(lance.pool, jeton);
    if (r && r.pic) pic = { usd: r.pic.prix * offreUnites, jour: new Date(r.pic.t * 1000).toISOString().slice(0, 10), source: 'geckoterminal daily close × totalSupply read on chain', meche: r.meche ? r.meche.prix * offreUnites : null };

    const base = K.tauxBase(lignes.map((l) => ({ tot: l.tot, issue: l.issue, marques: l.marques })));
    B.transaction(() => {
      B.ecris('DELETE FROM acheteurs WHERE jeton = ?', [jeton]);
      for (const l of lignes) B.pose('acheteurs', l);
      B.pose('jetons', Object.assign({}, row, {
        symbole: infos.symbole || row.symbole, nom: infos.nom, decimales: infos.decimales, offre: infos.offre,
        statut: 'lu', mode, erreur: null, lancement_bloc: lance.bloc, lancement_t: t0 == null ? null : t0, lancement_tx: lance.tx,
        piscine: lance.pool, version: lance.version, eth_est0: lance.ethEst0, crochet: lance.hook,
        createur: cr.qui, role_createur: cr.role, createur_verifie: cr.verifie, createur_bloc: cr.bloc || null, createur_tx: cr.tx || null, via: cr.via || null,
        ancien: mig ? mig.ancien : null,
        pic_usd: pic ? pic.usd : null, pic_jour: pic ? pic.jour : null, pic_source: pic ? pic.source : null,
        prix_num: prix ? prix.num : null, prix_den: prix ? prix.den : null, prix_bloc: dernierSwap ? dernierSwap.bloc : null,
        base_n: base.n, base_gagnants: base.gagnants,
        recette, drapeaux, liquidite, profil_t: prof && prof.t ? Math.round(prof.t / 1000) : null,
        lu_t: Math.floor(deps.horloge() / 1000),
        details: { ancien, picMeche: pic && pic.meche, premiersBloc: premiers.length ? premiers[premiers.length - 1].bloc : null, nPremiers: premiers.length, prixTx: dernierSwap ? dernierSwap.tx : null,
          finHeure, robotsBloc: finMinute },
      }));
    });
  }

  /** La liquidite de la piscine principale, lue sur la chaine. v2 : jetons LP
   *  (frappes, retires par la paire, a 0x…dead) ; v4 : ModifyLiquidity du pool ;
   *  v3 : non lue (dit). */
  async function liquiditeDe(p, P) {
    if (p.version === 2) {
      const { logs } = await R.lisLogs({ address: p.pool, topics: [K.TOPIC.TRANSFER] }, p.bloc, P.pointe, P);
      let frappe = 0n, retire = 0n, maxRetrait = null;
      for (const e of logs.map(K.decode).filter(Boolean)) {
        if (e.de === K.ADR.ETH_NATIF && e.vers !== K.ADR.ETH_NATIF) frappe += e.valeur;
        if (e.de === p.pool && e.vers === K.ADR.ETH_NATIF) { retire += e.valeur; if (!maxRetrait || e.valeur > maxRetrait.v) maxRetrait = { v: e.valeur, bloc: e.bloc, tx: e.tx }; }
      }
      const [offre, mort] = await R.multicall([{ to: p.pool, fn: 'totalSupply' }, { to: p.pool, fn: 'balanceOf', args: [K.ADR.MORT] }]);
      return { version: 2, brulePct: offre && mort != null ? Number(mort * 10000n / (offre || 1n)) / 100 : null, retirePct: frappe ? Number(retire * 10000n / frappe) / 100 : 0,
               plusGrosRetrait: maxRetrait ? { bloc: maxRetrait.bloc, tx: maxRetrait.tx } : null };
    }
    if (p.version === 4) {
      const { logs } = await R.lisLogs({ address: K.ADR.POOL_MANAGER_V4, topics: [TOPIC_MODIFY_V4, p.pool] }, p.bloc, P.pointe, P);
      let ajoute = 0n, retire = 0n, maxRetrait = null;
      for (const l of logs) {
        const w = String(l.data).slice(2).match(/.{64}/g) || [];
        if (w.length < 3) continue;
        let d = BigInt('0x' + w[2]); if (d >= 2n ** 255n) d -= 2n ** 256n;
        if (d > 0n) ajoute += d; else if (d < 0n) { retire -= d; if (!maxRetrait || -d > maxRetrait.v) maxRetrait = { v: -d, bloc: parseInt(l.blockNumber, 16), tx: String(l.transactionHash).toLowerCase() }; }
      }
      return { version: 4, brulePct: null, retirePct: ajoute ? Number(retire * 10000n / ajoute) / 100 : 0, plusGrosRetrait: maxRetrait ? { bloc: maxRetrait.bloc, tx: maxRetrait.tx } : null };
    }
    return { version: p.version, nonLue: true };
  }

  // ---------------------------------------------------------- 3. recalcul
  /** Un jeton compte pour le score s'il a passe le seuil : pic ou capitalisation
   *  actuelle (revue C4 : HM a 587 853 $ et TROLL a 955 578 $ comptaient comme
   *  projets ; NOVAAI a 434 M$ actuels comptait 0 reussite faute de pic). */
  const auDessus = (j) => Math.max(j.pic_usd || 0, j.cap_usd || 0) >= K.SEUIL_CAP_USD;
  function recalcule() {
    const tousLus = B.tous("SELECT * FROM jetons WHERE statut = 'lu'");
    const jetons = tousLus.filter(auDessus);
    const retenus = new Set(jetons.map((j) => j.adresse));
    const lignes = B.tous('SELECT * FROM acheteurs');
    /* les marques ENTRE jetons (revue INI-01 et INI-04), recalculees a chaque
       fois sur tous les jetons lus : co-entree, et paires repetees d'un jeton a
       l'autre (meme bloc, mise du 1er achat a +/- 2 %) */
    const coentree = K.marqueCoentree(lignes.filter((a) => a.bloc != null).map((a) => ({ wallet: a.wallet, jeton: a.jeton, bloc: a.bloc, tx: a.tx })));
    const pairesX = K.marquePaires(lignes.filter((a) => a.mise != null && a.bloc != null).map((a) => ({ qui: a.wallet, cle: a.jeton + ':' + a.bloc, bloc: a.bloc, jeton: a.jeton, eth: BigInt(a.mise), tx: a.tx })));
    const marquesDe = (a) => {
      const l = jsonOu(a.marques, []).filter((m) => m.type !== 'coentree' && !(m.type === 'paire' && m.preuve && m.preuve.croise));
      if (coentree.has(a.wallet)) l.push({ type: 'coentree', preuve: coentree.get(a.wallet) });
      const px = pairesX.get(a.wallet);
      if (px && new Set(px.blocs.map((b) => b.jeton)).size >= 2 && !l.some((m) => m.type === 'groupe' || m.type === 'paire')) l.push({ type: 'paire', preuve: Object.assign({ croise: true }, px) });
      return l;
    };
    const parts = new Map(), parJeton = new Map();
    const nouvellesMarques = [];
    for (const a of lignes) {
      const mq = marquesDe(a);
      if (JSON.stringify(mq) !== (a.marques || '[]')) nouvellesMarques.push([mq, a.jeton, a.wallet]);
      const x = { jeton: a.jeton, tot: !!a.tot, issue: a.issue, gain: big(a.gain), minutes: a.minutes, marques: mq };
      if (!parJeton.has(a.jeton)) parJeton.set(a.jeton, []);
      parJeton.get(a.jeton).push(x);
      if (!retenus.has(a.jeton)) continue;      // sous 1 M$ : montre, jamais compte dans un score
      if (!parts.has(a.wallet)) parts.set(a.wallet, []);
      parts.get(a.wallet).push(x);
    }
    /* le taux de base de chaque jeton : sans les wallets marques (revue C6) */
    const bases = new Map([...parJeton].map(([j, l]) => [j, K.tauxBase(l)]));
    const t = Math.floor(deps.horloge() / 1000);
    B.transaction(() => {
      for (const [mq, j, w] of nouvellesMarques) B.ecris('UPDATE acheteurs SET marques = ? WHERE jeton = ? AND wallet = ?', [mq, j, w]);
      for (const j of tousLus) { const b = bases.get(j.adresse); B.ecris('UPDATE jetons SET base_n = ?, base_gagnants = ? WHERE adresse = ?', [b ? b.n : null, b ? b.gagnants : null, j.adresse]); }
      B.ecris('DELETE FROM wallets');
      for (const [w, l] of parts) {
        const s = K.score(l, bases);
        B.pose('wallets', { adresse: w, projets: s.projets, connus: s.connus, jugeables: s.jugeables, gagnants: s.gagnants, gain_total: s.gainTotal, delai_moyen: s.delaiMoyen,
          attendu: s.attendu, ecart_type: s.ecartType, z: s.z, initie: s.initie, smart: s.smart, verdict: s.verdict, maj_t: t });
      }
      /* les createurs (deployeur ou lanceur) et les operateurs de migration */
      const parC = new Map();
      for (const j of tousLus) {
        if (!j.createur) continue;
        const k = j.createur;
        if (!parC.has(k)) parC.set(k, { role: j.role_createur, l: [] });
        parC.get(k).l.push(j);
      }
      const anciens = B.tous('SELECT adresse, rampes, migrations FROM createurs');
      const garde = new Map(anciens.map((x) => [x.adresse, x]));
      B.ecris('DELETE FROM createurs');
      for (const [c, { role, l }] of parC) {
        const liq = l.map((j) => jsonOu(j.liquidite, {}));
        const g = garde.get(c) || {};
        const drap = [];
        for (const j of l) for (const d of jsonOu(j.drapeaux, [])) drap.push(Object.assign({ jeton: j.adresse, symbole: j.symbole, decimales: j.decimales }, d));
        for (const j of l) { const x = jsonOu(j.liquidite, {}); if (x.retirePct != null && x.retirePct >= RETRAIT_RUG * 100) drap.push({ type: 'retrait', jeton: j.adresse, symbole: j.symbole, pct: x.retirePct, bloc: x.plusGrosRetrait && x.plusGrosRetrait.bloc, tx: x.plusGrosRetrait && x.plusGrosRetrait.tx }); }
        B.pose('createurs', { adresse: c, role, lancements: l.length,
          reussites: l.filter(auDessus).length,
          reussites_connues: l.filter((j) => j.pic_usd != null || j.cap_usd != null).length,
          retraits: liq.filter((x) => x.retirePct != null && x.retirePct >= RETRAIT_RUG * 100).length,
          lp_brulees: liq.filter((x) => x.brulePct != null && x.brulePct >= 99).length,
          drapeaux: l.reduce((n, j) => n + jsonOu(j.drapeaux, []).length, 0), drapeaux_liste: drap,
          rampes: g.rampes == null ? null : g.rampes, migrations: g.migrations == null ? null : g.migrations,
          jetons: l.map((j) => j.adresse), maj_t: t });
      }
      B.ecris('DELETE FROM liens');
      const premiers = new Map();
      for (const a of lignes) { if (!premiers.has(a.jeton)) premiers.set(a.jeton, []); premiers.get(a.jeton).push(a.wallet); }
      /* le VRAI createur : pour une migration, celui de l'ancien jeton (revue
         INI-06) ; l'operateur a son propre lien */
      const vrai = (j) => {
        if (j.role_createur === 'migration') { const an = (jsonOu(j.details, {}) || {}).ancien; return an && an.createur && (an.role === 'deployeur' || an.role === 'lanceur') ? an.createur : null; }
        return j.role_createur === 'deployeur' || j.role_createur === 'lanceur' ? j.createur : null;
      };
      for (const L of K.liens(tousLus.map((j) => ({ jeton: j.adresse, createur: vrai(j), operateur: j.role_createur === 'migration' ? j.createur : null,
        premiers: premiers.get(j.adresse) || [], recette: jsonOu(j.recette, null), ancien: j.ancien })))) B.pose('liens', L);
    });
  }
  /** Les lancements comptes ailleurs que dans nos jetons : rampes connues et
   *  migrations (une fois par jour et par createur). */
  async function compteLancements(P, M) {
    /* une fois par jour (revue N1 : relue a chaque passe depuis le bloc 0, la
       rampe 0x1eef coutait 50,5 Mo et finissait la passe en « abandon ») */
    const jour = heureLocale(deps.horloge()).jour;
    if (B.meta('lancements_jour') === jour) return;
    const parOp = new Map();
    for (const m of M.values()) if (m.operateur) parOp.set(m.operateur, (parOp.get(m.operateur) || 0) + 1);
    /* toute la rampe en une lecture (filtre simple : cellules fermees en cache,
       la queue coute 1 appel), comptee par createur ensuite */
    const parRampe = new Map();
    for (const r of RAMPES) for (const l of (await R.lisLogs({ address: r.adresse, topics: [r.topic] }, 0, P.pointe, P)).logs) {
      if (!l.topics[2]) continue;
      const c = K.adrDe(l.topics[2]); parRampe.set(c, (parRampe.get(c) || 0) + 1);
    }
    for (const c of B.tous('SELECT adresse FROM createurs')) B.ecris('UPDATE createurs SET rampes = ?, migrations = ? WHERE adresse = ?', [parRampe.get(c.adresse) || 0, parOp.get(c.adresse) || 0, c.adresse]);
    B.meta('lancements_jour', jour);
  }

  // ---------------------------------------------------------- la passe
  async function passe() {
    if (enCours) return { fait: 'deja' };
    enCours = (async () => {
      await allume();
      R.nouvellePasse(); S.nouvellePasse(); S.purge();
      if (R.purgeVeille) R.purgeVeille(PURGE_VEILLE_MS);
      const debut = Math.floor(deps.horloge() / 1000);
      const bilan = { retenus: 0, pics: 0, lus: 0, statut: 'ok' };
      let P = null;
      try {
        await decouverte(bilan);
        P = await R.pointe();
        const M = await migrations(P);
        for (const row of B.tous("SELECT * FROM jetons WHERE statut = 'a_lire' ORDER BY COALESCE(pic_usd, cap_usd, 0) DESC")) {
          await litJeton(row, P, M);
          bilan.lus++;
          B.sauve();
        }
        recalcule();
        await compteLancements(P, M);
      } catch (e) {
        bilan.statut = e.budget ? 'budget' : e.abandon ? 'abandon' : 'erreur';
        bilan.erreur = masque(e.message || e).slice(0, 200);
        note('passe', bilan.statut + ' : ' + bilan.erreur);
        try { recalcule(); } catch (x) { /* le recalcul ne masque pas la cause */ }
      }
      bilan.rpc = R.etat.passe.rpc;            // appels JSON-RPC (un lot de 20 en compte 20 ; revue N9)
      if (R.etat.cachePlein) { bilan.cachePlein = true; note('cache', 'cache brut plein : les lectures ne sont plus gardees, chaque passe retelecharge'); }
      B.pose('passes', { genre: 'passe', debut, fin: Math.floor(deps.horloge() / 1000), statut: bilan.statut, appels: R.etat.passe.appels, octets: R.etat.passe.octets,
        gt: S.etat.gt.passe, ds: S.etat.ds.passe, jetons: bilan.lus, detail: bilan });
      await rapportSiHeure();
      B.sauve();
      instantane = construitVue();
      return bilan;
    })();
    try { return await enCours; } finally { enCours = null; }
  }

  // ---------------------------------------------------------- la veille
  let veilleEnCours = false;
  async function veille() {
    if (veilleEnCours) return { fait: 'deja' };
    veilleEnCours = true;
    try {
      await allume();
      RV.nouvellePasse();
      const P = await RV.pointe();
      const haut = P.pointe - CONFIRMATIONS;
      let de = (B.meta('veille_bloc') || (haut - 2900)) + 1;
      let saute = 0;
      if (haut - de > VEILLE_RATTRAPAGE_MAX) { saute = haut - VEILLE_RATTRAPAGE_MAX - de; de = haut - VEILLE_RATTRAPAGE_MAX; note('veille', `${saute} blocs sautes apres une coupure (rattrapage borne a ${VEILLE_RATTRAPAGE_MAX})`); }
      if (de > haut) { await rapportSiHeure(); B.sauve(); return { fait: 'rien' }; }
      const PP = Object.assign({}, P, { pointe: haut });
      const bilan = { de, a: haut, creations: 0, achats: 0, alertes: 0, saute };
      /* les naissances */
      const ev = [];
      ev.push(...(await RV.lisLogs({ address: K.ADR.POOL_MANAGER_V4, topics: [K.TOPIC.INIT_V4] }, de, haut, PP)).logs);
      ev.push(...(await RV.lisLogs({ address: FABRIQUES_V3, topics: [K.TOPIC.POOL_V3] }, de, haut, PP)).logs);
      ev.push(...(await RV.lisLogs({ address: FABRIQUES_V2, topics: [K.TOPIC.PAIR_V2] }, de, haut, PP)).logs);
      const nes = [];
      for (const e of ev.map(K.decode).filter(Boolean)) {
        const jeton = SOCLE.has(e.c0) ? e.c1 : SOCLE.has(e.c1) ? e.c0 : null;
        if (!jeton || !COTE_ETH(e)) continue;
        nes.push({ e, jeton });
      }
      const txs = [...new Set(nes.map((n) => n.e.tx))];
      const rcs = await RV.recus(txs, P.sure), tts = await RV.transactions(txs, P.sure);
      const hs = await RV.horodatages([...new Set(nes.map((n) => n.e.bloc))], P.sure);
      const connus = new Map(B.tous("SELECT * FROM createurs WHERE role IN ('deployeur','lanceur')").map((c) => [c.adresse, c]));
      let creusees = 0;
      const aJuger = [];
      for (const { e, jeton } of nes) {
        const rc = rcs.get(e.tx), tx = tts.get(e.tx);
        let a = K.attribueCreateur({ jeton, tx, recu: rc, migration: null });
        /* la piscine nait dans une autre tx que le jeton (deploiement direct puis
           Initialize) : si l'expediteur est un createur CONNU, on cherche la 1re
           trace du jeton sur les 24 h d'avant (au plus VEILLE_CREUSE par veille,
           CHOISI) ; sinon rien n'est affirme et aucune alerte ne part */
        if (a.role === 'inconnu' && a.qui && connus.has(a.qui) && creusees < VEILLE_CREUSE) {
          creusees++;
          const { logs } = await RV.lisLogs({ address: jeton }, Math.max(0, e.bloc - 24 * HEURE_BLOCS), e.bloc, Object.assign({}, PP, { premier: true }));
          if (logs.length) {
            const h = String(logs[0].transactionHash).toLowerCase();
            const rc2 = (await RV.recus([h], P.sure)).get(h), tx2 = (await RV.transactions([h], P.sure)).get(h);
            const b = K.attribueCreateur({ jeton, tx: tx2, recu: rc2, migration: null });
            if (b.verifie) a = b;
          }
        }
        B.pose('creations', { pool: e.pool, jeton, version: e.version, bloc: e.bloc, t: hs.get(e.bloc) || null, tx: e.tx, createur: a.qui, role: a.role, verifie: a.verifie, via: a.via || null });
        bilan.creations++;
        aJuger.push({ a, jeton });
      }
      /* les alertes APRES avoir pose toutes les naissances de la veille : un
         LANCEUR AUTOMATIQUE (>= LANCEUR_AUTO jetons en 24 h, ceux de cette veille
         compris ; revue INI-07) n'a pas d'alerte jeton par jeton, un resume dans
         le rapport */
      for (const { a, jeton } of aJuger) {
        const n24 = a.qui ? (B.un('SELECT count(DISTINCT jeton) n FROM creations WHERE createur = ? AND (t >= ? OR t IS NULL)', [a.qui, Math.floor(deps.horloge() / 1000) - NOUVEAU_S]) || {}).n || 0 : 0;
        const al = K.alerteCreateur(Object.assign({}, a, { jeton }), connus, { lancements24h: n24 });
        if (!al && K.estLanceurAuto(n24) && connus.has(a.qui)) bilan.autoTaisees = (bilan.autoTaisees || 0) + 1;
        if (al) {
          const c = connus.get(al.createur);
          const palm = { lancements: c.lancements, reussites: c.reussites, retraits: c.retraits, drapeaux: c.drapeaux };
          const inf = await RV.infosJeton(jeton).catch(() => ({}));
          const texte = K.texteAlerteCreateur(Object.assign({}, al, { palmares: palm }), { explorer: deps.explorer, via: a.via, symbole: inf.symbole });
          if (await envoie('createur', 'createur:' + jeton, jeton, texte)) bilan.alertes++;
        }
      }
      /* les achats des smart */
      const smart = B.tous('SELECT adresse FROM wallets WHERE smart = 1 ORDER BY gagnants DESC LIMIT ' + SMART_VEILLE_MAX).map((x) => x.adresse);
      if (smart.length) {
        const { logs } = await RV.lisLogs({ topics: [K.TOPIC.TRANSFER, null, smart.map(K.pad32)] }, de, haut, PP);
        const recents = new Map(B.tous('SELECT * FROM creations WHERE t >= ?', [Math.floor(deps.horloge() / 1000) - NOUVEAU_S]).map((c) => [c.jeton, c]));
        const vises = logs.map(K.decode).filter((t) => t && recents.has(t.jeton));
        const rcs2 = await RV.recus([...new Set(vises.map((t) => t.tx))], P.sure);
        const h2 = await RV.horodatages([...new Set(vises.map((t) => t.bloc))], P.sure);
        for (const t of vises) {
          const c = recents.get(t.jeton);
          const rc = rcs2.get(t.tx); if (!rc) continue;
          const evts = (rc.logs || []).map(K.decode).filter(Boolean);
          const ini = evts.find((x) => x.genre === 'init' && x.pool === c.pool);
          const ps = ini ? K.piscineEth(ini, t.jeton) : await piscineConnue(c, t.jeton, PP);
          if (!ps) continue;
          for (const tr of K.echanges({ jeton: t.jeton, piscines: [ps], evts })) {
            if (tr.sens !== 'achat' || tr.qui !== t.vers) continue;
            B.pose('achats_smart', { tx: tr.tx, wallet: tr.qui, jeton: t.jeton, bloc: tr.bloc, t: h2.get(tr.bloc) || null });
            bilan.achats++;
          }
        }
        const depuis = Math.floor(deps.horloge() / 1000) - K.ALERTE_FENETRE_S;
        const achats = B.tous('SELECT * FROM achats_smart WHERE t >= ?', [depuis]).map((a) => ({ qui: a.wallet, jeton: a.jeton, t: a.t, bloc: a.bloc, tx: a.tx }));
        const scores = new Map(B.tous('SELECT * FROM wallets WHERE smart = 1').map((w) => [w.adresse, { projets: w.projets, gagnants: w.gagnants, z: w.z, verdict: w.verdict }]));
        for (const al of K.alertesSmart(achats, new Set(smart))) {
          const sym = (B.un('SELECT symbole FROM jetons WHERE adresse = ?', [al.jeton]) || {}).symbole;
          const texte = K.texteAlerteSmart(al, { explorer: deps.explorer, scores, symbole: sym });
          if (await envoie('smart', 'smart:' + al.jeton, al.jeton, texte)) bilan.alertes++;
        }
      }
      B.meta('veille_bloc', haut);
      B.pose('passes', { genre: 'veille', debut: Math.floor(deps.horloge() / 1000), fin: Math.floor(deps.horloge() / 1000), statut: 'ok', appels: RV.etat.passe.appels, octets: RV.etat.passe.octets, gt: 0, ds: 0, jetons: 0, detail: bilan });
      await rapportSiHeure();
      B.sauve();
      instantane = construitVue();
      return bilan;
    } catch (e) {
      const msg = masque(e.message || e).slice(0, 200);
      note('veille', (e.budget ? 'budget' : e.abandon ? 'abandon' : 'erreur') + ' : ' + msg);
      try { B.pose('passes', { genre: 'veille', debut: Math.floor(deps.horloge() / 1000), fin: Math.floor(deps.horloge() / 1000), statut: e.budget ? 'budget' : e.abandon ? 'abandon' : 'erreur', detail: { erreur: msg } }); B.sauve(); } catch (x) { /* rien */ }
      /* l'instantane est refait aussi en cas d'echec : la page doit voir la veille ratee (revue P4) */
      try { instantane = construitVue(); } catch (x) { /* rien */ }
      return { fait: 'erreur', erreur: msg };
    } finally { veilleEnCours = false; }
  }
  const COTE_ETH = (e) => K.COTES_ETH.has(e.c0) || K.COTES_ETH.has(e.c1);
  async function piscineConnue(c, jeton, P) {
    if (c.version === 4) {
      const { logs } = await RV.lisLogs({ address: K.ADR.POOL_MANAGER_V4, topics: [K.TOPIC.INIT_V4, c.pool] }, c.bloc, c.bloc, P);
      const ini = logs.map(K.decode).find(Boolean);
      return ini ? K.piscineEth(ini, jeton) : null;
    }
    const f = c.version === 3 ? { address: FABRIQUES_V3, topics: [K.TOPIC.POOL_V3] } : { address: FABRIQUES_V2, topics: [K.TOPIC.PAIR_V2] };
    const { logs } = await RV.lisLogs(f, c.bloc, c.bloc, P);
    const ini = logs.map(K.decode).find((x) => x && x.pool === c.pool);
    return ini ? K.piscineEth(ini, jeton) : null;
  }

  // ---------------------------------------------------------- le rapport quotidien
  async function rapportSiHeure() {
    const l = heureLocale(deps.horloge());
    if (l.minutes < minutesDe(C.heure)) return false;
    if (B.meta('rapport_jour') === l.jour) return false;
    B.meta('rapport_jour', l.jour);
    const texte = texteRapport();
    await envoie('rapport', 'rapport:' + l.jour, null, texte);
    return true;
  }
  function texteRapport() {
    const t = Math.floor(deps.horloge() / 1000);
    const L = { tx: (h) => `${deps.explorer}/tx/${h}`, a: (x) => `${deps.explorer}/address/${x}` };
    const top = B.tous('SELECT * FROM wallets WHERE smart = 1 ORDER BY gagnants DESC, z DESC LIMIT 20');
    const nouveaux = B.tous('SELECT * FROM jetons WHERE vu_t >= ? ORDER BY COALESCE(pic_usd, cap_usd, 0) DESC LIMIT 10', [t - 24 * 3600]);
    const gl = groupesVus().slice(0, 10);
    const v = [], nv = [];
    v.push(`${top.length} wallet${top.length === 1 ? '' : 's'} pass the owner’s rule (early and up on 3+ tokens over $1M, no insider mark)`);
    for (const w of top) nv.push(`<a href="${L.a(w.adresse)}">${K.court(w.adresse)}</a> — up on ${w.gagnants} of ${w.connus} known (${w.projets} early), ${K.zTexte(w)} vs the base rate; ${K.esc(K.verdictTexte(w))}`);
    v.push(`${nouveaux.length} new token${nouveaux.length === 1 ? '' : 's'} over $1M spotted in 24 h`);
    for (const j of nouveaux) nv.push(`${K.esc(j.symbole || K.court(j.adresse))}: ${j.pic_usd != null ? 'peak ' + K.usd(j.pic_usd) : 'now ' + K.usd(j.cap_usd)} (GeckoTerminal/DexScreener) <a href="https://dexscreener.com/robinhood/${j.adresse}">DexScreener</a>`);
    /* le MOTIF est lu sur la chaine ; « initie » est une deduction (revue INI-08) */
    v.push(`${gl.length} same-block buy group${gl.length === 1 ? '' : 's'} (${K.GROUPE_MIN}+ wallets, same block, buys within ±${K.GROUPE_ECART * 100}%)`);
    for (const g of gl) v.push(`${g.n} wallets in block ${K.milliers(g.bloc)} on ${K.court(g.jeton)}, ${g.wallets.length} among its first ${K.N_ACHETEURS} (<a href="${L.tx(g.tx)}">tx ${K.court(g.tx)}</a>)`);
    if (gl.length) nv.push('a same-block buy group is read as an insider pattern: some groups are chance (busy blocks)');
    const li = B.tous('SELECT * FROM liens').filter((x) => x.type !== 'migration');
    if (li.length) v.push(`${li.length} link${li.length === 1 ? '' : 's'} between tokens read (same creator, same migration operator, shared first buyers, same recipe) — see the page`);
    const auto = lanceursAuto();
    if (auto.length) v.push(`${auto.length} automated launcher${auto.length === 1 ? '' : 's'} (${K.LANCEUR_AUTO}+ launches in 24 h, ${auto.reduce((n, a) => n + a.n, 0)} launches): no alert per token`);
    return `<b>Smart money — daily report</b>\n` + K.sections(v, nv) + `\nAlerts only: nothing is ever bought.`;
  }

  /** Les groupes d'achat dans le meme bloc : listes des qu'UN des 50 premiers
   *  en est membre, avec la taille reelle du groupe (revue INI-09 : HM bloc
   *  49 405 448 = 16 wallets, la page en montrait 9 ; 49 groupes existaient sur
   *  6 jetons, 13 etaient montres). */
  function groupesVus() {
    const parBloc = new Map();
    for (const g of B.tous("SELECT jeton, wallet, marques FROM acheteurs WHERE marques LIKE '%groupe%'")) for (const m of jsonOu(g.marques, [])) if (m.type === 'groupe' && m.preuve) {
      const k = g.jeton + ':' + m.preuve.bloc;
      if (!parBloc.has(k)) parBloc.set(k, { jeton: g.jeton, bloc: m.preuve.bloc, tx: m.preuve.tx, n: m.preuve.n || 0, acheteursBloc: m.preuve.acheteursBloc || null, charge: (m.preuve.acheteursBloc || 0) > K.BLOC_CHARGE, wallets: [] });
      const x = parBloc.get(k); x.wallets.push(g.wallet); x.n = Math.max(x.n, m.preuve.n || 0);
    }
    const l = [...parBloc.values()];
    for (const g of l) g.n = Math.max(g.n, g.wallets.length);
    l.sort((a, b) => b.n - a.n || b.wallets.length - a.wallets.length);
    return l;
  }
  /** Les wallets qui ont lance au moins LANCEUR_AUTO jetons en 24 h (veille). */
  function lanceursAuto() {
    const t = Math.floor(deps.horloge() / 1000);
    return B.tous('SELECT createur, count(DISTINCT jeton) n FROM creations WHERE t >= ? AND createur IS NOT NULL GROUP BY createur HAVING n >= ? ORDER BY n DESC', [t - NOUVEAU_S, K.LANCEUR_AUTO]).map((x) => ({ adresse: x.createur, n: x.n }));
  }

  // ---------------------------------------------------------- la vue (routes)
  const s = (x) => (x == null ? null : String(x));
  function vueWallet(w) {
    return { adresse: w.adresse, projets: w.projets, connus: w.connus, jugeables: w.jugeables, gagnants: w.gagnants, gain_total_wei: s(w.gain_total), delai_moyen_min: w.delai_moyen,
      attendu: w.attendu, z: w.z, smart: !!w.smart, initie: !!w.initie, verdict: w.verdict };
  }
  function vueJeton(j) {
    return { adresse: j.adresse, symbole: j.symbole, statut: j.statut, mode: j.mode, erreur: j.erreur,
      lancement: j.lancement_bloc != null ? { bloc: j.lancement_bloc, t: j.lancement_t, tx: j.lancement_tx, piscine: j.piscine, version: j.version } : null,
      createur: j.createur ? { adresse: j.createur, role: j.role_createur, verifie: !!j.createur_verifie, bloc: j.createur_bloc, tx: j.createur_tx, via: j.via } : null,
      ancien: j.ancien, details: jsonOu(j.details, null),
      /* la piscine GeckoTerminal de la source (lien de la page, revue P3) */
      pic: j.pic_usd != null ? { usd: j.pic_usd, jour: j.pic_jour, source: j.pic_source, piscine: j.piscine || j.source || null } : null,
      cap: j.cap_usd != null ? { usd: j.cap_usd, source: j.cap_source, piscine: j.source || null } : null,
      prix: j.prix_bloc != null ? { bloc: j.prix_bloc } : null,
      base: j.base_n != null ? { n: j.base_n, gagnants: j.base_gagnants } : null,
      recette: jsonOu(j.recette, null), drapeaux: jsonOu(j.drapeaux, []), liquidite: jsonOu(j.liquidite, null), profil_t: j.profil_t };
  }
  function construitVue() {
    if (!B) return { actif: false, pret: false, mode: C.mode };
    const dern = (g, ok) => { const p = B.un('SELECT * FROM passes WHERE genre = ?' + (ok ? " AND statut = 'ok'" : '') + ' ORDER BY id DESC LIMIT 1', [g]); return p ? Object.assign({}, p, { detail: jsonOu(p.detail, null) }) : null; };
    const wallets = B.tous('SELECT * FROM wallets ORDER BY smart DESC, gagnants DESC, z DESC LIMIT 40').map(vueWallet);
    const createurs = B.tous('SELECT * FROM createurs ORDER BY reussites DESC, lancements DESC LIMIT 30').map((c) => Object.assign({}, c, { jetons: jsonOu(c.jetons, []), drapeaux_liste: jsonOu(c.drapeaux_liste, []) }));
    const jetons = B.tous('SELECT * FROM jetons ORDER BY COALESCE(pic_usd, cap_usd, 0) DESC LIMIT 60').map(vueJeton);
    const maintenant = Math.floor(deps.horloge() / 1000);
    const auto = new Map(lanceursAuto().map((a) => [a.adresse, a.n]));
    const nouveaux = B.tous('SELECT * FROM creations WHERE t >= ? ORDER BY bloc DESC LIMIT 60', [maintenant - NOUVEAU_S]).map((c) => Object.assign({}, c, { auto: auto.has(c.createur) ? auto.get(c.createur) : null }));
    const sym = new Map(B.tous('SELECT adresse, symbole FROM jetons').map((j) => [j.adresse, j.symbole]));
    const liens = B.tous("SELECT * FROM liens WHERE type != 'migration' ORDER BY type LIMIT 40").map((l) => Object.assign({}, l, { symA: sym.get(l.a) || null, symB: sym.get(l.b) || null }));
    const n = (sql) => (B.un(sql) || {}).n || 0;
    const passe = dern('passe'), veille = dern('veille');
    /* t = l'heure de la DERNIERE LECTURE (fin de la derniere passe ou veille),
       jamais l'heure de construction (revue P4 : apres un redemarrage, la page
       annoncait une mise a jour sans aucune lecture) */
    const t = Math.max(passe ? passe.fin || 0 : 0, veille ? veille.fin || 0 : 0) || null;
    return {
      actif: true, pret: true, mode: C.mode, t, maintenant,
      regles: { acheteurs: K.N_ACHETEURS, mise_min_eth: Number(K.MISE_MIN_WEI) / 1e18, tot_min: K.TOT_S / 60, smart_jetons: K.SMART_JETONS, projets_assez: K.PROJETS_ASSEZ,
        z_verdict: K.Z_VERDICT, groupe_min: K.GROUPE_MIN, groupe_ecart_pct: K.GROUPE_ECART * 100, bloc_charge: K.BLOC_CHARGE, relais_pct: K.RELAIS_PART * 100, relais_blocs: K.RELAIS_BLOCS, seuil_usd: K.SEUIL_CAP_USD,
        base_assez: K.BASE_ASSEZ, robots_min: K.ROBOTS_MIN, lanceur_auto: K.LANCEUR_AUTO, actifs_min: SRC.ACTIFS_MIN, pic_candidat_usd: SRC.PIC_CANDIDAT_USD,
        passe_min: PASSE_MS / 60e3, veille_min: VEILLE_MS / 60e3 },
      passe, veille, passe_ok: dern('passe', true), veille_ok: dern('veille', true),
      cache: { plein: !!(R && R.etat.cachePlein) },
      compteurs: { retenus: n('SELECT count(*) n FROM jetons'), lus: n("SELECT count(*) n FROM jetons WHERE statut = 'lu'"), wallets: n('SELECT count(*) n FROM wallets'),
        smart: n('SELECT count(*) n FROM wallets WHERE smart = 1'), inities: n('SELECT count(*) n FROM wallets WHERE initie = 1'), creations24h: nouveaux.length, lanceurs_auto: auto.size },
      wallets, createurs, jetons, nouveaux, groupes: groupesVus().slice(0, 20), liens,
      alertes: B.tous('SELECT id, t, genre, jeton, envoye FROM alertes ORDER BY id DESC LIMIT 10'),
      journal: journal.slice(-20),
    };
  }
  function detailJeton(a) {
    if (!B) return null;
    const j = B.un('SELECT * FROM jetons WHERE adresse = ?', [a]);
    if (!j) return null;
    const ach = B.tous('SELECT * FROM acheteurs WHERE jeton = ? ORDER BY rang', [a]).map((x) => ({ wallet: x.wallet, rang: x.rang, bloc: x.bloc, t: x.t, minutes: x.minutes, tot: !!x.tot, tx: x.tx,
      entre_wei: s(x.entre), sorti_wei: s(x.sorti), solde: s(x.solde), gain_wei: s(x.gain), issue: x.issue, cout_connu: !!x.cout_connu, marques: jsonOu(x.marques, []),
      frais_wei: s(x.frais), frais_lus: x.frais_lus == null ? null : !!x.frais_lus, contrat: x.contrat == null ? null : !!x.contrat }));
    const liensJ = B.tous('SELECT * FROM liens WHERE a = ? OR b = ?', [a, a]);
    return Object.assign(vueJeton(j), { acheteurs: ach, liens: liensJ });
  }
  function detailWallet(a) {
    if (!B) return null;
    const w = B.un('SELECT * FROM wallets WHERE adresse = ?', [a]);
    const parts = B.tous('SELECT a.*, j.symbole, j.base_n, j.base_gagnants FROM acheteurs a LEFT JOIN jetons j ON j.adresse = a.jeton WHERE a.wallet = ?', [a]).map((x) => ({
      jeton: x.jeton, symbole: x.symbole, rang: x.rang, bloc: x.bloc, minutes: x.minutes, tot: !!x.tot, tx: x.tx, entre_wei: s(x.entre), sorti_wei: s(x.sorti), gain_wei: s(x.gain), issue: x.issue,
      frais_wei: s(x.frais), frais_lus: x.frais_lus == null ? null : !!x.frais_lus, contrat: x.contrat == null ? null : !!x.contrat,
      marques: jsonOu(x.marques, []), base: x.base_n ? { n: x.base_n, gagnants: x.base_gagnants } : null }));
    if (!w && !parts.length) return null;
    return Object.assign(w ? vueWallet(w) : { adresse: a }, { participations: parts, achats_smart: B.tous('SELECT * FROM achats_smart WHERE wallet = ? ORDER BY bloc DESC LIMIT 20', [a]) });
  }
  function detailCreateur(a) {
    if (!B) return null;
    const c = B.un('SELECT * FROM createurs WHERE adresse = ?', [a]);
    const jet = B.tous('SELECT * FROM jetons WHERE createur = ?', [a]).map(vueJeton);
    const cre = B.tous('SELECT * FROM creations WHERE createur = ? ORDER BY bloc DESC LIMIT 30', [a]);
    if (!c && !jet.length && !cre.length) return null;
    return Object.assign(c ? Object.assign({}, c, { jetons: jsonOu(c.jetons, []) }) : { adresse: a }, { lus: jet, creations: cre });
  }

  function ligneDemarrage() {
    if (C.mode === 'off') return '[smart] ETEINT (SMART_MONEY vide) : aucune minuterie, aucune requete, aucun fichier';
    if (C.mode === 'inconnu') return `[smart] SMART_MONEY=${C.brut} inconnu (« observe » ou « 1 ») : RIEN ne tourne`;
    const base = `passe toutes les ${PASSE_MS / 60e3} min (GeckoTerminal + DexScreener sans cle, noeud ${C.rpcPropre ? 'SMART_RPC_URL' : 'public'} en lecture seule), veille toutes les ${VEILLE_MS / 60e3} min, rapport ${C.heure} ${FUSEAU}`;
    return C.mode === 'observe' ? `[smart] OBSERVATION (SMART_MONEY=observe) : ${base} — n envoie rien` : `[smart] ALERTES au proprietaire seul (SMART_MONEY=1, notifyPrive) : ${base}`;
  }

  return {
    config: C, passe, veille, ligneDemarrage, allume,
    vue: () => (B ? (instantane || construitVue()) : { actif: C.mode === 'observe' || C.mode === 'envoi', pret: false, mode: C.mode }),
    jeton: (a) => detailJeton(String(a).toLowerCase()),
    wallet: (a) => detailWallet(String(a).toLowerCase()),
    createur: (a) => detailCreateur(String(a).toLowerCase()),
    texteRapport: () => texteRapport(),
    /** Refait scores, createurs et liens depuis la base locale (aucune requete). */
    recalcule: () => { recalcule(); instantane = construitVue(); },
    base: () => B,
    sauve: () => { if (B) B.sauve(); },
    journal: () => journal.slice(),
  };
}

/**
 * Le branchement (server.js). Inerte — aucune minuterie, aucune requete,
 * aucun fichier — si SMART_MONEY est vide ou inconnu.
 */
function planifie(deps) {
  const I = cree(deps);
  console.log(I.ligneDemarrage());
  const inerte = { passe: async () => ({ fait: 'off' }), veille: async () => ({ fait: 'off' }), arrete() {}, actif: false, instance: I };
  if (I.config.mode !== 'observe' && I.config.mode !== 'envoi') return inerte;
  const m = [];
  if (!deps || deps.minuteries !== false) {
    /* la base sur le volume est rouverte tout de suite : la page sert le dernier
       etat connu des le redemarrage, sans attendre la premiere passe */
    I.allume().catch((e) => console.log('[smart] base : ' + (e && e.message)));
    const garde = (f, nom) => () => { f().catch((e) => console.log(`[smart] ${nom} : ${e && e.message}`)); };
    const p = setTimeout(garde(I.passe, 'passe'), PREMIERE_PASSE_MS); if (p.unref) p.unref(); m.push(['t', p]);
    const a = setInterval(garde(I.passe, 'passe'), PASSE_MS); if (a.unref) a.unref(); m.push(['i', a]);
    const b = setInterval(garde(I.veille, 'veille'), VEILLE_MS); if (b.unref) b.unref(); m.push(['i', b]);
  }
  return {
    passe: () => I.passe(), veille: () => I.veille(), actif: true, instance: I,
    /* synchrone : journal.draine coupe le processus 2 s apres SIGTERM */
    arrete() { for (const [k, x] of m) (k === 't' ? clearTimeout : clearInterval)(x); m.length = 0; try { I.sauve(); } catch (e) { /* rien */ } },
  };
}

module.exports = { config, cree, planifie, PASSE_MS, VEILLE_MS, RAMPES, FABRIQUES_V2, FABRIQUES_V3, NOUVEAU_S, RETRAIT_RUG, LIGNES_TOUT_MAX, HEURE_BLOCS };
