'use strict';
/*
 * SE FAIRE TROUVER (decouverte.js) — ce que lisent les annuaires d'agents,
 * d'après les spécifications relues le 26 septembre 2026 :
 *   1. /openapi.json : OpenAPI 3.1, info.x-guidance, x-payment-info en $
 *      DÉCIMAUX (pas en unités atomiques), un outil par chemin avec son schéma ;
 *   1 bis. les SCHÉMAS DE SORTIE (audit AgentCash : 16 erreurs, presque toutes
 *      « Output schema is missing ») : un schéma et un exemple par outil, l'exemple
 *      valide son schéma, et la sortie des VRAIS outils aussi — dans les deux
 *      sens : aucun champ requis inventé, aucun champ rendu sans description ;
 *   1 ter. les prix : le prix x402 réel du moment, un intervalle seulement quand
 *      la demande le fait varier (images) — plus jamais « dix fois le gaz » ;
 *      étiquettes, contact, logo, mode d'authentification lisible ;
 *   2. la preuve de propriété : une signature EIP-191 de l'origine NUE par la
 *      trésorerie — une fausse, une autre origine, un autre signataire sont écartés ;
 *   3. /.well-known/x402 : { version 1, x402Version 2, resources, ownershipProofs,
 *      instructions } — seulement des champs que la spécification définit
 *      (plus name/description/docs, déjà là) ;
 *   3 bis. l'extension `bazaar` d'un 402 (x402.js, `deps.bazaar`) : pour CHAQUE
 *      outil, `info` valide son propre schéma (la règle des facilitateurs), avec
 *      un exemple d'entrée FIXE — une sonde d'annuaire n'a pas d'arguments, et
 *      les arguments d'un acheteur ne sont jamais recopiés ;
 *   4. la fiche du registre MCP : les contraintes du schéma server.json 2025-12-11.
 */
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const fs = require('fs'), os = require('os'), path = require('path');
const { ethers } = require('ethers');
delete process.env.TG_APPELS_VENTE;   /* le defaut : telegram_calls pas vendu */
process.env.STUDIO_MARGE = '1.5';
delete process.env.AGENTIC_PRIX;
const D = require('./decouverte');
const A = require('./agentic');

/* ---- UN VALIDATEUR MINUSCULE (JSON Schema, le sous-ensemble utilise ici) ----
 * type (y compris 'null' et 'integer', seul ou en liste), properties, required,
 * items, enum, const, anyOf, additionalProperties: false, minimum, maximum
 * (les bornes des schemas d'entree, ex. new_launches.limit). `strict` : un champ
 * rendu que le schema ne decrit pas est une erreur (la sortie reelle ne doit
 * rien porter d'invisible). Rend la liste des erreurs, avec leur chemin. */
let DOC = null;   /* le document ou se resolvent les $ref (#/components/schemas/…) */
function valide(sc, v, ch, strict, err) {
  err = err || []; ch = ch || '$';
  if (!sc || typeof sc !== 'object') return err;
  if (sc.$ref) return valide(sc.$ref.slice(2).split('/').reduce((o, k) => (o || {})[k], DOC), v, ch, strict, err);
  if (sc.anyOf) {
    const bons = sc.anyOf.filter((x) => !valide(x, v, ch, strict, []).length);
    if (!bons.length) err.push(ch + ' : aucune branche de anyOf');
    return err;
  }
  const types = sc.type === undefined ? null : [].concat(sc.type);
  const typeDe = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (types) {
    const t = typeDe(v);
    const bon = types.some((y) => y === t || (y === 'integer' && t === 'number' && Number.isInteger(v)));
    if (!bon) { err.push(ch + ' : ' + t + ' au lieu de ' + types.join('|')); return err; }
  }
  if (sc.const !== undefined && v !== sc.const) err.push(ch + ' : ' + JSON.stringify(v) + ' au lieu de ' + JSON.stringify(sc.const));
  if (sc.enum && !sc.enum.includes(v)) err.push(ch + ' : ' + JSON.stringify(v) + ' hors de ' + JSON.stringify(sc.enum));
  if (typeof v === 'number' && sc.minimum !== undefined && v < sc.minimum) err.push(ch + ' : ' + v + ' sous le minimum ' + sc.minimum);
  if (typeof v === 'number' && sc.maximum !== undefined && v > sc.maximum) err.push(ch + ' : ' + v + ' au-dessus du maximum ' + sc.maximum);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of sc.required || []) if (!(k in v)) err.push(ch + '.' + k + ' : requis, absent');
    if (sc.properties) {
      for (const k of Object.keys(v)) {
        if (sc.properties[k]) valide(sc.properties[k], v[k], ch + '.' + k, strict, err);
        else if (strict || sc.additionalProperties === false) err.push(ch + '.' + k + ' : rendu mais non decrit');
      }
    }
  }
  if (Array.isArray(v) && sc.items) v.forEach((x, i) => valide(sc.items, x, ch + '[' + i + ']', strict, err));
  return err;
}

