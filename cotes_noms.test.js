'use strict';
/*
 * LES COTES ET LE NOM DES EQUIPES.
 *
 * ---- CE QUE CET ESSAI GARDE ----
 *
 * Un soir, tous les bookmakers donnaient Monaco a 2,2 et Marseille a 3. Nous
 * affichions Monaco a 5, et des joueurs ont mise dessus.
 *
 * Le modele n'y etait pour rien. Sur les vraies forces — Monaco 1820,
 * Marseille 1810 — il rend 2,02 / 3,68 / 3,00, ce qui colle au marche. Le
 * fournisseur, lui, ecrit « AS Monaco ». La clef cherchee etait
 * `foot:as monaco`, elle n'existait pas, et la force par defaut — 1500 —
 * prenait sa place SANS RIEN DIRE. Monaco valait soudain trois cent dix
 * points de moins que la verite, et la cote suivait.
 *
 * Un defaut silencieux est le pire de tous ici : il ne casse rien, il ne leve
 * rien, il fabrique un chiffre confiant et faux — et ce chiffre est de
 * l'argent.
 *
 * On mesure donc trois choses, et les trois comptent :
 *   1. que le nom du flux RETROUVE son equipe ;
 *   2. que la cote qui en sort est celle du marche, pas celle du defaut ;
 *   3. et que quand le nom ne se retrouve PAS, on REFUSE de coter au lieu
 *      d'inventer. C'est la seule protection qui vaille : la liste des
 *      orthographes ne sera jamais complete.
 */
const cotes = require('./cotes');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* ---- 1. LE SOIR EN QUESTION ---- */
console.log('\n-- Monaco - Marseille, tel que le flux l ecrit --');
{
  const r = cotes.noteDe('foot', 'AS Monaco');
  ok(r.connue && r.note === 1820,
     `« AS Monaco » retrouve sa force (${r.note}, par ${r.via}) — elle valait 1500`);
  const c = cotes.cotesDe('foot', 'AS Monaco', 'Marseille');
  console.log('   ' + JSON.stringify(c));
  /* Les vrais bookmakers ce soir-la : Monaco 2,2, Marseille 3. On ne demande
     pas au modele de les egaler — on lui demande de ne pas etre a l'autre
     bout du marche. */
  ok(c['1'] > 1.7 && c['1'] < 2.7,
     `Monaco sort a ${c['1']} — le marche disait 2,2, et nous affichions 5,04`);
  ok(c['2'] > 2.4 && c['2'] < 3.8,
     `et Marseille a ${c['2']} — le marche disait 3`);
  /* Le meme couple ecrit autrement doit donner le MEME prix. Deux
     orthographes qui cotent differemment, c'est une arbitrage offerte. */
  const c2 = cotes.cotesDe('foot', 'Monaco', 'Olympique de Marseille');
  ok(JSON.stringify(c) === JSON.stringify(c2),
     'et « Monaco v Olympique de Marseille » sort exactement au meme prix');
}

/* ---- 2. CE QU'ON REFUSE ---- */
console.log('\n-- une equipe qu on ne sait pas lire ne se cote pas --');
{
  let leve = null;
  try { cotes.cotesDe('foot', 'Equipe Qui N Existe Pas', 'Marseille'); }
  catch (e) { leve = e.message; }
  ok(leve && /force inconnue/.test(leve),
     'une equipe inconnue fait REFUSER la cote, elle ne vaut plus 1500 en silence');
  console.log('   ' + (leve || '(aucun refus)').slice(0, 120));

  /* ---- L AMBIGUITE AUSSI ----
   * Mesure sur les 163 equipes du fichier : raboter « real » et « atletico »
   * fait tomber `real madrid` et `atletico madrid` sur le meme nom. Deux clubs
   * de la meme ville, cent points d ecart. Deviner lequel serait le defaut
   * qu on repare, en pire — parce qu il paraitrait juste. */
  let amb = null;
  try { cotes.cotesDe('foot', 'Madrid', 'Barcelona'); } catch (e) { amb = e.message; }
  ok(amb && /inconnue/.test(amb),
     '« Madrid » tout court est REFUSE : deux clubs portent ce nom, et deviner coute de l argent');
  const r = cotes.noteDe('foot', 'Madrid');
  ok(!r.connue, `il n est pas resolu au hasard (${r.via})`);
  /* Et les deux vrais noms, eux, passent — et ne se confondent pas. */
  const rm = cotes.noteDe('foot', 'Real Madrid'), am = cotes.noteDe('foot', 'Atletico Madrid');
  ok(rm.connue && am.connue && rm.note !== am.note,
     `Real (${rm.note}) et Atletico (${am.note}) restent deux equipes differentes`);
}

/* ---- 3. LES ABREVIATIONS, ET RIEN QU ELLES ---- */
console.log('\n-- ce que la reduction a le droit d enlever --');
{
  const paires = [['AS Monaco', 'Monaco'], ['FC Nantes', 'Nantes'],
                  ['Toulouse FC', 'Toulouse'], ['RC Lens', 'Lens']];
  for (const [flux, vrai] of paires) {
    const a = cotes.noteDe('foot', flux), b = cotes.noteDe('foot', vrai);
    ok(a.connue && a.note === b.note, `« ${flux} » = « ${vrai} » (${a.note})`);
  }
  /* Le releve a montre cinq DOUBLONS dans le fichier — deux forces pour un
     seul club, qui divergent a chaque resultat. La regle les resout sans rien
     effacer : la forme reduite est elle-meme une clef, donc c est elle. */
  const g = cotes.noteDe('foot', 'FC Augsburg');
  ok(g.connue, `« FC Augsburg » se resout malgre le doublon du fichier (${g.note})`);
}

/* ---- 4. L AUDIT DU CATALOGUE ----
 * Il ne s agit pas de faire passer un essai : il s agit de SAVOIR. Le releve
 * du jour dit quelles rencontres du calendrier reel ne peuvent pas etre
 * cotees par le modele — leur 1-N-2 est releve a la main, il est bon, mais
 * leurs marches derives sortent d un modele qui ne connait pas les joueurs. */
console.log('\n-- ce que le calendrier du jour ne sait pas coter --');
{
  const cat = require('./paris_catalogue.json');
  const s = cotes.sansForce(cat);
  const par = {};
  for (const x of s) par[x.sport] = (par[x.sport] || 0) + 1;
  console.log('   ' + s.length + ' rencontre(s) sur ' + (cat.matchs || []).length
              + ' : ' + JSON.stringify(par));
  s.slice(0, 6).forEach((x) => console.log('      ' + x.sport + ' — ' + x.domicile + ' v ' + x.exterieur));
  /* Le football, lui, doit etre entierement cotable : c est la ou l argent
     va, et c est la que le defaut s est paye. */
  const foot = s.filter((x) => x.sport === 'foot');
  ok(foot.length === 0,
     'aucune rencontre de FOOT sans force' + (foot.length
       ? ' — ' + foot.map((x) => x.domicile + ' v ' + x.exterieur).join(', ') : ''));
}

console.log('\ncotes_noms.test.js : ' + n + ' verifications, ' + rates + ' ratees');
process.exit(rates ? 1 : 0);
