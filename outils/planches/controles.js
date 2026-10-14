'use strict';
/* ==========================================================================
 * PLANCHES — LES CONTROLES, AVEC UN VERDICT
 *
 * Chaque controle rend { id, action?, dir?, valeur, seuil, sens, n, ok }.
 * `n` = le nombre d'images sur lequel porte la valeur. La planche passe si
 * TOUS passent ; sinon elle est « a revoir » et la fiche dit lesquels.
 *
 * LES SEUILS SONT PROVISOIRES. Ils viennent des mesures de qc_planche.py sur
 * 13 planches (8 du jeu, 5 refaites en essai, 2 personnages), releve du
 * 12/10/2026 (qc_mesures.json, wuwvxcq70.output), du mannequin de cette
 * chaine (planches_chaine.test.js) et du banc du 13/10/2026 (3 habits, 21
 * defauts, ci-dessous). Ils ne connaissent AUCUN vrai clip : a reecrire avec
 * leur date et leur n apres la sonde (plan, etape 6).
 *
 * Revue du 13/10/2026, ajoutes : direction (chaque image plus proche de SA pose),
 * cote de l'arme, taille et appui contre la pose (le geste compris), appui d'une
 * direction a l'autre, foulee et alternance des jambes, derive du torse, residus
 * opaques, franges de chrominance ; sol et halo pris sur la PIRE image.
 * ======================================================================== */
const T = require('./traite');
const { ecartPieds } = require('./choix');
const { MIROIR_DE, ELEV, HAUT_CORPS } = require('./guide');

/* La foulee attendue par cycle, en hauteurs de corps (guide.js reference() : 2 x foulee
   x projection de la diagonale / hauteur) : marche 0,545, course 0,818. */
const PAS_CYCLE = (() => { const diag = Math.sqrt(0.5 + 0.5 * Math.sin(ELEV) ** 2); return { walk: 2 * 0.30 * diag / HAUT_CORPS, run: 2 * 0.45 * diag / HAUT_CORPS }; })();

/* Mesures de calibrage du 13/10/2026 (« banc » ci-dessous) : de faux clips H.264 4:2:0
   du mannequin a travers toute la chaine, 3 habits — « perso » (droite et gauche de
   couleurs differentes), « sym » (symetrique, baton fin de la couleur du torse a 23
   niveaux pres) et « sabre » (symetrique, lame claire hors du corps, comme pirate,
   piratesse et lieutenant) —, 5 actions x 4 directions chacun (60 lignes, 8 images),
   et 20 defauts fabriques (guide.clipFaux), dont les 12 de la revue du 13/10/2026.
   Les memes cas (fabrique_essai.js + guide.clipFaux) sont rejoues par planches_chaine.test.js. */
