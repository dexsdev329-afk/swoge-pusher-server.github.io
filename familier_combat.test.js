'use strict';
/*
 * LE FAMILIER SE BAT — cinquieme et derniere etape du plan des animaux.
 *
 * Six pouvoirs, six facons de casser. Ce fichier verifie chacun, et surtout
 * les endroits ou une aide devient autre chose qu'une aide :
 *
 * 1. IL AGIT SEUL, sur une recharge. Un compagnon qu'il faut declencher est
 *    une deuxieme touche de pouvoir : on l'oublie, ou on l'appuie en boucle.
 * 2. UN GESTE DANS LE VIDE NE COUTE PAS LA RECHARGE. Sinon le chien mord
 *    l'air a l'instant ou l'on arrive sur un groupe, et attend cinq secondes
 *    pour le premier vrai coup.
 * 3. LE NIVEAU CHANGE QUELQUE CHOSE. Un niveau qui monte sans qu'on voie rien
 *    changer est une barre de progression, pas une progression.
 * 4. IL NE REMPLACE PAS LE JOUEUR. Les chiffres restent petits devant ceux
 *    d'une arme : il n'y a aucune facon de FARMER un un-sur-cinq-mille, et un
 *    familier qui tuerait seul mettrait les autres derriere pour une raison
 *    qu'ils ne controlent pas.
 * 5. ET IL NE SE BAT PAS DANS LE MONDE ROUGE. On y perd son sac ; laisser un
 *    tirage a un sur cinq mille decider des duels aurait fait de la chance au
 *    butin la competence principale de la carte ou l'on risque ses affaires.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/famcbt-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const monde = require('./monde');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };
const pres = (a, b, e, m) => { assert.ok(Math.abs(a - b) <= e, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const fiche = (fam, niv) => ({ skin: 'andy', nom: 'Alice',
  stats: { att: 40, def: 10, spd: 30, dex: 30, vit: 30, wis: 20, hp: 500, mp: 100 },
  famille: 'lame', degats: [40, 60], fam: fam || null, famNiv: niv || 1 });

/* Une scene minimale : un joueur, et UN monstre pose a portee. On enleve tous
   les autres — mesurer un pouvoir de zone au milieu d'un monde peuple
   reviendrait a mesurer le monde. */
function scene(fam, niv, opts) {
  const R = new Realm(opts || {});
  const A = '0xaaa';
  R.rejoint(A, fiche(fam, niv));
  const j = R.joueurs.get(A);
  R.monstres.length = 0;
  R.tirsM.length = 0;
  R.zones.length = 0;
  /* ---- LE TROISIEME CRAN EST MIS DE COTE, ICI ----
   *
   * A partir du soixantieme niveau le compagnon connait un pouvoir de
   * SOUTIEN, et ce soutien passe DEVANT tout le reste : il prepare, puis il
   * frappe. Plusieurs scenes de ce fichier tournent au centieme niveau pour
   * avoir une recharge courte — elles mesureraient donc le soutien au lieu
   * de ce qu'elles annoncent mesurer.
   *
   * On le met sur son delai des le depart. Ce n'est pas un contournement :
   * c'est l'etat NORMAL d'un compagnon qui vient de preparer son maitre, et
   * c'est dans cet etat qu'il passe les trois quarts d'un combat. Le
   * soutien lui-meme a son fichier : familier_soutien.test.js. */
  j.famSoutienR = monde.FAMILIERS.soutienDelai;
  return { R, A, j };
}
function poseMonstre(R, j, dx, dy) {
  const espece = Object.keys(monde.MONSTRES)[0];
  const t = monde.MONSTRES[espece];
  const m = { id: R._nouvelId(), espece, biome: null, x: j.x + dx, y: j.y + dy,
              ancreX: j.x + dx, ancreY: j.y + dy,
              pv: 100000, pvMax: 100000, dir: 'down', cible: null,
              recharge: 999, rechargeT: 999, stase: 0,
              feu: 0, feuReste: 0, feuTaux: 0, feuPar: null,
              errX: 0, errY: 0, errChrono: 0 };
  R.monstres.push(m);
  return m;
}
/* Avancer d'un temps donne, en pas courts : la recharge se decompte par pas,
   et un seul pas de six secondes testerait une simulation qui n'existe pas. */
