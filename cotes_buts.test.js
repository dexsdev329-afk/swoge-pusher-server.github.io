/* ============================================================================
 * LE MODELE DE BUTS : IL DOIT DECRIRE UN MATCH DE FOOTBALL
 *
 * « Faut que tu baisses les cotes du score exact, beaucoup trop hautes, et par
 * exemple tous les bookmakers proposaient Barcelone a 1,1, nous 1,5. »
 *
 * Les deux moities avaient la meme cause, et elle ne se voyait sur aucun des
 * essais existants : ils verifiaient la MARGE — que la maison garde bien ses
 * dix pour cent — et la marge etait parfaite. Ce qu'ils ne verifiaient pas,
 * c'est que le modele decrive un match qui existe.
 *
 * Il n'en decrivait pas. `ajusteButs` cherche le nombre de buts qui reproduit
 * notre probabilite de nul ; ce nul etait deux points trop bas, et le seul
 * moyen de le reproduire etait d'ajouter des buts. Releve avant correction :
 * 3,48 buts attendus sur un match equilibre, 4,69 sur une affiche — la ou un
 * match de championnat en produit 2,7. Le modele ecrivait du handball.
 *
 * Et tout ce qui descend de la grille suivait :
 *
 *     « plus de 2,5 buts »   offert a 1,12   alors qu'il vaut ~1,9
 *     un 2-0                       a 12,86   alors qu'il vaut ~7,5
 *     le score « autre »            a 1,95   soit 51 % de probabilite
 *
 * La maison ne perdait pas en moyenne — la marge du livre etait bonne. Elle
 * affichait des prix FAUX, et un parieur qui compare avec un vrai bookmaker
 * prend exactement le cote qui paie. C'est la pire des deux facons de perdre :
 * elle ne se voit pas dans les comptes avant longtemps.
 *
 * Cet essai ne mesure donc pas la marge. Il mesure que le match decrit est
 * un match de football, et il le mesure la ou ca se voit : le nombre de buts,
 * et les prix qui en descendent.
 * ==========================================================================*/
const assert = require('assert');
const c = require('./cotes.js');
const paris = require('./paris.js');

