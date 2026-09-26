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
  const vue = (h, c) => ({ id: h.slice(0, 12), nom: c.nom, debut: c.debut, cree: c.cree, derniere: c.derniere || null,
    plafondSwoge: c.plafondSwoge, depenseAujourdhui: c.jour === jourDe(maintenant()) ? c.depenseSwoge : 0, revoquee: !!c.revoquee });

  /** Crée une clé pour l'adresse de la SESSION. Rend la clé en clair une seule fois. */
  function nouvelle(addr, nom, plafondSwoge) {
    if (!addr) return { ok: false, code: 401 };
    const S = charge();
    const actives = Object.values(S.cles).filter((c) => c.addr === addr && !c.revoquee).length;
    if (actives >= MAX_ACTIVES) return { ok: false, code: 409, raison: 'at most ' + MAX_ACTIVES + ' active keys — revoke one first' };
    const p = Math.floor(Number(plafondSwoge));
    if (!(p >= PLAFOND_MIN && p <= PLAFOND_MAX)) return { ok: false, code: 400, raison: 'set a daily spending cap between ' + PLAFOND_MIN + ' and ' + PLAFOND_MAX.toLocaleString('en-US') + ' $SWOGE' };
    const cle = PREFIXE + crypto.randomBytes(32).toString('base64url');
    const h = empreinte(cle);
    S.cles[h] = { addr, nom: String(nom || 'agent').replace(/[^\w .-]/g, '').slice(0, 40) || 'agent', debut: cle.slice(0, 8),
                  cree: maintenant(), plafondSwoge: p, jour: null, depenseSwoge: 0 };
    sauve();
    return { ok: true, cle, cleVue: vue(h, S.cles[h]) };
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
    return { id: h.slice(0, 12), h, addr: c.addr, plafondSwoge: c.plafondSwoge };
  }

  /** Reste-t-il `swoge` sous le plafond du jour ? */
  function sousPlafond(h, swoge) {
    const c = charge().cles[h]; if (!c) return false;
    const j = jourDe(maintenant());
    const deja = c.jour === j ? c.depenseSwoge : 0;
    return deja + swoge <= c.plafondSwoge;
  }
  /** Compte une dépense réglée, et garde le reçu. */
  function depense(h, swoge, recu) {
    const S = charge(), c = S.cles[h]; if (!c) return;
    const j = jourDe(maintenant());
    if (c.jour !== j) { c.jour = j; c.depenseSwoge = 0; }
    c.depenseSwoge = Math.round((c.depenseSwoge + swoge) * 1e6) / 1e6;
    c.derniere = maintenant();
    const l = S.recus[c.addr] || (S.recus[c.addr] = []);
    l.unshift(Object.assign({ cle: h.slice(0, 12), t: maintenant() }, recu));
    if (l.length > RECUS_MAX) l.length = RECUS_MAX;
    sauve();
  }
  function recus(addr) { return (charge().recus[addr] || []).slice(); }

  return { nouvelle, liste, revoque, resout, sousPlafond, depense, recus, _etat: () => charge() };
}

module.exports = { cree, empreinte, MAX_ACTIVES, PREFIXE, PLAFOND_MIN, PLAFOND_MAX };
