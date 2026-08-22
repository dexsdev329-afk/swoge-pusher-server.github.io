'use strict';
/*
 * LE TROISIEME CRAN DU FAMILIER : LES POUVOIRS DE SOUTIEN.
 *
 * Au soixantieme niveau, chaque espece apprend un geste qui ne vise RIEN. Les
 * deux premiers crans agissent sur ce qui est en face — une creature, puis
 * toutes celles qui entourent. Celui-ci se pose sur le MAITRE.
 *
 * ---- ce qui compte, dans l'ordre ----
 *
 * 1. IL A SON PROPRE DELAI, ET C'EST LUI QUI TIENT L'EQUILIBRE. Sans lui, un
 *    compagnon de niveau cent aurait repose son soutien avant meme qu'il ne
 *    tombe — quatre secondes d'effet, trois de recharge — et il n'aurait plus
 *    jamais rien frappe. C'est exactement le piege qui avait force le plafond
 *    du bouclier de la terre.
 * 2. IL NE PART QUE S'IL Y A QUELQUE CHOSE A COMBATTRE. Un soutien lance dans
 *    une clairiere vide aurait grille dix-huit secondes pour arriver au
 *    combat SANS — le contraire exact d'un pouvoir de preparation.
 * 3. UN SOUTIEN INUTILE NE COUTE PAS SON DELAI. Le mana deja plein, le
 *    bouclier deja pose : le compagnon retombe sur ses autres gestes en
 *    gardant ses dix-huit secondes pour le moment ou elles compteront.
 * 4. IL PASSE DEVANT, ET IL N'EN FAIT QU'UN. La promesse du systeme ne change
 *    pas d'un cran a l'autre : un seul geste par recharge.
 * 5. AVANT LE NIVEAU, IL N'EXISTE PAS.
 * 6. ET CHACUN FAIT CE QU'IL DIT. Six pouvoirs, six effets mesures sur le
 *    joueur lui-meme et pas sur ce qu'il annonce.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/famsout-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const monde = require('./monde');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };
const pres = (a, b, m, marge) => {
  assert.ok(Math.abs(a - b) <= (marge || 0.01), m + ` [${a} vs ${b}]`);
  n++; console.log('  ok   ' + m);
};

const fiche = (fam, niv, nom) => ({ skin: 'andy', nom: nom || 'Alice',
  stats: { att: 40, def: 10, spd: 30, dex: 30, vit: 30, wis: 20, hp: 500, mp: 100 },
  famille: 'lame', degats: [40, 60], fam: fam || null, famNiv: niv || 1 });

/* Une scene vide : un joueur, aucune creature. Le monde est peuple et tire au
   hasard — mesurer un soutien dedans reviendrait a mesurer le monde. */
function scene(fam, niv) {
  const R = new Realm({});
  const A = '0xaaa';
  R.rejoint(A, fiche(fam, niv));
  const j = R.joueurs.get(A);
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  return { R, A, j };
}
function poseMonstre(R, j, dx, dy, pv) {
  const espece = Object.keys(monde.MONSTRES)[0];
  const m = { id: R._nouvelId(), espece, biome: null, x: j.x + dx, y: j.y + dy,
              ancreX: j.x + dx, ancreY: j.y + dy,
              pv: pv || 100000, pvMax: pv || 100000, dir: 'down', cible: null,
              recharge: 999, rechargeT: 999, stase: 0,
              feu: 0, feuReste: 0, feuTaux: 0, feuPar: null,
              errX: 0, errY: 0, errChrono: 0 };
  R.monstres.push(m);
  return m;
}
function avance(R, secondes) {
  const evs = [];
  for (let t = 0; t < secondes; t += 0.1) evs.push(R.pas(0.1));
  return evs;
}
const gestes = (evs, quoi) => evs.flatMap((e) => (e.fam || []))
  .filter((f) => !quoi || f.quoi === quoi);

/* ---- TOUT VIENT DU MONDE, RIEN N'EST RECOPIE ICI ----
 * Le cran, le delai, le rayon et la liste des six : les ecrire en dur ferait
 * passer l'essai le jour ou l'on decale le systeme, et c'est justement ce
 * jour-la qu'on veut qu'il parle. */
