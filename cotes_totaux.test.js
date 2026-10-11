'use strict';
/* ============================================================================
 * LE TOTAL PRIS AU MARCHE DES TOTAUX, DANS LA GRILLE (lot 5, 10/10/2026)
 *
 * `cotes.derives` peut recevoir le total du plus/moins des livres
 * (`contexte.totalMarche`, pose par paris_import.avecButs pour une cle de
 * PARIS_TOTAUX_LIGUES seulement — vide par defaut). Ce fichier verifie, sur
 * leur INTENTION :
 *   1. `totalDuMarche` est l'inverse de `plusDeLigne` (lignes x,5 seulement) ;
 *   2. la grille rend le P(plus de 2,5) du marche (identite de Dixon-Coles, a
 *      la troncature a BUTS_MAX pres) ;
 *   3. le 1-N-2 vendu est reproduit quand rho tient dans RHO_DU_MARCHE ; en
 *      butee, le rapport 1/2 reste exact ; la dc suit le 1-N-2 vendu ;
 *   4. aucun lot de scores ne rend plus qu'il ne coute ;
 *   5. sans total (ou un total de plus de 48 h), les lots sont octet pour
 *      octet ceux du code d'avant le lot (essais/totaux/sans_total.json,
 *      genere avec le cotes.js de 29b6160) ;
 *   6. la garde de coherence : au-dela d'un point du nul vendu, la rencontre
 *      reprend le chemin d'avant (sans elle, le « 1 » du handicap se paie) ;
 *      cede:false, RHO_DU_MARCHE, TOTAL_DU_MARCHE ;
 *   7. l'ombre compte a part ; `butsDe` (l'age du total).
 * Mesures : EXPLOITATION.md 8.8decies (porte 0, banc du 10/10/2026).
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'totaux-cotes-'));
process.env.DATA_DIR = DIR;
for (const k of Object.keys(process.env)) if (/^PARIS_/.test(k)) delete process.env[k];
const paris = require('./paris');
const c = require('./cotes');

let n = 0, rates = 0;
const ok = (v, m) => { n++; if (v) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const essai = (m, f) => { try { const r = f(); if (Array.isArray(r)) ok(r[0], m + (r[1] ? ' — ' + r[1] : '')); else ok(!!r, m); } catch (e) { ok(false, `${m} — exception : ${e.message}`); } };
const issuesDe = (s) => c.issuesDeLaGrille(c.grilleDesScores(s.lh, s.la, s.rho));
const duel = (ecart) => { const pn = c.NUL_MAX * Math.exp(-c.NUL_PENTE * Math.abs(ecart)); const e = 1 / (1 + Math.pow(10, -ecart / 400)); return { 1: (1 - pn) * e, N: pn, 2: (1 - pn) * (1 - e) }; };
const SUPER_LIG = 'soccer_turkey_super_league', EPL = 'soccer_epl';
const compte = () => Object.assign({}, c.etatButs().depuisDemarrage);
const ombre = () => Object.assign({}, c.etatButs().ombre);
const marche = (p, ligue, extra) => c.marchesDuMarche('foot', p, undefined, ligue, extra);
const J = (x) => JSON.stringify(x);

console.log('\n-- 1. totalDuMarche est l inverse de plusDeLigne, lignes x,5 seulement --');
essai('P(plus de L) retrouve a 1e-6 pour L = 1,5 ; 2,5 ; 3,5 et p de 0,05 a 0,95', () => {
  let pire = 0;
  for (const L of [1.5, 2.5, 3.5]) for (let p = 0.05; p < 0.951; p += 0.05) {
    const T = c.totalDuMarche(p, L);
    pire = Math.max(pire, Math.abs(c.plusDeLigne(T, L) - p));
  }
  return [pire < 1e-6, `ecart max ${pire.toExponential(2)}`];
});
essai('plusDeLigne(T, 2,5) = 1 - e^-T (1 + T + T^2/2)', () => {
  let pire = 0;
  for (let T = 0.5; T < 6; T += 0.25) pire = Math.max(pire, Math.abs(c.plusDeLigne(T, 2.5) - (1 - Math.exp(-T) * (1 + T + T * T / 2))));
  return [pire < 1e-12, pire.toExponential(2)];
});
essai('une ligne entiere ou en quart (2,25 ; 2,75 ; 3) rend null', () => [2.25, 2.75, 3, 2].every((L) => c.totalDuMarche(0.5, L) === null));
essai('p hors de ]0,02 ; 0,98[ rend null (0,02, 0,98, 0,01, 0,99, NaN)', () => [0.02, 0.98, 0.01, 0.99, NaN, undefined, 'x'].every((p) => c.totalDuMarche(p, 2.5) === null));
essai('la ligne par defaut est 2,5', () => Math.abs(c.totalDuMarche(0.55) - c.totalDuMarche(0.55, 2.5)) < 1e-12);

console.log('\n-- 2. la grille rend le P(plus de 2,5) du marche --');
{
  let pire = 0, pireTronc = 0, cas = 0, totalBouge = 0;
  for (const T of [1.6, 2.0, 2.4, 2.8, 3.2, 3.6, 4.0, 4.4, 4.8]) for (const ecart of [-300, -100, 0, 100, 255, 423, 565]) {
    const p = duel(ecart);
    const s = c.ajusteRho(p[1], p.N, p[2], T, c.RHO_DU_MARCHE, c.TOTAL_DU_MARCHE, { cede: false });
    if (Math.abs(s.total - T) > 1e-12) totalBouge++;
    const g = c.grilleDesScores(s.lh, s.la, s.rho);
    let plus = 0;
    for (let i = 0; i <= c.BUTS_MAX; i++) for (let j = 0; j <= c.BUTS_MAX; j++) if (i + j > 2.5) plus += g[i][j];
    /* la valeur exacte de la grille tronquee : 1 - P(total <= 2) / S, S = la masse du produit sur 13 x 13 */
    let S = 0, bas = 0;
    for (let i = 0; i <= c.BUTS_MAX; i++) for (let j = 0; j <= c.BUTS_MAX; j++) { const q = c.poisson(s.lh, i) * c.poisson(s.la, j); S += q; if (i + j <= 2) bas += q; }
    pireTronc = Math.max(pireTronc, Math.abs(plus - (1 - bas / S)));
    pire = Math.max(pire, Math.abs(plus - c.plusDeLigne(T, 2.5)));
    cas++;
  }
  ok(totalBouge === 0, `cede:false : le total demande ne bouge jamais (${cas} cas)`);
  ok(pireTronc < 1e-9, `rho n'y touche pas : P(plus) de la grille = 1 - P(total <= 2)/S a ${pireTronc.toExponential(2)} pres`);
  ok(pire < 2e-4, `P(plus de 2,5) de la grille = celui du marche, a la troncature a ${c.BUTS_MAX} buts pres (ecart max ${pire.toExponential(2)})`);
}

