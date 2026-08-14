'use strict';
/*
 * Les comptes du mois.
 *
 * ---- l'erreur qu'on cherche a rendre impossible ----
 *
 * « Il depose 100 000, il lui en reste 80 000, donc il a perdu 20 000. Le mois
 * suivant il remonte en positif. » C'est la facon naturelle de raisonner, et
 * elle est fausse : la variation d'un solde melange CINQ choses — depots,
 * retraits, resultat des jeux, rendement du staking, envois entre joueurs. Le
 * meme joueur repasse « positif » sans avoir joue une seule fois.
 *
 * ---- le controle qui vaut tous les autres ----
 *
 * La CONSERVATION. Sur une periode sans depot ni retrait, la somme de tous les
 * soldes doit avoir baisse d'exactement le revenu, et monte d'exactement ce
 * qui a ete donne. Si le compte du mois dit autre chose, il ment — et un
 * chiffre faux dans un tableau de bord est pire que pas de chiffre du tout,
 * parce qu'on decide avec.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-comptes-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const pres = (a, b, m, eps) => { ok(Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps), `${m} (${a} ≈ ${b})`); };
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const nb = (w) => Number(ethers.utils.formatUnits(w || ethers.BigNumber.from(0), cfg.DECIMALS));
const total = (g) => [...g.players.values()].reduce((s, p) => s + nb(p.balance), 0);

function table(solde) {
  const g = new Game();
  for (const a of [A, B]) { const p = g._p(a); p.balance = WEI(solde); p.hasDeposited = true; }
  return g;
}

// ============================== LA CONSERVATION
/*
 * Ce que la maison dit avoir garde doit correspondre, au jeton pres, a ce que
 * les joueurs ont reellement perdu.
 */
{
  const g = table(500000);
  const avant = total(g);
  for (let i = 0; i < 120; i++) g.plinkoDrop(A, 1000, 12, 'medium');
  for (let i = 0; i < 80; i++) g.plinkoDrop(B, 500, 12, 'high');
  const c = g.comptes();
  const apres = total(g);

  pres(avant - apres, c.revenu,
       'CONSERVATION : ce que les soldes ont perdu est exactement ce que la maison dit avoir garde');
  pres(c.revenu, c.mises - c.rendus, 'et le revenu vaut bien mises moins rendus');
  eq(c.manches, 200, 'les deux cents manches sont comptees');
  ok(c.mises > 0 && c.rendus > 0, 'avec les deux cotes du compte');
}

// ====================== UN DEPOT N EST PAS UN GAIN
/*
 * C'est l'erreur qui fait couler les casinos : se croire riche de l'argent
 * qu'on doit. Un depot de cent mille ne change RIEN au resultat du mois.
 */
{
  const g = table(0);
  g.creditDeposit({ player: A, amount: WEI(100000), tx: '0xd1' });
  const c = g.comptes();
  eq(c.resultat, 0, 'apres un depot de 100 000, le resultat du mois vaut toujours ZERO');
  pres(c.depots, 100000, 'le depot figure au bilan, pas au resultat');
  eq(c.revenu, 0, 'et il n a rien rapporte : la maison le DOIT');

  /* Le retrait non plus. */
  g._p(A).wagered = WEI(1);          // pour ne pas buter sur autre chose
  g.requestWithdraw(A, '50000');
  const c2 = g.comptes();
  eq(c2.resultat, 0, 'un retrait ne change pas davantage le resultat');
  pres(c2.retraits, 50000 * (1 - cfg.WITHDRAW_FEE_BPS / 10000), 'il figure au bilan, net du frais');
  pres(c2.brule, 50000 * cfg.WITHDRAW_FEE_BPS / 10000, 'et le frais brule est compte a part');
}