const SEUILS = {
  /* hauteur dans une ligne, mesuree du sommet a la ligne du SOL (fixe) et non au bas
     de la silhouette : en iso le pied avant descend a l'ecran a chaque foulee.
     « 5 % au plus » (releve 12/10), nos planches 1,3-7,0 % ; 6 %. La course REBONDIT :
     la course propre de l'exemple AutoSprite 4.webp donne 6,0-7,7 % (revue du 13/10,
     7 rangees sur 8 refusees a 6 %) ; le mannequin, dont la tete ne rebondit pas, 0,76 %.
     Course : 10 %. Un zoom de 12 % reste au-dessus. A RECALER sur la sonde. Essaye le
     13/10 et ecarte : une taille par recouvrement (IoU, echelle cherchee de 0,70 a 1,40)
     — stable au repos (+-2 %), elle sautait de 0,70 a 1,40 sur les rangees de course
     d'AutoSprite et de 0,78 a 1,15 sur la course du mannequin (bras qui pompent). */
  taille_ligne: 6, taille_ligne_run: 10,
  /* ligne des pieds (bas de la silhouette) : 4 % de profil, 8 % de face au releve
     (AutoSprite 0,6-3,4 % / 7-11 %). En iso la marche la fait varier PAR CONSTRUCTION
     (le pied avant passe sous la ligne du sol) : mannequin du 12/10/2026, 4 directions
     x 8 images, marche 10,4-12,5 %, course 11,5-17,7 %. Pieds poses (repos, attaque) : 6 % */
  pieds: { idle: 6, attack: 6, walk: 14, run: 20 },
  /* glisse du torse (etendue du x du torse sur la ligne), % de la hauteur. Un balancement
     n'est pas une glissade : le sabre qui balance deplace le centre du torse (banc :
     marche jusqu'a 6,3 %, course 9,9 %) et la course propre d'AutoSprite 4.webp va de 6,1
     a 8,4 %. Etendue : 8 % (repos, marche), 12 % (course). La glissade elle-meme est
     `derive` : un balancement revient, une glissade non. */
  glisse: 8, glisse_run: 12,
  /* derive du torse sur UNE periode du clip (moyenne de |x(i+P) - x(i)|), % du corps :
     banc 0,02-0,25 % ; la figure qui traverse son emplacement 9,6-10,7 %. 3 % */
  derive: 3,
  /* jambes / torse (XOR, bande 75-100 % contre 15-60 %) : lieutenant droite 0,96 = jambes immobiles ;
     nos bonnes lignes 1,35-5,2. Ecart des pieds le long de l'axe de marche, max/min : brasier 1,01-1,04 immobile */
  jambes_ratio: 1.3, jambes_ecart: 1.25,
  /* la foulee par cycle contre celle du guide (0,545 corps en marche, 0,818 en course) :
     banc 0,89-1,24 ; des ciseaux sur place (la jambe droite toujours devant) 0,08-0,10 en
     SE et NW. Revue du 13/10/2026 : la foulee n'etait verifiee que dans l'essai. 0,7 du
     guide (ce qu'un monstre aux jambes courtes peut faire : A RECALER sur la sonde). */
  foulee: 0.7,
  /* le pied le plus bas change de cote EXACTEMENT 2 fois par cycle : banc 2 partout (40
     lignes de marche et de course) ; ciseaux 0, 4, 6 ou 8 selon la direction (sauf NE : 2,
     vu par la foulee ailleurs). Valeur = |changements - 2| */
  alternance: 0,
  /* l'appui au sol contre la pose, % du corps : pieds poses (repos, attaque, saut au
     repos) des deux cotes, banc 0-3,1 % (la pointe du sabre en fente) ; marche et course :
     seulement si les pieds MONTENT (la foulee iso les fait descendre), banc au plus 3,1 %.
     Une direction qui flotte : marche 10,9 %, attaque 23,4 %. 4 % */
  appui: 4,
  /* l'appui d'une direction a l'autre (meme action), ecart max-min en % du corps : banc
     0,8-4,7 % ; une direction qui flotte 12,5 % (marche), 24,2 % (attaque). 6 % */
  appui_dirs: 6,
  /* couture de la foulee sur le clip : < 0,5 propre, > 0,8 a refaire (regle de Scenario, releve 12/10) */
  couture_clip: 0.8,
  /* couture sur les 8 images (7 -> 0) rapportee au pas moyen 0->1->...->7 : nos planches 0,46-1,51 sur 4 images */
  couture_8: 1.8,
  /* geste : la derniere image revient pres de la premiere (part de l'ecart maximal) */
  geste_retour: 0.35, geste_ampleur: 12,
  /* repos : un mouvement non nul (XOR moyen entre images voisines) — sinon c'est une image figee */
  repos_mouvement: 0.002,
  /* sol colle : base continue (plus long segment opaque des 4 % du bas / hauteur) — rodeur 0,35-0,51,
     les autres 0,04-0,29. Le PIRE des images (revue du 13/10/2026 : la mediane laissait passer
     une ombre presente sur 3 images sur 8) : banc au plus 0,279 ; l'ombre qui clignote 0,527 */
  sol_base: 0.32,
  /* halo : part des pixels semi-transparents (alpha 8-200) qui NE touchent PAS un pixel
     opaque — le bord anti-crenele d'une figure nette est exclu, une ombre ou une lueur
     detachee compte. Mesure du 12/10/2026 sur les 40 planches du jeu (160 lignes) :
     l'ancienne mesure (tous les semi-transparents, seuil 0,12 du releve) rejetait 12
     planches sur 40, dont les spectres translucides PAR DESSIN (oracle 0,24-0,28,
     veilleur 0,23-0,24) ; rodeur (0,23) n'en sortait pas du lot. Le halo : 26/40
     a 0,03 au plus, spectres et lave 0,07-0,14 (leur style). Le seuil est donc
     RELATIF a l'ancienne planche du meme monstre quand elle existe (+0,04),
     0,04 sinon. Le PIRE des images et non plus la moyenne (revue du 13/10/2026) : le
     banc monte alors a 0,036 (une image de saut, une de course) ; 0,04. */
  halo: 0.04,
  /* debris : part des pixels opaques dans des taches de moins de 2 % de la figure.
     Le releve demandait « la plus grosse tache >= 99 % » ; mais une pointe d'arme
     cachee derriere la tete est une tache a part LEGITIME (mannequin, attaque NW :
     0,858). Ce qui est vise, ce sont les miettes de detourage : <= 1 % */
  tache: 0.01,
  /* residus : part des pixels opaques (hors bord) d'une couleur que les poses n'ont pas —
     trainee grise, poussiere, fond mal detoure ACCROCHE au corps (le halo et les taches ne
     les voient pas : fantomes gris opaques d'AutoSprite 3.webp, revue du 13/10/2026).
     Banc au plus 0,014 ; une trainee grise derriere la tete sur 15 % du cycle 0,051. 0,03 */
  residus: 0.03,
  /* franges : part du bord (alpha >= 200) d'une couleur que l'interieur des poses n'a pas,
     MOINS la meme part sur la pose. Mannequin colore en H.264 4:2:0 : 0,46-0,50 avant la
     reprise de la chrominance du bord (traite.js), 0,03-0,07 apres ; la pose 0,003. 0,15 */
  franges: 0.15,
  /* couleur de chaque image contre la moyenne de sa ligne (Hellinger, 64 cases). Le
     releve du 12/10 donnait 0,08 sur des planches PEINTES (nos planches 0,021-0,039) ;
     une image tiree d'une video 4:2:0 melange la couleur a chaque frontiere entre deux
     pieces de couleurs vives : faux clips du mannequin colore (H.264 yuv420p, 12/10/2026),
     5 actions x 4 directions x 8 images = 160 images, 0,027-0,110. Le ninja refait par
     AutoSprite (video aussi) : 0,115-0,132, « a verifier a l'oeil ». Une lame claire qui
     entre et sort du champ en balancant (banc « sabre », 13/10/2026) : jusqu'a 0,161 en
     course pour une lame de 0,28 corps, 0,188 pour 0,34 corps. 0,18 (A RECALER sur la
     sonde : le sabre du pirate est long) ; une ombre qui clignote sur 3 images sur 8 :
     0,193 (et `sol` la voit aussi). */
  couleur: 0.18,
  /* premiere image du clip contre notre pose PNG (un clip non epingle part d'ailleurs) :
     le seul passage en video coute 0,143-0,158 au mannequin colore (20 lignes) */
  depart: 0.20,
  /* taille entre directions, entre actions, et contre la pose (au repos pour un geste) :
     nos planches 1,03-1,07 (releve du 12/10), banc 1,00-1,048. 1,08 : une direction 12 %
     plus grande (1,109) tombe, un zoom de camera de 30 % pendant l'attaque (1,281) aussi.
     Revue du 13/10/2026 : 1,15 laissait passer le saut de 12 %. */
  taille_dirs: 1.08,
  /* --- l'identite de la vue : la direction, et le cote de l'arme ---
     Seuils par GROUPE d'actions : le repos reste pres de la pose (les comparaisons y sont
     franches), la marche, la course, l'attaque et le saut bougent (bras, arme qui balance).
     direction : mediane, sur les images, de (concordance avec SA pose) - (la meilleure des
       trois autres). Banc repos 0,354-0,498, en mouvement -0,014 (course « sym ») a 0,411.
       Une vue qui se tourne vers la camera (NE -> SE) : -0,10 a -0,24 ; SW = SE retourne
       (habit « perso ») -0,18, NW = NE retourne -0,12 ; au repos, une copie retournee d'un
       monstre symetrique 0,027 (sabre) et 0,124 (baton). Repos >= 0,15, mouvement >= -0,05.
     miroir : mediane de (accord avec U) - (accord avec T) sur la region ou la vue T et la
       copie retournee U (le miroir de la vue voisine) different. Banc repos -0,60 a -0,276,
       mouvement jusqu'a +0,138 (course, baton). Copies : repos +0,088 (baton), -0,092
       (sabre) ; marche « perso » +0,159. Repos <= -0,20, mouvement <= 0,20.
     arme_cote : les pixels de l'arme (couleurs apprises sur T et U), plus pres du cote de
       T ou de U : (|x - xT| - |x - xU|) / |xT - xU|, de -1 (cote de T) a +1 (cote de U),
       mediane sur les images. Mesure seulement si T et U MONTRENT l'arme (autant de pixels
       a 30 % pres) a 0,06 corps au moins l'une de l'autre : SE et SW pour le banc ; en NW
       la lame est cachee derriere le corps (et une lame de NE qui balance vers le centre
       s'y confondait : jusqu'a +0,89 en course, vraie vue). Banc « sabre » (lame de 0,28
       et de 0,34 corps) au plus +0,08 ; SW = SE retourne +0,94 a +1, l'arme dans la main
       gauche +1. <= 0,5. Au REPOS, la pire image aussi (l'arme y balance peu) : banc au
       plus -0,24, l'arme passee dans l'autre main 2 images sur 8 +1.
     Limites de ces trois mesures (sur les 8 images gardees et par cases exactes) : un
       baton fin de la couleur du torse n'y a pas de couleurs propres ; une copie retournee
       limitee a la marche d'un monstre symetrique n'y est vue que si sa lame l'est ; l'arme
       qui change de main en marchant s'y confond avec le balancement. Ces trois cas sont
       repris sur TOUT le clip par cote, cote_presence et arme_saut (ci-dessous). */
  direction: { repos: 0.15, mouvement: -0.05 },
  miroir: { repos: -0.2, mouvement: 0.2 },
  arme_cote: 0.5, arme_ecart_min: 0.06, arme_vues_min: 0.7,
  /* --- le cote sur TOUT le clip (24 i/s), couleur par couleur (cotes() ci-dessous) ---
     Deuxieme passage du 13/10/2026 : le banc ci-dessus laissait passer deux cas de la revue,
     rejoues tels quels avec son propre script (et repris dans planches_chaine.test.js,
     section 3) : « arme_change_de_main » (le baton dans
     la main gauche une demi-seconde sur deux en marchant, verdict ok) et
     « symetrique_sw_copie » (monstre symetrique au baton, SW = SE retourne en marchant, ok).
     Mesures sur 30 faux clips (3 habits ; idle, walk, run, attack, jump ; vraies vues,
     copies retournees, arme qui change de main), 4 directions chacun, puis la chaine
     entiere sur les temoins des 3 habits et 6 defauts :
     cote : moyenne, sur le clip, de q = (x - xT) / (xU - xT) pour chaque couleur « de cote »
       (dans T et dans U, a des x differents) ; la PIRE couleur. Vraies vues 0,41 au plus
       (une jambe en saut), copies retournees 1,03 a 1,18. 0,7.
     cote_presence : une couleur visible dans une vue et cachee dans l'autre (la lame, de dos
       en NW) : q = (n - nT) / (nU - nT), n ramene a la surface de la pose, les pieds exclus (un
       pied se montre et se cache a chaque pas : 0,56 en marche, 0,87 pour une figure 12 %
       plus grande). Repos : vraies vues 0,013 au plus, copies 1,00 : 0,5. Marche : vraies vues
       0,33 au plus (le bras qui montre la lame en balancant), copies 0,99 : 0,7. Pas en course
       ni dans un geste (vraies vues jusqu'a 0,57 en course, 0,71 en attaque : la lame s'y montre).
     arme_saut : le plus grand saut de q d'une image a la suivante (les deux visibles), pour
       les couleurs bien separees (xU - xT >= 0,2 corps, l'arme) : repos, marche, course et saut
       des vraies vues 0,37 au plus ; l'arme qui change de main 1,69 a 2,28. 1,0. Pas dans
       l'attaque : le coup lui-meme fait 1,43 a 1,64 en une image.
     Ce qui reste a l'oeil (sprite_lab.html) : une copie retournee de NW ou NE en course ou
     dans un geste pour un monstre symetrique (la lame, cachee de dos, n'y dit rien de sur),
     et l'arme qui change de main PENDANT le coup. Seuils provisoires : faux clips seulement,
     la sonde dira ce que font les vrais. */
  cote: 0.7, cote_presence: { idle: 0.5, walk: 0.7 }, arme_saut: 1.0,
};