console.log('\n-- 3. le 1-N-2 vendu est reproduit ; en butee, le rapport ; la dc suit le 1-N-2 vendu --');
{
  let reproduits = 0, libres = 0, pireLibre = 0;
  for (const T of [1.8, 2.2, 2.6, 3.0, 3.4]) for (const ecart of [-200, 0, 150, 300]) {
    const p = duel(ecart);
    const s = c.ajusteRho(p[1], p.N, p[2], T, c.RHO_DU_MARCHE, c.TOTAL_DU_MARCHE, { cede: false });
    if (!s.nulAtteint) continue;
    libres++;
    const q = issuesDe(s), S3 = p[1] + p.N + p[2];
    const e = Math.max(Math.abs(q[1] - p[1] / S3), Math.abs(q.N - p.N / S3), Math.abs(q[2] - p[2] / S3));
    pireLibre = Math.max(pireLibre, e);
    if (e < 1e-6) reproduits++;
  }
  ok(libres > 10 && reproduits === libres, `rho dans RHO_DU_MARCHE : ${reproduits}/${libres} 1-N-2 reproduits a 1e-6 (ecart max ${pireLibre.toExponential(2)})`);
  /* petit total, nul eleve : il faut rho sous -0,30 (RHO_BORNES n'y suffit pas) */
  const F1 = { 1: 0.33, N: 0.38, 2: 0.29 };
  const s1 = c.ajusteRho(F1[1], F1.N, F1[2], 2.2, c.RHO_DU_MARCHE, c.TOTAL_DU_MARCHE, { cede: false });
  ok(s1.nulAtteint && s1.rho < -0.30 && s1.rho > -0.40, `petit total et nul eleve (2,2 buts, nul 38 %) : rho ${s1.rho.toFixed(3)} dans ]-0,40 ; -0,30[, 1-N-2 reproduit`);
  const k0 = compte();
  const mm = marche(F1, EPL, { total: 2.2 });
  const k1 = compte();
  ok(mm && k1.totalMarche - k0.totalMarche === 1 && k1.nulManque === k0.nulManque && k1.totalMarcheEcarte === k0.totalMarcheEcarte,
    'par marchesDuMarche : la grille prend le total du marche, le nul est atteint (compteurs totalMarche +1, nulManque +0)');
  /* en butee mais sous la garde : nul manque d'au plus un point, rapport exact */
  const F3 = { 1: 0.30, N: 0.32, 2: 0.38 };
  const s3 = c.ajusteRho(F3[1], F3.N, F3[2], 1.5, c.RHO_DU_MARCHE, c.TOTAL_DU_MARCHE, { cede: false });
  const q3 = issuesDe(s3);
  ok(!s3.nulAtteint && Math.abs(s3.ecartNul) <= c.ECART_NUL_GARDE && Math.abs(q3[1] / (q3[1] + q3[2]) - F3[1] / (F3[1] + F3[2])) < 1e-6
     && Math.max(Math.abs(q3[1] - F3[1]), Math.abs(q3[2] - F3[2])) <= Math.abs(s3.ecartNul) + 1e-9,
     `en butee (1,5 but, nul 32 %) : rapport 1/2 exact, nul a ${(100 * s3.ecartNul).toFixed(2)} point(s), 1 et 2 a moins que lui`);
  const k2 = compte();
  const mm3 = marche(F3, EPL, { total: 1.5 });
  const k3 = compte();
  ok(k3.nulManque - k2.nulManque === 1 && k3.totalMarche - k2.totalMarche === 1, 'en butee, sous la garde : vendu au total du marche, COMPTE.nulManque monte');
  /* cede:false — au total demande : P(plus de 2,5) du lot = celui du marche */
  const g3 = c.probasDesMarches(s3.lh, s3.la, s3.rho);
  const attendu = c.habilleUnMarche(g3.ou25, ['plus', 'moins'], 1, c.MARGES_AU_MARCHE.ou25);
  ok(mm3.ou25 && J(mm3.ou25.cotes) === J(attendu.cotes) && Math.abs(g3.ou25.plus - c.plusDeLigne(1.5, 2.5)) < 1e-4,
    `cede:false : le plus/moins vendu sort du total DEMANDE (1,5), pas d un total cede (${J(mm3.ou25 && mm3.ou25.cotes)})`);
  /* la dc : celle du 1-N-2 vendu, toujours */
  for (const [p, T, nom] of [[F1, 2.2, 'nul atteint'], [F3, 1.5, 'en butee']]) {
    const m = marche(p, EPL, { total: T });
    const pdc = { '1X': p[1] + p.N, 12: p[1] + p[2], X2: p.N + p[2] };
    const lot = c.habilleUnMarche(pdc, paris.MARCHES.dc.issues('foot'), paris.MARCHES.dc.couverture, undefined);
    ok(m.dc && J(m.dc.cotes) === J(lot.cotes), `la double chance est celle du 1-N-2 vendu (${nom})`);
  }
}