const CRAN = monde.POUVOIRS_PAR_ESPECE.normal.find(
  (p) => monde.POUVOIRS_SOUTIEN.has(p.cle)).niveau;
const DELAI = monde.FAMILIERS.soutienDelai;
const RAYON = monde.FAMILIERS.zoneRayon;
/* La table espece -> cle de soutien se DEDUIT elle aussi. Une liste recopiee
   ici aurait continue d'essayer `elan` le jour ou le chien change de geste. */
const SOUTIEN = {};
for (const [espece, liste] of Object.entries(monde.POUVOIRS_PAR_ESPECE)) {
  const p = liste.find((x) => monde.POUVOIRS_SOUTIEN.has(x.cle));
  if (p) SOUTIEN[espece] = p.cle;
}

console.log('-- le cran, tel que le monde le definit --');
eq(Object.keys(SOUTIEN).length, 6, 'les six especes ont un soutien');
ok(Object.values(SOUTIEN).every((c) => monde.POUVOIRS_SOUTIEN.has(c)),
   `et ce sont bien les six de la liste (${Object.values(SOUTIEN).join(', ')})`);
ok(monde.POUVOIRS_PAR_ESPECE.normal.every((p) => p.niveau <= CRAN),
   `le soutien est le DERNIER cran ouvert (niveau ${CRAN})`);
/* Le delai doit etre plus long que la plus courte des recharges, sinon le
   soutien se reposerait avant d'etre tombe et le compagnon ne frapperait
   plus jamais. C'est la condition qui justifie l'existence du delai. */
ok(DELAI > monde.rechargeFamilier(monde.FAMILIERS.niveauMax),
   `et son delai (${DELAI}s) depasse la recharge la plus courte `
   + `(${monde.rechargeFamilier(monde.FAMILIERS.niveauMax)}s)`);

/* ================== 1. AVANT LE CRAN, IL N'EXISTE PAS ================== */
console.log('\n-- au niveau juste en dessous, rien de neuf --');
{
  const { R, j } = scene('normal', CRAN - 1);
  poseMonstre(R, j, 40, 0);
  const evs = avance(R, 1.0);
  eq(gestes(evs, SOUTIEN.normal).length, 0, 'aucun soutien');
  ok(gestes(evs).length > 0, 'mais il agit quand meme — il a ses autres gestes');
  eq(j.rafale, 0, 'et rien ne s est pose sur le joueur');
}
console.log('\n-- au niveau du cran, il existe --');
{
  const { R, j } = scene('normal', CRAN);
  poseMonstre(R, j, 40, 0);
  const evs = avance(R, 0.5);
  eq(gestes(evs, SOUTIEN.normal).length, 1, 'il prepare son maitre');
  ok(j.rafale > 0, 'et l effet est bien pose sur lui');
}

/* ================== 2. IL FAUT QUELQUE CHOSE A COMBATTRE ================== */
console.log('\n-- dans une clairiere vide, il garde son soutien --');
{
  const { R, j } = scene('normal', 100);
  const evs = avance(R, 3.0);        // aucune creature posee
  eq(gestes(evs, SOUTIEN.normal).length, 0, 'il ne prepare personne pour rien');
  eq(j.famSoutienR, 0, 'et son delai n a pas commence a courir');
  /* Le vrai enjeu : il doit etre pret a l INSTANT ou le combat arrive. Un
     soutien grille dans le vide serait arrive juste avant de ne plus servir. */
  poseMonstre(R, j, 40, 0);
  ok(gestes(avance(R, 0.5), SOUTIEN.normal).length === 1,
     'et il part des la premiere creature, sans attendre');
}
console.log('\n-- et il compte dans SON rayon, pas dans la portee --');
{
  const { R, j } = scene('normal', 100);
  const E = monde.pouvoirsDe('normal', 100).find((p) => p.soutien).effet;
  eq(E.rayon, RAYON, 'le soutien annonce le rayon de zone');
  ok(E.rayon < E.portee,
     `qui est plus court que la portee de ce qui vise (${E.rayon} < ${E.portee})`);
  /* Une creature entre les deux : elle est a portee d'une morsure mais hors
     du rayon du soutien. Compter dans la portee aurait fait preparer le
     maitre pour un monstre que le soutien ne concerne pas. */
  poseMonstre(R, j, (E.rayon + E.portee) / 2, 0);
  const evs = avance(R, 0.5);
  eq(gestes(evs, SOUTIEN.normal).length, 0, 'trop loin : pas de soutien');
  ok(gestes(evs, 'mord').length > 0, 'mais assez pres pour etre mordue');
}

