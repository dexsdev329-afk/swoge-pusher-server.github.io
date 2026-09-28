'use strict';
/* ==================================================================
 * LA BOUTIQUE eSIM SANS COMPTE (28 septembre 2026, au soir)
 * ==================================================================
 *
 * Demande du proprietaire : « faudrait qu'on puisse gagner de l'argent, et les
 * gens peuvent signer avec leur wallet pour acheter ? ils sont pas obliges de
 * deposer en SWOGE dans le vault et avoir un compte, car c'est complique ».
 *
 * Avant : une eSIM ne s'achetait que par l'agent SwogeAgentic, paye en $SWOGE
 * du vault, marge 5 % (0,10 $ sur un forfait a 2 $). Ici : une page, un pays,
 * un forfait, une signature USDC depuis son portefeuille (Base ou Solana, le
 * paiement x402 deja en ligne), et le QR. Marge ESIM_MARGE (1,25 par defaut,
 * choix du proprietaire le 28/09). Releve du meme soir pour la France :
 * Airalo et Holafly n'affichent que de l'illimite, 23,50 $ et 27,50 $ pour 7
 * jours ; CHIPS 1 Go 7 jours ~1,40 $, donc ~1,75 $ ici.
 *
 * L'ordre, celui de x402.paie : le paiement est VERIFIE, puis l'eSIM achetee
 * chez CHIPS (portefeuille de l'agent), puis le paiement REGLE. Une eSIM qui
 * n'a pas pu etre achetee : rien n'est regle, le payeur ne paie rien. L'inverse
 * (eSIM achetee, reglement rate) est une perte de la maison, bornee par les
 * plafonds d'achats.js (15 $ par achat, 30 $ par payeur et 60 $ par jour).
 *
 * Le code d'activation n'est rendu qu'a celui qui tient le lien secret (128
 * bits) rendu avec l'achat : pas de compte, pas de session.
 * ================================================================== */
const crypto = require('crypto');

const MARGE_DEFAUT = 1.25;
const marge = () => { const v = Number(process.env.ESIM_MARGE); return v >= 1 ? v : MARGE_DEFAUT; };
const arrondi = (x) => Math.round(x * 100) / 100;          /* le prix affiche, au cent */

/**
 * deps : { achats (achats.cree), x402 () → l'instance x402 ou null, url (l'URL publique de /esim/buy) }
 */
function cree(deps) {
  const DEVIS = new Map();                                 /* plan → le prix CHIPS retenu au devis */
  const MESURE = { recherches: 0, devis: 0, achats: 0, refus: 0 };
  const actif = () => !!(deps.achats && deps.achats.actif() && deps.x402 && deps.x402());

  /** Le prix x402 d'un achat (appele par x402.prix, synchrone) : le prix CHIPS connu × la marge. */
  function prixUsd(args) {
    const plan = String((args && args.plan) || '');
    const u = deps.achats.prixConnu(plan);
    if (!(u > 0)) return null;
    DEVIS.set(plan, u);
    return arrondi(u * marge());
  }

  /** Les forfaits d'un pays, au prix de la boutique. Rien n'est paye. */
  async function plans(a) {
    MESURE.recherches++;
    if (!actif()) return { ok: false, raison: 'the eSIM shop is closed right now' };
    const r = await deps.achats.forfaits({ pays: a && a.country, go: a && a.min_gb, jours: a && a.min_days });
    if (!r || !r.ok) return { ok: false, raison: (r && r.raison) || 'the eSIM shop did not answer - try again' };
    return { ok: true, destination: r.destination.nom, otherDestinations: r.destination.autres,
      plans: r.forfaits.map((f) => ({ plan: f.plan, name: f.nom, gb: f.go, days: f.jours, priceUsd: arrondi(f.usd * marge()) })),
      unavailable: r.horsFonds || 0, terms: r.conditions, compatibility: r.compatibles,
      note: 'Data only (no phone number). Paid in USDC from your wallet on Base or Solana; you are charged only if the eSIM is bought.' };
  }

  /** L'achat : le 402, puis, paiement verifie, l'eSIM, puis le reglement (x402.traite). */
  async function achete({ entete, plan, qui }) {
    const x = deps.x402 && deps.x402();
    if (!actif() || !x) return { status: 503, entetes: { 'content-type': 'application/json' }, corps: JSON.stringify({ ok: false, raison: 'the eSIM shop is closed right now' }) };
    const slug = String(plan || '').trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) return { status: 400, entetes: { 'content-type': 'application/json' }, corps: JSON.stringify({ ok: false, raison: 'plan must be a plan id from /esim/plans' }) };
    if (!entete && !(deps.achats.prixConnu(slug) > 0)) return { status: 409, entetes: { 'content-type': 'application/json' }, corps: JSON.stringify({ ok: false, raison: 'search the country again: this plan has no current price' }) };
    if (!entete) MESURE.devis++;
    const sert = async (payeur) => {
      const lien = crypto.randomBytes(16).toString('hex');
      const P = deps.achats.pour('wallet:' + String(payeur || '').toLowerCase(), { reserve: async () => ({ ok: true, jeton: 0 }), regle: async () => {} }, { marge: marge(), lien });
      const o = await P.propose({ plan: slug });
      if (!o || !o.ok) { MESURE.refus++; return { ok: false, code: 400, raison: (o && o.raison) || 'this eSIM cannot be bought right now' }; }
      /* Le prix CHIPS relu a l'offre ne doit pas depasser celui du devis que le payeur a signe (+1 %). */
      const devise = DEVIS.get(slug);
      if (devise && o.offre.usd > devise * 1.01 + 1e-9) { MESURE.refus++; return { ok: false, code: 400, raison: 'the price changed since your quote - search again, nothing was charged' }; }
      const c = await P.confirme(o.offre.id);
      if (!c || !c.ok) { MESURE.refus++; return { ok: false, raison: (c && c.raison) || 'the eSIM could not be bought - nothing was charged' }; }
      MESURE.achats++;
      return { ok: true, achat: c.achat, delivered: !!c.livree, orderLink: lien,
        texte: 'eSIM bought: ' + c.achat.nom + '. Keep your order link: it is the only way to see your activation code again.' };
    };
    return x.traite({ outil: 'esim', url: deps.url, entete: entete || null, sert, args: { plan: slug }, canal: 'rest', qui });
  }

  /** Le code d'activation, par le lien secret seulement. */
  async function commande(lien) { return deps.achats.parLien(lien); }

  return { plans, achete, commande, prixUsd, actif, MESURE, marge };
}

module.exports = { cree, MARGE_DEFAUT };