console.log('\n-- 4. aucun lot de scores ne rend plus qu il ne coute --');
{
  let lots = 0, perdants = 0, pire = 0;
  for (let T = 1.5; T <= 5.0 + 1e-9; T += 0.5) for (const x of [0.5, 0.62, 0.75, 0.85]) for (const r0 of c.RHO_DU_MARCHE) {
    const lh = T * x, la = T * (1 - x);
    /* rho a la borne de la plage, ramene dans la garde de Dixon-Coles (ajusteRho) */
    const rho = Math.min(0.9 / (lh * la), Math.max(-0.9 / Math.max(lh, la), r0));
    const g = c.probasDesMarches(lh, la, rho);
    const lot = c.habilleUnMarche(g.score, paris.SCORES, 1, c.MARGES_AU_MARCHE.score, c.scoresPrudents(lh, la, rho));
    if (!lot) continue;
    lots++;
    for (const s of paris.SCORES) { const e = lot.cotes[s] * g.score[s]; pire = Math.max(pire, e); if (e > 1 + 1e-9) perdants++; }
  }
  ok(lots >= 50 && perdants === 0, `${lots} lots de scores (T 1,5 a 5, rho aux deux bornes) : aucune cote x proba de la grille au-dessus de 1 (max ${pire.toFixed(3)})`);
}

