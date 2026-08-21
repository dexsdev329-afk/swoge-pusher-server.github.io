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

console.log(`\nskins_edition.test.js : ${n} verifications OK`);
