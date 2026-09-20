'use strict';
/* ==========================================================================
 * LA CARTE D UN SCAN, EN PNG, POUR LES APERCUS DE LIENS
 *
 * Le site est statique sur GitHub Pages et les robots de X ne lisent pas le
 * JavaScript : la carte dessinee dans la page ne sera jamais vue par eux.
 * Celle-ci est ecrite par le serveur, pixel par pixel (`carte_png.js`), sans
 * une seule dependance.
 *
 * Elle porte EXACTEMENT ce que porte celle du navigateur — les memes cases,
 * les memes effectifs, la meme ligne « never a buy signal ». Deux cartes qui
 * diraient deux choses differentes du meme jeton seraient pires qu une seule.
 * ======================================================================== */

const C = require('./carte_png');

const L = 1200, H = 630;
const FOND = '#0a1f44', BANDE = '#12305f';
const BLANC = '#e8f0ff', BLEU = '#7fb0ff', PALE = '#a8c4ee', GRIS = '#6c86b2';
const VERT = '#5bd99a', ROUGE = '#ff7b72', ROUGEFOND = '#3a1418', ROUGEPALE = '#ff9a94';

/** Coupe un texte a la largeur donnee, avec des points de suspension. */
function tiens(s, taille, max, gras) {
  s = String(s == null ? '' : s);
  if (C.largeur(s, taille, gras) <= max) return s;
  while (s.length > 1 && C.largeur(s + '…', taille, gras) > max) s = s.slice(0, -1);
  return s + '…';
}

/**
 * `d` est ce que rend `scanJeton()`. Rend un Buffer PNG.
 */
function dessine(d) {
  const t = C.toile(L, H, FOND);
  C.rect(t, 0, 0, L, 108, BANDE);

  const j = (d && d.jeton) || {};
  C.texte(t, 'SWOGE SCAN', 56, 52, 20, BLEU, { gras: true });
  C.texte(t, 'What our AI has measured', 56, 82, 16, PALE);
  C.texte(t, tiens('$' + (j.sym || 'TOKEN'), 34, 420, true), L - 56, 62, 34, BLANC, { gras: true, al: 'd' });
  const adr = String(j.adr || '');
  if (adr) C.texte(t, adr.slice(0, 10) + '…' + adr.slice(-6), L - 56, 88, 14, BLEU, { al: 'd' });

  /* Les faits de contrat d abord : ils ne dependent d aucune moyenne. */
  let y = 152;
  for (const f of (d.faits || []).slice(0, 2)) {
    C.rect(t, 56, y - 24, L - 112, 38, ROUGEFOND);
    C.texte(t, '!  ' + tiens(f.quoi, 18, 820, true), 74, y + 2, 18, ROUGEPALE, { gras: true });
    C.texte(t, f.source, L - 74, y + 2, 13, '#b8746f', { al: 'd' });
    y += 48;
  }

  const cases = (d.cases || []).slice(0, 5);
  if (!cases.length) {
    C.texte(t, 'Not enough measured on tokens like this one yet.', 56, y + 28, 22, '#8fa6c9');
  }
  for (const x of cases) {
    const pos = x.moyenne > 0;
    C.texte(t, String(x.trait).toUpperCase(), 56, y - 14, 12, GRIS, { gras: true });
    C.texte(t, tiens(x.case, 22, 760, true), 56, y + 8, 22, BLANC, { gras: true });
    C.texte(t, (pos ? '+' : '') + x.moyenne + '%', L - 150, y + 8, 30, pos ? VERT : ROUGE, { gras: true, al: 'd' });
    /* L effectif, TOUJOURS. Sans lui le chiffre ment. */
    C.texte(t, 'n=' + x.n, L - 56, y + 8, 15, GRIS, { al: 'd' });
    y += 58;
  }

  const m = (d && d.mesureSur) || {};
  C.rect(t, 0, H - 72, L, 72, BANDE);
  C.texte(t, m.observations
    ? 'Measured over ' + Number(m.observations).toLocaleString('en-US') + ' judged observations · never a buy signal'
    : 'Never a buy signal', 56, H - 28, 17, PALE);
  C.texte(t, 'swoleeswoge.dog/swoge_scan.html', L - 56, H - 28, 17, BLEU, { gras: true, al: 'd' });

  return C.png(t);
}

module.exports = { dessine, L, H };