function composantes(m, w, h) {
  const vu = new Uint8Array(w * h), tailles = [], pile = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || vu[i]) continue;
    let n = 0; pile.push(i); vu[i] = 1;
    while (pile.length) {
      const j = pile.pop(); n++;
      const x = j % w, y = (j / w) | 0;
      if (x > 0 && m[j - 1] && !vu[j - 1]) { vu[j - 1] = 1; pile.push(j - 1); }
      if (x < w - 1 && m[j + 1] && !vu[j + 1]) { vu[j + 1] = 1; pile.push(j + 1); }
      if (y > 0 && m[j - w] && !vu[j - w]) { vu[j - w] = 1; pile.push(j - w); }
      if (y < h - 1 && m[j + w] && !vu[j + w]) { vu[j + w] = 1; pile.push(j + w); }
    }
    tailles.push(n);
  }
  const s = tailles.reduce((a, b) => a + b, 0);
  return { n: tailles.length, grosse: s ? Math.max(...tailles) / s : 0, miettes: s ? tailles.filter((t) => t < 0.02 * s).reduce((a, b) => a + b, 0) / s : 0 };
}

function histo(d, n) {
  const h = new Float64Array(64); let s = 0;
  for (let i = 0; i < n; i++) if (d[i * 4 + 3] > T.ALPHA) { h[(d[i * 4] >> 6) * 16 + (d[i * 4 + 1] >> 6) * 4 + (d[i * 4 + 2] >> 6)]++; s++; }
  if (s) for (let k = 0; k < 64; k++) h[k] /= s;
  return h;
}
function hellinger(p, q) { let s = 0; for (let k = 0; k < 64; k++) s += Math.sqrt(p[k] * q[k]); return Math.sqrt(Math.max(0, 1 - s)); }

/** Le halo d'une image : semi-transparents sans voisin opaque (alpha >= 200), sur les pixels visibles. */
function halo(d, C) {
  let a = 0, h = 0;
  for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
    const v = d[(y * C + x) * 4 + 3];
    if (v <= 8) continue;
    a++;
    if (v >= 200) continue;
    let pres = false;
    for (let dy = -1; dy <= 1 && !pres; dy++) for (let dx = -1; dx <= 1 && !pres; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < C && yy < C) pres = d[(yy * C + xx) * 4 + 3] >= 200;
    }
    if (!pres) h++;
  }
  return a ? h / a : 0;
}

