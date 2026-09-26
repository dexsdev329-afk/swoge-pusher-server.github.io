'use strict';
/* ==========================================================================
 * TROUVER SEUL DE NOUVEAUX CANAUX TELEGRAM — SUR MESURE, JAMAIS SUR RÉPUTATION
 *
 * Demande du propriétaire, 26 septembre 2026 : « trouve plus d'influenceurs
 * crypto à rajouter, plus de canaux Telegram actifs ». Relevé du même jour, à la
 * main : les 72 canaux cités par sa liste → 26 publics → 3 avec un jeton
 * Robinhood dans leurs 20 derniers messages ; les canaux « Robinhood Gem Call »
 * trouvés sur le web étaient muets depuis 55 jours. La réputation ne dit donc
 * rien : seul compte ce qu'un canal poste VRAIMENT, sur CETTE chaîne, MAINTENANT.
 *
 * Chaque jour (`TG_DECOUVERTE_MS`) :
 *   1. les canaux cités par les canaux suivis (liens t.me, @mentions — les
 *      « callers » se citent et se transfèrent entre eux), les plus cités d'abord,
 *      au plus MESURES_PAR_TOUR, jamais remesurés avant MESURE_TTL ;
 *   2. chacun est MESURÉ : aperçu public ? dernier message ? jetons Robinhood
 *      CONFIRMÉS (DexScreener, une requête pour 30) dans ses derniers messages ;
 *   3. AJOUTÉ s'il est public, a posté depuis moins d'ACTIF_H heures et compte au
 *      moins RH_MIN jetons Robinhood — au plus AUTO_MAX canaux ajoutés ainsi,
 *      chacun avec la mesure qui l'a fait entrer ;
 *   4. un canal ajouté qui ne poste plus de Robinhood depuis RETRAIT_J jours est
 *      RETIRÉ (remesuré à chaque tour).
 * Les jetons de ces canaux restent jugés par la colonie comme ceux de toute autre
 * source, et leurs appels comptés à part (tg_appels.js) : un canal ajouté n'est
 * pas un canal cru. `TG_DECOUVERTE=0` éteint la découverte.
 * ======================================================================== */

const fs = require('fs');

const ACTIF_H = 48;
const RH_MIN = 2;
const AUTO_MAX = 10;
const RETRAIT_J = 7;
const MESURES_PAR_TOUR = 15;
const MESURE_TTL = 7 * 24 * 3600e3;

/**
 * deps = { tg (tg_canal), page(canal) → { statut, html }, litJson(url), fichier, maintenant() }
 */
