'use strict';
/* ==========================================================================
 * « PUIS-JE REVENDRE CE JETON ? » — L'EPREUVE DE SORTIE, VENDUE AUX AGENTS
 *
 * Demande du proprietaire, 27 septembre 2026 : developper SwogeAgentic avec des
 * outils dont un agent a besoin AU MOMENT D'AGIR. Les compteurs du meme jour :
 * 17 demandeurs distincts ont lu un prix, aucun n'a paye — l'information seule
 * ne vend pas. Avant d'acheter un jeton de Robinhood Chain, un agent de trading
 * veut savoir s'il pourra en ressortir, et a quel prix. honeypot.is ne connait
 * pas la chaine 4663 (ai_colonie.horsService, releve du meme jour) : cette
 * reponse-la, presque personne d'autre ne la donne.
 *
 * Ce qui est joue : l'epreuve que le Cobaye joue avant chaque achat de la
 * colonie (ai_colonie.epreuveDeSortie), en LECTURE SEULE —
 *   1. des porteurs reels envoient 1 unite vers la piscine (eth_call) : un
 *      contrat piege refuse ;
 *   2. le quoteur du miroir chiffre l'achat PUIS la revente immediate d'une
 *      sonde de la taille d'un ordre ordinaire : une piscine a hook, une taxe
 *      qui ramene la sortie a zero, une piscine trop mince se voient ;
 *   3. la part de la liquidite brulee, quand la piscine a un jeton de LP.
 * Aucune transaction, aucune cle : eth_call et devis.
 *
 * On ne facture qu'une REPONSE : jeton absent de Robinhood Chain, noeud muet,
 * quoteur muet et transfert non jouable → erreur, rien de regle.
 *
 * Chaque reponse est gardee (sorties/AAAA-MM-JJ.jsonl dans DATA_DIR) : jeton,
 * verdict, chiffres, sans le payeur. Demande du proprietaire, meme jour :
 * « toutes les donnees sont utiles a stocker et garder ». C'est ce journal qui
 * dira plus tard si « sellable » tenait trente minutes apres.
 * ======================================================================== */
const fs = require('fs');
const path = require('path');

const ADR = /^0x[0-9a-fA-F]{40}$/;
/* Une epreuve coute ~3 eth_call, une lecture de journaux et un devis : gardee
   60 s par adresse (le rythme du scan d'un utilisateur), et au plus 2 en vol
   pour ne pas prendre le noeud que la colonie partage. Pas des mesures : des
   reperes de depart, a relire dans MESURE. */
const CACHE_MS = 60e3;
const EN_VOL_MAX = 2;

const LIMITES = 'A read-only simulation of what the pool would return NOW for a small order. '
  + 'It cannot see a blacklist that closes after you buy, liquidity pulled later, or a tax changed later. Measurements, never a buy or sell signal.';

function jourUtc(t) { return new Date(t).toISOString().slice(0, 10); }
const arrondi = (x, k) => (typeof x === 'number' && isFinite(x) ? Math.round(x * (k || 10)) / (k || 10) : null);

/** Le verdict, a partir de ce que l'epreuve a rendu. `null` : rien de jugeable. */
function verdictDe(transfert, retour, max) {
  const tr = transfert || {}, rt = retour || {};
  const chiffre = typeof rt.pct === 'number' && isFinite(rt.pct);
  const cout = chiffre ? Math.round((100 - rt.pct) * 10) / 10 : null;
  if (tr.teste && !tr.passe) return { v: 'blocked', pourquoi: 'every holder we tried is refused when sending the token to the ' + (tr.via || 'pool') + ' (' + tr.refus + '/' + tr.essais + ')' };
  if (chiffre && rt.pct < rt.min) return { v: 'blocked', pourquoi: 'selling straight back would return ' + rt.pct + '% of the stake (' + rt.min + '% needed): the pool lets you in, not out' };
  if (chiffre && cout > max) return { v: 'costly', pourquoi: 'a round trip would cost ' + cout + '% in fees and depth, above the ' + max + '% the SWOGE colony itself accepts' };
  if (chiffre) return { v: 'sellable', pourquoi: 'a round trip returns ' + rt.pct + '% of the stake (' + cout + '% in fees and depth)' + (tr.teste ? ', and holders can send it to the ' + tr.via : '') };
  if (tr.teste && tr.passe) return { v: 'partial', pourquoi: 'holders can send it to the ' + tr.via + ', but no round-trip quote was available: a hooked pool or a sell tax would not show' };
  return null;
}

/**
 * deps : { epreuve(addr) → ai_colonie.epreuveDeSortie, dossier (DATA_DIR), maintenant() }
 */
