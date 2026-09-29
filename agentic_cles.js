'use strict';
/* ==================================================================
 * SWOGEAGENTIC — LES CLÉS D'API DES AGENTS, ATTACHÉES AU PORTEFEUILLE
 * ==================================================================
 *
 * Demande du propriétaire, le 26 septembre 2026 : « SwogeAgentic doit être
 * comme HYRE — utilisable par les AUTRES agents ». Un agent (Claude Desktop,
 * Cursor, un script) ne sait pas signer avec un wallet dans une page : il lui
 * faut une clé. La clé est créée DANS la page, par la session signée du
 * joueur, et débite SON solde $SWOGE — jamais celui d'un autre.
 *
 * ---- CE QUI PROTÈGE LE JOUEUR ----
 *
 *   - La clé est montrée UNE seule fois ; le serveur ne garde que son
 *     empreinte SHA-256. Un disque volé ne donne aucune clé utilisable.
 *   - Chaque clé a un PLAFOND PAR JOUR choisi par le joueur : une clé qui
 *     fuit ne peut coûter que ce plafond, jusqu'à ce qu'il la révoque.
 *   - Une clé ne peut rien créer, rien révoquer, et aucun outil n'achète, ne
 *     vend, ne signe : elle ne sert qu'à LIRE, contre paiement.
 *   - Au plus MAX_ACTIVES clés vivantes par adresse.
 *
 * Un fichier, `DATA_DIR/agentic_cles.json`, écrit comme `store.js` :
 * temporaire, fsync, rename. Un fichier illisible n'est jamais écrasé.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ACTIVES = 5;
const PREFIXE = 'swg_';
const RECUS_MAX = 50;
const PLAFOND_MIN = 1;                  /* en $SWOGE entiers, par jour */
const PLAFOND_MAX = 100000000;
/* Le crédit en dollars (credits.js, 29/09/2026) : une clé peut se payer sur le crédit du
   propriétaire au lieu de son $SWOGE. Son plafond du jour est alors en DOLLARS. */
const PLAFOND_USD_MIN = 0.01;
const PLAFOND_USD_MAX = 1000;
const PAIE_MIN_APPEL_USD = 0.001;       /* payer un service : le plafond par appel que le proprietaire choisit… */
const PAIE_MAX_APPEL_USD = 0.1;         /* …jamais au-dessus de celui de l'embauche (EMBAUCHE_MAX_APPEL_USD, 0,10 $) */

const empreinte = (cle) => crypto.createHash('sha256').update(String(cle)).digest('hex');
const jourDe = (t) => new Date(t).toISOString().slice(0, 10);

