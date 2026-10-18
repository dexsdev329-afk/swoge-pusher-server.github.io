'use strict';
/* ==================================================================
 * AGENTLIFE → SWOGE AI : LES ALERTES D'UN AUTRE BOT, OBSERVEES
 * ==================================================================
 *
 * Demande du proprietaire (18/10/2026) : « branche ca a SWOGE AI » — l'API des
 * signaux d'AgentLife (son autre bot, depot dexsdev329-afk/AGENTLIFE,
 * signalsapi.js), en lecture seule, cle SIGNALS_API_KEY.
 *
 * La regle du depot prime : MESURER AVANT DE CHANGER. Les bilans d'AgentLife
 * (stats7d : x1,5 / x2 atteints, « perdu la moitie a 6 h ») sont les SIENS,
 * comptes sur la capitalisation au plus haut — pas sur un prix vendable, pas
 * nets du cout d'une case. Aucun n'a ete mesure par cette colonie. Chaque
 * alerte devient donc une OMBRE de la colonie, par le meme chemin que les
 * sources du brief v2 (ai_colonie.js, signalSmart, une ligne par type
 * d'alerte : « agentlife: rebound »…) : jugee aux memes echeances, au meme
 * prix vendable, contre « achete ou retenu ». Elle n'entre JAMAIS dans le
 * tour : rien de ce que la colonie achete ne change.
 *
 * Ecartees a la source :
 *   - « swoge » : c'est l'alerte d'AgentLife sur un ACHAT de SWOGE AI
 *     (AGENTLIFE/swogeai.js lit /ai/colonie). La reprendre ferait juger la
 *     colonie par son propre echo.
 *   - « confirmation » : « prends tes profits », un signal de vente.
 *   - toute chaine autre que robinhood : la colonie ne lit que celle-la.
 *
 * Lecture : GET /signals/v1/alerts?since=…&limit=200 (une ligne du journal
 * par alerte, signalsapi.js alertView), toutes les AGENTLIFE_TOUR_MS (5 min ;
 * le guide dit « toutes les 5 a 10 minutes », 120 requetes/minute au plus).
 * Au premier tour, rien de plus vieux que 30 min : une ombre posee des heures
 * apres l'alerte jugerait un autre prix que celui de l'alerte.
 * ================================================================== */
const fs = require('fs');
const path = require('path');

const BASE = () => String(process.env.AGENTLIFE_URL || 'https://agentlife-production.up.railway.app').replace(/\/$/, '');
const CLE = () => String(process.env.AGENTLIFE_SIGNALS_KEY || '').trim();
const TOUR_MS = () => Math.max(60000, Number(process.env.AGENTLIFE_TOUR_MS) || 5 * 60000);
const PREMIER_RECUL_MS = 30 * 60000;
const VUS_MAX = 2000;
/* Les types d'alerte d'AgentLife (AGENTLIFE/alertlog.js, ALERT_KINDS, lu le 18/10) et la ligne
   d'audit de chacun. « swoge » et « confirmation » n'y sont pas : voir l'en-tete. */
const LIGNES = {
  graduation: 'agentlife: graduation watch', rebond: 'agentlife: rebound', lancement: 'agentlife: pons launch',
  narrative: 'agentlife: narrative', foule: 'agentlife: fast crowd', og: 'agentlife: og of a copy',
  equipe: 'agentlife: known team', smart: 'agentlife: smart money', dev: 'agentlife: dev wallet',
  suivi_nouveau: 'agentlife: tracked wallet, new token', suivi_mouvement: 'agentlife: tracked wallet, move',
  surveille: 'agentlife: watched token', copie: 'agentlife: copy a leader',
};
const ECARTES = ['swoge', 'confirmation'];
const FRAIS_COURBE = require('./smart_pons').FRAIS_COURBE_AR_PCT;

/**
 * deps = { surAlerte(v) -> bool (ai_colonie.signalSmart), dossier, prendre (fetch), maintenant() }
 */