function plusLong(m, w, y) { let best = 0, cur = 0; for (let x = 0; x < w; x++) { cur = m[y * w + x] ? cur + 1 : 0; if (cur > best) best = cur; } return best; }
const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
const r2 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000);

/* XOR moyen entre images voisines sur une bande de hauteur [lo, hi] de la silhouette (boucle comprise). */
function bande(M, B, C, lo, hi, boucle) {
  const r = [], N = M.length;
  for (let i = 0; i < (boucle ? N : N - 1); i++) {
    const j = (i + 1) % N, t = Math.min(B[i].y0, B[j].y0), h = Math.max(B[i].h, B[j].h);
    r.push(T.xor(M[i], M[j], Math.floor(t + lo * h) * C, Math.min(C, Math.floor(t + hi * h) + 1) * C));
  }
  return r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
}

/* ---- mesures par image (revue du 13/10/2026) ---- */

/* Franges : part des pixels opaques du BORD (alpha >= 200, un transparent a 1 px) d'une
   couleur que l'INTERIEUR des poses n'a pas (palette de cases de 16 niveaux, elargie
   d'une case — la mesure de la revue du 13/10/2026 : « a plus de 40 de toute couleur de
   la palette »). La video 4:2:0 + le detourage donnaient un liseré orange autour du
   rouge, cyan autour du bleu : 40 a 51 % du bord sur le mannequin, 3 % sur la pose.
   Comparee a la meme mesure sur la pose de la direction. */
function franges(d, C, palInt) {
  const A = (x, y) => (x < 0 || y < 0 || x >= C || y >= C ? 0 : d[(y * C + x) * 4 + 3]);
  let nb = 0, nf = 0;
  for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
    if (A(x, y) < 200) continue;
    let t = false;
    for (let dy = -1; dy <= 1 && !t; dy++) for (let dx = -1; dx <= 1 && !t; dx++) t = A(x + dx, y + dy) < 128;
    if (!t) continue;
    nb++;
    const o = (y * C + x) * 4;
    if (!palInt[(d[o] >> 4) * 256 + (d[o + 1] >> 4) * 16 + (d[o + 2] >> 4)]) nf++;
  }
  return nb ? nf / nb : 0;
}

/* La palette d'une ou plusieurs poses : cases de 16 niveaux par canal occupees par au
   moins 2 pixels opaques, elargies d'une case (le bruit de la video). */
function palette(poses, C, interieur) {
  const n = new Uint16Array(4096), ok = new Uint8Array(4096);
  const A = (d, x, y) => (x < 0 || y < 0 || x >= C || y >= C ? 0 : d[(y * C + x) * 4 + 3]);
  for (const d of poses) for (let i = 0; i < C * C; i++) {
    if (d[i * 4 + 3] <= T.ALPHA) continue;
    if (interieur) {
      /* l'interieur : aucun transparent a 3 px (le bord de la pose n'apprend rien) */
      const x = i % C, y = (i / C) | 0; let t = false;
      for (let dy = -3; dy <= 3 && !t; dy++) for (let dx = -3; dx <= 3 && !t; dx++) t = A(d, x + dx, y + dy) < 128;
      if (t) continue;
    }
    n[(d[i * 4] >> 4) * 256 + (d[i * 4 + 1] >> 4) * 16 + (d[i * 4 + 2] >> 4)]++;
  }
  for (let r = 0; r < 16; r++) for (let g = 0; g < 16; g++) for (let b = 0; b < 16; b++) {
    if (n[r * 256 + g * 16 + b] < 2) continue;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const R = r + dr, G = g + dg, B = b + db;
      if (R >= 0 && G >= 0 && B >= 0 && R < 16 && G < 16 && B < 16) ok[R * 256 + G * 16 + B] = 1;
    }
  }
  return ok;
}
/* Residus : part des pixels opaques (hors bord) d'une couleur que la pose n'a pas — une
   trainee grise, de la poussiere, un bout de fond mal detoure accroche au corps. Le halo
   et les taches ne les voyaient pas (fantomes gris OPAQUES de l'exemple AutoSprite 3.webp :
   halo 0,009-0,010, taches 0-0,008, tout vert). */
function residus(d, C, pal) {
  const op = (i) => d[i * 4 + 3] > T.ALPHA;
  let n = 0, r = 0;
  for (let y = 1; y < C - 1; y++) for (let x = 1; x < C - 1; x++) {
    const i = y * C + x;
    if (!op(i) || !op(i - 1) || !op(i + 1) || !op(i - C) || !op(i + C)) continue;
    n++;
    if (!pal[(d[i * 4] >> 4) * 256 + (d[i * 4 + 1] >> 4) * 16 + (d[i * 4 + 2] >> 4)]) r++;
  }
  return n ? r / n : 0;
}

/* Accord de deux images sur une region D (masque de pixels) : meme opacite, et meme
   couleur a 24 niveaux pres si les deux sont opaques. */
function accord(a, b, D, w) {
  let n = 0, k = 0;
  for (let i = 0; i < w * w; i++) {
    if (!D[i]) continue;
    n++;
    const pa = a[i * 4 + 3] > T.ALPHA, pb = b[i * 4 + 3] > T.ALPHA;
    if (pa !== pb) continue;
    if (!pa || (Math.abs(a[i * 4] - b[i * 4]) + Math.abs(a[i * 4 + 1] - b[i * 4 + 1]) + Math.abs(a[i * 4 + 2] - b[i * 4 + 2])) / 3 < 24) k++;
  }
  return n ? k / n : 0;
}
/* La region ou la vraie vue T et la copie retournee U different (dilatee d'un pixel) :
   pour un monstre symetrique, c'est l'arme (et ce qui n'est pas symetrique) ; pour le
   mannequin, aussi les membres (droite et gauche de couleurs differentes). */
function regionD(Tv, U, w) {
  const D0 = new Uint8Array(w * w), D = new Uint8Array(w * w);
  for (let i = 0; i < w * w; i++) {
    const pa = Tv[i * 4 + 3] > T.ALPHA, pb = U[i * 4 + 3] > T.ALPHA;
    if (pa !== pb || (pa && (Math.abs(Tv[i * 4] - U[i * 4]) + Math.abs(Tv[i * 4 + 1] - U[i * 4 + 1]) + Math.abs(Tv[i * 4 + 2] - U[i * 4 + 2])) / 3 >= 24)) D0[i] = 1;
  }
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    if (!D0[y * w + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < w) D[Y * w + X] = 1; }
  }
  return D;
}

