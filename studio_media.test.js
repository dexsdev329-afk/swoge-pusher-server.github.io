'use strict';
/*
 * SWOGE STUDIO — IMAGES ET VIDÉOS : ce qui peut perdre de l'argent, mis à l'essai.
 *
 *   1. On ne facture JAMAIS sous le coût rendu par xAI, jamais plus que la
 *      réserve ; la réserve couvre les prix de liste avec marge.
 *   2. Échec du fournisseur, image refusée, vidéo ratée ou trop longue : TOUT
 *      est rendu. Solde insuffisant : aucun appel payant.
 *   3. Une image jointe mal formée ou trop lourde est refusée avant tout débit.
 *   4. Une vidéo n'est lisible que par l'adresse qui l'a payée.
 *   5. De bout en bout, sur le VRAI serveur contre un faux xAI local
 *      (`XAI_BASE_URL`) : jeton de session exigé, seule l'adresse de la
 *      session est débitée, la clé ne quitte pas l'hôte, les champs envoyés
 *      sont ceux de la spécification OpenAPI d'xAI.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/studiomedia-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801';
process.env.STUDIO_MARGE = '1.5';
process.env.STUDIO_VIDEO_POLL_MS = '200'; process.env.STUDIO_VIDEO_MAX_MS = '60000';
delete process.env.XAI_API_KEY; delete process.env.GROK_API_KEY;

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
const COURS = 0.00002801;
const W = (x) => ethers.utils.parseUnits(String(x), 18);

(async () => {
  const port = await libre();
  process.env.PORT = String(port);
  const M = require('./studio_media');

  /* Un faux solde : ce qui est reserve, ce qui est facture. */
  const faux = () => {
    const s = { bal: W(1000000), reserves: [], reglements: [] };
    s.solde = {
      reserve: (a, w) => { const x = ethers.BigNumber.from(String(w)); if (x.lte(0) || s.bal.lt(x)) return false; s.bal = s.bal.sub(x); s.reserves.push(x); return true; },
      regle: (a, rw, fw) => { const r = ethers.BigNumber.from(String(rw)); const f = ethers.BigNumber.from(String(fw)); s.bal = s.bal.add(r.sub(f)); s.reglements.push({ r, f }); return ethers.utils.formatUnits(s.bal, 18); },
    };
    return s;
  };
  const enUsd = (wei) => Number(ethers.utils.formatUnits(wei, 18)) * COURS;

  console.log('-- 1. une image : le cout reel de xAI, avec marge, jamais sous le cout --');
  {
    for (const m of M.IMAGE.filter((x) => x.fournisseur === 'grok')) for (const nb of M.NOMBRES) {
      const s = faux();
      const cout = m.usd * nb;                         /* le prix de liste, rendu en ticks */
      const r = await M.images({ addr: '0xa' + m.id + nb, modele: m.id, prompt: 'a buff doge', n: nb }, {
        cours: async () => COURS, solde: s.solde,
        fournisseur: { images: async () => ({ urls: Array(nb).fill('https://x/img.png'), usage: { cost_in_usd_ticks: Math.round(cout * 1e10) } }) } });
      const f = s.reglements[0];
      ok(r.ok && enUsd(f.f) >= cout * 1.5 - 1e-6, m.nom + ' ×' + nb + ' : facture ' + enUsd(f.f).toFixed(4) + ' $ ≥ cout ' + cout.toFixed(2) + ' × 1,5');
      ok(enUsd(f.r) >= enUsd(f.f), 'et la reserve couvrait la facture');
    }
  }

  console.log('\n-- 1 bis. ChatGPT Image : factures aux JETONS lus dans usage, jamais sous le cout --');
  {
    const P = M.PRIX_OPENAI[M.modeleOpenai()];
    for (const m of M.IMAGE.filter((x) => x.fournisseur === 'openai')) for (const nb of M.NOMBRES) for (const retouche of [false, true]) {
      const s = faux(); let demande = null;
      /* Un usage realiste et large : 7 000 jetons de sortie par image (la mesure du 18 septembre : 6 893). */
      const usage = { input_tokens: 60 + (retouche ? 9000 : 0), input_tokens_details: { text_tokens: 60, image_tokens: retouche ? 9000 : 0 }, output_tokens: 7000 * nb };
      const cout = (60 * P.t + (retouche ? 9000 : 0) * P.i + 7000 * nb * P.o) / 1e6;
      const r = await M.images({ addr: '0xo' + m.id + nb + retouche, fournisseur: 'openai', modele: m.id, prompt: 'a buff doge', n: nb,
        image: retouche ? 'data:image/png;base64,iVBORw0KGgo=' : undefined }, {
        cours: async () => COURS, solde: s.solde, range: (u) => '/studio/media/fichier/' + 'a'.repeat(48) + '.jpg',
        fournisseurs: { openai: { actif: () => true, images: async (o) => { demande = o; return { urls: Array(nb).fill('data:image/jpeg;base64,/9j/AAA='), usage }; } } } });
      const f = s.reglements[0];
      ok(r.ok && enUsd(f.f) >= cout * 1.5 - 1e-6 && enUsd(f.r) >= enUsd(f.f),
         'ChatGPT ' + m.nom + ' ×' + nb + (retouche ? ' retouche' : '') + ' : facture ' + enUsd(f.f).toFixed(4) + ' $ ≥ cout ' + cout.toFixed(4) + ' × 1,5, sous la reserve');
      if (nb === 1 && !retouche) ok(demande.qualite === (m.id === 'qualite' ? 'high' : 'medium'), m.nom + ' = qualite ' + demande.qualite);
      if (nb === 1 && !retouche) ok(r.urls[0].startsWith('/studio/media/fichier/'), 'les images en base64 sont rangees chez nous : la page recoit une adresse');
    }
    const r = await M.images({ addr: '0xoff', fournisseur: 'openai', prompt: 'x' }, { cours: async () => COURS, solde: faux().solde,
      fournisseurs: { openai: { actif: () => false, images: async () => ({ urls: ['u'] }) } } });
    eq(r.code, 503, 'sans cle OpenAI : 503, rien n est reserve');
  }

  console.log('\n-- 2. tout est rendu quand rien n est livre --');
  {
    const s = faux(); const avant = s.bal;
    const r = await M.images({ addr: '0xb', modele: 'rapide', prompt: 'x', n: 2 }, { cours: async () => COURS, solde: s.solde,
      fournisseur: { images: async () => { throw new Error('xAI 500'); } } });
    ok(!r.ok && r.code === 502 && s.bal.eq(avant), 'le fournisseur echoue : 502, solde intact');
    const s2 = faux(); const avant2 = s2.bal;
    const r2 = await M.images({ addr: '0xb2', modele: 'rapide', prompt: 'x' }, { cours: async () => COURS, solde: s2.solde,
      fournisseur: { images: async () => ({ urls: [], usage: null }) } });
    ok(!r2.ok && s2.bal.eq(avant2), 'aucune image rendue (moderation) : rien n est facture');
    let appels = 0;
    const pauvre = faux(); pauvre.bal = W(1);
    const r3 = await M.images({ addr: '0xc', modele: 'qualite', prompt: 'x', n: 4 }, { cours: async () => COURS, solde: pauvre.solde,
      fournisseur: { images: async () => { appels++; return { urls: ['u'] }; } } });
    ok(r3.code === 402 && appels === 0 && Number(r3.requisSwoge) > 0, 'solde insuffisant : 402 avec le montant requis, AUCUN appel payant');
    const r4 = await M.images({ addr: '0xd', prompt: 'x', image: 'data:text/html;base64,PHNjcmlwdD4=' }, { cours: async () => COURS, solde: faux().solde, fournisseur: {} });
    ok(r4.code === 400, 'une piece jointe qui n est pas une image : refusee avant tout debit');
    const lourde = 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024);
    ok(M.imageJointe(lourde) === false, 'une image de plus de 6 Mo : refusee');
  }

  console.log('\n-- 3. sans usage : la liste, plafonnee a la reserve, et comptee --');
  {
    const s = faux(); const avant = M.MESURE.sansUsage;
    const r = await M.images({ addr: '0xe', modele: 'qualite', prompt: 'x' }, { cours: async () => COURS, solde: s.solde,
      fournisseur: { images: async () => ({ urls: ['u'], usage: null }) } });
    ok(r.ok && enUsd(s.reglements[0].f) >= 0.04 * 1.5 - 1e-6, 'facture au prix de liste avec marge');
    eq(M.MESURE.sansUsage, avant + 1, 'et le cas est compte');
    const s2 = faux(); const d0 = M.MESURE.depassements;
    await M.images({ addr: '0xf', modele: 'rapide', prompt: 'x' }, { cours: async () => COURS, solde: s2.solde,
      fournisseur: { images: async () => ({ urls: ['u'], usage: { cost_in_usd_ticks: 5 * 1e10 } }) } });
    ok(s2.reglements[0].f.eq(s2.reglements[0].r) && M.MESURE.depassements === d0 + 1, 'un cout aberrant ne depasse jamais la reserve (depassement compte)');
  }

  console.log('\n-- 4. une video : lancee, suivie, reglee — et a son proprietaire seulement --');
  {
    const s = faux(); let etat = { status: 'pending', progress: 40 };
    const deps = { cours: async () => COURS, solde: s.solde, sansBoucle: true,
      fournisseur: { lanceVideo: async (o) => { deps.demande = o; return 'rid-1'; }, litVideo: async () => etat } };
    const r = await M.lanceVideo({ addr: '0xv', modele: 'qualite', prompt: 'doge lifts', duree: 10, resolution: '720p', format: '9:16' }, deps);
    ok(r.ok && r.status === 'pending' && r.id, 'la video est lancee');
    ok(deps.demande.api === 'grok-imagine-video-1.5' && deps.demande.duree === 10 && deps.demande.resolution === '720p' && deps.demande.format === '9:16', 'avec le modele, la duree, la resolution et le format demandes');
    const job = M.JOBS.get(r.id);
    await M.avance(job, deps);
    eq(M.etatVideo(r.id, '0xv').progress, 40, 'pendant la generation, la progression est lue');
    eq(M.etatVideo(r.id, '0xautre').code, 404, 'une autre adresse ne voit pas la video');
    const r2 = await M.lanceVideo({ addr: '0xv', prompt: 'une autre' }, deps);
    eq(r2.code, 429, 'une seule video a la fois par joueur');
    etat = { status: 'done', video: { url: 'https://vidgen.x.ai/v.mp4', duration: 10 }, usage: { cost_in_usd_ticks: 0.8 * 1e10 } };
    await M.avance(job, deps);
    const e = M.etatVideo(r.id, '0xv');
    ok(e.status === 'done' && e.url === 'https://vidgen.x.ai/v.mp4', 'la video arrivee est rendue a son proprietaire');
    ok(enUsd(s.reglements[0].f) >= 0.8 * 1.5 - 1e-6 && enUsd(s.reglements[0].r) >= enUsd(s.reglements[0].f), 'facturee au cout reel × 1,5, sous la reserve');

    const s2 = faux(); const av = s2.bal;
    const d2 = { cours: async () => COURS, solde: s2.solde, sansBoucle: true,
      fournisseur: { lanceVideo: async () => 'rid-2', litVideo: async () => ({ status: 'failed', erreur: 'moderation' }) } };
    const r3 = await M.lanceVideo({ addr: '0xw', prompt: 'x' }, d2);
    await M.avance(M.JOBS.get(r3.id), d2);
    ok(M.etatVideo(r3.id, '0xw').status === 'failed' && s2.bal.eq(av), 'une video ratee : tout est rendu');
    const s3 = faux(); const av3 = s3.bal;
    const d3 = { cours: async () => COURS, solde: s3.solde, sansBoucle: true,
      fournisseur: { lanceVideo: async () => 'rid-3', litVideo: async () => ({ status: 'pending' }) } };
    const r4 = await M.lanceVideo({ addr: '0xy', prompt: 'x', maintenant: 1000 }, d3);
    await M.avance(M.JOBS.get(r4.id), d3, 1000 + 61000);
    ok(M.etatVideo(r4.id, '0xy').status === 'failed' && s3.bal.eq(av3), 'une video trop longue : tout est rendu');
    const r5 = await M.lanceVideo({ addr: '0xz' }, d3);
    eq(r5.code, 400, 'ni texte ni image : refusee avant tout debit');
  }

  console.log('\n-- 5. de bout en bout : vrai serveur, faux xAI --');
  {
    const vus = [];
    const fauxXai = http.createServer((q, r) => {
      let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
        vus.push({ url: q.url, methode: q.method, auth: q.headers.authorization, corps: b ? JSON.parse(b) : null });
        r.writeHead(200, { 'content-type': 'application/json' });
        if (q.url === '/v1/images/generations') return r.end(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/1.png' }, { url: 'https://imgen.x.ai/2.png' }], usage: { cost_in_usd_ticks: 8e8 } }));
        if (q.url === '/v1/videos/generations') return r.end(JSON.stringify({ request_id: 'req-9' }));
        if (q.url === '/v1/videos/req-9') return r.end(JSON.stringify({ status: 'done', video: { url: 'https://vidgen.x.ai/9.mp4', duration: 6, respect_moderation: true }, usage: { cost_in_usd_ticks: 3e9 } }));
        r.end('{}');
      });
    });
    const pX = await libre(); await new Promise((r) => fauxXai.listen(pX, r));
    process.env.XAI_API_KEY = 'xai-test-local';
    /* Un faux OpenAI : generation en JSON, retouche en multipart, images en base64. */
    const vusOA = [];
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');
    const fauxOA = http.createServer((q, r) => {
      const morceaux = []; q.on('data', (c) => morceaux.push(c)); q.on('end', () => {
        const brut = Buffer.concat(morceaux);
        vusOA.push({ url: q.url, type: q.headers['content-type'] || '', auth: q.headers.authorization, brut: brut.toString('latin1'),
                     corps: /json/.test(q.headers['content-type'] || '') ? JSON.parse(brut.toString('utf8')) : null });
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end(JSON.stringify({ created: 1, data: [{ b64_json: JPEG }],
          usage: { input_tokens: 50, input_tokens_details: { text_tokens: 50, image_tokens: 0 }, output_tokens: 6000 } }));
      });
    });
    const pO = await libre(); await new Promise((r) => fauxOA.listen(pO, r));
    process.env.OPENAI_API_KEY = 'sk-openai-test-local';
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + pO;
    process.env.XAI_BASE_URL = 'http://127.0.0.1:' + pX;

    const { Game } = require('./game');
    let moteur = null;
    const p0 = Game.prototype._p;
    Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };
    require('./server');
    await new Promise((r) => setTimeout(r, 900));
    const base = 'http://127.0.0.1:' + port;

    const cat = await (await fetch(base + '/studio/media/catalogue')).json();
    ok(cat.ouvert && cat.image.modeles.length === 2 && cat.video.modeles.length === 2, 'le catalogue est ouvert : deux modeles image, deux video');
    ok(cat.image.modeles.every((m) => m.parImageSwoge > 0) && cat.video.modeles.every((m) => m.typiqueSwoge > 0), 'chacun avec son prix en $SWOGE');
    eq((await fetch(base + '/studio/media/image', { method: 'POST', body: '{}' })).status, 401, 'sans jeton de session : 401');

    const w = ethers.Wallet.createRandom();
    const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    await new Promise((r) => s.on('open', r));
    const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
    const h = await attend('hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    const auth = await attend('auth');
    const adr = w.address.toLowerCase();
    moteur._p(adr).balance = W(200000);
    const autre = ethers.Wallet.createRandom().address.toLowerCase();
    const autreAvant = moteur.balanceStr(autre);
    const H = { 'content-type': 'application/json', authorization: 'Bearer ' + auth.session };

    const avant = W(moteur.balanceStr(adr));
    const ri = await (await fetch(base + '/studio/media/image', { method: 'POST', headers: H,
      body: JSON.stringify({ modele: 'qualite', prompt: 'a buff doge on the moon', n: 2, format: '16:9', addr: autre }) })).json();
    ok(ri.ok && ri.urls.length === 2, 'deux images rendues');
    const gi = vus.find((v) => v.url === '/v1/images/generations');
    ok(gi && gi.corps.model === 'grok-imagine-image-2.0' && gi.corps.n === 2 && gi.corps.aspect_ratio === '16:9' && gi.corps.prompt === 'a buff doge on the moon', 'xAI recoit model, n, aspect_ratio, prompt — les champs de sa specification');
    eq(gi.auth, 'Bearer xai-test-local', 'la cle part vers xAI, depuis le serveur');
    ok(!JSON.stringify(ri).includes('xai-test-local'), 'et ne revient jamais au navigateur');
    const debit = avant.sub(W(moteur.balanceStr(adr)));
    ok(debit.eq(W(ri.factureSwoge)), 'l adresse de la SESSION est debitee exactement de la facture annoncee [' + ri.factureSwoge + ']');
    eq(moteur.balanceStr(autre), autreAvant, 'l adresse glissee dans le corps n est pas touchee');
    ok(Math.abs(Number(ri.factureUsd) - 0.08 * 1.5) < 1e-6, 'facture = cout rendu par xAI (0,08 $) × 1,5');

    const rv = await (await fetch(base + '/studio/media/video', { method: 'POST', headers: H,
      body: JSON.stringify({ modele: 'rapide', prompt: 'the doge flexes', duree: 6, resolution: '480p', format: '9:16' }) })).json();
    ok(rv.ok && rv.id, 'la video est lancee');
    const gv = vus.find((v) => v.url === '/v1/videos/generations');
    ok(gv && gv.corps.model === 'grok-imagine-video' && gv.corps.duration === 6 && gv.corps.resolution === '480p' && gv.corps.aspect_ratio === '9:16', 'xAI recoit model, duration, resolution, aspect_ratio');
    let ev = null;
    for (let i = 0; i < 40; i++) { ev = await (await fetch(base + '/studio/media/video/' + rv.id, { headers: H })).json(); if (ev.status !== 'pending') break; await new Promise((r) => setTimeout(r, 100)); }
    ok(ev.status === 'done' && ev.url === 'https://vidgen.x.ai/9.mp4', 'le serveur a suivi la video jusqu au bout, la page la lit chez nous');
    ok(Math.abs(Number(ev.factureUsd) - 0.3 * 1.5) < 1e-6, 'facturee au cout rendu par xAI (0,30 $) × 1,5 [' + ev.factureSwoge + ' $SWOGE]');
    const autreJeton = await (await fetch(base + '/studio/media/video/' + rv.id, { headers: { authorization: 'Bearer faux' } })).status;
    eq(autreJeton, 401, 'sans la bonne session : personne ne lit la video');

    /* ---- ChatGPT Image, de bout en bout ---- */
    const cat2 = await (await fetch(base + '/studio/media/catalogue')).json();
    ok(cat2.image.fournisseurs.map((f) => f.id + ':' + f.actif).join(',') === 'grok:true,openai:true', 'le catalogue propose Grok Imagine ET ChatGPT Image');
    const av2 = W(moteur.balanceStr(adr));
    const ro = await (await fetch(base + '/studio/media/image', { method: 'POST', headers: H,
      body: JSON.stringify({ fournisseur: 'openai', modele: 'qualite', prompt: 'a doge astronaut', n: 1, format: '9:16' }) })).json();
    const go = vusOA.find((v) => v.url === '/v1/images/generations');
    ok(ro.ok && go && go.corps.model === 'gpt-image-2' && go.corps.size === '1024x1536' && go.corps.quality === 'high' && go.corps.n === 1,
       'OpenAI recoit model gpt-image-2, size 1024x1536 (9:16), quality high, n — les champs de sa specification');
    eq(go.auth, 'Bearer sk-openai-test-local', 'la cle OpenAI part du serveur');
    ok(!JSON.stringify(ro).includes('sk-openai') && !JSON.stringify(ro).includes('base64'), 'la page ne recoit ni la cle, ni des megaoctets de base64');
    const img = await fetch(base + ro.urls[0]);
    ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg' && Buffer.from(await img.arrayBuffer()).toString('base64') === JPEG,
       'l image est rangee chez nous et servie telle quelle, en image/jpeg');
    eq((await fetch(base + '/studio/media/fichier/..%2F..%2Fstate.json')).status, 404, 'rien d autre ne sort du dossier des images');
    const cout = (50 * 5 + 6000 * 30) / 1e6;
    ok(Math.abs(Number(ro.factureUsd) - cout * 1.5) < 1e-5,   /* factureUsd est arrondie a 5 decimales */ 'facture = jetons lus dans usage × grille gpt-image-2 × 1,5 [' + ro.factureUsd + ' $]');
    ok(av2.sub(W(moteur.balanceStr(adr))).eq(W(ro.factureSwoge)), 'et la session est debitee exactement de la facture');
    const re = await (await fetch(base + '/studio/media/image', { method: 'POST', headers: H,
      body: JSON.stringify({ fournisseur: 'openai', modele: 'rapide', prompt: 'make it gold', image: 'data:image/png;base64,iVBORw0KGgo=' }) })).json();
    const eo = vusOA.find((v) => v.url === '/v1/images/edits');
    ok(re.ok && eo && /multipart\/form-data/.test(eo.type) && /name="image"; filename="photo.png"/.test(eo.brut) && /name="quality"\r\n\r\nmedium/.test(eo.brut),
       'une retouche part en multipart, la photo en fichier, qualite medium pour « Speed »');
    fauxOA.close();

    s.close(); fauxXai.close();
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
