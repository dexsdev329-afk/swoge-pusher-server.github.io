'use strict';
/* ============================================================================
 * LE RELEVE DOIT ECHOUER A TROUVER QUELQUE CHOSE DANS DU BRUIT
 *
 * C est LA verification de ce fichier, et elle vaut toutes les autres.
 *
 * Avec quinze decoupages de cinq tranches, on examine soixante-quinze cases.
 * Sur des donnees purement aleatoires, la meilleure de soixante-quinze cases
 * a l air excellente — c est de l arithmetique, pas de la chance. Un outil
 * qui trie par esperance et montre le haut du tableau trouvera TOUJOURS une
 * regle gagnante, y compris dans du bruit. C est comme ca qu on met de
 * l argent reel sur rien.
 *
 * Alors on lui donne du bruit pur, et on exige qu il dise « dans le bruit ».
 * Puis on lui donne un vrai signal, et on exige qu il le voie. Un outil qui
 * ne rate jamais rien ne sert a rien : il doit rater ce qui n existe pas.
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' (' + JSON.stringify(a) + ')');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'perpr-'));
process.env.DATA_DIR = BAC;
process.env.PERP_JOURNAL = '1';
const J = require('./perp_journal');
const R = require('./perp_releve');

/* Un generateur reproductible : un essai qui clignote a une cause, et un
   `Math.random` non maitrise en est une. */
let graine = 12345;
function alea() { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; }

/**
 * Fabrique `nb` situations. `signal` decide du rendement :
 *   - 'bruit'       : purement aleatoire, aucun lien avec quoi que ce soit ;
 *   - 'financement' : le financement paie vraiment, et le reste est du bruit.
 */
function fabrique(nb, signal, jour) {
  const t0 = Date.parse(jour + 'T00:00:00Z');
  const marches = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
  for (let i = 0; i < nb; i++) {
    const t = t0 + i * 300000;
    const sym = marches[i % marches.length];
    const fin = (alea() - 0.5) * 0.04 / 100;          /* +/- 0,02 % par 8 h */
    const id = J.idObs(t, sym, i);
    J.noteObservation({ id, t, x: {
      sym, prix: 100 + alea() * 10, ecartEma: (alea() - 0.5) * 2, fond: (alea() - 0.5) * 10,
      vol15: alea() * 0.5, vol4: alea() * 0.6, couloir: alea(), var1h: (alea() - 0.5) * 2,
      var4h: (alea() - 0.5) * 4, var24: (alea() - 0.5) * 8, financement: fin,
      interet: 1000 + alea() * 500, varInteret: (alea() - 0.5) * 4, base: (alea() - 0.5) * 0.06,
      carnet: (alea() - 0.5), volume: 1e7 + alea() * 2e9,
    }, sides: [{ sens: 1, score: Math.round(30 + alea() * 60), refus: null, qui: null },
               { sens: -1, score: Math.round(30 + alea() * 60), refus: null, qui: null }],
      prise: 1 });
    const sens = alea() > 0.5 ? 1 : -1;
    let r = (alea() - 0.5) * 4;                        /* du bruit, toujours */
    /* Un vrai signal : contre la foule. Financement positif = les longs
       paient = tout le monde est long, donc le short paie. */
    if (signal === 'financement') r += -sens * (fin * 100 / 0.02) * 2.5;
    J.noteResultat({ id, t: t + 240 * 60000, sym, sens, horizon: 240,
                     rendement: r, brut: r, financement: 0, cle: 'pris' });
  }
}