function cree(deps) {
  const maintenant = () => (deps.maintenant ? deps.maintenant() : Date.now());
  const cache = new Map(), enVol = new Map();
  let actifs = 0;
  const MESURE = { demandes: 0, cache: 0, occupe: 0, rendus: 0, sansReponse: 0, absents: 0, verdicts: {} };

  function garde(ligne) {
    if (!deps.dossier) return;
    try {
      const d = path.join(deps.dossier, 'sorties');
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(path.join(d, jourUtc(ligne.t) + '.jsonl'), JSON.stringify(ligne) + '\n');
    } catch (e) { /* un journal qui echoue ne casse jamais une reponse */ }
  }

  async function joue(a) {
    let b;
    try { b = await deps.epreuve(a); } catch (e) { b = null; }
    if (!b || !b.trouve) {
      MESURE.absents++;
      return { erreur: 'this token has no pool on Robinhood Chain that DexScreener knows — nothing was charged' };
    }
    const max = b.retourMax;
    const v = verdictDe(b.transfert, b.retour, max);
    if (!v) {
      MESURE.sansReponse++;
      const pourquoi = [b.transfert && b.transfert.raison, b.retour && b.retour.raison].filter(Boolean).join('; ');
      return { erreur: 'the exit could not be tested right now (' + (pourquoi || 'no answer') + ') — nothing was charged' };
    }
    const t = b.jeton || {}, tr = b.transfert || {}, rt = b.retour || {}, lp = b.lp || {};
    const chiffre = typeof rt.pct === 'number' && isFinite(rt.pct);
    const quand = maintenant();
    const r = {
      token: { address: a, symbol: t.sym || null, chain: 'robinhood', pool: t.pool || null, ageMinutes: arrondi(t.minutes, 1),
               liquidityUsd: arrondi(t.liq, 1), marketCapUsd: arrondi(t.mc, 1) },
      verdict: v.v,
      why: v.pourquoi,
      transfer: { tested: !!tr.teste, tries: tr.teste ? tr.essais : 0, refused: tr.teste ? tr.refus : 0, target: tr.via || null,
                  reason: tr.teste ? null : (tr.raison || null) },
      roundTrip: chiffre
        ? { quoted: true, returnPct: rt.pct, costPct: Math.round((100 - rt.pct) * 10) / 10, minReturnPct: rt.min, probeEth: rt.sonde ? Number(rt.sonde) : null,
            uniswap: rt.ver || null, maxCostPct: max }
        : { quoted: false, reason: rt.raison || 'no quoter available' },
      liquidity: lp.vu ? { lpTokenRead: true, burnedPct: lp.brulee } : { lpTokenRead: false, reason: lp.raison || null },
      checkedAt: new Date(quand).toISOString(),
      limits: LIMITES,
    };
    MESURE.rendus++;
    MESURE.verdicts[v.v] = (MESURE.verdicts[v.v] || 0) + 1;
    garde({ t: quand, adresse: a, sym: t.sym || null, verdict: v.v, retour: chiffre ? rt.pct : null, cout: chiffre ? r.roundTrip.costPct : null,
            sonde: chiffre ? r.roundTrip.probeEth : null, uniswap: chiffre ? rt.ver || null : null,
            transfert: tr.teste ? { essais: tr.essais, refus: tr.refus, via: tr.via } : null,
            lpBrulee: lp.vu ? lp.brulee : null, liq: t.liq || null, mc: t.mc || null, minutes: arrondi(t.minutes, 1) });
    return { resultat: r };
  }

  /** Rend { resultat } ou { erreur } (jamais facture). */
  async function verifie(adresse) {
    MESURE.demandes++;
    if (!ADR.test(String(adresse || ''))) return { erreur: 'address must be 0x followed by 40 hex characters' };
    const a = String(adresse).toLowerCase();
    const c = cache.get(a);
    if (c && maintenant() - c.t < CACHE_MS) { MESURE.cache++; return c.r; }
    if (enVol.has(a)) return enVol.get(a);
    if (actifs >= EN_VOL_MAX) { MESURE.occupe++; return { erreur: 'busy: two exit tests are already running — try again in a few seconds, nothing was charged' }; }
    actifs++;
    const p = joue(a).then((r) => {
      if (r.resultat) cache.set(a, { t: maintenant(), r });
      return r;
    }).finally(() => { actifs--; enVol.delete(a); });
    enVol.set(a, p);
    return p;
  }

  /** Le texte que lit un modele : le verdict d'abord, puis les chiffres. */
  function texte(r) {
    const x = r.resultat;
    const rt = x.roundTrip, tr = x.transfer;
    return 'Exit test for ' + (x.token.symbol ? '$' + x.token.symbol + ' ' : '') + x.token.address + ' on Robinhood Chain: ' + x.verdict.toUpperCase() + ' — ' + x.why + '.\n'
      + '- Round trip: ' + (rt.quoted ? 'buy then sell ' + rt.probeEth + ' ETH returns ' + rt.returnPct + '% (' + rt.costPct + '% cost, Uniswap ' + (rt.uniswap || '?') + ')' : 'not quoted (' + rt.reason + ')') + '.\n'
      + '- Transfer to the ' + (tr.target || 'pool') + ': ' + (tr.tested ? (tr.tries - tr.refused) + ' of ' + tr.tries + ' holders can send it' : 'not tested (' + tr.reason + ')') + '.\n'
      + '- Liquidity: ' + (x.liquidity.lpTokenRead ? x.liquidity.burnedPct + '% of LP tokens burned' : 'LP not readable (' + x.liquidity.reason + ')')
      + (x.token.liquidityUsd ? ', pool $' + Math.round(x.token.liquidityUsd).toLocaleString('en-US') : '') + '.\n'
      + x.limits;
  }

  return { verifie, texte, MESURE };
}

module.exports = { cree, verdictDe, CACHE_MS, EN_VOL_MAX, LIMITES };