/* ---- le cote de l'arme ----
   Les couleurs de l'arme : celles qui sont BIEN plus frequentes dans la region ou la vraie
   vue T et la copie retournee U different (pour un monstre symetrique, l'arme) que dans
   le reste du corps (cases de 16 niveaux, au moins 4 fois plus frequentes). */
const caseRVB = (d, i) => (d[i * 4] >> 4) * 256 + (d[i * 4 + 1] >> 4) * 16 + (d[i * 4 + 2] >> 4);
function couleursArme(Tv, U, D, w) {
  const nD = new Float64Array(4096), nC = new Float64Array(4096);
  let sD = 0, sC = 0;
  for (const img of [Tv, U]) for (let i = 0; i < w * w; i++) {
    if (img[i * 4 + 3] <= T.ALPHA) continue;
    if (D[i]) { nD[caseRVB(img, i)]++; sD++; } else { nC[caseRVB(img, i)]++; sC++; }
  }
  const ok = new Uint8Array(4096);
  if (!sD) return ok;
  for (let k = 0; k < 4096; k++) if (nD[k] >= 3 && nD[k] / sD > 4 * (nC[k] + 1) / Math.max(1, sC)) ok[k] = 1;
  return ok;
}
/* Les pixels de l'arme d'une image : combien, et ou par rapport au torse (en hauteurs de
   corps, positif = a droite de l'ecran). */
function coteArme(d, w, cells, hC) {
  const m = T.masque(d, w, w), b = T.bbox(m, w, w);
  if (!b) return { n: 0, x: 0 };
  const tx = T.torse(m, w, w, b);
  let n = 0, sx = 0;
  for (let i = 0; i < w * w; i++) if (m[i] && cells[caseRVB(d, i)]) { n++; sx += (i % w) - tx; }
  return { n, x: n ? sx / n / hC : 0 };
}

/* ---- le cote sur tout le clip, couleur par couleur ----
   Une palette des deux poses T (cette direction) et U (le MIROIR de la voisine : cette
   direction avec l'arme dans l'autre main, pour un monstre symetrique) : la couleur moyenne
   de chaque case de 16 niveaux d'au moins 20 px, les cases a moins de 24 l'une de l'autre
   fusionnees. Chaque pixel d'une image va a la couleur de la palette la plus proche (a
   moins de 48). Mesure du 13/10/2026 : par cases exactes, le baton orange (215, 96, 32)
   sortait de sa case en H.264 4:2:0 et n'etait vu que sur 0 a 40 % des images de marche ;
   par la couleur la plus proche, sur 80 a 100 %. */
const d2 = (a, r, g, b) => (a[0] - r) * (a[0] - r) + (a[1] - g) * (a[1] - g) + (a[2] - b) * (a[2] - b);
function paletteCote(imgs, C) {
  const n = new Float64Array(4096), s = new Float64Array(4096 * 3);
  for (const d of imgs) for (let i = 0; i < C * C; i++) {
    if (d[i * 4 + 3] <= T.ALPHA) continue;
    const k = caseRVB(d, i); n[k]++; s[k * 3] += d[i * 4]; s[k * 3 + 1] += d[i * 4 + 1]; s[k * 3 + 2] += d[i * 4 + 2];
  }
  const P = []; for (let k = 0; k < 4096; k++) if (n[k] >= 20) P.push({ c: [s[k * 3] / n[k], s[k * 3 + 1] / n[k], s[k * 3 + 2] / n[k]], n: n[k] });
  P.sort((a, b) => b.n - a.n);
  const out = [];
  for (const p of P) {
    const o = out.find((q) => d2(q.c, p.c[0], p.c[1], p.c[2]) < 24 * 24);
    if (!o) { out.push({ c: p.c.slice(), n: p.n }); continue; }
    const t = o.n + p.n; o.c = o.c.map((v, j) => (v * o.n + p.c[j] * p.n) / t); o.n = t;
  }
  return out.map((p) => p.c);
}
/* combien de pixels de chaque couleur de la palette, et leur x moyen par rapport au torse */
function parCouleur(d, C, pal) {
  const m = T.masque(d, C, C), b = T.bbox(m, C, C);
  if (!b) return null;
  const tx = T.torse(m, C, C, b), n = new Float64Array(pal.length), sx = new Float64Array(pal.length), sy = new Float64Array(pal.length);
  let tot = 0;
  for (let i = 0; i < C * C; i++) {
    if (!m[i]) continue;
    tot++;
    const r = d[i * 4], g = d[i * 4 + 1], bl = d[i * 4 + 2];
    let j0 = -1, e0 = 48 * 48;
    for (let j = 0; j < pal.length; j++) { const e = d2(pal[j], r, g, bl); if (e < e0) { e0 = e; j0 = j; } }
    if (j0 >= 0) { n[j0]++; sx[j0] += (i % C) - tx; sy[j0] += ((i / C) | 0) - b.y0; }
  }
  return { n, sx, sy, h: b.h, tot };
}
/**
 * Le cote de chaque couleur « de cote » sur les images [i0, i1) du clip, contre T et U.
 * Rend { position, presence, saut, couleurs } (voir SEUILS.cote) ou null si rien ne
 * distingue T de U.
 */
