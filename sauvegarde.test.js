'use strict';
/*
 * La sauvegarde hors machine.
 *
 * ---- ce qu'on verifie, et pourquoi ce n'est pas l'envoi ----
 *
 * Qu'un fichier parte sur Telegram ne prouve rien. Une sauvegarde ne vaut que
 * par une chose : QU'ELLE SE RESTAURE. Le jour ou l'on en a besoin, on est
 * dans le pire moment possible — le volume a disparu, les joueurs attendent —
 * et c'est le pire moment pour decouvrir que l'archive est illisible, tronquee
 * ou incomplete.
 *
 * Ce test fait donc le chemin ENTIER : un casino avec des soldes, du staking,
 * des amis, du parrainage, des graines revelees et des comptes → l'archive
 * compressee → un serveur NEUF qui la relit → et chaque chiffre doit
 * correspondre, au jeton pres.
 */
const assert = require('assert');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-sauve-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './journal', './game', './store']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const { Game } = require('./game');
const store = require('./store');
const cfg = require('./config');
const ethers = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const WEI = (x) => ethers.utils.parseUnits(String(x), cfg.DECIMALS);
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/* Un casino qui a vecu : des soldes, du jeu, du staking, des amis, un
   parrainage, une graine revelee, des comptes. Une sauvegarde qui ne
   ramenerait qu'une partie de ca serait pire qu'aucune — on croirait avoir
   tout restaure. */
function casino() {
  const g = new Game();
  for (const a of [A, B]) { const p = g._p(a); p.balance = WEI(500000); p.hasDeposited = true; p.deposited = WEI(500000); }
  g.setPublicName(A, 'Le Costaud');
  g.setVisage(A, 'b3');
  g.amiDemande(A, B); g.amiAccepte(B, A);
  g.lieParrain(B, A);
  for (let i = 0; i < 30; i++) g.plinkoDrop(A, 1000, 12, 'medium');
  for (let i = 0; i < 10; i++) g.plinkoDrop(B, 500, 12, 'high');
  g.stake(A, '100000');
  g.tourneGraine();
  g.requestWithdraw(A, '20000');
  return g;
}

(async () => {
  const g = casino();
  store.save(g.serialize());

  // ---------- l'archive, exactement comme le serveur la fabrique
  const brut = fs.readFileSync(store.FILE);
  const gz = zlib.gzipSync(brut, { level: 9 });
  ok(gz.length < brut.length, `compressee : ${(brut.length / 1024).toFixed(1)} Ko → ${(gz.length / 1024).toFixed(1)} Ko`);
  ok(gz.length < 45 * 1024 * 1024, 'et sous la limite d un document Telegram (50 Mo)');

  // ---------- LE CONTROLE : un serveur NEUF la relit
  /* On repart de zero, comme apres un volume perdu : rien sur le disque, rien
     en memoire, juste l'archive. */
  const rendu = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  const g2 = new Game();
  g2.hydrate(rendu);

  eq(g2.players.size, g.players.size, 'tous les joueurs sont revenus');
  eq(g2.balanceStr(A), g.balanceStr(A), 'AU JETON PRES : le solde du premier');
  eq(g2.balanceStr(B), g.balanceStr(B), 'et celui du second');

  /* Un solde restaure ne suffit pas : tout ce qui EST de l'argent doit
     revenir, sinon on decouvre le trou des semaines plus tard. */
  eq(g2._p(A).cumulativeAuthorized.toString(), g._p(A).cumulativeAuthorized.toString(),
     'le cumul autorise au retrait — sans lui, la chaine refuserait les bons suivants');
  eq(ethers.utils.formatUnits(g2._stakedTotal(g2._p(A)), cfg.DECIMALS),
     ethers.utils.formatUnits(g._stakedTotal(g._p(A)), cfg.DECIMALS), 'ce qui est en staking');
  eq(g2.jackpotStr(), g.jackpotStr(), 'le jackpot en cours');
  eq(g2.fraisCumules.toString(), g.fraisCumules.toString(), 'et le tas a bruler');

  /* Et tout ce qui n'est pas de l'argent mais qu'un joueur reclamerait. */
  eq(g2.profilPublic(A).name, 'Le Costaud', 'le nom choisi');
  eq(g2.profilPublic(A).visage, 'b3', 'la medaille');
  eq(g2.amis(A).amis.length, 1, 'les amis');
  eq(g2.parrainage(A).filleuls.length, 1, 'les filleuls');
  eq(g2.equite().graines.length, 1, 'les graines revelees — la preuve d equite ne doit pas disparaitre');
  eq(g2.equite().graines[0].graine, g.equite().graines[0].graine, 'a l identique');
  eq(g2.comptes().revenu, g.comptes().revenu, 'et les comptes du mois');

  /* La somme due resume tout : si elle correspond, aucun joueur n'a rien
     perdu dans l'operation.
     ATTENTION au piege — elle NE PEUT PAS etre identique au wei pres, parce
     que le rendement du staking court entre les deux mesures. Ma premiere
     version comparait les deux totaux et echouait de 0,0000032 $SWOGE : le
     temps ecoule entre deux lignes de code. On compare donc a l'identique ce
     qui est fige, et a l'epsilon pres ce qui coule. */
  const a1 = g.owedBreakdown(), a2 = g2.owedBreakdown();
  eq(a2.balances.toString(), a1.balances.toString(), 'LES SOLDES : identiques au wei pres');
  eq(a2.staked.toString(), a1.staked.toString(), 'ce qui est en staking : identique');
  eq(a2.jackpot.toString(), a1.jackpot.toString(), 'le jackpot : identique');
  const ecart = Number(ethers.utils.formatUnits(a2.pending.sub(a1.pending).abs(), cfg.DECIMALS));
  ok(ecart < 0.001,
     `le rendement en cours ne differe que du temps ecoule entre les deux mesures (${ecart.toExponential(1)})`);

  // ---------- une archive abimee ne doit pas passer pour bonne
  /* Un octet change au milieu : gunzip doit refuser. C'est ce qui garantit
     qu'on ne restaure jamais a moitie sans le savoir. */
  const abime = Buffer.from(gz);
  abime[Math.floor(abime.length / 2)] ^= 0xFF;
  let refuse = false;
  try { zlib.gunzipSync(abime); } catch (e) { refuse = true; }
  ok(refuse, 'une archive abimee est REFUSEE, pas restauree a moitie');

  // ---------- sans canal prive configure, rien ne part
  /* L'etat porte les adresses et les soldes de tout le monde. Mieux vaut
     aucune sauvegarde qu'une sauvegarde publiee par erreur : ca ne se
     rattrape pas. */
  const tg = require('./telegram');
  const envoye = await tg.sendDocument(gz, 'test.gz', 'essai');
  eq(envoye, false, 'sans TG_BACKUP_CHAT_ID, aucun fichier ne quitte la machine');

  require('./journal').draine(() => {
    fs.rmSync(bac, { recursive: true, force: true });
    console.log(`sauvegarde.test.js : ${n} verifications OK`);
  });
})().catch((e) => { console.error('ECHEC', e); process.exit(1); });