console.log('\n-- 5. sans total, ou un total de plus de 48 h : octet pour octet le code d avant le lot --');
{
  const REF = JSON.parse(fs.readFileSync(path.join(__dirname, 'essais', 'totaux', 'sans_total.json'), 'utf8'));
  let pareils = 0, total = 0, premier = null;
  for (const x of REF.cas) {
    for (const [nom, v, attendu] of [
      ['marchesDuMarche', marche(x.p, x.ligue), x.marchesDuMarche],
      ['marchesDuMarche extra vide', marche(x.p, x.ligue, {}), x.marchesDuMarche],
      ['marchesDuMarche total absent', marche(x.p, x.ligue, { total: undefined }), x.marchesDuMarche],
      ['marchesDe', (() => { const b = c.habilleUnMarche(x.p, ['1', 'N', '2'], 1, undefined); return b ? c.marchesDe('foot', 'Equipe A', 'Equipe B', undefined, b.cotes, x.ligue) : null; })(), x.marchesDe]]) {
      total++;
      if (J(v) === J(attendu)) pareils++; else if (!premier) premier = `${nom} ${x.ligue} ${J(x.p)}`;
    }
  }
  ok(total === 312 && pareils === total, `${pareils}/${total} lots identiques a ceux de 29b6160 (${REF.cas.length} cas x 4 appels)` + (premier ? ' ; premier ecart : ' + premier : ''));
  /* par habille : un butsMarche perime est ignore, un frais sert */
  const T0 = Date.UTC(2026, 9, 12, 12);
  const m0 = { id: 'epl-x', sport: 'foot', domicile: 'Arsenal', exterieur: 'Everton', debut: new Date(T0 + 30 * 3600000).toISOString(),
    cotesGenerees: true, source: { ligue: EPL, evenement: 'e1' }, prixMarche: { ref: 'betfair', t: new Date(T0).toISOString(), livres: 5, p: { 1: 0.55, N: 0.25, 2: 0.20 } } };
  const sans = c.habille(m0, undefined, T0);
  const avec = (h, total) => c.habille(Object.assign({}, m0, { butsMarche: { total: total || 3.4, t: new Date(T0 - h * 3600000).toISOString(), ref: 'betfair', ligne: 2.5 } }), undefined, T0);
  ok(J(avec(49).marches) === J(sans.marches), 'un total de 49 h est ignore : les lots sont ceux du chemin d avant');
  ok(J(avec(47).marches) !== J(sans.marches) && J(avec(47).marches['1n2']) === J(sans.marches['1n2']), 'un total de 47 h sert : les buts changent, le 1-N-2 non');
  process.env.PARIS_TOTAUX_AGE_MAX_H = '200';
  ok(J(avec(49).marches) === J(sans.marches), 'PARIS_TOTAUX_AGE_MAX_H=200 est ramene a 48 : un total de 49 h reste ignore');
  process.env.PARIS_TOTAUX_AGE_MAX_H = '24';
  ok(J(avec(30).marches) === J(sans.marches) && J(avec(20).marches) !== J(sans.marches), 'PARIS_TOTAUX_AGE_MAX_H=24 : 30 h ignore, 20 h sert (plus strict permis)');
  delete process.env.PARIS_TOTAUX_AGE_MAX_H;
  /* une rencontre commencee ne bouge plus, total ou pas */
  const commencee = Object.assign({}, sans, { debut: new Date(T0 - 60000).toISOString(), butsMarche: { total: 4.2, t: new Date(T0).toISOString(), ref: 'betfair', ligne: 2.5 } });
  ok(c.habille(commencee, undefined, T0) === commencee, 'une rencontre commencee est rendue telle quelle, meme avec un total frais');
  /* le chemin Elo (lot releve) prend aussi le total (decision du 09/10) */
  const b = c.habilleUnMarche({ 1: 0.55, N: 0.25, 2: 0.20 }, ['1', 'N', '2'], 1, undefined);
  ok(J(c.marchesDe('foot', 'A', 'B', undefined, b.cotes, EPL, { total: 3.4 }).ou25) !== J(c.marchesDe('foot', 'A', 'B', undefined, b.cotes, EPL).ou25),
    'marchesDe : un championnat revenu a l Elo (lot releve) prend aussi le total du marche');
}