function cotes(clip, C, Tv, U, i0, i1) {
  const pal = paletteCote([Tv, U], C), sT = parCouleur(Tv, C, pal), sU = parCouleur(U, C, pal);
  if (!sT || !sU) return null;
  const hC = sT.h, pos = [], pres = [];
  for (let j = 0; j < pal.length; j++) {
    const a = sT.n[j], b = sU.n[j];
    if (Math.max(a, b) >= 40 && Math.min(a, b) / Math.max(a, b) < 0.35) {
      /* pas les pieds : un pied se montre et se cache a chaque pas (le pied droit en NW, vrai
         mannequin en marche : 0,56 ; 0,87 pour une figure 12 % plus grande) */
      const v = a > b ? sT : sU, yMoy = v.sy[j] / Math.max(1, v.n[j]) / v.h;
      if (yMoy < 0.8) pres.push({ j, nT: a, nU: b });
      continue;
    }
    if (a < 20 || b < 20 || Math.min(a, b) / Math.max(a, b) < 0.5) continue;
    const xT = sT.sx[j] / a, xU = sU.sx[j] / b, sep = Math.abs(xU - xT) / hC;
    if (sep >= 0.1) pos.push({ j, nT: a, nU: b, xT, xU, sep });
  }
  if (!pos.length && !pres.length) return null;
  const S = []; for (let i = Math.max(0, i0); i < Math.min(clip.length, i1); i++) S.push(parCouleur(clip[i], C, pal));
  let position = null, presence = null, saut = null;
  const couleurs = [];
  for (const c of pos) {
    /* visible : au moins la moitie de ses pixels de la pose (une arme cachee ne dit rien) */
    const q = S.map((s) => (s && s.n[c.j] >= 0.5 * Math.min(c.nT, c.nU) ? (s.sx[c.j] / s.n[c.j] - c.xT) / (c.xU - c.xT) : null));
    const vis = q.filter((x) => x != null);
    if (vis.length < 3) continue;
    const moy = vis.reduce((a, b) => a + b, 0) / vis.length;
    let j = 0; for (let i = 1; i < q.length; i++) if (q[i] != null && q[i - 1] != null) j = Math.max(j, Math.abs(q[i] - q[i - 1]));
    position = Math.max(position == null ? -Infinity : position, moy);
    if (c.sep >= 0.2) saut = Math.max(saut == null ? 0 : saut, j);
    couleurs.push({ c: pal[c.j].map(Math.round), sep: r2(c.sep), moy: r2(moy), saut: r2(j), vues: vis.length });
  }
  for (const c of pres) {
    /* compte ramene a la surface de la pose (une figure 12 % plus grande montre 25 % de pixels en plus) */
    const q = S.filter(Boolean).map((s) => (s.n[c.j] * sT.tot / Math.max(1, s.tot) - c.nT) / (c.nU - c.nT));
    if (!q.length) continue;
    const moy = q.reduce((a, b) => a + b, 0) / q.length;
    presence = Math.max(presence == null ? -Infinity : presence, moy);
    couleurs.push({ c: pal[c.j].map(Math.round), presence: true, moy: r2(moy) });
  }
  return { position, presence, saut, couleurs, n: S.length };
}

/**
 * Les controles d'une ligne (une action, une direction).
 * F : les n images gardees (RGBA C x C) ; info : ce que le choix a mesure ;
 * pose : la case de la pose de cette direction (reference de couleur) ;
 * coupes : pixels sortis de la case ; sortie : images ou la figure touche le
 * bord de son emplacement dans la video ; ext (facultatif) : { poses: {dir: case},
 * corps, pal } pour les controles contre la pose (direction, cote de l'arme,
 * taille, appui, residus, franges).
 */
