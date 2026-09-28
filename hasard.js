'use strict';
/* ==================================================================
 * LE HASARD PROUVABLE, VENDU AUX AGENTS (28 septembre 2026)
 * ==================================================================
 *
 * Releve du catalogue PayAI du 28/09 (mesures/catalogue_payai_2026-09-28.md) :
 * AUCUN service de verification « provably fair », trois services de hasard
 * (0,001 a 0,01 $). Un site de jeux sait faire ca : casino.js tire deja ses
 * cartes par HMAC-SHA256 (serverSeed / clientSeed / nonce). Ici, la meme
 * mecanique, ouverte a n'importe quel agent — pour un jeu entre agents, un
 * tirage au sort, un giveaway :
 *
 *   1. fair_commit : le serveur tire une graine secrete et PUBLIE son empreinte
 *      (SHA-256). Il ne peut plus la changer.
 *   2. fair_draw : l'agent donne SA graine (client_seed) ; le serveur revele la
 *      sienne et tire les nombres. Un engagement ne tire qu'UNE fois : un
 *      deuxieme appel rend le tirage d'origine (sinon, graine connue, on
 *      choisirait la graine client qui arrange).
 *   3. fair_verify : n'importe qui recalcule — l'empreinte, les nombres, ou un
 *      sabot de 52 cartes du casino SWOGE.
 *
 * L'algorithme (ALGO), assez court pour etre refait ailleurs :
 *   cle = la graine serveur (64 hexadecimaux, en texte) ; flux = HMAC-SHA256(cle,
 *   client_seed + ":" + 0), puis ":" + 1… mis bout a bout ; chaque nombre lit 4
 *   octets (entier non signe, gros-boutiste) x, rejete si x >= plafond (le plus
 *   grand multiple de n = max - min + 1 sous 2^32), sinon min + (x mod n).
 *   Empreinte = SHA-256 de la graine serveur (le texte hexadecimal).
 * Rien ne coute : du calcul. Les engagements vivent 7 jours (hasard.json).
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALGO = 'swoge-hmac-sha256-v1';
const TTL_MS = 7 * 24 * 3600e3;
const MAX_ENGAGEMENTS = 50000;
const MAX_NOMBRES = 100;
const DEUX32 = 4294967296;

const empreinte = (graine) => crypto.createHash('sha256').update(String(graine)).digest('hex');

/** Les nombres d'un tirage : entiers uniformes dans [min, max], sans biais (rejet). */
function nombres(graineServeur, graineClient, n, min, max) {
  const etendue = max - min + 1;
  const plafond = Math.floor(DEUX32 / etendue) * etendue;
  const out = [];
  let flux = Buffer.alloc(0), compteur = 0;
  while (out.length < n) {
    if (flux.length < 4) flux = Buffer.concat([flux, crypto.createHmac('sha256', String(graineServeur)).update(String(graineClient) + ':' + (compteur++)).digest()]);
    const x = flux.readUInt32BE(0);
    flux = flux.subarray(4);
    if (x >= plafond) continue;
    out.push(min + (x % etendue));
  }
  return out;
}

/* Les cartes du casino SWOGE (casino.js : entier 0..51, rang = c % 13, 0 = 2 … 12 = As ; couleur = c / 13). */
const RANGS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const COULEURS = ['c', 'd', 'h', 's'];
const carte = (c) => RANGS[c % 13] + COULEURS[(c / 13) | 0];

/** Les parametres d'un tirage, verifies. Rend { n, min, max } ou { erreur }. */
function parametres(a) {
  const n = a.count === undefined ? 1 : Number(a.count);
  const min = a.min === undefined ? 1 : Number(a.min);
  const max = a.max === undefined ? 100 : Number(a.max);
  if (!Number.isInteger(n) || n < 1 || n > MAX_NOMBRES) return { erreur: 'count must be an integer from 1 to ' + MAX_NOMBRES };
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) return { erreur: 'min and max must be integers with min <= max' };
  if (max - min + 1 > DEUX32) return { erreur: 'max - min + 1 must be at most 4,294,967,296' };
  return { n, min, max };
}
const graineClientValide = (g) => typeof g === 'string' && g.length >= 1 && g.length <= 128 && /^[\x20-\x7e]+$/.test(g);

/** Le code qui refait le tirage, a coller dans Node. */
const recette = 'const c=require("crypto");function draw(s,cs,n,min,max){const e=max-min+1,p=Math.floor(4294967296/e)*e,o=[];let f=Buffer.alloc(0),k=0;'
  + 'while(o.length<n){if(f.length<4)f=Buffer.concat([f,c.createHmac("sha256",s).update(cs+":"+(k++)).digest()]);const x=f.readUInt32BE(0);f=f.subarray(4);if(x<p)o.push(min+x%e);}return o;}'
  + ' // check: c.createHash("sha256").update(server_seed).digest("hex") === server_seed_hash';

/**
 * deps : { dossier, maintenant?, shoe? (casino.shoe, pour verifier un sabot) }
 */
