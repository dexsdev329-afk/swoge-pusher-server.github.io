'use strict';
/* token_verdict (verdict_jeton.js) : chaque regle, sur des fiches au format de
   studio_jeton.fiche. Le verdict n'est JAMAIS « safe », un inconnu n'est jamais
   une bonne nouvelle, et chaque signal dit sa source et sa mesure. */
const V = require('./verdict_jeton');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };
const ADR = '0x8a166fb41cd659a0a43396272ff73973ce29f817';
const marche = (o) => Object.assign({ chaine: 'robinhood', dex: 'uniswap', sym: 'SWOGE', nom: 'Swole Doge', prixUsd: 0.00002579, liqUsd: 13569, mcUsd: 25453, ageJours: 82.1,
  url: 'https://dexscreener.com/robinhood/0xabc' }, o);
const secu = (o) => Object.assign({ couverte: true, connu: true, honeypot: false, venteBloquee: false, achatBloque: false, mint: false, pause: false, listeNoire: false,
  proxy: false, codeOuvert: true, proprioCache: false, reprendPropriete: false, soldeModifiable: false, memeCreateurHoneypot: false, taxeAchat: 0, taxeVente: 0,
  porteurs: 685, premierPorteur: 3.9, dixPremiers: 11.5, lpVerrouillee: 100 }, o);
const fiche = (o) => Object.assign({ adresse: ADR, marche: marche(), securite: secu(), colonie: null, manque: [] }, o);
const codes = (v) => v.flags.map((x) => x.code);

