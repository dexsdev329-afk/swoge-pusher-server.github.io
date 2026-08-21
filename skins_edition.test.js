'use strict';
/*
 * LES EDITIONS LIMITEES DE SKIN.
 *
 * Un skin ordinaire est disponible en permanence : c'est ce qui le separe des
 * saisons de boutique.js, qui sont des editions fermees tirees au sort. Un
 * skin d'EDITION se choisit et se paie comme les autres, mais il n'en existe
 * qu'un nombre fixe.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE COMPTE NE DEBORDE JAMAIS. Une edition qui vend un exemplaire de trop
 *    n'est plus une edition — et payee en jetons reels, c'est une promesse
 *    dont on ne se releve pas.
 * 2. UN REFUS NE COUTE RIEN. Le solde et le compteur sont intacts apres un
 *    achat refuse.
 * 3. LE REGISTRE TRAVERSE LES SAUVEGARDES. Un redemarrage qui le remettrait a
 *    zero rouvrirait une edition epuisee, et personne ne le verrait avant le
 *    cinquante et unieme exemplaire.
 * 4. LE PRIX D'UNE EDITION NE SUIT PAS LE BAREME. Ce qu'on paie est la
 *    rarete, pas la force : le laisser sur la droite des puissances aurait
 *    voulu dire choisir ses stats pour obtenir un prix.
 * 5. L'OR N'EST PAS DU $SWOGE. Un skin paye en or ne doit toucher ni le
 *    solde, ni le net du jour, ni le chiffre d'affaires de la boutique : ces
 *    trois-la comptent de l'argent reel, et un nombre qui n'est jamais entre
 *    en caisse ne doit pas les gonfler.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/skined-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const skins = require('./skins');

/* On pose une edition d'essai PLUTOT que de compter sur une du catalogue :
   l'essai doit verifier le mecanisme, pas le contenu du jour. Une edition
   retiree du catalogue ferait tomber un essai qui ne parle pas d'elle. */
const CIBLE = 'brett';
const EXEMPLAIRES = 3, PRIX = 50000;
skins.EDITIONS[CIBLE] = { exemplaires: EXEMPLAIRES, prix: PRIX };

/* Une seconde edition, payee en OR. Deux editions cote a cote plutot qu'une
   seule qu'on retoucherait entre deux sections : les essais du haut relisent
   `skins.EDITIONS[CIBLE]` a chaque achat, et changer sa monnaie en cours de
   route rendrait leur resultat dependant de l'ordre des sections. */
const CIBLE_OR = 'landwolf';
const EXEMPLAIRES_OR = 2, PRIX_OR = 20000;
skins.EDITIONS[CIBLE_OR] = { exemplaires: EXEMPLAIRES_OR, prix: PRIX_OR, monnaie: 'or' };

const { Game } = require('./game');
const ethers = require('./node_modules/ethers');
const cfg = require('./config');
const W = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const g = new Game();
const compte = (i) => '0x' + String.fromCharCode(97 + i).repeat(40);
const fiche = (a) => g.skinsEtat(a).catalogue.filter((s) => s.id === CIBLE)[0];

console.log('\n-- le prix est une decision, pas un calcul --');
{
  eq(skins.prixDe(CIBLE), PRIX, 'le prix de l edition est celui qu on a ecrit');
  eq(skins.editionDe(CIBLE), EXEMPLAIRES, `et il en existe ${EXEMPLAIRES}`);
  /* Le bareme des puissances aurait donne un tout autre chiffre. C'est le
     point : une edition ne se range pas sur cette droite. */
  const s = skins.skin(CIBLE);
  ok(skins.PUISSANCE_PRIX[s.puissance] !== PRIX,
     `le bareme aurait dit ${skins.PUISSANCE_PRIX[s.puissance]} — l edition ne le suit pas`);
  eq(skins.editionDe('andy'), 0, 'un skin sans edition rend zero, pas null');
}

