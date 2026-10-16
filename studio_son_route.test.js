'use strict';
/* ============================================================================
 * L'ONGLET VOICE DU STUDIO (/studio/son/...), SUR UN VRAI SERVEUR
 *
 * Ce qu'elle DOIT tenir :
 *   1. GET /studio/son/catalogue sans session : les prix au joueur, les voix de la
 *      bibliotheque — ni cout maison, ni plafond, ni cle ; les autres routes : 401.
 *   2. Un joueur quelconque paie au credit en dollars de SA session : la voix off
 *      part chez ElevenLabs (xi-api-key, /v1/text-to-speech/<voix>), le credit est
 *      debite du prix montre ; un prix confirme faux : 409, rien debite.
 *   3. Le MP3 ne sort qu'avec la session qui l'a paye (401 sans, 404 pour un autre).
 *   4. La musique (/v1/music) ; un refus d'ElevenLabs (bad_prompt) : rien debite ; un
 *      artiste nomme : 400 sans appel ; credit trop bas : 402.
 *   5. Une adresse mise dans le corps ne change pas le payeur ; la cle ne sort jamais.
 *   6. Un second serveur SANS ELEVENLABS_API_KEY : catalogue eteint, 503.
 * ElevenLabs est simule en remplacant `fetch` pour son seul domaine.
 * ==========================================================================*/
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ethers = require('ethers');
const WebSocket = require('ws');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* Le second serveur (sans cle) : ce meme fichier, relance avec ETEINT=1. */
const ETEINT = process.env.STUDIO_SON_ESSAI_ETEINT === '1';
process.env.DATA_DIR = fs.mkdtempSync('/tmp/studio-son-route-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.TG_APPELS = '0'; process.env.TG_DECOUVERTE = '0'; process.env.KLING_TG = '0';
process.env.SITE_URL = 'https://site.example';
delete process.env.STUDIO_MARGE; delete process.env.STUDIO_SON_PLAFOND_JOUR_USD; delete process.env.STUDIO_SON_PAR_MINUTE;
if (ETEINT) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = 'cle-elevenlabs-secrete';
const J1 = ethers.Wallet.createRandom(), J2 = ethers.Wallet.createRandom(), J3 = ethers.Wallet.createRandom();
fs.writeFileSync(path.join(process.env.DATA_DIR, 'credits.json'), JSON.stringify({ soldes: {
  [J1.address.toLowerCase()]: 2e6, [J2.address.toLowerCase()]: 2e6, [J3.address.toLowerCase()]: 1000 }, ouvertes: {}, tx: {}, seq: 0 }));

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 9)]);
const recus = [];
let refus = null;
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  if (!url.startsWith('https://api.elevenlabs.io/')) return vraiFetch(u, o);
  recus.push({ url, m: (o && o.method) || 'GET', cle: o && o.headers && o.headers['xi-api-key'], corps: o && o.body ? JSON.parse(o.body) : null });
  if (url.startsWith('https://api.elevenlabs.io/v2/voices')) {
    return new Response(JSON.stringify({ voices: [
      { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', category: 'premade', preview_url: 'https://storage.example/george.mp3', labels: { gender: 'male' } },
      { voice_id: 'CLONEDxxxxxxxxxxxxxx', name: 'Clone', category: 'cloned', preview_url: null, labels: {} }], has_more: false, total_count: 2 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (refus) return new Response(JSON.stringify(refus), { status: 400, headers: { 'content-type': 'application/json' } });
  return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
};

const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
async function connecte(port, w) {
  const s = new WebSocket('ws://127.0.0.1:' + port); s.recus = [];
  s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
  await new Promise((r) => s.on('open', r));
  const attend = (t) => new Promise((res, rej) => { const t0 = Date.now(); (function tour() { const m = s.recus.filter((x) => x.type === t).pop(); if (m) return res(m); if (Date.now() - t0 > 5000) return rej(new Error('pas de ' + t)); setTimeout(tour, 25); })(); });
  const h = await attend('hello');
  const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
  s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  const auth = await attend('auth');
  return { s, H: { 'content-type': 'application/json', authorization: 'Bearer ' + auth.session } };
}

(async () => {
  const port = await libre();
  process.env.PORT = String(port);
  process.env.PUBLIC_URL = 'http://127.0.0.1:' + port;
  const tg = require.resolve('./telegram');
  require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: { notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const B = 'http://127.0.0.1:' + port;
  const textes = [];
  const appel = async (chemin, H, corps, methode) => {
    const r = await vraiFetch(B + chemin, { method: methode || (corps ? 'POST' : 'GET'), headers: H || {}, body: corps ? JSON.stringify(corps) : undefined });
    const b = Buffer.from(await r.arrayBuffer()); const t = b.toString('utf8'); textes.push(t);
    let j = {}; try { j = JSON.parse(t); } catch (e) {}
    return { statut: r.status, j, t, b, h: r.headers };
  };

  if (ETEINT) {
    console.log('-- 6. un serveur SANS ELEVENLABS_API_KEY --');
    const g = await appel('/studio/son/catalogue');
    ok(g.statut === 200 && g.j.actif === false && /coming soon/i.test(g.j.note) && g.j.voix.voix.length === 0, 'catalogue : actif false, « coming soon »');
    const j1 = await connecte(port, J1);
    const v = await appel('/studio/son/voix', j1.H, { texte: 'Hi', voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: 0.001 });
    const m = await appel('/studio/son/musique', j1.H, { prompt: 'Calm', secondes: 10, confirmeUsd: 0.0375 });
    ok(v.statut === 503 && m.statut === 503 && recus.length === 0, 'voix off et musique : 503, aucun appel a ElevenLabs');
    j1.s.close();
    console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
    process.exit(rates ? 1 : 0);
  }

  console.log('-- 1. sans session --');
  const g = await appel('/studio/son/catalogue');
  ok(g.statut === 200 && g.j.actif === true && g.j.voix.voix.length === 1 && g.j.voix.voix[0].nom === 'George' && g.j.voix.modeles[0].parMilleUsd === 0.12 && g.j.musique.prixUsd['30'] === 0.1125,
    'catalogue public : George seul (la clonee ecartee), 0,12 $/1 000 caracteres, 30 s de musique 0,1125 $');
  ok(!/0\.08\b|0\.15\b|plafond|cle-elevenlabs|cloned/i.test(g.t), 'ni cout ElevenLabs, ni plafond, ni cle dans la reponse publique');
  ok((await appel('/studio/son/voix', { 'content-type': 'application/json' }, { texte: 'Hi' })).statut === 401 && (await appel('/studio/son/mes')).statut === 401
     && (await appel('/studio/son/fichier/' + 'a'.repeat(48))).statut === 401, 'voix, liste et fichier sans session : 401');

  console.log('\n-- 2. une voix off payee au credit de la session --');
  const j1 = await connecte(port, J1), j2 = await connecte(port, J2), j3 = await connecte(port, J3);
  const credit = async (H) => (await appel('/credit', H)).j.balanceUsd;
  const texte = 'Welcome to SWOGE World.';     /* 23 caracteres : 0,00276 -> 0,0028 $ */
  const faux = await appel('/studio/son/voix', j1.H, { texte, voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: 0.0018 });
  ok(faux.statut === 409 && faux.j.prixUsd === 0.0028 && await credit(j1.H) === 2 && recus.filter((x) => /text-to-speech/.test(x.url)).length === 0, 'prix confirme faux : 409 (le serveur dit 0,0028 $), rien debite, rien appele');
  const v = await appel('/studio/son/voix', j1.H, { texte, voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: 0.0028, addr: J2.address, adresse: J2.address });
  const env = recus.filter((x) => /text-to-speech/.test(x.url)).pop();
  ok(v.statut === 200 && env && env.url === 'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128' && env.cle === 'cle-elevenlabs-secrete'
     && JSON.stringify(env.corps) === JSON.stringify({ text: texte, model_id: 'eleven_v3' }), 'ElevenLabs recoit la requete exacte (xi-api-key, /v1/text-to-speech/<voix>, { text, model_id })');
  ok(await credit(j1.H) === 1.9972 && await credit(j2.H) === 2 && v.j.factureUsd === 0.0028 && v.j.creditUsd === 1.9972, 'le credit de la SESSION est debite (2 -> 1,9972 $) ; l adresse du corps est ignoree');

  console.log('\n-- 3. le fichier, a la session qui l a paye --');
  const f = await appel(v.j.url, j1.H);
  ok(f.statut === 200 && f.h.get('content-type') === 'audio/mpeg' && f.b.equals(MP3) && /no-store/.test(f.h.get('cache-control')), 'le MP3 avec la session qui l a paye');
  ok((await appel(v.j.url, j2.H)).statut === 404 && (await appel(v.j.url)).statut === 401, 'un autre wallet : 404 ; sans session : 401');
  ok((await appel('/studio/son/mes', j1.H)).j.fichiers.length === 1 && (await appel('/studio/son/mes', j2.H)).j.fichiers.length === 0, '« mes resultats » : ceux de la session seulement');

  console.log('\n-- 4. la musique, les refus --');
  const m = await appel('/studio/son/musique', j2.H, { prompt: 'Upbeat synthwave', secondes: 30, confirmeUsd: 0.1125 });
  const em = recus.filter((x) => /\/v1\/music$/.test(x.url)).pop();
  ok(m.statut === 200 && em && JSON.stringify(em.corps) === JSON.stringify({ prompt: 'Upbeat synthwave', music_length_ms: 30000, model_id: 'music_v2_5', force_instrumental: true }) && await credit(j2.H) === 1.8875,
    'POST /v1/music { prompt, music_length_ms, model_id, force_instrumental } ; 0,1125 $ debites');
  const avant = recus.length;
  const art = await appel('/studio/son/musique', j2.H, { prompt: 'a song in the style of Daft Punk', secondes: 10, confirmeUsd: 0.0375 });
  ok(art.statut === 400 && recus.length === avant && await credit(j2.H) === 1.8875, 'un artiste nomme : 400, aucun appel, rien debite');
  refus = { detail: { status: 'bad_prompt', data: { prompt_suggestion: 'Retro electronic funk with vocoder' } } };
  const bp = await appel('/studio/son/musique', j2.H, { prompt: 'that famous robot song', secondes: 10, confirmeUsd: 0.0375 });
  refus = null;
  ok(bp.statut === 422 && bp.j.suggestion === 'Retro electronic funk with vocoder' && await credit(j2.H) === 1.8875, 'bad_prompt d ElevenLabs : 422, sa suggestion, rien debite');
  const pv = await appel('/studio/son/voix', j3.H, { texte: 'x'.repeat(100), voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: 0.012 });
  ok(pv.statut === 402 && /\$0\.0120 needed/.test(pv.j.raison) && await credit(j3.H) === 0.001, 'credit trop bas : 402, rien debite');
  ok((await appel('/studio/son/voix', j1.H, { texte: 'Hi', voix: 'CLONEDxxxxxxxxxxxxxx', modele: 'qualite', confirmeUsd: 0.001 })).statut === 400, 'une voix clonee : 400');

  console.log('\n-- 5. aucune cle, aucune adresse --');
  ok(textes.every((t) => !t.includes('cle-elevenlabs-secrete')), 'la cle ne sort dans aucune reponse (' + textes.length + ')');
  ok(textes.filter((t) => t.startsWith('{')).every((t) => !new RegExp(J1.address.slice(2) + '|' + J2.address.slice(2), 'i').test(t)), 'aucune adresse de joueur dans une reponse JSON');
  const jr = fs.readFileSync(path.join(process.env.DATA_DIR, 'studio_son_journal.jsonl'), 'utf8');
  ok(/"sorte":"livre"/.test(jr) && /"sorte":"rendu"/.test(jr) && !/cle-elevenlabs/.test(jr), 'le journal du volume garde livraisons et rendus, sans la cle');
  for (const x of [j1, j2, j3]) x.s.close();

  /* 6. le second serveur, sans cle */
  const fils = spawn(process.execPath, [__filename], { env: Object.assign({}, process.env, { STUDIO_SON_ESSAI_ETEINT: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let sortie = '';
  fils.stdout.on('data', (d) => { sortie += d; });
  const code = await new Promise((r) => fils.on('close', r));
  process.stdout.write('\n' + sortie.split('\n').filter((l) => /^\s+(ok|RATE)|^--/.test(l)).join('\n') + '\n');
  n += (sortie.match(/^\s+(ok|RATE)/gm) || []).length; rates += (sortie.match(/^\s+RATE/gm) || []).length;
  if (code !== 0 && !/RATE/.test(sortie)) { rates++; console.log('  RATE le serveur sans cle n a pas fini (' + code + ')'); }

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
