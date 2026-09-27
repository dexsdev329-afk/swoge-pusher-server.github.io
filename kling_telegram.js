'use strict';
/* ==========================================================================
 * UNE IMAGE KLING POSTEE SUR TELEGRAM, A HEURE FIXE, UNE SEULE FOIS
 *
 * Demande du proprietaire, 27 septembre 2026 : « j'ai pris le plan video et
 * image, cree une requete pour qu'a 20 h il poste dans le Telegram une image
 * Kling de SWOGE au poker, pour voir le resultat ».
 *
 * C'est un ESSAI : on veut voir ce que Kling rend a partir du personnage
 * officiel (img/site/swoge_reference.jpg, la meme reference que SwoleMind),
 * donc chaque envoi du programme part une fois et une seule :
 *   - l'envoi fait est ecrit dans DATA_DIR (kling_telegram.json) AVANT de
 *     poster, et un redemarrage ne le rejoue pas ;
 *   - un serveur qui demarre plus d'une heure apres l'heure prevue ne poste
 *     pas en retard (un « 20 h » publie a 23 h n'est plus le meme essai) ;
 *   - si Kling echoue, RIEN ne part sur le canal public : l'echec est journalise
 *     (kling_essais.jsonl) et lisible dans /studio/kling, pas annonce aux joueurs.
 * Cout : 0,028 $ l'image (Kling Image 3.0, grille officielle), sur le compte
 * Kling du proprietaire.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');

/* 20 h a Paris le 27/09/2026 = 18 h UTC (heure d'ete, UTC+2). */
const PROGRAMME = [
  { cle: 'poker-2026-09-27', a: Date.parse('2026-09-27T18:00:00Z'),
    prompt: 'SWOGE, the character in the reference image: a very muscular, bodybuilder-build shiba inu — keep his face, fur colours and muscular build. '
      + 'He sits at a high-stakes poker table in a luxurious neon-lit casino at night, calmly revealing a royal flush of spades, '
      + 'tall stacks of gold chips in front of him, other players in shadow, green felt, warm cinematic lighting, confident smirk, highly detailed, sharp focus.',
    legende: '🃏 <b>SWOGE at the poker table</b>\nFirst picture made with <b>Kling AI</b> from the official SWOGE character.\n\n♠️ Play live: https://swoleeswoge.dog/swoge_poker.html',
    format: '3:4', reference: 'subject' },
];
const RETARD_MAX_MS = 60 * 60e3;

/**
 * deps : { kling (kling.js), telegram ({ notifyPhoto }), dossier, site, journal(o),
 *          maintenant?, programme? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const programme = deps.programme || PROGRAMME;
  const fichier = path.join(deps.dossier, 'kling_telegram.json');
  const journal = deps.journal || (() => {});
  let faits = {};
  try { faits = JSON.parse(fs.readFileSync(fichier, 'utf8')) || {}; } catch (e) { faits = {}; }
  let enCours = false;

  const ecrit = () => { try { fs.writeFileSync(fichier, JSON.stringify(faits)); } catch (e) { /* jamais bloquant */ } };

  /** Un passage : poste ce qui est du, rend ce qui a ete fait (pour les essais). */
  async function tour() {
    if (enCours) return null;
    const t = maintenant();
    const du = programme.find((p) => !faits[p.cle] && t >= p.a && t - p.a <= RETARD_MAX_MS);
    /* Trop tard : on le note comme manque, une fois, sans rien poster. */
    for (const p of programme) if (!faits[p.cle] && t - p.a > RETARD_MAX_MS) { faits[p.cle] = { etat: 'manque', t }; ecrit(); journal({ programme: p.cle, statut: 'manque' }); }
    if (!du) return null;
    if (!deps.kling.actif()) return null;          // sans cle, on attend : l'essai reste du tant qu'il est dans l'heure
    enCours = true;
    faits[du.cle] = { etat: 'lance', t }; ecrit();  // ecrit AVANT : un redemarrage pendant l'attente ne relance pas
    try {
      const r = await deps.kling.image({ prompt: du.prompt, image: deps.site + '/img/site/swoge_reference.jpg', reference: du.reference, format: du.format }, deps.attente);
      if (!r.ok) {
        faits[du.cle] = { etat: 'echec', t, raison: r.raison }; ecrit();
        journal({ programme: du.cle, type: 'image', statut: 'failed', message: r.raison, essais: r.essais });
        return { cle: du.cle, ok: false, raison: r.raison };
      }
      deps.telegram.notifyPhoto(r.url, du.legende);
      faits[du.cle] = { etat: 'poste', t, id: r.id, url: r.url, reference: r.reference }; ecrit();
      journal({ programme: du.cle, type: 'image', id: r.id, statut: 'succeed', url: r.url, reference: r.reference, estimationUsd: r.estimationUsd, essais: r.essais });
      return { cle: du.cle, ok: true, url: r.url };
    } finally { enCours = false; }
  }

  let minuteur = null;
  function demarre(pasMs) {
    if (minuteur) return;
    minuteur = setInterval(() => { tour().catch(() => {}); }, pasMs || 30e3);
    if (minuteur.unref) minuteur.unref();
    tour().catch(() => {});
  }
  const etat = () => programme.map((p) => ({ cle: p.cle, a: p.a, fait: faits[p.cle] || null }));

  return { tour, demarre, etat };
}

module.exports = { cree, PROGRAMME, RETARD_MAX_MS };