console.log('\n-- on vend exactement le nombre annonce --');
{
  for (let i = 0; i < EXEMPLAIRES; i++) {
    const a = compte(i);
    g._p(a).balance = W(200000);
    g.acheteSkin(a, CIBLE);
    eq(fiche(a).reste, EXEMPLAIRES - i - 1,
       `apres le ${i + 1}e achat, il en reste ${EXEMPLAIRES - i - 1}`);
  }

  /* ---- ET PAS UN DE PLUS ---- */
  const trop = compte(EXEMPLAIRES);
  const p = g._p(trop);
  p.balance = W(200000);
  const avant = g.balanceStr(trop);
  let err = null;
  try { g.acheteSkin(trop, CIBLE); } catch (e) { err = e.message; }
  ok(/sold out/.test(err || ''), `le suivant est refuse (${err})`);
  /* UN REFUS NE COUTE RIEN. Le controle passe AVANT le debit ; l'ordre
     inverse aurait pris l argent d un joueur qui ne recoit rien. */
  eq(g.balanceStr(trop), avant, 'et son solde est intact');
  eq(g.possedeSkin(p, CIBLE), false, 'il ne l a pas');
  eq(g.skinsEmis[CIBLE], EXEMPLAIRES, `le compteur s arrete a ${EXEMPLAIRES}`);
}

console.log('\n-- un achat impossible ne consomme pas d exemplaire --');
{
  /* Pas assez de jetons : l exemplaire doit rester disponible. C est le cas
     qui creuse le trou le plus silencieux — une edition qui se vide sans que
     personne ne recoive rien. */
  const g2 = new Game();
  const a = compte(0);
  g2._p(a).balance = W(10);
  let err = null;
  try { g2.acheteSkin(a, CIBLE); } catch (e) { err = e.message; }
  ok(/not enough/.test(err || ''), `sans jetons, l achat est refuse (${err})`);
  eq((g2.skinsEmis || {})[CIBLE] | 0, 0, 'et aucun exemplaire n a ete consomme');
}

console.log('\n-- le registre traverse la sauvegarde --');
{
  /* On passe par les VRAIES fonctions de sauvegarde et de relecture. Recopier
     le champ a la main verifierait qu'un objet se copie, pas que le registre
     survit a un redemarrage. */
  const etat = JSON.parse(JSON.stringify(g.serializeTete()));
  ok(etat.skinsEmis && etat.skinsEmis[CIBLE] === EXEMPLAIRES,
     `l etat sauvegarde porte le compteur (${etat.skinsEmis && etat.skinsEmis[CIBLE]})`);
  const g3 = new Game();
  g3.hydrate(etat);
  const a = compte(EXEMPLAIRES + 1);
  g3._p(a).balance = W(200000);
  let err = null;
  try { g3.acheteSkin(a, CIBLE); } catch (e) { err = e.message; }
  ok(/sold out/.test(err || ''),
     `apres rechargement, l edition est TOUJOURS epuisee (${err})`);
}

console.log('\n-- et les autres skins ne changent pas --');
{
  const g4 = new Game();
  const a = compte(1);
  g4._p(a).balance = W(2000000);
  const avant = Number(g4.balanceStr(a));
  g4.acheteSkin(a, 'pepe');
  const paye = avant - Number(g4.balanceStr(a));
  eq(paye, skins.prixDe('pepe'), 'un skin sans edition se paie a son prix de bareme');
  eq((g4.skinsEmis || {})['pepe'] | 0, 0, 'et ne touche aucun compteur');
  const f = g4.skinsEtat(a).catalogue.filter((s) => s.id === 'pepe')[0];
  eq(f.edition, 0, 'sa fiche dit qu il n a pas d edition');
  eq(f.reste, 0, 'donc pas de « il en reste » a afficher');
}

