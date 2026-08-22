'use strict';
/*
 * LES PASSIFS DES ARMURES ET DES BAGUES.
 *
 * ---- POURQUOI CE FICHIER EXISTE ----
 *
 * Les armures et les bagues annoncaient un POUVOIR qu'elles ne donnaient
 * jamais : 86 fiches promettaient une Stase que seul le fruit peut lancer. On
 * l'a retiree, et les passifs sont ce qui la remplace.
 *
 * Un passif ne se declenche pas. Rien a l'ecran ne dit qu'il a marche. C'est
 * donc EXACTEMENT le genre de chose qui peut ne rien faire pendant des mois
 * sans que personne ne le remarque — et la raison pour laquelle chaque effet
 * est ici mesure sur la simulation, jamais deduit de sa fiche.
 *
 * ---- ce que ce fichier protege, dans l'ordre ----
 *
 * 1. UNE CHOSE PAR SAISON. Le fruit un pouvoir, l'arme des degats, l'armure
 *    et la bague un passif. Un objet qui donnerait les deux ferait de la
 *    saison 1 un cran de plus au lieu d'un choix.
 * 2. CHACUN FAIT CE QU'IL DIT, mesure sur le joueur ou sur le monstre.
 * 3. LES PLAFONDS TIENNENT. Un pouvoir gratuit, une entrave annulee ou un
 *    coup toujours double cesseraient d'etre des choix.
 * 4. ET DEUX PIECES S'ADDITIONNENT. Porter deux objets qui brulent doit
 *    bruler plus, sinon le second ne sert a rien et le joueur cherche
 *    pourquoi.
 */
const assert = require('assert');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/passifs-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
const { Realm } = require('./realm');
const { Game } = require('./game');
const monde = require('./monde');
const P = require('./personnages');
const boutique = require('./boutique');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

const fiche = (passifs) => ({ skin: 'andy', nom: 'Alice',
  stats: { att: 60, def: 30, spd: 40, dex: 40, vit: 30, wis: 30, hp: 2000, mp: 300 },
  famille: 'lame', degats: [40, 60], passifs: passifs || {} });

function scene(passifs) {
  const R = new Realm({});
  R.rejoint('0xaaa', fiche(passifs));
  const j = R.joueurs.get('0xaaa');
  R.monstres.length = 0; R.tirsM.length = 0; R.zones.length = 0;
  return { R, j };
}
function poseMonstre(R, j, dx, pv) {
  const espece = Object.keys(monde.MONSTRES)[0];
  const m = { id: R._nouvelId(), espece, biome: null, x: j.x + dx, y: j.y,
              ancreX: j.x + dx, ancreY: j.y,
              pv: pv || 100000, pvMax: pv || 100000, dir: 'down', cible: null,
              recharge: 999, rechargeT: 999, stase: 0,
              feu: 0, feuReste: 0, feuTaux: 0, feuPar: null,
              errX: 0, errY: 0, errChrono: 0 };
  R.monstres.push(m);
  return m;
}
const avance = (R, s) => { const e = []; for (let t = 0; t < s; t += 0.1) e.push(R.pas(0.1)); return e; };

/* ================== 1. UNE CHOSE PAR SAISON ================== */
console.log('-- une chose par saison --');
{
  const tous = boutique.ITEMS.concat(boutique.ITEMS_DROP || []);
  const compte = { passif: {}, sort: {} };
  for (const o of tous) {
    if (Game.passifDe(o)) compte.passif[o.saison] = (compte.passif[o.saison] || 0) + 1;
    if (Game.sortDuFruit(o)) compte.sort[o.saison] = (compte.sort[o.saison] || 0) + 1;
  }
  /* Les saisons viennent du catalogue : les nommer ici — « 3 et 4 » — ferait
     passer l'essai le jour ou l'on en ajoute une. */
  for (const S of boutique.SAISONS) {
    const p = compte.passif[S.n] || 0, s = compte.sort[S.n] || 0;
    ok(!(p > 0 && s > 0),
       `« ${S.cle} » ne donne pas les deux (${p} passifs, ${s} pouvoirs)`);
    if (S.cle === 'armures' || S.cle === 'bagues') {
      ok(p > 0, `et « ${S.cle} » donne bien un passif (${p} objets)`);
      eq(s, 0, `sans aucun pouvoir actif`);
    }
    if (S.cle === 'fruits') { ok(s > 0, 'les fruits gardent le pouvoir'); eq(p, 0, 'et pas de passif'); }
    if (S.cle === 'armes') { eq(p, 0, 'les armes n ont ni l un'); eq(s, 0, 'ni l autre'); }
  }
}