/* ================== 3. LE DELAI, ET CE QU'IL EMPECHE ================== */
console.log('\n-- un seul soutien par delai --');
{
  const { R, j } = scene('normal', 100);
  poseMonstre(R, j, 40, 0);
  /* On tourne PLUS LONGTEMPS que le delai : le compte doit etre de deux, pas
     de « autant que de recharges ». A trois secondes de recharge et quatre
     secondes d'effet, l'absence de delai en donnerait sept sur cette fenetre.
     La fenetre laisse cinq secondes de marge de chaque cote du deuxieme : le
     delai et la recharge tombent a zero par soustractions successives de
     0,1 s, et coller a la seconde exacte ferait dependre l'essai d'un arrondi
     flottant plutot que de la regle. */
  const fenetre = DELAI + 5;
  const evs = avance(R, fenetre);
  const tous = gestes(evs);
  const sout = gestes(evs, SOUTIEN.normal);
  eq(sout.length, 2, `deux soutiens sur ${fenetre}s, pas un de plus`);
  ok(tous.length > sout.length * 3,
     `et le reste du temps il FRAPPE (${tous.length} gestes en tout)`);
  /* Le test qui compte vraiment : sans delai, il n'aurait fait que du
     soutien. On verifie donc que les gestes offensifs dominent. */
  ok(tous.filter((f) => !monde.POUVOIRS_SOUTIEN.has(f.quoi)).length
     > tous.filter((f) => monde.POUVOIRS_SOUTIEN.has(f.quoi)).length,
     'il frappe plus souvent qu il ne prepare');
}
console.log('\n-- le delai court meme pendant la recharge --');
{
  /* Au niveau d'ouverture : sa recharge vaut pres de cinq secondes, donc le
     compagnon ne peut PAS agir pendant la fenetre de deux secondes qui suit.
     Si le delai n'avancait qu'entre deux gestes, il ne bougerait pas. */
  const { R, j } = scene('normal', CRAN);
  poseMonstre(R, j, 40, 0);
  avance(R, 0.5);
  ok(j.famSoutienR > 0, 'le delai est pose');
  const avant = j.famSoutienR;
  avance(R, 2.0);
  pres(j.famSoutienR, avant - 2.0,
       'et il descend seconde par seconde, sans attendre la recharge', 0.15);
}

/* ================== 4. UN SOUTIEN INUTILE NE COUTE RIEN ================== */
console.log('\n-- ce qui ne sert a personne ne brule pas le delai --');
{
  /* Le legendaire beni : son bouclier tient deja. Il doit retomber sur son
     aura ou son soin SANS avoir consomme ses dix-huit secondes — sinon le
     troisieme cran resterait muet pendant des combats entiers, et rien ne le
     dirait. */
  const { R, j } = scene('legendaire', 100);
  poseMonstre(R, j, 40, 0);
  j.pv = j.pvMax - 200;
  const E = monde.pouvoirsDe('legendaire', 100).find((p) => p.soutien).effet;
  j.bouclier = E.duree;                 // il est deja beni
  j.bouclierPart = E.reduction;
  const evs = avance(R, 0.5);
  eq(gestes(evs, SOUTIEN.legendaire).length, 0, 'il ne repose pas ce qui tient');
  ok(gestes(evs).length > 0, 'mais il fait autre chose');
  eq(j.famSoutienR, 0, 'et son delai n a pas commence a courir');
}
console.log('\n-- mana plein : l emprise se tait --');
{
  const { R, j } = scene('tenebre', 100);
  poseMonstre(R, j, 40, 0);
  eq(j.mp, j.mpMax, 'le joueur part avec sa reserve pleine');
  const evs = avance(R, 0.5);
  eq(gestes(evs, 'emprise').length, 0, 'rien a verser, rien ne part');
  eq(j.famSoutienR, 0, 'et le delai reste entier');
  /* Des qu il manque du mana, elle part — sans avoir rien perdu a attendre. */
  j.mp = 10;
  ok(gestes(avance(R, 4.0), 'emprise').length === 1, 'elle part des qu il manque du mana');
}

