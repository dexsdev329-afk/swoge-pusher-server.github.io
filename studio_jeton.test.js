'use strict';
/*
 * SWOLEMIND — une adresse de jeton dans le chat, mise a l'essai contre de faux
 * DexScreener et GoPlus locaux (DEXSCREENER_BASE_URL / GOPLUS_BASE_URL), aux
 * formes relues sur les vrais services le 26 septembre 2026 :
 *   1. les adresses de la question : sans doublon, au plus deux ;
 *   2. le marche : la piscine la plus profonde, toutes chaines ; https seulement ;
 *   3. la securite : tri-etat — « GoPlus ne sait pas » n'est jamais « sur » ;
 *      les porteurs en FRACTION chez GoPlus, contrats et verrous exclus ;
 *   4. la colonie seulement sur Robinhood Chain, chaque case avec son effectif,
 *      « trop peu pour conclure » sous OBS_ASSEZ ;
 *   5. trois colonnes d'une comparaison ne lisent le jeton qu'une fois ;
 *   6. dans le chat : la fiche rejoint la question, la reserve compte ses
 *      jetons, les sources et la carte reviennent a la page ; une lecture
 *      ratee n'empeche pas de repondre.
 */
const http = require('http');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801'; process.env.STUDIO_MARGE = '1.5';
delete process.env.OPENAI_API_KEY; delete process.env.XAI_API_KEY; delete process.env.GROK_API_KEY;

const ETH = '0x6982508145454ce325ddbe47a25d4ec3d2311933';   /* PEPE, forme relue sur les vrais services */
const RH = '0x1111111111111111111111111111111111111111';
const INCONNU = '0x2222222222222222222222222222222222222222';
const SOLANA_SEUL = '0x3333333333333333333333333333333333333333';
const PANNE = '0x5555555555555555555555555555555555555555';

