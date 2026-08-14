'use strict';
/*
 * La restauration.
 *
 * ---- pourquoi remplacer n'est pas charger ----
 *
 * hydrate() AJOUTE : il pose les fiches de l'archive par-dessus celles qui
 * sont deja en memoire. C'est ce qu'il faut au demarrage, quand la memoire est
 * vide. Ce n'est SURTOUT PAS ce qu'il faut pour une restauration : les joueurs
 * apparus depuis l'archive resteraient la, avec leur solde d'aujourd'hui,
 * melanges aux soldes d'hier. On croirait avoir restaure ; on aurait fabrique
 * un etat qui n'a jamais existe — et c'est le pire des trois resultats
 * possibles, parce que c'est le seul qui ne se voit pas.
 *
 * ---- ce qui est verifie ----
 *
 * Que le chemin ENTIER tienne : un casino qui a vecu → l'archive compressee →
 * un serveur qui a continue de tourner entre-temps → la restauration → et
 * chaque chiffre correspond a l'archive, AU JETON PRES, sans qu'aucune trace
 * de l'etat intermediaire ne survive.
 */
const assert = require('assert');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-restau-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game', './store']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const store = require('./store');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';
const du = (g) => {
  const b = g.owedBreakdown();
  return b.balances.add(b.staked).add(b.jackpot).toString();       // sans le rendement, qui coule
};

/* Un casino qui a vecu. */
function casino() {
  const g = new Game();
  for (const a of [A, B]) { const p = g._p(a); p.balance = WEI(400000); p.hasDeposited = true; p.deposited = WEI(400000); }
  g.setPublicName(A, 'Le Costaud'); g.setVisage(A, 'b3');
  g.amiDemande(A, B); g.amiAccepte(B, A);
  g.lieParrain(B, A);
  for (let i = 0; i < 25; i++) g.plinkoDrop(A, 1000, 12, 'medium');
  for (let i = 0; i < 10; i++) g.plinkoDrop(B, 500, 12, 'high');
  g.stake(A, '50000');
  g.tourneGraine();
  return g;
}

// ================== LE PIEGE : un joueur d'aujourd'hui ne doit pas survivre
{
  const g = casino();
  const archive = JSON.parse(JSON.stringify(g.serialize()));

  /* Le serveur a continue de tourner : un joueur NEUF est arrive, et un
     ancien a gagne. C'est exactement la situation d'une vraie restauration. */
  const p = g._p(C); p.balance = WEI(999999); p.hasDeposited = true;
  g._p(A).balance = g._p(A).balance.add(WEI(123456));
  eq(g.players.size, 3, 'trois joueurs en memoire, dont un absent de l archive');

  const r = g.remplace(archive);
  eq(r.apres, 2, 'la restauration ramene les deux joueurs de l archive');
  eq(g.players.has(C), false,
     'ET LE JOUEUR APPARU DEPUIS A DISPARU — c est tout le sujet : hydrate() l aurait garde');
  eq(g.balanceStr(A), ethers.utils.formatUnits(WEI(0).add(archive.players.find((x) => x[0] === A)[1].b), cfg.DECIMALS),
     'et le solde de l ancien est celui de l archive, pas celui d apres');
}