{
  const v = V.juge(fiche());
  ok(v.verdict === 'no_red_flag_found' && v.flags.length === 0 && /not a statement that the token is safe/.test(v.summary) && !/\bsafe\b/.test(v.verdict),
     'rien ne se declenche : no_red_flag_found, et le resume dit que ce n est pas « safe »');
  ok(v.attribution && v.attribution.security === 'Powered by Go+ Security' && /Powered by Go\+ Security/.test(V.texte(v)), 'la mention GoPlus, en donnees et dans le texte');
  ok(v.token.symbol === 'SWOGE' && v.token.liquidityUsd === 13569 && /never a buy or sell signal/.test(v.note), 'le jeton et la note « jamais un signal »');
}
{
  const v = V.juge(fiche({ securite: secu({ honeypot: true, mint: true }) }));
  ok(v.verdict === 'red_flags' && codes(v).includes('honeypot') && codes(v).includes('mintable') && v.flags.find((x) => x.code === 'honeypot').level === 'red'
     && v.flags.every((x) => x.source), 'honeypot : red_flags (rouge), mint en prudence, chaque signal avec sa source');
}
for (const [k, code] of [['venteBloquee', 'cannot_sell_all'], ['achatBloque', 'cannot_buy'], ['soldeModifiable', 'owner_can_change_balance'], ['memeCreateurHoneypot', 'creator_made_honeypot']]) {
  const v = V.juge(fiche({ securite: secu({ [k]: true }) }));
  ok(v.verdict === 'red_flags' && codes(v).join() === code, code + ' : rouge');
}
{
  const v = V.juge(fiche({ securite: secu({ proprioCache: true, taxeAchat: null, taxeVente: null }) }));
  ok(v.verdict === 'caution' && codes(v).join() === 'hidden_owner,tax_unknown', 'proprietaire cache + taxe non rapportee (le releve reel de $SWOGE) : caution, pas « no red flag »');
  const t = V.juge(fiche({ securite: secu({ taxeVente: 12.5 }) }));
  ok(t.verdict === 'caution' && t.flags[0].text === 'sell tax 12.5%', 'une taxe : rendue telle quelle (aucun seuil invente)');
  const lp = V.juge(fiche({ securite: secu({ lpVerrouillee: 0 }) }));
  ok(codes(lp).join() === 'lp_not_locked', 'aucune LP verrouillee ni brulee : prudence');
}
{
  const v = V.juge(fiche({ marche: marche({ liqUsd: 8803 }) }));
  const f = v.flags[0];
  ok(v.verdict === 'caution' && f.code === 'thin_pool' && /\$8,803/.test(f.text) && /28 trades, -7\.8% average/.test(f.text), 'piscine de 8 803 $ sur Robinhood : prudence, AVEC la mesure du carnet (28 trades, -7,8 %)');
  const b = V.juge(fiche({ marche: marche({ chaine: 'base', liqUsd: 500 }) }));
  ok(b.verdict === 'no_red_flag_found', 'hors Robinhood Chain : pas de regle de piscine (la colonie ne l a mesuree que la)');
}
{
  ok(V.juge(fiche({ marche: null, securite: null })).verdict === 'unknown', 'introuvable sur DexScreener : unknown');
  ok(V.juge(fiche({ securite: null, manque: ['GoPlus'] })).verdict === 'unknown', 'GoPlus en panne : unknown (jamais « no red flag »)');
  ok(V.juge(fiche({ securite: { couverte: false } })).verdict === 'unknown' && V.juge(fiche({ securite: { couverte: true, connu: false } })).verdict === 'unknown',
     'chaine non couverte, ou jeton sans fiche GoPlus : unknown');
  ok(V.juge(fiche({ securite: null, marche: marche() , colonie: null })).attribution === null, 'sans reponse GoPlus : pas de mention GoPlus');
  const r = V.juge(fiche({ securite: { couverte: false }, marche: marche({ liqUsd: 1000 }) }));
  ok(r.verdict === 'unknown', 'inconnu l emporte sur la prudence (on ne sait pas lire le contrat)');
}
{
  const colonie = { observations: 155840, echeance: 30, scan: 'https://swoleeswoge.dog/swoge_scan.html?t=' + ADR,
    toutes: [{ trait: 'octEmit', case: 'code : sans emission', n: 2395, moyenne: 16.9 }, { trait: 'octListe', case: 'code : sans liste noire', n: 2398, moyenne: 16.9 },
      { trait: 'mc', case: 'mc <10k', n: 32821, moyenne: -4.3 }, { trait: 'age×mc', case: '2-6 h × mc <10k', n: 12, moyenne: -9.7 }] };
  const v = V.juge(fiche({ colonie }));
  const neg = v.flags.filter((x) => x.code === 'colony_negative_trait');
  ok(neg.length === 1 && /-4\.3% on average in 30 minutes, over 32,821 observations/.test(neg[0].text) && v.verdict === 'caution',
     'un trait a -4,3 % sur 32 821 observations : prudence avec son effectif ; celui a 12 observations n est PAS compte');
  ok(v.colony.observations === 155840 && v.colony.positiveTraits.length === 1 && v.colony.positiveTraits[0].observations === 2395 && v.colony.minObservations === 30,
     'les traits positifs sont rendus a part (le bytecode, une seule ligne), jamais comme une recommandation');
  ok(/not an endorsement/.test(V.texte(v)) && /QUICK VERDICT|CAUTION/.test(V.texte(v)), 'le texte : verdict en tete, les traits positifs « not an endorsement »');
}
/* L'identite (28/09) : une copie d'action tokenisee est rouge, avec l'adresse officielle. */
{
  const NV = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
  const v = V.juge(fiche({ marche: marche({ sym: 'NVDA', nom: 'NVDA', liqUsd: 30386 }), action: { imposteur: true, symbole: 'NVDA', adresse: NV } }));
  const d = v.flags.find((x) => x.code === 'impostor_stock_token');
  ok(v.verdict === 'red_flags' && d && d.level === 'red' && d.text.includes(NV) && /official stock token list/.test(d.source),
     'une copie du symbole NVDA : rouge, avec l adresse officielle et sa source');
  const o = V.juge(fiche({ marche: marche({ sym: 'NVDA', nom: 'NVIDIA Robinhood Token', liqUsd: 5169580 }), action: { officielle: true, symbole: 'NVDA', adresse: NV } }));
  ok(!o.flags.some((x) => x.code === 'impostor_stock_token') && o.verdict === 'no_red_flag_found', 'l action officielle : aucun drapeau d identite');
}
console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
process.exit(rates ? 1 : 0);
