'use strict';
/*
 * LES MODELES GRATUITS (18 octobre 2026), contre un faux OVH et un faux
 * Pollinations locaux (GRATUIT_BASE_URL, GRATUIT_POLLINATIONS_URL) :
 *   1. un gratuit ne lit ni le cours ni le solde : ni reserve, ni facture ;
 *   2. un 429 passe au repli suivant, un refus d'une autre sorte non ; sans
 *      OVH_AI_KEY, aucun en-tete Authorization ne part ;
 *   3. le quota par joueur et par jour se prend a la reponse REUSSIE, et se
 *      rend a minuit UTC ;
 *   4. le gratuit ne se revend pas : x402 (horsSolde), l'agent (pireCas) et les
 *      cles d'agent retombent sur « unknown model » ou sur Grok, et MODELES
 *      (lu par agentic.js et chat_x402.js) ne le contient pas ;
 *   5. les images : Pollinations avec safe=true, SDXL seulement si le garde dit
 *      « Safe », une demande « Unsafe » refusee partout, pas de retouche.
 */
const http = require('http');
const net = require('net');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });

process.env.STUDIO_DEX = '0';
delete process.env.OVH_AI_KEY; delete process.env.STUDIO_GRATUIT;
process.env.STUDIO_GRATUIT_JOUR = '3'; process.env.STUDIO_GRATUIT_IMAGES_JOUR = '2';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

