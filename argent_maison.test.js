'use strict';
/*
 * CE QUE LA MAISON GAGNE, CE QU'ELLE DOIT, ET CE QU'ELLE NE PEUT PAS RETIRER.
 *
 * Trois defauts de la meme famille : de l'argent reel que le serveur DEPLACE
 * bien, mais dont il rend compte faux ou pas du tout.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. LE RESULTAT DU MOIS VOIT TOUT L'ARGENT. `note()` ecrivait `boutique`,
 *    `marche`, `primes` et `rachat` au mois depuis le debut ; `comptes()` n'en
 *    relisait aucune. Le chiffre presente comme « le seul qui reponde a le
 *    casino a-t-il gagne de l'argent ce mois-ci » repondait a une autre
 *    question, et l'autonomie du coffre s'en deduisait.
 * 2. LE PRIX DU CLASSEMENT NE BOUGE PAS. `cagnotte()` se calcule sur le revenu
 *    DU JEU. Y verser le chiffre d'affaires des coffres ferait grossir une
 *    somme que des joueurs touchent reellement — un changement de paiement, pas
 *    de comptabilite.
 * 3. UN BON SIGNE EST UNE DETTE. Entre l'autorisation et la presentation, les
 *    jetons sont encore dans le coffre et ne sont plus dans aucun solde : le
 *    surplus montait d'autant, et le proprietaire pouvait retirer de bonne foi
 *    de l'argent deja promis.
 * 4. ET ON PEUT REDEMANDER SON BON. Refuser dans son portefeuille laissait le
 *    joueur sans solde, sans bon valide et sans recours.
 * 5. LE CADEAU DE PARRAINAGE NE SORT PAS SANS ETRE JOUE — par AUCUNE porte. Le
 *    verrou n'existait qu'au retrait ; le virement le contournait sans frais.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/argentmaison-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const ethers = require('ethers');
const { Game } = require('./game');
const cfg = require('./config');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };
const pres = (a, b, m) => { assert.ok(Math.abs(a - b) < 1e-6, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const f = (w) => Number(ethers.utils.formatUnits(w || ethers.BigNumber.from(0), cfg.DECIMALS));
const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);

console.log('\n-- le resultat du mois voit les quatre lignes --');
{
  const g = new Game();
  /* On passe par `note()`, le seul chemin par lequel ces lignes arrivent au
     mois : ecrire dans `compta` a la main verifierait la lecture d'un objet,
     pas la chaine que le jeu parcourt vraiment. */
  g.note('mises', 1000, A);
  g.note('rendus', 950, A);
  g.note('boutique', 40000, A);
  g.note('marche', 2500, A);
  g.note('primes', 9000, B);
  g.note('rachat', -12000, A);

  const c = g.comptes();
  pres(c.revenu, 50, 'le revenu du JEU reste mises moins rendus');
  pres(c.boutique, 40000, 'le chiffre d affaires des coffres et des skins est lu');
  pres(c.marche, 2500, 'les cinq pour cent du marche aussi');
  pres(c.recettes, 42500, 'et les deux font les recettes hors tables');
  pres(c.primes, 9000, 'le prix du classement verse est un COUT');
  pres(c.rachat, 12000,
       'le rachat aussi — stocke en negatif, il se lit en depense positive');
  /* LE CHIFFRE QUI COMPTE. Avant, il valait 50. */
  pres(c.resultat, 50 + 42500 - 9000 - 12000, 'le resultat du mois est enfin complet');
  ok(c.resultat !== c.revenu - 0,
     `et il ne vaut plus le seul revenu du jeu (${c.resultat} au lieu de 50)`);
}