console.log('\n-- une edition peut se payer en or --');
{
  eq(skins.monnaieDe(CIBLE_OR), 'or', 'la fiche dit que celle-ci se paie en or');
  eq(skins.monnaieDe(CIBLE), 'swoge', 'l autre edition reste en jetons');
  /* Jamais `undefined` : la page compare a `'or'` sans avoir a se demander si
     le champ existe. */
  eq(skins.monnaieDe('pepe'), 'swoge', 'et un skin du bareme aussi, par defaut');
  eq(skins.prixDe(CIBLE_OR), PRIX_OR, 'son prix est celui qu on a ecrit');

  const g5 = new Game();
  const a = compte(3);
  const p = g5._p(a);
  p.fame = PRIX_OR + 500;
  p.balance = W(1000000);
  const soldeAvant = g5.balanceStr(a);
  const netAvant = p.dayNet.toString();
  const caAvant = Number(g5._mois().boutique || 0);

  const r = g5.acheteSkin(a, CIBLE_OR);
  eq(r.monnaie, 'or', 'l achat REND la monnaie — la page n a pas a la deviner');
  eq(p.fame, 500, `l or paie : ${PRIX_OR} sont partis, il en reste 500`);
  eq(g5.possedeSkin(p, CIBLE_OR), true, 'et le skin est au joueur');

  /* ---- CE QUE L'OR NE TOUCHE PAS ----
   * Les trois compteurs qui parlent d argent reel. Un seul d entre eux qui
   * bougerait ferait apparaitre un depot qui n a jamais eu lieu — et le
   * chiffre d affaires de la boutique sert a decider pour de vrai. */
  eq(g5.balanceStr(a), soldeAvant, 'le solde en jetons n a pas bouge');
  eq(p.dayNet.toString(), netAvant, 'le net du jour non plus');
  eq(Number(g5._mois().boutique || 0), caAvant,
     'et le chiffre d affaires de la boutique reste au meme point');

  /* Le compteur d exemplaires, lui, compte pareil : la monnaie change le
     debit, pas la rarete. */
  const f = g5.skinsEtat(a).catalogue.filter((x) => x.id === CIBLE_OR)[0];
  eq(f.reste, EXEMPLAIRES_OR - 1, `il en reste ${EXEMPLAIRES_OR - 1}`);
  eq(f.monnaie, 'or', 'et le catalogue porte la monnaie jusqu a la page');
  eq(g5.skinsEtat(a).or, 500, 'l etat porte l or du compte, pour l afficher');
}

console.log('\n-- sans or, on est refuse EN OR --');
{
  const g6 = new Game();
  const a = compte(4);
  const p = g6._p(a);
  p.fame = PRIX_OR - 1;
  /* Riche en jetons, pauvre en or : c est tout le piege. Un controle qui
     regarderait le solde laisserait passer un achat que le joueur ne peut
     pas payer. */
  p.balance = W(5000000);
  let err = null;
  try { g6.acheteSkin(a, CIBLE_OR); } catch (e) { err = e.message; }
  ok(/gold/.test(err || ''), `le refus parle d or (${err})`);
  ok(!/\$SWOGE/.test(err || ''),
     'et surtout pas de $SWOGE — sinon on envoie deposer des jetons pour rien');
  eq(p.fame, PRIX_OR - 1, 'son or est intact');
  eq(g6.possedeSkin(p, CIBLE_OR), false, 'il n a pas le skin');
  eq((g6.skinsEmis || {})[CIBLE_OR] | 0, 0, 'et aucun exemplaire n a ete consomme');
}

console.log('\n-- un prix ecrit a la main n oblige pas a limiter --');
{
  /* `exemplaires: 0` : un prix decide hors bareme, mais disponible en
     permanence. La page ne doit alors afficher aucun « il en reste » — un
     compteur sur un skin sans limite se lit comme une edition qui s epuise. */
  skins.EDITIONS.ogswoge = { exemplaires: 0, prix: 7500, monnaie: 'or' };
  eq(skins.prixDe('ogswoge'), 7500, 'le prix ecrit a la main est retenu');
  eq(skins.editionDe('ogswoge'), 0, 'et il n y a pas d edition');
  const g7 = new Game();
  const a = compte(5);
  g7._p(a).fame = 100000;
  for (let i = 0; i < 3; i++) {
    const b = compte(5 + i);
    g7._p(b).fame = 100000;
    g7.acheteSkin(b, 'ogswoge');
  }
  eq((g7.skinsEmis || {})['ogswoge'] | 0, 0,
     'trois achats et toujours aucun compteur — rien ne s epuise');
  delete skins.EDITIONS.ogswoge;
}

console.log(`\nskins_edition.test.js : ${n} verifications OK`);