function avance(R, secondes) {
  const evs = [];
  for (let t = 0; t < secondes; t += 0.1) evs.push(R.pas(0.1));
  return evs;
}
const gestes = (evs, quoi) => evs.flatMap((e) => (e.fam || []))
  .filter((f) => !quoi || f.quoi === quoi);

/* ================== 1. IL AGIT SEUL, SUR SA RECHARGE ================== */
console.log('\n-- le chien mord, tout seul --');
{
  const { R, j } = scene('normal', 1);
  const m = poseMonstre(R, j, 100, 0);
  const pv0 = m.pv;
  const evs = avance(R, 0.4);
  const mord = gestes(evs, 'mord');
  eq(mord.length, 1, 'il mord des le premier pas — pas d attente au debut');
  ok(m.pv < pv0, `et le monstre le sent (${pv0 - m.pv} points)`);
  eq(mord[0].perte, pv0 - m.pv, 'l evenement dit exactement ce qui a ete retire');
  /* La MEME forme que nos tirs : la page peint le chiffre au meme endroit,
     avec le meme code. Un second chemin d affichage aurait fini par montrer
     les degats du chien autrement que les notres. */
  const t = evs.flatMap((e) => e.touches).filter((x) => x.familier);
  eq(t.length, 1, 'et il passe par le meme evenement `touches` que nos tirs');

  /* ---- LA RECHARGE TIENT, ET ELLE VIENT DU NIVEAU ----
   * Elle valait cinq secondes pour tout le monde. Elle vaut maintenant
   * SOIXANTE au premier niveau et trois au centieme — le niveau achete de la
   * frequence. L'essai la DEMANDE au monde plutot que de l'ecrire : un
   * chiffre en dur ici serait tombe le jour du changement sans qu'une seule
   * regle soit fausse. */
  const rech = monde.rechargeFamilier(1);
  eq(Math.round(rech), 60, 'au premier niveau, il agit une fois par minute');
  const suite = gestes(avance(R, rech - 1), 'mord');
  eq(suite.length, 0, 'il ne remord pas pendant sa recharge');
  const apres = gestes(avance(R, 1.6), 'mord');
  eq(apres.length, 1, 'et il remord quand elle est finie');
}

/* ================== 2. LE VIDE NE COUTE PAS LA RECHARGE ================== */
console.log('\n-- mordre l air ne coute rien --');
{
  const { R, j } = scene('normal', 1);
  /* Aucun monstre : il regarde autour, il ne dort pas. Trois secondes, soit
     vingt fois moins que sa recharge au premier niveau — s'il consommait la
     recharge en mordant l'air, il ne pourrait plus rien faire pendant une
     minute au moment precis ou l'on arrive sur un groupe. */
  avance(R, 3);
  const m = poseMonstre(R, j, 100, 0);
  const mord = gestes(avance(R, 0.6), 'mord');
  ok(mord.length >= 1,
     'un monstre qui arrive apres trois secondes de vide est mordu tout de suite');
}

