'use strict';
/* ==================================================================
 * SWOLEMIND — UNE PHOTO OU UN PDF JOINT A LA QUESTION
 * ==================================================================
 *
 * Demande du propriétaire, le 26 septembre 2026 : « joindre un PDF ou une
 * photo pour que l'IA la lise ». Aucune logique d'argent ici : on vérifie les
 * pièces, on compte ce qu'une image pèse dans le pire cas, et on les met dans
 * la forme de chaque fournisseur. C'est `studio_chat.js` qui réserve.
 *
 * Ce que chaque fournisseur accepte, relu le même jour :
 *   - Anthropic : blocs `image` (base64, media_type) et `document`
 *     (base64, application/pdf) — tous les modèles actifs lisent images et
 *     PDF ; 32 Mo par requête ; une page de PDF = 1 500 à 3 000 jetons de
 *     texte PLUS une image. Le compte exact se demande avant
 *     (`messages.countTokens`) : on réserve sur lui, pas sur une estimation.
 *   - OpenAI (spécification Chat Completions) : partie `image_url`
 *     { url: data:…;base64, detail } ; GPT-6 Sol et Luna : « image_input ».
 *     Découpe en carrés de 32 px, multiplicateur 1,2 (1,62 au plus haut listé).
 *   - xAI : `image_url.url` en data URL, jpg/png, 20 Mio au plus ; Grok 4.7,
 *     4.20 et 4.3 lisent les images.
 * Les PDF ne partent qu'à Claude : c'est le seul dont on peut compter le coût
 * EXACT avant l'appel. Ailleurs, on devinerait — et on ne devine pas.
 * ================================================================== */

const MAX_IMAGES = 4;
const MAX_PDF = 1;
const IMAGE_OCTETS_MAX = 5 * 1024 * 1024;
const PDF_OCTETS_MAX = 10 * 1024 * 1024;
/* La page réduit chaque photo à 1 568 px de grand côté ; au-delà de 2 048,
   c'est qu'elle a été contournée, et le pire cas ne serait plus borné. */
const IMAGE_COTE_MAX = 2048;
/* Au-delà, un PDF coûte plus qu'une question : on le refuse et on le dit. */
const PDF_JETONS_MAX = 200000;
const MEDIAS = { 'image/jpeg': 'image', 'image/png': 'image', 'application/pdf': 'pdf' };

/** Les dimensions lues dans l'en-tête (PNG : IHDR ; JPEG : le premier SOF). */
function dimensions(b, media) {
  if (media === 'image/png') {
    if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { l: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (media === 'image/jpeg') {
    if (b[0] !== 0xff || b[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const mk = b[i + 1];
      if (mk === 0xff) { i++; continue; }
      const long = b.readUInt16BE(i + 2);
      /* SOF0..SOF15, sauf DHT (C4), JPG (C8) et DAC (CC). */
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { h: b.readUInt16BE(i + 5), l: b.readUInt16BE(i + 7) };
      i += 2 + long;
    }
  }
  return null;
}

/** Le pire cas d'une image, en jetons d'entrée, tous fournisseurs : les
 *  carrés de 32 px × 2 (au-dessus du 1,62 le plus haut publié chez OpenAI) ;
 *  chez Anthropic, l×h/750, soit 1,37 par carré — couvert aussi. */
function jetonsImage(l, h) { return Math.ceil(l / 32) * Math.ceil(h / 32) * 2 + 100; }

/**
 * Vérifie les pièces jointes de toute la conversation. Rend
 * `{ messages }` (les pièces normalisées, sur les messages du joueur
 * seulement) ou `{ erreur }` — un refus dit toujours pourquoi.
 */
function verifie(messages) {
  let images = 0, pdf = 0;
  const out = [];
  for (const x of Array.isArray(messages) ? messages : []) {
    if (!x || !Array.isArray(x.pieces) || !x.pieces.length || x.role !== 'user') { out.push(x && x.pieces ? Object.assign({}, x, { pieces: undefined }) : x); continue; }
    const pieces = [];
    for (const p of x.pieces) {
      const media = String((p && p.media) || '').toLowerCase();
      const genre = MEDIAS[media];
      if (!genre) return { erreur: 'only photos (JPEG, PNG) and PDF files can be attached' };
      const data = String(p.data || '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { erreur: 'the attached file is unreadable' };
      const b = Buffer.from(data, 'base64');
      const nom = String(p.nom || (genre === 'pdf' ? 'document.pdf' : 'photo')).replace(/[^\w .()-]/g, '_').slice(0, 80);
      if (genre === 'pdf') {
        if (++pdf > MAX_PDF) return { erreur: 'one PDF per question' };
        if (b.length > PDF_OCTETS_MAX) return { erreur: 'this PDF is too large (max 10 MB)' };
        if (b.toString('latin1', 0, 5) !== '%PDF-') return { erreur: nom + ' is not a PDF' };
        pieces.push({ genre, media, data, nom, octets: b.length });
      } else {
        if (++images > MAX_IMAGES) return { erreur: 'at most ' + MAX_IMAGES + ' photos per question' };
        if (b.length > IMAGE_OCTETS_MAX) return { erreur: 'this photo is too large (max 5 MB)' };
        const d = dimensions(b, media);
        if (!d || !d.l || !d.h) return { erreur: nom + ' is not a readable ' + (media === 'image/png' ? 'PNG' : 'JPEG') };
        if (d.l > IMAGE_COTE_MAX || d.h > IMAGE_COTE_MAX) return { erreur: 'this photo is too large (max ' + IMAGE_COTE_MAX + ' px per side)' };
        pieces.push({ genre, media, data, nom, octets: b.length, l: d.l, h: d.h });
      }
    }
    out.push(Object.assign({}, x, { pieces }));
  }
  return { messages: out, images, pdf };
}

/** Les jetons d'entrée des images d'une conversation, pire cas. */
function jetonsImages(messages) {
  let t = 0;
  for (const x of messages || []) for (const p of x.pieces || []) if (p.genre === 'image') t += jetonsImage(p.l, p.h);
  return t;
}
const aUnPdf = (messages) => (messages || []).some((x) => (x.pieces || []).some((p) => p.genre === 'pdf'));

/** Un message pour Anthropic : les pièces d'abord (ce que la doc recommande), puis le texte. */
function pourClaude(x) {
  if (!x.pieces || !x.pieces.length) return { role: x.role, content: x.content };
  return { role: x.role, content: x.pieces.map((p) => (p.genre === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } }
    : { type: 'image', source: { type: 'base64', media_type: p.media, data: p.data } }))
    .concat([{ type: 'text', text: x.content }]) };
}

/** Un message pour OpenAI et xAI (Chat Completions). Jamais de PDF ici. */
function pourCompat(x) {
  if (!x.pieces || !x.pieces.length) return { role: x.role, content: x.content };
  return { role: x.role, content: x.pieces.filter((p) => p.genre === 'image')
    .map((p) => ({ type: 'image_url', image_url: { url: 'data:' + p.media + ';base64,' + p.data, detail: 'high' } }))
    .concat([{ type: 'text', text: x.content }]) };
}

module.exports = { verifie, dimensions, jetonsImage, jetonsImages, aUnPdf, pourClaude, pourCompat,
  MAX_IMAGES, MAX_PDF, IMAGE_OCTETS_MAX, PDF_OCTETS_MAX, IMAGE_COTE_MAX, PDF_JETONS_MAX };
