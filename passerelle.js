'use strict';
/* ==================================================================
 * LA PASSERELLE DE DEPENSE DES AGENTS (28 septembre 2026, au soir)
 * ==================================================================
 *
 * Premier morceau du « SWOGE Agent Network » (analyse du 28/09) : le compte de
 * depense d'un agent. Un agent exterieur, avec SA cle swg_…, demande a SWOGE de
 * payer un service x402 a sa place :
 *
 *   POST /agentic/pay  { url, method?, query?, body?, max_usd? }  + Idempotency-Key
 *
 * et recoit la reponse du service et un recu. Ce que la passerelle garantit au
 * proprietaire de la cle, dans cet ordre :
 *   1. la cle a la permission de payer (eteinte par defaut, activee par lui) ;
 *   2. le site est dans SA liste, s'il en a fait une ;
 *   3. le prix du 402 est sous SON plafond par appel (et sous celui de l'embauche) ;
 *   4. le plafond du jour de la cle ($SWOGE) et celui de l'embauche tiennent ;
 *   5. une meme Idempotency-Key ne paie qu'une fois, meme apres un redemarrage ;
 *   6. chaque appel — paye, refuse ou rate — laisse une ligne d'audit CHAINEE
 *      (chaque ligne porte l'empreinte de la precedente : en modifier une casse
 *      toutes les suivantes, verifie()).
 * Le paiement lui-meme est celui de l'embauche (embauche.js) : catalogue public
 * seulement, adresses publiques, pas de redirection, reserve avant, facture sur
 * 200 seulement, recu retrouve sur la chaine. Le proprietaire est facture en
 * $SWOGE, comme pour l'embauche de son agent sur la page.
 *
 * Ce que l'audit garde : des empreintes (requete, reponse), jamais leur contenu.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IDEM_TTL_MS = 24 * 3600e3;
const IDEM_MAX = 20000;
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x === undefined ? null : x)).digest('hex');
const ZERO = '0'.repeat(64);
/* L'empreinte d'une ligne : tous ses champs sauf la sienne, dans un ordre fixe. */
const empreinteLigne = (l) => sha(JSON.stringify(Object.keys(l).filter((k) => k !== 'h').sort().map((k) => [k, l[k]])));

/** Verifie une chaine d'audit : { ok, lignes, casseA } (casseA : le seq de la premiere ligne fausse). */
function verifie(lignes) {
  let prev = ZERO;
  for (const l of lignes) {
    if (l.prev !== prev || empreinteLigne(l) !== l.h) return { ok: false, lignes: lignes.length, casseA: l.seq };
    prev = l.h;
  }
  return { ok: true, lignes: lignes.length, casseA: null };
}