function cree(deps) {
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());
  let etat = { auto: {}, mesures: {}, tours: 0 };
  try { etat = Object.assign(etat, JSON.parse(fs.readFileSync(deps.fichier, 'utf8'))); } catch (e) { /* premier tour */ }
  const sauve = () => { try { fs.writeFileSync(deps.fichier + '.tmp', JSON.stringify(etat)); fs.renameSync(deps.fichier + '.tmp', deps.fichier); } catch (e) { /* disque */ } };
  deps.tg.poseAuto(() => Object.keys(etat.auto));

  /** Les jetons Robinhood CONFIRMÉS parmi des adresses (une requête pour 30). */
  async function robinhood(adresses) {
    const ok = new Map();
    for (let i = 0; i < adresses.length; i += 30) {
      const j = await deps.litJson('https://api.dexscreener.com/tokens/v1/robinhood/' + adresses.slice(i, i + 30).join(','));
      for (const p of Array.isArray(j) ? j : []) {
        if (String(p.chainId).toLowerCase() !== 'robinhood') continue;
        ok.set(String(p.baseToken.address).toLowerCase(), String(p.baseToken.symbol || '?').slice(0, 16));
      }
    }
    return ok;
  }

  /** Mesurer un canal : public, actif, combien de jetons Robinhood. */
  async function mesure(canal) {
    const p = await deps.page(canal);
    if (!p || p.statut !== 200) return { canal, public: false, t: maintenant() };
    const ms = deps.tg.messages(p.html);
    const dates = ms.map((m) => m.t).filter(Boolean).map((x) => Date.parse(x)).filter((x) => x > 0).sort((a, b) => a - b);
    const cands = new Set();
    for (const m of ms) {
      const a = deps.tg.analyse(m.html);
      a.nues.forEach((x) => cands.add(x));
      for (const l of a.liens) { const r = await deps.tg.resousLien(l.id).catch(() => null); if (r) cands.add(r); }
    }
    const rh = cands.size ? await robinhood([...cands]) : new Map();
    const dernier = dates.length ? dates[dates.length - 1] : null;
    return { canal, public: true, t: maintenant(), messages: ms.length, dernier, robinhood: rh.size, symboles: [...rh.values()].slice(0, 6) };
  }

  const actif = (m) => m.public && m.dernier && maintenant() - m.dernier <= ACTIF_H * 3600e3;

  /** Un tour de découverte. */
  async function tour() {
    etat.tours++;
    const faits = { ajoutes: [], retires: [], mesures: 0 };
    /* 1. les canaux déjà ajoutés : toujours là ? */
    for (const c of Object.keys(etat.auto)) {
      try {
        const m = await mesure(c); faits.mesures++;
        const a = etat.auto[c];
        a.derniereMesure = m;
        if (m.public && m.robinhood > 0) a.dernierRobinhood = maintenant();
        if (!m.public || maintenant() - (a.dernierRobinhood || a.ajoute) > RETRAIT_J * 24 * 3600e3) {
          delete etat.auto[c];
          faits.retires.push({ canal: c, raison: !m.public ? 'no longer public' : 'no Robinhood Chain token for ' + RETRAIT_J + ' days' });
        }
      } catch (e) { /* un canal en panne : retenté au prochain tour */ }
    }
    /* 2. les canaux cités, jamais mesurés ou mesurés il y a longtemps */
    const suivis = new Set(deps.tg.canaux().map((c) => c.toLowerCase()));
    const cands = deps.tg.cites().map((x) => x.canal)
      .filter((c) => !suivis.has(c.toLowerCase()) && !(etat.mesures[c] && maintenant() - etat.mesures[c].t < MESURE_TTL))
      .slice(0, MESURES_PAR_TOUR);
    for (const c of cands) {
      let m;
      try { m = await mesure(c); } catch (e) { continue; }
      faits.mesures++;
      const pret = actif(m) && m.robinhood >= RH_MIN;
      m.verdict = !m.public ? 'no public preview' : !actif(m) ? 'not active in ' + ACTIF_H + ' h'
        : m.robinhood < RH_MIN ? m.robinhood + ' Robinhood Chain token(s) in its latest posts (' + RH_MIN + ' needed)' : 'added';
      if (pret && Object.keys(etat.auto).length >= AUTO_MAX) m.verdict = 'would qualify, but ' + AUTO_MAX + ' channels were already added';
      etat.mesures[c] = m;
      if (pret && Object.keys(etat.auto).length < AUTO_MAX) {
        etat.auto[c] = { ajoute: maintenant(), dernierRobinhood: maintenant(), mesure: m };
        faits.ajoutes.push({ canal: c, robinhood: m.robinhood, symboles: m.symboles });
      }
    }
    /* la mémoire des mesures ne grossit pas sans fin */
    for (const [c, m] of Object.entries(etat.mesures)) if (maintenant() - m.t > MESURE_TTL) delete etat.mesures[c];
    etat.dernier = Object.assign({ t: maintenant() }, faits);
    sauve();
    return faits;
  }

  /** Ce que la page montre : les canaux ajoutés et pourquoi, les derniers mesurés et le verdict. */
  function vue() {
    return { auto: Object.entries(etat.auto).map(([canal, a]) => ({ canal, ajoute: a.ajoute, robinhood: a.mesure.robinhood, symboles: a.mesure.symboles,
               dernierRobinhood: a.dernierRobinhood })),
             mesures: Object.values(etat.mesures).sort((a, b) => b.t - a.t).slice(0, 20).map((m) => ({ canal: m.canal, public: m.public, robinhood: m.robinhood || 0, verdict: m.verdict || null })),
             regle: { actifH: ACTIF_H, robinhoodMin: RH_MIN, max: AUTO_MAX, retraitJours: RETRAIT_J }, dernierTour: etat.dernier || null };
  }

  return { tour, vue, mesure, etat: () => etat };
}

module.exports = { cree, ACTIF_H, RH_MIN, AUTO_MAX, RETRAIT_J, MESURES_PAR_TOUR };