(async () => {
  const vus = [];
  const faux = http.createServer((q, r) => {
    vus.push(q.url);
    const rend = (j, code) => { r.writeHead(code || 200, { 'content-type': 'application/json' }); r.end(JSON.stringify(j)); };
    const m = q.url.match(/^\/latest\/dex\/tokens\/(0x[0-9a-f]{40})$/);
    if (m) {
      const a = m[1];
      if (a === ETH) return rend({ schemaVersion: '1.0.0', pairs: [
        { chainId: 'ethereum', dexId: 'uniswap', url: 'https://dexscreener.com/ethereum/0xpetite', baseToken: { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', name: 'Pepe' },
          priceUsd: '0.000004429', liquidity: { usd: 1000 }, fdv: 1, volume: { h24: 1 }, priceChange: {}, txns: { h24: { buys: 1, sells: 1 } } },
        { chainId: 'ethereum', dexId: 'uniswap', url: 'https://dexscreener.com/ethereum/0xprofonde', baseToken: { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', name: 'Pepe' },
          priceUsd: '0.000004431', liquidity: { usd: 25000000 }, fdv: 1860000000, marketCap: 1860000000, volume: { h24: 9100000 },
          priceChange: { h1: -0.4, h24: 3.2 }, txns: { h24: { buys: 1200, sells: 900 } }, pairCreatedAt: Date.now() - 900 * 864e5 },
        /* Une piscine ou PEPE est la monnaie d'echange, pas le jeton : elle ne compte pas. */
        { chainId: 'bsc', dexId: 'pancakeswap', url: 'https://dexscreener.com/bsc/0xautre', baseToken: { address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', symbol: 'X' },
          quoteToken: { address: ETH }, priceUsd: '9', liquidity: { usd: 99000000 } }] });
      if (a === RH) return rend({ pairs: [{ chainId: 'robinhood', dexId: 'swogeswap', url: 'javascript:alert(1)', baseToken: { address: RH, symbol: 'DOGE', name: 'Doge' },
        priceUsd: '0.0012', liquidity: { usd: 4200 }, fdv: 90000, volume: { h24: 300 }, priceChange: { h24: -12 }, txns: { h24: { buys: 4, sells: 9 } } }] });
      if (a === SOLANA_SEUL) return rend({ pairs: [{ chainId: 'zkfoo', dexId: 'foo', url: 'https://dexscreener.com/zkfoo/x', baseToken: { address: SOLANA_SEUL, symbol: 'FOO' }, priceUsd: '1', liquidity: { usd: 10 } }] });
      if (a === PANNE) return rend({}, 500);
      return rend({ schemaVersion: '1.0.0', pairs: null });   /* ce que rend le vrai service pour un jeton sans piscine */
    }
    const g = q.url.match(/^\/api\/v1\/token_security\/(\w+)\?contract_addresses=(0x[0-9a-f]{40})$/);
    if (g) {
      if (g[2] === ETH && g[1] === '1') return rend({ code: 1, message: 'OK', result: { [ETH]: {
        is_honeypot: '0', cannot_sell_all: '0', cannot_buy: '0', buy_tax: '0', sell_tax: '0.05', is_mintable: '0', transfer_pausable: '1',
        is_blacklisted: '1', is_open_source: '1', hidden_owner: '0', owner_change_balance: '0', holder_count: '593837',
        holders: [
          { address: '0xcex', tag: '', is_contract: 0, percent: '0.088302969162162680', is_locked: 0 },
          { address: '0xlock', tag: 'UNCX lock', is_contract: 0, percent: '0.30', is_locked: 1 },
          { address: '0xpool', tag: '', is_contract: 1, percent: '0.20', is_locked: 0 },
          { address: '0xdead', tag: 'Null Address', is_contract: 0, percent: '0.10', is_locked: 0 },
          { address: '0xb', tag: '', is_contract: 0, percent: '0.066055714023645453', is_locked: 0 }],
        lp_holders: [{ tag: 'burn', percent: '0.9', is_locked: 0 }, { tag: '', percent: '0.1', is_locked: 0 }] } } });
      /* Robinhood : GoPlus n'a encore rien — une fiche vide, pas des zeros. */
      if (g[1] === '4663') return rend({ code: 1, message: 'OK', result: {} });
      return rend({ code: 1, result: {} });
    }
    rend({}, 404);
  });
  await new Promise((s) => faux.listen(0, '127.0.0.1', s));
  const base = 'http://127.0.0.1:' + faux.address().port;
  process.env.DEXSCREENER_BASE_URL = base; process.env.GOPLUS_BASE_URL = base; process.env.SITE_URL = 'https://site.example';
  const J = require('./studio_jeton');
  const C = require('./studio_chat');
  const Rech = require('./studio_recherche');

  console.log('-- 1. les adresses de la question --');
  eq(J.adressesDe('check ' + ETH.toUpperCase().replace('0X', '0x') + ' and ' + ETH + ' then ' + RH + ' and ' + INCONNU).join(','), ETH + ',' + RH,
     'sans doublon (casse ignoree), au plus deux');
  eq(J.adressesDe('0x1234 is not an address, nor is 0x' + '1'.repeat(41)).length, 0, 'une adresse courte ou trop longue n est pas lue');

  console.log('\n-- 2. le marche (DexScreener) --');
  {
    const mk = await J.lisMarche(ETH);
    ok(mk.url === 'https://dexscreener.com/ethereum/0xprofonde' && mk.liqUsd === 25000000 && mk.prixUsd === 0.000004431, 'la piscine la plus PROFONDE, pas la premiere venue');
    ok(mk.piscines === 2 && mk.chaine === 'ethereum' && mk.sym === 'PEPE', 'la piscine ou le jeton n est que la monnaie d echange ne compte pas [' + mk.piscines + ']');
    ok(mk.var24h === 3.2 && mk.achats24 === 1200 && mk.ventes24 === 900 && mk.ageJours >= 899 && mk.mcUsd === 1860000000, 'variation, achats/ventes, age, capitalisation lus');
    eq((await J.lisMarche(RH)).url, null, 'une adresse de service qui n est pas https ne sort jamais');
    eq(await J.lisMarche(INCONNU), null, 'un jeton sans piscine : rien, pas des zeros');
  }

  console.log('\n-- 3. la securite (GoPlus), tri-etat --');
  {
    const s = await J.lisSecurite('ethereum', ETH);
    ok(s.connu && s.honeypot === false && s.pause === true && s.listeNoire === true && s.mint === false, 'les « 0 » et « 1 » lus comme non / oui');
    ok(s.taxeAchat === 0 && s.taxeVente === 5, 'les taxes en fraction deviennent des pourcents [' + s.taxeVente + ']');
    ok(s.premierPorteur === 8.8 && s.dixPremiers === 15.4, 'porteurs : fraction → %, verrou, contrat et adresse nulle exclus [' + s.premierPorteur + ' / ' + s.dixPremiers + ']');
    ok(s.porteurs === 593837 && s.lpVerrouillee === 90, 'nombre de porteurs, part de liquidite brulee');
    const vide = await J.lisSecurite('robinhood', RH);
    ok(vide.couverte && vide.connu === false && vide.honeypot === undefined, 'une fiche GoPlus vide : « inconnu », jamais « pas de honeypot »');
    const hors = await J.lisSecurite('zkfoo', SOLANA_SEUL);
    ok(hors.couverte === false && !vus.some((u) => /token_security\/undefined/.test(u)), 'une chaine que GoPlus ne couvre pas : aucun appel, et on le dit');
  }

  console.log('\n-- 4. la colonie, seulement sur Robinhood Chain --');
  {
    let scans = [];
    const scan = async (a) => { scans.push(a); return { cases: [
      { trait: 'deployeur', case: '4+', n: 642, moyenne: -43.7 }, { trait: 'liq', case: '<5k', n: 12, moyenne: 18.2 }],
      faits: [{ quoi: 'the contract can mint more tokens', source: 'bytecode' }], mesureSur: { observations: 48213, echeance: 30 } }; };
    J.CACHE.clear();
    const f = await J.fiche(RH, { scan });
    ok(scans.length === 1 && f.colonie.cases.length === 2 && f.colonie.observations === 48213, 'Robinhood : le scan de la colonie est lu');
    ok(f.colonie.cases[0].assez === true && f.colonie.cases[1].assez === false, 'sous ' + J.OBS_ASSEZ + ' observations, une case est marquee « trop peu »');
    eq(f.colonie.scan, 'https://site.example/swoge_scan.html?t=' + RH, 'le lien vers le scan complet');
    const fe = await J.fiche(ETH, { scan });
    ok(scans.length === 1 && fe.colonie === null, 'Ethereum : la colonie n est pas interrogee (elle ne vit que sur Robinhood Chain)');
    const lent = await J.fiche('0x4444444444444444444444444444444444444444', { scan: () => new Promise(() => {}) });
    ok(lent.marche === null && lent.manque.length === 0, 'un jeton introuvable s arrete au marche, sans attendre le reste');
    const pan = await J.fiche(PANNE, { scan });
    ok(pan.marche === null && pan.manque.join() === 'DexScreener' && /Not found on DexScreener \(the lookup failed\)/.test(J.contexte([pan])),
       'DexScreener en panne : la fiche le dit, elle ne pretend pas que le jeton n existe pas');

    const ctx = J.contexte([f, fe]);
    ok(/never a buy or sell signal/.test(ctx) && /never call a token safe/.test(ctx), 'le modele recoit la consigne : des mesures, jamais un signal, jamais « sur »');
    ok(/deployeur = 4\+: -43\.7% average over 642 observations\n/.test(ctx) && /liq = <5k: \+18\.2% average over 12 observations \(too few to conclude\)/.test(ctx),
       'chaque case avec son effectif, « too few to conclude » sous le seuil');
    ok(/GoPlus has no record of this token yet — unknown, NOT safe/.test(ctx), 'GoPlus muet : « inconnu, PAS sur »');
    ok(/transfers can be paused; has a blacklist/.test(ctx) && /largest free wallet 8\.8%/.test(ctx) && /buy\/sell tax 0%\/5%/.test(ctx), 'les drapeaux, les porteurs et les taxes, lus');
    eq(J.sources([f, fe]).map((x) => x.url).join(','), 'https://site.example/swoge_scan.html?t=' + RH + ',https://dexscreener.com/ethereum/0xprofonde',
       'les sources : le scan de la colonie, la piscine DexScreener (https seulement)');
    const c = J.carte(fe);
    ok(c.sym === 'PEPE' && c.securite === 'read' && c.alertes.join(',') === 'Pausable,Blacklist' && c.premierPorteur === 8.8, 'la carte de la page : les chiffres et les alertes, pas de verdict');
    eq(J.carte(f).securite, 'unknown', 'et elle dit quand la securite est inconnue');

    /* La fiche la plus longue qu'on sache fabriquer : toutes les alertes, six
       cases, des faits. La reserve compte JETONS_PAR_FICHE : elle doit couvrir
       un jeton pour deux caracteres (la regle de la reserve). */
    const pire = JSON.parse(JSON.stringify(fe));
    Object.assign(pire.securite, { honeypot: true, venteBloquee: true, achatBloque: true, mint: true, proxy: true, proprioCache: true,
      reprendPropriete: true, soldeModifiable: true, memeCreateurHoneypot: true, codeOuvert: false });
    pire.marche.nom = 'N'.repeat(40); pire.marche.sym = 'S'.repeat(16); pire.marche.dex = 'D'.repeat(24);
    pire.colonie = { observations: 9e6, echeance: 30, scan: f.colonie.scan, faits: Array(6).fill('the contract can mint more tokens (GoPlus)'),
      cases: Array(6).fill({ trait: 'une_case_au_nom_long', case: 'une valeur longue', n: 123456, moyenne: -99.9, assez: true }) };
    pire.manque = ['DexScreener', 'GoPlus', 'SWOGE AI colony'];
    const car = J.contexte([pire]).length;
    ok(Math.ceil(car / 2) <= J.JETONS_PAR_FICHE, 'la fiche la plus longue (' + car + ' caracteres) tient dans ' + J.JETONS_PAR_FICHE + ' jetons de reserve a 2 caracteres par jeton');
  }

  console.log('\n-- 5. trois colonnes, une seule lecture --');
  {
    J.CACHE.clear();
    const avant = vus.filter((u) => u.includes(ETH)).length;
    await Promise.all([J.fiche(ETH), J.fiche(ETH), J.fiche(ETH)]);
    eq(vus.filter((u) => u.includes(ETH)).length - avant, 2, 'une comparaison a trois : un appel DexScreener et un GoPlus, pas six');
  }

  console.log('\n-- 6. dans le chat --');
  {
    const cours = 0.00002801;
    const solde = () => { const s = { r: [] }; s.o = { reserve: (a, w) => { s.r.push({ reserve: BigInt(String(w)) }); return true; },
      regle: (a, rw, fw) => { s.r.push({ rw: BigInt(String(rw)), fw: BigInt(String(fw)) }); return '0'; } }; return s; };
    const faitRepondre = (vu) => async (p) => { vu.push(p); return { texte: 'PEPE: liquidity $25,000,000 [1].', sources: [{ url: 'https://news.example/a', titre: 'a' }],
      usage: { input_tokens: 2000, output_tokens: 300 }, stop: 'end_turn' }; };
    J.CACHE.clear();
    const vu = [], s = solde(); let etapes = 0;
    const q = 'is ' + ETH + ' a honeypot?';
    const r = await C.repond({ addr: '0xa', modele: 'sonnet-5', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: q }] },
      { cours: async () => cours, solde: s.o, actif: () => true, fournisseur: faitRepondre(vu), surJeton: () => { etapes++; },
        jetons: (a) => Promise.all(a.map((x) => J.fiche(x))) });
    const der = vu[0].messages[vu[0].messages.length - 1].content;
    ok(r.ok && der.startsWith(q + '\n\n---\nToken data read live by SwoleMind') && /PEPE/.test(der), 'la fiche rejoint la DERNIERE question, apres elle');
    eq(vu[0].messages[0].content, 'hi', 'l historique reste intact');
    eq(etapes, 1, 'la page est prevenue que le jeton est lu');
    ok(r.sources[0].url === 'https://dexscreener.com/ethereum/0xprofonde' && r.sources[1].url === 'https://news.example/a', 'les sources : la piscine d abord, puis celles du modele');
    ok(r.jetons.length === 1 && r.jetons[0].sym === 'PEPE' && r.jetons[0].alertes.includes('Blacklist'), 'la carte du jeton revient a la page');
    eq(Rech.requeteDe(vu[0].messages), q, 'la recherche web cherche la question du joueur, pas notre fiche');

    const s2 = solde(); const vu2 = [];
    await C.repond({ addr: '0xb', modele: 'sonnet-5', messages: [{ role: 'user', content: 'is PEPE a honeypot?' }] },
      { cours: async () => cours, solde: s2.o, actif: () => true, fournisseur: faitRepondre(vu2), jetons: () => { throw new Error('ne doit pas etre appele'); } });
    ok(vu2.length === 1 && vu2[0].messages[0].content === 'is PEPE a honeypot?', 'sans adresse : aucune lecture, la question part telle quelle');
    const m = C.modele('sonnet-5');
    const ecart = C.pireCasUsd(m, [{ content: q }], false, 1) - C.pireCasUsd(m, [{ content: q }], false, 0);
    ok(Math.abs(ecart - J.JETONS_PAR_FICHE * m.entree / 1e6) < 1e-12, 'la reserve compte ' + J.JETONS_PAR_FICHE + ' jetons d entree par adresse lue');
    ok(s.r[0].reserve > 0n && s.r[1].fw <= s.r[1].rw, 'facture sous la reserve');

    const vu3 = [];
    const r3 = await C.repond({ addr: '0xc', modele: 'sonnet-5', messages: [{ role: 'user', content: q }] },
      { cours: async () => cours, solde: solde().o, actif: () => true, fournisseur: faitRepondre(vu3), jetons: async () => { throw new Error('panne'); } });
    ok(r3.ok && vu3[0].messages[0].content === q && r3.jetons.length === 0, 'la lecture en panne : on repond quand meme, sans fiche');
  }

  faux.close();
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
