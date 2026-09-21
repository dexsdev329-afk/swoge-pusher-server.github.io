'use strict';
/* ==================================================================
 * UN RAPPORT PDF, SANS DEPENDANCE
 * ==================================================================
 * Meme choix que `carte_png.js` : un PDF est un format documente, et un
 * rapport de quinze pages de texte n en utilise qu une fraction. Tirer
 * deux megaoctets de bibliotheque pour poser des lignes de Helvetica sur
 * du A4 serait payer cher une chose qu on peut ecrire.
 *
 * Ce qu on emet : PDF 1.4, une police de base (Helvetica, presente dans
 * tout lecteur, donc rien a embarquer), du texte positionne, et une table
 * de references exacte. Pas d image, pas de transparence, pas de police
 * incorporee — rien de ce qui rend un generateur de PDF complique.
 *
 * L ENCODAGE, qui est le piege. Les polices de base sont en WinAnsi :
 * latin-1 passe tel quel — donc les accents francais — et le reste doit
 * etre remplace, sinon le lecteur affiche des carres ou refuse le fichier.
 * On remplace explicitement plutot que de laisser passer des octets que
 * personne ne saura lire. */

const A4 = { l: 595.28, h: 841.89 };
const MARGE = 48;
const INTERLIGNE = 1.35;

/* Les largeurs de Helvetica, en millieme de cadratin. Il en faut pour
   couper les lignes a la bonne longueur : sans elles, on coupe au nombre
   de caracteres et une ligne de « W » deborde quand une ligne de « i »
   laisse la moitie de la page vide. */
const LARGEURS = { ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333, '{': 334, '|': 260, '}': 334, '~': 584 };
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') LARGEURS[c] = { I: 278, J: 500, L: 556, M: 833, W: 944 }[c] || 722;
for (const c of 'abcdefghijklmnopqrstuvwxyz') LARGEURS[c] = { f: 278, i: 222, j: 222, l: 222, m: 833, r: 333, t: 278, w: 722 }[c] || 556;
function largeur(texte, taille) {
  let n = 0;
  for (const c of String(texte)) n += (LARGEURS[c] === undefined ? 556 : LARGEURS[c]);
  return n * taille / 1000;
}

/* WinAnsi : latin-1 passe, le reste est remplace par un equivalent lisible
   plutot que par un octet que le lecteur ne saura pas rendre. */
const REMPLACE = { '’': "'", '‘': "'", '“': '"', '”': '"',
  '—': '-', '–': '-', '…': '...', ' ': ' ', '→': '->', '×': 'x',
  '✓': 'v', '✗': 'x', '↗': '', '·': '-' };
function winansi(s) {
  let out = '';
  for (const c of String(s == null ? '' : s)) {
    if (REMPLACE[c] !== undefined) { out += REMPLACE[c]; continue; }
    const p = c.codePointAt(0);
    out += (p >= 32 && p <= 255) ? c : '?';
  }
  return out;
}
/* Dans un PDF, la parenthese et l antislash ferment ou echappent une
   chaine : une source qui en contient casserait le fichier entier. */
const echappe = (s) => winansi(s).replace(/([\\()])/g, '\\$1');

/* Coupe un texte a la largeur utile, en respectant les mots. Un mot plus
   long que la ligne (une URL sans espace) est coupe de force plutot que
   de deborder de la page. */
function coupe(texte, taille, large) {
  const mots = winansi(texte).split(/\s+/).filter(Boolean);
  const lignes = [];
  let cour = '';
  for (let m of mots) {
    while (largeur(m, taille) > large) {
      let i = 1;
      while (i < m.length && largeur(m.slice(0, i + 1), taille) <= large) i++;
      if (cour) { lignes.push(cour); cour = ''; }
      lignes.push(m.slice(0, i));
      m = m.slice(i);
    }
    const essai = cour ? cour + ' ' + m : m;
    if (largeur(essai, taille) <= large) { cour = essai; continue; }
    if (cour) lignes.push(cour);
    cour = m;
  }
  if (cour) lignes.push(cour);
  return lignes.length ? lignes : [''];
}

/* `lignes` : [{ texte, taille, gras, avant, gris }]. Rendu en pages A4,
   coupe et pagine tout seul. */