function cree(opts) {
  const fichier = (opts && opts.fichier) || path.join(require('./config').DATA_DIR, 'agentic_cles.json');
  const maintenant = (opts && opts.maintenant) || (() => Date.now());
  let E = null;

  function charge() {
    if (E) return E;
    let brut;
    try { brut = fs.readFileSync(fichier, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { E = { cles: {}, recus: {} }; return E; } throw e; }
    const j = JSON.parse(brut);
    if (!j || typeof j.cles !== 'object') throw new Error('agentic_cles illisible');
    E = { cles: j.cles, recus: j.recus || {} };
    return E;
  }
  function sauve() {
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    const tmp = fichier + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(E)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, fichier);
  }
  const auCredit = (c) => c.payeur === 'credit';
  /* La dépense du jour, dans l'UNITÉ de la clé ($SWOGE, ou dollars pour une clé au crédit). */
  const depenseDuJour = (c) => (c.jour === jourDe(maintenant()) ? (auCredit(c) ? c.depenseUsd || 0 : c.depenseSwoge) : 0);
  const vue = (h, c) => ({ id: h.slice(0, 12), nom: c.nom, debut: c.debut, cree: c.cree, derniere: c.derniere || null,
    payeur: auCredit(c) ? 'credit' : 'swoge', plafondUsd: auCredit(c) ? c.plafondUsd : null,
    plafondSwoge: c.plafondSwoge, depenseAujourdhui: depenseDuJour(c), revoquee: !!c.revoquee,
    paiements: c.paie && c.paie.actif ? { actif: true, maxAppelUsd: c.paie.maxAppelUsd, hotes: c.paie.hotes.slice() } : { actif: false },
    passeportPublic: !!c.passeportPublic });

  /* Le payeur et son plafond du jour : { payeur: 'credit', plafondUsd } ou { payeur: 'swoge', plafondSwoge }. */
  function payeurLu(o) {
    o = o || {};
    if (o.payeur === 'credit') {
      const u = Math.round(Number(o.plafondUsd) * 100) / 100;
      if (!(u >= PLAFOND_USD_MIN && u <= PLAFOND_USD_MAX)) return { erreur: 'set a daily spending cap between $' + PLAFOND_USD_MIN + ' and $' + PLAFOND_USD_MAX };
      return { payeur: 'credit', plafondUsd: u };
    }
    const p = Math.floor(Number(o.plafondSwoge));
    if (!(p >= PLAFOND_MIN && p <= PLAFOND_MAX)) return { erreur: 'set a daily spending cap between ' + PLAFOND_MIN + ' and ' + PLAFOND_MAX.toLocaleString('en-US') + ' $SWOGE' };
    return { payeur: 'swoge', plafondSwoge: p };
  }

  /** Crée une clé pour l'adresse de la SESSION. Rend la clé en clair une seule fois.
   *  opts : { payeur: 'credit', plafondUsd } pour une clé payée sur le crédit en dollars. */
  function nouvelle(addr, nom, plafondSwoge, opts) {
    if (!addr) return { ok: false, code: 401 };
    const S = charge();
    const actives = Object.values(S.cles).filter((c) => c.addr === addr && !c.revoquee).length;
    if (actives >= MAX_ACTIVES) return { ok: false, code: 409, raison: 'at most ' + MAX_ACTIVES + ' active keys — revoke one first' };
    const pl = payeurLu(Object.assign({ plafondSwoge }, opts || {}));
    if (pl.erreur) return { ok: false, code: 400, raison: pl.erreur };
    const cle = PREFIXE + crypto.randomBytes(32).toString('base64url');
    const h = empreinte(cle);
    S.cles[h] = { addr, nom: String(nom || 'agent').replace(/[^\w .-]/g, '').slice(0, 40) || 'agent', debut: cle.slice(0, 8),
                  cree: maintenant(), plafondSwoge: pl.plafondSwoge || null, jour: null, depenseSwoge: 0 };
    if (pl.payeur === 'credit') Object.assign(S.cles[h], { payeur: 'credit', plafondUsd: pl.plafondUsd, depenseUsd: 0 });
    sauve();
    return { ok: true, cle, cleVue: vue(h, S.cles[h]) };
  }

  /** Le propriétaire (SESSION) change le payeur d'une de ses clés, et son plafond du jour dans la nouvelle unité. */
  function fixePayeur(addr, id, o) {
    const S = charge();
    const h = Object.keys(S.cles).find((k) => k.slice(0, 12) === String(id || '') && S.cles[k].addr === addr && !S.cles[k].revoquee);
    if (!h) return { ok: false, code: 404, raison: 'no such key' };
    const pl = payeurLu(o);
    if (pl.erreur) return { ok: false, code: 400, raison: pl.erreur };
    const c = S.cles[h];
    if (pl.payeur === 'credit') { if (!auCredit(c)) c.depenseUsd = 0; c.payeur = 'credit'; c.plafondUsd = pl.plafondUsd; }
    else { if (auCredit(c)) c.depenseSwoge = 0; delete c.payeur; delete c.plafondUsd; c.plafondSwoge = pl.plafondSwoge; }
    sauve();
    return { ok: true, cle: vue(h, c) };
  }

  /** Les clés d'une adresse, sans jamais la clé elle-même. */
  function liste(addr) {
    const S = charge();
    return Object.entries(S.cles).filter(([, c]) => c.addr === addr).map(([h, c]) => vue(h, c)).sort((a, b) => b.cree - a.cree);
  }

  function revoque(addr, id) {
    const S = charge();
    const h = Object.keys(S.cles).find((k) => k.slice(0, 12) === String(id || '') && S.cles[k].addr === addr);
    if (!h) return { ok: false, code: 404, raison: 'no such key' };
    S.cles[h].revoquee = true; sauve();
    return { ok: true };
  }

  /** La clé présentée par un agent → l'adresse qu'elle débite, ou null. */
  function resout(cle) {
    if (typeof cle !== 'string' || !cle.startsWith(PREFIXE) || cle.length > 100) return null;
    const S = charge();
    const h = empreinte(cle), c = S.cles[h];
    if (!c || c.revoquee) return null;
    return { id: h.slice(0, 12), h, addr: c.addr, plafondSwoge: c.plafondSwoge, payeur: auCredit(c) ? 'credit' : 'swoge', plafondUsd: auCredit(c) ? c.plafondUsd : null };
  }

  /** Reste-t-il `montant` sous le plafond du jour ? `montant` est dans l'UNITÉ de la clé :
   *  $SWOGE, ou dollars pour une clé au crédit (l'appelant facture alors au cours 1). */
  function sousPlafond(h, montant) {
    const c = charge().cles[h]; if (!c) return false;
    return depenseDuJour(c) + montant <= (auCredit(c) ? c.plafondUsd : c.plafondSwoge) + 1e-9;
  }
  /** Compte une dépense réglée (dans l'unité de la clé), et garde le reçu. */
  function depense(h, montant, recu) {
    const S = charge(), c = S.cles[h]; if (!c) return;
    const j = jourDe(maintenant());
    if (c.jour !== j) { c.jour = j; c.depenseSwoge = 0; c.depenseUsd = 0; }
    if (auCredit(c)) c.depenseUsd = Math.round(((c.depenseUsd || 0) + montant) * 1e6) / 1e6;
    else c.depenseSwoge = Math.round((c.depenseSwoge + montant) * 1e6) / 1e6;
    c.derniere = maintenant();
    /* Le passeport (29/09) : ce que la clé a fait depuis qu'on le compte, en appels et en dollars (le reçu porte toujours usd). */
    c.appels = (c.appels || 0) + 1;
    c.usdTotal = Math.round(((c.usdTotal || 0) + (Number(recu && recu.usd) || 0)) * 1e6) / 1e6;
    if (!c.comptesDepuis) c.comptesDepuis = maintenant();
    const l = S.recus[c.addr] || (S.recus[c.addr] = []);
    /* Au crédit : le reçu dit dollars, jamais un montant en $SWOGE qui n'a pas été débité. */
    if (auCredit(c)) { recu = Object.assign({}, recu, { payeur: 'credit' }); delete recu.swoge; }
    l.unshift(Object.assign({ cle: h.slice(0, 12), t: maintenant() }, recu));
    if (l.length > RECUS_MAX) l.length = RECUS_MAX;
    sauve();
  }
  function recus(addr) { return (charge().recus[addr] || []).slice(); }

  /* ---- PAYER D'AUTRES SERVICES AVEC LA CLE (passerelle.js, 28/09/2026 au soir) ----
     Une clé ne sert qu'a LIRE, c'est sa promesse : payer un service exterieur est une
     permission que le proprietaire active LUI-MEME, cle par cle, avec un plafond par appel
     (au plus PAIE_MAX_APPEL_USD, le plafond de l'embauche) et, s'il le veut, les seuls
     sites autorises. Eteinte par defaut, et pour toute cle creee avant. */
  function fixePaiement(addr, id, p) {
    const S = charge();
    const h = Object.keys(S.cles).find((k) => k.slice(0, 12) === String(id || '') && S.cles[k].addr === addr && !S.cles[k].revoquee);
    if (!h) return { ok: false, code: 404, raison: 'no such key' };
    p = p || {};
    if (!p.actif) { S.cles[h].paie = { actif: false, maxAppelUsd: 0, hotes: [] }; sauve(); return { ok: true, cle: vue(h, S.cles[h]) }; }
    const m = Number(p.maxAppelUsd);
    if (!(m >= PAIE_MIN_APPEL_USD && m <= PAIE_MAX_APPEL_USD)) return { ok: false, code: 400, raison: 'set a per-call payment cap between $' + PAIE_MIN_APPEL_USD + ' and $' + PAIE_MAX_APPEL_USD };
    const hotes = Array.isArray(p.hotes) ? p.hotes.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
    if (hotes.length > 20 || !hotes.every((x) => /^(?=.{1,120}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(x))) return { ok: false, code: 400, raison: 'allowed sites: up to 20 host names like api.example.com' };
    S.cles[h].paie = { actif: true, maxAppelUsd: Math.round(m * 1e6) / 1e6, hotes: [...new Set(hotes)] };
    sauve();
    return { ok: true, cle: vue(h, S.cles[h]) };
  }
  /** La politique de paiement d'une cle (par son empreinte), ou null si les paiements sont eteints. */
  function paiementDe(h) { const c = charge().cles[h]; return c && !c.revoquee && c.paie && c.paie.actif ? Object.assign({}, c.paie, { hotes: c.paie.hotes.slice() }) : null; }

  /* ---- LE PASSEPORT (passeport.js, 29/09) ----
     Privé par défaut ; le propriétaire (SA session) le rend public, clé par clé. */
  function publie(addr, id, oui) {
    const S = charge();
    const h = Object.keys(S.cles).find((k) => k.slice(0, 12) === String(id || '') && S.cles[k].addr === addr && !S.cles[k].revoquee);
    if (!h) return { ok: false, code: 404, raison: 'no such key' };
    S.cles[h].passeportPublic = !!oui; sauve();
    return { ok: true, cle: vue(h, S.cles[h]) };
  }
  /** Une clé par son identifiant public (12 hexadécimaux) : { h, id, c } ou null. Jamais la clé elle-même. */
  function parId(id) {
    if (!/^[0-9a-f]{12}$/.test(String(id || ''))) return null;
    const S = charge();
    const h = Object.keys(S.cles).find((k) => k.slice(0, 12) === id);
    return h ? { h, id, c: Object.assign({}, S.cles[h], { paie: S.cles[h].paie ? Object.assign({}, S.cles[h].paie, { hotes: (S.cles[h].paie.hotes || []).slice() }) : null }) } : null;
  }

  return { nouvelle, liste, revoque, resout, sousPlafond, depense, recus, fixePaiement, paiementDe, fixePayeur, publie, parId, _etat: () => charge() };
}

module.exports = { cree, empreinte, MAX_ACTIVES, PREFIXE, PLAFOND_MIN, PLAFOND_MAX, PLAFOND_USD_MIN, PLAFOND_USD_MAX };
