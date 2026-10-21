'use strict';
/* ==================================================================
 * L'HISTOIRE COMPLETE DE PONS, RAPATRIEE EN QUELQUES JOURS (21/10/2026)
 * ==================================================================
 *
 * Demande du proprietaire : « lire toute la chaine, stocker le maximum, devenir
 * l'observateur ». Mesures du 21/10 sur le noeud public (lecture seule) :
 *   - toute la chaine : ~26 evenements par bloc aujourd'hui, ~10 Transfer et
 *     2,7 echanges DEX par bloc (17 il y a ~47 jours) : de l'ordre de 2
 *     milliards d'evenements, 1,5 a 2 To bruts. Hors de portee du noeud public
 *     (10 000 evenements par requete) sans risquer de rendre AVEUGLE le direct,
 *     qui lit par le meme noeud depuis la meme adresse ;
 *   - Pons seul : ~1 950 lancements en 24 h (1 954 lus), ~3 100 achats et
 *     ventes de courbe par heure (1 767 en 20 000 blocs) : quelques millions
 *     d'evenements, quelques Go. A portee, en quelques jours.
 * Decision du proprietaire (21/10) : Pons d'abord.
 *
 * Quatre phases, chacune son curseur (bloc), dans l'ordre :
 *   1. lancements  TokenLaunched de l'usine Pons, du bloc 0 a la pointe ;
 *   2. courbes     CurveBuy, CurveSell, SnipeTaxExempted, CurveCompleted (sur
 *                  TOUTES les courbes : les sujets sont propres a Pons), du
 *                  premier lancement a la pointe ;
 *   3. piscines    Initialize du PoolManager v4 dont la devise est un jeton
 *                  gradue (topic 3 : currency1, l'ETH natif etant l'adresse 0,
 *                  toujours currency0 ; et topic 2 pour un jeton cote hors ETH) ;
 *   4. echanges    Swap du PoolManager v4 sur ces identifiants de piscine.
 * Une fois a la pointe, chaque phase continue au fil de la chaine.
 *
 * Le noeud d'abord : UNE requete eth_getLogs par pas, un pas toutes les
 * PONS_HISTOIRE_MS (30 s par defaut), un plafond du jour a lui (HTTP et
 * octets), une file a lui (jamais dans celle du direct), et il SE TAIT tant
 * que le direct est en pause (rythme partage, `pauseDirect`). La fenetre de
 * blocs s'adapte : coupee en deux sur « exceeds limit », « timed out » ou une
 * reponse trop lourde, agrandie de moitie sous 3 000 evenements.
 *
 * Stockage : DATA_DIR/pons_histoire/<phase>/<de>-<a>.jsonl.gz, une ligne
 * COMPACTE par evenement (tableau), jamais reecrite ; etat.json pour les
 * curseurs. Rien ici n'achete ni n'alerte : c'est une bibliotheque.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SP = require('./smart_pons');

const PM4 = '0x8366a39cc670b4001a1121b8f6a443a643e40951';     // PoolManager v4 (miroir.js PM4)
const TOPIC_INIT4 = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';  // Initialize(bytes32,address,address,uint24,int24,address,uint160,int24), keccak verifie le 21/10
const TOPIC_SWAP4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';  // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24), keccak verifie le 21/10
/* la cadence (smart_money.planifie) : PONS_HISTOIRE_MS, 30 s par defaut ; PONS_HISTOIRE=0 l'eteint */
const PAS_MS = () => Math.max(5000, Number(process.env.PONS_HISTOIRE_MS) || 30000);
/* Plafonds du jour. CHOISI contre la mesure : ~5 Go bruts pour Pons, en ~4 jours a
   1,5 Go/jour ; 30 s par pas = 2 880 requetes/jour au plus. */
const JOUR_HTTP = 3000, JOUR_OCTETS = 1.5e9;
const MAX_10M = 9999999;                 // le noeud refuse plus de 10 000 000 blocs par requete (sonde du 11/10, communaute.js)
/* fenetres de depart ; les phases FILTREES (piscines, echanges : une poignee d'identifiants) sont
   clairsemees et grandissent jusqu'a 10 M blocs ; les courbes (~3 100 evenements/h) restent pres
   de 3 000 a 10 000 evenements par requete. */