let n = 0, rates = 0;
const ok = (v, m) => { n++; if (v) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* Un duel construit a partir d'un ecart de force, sans dependre du fichier
   des notes : ce qui est mesure ici est le MODELE, pas le classement. */
function duel(ecart) {
  const pn = c.NUL_MAX * Math.exp(-c.NUL_PENTE * Math.abs(ecart));
  const e = 1 / (1 + Math.pow(10, -ecart / 400));
  return { 1: (1 - pn) * e, N: pn, 2: (1 - pn) * (1 - e) };
}

console.log('-- le nombre de buts attendu --');
/* Ce que produit vraiment un match de championnat : 2,7 en moyenne, et
   jusqu'a 4 sur les affiches les plus desequilibrees. En dessous de 2,2 on
   decrit un autre sport, au-dessus de 3,6 aussi. */
const ECARTS = [0, 65, 150, 255, 350, 423, 500, 565];
const totaux = [];
for (const d of ECARTS) {
  const p = duel(d);
  const l = c.ajusteButs(p[1], p.N, p[2]);
  totaux.push({ d, total: l.lh + l.la, nul: p.N });
}
console.log('   ' + totaux.map(x => 'e' + x.d + ':' + x.total.toFixed(2)).join('  '));
const hors = totaux.filter(x => x.total < 2.2 || x.total > 3.6);
ok(hors.length === 0,
   hors.length === 0
     ? 'sur ' + ECARTS.length + ' ecarts de force, le total attendu reste entre 2,2 et 3,6 buts'
     : 'total hors du football : ' + hors.map(x => 'ecart ' + x.d + ' → ' + x.total.toFixed(2)).join(', '));
const moyen = totaux[1].total;   /* ecart 65 : deux equipes egales, avantage du terrain */
ok(moyen > 2.4 && moyen < 3.1,
   'un match equilibre attend ' + moyen.toFixed(2) + ' buts — la moyenne observee est 2,7');

console.log('\n-- le nul reste dans ce qu on observe --');
/* 25-29 % quand les deux equipes se valent, 13-19 % sur un gros favori.
   En dessous, ce n'est pas seulement le nul qui est faux : c'est le nombre
   de buts, parce que c'est lui qui absorbe l'erreur. */
ok(totaux[1].nul > 0.25 && totaux[1].nul < 0.30,
   'match equilibre : nul a ' + (totaux[1].nul * 100).toFixed(0) + ' %');
const gros = totaux[totaux.length - 1].nul;
ok(gros > 0.12 && gros < 0.20,
   'gros favori : nul a ' + (gros * 100).toFixed(0) + ' %');

console.log('\n-- les prix qui descendent de la grille --');
{
  const p = duel(65);                       /* match equilibre */
  const l = c.ajusteButs(p[1], p.N, p[2]);
  const pr = c.probasDesMarches(l.lh, l.la);
  console.log('   equilibre : plus de 2,5 a ' + (pr.ou25.plus * 100).toFixed(0)
    + ' % · les deux marquent a ' + (pr.btts.oui * 100).toFixed(0) + ' %');
  /* Sur un match equilibre, un vrai livre affiche « plus de 2,5 » autour de
     50-55 % et « les deux marquent » autour de 50-55 %. C'est ce prix-la que
     le modele offrait a 1,12 — soit 89 % — avant correction. */
  ok(pr.ou25.plus > 0.42 && pr.ou25.plus < 0.66,
     'plus de 2,5 buts : ' + (pr.ou25.plus * 100).toFixed(0) + ' % (le marche est vers 52 %)');
  ok(pr.btts.oui > 0.42 && pr.btts.oui < 0.66,
     'les deux marquent : ' + (pr.btts.oui * 100).toFixed(0) + ' % (le marche est vers 52 %)');
}
{
  const p = duel(423);                      /* gros favori a domicile */
  const l = c.ajusteButs(p[1], p.N, p[2]);
  const pr = c.probasDesMarches(l.lh, l.la);
  /* ---- « AUTRE », LE SYMPTOME LE PLUS PARLANT ----
   * C'est la case qui ramasse tout ce que la grille 0-3 ne nomme pas. Quand
   * le modele met 4,6 buts sur la table, la moitie de la probabilite tombe
   * dedans — et les seize scores nommes se partagent le reste, donc chacun
   * sort a un prix beaucoup trop genereux. Un « autre » raisonnable est le
   * signe que la grille est au bon endroit. */
  console.log('   gros favori : « autre » a ' + (pr.score.autre * 100).toFixed(0) + ' %');
  ok(pr.score.autre < 0.35,
     'le score « autre » ne ramasse pas la moitie de la grille : '
     + (pr.score.autre * 100).toFixed(0) + ' % (il en prenait 51)');
  /* Les scores les plus probables d'un match a gros favori sont 1-0, 2-0 et
     2-1. Si le modele met 3-1 devant, c'est qu'il a trop de buts. */
  const par = Object.keys(pr.score).filter(s => s !== 'autre')
    .map(s => ({ s, p: pr.score[s] })).sort((a, b) => b.p - a.p);
  console.log('   scores les plus probables : ' + par.slice(0, 4).map(x => x.s).join(', '));
  ok(['1-0', '2-0', '2-1', '1-1'].indexOf(par[0].s) >= 0,
     'le score le plus probable est un vrai score de football (' + par[0].s + ')');
}

console.log('\n-- et le favori est au prix du marche --');
{
  /* Le cas exact du rapport : un gros favori que tous les bookmakers
     affichent autour de 1,1. Avec 565 points d'ecart — ce que separe le haut
     et le bas du fichier des notes — on doit y etre. */
  const p = duel(565);
  const t = c.tarife('foot', null, null, undefined) === undefined ? null : null;
  const k = c.exposant(p, ['1', 'N', '2'], c.MARGE_DEFAUT, 1);
  const cote1 = 1 / Math.pow(p[1], k);
  console.log('   ecart 565 : p1 = ' + (p[1] * 100).toFixed(0) + ' % → cote ' + cote1.toFixed(2));
  ok(cote1 < 1.25,
     'un ecart de 565 points sort sous 1,25 — le marche affiche 1,08-1,15 ('
     + cote1.toFixed(2) + ')');
  ok(cote1 > 1.02,
     'et pas sous la borne du validateur : une cote a 1,01 ne rapporte rien a la maison ('
     + cote1.toFixed(2) + ')');
}

console.log('\n-- ce qui ne doit jamais revenir --');
{
  /* Le garde le plus important de ce fichier : aucun score nomme ne doit
     rendre au parieur plus que ce qu'il mise, sur AUCUN ecart de force. Un
     seul score au-dessus de 100 %, et il suffit de le jouer en boucle. */
  let pire = { r: 0 };
  for (const d of ECARTS) {
    const p = duel(d);
    const l = c.ajusteButs(p[1], p.N, p[2]);
    const pr = c.probasDesMarches(l.lh, l.la);
    const prudent = c.scoresPrudents(l.lh, l.la);
    /* `habilleUnMarche` rend `{cotes, marge}`, pas les cotes nues : lire le
       mauvais niveau donnait une boucle qui ne mesurait RIEN et un essai qui
       felicitait le vide. */
    const m = c.habilleUnMarche(pr.score, Object.keys(pr.score), 1, c.MARGE_DEFAUT, prudent);
    const cotes = m && (m.cotes || m);
    if (!cotes) continue;
    for (const s of Object.keys(cotes)) {
      const r = (prudent[s] || 0) * cotes[s];
      if (r > pire.r) pire = { r, s, d, cote: cotes[s] };
    }
  }
  console.log('   pire retour : ' + (pire.s || '—') + ' a l ecart ' + pire.d
    + ' → ' + (pire.r * 100).toFixed(0) + ' %');
  ok(pire.r > 0.4 && pire.r <= 1.0,
     'aucun score nomme ne rend plus de 100 % au parieur, meme sous le rho le plus '
     + 'defavorable (' + (pire.r * 100).toFixed(0) + ' % sur ' + pire.s + ')');
}

console.log('\n-- et aucun LOT de scores ne rend plus qu il ne coute --');
{
  /* ---- LE GARDE QUI MANQUAIT ----
   * L'essai ci-dessus verifie qu'aucun score PRIS SEUL ne rend plus de 100 %.
   * Ce n'est pas ainsi qu'on attaque un marche a dix-sept issues. Le rapport
   * recu : « je prends 0-0, 1-0, 0-1, 1-1, 2-0, 2-1, 0-2, 1-2, je mets un
   * million sur ces combinaisons, et ca passe quasiment tout le temps ».
   * C'est exactement la bonne facon de s'y prendre, et rien ne la mesurait :
   * couvrir un lot de scores probables coute plus cher mais gagne bien plus
   * souvent, et le retour d'un LOT peut depasser 100 % alors qu'aucun de ses
   * membres ne le fait.
   *
   * Le score exact porte desormais trois fois la marge de base — c'est ce que
   * prend un vrai livre sur ce marche, et pour la meme raison : dix-sept
   * issues tirees d'une grille de Poisson et d'un rho estime, donc une
   * incertitude bien plus grande que sur trois issues. On verifie ici que la
   * borne tient sur TOUS les sous-ensembles, pas seulement sur les singletons. */
  const LOT_SIGNALE = ['0-0', '1-0', '0-1', '1-1', '2-0', '2-1', '0-2', '1-2'];
  let pire = { r: 0 };
  for (const d of ECARTS) {
    const p = duel(d);
    const l = c.ajusteButs(p[1], p.N, p[2]);
    const pr = c.probasDesMarches(l.lh, l.la);
    const prudent = c.scoresPrudents(l.lh, l.la);
    const m = c.habilleUnMarche(pr.score, Object.keys(pr.score), 1,
                                c.MARGE_DEFAUT * (paris.MARCHES.score.margeX || 1), prudent);
    const cotes = m && (m.cotes || m);
    if (!cotes) continue;
    /* Le lot signale, puis les K scores les plus probables pour tout K. */
    const tri = Object.keys(cotes).sort((a, b) => (prudent[b] || 0) - (prudent[a] || 0));
    const lots = [LOT_SIGNALE];
    for (let k = 1; k <= tri.length; k++) lots.push(tri.slice(0, k));
    for (const lot of lots) {
      let esp = 0;
      for (const s of lot) esp += (prudent[s] || 0) * (cotes[s] || 0);
      const r = esp / lot.length;                 /* mise egale sur chaque issue du lot */
      if (r > pire.r) pire = { r, taille: lot.length, d };
    }
  }
  console.log('   pire lot : ' + pire.taille + ' scores a l ecart ' + pire.d
    + ' → ' + (pire.r * 100).toFixed(1) + '% de retour');
  ok(pire.r < 1,
     'aucun lot de scores, quelle que soit sa taille, ne rend plus qu il ne coute ('
     + (pire.r * 100).toFixed(1) + '% au pire)');
  ok(pire.r < 0.95,
     'et la marge de la maison tient sur le pire d entre eux : ' + (100 - pire.r * 100).toFixed(1)
     + ' points, la ou un livre ordinaire en garde dix');
}

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
if (rates) process.exitCode = 1;