/* ================== 5. IL PASSE DEVANT, ET IL N'EN FAIT QU'UN ============= */
console.log('\n-- il prepare AVANT de frapper --');
{
  const { R, j } = scene('normal', 100);
  /* Assez de creatures pour que la zone soit preferee a la cible unique : le
     soutien doit passer devant les DEUX, pas seulement devant la morsure. */
  for (let i = 0; i < monde.FAMILIERS.zoneMini + 2; i++) poseMonstre(R, j, 40 + i * 10, 0);
  const evs = avance(R, 0.15);
  const tous = gestes(evs);
  eq(tous.length, 1, 'un seul geste sur la premiere recharge');
  eq(tous[0].quoi, SOUTIEN.normal, 'et c est le soutien');
  /* La preuve que ce n'est pas un cumul : la promesse du systeme est qu'il
     n'agit qu'une fois par recharge, et elle ne change pas d'un cran a
     l'autre. */
  ok(!tous.some((f) => f.quoi === 'meute' || f.quoi === 'mord'),
     'il n a rien frappe en meme temps');
}
console.log('\n-- puis il frappe, sans avoir perdu son tour --');
{
  const { R, j } = scene('normal', 100);
  for (let i = 0; i < monde.FAMILIERS.zoneMini + 2; i++) poseMonstre(R, j, 40 + i * 10, 0);
  const evs = avance(R, 6.0);
  ok(gestes(evs, 'meute').length > 0, 'la zone repart derriere le soutien');
}

/* ================== 6. CHACUN FAIT CE QU'IL DIT ================== */
/* On mesure sur le JOUEUR, jamais sur ce que l'evenement annonce : un
   evenement qui promet un effet que le serveur n'applique pas est exactement
   le bug que ce fichier doit attraper. */

