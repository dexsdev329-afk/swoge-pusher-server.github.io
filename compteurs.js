'use strict';
/* ==================================================================
 * LES COMPTEURS DURABLES DE L'ARGENT DES AGENTS — UN FICHIER PAR JOUR
 * ==================================================================
 *
 * Audit du 26 septembre 2026, serveur en production : x402 marchait, mais
 * AUCUN paiement n'avait jamais été réglé ; MCP refusait tout appel sans clé,
 * même un devis ; et rien ne permettait de dire pourquoi. Les compteurs
 * existants (x402 MESURE, chat, médias) vivent en mémoire et repartent de
 * zéro à chaque redéploiement ; les clés ne gardent que la dépense du jour et
 * les 50 derniers reçus (RECUS_MAX). Rien de durable ne comptait les 402
 * émis contre les paiements, par outil, ni les appels refusés faute de clé.
 * Sans ces nombres, aucune décision de prix ou de débit n'est jugeable
 * (règle du dépôt : mesurer avant de changer).
 *
 * ---- CE QU'ON COMPTE ----
 * note(evenement, { outil, canal, qui, usd, coutUsd, sorte })
 *   evenement : devis, demande402, paye_x402, paye_cle, refus_sans_cle,
 *               echec, chat_facture, image_facturee, video_facturee
 *   canal     : rest | mcp | chat | agent | studio
 *   qui       : sert SEULEMENT à compter les demandeurs DISTINCTS — l'adresse
 *               du payeur ou du propriétaire de la clé pour un paiement,
 *               l'empreinte salée et tronquée de l'IP (`ip()`) sinon. Il est
 *               re-haché avant d'être écrit : le fichier ne contient ni IP ni
 *               adresse, seulement des empreintes de 16 caractères.
 *   usd       : ce qui a été facturé ; coutUsd : ce que ça nous a coûté,
 *               QUAND ON LE SAIT (sinon null — la marge ne se calcule que sur
 *               les observations dont le coût est connu : coutN, usdAvecCout).
 *   sorte     : un sous-compte (raison d'un échec, sonde ou vraie demande,
 *               fournisseur d'une image) — un ensemble petit et borné.
 *
 * Chaque compte est séparé en `exterieur` et `maison` : une adresse de
 * `maison()` (AI_OWNER, X402_PAYTO, le portefeuille de gaz, COMPTEURS_MAISON)
 * compte comme la maison — un essai du propriétaire n'est pas un client. Une
 * empreinte d'IP ne se reconnaît pas : elle compte toujours comme extérieure.
 *
 * ---- LE DISQUE ----
 * DATA_DIR/compteurs/AAAA-MM-JJ.json (jour UTC), écrit comme agentic_cles.js :
 * temporaire, fsync, rename. Écriture différée d'au plus DELAI_MS (5 s), et
 * vidée sur SIGTERM/SIGINT/beforeExit/exit : un redéploiement ne perd rien.
 * JOURS_GARDES (400) jours gardés. Les empreintes distinctes sont bornées à
 * DISTINCTS_MAX (10 000) par jour ET PAR ÉVÉNEMENT : au-delà on compte encore,
 * mais le nombre de distincts de CET événement devient un minimum
 * (`approx: true`). Une borne par jour partagée entre tous les événements
 * laissait un flot de refus sans clé (empreintes d'IP, X-Forwarded-For
 * falsifiable) remplir la journée : relecture du 26 septembre 2026, 10 050
 * appels ask_agent sans clé en 6,2 s, puis un vrai paiement USDG d'une adresse
 * neuve → paye_x402 {n: 1, distincts: 0, approx}. Le nombre de payeurs
 * distincts — celui que cet audit venait chercher — s'effaçait pour la journée.
 * Par événement, les payeurs (adresses vérifiées, bornées par l'argent) ne
 * partagent plus leur borne avec les IP. Pire cas : 9 × 10 000 empreintes de
 * 16 caractères, ~1,7 Mo pour le fichier du jour.
 * `debordes` compte les NOTES arrivées après la borne avec une empreinte non
 * gardée — un même demandeur y compte à chaque fois : ce n'est pas un nombre
 * de personnes.
 * ================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EVENEMENTS = ['devis', 'demande402', 'paye_x402', 'paye_cle', 'refus_sans_cle', 'echec', 'chat_facture', 'image_facturee', 'video_facturee'];
const CANAUX = ['rest', 'mcp', 'chat', 'agent', 'studio'];
const DELAI_MS = 5000;
const JOURS_GARDES = 400;
const DISTINCTS_MAX = 10000;
const MOTIF_FICHIER = /^(\d{4}-\d{2}-\d{2})\.json$/;

const jourDe = (t) => new Date(t).toISOString().slice(0, 10);
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const nombre = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const compteVide = () => ({ n: 0, usd: 0, coutUsd: 0, coutN: 0, usdAvecCout: 0 });

function ajoute(c, usd, cout) {
  c.n++;
  if (usd !== null) c.usd = r6(c.usd + usd);
  if (cout !== null) { c.coutN++; c.coutUsd = r6(c.coutUsd + cout); c.usdAvecCout = r6(c.usdAvecCout + (usd || 0)); }
}
/* Un compte, et la part extérieure / maison. */
const compteSepare = () => Object.assign(compteVide(), { exterieur: compteVide(), maison: compteVide() });