function cree(deps) {
  const d = deps || {};
  const prendre = d.prendre || fetch;
  const maintenant = d.maintenant || Date.now;
  const FICHIER = path.join(d.dossier || '.', 'agentlife.json');
  const MESURE = { tours: 0, lues: 0, transmises: 0, refusees: 0, ecartees: {}, horsChaine: 0, erreurs: 0, derniereErreur: null, dernierTour: null };
  let enCours = false;

  function lis() { try { const e = JSON.parse(fs.readFileSync(FICHIER, 'utf8')) || {}; e.vus = Array.isArray(e.vus) ? e.vus : []; return e; } catch (x) { return { vus: [] }; } }
  function ecris(e) {
    if (e.vus.length > VUS_MAX) e.vus = e.vus.slice(-VUS_MAX);
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(FICHIER + '.tmp', JSON.stringify(e)); fs.renameSync(FICHIER + '.tmp', FICHIER);
  }
  const ecarte = (k) => { MESURE.ecartees[k] = (MESURE.ecartees[k] || 0) + 1; };

  /** Un tour : les alertes depuis le curseur, chacune transmise une fois. */
  async function tour() {
    if (!CLE()) return { etat: 'inactif' };
    if (enCours) return { etat: 'en cours' };
    enCours = true;
    try {
      const t = maintenant();
      const e = lis();
      const depuis = Math.max(Number(e.curseur) || 0, t - PREMIER_RECUL_MS);
      const url = BASE() + '/signals/v1/alerts?limit=200&since=' + encodeURIComponent(new Date(depuis).toISOString());
      const r = await prendre(url, { headers: { authorization: 'Bearer ' + CLE() }, signal: AbortSignal.timeout(20000) });
      let j = null;
      try { j = await r.json(); } catch (x) { j = null; }
      MESURE.tours++; MESURE.dernierTour = new Date(t).toISOString();
      /* La reponse ne cite jamais la cle ; le message d'erreur non plus (statut et texte d'AgentLife seulement). */
      if (!r.ok || !j || !Array.isArray(j.alerts)) {
        MESURE.erreurs++; MESURE.derniereErreur = r.status + ' ' + String((j && j.error) || '').slice(0, 100);
        return { etat: 'erreur', statut: r.status };
      }
      let transmises = 0, plusRecente = depuis;
      for (const a of j.alerts) {
        MESURE.lues++;
        const at = Date.parse(a && a.at);
        if (Number.isFinite(at) && at > plusRecente) plusRecente = at;
        const token = String((a && a.token) || '').toLowerCase();
        const cle = (a && a.kind) + '|' + token + '|' + (a && a.at);
        if (e.vus.includes(cle)) continue;
        e.vus.push(cle);
        if (ECARTES.includes(a.kind)) { ecarte(a.kind); continue; }
        if (!LIGNES[a.kind]) { ecarte('inconnu:' + String(a.kind).slice(0, 20)); continue; }
        if (String(a.chain || 'robinhood') !== 'robinhood') { MESURE.horsChaine++; continue; }
        if (!/^0x[0-9a-f]{40}$/.test(token)) { ecarte('adresse'); continue; }
        /* courbe + fraisPct : releve du 18/10 (44 alertes sur 24 h), « foule » et « lancement » visent
           surtout des jetons encore sur leur courbe Pons, sans prix DexScreener. La colonie prend alors
           le prix de la courbe si elle la suit, et n'applique les frais d'aller-retour (smart_pons,
           FRAIS_COURBE_AR_PCT, 6 points) qu'a une ombre pesee SUR la courbe (ai_colonie.js). */
        const pris = d.surAlerte({ jeton: token, sym: a.symbol || null, verdict: 'ACHETER', source: 'agentlife_' + a.kind, t: Number.isFinite(at) ? at : t,
          courbe: true, fraisPct: FRAIS_COURBE,
          conditions: a.note ? [String(a.note).slice(0, 140)] : [] });
        if (pris) { transmises++; MESURE.transmises++; } else MESURE.refusees++;
      }
      /* Le curseur avance a la plus recente lue (since est inclusif : les cles vues evitent le double). */
      e.curseur = plusRecente;
      ecris(e);
      return { etat: 'lu', alertes: j.alerts.length, transmises };
    } catch (x) {
      MESURE.erreurs++; MESURE.derniereErreur = String(x && x.message || x).slice(0, 120);
      return { etat: 'erreur' };
    } finally {
      enCours = false;
    }
  }

  function planifie() {
    if (!CLE()) { console.log('[agentlife] ETEINT : AGENTLIFE_SIGNALS_KEY absente'); return null; }
    console.log('[agentlife] ARME : alertes observees par la colonie (ombres, aucun achat), toutes les ' + Math.round(TOUR_MS() / 60000) + ' min');
    const f = () => tour().catch(() => {});
    const premier = setTimeout(f, 45000);
    const minuterie = setInterval(f, TOUR_MS());
    return { arrete() { clearTimeout(premier); clearInterval(minuterie); } };
  }

  const etat = () => ({ actif: !!CLE(), base: BASE(), tourMin: Math.round(TOUR_MS() / 60000), mesure: MESURE });
  return { tour, planifie, etat, MESURE };
}

module.exports = { cree, LIGNES, ECARTES };
