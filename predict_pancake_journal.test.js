'use strict';
/* ============================================================================
 * PANCAKE — LE JOURNAL DURABLE, LE REMPLISSAGE, LES OMBRES
 *
 * Aucun appel réseau : la chaîne et le lecteur JSON-RPC sont injectés.
 *
 *   1. Deux fichiers en ajout seul, une ligne par round : la décision (ce qu'on
 *      savait à T−45 s) est écrite AVANT l'issue et n'en reçoit jamais ; le
 *      round réglé ne porte aucun champ de décision. Un epoch n'est écrit
 *      qu'une fois.
 *   2. Les ombres : payées à la cote finale réelle, mise diluée ; une ÉGALITÉ
 *      est PERDUE ; un round ANNULÉ est remboursé et ne compte pas.
 *   3. Redémarrage : tout se relit du disque (index, ombres, décisions encore
 *      ouvertes, qui se règlent après).
 *   4. La boucle règle les rounds récents : oracle appelé, ou annulé passé
 *      close + bufferSeconds (30 s, lu sur le contrat).
 *   5. Le remplissage : borné (jamais sous le plancher), lent exprès (un lot
 *      par pas), reprenable (un epoch écrit est sauté), il ne bloque jamais la
 *      boucle d'événements, et une panne RPC ne perd rien.
 *   6. La carte : n, Wilson, EV ± e.-t., t, moitiés ; verdict seulement à
 *      n ≥ 500, t ≥ 2,7 et les deux moitiés positives.
 *   7. PREDICT_PANCAKE_REMPLISSAGE=0 : aucun appel, aucune ligne.
 *  7b. Une panne RPC (429, lot incomplet, port fermé, URL mal formée) ne
 *      publie jamais l'URL de BSC_RPC ni la clé qu'elle porte.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-journal-'));
process.env.PREDICT_PANCAKE_REMPLISSAGE_JOURS = '1';     /* 288 rounds */
process.env.PREDICT_PANCAKE_REMPLISSAGE_LOT = '50';
process.env.PREDICT_PANCAKE_REMPLISSAGE_MS = '120';      /* lent exprès, mais vite pour l'essai */
delete process.env.PREDICT_PANCAKE_REMPLISSAGE;
const J = require('./predict_pancake_journal');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const near = (a, b, e, m) => ok(a != null && Math.abs(a - b) <= e, m + ' [' + a + ']');
const lignes = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)) : []);
const dort = (ms) => new Promise((s) => setTimeout(s, ms));
const nowS = () => Math.floor(Date.now() / 1000);

/* Un round réglé, comme le rend la chaîne (lockPrice/closePrice en entiers). */
function rond(ep, o) {
  return Object.assign({ epoch: String(ep), start: 1000 + ep * 300, lock: 1300 + ep * 300, close: 1600 + ep * 300,
    lockPrice: '60000000000', closePrice: '60100000000', bull: 0.5, bear: 0.5, total: 1, rb: 0.5, rw: 0.97, oracleCalled: true }, o || {});
}
function decision(ep, cand, o) {
  return Object.assign({ ep, t: Date.now(), lock: 1300 + ep * 300, avantLock: 40, fee: 0.03, mise: 0.002,
    vu: { bull: 0.1, bear: 0.2, total: 0.3 }, moteur: { sens: 'UP', prob: 58.2, confiance: 'HIGH' },
    cand: Object.assign({ moteur: 'BULL', inverse: 'BEAR', outsider: 'BULL', bull: 'BULL' }, cand || {}),
    porte: { produit: 0.93, requis: 1.1, passe: false }, parie: false, modeInverse: true }, o || {});
}

