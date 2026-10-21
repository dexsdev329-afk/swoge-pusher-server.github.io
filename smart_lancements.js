'use strict';
/* ==================================================================
 * LANCEMENTS PONS ET IGNITION, LUS SUR LA CHAINE TOUTES LES 60 S (15/10/2026)
 * ==================================================================
 *
 * Le detecteur smart money a rate $JUDGEBOT (0xa922cdff…) : il ne voyait un
 * jeton qu'a la naissance de sa piscine (Initialize v4, PoolCreated,
 * PairCreated) et par DexScreener / GeckoTerminal, et JUDGEBOT etait encore
 * sur sa COURBE Pons. Le brief v2 du proprietaire (smart_brief.BRIEF2) dit de
 * lire les lancements eux-memes. Ce module le fait, en LECTURE SEULE, et
 * n'achete rien : ses alertes vont au proprietaire (notifyPrive, par
 * `envoie` de smart_money.js), ses signaux a la colonie comme OBSERVES, une
 * ligne d'audit par source (ai_colonie.js, smartSignal).
 *
 * UN CYCLE (toutes les 60 s, brief) :
 *  1. la pointe (eth_blockNumber) ;
 *  2. les journaux des USINES (filtre d'adresse : Pons V2 + les cinq
 *     d'IGNITION ; lancements Pons, graduations, lancements IGNITION) ;
 *  3. les journaux des COURBES, sans adresse (achat, vente, exemption,
 *     graduation de courbe), filtres ENSUITE sur les courbes connues : une
 *     seule requete donne le T+2 de chaque lancement, le suivi des courbes
 *     alertees et les achats sur courbe des wallets copies. Une adresse que
 *     l'usine n'a pas lancee n'est jamais crue (verifiee par l'usine) ;
 *  4. UN lot JSON-RPC : nonce du wallet IGNITION, prix ETH (slot0, toutes les
 *     10 min), tx des nouveaux lancements et des achats a copier ;
 *  5. pour un lancement qui alerte seulement : description(), logo(),
 *     socials(), symbol() (un lot), et la promo DexScreener (orders/v1).
 * Reprise au dernier bloc lu (B.meta), au plus FENETRE_MAX blocs par cycle,
 * rattrapage borne a RATTRAPAGE_MAX apres un arret (au-dela : saute, et dit).
 * Mesure du cout d'un cycle : EXPLOITATION.md, « Lancements Pons ».
 * ================================================================== */

const SP = require('./smart_pons');
const L = require('./smart_listes');
const SPUB = require('./smart_public');

const CYCLE_MS = 60e3;                 // brief : « toutes les 60 s »
const CONFIRMATIONS = 20;              // = smart_money.CONFIRMATIONS (~2 s ; les repliques reculent de 3 blocs au plus, sonde du 13/10)
/* Par cycle, au plus 6 000 blocs (~10 min) : CHOISI. La requete des courbes
   est sans adresse, donc bornee par le noeud a 30 000 blocs (sonde du 15/10 :
   « only 30000 are allowed ») ; 600 blocs en portent 71 lignes, 58 Ko (sonde). */
const FENETRE_MAX = 6000;
/* Apres un arret, au plus 30 min de rattrapage (18 000 blocs), en trois
   cycles ; au-dela on saute et on le dit. CHOISI : un lancement de plus de
   30 min n'est plus « au lancement » ; JUDGEBOT n'avait que 10 acheteurs a
   T+2 et 38 a T+30 (sonde). */
const RATTRAPAGE_MAX = 18000;
/* Budget d'un cycle : 15 requetes HTTP et 8 Mo. CHOISI contre la mesure (un
   cycle courant : 4 requetes, ~70 Ko ; un cycle qui alerte : 6 requetes).
   Plafond du jour PROPRE a ce client (la file et l'espacement restent ceux de
   la passe et de la veille) : 8 000 requetes et 400 Mo. Mesure du 15/10 (3
   cycles reels a 23:3x UTC) : 4 requetes et 38 a 79 Ko par cycle, soit
   ~5 760 requetes et ~100 Mo pour 1 440 cycles ; 8 000 laisse ~40 % aux
   cycles qui alertent (6 requetes). */
const CYCLE_APPELS = 15, CYCLE_OCTETS = 8e6;
const JOUR_HTTP = 8000, JOUR_OCTETS = 400e6;
/* 2 s apres un appel leger de CE client, au lieu de 1,5 s : sonde du 15/10,
   eth_blockNumber puis eth_getLogs en alternance, 76 requetes a chaque ecart :
   3 refus 429 a 1,5 s (tous dans la meme minute, 23:11 UTC), 0 a 2 s ; et
   le cycle reel de 23:0x avait pris deux 429 a 1,5 s (recul 15 s + 60 s, cycle
   de 83 s). Un abandon met TOUT le noeud en pause 30 min (passe et veille
   comprises) : CHOISI prudent. L'espacement de la passe et de la veille n'est
   pas touche (3 refus sur 76 ne suffisent pas a le juger). */
const ESPACE_LEGER_MS = 2000;
const LOT_TX_MAX = 60;                 // tx lues par cycle : CHOISI (1 664 lancements en 24 h = ~1,2 par cycle ; 30 min de rattrapage ~35)
const META_PAR_CYCLE = 6;              // jetons dont on lit logo/socials/description par cycle : CHOISI
const SEL_NAME = '0x06fdde03';         // name() — keccak verifie (ethers utils.id) le 21/10 : le carnet des lancements
/* Une courbe alertee est suivie 150 min au plus (les ombres de la colonie se
   jugent jusqu'a 120 min), et lachee apres 30 min sans echange ou a la
   graduation. CHOISI. */
const SUIVI_MIN = 150, INACTIF_MIN = 30, SUIVI_MAX = 40;
const JEUNES_MAX = 400;                // lancements en attente de leur T+2 : CHOISI (rattrapage de 30 min ~35)
const CONNUES_MAX = 3000;              // courbes connues (jeton, bloc) gardees : CHOISI (~2 jours de lancements)
const ACHETEURS_GARDES = 200;          // acheteurs distincts gardes par courbe suivie (le T+2 en demande 20)
const IGNITION_NONCES_MAX = 10;        // contrats d'IGNITION verifies par cycle : CHOISI (91 nonces en tout, 19 contrats, sonde)
const ETH_USD_MS = 10 * 60e3;          // prix de l'ETH relu toutes les 10 min (slot0 de WETH/USDG v3) : CHOISI
const S_PAR_BLOC = 0.1012;             // sonde du 15/10 : 6 000 blocs = 607 s
/* Relay (section 3) : « toutes les 2 min ». limit=5 au lieu de 20 : CHOISI
   (sonde du 15/10 : 196 Ko pour 20 demandes, 50 Ko pour 5 ; le plus serre
   observe : deux envois en 2 min 30 s). Sans cle, delai de 10 s, aucune
   relance ; une panne met Relay en pause 30 min. La v2 est DEPRECIEE
   (reponse du 15/10 : ralentie depuis le 01/09, retiree le 24/11/2026 ; la v3
   exige une cle x-api-key : sonde, 400). UN wallet par appel, en rotation,
   un appel toutes les 20 s : chaque wallet est relu toutes les 2 min. Sonde
   du 15/10 : les six d'affilee a 2 s d'ecart -> 429 au 3e, deux fois de
   suite ; a 20 s d'ecart, voir EXPLOITATION.md. */
const RELAY_MS = 20e3, RELAY_LIMITE = 5, RELAY_DELAI_MS = 10000, RELAY_PAUSE_MS = 30 * 60e3;
const RELAY_URL = 'https://api.relay.link/requests/v2';
const CHAINE_SOLANA = 792703809, CHAINE_RH = 4663;   // chainId de Relay (sonde : currencyIn/currencyOut)
const FINANCES_GARDE_MS = 7 * 24 * 3600e3;            // CHOISI : un wallet finance reste suivi 7 jours (le brief : finance 2 a 55 min avant)
const DS_ORDERS = 'https://api.dexscreener.com/orders/v1/robinhood/';
const DS_DELAI_MS = 8000;
/* Rebond (section 7) : un jeton alerte reste en surveillance 24 h, relu
   toutes les 5 min, 20 au plus, 2 relectures par cycle : CHOISI. */