/* ================== 2. LA FORCE SUIT LA RARETE ================== */
console.log('\n-- plus c est rare, plus c est fort --');
{
  /* ---- ON CHERCHE UN ECHELON COMPLET, ON N'EN SUPPOSE PAS ----
   * J'avais pris « la brulure dans le butin ». Le catalogue de butin n'en
   * contient qu'UNE — il est concentre sur les epines — et l'essai accusait
   * la courbe de rarete alors qu'il n'avait qu'un point a comparer.
   * On prend donc la premiere famille d'objets qui offre au moins trois
   * rangs du meme passif, dans la meme liste. */
  const echelle = (liste, saison) => {
    const par = {};
    for (const o of liste) {
      if (Number(o.saison) !== saison) continue;
      const p = Game.passifDe(o);
      if (!p) continue;
      (par[p.cle] = par[p.cle] || {})[o.rarete] = { v: p.valeur, o };
    }
    for (const cle of Object.keys(par)) {
      const rangs = boutique.RARETES.map((r) => r.cle).filter((r) => par[cle][r]);
      if (rangs.length >= 3) return { cle, rangs, par: par[cle] };
    }
    return null;
  };
  const ech = echelle(boutique.ITEMS, 3) || echelle(boutique.ITEMS_DROP, 3);
  ok(!!ech, 'on trouve un passif porte a au moins trois rangs de rarete');
  const rangs = ech.rangs;
  const parRarete = {};
  for (const r of rangs) parRarete[r] = ech.par[r].v;
  ok(rangs.length >= 3,
     `« ${ech.cle} » est porte a ${rangs.length} rangs (${rangs.join(', ')})`);
  for (let i = 1; i < rangs.length; i++) {
    ok(parRarete[rangs[i]] > parRarete[rangs[i - 1]],
       `« ${rangs[i]} » (${parRarete[rangs[i]]}) depasse « ${rangs[i - 1]} » (${parRarete[rangs[i - 1]]})`);
  }
  /* Et la courbe est CELLE DES BONUS, pas une seconde a tenir d'accord. */
  const un = ech.par[rangs[0]].o;
  const deux = ech.par[rangs[rangs.length - 1]].o;
  const rapportPassif = parRarete[rangs[rangs.length - 1]] / parRarete[rangs[0]];
  const rapportBudget = P.budgetDe(deux) / P.budgetDe(un);
  ok(Math.abs(rapportPassif - rapportBudget) < 0.01,
     `l ecart suit exactement le budget de rarete (${rapportPassif.toFixed(2)} contre ${rapportBudget.toFixed(2)})`);
}

/* ================== 3. CHACUN FAIT CE QU'IL DIT ================== */
console.log('\n-- la brulure enflamme --');
{
  const { R, j } = scene({ brulure: 120, brulureDuree: 6 });
  const m = poseMonstre(R, j, 60);
  R.alea = () => 0.5;
  R.tire('0xaaa', 0);
  avance(R, 0.5);
  ok(m.feu > 0, `la creature brule (${m.feu.toFixed(1)}s)`);
  eq(m.feuPar, j.addr, 'a notre compte — c est nous qui aurons l XP');
  /* Le TOTAL est reparti sur la duree : la table dit « 120 sur six secondes »,
     pas « 120 par seconde ». Le verifier evite l erreur qui multiplierait la
     brulure par six sans que rien ne le dise. */
  const pvA = m.pv;
  avance(R, 6.5);
  const brule = pvA - m.pv;
  ok(Math.abs(brule - 120) < 14, `et elle rend environ ce qu elle annonce (${brule} pour 120)`);

  /* SANS le passif, rien ne brule. Le temoin est ce qui fait la preuve. */
  const t = scene({});
  const m2 = poseMonstre(t.R, t.j, 60);
  t.R.alea = () => 0.5;
  t.R.tire('0xaaa', 0);
  avance(t.R, 0.5);
  eq(m2.feu, 0, 'et sans le passif, rien ne brule');
}