(async () => {
  const vus = [];
  const limites = new Set();      /* modeles qui rendent 429 */
  let refusAutre = null;          /* modele qui rend 400 */
  let gardeDit = 'Safe';
  const faux = http.createServer((q, r) => {
    let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
      const corps = b ? JSON.parse(b) : {};
      vus.push({ url: q.url, auth: q.headers.authorization, corps });
      if (q.url.startsWith('/prompt/')) {
        r.writeHead(200, { 'content-type': 'image/jpeg' }); return r.end(JPEG);
      }
      if (q.url === '/v1/images/generations') {
        r.writeHead(200, { 'content-type': 'application/json' });
        return r.end(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }));
      }
      if (corps.model === 'Qwen3Guard-Gen-8B') {
        if (gardeDit === null) { r.writeHead(429, { 'content-type': 'application/json' }); return r.end('{}'); }
        r.writeHead(200, { 'content-type': 'application/json' });
        return r.end(JSON.stringify({ choices: [{ message: { content: 'Safety: ' + gardeDit + '\nCategories: None' } }] }));
      }
      if (limites.has(corps.model)) { r.writeHead(429, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ error: { message: 'rate limited' } })); }
      if (refusAutre === corps.model) { r.writeHead(400, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ error: { message: 'bad' } })); }
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      r.write('data: ' + JSON.stringify({ model: corps.model, choices: [{ delta: { content: 'Bonjour ' } }] }) + '\n\n');
      r.write('data: ' + JSON.stringify({ model: corps.model, choices: [{ delta: { content: 'de ' + corps.model }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } }) + '\n\n');
      r.end('data: [DONE]\n\n');
    });
  });
  const port = await libre();
  await new Promise((res) => faux.listen(port, res));
  process.env.GRATUIT_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.GRATUIT_POLLINATIONS_URL = 'http://127.0.0.1:' + port;

  const C = require('./studio_chat');
  const Compat = require('./studio_compat');
  const M = require('./studio_media');
  const G = require('./studio_gratuit');

  /* Un solde et un cours qui CRIENT s'ils sont touches. */
  let touche = 0;
  const solde = { reserve: () => { touche++; return true; }, regle: () => { touche++; return '0'; } };
  const cours = async () => { touche++; return 0.00002801; };
  const deps = (o) => Object.assign({ solde, cours, fournisseur: (p) => Compat.repond(p), actif: Compat.actif }, o || {});
  const question = [{ role: 'user', content: 'What is a memecoin?' }];
  const T = Date.parse('2026-10-18T12:00:00Z');

  console.log('1. ni cours, ni reserve, ni facture');
  ok(Compat.actif('gratuit'), 'le fournisseur gratuit est allume sans cle');
  let r = await C.repond({ addr: '0xA', modele: 'free-llama-3-3-70b', messages: question, maintenant: T }, deps());
  ok(r.ok, 'une reponse gratuite passe');
  eq(r.factureUsd, 0, 'facture : 0 $');
  eq(touche, 0, 'le solde et le cours ne sont jamais touches');
  eq(r.servi, 'Meta-Llama-3_3-70B-Instruct', 'le modele demande sert');
  ok(/Bonjour de Meta-Llama/.test(r.texte), 'le texte arrive');
  const v0 = vus.filter((x) => x.url === '/v1/chat/completions').pop();
  eq(v0.auth, undefined, 'sans OVH_AI_KEY : aucun en-tete Authorization');
  ok(v0.corps.stream === true && v0.corps.max_completion_tokens === 4000, 'stream et max_completion_tokens envoyes');

  console.log('2. le repli sur un 429, pas sur un autre refus');
  limites.add('Meta-Llama-3_3-70B-Instruct');
  r = await C.repond({ addr: '0xA', modele: 'free-llama-3-3-70b', messages: question, maintenant: T }, deps());
  ok(r.ok && r.servi === 'gpt-oss-120b', 'Llama limite -> gpt-oss-120b sert [' + r.servi + ']');
  limites.add('gpt-oss-120b'); limites.add('gpt-oss-20b');
  r = await C.repond({ addr: '0xB', modele: 'free-llama-3-3-70b', messages: question, maintenant: T }, deps());
  ok(!r.ok && r.code === 429 && /busy/.test(r.raison), 'tous limites -> 429 « busy », rien de facture');
  eq(C.gratuitsRestants('0xB', T), 3, 'un echec ne mange pas le quota');
  limites.clear(); refusAutre = 'Meta-Llama-3_3-70B-Instruct';
  const avant = vus.length;
  r = await C.repond({ addr: '0xB', modele: 'free-llama-3-3-70b', messages: question, maintenant: T }, deps());
  ok(!r.ok && r.code === 502, 'un 400 ne passe pas au repli');
  eq(vus.length - avant, 1, 'un seul appel parti sur un 400');
  refusAutre = null;
  /* Un payant n'a toujours qu'un essai : le repli est reserve aux gratuits. */
  const Fp = Compat.FOURNISSEURS.openai; const baseP = Fp.base, cleP = Fp.cle;
  Fp.base = () => 'http://127.0.0.1:' + port; Fp.cle = () => 'sk-essai';
  limites.add('gpt-6-luna');
  const av2 = vus.length;
  let err = null;
  try { await Compat.repond({ m: Object.assign({}, C.modele('gpt-6-luna'), { repli: ['gpt-oss-20b'] }), messages: question }); } catch (e) { err = e; }
  ok(err && err.statut === 429, 'un payant limite echoue (pas de repli)');
  eq(vus.length - av2, 1, 'un seul appel pour un payant');
  eq(vus[vus.length - 1].auth, 'Bearer sk-essai', 'un payant garde son Authorization');
  Fp.base = baseP; Fp.cle = cleP; limites.clear();

  console.log('3. le quota par jour');
  eq(C.gratuitsRestants('0xA', T), 1, '0xA : deux reponses prises sur trois');
  r = await C.repond({ addr: '0xA', modele: 'free-gpt-oss-20b', messages: question, maintenant: T }, deps());
  ok(r.ok && r.gratuitRestant === 0, 'la troisieme passe, il en reste 0');
  r = await C.repond({ addr: '0xa', modele: 'free-gpt-oss-120b', messages: question, maintenant: T }, deps());
  ok(!r.ok && r.code === 429 && /free answers/.test(r.raison), 'la quatrieme est refusee (adresse en minuscules comprise)');
  eq(C.gratuitsRestants('0xA', T + 24 * 3600e3), 3, 'le lendemain UTC, le quota revient');

  console.log('4. le gratuit ne se revend pas');
  ok(!C.MODELES.some((m) => m.gratuit), 'MODELES (agentic, chat_x402) ne contient aucun gratuit');
  eq(C.modele('free-gpt-oss-120b'), null, 'modele() ne le trouve pas (chat_x402.lis)');
  r = await C.repond({ addr: '0xC', modele: 'free-gpt-oss-120b', messages: question }, deps({ horsSolde: true }));
  ok(!r.ok && r.code === 400, 'x402 (horsSolde) : unknown model');
  r = await C.repond({ addr: '0xC', modele: 'free-gpt-oss-120b', messages: question }, deps({ pireCas: () => 0 }));
  ok(!r.ok && r.code === 400, 'l agent (pireCas) : unknown model');
  r = await C.repond({ addr: '0xC', modele: 'free-gpt-oss-120b', messages: [{ role: 'user', content: 'x', pieces: [{ type: 'image', data: 'data:image/png;base64,iVBORw0KGgo=' }] }] }, deps());
  ok(!r.ok && r.code === 400, 'une photo jointe est refusee (texte seul)');
  const cat = C.catalogue(0.00002801, { anthropic: false, gratuit: true });
  ok(cat.ouvert && cat.modeles.filter((m) => m.gratuit && m.actif).length === 3, 'le catalogue : ouvert, trois gratuits allumes');
  ok(C.catalogue(null, { gratuit: true }).ouvert, 'ouvert meme sans cours (le gratuit ne le lit pas)');
  ok(cat.modeles.filter((m) => m.gratuit).every((m) => m.typiqueUsd === 0 && m.recherche === false && m.nomFournisseur === 'Free'), 'gratuits : 0 $, sans recherche, groupe « Free »');
  eq(C.catalogue(1, { anthropic: true }).modeles.filter((m) => m.gratuit && m.actif).length, 0, 'STUDIO_GRATUIT eteint : gratuits eteints');
  process.env.STUDIO_GRATUIT = '0';
  ok(!Compat.actif('gratuit'), 'STUDIO_GRATUIT=0 coupe le fournisseur');
  delete process.env.STUDIO_GRATUIT;

  console.log('5. les images gratuites');
  const four = G.cree();
  const dm = (o) => Object.assign({ solde, cours, fournisseurs: { gratuit: four, grok: { actif: () => true, images: async () => ({ urls: ['https://grok/x.png'], usage: { cost_in_usd_ticks: 2e8 } }) } }, range: (u) => 'https://nous/' + u.length }, o || {});
  touche = 0;
  let im = await M.images({ addr: '0xI', fournisseur: 'gratuit', modele: 'rapide', prompt: 'a shiba', format: '16:9', maintenant: T }, dm());
  ok(im.ok && im.fournisseur === 'gratuit' && im.factureUsd === 0, 'Pollinations : une image, 0 $');
  eq(touche, 0, 'ni cours ni solde touches');
  ok(/^https:\/\/nous\//.test(im.urls[0]), 'l image est rangee chez nous (pas de data-URL a la page)');
  const p = vus.filter((x) => x.url.startsWith('/prompt/')).pop();
  ok(/safe=true/.test(p.url) && /width=1344&height=768/.test(p.url), 'safe=true et le format 16:9 envoyes');
  gardeDit = 'Controversial';
  im = await M.images({ addr: '0xJ', fournisseur: 'gratuit', modele: 'qualite', prompt: 'x', maintenant: T }, dm());
  ok(!im.ok && im.code === 400 && /safety/.test(im.raison), 'SDXL : « Controversial » refuse');
  im = await M.images({ addr: '0xJ', fournisseur: 'gratuit', modele: 'rapide', prompt: 'x', maintenant: T }, dm());
  ok(im.ok, 'Pollinations : « Controversial » part (safe=true filtre)');
  gardeDit = 'Unsafe';
  const avI = vus.filter((x) => x.url.startsWith('/prompt/')).length;
  im = await M.images({ addr: '0xK', fournisseur: 'gratuit', modele: 'rapide', prompt: 'x', maintenant: T }, dm());
  ok(!im.ok && im.code === 400, 'Pollinations : « Unsafe » refuse');
  eq(vus.filter((x) => x.url.startsWith('/prompt/')).length, avI, 'rien n est parti chez Pollinations');
  eq(M.imagesGratuitesRestantes('0xK', T), 2, 'un refus ne prend pas le quota');
  gardeDit = null;
  im = await M.images({ addr: '0xK', fournisseur: 'gratuit', modele: 'qualite', prompt: 'x', maintenant: T }, dm());
  ok(!im.ok && /busy/.test(im.raison), 'garde muet : SDXL refuse');
  im = await M.images({ addr: '0xK', fournisseur: 'gratuit', modele: 'rapide', prompt: 'x', maintenant: T }, dm());
  ok(im.ok, 'garde muet : Pollinations part');
  gardeDit = 'Safe';
  im = await M.images({ addr: '0xL', fournisseur: 'gratuit', modele: 'qualite', prompt: 'x', format: '9:16', maintenant: T }, dm());
  ok(im.ok, 'SDXL « Safe » : une image');
  eq(vus.filter((x) => x.url === '/v1/images/generations').pop().corps.size, '1024x1792', 'SDXL 9:16 -> 1024x1792 (taille permise)');
  im = await M.images({ addr: '0xI', fournisseur: 'gratuit', modele: 'rapide', prompt: 'x', maintenant: T }, dm());
  ok(im.ok && im.gratuitRestant === 0, '0xI : deuxieme image, quota epuise');
  im = await M.images({ addr: '0xI', fournisseur: 'gratuit', modele: 'rapide', prompt: 'x', maintenant: T }, dm());
  ok(!im.ok && im.code === 429, 'troisieme refusee');
  im = await M.images({ addr: '0xM', fournisseur: 'gratuit', modele: 'rapide', prompt: 'x', image: 'data:image/png;base64,iVBORw0KGgo=', maintenant: T }, dm());
  ok(!im.ok && /edit a photo/.test(im.raison), 'pas de retouche en gratuit');
  /* x402 et cles d'agent : le gratuit retombe sur Grok (payant), comme un fournisseur inconnu. */
  im = await M.images({ addr: '0xN', fournisseur: 'gratuit', modele: 'rapide', prompt: 'x', prixUsd: 0.2 }, dm({ horsSolde: true }));
  ok(im.ok && im.fournisseur === 'grok', 'x402 : gratuit -> Grok (paye d avance)');
  im = await M.images({ addr: '0xN', fournisseur: 'gratuit', modele: 'rapide', prompt: 'x', canal: 'rest' }, dm());
  ok(im.ok && im.fournisseur === 'grok', 'cle d agent (canal rest) : gratuit -> Grok');
  const mc = M.catalogue(null, { grok: false, openai: false, gratuit: true });
  ok(mc.ouvert && mc.image.fournisseurs.find((f) => f.id === 'gratuit').actif, 'catalogue media : ouvert pour le gratuit seul, sans cours');
  ok(mc.image.fournisseurs.find((f) => f.id === 'gratuit').modeles.every((m) => m.parImageUsd === 0), 'images gratuites a 0 $');
  ok(!mc.videoOuverte, 'la video reste fermee (aucun gratuit)');

  faux.close();
  console.log((rates ? 'RATES : ' + rates + '/' + n : n + ' verifications OK'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
