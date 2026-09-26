'use strict';
/* ============================================================================
 * SERIES ET PUBS (studio_production.js)
 *
 * Ce qui compte pour le proprietaire : « que la voix et les personnages soient
 * les memes a chaque scene ». L'essai mesure donc :
 *   1. une production mal formee est refusee avec une raison lisible (mode,
 *      titre, personnage sans image, voix inconnue, trop de personnages, noms
 *      en double, pub sans produit ou sans photo) ;
 *   2. les MEMES references partent dans le MEME ordre a chaque scene, et le
 *      prompt nomme chaque personnage par sa <IMAGE_n> et sa <AUDIO_n> ;
 *   3. une voix partagee par deux personnages n'occupe qu'une place ;
 *   4. la pub nomme le produit <IMAGE_1>, le presentateur, le decor, le slogan ;
 *   5. les images sont rangees, reprises seulement par l'adresse qui les a
 *      rangees, effacees avec la derniere production qui les designe ;
 *   6. persistance par adresse, plafonds, scenes notees.
 * Aucun appel sortant.
 * ==========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./studio_production');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-'));
const ALICE = '0x' + 'a'.repeat(40), BOB = '0x' + 'b'.repeat(40);
const PNG = 'data:image/png;base64,' + Buffer.alloc(64, 7).toString('base64');
const JPG = 'data:image/jpeg;base64,' + Buffer.alloc(64, 9).toString('base64');
const imageOk = (x) => /^data:image\/(png|jpeg|webp);base64,/.test(x);
const voixOk = (v) => ['eve', 'ara', 'rex', 'sal', 'leo'].includes(v);
const S = P.cree({ dossier, maintenant: () => 1000 });
const outils = (addr) => ({ image: S.outilImage(addr, imageOk), voixOk });

const serie = (ps, plus) => Object.assign({ mode: 'serie', titre: 'Gym Wars', personnages: ps }, plus || {});

(async () => {
  console.log('-- 1. ce qui est refuse, avec sa raison --');
  {
    const v = (p) => P.valide(p, outils(ALICE)).erreur || null;
    ok(/mode/.test(v({ mode: 'film', titre: 'x' })), 'un mode inconnu');
    ok(/title/.test(v({ mode: 'serie', titre: '  ' })), 'sans titre');
    ok(/at least one/.test(v(serie([]))), 'une serie sans personnage');
    ok(/reference image/.test(v(serie([{ nom: 'Rex' }]))), 'un personnage sans image : il ne resterait pas le meme');
    ok(/PNG, JPEG or WebP/.test(v(serie([{ nom: 'Rex', image: 'data:image/gif;base64,AAAA' }]))), 'une image qui n est pas PNG/JPEG/WebP');
    ok(/unknown voice/.test(v(serie([{ nom: 'Rex', image: PNG, voix: 'darth' }]))), 'une voix hors catalogue');
    ok(/at most 3/.test(v(serie([1, 2, 3, 4].map((i) => ({ nom: 'C' + i, image: 'swoge' }))))), 'quatre personnages : le modele en garde trois');
    ok(/same name/.test(v(serie([{ nom: 'Rex', image: 'swoge' }, { nom: 'rex', image: 'swoge' }]))), 'deux personnages du meme nom (la casse ne compte pas)');
    ok(/product name/.test(v({ mode: 'pub', titre: 'Ad', produit: { image: PNG } })), 'une pub sans nom de produit');
    ok(/photo of the product/.test(v({ mode: 'pub', titre: 'Ad', produit: { nom: 'Shaker' } })), 'une pub sans photo du produit');
    ok(/name/.test(v(serie([{ image: 'swoge' }]))), 'un personnage sans nom');
  }

  console.log('\n-- 2. les memes references, dans le meme ordre, a chaque scene --');
  let prodSerie;
  {
    const p = P.valide(serie([
      { nom: 'SWOGE', image: 'swoge', voix: 'rex' },
      { nom: 'Luna', image: PNG, voix: 'EVE', description: 'a grey cat <script>' },
      { nom: 'Coach', image: JPG },
    ], { style: 'anime' }), outils(ALICE));
    ok(!p.erreur, 'une serie de trois personnages est valide');
    eq(p.format, '16:9', 'format par defaut d une serie : 16:9');
    ok(/muscular/.test(p.personnages[0].description), 'SWOGE sans description : le corps muscle est rappele (pas la tenue)');
    ok(!/[<>]/.test(p.personnages[1].description), 'les chevrons sont retires du texte');
    ok(p.personnages[1].image.startsWith(P.IMAGE_PREFIXE) && p.personnages[1].voix === 'eve', 'l image est rangee chez nous, la voix mise en minuscules');
    const a = P.scene(p, 'SWOGE lifts. Luna says "Not bad."', 10);
    const b = P.scene(p, 'Coach shouts at SWOGE.', 10);
    eq(JSON.stringify(a.references), JSON.stringify(b.references), 'deux scenes : exactement les memes references');
    eq(JSON.stringify(a.voix), JSON.stringify(b.voix), 'et exactement les memes voix');
    eq(a.references.join(','), ['swoge', p.personnages[1].image, p.personnages[2].image].join(','), 'dans l ordre des personnages');
    eq(a.voix.join(','), 'rex,eve', 'le personnage sans voix n occupe pas de place audio');
    ok(/SWOGE is the character in <IMAGE_1>[^;]*<AUDIO_0>/.test(a.prompt) && /Luna is the character in <IMAGE_2>[^;]*<AUDIO_1>/.test(a.prompt), 'le prompt nomme chacun par son image et sa voix');
    ok(/Coach is the character in <IMAGE_3>/.test(a.prompt) && !/Coach[^;]*<AUDIO/.test(a.prompt), 'et le personnage muet sans voix');
    ok(/Visual style: anime/.test(a.prompt) && /Only characters named in the scene appear/.test(a.prompt), 'le style et la regle des absents');
    ok(/describe the scene/.test(P.scene(p, '  ').erreur), 'une scene vide est refusee');
    prodSerie = p;
  }

  console.log('\n-- 3. une voix partagee n occupe qu une place --');
  {
    const p = P.valide(serie([{ nom: 'A', image: 'swoge', voix: 'leo' }, { nom: 'B', image: 'swoge', voix: 'leo' }]), outils(ALICE));
    const s = P.scene(p, 'A and B talk.');
    eq(s.voix.join(','), 'leo', 'une seule voix envoyee');
    ok(/A is the character in <IMAGE_1>[^;]*<AUDIO_0>/.test(s.prompt) && /B is the character in <IMAGE_2>[^;]*<AUDIO_0>/.test(s.prompt), 'les deux la designent par <AUDIO_0>');
  }

  console.log('\n-- 4. la pub --');
  {
    const p = P.valide({ mode: 'pub', titre: 'Shaker launch', produit: { nom: 'Swole Shaker', image: PNG, presentateur: 'swoge', presentateurNom: 'SWOGE',
      decor: JPG, voix: 'ara', slogan: 'Shake it swole', appel: 'Order at swoleeswoge.dog' } }, outils(ALICE));
    ok(!p.erreur, 'une pub complete est valide');
    eq(p.format, '9:16', 'format par defaut d une pub : vertical');
    const s = P.scene(p, '', 12);
    eq(s.references.length, 3, 'produit, presentateur, decor');
    eq(s.references[1], 'swoge', 'le presentateur en deuxieme');
    ok(/12-second advertisement for "Swole Shaker", the product in <IMAGE_1>/.test(s.prompt), 'le produit est <IMAGE_1>, la duree dite');
    ok(/presenter, SWOGE, is the character in <IMAGE_2>[^.]*<AUDIO_0>/.test(s.prompt), 'le presentateur, sa voix');
    ok(/setting is the place in <IMAGE_3>/.test(s.prompt) && /"Shake it swole" is said aloud/.test(s.prompt) && /call to action: "Order at swoleeswoge.dog"/.test(s.prompt), 'decor, slogan, appel');
    const q = P.valide({ mode: 'pub', titre: 'Ad', produit: { nom: 'Cap', image: PNG, voix: 'sal' } }, outils(ALICE));
    const s2 = P.scene(q, 'On a beach.');
    ok(/voice-over with the voice from <AUDIO_0>/.test(s2.prompt) && s2.references.length === 1, 'sans presentateur : une voix off, une seule image');
  }

  console.log('\n-- 5. les images : a qui elles sont, quand elles partent --');
  {
    const img = prodSerie.personnages[1].image;
    ok(S.litImage(img.slice(P.IMAGE_PREFIXE.length)) && S.litImage(img.slice(P.IMAGE_PREFIXE.length)).type === 'image/png', 'l image rangee se relit, avec son type');
    eq(S.litImage('../../etc/passwd'), null, 'un nom qui sort du dossier : rien');
    ok(/PNG, JPEG or WebP/.test(P.valide(serie([{ nom: 'X', image: img }]), outils(BOB)).erreur), 'Bob ne peut pas reprendre une image rangee par Alice');
    ok(!P.valide(serie([{ nom: 'X', image: img }]), outils(ALICE)).erreur, 'Alice, si');
    /* une validation qui echoue en chemin a deja range la premiere image : le menage l efface */
    const avant = fs.readdirSync(path.join(dossier, 'images')).length;
    ok(/unknown voice/.test(P.valide(serie([{ nom: 'A', image: JPG }, { nom: 'B', image: 'swoge', voix: 'darth' }]), outils(ALICE)).erreur), 'une serie refusee au deuxieme personnage');
    eq(fs.readdirSync(path.join(dossier, 'images')).length, avant + 1, 'la premiere image a ete rangee en chemin (le menage, en 6, l efface)');
  }

  console.log('\n-- 6. persistance, plafonds, scenes --');
  {
    const r = S.pose(ALICE, prodSerie);
    ok(r.ok && r.production.id && r.production.scenes.length === 0, 'une production posee a un id et aucune scene');
    const id = r.production.id;
    /* la route valide puis pose sans rien attendre entre les deux ; apres un refus, elle fait le menage */
    const nb = () => fs.readdirSync(path.join(dossier, 'images')).length;
    const avant = nb();
    eq(S.menage(ALICE) >= 2, true, 'le menage efface les images que rien ne designe (celles des validations refusees ou jamais posees)');
    ok(nb() < avant && prodSerie.personnages.every((c) => c.image === 'swoge' || S.litImage(c.image.slice(P.IMAGE_PREFIXE.length))), 'et garde toutes celles de la production posee');
    eq(S.liste(BOB).length, 0, 'Bob ne voit rien des productions d Alice');
    eq(S.une(BOB, id), null, 'ni par son id');
    ok(S.noteScene(ALICE, id, { id: 's1', texte: 'x', statut: 'pending' }) && S.noteScene(ALICE, id, { id: 's1', statut: 'done', url: 'https://v' }), 'une scene notee puis mise a jour');
    const u = S.une(ALICE, id);
    ok(u.scenes.length === 1 && u.scenes[0].statut === 'done' && u.scenes[0].texte === 'x', 'une seule scene, fusionnee');
    const S2 = P.cree({ dossier });
    eq(S2.une(ALICE, id).titre, 'Gym Wars', 'relue par une autre instance (le fichier, pas la memoire)');
    eq(S.pose(ALICE, prodSerie, 'inconnu').code, 404, 'remplacer une production inconnue : 404');
    /* remplacer : les scenes restent, l image abandonnee part */
    const vieille = prodSerie.personnages[2].image;
    const neuve = P.valide(serie([{ nom: 'SWOGE', image: 'swoge', voix: 'rex' }, { nom: 'Luna', image: prodSerie.personnages[1].image }]), outils(ALICE));
    const r2 = S.pose(ALICE, neuve, id);
    ok(r2.ok && r2.production.scenes.length === 1 && r2.production.id === id, 'remplacee : meme id, scenes gardees');
    eq(S.litImage(vieille.slice(P.IMAGE_PREFIXE.length)), null, 'l image du personnage retire est effacee');
    ok(S.litImage(prodSerie.personnages[1].image.slice(P.IMAGE_PREFIXE.length)), 'celle qui reste designee est gardee');
    eq(S.supprime(BOB, id).code, 404, 'Bob ne supprime pas la production d Alice');
    ok(S.supprime(ALICE, id).ok && S.liste(ALICE).every((p) => p.id !== id), 'Alice la supprime');
    const pub = S.liste(ALICE).length;
    eq(pub, 0, 'plus rien');
    for (let i = 0; i < P.PRODUCTIONS_MAX; i++) S.pose(ALICE, P.valide(serie([{ nom: 'S', image: 'swoge' }]), outils(ALICE)));
    eq(S.pose(ALICE, P.valide(serie([{ nom: 'S', image: 'swoge' }]), outils(ALICE))).code, 400, 'au-dela de ' + P.PRODUCTIONS_MAX + ' productions : refuse');
  }

  fs.rmSync(dossier, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
