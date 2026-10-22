'use strict';
/* ==================================================================
 * LE CARNET DES LANCEMENTS — CHAQUE JETON NE, GARDE ET SUIVI 30 JOURS
 * ==================================================================
 *
 * Demande du proprietaire (21/10/2026) : « enregistre le plus de donnees pour
 * comprendre comment ca fonctionne dans les coulisses : comment on cree un
 * jeton, quel meta fonctionne mieux, quel narratif, comment reconnaitre un
 * projet sur le long terme ».
 *
 * Ce qui existait (releve du code, 21/10) : chaque lancement Pons est juge a
 * T+2 min puis OUBLIE s'il n'alerte pas ; une courbe alertee est suivie
 * 150 min au plus ; les metadonnees (nom, description, reseaux) ne sont lues
 * que pour une alerte, 6 par cycle, et ne sont gardees nulle part. Aucun prix
 * a 1 jour, 7 jours ou 30 jours. On ne peut donc RIEN dire du long terme.
 *
 * Ce module ne decide rien et n'achete rien. Il ECRIT :
 *   1. la NAISSANCE de chaque lancement, a son T+2 (smart_lancements.js) :
 *      createur, achat du dev, acheteurs et ETH des 2 premieres minutes,
 *      exemptions, ventes du dev, gaz de la tx de lancement ;
 *   2. ses METADONNEES lues sur la chaine (nom, symbole, description,
 *      reseaux, logo), en file, au plus META_PAR_CYCLE jetons par cycle des
 *      lancements, dans UN lot JSON-RPC (budget du noeud : voir plus bas) ;
 *   3. son SUIVI a +1 h, +6 h, +24 h, +7 j, +30 j : DexScreener tokens/v1
 *      (30 jetons par appel, AU PLUS un appel par cycle), prix, capitalisation,
 *      liquidite, volume et transactions 24 h. Un jeton encore sur sa courbe
 *      Pons n'a pas de marche DexScreener : il est note « pas de marche ».
 *
 * Stockage : DATA_DIR/lancements/AAAA-MM-JJ.jsonl, une ligne par evenement,
 * jamais reecrite (le motif de observatoire.js). Une fiche COMPACTE par jeton
 * vit en memoire (reconstruite au demarrage depuis les JOURS_GARDES derniers
 * jours) : le bilan se calcule sur elle, pas en relisant les fichiers.
 *
 * ---- QUI TIENT LE PROJET (21/10/2026, le proprietaire) ----
 * « Un memecoin sans taxe, sans utilite, avec un narratif, se fait souvent rug
 * par le dev, et parfois il est repris en CTO par la communaute : il faut savoir
 * differencier un projet gere par une equipe et un projet gere par la
 * communaute. » Lectures de plus, toutes en LECTURE :
 *   - les AVOIRS DU CREATEUR (balanceOf du deployer) a +1 h, +24 h, +7 j,
 *     +30 j : un dev qui a tout vendu n'est plus l'equipe ;
 *   - la TAXE du createur (creatorTaxBps de la courbe Pons) a la naissance ;
 *   - les commandes DexScreener (orders/v1) d'un jeton qui a encore un marche a
 *     +24 h, +7 j, +30 j : `communityTakeover` est la marque d'un CTO
 *     (type verifie dans la doc DexScreener le 21/10), `tokenProfile`, pubs ;
 *   - les METAS de DexScreener (/metas/trending/v1 puis /metas/meta/v1/<slug>),
 *     une fois par jour : leur propre classement de narratifs (cat, dog, ai,
 *     trump, stonks…), qui listait 9 jetons robinhood le 21/10 (5 metas lues).
 * La GOUVERNANCE est une HYPOTHESE (`gouvernance`), a juger sur la mesure :
 *   cto      : commande communityTakeover, OU createur parti (moins de 10 % de son
 *              plus haut) et jeton vivant ;
 *   team     : createur encore la (au moins 50 % de son plus haut) et vivant ;
 *   rug      : createur parti et jeton mort (pas de marche, ou < VIVANT_LIQ) ;
 *   abandoned: createur encore la et jeton mort ; le reste est dit tel quel.
 *
 * ---- LES DETENTEURS ET L'ACTIVITE (21/10/2026, la grille du proprietaire) ----
 * « Pourcentage detenu par les 10 et 20 premiers portefeuilles, concentration
 * reelle apres exclusion des contrats, pools et burn » ; « utilisateurs actifs,
 * nouveaux portefeuilles, adresses qui reviennent reellement ». Pour un jeton
 * VIVANT a +24 h, +7 j, +30 j : tous ses Transfer depuis sa naissance
 * (eth_getLogs sur le noeud ; Blockscout repond un defi Cloudflare, sonde du
 * 11/10, et on ne le contourne pas), un jeton par cycle au plus. On en tire :
 * detenteurs, part du top 10 et du top 20 HORS courbe, piscines, PoolManager v4
 * et burn, transferts, adresses actives, nouvelles et revenantes sur 24 h.
 *
 * Le bilan (`bilan()`, route /ai/lancements) groupe les lancements par trait
 * (theme du nom, reseaux, description, achat du dev, acheteurs a T+2, passe du
 * createur, heure) et dit, par groupe, la part VIVANTE a 24 h et a 7 j. Sous
 * BILAN_ASSEZ fiches mesurees, il donne le nombre et REFUSE la part : une
 * poignee de jetons, c'est de la chance, pas un resultat.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const MC = require('./marche_contexte');   /* les tranches de marche BTC/ETH (22/10) : pures, aucun reseau */

