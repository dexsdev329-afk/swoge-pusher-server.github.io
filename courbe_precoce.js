'use strict';
/* ==================================================================
 * L'OBSERVATEUR DE COURBE PRECOCE (23/10/2026) — OBSERVATION STRICTE
 * ==================================================================
 *
 * POURQUOI. Mesure du portrait Pons (23/10, 708 180 lancements, 5 000
 * courbes) : 80 % des graduations se font dans la 1re HEURE (mediane 5 min),
 * 43 % des jetons meurent en moins d'une heure, 1,20 % graduent. Or la colonie
 * ne VOIT un lancement qu'apres graduation, ou apres ~10-15 min via DexScreener
 * (qui n'indexe pas plus tot, et un jeton sur sa courbe n'a AUCUNE piscine DEX) :
 * elle est aveugle a la fenetre ou tout se joue. Cet observateur lit la COURBE
 * directement sur la chaine (comme pons_histoire.js), suit chaque lancement Pons
 * frais dans sa 1re heure, et MESURE en papier ce qu'une entree precoce aurait
 * donne a plusieurs horizons, contre la reference « achete ou retenu ».
 *
 * CE QU'IL NE FAIT PAS. Il n'importe PAS ai_colonie, n'appelle NI rassemble, NI
 * jetonDepuisDex, NI signalSmart, NI aucune porte d'achat : il n'a structurellement
 * aucun chemin vers le tour. Sa seule sortie est son propre audit, serialise par
 * `vue()`. AUCUN trade, AUCUNE porte d'achat ouverte. Drapeau OBS_COURBE, off par
 * defaut.
 *
 * LE PIEGE BUDGET, evite. UNE requete eth_getLogs par pas (topics seuls, sans
 * adresse), cout INDEPENDANT du nombre de courbes et d'horizons : etatCourbe
 * tranche le buffer deja lu ; JAMAIS de getLogs par jeton. Le buffer accumule
 * TOUS les evenements de courbe par adresse (purge age > 65 min) pour capter la
 * minute 1 meme si le carnet ne connait la courbe qu'au T+2.
 * ================================================================== */

const SP = require('./smart_pons');

/* Les quatre evenements de courbe (keccak verifies dans smart_pons) */
const SUJETS = [SP.TOPIC.ACHAT, SP.TOPIC.VENTE, SP.TOPIC.EXEMPTION, SP.TOPIC.GRADUATION_COURBE];

/* Le modele de la courbe (backtest du 23/10 sur 5 000 courbes, erreur < 2 %) :
   produit constant a reserves virtuelles X0 = 1,68 ETH, Y0 = 1e9 jetons ;
   plancher = X0/Y0 = 1,68e-9 ETH/jeton. Le prix d'un instant est le prix moyen
   du dernier echange (cote/jetons), comme la colonie le lit deja (prixCourbe). */
const PLANCHER = 1.68 / 1e9;

/* Mesure du 23/10 : ~854 000 blocs/jour sur la chaine Robinhood = ~593/min.
   CHOISI (reglage, pas une conviction) : sert a situer les horizons en blocs ;
   adaptatif en service (voir estimeBlocsParMin). */
const BLOCS_PAR_MIN_DEFAUT = 593;
const OBS_HORIZONS = [5, 15, 30, 60];      // minutes, comme les ombres de la colonie
const ENTREE_MIN = 1;                      // l'entree precoce fictive : minute 1
const AGE_MAX_MIN = 65;                    // on garde une courbe jusqu'a 65 min (fenetre 60 + marge)
const OBS_FENETRE = 2000;                  // blocs lus au tout premier pas (sera borne par le conseil/coupe)
const FENETRE_MAX = 30000;                 // le noeud public refuse au-dela de ~10 000 logs ; borne prudente
const VISE_MIN = 2000;                     // sous ce nombre de logs, on elargit la fenetre
/* Ses propres seuils (le module est isole : il ne lit pas ceux de la colonie). */
const AUDIT_MIN_OBS = 12;                  // sous 12, une part de montees est du bruit
const BANCS_ASSEZ = 100;                   // sous 100, on ne compare pas a la reference
const MONTE_PCT = 20, EFFONDRE_PCT = -30;  // memes bornes que noteAudit de la colonie
const FRAIS = SP.FRAIS_COURBE_AR_PCT;      // 6 % d'aller-retour de courbe, net