function ligne(action, dir, F, C, info, pose, coupes, sortie, sol, ref0, haloRef, ext) {
  ext = ext || {};
  const solPx = (sol == null ? 0.88 : sol) * C;
  const n = F.length, N = C * C, out = [];
  /* les controles image par image portent aussi sur les images HD en plus (une sur deux) */
  const FX = ext.extra && ext.extra.length ? F.concat(ext.extra) : F;
  const M = F.map((d) => T.masque(d, C, C)), B = M.map((m) => T.bbox(m, C, C));
  const add = (id, valeur, seuil, sens, extra) => out.push(Object.assign({ id, action, dir, valeur: r2(valeur), seuil, sens, n,
    ok: Number.isFinite(valeur) && (sens === '<=' ? valeur <= seuil : valeur >= seuil) }, extra || {}));
  if (B.some((b) => !b)) { add('vide', 1, 0, '<='); return { controles: out, mesures: {} }; }
  const H = B.map((b) => b.h), BOT = B.map((b) => b.y1), TX = M.map((m, i) => T.torse(m, C, C, B[i]));
  const HS = B.map((b) => solPx - b.y0);   /* du sommet a la ligne du sol */
  const hm = H.reduce((a, b) => a + b, 0) / n;
  const boucle = action === 'idle' || action === 'walk' || action === 'run';
  const geste = action === 'attack' || action === 'jump';
  /* au repos du geste : la premiere et la derniere image gardees */
  const repos = geste ? [0, n - 1] : F.map((_, i) => i);
  const mesures = { h_med: med(repos.map((i) => HS[i])), pied_med: med(repos.map((i) => BOT[i])) };

  if (boucle) {
    add('taille_ligne', 100 * (Math.max(...HS) - Math.min(...HS)) / med(HS), action === 'run' ? SEUILS.taille_ligne_run : SEUILS.taille_ligne, '<=');
    add('glisse', 100 * (Math.max(...TX) - Math.min(...TX)) / hm, action === 'run' ? SEUILS.glisse_run : SEUILS.glisse, '<=');
    const pas = []; for (let i = 0; i < n - 1; i++) pas.push(T.ecart(F[i], F[i + 1], N));
    add('boucle', T.ecart(F[n - 1], F[0], N) / Math.max(1e-6, pas.reduce((a, b) => a + b, 0) / pas.length), SEUILS.couture_8, '<=');
  }
  if (SEUILS.pieds[action]) add('pieds', 100 * (Math.max(...BOT) - Math.min(...BOT)) / hm, SEUILS.pieds[action], '<=');
  if (action === 'walk' || action === 'run') {
    add('boucle_clip', info.couture, SEUILS.couture_clip, '<=', { periodeS: r2(info.periodeS) });
    if (info.derive != null) add('derive', info.derive, SEUILS.derive, '<=');
    const jambes = bande(M, B, C, 0.75, 1.0, true), torse = bande(M, B, C, 0.15, 0.6, true);
    add('jambes', torse > 0 ? jambes / torse : 0, SEUILS.jambes_ratio, '>=');
    const e = F.map((d) => ecartPieds(d, C, dir));
    add('jambes_ecart', Math.max(...e) / Math.max(1, Math.min(...e)), SEUILS.jambes_ecart, '>=');
    /* la foulee et l'alternance : des jambes qui BOUGENT ne suffisent pas, il faut qu'elles marchent */
    if (ext.corps && info.pasCase != null) add('foulee', info.pasCase / (PAS_CYCLE[action] * ext.corps), SEUILS.foulee, '>=', { pasCase: r2(info.pasCase) });
    /* exactement 2 changements par cycle : 0 = la meme jambe toujours devant ; 4 et plus =
       un pied qui oscille sans que les jambes se croisent (ciseaux vus de dos) */
    if (info.alternances) add('alternance', Math.abs(info.alternances.n - 2), SEUILS.alternance, '<=', { n: info.alternances.lues, changements: info.alternances.n, ecart_px: info.alternances.ecart });
  }
  if (action === 'idle') {
    let s = 0; for (let i = 0; i < n; i++) s += T.xor(M[i], M[(i + 1) % n]);
    add('repos_mouvement', s / n, SEUILS.repos_mouvement, '>=');
  }
  if (geste) {
    const e = F.map((d) => T.ecart(d, F[0], N)), mx = Math.max(...e);
    add('geste_ampleur', mx, SEUILS.geste_ampleur, '>=');
    add('geste_retour', mx > 0 ? e[n - 1] / mx : 1, SEUILS.geste_retour, '<=');
  }
  /* sol colle et halo : sur CHAQUE image (le pire), pas la mediane ni la moyenne — une
     ombre qui clignote sur 3 images sur 8 se voit a chaque boucle (revue du 13/10/2026) */
  const base = M.map((m, i) => { let b = 0; for (let y = Math.max(0, B[i].y1 - Math.max(1, Math.round(0.04 * B[i].h))); y <= B[i].y1; y++) b = Math.max(b, plusLong(m, C, y)); return b / B[i].h; });
  add('sol', Math.max(...base), SEUILS.sol_base, '<=');
  add('halo', Math.max(...FX.map((d) => halo(d, C))), Math.round(((haloRef == null ? 0 : haloRef) + SEUILS.halo) * 1000) / 1000, '<=', { n: FX.length });
  /* rien de coupe, rien au bord, une seule figure */
  const MX = FX === F ? M : M.concat(ext.extra.map((d) => T.masque(d, C, C)));
  let bord = 0;
  for (const m of MX) { let t = false; for (let k = 0; k < C && !t; k++) t = m[k] || m[(C - 1) * C + k] || m[k * C] || m[k * C + C - 1]; if (t) bord++; }
  add('coupes', coupes + bord + (sortie || 0), 0, '<=', { px_coupes: coupes, images_au_bord: bord, images_hors_emplacement: sortie || 0, n: FX.length });
  add('taches', Math.max(...MX.map((m) => composantes(m, C, C).miettes)), SEUILS.tache, '<=', { n: FX.length });
  /* identite : chaque image contre la MOYENNE de sa ligne (la mesure de qc_planche.py:89-90,
     celle qui a donne 0,021-0,039 sur nos planches), et la premiere image du clip
     contre notre pose (un clip non epingle peut partir d'ailleurs) */
  const hs = F.map((d) => histo(d, N)), moy = new Float64Array(64);
  for (const h of hs) for (let k = 0; k < 64; k++) moy[k] += h[k] / n;
  add('couleur', Math.max(...hs.map((h) => hellinger(h, moy))), SEUILS.couleur, '<=');
  if (ref0 && pose) add('depart', hellinger(histo(ref0, N), histo(pose, N)), SEUILS.depart, '<=', { n: 1 });

  /* ---- contre la pose : taille, appui au sol, direction, cote de l'arme, residus, franges ---- */
  if (pose) {
    const pm = T.masque(pose, C, C), pb = T.bbox(pm, C, C);
    if (pb) {
      const hP = pb.h;
      /* la taille contre la pose (repos du geste ; toute la ligne en boucle) : un zoom de
         camera sur toute l'attaque passait (revue du 13/10/2026, NW x1,30) */
      const rT = mesures.h_med / (solPx - pb.y0);
      add('taille_pose', Math.max(rT, 1 / rT), SEUILS.taille_dirs, '<=', { n: repos.length });
      /* l'appui au sol, en absolu (la ligne des pieds contre celle de la pose) : une
         direction qui marche 12 % au-dessus du sol passait. Pieds poses (repos, geste) :
         des deux cotes ; en marche et en course, le pied le plus pres de la camera
         descend a l'ecran a chaque foulee (iso) : on ne refuse que ce qui MONTE. */
      const d = 100 * (pb.y1 - mesures.pied_med) / hP;
      mesures.appui = d;
      add('appui', boucle && action !== 'idle' ? d : Math.abs(d), SEUILS.appui, '<=', { n: repos.length });
    }
    if (ext.pal) add('residus', Math.max(...FX.map((d) => residus(d, C, ext.pal))), SEUILS.residus, '<=', { n: FX.length });
    if (ext.palInt) {
      const fP = franges(pose, C, ext.palInt);
      add('franges', Math.max(...FX.map((d) => franges(d, C, ext.palInt))) - fP, SEUILS.franges, '<=', { pose: r2(fP), n: FX.length });
    }
  }
  if (ext.poses && ext.poses[dir]) {
    const w = C >> 1, Fh = FX.map((d) => T.moitie(d, C, C));
    const Ph = {}; for (const [d, p] of Object.entries(ext.poses)) Ph[d] = T.moitie(p, C, C);
    /* direction : chaque image est plus proche de SA pose que des trois autres (une vue
       NE qui se tourne vers la camera au milieu d'un clip epingle passait) */
    const autres = Object.keys(Ph).filter((d) => d !== dir);
    if (autres.length) {
      const cP = {}; for (const d of Object.keys(Ph)) cP[d] = centre(Ph[d], w);
      const marges = Fh.map((f) => { const cf = centre(f, w), s0 = concorde(f, Ph[dir], w, cf, cP[dir]); return s0 - Math.max(...autres.map((d) => concorde(f, Ph[d], w, cf, cP[d]))); });
      add('direction', med(marges), action === 'idle' ? SEUILS.direction.repos : SEUILS.direction.mouvement, '>=', { pire: r2(Math.min(...marges)) });
    }
    /* le cote de l'arme : contre la pose T de cette direction et U, le MIROIR de la pose
       voisine (SE retourne pour SW...) — pour un monstre symetrique, U est cette direction
       avec l'arme dans l'AUTRE main. Sur la region ou T et U different, chaque image doit
       ressembler a T : la mediane dit si la ligne est une copie retournee (miroir), la pire
       image si l'arme change de main en cours de route (arme). */
    const part = MIROIR_DE[dir];
    if (part && Ph[part]) {
      const Tv = Ph[dir], U = T.miroir(Ph[part], w, w), D = regionD(Tv, U, w);
      let nD = 0; for (let i = 0; i < w * w; i++) nD += D[i];
      if (nD >= 20) {
        const q = Fh.map((f) => accord(f, U, D, w) - accord(f, Tv, D, w));
        add('miroir', med(q), action === 'idle' ? SEUILS.miroir.repos : SEUILS.miroir.mouvement, '<=', { region_px: nD * 4 });
        /* le cote de l'arme : ses pixels (couleurs apprises sur T et U), a gauche ou a droite
           du torse, plus pres de T ou de U */
        const cells = couleursArme(Tv, U, D, w), hC = (T.bbox(T.masque(Tv, w, w), w, w) || { h: w / 2 }).h;
        const aT = coteArme(Tv, w, cells, hC), aU = coteArme(U, w, cells, hC);
        const vis = Math.max(6, 0.25 * Math.max(aT.n, aU.n));
        const xT = aT.n >= vis ? aT.x : 0, xU = aU.n >= vis ? aU.x : 0;
        const qa = Fh.map((f) => coteArme(f, w, cells, hC)).filter((c) => c.n >= vis).map((c) => Math.abs(c.x - xT) - Math.abs(c.x - xU));
        /* mesurable si les DEUX vues montrent l'arme (sinon, de dos, la lame cachee derriere
           le corps ne dit rien) et la mettent assez loin l'une de l'autre ; q ramene a cet
           ecart (-1 : du cote de T, +1 : du cote de U) */
        const sep = Math.abs(xT - xU), vues = Math.min(aT.n, aU.n) / Math.max(1, aT.n, aU.n);
        if (sep >= SEUILS.arme_ecart_min && vues >= SEUILS.arme_vues_min && qa.length >= 3) {
          const qn = qa.map((x) => x / sep);
          add('arme_cote', med(qn), SEUILS.arme_cote, '<=', { n: qa.length, pire: r2(Math.max(...qn)), ecart: r2(sep) });
          if (action === 'idle') add('arme_image', Math.max(...qn), SEUILS.arme_cote, '<=', { n: qa.length, ecart: r2(sep) });
        }
      }
    }
  }
  /* le cote sur TOUT le clip (hors des 0,4 s epinglees du debut et de la fin), couleur par
     couleur : une copie retournee (cote, cote_presence) et l'arme qui change de main
     (arme_saut), meme pour un monstre symetrique dont l'arme est fine */
  const part = MIROIR_DE[dir];
  if (ext.clip && ext.clip.length && ext.poses && ext.poses[dir] && part && ext.poses[part]) {
    const marge = Math.round(0.4 * (ext.fps || 24));
    const k = cotes(ext.clip, C, ext.poses[dir], T.miroir(ext.poses[part], C, C), marge, ext.clip.length - marge);
    if (k) {
      const plus = { n: k.n, couleurs: k.couleurs };
      if (k.position != null) add('cote', k.position, SEUILS.cote, '<=', plus);
      if (k.presence != null && SEUILS.cote_presence[action] != null) add('cote_presence', k.presence, SEUILS.cote_presence[action], '<=', plus);
      if (k.saut != null && action !== 'attack') add('arme_saut', k.saut, SEUILS.arme_saut, '<=', plus);
    }
  }
  return { controles: out, mesures };
}

