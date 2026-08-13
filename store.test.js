'use strict';
/*
 * La persistance des soldes.
 *
 * C'est le fichier qui porte l'argent des joueurs. Les verifications qui
 * comptent ne sont pas « ca ecrit et ca relit » — c'est ce qui se passe quand
 * ca se passe MAL :
 *
 *   • le fichier est tronque a moitie ;
 *   • le fichier est vide ;
 *   • le volume n'est pas monte et le fichier a disparu ;
 *   • le serveur, ayant mal lu, veut ecrire un etat vide par-dessus.
 *
 * Le dernier cas est celui qui efface un casino entier. Il doit etre refuse.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-store-'));
process.env.DATA_DIR = bac;
delete require.cache[require.resolve('./config')];
delete require.cache[require.resolve('./store')];
let store = require('./store');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

/** On recharge le module pour repartir d'une memoire vierge, comme un vrai demarrage. */
function redemarre() {
  delete require.cache[require.resolve('./store')];
  store = require('./store');
}
const etat = (joueurs) => ({
  players: Array.from({ length: joueurs }, (_, i) => [`0x${String(i).padStart(40, '0')}`, { b: '1000' }]),
  jackpot: '5000', seenTx: [], lastBlock: 42,
});

// ------------------------------------------------- premier demarrage
{
  eq(store.load(), null, 'aucun fichier : on part de zero, et c est normal');
  ok(store.save(etat(3)), 'la premiere sauvegarde passe');
  eq(store.load().players.length, 3, 'et se relit');
  eq(store.load().lastBlock, 42, 'avec tout son contenu');
}

// ------------------------------- LE CAS QUI EFFACE UN CASINO
/* Un demarrage rate lit mal, croit qu'il n'y a personne, et la sauvegarde
   automatique ecrase le bon fichier dix secondes plus tard. Le garde-fou doit
   refuser cette ecriture-la. */
{
  redemarre();
  eq(store.load().players.length, 3, 'trois joueurs en place');
  eq(store.save(etat(0)), false, 'ECRIRE ZERO JOUEUR PAR-DESSUS TROIS EST REFUSE');
  eq(store.load().players.length, 3, 'et les trois sont toujours la');
  ok(store.save(etat(0), { force: true }), 'une remise a zero VOULUE reste possible');
  eq(store.load().players.length, 0, 'et prend effet');
  ok(store.save(etat(3)), 'on remet les trois pour la suite');
}

// ------------------------------------------- un fichier tronque
/* Sans secours utilisable : c'est le cas ou il n'y a vraiment plus rien de
   lisible. La reprise par le secours est verifiee plus bas, a part. */
{
  redemarre();
  const brut = fs.readFileSync(store.FILE, 'utf8');
  try { fs.unlinkSync(store.BAK); } catch (e) {}
  fs.writeFileSync(store.FILE, brut.slice(0, Math.floor(brut.length / 2)));   // coupe en deux
  jete(() => store.load(), /impossible de lire/,
       'un fichier tronque ARRETE le serveur au lieu de le faire partir a vide');
  fs.writeFileSync(store.FILE, brut);
  eq(store.load().players.length, 3, 'le fichier reparé se relit');
}

// ------------------------------------------------- un fichier vide
{
  redemarre();
  const brut = fs.readFileSync(store.FILE, 'utf8');
  try { fs.unlinkSync(store.BAK); } catch (e) {}
  fs.writeFileSync(store.FILE, '');
  jete(() => store.load(), /impossible de lire/, 'un fichier vide aussi');
  fs.writeFileSync(store.FILE, brut);
}

// ---------------------------- le volume qui n'est pas encore monte
/* Le scenario Railway : le conteneur demarre, le dossier est vide parce que le
   volume arrive une seconde plus tard. Sans secours, c'est indistinguable d'un
   premier demarrage — donc on part de zero, et c'est correct. AVEC un fichier
   present mais vide, en revanche, on refuse. La difference tient a un fichier
   qui existe ou non, et c'est tout ce qu'on peut savoir. */
{
  redemarre();
  const brut = fs.readFileSync(store.FILE, 'utf8');
  fs.unlinkSync(store.FILE);
  try { fs.unlinkSync(store.BAK); } catch (e) {}
  eq(store.load(), null, 'dossier vide : premier demarrage, on ne refuse pas');
  fs.writeFileSync(store.FILE, brut);
}

// ------------------------------------------- la sauvegarde de secours
/* Elle n'est prise que toutes les cinq minutes : pour la verifier, on la pose
   a la main, comme le ferait une longue journee de jeu. */
{
  redemarre();
  fs.copyFileSync(store.FILE, store.BAK);
  fs.writeFileSync(store.FILE, '{ ceci n est pas du JSON');
  const r = store.load();
  ok(r && r.players.length === 3, 'le fichier principal casse, on repart du secours');
  ok(fs.existsSync(store.FILE + '.corrompu'), 'et le fichier casse est mis de cote, pas efface');
  // apres reprise, l'ecriture normale reprend son cours
  fs.renameSync(store.BAK, store.FILE);
  ok(store.save(etat(4)), 'et la sauvegarde repart');
  eq(store.load().players.length, 4, 'avec le nouvel etat');
}

// ------------------------------------ un etat invalide n'ecrase rien
{
  redemarre();
  eq(store.load().players.length, 4, 'quatre joueurs en place');
  eq(store.save(null), false, 'ecrire null est refuse');
  eq(store.save({}), false, 'ecrire un objet sans joueurs est refuse');
  eq(store.save({ players: 'pas un tableau' }), false, 'et un contenu du mauvais type aussi');
  eq(store.load().players.length, 4, 'les quatre sont intacts');
}

// ---------------------------------- l ecriture est reellement atomique
/* On ne peut pas couper le courant dans un test, mais on peut verifier ce qui
   le rend sur : aucun fichier temporaire ne survit a une ecriture reussie, et
   le fichier final est complet a la milliseconde ou il apparait. */
{
  redemarre();
  for (let i = 0; i < 20; i++) {
    ok(store.save(etat(5 + i)) === true, i === 0 ? 'vingt ecritures d affilee' : true);
    n -= (i === 0 ? 0 : 1);           // on ne compte la ligne qu une fois
    const relu = store.load();
    if (relu.players.length !== 5 + i) { ok(false, `ecriture ${i} incomplete`); break; }
  }
  ok(!fs.existsSync(store.FILE + '.tmp'), 'aucun fichier temporaire ne traine apres coup');
  eq(store.load().players.length, 24, 'et le dernier etat ecrit est bien celui qu on relit');
}

fs.rmSync(bac, { recursive: true, force: true });
console.log(`store.test.js : ${n} verifications OK`);
