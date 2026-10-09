'use strict';
/* ============================================================================
 * LE TOTAL DE BUTS DU CHAMPIONNAT, ET RHO POUR LE NUL (09/10/2026)
 *
 * `ajusteButs` tirait le total de buts du seul nul du 1-N-2. Le nul de l'Elo
 * ne connait pas le championnat : ~2,8 buts en Liga 2 comme aux Pays-Bas,
 * quand le reel va de 2,27 a 3,11. Tout ce qui descend de la grille suivait :
 * le 1-0 a ~7,9 % au lieu de 14,1 % en Liga 2, mise a chaque match a sa cote
 * +37 +-12 % au parieur (3 400 matchs) ; le plus/moins 2,5 a 52,5-55 % de
 * « plus » partout.
 *
 * Desormais le TOTAL vient du championnat (`paris_buts.json`), la part du
 * domicile et rho du 1-N-2 vendu. Ce fichier verifie, sur leur INTENTION :
 *   0. ce que l'ancien modele faisait mal (ces lignes TOMBENT sur le code
 *      d'avant le 09/10/2026 : c'est voulu, elles disent ce qui a change) ;
 *   1. la grille reproduit le 1-N-2 vendu ; la double chance le suit ;
 *   2. le nul hors d'atteinte : au marche le total cede, a l'Elo l'ecart est
 *      dit ; jamais une case negative ;
 *   3. le total suit le championnat et le desequilibre, par les deux chemins
 *      d'`habille` ;
 *   4. sans table, sans championnat, ou PARIS_BUTS_LIGUE=0 : rien ne change ;
 *   5. le rabot du score exact couvre le rho de la grille ;
 *   6. la regle se lit en direct (etatButs) ;
 *   7. la table du depot est saine et pas oubliee ;
 *   8. le calcul de la table ne lit pas le futur et n'ecrit rien de partiel.
 * Mesures : EXPLOITATION.md 8.8ter (banc du 09/10, football-data 2018/19-2026/27).
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');

/* les forces de l'essai vivent dans un dossier jetable, jamais sur le volume */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'buts-'));
process.env.DATA_DIR = DIR;
delete process.env.PARIS_BUTS_LIGUE;
const paris = require('./paris');
const c = require('./cotes');
let BL = null;
try { BL = require('./outils/buts_ligue'); } catch (e) { /* absent sur le code d'avant */ }

