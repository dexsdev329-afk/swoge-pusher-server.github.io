'use strict';
/*
 * LES REGLES ECRITES SUR L'ECRAN D'INFORMATION SONT-ELLES ENCORE VRAIES ?
 *
 * La plupart de ce que la page affiche vient du bareme : les gains, les
 * rouleaux du Wild, le nombre de tours, les prix. Ces valeurs-la ne peuvent
 * pas se dementir, la page ne les connait pas.
 *
 * Mais trois phrases ne sont PAS des nombres — ce sont des formes du
 * moteur, et elles sont ecrites en toutes lettres dans `swoge_dod.html` :
 *
 *   1. « When Wilds land on several reels at once their multipliers are
 *      MULTIPLIED together, not added »
 *   2. « each Wild multiplier STAYS on its reel until the round ends, and a
 *      new Wild landing on a reel that already holds one ADDS to it »
 *   3. « the bonus cannot be retriggered »
 *
 * Plus le retour au joueur, qui est un nombre MESURE et non deduit.
 *
 * Un jour quelqu'un changera le moteur — un produit deviendra une somme,
 * les collants sauteront, le redeclenchement s'ouvrira — et ces phrases
 * resteront a l'ecran, fausses, lues juste avant de miser. Cet essai les
 * verifie sur le moteur LUI-MEME et nomme le paragraphe a corriger.
 */
const fs = require('fs');
const path = require('path');
const dod = require('./dod.js');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* La page est dans l'autre depot. Absente, on saute les verifications de
   texte plutot que d'echouer : les deux depots se clonent separement. */
const PAGE = '/home/user/swoge.github.io/swoge_dod.html';
/* Les phrases sont ECRITES EN MORCEAUX dans la page — `'...STAYS on its' +
   ' reel until...'` — donc les chercher telles quelles dans le source
   echoue sans qu'aucune regle ait change. On recolle les concatenations
   avant de chercher. */
const page = fs.existsSync(PAGE)
  ? fs.readFileSync(PAGE, 'utf8').replace(/'\s*\+\s*'/g, '')
  : null;

console.log('-- ce que le moteur fait vraiment --');

/* 1. LE PRODUIT, PAS LA SOMME.
 * On cherche un tour ou DEUX rouleaux tiennent un multiplicateur, et on
 * compare le multiplicateur du tour a leur produit et a leur somme. */
{
  let vu = null;
  for (let i = 1; i < 400000 && !vu; i++) {
    const t = dod.unTourPourEssai
      ? dod.unTourPourEssai(i)
      : dod.joue({ serverSeed: 'r', clientSeed: 'c', nonce: i, mise: 100 }).base;
    const tenus = (t.multis || []).filter((m) => m > 0);
    if (tenus.length >= 2 && new Set(tenus).size >= 1) vu = { t, tenus };
  }
  if (!vu) { ok(false, 'un tour avec deux rouleaux multiplicateurs (aucun trouve)'); }
  else {
    const prod = vu.tenus.reduce((a, b) => a * b, 1);
    const somme = vu.tenus.reduce((a, b) => a + b, 0);
    ok(vu.t.multi === prod,
       'plusieurs Wilds se MULTIPLIENT : ' + vu.tenus.join(' × ') + ' = ' + vu.t.multi
       + (prod !== somme ? ' (leur somme ferait ' + somme + ')' : ''));
    if (page) ok(/multipliers are MULTIPLIED together, not added/.test(page),
      'et l ecran d information le dit bien');
  }
}

/* 2. LES MULTIPLICATEURS COLLENT, ET S'AJOUTENT SUR LE MEME ROULEAU. */
{
  /* La VRAIE preuve du collant : un rouleau qui garde son multiplicateur sur
     un tour ou AUCUN Wild n'y est tombe. Un ×1 suivi d'un ×1 ne prouve rien
     — c'etait la premiere version de cet essai, et elle passait sans rien
     verifier. */
  let vu = null, grandit = null;
  for (let i = 1; i < 200000 && !(vu && grandit); i++) {
    const r = dod.joue({ serverSeed: 'r', clientSeed: 'c', nonce: i, mise: 100 });
    if (!r.gratuits) continue;
    const tours = r.gratuits.tours;
    for (let k = 1; k < tours.length; k++) {
      const sansWild = new Set((tours[k].wilds || []).map((w) => w.rouleau));
      for (let rr = 0; rr < tours[k].multis.length; rr++) {
        const av = tours[k - 1].multis[rr], ap = tours[k].multis[rr];
        if (!vu && av > 0 && ap === av && !sansWild.has(rr))
          vu = { avant: av, apres: ap, rr, k };
        if (!grandit && av > 0 && ap > av) grandit = { avant: av, apres: ap, rr, k };
      }
    }
  }
  ok(!!vu, 'un multiplicateur RESTE sur son rouleau un tour ou AUCUN Wild n y tombe'
     + (vu ? ' (rouleau ' + (vu.rr + 1) + ' garde ×' + vu.avant + ' au tour ' + (vu.k + 1) + ')' : ''));
  ok(!!grandit, 'et un nouveau Wild sur un rouleau deja tenu S AJOUTE'
     + (grandit ? ' (rouleau ' + (grandit.rr + 1) + ' : ×' + grandit.avant
                  + ' devient ×' + grandit.apres + ')' : ''));
  /* Et il ne redescend jamais : c'est ce que « stays » promet. */
  let descend = null;
  for (let i = 1; i < 200000 && !descend; i++) {
    const r = dod.joue({ serverSeed: 's', clientSeed: 'c', nonce: i, mise: 100 });
    if (!r.gratuits) continue;
    const t = r.gratuits.tours;
    for (let k = 1; k < t.length && !descend; k++)
      for (let rr = 0; rr < t[k].multis.length; rr++)
        if (t[k - 1].multis[rr] > 0 && t[k].multis[rr] < t[k - 1].multis[rr])
          descend = { k, rr, avant: t[k - 1].multis[rr], apres: t[k].multis[rr] };
  }
  ok(!descend, 'et il ne redescend jamais pendant la serie'
     + (descend ? ' — rouleau ' + (descend.rr + 1) + ' passe de ×' + descend.avant
                  + ' a ×' + descend.apres + ' au tour ' + descend.k : ''));
  if (page) ok(/STAYS on its reel until the round ends/.test(page)
            && /ADDS to it/.test(page),
    'et l ecran d information le dit bien');
}

