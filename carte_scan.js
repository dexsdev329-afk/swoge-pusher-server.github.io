'use strict';
/* ==========================================================================
 * LA CARTE D UN SCAN, EN PNG, POUR LES APERCUS DE LIENS
 *
 * Le site est statique sur GitHub Pages et les robots de X ne lisent pas le
 * JavaScript : la carte dessinee dans la page ne sera jamais vue par eux.
 * Celle-ci est ecrite par le serveur, pixel par pixel (`carte_png.js`), sans
 * une seule dependance.
 *
 * Elle porte les memes chiffres que celle du navigateur — les memes cases,
 * les memes effectifs, la meme ligne « never a buy signal ». Deux cartes qui
 * diraient deux choses differentes du meme jeton seraient pires qu une seule.
 *
 * ---- EN ANGLAIS, ET SANS CODE BRUT (audit du 26 septembre 2026) ----
 *
 * La carte partagee montrait les CLES internes de la colonie : « OCTEMIT »
 * au-dessus de « code : sans emission ». Une carte faite pour etre vue par
 * des inconnus sur X parlait donc francais et montrait un nom de variable.
 * Les cles ne bougent pas a la source (ce sont des cles de memoire, voir
 * `MOTS` dans ai_colonie.js) : on traduit A LA SORTIE, ici, avec la table
 * de la colonie pour les cases et `NOMS_TRAITS` pour les traits. Une case
 * que la table ne connait pas N APPARAIT PAS sur la carte — mieux vaut une
 * ligne de moins qu un code brut ; l essai de la colonie exige de toute
 * facon que chaque libelle ait sa traduction.
 *
 * ---- SANS DOUBLON ----
 *
 * Mesure sur le scan de LOBSTER (0x254a…8dc5) le 26 septembre 2026 : les
 * quatre cases du bytecode (octEmit, octListe, octPause, octFrais) portaient
 * +16,9 % sur 2 395 a 2 398 observations — la MEME population lue quatre
 * fois (0,13 % d ecart d effectif), donc quatre lignes identiques a l oeil ;
 * et les cinq cases pons (« not from pons ») portaient toutes 57 293
 * observations a +3,3 %. Une ligne par phrase rendue, et une seule ligne par
 * mesure : meme moyenne et effectifs a moins de 0,5 % (au moins 3) — les
 * phrases differentes d une meme mesure sont fusionnees, la plus petite des
 * n est gardee (chaque phrase de la ligne tient sur au moins autant).
 * ======================================================================== */

const C = require('./carte_png');

const L = 1200, H = 630;
const FOND = '#0a1f44', BANDE = '#12305f';
const BLANC = '#e8f0ff', BLEU = '#7fb0ff', PALE = '#a8c4ee', GRIS = '#6c86b2';
const VERT = '#5bd99a', ROUGE = '#ff7b72', ROUGEFOND = '#3a1418', ROUGEPALE = '#ff9a94';

/* ---- LE NOM ANGLAIS DE CHAQUE TRAIT ----
 * Un par cle de `TRAITS` (ai_colonie.js). carte_scan.test.js parcourt la
 * table de la colonie : un trait ajoute demain sans sa ligne ici fait
 * echouer l essai, pas la carte d un visiteur. Les quatre traits du bytecode
 * partagent un nom : c est une seule lecture du contrat. */