(async () => {
  console.log('-- 1. deux fichiers, en ajout seul, une ligne par round --');
  {
    await J.indexe();
    ok(J.ajouteDecision(decision(100)), 'la décision du round 100 est écrite (T−45 s)');
    await J._vidange();
    ok(lignes(J.fichierDecisions()).length === 1 && lignes(J.fichierRounds()).length === 0,
       'elle est sur le disque AVANT que le round soit réglé (aucune ligne de round encore)');
    ok(!J.ajouteDecision(decision(100)), 'une seconde décision pour le même round est refusée');
    /* Le round 100 se règle : BULL gagne, pools finaux 0,5 / 0,5. */
    ok(J.ajouteRound(100, rond(100), 'direct'), 'le round 100 réglé est écrit');
    ok(!J.ajouteRound(100, rond(100), 'chaine'), 'le même epoch n est jamais écrit deux fois (boucle et remplissage)');
    await J._vidange();
    const D = lignes(J.fichierDecisions()), R = lignes(J.fichierRounds());
    ok(D.length === 1 && R.length === 1, 'une ligne par round dans chaque fichier');
    ok(!('cp' in D[0]) && !('lp' in D[0]) && !('bull' in D[0]) && !('oc' in D[0]),
       'la ligne de décision ne porte AUCUN champ réglé (ni prix, ni pool final, ni oracle)');
    ok(!('cand' in R[0]) && !('moteur' in R[0]) && !('vu' in R[0]) && !('porte' in R[0]),
       'la ligne de round ne porte AUCUN champ de décision');
    ok(R[0].lp === '60000000000' && R[0].cp === '60100000000' && R[0].oc === true && R[0].src === 'direct',
       'le round garde les prix Chainlink exacts (texte), l oracle et sa source');
    ok(D[0].vu && D[0].vu.total === 0.3 && D[0].avantLock === 40, 'la décision garde le pool VISIBLE et l avance sur le lock');
    /* Taille mesurée, pour le commentaire du module. */
    const tailleR = Buffer.byteLength(JSON.stringify(R[0])), tailleD = Buffer.byteLength(JSON.stringify(D[0]));
    console.log('       (taille mesurée : round réglé ' + tailleR + ' o, décision ' + tailleD + ' o)');
    ok(tailleR < 400 && tailleD < 600, 'des lignes courtes [' + tailleR + ' / ' + tailleD + ' o]');
  }

  console.log('\n-- 2. les ombres : cote finale réelle, égalité PERDUE, annulé remboursé --');
  {
    /* Round 100 : BULL a gagné, pools 0,5/0,5, frais 3 %, mise 0,002 diluée. */
    const o = J.ombres();
    const c = (id) => o.candidats.find((x) => x.id === id);
    const coteBull = (1 + 0.002) * 0.97 / (0.5 + 0.002);
    near(c('moteur').ev, 100 * (coteBull - 1 - 0.00002 / 0.002), 0.01, 'le camp du moteur (BULL) gagne à la cote finale diluée, gaz réel 1 % payé');
    near(c('inverse').ev, -101, 0.01, 'son inverse perd la mise et le gaz (−101 %)');
    ok(c('bull').n === 1 && c('outsider').n === 1, 'chaque candidat a son pari fictif sur ce round');
    ok(o.nCandidats === 5, 'la carte dit combien de candidats sont regardés : quatre a la decision, plus le retard de l oracle [' + o.nCandidats + ']');
    ok(c('oracle').n === 0, 'le retard de l oracle ne parie pas sans son signal (ce round n en porte pas)');
    /* ÉGALITÉ : lock = close → tout le pool au trésor → PERDU pour tous. */
    J.ajouteDecision(decision(101));
    J.ajouteRound(101, rond(101, { closePrice: '60000000000' }), 'direct');
    const o2 = J.ombres();
    ok(o2.candidats.filter((x) => x.id !== 'oracle').every((x) => x.n === 2 && x.gagnes <= 1), 'une égalité compte : chaque candidat de la decision a un pari de plus');
    ok(o2.candidats.find((x) => x.id === 'inverse').gagnes === 0 && o2.candidats.find((x) => x.id === 'moteur').gagnes === 1,
       'et elle est PERDUE pour tous (le contrat V2 donne le pool au trésor)');
    ok(J.gagnantDe({ oc: true, lp: '5', cp: '5' }) === 'TIE', 'gagnantDe : lock = close → TIE');
    ok(J.rendement('BULL', { oc: true, lp: '5', cp: '5', tot: 1, bull: 0.5, bear: 0.5 }, 0.03, 0.002).g === false, 'rendement : une égalité ne gagne jamais');
    /* ANNULÉ : oracle jamais appelé → remboursé → hors des ombres. */
    J.ajouteDecision(decision(102));
    J.ajouteRound(102, rond(102, { oracleCalled: false, closePrice: '0' }), 'direct');
    const o3 = J.ombres();
    ok(o3.candidats.filter((x) => x.id !== 'oracle').every((x) => x.n === 2) && o3.annules === 1, 'un round annulé est remboursé : aucune ombre ne le compte, il est dit à part');
    ok(J.rendement('BULL', { oc: false, lp: '0', cp: '0' }, 0.03, 0.002) === null, 'rendement : annulé → null');
    /* L'outsider VISIBLE : le plus petit pool à la décision, rien si égal. */
    ok(o3.candidats.find((x) => x.id === 'outsider').texte.indexOf('visible') >= 0, 'l outsider est celui du pool VISIBLE à la décision');
    await J._vidange();
  }

  console.log('\n-- 3. redémarrage : tout se relit du disque --');
  {
    /* Une décision reste OUVERTE (round 103 pas encore réglé) au moment du redémarrage. */
    J.ajouteDecision(decision(103, { moteur: 'BEAR', inverse: 'BULL' }));
    await J._vidange();
    const avant = JSON.stringify(J.ombres().candidats.map((x) => [x.id, x.n, x.ev]));
    J._reset();
    ok(J.ombres().candidats.every((x) => x.n === 0), 'mémoire vidée');
    await J.indexe();
    const apres = JSON.stringify(J.ombres().candidats.map((x) => [x.id, x.n, x.ev]));
    ok(apres === avant, 'relues du disque, les ombres sont les mêmes');
    ok(J.etat().rounds === 3 && J.etat().decisions === 4, 'l index compte 3 rounds et 4 décisions [' + J.etat().rounds + '/' + J.etat().decisions + ']');
    ok(J.ombres().enAttente === 1, 'la décision encore ouverte (103) est retrouvée');
    J.ajouteRound(103, rond(103, { closePrice: '59000000000' }), 'direct');   /* BEAR gagne */
    ok(J.ombres().candidats.find((x) => x.id === 'moteur').gagnes === 2, 'et elle se règle après le redémarrage (le moteur disait BEAR : gagné)');
    await J._vidange();
  }

  console.log('\n-- 4. la boucle règle les rounds récents (oracle, ou annulé pour de bon) --');
  {
    J._reset(); await J.indexe();
    const t = nowS();
    const chaine = {
      round: async (k) => ({
        110: rond(110),
        111: rond(111, { oracleCalled: false, closePrice: '0', close: t - 31 }),   /* annulé : close + 30 s passé */
        112: rond(112, { oracleCalled: false, closePrice: '0', close: t - 5 }),    /* pas encore : l oracle peut encore passer */
      })[k],
    };
    const nR = await J.regleRecents(chaine, 114, t);
    ok(nR === 2, 'deux rounds réglés sur trois lus [' + nR + ']');
    await J._vidange();
    const R = lignes(J.fichierRounds()).filter((l) => l.ep >= 110);
    ok(R.some((l) => l.ep === 111 && l.oc === false), 'le round annulé (close + 30 s passé) est écrit, oracle = false');
    ok(!R.some((l) => l.ep === 112), 'le round encore dans son délai d oracle attend');
    ok(J.annule({ oracleCalled: false, close: t - 31 }, t) && !J.annule({ oracleCalled: false, close: t - 29 }, t) && !J.annule({ oracleCalled: true, close: 1 }, t),
       'annulé = oracle non appelé ET close + bufferSeconds (30 s) dépassé');
  }

  console.log('\n-- 4b. le retard de l oracle : donnees d AVANT le lock, regle fixee d avance, relu du disque --');
  {
    J._reset(); await J.indexe();
    const lp = 60000000000;                                   /* 600,00 $ en entier Chainlink */
    const r = (ep, o, os) => Object.assign(rond(ep, o), { os });
    const L = J.ORACLE_L;
    /* 120 : Binance 0,1 % AU-DESSUS du lockPrice, publie 15 s avant le lock -> BULL ; BULL gagne */
    const a = r(120, {}, { L, px: 600.6, maj: 1300 + 120 * 300 - 15 });
    ok(J.signalOracle({ ep: 120, lock: a.lock, lp: String(lp), os: a.os }) === 'BULL', 'Binance au-dessus du prix oracle de depart : BULL');
    ok(J.signalOracle({ ep: 1, lock: 1000, lp: String(lp), os: { L, px: 599.4, maj: 900 } }) === 'BEAR', 'en dessous : BEAR');
    ok(J.signalOracle({ ep: 1, lock: 1000, lp: String(lp), os: { L, px: 600.2, maj: 900 } }) === null, 'ecart de 0,033 % (< 0,05 %) : pas de pari');
    ok(J.signalOracle({ ep: 1, lock: 1000, lp: String(lp), os: { L, px: 601, maj: 995 } }) === null, 'lockPrice publie APRES lock − 8 s : pas de pari (on ne triche pas)');
    ok(J.signalOracle({ ep: 1, lock: 1000, lp: String(lp) }) === null && J.signalOracle({ ep: 1, lock: 1000, lp: String(lp), os: null }) === null, 'lecture ratee : pas de pari');
    ok(J.ORACLE_L === 8 && J.ORACLE_SEUIL === 0.0005, 'le reglage fixe d avance le 29/09 : 8 s, 0,05 %');
    /* la boucle : elle relit le signal au reglement, sur un round verrouille, et l ecrit avec le round */
    const t = nowS(); const lus = [];
    const chaine = {
      round: async (k) => ({ 120: rond(120), 121: rond(121, { closePrice: '59900000000' }), 122: rond(122, { oracleCalled: false, closePrice: '0', close: t - 40 }) })[k],
      oracleSignal: async (rr, LL) => { lus.push([rr.epoch, LL]); return rr.epoch === '120' ? { L: LL, px: 600.6, maj: rr.lock - 15 } : rr.epoch === '121' ? { L: LL, px: 600.9, maj: rr.lock - 20 } : null; },
    };
    await J.regleRecents(chaine, 124, t);
    await J._vidange();
    const o = J.ombres().candidats.find((x) => x.id === 'oracle');
    ok(lus.length === 2 && lus.every((x) => x[1] === 8) && !lus.some((x) => x[0] === '122'), 'le signal est relu pour chaque round regle par l oracle, a L = 8 s ; jamais pour un round annule');
    const coteBull = (1 + 0.002) * 0.97 / (0.5 + 0.002);
    ok(o.n === 2 && o.gagnes === 1, 'deux paris : 120 gagne (BULL), 121 perdu (BULL, BEAR gagne)');
    near(o.ev, 100 * ((coteBull - 1 - 0.01) + (-1 - 0.01)) / 2, 0.01, 'paye a la cote finale diluee, 3 % de frais, gaz reel');
    const R = lignes(J.fichierRounds()).filter((l) => l.ep >= 120);
    ok(R.find((l) => l.ep === 120).os.px === 600.6 && !('os' in R.find((l) => l.ep === 122)), 'le signal est ECRIT avec la ligne du round (le round annule n en a pas)');
    const avant = JSON.stringify(o);
    J._reset(); await J.indexe();
    ok(JSON.stringify(J.ombres().candidats.find((x) => x.id === 'oracle')) === avant, 'apres un redemarrage, relu du disque a l identique');
    ok(/Oracle lag only when its signal fires/.test(J.ombres().regle), 'la regle affichee dit que ce candidat ne parie que sur signal');
  }

  console.log('\n-- 5. le remplissage : borné, lent, reprenable, jamais bloquant --');
  {
    J._reset(); await J.indexe();
    const COUR = 20000;
    const appels = [];
    let panne = 0, lent = 0;
    J._lecteurTest({
      epoch: async () => COUR,
      rounds: async (eps) => {
        appels.push({ t: Date.now(), eps: eps.slice() });
        if (lent) await dort(lent);
        if (panne > 0) { panne--; throw new Error('RPC down'); }
        return eps.map((ep) => rond(ep));
      },
    });
    /* Un epoch déjà écrit par la boucle ne sera pas relu. */
    J.ajouteRound(COUR - 5, rond(COUR - 5), 'direct');
    /* Une panne au 3e lot : le lot sera relu, rien de perdu. */
    let ticks = 0; const bat = setInterval(() => { ticks++; }, 10);
    panne = 0; lent = 30;
    const t0 = Date.now();
    ok(J.demarreRemplissage(), 'le remplissage démarre');
    ok(!J.demarreRemplissage(), 'une seule boucle à la fois');
    await dort(200);
    panne = 1;   /* le prochain lot échoue */
    while (J.etat().remplissage.actif && Date.now() - t0 < 20000) await dort(50);
    clearInterval(bat);
    const dt = Date.now() - t0;
    await J._vidange();
    const st = J.etat().remplissage;
    const R = lignes(J.fichierRounds()).filter((l) => l.ep > 1000);   /* les rounds des sections 1–4 sont plus bas */
    const eps = R.map((l) => l.ep);
    ok(st.fini && !st.actif, 'il s arrête de lui-même au plancher [' + st.lots + ' lots, ' + st.erreurs + ' erreur(s)]');
    ok(st.erreurs === 1, 'la panne RPC est comptée, pas fatale');
    ok(new Set(eps).size === eps.length, 'aucun epoch écrit deux fois (' + eps.length + ' lignes)');
    ok(eps.length === 288, 'exactement un jour de rounds : 288 (287 remplis + 1 déjà là) [' + eps.length + ']');
    ok(Math.min(...eps) === COUR - 2 - 288 + 1 && Math.max(...eps) === COUR - 2, 'borné : de e − 2 au plancher e − 2 − 288, jamais en dessous');
    ok(!appels.some((a) => a.eps.includes(COUR - 5)), 'l epoch déjà écrit par la boucle n est jamais redemandé');
    ok(appels.every((a) => a.eps.length <= 50), 'jamais plus de 50 epochs par lot JSON-RPC');
    const ecarts = appels.slice(1).map((a, i) => a.t - appels[i].t);
    ok(ecarts.every((e) => e >= 100), 'un lot par pas, jamais en rafale (écart mini ' + Math.min(...ecarts) + ' ms pour un pas de 120 ms)');
    ok(ticks > dt / 10 / 3, 'la boucle d événements n est jamais bloquée (' + ticks + ' battements de 10 ms en ' + dt + ' ms)');
    ok(R.every((l) => l.ep === COUR - 5 ? l.src === 'direct' : l.src === 'chaine'), 'l historique rempli est marqué src = chaine');
    /* Reprise : un redémarrage à mi-chemin ne relit que ce qui manque. */
    J._reset(); await J.indexe();
    appels.length = 0; lent = 0;
    J._lecteurTest({ epoch: async () => COUR + 3, rounds: async (eps) => { appels.push({ eps }); return eps.map((ep) => rond(ep)); } });
    J.demarreRemplissage();
    while (J.etat().remplissage.actif) await dort(20);
    await J._vidange();
    const relus = appels.reduce((a, x) => a + x.eps.length, 0);
    ok(relus === 3, 'reprise : seuls les 3 rounds apparus depuis sont lus [' + relus + ']');
    const R2 = lignes(J.fichierRounds()).filter((l) => l.ep > 1000).map((l) => l.ep);
    ok(new Set(R2).size === R2.length, 'et toujours aucun doublon après reprise');
  }

  console.log('\n-- 6. la carte : n, Wilson, EV ± e.-t., t, moitiés, verdict --');
  {
    /* 600 paris à +20 % de moyenne, un sur deux gagné : t ≈ 4, deux moitiés > 0. */
    const bon = []; for (let i = 0; i < 600; i++) bon.push([i, i % 2 ? 1.4 : -1.0, i % 2]);
    const sb = J.statsSerie(bon);
    ok(sb.n === 600 && sb.taux === 50 && sb.wilson[0] < 50 && sb.wilson[1] > 50, 'Wilson autour du taux [' + sb.wilson + ']');
    near(sb.ev, 20, 0.01, 'EV moyenne par pari, en %');
    ok(sb.se > 0 && Math.abs(sb.t - sb.ev / sb.se) < 0.05, 't = EV / erreur-type [' + sb.t + ']');
    ok(J.verdict(sb).conclut, 'n ≥ 500, t ≥ 2,7, deux moitiés > 0 : verdict [' + J.verdict(sb).texte + ']');
    /* Même moyenne, mais tout le gain dans la seconde moitié : pas de verdict. */
    const moitie = []; for (let i = 0; i < 600; i++) moitie.push([i, i < 300 ? -0.05 : (i % 2 ? 1.5 : -1.0), 0]);
    const sm = J.statsSerie(moitie);
    ok(sm.moitie1 < 0 && !J.verdict(sm).conclut, 'une moitié négative : aucun verdict, même à t élevé [t ' + sm.t + ']');
    /* Sous 500 paris : jamais de verdict, et la carte dit combien il en manque. */
    const court = bon.slice(0, 499);
    ok(!J.verdict(J.statsSerie(court)).conclut && /499\/500/.test(J.verdict(J.statsSerie(court)).texte), 'sous 500 : « not judgeable yet (499/500) »');
    /* t sous 2,7 : pas de verdict. */
    const faible = []; for (let i = 0; i < 600; i++) faible.push([i, i % 2 ? 1.02 : -1.0, i % 2]);
    ok(!J.verdict(J.statsSerie(faible)).conclut, 't < 2,7 : aucun verdict [t ' + J.statsSerie(faible).t + ']');
    ok(/0 bets on purpose/.test(J.ombres().regle), 'la carte rappelle que la caisse papier reste à 0 pari exprès');
  }

  console.log('\n-- 7. PREDICT_PANCAKE_REMPLISSAGE=0 : aucun appel, aucune ligne --');
  {
    delete require.cache[require.resolve('./predict_pancake_journal')];
    process.env.PREDICT_PANCAKE_REMPLISSAGE = '0';
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-journal-off-'));
    const J2 = require('./predict_pancake_journal');
    let lu = 0;
    J2._lecteurTest({ epoch: async () => { lu++; return 5000; }, rounds: async (e) => { lu++; return []; } });
    await J2.indexe();
    ok(J2.demarreRemplissage() === false, 'le remplissage refuse de démarrer');
    await dort(100);
    ok(lu === 0 && !fs.existsSync(J2.fichierRounds()), 'aucun appel RPC, aucun fichier');
    ok(J2.etat().remplissage.on === false, 'et l état le dit');
    delete process.env.PREDICT_PANCAKE_REMPLISSAGE;
  }

  console.log('\n-- 7b. une panne RPC ne publie jamais l URL de BSC_RPC (ni sa clé) --');
  {
    /* Un fournisseur à clé met la clé dans le chemin ; derniereErreur est servi
       sans authentification par /predict/pancake. Un faux RPC répond 429, puis
       un lot incomplet, puis plus rien (port fermé). */
    const http = require('http');
    let mode = 429;
    const faux = http.createServer((q, r) => {
      if (mode === 429) { r.writeHead(429); r.end('slow down'); }
      else { r.writeHead(200, { 'content-type': 'application/json' }); r.end('[]'); }
    });
    await new Promise((s) => faux.listen(0, '127.0.0.1', s));
    const CLE = 'CLEFACTICE9f3a1b2c';
    const avant = process.env.BSC_RPC;
    process.env.BSC_RPC = 'http://127.0.0.1:' + faux.address().port + '/v1/' + CLE + '?apikey=' + CLE;
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-journal-rpc-'));
    delete require.cache[require.resolve('./predict_pancake_journal')];
    const J3 = require('./predict_pancake_journal');
    ok(J3.RPCS[0].includes(CLE), 'le module lit bien BSC_RPC (la clé est dans RPCS[0])');
    const L = J3._lecteurReel();
    const erreurDe = async (f) => { try { await f(); return null; } catch (e) { return String(e.message || e); } };
    const e429 = await erreurDe(() => L.epoch());
    ok(e429 && /429/.test(e429) && !e429.includes(CLE) && !/\/v1\/|apikey|127\.0\.0\.1/.test(e429),
       '429 : le message dit le statut et le rang, jamais l URL [' + e429 + ']');
    mode = 200;
    const L2 = J3._lecteurReel();
    const eLot = await erreurDe(() => L2.rounds([1, 2]));
    ok(eLot && /incomplete batch/.test(eLot) && !eLot.includes(CLE) && !/\/v1\/|apikey/.test(eLot),
       'lot incomplet : idem [' + eLot + ']');
    /* Le chemin complet : le remplissage échoue, l erreur est gardée, etat() la sert. */
    mode = 429;
    J3.demarreRemplissage();
    for (let i = 0; i < 40 && !J3.etat().remplissage.erreurs; i++) await dort(50);
    J3.arreteRemplissage();
    const et = J3.etat();
    ok(et.remplissage.erreurs >= 1 && /429/.test(et.remplissage.derniereErreur || ''),
       'le remplissage a bien échoué sur le faux RPC [' + et.remplissage.derniereErreur + ']');
    ok(!JSON.stringify(et).includes(CLE) && !/:\/\//.test(et.remplissage.derniereErreur),
       'JSON.stringify(etat()) ne contient ni la clé ni aucune URL');
    await new Promise((s) => faux.close(s));
    /* Port fermé, URL mal formée : fetch écrit lui-même l URL dans son message. */
    const LX = J3._lecteurReel();
    J3.RPCS[0] = 'http://127.0.0.1:1/v1/' + CLE;
    const eFerme = await erreurDe(() => LX.epoch());
    J3.RPCS[0] = 'ht!tp://' + CLE + '/v1/' + CLE;
    const LY = J3._lecteurReel();
    const eMal = await erreurDe(() => LY.epoch());
    ok(eFerme && eMal && !eFerme.includes(CLE) && !eMal.includes(CLE),
       'port fermé et URL mal formée : la clé ne sort pas non plus [' + eFerme + ' | ' + eMal + ']');
    ok(J3._masqueUrl('x https://h.example/k/' + CLE + '?a=' + CLE + ' y') === 'x rpc y', 'et toute URL restante est remplacée');
    if (avant === undefined) delete process.env.BSC_RPC; else process.env.BSC_RPC = avant;
  }

  /* 8. Optionnel, réseau réel : PANCAKE_RPC_REEL=1 relit l'ABI sur les RPC
     publics (lecture seule, deux rounds). Hors de la suite : aucun essai de la
     boucle ne dépend du réseau. */
  if (process.env.PANCAKE_RPC_REEL === '1') {
    console.log('\n-- 8. (réseau) l ABI sur les RPC publics --');
    const L = J._lecteurReel();
    const cur = await L.epoch();
    ok(cur > 519000, 'currentEpoch() lu [' + cur + ']');
    const rs = await L.rounds([cur - 10, cur - 11]);
    ok(rs.length === 2 && rs.every((r) => r.oracleCalled === true && r.total > 0 && r.close - r.lock >= 300 && /^\d+$/.test(r.lockPrice)),
       'rounds(uint256) décodé : oracle appelé, pool, lock/close, prix entier [' + rs.map((r) => r.epoch + ':' + r.total.toFixed(3)).join(', ') + ']');
  }

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