/* Les echeances du suivi, en minutes. CHOISI : la colonie juge a 20-120 min ;
   ici on cherche ce qui DURE. */
const HORIZONS = [['1h', 60], ['6h', 360], ['24h', 1440], ['7j', 10080], ['30j', 43200]];
/* Une echeance lue trop tard (serveur arrete) n'est pas cette echeance : elle
   est comptee « manquee », jamais ecrite sous une autre etiquette. Retard admis :
   15 min ou 25 % de l'echeance, le plus grand. CHOISI. */
const retardAdmisMin = (h) => Math.max(15, h * 0.25);
/* Budget du noeud, lu en direct le 21/10 a 20:59 UTC : le client des lancements
   avait fait 4 997 requetes HTTP sur son plafond de 8 000 (JOUR_HTTP), soit
   ~5 700 projetees sur 24 h. 3 jetons x 6 lectures (nom, symbole, description,
   reseaux, logo, taxe) + 2 soldes = 20 eth_call = UN lot (LOT de smart_rpc) = une
   requete HTTP par cycle au plus ; ~1 664 lancements par jour / 3 = ~555
   requetes, et 4 soldes par jeton (1 h, 24 h, 7 j, 30 j) = ~6 650 eth_call
   groupes par 20 = ~330 requetes : ~6 600 sur 8 000 au total. CHOISI. */
const LOT_RPC = 20;
const SOLDES_H = ['1h', '24h', '7j', '30j'];
const SOLDES_FILE_MAX = 5000;
/* Les commandes DexScreener (orders/v1, 60 par minute, doc) : un jeton VIVANT a
   +24 h, +7 j, +30 j ; au plus 2 appels par tic (un tic par minute). CHOISI. */
const ORDRES_H = ['24h', '7j', '30j'];
const ORDRES_PAR_TIC = 2;
/* Les metas de DexScreener : la liste une fois par 24 h, puis une meta par tic. CHOISI. */
const METAS_DS_MS = 24 * 3600e3;
const PONS_OFFRE = 1e9;                 // offre d'un jeton Pons, en unites entieres (sonde du 15/10 : totalSupply 1e27, 18 decimales)
const META_PAR_CYCLE = 3;
const META_ESSAIS = 3;                 // un jeton sans metadonnee lisible apres 3 lots : abandonne, compte
const META_FILE_MAX = 3000;            // ~2 jours de lancements en retard au plus : au-dela les plus vieux partent, comptes
const DS_LOT = 30;                     // DexScreener tokens/v1 : 30 adresses par appel (doc, smart_sources.js)
const DS_DELAI_MS = 8000;
const JOURS_GARDES = 120;              // fichiers gardes sur le volume (~2,5 Mo par jour) : CHOISI
const JOURS_MEMOIRE = 32;              // fiches reconstruites au demarrage : le suivi va a 30 j
const BILAN_ASSEZ = 40;                // comme smart_public.BILAN_ASSEZ et AUDIT_ASSEZ du site
const BILAN_CACHE_MS = 10 * 60e3;
/* « Vivant » : un marche DexScreener avec au moins 5 000 $ de liquidite. CHOISI :
   le plancher de piscine de la colonie est 13 000 $ (releve du 21/10) ; ici on
   veut savoir ce qui EXISTE encore, pas ce qu'on achete. */
const VIVANT_LIQ = 5000;
const DS = 'https://api.dexscreener.com';
const SEL_BALANCE = '0x70a08231';
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';   // keccak verifie le 21/10
/* Jamais des detenteurs : le burn, et le PoolManager v4 (miroir.js PM4) ou dorment les jetons
   de toute piscine v4, donc d'un jeton Pons gradue. */
const EXCLUS_FIXES = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '0x8366a39cc670b4001a1121b8f6a443a643e40951'];
const BLOCS_24H = Math.round(86400 / 0.1012);   // smart_lancements S_PAR_BLOC (sonde du 15/10 : 6 000 blocs = 607 s)
const DET_H = ['24h', '7j', '30j'];
const DET_FILE_MAX = 500;      // balanceOf(address) — keccak verifie (ethers utils.id) le 21/10

/* Les themes : des HYPOTHESES de depart, mots entiers sur nom + symbole +
   description. Un jeton peut en avoir plusieurs, ou aucun (« other »). Le bilan
   dira lesquels tiennent ; la liste se corrige sur la mesure. */
const THEMES = {
  ai: /\b(ai|a\.i|gpt|agent|agents|bot|neural|llm|agi|robot|robo)\b/i,
  dog: /\b(dog|doge|shib|inu|puppy|pup|swoge|woof|bonk|wif)\b/i,
  cat: /\b(cat|kitty|meow|neko|popcat|mew)\b/i,
  frog: /\b(pepe|frog|toad|kek)\b/i,
  politics: /\b(trump|maga|elon|musk|biden|vance|president|usa|america)\b/i,
  robinhood: /\b(robinhood|hood|vlad|tenev|stock|stocks|wallstreet|wsb)\b/i,
  money: /\b(moon|pump|100x|1000x|rich|gold|money|cash|million|billion|lambo)\b/i,
  community: /\b(community|cto|dao|people|holders|army|cult)\b/i,
  ape: /\b(ape|monkey|chimp|gorilla|bape)\b/i,
};

