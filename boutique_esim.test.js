'use strict';
/* boutique_esim.js : les forfaits au prix de la boutique (×1,25), l'achat par x402 (l'eSIM
   achetee AVANT le reglement ; rien d'achete, rien de regle), un prix qui monte refuse,
   le code d'activation par le lien secret seulement. */
const fs = require('fs');
const path = require('path');
const B = require('./boutique_esim');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

(async () => {
  let ouvert = true, prixChips = 2.0, confirmeOk = true;
  const vus = { pour: [], proposes: 0, confirmes: 0, traites: [] };
  const achats = {
    actif: () => ouvert,
    prixConnu: (slug) => (slug === 'europe-1gb-7days' ? 2.0 : null),
    forfaits: async (a) => ({ ok: true, destination: { nom: 'France', autres: ['Europe'] }, horsFonds: 1, conditions: 'https://t', compatibles: 'https://c',
      forfaits: [{ plan: 'europe-1gb-7days', nom: 'Europe 1GB', go: 1, jours: 7, usd: 2.0 }, { plan: 'fr-3gb', nom: 'France 3GB', go: 3, jours: 15, usd: 3.383 }], vu: a }),
    pour: (qui, factu, opts) => {
      vus.pour.push({ qui, opts });
      return {
        propose: async ({ plan }) => { vus.proposes++; return { ok: true, offre: { id: 'o1', plan, usd: prixChips, factureUsd: prixChips * opts.marge } }; },
        confirme: async () => { vus.confirmes++; return confirmeOk ? { ok: true, livree: true, achat: { nom: 'Europe 1GB', activation: { uri: 'LPA:1$x$y' } } } : { ok: false, raison: 'the eSIM shop answered HTTP 503 - you were not charged' }; },
      };
    },
    parLien: async (l) => (l === 'a'.repeat(32) ? { ok: true, achat: { activation: { uri: 'LPA:1$x$y' } } } : { ok: false, raison: 'unknown order link' }),
  };
  /* Un faux x402 : sans en-tete, le 402 ; avec, le paiement « verifie » puis sert(payeur) ; regle seulement si sert reussit. */
  const x402 = { traite: async (o) => {
    vus.traites.push(o);
    if (!o.entete) return { status: 402, entetes: {}, corps: JSON.stringify({ ok: false, accepts: [] }) };
    const r = await o.sert('0xPAYEUR');
    if (!r.ok) return { status: r.code === 400 ? 400 : 502, entetes: {}, corps: JSON.stringify({ ok: false, raison: r.raison, paye: false }) };
    return { status: 200, entetes: { 'payment-response': 'x' }, corps: JSON.stringify(r) };
  } };
  const S = B.cree({ achats, x402: () => x402, url: 'https://srv/esim/buy' });

  console.log('\n-- les forfaits, au prix de la boutique --');
  const p = await S.plans({ country: 'france' });
  ok(p.ok && p.plans[0].priceUsd === 2.5 && p.plans[1].priceUsd === 4.23 && p.unavailable === 1 && /you are charged only if the eSIM is bought/.test(p.note),
     'CHIPS × 1,25, au cent (2 $ → 2,50 $ ; 3,383 $ → 4,23 $), les forfaits impayables comptes');
  ok(B.MARGE_DEFAUT === 1.25 && S.marge() === 1.25, 'la marge choisie par le proprietaire le 28/09 : 25 %');
  process.env.ESIM_MARGE = '1.4'; ok(S.marge() === 1.4, 'ESIM_MARGE la change sans deploiement'); delete process.env.ESIM_MARGE;
  ok(S.prixUsd({ plan: 'europe-1gb-7days' }) === 2.5 && S.prixUsd({ plan: 'inconnu' }) === null, 'le prix x402 : celui du forfait connu, rien sinon');

  console.log('\n-- acheter : le 402, puis l eSIM avant le reglement --');
  const d = await S.achete({ plan: 'europe-1gb-7days', qui: 'ip1' });
  ok(d.status === 402 && vus.traites[0].outil === 'esim' && vus.traites[0].args.plan === 'europe-1gb-7days' && vus.proposes === 0, 'sans signature : le 402, rien d achete');
  const a = await S.achete({ plan: 'europe-1gb-7days', entete: 'sig', qui: 'ip1' });
  const c = JSON.parse(a.corps);
  ok(a.status === 200 && c.ok && /^[0-9a-f]{32}$/.test(c.orderLink) && c.achat.activation, 'paye et achete : le code d activation et le lien secret');
  ok(vus.pour[0].qui === 'wallet:0xpayeur' && vus.pour[0].opts.marge === 1.25 && vus.pour[0].opts.lien === c.orderLink,
     'l achat est au nom du PAYEUR verifie (jamais d une adresse du message), a la marge de la boutique, avec son lien');
  prixChips = 2.05;
  const m = await S.achete({ plan: 'europe-1gb-7days', entete: 'sig', qui: 'ip1' });
  ok(m.status === 400 && /price changed/.test(JSON.parse(m.corps).raison) && vus.confirmes === 1, 'le prix CHIPS a monte de plus de 1 % depuis le devis : refuse AVANT d acheter, rien regle');
  prixChips = 2.0; confirmeOk = false;
  const f = await S.achete({ plan: 'europe-1gb-7days', entete: 'sig', qui: 'ip1' });
  ok(f.status === 502 && JSON.parse(f.corps).paye === false, 'CHIPS refuse : l outil echoue, x402 ne regle rien');
  confirmeOk = true;
  ok((await S.achete({ plan: '../etc', qui: 'ip1' })).status === 400 && (await S.achete({ plan: 'fr-3gb', qui: 'ip1' })).status === 409,
     'un id invalide : 400 ; un forfait sans prix courant : 409 (chercher a nouveau)');
  ouvert = false;
  ok((await S.achete({ plan: 'europe-1gb-7days', qui: 'ip1' })).status === 503 && !(await S.plans({ country: 'fr' })).ok, 'boutique fermee (ACHATS=0) : 503, rien');
  ouvert = true;

  console.log('\n-- choisir sans taper (29/09) --');
  achats.pays = async () => [{ code: 'FR', nom: 'France' }, { code: 'JP', nom: 'Japan' }];
  const dd = await S.destinations();
  ok(dd.ok && dd.countries.length === 2 && dd.countries[1].code === 'JP' && dd.countries[1].name === 'Japan' && dd.regions.includes('Europe') && dd.regions.includes('Global'),
     'les pays vendus (code, nom) et les regions que la recherche comprend');
  achats.pays = async () => { throw new Error('down'); };
  ok(!(await S.destinations()).ok, 'CHIPS muet : la liste le dit, sans inventer de pays');
  ouvert = false; ok(!(await S.destinations()).ok, 'boutique fermee : pas de liste'); ouvert = true;

  console.log('\n-- le code, par le lien seulement --');
  ok((await S.commande('a'.repeat(32))).ok && !(await S.commande('b'.repeat(32))).ok, 'le bon lien rend le code, un autre non');

  console.log('\n-- le serveur --');
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  ok(/o === 'esim' \? boutiqueEsim\(\)\.prixUsd\(a\)/.test(srv) && /path === '\/esim\/plans' \|\| path === '\/esim\/buy' \|\| path\.startsWith\('\/esim\/order\/'\)/.test(srv)
     && /'access-control-expose-headers': 'payment-required, payment-response'/.test(srv.slice(srv.indexOf("path === '/esim/plans' ||"))),
     'routes /esim, prix x402 par la boutique, en-tetes de paiement lisibles par la page');
  ok(/RECHERCHES_ESIM/.test(srv) && /l\.length >= 20/.test(srv), 'la recherche est bornee par IP (chaque recherche sonde CHIPS)');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