/* Concordance forme + couleur de deux images (demi-resolution) : 1 = la meme image.
   Les deux figures sont d'abord recalees sur leurs centres de masse (chaque direction a
   sa propre ancre, tiree de SA pose : un SE retourne pose dans l'emplacement SW n'a ni
   le meme torse ni les memes pieds que le vrai SW — premier essai sans recalage, le
   miroir decale passait a 0,33), puis +-1 px autour. */
function centre(d, w) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > T.ALPHA) { sx += x; sy += y; n++; }
  return n ? [sx / n, sy / n] : [w / 2, w / 2];
}
function concorde(a, b, w, ca, cb) {
  ca = ca || centre(a, w); cb = cb || centre(b, w);
  const bx = Math.round(cb[0] - ca[0]), by = Math.round(cb[1] - ca[1]);
  let best = 0;
  for (let dy = by - 1; dy <= by + 1; dy++) for (let dx = bx - 1; dx <= bx + 1; dx++) {
    let u = 0, k = 0;
    for (let y = 0; y < w; y++) {
      const yb = y + dy; if (yb < 0 || yb >= w) continue;
      for (let x = 0; x < w; x++) {
        const xb = x + dx; if (xb < 0 || xb >= w) continue;
        const i = (y * w + x) * 4, j = (yb * w + xb) * 4, pa = a[i + 3] > T.ALPHA, pb = b[j + 3] > T.ALPHA;
        if (!pa && !pb) continue;
        u++;
        if (pa && pb && (Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2])) / 3 < 24) k++;
      }
    }
    if (u && k / u > best) best = k / u;
  }
  return best;
}

/**
 * Les controles de la planche entiere.
 * L : { action: { dir: { F (gardees), Fh (tout le clip, demi-resolution), mesures } } }
 */
function planche(L, C, dirs) {
  const out = [];
  /* taille entre directions (par action en boucle) et entre actions (par direction) */
  for (const action of Object.keys(L)) {
    if (!['idle', 'walk', 'run'].includes(action)) continue;
    const h = dirs.filter((d) => L[action][d]).map((d) => L[action][d].mesures.h_med);
    if (h.length > 1) { const v = Math.max(...h) / Math.min(...h); out.push({ id: 'taille_dirs', action, valeur: r2(v), seuil: SEUILS.taille_dirs, sens: '<=', n: h.length * 8, ok: v <= SEUILS.taille_dirs }); }
  }
  for (const dir of dirs) {
    const h = ['idle', 'walk', 'run'].filter((a) => L[a] && L[a][dir]).map((a) => L[a][dir].mesures.h_med);
    if (h.length > 1) { const v = Math.max(...h) / Math.min(...h); out.push({ id: 'taille_actions', dir, valeur: r2(v), seuil: SEUILS.taille_dirs, sens: '<=', n: h.length * 8, ok: v <= SEUILS.taille_dirs }); }
  }
  /* la ligne des pieds d'une direction a l'autre (contre la pose de chacune) : une seule
     direction qui flotte se voit meme en course, ou la foulee iso fait descendre les pieds */
  for (const action of Object.keys(L)) {
    const a = dirs.filter((d) => L[action][d] && Number.isFinite(L[action][d].mesures.appui)).map((d) => L[action][d].mesures.appui);
    if (a.length > 1) { const v = Math.max(...a) - Math.min(...a); out.push({ id: 'appui_dirs', action, valeur: r2(v), seuil: SEUILS.appui_dirs, sens: '<=', n: a.length * 8, ok: v <= SEUILS.appui_dirs }); }
  }
  return out;
}

module.exports = { SEUILS, PAS_CYCLE, ligne, planche, concorde, composantes, hellinger, histo, halo, franges, palette, residus, regionD, accord, couleursArme, coteArme, cotes, paletteCote };
