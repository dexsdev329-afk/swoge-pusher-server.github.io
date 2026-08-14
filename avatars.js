'use strict';
/*
 * Les photos de profil televersees.
 *
 * ---- ce que c'est vraiment ----
 *
 * Ce n'est pas « une image que le joueur met sur son compte ». C'est une image
 * que le joueur fait APPARAITRE SUR L'ECRAN DES AUTRES — a la table de poker,
 * dans le vestibule du Connect 4, dans la liste du Crash. Tout ce qui suit
 * decoule de la : on ne fait confiance ni au type annonce, ni a la taille
 * annoncee, ni au navigateur qui envoie.
 *
 * ---- pourquoi pas dans state.json ----
 *
 * Meme raison que le journal : l'etat est relu et reecrit en entier toutes les
 * dix secondes. Mille joueurs a huit kilo-octets d'image feraient huit
 * megaoctets reecrits sans arret pour des soldes qui n'ont pas bouge. Les
 * images vivent donc a cote, un fichier par joueur, servis par une adresse
 * dediee — et le navigateur les met en cache, ce qu'un data-URI dans un
 * message ne permet pas.
 *
 * ---- ce qui est verifie ----
 *
 *  1. la taille REELLE apres decodage, pas celle annoncee ;
 *  2. les octets d'en-tete : un fichier qui se dit JPEG doit commencer par
 *     les octets d'un JPEG. Sans ce controle, « data:image/jpeg;base64, »
 *     suivi de n'importe quoi passerait ;
 *  3. le format doit etre une image matricielle. Le SVG est refuse tout net :
 *     un SVG est un document qui peut porter du script, et il s'afficherait
 *     chez les autres joueurs.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DOSSIER = path.join(cfg.DATA_DIR, 'avatars');
const MAX_OCTETS = 32 * 1024;          // 32 Ko : largement assez pour du 128x128

/* Les signatures des trois formats acceptes. Un SVG n'a pas sa place ici :
   c'est un document, il peut porter du script, et il s'affiche chez les
   autres joueurs. */
const FORMATS = [
  { mime: 'image/jpeg', ext: 'jpg', tete: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png', ext: 'png', tete: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/webp', ext: 'webp', tete: [0x52, 0x49, 0x46, 0x46] },   // RIFF, + WEBP en 8..11
];

let pret = false;
function dossier() {
  if (!pret) { try { fs.mkdirSync(DOSSIER, { recursive: true }); pret = true; } catch (e) {} }
  return DOSSIER;
}

function cle(addr) {
  const a = String(addr || '').toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}

/** Le chemin du fichier d'un joueur, quel que soit son format, ou null. */
function fichier(addr) {
  const a = cle(addr);
  if (!a) return null;
  for (const f of FORMATS) {
    const p = path.join(dossier(), a + '.' + f.ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function commencePar(buf, octets) {
  if (buf.length < octets.length) return false;
  for (let i = 0; i < octets.length; i++) if (buf[i] !== octets[i]) return false;
  return true;
}

/**
 * Enregistre une image envoyee en data-URI.
 * @returns {{ ext:string, octets:number }}
 * @throws  avec un message lisible par le joueur
 */
function enregistre(addr, dataUri) {
  const a = cle(addr);
  if (!a) throw new Error('unknown player');
  const s = String(dataUri || '');
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) throw new Error('unsupported image');

  /* On borne AVANT de decoder : une chaine de dix megaoctets ne doit pas
     devenir dix megaoctets de tampon pour etre ensuite refusee. */
  if (m[2].length > (MAX_OCTETS * 4) / 3 + 64) throw new Error('image is too large (32 KB max)');

  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (e) { throw new Error('unsupported image'); }
  if (!buf.length) throw new Error('unsupported image');
  if (buf.length > MAX_OCTETS) throw new Error('image is too large (32 KB max)');

  /* Le type ANNONCE ne decide de rien : ce sont les octets qui parlent. Sans
     ce controle, n'importe quel fichier passerait derriere une etiquette
     « image/jpeg ». */
  const f = FORMATS.find((x) => commencePar(buf, x.tete));
  if (!f) throw new Error('only JPEG, PNG or WebP images');
  if (f.ext === 'webp' && buf.toString('ascii', 8, 12) !== 'WEBP') throw new Error('only JPEG, PNG or WebP images');

  supprime(addr);                         // un seul fichier par joueur, quel que soit le format
  const p = path.join(dossier(), a + '.' + f.ext);
  fs.writeFileSync(p, buf);
  return { ext: f.ext, octets: buf.length };
}

function supprime(addr) {
  const a = cle(addr);
  if (!a) return false;
  let fait = false;
  for (const f of FORMATS) {
    const p = path.join(dossier(), a + '.' + f.ext);
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); fait = true; } } catch (e) {}
  }
  return fait;
}