(async () => {
  const BASE = 'https://api.example.dog';
  const tresor = ethers.Wallet.createRandom();
  const outils = A.definitions({ recherche: true });
  const x402 = { actif: true, network: 'eip155:4663', payTo: tresor.address, minimumUsd: 0.02,
    assets: [{ symbol: 'USDG', asset: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', assetTransferMethod: 'eip3009', name: 'Global Dollar', version: '1' },
      { symbol: 'SWOGE', asset: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', assetTransferMethod: 'permit2', name: 'Swole Doge', version: '1' }] };
  /* Le prix x402 tel que x402.prix le calcule : prix de l'outil + gaz, au moins 0,02 $ —
     le gaz du releve en direct du 26 septembre 2026 (0,014291 $). */
  const GAZ = 0.014291;
  const prixFaux = async (nom, args) => { const u = A.prixX402Usd(nom, args); return u > 0 ? { usd: Math.max(0.02, Math.round((u + GAZ) * 1e6) / 1e6), gazUsd: GAZ } : null; };
  const payables = outils.map((o) => o.name).filter((nom) => nom === 'generate_image' || (A.prixX402Usd(nom) > 0));
  const prixX402 = await D.prixX402Annonces({ noms: payables, prix: prixFaux, base: A.prixX402Usd, minUsd: 0.02 });
  /* Le catalogue, pour le prix par cle (comme la route) : un cours du jour. */
  const cat = await A.cree({ cles: {}, solde: {}, outils: {}, cours: async () => 0.00002493, actifs: () => ({ recherche: true }) }).catalogue();

  console.log('-- 1. /openapi.json --');
  const doc = D.openapi({ base: BASE, outils: cat.outils, x402, prixX402, cours: 0.00002493, preuves: [], page: 'https://site/swogeagentic.html', docs: 'https://site/docs' });
  DOC = doc;
  ok(doc.openapi === '3.1.0' && doc.info.title && doc.info.version && doc.info['x-guidance'] && doc.paths, 'les champs obligatoires : openapi, info.title, info.version, info.x-guidance, paths');
  ok(/PAYMENT-SIGNATURE/.test(doc.info['x-guidance']) && /SAME arguments/.test(doc.info['x-guidance']) && /USDG via eip3009/.test(doc.info['x-guidance']), 'x-guidance dit comment payer, avec quels jetons, et de garder les memes arguments');
  ok(doc.info['x-guidance'].length < 4000, 'x-guidance sous les ~4 000 caracteres que la decouverte injecte telle quelle (' + doc.info['x-guidance'].length + ')');
  eq(doc.servers[0].url, BASE, 'servers : l adresse de l API');
  ok(outils.every((o) => doc.paths['/agentic/call/' + o.name] && doc.paths['/agentic/call/' + o.name].post), 'chaque outil du catalogue a son chemin (' + outils.length + ')');
  const st = doc.paths['/agentic/call/scan_token'].post;
  ok(st.requestBody.content['application/json'].schema.properties.arguments.properties.address && st.requestBody.content['application/json'].schema.required.includes('arguments'),
     'le corps : `arguments` avec le schema d entree de l outil');
  ok(JSON.stringify(st['x-payment-info'].protocols) === '[{"x402":{}}]' && st['x-payment-info'].price.currency === 'USD' && /^\d+\.\d{6}$/.test(st['x-payment-info'].price.amount),
     'x-payment-info : protocole x402, prix en DOLLARS decimaux a 6 chiffres (' + st['x-payment-info'].price.amount + ')');
  ok(!doc.paths['/agentic/call/ask_agent'].post['x-payment-info'] && !doc.paths['/agentic/call/generate_video'].post['x-payment-info'], 'agent et video : pas de x-payment-info (cle seulement)');
  ok(st.responses['402'] && st.security.some((x) => !Object.keys(x).length), 'le 402 est documente, et l appel sans cle est permis pour un outil payable');
  ok(/Powered by Go\+ Security, https:\/\/gopluslabs\.io/.test(st.summary) && /Powered by Go\+ Security/.test(st.description),
     'scan_token : « Powered by Go+ Security » et son lien dans le resume ET la description (licence GoPlus)');
  ok(!doc.paths['/agentic/call/telegram_calls'], 'sans TG_APPELS_VENTE=1 : aucun chemin telegram_calls (conditions de Telegram)');
  ok(!D.openapi({ base: BASE, outils, x402: null, prixX402: {} }).paths['/agentic/x402'] && !/PAYMENT-SIGNATURE/.test(D.openapi({ base: BASE, outils, x402: null, prixX402: {} }).info['x-guidance']),
     'x402 eteint : l OpenAPI ne promet aucun paiement sans cle');

  console.log('\n-- 1 bis. les schemas de sortie, et un exemple par outil --');
  const chemins = Object.keys(doc.paths).filter((p) => p.startsWith('/agentic/call/'));
  const sans200 = chemins.filter((p) => { const c = ((doc.paths[p].post.responses['200'] || {}).content || {})['application/json']; return !c || !c.schema || !c.schema.properties || !c.schema.properties.resultat || !c.schema.properties.resultat.properties; });
  ok(!sans200.length, 'chaque chemin d outil (' + chemins.length + ') a un schema 200 qui decrit `resultat` champ par champ' + (sans200.length ? ' — manque : ' + sans200.join(', ') : ''));
  const sans402 = chemins.filter((p) => { const c = ((doc.paths[p].post.responses['402'] || {}).content || {})['application/json']; return !c || !c.schema; });
  ok(!sans402.length, 'et un 402 decrit, avec son schema' + (sans402.length ? ' — manque : ' + sans402.join(', ') : ''));
  for (const p of chemins) {
    const r2 = doc.paths[p].post.responses['200'].content['application/json'];
    const e = valide(r2.schema, r2.example, '$', true);
    ok(!e.length, p.slice('/agentic/call/'.length) + ' : l exemple 200 valide son schema, sans champ non decrit' + (e.length ? ' — ' + e.slice(0, 3).join(' ; ') : ''));
  }
  const d402 = st.responses['402'].content['application/json'];
  const e402 = valide(d402.schema, d402.example, '$', false);
  ok(!e402.length && d402.example.accepts[0].amount === String(Math.round(prixX402.scan_token.min * 1e6)) && d402.example.accepts[0].extra.assetTransferMethod === 'eip3009'
     && d402.example.accepts[1].extra.assetTransferMethod === 'permit2' && st.responses['402'].headers['PAYMENT-REQUIRED'],
     'le 402 de scan_token : le defi x402 v2 en exemple (USDG en unites atomiques, puis $SWOGE), et l en-tete PAYMENT-REQUIRED' + (e402.length ? ' — ' + e402.join(' ; ') : ''));
  ok(doc.paths['/agentic/call/ask_agent'].post.responses['402'].content['application/json'].schema.$ref === '#/components/schemas/KeyRefusal' && doc.components.schemas.KeyRefusal === D.REFUS_CLE
     && doc.components.schemas.PaymentRequired === D.DEFI_X402, 'outil a cle seulement : son 402 est le refus de solde ou de plafond (schemas partages dans components)');
  ok(/Free with an API key/.test(doc.paths['/agentic/call/video_status'].post.description) && !/price is not known/.test(doc.paths['/agentic/call/video_status'].post.description),
     'video_status : gratuit, et rien ne pretend que son prix est inconnu');

  /* ---- LA SORTIE DES VRAIS OUTILS ----
   * Les outils de studio_agent sur de fausses sources (formes des vraies), passes
   * par agentic comme le fait la route : sans cle (x402) et par cle. */
  const Agent = require('./studio_agent'), Jeton = require('./studio_jeton'), K = require('./agentic_cles');
  const ADR = '0x254afb9fd36789bea39fb5656ba6fdb827be8dc5';
  const fiche = { adresse: ADR, marche: { chaine: 'robinhood', sym: 'LOBSTER', nom: 'Lobster', dex: 'uniswap', piscines: 1, prixUsd: 0.000008424, liqUsd: 8803.04, mcUsd: 8253,
    vol24Usd: 1204.7, var1h: 0.4, var24h: -3.1, achats24: 12, ventes24: 9, ageJours: 6.5, chaines: ['robinhood'], url: 'https://dexscreener.com/robinhood/0x66604bdc' },
    securite: { couverte: true, connu: false }, manque: [],
    colonie: { observations: 147292, echeance: 30, scan: 'https://swoleeswoge.dog/swoge_scan.html?t=' + ADR, faits: [],
      cases: [{ trait: 'octEmit', case: 'code : sans emission', n: 2395, moyenne: 16.9, assez: true }, { trait: 'octListe', case: 'code : sans liste noire', n: 2398, moyenne: 16.9, assez: true },
        { trait: 'mc', case: 'mc <10k', n: 32821, moyenne: -4.3, assez: true }] } };
  const vue = { tours: 14949, tresor: 3174.6, depart: 1000, dernierTour: Date.now(),
    positions: [{ sym: 'TELEPAD', adr: '0x7d1c', ouverteDepuis: 780000, latent: 25.7, mise: 94.97, mcAchat: 39078 }],
    signaux: [{ k: 'achat', sym: 'TELEPAD', adr: '0x7d1c', mc: 40325, t: Date.now() }, { k: 'vente', sym: 'NOIR', adr: '0x5b3e', mc: 21400, r: -22.2, comment: 'Duration reached', t: Date.now() }],
    carnet: { tout: { n: 285, moyenne: 1.9, partGagnantes: 47 } }, reel: { n: 272, moyenne: -3.5 },
    candidats: [{ sym: 'NEW', addr: '0x9f2e', minutes: 1, liq: 8000, mc: 9000, ch_m5: 65, score: 48, refus: '$8000 pool: below the buy floor ($13000)', origine: 'pools' }],
    surveillance: [{ sym: 'TALIS', addr: '0x3c4d', vu: 29, liq: 53366, verdict: 'too old (819 min): watched only, never bought' }] };
  const eco = { ok: true, frais: true, lu: Date.now(), jeton: '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817', chaine: 4663, adresseBrulage: '0x000000000000000000000000000000000000dEaD',
    coffreAdresse: '0x5593c8141303D14999Df7aa03dd3d3a6d4335fAb', offre: 1e9, brule: 13389118.44, brulePct: 1.34, coffre: 15155373.09, coffrePct: 1.52, stakingAprPct: 100, stakingPlafond: 2e8 };
  const src = { recherche: true, Jeton, fiche: async () => fiche, vue: () => vue, economie: async () => eco, cours: async () => 0.00002493,
    cherche: async () => [{ url: 'https://news.example/a', titre: 'News', extrait: 'x', date: null }], contexteRecherche: (r) => 'RESULTS ' + r.length,
    detecte: (x) => (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x) ? { type: 'domaine', valeur: x } : null),
    osint: async (type, valeur) => ({ cible: { type, valeur }, faits: [{ predicat: 'A', valeur: '93.184.215.14', sources: ['dns.google'] }], constats: [{ etiquette: 'NOTE', dit: 'Hosted on a CDN.' }] }),
    liensScan: (a) => ({ card: BASE + '/scan/carte/' + a + '.png', share: BASE + '/s/' + a, page: 'https://swoleeswoge.dog/swoge_scan.html?t=' + a }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decouv-'));
  const cles = K.cree({ fichier: path.join(dir, 'cles.json') });
  const cle = cles.resout(cles.nouvelle('0x' + 'ab'.repeat(20), 'essai', 1e6).cle);
  const solde = { reserve: () => true, regle: () => '248393.51' };
  const api = A.cree({ cles, cours: async () => 0.00002493, solde, outils: Agent.outils(src), actifs: () => ({ recherche: true }),
    agent: async () => ({ ok: true, texte: 'Answer.', sources: [{ url: 'https://a.example', titre: 'A' }], jetons: [], factureSwoge: '321.5', factureUsd: 0.009, solde: '999', etapes: 3 }),
    image: async () => ({ ok: true, urls: ['https://imgen.x.ai/b.png'], factureSwoge: '4284.18', factureUsd: 0.12, solde: '900', compris: null, reference: null }),
    imageHorsSolde: async () => ({ ok: true, urls: ['https://imgen.x.ai/c.png'], compris: 'SWOGE on a boat', reference: 'swoge' }),
    video: async () => ({ ok: true, id: '66f5b1c2d3e4f5a6b7c8d9e0', status: 'pending', duree: 6, resolution: '480p' }),
    etatVideo: () => ({ ok: true, id: '66f5b1c2d3e4f5a6b7c8d9e0', status: 'done', progress: 100, url: 'https://srv.example/v.mp4', duree: 6, resolution: '480p', factureSwoge: '9621.43', factureUsd: 0.24 }) });
  const ARGS = { scan_token: { address: ADR }, colony_activity: {}, swoge_economy: {}, new_launches: { limit: 5 }, wallet_intel: { address: '0x' + 'cd'.repeat(20) },
    osint_lookup: { target: 'example.com' }, web_search: { query: 'robinhood chain' }, generate_image: { prompt: 'a swole doge', count: 1 },
    ask_agent: { task: 'is LOBSTER worth a look?' }, generate_video: { prompt: 'a swole doge lifting' }, video_status: { id: '66f5b1c2d3e4f5a6b7c8d9e0' } };
  for (const o of outils) {
    const payable = !!prixX402[o.name];
    /* Ce que la route ENVOIE : du JSON (un champ `undefined` n'y existe pas). */
    const r = JSON.parse(JSON.stringify(payable
      ? Object.assign({}, await api.sertSansFacture({ outil: o.name, args: ARGS[o.name], payeur: '0x' + '9'.repeat(40) }),
        { x402: { transaction: '0x' + 'ab'.repeat(32), network: 'eip155:4663', amount: '24291', asset: x402.assets[0].asset } })
      : await api.appelle({ cle, outil: o.name, args: ARGS[o.name] })));
    const sc = doc.paths['/agentic/call/' + o.name].post.responses['200'].content['application/json'].schema;
    const eR = valide(sc.properties.resultat, r.resultat, '$.resultat', true);
    const eE = valide(sc, r, '$', false);
    ok(r.ok && !eR.length && !eE.length, o.name + ' (' + (payable ? 'x402' : 'cle') + ') : la VRAIE sortie valide le schema publie, sans champ cache'
      + (!r.ok ? ' — ' + r.raison : '') + (eR.length || eE.length ? ' — ' + eR.concat(eE).slice(0, 3).join(' ; ') : ''));
  }
  /* Le devis (sans cle depuis le 26 septembre 2026) : meme enveloppe, champs de devis decrits. */
  for (const [nom, q] of [['scan_token', { cle, outil: 'scan_token', args: {}, devis: true }], ['ask_agent', { cle: null, outil: 'ask_agent', args: {}, devis: true, qui: 'essai' }]]) {
    const dq = JSON.parse(JSON.stringify(await api.appelle(q)));
    const sc = doc.paths['/agentic/call/' + nom].post.responses['200'].content['application/json'].schema;
    const e = valide(sc, dq, '$', true);
    ok(dq.ok && !e.length, nom + ' : le devis' + (q.cle ? ' par cle' : ' sans cle') + ' valide le schema 200, chaque champ decrit' + (!dq.ok ? ' — ' + dq.raison : '') + (e.length ? ' — ' + e.slice(0, 3).join(' ; ') : ''));
  }
  const rs = await api.sertSansFacture({ outil: 'scan_token', args: { address: ADR }, payeur: '0x' + '9'.repeat(40) });
  ok(rs.resultat.token.links && rs.resultat.token.links.card === BASE + '/scan/carte/' + ADR + '.png' && rs.resultat.token.colonie.cases[0].trait === 'Contract bytecode',
     'scan_token vendu : les liens de la carte, et les cases de la colonie en anglais');

  console.log('\n-- 1 ter. les prix, les etiquettes, le contact --');
  const cle1 = (nom) => (cat.outils.find((o) => o.name === nom).prix || {}).usd;
  ok(payables.filter((nom) => nom !== 'generate_image').every((nom) => prixX402[nom].min === prixX402[nom].max
     && Math.abs(prixX402[nom].min - Math.max(0.02, cle1(nom) + GAZ)) < 2e-6 && doc.paths['/agentic/call/' + nom].post['x-payment-info'].price.mode === 'fixed'),
     'un prix FIXE pour chaque outil a prix fixe : le prix x402 du moment, max(0,02 $ ; prix + gaz) — scan_token ' + usdP(prixX402.scan_token.min));
  const im = doc.paths['/agentic/call/generate_image'].post['x-payment-info'].price;
  const bases = D.OPTIONS_IMAGE.map((a) => A.prixX402Usd('generate_image', a));
  ok(im.mode === 'dynamic' && Math.abs(Number(im.min) - (Math.min(...bases) + GAZ)) < 2e-6 && Math.abs(Number(im.max) - (Math.max(...bases) + GAZ)) < 2e-6,
     'generate_image : un intervalle, parce que la DEMANDE fait le prix — de l option la moins chere a la plus chere, gaz du moment compris (' + im.min + ' a ' + im.max + ')');
  /* La borne saine : jamais plus que le prix de l'outil (le pire cas de sa demande
     pour une image) + 0,05 $ de gaz — plus de trois fois le reglement le plus cher
     mesure sur la chaine 4663 (226 000 gaz, 0,0167 $). L'ancien maximum : 10 × le gaz. */
  const fous = Object.keys(doc.paths).filter((p) => doc.paths[p].post && doc.paths[p].post['x-payment-info']).filter((p) => {
    const nom = p.slice('/agentic/call/'.length), pr = doc.paths[p].post['x-payment-info'].price;
    const plafond = Math.max(0.02, nom === 'generate_image' ? Math.max(...bases) : A.prixX402Usd(nom)) + 0.05;
    return Number(pr.mode === 'fixed' ? pr.amount : pr.max) > plafond;
  });
  ok(!fous.length, 'aucun prix annonce au-dessus du prix de l outil + 0,05 $ de gaz' + (fous.length ? ' — ' + fous.join(', ') : ''));
  const replis = await D.prixX402Annonces({ noms: ['scan_token', 'swoge_economy'], prix: async () => null, base: A.prixX402Usd, minUsd: 0.02 });
  ok(replis.scan_token.min === 0.02 && replis.swoge_economy.min === 0.02, 'cours de l ETH inconnu : le plancher (0,02 $), jamais un prix invente');
  ok(/With an API key: \$0\.01 per call/.test(st.description) && /Without a key \(x402\): \$0\.024291 now, in USDG or \$SWOGE/.test(st.description),
     'la description dit les deux prix : par cle (0,01 $) et sans cle (x402, le prix du moment)');
  ok(/real cost, up to \$\d/.test(doc.paths['/agentic/call/ask_agent'].post.description) && /API key only/.test(doc.paths['/agentic/call/ask_agent'].post.description),
     'ask_agent : son maximum par cle, et « cle seulement »');
  const noms = doc.tags.map((t) => t.name);
  ok(['crypto', 'robinhood-chain', 'token-security', 'research', 'images'].every((t) => noms.includes(t)) && doc.tags.every((t) => t.description),
     'les etiquettes (OpenAPI `tags`) : crypto, robinhood-chain, token-security, research, images… chacune decrite');
  const orphelines = Object.values(doc.paths).map((p) => p.post || p.get).filter((op) => !op.tags || !op.tags.length || op.tags.some((t) => !noms.includes(t)));
  ok(!orphelines.length, 'chaque operation porte des etiquettes declarees en tete');
  ok(doc.info.contact && /^https:\/\//.test(doc.info.contact.url) && !doc.info.contact.email, 'info.contact : une URL ; aucune adresse e-mail sans DECOUVERTE_EMAIL');
  eq(D.openapi({ base: BASE, outils, x402, prixX402, email: 'owner@example.com' }).info.contact.email, 'owner@example.com', 'avec DECOUVERTE_EMAIL : publiee dans info.contact');
  ok(doc.info['x-logo'].url === 'https://swoleeswoge.dog/img/site/icone-192.png' && doc['x-agentcash-guidance'].llmsTxtUrl === BASE + '/llms.txt' && /sample size|observation/i.test(doc.info.description),
     'le logo (x-logo), le llms.txt (x-agentcash-guidance) et une vraie description : mesures avec effectifs');
  const site = [path.join(__dirname, '..', 'SWOGE.github.io'), path.join(__dirname, '..', 'site')].find((d) => fs.existsSync(path.join(d, 'index.html')));
  if (site) ok(fs.statSync(path.join(site, 'img', 'site', 'icone-192.png')).size > 1000, 'l icone annoncee existe dans le site (img/site/icone-192.png)');
  /* Le mode d'authentification, tel que @agentcash/discovery le deduit : il ne
     reconnait une cle que par un schema `type: "apiKey"` (le bearer `http` ne compte pas). */
  const sch = doc.components.securitySchemes;
  const cleSeule = ['ask_agent', 'generate_video', 'video_status'].every((nom) => doc.paths['/agentic/call/' + nom].post.security.some((r) => Object.keys(r).some((k) => sch[k] && sch[k].type === 'apiKey')));
  ok(cleSeule && sch.cleEnTete.in === 'header' && sch.cleEnTete.name === 'X-API-Key', 'les outils a cle seulement declarent un schema apiKey (X-API-Key, lu par le serveur) : plus « missing auth mode »');
  ok(Object.values(doc.paths).every((p) => Array.isArray((p.post || p.get).security)), 'chaque operation declare sa securite (security: [] pour le catalogue public)');

  console.log('\n-- 2. la preuve de propriete --');
  const orig = D.origine(BASE + '/agentic/call/scan_token?x=1');
  eq(orig, BASE, 'l origine NUE : sans chemin, sans barre finale');
  const bonne = await tresor.signMessage(BASE);
  const autreOrigine = await tresor.signMessage(BASE + '/');
  const autreSignataire = await ethers.Wallet.createRandom().signMessage(BASE);
  const v = D.preuvesValides([bonne, autreOrigine, autreSignataire, '0xdeadbeef', ''].join(','), orig, tresor.address);
  ok(v.length === 1 && v[0] === bonne, 'seule la signature de l origine par la TRESORERIE est gardee (autre origine, autre signataire, charabia : ecartes)');
  eq(D.preuvesValides(undefined, orig, tresor.address).length, 0, 'sans X402_PREUVE : aucune preuve (rien d invente)');
  const avec = D.openapi({ base: BASE, outils, x402, prixX402, preuves: v });
  eq(JSON.stringify(avec['x-discovery']), JSON.stringify({ ownershipProofs: [bonne] }), 'l OpenAPI porte x-discovery.ownershipProofs quand la preuve est juste');
  eq(JSON.stringify(avec['x-agentcash-provenance']), JSON.stringify({ ownershipProofs: [bonne] }), 'et x-agentcash-provenance.ownershipProofs, que @agentcash/discovery lit en premier');
  ok(!('x-discovery' in doc) && !('x-agentcash-provenance' in doc), 'sans preuve : ni l un ni l autre');

  console.log('\n-- 3. /.well-known/x402 --');
  const m = D.manifeste({ base: BASE, x402, prixX402, preuves: v, docs: 'https://site/docs' });
  ok(m.version === 1 && m.x402Version === 2 && Array.isArray(m.resources), 'la forme lue par x402scan : version 1, x402Version 2, resources');
  eq(m.resources.join(','), payables.map((nom) => BASE + '/agentic/call/' + nom).join(','), 'les ressources : les outils payables d avance, en URL absolues');
  ok(m.ownershipProofs[0] === bonne && !('ownershipProofs' in D.manifeste({ base: BASE, prixX402, preuves: [] })), 'la preuve y est quand elle existe, absente sinon');
  const permis = ['version', 'x402Version', 'name', 'description', 'resources', 'ownershipProofs', 'instructions', 'docs'];
  ok(Object.keys(m).every((k) => permis.includes(k)), 'aucun champ que la spec x402scan ne definit (hors name/description/docs, deja la) : ' + Object.keys(m).join(', '));
  ok(/Robinhood Chain/.test(m.description) && /sample size/.test(m.description) && /observations/.test(m.instructions) && /402/.test(m.instructions) && /PAYMENT-SIGNATURE/.test(m.instructions)
     && m.instructions.includes(BASE + '/openapi.json') && /USDG via eip3009/.test(m.instructions),
     'description et `instructions` : ce qu est le service (Robinhood Chain, mesures avec effectifs), comment payer, ou sont schemas et etiquettes');
  ok(!/\b(safe|rug)\b/i.test(JSON.stringify(m) + JSON.stringify(doc.info)), 'nulle part « safe » ni « rug »');

  console.log('\n-- 3 bis. l extension bazaar d un 402 (x402.js, deps.bazaar) --');
  const bz = D.bazaar('scan_token', outils.find((o) => o.name === 'scan_token'));
  const eBz = valide(bz.schema, bz.info, '$', false);
  ok(!eBz.length && bz.info.input.type === 'http' && bz.info.input.method === 'POST' && bz.info.input.bodyType === 'json' && bz.info.output.type === 'json',
     'info valide son propre schema (la regle des facilitateurs), entree POST json' + (eBz.length ? ' — ' + eBz.join(' ; ') : ''));
  ok(bz.schema.properties.input.properties.body.properties.arguments.properties.address && bz.schema.properties.output.properties.example.properties.resultat.properties.token,
     'la ou @agentcash/discovery les lit : le schema d entree (input.properties.body) et de sortie (output.properties.example)');
  /* Pour CHAQUE outil (telegram_calls compris, vendu avec TG_APPELS_VENTE=1) :
     info valide son schema. Un annuaire sonde SANS arguments : avec l'ancien
     exemple (les arguments de la requete, {} pour une sonde), 9 outils sur 12
     echouaient (scan_token sur address, generate_image sur prompt…). */
  process.env.TG_APPELS_VENTE = '1';
  const tous = require('./agentic').definitions({ recherche: true });
  delete process.env.TG_APPELS_VENTE;
  ok(tous.length === 12 && tous.every((o) => D.EXEMPLES_ENTREE[o.name]), 'un exemple d entree fixe pour chacun des ' + tous.length + ' outils'
     + (tous.filter((o) => !D.EXEMPLES_ENTREE[o.name]).length ? ' — manque : ' + tous.filter((o) => !D.EXEMPLES_ENTREE[o.name]).map((o) => o.name).join(', ') : ''));
  for (const o of tous) {
    const b = D.bazaar(o.name, o);
    const e = valide(b.schema, b.info, '$', false).concat(valide(o.inputSchema, b.info.input.body.arguments, '$.arguments', false));
    const inv = A.entreeInvalide(o.name, b.info.input.body.arguments);
    ok(!e.length && !inv, o.name + ' : info valide son schema, et l exemple passe la validation du serveur' + (e.length ? ' — ' + e.slice(0, 3).join(' ; ') : '') + (inv ? ' — ' + inv : ''));
  }
  /* Les arguments d'un acheteur ne voyagent jamais dans le 402 : un facilitateur
     peut publier `info` dans un catalogue public. */
  const acheteur = '0x' + 'ee'.repeat(20);
  const bzA = D.bazaar('scan_token', outils.find((o) => o.name === 'scan_token'), { address: acheteur });
  ok(JSON.stringify(bzA) === JSON.stringify(bz) && !JSON.stringify(bzA).includes(acheteur), 'l exemple est fixe : l adresse d un acheteur n est jamais recopiee dans l extension');

  console.log('\n-- 4. la fiche du registre MCP (server.json) --');
  const f = D.ficheMcp({ nom: 'dog.swoleeswoge/swogeagentic', base: BASE });
  ok(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(f.name) && f.name.length <= 200, 'name : forme reverse-DNS avec une seule barre (motif du schema)');
  ok(f.description.length >= 1 && f.description.length <= 100 && f.title.length <= 100, 'description ≤ 100 caracteres (' + f.description.length + '), title ≤ 100');
  ok(f.name && f.description && f.version && f.$schema === 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json', 'les champs requis (name, description, version) et le schema 2025-12-11');
  const r = f.remotes[0];
  /* Depuis le devis sans cle (26 septembre 2026) : tools/list et les devis marchent
     sans cle — l'en-tete reste secret, mais n'est plus « requis », et le dit. */
  ok(r.type === 'streamable-http' && r.url === BASE + '/mcp' && r.headers[0].name === 'Authorization' && r.headers[0].isSecret === true
     && r.headers[0].isRequired === false && /without a key/.test(r.headers[0].description),
     'remote streamable-http sur /mcp, en-tete Authorization secret ; facultatif, et la description dit ce qui marche sans');

  /* La fiche publiee dans le depot (celle que `mcp-publisher publish` lit) ne vieillit pas en silence. */
  const depot = JSON.parse(fs.readFileSync(path.join(__dirname, 'server.json'), 'utf8'));
  eq(JSON.stringify(depot), JSON.stringify(D.ficheMcp({ nom: 'dog.swoleeswoge/swogeagentic', base: 'https://web-production-220a3.up.railway.app' })),
     'server.json du depot = la fiche generee (sinon : la regenerer avec decouverte.ficheMcp)');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });

function usdP(x) { return '$' + Number(x).toFixed(6); }