const SURV_MAX = 20, SURV_MS = 24 * 3600e3, REBOND_RELIRE_MS = 5 * 60e3, REBOND_PAR_CYCLE = 2;
const OFFRE_PONS = 10n ** 27n;         // sonde : totalSupply de JUDGEBOT = 1e27 (1 milliard, 18 decimales) ; relu pour la copie
const TROP_LIGNES = /exceeds limit of (\d+)/i, TROP_BLOCS = /only (\d+) are allowed/i, TROP_LONG = /timed out|timeout|deadline/i;

function config(env) {
  const e = env || process.env;
  const on = (k) => String(e[k] == null ? '' : e[k]).trim() !== '0';
  const C = { lancements: on('SMART_LANCEMENTS'), ignition: on('SMART_IGNITION'), relay: on('SMART_RELAY'), dsOrders: on('SMART_DS_ORDERS'), copie: on('SMART_COPIE'), rebond: on('SMART_REBOND'),
    /* un bon signe a T+2 SEUL (sans autre signal au lancement) : mesure du
       15/10, 6 lancements sur 49 (12 %), ~200 par jour a 1 664 lancements :
       trop pour des alertes. Par defaut il va a la colonie seule (ligne
       observee) ; SMART_T2_ALERTE=1 l'envoie aussi au proprietaire. */
    t2Alerte: String(e.SMART_T2_ALERTE == null ? '' : e.SMART_T2_ALERTE).trim() === '1' };
  if (!C.ignition) C.relay = false;
  return C;
}
const lc = (x) => String(x == null ? '' : x).toLowerCase();
const hex = (n) => '0x' + Number(n).toString(16);
const court = (a) => (a ? String(a).slice(0, 6) + '…' + String(a).slice(-4) : '?');
const big = (x) => { try { return x == null ? null : BigInt(x); } catch (e) { return null; } };

/**
 * deps :
 *   R          client smart_rpc (budget du cycle, plafond du jour propre)
 *   B          la base smart money (meta, alertes)
 *   envoie(genre, cle, jeton, texte) -> Promise<bool>   (smart_money : notifyPrive, une fois par cle)
 *   note(genre, texte), horloge, prendre (fetch), env, explorer
 *   faits(jeton) -> { mc, liq, taxe, sym }   (la colonie ; optionnel)
 *   surSignal(v)                            (la colonie, signal OBSERVE ; optionnel)
 *   exclu(jeton) -> raison | null           (actions tokenisees, stablecoins ; optionnel)
 */