const FENETRES = { lancements: 2000000, courbes: 20000, piscines: MAX_10M, echanges: 500000 };
const FENETRE_MAX = { lancements: MAX_10M, courbes: 1000000, piscines: MAX_10M, echanges: MAX_10M };
const VISE_MIN = 3000;                   // sous 3 000 evenements, la fenetre grandit de moitie
const LOT_JETONS = 40, LOT_PISCINES = 40;  // valeurs par position de topic, par requete : CHOISI (prudent)
const lc = (x) => String(x == null ? '' : x).toLowerCase();
const hex = (n) => '0x' + Number(n).toString(16);
const PHASES = ['lancements', 'courbes', 'piscines', 'echanges'];
/* Une phase est « rattrapee » a moins de 200 000 blocs (~5,6 h) de la pointe : la suivante
   peut alors avancer ; sinon la premiere phase reprendrait chaque pas, la pointe avancant. CHOISI. */
const RATTRAPE = 200000;

/** Une ligne compacte par evenement (pur). */
function compacte(phase, l) {
  if (phase === 'lancements') { const d = SP.decodeLancementPons(l); return d && [d.bloc, d.i, d.tx, d.jeton, d.courbe, d.deployer, d.cote, String(d.seuil)]; }
  if (phase === 'courbes') {
    const d = SP.decodeCourbe(l); if (!d) return null;
    const g = { achat: 'A', vente: 'V', exemption: 'X', graduation: 'G' }[d.genre];
    if (g === 'A' || g === 'V') return [d.bloc, d.i, d.tx, g, d.courbe, d.expediteur, d.destinataire, String(d.cote), String(d.jetons)];
    return [d.bloc, d.i, d.tx, g, d.courbe, d.qui || null];
  }
  const t = l.topics || [], bloc = parseInt(l.blockNumber, 16), i = parseInt(l.logIndex || '0x0', 16), tx = lc(l.transactionHash);
  if (phase === 'piscines') return [bloc, i, tx, lc(t[1]), '0x' + lc(t[2]).slice(-40), '0x' + lc(t[3]).slice(-40), lc(l.data).slice(0, 2 + 64 * 5)];
  if (phase === 'echanges') return [bloc, i, tx, lc(t[1]), '0x' + lc(t[2]).slice(-40), lc(l.data)];
  return null;
}

/**
 * deps = { R (client smart_rpc a lui), dossier, horloge, note, pauseDirect() -> bool }
 */