/* ================== 3. LES SIX POUVOIRS ================== */
console.log('\n-- le feu brule --');
{
  const { R, j } = scene('feu', 1);
  const m = poseMonstre(R, j, 100, 0);
  const pv0 = m.pv;
  const evs = avance(R, 0.4);
  eq(gestes(evs, 'brule').length, 1, 'il met le feu');
  ok(m.feu > 0, `et la creature brule (${m.feu.toFixed(1)}s)`);
  eq(m.feuPar, '0xaaa', 'au compte de son maitre — c est lui qui aura l XP');
  avance(R, 3.6);
  ok(m.pv < pv0, `la brulure ronge (${pv0 - m.pv} points)`);
  ok(!(m.feu > 0), 'puis elle s eteint');
  const fige = m.pv;
  avance(R, 1);
  eq(m.pv, fige, 'et elle cesse de faire des degats');
}
console.log('\n-- la glace fige --');
{
  const { R, j } = scene('glace', 1);
  const m = poseMonstre(R, j, 100, 0);
  const evs = avance(R, 0.4);
  eq(gestes(evs, 'gele').length, 1, 'il gele');
  ok(m.stase > 0, `la creature est figee (${m.stase.toFixed(2)}s)`);
  /* Prolonger a chaque recharge aurait fait d un seul monstre une statue
     permanente — ce qui n est pas une aide, c est une suppression. */
  const encore = gestes(avance(R, monde.rechargeFamilier(1) + 2), 'gele');
  ok(m.stase <= 0 || encore.length <= 1,
     'et il ne prolonge pas indefiniment le meme');
}
console.log('\n-- les tenebres repoussent --');
{
  const { R, j } = scene('tenebre', 1);
  const m = poseMonstre(R, j, 60, 0);
  const avantX = m.x;
  const evs = avance(R, 0.4);
  eq(gestes(evs, 'repousse').length, 1, 'il repousse');
  ok(m.x > avantX, `la creature recule (${Math.round(m.x - avantX)} unites)`);
  /* Pas de degats : une porte de sortie qui tue en plus n aurait plus aucune
     raison d etre choisie contre le chien qui mord. */
  eq(m.pv, m.pvMax, 'sans lui faire de mal — c est une sortie, pas une arme');
}
console.log('\n-- la terre protege --');
{
  const { R, j } = scene('terre', 1);
  poseMonstre(R, j, 100, 0);
  const evs = avance(R, 0.4);
  const b = gestes(evs, 'bouclier');
  eq(b.length, 1, 'il pose un bouclier');
  ok(j.bouclier > 0, 'et il tient');
  /* Une REDUCTION, pas une immunite : un bouclier qui annule ferait des
     secondes ou l on ne risque rien, et l esquive cesserait de compter. */
  const brut = 100;
  const amorti = R._amorti(j, brut);
  ok(amorti < brut, `il retire des degats (${brut} -> ${amorti})`);
  ok(amorti > 0, 'sans jamais tout annuler');
  /* La brulure n y passe pas : elle ignore la defense par regle du jeu, et un
     bouclier est une defense. */
  j.brulure = 5; j.brulReste = 0; j.pv = j.pvMax;
  const pvA = j.pv;
  avance(R, 1.1);
  ok(j.pv < pvA, 'et la brulure passe quand meme au travers');
}
console.log('\n-- le legendaire soigne --');
{
  const { R, j } = scene('legendaire', 1);
  j.pv = 100;
  const evs = avance(R, 0.4);
  const s = gestes(evs, 'soigne');
  eq(s.length, 1, 'il soigne');
  ok(j.pv > 100, `sans qu il y ait le moindre monstre (${j.pv - 100} points)`);
  /* A pleine vie, il ne fait rien — et surtout il ne consomme pas sa
     recharge, sinon on serait sans soin a l instant ou l on encaisse. */
  j.pv = j.pvMax;
  eq(gestes(avance(R, monde.rechargeFamilier(1) + 2), 'soigne').length, 0,
     'a pleine vie il se tait');
  j.pv = j.pvMax - 200;
  ok(gestes(avance(R, 0.5), 'soigne').length >= 1,
     'et il repart des qu on est blesse, sans attendre la recharge');
  ok(j.pv <= j.pvMax, 'il ne depasse jamais le maximum');
}