console.log('\n-- normal : l elan presse le tir --');
{
  const { R, j } = scene('normal', 100);
  poseMonstre(R, j, 40, 0);
  const E = monde.pouvoirsDe('normal', 100).find((p) => p.soutien).effet;
  const a = R.etatPour('0xaaa');
  avance(R, 0.15);
  const b = R.etatPour('0xaaa');
  pres(j.rafale, E.duree, 'la rafale est posee pour la duree annoncee', 0.15);
  eq(j.rafalePart, E.facteur, 'avec le facteur du COMPAGNON, pas celui du fruit');
  ok(E.facteur < monde.POUVOIRS.rafale.facteur,
     `qui est plus faible — le fruit se paie, l elan est gratuit `
     + `(${E.facteur.toFixed(2)} < ${monde.POUVOIRS.rafale.facteur})`);
  ok(b.moi.c > a.moi.c,
     `et la cadence annoncee au client monte (${a.moi.c} -> ${b.moi.c})`);
  /* Le fruit ECRASE l elan : un joueur qui vient de payer quarante-cinq de
     mana ne doit pas se retrouver RALENTI par son propre compagnon. */
  R.pouvoir('0xaaa', { touches: [], kills: [] });
  if (j.pouvoir === 'rafale') {
    eq(j.rafalePart, monde.POUVOIRS.rafale.facteur, 'et le fruit reprend la main dessus');
  }
}
console.log('\n-- feu : l ardeur fait porter les coups du maitre --');
{
  const E = monde.pouvoirsDe('feu', 100).find((p) => p.soutien).effet;
  /* ---- ON MESURE SUR UN JOUEUR SANS COMPAGNON ----
   * Le familier de feu BRULE, et la brulure est un degat par seconde qui
   * n'est pas multiplie par l'ardeur — a juste titre. La laisser courir
   * pendant la mesure aurait melange deux sources dans un seul chiffre, et le
   * rapport mesure n'aurait plus rien dit de l'ardeur.
   *
   * Deux scenes identiques, une seule difference. Un « avant/apres » sur une
   * seule scene aurait melange l'ardeur au tirage de l'arme, qui varie a
   * chaque coup — on le fige aussi, pour la meme raison. */
  const coup = (avecArdeur) => {
    const { R, j } = scene(null, 1);
    R.alea = () => 0.5;
    const m = poseMonstre(R, j, 30, 0);
    if (avecArdeur) { j.ardeur = 99; j.ardeurPart = E.part; }
    const pv = m.pv;
    R.tire('0xaaa', 0);
    avance(R, 1.0);
    return pv - m.pv;
  };
  const sans = coup(false), avec = coup(true);
  ok(sans > 0, `le coup nu porte (${sans})`);
  ok(avec > sans, `et avec l ardeur il porte plus fort (${sans} -> ${avec})`);
  pres(avec / sans, 1 + E.part, 'exactement de ce que l ardeur annonce', 0.02);

  /* ---- LA LIMITE QUI TIENT TOUT L EQUILIBRE ----
   * Elle ne multiplie PAS le compagnon. Sans cette limite, l'ardeur aurait
   * multiplie la brulure et le brasier en meme temps que l'arme, et trois
   * sources qui se multiplient entre elles ne se reglent plus.
   * On ne tire PAS ici : seul le compagnon travaille. */
  const brulure = (avecArdeur, combien) => {
    const { R, j } = scene('feu', 100);
    j.famSoutienR = DELAI;                    // pas de preparation dans la mesure
    const ms = [];
    for (let i = 0; i < combien; i++) ms.push(poseMonstre(R, j, 30 + i * 10, 0));
    if (avecArdeur) { j.ardeur = 99; j.ardeurPart = E.part; }
    avance(R, 1.0);
    return ms.reduce((t, m) => t + (m.pvMax - m.pv), 0);
  };
  /* UNE creature : il choisit sa brulure a cible unique. */
  const nu = brulure(false, 1);
  ok(nu > 0, `le compagnon brule tout seul (${nu})`);
  eq(brulure(true, 1), nu, 'et l ardeur ne change rien a sa brulure');
  /* ASSEZ de creatures pour qu'il prefere son brasier. La brulure de zone est
     une SECONDE branche du meme effet : un `_attise` glisse dans l'une des
     deux serait passe inapercu si l'essai ne mesurait que l'autre. */
  const NB = monde.FAMILIERS.zoneMini + 1;
  const enZone = brulure(false, NB);
  ok(enZone > nu, `son brasier brule ${NB} creatures (${enZone} au total)`);
  eq(brulure(true, NB), enZone, 'et l ardeur ne change rien a son brasier');

  /* ---- ET SUR SES GESTES DE ZONE NON PLUS ----
   * La fuite la plus facile a laisser passer : la brulure ci-dessus est un
   * geste a CIBLE UNIQUE, et un `_attise` glisse dans une branche de zone
   * serait passe inapercu. On mesure donc aussi une meute — assez de
   * creatures pour que le compagnon la prefere, et des degats directs qui se
   * comptent au point pres. */
  const ameute = (avecArdeur) => {
    const { R, j } = scene('normal', 100);
    j.famSoutienR = DELAI;
    const ms = [];
    for (let i = 0; i < monde.FAMILIERS.zoneMini + 1; i++) ms.push(poseMonstre(R, j, 40 + i * 10, 0));
    if (avecArdeur) { j.ardeur = 99; j.ardeurPart = E.part; }
    const evs = avance(R, 0.15);
    ok(gestes(evs, 'meute').length === 1, avecArdeur
      ? 'le compagnon ameute, l ardeur posee' : 'le compagnon ameute');
    return ms.reduce((t, m) => t + (m.pvMax - m.pv), 0);
  };
  const large = ameute(false);
  ok(large > 0, `sa meute mord (${large} au total)`);
  eq(ameute(true), large, 'et l ardeur ne change rien a sa meute non plus');
}

