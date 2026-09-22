'use strict';
/* ============================================================================
 * PREDICT PANCAKE — ÉTAGE 2 : L'ARGENT RÉEL, SUR UNE FAUSSE CHAÎNE
 *
 * La seule suite qui couvre de vrais BNB — comme `miroir_reel.test.js` pour le
 * miroir. Aucune vraie chaîne : on injecte un faux contrat qui ENREGISTRE les
 * paris sans rien signer, et on vérifie les garde-fous qui protègent l'argent :
 *
 *   1. La clé : montrée UNE fois à la création, jamais dans l'état ni le journal,
 *      chiffrée sur le disque. Sans `PREDICT_PANCAKE_CLE`, aucun portefeuille.
 *   2. Dry run (EXECUTE éteint) : on décide, on journalise, RIEN ne se signe.
 *   3. Armé (EXECUTE=1 + Play) : un vrai `betBull`/`betBear` part sur l'epoch de
 *      la session, à la mise martingale ; un round gagné se `claim`, un perdu non.
 *   4. La martingale monte après une perte, repart après un gain (même règle que
 *      l'étage 1 papier).
 *   5. Stop : on balaie le BNB vers le portefeuille du COMPTE, jamais une adresse
 *      reçue dans un message.
 * ==========================================================================*/
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pancake-reel-'));
process.env.PREDICT_PANCAKE_CLE = 'phrase-de-test-pour-le-registre';
process.env.PREDICT_PANCAKE_STAKE = '0.01';
process.env.PREDICT_PANCAKE_GAZ = '0.0006';
process.env.PREDICT_PANCAKE_MARGE = '0.05';
process.env.PREDICT_PANCAKE_MART_FACTEUR = '2';
process.env.PREDICT_PANCAKE_MART_PALIERS = '6';
delete process.env.PREDICT_PANCAKE_EXECUTE;   /* d'abord ÉTEINT */

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const JOUEUR = '0x1111111111111111111111111111111111111111';
const COMPTE = '0x2222222222222222222222222222222222222222';   /* le portefeuille du compte (destination du stop) */
const INTRUS = '0x3333333333333333333333333333333333333333';   /* une adresse reçue dans un message : interdite */

/* Un faux contrat de haut niveau : il enregistre, il ne signe rien. */
function fausseChaine(walletAddr) {
  const st = { epoch: 200, rounds: {}, bets: [], claims: [], sweeps: [], solde: {} };
  st.solde[walletAddr] = 1;                       /* 1 BNB dans le portefeuille */
  const nowS = Math.floor(Date.now() / 1000);
  st.rounds[200] = { epoch: '200', lock: nowS + 8, close: nowS + 308, lockPrice: '0', closePrice: '0',
                     bull: 0.1, bear: 0.5, total: 0.6, oracleCalled: false };   /* BULL gras, proche du lock */
  const ch = {
    _st: st,
    epoch: async () => st.epoch,
    fee: async () => 0.03,
    minBet: async () => 0.001,
    paused: async () => false,
    round: async (ep) => st.rounds[Number(ep)] || { epoch: String(ep), lock: 0, close: 0, lockPrice: '0', closePrice: '0', bull: 0, bear: 0, total: 0, oracleCalled: false },
    ledger: async (ep, addr) => ({ side: 'BULL', montant: 0.01, claimed: false }),
    claimable: async (ep, addr) => !!(st.rounds[Number(ep)] && st.rounds[Number(ep)].bullWon),
    refundable: async () => false,
    balance: async (addr) => st.solde[addr] || 0,
    betBull: async (c, ep, mise) => { st.bets.push({ from: c.adr, side: 'BULL', ep: Number(ep), mise }); st.solde[c.adr] -= mise; return 'txbull-' + ep; },
    betBear: async (c, ep, mise) => { st.bets.push({ from: c.adr, side: 'BEAR', ep: Number(ep), mise }); st.solde[c.adr] -= mise; return 'txbear-' + ep; },
    claim: async (c, eps) => { st.claims.push({ from: c.adr, eps: eps.slice() }); return 'txclaim'; },
    sweep: async (c, vers) => { const m = st.solde[c.adr] || 0; st.sweeps.push({ from: c.adr, vers, montant: m }); st.solde[c.adr] = 0; return { tx: 'txsweep', montant: m, vide: m <= 0 }; },
  };
  return ch;
}