const NOMS_TRAITS = Object.freeze({
  age: 'Pool age', liq: 'Liquidity', mc: 'Market cap', elan: '5-minute move',
  press: 'Buy pressure (1 h)', uniq: 'Unique traders (1 h)', accel: 'Volume trend',
  origine: 'How the colony found it',
  pons: 'Pons launchpad', ponsGradAge: 'Pons graduation', ponsVitesse: 'Pons graduation speed',
  ponsDep: 'Launcher on pons', ponsInit: 'Launcher first buy',
  pad: 'Launchpad', padDep: 'Launcher history',
  avis: 'Colony advisor', cobaye: 'Simulated sell', lp: 'Liquidity tokens',
  taxe: 'Buy + sell tax',
  octEmit: 'Contract bytecode', octListe: 'Contract bytecode', octPause: 'Contract bytecode', octFrais: 'Contract bytecode',
  code: 'Source code', pouv: 'Owner powers',
  top: 'Largest holder', det: 'Holders', brule: 'Supply burned',
  flux: 'Who trades', achUniq: 'Unique buyers', taille: 'Average ticket',
  pools: 'Number of pools', accord: 'Price sources', social: 'Social links', vola: 'Volatility',
});
/* Un trait que la table ne connait pas encore : un nom generique, jamais la cle. */
const TRAIT_INCONNU = 'Colony measure';
/* Plusieurs cases « on n a pas pu lire » fusionnees en une ligne ; plusieurs
   traits differents qui mesurent les memes jetons. */
const NON_LU = 'Not read on this token';
const PLUSIEURS = 'Several traits, same tokens';

/* La table des cases vit dans la colonie ; chargee a la demande (le module
   est deja en memoire dans le serveur). */
let colonieM = null;
const colonie = () => (colonieM || (colonieM = require('./ai_colonie')));

/** Le nom anglais d un trait (croise « a×b » : ses parts). null si inconnu. */
function nomTrait(trait) {
  const parts = String(trait == null ? '' : trait).split('×').map((p) => NOMS_TRAITS[p.trim()]);
  return parts.length && parts.every(Boolean) ? parts.join(' × ') : null;
}

/** La phrase anglaise d une case, ou null si la table de la colonie ne la connait pas. */
function phraseCase(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const { MOTS, enMots } = colonie();
  if (MOTS[s] !== undefined) return MOTS[s];
  if (/^\d+e prolongation$/.test(s)) return enMots(s);
  const parts = s.split(' × ');
  if (parts.length > 1 && parts.every((p) => MOTS[p.trim()] !== undefined)) return enMots(s);
  return null;
}

/* Une case « on n a pas pu lire » (la liste de la colonie). */
const nonLue = (v) => { const f = colonie().caseNonLue; return typeof f === 'function' ? !!f(v) : false; };

/* Meme mesure : meme moyenne, effectifs a moins de 0,5 % (au moins 3). */
const memeMesure = (a, b) => a.moyenne === b.moyenne && Math.abs(a.n - b.n) <= Math.max(3, 0.005 * Math.max(a.n, b.n));

/** Des phrases d une meme mesure en une : « bytecode: no mint, no pause » quand elles partagent leur tete. */
function fusionne(phrases) {
  const d = [...new Set(phrases)];
  if (d.length === 1) return d[0];
  const tetes = d.map((p) => (/^([^:]{1,24}): /.exec(p) || [])[1]);
  if (tetes[0] && tetes.every((t) => t === tetes[0])) return tetes[0] + ': ' + d.map((p) => p.slice(tetes[0].length + 2)).join(', ');
  return d.join(' · ');
}

/**
 * Les cases d un scan, en anglais et sans doublon, les plus tranchees
 * d abord. Chaque ligne garde sa cle (`trait`, `case`) et gagne `label`
 * (la phrase) et `traitLabel` (le nom du trait). Une case intraduisible
 * est ecartee.
 */
