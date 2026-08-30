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

/* 1. LA SOMME, PLUS LE PRODUIT.
 *
 * C'etait un PRODUIT jusqu'en aout. Il l'a cesse le jour ou les
 * multiplicateurs se sont mis a grandir : produit ET croissance donnaient
 * 10 877 % de retour, et le plafond de gain mordait sur un tour sur 262.
 * Cet essai-la a echoue en premier, et c'est ce qu'on lui demande. */
{
  let vu = null;
  for (let i = 1; i < 400000 && !vu; i++) {
    const t = dod.joue({ serverSeed: 'r', clientSeed: 'c', nonce: i, mise: 100 }).base;
    const tenus = (t.multis || []).filter((m) => m > 0);
    if (tenus.length >= 2) vu = { t, tenus };
  }
  if (!vu) { ok(false, 'un tour avec deux rouleaux multiplicateurs (aucun trouve)'); }
  else {
    const prod = vu.tenus.reduce((a, b) => a * b, 1);
    const somme = vu.tenus.reduce((a, b) => a + b, 0);
    ok(vu.t.multi === somme,
       'plusieurs Wilds s AJOUTENT : ' + vu.tenus.join(' + ') + ' = ' + vu.t.multi
       + (prod !== somme ? ' (leur produit ferait ' + prod + ')' : ''));
    if (page) ok(/multipliers are ADDED together/.test(page),
      'et l ecran d information le dit bien');
    if (page) ok(!/MULTIPLIED together, not added/.test(page),
      'et l ancienne phrase — « MULTIPLIED together, not added » — a bien disparu :'
      + ' une regle qui n est plus vraie et qui reste affichee est pire qu absente');
  }
}

/* 2. CE QUI COLLE GRANDIT TOUT SEUL, JUSQU A UN PLAFOND.
 *
 * C'est la mecanique centrale du mode gratuit, et la seule que le joueur
 * doit avoir comprise avant son premier bonus. Trois choses a prouver :
 * ca colle, ca DOUBLE (triple en Deader) sans qu aucun Wild ne retombe, et
 * ca ne depasse jamais le plafond du rouleau. */
{
  let colle = null, double = null, triple = null, tropHaut = null, descend = null;
  for (let i = 1; i < 300000 && !(colle && double && triple); i++) {
    const r = dod.joue({ serverSeed: 'r', clientSeed: 'c', nonce: i, mise: 100 });
    if (!r.gratuits) continue;
    const t = r.gratuits.tours;
    for (let k = 1; k < t.length; k++) {
      const neufs = new Set((t[k].wilds || []).map((w) => w.rouleau));
      const mode = t[k].mode;
      const f = dod.CROISSANCE[mode], pl = dod.PLAFOND_ROULEAU[mode];
      for (let rr = 0; rr < t[k].multis.length; rr++) {
        const av = t[k - 1].multis[rr], ap = t[k].multis[rr];
        if (av > 0 && ap > pl) tropHaut = { rr, ap, pl, mode };
        if (av > 0 && ap < av) descend = { rr, av, ap, k };
        if (av > 0 && !neufs.has(rr)) {
          const attendu = Math.min(av * f, pl);
          if (ap !== attendu) { colle = colle || { casse: true, rr, av, ap, attendu, mode, k }; }
          else {
            if (!colle) colle = { rr, av, ap, mode, k };
            if (!double && mode === dod.DEAD && ap === av * 2) double = { rr, av, ap, k };
            if (!triple && mode === dod.DEADER && ap === av * 3) triple = { rr, av, ap, k };
          }
        }
      }
    }
  }
  ok(colle && !colle.casse,
     colle && !colle.casse
       ? 'un rouleau tenu grandit SANS qu aucun Wild n y retombe : ×' + colle.av
         + ' devient ×' + colle.ap + ' au tour ' + (colle.k + 1) + ' (' + colle.mode + ')'
       : 'un rouleau tenu n a pas grandi comme annonce'
         + (colle ? ' : ×' + colle.av + ' donne ×' + colle.ap + ' au lieu de ×' + colle.attendu : ''));
  ok(!!double, 'en Dead Spins il DOUBLE'
     + (double ? ' (×' + double.av + ' → ×' + double.ap + ')' : ' — aucun cas trouve'));
  ok(!!triple, 'en Deader Spins il TRIPLE'
     + (triple ? ' (×' + triple.av + ' → ×' + triple.ap + ')' : ' — aucun cas trouve'));
  ok(!tropHaut, 'et il ne depasse jamais le plafond du rouleau'
     + (tropHaut ? ' — ×' + tropHaut.ap + ' en ' + tropHaut.mode
                   + ' ou le plafond est ×' + tropHaut.pl : ''));
  ok(!descend, 'ni ne redescend pendant la serie'
     + (descend ? ' — ×' + descend.av + ' devient ×' + descend.ap : ''));
  if (page) ok(new RegExp('at every free spin, every reel that holds a multiplier').test(page),
    'et l ecran d information l annonce');
}