function cree(deps) {
  const d = deps || {};
  const D = path.join(d.dossier || './data', 'pons_histoire');
  const maintenant = d.horloge || Date.now;
  const note = (t) => { try { if (d.note) d.note('histoire', t); } catch (e) { /* rien */ } };
  const ETAT = path.join(D, 'etat.json');
  let E = { curseurs: {}, fenetres: {}, compte: {}, debut: null, gradues: [], gradCourbes: [], piscines: [], aPiscine: {}, pisDone: {} };
  try { E = Object.assign(E, JSON.parse(fs.readFileSync(ETAT, 'utf8'))); } catch (e) { /* premier demarrage */ }
  /* courbe -> jeton : en memoire seulement (~2 000 lancements par jour), relue depuis les
     fichiers des lancements au demarrage, pour ne pas reecrire des Mo a chaque pas */
  const jetonDeCourbe = new Map();
  try {
    const dl = path.join(D, 'lancements');
    for (const f of fs.readdirSync(dl)) {
      for (const l of zlib.gunzipSync(fs.readFileSync(path.join(dl, f))).toString('utf8').split('\n')) { if (!l) continue; try { const x = JSON.parse(l); jetonDeCourbe.set(x[4], x[3]); } catch (e) { /* ligne coupee */ } }
    }
  } catch (e) { /* pas encore de fichiers */ }
  /** Une graduation dont la courbe n'est pas (encore) connue : gardee, resolue plus tard. */
  function gradue(courbe) {
    const j = jetonDeCourbe.get(courbe);
    if (j) { if (!E.gradues.includes(j)) E.gradues.push(j); return; }
    if (!E.gradCourbes.includes(courbe)) E.gradCourbes.push(courbe);
  }
  const C = { pas: 0, erreurs: 0, coupes: 0, derniere: null, dernierPas: null };
  let enCours = false;
  const sauve = () => { try { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(ETAT + '.tmp', JSON.stringify(E)); fs.renameSync(ETAT + '.tmp', ETAT); } catch (e) { C.erreurs++; } };
  function ecris(phase, de, a, lignes) {
    if (!lignes.length) return;
    const dir = path.join(D, phase);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, de + '-' + a + '.jsonl.gz'), zlib.gzipSync(lignes.map((x) => JSON.stringify(x)).join('\n') + '\n'));
  }

  /** La phase a jouer, et son filtre ; null si tout est a la pointe. */
  function prochaine(pointe) {
    const pret = [];
    for (const ph of PHASES) {
      const de = E.curseurs[ph] == null ? depart(ph) : E.curseurs[ph] + 1;
      if (de == null || de > pointe) continue;
      const f = filtre(ph);
      if (!f) continue;
      /* la premiere phase en RETARD passe d'abord ; une fois toutes rattrapees, la premiere qui a du travail */
      if (pointe - de > RATTRAPE) return { ph, de, f };
      pret.push({ ph, de, f });
    }
    return pret[0] || null;
  }
  function depart(ph) {
    if (ph === 'lancements') return 0;
    if (ph === 'courbes') return E.debut;                             // le premier lancement Pons
    if (ph === 'piscines') return E.gradues.length ? E.debut : null;
    if (ph === 'echanges') return E.piscines.length ? E.debut : null;
    return null;
  }
  function filtre(ph) {
    if (ph === 'lancements') return { address: SP.ADR.USINE_PONS, topics: [SP.TOPIC.LANCE_PONS] };
    if (ph === 'courbes') return E.debut == null ? null : { topics: [[SP.TOPIC.ACHAT, SP.TOPIC.VENTE, SP.TOPIC.EXEMPTION, SP.TOPIC.GRADUATION_COURBE]] };
    if (ph === 'piscines') {
      /* les jetons gradues dont la piscine n'est pas encore trouvee, par lot ; un lot balaie toute
         la chaine puis on passe au suivant (curseur remis au debut) */
      /* le lot est FIGE pour tout un balayage : un jeton ajoute en route attend le suivant */
      if (E.curseurs.piscines == null || !Array.isArray(E.lotP) || !E.lotP.length) E.lotP = E.gradues.filter((j) => !E.aPiscine[j]).slice(0, LOT_JETONS);
      const lot = E.lotP;
      return lot.length ? { address: PM4, topics: [TOPIC_INIT4, null, null, lot], lot } : null;
    }
    if (ph === 'echanges') {
      if (E.curseurs.echanges == null || !Array.isArray(E.lotE) || !E.lotE.length) E.lotE = E.piscines.filter((p) => !E.pisDone[p]).slice(0, LOT_PISCINES);
      const lot = E.lotE;
      return lot.length ? { address: PM4, topics: [TOPIC_SWAP4, lot], lot } : null;
    }
    return null;
  }

  /** Un pas : UNE requete eth_getLogs. */
  async function pas() {
    if (enCours) return { fait: 'deja' };
    if (typeof d.pauseDirect === 'function' && d.pauseDirect()) return { fait: 'pause du direct' };
    enCours = true;
    try {
      d.R.nouvellePasse({ appels: 2, octets: 40e6 });
      const P = await d.R.pointe();
      const pointe = P.pointe - 5;
      const x = prochaine(pointe);
      if (!x) { C.dernierPas = { t: maintenant(), fait: 'a jour' }; return { fait: 'a jour' }; }
      const { ph, de, f } = x;
      const w = Math.max(1, Math.min(Number(E.fenetres[ph]) || FENETRES[ph], FENETRE_MAX[ph]));
      const a = Math.min(pointe, de + w - 1);
      const filtreRpc = { fromBlock: hex(de), toBlock: hex(a), topics: f.topics };
      if (f.address) filtreRpc.address = f.address;
      let r;
      try { r = await d.R.appel('eth_getLogs', [filtreRpc]); }
      catch (e) { if (!e.tropLourd) throw e; r = { erreur: { message: 'trop lourd' } }; }
      C.pas++;
      if (r.erreur) {
        const m = String(r.erreur.message || '');
        if (/exceeds limit|timed out|timeout|only \d+ are allowed|trop lourd/i.test(m) && w > 1) {
          E.fenetres[ph] = Math.max(1, Math.floor(w / 2)); C.coupes++; sauve();
          return { fait: 'fenetre coupee', ph, fenetre: E.fenetres[ph] };
        }
        throw new Error('eth_getLogs : ' + m.slice(0, 120));
      }
      const logs = Array.isArray(r.result) ? r.result : [];
      const lignes = logs.map((l) => compacte(ph, l)).filter(Boolean);
      ecris(ph, de, a, lignes);
      E.compte[ph] = (E.compte[ph] || 0) + lignes.length;
      if (ph === 'lancements') {
        for (const l of lignes) { if (E.debut == null || l[0] < E.debut) E.debut = l[0]; jetonDeCourbe.set(l[4], l[3]); }
        if (E.gradCourbes.length) { const reste = E.gradCourbes; E.gradCourbes = []; reste.forEach(gradue); }
      } else if (ph === 'courbes') {
        for (const l of lignes) if (l[3] === 'G') gradue(l[4]);
      } else if (ph === 'piscines') {
        for (const l of lignes) { for (const j of [l[4], l[5]]) if (f.lot.includes(j)) E.aPiscine[j] = l[3]; if (!E.piscines.includes(l[3])) E.piscines.push(l[3]); }
      }
      E.curseurs[ph] = a;
      /* un lot de piscines ou d'echanges a balaye la chaine : le lot suivant repart du debut */
      if ((ph === 'piscines' || ph === 'echanges') && a >= pointe) {
        for (const v of f.lot) { if (ph === 'piscines') { if (!E.aPiscine[v]) E.aPiscine[v] = 'aucune'; } else E.pisDone[v] = a; }
        if (ph === 'piscines') E.lotP = []; else E.lotE = [];
        E.curseurs[ph] = null;
        if (!filtre(ph)) E.curseurs[ph] = a;      // plus rien a chercher : la phase reste a la pointe
      }
      if (lignes.length < VISE_MIN && w < FENETRE_MAX[ph]) E.fenetres[ph] = Math.min(FENETRE_MAX[ph], Math.floor(w * 1.5));
      sauve();
      C.dernierPas = { t: maintenant(), ph, de, a, evts: lignes.length };
      return { fait: 'lu', ph, de, a, evts: lignes.length };
    } catch (e) {
      C.erreurs++; C.derniere = String((e && e.message) || e).slice(0, 160);
      note(C.derniere);
      return { fait: 'erreur', erreur: C.derniere };
    } finally { enCours = false; }
  }

  function vue() {
    return { curseurs: E.curseurs, fenetres: E.fenetres, compte: E.compte, debut: E.debut, gradues: E.gradues.length, graduationsSansJeton: E.gradCourbes.length, piscinesTrouvees: E.piscines.length,
      sansPiscine: Object.values(E.aPiscine).filter((v) => v === 'aucune').length, echangesFinis: Object.keys(E.pisDone).length,
      jour: d.R && d.R.jour ? d.R.jour() : null, pasS: Math.round(PAS_MS() / 1000), plafonds: { http: JOUR_HTTP, octets: JOUR_OCTETS }, mesure: C };
  }
  return { pas, vue, _etat: () => E };
}

module.exports = { cree, compacte, RATTRAPE, PM4, TOPIC_INIT4, TOPIC_SWAP4, JOUR_HTTP, JOUR_OCTETS, FENETRES, PHASES };
