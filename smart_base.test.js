'use strict';
/*
 * La base du detecteur smart money (smart_base.js, sql.js 1.14.2, 13/10/2026).
 * L'intention :
 *  - les montants restent EXACTS (TEXT) : 1e27 et un gain negatif au wei pres ;
 *  - sauvegarde atomique : jamais de fichier a moitie ecrit, la base rouverte
 *    est celle d'avant (et une sauvegarde sans changement n'ecrit rien) ;
 *  - export() ferme et rouvre la base : les requetes suivantes marchent ;
 *  - migrations par user_version, jamais rejouees ;
 *  - une base illisible est mise de cote, jamais ecrasee ;
 *  - une transaction ratee ne laisse rien.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const SB = require('./smart_base');

let n = 0, rates = 0;
const ok = (c, m) => { if (c) n++; else { rates++; console.log('  RATE ' + m); } };
const egal = (a, b, m) => ok(a === b || String(a) === String(b), `${m} (lu ${a}, attendu ${b})`);

(async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-base-'));
  const f = path.join(dossier, 'sm', 'base.sqlite');
  console.log('-- 1. ouverture, schema, montants exacts --');
  let B = await SB.ouvre(f);
  egal(B.version(), SB.MIGRATIONS.length, 'schema a la derniere version');
  egal(B.versionAvant, 0, 'base neuve : version 0 avant migration');
  ok(!fs.existsSync(f), 'rien n\'est ecrit avant la premiere sauvegarde');
  const offre = 10n ** 27n + 7n, perte = -570075290399687548n;
  B.pose('jetons', { adresse: '0xaa', symbole: 'X', offre, statut: 'lu', recette: { signature: 'a' }, drapeaux: [{ type: 'sortie_de_dead', valeur: 973323411065236870n }] });
  B.pose('acheteurs', { jeton: '0xaa', wallet: '0xbb', rang: 1, entre: 3514124648352682654n, gain: perte, marques: [], cout_connu: false });
  const j = B.un('SELECT * FROM jetons WHERE adresse = ?', ['0xaa']);
  egal(BigInt(j.offre), offre, 'offre de 1e27 + 7 : exacte (TEXT)');
  egal(JSON.parse(j.drapeaux)[0].valeur, '973323411065236870', 'BigInt dans un objet JSON : en chaine, exact');
  const a = B.un('SELECT * FROM acheteurs WHERE wallet = ?', ['0xbb']);
  egal(BigInt(a.gain), perte, 'gain negatif au wei pres');
  egal(a.cout_connu, 0, 'booleen -> 0/1');
  /* lot du 14/10 : la decouverte historique a sa table (v3), un jeton juge une fois */
  B.pose('historique', { adresse: '0xcc', bloc: 57852996, pool: '0xdd', version: 2, statut: 'candidat', fdv: 21800, liq: 12944 });
  const hh = B.un('SELECT * FROM historique WHERE adresse = ?', ['0xcc']);
  egal(hh && hh.statut + ':' + hh.bloc + ':' + hh.liq, 'candidat:57852996:12944', 'table historique (migration v3) : statut, bloc de naissance, liquidite');
  /* 16/10 : le journal public (v4), une ligne par cle, sa mesure a cote */
  B.pose('publiques', { t: 1, publie_t: 1, cle: 'lancement:0xcc', genre: 'lancement', categorie: 'pons', verdict: 'vert', jeton: '0xcc', ref_prix: 0.000012, mesures: '{}' });
  const pq = B.un('SELECT * FROM publiques WHERE cle = ?', ['lancement:0xcc']);
  egal(pq && pq.categorie + ':' + pq.ref_prix + ':' + pq.fini, 'pons:0.000012:0', 'table publiques (migration v4) : categorie, prix de reference, mesure en cours');
  egal(SB.MIGRATIONS.length, 4, 'quatre versions de schema (v3 : historique, v4 : journal public)');
  B.meta('rotation', 3);
  egal(B.meta('rotation'), 3, 'meta : aller-retour');
  egal(B.meta('absent'), null, 'meta absente : null');

  console.log('-- 2. sauvegarde atomique --');
  ok(B.sauve(), 'sauvegarde : un fichier est ecrit');
  ok(fs.existsSync(f), 'le fichier existe');
  ok(!fs.readdirSync(path.dirname(f)).some((x) => /\.tmp$/.test(x)), 'aucun .tmp ne reste');
  const mt = fs.statSync(f).mtimeMs;
  ok(!B.sauve(), 'rien de change : pas de reecriture');
  egal(fs.statSync(f).mtimeMs, mt, 'meme fichier');
  B.ecris('UPDATE jetons SET symbole = ? WHERE adresse = ?', ['Y', '0xaa']);
  egal(B.un('SELECT symbole FROM jetons').symbole, 'Y', 'apres export() (qui ferme et rouvre), les requetes marchent');
  /* une coupure au milieu d'une ecriture : on simule le renommage qui n'a pas eu lieu */
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('coupure'); };
  let e = null; try { B.sauve(); } catch (x) { e = x; } finally { fs.renameSync = rename; }
  ok(e, 'la coupure est vue');
  for (const x of fs.readdirSync(path.dirname(f))) if (/\.tmp$/.test(x)) fs.unlinkSync(path.join(path.dirname(f), x));
  const B2 = await SB.ouvre(f);
  egal(B2.un('SELECT symbole FROM jetons').symbole, 'X', 'la base sur le disque est ENTIERE, celle d\'avant (X)');
  egal(B2.versionAvant, SB.MIGRATIONS.length, 'rouverte : aucune migration rejouee');
  B2.ferme();
  ok(B.sauve(), 'apres la coupure, la sauvegarde suivante passe');
  B.ferme();
  B = await SB.ouvre(f);
  egal(B.un('SELECT symbole FROM jetons').symbole, 'Y', 'la nouvelle valeur est la');

  console.log('-- 3. transaction : tout ou rien --');
  let e2 = null;
  try { B.transaction(() => { B.pose('wallets', { adresse: '0xcc', projets: 1 }); throw new Error('panne'); }); } catch (x) { e2 = x; }
  ok(e2 && !B.un('SELECT * FROM wallets WHERE adresse = ?', ['0xcc']), 'une transaction ratee ne laisse rien');
  B.transaction(() => { B.pose('wallets', { adresse: '0xcc', projets: 1 }); B.pose('wallets', { adresse: '0xdd', projets: 2 }); });
  egal(B.tous('SELECT * FROM wallets').length, 2, 'une transaction reussie ecrit tout');
  let e3 = null; try { B.pose('wallets; DROP TABLE jetons', { a: 1 }); } catch (x) { e3 = x; }
  ok(e3 && B.un('SELECT count(*) n FROM jetons').n === 1, 'un nom de table douteux est refuse');
  egal(B.un('SELECT count(*) n FROM alertes').n, 0, 'table des alertes presente');
  B.pose('alertes', { t: 1, genre: 'smart', cle: 'smart:0xaa', texte: 'x', envoye: 0 });
  B.pose('alertes', { t: 2, genre: 'smart', cle: 'smart:0xaa', texte: 'y', envoye: 1 });
  egal(B.tous('SELECT * FROM alertes').length, 1, 'une cle d\'alerte est unique (INSERT OR REPLACE la remplace, jamais deux)');
  B.ferme();

  console.log('-- 4. base illisible : mise de cote, jamais ecrasee --');
  fs.writeFileSync(f, 'ceci n\'est pas une base');
  const B3 = await SB.ouvre(f, { horloge: () => 42 });
  ok(B3.miseDeCote && fs.existsSync(B3.miseDeCote) && fs.readFileSync(B3.miseDeCote, 'utf8') === 'ceci n\'est pas une base', 'le fichier illisible est garde a cote (.illisible-42)');
  egal(B3.version(), SB.MIGRATIONS.length, 'une base neuve repart au bon schema');
  B3.ferme();

  console.log('-- 5. en memoire (essais) --');
  const M = await SB.ouvre(null);
  M.pose('meta', { cle: 'x', valeur: '1' });
  ok(!M.sauve(), 'sans fichier : sauve ne fait rien');
  M.ferme();

  fs.rmSync(dossier, { recursive: true, force: true });
  if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
  console.log(`smart_base.test.js : ${n} verifications OK`);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
