'use strict';
/* ==========================================================================
 * LES APPELS TELEGRAM — CE QUE CHAQUE CANAL A POSTÉ, ET CE QUE ÇA A DONNÉ
 *
 * Idée du propriétaire, 26 septembre 2026 : « un agent capable de suivre une
 * liste de chaînes Telegram et notifier l'information, ça serait super utile
 * pour d'autres agents ». La valeur n'est pas « tel canal a posté tel jeton »
 * (le canal le dit lui-même) : c'est CE QUE L'APPEL A DONNÉ ensuite, et quel
 * canal a le meilleur historique — sur combien d'appels.
 *
 * Relevé du 26 septembre 2026 sur les douze canaux publics donnés : 240
 * messages lus en 4,3 s, 49 adresses candidates, 20 jetons confirmés sur
 * Robinhood Chain (29 sur Ethereum, BSC ou Base, écartés).
 *
 * ---- CE QUI EST MESURÉ, ET CE QUI NE L'EST PAS ----
 * Le prix de référence est celui LU À LA DÉTECTION (tour de TOUR_MS, deux
 * minutes), pas celui de l'instant du message : un appel détecté longtemps
 * après son message (au premier démarrage, un canal relu en retard) n'a pas
 * le prix de l'appel. Seuls les appels FRAIS — détectés moins de FRAIS_MS
 * après leur message — comptent dans le score d'un canal. En dessous de
 * APPELS_ASSEZ appels frais mesurés, le score dit qu'il ne conclut pas : un
 * écart sur une poignée d'appels est de la chance, pas un résultat.
 *
 * Coût : une requête DexScreener pour 30 adresses (`/tokens/v1/robinhood/…`,
 * vérifiée le 26 septembre : n'y reviennent que les paires Robinhood — c'est
 * aussi la vérification de chaîne). Le suivi des plus hauts relit les appels
 * de moins de SUIVI_H heures toutes les SUIVI_MS.
 * ======================================================================== */

const fs = require('fs');

const TOUR_MS = 2 * 60e3;
const SUIVI_MS = 10 * 60e3;
const SUIVI_H = 72;
const FRAIS_MS = 15 * 60e3;
const APPELS_ASSEZ = 10;
const MAX = 1000;
const LOT = 30;

const med = (l) => { const t = l.slice().sort((a, b) => a - b); return t.length ? (t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2) : null; };
const pct = (a, b) => (a > 0 && b > 0 ? Math.round((b / a - 1) * 1000) / 10 : null);

/**
 * deps = { tg (tg_canal), lit(url) → JSON, fichier, maintenant(), notifie(appel) }
 */