/* ================== 4. LE NIVEAU CHANGE QUELQUE CHOSE ================== */
console.log('\n-- le niveau se voit --');
{
  const un = scene('normal', 1);
  const m1 = poseMonstre(un.R, un.j, 100, 0);
  const pv1 = m1.pv; avance(un.R, 0.3);
  const degats1 = pv1 - m1.pv;

  const vingt = scene('normal', monde.FAMILIERS.niveauMax);
  const m2 = poseMonstre(vingt.R, vingt.j, 100, 0);
  const pv2 = m2.pv; avance(vingt.R, 0.3);
  const degats20 = pv2 - m2.pv;
  ok(degats20 > degats1 * 3,
     `au centieme il mord bien plus fort (${degats1} -> ${degats20})`);

  /* Mais jamais au point de remplacer une arme : un coup de lame vaut entre
     quarante et soixante, et il en donne dix par seconde. */
  /* ---- MEME AU CENTIEME, IL N EST PAS UNE ARME ----
   * C'est la ou le systeme peut deraper : la frequence est multipliee par
   * vingt entre le premier niveau et le centieme. Un coup de lame vaut entre
   * quarante et soixante et part plusieurs fois par seconde ; le familier doit
   * rester loin derriere. */
  const E = monde.familierEffet('mord', monde.FAMILIERS.niveauMax);
  const parSec = E.degats / E.recharge;
  ok(parSec < 40,
     `et il reste loin d une arme, meme au maximum (${parSec.toFixed(1)} par seconde contre 40+)`);

  const s1 = monde.familierEffet('soigne', 1).part;
  const s20 = monde.familierEffet('soigne', monde.FAMILIERS.niveauMax).part;
  ok(s20 > s1, `le soin monte aussi (${(s1 * 100).toFixed(1)}% -> ${(s20 * 100).toFixed(1)}%)`);
  /* ---- ET LE BOUCLIER EST PLAFONNE PLUS BAS QU AVANT ----
   * Il dure trois secondes. Au centieme niveau la recharge vaut aussi trois
   * secondes : il devient PERMANENT. Une reduction de moitie qui ne s arrete
   * jamais rendrait l esquive — seule competence du jeu — sans objet pour
   * toujours. */
  const bMax = monde.familierEffet('bouclier', monde.FAMILIERS.niveauMax);
  ok(bMax.reduction <= 0.36,
     `et le bouclier est plafonne (${(100 * bMax.reduction).toFixed(0)} %) — il ne devient jamais une immunite`);
  ok(Math.abs(bMax.recharge - bMax.duree) < 0.5,
     'au maximum il ne se coupe plus : c est pour ca que le plafond a baisse');

  /* ---- LA CADENCE MONTE EN LIGNE DROITE ----
   * Une fois par minute au premier niveau, vingt fois au centieme. C'est LA
   * promesse du systeme, et c'est elle qu'un joueur ressent. */
  eq(Math.round(monde.rechargeFamilier(1)), 60, 'niveau 1 : une fois par minute');
  eq(Math.round(monde.rechargeFamilier(monde.FAMILIERS.niveauMax)), 3,
     'niveau 100 : toutes les trois secondes');
  ok(monde.rechargeFamilier(10) < 25,
     `et le gain arrive VITE (${monde.rechargeFamilier(10).toFixed(0)}s des le dixieme niveau)`);
  let avant = 1e9;
  for (let k = 1; k <= monde.FAMILIERS.niveauMax; k++) {
    const r2 = monde.rechargeFamilier(k);
    if (r2 > avant) { ok(false, `la recharge remonte au niveau ${k}`); break; }
    avant = r2;
  }
  ok(true, 'elle ne remonte jamais d un niveau au suivant');
}

/* ================== 5. PAS DANS LE MONDE ROUGE ================== */
console.log('\n-- et il ne se bat pas dans la carte rouge --');
{
  const { R, j } = scene('normal', monde.FAMILIERS.niveauMax, { pvp: true });
  const m = poseMonstre(R, j, 100, 0);
  const pv0 = m.pv;
  const evs = avance(R, 6);
  eq(gestes(evs).length, 0, 'aucun geste de familier sur la carte PvP');
  eq(m.pv, pv0, 'et rien n a ete touche');
  /* Il est TOUJOURS la : c est une carte ou il ne se bat pas, pas une carte
     ou il n existe pas. Le champ part quand meme aux autres pages. */
  eq(R.etatPour('0xaaa').moi.fam, 'normal', 'mais il trotte quand meme derriere');
}

/* ---- ET UN JOUEUR SANS FAMILIER NE DECLENCHE RIEN ---- */
{
  const { R, j } = scene(null, 1);
  const m = poseMonstre(R, j, 100, 0);
  const pv0 = m.pv;
  eq(gestes(avance(R, 8)).length, 0, 'un joueur sans familier ne declenche rien');
  eq(m.pv, pv0, 'et le monstre est intact');
}

console.log(`\nfamilier_combat.test.js : ${n} verifications OK`);