console.log('\n-- 6. la garde de coherence, cede:false, RHO_DU_MARCHE, TOTAL_DU_MARCHE --');
{
  /* gros favori, total bas : rho ne rend pas le nul, la grille s'ecarte de 15 points */
  const F2 = { 1: 0.80, N: 0.10, 2: 0.10 };
  const s = c.ajusteRho(F2[1], F2.N, F2[2], 1.6, c.RHO_DU_MARCHE, c.TOTAL_DU_MARCHE, { cede: false });
  ok(!s.nulAtteint && Math.abs(s.ecartNul) > c.ECART_NUL_GARDE, `fixture : 80 % / 10 % / 10 %, 1,6 but — la grille du total du marche manque le nul de ${(100 * s.ecartNul).toFixed(1)} points`);
  const k0 = compte();
  const garde = marche(F2, SUPER_LIG, { total: 1.6 });
  const k1 = compte();
  const avant = marche(F2, SUPER_LIG);
  ok(J(garde) === J(avant), 'au-dela d un point : TOUS les marches derives sont ceux du chemin d avant (total du championnat)');
  ok(k1.totalMarcheEcarte - k0.totalMarcheEcarte === 1 && k1.totalMarche === k0.totalMarche, 'et COMPTE.totalMarcheEcarte le dit (+1), totalMarche ne bouge pas');
  /* la reference : la grille du chemin d'avant, qui reproduit le 1-N-2 vendu */
  const sRef = c.ajusteRho(F2[1], F2.N, F2[2], c.totalDe(SUPER_LIG, F2, 'marche'), undefined, undefined, { cede: true });
  const gRef = c.probasDesMarches(sRef.lh, sRef.la, sRef.rho);
  ok(garde.hand && garde.hand.cotes[1] * gRef.hand[1] <= 1 && garde.hand.cotes[2] * gRef.hand[2] <= 1,
    `avec la garde : le handicap ne se paie pas (« 1 » ${garde.hand && garde.hand.cotes[1]} x ${gRef.hand[1].toFixed(3)})`);
  const gSans = c.probasDesMarches(s.lh, s.la, s.rho);
  const sansGarde = c.habilleUnMarche(gSans.hand, ['1', '2'], 1, c.MARGES_AU_MARCHE.hand);
  ok(sansGarde && sansGarde.cotes[1] * gRef.hand[1] > 1, `ce que la garde empeche : sans elle, « 1 » a ${sansGarde && sansGarde.cotes[1]} x ${gRef.hand[1].toFixed(3)} = ${(sansGarde.cotes[1] * gRef.hand[1]).toFixed(2)} > 1`);
  /* TOTAL_DU_MARCHE : borne a [1,5 ; 5]. Deux rencontres ou la grille tient
     sous la garde aux deux totaux (sinon la garde rendrait les deux egaux) */
  const HAUT = { 1: 0.40, N: 0.18, 2: 0.42 }, BAS = { 1: 0.15, N: 0.43, 2: 0.42 };
  const kb = compte();
  const h6 = marche(HAUT, EPL, { total: 6 }), h5 = marche(HAUT, EPL, { total: 5.0 }), b1 = marche(BAS, EPL, { total: 1.0 }), b15 = marche(BAS, EPL, { total: 1.5 });
  const kc = compte();
  ok(kc.totalMarche - kb.totalMarche === 4 && kc.totalMarcheEcarte === kb.totalMarcheEcarte && J(h6) === J(h5) && J(b1) === J(b15) && J(h5) !== J(marche(HAUT, EPL, { total: 4.0 })),
    'TOTAL_DU_MARCHE : un total de 6 est vendu comme 5, un total de 1 comme 1,5 (les quatre au total du marche, sous la garde)');
  const p = duel(150);
  ok(c.RHO_DU_MARCHE[0] === -0.40 && c.RHO_DU_MARCHE[1] === 0.15 && c.TOTAL_DU_MARCHE[0] === 1.5 && c.TOTAL_DU_MARCHE[1] === 5.0 && c.ECART_NUL_GARDE === 0.01,
    'les constantes mesurees : RHO_DU_MARCHE [-0,40 ; 0,15], TOTAL_DU_MARCHE [1,5 ; 5], garde 1 point');
  /* un total illisible ne sert pas */
  ok(J(marche(p, EPL, { total: 'x' })) === J(marche(p, EPL)) && J(marche(p, EPL, { total: -2 })) === J(marche(p, EPL)) && J(marche(p, EPL, { total: NaN })) === J(marche(p, EPL)),
    'un total illisible (texte, negatif, NaN) : le chemin d avant');
}