console.log('\n-- mais le prix du classement ne bouge pas d un jeton --');
{
  /* Deux mois identiques cote TABLES, l'un avec un enorme chiffre d affaires
     de boutique. La cagnotte doit etre la MEME : elle se calcule sur le jeu.
     Sans cette verification, une correction de comptabilite changerait en
     silence ce que des joueurs touchent. */
  const g1 = new Game();
  g1.note('mises', 100000, A); g1.note('rendus', 90000, A);
  const g2 = new Game();
  g2.note('mises', 100000, A); g2.note('rendus', 90000, A);
  g2.note('boutique', 5000000, A);
  eq(g2.cagnotte(), g1.cagnotte(),
     `la cagnotte ne suit pas la boutique (${g1.cagnotte()})`);
  ok(g1.cagnotte() > 0, 'et elle n est pas nulle — la comparaison veut dire quelque chose');
}

console.log('\n-- le detail par joueur garde la trace --');
{
  /* `note(quoi, montant, qui)` passait son troisieme argument pour rien sur ces
     quatre lignes : la cle n existait pas dans la fiche du mois, et le
     mouvement se perdait. Un argument ignore en silence est pire qu absent. */
  const g = new Game();
  g.note('boutique', 4000, A);
  g.note('marche', 250, A);
  const m = g.compta[Game.moisCle()];
  pres(m.joueurs[A].boutique, 4000, 'ce que ce compte a depense en coffres est garde');
  pres(m.joueurs[A].marche, 250, 'et les frais qu il a payes au marche');
}

console.log('\n-- l autonomie ne compte pas le staking deux fois --');
{
  const g = new Game();
  g.note('mises', 1000, A); g.note('rendus', 900, A);
  g.note('boutique', 5000, A);
  g.note('staking', 700, A);
  const c = g.comptes();
  pres(c.resultat, 100 + 5000 - 700, 'le resultat retient bien le staking');
  pres(c.horsStaking, 100 + 5000,
       'la ligne de tresorerie ne le retient pas — il est deja en face, dans le rendement');
}

console.log('\n-- un bon signe reste une dette du coffre --');
{
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(100000); p.hasDeposited = true;
  const duAvant = f(g.totalOwed());

  const brut = 50000;
  g.requestWithdraw(A, String(brut));
  const frais = f(g.fraisRetrait(A, WEI(brut)));
  const net = brut - frais;

  eq(f(g.owedBreakdown().bons), net, `le bon non presente est du : ${net}`);
  /* LE POINT DE TOUTE LA SECTION. Le solde a baisse de 50 000 ; si le du
     baissait d autant, le surplus du proprietaire monterait de 50 000 alors
     qu aucun jeton n a quitte le coffre — et « Fill safe surplus » proposerait
     de les retirer. */
  pres(f(g.totalOwed()), duAvant - frais,
       'le du ne baisse que des frais, pas du montant autorise');

  const b = g.bonEnAttente(A);
  eq(f(b.du), net, 'et le joueur peut redemander exactement ce bon-la');
  ok(b.cumulative.gt(0), 'le cumul signe existe');
}

console.log('\n-- et il s efface quand la chaine dit qu il est encaisse --');
{
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(100000); p.hasDeposited = true;
  g.requestWithdraw(A, '50000');
  const cum = g.bonEnAttente(A).cumulative;
  ok(f(g.owedBreakdown().bons) > 0, 'avant la reponse de la chaine, le bon est du');

  /* La chaine repond « ce joueur a deja tout tire ». La dette tombe — et pas
     avant : le serveur ne voit pas les transactions, il ne peut que demander. */
  g.noteRetireOnChain(A, cum);
  eq(f(g.owedBreakdown().bons), 0, 'une fois encaisse, il ne doit plus rien');
  eq(f(g.bonEnAttente(A).du), 0, 'et il n y a plus rien a redemander');

  /* Un encaissement PARTIEL laisse le reste du. */
  g.requestWithdraw(A, '10000');
  const reste = f(g.bonEnAttente(A).du);
  ok(reste > 0, `un nouveau retrait recree une dette (${reste})`);
  g.noteRetireOnChain(A, cum);        // la chaine n'a pas encore vu le second
  pres(f(g.bonEnAttente(A).du), reste, 'un encaissement partiel laisse le reste du');
}

