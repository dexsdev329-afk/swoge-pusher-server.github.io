'use strict';
/*
 * Le frais de retrait, et le minimum d'envoi entre joueurs.
 *
 * ---- ce qui est verifie, et pourquoi ----
 *
 * Un frais est un DEPLACEMENT d'argent : ce que le joueur ne touche pas doit
 * se retrouver, au jeton pres, dans le coffre. Le controle qui compte n'est
 * donc pas « le frais vaut bien 1 % » mais la conservation : solde du joueur
 * + autorise a tirer + frais preleves doit valoir exactement ce qu'il y avait
 * avant. Un jeton cree ou perdu se voit la, meme s'il se cache.
 *
 * Et surtout : le frais ne doit JAMAIS tomber sur un joueur qui joue. C'est
 * toute la regle — on taxe l'aller-retour sans jouer, pas la sortie.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-retrait-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, m) => { ok(Math.abs(a - b) <= 1e-6, `${m} (${a} ≈ ${b})`); };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const nb = (w) => Number(ethers.utils.formatUnits(w || ethers.BigNumber.from(0), cfg.DECIMALS));
const sol = (g, a) => Number(g.balanceStr(a));
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);

/** Un joueur qui a depose pour de vrai, et qui n'a encore rien joue. */
function depose(montant) {
  const g = new Game();
  g.creditDeposit({ player: A, amount: WEI(montant), tx: '0x' + Math.random().toString(16).slice(2) });
  return g;
}

// ------------------------------------------- le frais, le meme pour tous
{
  const g = depose(100000);
  const info = g.infoFrais();
  eq(info.du, true, 'le frais s applique');
  eq(info.brule, true, 'et il est BRULE, pas encaisse par la maison');
  pres(Number(info.taux), cfg.WITHDRAW_FEE_BPS / 100, `il vaut ${cfg.WITHDRAW_FEE_BPS / 100} %`);

  const avant = sol(g, A);
  g.requestWithdraw(A, '50000');
  const frais = 50000 * cfg.WITHDRAW_FEE_BPS / 10000;

  pres(sol(g, A), avant - 50000, 'le solde baisse du BRUT demande');
  pres(nb(g._p(A).cumulativeAuthorized), 50000 - frais, 'mais il n est autorise a tirer que le NET');
  pres(nb(g.fraisCumules), frais, 'et le frais est compte a part, pour pouvoir etre brule');

  /* La conservation : rien ne se cree, rien ne se perd. */
  pres(sol(g, A) + nb(g._p(A).cumulativeAuthorized) + nb(g.fraisCumules), avant,
       'solde + autorise + frais = exactement ce qu il y avait avant');
}

// ------------------------------ le meme frais, quoi qu on ait fait avant
/* Un taux qui depend de l'historique du joueur ne se raconte pas en une
   phrase, et « every withdrawal burns $SWOGE » ne souffre aucune exception :
   la promesse doit etre vraie pour tout le monde. */
{
  const g = depose(100000);
  g._markWager(g._p(A), WEI(500000));            // gros joueur, a mise cinq fois son depot
  const avant = sol(g, A);
  g.requestWithdraw(A, '50000');
  const frais = 50000 * cfg.WITHDRAW_FEE_BPS / 10000;
  pres(nb(g._p(A).cumulativeAuthorized), 50000 - frais, 'il paie exactement le meme frais');
  pres(nb(g.fraisCumules), frais, 'et il part au meme endroit : le tas a bruler');
  pres(sol(g, A) + nb(g._p(A).cumulativeAuthorized) + nb(g.fraisCumules), avant,
       'conservation, la aussi');
}

// -------------------------- le frais n est verse a PERSONNE
/*
 * C'est ce qui separe un brulage d'une taxe. Le montant quitte le joueur,
 * n'arrive sur aucun solde, et reste dans le coffre : l'offre en circulation
 * baisse d'autant. Si un solde grossissait quelque part, ce serait un
 * prelevement deguise en brulage.
 */
{
  const g = depose(100000);
  const sommeAvant = [...g.players.values()].reduce((n, p) => n + nb(p.balance), 0);
  g.requestWithdraw(A, '50000');
  const sommeApres = [...g.players.values()].reduce((n, p) => n + nb(p.balance), 0);
  const frais = 50000 * cfg.WITHDRAW_FEE_BPS / 10000;
  pres(sommeApres, sommeAvant - 50000, 'aucun solde n a grossi d un seul jeton');
  pres(nb(g.fraisCumules), frais, 'le frais n existe que dans le compteur a bruler');
}

// ---------------------------------- le frais survit au redemarrage
{
  const g = depose(100000);
  g.requestWithdraw(A, '50000');
  const g2 = new Game();
  g2.hydrate(g.serialize());
  pres(nb(g2.fraisCumules), 50000 * cfg.WITHDRAW_FEE_BPS / 10000,
       'le total preleve est relu apres redemarrage — sinon on ne saurait plus quoi bruler');
  pres(nb(g2._p(A).cumulativeAuthorized), nb(g._p(A).cumulativeAuthorized),
       'et l autorisation cumulee ne bouge pas d un jeton');
}

// --------------------------------------- le minimum de retrait
/* Le coffre a le sien, en dur dans le contrat. Celui du serveur ne peut
   qu'etre plus haut : plus bas, on signerait des bons que la chaine
   refuserait, et le joueur verrait sa transaction echouer sans comprendre. */
{
  const g = depose(100000);
  ok(Number(cfg.MIN_WITHDRAW) >= 10000, `le retrait minimum vaut ${cfg.MIN_WITHDRAW} $SWOGE`);
  jete(() => g.requestWithdraw(A, '50'), /below minimum/, 'cinquante jetons : refuse');
  jete(() => g.requestWithdraw(A, String(Number(cfg.MIN_WITHDRAW) - 1)), /below minimum/,
       'juste en dessous : refuse');
  const avant = sol(g, A);
  g.requestWithdraw(A, String(cfg.MIN_WITHDRAW));
  pres(sol(g, A), avant - Number(cfg.MIN_WITHDRAW), 'au minimum : accepte');
}

// ------------------------------------- l envoi a un ami a un minimum
/*
 * Sans minimum, un virement de solde a solde est gratuit et instantane : c'est
 * exactement l'outil qu'il faut pour eparpiller une somme sur vingt comptes,
 * ou pour faire tourner de l'argent sans jamais jouer.
 */
{
  const g = new Game();
  for (const a of [A, B]) { const p = g._p(a); p.balance = WEI(1000000); p.hasDeposited = true; }
  ok(cfg.TRANSFER_MIN >= 10000, `le minimum d envoi vaut ${cfg.TRANSFER_MIN} $SWOGE`);

  jete(() => g.transfere(A, B, '1'), /minimum transfer/, 'un jeton : refuse');
  jete(() => g.transfere(A, B, String(cfg.TRANSFER_MIN - 1)), /minimum transfer/,
       'juste en dessous du minimum : refuse');
  const avant = sol(g, A) + sol(g, B);
  g.transfere(A, B, String(cfg.TRANSFER_MIN));
  pres(sol(g, A) + sol(g, B), avant, 'au minimum : accepte, et la somme des deux soldes ne bouge pas');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`retrait.test.js : ${n} verifications OK`);
});