console.log('\n-- glace : le givre efface et immunise --');
{
  const { R, j } = scene('glace', 100);
  poseMonstre(R, j, 40, 0);
  const E = monde.pouvoirsDe('glace', 100).find((p) => p.soutien).effet;
  /* On le pose EN PLEINE paralysie : c est le seul moment ou il compte, et
     c est la seule sortie du jeu contre une paralysie deja subie. */
  for (const cle of Object.keys(monde.EFFETS)) j[cle] = monde.EFFETS[cle].duree;
  j.brulReste = 0.9;
  avance(R, 0.15);
  for (const cle of Object.keys(monde.EFFETS)) {
    eq(j[cle], 0, `« ${cle} » est efface`);
    pres(j.immun[cle], E.duree, `et immunise pour la duree annoncee (${cle})`, 0.15);
  }
  eq(j.brulReste, 0, 'et le reste de degat de brulure part avec elle');
  /* L immunite ne doit jamais RETIRER de la protection : un joueur qui en
     porte deja plus long garde la sienne. */
  const s2 = scene('glace', 100);
  poseMonstre(s2.R, s2.j, 40, 0);
  s2.j.immun.paralyse = E.duree + 10;
  avance(s2.R, 0.15);
  ok(s2.j.immun.paralyse > E.duree,
     'et une immunite plus longue deja en place n est pas raccourcie');
}
console.log('\n-- terre : les racines accelerent la vie --');
{
  const E = monde.pouvoirsDe('terre', 100).find((p) => p.soutien).effet;
  /* ---- DIX SECONDES, ET PAS DEUX ----
   * La regeneration accumule en flottant et ne verse que les points ENTIERS.
   * Sur deux secondes, le joueur nu ne gagne que quatre points : le rapport
   * mesure depend alors de l'arrondi bien plus que du facteur. Sur dix, la
   * part perdue a l'arrondi devient negligeable et l'essai mesure enfin ce
   * qu'il annonce mesurer. */
  const remonte = (avecRacines) => {
    const { R, j } = scene('terre', 100);
    poseMonstre(R, j, 40, 0);
    j.famSoutienR = DELAI;                    // on choisit nous-memes le moment
    j.pv = 100; j.pvReste = 0;
    if (avecRacines) { j.racines = 99; j.racinesPart = E.part; }
    avance(R, 10.0);
    return j.pv - 100;
  };
  const sans = remonte(false), avec = remonte(true);
  ok(avec > sans, `la vie remonte plus vite (${sans} -> ${avec} points en 10s)`);
  pres(avec / sans, 1 + E.part, 'et du facteur annonce', 0.2);

  /* ---- LE MANA NE BOUGE PAS ----
   * C'est le travail de l'emprise, et un pouvoir qui rendrait les deux aurait
   * rendu l'autre inutile. Les deux scenes tournent EXACTEMENT le meme temps :
   * un pas d'ecart aurait suffi a faire croire a un effet. */
  const mana = (avecRacines) => {
    const { R, j } = scene('terre', 100);
    poseMonstre(R, j, 40, 0);
    j.famSoutienR = DELAI;
    j.pv = 100; j.mp = 10; j.mpReste = 0;
    if (avecRacines) { j.racines = 99; j.racinesPart = E.part; }
    avance(R, 10.0);
    return j.mp;
  };
  eq(mana(true), mana(false), 'et le mana remonte exactement comme sans elles');

  /* Et le compagnon les pose bien tout seul, sans qu'on l'aide. */
  const { R, j } = scene('terre', 100);
  poseMonstre(R, j, 40, 0);
  j.pv = 100;
  avance(R, 0.15);
  ok(j.racines > 0, 'le compagnon les pose de lui-meme quand son maitre est blesse');
  eq(j.racinesPart, E.part, 'avec le facteur annonce');
}