function cree(deps) {
  deps = deps || {};
  const maintenant = deps.maintenant || Date.now;
  const fichier = deps.dossier ? path.join(deps.dossier, 'hasard.json') : null;
  let E = {};
  try { if (fichier) E = JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch (e) { E = {}; }
  const MESURE = { engagements: 0, tirages: 0, verifications: 0 };
  const ecritTout = () => { if (fichier) try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(fichier, JSON.stringify(E)); } catch (e) { /* jamais bloquant */ } };
  function purge() {
    const t = maintenant();
    for (const [k, v] of Object.entries(E)) if (t - v.t > TTL_MS) delete E[k];
    const cles = Object.keys(E);
    if (cles.length > MAX_ENGAGEMENTS) cles.sort((a, b) => E[a].t - E[b].t).slice(0, cles.length - MAX_ENGAGEMENTS).forEach((k) => delete E[k]);
  }

  /** 1. S'engager : une graine secrete, son empreinte publiee. */
  function engage() {
    purge();
    const graine = crypto.randomBytes(32).toString('hex');
    const id = crypto.randomBytes(12).toString('hex');
    E[id] = { graine, empreinte: empreinte(graine), t: maintenant() };
    MESURE.engagements++;
    ecritTout();                                  /* ecrit tout de suite : un redemarrage ne perd pas une graine promise */
    return { ok: true, commitment_id: id, server_seed_hash: E[id].empreinte, algorithm: ALGO, committed_at: new Date(E[id].t).toISOString(),
      expires_at: new Date(E[id].t + TTL_MS).toISOString(),
      next: 'Share server_seed_hash with the other players now. Then call fair_draw with this commitment_id and your client_seed: the server reveals its seed and draws once.' };
  }

  /** 2. Tirer : la graine revelee, les nombres ; une seule fois par engagement. */
  function tire(a) {
    a = a || {};
    const id = String(a.commitment_id || '');
    const v = E[id];
    if (!v || maintenant() - v.t > TTL_MS) return { ok: false, erreur: 'unknown or expired commitment_id (commitments live 7 days) - call fair_commit first' };
    if (v.tirage) return Object.assign({ ok: true }, v.tirage, { already_drawn: true, note: 'This commitment was already drawn: this is the original draw. A commitment draws once.' });
    if (!graineClientValide(a.client_seed)) return { ok: false, erreur: 'client_seed must be 1 to 128 printable ASCII characters' };
    const p = parametres(a);
    if (p.erreur) return { ok: false, erreur: p.erreur };
    const t = maintenant();
    v.tirage = { commitment_id: id, algorithm: ALGO, server_seed_hash: v.empreinte, server_seed: v.graine, client_seed: a.client_seed, count: p.n, min: p.min, max: p.max,
      numbers: nombres(v.graine, a.client_seed, p.n, p.min, p.max), committed_at: new Date(v.t).toISOString(), drawn_at: new Date(t).toISOString(), verify_code: recette };
    MESURE.tirages++;
    ecritTout();
    return Object.assign({ ok: true, already_drawn: false }, v.tirage);
  }

  /** 3. Verifier : l'empreinte, les nombres, ou le sabot du casino. Pur calcul. */
  function verifie(a) {
    a = a || {};
    MESURE.verifications++;
    const s = String(a.server_seed || '');
    if (!s || s.length > 256) return { ok: false, erreur: 'server_seed is required (at most 256 characters)' };
    if (!graineClientValide(a.client_seed)) return { ok: false, erreur: 'client_seed must be 1 to 128 printable ASCII characters' };
    const h = a.server_seed_hash === undefined ? null : String(a.server_seed_hash).toLowerCase();
    const recalcule = empreinte(s);
    const hashOk = h === null ? null : h === recalcule;
    const out = { ok: true, algorithm: a.scheme === 'swoge-casino-shoe' ? 'swoge-casino-shoe' : ALGO, server_seed_hash_computed: recalcule, hash_matches: hashOk };
    if (a.scheme === 'swoge-casino-shoe') {
      if (!deps.shoe) return { ok: false, erreur: 'the casino shoe check is not available here' };
      const nonce = Number(a.nonce);
      if (!Number.isSafeInteger(nonce) || nonce < 0) return { ok: false, erreur: 'nonce must be a non-negative integer for swoge-casino-shoe' };
      const d = deps.shoe(s, a.client_seed, nonce);
      return Object.assign(out, { nonce, deck: d, cards: d.map(carte) });
    }
    const p = parametres(a);
    if (p.erreur) return { ok: false, erreur: p.erreur };
    const n = nombres(s, a.client_seed, p.n, p.min, p.max);
    const attendus = Array.isArray(a.numbers) ? a.numbers.map(Number) : null;
    return Object.assign(out, { count: p.n, min: p.min, max: p.max, numbers: n,
      numbers_match: attendus ? attendus.length === n.length && attendus.every((x, i) => x === n[i]) : null });
  }

  return { engage, tire, verifie, MESURE, etat: () => ({ engagements: Object.keys(E).length, mesure: Object.assign({}, MESURE) }) };
}

module.exports = { cree, nombres, empreinte, parametres, carte, ALGO, TTL_MS, MAX_NOMBRES, recette };