const lc = (s) => String(s || '').toLowerCase();
const hex = (n) => '0x' + Math.max(0, Math.floor(n)).toString(16);
const prixDe = (d) => (d && d.jetons > 0n) ? Number(d.cote) / Number(d.jetons) : null;

function cree(deps) {
  const d = deps || {};
  const R = d.R;
  const carnet = d.carnet;                 // lancements_carnet (pour fraiches())
  const maintenant = d.horloge || Date.now;
  const note = typeof d.note === 'function' ? d.note : () => {};
  const dedie = !!d.dedie;
  const reference = typeof d.reference === 'function' ? d.reference : () => null;

  /* L'etat : le dernier bloc lu, le buffer d'evenements par courbe, la meta par
     courbe suivie, l'audit par ligne, un ancrage bloc<->temps, la sante. */
  const S = {
    dernierBloc: null,
    buffer: new Map(),       // courbe -> [evts]
    meta: new Map(),         // courbe -> { bloc0, devs:Set, t, gradueBloc, juges:{h:true} }
    audit: {},               // cle -> { n, s, montes, effondres }
    ancre: null,             // { bloc, t } pour estimer les blocs/min
    bpm: BLOCS_PAR_MIN_DEFAUT,
    pas: 0, erreurs: 0, derniere: null, dernierPas: null,
    sante: { fraichesCarnet: 0, courbesSuivies: 0, evtsBufferises: 0, jugees: 0 },
  };

  function estimeBlocsParMin(pointe) {
    const now = maintenant();
    if (!S.ancre) { S.ancre = { bloc: pointe, t: now }; return; }
    const dmin = (now - S.ancre.t) / 60000;
    if (dmin >= 10) {
      const bpm = (pointe - S.ancre.bloc) / dmin;
      if (bpm > 50 && bpm < 5000) S.bpm = Math.round(bpm);   // garde-fou : jamais une valeur aberrante
      S.ancre = { bloc: pointe, t: now };
    }
  }

  function note1(cle, r) {
    const a = S.audit[cle] || (S.audit[cle] = { n: 0, s: 0, montes: 0, effondres: 0 });
    a.n++; a.s += r;
    if (r >= MONTE_PCT) a.montes++;
    if (r <= EFFONDRE_PCT) a.effondres++;
  }

  /* Le prix d'une courbe a `jusqua` (bloc) : prix moyen du dernier echange, ou
     le plancher si aucun echange avant ce bloc. */
  function prixA(c, jusqua) {
    const evts = S.buffer.get(c) || [];
    const m = S.meta.get(c);
    const e = SP.etatCourbe(evts, { jusqua, devs: m ? [...m.devs] : [] });
    const p = prixDe(e.dernierPrix);
    return { prix: p === null ? PLANCHER : p, etat: e };
  }

  /* Juger une courbe a tous les horizons dont l'age est atteint et pas encore
     juges. Entree = prix a la minute 1 ; rendement net de l'aller-retour de
     courbe (6 %). Aucune ecriture ailleurs que dans S.audit. */
  function juge(c) {
    const m = S.meta.get(c);
    if (!m) return;
    const ageMin = (maintenant() - m.t) / 60000;
    const bEntree = m.bloc0 + Math.round(ENTREE_MIN * S.bpm);
    const pEntree = prixA(c, bEntree).prix;
    if (!(pEntree > 0)) return;
    for (const h of OBS_HORIZONS) {
      if (ageMin < h) continue;
      if (m.juges[h]) continue;
      const bH = m.bloc0 + Math.round(h * S.bpm);
      const { prix } = prixA(c, bH);
      const brut = (prix - pEntree) / pEntree * 100;
      const r = Math.round((brut - FRAIS) * 10) / 10;     // net de l'aller-retour de courbe
      note1('curve: early window @' + h + 'm', r);
      /* le sous-ensemble qui gradue tot : la vraie question (1,2 % graduent) */
      if (m.gradueBloc && (m.gradueBloc - m.bloc0) <= 60 * S.bpm) note1('curve: graduated early @' + h + 'm', r);
      m.juges[h] = true;
      S.sante.jugees++;
    }
  }

  async function pas() {
    if (!R) return { fait: 'pas de client' };
    if (!dedie && typeof d.pauseDirect === 'function' && d.pauseDirect()) return { fait: 'pause du direct' };
    try {
      R.nouvellePasse({ appels: 2, octets: dedie ? 80e6 : 40e6 });
      const P = await R.pointe();
      const pointe = P.pointe - 5;
      estimeBlocsParMin(pointe);
      /* 1. les courbes fraiches du carnet : on les prend en suivi (buffer vide
            si inconnue) ; aucune ecriture dans le carnet. */
      const fraiches = (carnet && typeof carnet.fraiches === 'function') ? carnet.fraiches(AGE_MAX_MIN) : [];
      S.sante.fraichesCarnet = fraiches.length;
      const suivies = new Set();
      for (const f of fraiches) {
        const c = lc(f.courbe); if (!c) continue;
        suivies.add(c);
        if (!S.meta.has(c)) { S.meta.set(c, { bloc0: f.bloc, devs: new Set([lc(f.dev)].filter(Boolean)), t: f.t, gradueBloc: null, juges: {} }); S.buffer.set(c, []); }
        else { const m = S.meta.get(c); if (f.dev) m.devs.add(lc(f.dev)); if (f.bloc && !m.bloc0) m.bloc0 = f.bloc; }
      }
      /* 2. UNE requete : tous les evenements de courbe de la fenetre, par sujets
            (sans adresse) ; le conseil/coupe borne la fenetre comme pons_histoire. */
      let de = S.dernierBloc == null ? pointe - OBS_FENETRE : S.dernierBloc + 1;
      if (de > pointe) { S.dernierPas = { t: maintenant(), fait: 'a jour' }; menage(); return { fait: 'a jour' }; }
      const w = Math.max(1, Math.min(S.fenetre || OBS_FENETRE, FENETRE_MAX));
      const a = Math.min(pointe, de + w - 1);
      let r;
      try { r = await R.appel('eth_getLogs', [{ fromBlock: hex(de), toBlock: hex(a), topics: [SUJETS] }]); }
      catch (e) { if (!e.tropLourd) throw e; r = { erreur: { message: 'trop lourd' } }; }
      S.pas++;
      if (r.erreur) {
        const msg = String(r.erreur.message || '');
        const c = /this block range should work[^\[]*\[\s*(0x[0-9a-fA-F]+|\d+)\s*,\s*(0x[0-9a-fA-F]+|\d+)/.exec(msg);
        if (c) { const b = Number(c[2]); if (b > de) { S.fenetre = b - de + 1; return { fait: 'fenetre conseillee', fenetre: S.fenetre }; } }
        if (/exceeds limit|limit exceeded|timed out|timeout|only \d+ are allowed|trop lourd|10000/i.test(msg) && w > 1) { S.fenetre = Math.max(1, Math.floor(w / 2)); return { fait: 'fenetre coupee', fenetre: S.fenetre }; }
        throw new Error('eth_getLogs : ' + msg.slice(0, 120));
      }
      const logs = Array.isArray(r.result) ? r.result : [];
      let n = 0;
      for (const l of logs) {
        const e = SP.decodeCourbe(l); if (!e) continue;
        const c = lc(e.courbe);
        /* on ne bufferise QUE les courbes suivies (fraiches) : inutile de garder
           le flux de toute la chaine. Une courbe inconnue au carnet mais vue ici
           est ignoree — le carnet la connaitra au T+2 et on la prendra alors. */
        if (!S.meta.has(c)) continue;
        const buf = S.buffer.get(c) || (S.buffer.set(c, []), S.buffer.get(c));
        buf.push(e); n++;
        if (e.genre === 'graduation') { const m = S.meta.get(c); if (m && !m.gradueBloc) m.gradueBloc = e.bloc; }
      }
      S.sante.evtsBufferises = n;
      S.dernierBloc = a;
      if (logs.length < VISE_MIN && w < FENETRE_MAX) S.fenetre = Math.min(FENETRE_MAX, Math.floor(w * 1.5));
      /* 3. juger les courbes dont un horizon est atteint ; 4. menage. */
      for (const c of suivies) juge(c);
      menage();
      S.sante.courbesSuivies = S.meta.size;
      S.dernierPas = { t: maintenant(), fait: 'lu', de, a, evts: n, courbes: S.meta.size };
      return S.dernierPas;
    } catch (e) {
      S.erreurs++; S.derniere = String((e && e.message) || e).slice(0, 160); note(S.derniere);
      return { fait: 'erreur', erreur: S.derniere };
    }
  }

  /* Le menage libere la MEMOIRE sans jamais faire rejuger une courbe. Une courbe
     FINIE (tous ses horizons juges) garde sa meta — donc ses `juges` — mais perd
     son buffer : le carnet la rend encore « fraiche » (< 65 min) et la reajoute,
     mais comme sa meta existe deja avec juges remplis, elle n'est PAS rejugee.
     Une courbe passee l'age max est oubliee entierement. Sans cette distinction,
     une courbe finie etait supprimee puis recreee a juges vides, et comptait
     plusieurs fois (RATE du 24/10 : n=10 au lieu de 2). */
  function menage() {
    const now = maintenant();
    for (const [c, m] of S.meta) {
      const vieille = (now - m.t) / 60000 > AGE_MAX_MIN;
      const finie = OBS_HORIZONS.every((h) => m.juges[h]);
      if (vieille) { S.meta.delete(c); S.buffer.delete(c); }
      else if (finie && S.buffer.has(c)) S.buffer.delete(c);   // meta gardee (juges), buffer libere
    }
  }

  /* La vue : par ligne et par horizon, n, part de montees, moyenne, et un
     verdict INDICATIF contre la reference « achete ou retenu ». Refuse de
     conclure sous AUDIT_MIN_OBS ; ne compare a la reference que sous BANCS_ASSEZ.
     Texte joueur en anglais. */
  function lignesVue() {
    const ref = (() => { try { return reference(); } catch (e) { return null; } })();
    const out = [];
    for (const cle of Object.keys(S.audit).sort()) {
      const a = S.audit[cle];
      const partMontes = a.n >= AUDIT_MIN_OBS ? Math.round(a.montes / a.n * 100) : null;
      let verdict;
      if (a.n < AUDIT_MIN_OBS) verdict = 'too few observations to conclude (' + a.n + '/' + AUDIT_MIN_OBS + ')';
      else if (!(ref && a.n >= BANCS_ASSEZ)) verdict = 'observing — not yet ' + BANCS_ASSEZ + ' obs (' + a.n + ')';
      else verdict = partMontes > ref.partMontes ? 'beats reference' : 'below reference';
      out.push({ cle, n: a.n, partMontes, moyenne: Math.round(a.s / a.n * 10) / 10,
                 montes: a.montes, effondres: a.effondres, verdict,
                 reference: ref ? { n: ref.n, partMontes: ref.partMontes } : null });
    }
    return out;
  }

  function observe() {
    return {
      actif: true, mode: 'observe', note: 'on-chain curve observer — paper only, no trade, no buy gate',
      horizons: OBS_HORIZONS, entreeMin: ENTREE_MIN, fenetreMin: AGE_MAX_MIN, fraisPct: FRAIS,
      blocsParMin: S.bpm, dedie,
      lignes: lignesVue(),
      sante: S.sante, pas: S.pas, erreurs: S.erreurs, derniere: S.derniere, dernierPas: S.dernierPas,
      jour: (R && typeof R.jour === 'function') ? R.jour() : null,
    };
  }

  return { pas, observe, _etat: () => S, _juge: juge, _menage: menage };
}

module.exports = { cree, SUJETS, OBS_HORIZONS, ENTREE_MIN, AGE_MAX_MIN, AUDIT_MIN_OBS, BANCS_ASSEZ, PLANCHER, BLOCS_PAR_MIN_DEFAUT, FRAIS };
