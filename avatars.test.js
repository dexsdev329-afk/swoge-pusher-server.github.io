'use strict';
/*
 * Les photos de profil.
 *
 * Ce n'est pas « une image sur un compte » : c'est une image que le joueur
 * fait apparaitre SUR L'ECRAN DES AUTRES. Les verifications qui comptent sont
 * donc toutes des refus — et chacune correspond a une facon connue de faire
 * passer autre chose qu'une image.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-avatars-'));
process.env.DATA_DIR = bac;
for (const m of ['./config', './avatars']) { try { delete require.cache[require.resolve(m)]; } catch (e) {} }
const av = require('./avatars');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const jete = (f, re, m) => { assert.throws(f, re, m); n++; };

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';

const uri = (mime, octets) => 'data:' + mime + ';base64,' + Buffer.from(octets).toString('base64');
const JPEG = [0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 73, 72, 68, 82];
const WEBP = [0x52, 0x49, 0x46, 0x46, 20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 86, 80, 56, 32];

// ------------------------------------------------------- ce qui est accepte
{
  eq(av.existe(A), false, 'personne n a d image au depart');
  eq(av.enregistre(A, uri('image/jpeg', JPEG)).ext, 'jpg', 'un JPEG passe');
  eq(av.existe(A), true, 'et il est la');
  const l = av.lit(A);
  eq(l.mime, 'image/jpeg', 'servi avec le bon type');
  eq(l.corps.length, JPEG.length, 'et les bons octets');

  eq(av.enregistre(A, uri('image/png', PNG)).ext, 'png', 'un PNG remplace le JPEG');
  const p = fs.readdirSync(path.join(bac, 'avatars')).filter((f) => f.startsWith(A.slice(2, 8)) || f.includes(A.slice(2)));
  eq(p.length, 1, 'UN SEUL fichier par joueur, quel que soit le format');
  eq(av.enregistre(A, uri('image/webp', WEBP)).ext, 'webp', 'un WebP aussi');
}

// ------------------------------------------ ce qui est refuse, et pourquoi
{
  /* Le type ANNONCE ne decide de rien. Sans controle des octets d'en-tete,
     n'importe quel fichier passerait derriere une etiquette « image/jpeg » —
     c'est la facon la plus simple de faire servir autre chose qu'une image. */
  jete(() => av.enregistre(B, uri('image/jpeg', [0x4D, 0x5A, 0x90, 0x00])),
       /JPEG, PNG or WebP/, 'un executable etiquete « image/jpeg » : refuse');
  jete(() => av.enregistre(B, uri('image/png', Buffer.from('<html><script>alert(1)</script>'))),
       /JPEG, PNG or WebP/, 'du HTML etiquete « image/png » : refuse');

  /* Le SVG est une image pour un navigateur, mais c'est un DOCUMENT : il peut
     porter du script, et il s'afficherait chez les autres joueurs. */
  jete(() => av.enregistre(B, uri('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>'))),
       /JPEG, PNG or WebP/, 'un SVG : refuse, c est un document et il peut porter du script');

  jete(() => av.enregistre(B, 'pas une adresse de donnees'), /unsupported image/, 'du texte brut : refuse');
  jete(() => av.enregistre(B, 'data:image/jpeg;base64,'), /unsupported image/, 'une image vide : refuse');
  jete(() => av.enregistre(B, uri('image/jpeg', new Array(av.MAX_OCTETS + 500).fill(0xFF))),
       /too large/, 'plus gros que la limite : refuse');
  jete(() => av.enregistre('pas une adresse', uri('image/jpeg', JPEG)), /unknown player/,
       'une adresse invalide : refuse');
  eq(av.existe(B), false, 'et apres tous ces refus, B n a toujours aucune image');
}

// ------------------------------- la borne est posee AVANT le decodage
/* Une chaine de plusieurs megaoctets ne doit pas devenir un tampon de
   plusieurs megaoctets pour etre ensuite refusee : ce serait exactement le
   levier qu'on cherche a retirer. */
{
  const enorme = 'data:image/jpeg;base64,' + 'A'.repeat(8 * 1024 * 1024);
  const t0 = Date.now();
  jete(() => av.enregistre(B, enorme), /too large/, 'huit megaoctets : refuses');
  const dt = Date.now() - t0;
  ok(dt < 500, `et refuses tout de suite (${dt} ms), sans etre decodes`);
}

// ------------------------------------------------------------ la suppression
{
  ok(av.existe(A), 'A a une image');
  eq(av.supprime(A), true, 'on peut la retirer');
  eq(av.existe(A), false, 'et elle a bien disparu');
  eq(av.lit(A), null, 'plus rien a servir');
  eq(av.supprime(A), false, 'retirer deux fois ne casse rien');
}

// -------------------------------------- on ne sort pas du dossier
{
  eq(av.lit('../../etc/passwd'), null, 'un chemin qui remonte ne lit rien');
  eq(av.supprime('../../etc/passwd'), false, 'et n efface rien');
  jete(() => av.enregistre('../../evil', uri('image/jpeg', JPEG)), /unknown player/,
       'ni n ecrit ailleurs');
}

fs.rmSync(bac, { recursive: true, force: true });
console.log(`avatars.test.js : ${n} verifications OK`);