console.log('-- du bruit pur : le releve ne doit RIEN trouver --');
{
  fabrique(3000, 'bruit', '2026-09-01');
  const r = R.releve({ jours: 100000, horizon: 240, minCase: 30 });
  eq(r.apparies, 3000, 'trois mille situations appariees');
  ok(r.ensemble && Math.abs(r.ensemble.moyenne) < 0.4,
     'l ensemble tourne autour de zero, comme il doit : ' + r.ensemble.moyenne + ' %');
  /* Le decoupage est large : quinze questions, des dizaines de cases. */
  const total = r.decoupages.reduce((a, d) => a + d.examinees, 0);
  ok(total >= 40, total + ' cases examinees sur quinze decoupages — assez pour que le hasard brille');
  /* ---- CE QU UN OUTIL NAIF AURAIT ANNONCE ----
   * La meilleure case de tout le releve, sur du bruit pur. Elle est belle,
   * et elle ne vaut rien. */
  let meilleure = null;
  for (const d of r.decoupages) for (const c of d.cases)
    if (!meilleure || c.moyenne > meilleure.c.moyenne) meilleure = { d: d.decoupage, c };
  console.log('       la plus belle case du bruit : ' + meilleure.d + ' / ' + meilleure.c.case
              + ' = ' + meilleure.c.moyenne + ' % sur ' + meilleure.c.n + ' observations');
  ok(meilleure.c.moyenne > 0.15,
     'un outil naif aurait annonce ' + meilleure.c.moyenne + ' % — et se serait trompe');
  /* ---- CE QUE CELUI-CI ANNONCE ---- */
  const remarquables = r.decoupages.filter((d) => d.verdict === 'remarquable');
  eq(remarquables.length, 0,
     'aucun decoupage n est declare remarquable : ' + remarquables.map((d) => d.decoupage).join(', '));
  ok(r.decoupages.every((d) => d.hasard === null || d.cases.length === 0 || d.cases[0].moyenne <= d.hasard),
     'chaque meilleure case reste sous le plafond du hasard, decoupage par decoupage');
}

console.log('\n-- un vrai signal : il doit le voir --');
{
  fs.rmSync(J.dossier(), { recursive: true, force: true });
  graine = 999;
  fabrique(3000, 'financement', '2026-09-01');
  const r = R.releve({ jours: 100000, horizon: 240, minCase: 30 });
  const f = r.decoupages.find((d) => d.decoupage === 'financement');
  eq(f.verdict, 'remarquable', 'le decoupage par financement ressort');
  ok(f.cases[0].moyenne > f.hasard,
     'sa meilleure case depasse le plafond du hasard : ' + f.cases[0].moyenne + ' % contre ' + f.hasard + ' %');
  console.log('       ' + f.cases[0].case + ' : ' + f.cases[0].moyenne + ' % sur ' + f.cases[0].n + ' observations');
  /* Un outil qui declarerait tout remarquable serait aussi inutile que celui
     qui ne declare rien : les decoupages sans lien doivent rester muets. */
  const bruyants = r.decoupages.filter((d) => d.verdict === 'remarquable').map((d) => d.decoupage);
  ok(bruyants.length <= 3, 'et il ne declare pas tout remarquable : ' + bruyants.join(', '));
}

console.log('\n-- une case trop petite n est pas une case --');
{
  const r = R.releve({ jours: 100000, horizon: 240, minCase: 500 });
  ok(r.decoupages.every((d) => d.cases.every((c) => c.n >= 500)),
     'sous le minimum demande, aucune case n est rendue');
  const r2 = R.releve({ jours: 100000, horizon: 240, minCase: 100000 });
  ok(r2.decoupages.every((d) => d.examinees === 0 && d.verdict === 'pas assez'),
     'et quand plus rien ne passe, le verdict est « pas assez », pas « dans le bruit »');
}

console.log('\n-- une echeance sans resultat ne s invente pas --');
{
  const r = R.releve({ jours: 100000, horizon: 15 });
  eq(r.apparies, 0, 'aucune situation appariee a quinze minutes');
  eq(r.ensemble, null, 'et aucune esperance annoncee');
}

console.log('\n-- le releve ne DECIDE rien --');
{
  const src = fs.readFileSync(path.join(__dirname, 'perp_releve.js'), 'utf8');
  ok(!/require\(['"]\.\/ai_perp/.test(src), 'il ne charge pas le moteur : il le lirait pour l influencer');
  const moteur = fs.readFileSync(path.join(__dirname, 'ai_perp.js'), 'utf8');
  ok(!/perp_releve/.test(moteur), 'et le moteur ne le charge pas non plus');
  ok(!/API_KEY|SECRET|signature|\bsign\(/i.test(src.replace(/\* [^\n]*/g, '')),
     'ni cle ni signature : c est un outil de lecture');
}

try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* un bac temporaire */ }
console.log(rates ? `\nperp_releve.test.js : RATES : ${rates}/${n}` : `\nperp_releve.test.js : ${n} verifications OK`);
process.exit(rates ? 1 : 0);