function cree(opts) {
  const o = opts || {};
  const dossier = o.dossier || path.join(require('./config').DATA_DIR, 'compteurs');
  const maintenant = o.maintenant || (() => Date.now());
  const maison = o.maison || (() => new Set());
  const delaiMs = o.delaiMs === undefined ? DELAI_MS : o.delaiMs;
  const joursGardes = o.joursGardes || JOURS_GARDES;
  const distinctsMax = o.distinctsMax || DISTINCTS_MAX;

  /* ---- LE SEL : de l'environnement, ou tiré au premier démarrage et gardé ici ---- */
  let sel = String(o.sel || process.env.COMPTEURS_SEL || '');
  if (!sel) {
    const f = path.join(dossier, 'sel');
    try { sel = fs.readFileSync(f, 'utf8').trim(); } catch (e) { sel = ''; }
    if (!sel) {
      sel = crypto.randomBytes(32).toString('hex');
      try { fs.mkdirSync(dossier, { recursive: true }); fs.writeFileSync(f, sel, { mode: 0o600 }); }
      catch (e) { console.warn('[compteurs] salt not stored (' + (e && e.code) + ') — distinct counts restart with the process'); }
    }
  }
  const empreinte = (x) => crypto.createHash('sha256').update(sel + '|' + x).digest('hex').slice(0, 16);

  /** L'IP d'une requête → son empreinte salée et tronquée. L'IP elle-même n'est jamais gardée. */
  const ip = (brute) => 'ip:' + empreinte('ip|' + String(brute || '?'));

  let J = null;            /* le jour en cours, en mémoire (ensembles vivants) */
  let sale = false, minuteur = null;
  const passes = new Map(); /* jour passé → résumé (un jour fini ne bouge plus) */

  const fichierDe = (jour) => path.join(dossier, jour + '.json');

  function lit(jour) {
    let brut;
    try { brut = fs.readFileSync(fichierDe(jour), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { return JSON.parse(brut); }
    catch (e) {
      /* Un fichier illisible n'est jamais écrasé : on le met de côté et on repart. */
      try { fs.renameSync(fichierDe(jour), fichierDe(jour) + '.illisible.' + maintenant()); } catch (x) { /* rien */ }
      console.error('[compteurs] unreadable ' + jour + '.json set aside');
      return null;
    }
  }

  /* Un jour lu (ou neuf) → prêt à compter : les empreintes en ensembles vivants. */
  function prepare(lu, jour) {
    const d = lu || { v: 1, jour, evenements: {} };
    d.v = 1; d.jour = jour; d.evenements = d.evenements || {};
    for (const e of Object.values(d.evenements)) {
      const dd = e.distincts || (e.distincts = { n: 0, approx: false, debordes: 0, h: [] });
      dd.ens = new Set(dd.h || []); delete dd.h;
    }
    return d;
  }

  function serialise(d) {
    const copie = { v: 1, jour: d.jour, evenements: {} };
    for (const [k, e] of Object.entries(d.evenements)) {
      const dd = e.distincts;
      copie.evenements[k] = Object.assign({}, e, { distincts: { n: dd.n, approx: dd.approx, debordes: dd.debordes, h: Array.from(dd.ens) } });
    }
    return JSON.stringify(copie);
  }

  function ecrit(d) {
    fs.mkdirSync(dossier, { recursive: true });
    const f = fichierDe(d.jour), tmp = f + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, serialise(d)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, f);
  }

  /* Les jours au-delà de JOURS_GARDES s'effacent. */
  function purge() {
    let noms = [];
    try { noms = fs.readdirSync(dossier); } catch (e) { return; }
    const limite = jourDe(maintenant() - joursGardes * 864e5);
    for (const nom of noms) {
      const m = MOTIF_FICHIER.exec(nom);
      if (m && m[1] < limite) { try { fs.unlinkSync(path.join(dossier, nom)); } catch (e) { /* rien */ } }
    }
  }

  /** Écrit ce qui attend. Synchrone : appelable depuis un gestionnaire de sortie. */
  function vide() {
    if (minuteur) { clearTimeout(minuteur); minuteur = null; }
    if (!sale || !J) return;
    try { ecrit(J); sale = false; }
    catch (e) { console.error('[compteurs] write failed: ' + (e && e.code || e)); }
  }

  function jourCourant() {
    const j = jourDe(maintenant());
    if (J && J.jour === j) return J;
    if (J) { vide(); passes.delete(J.jour); }
    J = prepare(lit(j), j);
    purge();
    return J;
  }

  function planifie() {
    sale = true;
    if (delaiMs <= 0) return vide();
    if (!minuteur) { minuteur = setTimeout(vide, delaiMs); if (minuteur.unref) minuteur.unref(); }
  }

  /** Compte un événement. Rend false (sans rien lever) pour un événement inconnu. */
  function note(evenement, info) {
    if (!EVENEMENTS.includes(evenement)) return false;
    const i = info || {};
    const d = jourCourant();
    const usd = nombre(i.usd), cout = nombre(i.coutUsd);
    const qui = i.qui ? String(i.qui).toLowerCase() : null;
    const adr = qui ? qui.replace(/^x402:/, '') : null;
    /* Une adresse EVM, ou Solana (base58, mise en minuscules comme tout le reste : 28/09,
       les paiements Solana du proprietaire comptaient comme des clients). Une IP, jamais. */
    const chezNous = !!(adr && (/^0x[0-9a-f]{40}$/.test(adr) || /^[1-9a-z]{32,44}$/.test(adr)) && maison().has(adr));
    const part = chezNous ? 'maison' : 'exterieur';
    const e = d.evenements[evenement] || (d.evenements[evenement] = Object.assign(compteSepare(),
      { canaux: {}, sortes: {}, outils: {}, distincts: { n: 0, approx: false, debordes: 0, ens: new Set() } }));
    ajoute(e, usd, cout); ajoute(e[part], usd, cout);
    const canal = CANAUX.includes(i.canal) ? i.canal : 'autre';
    e.canaux[canal] = (e.canaux[canal] || 0) + 1;
    /* Depuis le 28/09 au soir, un sous-compte separe aussi exterieur et maison ; un sous-compte
       ecrit avant (sans la separation) reste tel quel ce jour-la : sa part exterieure est inconnue. */
    if (i.sorte) { const s = String(i.sorte).slice(0, 60), so = e.sortes[s] || (e.sortes[s] = compteSepare()); ajoute(so, usd, cout); if (so.exterieur) ajoute(so[part], usd, cout); }
    const outil = String(i.outil || '-').slice(0, 60);
    const t = e.outils[outil] || (e.outils[outil] = compteSepare());
    ajoute(t, usd, cout); ajoute(t[part], usd, cout);
    if (qui) {
      const h = empreinte(qui), dd = e.distincts;
      /* La borne est celle de l'événement : un flot d'empreintes d'IP sur
         refus_sans_cle ne peut plus effacer les payeurs de paye_x402. */
      if (!dd.ens.has(h)) {
        if (dd.ens.size < distinctsMax) { dd.ens.add(h); dd.n = dd.ens.size; }
        else { dd.approx = true; dd.debordes++; }
      }
    }
    planifie();
    return true;
  }

  /* Un jour, sans empreintes : ce qui peut se montrer. */
  function resume(d) {
    const net = (c) => ({ n: c.n, usd: c.usd, coutUsd: c.coutUsd, coutN: c.coutN, usdAvecCout: c.usdAvecCout });
    const out = { jour: d.jour, evenements: {}, outils: {} };
    for (const [k, e] of Object.entries(d.evenements || {})) {
      const dd = e.distincts || {};
      out.evenements[k] = Object.assign(net(e), { exterieur: net(e.exterieur || compteVide()), maison: net(e.maison || compteVide()),
        distincts: dd.ens ? dd.ens.size : (dd.n || 0), distinctsApprox: !!dd.approx, canaux: Object.assign({}, e.canaux),
        sortes: Object.fromEntries(Object.entries(e.sortes || {}).map(([s, c]) => [s, Object.assign(net(c), c.exterieur ? { exterieur: net(c.exterieur) } : {})])) });
      for (const [nom, c] of Object.entries(e.outils || {})) {
        (out.outils[nom] = out.outils[nom] || {})[k] = Object.assign(net(c), { exterieur: net(c.exterieur || compteVide()), maison: net(c.maison || compteVide()) });
      }
    }
    return out;
  }

  /** Les `jours` derniers jours (aujourd'hui compris), du plus récent au plus ancien, et leur total. */
  function vue(jours) {
    const nb = Math.max(1, Math.min(joursGardes, Math.floor(Number(jours) || 30)));
    const courant = jourCourant();
    const liste = [];
    for (let k = 0; k < nb; k++) {
      const j = jourDe(maintenant() - k * 864e5);
      let r;
      if (j === courant.jour) r = resume(courant);
      else if (passes.has(j)) r = passes.get(j);
      else { const d = lit(j); r = d ? resume(prepare(d, j)) : null; passes.set(j, r); }
      if (r) liste.push(r);
    }
    /* Le total de la période : les distincts ne s'additionnent pas d'un jour à l'autre (on donne le maximum d'un jour). */
    const total = { evenements: {}, outils: {} };
    const plus = (a, b) => { a.n += b.n; a.usd = r6(a.usd + b.usd); a.coutUsd = r6(a.coutUsd + b.coutUsd); a.coutN += b.coutN; a.usdAvecCout = r6(a.usdAvecCout + b.usdAvecCout); };
    for (const r of liste) {
      for (const [k, e] of Object.entries(r.evenements)) {
        const t = total.evenements[k] || (total.evenements[k] = Object.assign(compteVide(), { exterieur: compteVide(), maison: compteVide(), distinctsMaxJour: 0, canaux: {} }));
        plus(t, e); plus(t.exterieur, e.exterieur); plus(t.maison, e.maison);
        t.distinctsMaxJour = Math.max(t.distinctsMaxJour, e.distincts);
        for (const [c, n] of Object.entries(e.canaux)) t.canaux[c] = (t.canaux[c] || 0) + n;
      }
      for (const [nom, evs] of Object.entries(r.outils)) {
        for (const [k, c] of Object.entries(evs)) {
          const t = ((total.outils[nom] = total.outils[nom] || {})[k]) || (total.outils[nom][k] = Object.assign(compteVide(), { exterieur: compteVide(), maison: compteVide() }));
          plus(t, c); plus(t.exterieur, c.exterieur); plus(t.maison, c.maison);
        }
      }
    }
    return { depuis: jourDe(maintenant() - (nb - 1) * 864e5), jusqua: courant.jour, jours: liste, total };
  }

  /**
   * Le résumé PUBLIC (route /agentic/x402, champ `jours`) : par jour, chaque
   * événement ; sur la période, chaque outil. Des nombres seulement — ni
   * adresse, ni empreinte, ni sous-compte libre.
   */
  function publique(jours) {
    const v = vue(jours);
    /* Pourquoi un paiement echoue (28/09) : le 27/09, 14 echecs exterieurs de 2 payeurs, et
       aucune raison lisible hors du disque. Les raisons sont des CODES (x402 : invalid_payload,
       invalid_exact_evm_payload_signature… ; les notres : outil, reglement, paiement_refuse:<code>) ;
       tout ce qui n'a pas la forme d'un code devient « other » : jamais de texte libre. */
    const code = (s) => String(s).split(':').map((x) => (/^[a-z0-9_]{1,60}$/.test(x) ? x : 'other')).join(':');
    const raisons = (so) => {
      const o = {};
      /* exterieur : null quand un des sous-comptes date d'avant la separation (inconnu, pas zero). */
      for (const [s, c] of Object.entries(so || {})) {
        const k = code(s), r = o[k] || (o[k] = { n: 0, exterieur: 0 });
        r.n += c.n || 0;
        r.exterieur = r.exterieur === null || !c.exterieur ? null : r.exterieur + (c.exterieur.n || 0);
      }
      return o;
    };
    const court = (c) => ({ n: c.n, usd: c.usd, exterieur: { n: c.exterieur.n, usd: c.exterieur.usd }, maison: { n: c.maison.n, usd: c.maison.usd } });
    const avecCout = (c) => Object.assign(court(c), c.coutN ? { coutUsd: c.coutUsd, coutN: c.coutN, usdAvecCout: c.usdAvecCout } : {});
    return {
      depuis: v.depuis, jusqua: v.jusqua,
      note: 'UTC days. exterieur = not one of our own addresses (an IP-only requester always counts as exterieur). coutUsd is summed only over the coutN events whose real cost is known; usdAvecCout is what those same events billed. chat_facture, image_facturee and video_facturee measure billing against provider cost and overlap paye_cle / paye_x402: do not add them up.',
      parJour: v.jours.map((r) => ({ jour: r.jour, evenements: Object.fromEntries(Object.entries(r.evenements).map(([k, e]) =>
        [k, Object.assign(court(e), { distincts: e.distincts, distinctsApprox: e.distinctsApprox, canaux: e.canaux }, k === 'echec' ? { raisons: raisons(e.sortes) } : {},
          /* Qui demande un prix (29/09) : sonde (sans arguments) ou demande, et la famille du client — des codes seulement. */
          k === 'demande402' || k === 'refus_sans_cle' ? { sortes: raisons(e.sortes) } : {})])),
        /* Par outil et par jour (28/09) : ce qu'il faut pour juger une experience de prix
           avant/apres, outil par outil (releve_x402.js). Les nombres seulement. */
        outils: Object.fromEntries(Object.entries(r.outils || {}).map(([nom, evs]) => [nom, Object.fromEntries(Object.entries(evs).map(([k, c]) => [k, court(c)]))])) })),
      total: Object.fromEntries(Object.entries(v.total.evenements).map(([k, e]) => [k, Object.assign(avecCout(e), { canaux: e.canaux })])),
      outils: Object.fromEntries(Object.entries(v.total.outils).map(([nom, evs]) => [nom, Object.fromEntries(Object.entries(evs).map(([k, c]) => [k, avecCout(c)]))])),
    };
  }

  /* ---- LA SORTIE : rien ne se perd au redéploiement ----
     SIGTERM/SIGINT : on vide, puis, si personne d'autre n'écoute ce signal, on
     le relance tel quel — ajouter un écouteur ne doit pas empêcher le
     processus de s'arrêter (server.js a le sien, `shutdown`, qui sort). */
  const ecouteurs = [];
  if (o.signaux !== false) {
    for (const sig of ['SIGTERM', 'SIGINT']) {
      const h = () => {
        vide();
        if (process.listenerCount(sig) === 1) { process.removeListener(sig, h); process.kill(process.pid, sig); }
      };
      process.on(sig, h); ecouteurs.push([sig, h]);
    }
    for (const ev of ['beforeExit', 'exit']) { const h = () => vide(); process.on(ev, h); ecouteurs.push([ev, h]); }
  }
  function ferme() {
    vide();
    for (const [ev, h] of ecouteurs) process.removeListener(ev, h);
    ecouteurs.length = 0;
  }

  return { note, ip, vue, publique, vide, ferme, dossier, _jour: () => J };
}

module.exports = { cree, EVENEMENTS, CANAUX, DELAI_MS, JOURS_GARDES, DISTINCTS_MAX, jourDe };
