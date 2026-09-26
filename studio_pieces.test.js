'use strict';
/*
 * SWOLEMIND — une photo ou un PDF joint a la question :
 *   1. les dimensions lues dans l'en-tete (PNG, JPEG), pas crues sur parole ;
 *   2. la verification : formats, octets magiques, tailles, nombre — un refus
 *      dit pourquoi, et rien n'est reserve ;
 *   3. le pire cas d'une image couvre Anthropic (l×h/750) ET OpenAI (carres
 *      de 32 px × 1,62, le plus haut publie) ;
 *   4. la forme de chaque fournisseur : blocs `image`/`document` chez
 *      Anthropic, parties `image_url` en data URL chez OpenAI et xAI ;
 *   5. un PDF : Claude seulement, reserve sur le compte EXACT d'Anthropic,
 *      refuse au-dela de PDF_JETONS_MAX, rien facture si le compte echoue.
 */
const http = require('http');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801'; process.env.STUDIO_MARGE = '1.5';
delete process.env.OPENAI_API_KEY; delete process.env.XAI_API_KEY; delete process.env.GROK_API_KEY; delete process.env.PERPLEXITY_API_KEY;

/* Un PNG et un JPEG dont seuls les en-tetes comptent pour le lecteur. */
const png = (l, h) => { const b = Buffer.alloc(40); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(l, 16); b.writeUInt32BE(h, 20); return b; };
const jpeg = (l, h) => Buffer.concat([Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),   /* APP0, 16 octets */
  Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]),                                                   /* DHT : n'est pas un SOF */
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, l >> 8, l & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  Buffer.from([0xff, 0xd9])]);
const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF', 'latin1');
const b64 = (b) => b.toString('base64');

