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
 * Le bilan (`bilan()`, route /ai/lancements) groupe les lancements par trait
 * (theme du nom, reseaux, description, achat du dev, acheteurs a T+2, passe du
 * createur, heure) et dit, par groupe, la part VIVANTE a 24 h et a 7 j. Sous
 * BILAN_ASSEZ fiches mesurees, il donne le nombre et REFUSE la part : une
 * poignee de jetons, c'est de la chance, pas un resultat.
 * ================================================================== */
const fs = require('fs');
const path = require('path');

/* Les echeances du suivi, en minutes. CHOISI : la colonie juge a 20-120 min ;
   ici on cherche ce qui DURE. */
const HORIZONS = [['1h', 60], ['6h', 360], ['24h', 1440], ['7j', 10080], ['30j', 43200]];
/* Une echeance lue trop tard (serveur arrete) n'est pas cette echeance : elle
   est comptee « manquee », jamais ecrite sous une autre etiquette. Retard admis :
   15 min ou 25 % de l'echeance, le plus grand. CHOISI. */
const retardAdmisMin = (h) => Math.max(15, h * 0.25);
/* Budget du noeud, lu en direct le 21/10 a 20:59 UTC : le client des lancements
   avait fait 4 997 requetes HTTP sur son plafond de 8 000 (JOUR_HTTP), soit
   ~5 700 projetees sur 24 h. 4 jetons x 5 lectures = 20 eth_call = UN lot (LOT
   de smart_rpc) = une requete HTTP par cycle au plus ; ~1 664 lancements par
   jour (smart_lancements.js) / 4 = ~420 requetes par jour. CHOISI. */
const META_PAR_CYCLE = 4;
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
  const ETAT = path.join(D, 'etat.json');
  const C = { naissances: 0, doublons: 0, metas: 0, metasVides: 0, metasAbandonnees: 0, metaFileDebordee: 0, suivis: 0, manques: 0, dsAppels: 0, dsErreurs: 0, erreursEcriture: 0 };
  /* la fiche compacte de chaque jeton, et l'ordre de naissance (pour les curseurs) */
  const F = new Map();
  let ordre = [];
  let etat = { curseurs: {}, file: [], essais: {} };
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
    if (!j) return;
    if (o.k === 'n') {
      if (F.has(j)) return;
      F.set(j, { t: o.t, plat: o.plateforme || 'pons', dev: adr(o.deployer), devEth: num(o.achatDevEth), t2a: o.t2 ? num(o.t2.acheteurs) : null, t2e: o.t2 ? num(o.t2.eth) : null,
        ex: o.exemptions || 0, vd: o.ventesDev || 0, nom: null, sym: o.symbole || null, desc: 0, th: null, res: null, logo: null, s: {} });
      /* ordre de naissance : presque toujours en fin ; une naissance plus ancienne (IGNITION, rattrapage) prend sa place */
      let i = ordre.length;
      while (i > 0 && F.get(ordre[i - 1]).t > o.t) i--;
      ordre.splice(i, 0, j);
    } else if (o.k === 'm') {
      const f = F.get(j); if (!f) return;
      f.nom = o.nom || null; f.sym = o.symbole || f.sym; f.desc = o.description ? o.description.length : 0;
      f.th = themesDe(o.nom, o.symbole, o.description); f.res = reseauxDe(o.socials); f.logo = !!o.logo;
    } else if (o.k === 's') {
      const f = F.get(j); if (!f) return;
      f.s[o.h] = { m: !!o.marche, liq: num(o.liq), fdv: num(o.fdv), vol: num(o.vol24) };
    }
  }
  /** Au demarrage : les fiches des JOURS_MEMOIRE derniers jours, l'etat, le menage des vieux fichiers. */
  function charge() {
    try { etat = Object.assign({ curseurs: {}, file: [], essais: {} }, JSON.parse(fs.readFileSync(ETAT, 'utf8'))); } catch (e) { /* premier demarrage */ }
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
    if (etat.file.length > META_FILE_MAX) { C.metaFileDebordee += etat.file.length - META_FILE_MAX; etat.file.splice(0, etat.file.length - META_FILE_MAX); }
    return true;
  }
  /** Les jetons dont lire les metadonnees ce cycle-ci. */
  const aLire = (n) => etat.file.slice(0, Math.min(n || META_PAR_CYCLE, META_PAR_CYCLE));
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
      socials: (Array.isArray(m.socials) ? m.socials : []).map((x) => texte(x, 200)).filter(Boolean).slice(0, 8), logo: texte(m.logo, 200) };
    ecrisLigne(o);
    applique(o);
    C.metas++;
  }

  /** Les echeances dues, dans l'ordre des horizons, au plus `max`. */
  function dues(now, max) {
    const out = [];
    for (const [h, min] of HORIZONS) {
      let cur = Number(etat.curseurs[h]) || 0;
      for (const j of ordre) {
        if (out.length >= max) break;
        const f = F.get(j);
        if (f.t <= cur) continue;
        if (f.t + min * 60e3 > now) break;
        if ((now - f.t) / 60e3 - min > retardAdmisMin(min)) { C.manques++; cur = f.t; etat.curseurs[h] = cur; continue; }
        out.push({ j, h, f });
        cur = f.t;
      }
    }
    return out;
  }
  /** Un pas du suivi (appele a chaque cycle des lancements) : AU PLUS un appel DexScreener. */
  async function tic() {
    if (enCours) return { fait: 'deja' };
    enCours = true;
    try {
      const now = maintenant();
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
        etat.curseurs[h] = Math.max(Number(etat.curseurs[h]) || 0, f.t);
        C.suivis++;
      }
      sauveEtat();
      bilanCache = null;
      return { fait: 'lu', suivis: l.length };
    } finally { enCours = false; }
  }

  // ---------------------------------------------------------- le bilan
  /** Une ligne de groupe : vivants a 24 h et a 7 j, capitalisation mediane des vivants. */
  function ligne(fs_) {
    const out = { n: fs_.length };
    for (const h of ['24h', '7j']) {
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
      parPlateforme: groupe((f) => f.plat),
      parVenteDevT2: groupe((f) => (f.vd > 0 ? 'dev sold by T+2' : 'dev held at T+2')),
    };
    bilanCache = { t: maintenant(), b };
    return b;
  }

  const vue = () => ({ fiches: F.size, fileMeta: etat.file.length, curseurs: etat.curseurs, horizons: HORIZONS.map(([h]) => h), compteurs: C, metaParCycle: META_PAR_CYCLE, joursGardes: JOURS_GARDES });
  return { naissance, aLire, meta, tic, bilan, vue, _fiches: F, _etat: () => etat };
}

module.exports = { cree, themesDe, reseauxDe, HORIZONS, THEMES, META_PAR_CYCLE, BILAN_ASSEZ, VIVANT_LIQ, JOURS_GARDES, retardAdmisMin };