/** Le contenu a servir, avec son type. */
function lit(addr) {
  const p = fichier(addr);
  if (!p) return null;
  const f = FORMATS.find((x) => p.endsWith('.' + x.ext));
  try { return { corps: fs.readFileSync(p), mime: f.mime, mtime: fs.statSync(p).mtimeMs }; }
  catch (e) { return null; }
}

function existe(addr) { return !!fichier(addr); }

/* ====================== LES IMAGES DANS LA SAUVEGARDE ======================
 *
 * Les images vivent a cote de `state.json` — c'est la bonne decision pour
 * l'ecriture, qui a lieu toutes les dix secondes. Mais la SAUVEGARDE, elle,
 * n'emportait que `state.json` : le jour d'une restauration sur un volume
 * neuf, chaque joueur retrouvait ses jetons, son niveau, ses amis... et une
 * image cassee, parce que sa fiche disait « il en a une » et que le fichier
 * n'existait plus. Une seule ligne dans l'archive repare ca.
 *
 * Elles sont bornees : 32 Ko chacune, et un plafond global au-dela duquel on
 * en laisse — en le DISANT, parce qu'une sauvegarde qui tronque en silence
 * est pire que pas de photo du tout.
 * ========================================================================= */
const MAX_SAUVEGARDE = 20 * 1024 * 1024;   // Telegram refuse au-dela de 50 Mo

/** Toutes les images, en data-URI, pour etre glissees dans l'archive. */
function exporte(plafond) {
  const max = plafond || MAX_SAUVEGARDE;
  const images = {};
  let octets = 0, laissees = 0, n = 0;
  let noms = [];
  try { noms = fs.readdirSync(dossier()); } catch (e) { return { images, octets: 0, laissees: 0, n: 0 }; }
  noms.sort();                                   // meme archive pour le meme dossier
  for (const nom of noms) {
    const m = /^(0x[0-9a-f]{40})\.(jpg|png|webp)$/.exec(nom);
    if (!m) continue;
    const f = FORMATS.find((x) => x.ext === m[2]);
    let buf;
    try { buf = fs.readFileSync(path.join(dossier(), nom)); } catch (e) { continue; }
    if (!buf.length || buf.length > MAX_OCTETS || octets + buf.length > max) { laissees++; continue; }
    octets += buf.length; n++;
    images[m[1]] = 'data:' + f.mime + ';base64,' + buf.toString('base64');
  }
  return { images, octets, laissees, n };
}

/**
 * Repose les images d'une archive.
 *
 * Elles repassent par `enregistre()` — donc par le controle des octets
 * d'en-tete et de la taille. Un fichier de sauvegarde est un fichier comme un
 * autre : il a pu etre modifie entre l'envoi et le retour, et ce qui en sort
 * s'affiche chez les autres joueurs. On ne le recopie pas les yeux fermes.
 */
function importe(images) {
  let poses = 0, refusees = 0;
  for (const a of Object.keys(images || {})) {
    try { enregistre(a, images[a]); poses++; } catch (e) { refusees++; }
  }
  return { poses, refusees };
}

module.exports = { enregistre, supprime, lit, existe, exporte, importe,
                   MAX_OCTETS, MAX_SAUVEGARDE, DOSSIER };