let n = 0, rates = 0;
const ok = (v, m) => { n++; if (v) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
/* une verification qui leve est une verification ratee, pas un essai casse */
const essai = (m, f) => { try { const r = f(); if (Array.isArray(r)) ok(r[0], m + (r[1] ? ' — ' + r[1] : '')); else ok(!!r, m); } catch (e) { ok(false, `${m} — exception : ${e.message}`); } };

/* Un duel construit a partir d'un ecart de force, comme cotes_buts.test.js :
   ce qui est mesure est le MODELE, pas le classement. */
function duel(ecart) {
  const pn = c.NUL_MAX * Math.exp(-c.NUL_PENTE * Math.abs(ecart));
  const e = 1 / (1 + Math.pow(10, -ecart / 400));
  return { 1: (1 - pn) * e, N: pn, 2: (1 - pn) * (1 - e) };
}
const ECARTS = [-300, -100, 0, 65, 150, 255, 350, 423, 500, 565];
const TOTAUX = [2.2, 2.5, 2.8, 3.1, 3.4];
const SP2 = 'soccer_spain_segunda_division', N1 = 'soccer_netherlands_eredivisie';
const elo = (ligue) => ({ ligue, chemin: 'elo' });
const marche = (ligue) => ({ ligue, chemin: 'marche' });
const issues = (s) => c.issuesDeLaGrille(c.grilleDesScores(s.lh, s.la, s.rho));

/* Une table d'essai, ecrite a cote : l'essai ne depend pas des chiffres du
   jour dans paris_buts.json. Liga 2 a 2,30 : ce qu'elle marque sur les matchs
   equilibres de 2018/19-2026/27 (2,27, 1 819 matchs). */
const TABLE = path.join(DIR, 'paris_buts.json');
fs.writeFileSync(TABLE, JSON.stringify({
  calcule: '2026-10-09', jusqua: '2026-10-05', pente: 1.44, compressionElo: 0.805, poidsMarche: 0.75,
  global: { a: 2.66, b: 0.17 },
  ligues: { [SP2]: { a: 2.30, b: 0.10, n: 462 }, [N1]: { a: 3.00, b: 0.13, n: 297 } },
}));
if (c.chargeButs) c.chargeButs(TABLE);

console.log('-- 0. ce que l ancien modele faisait mal (tombe sur le code d avant) --');
essai('meme 1-N-2 a l Elo, la Liga 2 et l Eredivisie n ont plus le meme « plus de 2,5 »', () => {
  const p = duel(65);
  const a = c.derives('foot', p, undefined, {}, undefined, elo(SP2)).ou25.cotes.plus;
  const b = c.derives('foot', p, undefined, {}, undefined, elo(N1)).ou25.cotes.plus;
  return [a > b + 0.15, `Liga 2 ${a}, Eredivisie ${b}`];
});
essai('match equilibre de Liga 2 : la grille donne au 1-0 au moins 11 % (frequence mesuree 12,6 +-1,5 %, 1 819 matchs ; ajusteButs : 8,2 %)', () => {
  const p = duel(65);
  const s = c.ajusteRho(p[1], p.N, p[2], c.totalDe(SP2, p, 'elo'));
  const un0 = c.probasDesMarches(s.lh, s.la, s.rho).score['1-0'];
  return [un0 >= 0.11, `${(100 * un0).toFixed(1)} %`];
});
essai('au prix du marche, un favori a 80 % avec 13 % de nul : la grille rend le 1-N-2 vendu a 1e-6 (ajusteButs : jusqu a 5,8 points, total colle a 3,6)', () => {
  const p = { 1: 0.80, N: 0.13, 2: 0.07 };
  const s = c.ajusteRho(p[1], p.N, p[2], c.totalDe(SP2, p, 'marche'), undefined, undefined, { cede: true });
  const q = issues(s);
  const e = Math.max(Math.abs(q[1] - p[1]), Math.abs(q.N - p.N), Math.abs(q[2] - p[2]));
  return [e < 1e-6, `ecart ${e.toExponential(1)}, total ${s.total.toFixed(2)}`];
});
essai('habille lit m.source.ligue sur le chemin du marche (« plus de 2,5 » plus long en Liga 2 qu en Eredivisie)', () => {
  const demain = new Date(Date.now() + 86400000).toISOString();
  const base = { sport: 'foot', domicile: 'A', exterieur: 'B', debut: demain, prixMarche: { p: { 1: 0.45, N: 0.28, 2: 0.27 } } };
  const a = c.habille(Object.assign({ source: { ligue: SP2 } }, base)).marches.ou25.cotes.plus;
  const b = c.habille(Object.assign({ source: { ligue: N1 } }, base)).marches.ou25.cotes.plus;
  return [a > b, `Liga 2 ${a}, Eredivisie ${b} (au marche, le niveau du championnat pese un quart : voir totalDe)`];
});

console.log('\n-- 1. la grille reproduit le 1-N-2 vendu, la double chance le suit --');
essai('Elo : quand le nul est atteignable, les trois issues a 1e-9 pres ; hors d atteinte seulement les gros favoris (423 points et plus), ecart sous 4 points', () => {
  let pire = 0, atteints = 0, total = 0, pireEcart = 0;
  const hors = [];
  for (const cle of [SP2, N1]) for (const d of ECARTS) {
    const p = duel(d);
    const s = c.ajusteRho(p[1], p.N, p[2], c.totalDe(cle, p, 'elo'));
    total++;
    if (!s.nulAtteint) { hors.push(`${cle.split('_').pop()} ${d}`); pireEcart = Math.max(pireEcart, Math.abs(s.ecartNul)); if (d < 423) return [false, 'hors d atteinte a ' + d]; continue; }
    atteints++;
    const q = issues(s);
    pire = Math.max(pire, Math.abs(q[1] - p[1]), Math.abs(q.N - p.N), Math.abs(q[2] - p[2]));
  }
  return [pire < 1e-9 && pireEcart < 0.04, `${atteints}/${total} atteints a ${pire.toExponential(1)} ; hors : ${hors.join(', ') || 'aucun'}, ${(100 * pireEcart).toFixed(1)} pt au plus`];
});
essai('marche : le total cede, la grille rend les trois issues a 1e-6 sur toute une gamme de 1-N-2 (nul de 6 a 34 %, favori de 30 a 88 %)', () => {
  let pire = 0, m = 0, cedes = 0;
  for (let pn = 0.06; pn <= 0.34; pn += 0.02) for (let e = 0.30; e <= 0.88; e += 0.04) {
    if ((1 - pn) * e > 0.93) continue;
    const p = { 1: (1 - pn) * e, N: pn, 2: (1 - pn) * (1 - e) };
    const s = c.ajusteRho(p[1], p.N, p[2], c.totalDe(SP2, p, 'marche'), undefined, undefined, { cede: true });
    if (!s.nulAtteint) continue;
    if (s.cede) cedes++;
    m++;
    const q = issues(s);
    pire = Math.max(pire, Math.abs(q[1] - p[1]), Math.abs(q.N - p.N), Math.abs(q[2] - p[2]));
  }
  return [m > 100 && pire < 1e-6 && cedes > 0, `${m} lots, ${cedes} ou le total cede, ecart max ${pire.toExponential(1)}`];
});
essai('la double chance de l Elo est cotee sur le 1-N-2 vendu : identique a celle d avant sur 1 801 ecarts de -900 a +900', () => {
  let diff = 0, compares = 0;
  for (let d = -900; d <= 900; d++) {
    const p = duel(d);
    const avant = c.derives('foot', p, undefined, {});
    const apres = c.derives('foot', p, undefined, {}, undefined, elo(N1));
    if (!avant.dc && !apres.dc) continue;
    compares++;
    if (JSON.stringify(avant.dc) !== JSON.stringify(apres.dc)) diff++;
  }
  return [diff === 0 && compares > 1000, `${compares} lots compares, ${diff} differents`];
});
essai('aucune double chance ne s arbitre contre le 1-N-2 vendu (Elo, deux championnats, dix ecarts)', () => {
  let pire = Infinity;
  for (const cle of [SP2, N1]) for (const d of ECARTS) {
    const p = duel(d);
    const base = c.habilleUnMarche(p, ['1', 'N', '2'], 1, c.MARGE_DEFAUT).cotes;
    const dc = c.derives('foot', p, undefined, {}, undefined, elo(cle)).dc;
    if (!dc) continue;
    pire = Math.min(pire, 1 / base[1] + 1 / dc.cotes.X2, 1 / base.N + 1 / dc.cotes[12], 1 / base[2] + 1 / dc.cotes['1X']);
  }
  return [pire > 1, `plus petite somme des inverses ${pire.toFixed(4)}`];
});
essai('les cinq marches derives sont la, et le total demande est tenu (borne a 4,5) quand le nul est atteint', () => {
  const p = duel(150);
  const lot = c.derives('foot', p, undefined, {}, undefined, elo(SP2));
  const T = c.totalDe(SP2, p, 'elo');
  const s = c.ajusteRho(p[1], p.N, p[2], T);
  return [!!(lot.dc && lot.ou25 && lot.btts && lot.score && lot.hand) && Math.abs(s.lh + s.la - Math.min(4.5, T)) < 1e-9, `total ${T.toFixed(2)}`];
});

console.log('\n-- 2. le nul hors d atteinte --');
essai('Elo : un match equilibre a 3,4 buts avec 34 % de nul — rho reste a sa borne, rapport 1/2 exact, ecart DIT', () => {
  const p = { 1: 0.33, N: 0.34, 2: 0.33 };
  const s = c.ajusteRho(p[1], p.N, p[2], 3.4);
  const q = issues(s);
  return [!s.nulAtteint && s.rho === c.RHO_BORNES[0] && Math.abs(q[1] / (q[1] + q[2]) - 0.5) < 1e-9 && Math.abs(s.ecartNul - (q.N - p.N)) < 1e-12 && s.total === 3.4,
    `rho ${s.rho}, ecart ${(100 * s.ecartNul).toFixed(1)} points, total garde ${s.total}`];
});
essai('marche : le meme match — le total CEDE vers moins de buts et le nul est rendu', () => {
  const p = { 1: 0.33, N: 0.34, 2: 0.33 };
  const s = c.ajusteRho(p[1], p.N, p[2], 3.4, undefined, undefined, { cede: true });
  return [s.cede === 'moins' && s.total < 3.4 && s.nulAtteint && Math.abs(issues(s).N - 0.34) < 1e-6, `total 3,4 -> ${s.total.toFixed(2)}`];
});
essai('marche : un favori a 91 % avec 5,7 % de nul — le total cede vers PLUS de buts, borne a 4,5', () => {
  const p = { 1: 0.91, N: 0.057, 2: 0.033 };
  const s = c.ajusteRho(p[1], p.N, p[2], 3.0, undefined, undefined, { cede: true });
  return [s.cede === 'plus' && s.total > 3.0 && s.total <= 4.5 + 1e-12, `total 3,0 -> ${s.total.toFixed(2)}, nul ${s.nulAtteint ? 'rendu' : `manque de ${(100 * s.ecartNul).toFixed(1)} pt`}`];
});
essai('le chemin decide, dans derives : l Elo GARDE son total (gros favori d Eredivisie, nul de l Elo trop haut), le marche CEDE (favori a 91 %)', () => {
  const lotDe = (s, marge) => c.habilleUnMarche(c.probasDesMarches(s.lh, s.la, s.rho).ou25, ['plus', 'moins'], 1, marge).cotes;
  const pE = duel(565), pM = { 1: 0.91, N: 0.057, 2: 0.033 };
  const sE = c.ajusteRho(pE[1], pE.N, pE[2], c.totalDe(N1, pE, 'elo'), undefined, undefined, { cede: false });
  const sM = c.ajusteRho(pM[1], pM.N, pM[2], c.totalDe(SP2, pM, 'marche'), undefined, undefined, { cede: true });
  const e = c.derives('foot', pE, undefined, {}, undefined, elo(N1)).ou25.cotes;
  const m = c.derives('foot', pM, undefined, {}, undefined, marche(SP2)).ou25.cotes;
  return [!sE.nulAtteint && sE.cede === null && sM.cede === 'plus'
    && JSON.stringify(e) === JSON.stringify(lotDe(sE, c.MARGE_DEFAUT * paris.MARCHES.ou25.margeX))
    && JSON.stringify(m) === JSON.stringify(lotDe(sM, c.MARGE_DEFAUT * paris.MARCHES.ou25.margeX)),
    `Elo : total ${sE.total.toFixed(2)} garde, nul a ${(100 * sE.ecartNul).toFixed(1)} pt ; marche : ${sM.demande.toFixed(2)} -> ${sM.total.toFixed(2)}`];
});
essai('Elo : nul trop bas — rho s arrete a +0,10, l ecart est positif et dit', () => {
  const p = { 1: 0.45, N: 0.15, 2: 0.40 };
  const s = c.ajusteRho(p[1], p.N, p[2], 2.2);
  return [!s.nulAtteint && s.rho <= c.RHO_BORNES[1] + 1e-12 && s.ecartNul > 0, `rho ${s.rho.toFixed(3)}, ecart ${(100 * s.ecartNul).toFixed(1)} points`];
});
essai('balayage de 800 entrees, deux chemins : rho dans ses bornes, total dans [1,9 ; 4,5], les quatre facteurs de Dixon-Coles au-dessus de 0,1, aucune case negative', () => {
  let mauvais = 0;
  for (let k = 0; k < 400; k++) for (const cede of [false, true]) {
    const pn = 0.04 + 0.34 * ((k * 37) % 100) / 100, e = 0.02 + 0.96 * ((k * 61) % 100) / 100;
    const pp = { 1: (1 - pn) * e, N: pn, 2: (1 - pn) * (1 - e) };
    const r = c.ajusteRho(pp[1], pp.N, pp[2], 1.5 + 3.5 * ((k * 17) % 100) / 100, undefined, undefined, { cede });
    if (r.rho < c.RHO_BORNES[0] - 1e-12 || r.rho > c.RHO_BORNES[1] + 1e-12) mauvais++;
    if (r.total < 1.9 - 1e-12 || r.total > 4.5 + 1e-12) mauvais++;
    if (Math.min(1 + r.lh * r.rho, 1 + r.la * r.rho, 1 - r.lh * r.la * r.rho, 1 - r.rho) < 0.1 - 1e-9) mauvais++;
    for (const l of c.grilleDesScores(r.lh, r.la, r.rho)) for (const v of l) if (!(v >= 0)) mauvais++;
  }
  return [mauvais === 0, `${mauvais} entree(s) fautive(s)`];
});

console.log('\n-- 3. le total suit le championnat et le desequilibre --');
essai('meme 1-N-2 : moins de 2,5 buts en Liga 2, plus de 3 aux Pays-Bas ; un gros favori en fait plus', () => {
  const p = duel(65);
  const sp2 = c.totalDe(SP2, p, 'elo'), n1 = c.totalDe(N1, p, 'elo'), gros = c.totalDe(SP2, duel(500), 'elo');
  return [sp2 < 2.5 && n1 > 3.0 && gros > sp2 + 0.3, `${sp2.toFixed(2)} / ${n1.toFixed(2)} ; gros favori ${gros.toFixed(2)}`];
});
essai('au marche, un nul plus bas donne plus de buts', () => {
  const m1 = c.totalDe(SP2, { 1: 0.40, N: 0.33, 2: 0.27 }, 'marche'), m2 = c.totalDe(SP2, { 1: 0.44, N: 0.23, 2: 0.33 }, 'marche');
  return [m2 > m1, `${m1.toFixed(2)} -> ${m2.toFixed(2)}`];
});
essai('habille, chemin Elo : la rencontre prend le total de SON championnat, et les cotes sont celles de derives', () => {
  c.chargeNotes(path.join(DIR, 'notes_essai.json'));
  c.poseNote('foot', 'Alpha FC', 1620); c.poseNote('foot', 'Beta FC', 1560);
  const demain = new Date(Date.now() + 86400000).toISOString();
  const m = (ligue) => ({ sport: 'foot', domicile: 'Alpha FC', exterieur: 'Beta FC', debut: demain, source: { ligue } });
  const a = c.habille(m(SP2)).marches, b = c.habille(m(N1)).marches;
  const p = c.probabilites('foot', 'Alpha FC', 'Beta FC');
  const ref = c.derives('foot', p, undefined, {}, undefined, elo(SP2));
  return [a.ou25.cotes.plus > b.ou25.cotes.plus && JSON.stringify(a.ou25) === JSON.stringify(ref.ou25)
    && JSON.stringify(a['1n2']) === JSON.stringify(b['1n2']), `« plus » ${a.ou25.cotes.plus} en Liga 2, ${b.ou25.cotes.plus} en Eredivisie, 1-N-2 inchange`];
});
essai('habille, 1-N-2 releve chez un livre : ses marches derives prennent le chemin du marche', () => {
  const demain = new Date(Date.now() + 86400000).toISOString();
  const cotes = { 1: 2.10, N: 3.30, 2: 3.60 };
  const h = c.habille({ sport: 'foot', domicile: 'X', exterieur: 'Y', debut: demain, cotes, source: { ligue: SP2 } });
  const p = c.probasImplicites(cotes, ['1', 'N', '2'], 1);
  const ref = c.derives('foot', p, undefined, {}, undefined, marche(SP2));
  return [JSON.stringify(h.marches.ou25) === JSON.stringify(ref.ou25) && JSON.stringify(h.marches['1n2'].cotes) === JSON.stringify(cotes), `« plus » ${h.marches.ou25.cotes.plus}`];
});
essai('le 1-N-2 et la double chance du marche ne bougent pas avec le championnat', () => {
  const demain = new Date(Date.now() + 86400000).toISOString();
  const base = { sport: 'foot', domicile: 'A', exterieur: 'B', debut: demain, prixMarche: { p: { 1: 0.45, N: 0.28, 2: 0.27 } } };
  const avec = c.habille(Object.assign({ source: { ligue: SP2 } }, base)), sans = c.habille(base);
  return JSON.stringify(avec.marches['1n2']) === JSON.stringify(sans.marches['1n2']) && JSON.stringify(avec.marches.dc) === JSON.stringify(sans.marches.dc);
});
essai('un championnat que la table ne connait pas (Ligue des champions) prend le niveau commun — exactement', () => {
  const p = duel(65), t = c.totalDe('soccer_uefa_champs_league', p, 'marche');
  /* table d'essai : global a 2,66, b 0,17 ; pente 1,44 ; poids du marche 0,75 */
  const attendu = 0.75 * (c.ajusteButs(p[1], p.N, p[2]).total - 0.17) + 0.25 * (2.66 + 1.44 * Math.pow(p[1] - p[2], 2));
  return [Math.abs(t - attendu) < 1e-12, `${t.toFixed(4)} pour ${attendu.toFixed(4)}`];
});

console.log('\n-- 4. sans table, sans championnat, ou coupe : rien ne change --');
{
  const p = duel(150);
  const avant = () => JSON.stringify(c.derives('foot', p, undefined, {}));
  essai('sans championnat, les lots sont ceux d ajusteButs, a la cote pres', () => {
    const vide = JSON.stringify(c.derives('foot', p, undefined, {}, undefined, { ligue: undefined, chemin: 'elo' }));
    const aj = c.ajusteButs(p[1], p.N, p[2]);
    const m = c.habilleUnMarche(c.probasDesMarches(aj.lh, aj.la).ou25, ['plus', 'moins'], 1, c.MARGE_DEFAUT * (paris.MARCHES.ou25.margeX || 1));
    return avant() === vide && JSON.stringify(m.cotes) === JSON.stringify(JSON.parse(vide).ou25.cotes);
  });
  essai('PARIS_BUTS_LIGUE=0 : le retour arriere, sans commit — lots d avant meme avec un championnat', () => {
    process.env.PARIS_BUTS_LIGUE = '0';
    try {
      const coupe = JSON.stringify(c.derives('foot', p, undefined, {}, undefined, elo(SP2)));
      return [coupe === avant() && c.totalDe(SP2, p, 'elo') === null && c.etatButs().coupe === true, 'totalDe rend null'];
    } finally { delete process.env.PARIS_BUTS_LIGUE; }
  });
  /* Number(null) vaut 0 : une table aux champs nuls se vendait (relecture du 09/10). */
  essai('une table aux champs nuls (pente, niveau commun, niveau d une ligue) : lots d avant, jamais un total a 0', () => {
    const nulle = path.join(DIR, 'nulle.json'), ligueNulle = path.join(DIR, 'ligue_nulle.json');
    fs.writeFileSync(nulle, JSON.stringify({ calcule: '2026-10-09', pente: null, poidsMarche: 0.75, global: { a: null, b: 0.17 }, ligues: { [SP2]: { a: 2.3, b: 0.1 } } }));
    fs.writeFileSync(ligueNulle, JSON.stringify({ calcule: '2026-10-09', pente: 1.44, poidsMarche: 0.75, global: { a: 2.66, b: 0.17 }, ligues: { [SP2]: { a: null, b: null } } }));
    try {
      c.chargeButs(nulle);
      const a = c.totalDe(SP2, p, 'elo') === null && avant() === JSON.stringify(c.derives('foot', p, undefined, {}, undefined, elo(SP2)));
      c.chargeButs(ligueNulle);
      const b = c.totalDe(SP2, p, 'elo') === null && c.totalDe(SP2, p, 'marche') === null
        && avant() === JSON.stringify(c.derives('foot', p, undefined, {}, undefined, elo(SP2)));
      return [a && b, `pente nulle : ${a ? 'rejetee' : 'VENDUE'} ; niveau de ligue nul : ${b ? 'rejete' : 'VENDU'}`];
    } finally { c.chargeButs(TABLE); }
  });
  essai('une table absente : totalDe rend null, ajusteButs reprend, les lots sont ceux d avant', () => {
    c.chargeButs(path.join(DIR, 'absente.json'));
    try {
      return c.totalDe(SP2, p, 'elo') === null && avant() === JSON.stringify(c.derives('foot', p, undefined, {}, undefined, elo(SP2)))
        && c.etatButs().table === false;
    } finally { c.chargeButs(TABLE); }
  });
}

console.log('\n-- 5. le rabot du score exact couvre le rho de la grille --');
essai('la borne du rabot est au-dessus de la grille vendue case par case, jamais sous la plage d avant ; aucun score seul ni lot des K plus probables ne rend 100 % / 95 %', () => {
  /* Le rho ajuste peut sortir de la plage [0 ; -0,18] (Liga 2 : +0,02 de
     mediane a l'apprentissage, le nul de l'Elo y est trop bas). Le rabot doit
     borner la grille VENDUE, et rester au moins aussi prudent qu'avant. */
  let couvre = true, auMoins = true, pireLot = 0, pireSeul = 0;
  for (const d of ECARTS) for (const T of TOTAUX) for (const cede of [false, true]) {
    const p = duel(d);
    const s = c.ajusteRho(p[1], p.N, p[2], T, undefined, undefined, { cede });
    const pr = c.probasDesMarches(s.lh, s.la, s.rho);
    const prudent = c.scoresPrudents(s.lh, s.la, s.rho), plage = c.scoresPrudents(s.lh, s.la);
    for (const sc of paris.SCORES) {
      if (prudent[sc] < pr.score[sc] - 1e-12) couvre = false;
      if (prudent[sc] < plage[sc] - 1e-12) auMoins = false;
    }
    const m = c.habilleUnMarche(pr.score, paris.SCORES, 1, c.MARGE_DEFAUT * (paris.MARCHES.score.margeX || 1), prudent);
    if (!m) continue;
    const tri = paris.SCORES.slice().sort((a, b) => prudent[b] - prudent[a]);
    for (let k = 1; k <= tri.length; k++) {
      let esp = 0;
      for (const sc of tri.slice(0, k)) esp += prudent[sc] * m.cotes[sc];
      pireLot = Math.max(pireLot, esp / k);
    }
    for (const sc of paris.SCORES) pireSeul = Math.max(pireSeul, prudent[sc] * m.cotes[sc]);
  }
  return [couvre && auMoins && pireSeul <= 1.0 && pireLot < 0.95, `score seul ${(100 * pireSeul).toFixed(0)} %, lot ${(100 * pireLot).toFixed(1)} % au pire`];
});

essai('dans derives, chaque score VENDU tient le plancher par issue du rabot contre la grille VENDUE (cote x p x (1 + plancher) <= 1, au demi-centime d arrondi pres), meme quand rho sort de la plage [-0,18 ; 0]', () => {
  let pire = 0, horsPlage = 0, plancher = 0;
  for (const cle of [SP2, N1]) for (let d = -400; d <= 600; d += 50) for (const ch of ['elo', 'marche']) {
    const p = duel(d);
    const s = c.ajusteRho(p[1], p.N, p[2], c.totalDe(cle, p, ch), undefined, undefined, { cede: ch === 'marche' });
    if (s.rho < -0.18 || s.rho > 0) horsPlage++;
    const g = c.probasDesMarches(s.lh, s.la, s.rho).score;
    const lot = c.derives('foot', p, undefined, {}, undefined, { ligue: cle, chemin: ch }).score;
    if (!lot) continue;
    for (const sc of paris.SCORES) {
      pire = Math.max(pire, lot.cotes[sc] * g[sc]);
      /* le rabot arrondit au centime le plus proche : un demi-centime de tolerance, pas plus */
      if (lot.cotes[sc] > c.COTE_PLANCHER) plancher = Math.max(plancher, (lot.cotes[sc] - 0.005) * g[sc] * (1 + c.plancherDe(g[sc])));
    }
  }
  return [plancher <= 1 + 1e-9 && pire <= 0.95 && horsPlage > 5, `${horsPlage} grilles hors de la plage, pire retour ${(100 * pire).toFixed(1)} %, plancher tenu a ${plancher.toFixed(4)}`];
});

essai('dans derives, le score vendu est rabote contre la plage ET le rho de la grille (nul du marche a 18 % en Liga 2 : rho +0,10, le 1-0 raccourci d un ou deux centimes)', () => {
  let compares = 0, differents = 0, rhoHors = 0;
  for (let pn = 0.14; pn <= 0.22; pn += 0.02) for (let e = 0.15; e <= 0.85; e += 0.05) {
    const p = { 1: (1 - pn) * e, N: pn, 2: (1 - pn) * (1 - e) };
    const s = c.ajusteRho(p[1], p.N, p[2], c.totalDe(SP2, p, 'marche'), undefined, undefined, { cede: true });
    if (s.rho >= -0.18 && s.rho <= 0) continue;
    rhoHors++;
    const ref = c.habilleUnMarche(c.probasDesMarches(s.lh, s.la, s.rho).score, paris.SCORES, 1, c.MARGES_AU_MARCHE.score, c.scoresPrudents(s.lh, s.la, s.rho));
    const lot = c.derives('foot', p, undefined, {}, c.MARGES_AU_MARCHE, marche(SP2)).score;
    if (!ref || !lot) continue;
    compares++;
    if (JSON.stringify(ref.cotes) !== JSON.stringify(lot.cotes)) differents++;
  }
  return [rhoHors > 5 && compares === rhoHors && differents === 0, `${compares} lots a rho hors de [-0,18 ; 0], ${differents} differents du rabot attendu`];
});

console.log('\n-- 6. la regle se lit en direct --');
essai('etatButs compte ce que le modele a fait : rencontres par chemin, nul manque a l Elo, total cede au marche, championnat inconnu', () => {
  const e0 = c.etatButs().depuisDemarrage;
  c.derives('foot', duel(565), undefined, {}, undefined, elo(N1));                    // gros favori Elo : nul trop haut
  c.derives('foot', { 1: 0.91, N: 0.057, 2: 0.033 }, undefined, {}, undefined, marche(SP2)); // favori du marche a 5,7 % de nul : le total cede
  c.marchesDuMarche('foot', { 1: 0.45, N: 0.28, 2: 0.27 }, undefined, 'soccer_uefa_champs_league');
  const e = c.etatButs();
  const d = e.depuisDemarrage;
  return [d.elo > e0.elo && d.marche >= e0.marche + 2 && d.nulManque > e0.nulManque && d.totalCede > e0.totalCede
    && d.ligueInconnue > e0.ligueInconnue && e.calcule === '2026-10-09' && e.ageJours >= 0,
    `elo ${d.elo}, marche ${d.marche}, nul manque ${d.nulManque} (${(100 * d.ecartNulMax).toFixed(1)} pt au plus), total cede ${d.totalCede}, inconnu ${d.ligueInconnue}`];
});

console.log('\n-- 7. la table du depot --');
{
  let t = null;
  try { t = JSON.parse(fs.readFileSync(path.join(__dirname, 'paris_buts.json'), 'utf8')); } catch (e) { /* absente */ }
  essai('paris_buts.json lisible : les seize championnats importes en football (quatorze europeens, MLS, Liga MX)', () =>
    [!!t && Object.keys(t.ligues).length >= 16, `${t ? Object.keys(t.ligues).length : 0} championnats`]);
  /* ---- LE CHEMIN DE PRODUCTION, PAS SEULEMENT LE FICHIER ----
   * Railway construit depuis git (Dockerfile `COPY . .`) : un paris_buts.json
   * present ici mais jamais commite partirait absent, et tout le football
   * reviendrait a ajusteButs sans un mot (relecture du 09/10). chargeButs()
   * sans argument est ce que le serveur appelle. */
  essai('le serveur (chargeButs sans argument) lit paris_buts.json : au moins seize championnats', () => {
    let k = 0;
    try { const t2 = c.chargeButs(); k = t2.ligues ? Object.keys(t2.ligues).length : 0; } finally { c.chargeButs(TABLE); }
    return [k >= 16, `${k} championnats`];
  });
  essai('chaque championnat a un niveau et un biais plausibles, sur au moins 100 matchs', () => {
    const L = Object.entries(t.ligues);
    const sains = L.filter(([, x]) => isFinite(x.a) && isFinite(x.b) && x.n >= 100 && x.a > 1.8 && x.a < 3.6 && Math.abs(x.b) < 0.8);
    return [sains.length === L.length, `${sains.length}/${L.length}`];
  });
  /* ---- OUBLIEE, ELLE SE VOIT ICI ----
   * Banc du 09/10 (test, 15 986 rencontres, log-loss du score exact
   * contre ajusteButs) : fraiche -0,0138, 60 jours -0,0133, 400 jours -0,0120
   * +-0,0032 (4,5 % d'issues battables contre 10,1 %) — encore mieux qu'avant. L'age se lit chaque jour dans
   * etatImport().buts ; l'essai ne rougit qu'au-dela de 400 jours, pour ne
   * pas bloquer les commits des deux depots pour un ecart de 0,0005. */
  essai('table calculee il y a moins de 400 jours, sur des donnees de moins de 400 jours — sinon : node outils/buts_ligue.js, puis committer paris_buts.json', () => {
    const age = (d) => (Date.now() - Date.parse(d)) / 86400000;
    return [age(t.calcule) < 400 && age(t.jusqua) < 400, `calculee le ${t.calcule} (${Math.floor(age(t.calcule))} j), donnees jusqu au ${t.jusqua} (${Math.floor(age(t.jusqua))} j)`];
  });
}

console.log('\n-- 8. le calcul de la table ne lit pas le futur et n ecrit rien de partiel --');
{
  const J = 86400000, t0 = Date.UTC(2026, 0, 1);
  const L = [];
  for (let k = 0; k < 400; k++) L.push({ t: t0 + k * J, hg: 1, ag: 1, p: { 1: 0.45, N: 0.27, 2: 0.28 } });
  L.push({ t: t0 + 400 * J, hg: 9, ag: 9, p: { 1: 0.45, N: 0.27, 2: 0.28 } });
  essai('un match du jour meme n entre pas ; seuls les 365 derniers jours comptent', () => {
    const tab = BL.table(new Map([['X', L]]), t0 + 400 * J, BL.REGLAGE);
    return [Math.abs(tab.ligues.X.buts - 2) < 1e-12 && tab.ligues.X.n === 365, `${tab.ligues.X.n} matchs, ${tab.ligues.X.buts} buts`];
  });
  essai('une ligue sans match prend le niveau commun ; vingt matchs seulement : retreci vers lui', () => {
    const vide = BL.table(new Map([['X', L], ['Y', []]]), t0 + 400 * J, BL.REGLAGE);
    const peu = BL.table(new Map([['X', L], ['Y', L.slice(360, 380).map((m) => Object.assign({}, m, { hg: 3, ag: 3 }))]]), t0 + 400 * J, BL.REGLAGE);
    return vide.ligues.Y.a === vide.global.a && peu.ligues.Y.a < peu.ligues.Y.aBrut && peu.ligues.Y.a > peu.global.a;
  });
  /* Un CSV de football-data minimal : en-tete et cinq cents lignes recentes. */
  const csv = (jours) => {
    const lignes = ['Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,PSH,PSD,PSA'];
    for (let k = 0; k < jours; k++) {
      const d = new Date(Date.UTC(2026, 9, 1) - k * J);
      lignes.push(`X,${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()},15:00,A${k},B${k},${k % 3},${k % 2},2.10,3.30,3.60`);
    }
    return lignes.join('\n');
  };
  const csvNew = csv(500).replace('Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,PSH,PSD,PSA', 'Country,Date,Time,Home,Away,HG,AG,PSCH,PSCD,PSCA');
  const maintenant = Date.UTC(2026, 9, 9);
  const fichier = path.join(DIR, 'table_essai.json');
  const chaque = (url) => (/\/new\//.test(url) ? csvNew : csv(500));
  /* l'essai appelle `principal` et attend : les lignes suivantes sont asynchrones */
  const suite = (async () => {
    try {
      let refuse = null;
      try { await BL.principal({ telecharge: async (u) => { if (/SP2/.test(u)) throw new Error('HTTP 404'); return chaque(u); }, maintenant, fichier, cotes: c }); }
      catch (e) { refuse = e; }
      ok(refuse && /SP2/.test(refuse.message) && /PAS ecrit/.test(refuse.message) && !fs.existsSync(fichier),
         'un telechargement rate : rien n est ecrit, et l erreur dit lequel' + (refuse ? ` (${refuse.message.slice(0, 80)}...)` : ''));
      /* Un 200 qui n'est pas un CSV (page d'erreur, fichier vide) : un rate aussi (relecture du 09/10). */
      let html = null;
      try { await BL.principal({ telecharge: async (u) => (/SP2/.test(u) ? '<html><body>maintenance</body></html>' : chaque(u)), maintenant, fichier, cotes: c }); }
      catch (e) { html = e; }
      ok(html && /SP2/.test(html.message) && !fs.existsSync(fichier), 'une page qui n est pas un CSV : rien n est ecrit, et l erreur dit laquelle');
      const t = await BL.principal({ telecharge: async (u) => { if (/SP2/.test(u)) throw new Error('HTTP 404'); return chaque(u); }, maintenant, fichier, cotes: c, partiel: true });
      ok(fs.existsSync(fichier) && Array.isArray(t.partiel) && t.partiel.length >= 1, '--partiel : ecrit, et la table DIT ce qui manquait');
      fs.unlinkSync(fichier);
      const t2 = await BL.principal({ telecharge: async (u) => chaque(u), maintenant, fichier, cotes: c });
      const lu = JSON.parse(fs.readFileSync(fichier, 'utf8'));
      ok(!lu.partiel && lu.jusqua === '2026-10-01' && lu.calcule === '2026-10-09' && Object.keys(t2.ligues).length === 16,
        `tout lu : ${Object.keys(t2.ligues).length} championnats, calculee le ${lu.calcule}, donnees jusqu au ${lu.jusqua}`);
    } catch (e) { ok(false, 'le calcul de la table — exception : ' + e.message); }
  })();
  suite.then(fin);
}

function fin() {
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
  if (rates) process.exitCode = 1;
}