function casesEnAnglais(cases) {
  const lignes = [];
  for (const c of cases || []) {
    const label = phraseCase(c && c.case);
    if (!label || !(Number(c.n) > 0)) continue;
    const x = Object.assign({}, c, { label, traitLabel: nomTrait(c.trait) || TRAIT_INCONNU });
    /* La meme phrase deux fois : la plus observee reste (une ligne deja
       fusionnee la porte deja, elle ne bouge pas). */
    const meme = lignes.find((l) => l._phrases.some((p) => p.toLowerCase() === label.toLowerCase()));
    if (meme) {
      if (meme._phrases.length === 1 && x.n > meme.n) Object.assign(meme, x, { _phrases: meme._phrases });
      continue;
    }
    /* La meme mesure sous une autre phrase : une seule ligne. */
    const groupe = lignes.find((l) => memeMesure(l, x));
    if (groupe) {
      groupe._phrases.push(label);
      groupe._noms.add(x.traitLabel);
      groupe._nonLues = groupe._nonLues && nonLue(c.case);
      groupe.label = fusionne(groupe._phrases);
      groupe.n = Math.min(groupe.n, x.n);
      /* Plusieurs traits sous une ligne : leur nom commun si c est la meme
         lecture ; « rien n a ete lu » quand toutes disent qu on ne sait pas
         (le releve de LOBSTER : taxe, code, pouvoirs, sources, conseiller —
         62 993 a 63 182 observations, +2,8 %, la population entiere). */
      if (groupe._noms.size > 1) groupe.traitLabel = groupe._nonLues ? NON_LU : PLUSIEURS;
      continue;
    }
    lignes.push(Object.assign(x, { _phrases: [label], _noms: new Set([x.traitLabel]), _nonLues: nonLue(c.case) }));
  }
  return lignes.map((l) => { const o = Object.assign({}, l); delete o._phrases; delete o._noms; delete o._nonLues; return o; })
    .sort((a, b) => Math.abs(b.moyenne) - Math.abs(a.moyenne));
}

/** Les liens d un scan : l image de la carte, la page de partage (og:image), la page du site. */
function liens(adr, u) {
  const a = String(adr || '').toLowerCase();
  return { card: u.api + '/scan/carte/' + a + '.png', share: u.api + '/s/' + a, page: u.site + '/swoge_scan.html?t=' + a };
}

/**
 * Le scan public (route /scan), enrichi : ses liens, et pour CHAQUE case sa
 * phrase anglaise (`label`, null si la table ne la connait pas) et le nom de
 * son trait (`traitLabel`). Les cles brutes restent pour qui lit en
 * programme ; rien n est retire ni fusionne dans `cases`.
 *
 * `lines` : ce que la page MONTRE — les memes lignes que la carte du serveur
 * (casesEnAnglais : en anglais, sans case intraduisible, une ligne par
 * mesure). La page dessinait `cases` telles quelles : sur LOBSTER, sa carte
 * partageable portait « OCTEMIT / code : sans emission » puis trois autres
 * lignes du bytecode a +16,9 % (releve du 26 septembre 2026, 35 cases → 21
 * lignes). La carte du navigateur prend les 5 premieres, comme celle-ci.
 */
function avecLiens(r, u) {
  const cases = ((r && r.cases) || []).map((c) => Object.assign({}, c, { label: phraseCase(c.case), traitLabel: nomTrait(c.trait) || TRAIT_INCONNU }));
  /* Sans la cle brute : une ligne fusionnee en couvre plusieurs. */
  const lines = casesEnAnglais((r && r.cases) || []).map((c) => ({ traitLabel: c.traitLabel, label: c.label, n: c.n, moyenne: c.moyenne }));
  return Object.assign({}, r, { cases, lines, links: liens(r && r.jeton && r.jeton.adr, u) });
}

/* L atlas n a ni tiret long ni guillemets typographiques : on les ramene a
   ce qu il sait dessiner, plutot qu un blanc au milieu d une phrase. */
const propre = (s) => String(s == null ? '' : s).replace(/[—–]/g, '-').replace(/≥/g, '>=').replace(/≤/g, '<=')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** Coupe un texte a la largeur donnee, avec des points de suspension. */
function tiens(s, taille, max, gras) {
  s = propre(s);
  if (C.largeur(s, taille, gras) <= max) return s;
  while (s.length > 1 && C.largeur(s + '…', taille, gras) > max) s = s.slice(0, -1);
  return s + '…';
}

/* D ou vient un fait de contrat, en toutes lettres. GoPlus : la mention que
   sa licence demande (relue le 26 septembre 2026) — une image ne porte pas
   de lien, la mention en toutes lettres y suffit. */