/* 3. LES DEUX SCATTERS SEULS DEVIENNENT DES WILDS.
 *
 * Le quasi-manque le plus frequent du jeu. On cherche un tour ou EXACTEMENT
 * deux scatters sont tombes, et on verifie qu il n en reste aucun sur la
 * grille et que deux Wilds ont pris leur place. */
{
  let vu = null, resteScatter = null;
  for (let i = 1; i < 200000 && !vu; i++) {
    const t = dod.joue({ serverSeed: 'q', clientSeed: 'c', nonce: i, mise: 100 }).base;
    const n = (t.scatters[dod.DEAD] || 0) + (t.scatters[dod.DEADER] || 0);
    if (n !== dod.DEUX_SCATTERS_WILD) continue;
    const surGrille = t.grille.filter((c) => c === dod.DEAD || c === dod.DEADER).length;
    if (surGrille) { resteScatter = { i, surGrille }; break; }
    if ((t.convertis || []).length === dod.DEUX_SCATTERS_WILD
        && t.convertis.every((k) => t.grille[k] === dod.WILD)) vu = { i, t };
  }
  ok(!resteScatter, 'aucun scatter ne reste sur la grille quand il y en avait exactement '
     + dod.DEUX_SCATTERS_WILD + (resteScatter ? ' — il en reste ' + resteScatter.surGrille : ''));
  ok(!!vu, dod.DEUX_SCATTERS_WILD + ' scatters seuls deviennent bien '
     + dod.DEUX_SCATTERS_WILD + ' Wilds, la ou ils sont'
     + (vu ? ' (cases ' + vu.t.convertis.join(' et ') + ')' : ' — aucun cas trouve'));
  if (page) ok(/they TURN INTO WILDS where they stand/.test(page),
    'et l ecran d information le dit');
}