(async () => {
  const P = require('./studio_pieces');
  const C = require('./studio_chat');

  console.log('-- 1. les dimensions, lues dans le fichier --');
  {
    const d1 = P.dimensions(png(1568, 1176), 'image/png'), d2 = P.dimensions(jpeg(1200, 900), 'image/jpeg');
    ok(d1.l === 1568 && d1.h === 1176, 'PNG : IHDR lu');
    ok(d2.l === 1200 && d2.h === 900, 'JPEG : le premier SOF, en sautant APP0 et DHT');
    eq(P.dimensions(Buffer.from('not an image'), 'image/jpeg'), null, 'un faux JPEG ne rend rien');
  }

  console.log('\n-- 2. la verification --');
  {
    const u = (pieces, extra) => [Object.assign({ role: 'user', content: 'look', pieces }, extra || {})];
    ok(/only photos/.test(P.verifie(u([{ media: 'image/gif', data: 'R0lG' }])).erreur), 'un GIF est refuse, et le refus le dit');
    ok(/unreadable/.test(P.verifie(u([{ media: 'image/png', data: 'pas du base64 !' }])).erreur), 'un base64 casse est refuse');
    ok(/is not a PDF/.test(P.verifie(u([{ media: 'application/pdf', data: b64(png(10, 10)), nom: 'x.pdf' }])).erreur), 'un PNG deguise en PDF est refuse (octets magiques)');
    ok(/not a readable JPEG/.test(P.verifie(u([{ media: 'image/jpeg', data: b64(png(10, 10)) }])).erreur), 'un PNG deguise en JPEG aussi');
    ok(/max 2048 px/.test(P.verifie(u([{ media: 'image/png', data: b64(png(4000, 3000)) }])).erreur), 'une photo non reduite par la page est refusee : le pire cas reste borne');
    ok(/at most 4 photos/.test(P.verifie(u(Array(5).fill({ media: 'image/png', data: b64(png(10, 10)) }))).erreur), 'au plus quatre photos');
    ok(/one PDF/.test(P.verifie([{ role: 'user', content: 'a', pieces: [{ media: 'application/pdf', data: b64(pdf) }] }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c', pieces: [{ media: 'application/pdf', data: b64(pdf) }] }]).erreur), 'un seul PDF par requete, historique compris');
    ok(/too large \(max 10 MB\)/.test(P.verifie(u([{ media: 'application/pdf', data: b64(Buffer.concat([pdf, Buffer.alloc(10 * 1024 * 1024)])) }])).erreur), 'un PDF de plus de 10 Mo est refuse');
    const v = P.verifie([{ role: 'assistant', content: 'x', pieces: [{ media: 'image/png', data: b64(png(10, 10)) }] },
      { role: 'user', content: 'y', pieces: [{ media: 'image/png', data: b64(png(64, 32)), nom: '../../etc/passwd<script>' }] }]);
    ok(!v.erreur && v.messages[0].pieces === undefined, 'une piece sur un message de l assistant est retiree');
    ok(v.messages[1].pieces[0].l === 64 && /^[\w .()-]+$/.test(v.messages[1].pieces[0].nom), 'les dimensions sont gardees, le nom nettoye [' + v.messages[1].pieces[0].nom + ']');
  }

  console.log('\n-- 3. le pire cas d une image --');
  for (const [l, h] of [[1568, 1176], [2048, 2048], [1, 1], [300, 2000]]) {
    const j = P.jetonsImage(l, h);
    ok(j >= l * h / 750 && j >= Math.ceil(Math.ceil(l / 32) * Math.ceil(h / 32) * 1.62), l + '×' + h + ' : ' + j + ' jetons ≥ Anthropic (' + Math.ceil(l * h / 750) + ') et ≥ OpenAI × 1,62 (' + Math.ceil(Math.ceil(l / 32) * Math.ceil(h / 32) * 1.62) + ')');
  }
  ok(P.jetonsImage(1568, 1568) >= 4784, 'et au-dessus du plafond publie d Anthropic en haute resolution (4 784 jetons)');

  console.log('\n-- 4. la forme de chaque fournisseur --');
  {
    const x = { role: 'user', content: 'what is this?', pieces: [{ genre: 'pdf', media: 'application/pdf', data: 'QQ==' }, { genre: 'image', media: 'image/png', data: 'Qg==' }] };
    const c = P.pourClaude(x);
    ok(c.content[0].type === 'document' && c.content[0].source.type === 'base64' && c.content[0].source.media_type === 'application/pdf' && c.content[0].source.data === 'QQ==',
       'Anthropic : bloc document base64 application/pdf');
    ok(c.content[1].type === 'image' && c.content[1].source.media_type === 'image/png' && c.content[2].type === 'text' && c.content[2].text === 'what is this?',
       'puis l image, puis le texte en dernier');
    const o = P.pourCompat(x);
    ok(o.content.length === 2 && o.content[0].type === 'image_url' && o.content[0].image_url.url === 'data:image/png;base64,Qg==' && o.content[0].image_url.detail === 'high',
       'Chat Completions : image_url en data URL ; le PDF ne part jamais');
    eq(P.pourClaude({ role: 'user', content: 'hi' }).content, 'hi', 'sans piece, le message reste une chaine');
  }

  console.log('\n-- 5. dans le chat --');
  {
    const cours = 0.00002801;
    const solde = () => { const s = { r: [] }; s.o = { reserve: (a, w) => { s.r.push({ reserve: BigInt(String(w)) }); return true; },
      regle: (a, rw, fw) => { s.r.push({ rw: BigInt(String(rw)), fw: BigInt(String(fw)) }); return '0'; } }; return s; };
    const usd = (w) => Number(w) / 1e18 * cours;
    const photo = { media: 'image/jpeg', data: b64(jpeg(1568, 1176)), nom: 'chart.jpg' };
    const doc = { media: 'application/pdf', data: b64(pdf), nom: 'whitepaper.pdf' };
    const fourn = (vu) => async (p) => { vu.push(p); return { texte: 'ok', sources: [], usage: { input_tokens: 5000, output_tokens: 100 } }; };

    /* Une photo sur Grok : la reserve compte ses jetons. */
    const vu = [], s = solde();
    const r = await C.repond({ addr: '0x1', modele: 'grok-4-3', messages: [{ role: 'user', content: '', pieces: [photo] }] },
      { cours: async () => cours, solde: s.o, actif: () => true, fournisseur: fourn(vu) });
    ok(r.ok && vu[0].messages[0].pieces[0].l === 1568 && vu[0].messages[0].content === 'See the attached file.', 'une photo seule part, avec une question par defaut');
    const m = C.modele('grok-4-3');
    const attendu = C.factureUsd(C.pireCasUsd(m, [{ content: 'See the attached file.' }], false) + P.jetonsImage(1568, 1176) * m.entree / 1e6);
    ok(Math.abs(usd(s.r[0].reserve) - attendu) < 1e-6, 'la reserve compte les jetons de la photo [' + usd(s.r[0].reserve).toFixed(5) + ' $]');

    /* Un PDF sur GPT : refuse, rien reserve. */
    const s2 = solde();
    const r2 = await C.repond({ addr: '0x2', modele: 'gpt-6-sol', messages: [{ role: 'user', content: 'sum up', pieces: [doc] }] },
      { cours: async () => cours, solde: s2.o, actif: () => true, fournisseur: fourn([]), compte: async () => 1000 });
    ok(r2.code === 400 && /Claude models/.test(r2.raison) && s2.r.length === 0, 'un PDF a GPT : 400, le refus dit de choisir Claude, rien reserve');

    /* Un PDF sur Claude : le compte exact fait la reserve. */
    const s3 = solde(); let compte = null;
    const r3 = await C.repond({ addr: '0x3', modele: 'sonnet-5', messages: [{ role: 'user', content: 'sum up', pieces: [doc] }] },
      { cours: async () => cours, solde: s3.o, actif: () => true, fournisseur: fourn([]), compte: async (p) => { compte = p; return 42000; } });
    const ms = C.modele('sonnet-5');
    ok(r3.ok && compte.messages[0].pieces[0].genre === 'pdf', 'Claude : le PDF est compte AVANT de reserver');
    ok(Math.abs(usd(s3.r[0].reserve) - C.factureUsd(42000 * ms.entree / 1e6 + ms.maxTokens * ms.sortie / 1e6)) < 1e-6, 'la reserve = le compte exact + la sortie maximale');
    const s4 = solde();
    const r4 = await C.repond({ addr: '0x4', modele: 'sonnet-5', messages: [{ role: 'user', content: 'sum up', pieces: [doc] }] },
      { cours: async () => cours, solde: s4.o, actif: () => true, fournisseur: fourn([]), compte: async () => P.PDF_JETONS_MAX + 1 });
    ok(r4.code === 413 && /too long/.test(r4.raison) && s4.r.length === 0, 'un PDF trop long : 413, dit combien, rien reserve');
    const s5 = solde();
    const r5 = await C.repond({ addr: '0x5', modele: 'sonnet-5', messages: [{ role: 'user', content: 'sum up', pieces: [doc] }] },
      { cours: async () => cours, solde: s5.o, actif: () => true, fournisseur: fourn([]), compte: async () => { throw new Error('400 invalid pdf'); } });
    ok(r5.code === 502 && /not charged/.test(r5.raison) && s5.r.length === 0, 'le compte echoue : rien reserve, rien facture');
    const r6 = await C.repond({ addr: '0x6', modele: 'sonnet-5', messages: [{ role: 'user', content: 'x', pieces: [{ media: 'image/gif', data: 'R0lG' }] }] },
      { cours: async () => cours, solde: solde().o, actif: () => true, fournisseur: fourn([]) });
    ok(r6.code === 400 && /only photos/.test(r6.raison), 'une piece refusee arrete la requete avant tout');

    /* La fiche d'un jeton et une photo dans la meme question : la photo reste. */
    const vu7 = [];
    await C.repond({ addr: '0x7', modele: 'sonnet-5', messages: [{ role: 'user', content: 'is 0x6982508145454ce325ddbe47a25d4ec3d2311933 on this chart?', pieces: [photo] }] },
      { cours: async () => cours, solde: solde().o, actif: () => true, fournisseur: fourn(vu7),
        jetons: async (a) => a.map((x) => ({ adresse: x, marche: null, securite: null, colonie: null, manque: [] })) });
    ok(/---\nToken data/.test(vu7[0].messages[0].content) && vu7[0].messages[0].pieces.length === 1, 'la fiche d un jeton rejoint la question sans perdre la photo');

    const cat = C.catalogue(cours, { anthropic: true, openai: true, xai: true });
    ok(cat.modeles.every((x) => x.pieces.images) && cat.modeles.filter((x) => x.pieces.pdf).every((x) => x.fournisseur === 'anthropic') && cat.modeles.some((x) => x.pieces.pdf),
       'le catalogue dit ce que chaque modele lit : photos partout, PDF chez Claude');
  }

  console.log('\n-- 6. jusqu au fournisseur --');
  {
    /* Claude : le SDK remplace par un faux qui garde ce qu'il recoit. */
    const Cl = require('./studio_claude');
    let vu = null, vuCompte = null;
    const faux = { messages: {
      stream: (p) => { vu = p; const evs = [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }];
        return { [Symbol.asyncIterator]: async function* () { yield* evs; }, finalMessage: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }) }; },
      countTokens: async (p) => { vuCompte = p; return { input_tokens: 3210 }; } } };
    const msgs = [{ role: 'user', content: 'read', pieces: [{ genre: 'pdf', media: 'application/pdf', data: b64(pdf) }] }];
    await Cl.repond({ m: C.modele('haiku-4-5'), messages: msgs }, { client: faux });
    ok(vu.messages[0].content[0].type === 'document' && vu.messages[0].content[1].text === 'read', 'Claude recoit le bloc document, puis la question');
    eq(await Cl.compte({ m: C.modele('haiku-4-5'), messages: msgs }, { client: faux }), 3210, 'le compte rend input_tokens');
    ok(vuCompte.model === C.modele('haiku-4-5').api && /SwoleMind/.test(vuCompte.system) && vuCompte.messages[0].content[0].type === 'document', 'et compte la meme requete : modele, systeme, document');

    /* GPT et Grok : un faux fournisseur Chat Completions. */
    const corps = [];
    const srv = http.createServer((q, r) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { corps.push(JSON.parse(b));
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      r.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n'); }); });
    await new Promise((s) => srv.listen(0, '127.0.0.1', s));
    process.env.XAI_BASE_URL = process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + srv.address().port;
    process.env.XAI_API_KEY = 'x'; process.env.OPENAI_API_KEY = 'o';
    const Co = require('./studio_compat');
    await Co.repond({ m: C.modele('grok-4-7'), messages: [{ role: 'user', content: 'what chart?', pieces: [{ genre: 'image', media: 'image/jpeg', data: 'Qg==' }] }] });
    const u = corps[0].messages[1];
    ok(u.content[0].type === 'image_url' && u.content[0].image_url.url === 'data:image/jpeg;base64,Qg==' && u.content[1].type === 'text' && u.content[1].text === 'what chart?',
       'Grok recoit image_url (data URL) puis la question');
    ok(!('pieces' in u), 'nos champs internes ne partent pas chez le fournisseur');
    srv.close();
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