function cree(deps) {
  const C = config(deps.env);
  const R = deps.R, B = deps.B;
  const maintenant = () => deps.horloge();
  const note = (g, t) => { try { deps.note(g, t); } catch (e) { /* rien */ } };
  const etat = { dernierCycle: null, dernierRelay: null, ethUsd: null, ethUsdT: 0, cycles: 0, alertes: 0 };
  /* l'etat durable : dans la meta de la base (JSON), relu a chaque cycle */
  const lis = (k, d) => { const v = B.meta(k); return v == null ? d : v; };
  const ecris = (k, v) => B.meta(k, v);

  // ---------------------------------------------------------- les journaux, au bloc pres
  /** eth_getLogs sur [de, a] exactement ; coupe en deux sur un refus de plage,
   *  de plafond de lignes ou un delai (6 niveaux au plus). */
  async function logsExacts(filtre, de, a, prof) {
    if (de > a) return [];
    let r;
    try { r = await R.appel('eth_getLogs', [Object.assign({ fromBlock: hex(de), toBlock: hex(a) }, filtre)]); }
    catch (e) { if (!e.tropLourd) throw e; r = { erreur: { message: 'trop lourd' } }; }
    if (!r.erreur) return Array.isArray(r.result) ? r.result : [];
    const m = String(r.erreur.message || '');
    if ((prof || 0) < 6 && a > de && (TROP_LIGNES.test(m) || TROP_BLOCS.test(m) || TROP_LONG.test(m) || m === 'trop lourd')) {
      const mi = Math.floor((de + a) / 2);
      return (await logsExacts(filtre, de, mi, (prof || 0) + 1)).concat(await logsExacts(filtre, mi + 1, a, (prof || 0) + 1));
    }
    throw new Error('eth_getLogs : ' + m.slice(0, 120));
  }

  // ---------------------------------------------------------- l'etat durable
  const suivi = () => lis('lance_suivi', {});
  const versJson = (o) => JSON.parse(JSON.stringify(o, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));

  /** Une courbe connue (lancee par l'usine Pons) : { jeton, bloc, cote, seuil }. */
  function connue(courbe) { const c = lis('lance_connues', {}); return c[courbe] || null; }
  function connais(courbe, x) {
    const c = lis('lance_connues', {});
    c[courbe] = x;
    const k = Object.keys(c);
    if (k.length > CONNUES_MAX) for (const z of k.sort((p, q) => c[p].bloc - c[q].bloc).slice(0, k.length - CONNUES_MAX)) delete c[z];
    ecris('lance_connues', c);
  }
  /** Une courbe que le cycle n'a pas vue naitre : on demande a l'usine
   *  (TokenLaunched, topic 2 = la courbe ; une valeur par position et une
   *  adresse : 10 M de blocs par requete, sonde du 13/10). */
  async function verifieCourbe(courbe, a) {
    const k = connue(courbe); if (k) return k;
    const pad = '0x' + courbe.slice(2).padStart(64, '0');
    const ls = await logsExacts({ address: SP.ADR.USINE_PONS, topics: [SP.TOPIC.LANCE_PONS, null, pad] }, Math.max(0, a - 9999999), a);
    const l = ls.map(SP.decodeLancementPons).find(Boolean);
    if (!l) return null;
    const x = { jeton: l.jeton, bloc: l.bloc, cote: l.cote, seuil: l.seuil.toString(), deployer: l.deployer };
    connais(courbe, x);
    return x;
  }

  // ---------------------------------------------------------- le prix de l'ETH
  function ethUsd() { return etat.ethUsd; }

  // ---------------------------------------------------------- la promo DexScreener
  async function promoDe(jeton) {
    if (!C.dsOrders) return undefined;
    try {
      const r = await deps.prendre(DS_ORDERS + jeton, { signal: AbortSignal.timeout(DS_DELAI_MS) });
      if (!r || !r.ok) return null;
      return SP.promo(JSON.parse(await r.text()), maintenant());
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------- les alertes
  /* `a.pub` (16/10) : les CHAMPS du journal public (smart_public.js) — categorie,
     titre, qui, risque et plan en CODES ; l'anglais se construit la-bas par
     gabarit. Le texte francais ci-dessous reste celui du proprietaire. */
  async function alerte(genre, cle, jeton, a) {
    const texte = SP.texteAlerte(Object.assign({ explorer: deps.explorer }, a), maintenant());
    const pub = a.pub ? Object.assign({ verdict: a.verdict, symbole: a.symbole, ageMin: a.ageMin, courbe: a.courbe, capUsd: a.capUsd, promo: a.promo }, a.pub) : null;
    const ok = await deps.envoie(genre, cle, jeton, texte, pub);
    etat.alertes++;
    return { ok, texte };
  }
  function signal(o) {
    if (typeof deps.surSignal !== 'function') return;
    try { deps.surSignal(SP.pourLaColonie(Object.assign({ t: maintenant() }, o))); } catch (e) { note('lancements', 'colonie : ' + String((e && e.message) || e).slice(0, 60)); }
  }
  function surveille(jeton, o) {
    if (!C.rebond) return;
    const s = lis('rebond_surv', {});
    if (s[jeton]) return;
    const k = Object.keys(s);
    if (k.length >= SURV_MAX) delete s[k.sort((p, q) => s[p].t - s[q].t)[0]];
    s[jeton] = Object.assign({ t: maintenant(), prochain: maintenant() + REBOND_RELIRE_MS, etat: null }, o || {});
    ecris('rebond_surv', s);
  }

  // ---------------------------------------------------------- les metadonnees du jeton
  /** logo, socials, description, symbol du jeton ; et, s'il a une courbe,
   *  creatorTaxBps() (la taxe du brief, lue sur la courbe). `jetons` :
   *  [adresse] ou [{ jeton, courbe }]. */
  async function metaDe(jetons) {
    const out = new Map();
    if (!jetons.length) return out;
    const js = jetons.map((x) => (typeof x === 'string' ? { jeton: x, courbe: null } : x));
    const q = [];
    for (const { jeton: j, courbe } of js) {
      for (const s of [SP.SELECTEUR.LOGO, SP.SELECTEUR.SOCIALS, SP.SELECTEUR.DESCRIPTION, SP.SELECTEUR.SYMBOL]) q.push({ method: 'eth_call', params: [{ to: j, data: s }, 'latest'] });
      q.push(courbe ? { method: 'eth_call', params: [{ to: courbe, data: SP.SELECTEUR.CREATOR_TAX }, 'latest'] } : null);
    }
    const rs = await R.lot(q.filter(Boolean));
    let k = 0;
    for (const { jeton: j, courbe } of js) {
      const r = () => { const x = rs[k++]; return (x && x.result) || null; };
      const logo = SP.chaineAbi(r()), socials = SP.decodeSocials(r()), description = SP.chaineAbi(r()), symbole = SP.chaineAbi(r());
      let taxe = null;
      if (courbe) { const t = r(); if (t && /^0x[0-9a-f]{1,64}$/i.test(t)) { const b = Number(BigInt(t)); if (b >= 0 && b <= 10000) taxe = b / 100; } }
      out.set(j, (logo == null && socials == null && symbole == null) ? null : { logo, socials: socials || [], description, symbole: symbole ? symbole.replace(/[^\x20-\x7e]/g, '').slice(0, 24) : null, taxe });
    }
    return out;
  }

  /** Nom, symbole, description, reseaux, logo des jetons en file du carnet (lancements_carnet.js) :
   *  5 eth_call par jeton, 4 jetons = un lot de 20 = une requete HTTP. Une erreur (budget, noeud)
   *  laisse la file telle quelle : elle est relue au cycle suivant. */
  async function metasDuCarnet(bilan) {
    const q = deps.carnet.aLire();
    if (!q.length) return;
    try {
      const rs = await R.lot(q.flatMap(({ jeton: j }) => [SEL_NAME, SP.SELECTEUR.SYMBOL, SP.SELECTEUR.DESCRIPTION, SP.SELECTEUR.SOCIALS, SP.SELECTEUR.LOGO]
        .map((s) => ({ method: 'eth_call', params: [{ to: j, data: s }, 'latest'] }))));
      q.forEach(({ jeton: j }, i) => {
        const r = (k) => { const x = rs[i * 5 + k]; return (x && x.result) || null; };
        const nom = SP.chaineAbi(r(0)), symbole = SP.chaineAbi(r(1)), description = SP.chaineAbi(r(2)), socials = SP.decodeSocials(r(3)), logo = SP.chaineAbi(r(4));
        deps.carnet.meta(j, nom == null && symbole == null ? null : { nom, symbole, description, socials: socials || [], logo });
      });
      bilan.carnetMetas = q.length;
    } catch (e) { bilan.carnetMetas = 'erreur : ' + String((e && e.message) || e).slice(0, 60); }
  }

  // ---------------------------------------------------------- un lancement
  const txCourt = (t) => (t ? { from: lc(t.from), to: lc(t.to), value: t.value, gas: t.gas, maxFeePerGas: t.maxFeePerGas || null } : null);
  function quiTexte(l, tx, j) {
    const q = [];
    const dep = l.deployer || l.createur;
    if (dep) q.push((l.plateforme === 'ignition' ? 'créateur ' : 'deployer ') + court(dep) + (L.devConnu(dep) ? ' (dev connu : ' + L.devConnu(dep).groupe + ')' : ''));
    if (tx && tx.from && tx.from !== dep) q.push('tx.from ' + court(tx.from) + (L.devConnu(tx.from) ? ' (dev connu : ' + L.devConnu(tx.from).groupe + ')' : ''));
    if (tx && tx.to) q.push('tx.to ' + court(tx.to));
    if (j && j.achatDevEth != null) q.push('achat du dev ' + SP.versEth(BigInt(Math.round(j.achatDevEth * 1e6)) * 10n ** 12n).toString().replace('.', ',') + ' ETH (' + j.achatSource + ')');
    for (const s of (j && j.signaux) || []) if (s.cle !== 'dev_connu') q.push(s.texte);
    return q;
  }
  /* qui, pour le public : des adresses et des montants, les noms se font la-bas */
  function quiPublic(l, tx, j) {
    const dep = l.deployer || l.createur;
    const q = [];
    if (dep) q.push({ adresse: dep, role: 'deployer', eth: j && j.achatDevEth != null ? j.achatDevEth : null });
    if (tx && tx.from && tx.from !== dep) q.push({ adresse: tx.from, role: 'tx_from' });
    return q;
  }
  /* la categorie publique d'une source (smart_pons.SOURCES) */
  const catDe = (src) => ({ [SP.SOURCES.DEV]: 'dev', [SP.SOURCES.IGNITION]: 'ignition', [SP.SOURCES.COPIE]: 'copie', [SP.SOURCES.REBOND]: 'rebond' })[src] || 'pons';
  /* le prix USD d'un jeton au dernier echange de sa courbe (meme calcul que prixCourbe) */
  const prixUsdDe = (dernier, coteEth) => {
    if (!coteEth || !dernier || !ethUsd()) return null;
    try { const c = BigInt(dernier.cote), j = BigInt(dernier.jetons); return j > 0n ? Number((c * 10n ** 12n) / j) / 1e12 * ethUsd() : null; } catch (e) { return null; }
  };
  const titre = (j) => {
    const s = j.signaux[0];
    if (!s) return 'LANCEMENT — ' + ((j.attention[0] && j.attention[0].texte) || '?');
    return 'LANCEMENT — ' + s.texte;
  };

  // ---------------------------------------------------------- le cycle
  let enCours = null;
  async function cycle() {
    if (!C.lancements) return { fait: 'off' };
    if (enCours) return { fait: 'deja' };
    enCours = (async () => {
      const t0 = maintenant();
      R.nouvellePasse();      // le budget du client : CYCLE_APPELS et CYCLE_OCTETS (smart_money le cree ainsi)
      const bilan = { lancements: 0, ignition: 0, graduations: 0, alertes: 0, t2: 0, copies: 0, ignores: {}, statut: 'ok' };
      try {
        const P = await R.pointe();
        const haut = P.pointe - CONFIRMATIONS;
        let de = lis('lance_bloc', null);
        de = de == null ? haut - 599 : de + 1;
        if (haut - de + 1 > RATTRAPAGE_MAX) { bilan.saute = haut - RATTRAPAGE_MAX + 1 - de; de = haut - RATTRAPAGE_MAX + 1; note('lancements', bilan.saute + ' blocs sautes (rattrapage borne a ' + RATTRAPAGE_MAX + ')'); }
        if (de > haut) return Object.assign(bilan, { fait: 'rien' });
        const a = Math.min(haut, de + FENETRE_MAX - 1);
        bilan.de = de; bilan.a = a;
        /* 2. les usines */
        const usines = [SP.ADR.USINE_PONS].concat(C.ignition ? L.BRIEF2.IGNITION.usines : []);
        const lu = await logsExacts({ address: usines, topics: [[SP.TOPIC.LANCE_PONS, SP.TOPIC.LANCE_IGNITION]] }, de, a);
        const pons = [], ign = [];
        for (const l of lu) {
          const ad = lc(l.address);
          if (ad === SP.ADR.USINE_PONS) { const x = SP.decodeLancementPons(l); if (x) pons.push(x); }
          else if (L.BRIEF2.IGNITION.usines.includes(ad)) { const x = SP.decodeLancementIgnition(l); if (x) ign.push(x); }
        }
        bilan.lancements = pons.length; bilan.ignition = ign.length;
        for (const x of pons) connais(x.courbe, { jeton: x.jeton, bloc: x.bloc, cote: x.cote, seuil: x.seuil.toString(), deployer: x.deployer });
        /* 3. les courbes, sans adresse, puis filtrees */
        const lc2 = await logsExacts({ topics: [[SP.TOPIC.ACHAT, SP.TOPIC.VENTE, SP.TOPIC.EXEMPTION, SP.TOPIC.GRADUATION_COURBE]] }, de, a);
        const evts = lc2.map(SP.decodeCourbe).filter(Boolean);
        const parCourbe = new Map();
        for (const e of evts) { if (!parCourbe.has(e.courbe)) parCourbe.set(e.courbe, []); parCourbe.get(e.courbe).push(e); }
        /* les achats sur courbe des wallets suivis (section 4) et exclus (5) */
        const copies = [];
        for (const e of evts) {
          if (e.genre !== 'achat') continue;
          const r = L.roleV2(e.destinataire);
          if (!r) continue;
          if (r.role === 'exclu') { bilan.ignores.exclu = (bilan.ignores.exclu || 0) + 1; continue; }
          if (C.copie) copies.push(e);
        }
        /* 4. le lot : nonce IGNITION, ETH/USD, tx */
        const S = suivi();
        const txVoulues = [...new Set(pons.map((x) => x.tx).concat(ign.map((x) => x.tx)).concat(copies.map((e) => e.tx)))].slice(0, LOT_TX_MAX);
        const q = [];
        if (C.ignition) q.push({ method: 'eth_getTransactionCount', params: [L.BRIEF2.IGNITION.wallet, 'latest'] });
        const veutPrix = maintenant() - etat.ethUsdT >= ETH_USD_MS || etat.ethUsd == null;
        if (veutPrix) q.push({ method: 'eth_call', params: [{ to: SP.ADR.REF_ETH_USDG, data: SP.SELECTEUR.SLOT0 }, 'latest'] });
        for (const h of txVoulues) q.push({ method: 'eth_getTransactionByHash', params: [h] });
        const rs = q.length ? await R.lot(q) : [];
        let k = 0;
        const nonce = C.ignition ? (rs[k++] || {}).result : null;
        if (veutPrix) { const p = SP.ethUsdDepuisSlot0((rs[k++] || {}).result); if (p) { etat.ethUsd = p; etat.ethUsdT = maintenant(); } }
        const txs = new Map(); for (const h of txVoulues) { const t = (rs[k++] || {}).result; if (t) txs.set(lc(h), t); }

        /* 5. les nouveaux lancements Pons : jugement sans meta, puis meta pour
           ceux qui alertent */
        const finances = new Set(Object.keys(lis('ignition_finances', {})));
        const juges = [];
        for (const l of pons) {
          const tx = txs.get(l.tx) || null;
          const ev = (parCourbe.get(l.courbe) || []);
          const devs = [l.deployer, tx && lc(tx.from)].filter(Boolean).concat((L.devConnu(l.deployer) || { adresses: [] }).adresses);
          const e0 = SP.etatCourbe(ev.filter((e) => e.tx === l.tx), { devs });
          const coteEth = l.cote === SP.ADR.ETH;
          /* l'achat du dev : son Buy dans la tx de lancement ; a defaut,
             jugeLancement prend tx.value moins le droit de lancement */
          const f = { lancement: l, tx: txCourt(tx), achatDevEth: coteEth && e0.achatsDev > 0n ? SP.versEth(e0.achatsDev) : null, exemptions: SP.etatCourbe(ev, {}).exemptions, meta: null, taxe: null, finances };
          const j0 = SP.jugeLancement(f);
          /* la courbe entre en attente de son T+2 */
          S[l.courbe] = versJson({ jeton: l.jeton, courbe: l.courbe, bloc: l.bloc, deployer: l.deployer, cote: l.cote, seuil: l.seuil, tx: txCourt(tx), devs: [...new Set(devs)],
            t2Fait: false, alerte: null, suivre: false, acheteurs: [], achete: '0', net: '0', ventesDev: 0, exemptions: 0, gradue: false, dernier: null, dernierBloc: l.bloc, achatDevEth: j0.achatDevEth, achatSource: j0.achatSource });
          if (j0.alerte) juges.push({ l, f, j0 });
        }
        const metas = await metaDe(juges.slice(0, META_PAR_CYCLE).map((x) => ({ jeton: x.l.jeton, courbe: x.l.courbe })));
        for (const { l, f } of juges) {
          f.meta = metas.has(l.jeton) ? metas.get(l.jeton) : null;
          f.taxe = f.meta && typeof f.meta.taxe === 'number' ? f.meta.taxe : null;
          const j = SP.jugeLancement(f);
          if (!j.alerte) continue;
          const s = S[l.courbe];
          const m = f.meta || {};
          const seuilEth = l.cote === SP.ADR.ETH ? SP.versEth(l.seuil) : null;
          const ev = parCourbe.get(l.courbe) || [];
          const ec = SP.etatCourbe(ev, { devs: s.devs });
          const promo = await promoDe(l.jeton);
          const age = Math.max(0, (a - l.bloc) * S_PAR_BLOC / 60);
          const r = await alerte('lancement', 'lancement:' + l.jeton, l.jeton, {
            verdict: j.verdict, titre: titre(j), symbole: m.symbole, jeton: l.jeton, ageMin: age,
            courbe: { eth: l.cote === SP.ADR.ETH ? SP.versEth(ec.achete) : null, seuilEth, gradue: ec.gradue },
            qui: quiTexte(l, f.tx, j), promo, risque: j.risque, plan: SP.plan(j.verdict), lienX: SP.lienX(m.socials),
            pub: { categorie: catDe(j.source), titre: { cle: 'lancement', val: j.signaux[0] ? { cle: j.signaux[0].cle, val: j.signaux[0].val } : { cle: (j.attention[0] || {}).cle } },
              qui: quiPublic(l, f.tx, j), risque: j.risqueCode, plan: { cle: j.verdict }, capSource: 'curve', prixUsd: prixUsdDe(ec.dernierPrix, l.cote === SP.ADR.ETH) },
          });
          if (r.ok) bilan.alertes++;
          s.alerte = j.verdict; s.suivre = true; s.symbole = m.symbole || null; s.lienX = SP.lienX(m.socials); s.source = j.source; s.taxe = f.taxe;
          if (j.verdict !== 'rouge') {
            signal({ jeton: l.jeton, symbole: m.symbole, verdict: j.verdict, source: j.source, courbe: true,
              conditions: j.signaux.map((x) => ({ cle: x.cle, etat: 'ok' })).concat(j.mauvais.map((x) => ({ cle: x.cle, etat: 'echec' }))), inconnues: j.inconnues,
              wallets: [{ wallet: l.deployer, role: j.devConnu ? 'DEV:' + j.devConnu.groupe : 'DEPLOYER' }] });
            surveille(l.jeton, { symbole: m.symbole, courbe: l.courbe });
          }
        }
        /* 6. les lancements IGNITION (leurs usines : pas de courbe Pons) */
        for (const l of ign) {
          const tx = txs.get(l.tx) || null;
          const meta = (await metaDe([l.jeton])).get(l.jeton) || null;
          const j = SP.jugeLancement({ lancement: l, tx: txCourt(tx), achatDevEth: null, exemptions: null, meta, taxe: null, finances });
          /* le carnet (21/10) : un lancement IGNITION n'a pas de T+2 ; il est ecrit a sa lecture */
          if (deps.carnet) { try { deps.carnet.naissance({ jeton: l.jeton, plateforme: 'ignition', bloc: l.bloc, t: maintenant() - (a - l.bloc) * S_PAR_BLOC * 1000, deployer: l.createur || l.deployer, tx: txCourt(tx), symbole: meta && meta.symbole }); } catch (e) { /* rien */ } }
          const promo = await promoDe(l.jeton);
          const r = await alerte('ignition', 'ignition:' + l.jeton, l.jeton, {
            verdict: j.verdict === 'vert' ? 'jaune' : j.verdict, titre: 'IGNITION — lancement sur leur usine', symbole: meta && meta.symbole, jeton: l.jeton, ageMin: Math.max(0, (a - l.bloc) * S_PAR_BLOC / 60),
            courbe: null, qui: quiTexte(l, txCourt(tx), j), promo, risque: j.risque, plan: SP.plan('jaune'), lienX: meta && SP.lienX(meta.socials),
            pub: { categorie: 'ignition', titre: { cle: 'ignition_usine' }, qui: quiPublic(l, txCourt(tx), j), risque: j.risqueCode, plan: { cle: 'jaune' }, refDifferee: true },
          });
          if (r.ok) bilan.alertes++;
          signal({ jeton: l.jeton, symbole: meta && meta.symbole, verdict: 'jaune', source: SP.SOURCES.IGNITION, courbe: false, inconnues: j.inconnues,
            wallets: [{ wallet: l.createur, role: 'IGNITION' }] });
          surveille(l.jeton, { symbole: meta && meta.symbole });
        }
        /* 7. les graduations : CurveCompleted, lu avec les evenements des courbes (8) */
        bilan.graduations = evts.filter((e) => e.genre === 'graduation' && S[e.courbe]).length;
        /* 8. les evenements des courbes en attente ou suivies */
        for (const [c, ev] of parCourbe) {
          const s = S[c]; if (!s) continue;
          const devs = new Set(s.devs);
          const ach = new Set(s.acheteurs);
          let achete = BigInt(s.achete || '0'), net = BigInt(s.net || '0');
          let ventesDev = s.ventesDev || 0;
          for (const e of ev.sort((x, y) => x.bloc - y.bloc || x.i - y.i)) {
            const avantT2 = e.bloc <= s.bloc + SP.BLOCS_2MIN;
            if (e.genre === 'achat') {
              if (!devs.has(e.destinataire) && ach.size < ACHETEURS_GARDES && (avantT2 || s.suivre)) ach.add(e.destinataire);
              if (avantT2 && !devs.has(e.destinataire)) achete += e.cote;      // le T+2 : achats des autres jusqu'a lancement + 1 189 blocs
              net += e.cote;                       // la progression de la courbe (achats - ventes, en cote)
              if (e.jetons > 0n) s.dernier = { cote: e.cote.toString(), jetons: e.jetons.toString(), bloc: e.bloc };
              s.dernierBloc = e.bloc;
            } else if (e.genre === 'vente') {
              if (devs.has(e.expediteur) || devs.has(e.destinataire)) ventesDev++;
              net -= e.cote;
              if (e.jetons > 0n) s.dernier = { cote: e.cote.toString(), jetons: e.jetons.toString(), bloc: e.bloc };
              s.dernierBloc = e.bloc;
            } else if (e.genre === 'exemption') s.exemptions = (s.exemptions || 0) + 1;
            else if (e.genre === 'graduation') s.gradue = true;
          }
          const venteNeuve = ventesDev > (s.ventesDev || 0);
          s.acheteurs = [...ach]; s.achete = achete.toString(); s.net = net.toString(); s.ventesDev = ventesDev;
          /* « le dev ou ses wallets vendent = sortir », sur une courbe ALERTEE.
             `annonce === false` : un bon signe T+2 garde pour la colonie, jamais envoye
             (SMART_T2_ALERTE eteint). Mesure du 17/10/2026, 12:20-21:25 UTC : 24 des 30
             alertes publiques etaient des « EXIT » sur des jetons sans AUCUNE alerte
             d'entree avant (age 3 a 72 min, la plupart 3-7 min : juste apres le T+2) —
             une sortie d'une position que personne n'avait. Elles restent notees. */
          if (venteNeuve && s.suivre && s.annonce === false) note('lancements', 'le dev vend ' + s.jeton + ' (bon signe T+2 jamais envoye) : pas d alerte de sortie');
          if (venteNeuve && s.suivre && s.annonce !== false) {
            const r = await alerte('sortie', 'sortie:' + s.jeton, s.jeton, { verdict: 'rouge', titre: 'SORTIR — le dev vend', symbole: s.symbole, jeton: s.jeton,
              ageMin: (a - s.bloc) * S_PAR_BLOC / 60, courbe: { eth: s.cote === SP.ADR.ETH ? SP.versEth(BigInt(s.net)) : null, seuilEth: s.cote === SP.ADR.ETH ? SP.versEth(BigInt(s.seuil)) : null, gradue: s.gradue },
              qui: ['deployer ' + court(s.deployer)], promo: undefined, risque: 'le dev ou ses wallets vendent : sortir', plan: SP.plan('rouge', { sortie: true }), lienX: s.lienX,
              pub: { categorie: catDe(s.source), titre: { cle: 'sortie' }, qui: [{ adresse: s.deployer, role: 'deployer' }], risque: { cle: 'dev_vend' }, plan: { cle: 'rouge', val: { sortie: true } },
                capSource: 'curve', prixUsd: prixUsdDe(s.dernier, s.cote === SP.ADR.ETH) } });
            if (r.ok) bilan.alertes++;
          }
        }
        /* 9. le T+2 */
        const t2Bons = [];
        for (const c of Object.keys(S)) {
          const s = S[c];
          if (s.t2Fait || a < s.bloc + SP.BLOCS_2MIN) continue;
          s.t2Fait = true; bilan.t2++;
          const coteEth = s.cote === SP.ADR.ETH;
          const j2 = SP.jugeT2({ acheteurs: s.acheteurs.length, achete: BigInt(s.achete), ventesDev: s.ventesDev, gradue: s.gradue }, { coteEth });
          s.t2 = { acheteurs: j2.acheteurs, eth: j2.eth, bon: j2.bon };
          /* le carnet des lancements (21/10) : CHAQUE lancement, alerte ou non, a son T+2 */
          if (deps.carnet) { try { deps.carnet.naissance({ jeton: s.jeton, courbe: s.courbe, plateforme: 'pons', bloc: s.bloc, t: maintenant() - (a - s.bloc) * S_PAR_BLOC * 1000, deployer: s.deployer,
            coteEth, seuilEth: coteEth ? SP.versEth(BigInt(s.seuil)) : null, achatDevEth: s.achatDevEth, achatSource: s.achatSource, t2: { acheteurs: j2.acheteurs, eth: j2.eth }, acheteurs: s.acheteurs,
            exemptions: s.exemptions, ventesDev: s.ventesDev, gradue: s.gradue, tx: s.tx, symbole: s.symbole }); } catch (e) { note('carnet', String((e && e.message) || e).slice(0, 80)); } }
          if (j2.bon) t2Bons.push(s);
          else if (s.suivre && s.alerte && s.alerte !== 'rouge') note('lancements', 'T+2 ' + s.jeton + ' : ' + j2.acheteurs + ' acheteurs, ' + (j2.eth == null ? '?' : j2.eth.toFixed(3)) + ' ETH — pas de bon signe');
        }
        /* les metas d'un bon signe seul ne sont lues que s'il part au proprietaire */
        const metas2 = await metaDe(C.t2Alerte ? t2Bons.filter((s) => !s.suivre).slice(0, META_PAR_CYCLE).map((s) => ({ jeton: s.jeton, courbe: s.courbe })) : []);
        for (const s of t2Bons) {
          const deja = !!s.suivre;
          const meta = deja ? { symbole: s.symbole, socials: s.lienX ? [s.lienX] : [], logo: null } : (metas2.get(s.jeton) || null);
          const j = SP.jugeLancement({ lancement: { plateforme: 'pons', deployer: s.deployer, cote: s.cote }, tx: s.tx, achatDevEth: s.achatDevEth, exemptions: s.exemptions, meta, taxe: deja ? (s.taxe == null ? null : s.taxe) : (meta && typeof meta.taxe === 'number' ? meta.taxe : null), finances, devVend: s.ventesDev > 0 });
          const verdict = s.ventesDev > 0 ? 'rouge' : j.mauvais.length ? 'jaune' : 'vert';
          const envoyer = deja || C.t2Alerte;
          const promo = envoyer ? await promoDe(s.jeton) : undefined;
          const r = !envoyer ? { ok: false } : await alerte('t2', 't2:' + s.jeton, s.jeton, { verdict, titre: 'T+2 — bon signe (' + s.t2.acheteurs + ' acheteur' + (s.t2.acheteurs > 1 ? 's' : '') + ', ' + (s.t2.eth == null ? '?' : s.t2.eth.toFixed(2).replace('.', ',')) + ' ETH)',
            symbole: (meta && meta.symbole) || s.symbole, jeton: s.jeton, ageMin: 2,
            courbe: { eth: s.cote === SP.ADR.ETH ? SP.versEth(BigInt(s.net)) : null, seuilEth: s.cote === SP.ADR.ETH ? SP.versEth(BigInt(s.seuil)) : null, gradue: s.gradue },
            qui: quiTexte({ plateforme: 'pons', deployer: s.deployer }, s.tx, null), promo, risque: s.ventesDev > 0 ? 'le dev vend : sortir' : j.mauvais.length ? j.mauvais[0].texte : 'la plupart rechutent de 60 à 90 % après leur premier pic (brief)',
            plan: SP.plan(verdict, { sortie: s.ventesDev > 0 }), lienX: meta && SP.lienX(meta.socials),
            pub: { categorie: catDe(deja ? s.source : SP.SOURCES.LANCEMENT), titre: { cle: 't2', val: { acheteurs: s.t2.acheteurs, eth: s.t2.eth } }, qui: [{ adresse: s.deployer, role: 'deployer' }],
              risque: s.ventesDev > 0 ? { cle: 'dev_vend' } : j.mauvais.length ? { cle: j.mauvais[0].cle, val: j.mauvais[0].val } : { cle: 'rechute' },
              plan: { cle: verdict, val: { sortie: s.ventesDev > 0 } }, capSource: 'curve', prixUsd: prixUsdDe(s.dernier, s.cote === SP.ADR.ETH) } });
          if (r.ok) bilan.alertes++;
          if (!envoyer) bilan.t2Seuls = (bilan.t2Seuls || 0) + 1;
          if (!deja) { s.suivre = true; s.annonce = envoyer; s.alerte = verdict; s.symbole = meta && meta.symbole; s.lienX = meta && SP.lienX(meta.socials); s.source = SP.SOURCES.LANCEMENT; }
          if (verdict !== 'rouge') {
            signal({ jeton: s.jeton, symbole: s.symbole, verdict, source: deja ? (s.source || SP.SOURCES.LANCEMENT) : SP.SOURCES.LANCEMENT, courbe: true,
              conditions: [{ cle: 't2_bon', etat: 'ok', valeur: s.t2 }], inconnues: j.inconnues, wallets: [] });
            /* le rebond ne suit que ce qui a ete ALERTE (section 7 : « apres une alerte ») */
            if (envoyer) surveille(s.jeton, { symbole: s.symbole, courbe: s.courbe });
          }
        }
        /* 10. la copie sur courbe (sections 4 et 6) */
        for (const e of copies) {
          const k2 = await verifieCourbe(e.courbe, a);
          if (!k2) { bilan.ignores.pasPons = (bilan.ignores.pasPons || 0) + 1; continue; }
          const tx = txs.get(e.tx) || null;
          const memes = evts.filter((x) => x.tx === e.tx && x.genre === 'achat').map((x) => x.destinataire);
          const coteEth = k2.cote === SP.ADR.ETH;
          const s = S[e.courbe];
          const ec = SP.etatCourbe(parCourbe.get(e.courbe) || [], {});
          const dernier = ec.dernierPrix || (s && s.dernier ? { cote: BigInt(s.dernier.cote), jetons: BigInt(s.dernier.jetons) } : null);
          const cap = coteEth ? SP.capCourbeUsd(dernier, OFFRE_PONS, ethUsd()) : null;
          const usd = coteEth && ethUsd() ? SP.versEth(e.cote) * ethUsd() : null;
          const ageMin = (e.bloc - k2.bloc) * S_PAR_BLOC / 60;
          /* la liquidite d'une courbe : son ETH net × ETH/USD (regle du 16/10, jeunes jetons) */
          const liqUsd = coteEth && s && ethUsd() ? SP.versEth(BigInt(s.net || '0')) * ethUsd() : null;
          const fc = SP.filtreCopie({ wallet: e.destinataire, txFrom: tx && tx.from, listeMemeTx: SP.listeMemeTx(memes), usd, capUsd: cap, ageMin, liqUsd, createur: k2.deployer, exclusJeton: null, marche: !(s && s.gradue) && !ec.gradue });
          if (!fc.garde) { bilan.ignores[fc.raison] = (bilan.ignores[fc.raison] || 0) + 1; continue; }
          bilan.copies++;
          await copie({ jeton: k2.jeton, wallet: e.destinataire, voix: fc.voix, nom: fc.nom, usd, capUsd: cap, ageMin, inconnues: fc.inconnues, courbe: e.courbe, coteEth, tx: e.tx,
            etatCourbe: { eth: coteEth && s ? SP.versEth(BigInt(s.net || '0')) : null, seuilEth: coteEth ? SP.versEth(BigInt(k2.seuil)) : null, gradue: ec.gradue } }, bilan);
          if (!S[e.courbe]) S[e.courbe] = versJson({ jeton: k2.jeton, courbe: e.courbe, bloc: k2.bloc, deployer: k2.deployer, cote: k2.cote, seuil: k2.seuil, tx: null, devs: [k2.deployer], t2Fait: true,
            alerte: 'jaune', suivre: true, acheteurs: [], achete: '0', net: '0', ventesDev: 0, exemptions: 0, gradue: false, dernier: dernier ? { cote: dernier.cote.toString(), jetons: dernier.jetons.toString(), bloc: e.bloc } : null, dernierBloc: e.bloc, source: SP.SOURCES.COPIE });
        }
        /* 11. le menage : une courbe non suivie part apres son T+2 ; une
           courbe suivie part apres 150 min, 30 min d'inactivite ou sa
           graduation (le prix passe alors a DexScreener) */
        for (const c of Object.keys(S)) {
          const s = S[c];
          const ageMin = (a - s.bloc) * S_PAR_BLOC / 60, inactif = (a - (s.dernierBloc || s.bloc)) * S_PAR_BLOC / 60;
          if (!s.suivre && s.t2Fait) delete S[c];
          else if (s.suivre && (ageMin > SUIVI_MIN || inactif > INACTIF_MIN || s.gradue)) delete S[c];
        }
        const ks = Object.keys(S);
        if (ks.filter((c) => S[c].suivre).length > SUIVI_MAX || ks.length > JEUNES_MAX) {
          for (const c of ks.sort((p, q2) => S[p].bloc - S[q2].bloc)) { if (Object.keys(S).length <= JEUNES_MAX && Object.keys(S).filter((x) => S[x].suivre).length <= SUIVI_MAX) break; delete S[c]; }
        }
        ecris('lance_suivi', S);
        /* 12. IGNITION : chaque contrat deploye par son wallet */
        if (C.ignition && nonce) await nonceIgnition(parseInt(nonce, 16), bilan);
        /* 13. le rebond */
        if (C.rebond) await rebond(bilan);
        ecris('lance_bloc', a);
        /* 14. le carnet des lancements : les metadonnees de quelques jetons, en UN lot, a la fin du
           cycle (un budget epuise ici ne coupe rien d'autre) */
        if (deps.carnet) await metasDuCarnet(bilan);
      } catch (e) {
        bilan.statut = e.budget ? 'budget' : e.abandon ? 'abandon' : 'erreur';
        bilan.erreur = String((e && e.message) || e).slice(0, 200);
        note('lancements', bilan.statut + ' : ' + bilan.erreur);
      }
      bilan.appels = R.etat.passe.appels; bilan.rpc = R.etat.passe.rpc; bilan.octets = R.etat.passe.octets; bilan.ms = maintenant() - t0;
      etat.dernierCycle = Object.assign({ t: Math.floor(maintenant() / 1000) }, bilan);
      etat.cycles++;
      try { B.pose('passes', { genre: 'lancements', debut: Math.floor(t0 / 1000), fin: Math.floor(maintenant() / 1000), statut: bilan.statut, appels: bilan.appels, octets: bilan.octets, gt: 0, ds: 0, jetons: bilan.lancements, detail: bilan }); } catch (e) { /* rien */ }
      if (bilan.alertes) { try { B.sauve(); } catch (e) { /* rien */ } }
      return bilan;
    })();
    try { return await enCours; } finally { enCours = null; }
  }

  // ---------------------------------------------------------- la copie (courbe ou DEX)
  /** Une fois par cle (jeton et voix) : un groupe = une voix, aussi pour la
   *  colonie. Bornee aux 500 dernieres cles. */
  function premiereFois(cle) {
    const v = lis('lance_vus', []);
    if (v.includes(cle)) return false;
    v.push(cle); if (v.length > 500) v.splice(0, v.length - 500);
    ecris('lance_vus', v);
    return true;
  }
  async function copie(c, bilan) {
    if (!premiereFois('copie:' + c.jeton + ':' + c.voix)) { if (bilan) bilan.copiesDeja = (bilan.copiesDeja || 0) + 1; return { ok: false }; }
    const inconnu = (c.inconnues || []).length > 0;
    const verdict = inconnu ? 'jaune' : 'vert';
    if (c.silencieux) {
      signal({ jeton: c.jeton, symbole: c.symbole, verdict, source: SP.SOURCES.COPIE, courbe: false, inconnues: c.inconnues, wallets: [{ wallet: c.wallet, role: 'COPIE_V2', minutes: 0 }] });
      return { ok: false, silencieux: true };
    }
    const promo = await promoDe(c.jeton);
    const meta = c.symbole ? { symbole: c.symbole } : (c.courbe ? ((await metaDe([c.jeton])).get(c.jeton) || {}) : {});
    const r = await alerte('copie', 'copie:' + c.jeton + ':' + c.voix, c.jeton, {
      verdict, titre: 'COPIE — ' + c.nom + ' achète' + (c.courbe ? ' sur la courbe' : ''), symbole: meta.symbole, jeton: c.jeton, ageMin: c.ageMin,
      courbe: c.courbe ? c.etatCourbe : null, capUsd: c.capUsd, capSource: c.courbe ? 'courbe, prix du dernier échange' : 'DexScreener, non vérifié',
      qui: [c.nom + ' (' + court(c.wallet) + ')' + (c.usd != null ? ' pour ' + SP.usdTexte(c.usd) : '') + (c.ageMin != null ? ', ' + SP.dureeTexte(c.ageMin) + ' après le lancement' : '')],
      promo, risque: inconnu ? 'non lu : ' + c.inconnues.join(', ') : 'la plupart rechutent de 60 à 90 % après leur premier pic (brief)', plan: SP.plan(verdict), lienX: meta.socials ? SP.lienX(meta.socials) : null,
      pub: { categorie: 'copie', titre: { cle: 'copie', val: { nom: SPUB.nomPublic(lc(c.wallet), 'buyer'), courbe: !!c.courbe } }, qui: [{ adresse: c.wallet, role: 'buyer', usd: c.usd, apresLancementMin: c.ageMin }],
        risque: inconnu ? { cle: 'inconnues', val: c.inconnues } : { cle: 'rechute' }, plan: { cle: verdict }, capSource: c.courbe ? 'curve' : 'dex',
        prixUsd: c.courbe && typeof c.capUsd === 'number' && c.capUsd > 0 ? c.capUsd / Number(OFFRE_PONS / 10n ** 18n) : null },
    });
    if (r.ok && bilan) bilan.alertes++;
    signal({ jeton: c.jeton, symbole: meta.symbole, verdict, source: SP.SOURCES.COPIE, courbe: !!c.courbe, inconnues: c.inconnues,
      wallets: [{ wallet: c.wallet, role: 'COPIE_V2', minutes: 0 }] });
    surveille(c.jeton, { symbole: meta.symbole, courbe: c.courbe || null });
    return r;
  }
  /**
   * Les achats DEX des wallets suivis, lus par la veille (smart_money.js).
   * `achats` : [{ jeton, wallet, tx, bloc, eth (BigInt wei), recu, t (s) }] ;
   * `ctx` : { transactions(hashes) -> Map, ageMin(jeton) -> min|null }.
   * Les filtres de la section 6, puis l'alerte. Rend le bilan.
   */
  async function copieDex(achats, ctx) {
    const bilan = { vus: achats.length, gardes: 0, alertes: 0, ignores: {} };
    if (!C.copie || !achats.length) return bilan;
    const txs = await ctx.transactions([...new Set(achats.map((x) => x.tx))]);
    for (const x of achats) {
      const tx = txs.get(x.tx) || null;
      /* une tx qui envoie le meme jeton a plusieurs wallets de la liste */
      const memes = ((x.recu && x.recu.logs) || []).filter((l) => lc(l.address) === x.jeton && lc(l.topics && l.topics[0]) === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && l.topics[2]).map((l) => '0x' + lc(l.topics[2]).slice(-40));
      let fa = null;
      const faits = ctx.faits || deps.faits;
      if (typeof faits === 'function') { try { fa = await faits(x.jeton); } catch (e) { fa = null; } }
      const usd = ethUsd() && x.eth != null ? SP.versEth(BigInt(x.eth)) * ethUsd() : null;
      const exclu = typeof deps.exclu === 'function' ? deps.exclu(x.jeton) : null;
      const ageMin = ctx.ageMin ? ctx.ageMin(x.jeton) : null;
      const fc = SP.filtreCopie({ wallet: x.wallet, txFrom: tx && tx.from, listeMemeTx: SP.listeMemeTx(memes), usd, capUsd: fa && typeof fa.mc === 'number' ? fa.mc : null, ageMin, liqUsd: fa && typeof fa.liq === 'number' ? fa.liq : null,
        exclusJeton: exclu, marche: fa ? (typeof fa.liq === 'number' ? fa.liq > 0 : true) : true });
      if (!fc.garde) { bilan.ignores[fc.raison] = (bilan.ignores[fc.raison] || 0) + 1; continue; }
      bilan.gardes++;
      /* un wallet que l'analyste du 1er brief juge deja (fort ou faible) : son
         verdict est parti au proprietaire ; la copie ne lui envoie pas une 2e
         alerte pour le meme achat, mais nourrit sa propre ligne (colonie) */
      const v1 = L.roleDe(x.wallet);
      const silencieux = !!(v1 && (v1.signal === 'fort' || v1.signal === 'faible'));
      if (silencieux) bilan.silencieux = (bilan.silencieux || 0) + 1;
      await copie({ jeton: x.jeton, wallet: x.wallet, voix: fc.voix, nom: fc.nom, usd, capUsd: fa && fa.mc, ageMin, inconnues: fc.inconnues, courbe: null, symbole: fa && fa.sym, tx: x.tx, silencieux }, bilan);
    }
    return bilan;
  }

  // ---------------------------------------------------------- IGNITION : les contrats de son wallet
  async function nonceIgnition(n, bilan) {
    const vu = lis('ignition_nonce', null);
    if (vu == null) { ecris('ignition_nonce', n); return; }        // 1re fois : l'histoire n'alerte pas
    if (n <= vu) return;
    const { utils } = require('ethers');
    const fin = Math.min(n, vu + IGNITION_NONCES_MAX);
    const adrs = []; for (let k = vu; k < fin; k++) adrs.push(utils.getContractAddress({ from: L.BRIEF2.IGNITION.wallet, nonce: k }).toLowerCase());
    const rs = await R.lot(adrs.flatMap((x) => [{ method: 'eth_getCode', params: [x, 'latest'] }, { method: 'eth_call', params: [{ to: x, data: SP.SELECTEUR.SYMBOL }, 'latest'] }]));
    for (let i = 0; i < adrs.length; i++) {
      const code = rs[2 * i] && rs[2 * i].result;
      if (!code || code === '0x') continue;
      const sym = SP.chaineAbi(rs[2 * i + 1] && rs[2 * i + 1].result);
      const r = await alerte('ignition', 'ignition:contrat:' + adrs[i], adrs[i], { verdict: 'jaune', titre: 'IGNITION — ' + (sym ? 'nouveau jeton' : 'nouveau contrat') + ' déployé par son wallet',
        symbole: sym, jeton: adrs[i], ageMin: 0, courbe: null, qui: ['wallet IGNITION ' + court(L.BRIEF2.IGNITION.wallet) + ', nonce ' + (vu + i)], promo: sym ? await promoDe(adrs[i]) : undefined,
        risque: sym ? 'jeton sans marché tant qu’aucune piscine n’est née' : 'un contrat n’est pas un jeton (pas de symbol())', plan: SP.plan('jaune'), lienX: null,
        /* 21/10 : un contrat sans symbol() n'est pas un jeton (releve : IGNITION publiait ses contrats
           utilitaires) — l'alerte privee reste, le public ne le voit plus. Un jeton sans marche est
           mesure depuis son premier prix (smart_public, reference differee). */
        pub: sym ? { categorie: 'ignition', titre: { cle: 'ignition_contrat', val: true }, qui: [{ adresse: L.BRIEF2.IGNITION.wallet, role: 'ignition_wallet' }], risque: { cle: 'sans_marche' }, plan: { cle: 'jaune' }, refDifferee: true } : null });
      if (r.ok) bilan.alertes++;
      if (sym) signal({ jeton: adrs[i], symbole: sym, verdict: 'jaune', source: SP.SOURCES.IGNITION, courbe: false, inconnues: ['marche'], wallets: [{ wallet: L.BRIEF2.IGNITION.wallet, role: 'IGNITION' }] });
    }
    ecris('ignition_nonce', fin);
  }

  // ---------------------------------------------------------- le rebond (section 7)
  async function rebond(bilan) {
    const s = lis('rebond_surv', {});
    const now = maintenant();
    let lus = 0;
    for (const j of Object.keys(s)) {
      const x = s[j];
      if (now - x.t > SURV_MS || (x.etat && x.etat.signale)) { delete s[j]; continue; }
      if (lus >= REBOND_PAR_CYCLE || now < x.prochain) continue;
      lus++;
      x.prochain = now + REBOND_RELIRE_MS;
      let obs = null;
      const c = x.courbe ? suivi()[x.courbe] : null;
      if (c && !c.gradue && c.dernier && c.cote === SP.ADR.ETH) obs = { mc: SP.capCourbeUsd({ cote: BigInt(c.dernier.cote), jetons: BigInt(c.dernier.jetons) }, OFFRE_PONS, ethUsd()), liq: null };   // sur la courbe : pas de liquidite DEX, jamais de signal
      else if (typeof deps.faits === 'function') { try { const f = await deps.faits(j); if (f) obs = { mc: f.mc, liq: f.liq }; } catch (e) { obs = null; } }
      const r = SP.suitRebond(x.etat, obs);
      x.etat = r.etat;
      if (r.signal) {
        const promo = await promoDe(j);
        const a = await alerte('rebond', 'rebond:' + j, j, { verdict: 'vert', titre: 'REBOND — −' + r.signal.chutePct + ' % depuis le plus haut, +' + r.signal.rebondPct + ' % depuis le creux',
          symbole: x.symbole, jeton: j, ageMin: (now - x.t) / 60000, courbe: null, capUsd: r.signal.prix, capSource: 'DexScreener, non vérifié', qui: ['surveillé depuis une alerte'], promo,
          risque: 'un rebond peut repartir sous le creux : stop juste dessous', plan: SP.plan('vert', { prix: 'capitalisation ~' + SP.usdTexte(r.signal.prix), stop: 'capitalisation ' + SP.usdTexte(r.signal.stop) + ' (5 % sous le creux)' }), lienX: null,
          pub: { categorie: 'rebond', titre: { cle: 'rebond', val: { chute: r.signal.chutePct, rebond: r.signal.rebondPct } }, qui: [], risque: { cle: 'rebond' },
            plan: { cle: 'vert', val: { prixCap: r.signal.prix, stopCap: r.signal.stop } }, capSource: 'dex' } });
        if (a.ok && bilan) bilan.alertes++;
        signal({ jeton: j, symbole: x.symbole, verdict: 'vert', source: SP.SOURCES.REBOND, courbe: false, conditions: [{ cle: 'rebond', etat: 'ok', valeur: r.signal }], inconnues: [], wallets: [] });
      }
    }
    ecris('rebond_surv', s);
  }

  // ---------------------------------------------------------- Relay (section 3)
  let relayEnCours = false;
  async function relay() {
    if (!C.relay) return { fait: 'off' };
    if (relayEnCours) return { fait: 'deja' };
    relayEnCours = true;
    const bilan = { lus: 0, envois: 0, nouveaux: 0, octets: 0, statut: 'ok' };
    try {
      const st = lis('relay_etat', {});
      if (st.pause && maintenant() < st.pause) return Object.assign(bilan, { fait: 'pause' });
      if (st.pause) delete st.pause;
      const fin = lis('ignition_finances', {});
      const liste = L.BRIEF2.IGNITION.solana;
      const rang = (Number(st.rang) || 0) % liste.length;
      st.rang = (rang + 1) % liste.length;
      for (const w of [liste[rang]]) {
        let j = null;
        try {
          const r = await deps.prendre(RELAY_URL + '?user=' + encodeURIComponent(w) + '&limit=' + RELAY_LIMITE, { signal: AbortSignal.timeout(RELAY_DELAI_MS) });
          if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
          const t = await r.text(); bilan.octets += Buffer.byteLength(t || '');
          j = JSON.parse(t);
        } catch (e) {
          st.pause = maintenant() + RELAY_PAUSE_MS; st.erreur = String((e && e.message) || e).slice(0, 80);
          bilan.statut = 'pause'; note('relay', 'Relay en pause 30 min : ' + st.erreur);
          break;
        }
        bilan.lus++;
        if (j && j.deprecation && j.deprecation.sunsetAt) st.retrait = String(j.deprecation.sunsetAt).slice(0, 10);
        for (const q of (j && Array.isArray(j.requests) ? j.requests : [])) {
          const m = (q && q.data && q.data.metadata) || {};
          const ci = m.currencyIn && m.currencyIn.currency, co = m.currencyOut && m.currencyOut.currency;
          if (!ci || !co || ci.chainId !== CHAINE_SOLANA || co.chainId !== CHAINE_RH) continue;
          const dest = lc(q.recipient);
          if (!/^0x[0-9a-f]{40}$/.test(dest)) continue;
          bilan.envois++;
          if (!fin[dest]) { bilan.nouveaux++; note('relay', 'wallet finance par ' + w.slice(0, 6) + '… : ' + dest); }
          fin[dest] = { t: Date.parse(q.createdAt) || maintenant(), sol: w.slice(0, 8), eth: m.currencyOut.amountFormatted ? String(m.currencyOut.amountFormatted).slice(0, 12) : null };
        }
      }
      for (const a of Object.keys(fin)) if (maintenant() - fin[a].t > FINANCES_GARDE_MS) delete fin[a];
      ecris('ignition_finances', fin);
      st.dernier = Math.floor(maintenant() / 1000);
      ecris('relay_etat', st);
    } finally { relayEnCours = false; etat.dernierRelay = Object.assign({ t: Math.floor(maintenant() / 1000) }, bilan); }
    return bilan;
  }

  /** Le prix (USD) d'un jeton sur sa courbe suivie, au dernier echange lu :
   *  pour les ombres de la colonie (un jeton sur la courbe n'a pas de prix
   *  DexScreener). null si la courbe n'est pas suivie, cotee hors ETH, ou si
   *  l'ETH n'a pas de prix. */
  function prixCourbe(jeton) {
    const j = lc(jeton);
    const S = lis('lance_suivi', {});
    const s = Object.values(S).find((x) => x.jeton === j && x.suivre);
    if (!s || !s.dernier || s.cote !== SP.ADR.ETH || !ethUsd()) return null;
    const cote = BigInt(s.dernier.cote), jet = BigInt(s.dernier.jetons);
    if (!(jet > 0n)) return null;
    return { prix: Number((cote * 10n ** 12n) / jet) / 1e12 * ethUsd(), liq: null, bloc: s.dernier.bloc, gradue: !!s.gradue };
  }

  function vue() {
    const S = lis('lance_suivi', {});
    const st = lis('relay_etat', {});
    return { config: C, cycle_s: CYCLE_MS / 1000, fenetre_max: FENETRE_MAX, rattrapage_max: RATTRAPAGE_MAX, budget: { cycle: { appels: CYCLE_APPELS, octets: CYCLE_OCTETS }, jour: { http: JOUR_HTTP, octets: JOUR_OCTETS } },
      jour: R && R.jour ? R.jour() : null, bloc: lis('lance_bloc', null), dernierCycle: etat.dernierCycle, cycles: etat.cycles,
      courbes: { suivies: Object.values(S).filter((x) => x.suivre).length, enAttenteT2: Object.values(S).filter((x) => !x.t2Fait).length },
      ignition: { nonce: lis('ignition_nonce', null), finances: Object.keys(lis('ignition_finances', {})).length },
      relay: { dernier: st.dernier || null, pause: st.pause && st.pause > maintenant() ? Math.floor(st.pause / 1000) : null, retrait: st.retrait || null, dernierBilan: etat.dernierRelay },
      rebond: Object.keys(lis('rebond_surv', {})).length, eth_usd: etat.ethUsd };
  }

  return { config: C, cycle, relay, copieDex, prixCourbe, vue, ethUsd, logsExacts, _metasDuCarnet: metasDuCarnet };
}

module.exports = { cree, config, ESPACE_LEGER_MS, CYCLE_MS, RELAY_MS, CONFIRMATIONS, FENETRE_MAX, RATTRAPAGE_MAX, CYCLE_APPELS, CYCLE_OCTETS, JOUR_HTTP, JOUR_OCTETS, SUIVI_MIN, RELAY_LIMITE, RELAY_URL, DS_ORDERS };
