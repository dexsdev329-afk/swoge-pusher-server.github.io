'use strict';
/* ============================================================================
 * « PUIS-JE REVENDRE CE JETON ? » (epreuve_sortie.js)
 *
 * Ce que l'outil DOIT tenir :
 *   1. le verdict suit l'epreuve du Cobaye : un transfert refuse par tous les
 *      porteurs ou un retour sous le minimum = blocked ; un aller-retour plus
 *      cher que le plafond de la colonie = costly ; sinon sellable ; un
 *      transfert seul, sans devis = partial ;
 *   2. on ne facture qu'une reponse : adresse invalide, jeton absent de
 *      Robinhood Chain, rien de jouable, panne → { erreur }, jamais de resultat ;
 *   3. 60 s de cache par adresse, un seul appel pour deux demandes simultanees,
 *      au plus 2 epreuves en vol ;
 *   4. chaque reponse est gardee dans sorties/AAAA-MM-JJ.jsonl, sans payeur ;
 *   5. le texte est en anglais, verdict d'abord, limites dites.
 * ==========================================================================*/
const fs = require('fs'), path = require('path'), os = require('os');
const S = require('./epreuve_sortie');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const A = '0x' + 'ab'.repeat(20);
const B = '0x' + 'cd'.repeat(20);
const C = '0x' + 'ef'.repeat(20);
const jeton = { sym: 'TOK', pool: '0x' + '11'.repeat(20), minutes: 42.3, liq: 21000, mc: 64000 };
const brut = (o) => Object.assign({ trouve: true, jeton, retourMax: 4,
  transfert: { teste: true, essais: 3, refus: 0, passe: true, via: 'pool' },
  retour: { pct: 97.2, min: 60, ver: 'v2', sonde: '0.01' },
  lp: { vu: true, brulee: 100 } }, o || {});