const SOURCES = { GoPlus: 'Powered by Go+ Security', bytecode: 'read from the bytecode' };

/**
 * Ce que la carte dessine, dans l ordre : des rectangles et des textes.
 * `dessine` ne fait que le peindre ; l essai lit les textes.
 */
function plan(d) {
  const ops = [];
  const rect = (x, y, l, h, c) => ops.push({ rect: [x, y, l, h, c] });
  const txt = (texte, x, y, taille, c, o) => ops.push({ texte: propre(texte), x, y, taille, c, o: o || {} });
  rect(0, 0, L, 108, BANDE);

  const j = (d && d.jeton) || {};
  txt('SWOGE SCAN', 56, 52, 20, BLEU, { gras: true });
  txt('What our AI has measured', 56, 82, 16, PALE);
  txt(tiens('$' + (j.sym || 'TOKEN'), 34, 420, true), L - 56, 62, 34, BLANC, { gras: true, al: 'd' });
  const adr = String(j.adr || '');
  if (adr) txt(adr.slice(0, 10) + '…' + adr.slice(-6), L - 56, 88, 14, BLEU, { al: 'd' });

  /* Les faits de contrat d abord : ils ne dependent d aucune moyenne. */
  let y = 152;
  const faits = [];
  for (const f of (d && d.faits) || []) if (f && f.quoi && !faits.some((x) => x.quoi === f.quoi)) faits.push(f);
  for (const f of faits.slice(0, 2)) {
    rect(56, y - 24, L - 112, 38, ROUGEFOND);
    txt('!  ' + tiens(f.quoi, 18, 820, true), 74, y + 2, 18, ROUGEPALE, { gras: true });
    txt(SOURCES[f.source] || 'on-chain read', L - 74, y + 2, 13, '#b8746f', { al: 'd' });
    y += 48;
  }

  const cases = casesEnAnglais((d && d.cases) || []).slice(0, 5);
  if (!cases.length) txt('Not enough measured on tokens like this one yet.', 56, y + 28, 22, '#8fa6c9');
  for (const x of cases) {
    const pos = x.moyenne > 0;
    txt(tiens(x.traitLabel.toUpperCase(), 12, 760, true), 56, y - 14, 12, GRIS, { gras: true });
    txt(tiens(x.label, 22, 760, true), 56, y + 8, 22, BLANC, { gras: true });
    txt((pos ? '+' : '') + x.moyenne + '%', L - 150, y + 8, 30, pos ? VERT : ROUGE, { gras: true, al: 'd' });
    /* L effectif, TOUJOURS. Sans lui le chiffre ment. */
    txt('n=' + x.n, L - 56, y + 8, 15, GRIS, { al: 'd' });
    y += 58;
  }

  const m = (d && d.mesureSur) || {};
  rect(0, H - 72, L, 72, BANDE);
  txt(m.observations
    ? 'Measured over ' + Number(m.observations).toLocaleString('en-US') + ' judged observations · never a buy signal'
    : 'Never a buy signal', 56, H - 28, 17, PALE);
  txt('swoleeswoge.dog/swoge_scan.html', L - 56, H - 28, 17, BLEU, { gras: true, al: 'd' });
  return ops;
}

/** Les textes de la carte, dans l ordre ou elle les ecrit. */
const textes = (d) => plan(d).filter((o) => o.texte !== undefined).map((o) => o.texte);

/**
 * `d` est ce que rend `scanJeton()`. Rend un Buffer PNG.
 */
function dessine(d) {
  const t = C.toile(L, H, FOND);
  for (const o of plan(d)) {
    if (o.rect) C.rect(t, ...o.rect);
    else C.texte(t, o.texte, o.x, o.y, o.taille, o.c, o.o);
  }
  return C.png(t);
}

module.exports = { dessine, plan, textes, casesEnAnglais, phraseCase, nomTrait, liens, avecLiens, NOMS_TRAITS, TRAIT_INCONNU, NON_LU, PLUSIEURS, L, H };