console.log('\n-- tenebre : l emprise rend du mana --');
{
  const { R, j } = scene('tenebre', 100);
  poseMonstre(R, j, 40, 0);
  const E = monde.pouvoirsDe('tenebre', 100).find((p) => p.soutien).effet;
  j.mp = 0; j.mpReste = 0;
  const evs = avance(R, 0.15);
  const g = gestes(evs, 'emprise')[0];
  ok(g, 'elle part');
  eq(j.mp, Math.round(j.mpMax * E.part), 'et verse la part annoncee du MAXIMUM');
  eq(g.mp, j.mp, 'l evenement dit exactement ce que le joueur a recu');
  /* Jamais au-dela du maximum : un mana qui deborderait ne se verrait pas et
     fausserait la barre. */
  const s2 = scene('tenebre', 100);
  poseMonstre(s2.R, s2.j, 40, 0);
  s2.j.mp = s2.j.mpMax - 1;
  avance(s2.R, 0.15);
  eq(s2.j.mp, s2.j.mpMax, 'et elle ne fait jamais deborder');
}
console.log('\n-- legendaire : la benediction protege et eteint le feu --');
{
  const { R, j } = scene('legendaire', 100);
  poseMonstre(R, j, 40, 0);
  const E = monde.pouvoirsDe('legendaire', 100).find((p) => p.soutien).effet;
  j.brulure = monde.EFFETS.brulure.duree;
  j.brulReste = 0.9;
  avance(R, 0.15);
  pres(j.bouclier, E.duree, 'le bouclier est pose pour la duree annoncee', 0.15);
  eq(j.bouclierPart, E.reduction, 'avec la reduction annoncee');
  eq(j.brulure, 0, 'la brulure en cours est eteinte');
  eq(j.brulReste, 0, 'et son reste avec');
  ok(j.immun.brulure > 0, 'et elle ne peut pas revenir tout de suite');
  /* Le bouclier du legendaire est PLUS FORT que celui de la terre, et c est
     le delai qui le permet : la terre repose le sien a chaque recharge, lui
     attend dix-huit secondes. */
  const terre = monde.familierEffet('bouclier', 100).reduction;
  ok(E.reduction > terre,
     `il protege mieux que celui de la terre (${E.reduction.toFixed(2)} > ${terre.toFixed(2)})`);
  /* Et il AMORTIT vraiment : un bouclier annonce qui ne retire rien serait un
     mensonge que seule une mesure attrape. */
  const brut = 100;
  ok(R._amorti(j, brut) < brut,
     `un coup de ${brut} est amorti a ${R._amorti(j, brut)}`);
}

/* ================== 7. LE MONDE ROUGE N'EN VOIT RIEN ================== */
console.log('\n-- sur la carte PvP, le compagnon ne prepare personne --');
{
  const R = new Realm({ pvp: true });
  R.rejoint('0xaaa', fiche('normal', 100));
  const j = R.joueurs.get('0xaaa');
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  poseMonstre(R, j, 40, 0);
  const evs = avance(R, 2.0);
  eq(gestes(evs).length, 0, 'aucun geste, soutien compris');
  eq(j.rafale, 0, 'et rien ne s est pose sur le joueur');
}

/* ================== 8. CE QUE LA PAGE RECOIT ================== */
console.log('\n-- les deux etats neufs partent dans l instantane --');
{
  const { R, j } = scene('feu', 100);
  poseMonstre(R, j, 40, 0);
  avance(R, 0.15);
  const e = R.etatPour('0xaaa');
  ok(e.moi.ard > 0, `l ardeur part a chaque image (${e.moi.ard}s)`);
  const t = scene('terre', 100);
  poseMonstre(t.R, t.j, 40, 0);
  t.j.pv = 100;
  avance(t.R, 0.15);
  ok(t.R.etatPour('0xaaa').moi.rac > 0, 'les racines aussi');
  /* Sans eux, un joueur qui recharge sa page en pleine ardeur verrait l effet
     disparaitre alors qu il court encore : ils agissent en changeant un
     CHIFFRE, et un chiffre qui change ne se dessine pas tout seul. */
}
console.log('\n-- et les six s annoncent avec leur delai --');
{
  for (const [espece, cle] of Object.entries(SOUTIEN)) {
    const p = monde.pouvoirsDe(espece, CRAN).find((x) => x.cle === cle);
    ok(p.soutien, `« ${cle} » est marque soutien`);
    eq(p.effet.delai, DELAI, 'et porte le delai que la page doit annoncer');
    ok(!p.zone, 'et il n est pas confondu avec une zone');
  }
  /* Le troisieme cran doit etre VISIBLE avant d etre atteint : un pouvoir
     qu on ne voit pas ne se merite pas. */
  const jeune = monde.pouvoirsDe('normal', 1);
  eq(jeune.length, 3, 'les trois crans sont annonces des le premier niveau');
  eq(jeune.filter((p) => p.ouvert).length, 1, 'un seul est ouvert');
  eq(jeune.find((p) => p.soutien).niveau, CRAN, 'et le soutien dit a quel niveau il ouvre');
}

console.log(`\nfamilier_soutien.test.js : ${n} verifications OK`);