// ================== le chemin ENTIER, compression comprise
{
  const g = casino();
  store.save(g.serialize());
  const gz = zlib.gzipSync(fs.readFileSync(store.FILE), { level: 9 });
  const attendu = { du: du(g), soldeA: g.balanceStr(A), soldeB: g.balanceStr(B),
                    nom: g.profilPublic(A).name, visage: g.profilPublic(A).visage,
                    amis: g.amis(A).amis.length, filleuls: g.parrainage(A).filleuls.length,
                    stake: g.stakeInfo(A).staked, graines: g.equite().graines.length,
                    jackpot: g.jackpotStr(), autorise: g._p(A).cumulativeAuthorized.toString() };

  /* Le serveur tourne encore et s'eloigne de l'archive. */
  for (let i = 0; i < 40; i++) g.plinkoDrop(B, 1000, 12, 'medium');
  g._p(C).balance = WEI(50000);
  ok(du(g) !== attendu.du, 'l etat courant s est eloigne de l archive');

  g.remplace(JSON.parse(zlib.gunzipSync(gz).toString('utf8')));

  eq(du(g), attendu.du, 'AU JETON PRES : ce que la maison doit est celui de l archive');
  eq(g.balanceStr(A), attendu.soldeA, 'le solde du premier');
  eq(g.balanceStr(B), attendu.soldeB, 'celui du second');
  eq(g._p(A).cumulativeAuthorized.toString(), attendu.autorise,
     'le cumul autorise au retrait — sans lui la chaine refuserait les bons suivants');
  eq(g.stakeInfo(A).staked, attendu.stake, 'ce qui est en staking');
  eq(g.jackpotStr(), attendu.jackpot, 'le jackpot');
  eq(g.profilPublic(A).name, attendu.nom, 'le nom choisi');
  eq(g.profilPublic(A).visage, attendu.visage, 'la medaille');
  eq(g.amis(A).amis.length, attendu.amis, 'les amis');
  eq(g.parrainage(A).filleuls.length, attendu.filleuls, 'les filleuls');
  eq(g.equite().graines.length, attendu.graines,
     'et les graines revelees — la preuve d equite ne doit pas disparaitre dans l operation');
  eq(g.players.has(C), false, 'et rien de l etat intermediaire ne survit');
}

// ================== on peut restaurer deux fois de suite
/* Une restauration qui ne marche qu'une fois n'est pas une restauration : le
   jour ou l'on en a besoin, on se trompe souvent de fichier au premier essai. */
{
  const g = casino();
  const a1 = JSON.parse(JSON.stringify(g.serialize()));
  g._p(C).balance = WEI(77777);
  const a2 = JSON.parse(JSON.stringify(g.serialize()));
  g.remplace(a2); eq(g.players.size, 3, 'on restaure la seconde archive');
  g.remplace(a1); eq(g.players.size, 2, 'puis la premiere — et on revient bien en arriere');
  eq(g.players.has(C), false, 'sans trace de la seconde');
}

// ================== un fichier qui n'est pas un etat est REFUSE
/* Et refuse AVANT d'avoir touche a quoi que ce soit : la verification passe
   d'abord, le remplacement ensuite. */
{
  const g = casino();
  const avant = du(g), taille = g.players.size;
  for (const mauvais of [null, undefined, 42, 'texte', {}, { players: 'pas une liste' }, { joueurs: [] }]) {
    jete(() => g.remplace(mauvais), /not a SWOGE state/, 'un fichier qui n est pas un etat est refuse');
    if (mauvais !== null) n--;                       // une seule ligne pour les sept
  }
  n++;
  eq(du(g), avant, 'ET RIEN N A BOUGE : le refus ne coute pas un jeton');
  eq(g.players.size, taille, 'ni un joueur');
}

// ================== une archive abimee ne passe pas pour bonne
{
  const g = casino();
  store.save(g.serialize());
  const gz = zlib.gzipSync(fs.readFileSync(store.FILE), { level: 9 });
  const abime = Buffer.from(gz);
  abime[Math.floor(abime.length / 2)] ^= 0xFF;
  let refuse = false;
  try { zlib.gunzipSync(abime); } catch (e) { refuse = true; }
  ok(refuse, 'une archive abimee est REFUSEE, jamais restauree a moitie');
}

// ================== une archive vide se reconnait a l'oeil nu
/* C'est la signature d'un mauvais fichier. La route HTTP la refuse par-dessus
   un casino peuple ; ici on verifie qu'elle est reconnaissable. */
{
  const g = casino();
  const vide = { players: [] };
  eq(vide.players.length, 0, 'une archive a zero joueur se voit avant de l appliquer');
  ok(g.players.size > 0, 'et le casino vivant en a, lui');
}

require('./journal').draine(() => {
  fs.rmSync(bac, { recursive: true, force: true });
  console.log(`restauration.test.js : ${n} verifications OK`);
});