console.log('\n-- 7. l ombre compte a part ; butsDe --');
{
  const p = duel(100);
  const k0 = compte(), o0 = ombre();
  const a = marche(p, EPL, { total: 3.0, ombre: true });
  const k1 = compte(), o1 = ombre();
  ok(o1.totalMarche - o0.totalMarche === 1 && J(k1) === J(k0), 'un calcul d ombre (mesure de cloture) compte dans etatButs().ombre, jamais dans depuisDemarrage');
  ok(J(a) === J(marche(p, EPL, { total: 3.0 })), 'et rend les memes lots que la vente');
  const T0 = Date.UTC(2026, 9, 12, 12);
  ok(c.butsDe({ butsMarche: { total: 2.9, t: new Date(T0 - 3600000).toISOString() } }, T0).total === 2.9, 'butsDe : un total frais');
  ok(c.butsDe({ butsMarche: { total: 0, t: new Date(T0).toISOString() } }, T0) === null && c.butsDe({ butsMarche: { total: 2.9, t: 'hier' } }, T0) === null
     && c.butsDe({}, T0) === null && c.butsDe({ butsMarche: { total: 2.9, t: new Date(T0 - 49 * 3600000).toISOString() } }, T0) === null,
     'butsDe : total nul, date illisible, absent ou plus de 48 h : null');
}