// =============== LE CAS QUI EMBROUILLE : 100 000 deposes, 80 000 restants
/*
 * Le joueur de l'exemple. Son SOLDE ne dit rien ; son resultat de jeu, si. Et
 * le mois suivant, un simple redepot le fait « remonter » sans qu'il ait joue.
 */
{
  const g = new Game();
  g.creditDeposit({ player: A, amount: WEI(100000), tx: '0xe1' });
  /* On lui fait perdre exactement 20 000 en jeu, sans dependre de la chance :
     une mise rendue a zero. */
  g._manche(g._p(A), 'plinko', 20000, 0);
  g._p(A).balance = g._p(A).balance.sub(WEI(20000));

  const c = g.comptes();
  pres(c.revenu, 20000, 'la maison a garde 20 000 — c est le seul chiffre vrai');
  pres(nb(g._p(A).balance), 80000, 'et il lui reste bien 80 000');

  /* Maintenant il redepose 50 000. Son solde remonte a 130 000 : a-t-il
     « regagne » ? Non. Il a toujours perdu 20 000 en jeu, et la maison a
     toujours garde 20 000. */
  g.creditDeposit({ player: A, amount: WEI(50000), tx: '0xe2' });
  const c2 = g.comptes();
  pres(nb(g._p(A).balance), 130000, 'son solde remonte a 130 000');
  pres(c2.revenu, 20000, 'MAIS le revenu de la maison n a pas bouge : toujours 20 000');
  const sien = c2.joueurs.find((x) => x.address === A);
  pres(sien.resultat, 20000, 'et son ardoise a lui reste a 20 000 perdus, redepot ou pas');
}

// ================ LE STAKING EST UN COUT, PAS UN RESULTAT DE JEU
/*
 * L'autre question : « il depose 200 000, il en stake 100 000, il gagne tous
 * les jours ». Ce rendement n'est pas une perte au jeu — c'est une depense de
 * la maison, et elle doit se lire separement. Melangee au resultat des jeux,
 * elle ferait passer un joueur qui NE JOUE PAS pour un joueur rentable.
 */
{
  const g = new Game();
  g.creditDeposit({ player: A, amount: WEI(200000), tx: '0xf1' });
  g.stake(A, '100000');

  /* Un an de rendement, sans toucher a une seule manche. */
  const p = g._p(A);
  p.stakes[0].s -= 365 * 86400000;
  const rendu = Number(g.claimStake(A));

  const c = g.comptes();
  eq(c.revenu, 0, 'il n a pas joue : la maison n a RIEN gagne sur lui');
  pres(c.staking, rendu, 'et le rendement verse est compte comme un cout');
  ok(c.resultat < 0, `le mois est en perte de ${(-c.resultat).toFixed(0)} — c est la verite`);
  pres(c.resultat, -rendu, 'exactement le rendement verse, rien d autre');
  ok(rendu > 90000, `a 100 % l an, 100 000 stakes ont rapporte ${rendu.toFixed(0)} en un an`);

  /* Le detail par joueur separe bien les deux : ce qu il a laisse au jeu et ce
     qu il a RECU. Un seul chiffre pour les deux serait ininterpretable. */
  const sien = c.joueurs.find((x) => x.address === A);
  eq(sien.resultat, 0, 'son ardoise de jeu est vide');
  pres(sien.recu, rendu, 'et ce qu il a recu figure a part');
}

// ============================== les bonus aussi sont des couts
{
  const g = new Game();
  g.grantWelcome(A);
  const c = g.comptes();
  pres(c.bonus, cfg.WELCOME_BONUS, 'le credit d essai est une depense');
  pres(c.resultat, -cfg.WELCOME_BONUS, 'qui pese sur le mois');
}

// ====================== chaque mois garde son compte
{
  const g = table(100000);
  g.plinkoDrop(A, 1000, 12, 'medium');
  const courant = Game.moisCle();

  /* On fabrique un mois passe a la main : ce qu'on verifie, c'est qu'un mois
     clos reste lisible et n'est pas ecrase par le suivant. */
  g.compta['2026-01'] = { mises: 500000, rendus: 480000, staking: 3000, bonus: 100,
                          parrainage: 0, jackpots: 0, depots: 0, retraits: 0, brule: 0,
                          manches: 900, joueurs: {} };
  const vieux = g.comptes('2026-01');
  pres(vieux.revenu, 20000, 'un mois clos garde son revenu');
  pres(vieux.resultat, 16900, 'et son resultat, couts deduits');
  ok(g.moisConnus().includes('2026-01') && g.moisConnus().includes(courant),
     'les deux mois sont proposes');

  const g2 = new Game();
  g2.hydrate(g.serialize());
  pres(g2.comptes('2026-01').resultat, 16900, 'et tout cela survit au redemarrage');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`comptes.test.js : ${n} verifications OK`);
});