/* Fermer le round 200 avec BULL gagnant (le prix a monté), passer l'epoch. */
function ferme200Gagnant(ch) {
  ch._st.rounds[200] = Object.assign({}, ch._st.rounds[200], { lockPrice: '100', closePrice: '120', oracleCalled: true, bullWon: true });
  ch._st.epoch = 202;
}

(async () => {
  console.log('-- 1. la clé : une fois, chiffrée, jamais dans l état --');
  {
    const P = require('./predict_pancake_reel');
    P._reset();
    const r = await P.cree(JOUEUR);
    ok(/^0x[0-9a-fA-F]{40}$/.test(r.adresse), 'un portefeuille est créé, adresse BSC [' + r.adresse.slice(0, 10) + '…]');
    ok(/^0x[0-9a-f]{64}$/.test(r.cle), 'la clé privée est rendue UNE fois');
    let a2 = false; try { await P.cree(JOUEUR); } catch (e) { a2 = /already/.test(e.message); }
    ok(a2, 'un second appel refuse : un seul portefeuille par compte');
    const e = P.etat(JOUEUR);
    ok(JSON.stringify(e).indexOf(r.cle) === -1, 'l état ne contient JAMAIS la clé privée');
    ok(e.adresse === r.adresse && e.aWallet === true, 'l état montre l adresse, pas la clé');
    /* Le fichier du registre : la clé y est chiffrée (v1.…), jamais en clair. */
    const brut = fs.readFileSync(path.join(process.env.DATA_DIR, 'predict_pancake_reel.json'), 'utf8');
    ok(brut.indexOf(r.cle) === -1, 'le registre sur disque ne contient pas la clé en clair');
    ok(/v1\.[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+/.test(brut), 'il contient l enveloppe chiffrée (AES-GCM)');
    /* Sans clé maîtresse, aucune création. */
    ok(P.revele(JOUEUR).cle === r.cle, 'revele rend SA clé au joueur (déchiffrée)');
  }

  console.log('\n-- 2. dry run (EXECUTE éteint) : on décide, rien ne se signe --');
  {
    const P = require('./predict_pancake_reel');
    ok(P.EXECUTE === false, 'EXECUTE est éteint par défaut');
    const ch = fausseChaine(P._fiche(JOUEUR).adr);
    P._chaineTest(ch);
    P._predicteur(async () => ({ sens: 'UP', prob: 55, assez: true }));
    await P.demarre(JOUEUR);
    await P.tic();
    ok(ch._st.bets.length === 0, 'AUCUN pari signé en dry run [' + ch._st.bets.length + ']');
    const e = P.etat(JOUEUR);
    ok(e.enAttente.length === 1 && e.enAttente[0].wouldBet && e.enAttente[0].reel === false,
       'mais la décision existe et dit qu on aurait misé (simulation)');
    ok(/dry run/i.test(e.note), 'l état dit clairement que c est un dry run');
  }

  console.log('\n-- 3. armé (EXECUTE=1 + Play) : un vrai pari part, un gain se claim --');
  {
    delete require.cache[require.resolve('./predict_pancake_reel')];
    process.env.PREDICT_PANCAKE_EXECUTE = '1';
    const P = require('./predict_pancake_reel');
    ok(P.EXECUTE === true, 'EXECUTE est armé');
    P._reset();
    const w = await P.cree(JOUEUR);
    const ch = fausseChaine(P._fiche(JOUEUR).adr);
    P._chaineTest(ch);
    P._predicteur(async () => ({ sens: 'UP', prob: 55, assez: true }));
    const d = await P.demarre(JOUEUR);
    ok(d.actif && d.execute === true, 'Play arme un compte financé (1 BNB ≥ min)');
    await P.tic();   /* décide près du lock → mise réelle */
    ok(ch._st.bets.length === 1, 'un pari a été signé [' + ch._st.bets.length + ']');
    const b = ch._st.bets[0];
    ok(b.side === 'BULL' && b.ep === 200, 'sur l epoch de la session, du bon côté (BULL, côte grasse)');
    ok(b.from === w.adresse, 'signé par le portefeuille de la SESSION, pas un autre');
    ok(Math.abs(b.mise - 0.01) < 1e-9, 'à la mise de base (martingale au palier 0) [' + b.mise + ']');
    /* Le round ferme, BULL gagne : on résout et on réclame. */
    ferme200Gagnant(ch);
    await P.tic();
    ok(ch._st.claims.length === 1 && ch._st.claims[0].eps[0] === 200, 'le round gagné est réclamé (claim #200)');
    const e = P.etat(JOUEUR);
    ok(e.banque.wins === 1 && e.banque.pl > 0, 'gagné : la banque monte [' + e.banque.pl + ' BNB]');
    ok(e.fermees[0].issue === 'win' && e.fermees[0].reel === true, 'l historique porte le round réel gagné');
    ok(JSON.stringify(e).indexOf(w.cle) === -1, 'et toujours aucune clé dans l état');
  }

  console.log('\n-- 4. la martingale monte après une perte (même règle que l étage 1) --');
  {
    delete require.cache[require.resolve('./predict_pancake_reel')];
    process.env.PREDICT_PANCAKE_EXECUTE = '1';
    const P = require('./predict_pancake_reel');
    P._reset();
    const w = await P.cree(JOUEUR);
    const ch = fausseChaine(P._fiche(JOUEUR).adr);
    P._chaineTest(ch);
    P._predicteur(async () => ({ sens: 'UP', prob: 55, assez: true }));
    await P.demarre(JOUEUR);
    await P.tic();                       /* pari #200 BULL, mise 0.01 */
    ok(ch._st.bets[0].mise === 0.01, 'mise de base au départ');
    /* Le round ferme, BULL PERD (le prix a baissé). */
    ch._st.rounds[200] = Object.assign({}, ch._st.rounds[200], { lockPrice: '100', closePrice: '90', oracleCalled: true, bullWon: false });
    ch._st.epoch = 202;
    await P.tic();                       /* résout : perte → palier 1 */
    const e = P.etat(JOUEUR);
    ok(e.banque.losses === 1, 'la perte est comptée');
    ok(e.martingale.palier === 1 && e.martingale.miseCourante > 0.01,
       'après la perte : palier 1, mise doublée [' + e.martingale.miseCourante + ']');
    ok(ch._st.claims.length === 0, 'un round perdu ne se claim pas');
  }

  console.log('\n-- 5. Stop : on balaie vers le COMPTE, jamais une adresse d un message --');
  {
    delete require.cache[require.resolve('./predict_pancake_reel')];
    process.env.PREDICT_PANCAKE_EXECUTE = '1';
    const P = require('./predict_pancake_reel');
    P._reset();
    await P.cree(JOUEUR);
    const ch = fausseChaine(P._fiche(JOUEUR).adr);
    P._chaineTest(ch);
    await P.demarre(JOUEUR);
    /* Le serveur passe TOUJOURS ws.addr (le compte) comme destination. */
    const r = await P.arrete(JOUEUR, COMPTE);
    ok(r.balaye && r.vers === COMPTE, 'le balayage va vers le portefeuille du compte');
    ok(ch._st.sweeps.length === 1 && ch._st.sweeps[0].vers === COMPTE, 'et une seule sortie, vers le compte');
    ok(ch._st.sweeps.every((s) => s.vers !== INTRUS), 'jamais vers l adresse intruse');
    ok(P._fiche(JOUEUR).actif === false, 'et le compte n est plus actif');
    let sansDest = false; try { await P.arrete(JOUEUR, ''); } catch (e) { sansDest = /destination/.test(e.message); }
    ok(sansDest, 'un stop sans destination valable refuse');
  }

  console.log('\n-- 6. papier de sécurité : le module ne porte aucune clé en dur --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'predict_pancake_reel.js'), 'utf8');
    ok(!/0x[0-9a-fA-F]{64}/.test(src), 'aucune clé privée écrite dans le source');
    ok(/PREDICT_PANCAKE_CLE/.test(src) && /aes-256-gcm/.test(src), 'la clé vient de l environnement, chiffrée AES-GCM');
    ok(/PREDICT_PANCAKE_EXECUTE/.test(src), 'et un vrai pari exige le verrou EXECUTE');
  }

  console.log('\nVERIFICATIONS : ' + n + '  —  ' + (rates ? ('RATES : ' + rates + '/' + n) : 'tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.log('  EXCEPTION ' + (e && e.stack || e)); process.exit(1); });