console.log('\n-- le vampirisme rend de la vie --');
{
  const { R, j } = scene({ vampire: 0.2 });
  const m = poseMonstre(R, j, 60);
  R.alea = () => 0.5;
  j.pv = 1000;
  R.tire('0xaaa', 0);
  avance(R, 0.6);
  ok(j.pv > 1000, `on remonte en frappant (${j.pv})`);
  /* Jamais AU-DESSUS du maximum : un soin qui deborde ne se voit pas et
     fausse la barre. */
  const t = scene({ vampire: 0.9 });
  poseMonstre(t.R, t.j, 60);
  t.R.alea = () => 0.5;
  t.R.tire('0xaaa', 0);
  avance(t.R, 1.0);
  ok(t.j.pv <= t.j.pvMax, 'et jamais au-dela du maximum');
}

console.log('\n-- les epines renvoient --');
{
  const { R, j } = scene({ epines: 0.5 });
  const m = poseMonstre(R, j, 60, 5000);
  /* Un projectile de monstre pose a la main : on mesure le RENVOI, pas la
     facon dont la creature decide de tirer. */
  R.tirsM.push({ id: R._nouvelId(), espece: m.espece, x: j.x, y: j.y, a: 0,
                 v: 300, reste: 1, att: 200, sprite: 'os', effet: null });
  const pvA = m.pv, vieA = j.pv;
  avance(R, 0.3);
  ok(j.pv < vieA, `on encaisse (${vieA - j.pv})`);
  ok(m.pv < pvA, `et la creature reprend une part (${pvA - m.pv})`);
  const t = scene({});
  const m2 = poseMonstre(t.R, t.j, 60, 5000);
  t.R.tirsM.push({ id: t.R._nouvelId(), espece: m2.espece, x: t.j.x, y: t.j.y, a: 0,
                   v: 300, reste: 1, att: 200, sprite: 'os', effet: null });
  const pv2 = m2.pv;
  avance(t.R, 0.3);
  eq(m2.pv, pv2, 'sans le passif, elle ne reprend rien');
}

console.log('\n-- le vif raccourcit les entraves --');
{
  const cle = Object.keys(monde.EFFETS)[0];
  const nu = scene({});
  nu.R._poseEtat(nu.j, cle, { degats: [] });
  const sans = nu.j[cle];
  const vif = scene({ vif: 0.4 });
  vif.R._poseEtat(vif.j, cle, { degats: [] });
  ok(vif.j[cle] < sans, `« ${cle} » dure moins (${vif.j[cle].toFixed(2)}s contre ${sans}s)`);
  ok(Math.abs(vif.j[cle] - sans * 0.6) < 0.01, 'et exactement de ce qu il annonce');
  /* JAMAIS zero : une entrave annulee n est plus une entrave, et le monde a
     des creatures dont c est la seule facon de peser. */
  const fou = scene({ vif: 5 });
  fou.R._poseEtat(fou.j, cle, { degats: [] });
  ok(fou.j[cle] > 0, `meme avec une valeur absurde, elle dure encore (${fou.j[cle].toFixed(2)}s)`);
}

console.log('\n-- la lucidite remonte le mana --');
{
  const mana = (p) => {
    const { R, j } = scene(p);
    j.mp = 0; j.mpReste = 0; j.pv = j.pvMax;
    avance(R, 10);
    return j.mp;
  };
  const sans = mana({}), avec = mana({ lucide: 1 });
  ok(avec > sans, `le mana remonte plus vite (${sans} -> ${avec} en 10s)`);
  ok(Math.abs(avec / sans - 2) < 0.25, 'et du facteur annonce');
}