(async () => {
  console.log('-- 1. le verdict suit l epreuve du Cobaye --');
  {
    const V = (tr, rt) => (S.verdictDe(tr, rt, 4) || {}).v || null;
    ok(V({ teste: true, essais: 3, refus: 3, passe: false, via: 'pool' }, { pct: 97, min: 60 }) === 'blocked', 'tous les porteurs refuses : blocked, meme avec un devis correct');
    ok(V({ teste: true, essais: 3, refus: 0, passe: true, via: 'pool' }, { pct: 12, min: 60 }) === 'blocked', 'un retour sous le minimum : blocked (la piscine laisse entrer, pas sortir)');
    ok(V(null, { pct: 94, min: 60 }) === 'costly', '6 % d aller-retour, au-dessus des 4 % de la colonie : costly');
    ok(V(null, { pct: 96, min: 60 }) === 'sellable', 'pile 4 % : sellable (le plafond est inclus, comme au Cobaye)');
    ok(V({ teste: true, essais: 2, refus: 1, passe: true, via: 'market maker' }, {}) === 'partial', 'un transfert qui passe, sans devis : partial, et pas sellable');
    ok(V({ teste: false, raison: 'no holder' }, { raison: 'no venue answers' }) === null, 'rien de jouable : aucun verdict');
  }

  console.log('\n-- 2. on ne facture qu une reponse --');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'sortie-'));
  {
    let appels = 0;
    const s = S.cree({ dossier, epreuve: async () => { appels++; return brut(); } });
    const r = await s.verifie('0x123');
    ok(r.erreur && /40 hex/.test(r.erreur) && appels === 0, 'une adresse invalide est refusee avant toute lecture');
    const abs = S.cree({ dossier, epreuve: async () => ({ trouve: false }) });
    const ra = await abs.verifie(A);
    ok(ra.erreur && /nothing was charged/.test(ra.erreur) && !ra.resultat, 'un jeton absent de Robinhood Chain : erreur, rien de regle');
    const muet = S.cree({ dossier, epreuve: async () => brut({ transfert: { teste: false, raison: 'the node did not answer' }, retour: { raison: 'the quoter took more than 15 s' } }) });
    const rm = await muet.verifie(A);
    ok(rm.erreur && /could not be tested/.test(rm.erreur) && /quoter took more/.test(rm.erreur), 'rien de jouable : erreur qui dit pourquoi, rien de regle');
    const panne = S.cree({ dossier, epreuve: async () => { throw new Error('rpc down'); } });
    ok(!!(await panne.verifie(A)).erreur, 'une panne leve une erreur, pas une exception');
  }

  console.log('\n-- 3. cache, doublons, en vol --');
  {
    let appels = 0, t = 1e12;
    const s = S.cree({ dossier, maintenant: () => t, epreuve: async () => { appels++; return brut(); } });
    await s.verifie(A); await s.verifie(A.toUpperCase().replace('0X', '0x'));
    ok(appels === 1, 'la meme adresse (casse comprise) dans les 60 s : une seule epreuve');
    t += S.CACHE_MS + 1;
    await s.verifie(A);
    ok(appels === 2, 'apres 60 s : rejouee');

    let lents = 0, libere;
    const barriere = new Promise((r) => { libere = r; });
    const l = S.cree({ dossier, epreuve: async () => { lents++; await barriere; return brut(); } });
    const p1 = l.verifie(A), p2 = l.verifie(A), p3 = l.verifie(B);
    const r4 = await l.verifie(C);
    ok(lents === 2, 'A demande deux fois en meme temps, plus B : deux epreuves, pas trois [' + lents + ']');
    ok(r4.erreur && /busy/.test(r4.erreur), 'une troisieme epreuve pendant que deux tournent : occupe, rien de regle');
    libere();
    const [x1, x2] = await Promise.all([p1, p2, p3]);
    ok(x1 === x2 && x1.resultat, 'et les deux demandeurs recoivent la meme reponse');
    ok(!(await l.verifie(C)).erreur, 'une fois liberees, la suivante passe');
  }

  console.log('\n-- 4. le journal --');
  {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sortie-j-'));
    const t = Date.UTC(2026, 8, 27, 12, 0, 0);
    const s = S.cree({ dossier: d2, maintenant: () => t, epreuve: async (a) => (a === B ? { trouve: false } : brut()) });
    await s.verifie(A); await s.verifie(B);
    const f = path.join(d2, 'sorties', '2026-09-27.jsonl');
    const lignes = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((x) => JSON.parse(x)) : [];
    ok(lignes.length === 1, 'une ligne par reponse, aucune pour une erreur [' + lignes.length + ']');
    const L = lignes[0] || {};
    ok(L.adresse === A && L.verdict === 'sellable' && L.retour === 97.2 && L.cout === 2.8 && L.transfert && L.transfert.essais === 3 && L.lpBrulee === 100,
       'jeton, verdict, retour, cout, transfert, LP brule');
    ok(!('qui' in L) && !('payeur' in L) && !JSON.stringify(L).includes('x402:'), 'jamais le payeur');
    /* Un « dossier » qui est un FICHIER : mkdir echoue, la reponse part quand meme. */
    const fichier = path.join(d2, 'pas-un-dossier'); fs.writeFileSync(fichier, 'x');
    const casse = S.cree({ dossier: fichier, epreuve: async () => brut() });
    ok(!!(await casse.verifie(A)).resultat, 'un journal impossible a ecrire ne casse pas la reponse');
  }

  console.log('\n-- 5. ce que lit l agent --');
  {
    const s = S.cree({ dossier, epreuve: async () => brut({ retour: { pct: 93.5, min: 60, ver: 'v3', sonde: '0.01' } }) });
    const r = await s.verifie(A);
    const x = r.resultat;
    ok(x.verdict === 'costly' && x.roundTrip.costPct === 6.5 && x.roundTrip.maxCostPct === 4 && x.roundTrip.probeEth === 0.01, 'le resultat porte le verdict et les chiffres');
    ok(x.token.chain === 'robinhood' && x.token.symbol === 'TOK' && x.liquidity.burnedPct === 100, 'le jeton et la liquidite brulee');
    const tx = s.texte(r);
    ok(/^Exit test for \$TOK/.test(tx) && /COSTLY/.test(tx) && /6\.5% cost/.test(tx) && /never a buy or sell signal/.test(tx), 'le texte : verdict d abord, chiffres, limites');
    ok(!/[àâçéèêëîïôûùüÿœ]/i.test(tx + JSON.stringify(x)), 'tout en anglais');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