const lc = (x) => String(x == null ? '' : x).toLowerCase();
/** Les detenteurs et l'activite d'un jeton depuis ses Transfer (pur). `logs` : eth_getLogs bruts. */
function analyseTransferts(logs, o) {
  const exclus = new Set(EXCLUS_FIXES.concat((o && o.exclus) || []).map(lc));
  const pointe = Number(o && o.pointe) || 0, depuis24 = pointe - BLOCS_24H;
  const solde = new Map(), premier = new Map();
  let transferts24 = 0;
  const actifs24 = new Set();
  const l = (Array.isArray(logs) ? logs : []).filter((x) => x && x.topics && lc(x.topics[0]) === TOPIC_TRANSFER && x.topics.length >= 3)
    .sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex || '0x0', 16) - parseInt(b.logIndex || '0x0', 16));
  for (const x of l) {
    const de = '0x' + lc(x.topics[1]).slice(-40), a = '0x' + lc(x.topics[2]).slice(-40), bloc = parseInt(x.blockNumber, 16);
    let v = 0n; try { v = BigInt(x.data && x.data !== '0x' ? x.data : '0x0'); } catch (e) { v = 0n; }
    solde.set(de, (solde.get(de) || 0n) - v); solde.set(a, (solde.get(a) || 0n) + v);
    for (const w of [de, a]) if (!exclus.has(w) && !premier.has(w)) premier.set(w, bloc);
    if (bloc > depuis24) { transferts24++; for (const w of [de, a]) if (!exclus.has(w)) actifs24.add(w); }
  }
  const tenus = [...solde].filter(([w, v]) => !exclus.has(w) && v > 0n).sort((p, q) => (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  const total = tenus.reduce((s, [, v]) => s + v, 0n);
  const part = (k) => (total > 0n ? Number(tenus.slice(0, k).reduce((s, [, v]) => s + v, 0n) * 10000n / total) / 100 : null);
  const nouveaux = [...actifs24].filter((w) => premier.get(w) > depuis24).length;
  return { transferts: l.length, detenteurs: tenus.length, top10: part(10), top20: part(20), transferts24, actifs24: actifs24.size, nouveaux24: nouveaux, revenants24: actifs24.size - nouveaux };
}
const adr = (a) => (/^0x[0-9a-f]{40}$/.test(lc(a)) ? lc(a) : null);
const fini = (x) => typeof x === 'number' && isFinite(x);
const num = (x) => { const n = Number(x); return isFinite(n) ? n : null; };
const texte = (s, n) => (s == null ? null : String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) || null);
const jour = (ms) => new Date(ms).toISOString().slice(0, 10);
function mediane(l) { if (!l.length) return null; const a = l.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }

/** Les themes d'un jeton (pur). */
function themesDe(nom, sym, desc) {
  const t = [nom, sym, desc].filter(Boolean).join(' ');
  const out = Object.keys(THEMES).filter((k) => THEMES[k].test(t));
  return out.length ? out : ['other'];
}
/** Les reseaux d'une liste de liens (pur) : x, telegram, site, autres. */
function reseauxDe(liens) {
  const l = (Array.isArray(liens) ? liens : []).map((x) => String(x || '').toLowerCase()).filter(Boolean);
  const x = l.some((u) => /(^|\/\/|\.)(x|twitter)\.com\//.test(u)), tg = l.some((u) => /t\.me\/|telegram/.test(u));
  const site = l.some((u) => /^https?:\/\//.test(u) && !/(x|twitter)\.com\/|t\.me\/|telegram|discord|tiktok|instagram|youtube/.test(u));
  return { n: l.length, x, tg, site };
}

/**
 * deps = { dossier (DATA_DIR), prendre (fetch), horloge () -> ms, note(genre, texte) }
 */
function cree(deps) {
  const d = deps || {};
  const D = path.join(d.dossier || './data', 'lancements');
  const maintenant = d.horloge || Date.now;
  const prendre = d.prendre || fetch;
  const note = (t) => { try { if (d.note) d.note('carnet', t); } catch (e) { /* rien */ } };
  /* Le contexte de marche BTC/ETH a la naissance (22/10/2026, marche_contexte.contexteA) : (t) -> contexte | null,
     pose par smart_money. Le bilan le lit A LA VOLEE sur f.t ; rien n'est ecrit dans la fiche (la serie remonte 90 j,
     elle couvre donc les fiches deja nees). Demande du proprietaire du 21/10 : « si le marche est baissier c'est
     surement plus complique d'avoir du volume » — on mesure si moins de lancements survivent, on ne decide rien. */
  const marcheA = typeof d.marche === 'function' ? d.marche : null;
  const ETAT = path.join(D, 'etat.json');
  const C = { naissances: 0, doublons: 0, metas: 0, metasVides: 0, metasAbandonnees: 0, metaFileDebordee: 0, suivis: 0, manques: 0, dsAppels: 0, dsErreurs: 0, erreursEcriture: 0 };
  /* la fiche compacte de chaque jeton, et l'ordre de naissance (pour les curseurs) */
  const F = new Map();
  let ordre = [];
  let etat = { curseurs: {}, file: [], essais: {}, soldes: [], ordres: [], metasDS: { t: 0, slugs: [] }, det: [] };
  let bilanCache = null;
  let enCours = false;

  function ecrisLigne(o) {
    try {
      fs.mkdirSync(D, { recursive: true });
      fs.appendFileSync(path.join(D, jour(o.t || maintenant()) + '.jsonl'), JSON.stringify(o) + '\n');
      return true;
    } catch (e) { C.erreursEcriture++; return false; }
  }
  function sauveEtat() {
    try { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(ETAT + '.tmp', JSON.stringify(etat)); fs.renameSync(ETAT + '.tmp', ETAT); } catch (e) { C.erreursEcriture++; }
  }
  /** Applique une ligne du journal a la fiche compacte (au demarrage comme en direct). */
  function applique(o) {
    const j = o && adr(o.jeton);
    if (!j && !(o && o.k === 'dsmeta')) return;
    if (o.k === 'n') {
      if (F.has(j)) return;
      F.set(j, { t: o.t, bloc: num(o.bloc), courbe: adr(o.courbe), plat: o.plateforme || 'pons', dev: adr(o.deployer), devEth: num(o.achatDevEth), t2a: o.t2 ? num(o.t2.acheteurs) : null, t2e: o.t2 ? num(o.t2.eth) : null,
        ex: o.exemptions || 0, vd: o.ventesDev || 0, nom: null, sym: o.symbole || null, desc: 0, th: null, res: null, logo: null, s: {},
        taxe: null, soldes: {}, soldeMax: null, ordres: {}, dsMetas: [], det: {}, pools: [] });
      /* ordre de naissance : presque toujours en fin ; une naissance plus ancienne (IGNITION, rattrapage) prend sa place */
      let i = ordre.length;
      while (i > 0 && F.get(ordre[i - 1]).t > o.t) i--;
      ordre.splice(i, 0, j);
    } else if (o.k === 'm') {
      const f = F.get(j); if (!f) return;
      f.nom = o.nom || null; f.sym = o.symbole || f.sym; f.desc = o.description ? o.description.length : 0;
      f.th = themesDe(o.nom, o.symbole, o.description); f.res = reseauxDe(o.socials); f.logo = !!o.logo;
      f.taxe = fini(o.taxePct) ? o.taxePct : null;
    } else if (o.k === 's') {
      const f = F.get(j); if (!f) return;
      f.s[o.h] = { m: !!o.marche, liq: num(o.liq), fdv: num(o.fdv), vol: num(o.vol24) };
      if (o.pool && !f.pools.includes(o.pool)) f.pools.push(o.pool);
    } else if (o.k === 'det') {
      const f = F.get(j); if (!f) return;
      f.det[o.h] = { n: o.detenteurs, top10: o.top10, top20: o.top20, actifs24: o.actifs24, nouveaux24: o.nouveaux24, revenants24: o.revenants24 };
    } else if (o.k === 'manque') {
      const f = F.get(j); if (!f) return;
      (f.mq = f.mq || {})[o.h] = true;
    } else if (o.k === 'solde') {
      const f = F.get(j); if (!f || !fini(o.part)) return;
      f.soldes[o.h] = o.part;
      f.soldeMax = Math.max(f.soldeMax == null ? 0 : f.soldeMax, o.part);
    } else if (o.k === 'ordres') {
      const f = F.get(j); if (!f) return;
      f.ordres[o.h] = { cto: !!o.cto, profil: !!o.profil, pubs: o.pubs || 0, boosts: o.boosts || 0 };
    } else if (o.k === 'dsmeta') {
      for (const x of (Array.isArray(o.jetons) ? o.jetons : [])) { const f = F.get(adr(x)); if (f && !f.dsMetas.includes(o.slug)) f.dsMetas.push(String(o.slug).slice(0, 40)); }
    }
  }
  /** Au demarrage : les fiches des JOURS_MEMOIRE derniers jours, l'etat, le menage des vieux fichiers. */
  function charge() {
    try { etat = Object.assign(etat, JSON.parse(fs.readFileSync(ETAT, 'utf8'))); } catch (e) { /* premier demarrage */ }
    let fichiers = [];
    try { fichiers = fs.readdirSync(D).filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort(); } catch (e) { return; }
    const now = maintenant();
    for (const f of fichiers) {
      const age = (now - Date.parse(f.slice(0, 10) + 'T00:00:00Z')) / 86400e3;
      if (age > JOURS_GARDES) { try { fs.unlinkSync(path.join(D, f)); } catch (e) { /* rien */ } continue; }
      if (age > JOURS_MEMOIRE) continue;
      let txt = '';
      try { txt = fs.readFileSync(path.join(D, f), 'utf8'); } catch (e) { continue; }
      for (const l of txt.split('\n')) { if (!l) continue; try { applique(JSON.parse(l)); } catch (e) { /* ligne coupee : ignoree */ } }
    }
    ordre.sort((a, b) => F.get(a).t - F.get(b).t);
  }
  charge();

  /** Un lancement a son T+2 (smart_lancements.js). Rend true s'il est nouveau. */
  function naissance(r) {
    const j = r && adr(r.jeton);
    if (!j) return false;
    if (F.has(j)) { C.doublons++; return false; }
    const o = { k: 'n', t: fini(r.t) ? r.t : maintenant(), jeton: j, courbe: adr(r.courbe), plateforme: r.plateforme === 'ignition' ? 'ignition' : 'pons', bloc: num(r.bloc),
      deployer: adr(r.deployer), cote: r.coteEth === false ? 'autre' : 'eth', seuilEth: num(r.seuilEth), achatDevEth: num(r.achatDevEth), achatSource: texte(r.achatSource, 20),
      t2: r.t2 ? { acheteurs: num(r.t2.acheteurs), eth: num(r.t2.eth) } : null, acheteurs: (Array.isArray(r.acheteurs) ? r.acheteurs : []).map(adr).filter(Boolean).slice(0, 20),
      exemptions: num(r.exemptions) || 0, ventesDev: num(r.ventesDev) || 0, gradueT2: !!r.gradue, symbole: texte(r.symbole, 24),
      tx: r.tx ? { from: adr(r.tx.from), gas: texte(r.tx.gas, 24), maxFee: texte(r.tx.maxFeePerGas, 24), value: texte(r.tx.value, 40) } : null };
    ecrisLigne(o);
    applique(o);
    C.naissances++;
    etat.file.push({ jeton: j, courbe: adr(r.courbe) });
    /* le solde du createur a sa naissance (T+2) : la reference de « parti » ou « encore la » */
    if (o.deployer && o.plateforme === 'pons') etat.soldes.push({ jeton: j, dev: o.deployer, h: 't2' });
    if (etat.file.length > META_FILE_MAX) { C.metaFileDebordee += etat.file.length - META_FILE_MAX; etat.file.splice(0, etat.file.length - META_FILE_MAX); }
    return true;
  }
  /** Les jetons dont lire les metadonnees ce cycle-ci. */
  const aLire = (n) => etat.file.slice(0, Math.min(n || META_PAR_CYCLE, META_PAR_CYCLE));
  /** Les soldes du createur a lire ce cycle-ci : ce qui reste du lot apres les metadonnees
   *  (6 eth_call par jeton). [{ jeton, dev, h }] */
  const soldesALire = (nMetas) => etat.soldes.slice(0, Math.max(0, LOT_RPC - 6 * (nMetas || 0)));
  /** Le jeton dont lire les Transfer ce cycle-ci : { jeton, h, bloc, exclus } ou null. */
  function detenteursALire() {
    /* une lecture deja faite (etat sauve avant elle, puis redemarrage) n'est pas refaite */
    while (etat.det.length && (() => { const f = F.get(etat.det[0].jeton); return !f || !f.bloc || f.det[etat.det[0].h]; })()) etat.det.shift();
    const x = etat.det[0]; if (!x) return null;
    const f = F.get(x.jeton);
    return { jeton: x.jeton, h: x.h, bloc: f.bloc, exclus: [f.courbe].concat(f.pools).filter(Boolean) };
  }
  /** Les Transfer lus (ou null : relu une fois, puis abandonne). */
  function detenteurs(jeton, h, logs, pointe) {
    const j = adr(jeton); if (!j) return;
    const i = etat.det.findIndex((x) => x.jeton === j && x.h === h);
    if (!Array.isArray(logs)) {
      if (i >= 0) { const x = etat.det[i]; x.essais = (x.essais || 0) + 1; etat.det.splice(i, 1); if (x.essais < 2) etat.det.push(x); else C.detRates = (C.detRates || 0) + 1; }
      return;
    }
    if (i >= 0) etat.det.splice(i, 1);
    const f = F.get(j);
    const o = Object.assign({ k: 'det', t: maintenant(), jeton: j, h, pointe: num(pointe) }, analyseTransferts(logs, { exclus: f ? [f.courbe].concat(f.pools).filter(Boolean) : [], pointe }));
    ecrisLigne(o); applique(o);
    C.det = (C.det || 0) + 1;
    sauveEtat();
  }
  /** Un solde lu : `brut` (hex de balanceOf) -> part de l'offre Pons en %, ou null (relu une fois). */
  function solde(jeton, h, brut) {
    const j = adr(jeton); if (!j) return;
    const i = etat.soldes.findIndex((x) => x.jeton === j && x.h === h);
    const x = i >= 0 ? etat.soldes[i] : null;
    if (brut == null || !/^0x[0-9a-f]{1,64}$/i.test(String(brut))) {
      if (x) { x.essais = (x.essais || 0) + 1; if (x.essais >= 2) { etat.soldes.splice(i, 1); C.soldesRates = (C.soldesRates || 0) + 1; } }
      return;
    }
    if (i >= 0) etat.soldes.splice(i, 1);
    /* la part de l'offre, sans perdre la precision des grands entiers : 1e27 unites = 100 % */
    const part = Number(BigInt(brut) * 1000000n / (BigInt(PONS_OFFRE) * 10n ** 18n)) / 10000;
    const o = { k: 'solde', t: maintenant(), jeton: j, h, dev: x ? x.dev : null, part };
    ecrisLigne(o); applique(o);
    C.soldes = (C.soldes || 0) + 1;
  }
  /** Le resultat de la lecture : m = { nom, symbole, description, socials, logo } ou null. */
  function meta(jeton, m) {
    const j = adr(jeton); if (!j) return;
    const i = etat.file.findIndex((x) => x.jeton === j);
    if (!m) {
      C.metasVides++;
      etat.essais[j] = (etat.essais[j] || 0) + 1;
      if (etat.essais[j] >= META_ESSAIS) { if (i >= 0) etat.file.splice(i, 1); delete etat.essais[j]; C.metasAbandonnees++; }
      else if (i >= 0) etat.file.push(etat.file.splice(i, 1)[0]);      // en fin de file
      return;
    }
    if (i >= 0) etat.file.splice(i, 1);
    delete etat.essais[j];
    const o = { k: 'm', t: maintenant(), jeton: j, nom: texte(m.nom, 64), symbole: texte(m.symbole, 24), description: texte(m.description, 600),
      socials: (Array.isArray(m.socials) ? m.socials : []).map((x) => texte(x, 200)).filter(Boolean).slice(0, 8), logo: texte(m.logo, 200),
      taxePct: fini(m.taxePct) && m.taxePct >= 0 && m.taxePct <= 100 ? m.taxePct : null };
    ecrisLigne(o);
    applique(o);
    C.metas++;
  }

  /** Les echeances dues, dans l'ordre des horizons, au plus `max`. */
  /* Une echeance est FAITE quand la fiche a son suivi ou sa marque « manquee » ; le curseur
     n'est qu'un raccourci : tout ce qui est ne AVANT lui est fait. Deux jetons nes a la meme
     milliseconde (meme bloc IGNITION) sont donc suivis tous les deux. */
  const fait = (f, h) => !!(f.s[h] || (f.mq && f.mq[h]));
  function dues(now, max) {
    const out = [];
    for (const [h, min] of HORIZONS) {
      const cur = Number(etat.curseurs[h]) || 0;
      let contigu = true;
      for (const j of ordre) {
        const f = F.get(j);
        if (f.t < cur) continue;
        if (fait(f, h)) { if (contigu) etat.curseurs[h] = f.t; continue; }
        if (f.t + min * 60e3 > now) break;
        contigu = false;
        if ((now - f.t) / 60e3 - min > retardAdmisMin(min)) {
          const o = { k: 'manque', t: now, jeton: j, h };
          ecrisLigne(o); applique(o); C.manques++;
          continue;
        }
        if (out.length >= max) break;
        out.push({ j, h, f });
      }
    }
    return out;
  }
  async function dsJson(url) {
    const r = await prendre(url, { headers: { accept: 'application/json', 'user-agent': 'swoge-launch-book/1.0 (read-only)' }, signal: AbortSignal.timeout(DS_DELAI_MS) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return JSON.parse(await r.text());
  }
  /** Les commandes DexScreener de 2 jetons vivants au plus, puis une meta DexScreener. */
  async function ordresEtMetas(now) {
    for (let k = 0; k < ORDRES_PAR_TIC && etat.ordres.length; k++) {
      const x = etat.ordres.shift();
      try {
        C.dsOrdres = (C.dsOrdres || 0) + 1;
        const j = await dsJson(DS + '/orders/v1/robinhood/' + x.jeton);
        const ok = (Array.isArray(j && j.orders) ? j.orders : []).filter((o) => o && o.status !== 'rejected' && o.status !== 'cancelled');
        const o = { k: 'ordres', t: now, jeton: x.jeton, h: x.h, cto: ok.some((q) => q.type === 'communityTakeover'), profil: ok.some((q) => q.type === 'tokenProfile'),
          pubs: ok.filter((q) => q.type === 'tokenAd' || q.type === 'trendingBarAd').length, boosts: Array.isArray(j && j.boosts) ? j.boosts.length : 0,
          types: [...new Set(ok.map((q) => texte(q.type, 30)).filter(Boolean))] };
        ecrisLigne(o); applique(o);
      } catch (e) { C.dsErreurs++; }
    }
    try {
      const M = etat.metasDS;
      if (now - (M.t || 0) >= METAS_DS_MS) {
        const l = await dsJson(DS + '/metas/trending/v1');
        M.t = now; M.slugs = (Array.isArray(l) ? l : []).map((x) => String((x && x.slug) || '')).filter((x) => /^[a-z0-9-]{1,40}$/.test(x)).slice(0, 40);
        C.dsMetasListes = (C.dsMetasListes || 0) + 1;
      } else if (M.slugs && M.slugs.length) {
        const slug = M.slugs.shift();
        const j = await dsJson(DS + '/metas/meta/v1/' + slug);
        const paires = Array.isArray(j && j.pairs) ? j.pairs : [];
        const jetons = [...new Set(paires.filter((p) => p && p.chainId === 'robinhood').map((p) => adr(p.baseToken && p.baseToken.address)).filter(Boolean))];
        const o = { k: 'dsmeta', t: now, slug, nom: texte(j && j.name, 40), jetons, tokenCount: num(j && j.tokenCount) };
        ecrisLigne(o); applique(o);
        C.dsMetas = (C.dsMetas || 0) + 1;
      }
    } catch (e) { C.dsErreurs++; }
  }
  /** Un pas du suivi (appele a chaque cycle des lancements) : AU PLUS un appel DexScreener tokens/v1. */
  async function tic() {
    if (enCours) return { fait: 'deja' };
    enCours = true;
    try {
      const now = maintenant();
      await ordresEtMetas(now);
      const l = dues(now, DS_LOT);
      if (!l.length) { sauveEtat(); return { fait: 'rien' }; }
      const jetons = [...new Set(l.map((x) => x.j))];
      let paires = null;
      try {
        C.dsAppels++;
        const r = await prendre(DS + '/tokens/v1/robinhood/' + jetons.join(','), { headers: { accept: 'application/json', 'user-agent': 'swoge-launch-book/1.0 (read-only)' }, signal: AbortSignal.timeout(DS_DELAI_MS) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        paires = JSON.parse(await r.text());
        if (!Array.isArray(paires)) throw new Error('reponse illisible');
      } catch (e) { C.dsErreurs++; note('DexScreener : ' + String((e && e.message) || e).slice(0, 80)); return { fait: 'erreur' }; }
      /* la paire la plus liquide de chaque jeton (cote base) */
      const meilleure = new Map();
      for (const p of paires) {
        const j = adr(p && p.baseToken && p.baseToken.address);
        if (!j || p.chainId !== 'robinhood') continue;
        const liq = num(p.liquidity && p.liquidity.usd) || 0;
        if (!meilleure.has(j) || liq > (num(meilleure.get(j).liquidity && meilleure.get(j).liquidity.usd) || 0)) meilleure.set(j, p);
      }
      for (const { j, h, f } of l) {
        const p = meilleure.get(j);
        const o = { k: 's', t: now, jeton: j, h, age_min: Math.round((now - f.t) / 60e3), marche: !!p };
        if (p) Object.assign(o, { dex: texte(p.dexId, 20), pool: adr(p.pairAddress), prix: num(p.priceUsd), fdv: num(p.fdv), mc: num(p.marketCap), liq: num(p.liquidity && p.liquidity.usd),
          vol24: num(p.volume && p.volume.h24), tx24: p.txns && p.txns.h24 ? { b: num(p.txns.h24.buys), s: num(p.txns.h24.sells) } : null,
          ch24: num(p.priceChange && p.priceChange.h24), pairesN: paires.filter((x) => adr(x && x.baseToken && x.baseToken.address) === j).length,
          info: p.info ? { sites: (p.info.websites || []).length, socials: (p.info.socials || []).length, image: !!p.info.imageUrl } : null });
        ecrisLigne(o);
        applique(o);
        C.suivis++;
        if (SOLDES_H.includes(h) && f.dev && f.plat === 'pons') etat.soldes.push({ jeton: j, dev: f.dev, h });
        if (ORDRES_H.includes(h) && o.marche && (o.liq || 0) >= VIVANT_LIQ) etat.ordres.push({ jeton: j, h });
        if (DET_H.includes(h) && o.marche && (o.liq || 0) >= VIVANT_LIQ && f.bloc) etat.det.push({ jeton: j, h });
      }
      if (etat.det.length > DET_FILE_MAX) { C.detDebordes = (C.detDebordes || 0) + etat.det.length - DET_FILE_MAX; etat.det.splice(0, etat.det.length - DET_FILE_MAX); }
      if (etat.soldes.length > SOLDES_FILE_MAX) { C.soldesDebordes = (C.soldesDebordes || 0) + etat.soldes.length - SOLDES_FILE_MAX; etat.soldes.splice(0, etat.soldes.length - SOLDES_FILE_MAX); }
      sauveEtat();
      bilanCache = null;
      return { fait: 'lu', suivis: l.length };
    } finally { enCours = false; }
  }

  // ---------------------------------------------------------- le bilan
  /** La gouvernance d'une fiche a l'echeance `h` (HYPOTHESE, voir l'en-tete) ; null si pas de suivi. */
  function gouvernance(f, h) {
    const s = f.s[h];
    if (!s) return null;
    const vivant = s.m && (s.liq || 0) >= VIVANT_LIQ;
    if (Object.values(f.ordres).some((o) => o.cto)) return 'cto';
    const sol = f.soldes[h];
    if (!fini(sol) || f.soldeMax == null || !(f.soldeMax > 0)) return vivant ? 'alive, creator unknown' : 'dead, creator unknown';
    const parti = sol < f.soldeMax * 0.1, la = sol >= f.soldeMax * 0.5;
    if (parti) return vivant ? 'cto' : 'rug';
    if (la) return vivant ? 'team' : 'abandoned';
    return vivant ? 'alive, creator partly out' : 'dead, creator partly out';
  }
  /** Une ligne de groupe : vivants a 24 h et a 7 j, capitalisation mediane des vivants. */
  function ligne(fs_) {
    const out = { n: fs_.length };
    for (const h of ['24h', '7j', '30j']) {
      const m = fs_.filter((f) => f.s[h]);
      const viv = m.filter((f) => f.s[h].m && (f.s[h].liq || 0) >= VIVANT_LIQ);
      const assez = m.length >= BILAN_ASSEZ;
      out[h] = { mesures: m.length, assez, vivantsPct: assez ? Math.round(viv.length / m.length * 1000) / 10 : null, marchePct: assez ? Math.round(m.filter((f) => f.s[h].m).length / m.length * 1000) / 10 : null,
        fdvMediane: assez && viv.length ? Math.round(mediane(viv.map((f) => f.s[h].fdv).filter(fini))) : null };
    }
    return out;
  }
  function groupe(cle) {
    const g = {};
    for (const f of F.values()) for (const k of [].concat(cle(f))) { if (k == null) continue; (g[k] = g[k] || []).push(f); }
    const out = {};
    for (const k of Object.keys(g).sort()) out[k] = ligne(g[k]);
    return out;
  }
  function bilan() {
    if (bilanCache && maintenant() - bilanCache.t < BILAN_CACHE_MS) return bilanCache.b;
    /* le passe du createur, dans l'ordre des naissances : combien de lancements avant, et si l'un d'eux vivait a 24 h */
    const parDev = new Map();
    for (const j of ordre) {
      const f = F.get(j);
      const p = f.dev ? (parDev.get(f.dev) || { n: 0, vivant: false }) : null;
      f.devAvant = p ? p.n : null; f.devVivantAvant = p ? p.vivant : null;
      if (p) { p.n++; if (f.s['24h'] && f.s['24h'].m && (f.s['24h'].liq || 0) >= VIVANT_LIQ) p.vivant = true; parDev.set(f.dev, p); }
    }
    const tranche = (x, bornes, noms) => { if (!fini(x)) return 'unknown'; for (let i = 0; i < bornes.length; i++) if (x < bornes[i]) return noms[i]; return noms[noms.length - 1]; };
    /* la tranche de marche a la naissance : null sans fournisseur (aucun groupe), « no market data » quand la serie
       ne couvre pas cet instant (compte, jamais range ailleurs) */
    const trancheMarche = (t, axe) => { if (!marcheA) return null; let c = null; try { c = marcheA(t); } catch (e) { c = null; } return (c && MC.trancheDe(axe, c[axe])) || MC.SANS; };
    const b = {
      seuil: BILAN_ASSEZ, vivant: 'DexScreener market with >= $' + VIVANT_LIQ + ' liquidity', fiches: F.size,
      tout: ligne([...F.values()]),
      parTheme: groupe((f) => f.th || 'no metadata yet'),
      parReseaux: groupe((f) => (f.res ? (f.res.n === 0 ? '0' : f.res.n <= 2 ? '1-2' : '3+') : 'no metadata yet')),
      parX: groupe((f) => (f.res ? (f.res.x ? 'has X' : 'no X') : null)),
      parTelegram: groupe((f) => (f.res ? (f.res.tg ? 'has Telegram' : 'no Telegram') : null)),
      parSite: groupe((f) => (f.res ? (f.res.site ? 'has website' : 'no website') : null)),
      parDescription: groupe((f) => (f.th ? (f.desc === 0 ? 'none' : f.desc < 80 ? 'short (<80)' : 'long (80+)') : null)),
      parAchatDev: groupe((f) => tranche(f.devEth, [1e-9, 0.05, 0.5, 2], ['0', '<0.05 ETH', '0.05-0.5', '0.5-2', '2+ ETH'])),
      parAcheteursT2: groupe((f) => tranche(f.t2a, [1, 5, 20], ['0', '1-4', '5-19', '20+'])),
      parEthT2: groupe((f) => tranche(f.t2e, [0.1, 0.5, 2], ['<0.1 ETH', '0.1-0.5', '0.5-2', '2+ ETH'])),
      parPasseDev: groupe((f) => (f.devAvant == null ? 'unknown' : f.devAvant === 0 ? 'first launch' : f.devAvant < 5 ? '1-4 before' : '5+ before')),
      parDevDejaVivant: groupe((f) => (f.devAvant ? (f.devVivantAvant ? 'a previous one lived 24 h' : 'none lived 24 h') : null)),
      parHeureUtc: groupe((f) => tranche(new Date(f.t).getUTCHours(), [6, 12, 18, 24], ['00-06', '06-12', '12-18', '18-24'])),
      /* le marche a la naissance (22/10) : BTC sur 24 h (±3 %) et 7 j (±5 %), tranches de marche_contexte */
      parBtc24h: groupe((f) => trancheMarche(f.t, 'btc24h')),
      parBtc7d: groupe((f) => trancheMarche(f.t, 'btc7d')),
      parPlateforme: groupe((f) => f.plat),
      parVenteDevT2: groupe((f) => (f.vd > 0 ? 'dev sold by T+2' : 'dev held at T+2')),
      parTaxe: groupe((f) => (f.taxe == null ? (f.th ? 'tax unknown' : null) : f.taxe === 0 ? 'no creator tax' : f.taxe <= 1 ? 'tax <= 1%' : 'tax > 1%')),
      parMetaDexscreener: groupe((f) => (f.dsMetas.length ? f.dsMetas : null)),
      /* la gouvernance compte les fiches par categorie (pas une part vivante : elle est
         definie PAR le vivant) */
      gouvernance: Object.fromEntries(['24h', '7j', '30j'].map((h) => {
        const c = {}; let n = 0;
        for (const f of F.values()) { const g = gouvernance(f, h); if (g) { c[g] = (c[g] || 0) + 1; n++; } }
        return [h, { n, assez: n >= BILAN_ASSEZ, parts: n >= BILAN_ASSEZ ? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v / n * 1000) / 10])) : null, comptes: c }];
      })),
      /* ce que chaque gouvernance a 7 j devient : vivant a 30 j ? (ligne : 24h et 7j de la fiche) */
      parGouvernance7j: groupe((f) => gouvernance(f, '7j')),
      /* la grille du proprietaire, lue a 24 h, jugee a 7 j et 30 j */
      parTop10a24h: groupe((f) => (f.det['24h'] && fini(f.det['24h'].top10) ? tranche(f.det['24h'].top10, [20, 40, 60], ['top10 < 20%', '20-40%', '40-60%', '60%+']) : null)),
      parDetenteursA24h: groupe((f) => (f.det['24h'] ? tranche(f.det['24h'].n, [50, 200, 1000], ['< 50 holders', '50-200', '200-1000', '1000+']) : null)),
      parRevenantsA24h: groupe((f) => { const d = f.det['24h']; if (!d || !d.actifs24) return null; return tranche(d.revenants24 / d.actifs24 * 100, [25, 50, 75], ['returning < 25%', '25-50%', '50-75%', '75%+']); }),
    };
    bilanCache = { t: maintenant(), b };
    return b;
  }

  const vue = () => ({ fiches: F.size, fileMeta: etat.file.length, fileSoldes: etat.soldes.length, fileDetenteurs: etat.det.length, fileOrdres: etat.ordres.length, metasDS: (etat.metasDS.slugs || []).length, curseurs: etat.curseurs, horizons: HORIZONS.map(([h]) => h), compteurs: C, metaParCycle: META_PAR_CYCLE, joursGardes: JOURS_GARDES });
  return { naissance, aLire, meta, soldesALire, solde, detenteursALire, detenteurs, tic, bilan, vue, gouvernance, _fiches: F, _etat: () => etat };
}

module.exports = { cree, analyseTransferts, TOPIC_TRANSFER, EXCLUS_FIXES, BLOCS_24H, themesDe, reseauxDe, HORIZONS, THEMES, META_PAR_CYCLE, BILAN_ASSEZ, VIVANT_LIQ, JOURS_GARDES, retardAdmisMin, SEL_BALANCE, LOT_RPC, SOLDES_H, ORDRES_H };