console.log('\n-- 8. butsMarche ne dit que le total qui a fait le prix (relecture du 10/10/2026) --');
{
  const T0 = Date.UTC(2026, 9, 12, 12);
  const base = (p, ligue, total, hAge) => ({ id: 'x', sport: 'foot', domicile: 'Arsenal', exterieur: 'Everton', debut: new Date(T0 + 30 * 3600000).toISOString(),
    cotesGenerees: true, source: { ligue, evenement: 'e1' }, prixMarche: { ref: 'betfair', t: new Date(T0).toISOString(), livres: 5, p },
    butsMarche: { total, t: new Date(T0 - (hAge || 1) * 3600000).toISOString(), ref: 'betfair', ligne: 2.5 } });
  const servi = c.habille(base(duel(100), EPL, 3.0), undefined, T0);
  ok(servi.butsMarche && servi.butsMarche.total === 3.0 && servi.butsMarche.grille === 3.0, `servi : butsMarche reste, avec le total de la grille (${J(servi.butsMarche)})`);
  const borne = c.habille(base({ 1: 0.40, N: 0.18, 2: 0.42 }, EPL, 6), undefined, T0);
  ok(borne.butsMarche && borne.butsMarche.total === 6 && borne.butsMarche.grille === 5, 'un total de 6 : butsMarche dit 6 au marche, 5 dans la grille (TOTAL_DU_MARCHE)');
  const ecarte = c.habille(base({ 1: 0.80, N: 0.10, 2: 0.10 }, SUPER_LIG, 1.6), undefined, T0);
  ok(!('butsMarche' in ecarte), 'la garde de coherence rend la rencontre au chemin d avant : butsMarche est RETIRE (il n a pas fait le prix)');
  const vieux = c.habille(base(duel(100), EPL, 3.0, 49), undefined, T0);
  ok(!('butsMarche' in vieux), 'un total de 49 h n a pas servi : butsMarche est retire');
  const sans = Object.assign({}, base(duel(100), EPL, 3.0)); delete sans.butsMarche;
  ok(!('butsMarche' in c.habille(sans, undefined, T0)), 'sans butsMarche en entree (le defaut) : rien n est ajoute');
  /* le chemin Elo : sous `garde` (lot releve), les marches deja ecrits recouvrent les neufs */
  const releve = { id: 'y', sport: 'foot', domicile: 'Arsenal', exterieur: 'Everton', debut: new Date(T0 + 30 * 3600000).toISOString(),
    cotesGenerees: false, cotes: { 1: 1.9, N: 3.6, 2: 4.2 }, source: { ligue: EPL, evenement: 'e2' },
    butsMarche: { total: 3.0, t: new Date(T0 - 3600000).toISOString(), ref: 'betfair', ligne: 2.5 } };
  ok(!('butsMarche' in c.habille(releve, undefined, T0)), 'un lot releve (garde) ne dit pas qu un total du marche a fait son prix');
  /* le retour de derives */
  const x = { total: 3.0 };
  marche(duel(100), EPL, x);
  const y = { total: 1.6 };
  marche({ 1: 0.80, N: 0.10, 2: 0.10 }, SUPER_LIG, y);
  ok(x.servi === true && x.grille === 3.0 && y.servi === false && y.ecarte === true && Math.abs(y.ecartNul) > c.ECART_NUL_GARDE,
    'derives dit dans `extra` si le total a servi (servi, grille) ou a ete ecarte (ecarte, ecartNul)');
}