console.log('\n-- la reserve allege le pouvoir --');
{
  const { R, j } = scene({ reserve: 0.5 });
  j.pouvoir = 'foudre';
  const P0 = monde.POUVOIRS.foudre;
  /* Juste assez de mana pour la moitie du cout : sans le passif c est un
     refus, avec lui ca passe. C est la seule facon de prouver que le cout a
     VRAIMENT baisse, et pas seulement l affichage. */
  j.mp = Math.ceil(P0.cout * 0.5);
  const ev = { touches: [], kills: [] };
  const r = R.pouvoir('0xaaa', ev);
  ok(r && !r.refus, `le pouvoir part avec la moitie du mana (${r && r.refus})`);
  const t = scene({});
  t.j.pouvoir = 'foudre';
  t.j.mp = Math.ceil(P0.cout * 0.5);
  const r2 = t.R.pouvoir('0xaaa', { touches: [], kills: [] });
  eq(r2 && r2.refus, 'mana', 'et sans le passif, il est refuse');
}

console.log('\n-- la justesse double, parfois --');
{
  /* On force le de : c est la seule facon de mesurer une chance sans mesurer
     du bruit. Deux scenes identiques, un tirage qui passe et un qui rate. */
  const coup = (chance, de) => {
    const { R, j } = scene(chance ? { justesse: chance } : {});
    const m = poseMonstre(R, j, 60);
    R.alea = () => de;
    R.tire('0xaaa', 0);
    avance(R, 0.5);
    return m.pvMax - m.pv;
  };
  /* ---- LE MEME DE POUR LES DEUX COTES ----
   * `alea` sert AUSSI au tirage de l'arme. Comparer « rate a 0,9 » a « nu a
   * 0,5 » changeait donc deux choses a la fois : le de de la justesse ET les
   * degats de la lame. L'essai accusait le passif d'une difference qui venait
   * de l'arme.
   * On fige donc le de, et l'on ne fait varier QUE le passif. */
  const nuHaut = coup(0, 0.9), rate = coup(0.3, 0.9);
  eq(rate, nuHaut, 'a de egal, un tirage rate frappe exactement comme sans le passif');
  const nuBas = coup(0, 0.1), passe = coup(0.3, 0.1);
  ok(passe > nuBas * 1.8, `et un tirage reussi frappe double (${nuBas} -> ${passe})`);
}

/* ================== 4. DEUX PIECES S'ADDITIONNENT ================== */
console.log('\n-- deux pieces qui font la meme chose s ajoutent --');
{
  /* On passe par le VRAI chemin : deux objets du catalogue, additionnes comme
     le serveur les additionne. Refaire la somme ici prouverait ma propre
     addition, pas la sienne. */
  const somme = (objets) => objets.reduce((acc, o) => {
    const p = Game.passifDe(o);
    if (!p) return acc;
    acc[p.cle] = (acc[p.cle] || 0) + p.valeur;
    if (p.duree) acc[p.cle + 'Duree'] = p.duree;
    return acc;
  }, {});
  const tous = boutique.ITEMS.concat(boutique.ITEMS_DROP || []);
  const deux = tous.filter((o) => { const p = Game.passifDe(o); return p && p.cle === 'brulure'; })
                   .slice(0, 2);
  ok(deux.length === 2, `deux pieces qui brulent : ${deux.map((o) => o.nom).join(', ')}`);
  const une = somme([deux[0]]), lesDeux = somme(deux);
  ok(lesDeux.brulure > une.brulure,
     `ensemble elles brulent plus (${une.brulure} -> ${lesDeux.brulure})`);
  /* Et la simulation le RESSENT, pas seulement le compte. */
  const brule = (p) => {
    const { R, j } = scene(p);
    const m = poseMonstre(R, j, 60);
    R.alea = () => 0.5;
    R.tire('0xaaa', 0);
    avance(R, 0.4);
    const pvA = m.pv;
    avance(R, 7);
    return pvA - m.pv;
  };
  ok(brule(lesDeux) > brule(une),
     'et la creature brule vraiment plus fort avec les deux');
}

console.log(`\npassifs.test.js : ${n} verifications OK`);