function pdf(titre, lignes) {
  const large = A4.l - 2 * MARGE;
  const pages = [];
  let flux = [];
  let y = A4.h - MARGE;
  const bas = MARGE + 24;

  const poseLigne = (t, taille, gras, gris) => {
    if (y < bas) { pages.push(flux); flux = []; y = A4.h - MARGE; }
    const g = gris === undefined ? 0 : gris;
    flux.push('BT /' + (gras ? 'F2' : 'F1') + ' ' + taille + ' Tf '
      + g + ' ' + g + ' ' + g + ' rg '
      + MARGE.toFixed(2) + ' ' + y.toFixed(2) + ' Td (' + echappe(t) + ') Tj ET');
    y -= taille * INTERLIGNE;
  };

  poseLigne(titre, 17, true);
  y -= 8;
  for (const l of lignes) {
    const taille = l.taille || 9.5;
    if (l.avant) y -= l.avant;
    if (l.trait) {
      if (y < bas) { pages.push(flux); flux = []; y = A4.h - MARGE; }
      flux.push('0.8 0.8 0.8 RG 0.5 w ' + MARGE + ' ' + y.toFixed(2) + ' m '
        + (A4.l - MARGE) + ' ' + y.toFixed(2) + ' l S');
      y -= 8;
      continue;
    }
    for (const t of coupe(l.texte, taille, large)) poseLigne(t, taille, !!l.gras, l.gris);
  }
  pages.push(flux);

  /* Le pied de page : le numero, et la date. Un rapport imprime sans date
     ne vaut rien six mois plus tard. */
  const jour = new Date().toISOString().slice(0, 10);
  pages.forEach((f, i) => {
    f.push('BT /F1 7.5 Tf 0.45 0.45 0.45 rg ' + MARGE + ' ' + MARGE + ' Td ('
      + echappe('SWOGE OSINT - ' + jour + ' - page ' + (i + 1) + '/' + pages.length) + ') Tj ET');
  });

  return assemble(pages);
}

/* L assemblage. La table de references veut l OCTET exact ou commence
   chaque objet : on construit donc le fichier morceau par morceau en
   comptant au fur et a mesure, plutot que de le recalculer apres coup. */
function assemble(pages) {
  const objets = [];
  const ajoute = (corps) => { objets.push(corps); return objets.length; };

  const nPages = ajoute(null);                       /* reserve : il lui faut ses enfants */
  const nFont = ajoute('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const nFontB = ajoute('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const idsPages = [];
  for (const flux of pages) {
    const contenu = flux.join('\n');
    const nFlux = ajoute('<< /Length ' + Buffer.byteLength(contenu, 'latin1') + ' >>\nstream\n' + contenu + '\nendstream');
    const nPage = ajoute('<< /Type /Page /Parent ' + nPages + ' 0 R /MediaBox [0 0 '
      + A4.l.toFixed(2) + ' ' + A4.h.toFixed(2) + '] /Resources << /Font << /F1 ' + nFont
      + ' 0 R /F2 ' + nFontB + ' 0 R >> >> /Contents ' + nFlux + ' 0 R >>');
    idsPages.push(nPage);
  }
  objets[nPages - 1] = '<< /Type /Pages /Count ' + idsPages.length + ' /Kids ['
    + idsPages.map((i) => i + ' 0 R').join(' ') + '] >>';
  const nCat = ajoute('<< /Type /Catalog /Pages ' + nPages + ' 0 R >>');

  let sortie = '%PDF-1.4\n';
  const positions = [];
  for (let i = 0; i < objets.length; i++) {
    positions.push(Buffer.byteLength(sortie, 'latin1'));
    sortie += (i + 1) + ' 0 obj\n' + objets[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(sortie, 'latin1');
  sortie += 'xref\n0 ' + (objets.length + 1) + '\n0000000000 65535 f \n';
  for (const p of positions) sortie += String(p).padStart(10, '0') + ' 00000 n \n';
  sortie += 'trailer\n<< /Size ' + (objets.length + 1) + ' /Root ' + nCat + ' 0 R >>\n'
          + 'startxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(sortie, 'latin1');
}

module.exports = { pdf, coupe, largeur, winansi, echappe, assemble, A4, MARGE };