console.log('\n-- la dette traverse la sauvegarde --');
{
  /* Un redemarrage qui l oublierait rendrait au surplus, d un coup, tous les
     bons signes et non presentes. */
  const g = new Game();
  const p = g._p(A);
  p.balance = WEI(100000); p.hasDeposited = true;
  g.requestWithdraw(A, '50000');
  const attendu = f(g.owedBreakdown().bons);

  const etat = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = new Game();
  g2.hydrate(etat);
  eq(f(g2.owedBreakdown().bons), attendu, `elle vaut toujours ${attendu} apres relecture`);
  eq(f(g2.bonEnAttente(A).du), attendu, 'et le joueur peut toujours redemander son bon');
}

console.log('\n-- le cadeau de parrainage ne sort par AUCUNE porte --');
{
  const MIN = cfg.REFERRAL_WELCOME_MIN, CADEAU = Number(cfg.REFERRAL_WELCOME);
  const monte = () => {
    const g = new Game();
    g.lieParrain(B, A);
    g.creditDeposit({ player: B, amount: WEI(MIN), tx: '0x' + Math.random().toString(16).slice(2) });
    const q = g._p(B);
    ok(q.bonusBloque.gt(0), 'le cadeau est dans le solde, et bloque');
    return g;
  };

  /* Le temoin : le retrait, seule porte qui le savait deja. */
  {
    const g = monte();
    let err = null;
    try { g.requestWithdraw(B, String(MIN + CADEAU)); } catch (e) { err = e.message; }
    ok(/unlock your referral gift/.test(err || ''), `le retrait refuse (${err})`);
  }

  /* LE TROU : le virement. Il ne coute rien, et il suffit d un second
     portefeuille. */
  {
    const g = monte();
    const avant = g.balanceStr(B);
    let err = null;
    try { g.transfere(B, A, String(MIN + CADEAU)); } catch (e) { err = e.message; }
    ok(/unlock your referral gift/.test(err || ''), `le virement refuse aussi (${err})`);
    eq(g.balanceStr(B), avant, 'et un refus ne coute rien');
    eq(f(g._p(A).balance), 0, 'le complice n a rien recu');

    /* SON PROPRE ARGENT, lui, sort sans entrave : la regle bloque le cadeau,
       pas le compte. Le montant est exactement ce qui n'est pas bloque —
       `MIN` depose, `CADEAU` retenu — et il faut qu'il tienne aussi le
       minimum de virement, sinon c'est cet autre refus qu'on mesurerait. */
    const libre = MIN + CADEAU - Number(ethers.utils.formatUnits(g._p(B).bonusBloque, cfg.DECIMALS));
    ok(libre >= cfg.TRANSFER_MIN,
       `ce qui n est pas bloque (${libre}) depasse le minimum de virement (${cfg.TRANSFER_MIN})`);
    const propre = g.transfere(B, A, String(libre));
    ok(!!propre, 'mais son propre argent part sans entrave');
  }

  /* Et le marche joueur, qui est un virement deguise a cinq pour cent. */
  {
    const g = monte();
    const v = g._p(A);
    v.hasDeposited = true;
    v.objets = { 1001: 1 };
    const a = g.marcheVend(A, 1001, MIN + CADEAU, 1);
    let err = null;
    try { g.marcheAchete(B, a.id); } catch (e) { err = e.message; }
    ok(/unlock your referral gift/.test(err || ''), `l achat au marche refuse aussi (${err})`);
    eq((g._p(B).objets || {})[1001], undefined, 'et rien n a change de main');
  }

  /* Une fois le cadeau JOUE, tout se rouvre — sinon la regle serait une prison,
     pas un verrou. */
  {
    const g = monte();
    const q = g._p(B);
    q.bonusBloque = ethers.BigNumber.from(0);
    const r = g.transfere(B, A, String(MIN));
    ok(!!r, 'cadeau debloque : le virement passe');
  }
}

console.log(`\nargent_maison.test.js : ${n} verifications OK`);