/* 3. PAS DE REDECLENCHEMENT. */
{
  let tours = 0, series = 0, avecScatters = 0;
  for (let i = 1; i < 200000 && series < 400; i++) {
    const r = dod.joue({ serverSeed: 'r', clientSeed: 'c', nonce: i, mise: 100 });
    if (!r.gratuits) continue;
    series++;
    tours += r.gratuits.tours.length;
    /* Des scatters TOMBENT pendant la serie — c'est ce qui rend la promesse
       verifiable : s'ils ne tombaient jamais, « pas de redeclenchement »
       serait vrai sans rien prouver. */
    if (r.gratuits.tours.some((t) => (t.scatters[dod.DEAD] || 0) >= dod.SCATTERS_POUR_TOURS
                                  || (t.scatters[dod.DEADER] || 0) >= dod.SCATTERS_POUR_TOURS))
      avecScatters++;
    const attendu = dod.TOURS[r.mode];
    if (r.gratuits.tours.length !== attendu) {
      ok(false, 'une serie ' + r.mode + ' donne ' + r.gratuits.tours.length
         + ' tours au lieu de ' + attendu + ' : le bonus s est redeclenche');
      series = 1e9;
    }
  }
  if (series < 1e9) {
    ok(true, series + ' series jouees, toutes de la longueur annoncee : le bonus'
       + ' ne se redeclenche pas — et ' + avecScatters + ' d entre elles ont pourtant'
       + ' vu tomber assez de scatters pour le faire');
    ok(avecScatters > 0,
       'la promesse est verifiable : des scatters tombent bien pendant les series');
  }
  if (page) ok(/cannot be retriggered/.test(page), 'et l ecran d information le dit bien');
}

/* 4. LES SCATTERS ET LE WILD NE PAIENT PAS SEULS. */
{
  const payants = dod.BAS.concat(dod.HAUTS);
  ok(payants.indexOf(dod.WILD) < 0 && payants.indexOf(dod.DEAD) < 0
     && payants.indexOf(dod.DEADER) < 0,
     'ni le Wild ni les scatters ne figurent au bareme : ils ne paient pas seuls');
  if (page) ok(/pays nothing on its own/.test(page)
            && /Scatters pay nothing by themselves/.test(page),
    'et l ecran d information le dit bien');
}

/* 5. LE RETOUR PUBLIE N'A PAS DERIVE DU MOTEUR.
 * Une mesure isolee ne suffit pas — l'ecart-type entre graines est de 1,34
 * point. On en poole assez pour que l'intervalle soit plus etroit que la
 * derive qu'on cherche, et on tolere large : cet essai doit attraper un
 * moteur REREGLE, pas le bruit. */
console.log('\n-- le retour publie --');
{
  const G = 12, N = 250000;
  const r = [];
  for (let i = 0; i < G; i++) r.push(100 * dod.mesure(N, 'v' + i).rtp);
  const moy = r.reduce((a, b) => a + b, 0) / G;
  const ec = Math.sqrt(r.reduce((a, b) => a + (b - moy) * (b - moy), 0) / (G - 1));
  const em = 1.96 * ec / Math.sqrt(G);
  const ecart = Math.abs(moy - dod.RTP);
  ok(ecart < 2.0,
     'le chiffre publie (' + dod.RTP.toFixed(2) + ' %) tient face a une remesure : '
     + moy.toFixed(2) + ' % ±' + em.toFixed(2) + ' sur ' + G + '×' + (N / 1000) + 'k tours'
     + ' — ecart ' + ecart.toFixed(2) + ' point(s)');
  ok(dod.RTP_IC > 0 && dod.RTP_TOURS >= 1e6,
     'et il est publie AVEC ses conditions : ±' + dod.RTP_IC + ' point sur '
     + (dod.RTP_TOURS / 1e6) + 'M tours — une moyenne sans son intervalle ne dit'
     + ' rien sur un jeu a cette variance');
}

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
process.exit(rates ? 1 : 0);