/* 3 bis. LE BONUS NE SE REDECLENCHE PAS — MAIS IL SE SURCLASSE.
 *
 * La regle a change : les scatters ne relancent toujours rien, mais un
 * `deader` sur le DERNIER rouleau fait passer le reste d une serie Dead en
 * Deader et ajoute deux tours. Une serie ne peut donc avoir que deux
 * longueurs, et aucune autre. */
{
  const attendues = {};
  attendues[dod.DEAD] = [dod.TOURS[dod.DEAD], dod.TOURS[dod.DEAD] + dod.SURCLASSE_TOURS];
  attendues[dod.DEADER] = [dod.TOURS[dod.DEADER]];
  let series = 0, surclassees = 0, mauvaise = null, sansDeader = 0;
  for (let i = 1; i < 300000 && series < 600; i++) {
    const r = dod.joue({ serverSeed: 'r', clientSeed: 'c', nonce: i, mise: 100 });
    if (!r.gratuits) continue;
    series++;
    const L = r.gratuits.tours.length;
    if (attendues[r.mode].indexOf(L) < 0) { mauvaise = { mode: r.mode, L }; break; }
    if (r.gratuits.surclasse) {
      surclassees++;
      /* Le surclassement doit avoir une CAUSE visible : un `deader` sur le
         dernier rouleau du tour qui le porte. */
      const t = r.gratuits.tours.find((x) => x.surclasse);
      if (t && !t.deaderDernier) sansDeader++;
      if (L !== dod.TOURS[dod.DEAD] + dod.SURCLASSE_TOURS) { mauvaise = { mode: r.mode, L }; break; }
    } else if (r.mode === dod.DEAD && L !== dod.TOURS[dod.DEAD]) { mauvaise = { mode: r.mode, L }; break; }
  }
  ok(!mauvaise, series + ' series jouees, toutes de la longueur annoncee'
     + (mauvaise ? ' — sauf une serie ' + mauvaise.mode + ' de ' + mauvaise.L + ' tours' : ''));
  ok(surclassees > 0, surclassees + ' d entre elles ont ete surclassees en Deader :'
     + ' la seconde chance existe vraiment et se mesure');
  ok(sansDeader === 0,
     'et chaque surclassement a sa cause sur la grille — un `deader` sur le dernier rouleau'
     + (sansDeader ? ' : ' + sansDeader + ' sans' : ''));
  /* Un surclassement ne se produit qu une fois : sinon une serie pourrait
     s allonger sans fin, et le plafond de gain deviendrait le seul frein. */
  let deuxFois = 0;
  for (let i = 1; i < 200000; i++) {
    const r = dod.joue({ serverSeed: 'u', clientSeed: 'c', nonce: i, mise: 100 });
    if (!r.gratuits) continue;
    if (r.gratuits.tours.filter((t) => t.surclasse).length > 1) deuxFois++;
  }
  ok(deuxFois === 0, 'et jamais deux fois dans la meme serie'
     + (deuxFois ? ' — ' + deuxFois + ' series en portent deux' : ''));
  if (page) ok(/Nothing else retriggers the bonus/.test(page)
            && /turns the rest of the round into Deader Spins/.test(page),
    'et l ecran d information dit les deux : ce qui surclasse, et que rien d autre ne relance');
  if (page) ok(!/the bonus cannot be retriggered/.test(page),
    'l ancienne phrase absolue a disparu : elle niait le surclassement');
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

/* 6. UN CRAN D'ACHAT N'EST NI UN PIEGE NI UN CADEAU.
 *
 * Les prix avaient ete calibres sur une base ESTIMEE a ~95,4 %. La vraie
 * base est 96,35 % : les quatre crans etaient trop chers, et le moins cher
 * — celui que tout le monde essaie en premier — rendait 91,13 %, soit CINQ
 * POINTS de moins que de simplement jouer. Rien ne le signalait.
 *
 * Le jeu qui a inspire celui-ci tient ses quatre crans dans 0,16 point de
 * sa base. C'est la bonne echelle : on exige ici moins d'un point.
 *
 * Le rendu se POOLE, comme le retour : celui d'un cran porte la meme queue
 * lourde que le jeu. Une mesure isolee ferait echouer cet essai au hasard.
 */
console.log('\n-- les crans d achat --');
{
  const G = 16, N = 60000;
  const ecarts = [];
  for (const c of dod.CRANS_ORDRE) {
    const r = [];
    for (let i = 0; i < G; i++) r.push(dod.mesureAchat(c, N, 'w' + i).rendu);
    const moy = r.reduce((a, b) => a + b, 0) / G;
    const ec = Math.sqrt(r.reduce((a, b) => a + (b - moy) * (b - moy), 0) / (G - 1));
    const em = 1.96 * ec / Math.sqrt(G);
    const retour = 100 * moy / dod.CRANS[c].prix;
    const ic = 100 * em / dod.CRANS[c].prix;
    const ecart = retour - dod.RTP;
    ecarts.push(Math.abs(ecart));
    ok(Math.abs(ecart) < 1.0 + ic,
       'le cran « ' + c + ' » a ' + dod.CRANS[c].prix + '× rend '
       + retour.toFixed(2) + ' % ±' + ic.toFixed(2) + ', soit '
       + (ecart >= 0 ? '+' : '') + ecart.toFixed(2) + ' point(s) de la base');
  }
  ok(Math.max(...ecarts) < 1.5,
     'et le pire des quatre reste sous un point et demi ('
     + Math.max(...ecarts).toFixed(2) + ') : acheter le bonus doit etre une'
     + ' AUTRE FACON DE MISER, pas une punition');
}

console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'tout passe : ' + n + ' verifications'));
process.exit(rates ? 1 : 0);