/**
 * deps : { embauche() → l'instance embauche.js, cles (agentic_cles), factuPour(addr, cle) → { reserve, regle },
 *          cours(cle) → USD par unite de la cle ($SWOGE ; 1 pour une cle payee au credit en dollars), dossier, maintenant? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const fAudit = deps.dossier ? path.join(deps.dossier, 'passerelle_audit.jsonl') : null;
  const fIdem = deps.dossier ? path.join(deps.dossier, 'passerelle_idem.json') : null;
  const MESURE = { appels: 0, payes: 0, refus: 0, rejoues: 0 };
  let lignes = [];
  try { if (fAudit) lignes = fs.readFileSync(fAudit, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch (e) { lignes = []; }
  let IDEM = {};
  try { if (fIdem) IDEM = JSON.parse(fs.readFileSync(fIdem, 'utf8')) || {}; } catch (e) { IDEM = {}; }
  const ecritIdem = () => { if (!fIdem) return; try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(fIdem, JSON.stringify(IDEM)); } catch (e) { /* jamais bloquant */ } };
  const purgeIdem = () => {
    const t = maintenant();
    for (const [k, v] of Object.entries(IDEM)) if (t - v.t > IDEM_TTL_MS) delete IDEM[k];
    const k = Object.keys(IDEM); if (k.length > IDEM_MAX) k.sort((a, b) => IDEM[a].t - IDEM[b].t).slice(0, k.length - IDEM_MAX).forEach((x) => delete IDEM[x]);
  };

  function audite(o) {
    const der = lignes[lignes.length - 1];
    const l = Object.assign({ seq: der ? der.seq + 1 : 1, t: maintenant() }, o, { prev: der ? der.h : ZERO });
    l.h = empreinteLigne(l);
    lignes.push(l);
    if (fAudit) try { fs.mkdirSync(deps.dossier, { recursive: true }); fs.appendFileSync(fAudit, JSON.stringify(l) + '\n'); } catch (e) { /* jamais bloquant */ }
    return l;
  }

  /**
   * cle : resout() d'agentic_cles ({ h, id, addr }). a : { url, method?, query?, body?, max_usd? }. idem : l'Idempotency-Key.
   * Rend { code, corps } — corps.ok, et sur un paiement : resultat, recu, audit (seq et empreinte de la ligne).
   */
  async function paie(cle, a, idem) {
    MESURE.appels++;
    a = a || {};
    const refus = (code, raison, extra) => {
      MESURE.refus++;
      const l = audite(Object.assign({ addr: String(cle.addr).toLowerCase(), cle: cle.id, url: String(a.url || '').slice(0, 300), statut: 'refuse', raison }, extra || {}));
      return { code, corps: { ok: false, raison, audit: { seq: l.seq, h: l.h } } };
    };
    const k = String(idem || '').trim();
    if (!/^[\x21-\x7e]{8,100}$/.test(k)) return { code: 400, corps: { ok: false, raison: 'send an Idempotency-Key header (8 to 100 visible characters): the same key never pays twice' } };
    purgeIdem();
    const ik = cle.h + '|' + k;
    const deja = IDEM[ik];
    if (deja) {
      MESURE.rejoues++;
      if (deja.etat === 'en cours') return { code: 409, corps: { ok: false, raison: 'a payment with this Idempotency-Key is still running - wait for it, do not send a new key' } };
      return { code: deja.code, corps: Object.assign({}, deja.corps, { rejoue: true }) };
    }
    const pol = deps.cles.paiementDe(cle.h);
    if (!pol) return refus(403, 'payments are off for this key - the owner turns them on, with a per-call cap, on the SwogeAgentic page');
    let u;
    try { u = new URL(String(a.url || '')); } catch (e) { return refus(400, 'url must be the full https URL of a paid service'); }
    if (u.protocol !== 'https:') return refus(400, 'url must be https');
    if (pol.hotes.length && !pol.hotes.includes(u.hostname.toLowerCase())) return refus(403, 'this site is not in the key\'s allowed sites (' + pol.hotes.join(', ') + ')');
    const max = Number(a.max_usd) > 0 ? Math.min(pol.maxAppelUsd, Number(a.max_usd)) : pol.maxAppelUsd;
    IDEM[ik] = { t: maintenant(), etat: 'en cours' };
    ecritIdem();
    /* La facture de l'embauche, bornee par le plafond du jour de la CLE : en $SWOGE au cours du
       moment, ou en dollars (cours 1) pour une cle payee au credit (credits.js, 29/09). */
    const inner = deps.factuPour(cle.addr, cle);
    let cours = null;
    const factu = {
      reserve: async (usd) => {
        cours = await deps.cours(cle);
        if (!(cours > 0)) return { ok: false, raison: 'the $SWOGE price is unavailable right now - nothing was charged' };
        if (!deps.cles.sousPlafond(cle.h, usd / cours)) return { ok: false, raison: 'this key reached its daily spending cap - nothing was charged' };
        return inner.reserve(usd);
      },
      regle: async (jeton, usd) => {
        await inner.regle(jeton, usd);
        if (usd > 0 && cours > 0) deps.cles.depense(cle.h, usd / cours, { id: 'pay-' + k.slice(0, 24), outil: 'pay', usd, url: u.toString().slice(0, 200) });
      },
    };
    let r;
    try {
      r = await deps.embauche().pour(cle.addr, factu).embauche({ url: u.toString(), method: a.method, query: a.query, body: a.body, maxUsd: max });
    } catch (e) { r = { ok: false, raison: 'the gateway failed - nothing was charged' }; }
    const base = { addr: String(cle.addr).toLowerCase(), cle: cle.id, url: u.toString().slice(0, 300), hote: u.hostname, methode: a.method ? String(a.method).toUpperCase().slice(0, 4) : null,
      requete: sha({ q: a.query || null, b: a.body || null }), maxUsd: max };
    let sortie;
    if (r && r.ok) {
      MESURE.payes++;
      const rc = r.recu || {};
      const l = audite(Object.assign(base, { statut: r.gratuit ? 'gratuit' : 'paye', usd: rc.usd || 0, factureUsd: rc.factureUsd || 0, reseau: rc.reseau || null, tx: rc.tx || null,
        reponse: sha(r.resultat === undefined ? null : r.resultat) }));
      sortie = { code: 200, corps: { ok: true, type: r.type || null, resultat: r.resultat, recu: rc, audit: { seq: l.seq, h: l.h } } };
    } else {
      MESURE.refus++;
      const l = audite(Object.assign(base, { statut: r && r.tx ? 'perte' : 'refuse', raison: String((r && r.raison) || 'refused').slice(0, 200), tx: (r && r.tx) || null }));
      sortie = { code: 402, corps: { ok: false, raison: (r && r.raison) || 'refused - nothing was charged', audit: { seq: l.seq, h: l.h } } };
    }
    IDEM[ik] = { t: maintenant(), etat: 'fini', code: sortie.code, corps: sortie.corps };
    ecritIdem();
    return sortie;
  }

  /** Les lignes d'audit d'un proprietaire (ou d'une seule de ses cles), les plus recentes d'abord, et l'etat de la chaine entiere. */
  function audit(addr, cleId, n) {
    const a = String(addr || '').toLowerCase();
    const l = lignes.filter((x) => x.addr === a && (!cleId || x.cle === cleId)).slice(-(n || 100)).reverse();
    return { ok: true, lignes: l, chaine: verifie(lignes), note: 'Each line carries the SHA-256 of the previous one (prev) and its own (h): changing any line breaks every later one.' };
  }

  return { paie, audit, MESURE, etat: () => ({ lignes: lignes.length, chaine: verifie(lignes).ok, mesure: Object.assign({}, MESURE) }) };
}

module.exports = { cree, verifie, empreinteLigne, ZERO };
