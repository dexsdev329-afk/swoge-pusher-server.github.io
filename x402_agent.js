'use strict';
/* ==================================================================
 * ASK_AGENT EN x402 : LE REGISTRE DES PERTES ET DES PAYEURS BLOQUÉS (durable)
 * ==================================================================
 *
 * Contrat base_design/CONTRAT.md §D.6 (27 septembre 2026). Le seul vrai risque
 * d'argent du lot : un payeur passe la vérification puis, pendant les 150 s
 * du travail, fait échouer l'encaissement — le plus simple est
 * `cancelAuthorization`, que l'USDC de Base expose (quelques centimes de gaz,
 * sceptique2/cancel_probe_2026-09-27.out). Nous avons alors payé le modèle
 * pour une réponse retenue. Les bornes :
 *   - PERTES SUR 24 H GLISSANTES : le coût modèle de chaque exécution servie
 *     mais pas encaissée, et de chaque exécution échouée après avoir dépensé.
 *     À X402_AGENT_PERTE_JOUR_USD (2,00 $ par défaut), ask_agent n'est plus
 *     vendu en x402 (agentic.x402Payable) ;
 *   - PAYEUR BLOQUÉ 24 H après un encaissement raté. Faible seul (une autre
 *     adresse suffit) : c'est le plafond du jour qui borne vraiment la perte.
 *   Pire cas sur 24 h : 2,00 $ + 3 en vol × 0,36 $ = 3,08 $ (une exécution
 *   coupée par un redémarrage n'est pas inscrite).
 * Valeurs de DÉPART, pas des mesures : à régler sur MESURE.horsSolde.nonRegles.
 *
 * Pourquoi pas compteurs.js : ses totaux sont par jour UTC (pas glissants),
 * `note()` n'accepte qu'une liste fixe d'événements, et `qui` y est salé et
 * haché — il ne peut pas garder une adresse à bloquer. En mémoire, le
 * registre repartirait à zéro à chaque redéploiement (chaque push sur main).
 * Un fichier JSON dans DATA_DIR, écrit comme compteurs.js / agentic_cles.js :
 * temporaire, fsync, rename.
 * ================================================================== */

const fs = require('fs');
const path = require('path');

const JOUR_MS = 24 * 3600 * 1000;
/* Au plus ENTREES_MAX pertes gardées (les plus récentes) : borne le fichier face à un flot. */
const ENTREES_MAX = 5000;

function cree({ fichier, maintenant } = {}) {
  const t = () => (maintenant ? maintenant() : Date.now());
  let E = { pertes: [], bloques: {} };
  if (fichier) {
    try {
      const lu = JSON.parse(fs.readFileSync(fichier, 'utf8'));
      if (lu && Array.isArray(lu.pertes) && lu.bloques && typeof lu.bloques === 'object') E = { pertes: lu.pertes, bloques: lu.bloques };
    } catch (e) {
      /* Absent : on part de zéro. Illisible : gardé à côté, jamais écrasé en silence. */
      if (e && e.code !== 'ENOENT') { try { fs.renameSync(fichier, fichier + '.illisible.' + t()); } catch (x) { /* rien */ } }
    }
  }
  function purge() {
    const n = t();
    E.pertes = E.pertes.filter((p) => n - p.t < JOUR_MS).slice(-ENTREES_MAX);
    for (const [a, fin] of Object.entries(E.bloques)) if (fin <= n) delete E.bloques[a];
  }
  function ecrit() {
    if (!fichier) return;
    try {
      fs.mkdirSync(path.dirname(fichier), { recursive: true });
      const tmp = fichier + '.tmp';
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, fichier);
    } catch (e) { console.error('[x402-agent] ledger write failed: ' + (e && e.code || e)); }
  }
  /** Une perte (USD, coût modèle) : servie sans être encaissée, ou échouée après avoir dépensé. */
  function perte(usd, raison) {
    const u = Number(usd);
    if (!(u > 0)) return;
    purge();
    E.pertes.push({ t: t(), usd: Math.round(u * 1e6) / 1e6, raison: String(raison || '').slice(0, 60) });
    ecrit();
  }
  /** Les pertes des 24 dernières heures, en USD. */
  function pertes24h() { purge(); return Math.round(E.pertes.reduce((s, p) => s + p.usd, 0) * 1e6) / 1e6; }
  /** Bloque un payeur 24 h (adresse vérifiée : le signataire, jamais une adresse du corps). */
  function bloque(addr) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(addr || ''))) return;
    purge();
    E.bloques[String(addr).toLowerCase()] = t() + JOUR_MS;
    ecrit();
  }
  function estBloque(addr) { purge(); return !!E.bloques[String(addr || '').toLowerCase()]; }
  function vue() { purge(); return { pertes24hUsd: pertes24h(), pertes24hN: E.pertes.length, bloques: Object.keys(E.bloques).length }; }
  return { perte, pertes24h, bloque, estBloque, vue };
}

module.exports = { cree, JOUR_MS, ENTREES_MAX };