console.log('\n-- 9. PARIS_TOTAUX_AGE_MAX_H echoue ferme ; les cles des totaux --');
{
  const pl = require('./prix_ligues');
  const T0 = Date.UTC(2026, 9, 12, 12);
  const age = (v) => { if (v === undefined) delete process.env.PARIS_TOTAUX_AGE_MAX_H; else process.env.PARIS_TOTAUX_AGE_MAX_H = v; return pl.totauxAgeMaxH(); };
  ok(age(undefined) === 48 && age('') === 48 && age('  ') === 48 && age('abc') === 48, 'absente, vide ou illisible : 48 h (Number(\'\') vaut 0, ce n est pas un « 0 » ecrit)');
  ok(age('0') === 0 && age('-5') === 0, '« 0 » ou negatif : 0 h, AUCUN total servi (avant : 48, la valeur la plus permissive)');
  ok(age('0.5') === 0.5 && age('24') === 24 && age('200') === 48, '« 0.5 » : 0,5 h (plus strict, permis) ; 24 : 24 ; 200 : ramene a 48');
  process.env.PARIS_TOTAUX_AGE_MAX_H = '0';
  ok(c.butsDe({ butsMarche: { total: 2.9, t: new Date(T0).toISOString() } }, T0) === null
     && c.butsDe({ butsMarche: { total: 2.9, t: new Date(T0 - 60000).toISOString() } }, T0) === null, 'a 0 h, butsDe ne sert rien, meme un total de cet instant');
  delete process.env.PARIS_TOTAUX_AGE_MAX_H;
  process.env.PARIS_TOTAUX_LIGUES = 'basketball_nba,soccer_*';
  ok(pl.totalVendu('basketball_nba') === false && pl.totalVendu('soccer_*') === false && pl.totauxARelever().size === 0 && pl.totauxRefusees().length === 2,
    'une cle hors football ou un joker : jamais vendue, jamais relevee, et les deux sont dites (totauxRefusees)');
  process.env.PARIS_TOTAUX_LIGUES = 'soccer_epl'; process.env.PARIS_TOTAUX_OBSERVE = 'soccer_epl';
  ok(pl.totalVendu('soccer_epl') === true && pl.totalObserve('soccer_epl') === false, 'une cle vendue n est pas dite observee');
  delete process.env.PARIS_TOTAUX_LIGUES; delete process.env.PARIS_TOTAUX_OBSERVE;
}

console.log('\n-- 10. les garde-fous que la mutation laissait passer (cotes) --');
{
  ok([-0.5, -1.5, NaN, 'x'].every((L) => c.totalDuMarche(0.5, L) === null), 'totalDuMarche : une ligne negative ou illisible rend null');
  /* BAS : une rencontre ou un total de 1,5 tient SOUS la garde — un total
     illisible ramene a 1,5 y serait vendu sans un mot */
  const BAS = { 1: 0.15, N: 0.43, 2: 0.42 };
  const k0 = compte();
  const ref = J(marche(BAS, EPL));
  ok(J(marche(BAS, EPL, { total: 'x' })) === ref && J(marche(BAS, EPL, { total: -2 })) === ref && J(marche(BAS, EPL, { total: NaN })) === ref,
    'BAS : un total illisible (texte, negatif, NaN) rend le chemin d avant, pas une grille a 1,5');
  const k1 = compte();
  ok(k1.totalMarche === k0.totalMarche && k1.totalMarcheEcarte === k0.totalMarcheEcarte, 'et aucun compteur du total du marche ne bouge');
  /* une ombre ECARTEE (gros favori), sur un championnat connu puis inconnu :
     rien dans depuisDemarrage, tout dans ombre */
  const F2 = { 1: 0.80, N: 0.10, 2: 0.10 };
  const d0 = compte(), o0 = ombre();
  marche(F2, SUPER_LIG, { total: 1.6, ombre: true });
  marche(F2, 'soccer_inconnue_xx', { total: 1.6, ombre: true });
  const d1 = compte(), o1 = ombre();
  ok(J(d1) === J(d0), 'une ombre ecartee par la garde (championnat connu ou non) : depuisDemarrage ne bouge pas');
  ok(o1.totalMarcheEcarte - o0.totalMarcheEcarte === 2 && o1.marche - o0.marche === 2 && o1.ligueInconnue - o0.ligueInconnue === 1,
    `et l ombre le compte a part (ecartees +${o1.totalMarcheEcarte - o0.totalMarcheEcarte}, marche +${o1.marche - o0.marche}, inconnue +${o1.ligueInconnue - o0.ligueInconnue})`);
}

fs.rmSync(DIR, { recursive: true, force: true });
console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
if (rates) process.exitCode = 1;