function cree(deps) {
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());
  let appels = [];
  try { appels = JSON.parse(fs.readFileSync(deps.fichier, 'utf8')) || []; } catch (e) { appels = []; }
  const MESURE = { tours: 0, lectures: 0, nouveaux: 0, horsChaine: 0, erreurs: 0, derniereErreur: null };
  let dernierSuivi = 0;
  const sauve = () => { try { fs.writeFileSync(deps.fichier + '.tmp', JSON.stringify(appels)); fs.renameSync(deps.fichier + '.tmp', deps.fichier); } catch (e) { /* disque : on garde en memoire */ } };

  /** La meilleure paire Robinhood de chaque adresse, par lots de 30 (une requête par lot). */
  async function paires(adresses) {
    const out = new Map();
    for (let i = 0; i < adresses.length; i += LOT) {
      const lot = adresses.slice(i, i + LOT);
      MESURE.lectures++;
      const j = await deps.lit('https://api.dexscreener.com/tokens/v1/robinhood/' + lot.join(','));
      for (const p of Array.isArray(j) ? j : []) {
        if (String(p.chainId).toLowerCase() !== 'robinhood') continue;
        const a = String(p.baseToken && p.baseToken.address || '').toLowerCase();
        if (!lot.includes(a)) continue;
        const liq = (p.liquidity && p.liquidity.usd) || 0;
        if (!out.has(a) || liq > out.get(a).liq) {
          out.set(a, { liq, prix: Number(p.priceUsd) || 0, mc: p.marketCap || p.fdv || 0, sym: (p.baseToken.symbol || '?').slice(0, 16),
                       nom: (p.baseToken.name || '').slice(0, 40), cree: p.pairCreatedAt || null, url: p.url || null });
        }
      }
    }
    return out;
  }

  /** Un tour : les nouveaux appels (canal × jeton) des canaux surveillés. */
  async function tour() {
    MESURE.tours++;
    try {
      const { adresses } = await deps.tg.adressesRecentes();
      const connus = new Set(appels.map((a) => a.canal + '|' + a.addr));
      const neufs = adresses.filter((x) => !connus.has(x.canal + '|' + x.addr));
      if (neufs.length) {
        const vus = await paires([...new Set(neufs.map((x) => x.addr))]);
        const t = maintenant();
        for (const x of neufs) {
          const p = vus.get(x.addr);
          if (!p || !(p.prix > 0)) { deps.tg.note(x.addr, x, 'hors robinhood'); MESURE.horsChaine++; continue; }
          const tm = x.t ? Date.parse(x.t) : null;
          const a = { canal: x.canal, addr: x.addr, sym: p.sym, nom: p.nom, post: x.post || null,
            tMessage: tm || null, tDetecte: t, frais: !!(tm && t - tm <= FRAIS_MS && t >= tm - 60e3),
            prix0: p.prix, liq0: Math.round(p.liq), mc0: Math.round(p.mc), haut: p.prix, tHaut: t, dernier: p.prix, tDernier: t,
            ageJeton: p.cree ? Math.round((t - p.cree) / 60e3) : null };
          appels.push(a);
          MESURE.nouveaux++;
          if (a.frais && deps.notifie) { try { deps.notifie(a); } catch (e) { /* la notification ne casse rien */ } }
        }
        if (appels.length > MAX) appels = appels.slice(appels.length - MAX);
        sauve();
      }
      if (maintenant() - dernierSuivi >= SUIVI_MS) await suivi();
    } catch (e) { MESURE.erreurs++; MESURE.derniereErreur = String(e && e.message || e).slice(0, 120); }
  }

  /** Les plus hauts : relire les appels récents et retenir le meilleur prix vu. */
  async function suivi() {
    dernierSuivi = maintenant();
    const t = maintenant();
    const recents = appels.filter((a) => t - a.tDetecte < SUIVI_H * 3600e3);
    if (!recents.length) return;
    const vus = await paires([...new Set(recents.map((a) => a.addr))]);
    for (const a of recents) {
      const p = vus.get(a.addr);
      if (!p || !(p.prix > 0)) continue;
      a.dernier = p.prix; a.tDernier = t;
      if (p.prix > a.haut) { a.haut = p.prix; a.tHaut = t; }
    }
    sauve();
  }

  /** La vue d'un appel : ce qu'il a fait depuis sa détection. */
  const vue = (a) => ({ channel: a.canal, token: a.addr, symbol: a.sym, name: a.nom,
    post: a.post ? 'https://t.me/' + a.post : null, chart: 'https://dexscreener.com/robinhood/' + a.addr,
    postedAt: a.tMessage ? new Date(a.tMessage).toISOString() : null, detectedAt: new Date(a.tDetecte).toISOString(),
    fresh: a.frais, tokenAgeMinAtCall: a.ageJeton, priceAtDetection: a.prix0, liquidityAtDetection: a.liq0, capAtDetection: a.mc0,
    changeSinceDetectionPct: pct(a.prix0, a.dernier), bestSinceDetectionPct: pct(a.prix0, a.haut),
    lastPriceAt: new Date(a.tDernier).toISOString() });

  /** Le score de chaque canal, sur ses appels FRAIS, avec l'effectif — et le refus de conclure en dessous. */
  function scores() {
    const par = {};
    for (const c of deps.tg.canaux()) par[c] = [];
    for (const a of appels) (par[a.canal] = par[a.canal] || []).push(a);
    return Object.entries(par).map(([canal, l]) => {
      const f = l.filter((a) => a.frais && a.tDernier > a.tDetecte);
      const now = f.map((a) => pct(a.prix0, a.dernier)).filter((x) => x !== null);
      const best = f.map((a) => pct(a.prix0, a.haut)).filter((x) => x !== null);
      const assez = now.length >= APPELS_ASSEZ;
      return { channel: canal, calls: l.length, freshMeasured: now.length,
        medianChangePct: assez ? med(now) : null, medianBestPct: assez ? med(best) : null,
        upSharePct: assez ? Math.round(now.filter((x) => x > 0).length / now.length * 100) : null,
        verdict: assez ? null : 'not enough fresh calls to judge (' + now.length + ' of ' + APPELS_ASSEZ + ')' };
    }).sort((a, b) => (a.medianChangePct === null) - (b.medianChangePct === null) || (b.medianChangePct || 0) - (a.medianChangePct || 0) || b.calls - a.calls);
  }

  /** Les appels récents (outil des agents). `heures` ≤ 168, `limite` ≤ 50, `canal` facultatif. */
  function liste({ canal, heures, limite } = {}) {
    const h = Math.min(168, Math.max(1, Number(heures) || 24)), n = Math.min(50, Math.max(1, Number(limite) || 20));
    const c = canal ? String(canal).replace(/^@/, '').toLowerCase() : null;
    const t = maintenant();
    const l = appels.filter((a) => t - a.tDetecte <= h * 3600e3 && (!c || a.canal.toLowerCase() === c))
      .sort((a, b) => (b.tMessage || b.tDetecte) - (a.tMessage || a.tDetecte)).slice(0, n);
    return { calls: l.map(vue), channels: scores(),
      method: 'Prices are read at detection (every ' + TOUR_MS / 60e3 + ' min), not at the exact second of the post. Only "fresh" calls — detected within '
        + FRAIS_MS / 60e3 + ' min of their post — count in a channel score, and no score is given under ' + APPELS_ASSEZ + ' fresh calls. Best is the highest price seen in our checks (every '
        + SUIVI_MS / 60e3 + ' min, first ' + SUIVI_H + ' h). Robinhood Chain only; this is not advice.' };
  }

  return { tour, suivi, liste, scores, MESURE, appels: () => appels };
}

module.exports = { cree, TOUR_MS, SUIVI_MS, FRAIS_MS, APPELS_ASSEZ, pct, med };
