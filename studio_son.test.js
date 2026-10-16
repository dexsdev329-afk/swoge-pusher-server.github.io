'use strict';
/*
 * L'ONGLET VOICE DU STUDIO (studio_son.js) — ElevenLabs simule, vrai credits.js.
 *
 * Intention :
 *   1. la forme EXACTE des requetes : POST /v1/text-to-speech/<voice_id>?output_format=mp3_44100_128
 *      et POST /v1/music, en-tete xi-api-key, corps { text, model_id, language_code? } et
 *      { prompt, music_length_ms, model_id, force_instrumental } ; les voix lues sur
 *      GET /v2/voices?category=premade, et seules les « premade » gardees ;
 *   2. le prix = liste ElevenLabs × STUDIO_MARGE, au 1/10 000 $ superieur, connu avant l'appel ;
 *      un confirmeUsd different = 409, rien de reserve ;
 *   3. la reserve sur le credit, puis le reglement au prix — ou TOUT rendu (refus, panne,
 *      fichier qui n'est pas un MP3) ; un refus du fournisseur ne coute rien et rend sa suggestion ;
 *   4. les bornes : texte, voix hors liste, langue, duree, artiste nomme (aucun appel), une
 *      generation a la fois, debit par minute, plafond du jour (et rendu a un echec) ;
 *   5. sans cle : eteint, rien appele ; le fichier n'est servi qu'a l'adresse qui l'a paye, 48 h.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

delete process.env.STUDIO_MARGE; delete process.env.STUDIO_SON_PLAFOND_JOUR_USD; delete process.env.STUDIO_SON_PAR_MINUTE;
delete process.env.STUDIO_SON_TEXTE_MAX; delete process.env.STUDIO_SON_MUSIQUE_MODELE;
const S = require('./studio_son');
const Credits = require('./credits');

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 7)]);
const VOIX = [
  { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', category: 'premade', preview_url: 'https://storage.example/george.mp3', labels: { gender: 'male', accent: 'british', age: 'middle_aged' }, sharing: { secret: 'x' } },
  { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', category: 'premade', preview_url: 'https://storage.example/sarah.mp3', labels: { gender: 'female', accent: 'american' } },
  { voice_id: 'CLONEDxxxxxxxxxxxxxx', name: 'My clone', category: 'cloned', preview_url: 'https://storage.example/clone.mp3', labels: {} },
  { voice_id: 'GENxxxxxxxxxxxxxxxxx', name: 'Generated', category: 'generated', preview_url: null, labels: {} },
];

(async () => {
  /* ---- le faux ElevenLabs ---- */
  const vus = [];
  let mode = 'ok';
  const faux = http.createServer((q, r) => {
    const b = []; q.on('data', (c) => b.push(c)); q.on('end', () => {
      const corps = Buffer.concat(b).toString('utf8');
      vus.push({ m: q.method, url: q.url, cle: q.headers['xi-api-key'] || null, ct: q.headers['content-type'] || null, corps: corps ? JSON.parse(corps) : null });
      if (q.url.startsWith('/v2/voices')) { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ voices: VOIX, has_more: false, total_count: 4 })); }
      if (mode === 'bad_prompt') { r.writeHead(400, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ detail: { status: 'bad_prompt', message: 'copyrighted', data: { prompt_suggestion: 'An epic rock ballad with soaring guitars' } } })); }
      if (mode === '422') { r.writeHead(422, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ detail: [{ loc: ['body', 'text'], msg: 'bad', type: 'value_error' }] })); }
      if (mode === '500') { r.writeHead(500); return r.end('down'); }
      if (mode === 'html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<html>proxy</html>'); }
      if (mode === 'lent') { setTimeout(() => { r.writeHead(200, { 'content-type': 'audio/mpeg' }); r.end(MP3); }, 300); return; }
      r.writeHead(200, { 'content-type': 'audio/mpeg' }); r.end(MP3);
    });
  });
  await new Promise((s) => faux.listen(0, '127.0.0.1', s));
  const base = 'http://127.0.0.1:' + faux.address().port;

  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-son-'));
  const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), P = '0x' + 'c3'.repeat(20);
  fs.writeFileSync(path.join(dossier, 'credits.json'), JSON.stringify({ soldes: { [A]: 5e6, [B]: 5e6, [P]: 1000 }, ouvertes: {}, tx: {}, seq: 0 }));
  const C = Credits.cree({ dossier });
  let t = Date.UTC(2026, 9, 16, 10, 0, 0);
  const env = {};
  let cle = 'xi-test-cle';
  const journal = [];
  const M = S.cree({ dossier: path.join(dossier, 'son'), base, cle: () => cle, env, maintenant: () => t, paie: S.paieCredit(() => C, 'studio voice'), journal: (o) => journal.push(o) });
  const usd = (a) => C.soldeUsd(a);

  console.log('-- 1. le catalogue : voix de la bibliotheque seulement, prix × marge --');
  const cat = await M.catalogue();
  const lv = vus.filter((v) => v.url.startsWith('/v2/voices'));
  ok(lv.length === 1 && lv[0].m === 'GET' && lv[0].url === '/v2/voices?category=premade&page_size=100' && lv[0].cle === 'xi-test-cle', 'GET /v2/voices?category=premade&page_size=100 avec xi-api-key [' + (lv[0] && lv[0].url) + ']');
  ok(cat.actif && cat.voix.actif && cat.voix.voix.map((v) => v.nom).join() === 'George,Sarah', 'seules les voix « premade » restent (la clonee et la generee sont ecartees)');
  ok(cat.voix.voix[0].apercu === 'https://storage.example/george.mp3' && cat.voix.voix[0].traits.join() === 'british,male,middle aged', 'chaque voix porte son echantillon (preview_url) et ses traits');
  ok(!/secret|sharing|cloned|category/.test(JSON.stringify(cat)) && !/xi-test-cle/.test(JSON.stringify(cat)), 'aucun champ prive, aucune cle dans le catalogue');
  ok(cat.voix.modeles[0].id === 'qualite' && cat.voix.modeles[0].parMilleUsd === 0.12 && cat.voix.modeles[1].parMilleUsd === 0.06, 'voix off : 0,08 $ et 0,04 $ / 1 000 caracteres × 1,5 = 0,12 $ et 0,06 $');
  ok(cat.musique.parMinuteUsd === 0.225 && cat.musique.prixUsd[30] === 0.1125 && cat.musique.prixUsd[10] === 0.0375 && cat.musique.durees.join() === '10,30,60,120', 'musique : 0,15 $/min × 1,5 = 0,225 $/min ; 30 s = 0,1125 $');
  ok(cat.regles.clonage === false && cat.regles.gardeHeures === 48, 'regles : pas de clonage, fichiers gardes 48 h');
  await M.catalogue();
  ok(vus.filter((v) => v.url.startsWith('/v2/voices')).length === 1, 'la liste des voix est gardee en cache (un seul appel)');

  console.log('\n-- 2. une voix off : la requete exacte, la reserve puis le reglement --');
  const texte = 'Welcome to SWOGE World. Lift heavy, stay swole.';   /* 47 caracteres */
  const prixV = S.prixClient(texte.length / 1000 * 0.08, 1.5);
  ok(prixV === 0.0057, 'le prix : 47 caracteres × 0,08 $/1 000 × 1,5 = 0,00564 -> 0,0057 $ [' + prixV + ']');
  const r409 = await M.voixOff({ addr: A, texte, voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: 0.0038 });
  ok(r409.code === 409 && r409.prixUsd === prixV && usd(A) === 5 && vus.length === 1, 'un prix confirme different (la liste sans marge) : 409, rien reserve, rien appele');
  vus.length = 0;
  const r1 = await M.voixOff({ addr: A, texte, voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', langue: 'fr', confirmeUsd: prixV });
  const v1 = vus[0];
  ok(r1.ok && vus.length === 1 && v1.m === 'POST' && v1.url === '/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128', 'POST /v1/text-to-speech/<voice_id>?output_format=mp3_44100_128 [' + (v1 && v1.url) + ']');
  ok(v1.cle === 'xi-test-cle' && v1.ct === 'application/json', 'en-tete xi-api-key, corps JSON');
  ok(JSON.stringify(v1.corps) === JSON.stringify({ text: texte, model_id: 'eleven_v3', language_code: 'fr' }), 'corps exact : { text, model_id: eleven_v3, language_code: fr } ' + JSON.stringify(v1.corps));
  ok(r1.factureUsd === prixV && Math.abs(usd(A) - (5 - prixV)) < 1e-9 && Math.abs(r1.creditUsd - (5 - prixV)) < 1e-9, 'facture = le prix montre, credit regle (5 $ -> ' + usd(A) + ' $)');
  ok(r1.genre === 'voice' && /^[0-9a-f]{48}$/.test(r1.id) && r1.url === '/studio/son/fichier/' + r1.id && r1.voix === 'George' && !JSON.stringify(r1).includes(A), 'le resultat : un identifiant, son adresse de lecture, la voix — jamais l adresse du joueur');
  t += 61000;
  vus.length = 0;
  const rf = await M.voixOff({ addr: A, texte: 'Fast one.', voix: 'EXAVITQu4vr4xnSDxMaL', modele: 'rapide', langue: 'fr', confirmeUsd: S.prixClient(9 / 1000 * 0.04, 1.5) });
  ok(rf.ok && JSON.stringify(vus[0].corps) === JSON.stringify({ text: 'Fast one.', model_id: 'eleven_flash_v2_5' }) && rf.factureUsd === 0.001, 'Fast : eleven_flash_v2_5, sans language_code (non documente pour ce modele), plancher 0,001 $');

  console.log('\n-- 3. le fichier : a son adresse seule, 48 h --');
  const f = M.fichier(r1.id, A);
  ok(f && fs.readFileSync(f.chemin).equals(MP3) && /\.mp3$/.test(f.nom), 'l adresse qui a paye lit le MP3');
  ok(M.fichier(r1.id, B) === null && M.fichier(r1.id, null) === null && M.fichier('../credits', A) === null, 'un autre wallet, sans session, ou un nom trafique : rien');
  ok(M.mes(A).length === 2 && M.mes(B).length === 0, 'la liste de mes resultats : ceux de la session seulement');
  const t0 = t; t += 48 * 3600e3 + 1000;
  ok(M.fichier(r1.id, A) === null && M.mes(A).length === 0 && M.menage() === 2, 'apres 48 h : plus servi, efface par le menage');
  t = t0 + 2 * 3600e3;

  console.log('\n-- 4. le refus du fournisseur est gratuit, la panne aussi --');
  const avant = usd(A);
  mode = '422';
  const rr = await M.voixOff({ addr: A, texte: 'Hello there.', voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: S.prixClient(12 / 1000 * 0.08, 1.5) });
  ok(rr.code === 422 && rr.refus && /refused/.test(rr.raison) && /not charged/.test(rr.raison) && usd(A) === avant, 'ElevenLabs refuse (422) : 422, rien facture');
  t += 61000; mode = '500';
  const rp = await M.voixOff({ addr: A, texte: 'Hello there.', voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: S.prixClient(12 / 1000 * 0.08, 1.5) });
  ok(rp.code === 502 && usd(A) === avant, 'ElevenLabs en panne (500) : 502, tout rendu');
  t += 61000; mode = 'html';
  const rh = await M.voixOff({ addr: A, texte: 'Hello there.', voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: S.prixClient(12 / 1000 * 0.08, 1.5) });
  ok(rh.code === 502 && usd(A) === avant && M.mes(A).length === 0, 'une reponse qui n est pas un MP3 : 502, rien range, tout rendu');
  t += 61000; mode = 'bad_prompt';
  const rb = await M.musique({ addr: A, prompt: 'An epic rock song', secondes: 30, confirmeUsd: 0.1125 });
  ok(rb.code === 422 && rb.suggestion === 'An epic rock ballad with soaring guitars' && /not charged/.test(rb.raison) && usd(A) === avant, 'bad_prompt : refuse, la suggestion d ElevenLabs rendue, rien facture');
  ok(C.etat().ouvertes === 0, 'aucune reserve ne reste ouverte apres les echecs');
  mode = 'ok';

  console.log('\n-- 5. une musique : la requete exacte --');
  t += 61000; vus.length = 0;
  const rm = await M.musique({ addr: A, prompt: 'Upbeat synthwave for a gym montage, 120 bpm', secondes: 30, confirmeUsd: 0.1125 });
  ok(rm.ok && vus.length === 1 && vus[0].url === '/v1/music' && vus[0].cle === 'xi-test-cle', 'POST /v1/music avec xi-api-key');
  ok(JSON.stringify(vus[0].corps) === JSON.stringify({ prompt: 'Upbeat synthwave for a gym montage, 120 bpm', music_length_ms: 30000, model_id: 'music_v2_5', force_instrumental: true }), 'corps exact : prompt, music_length_ms 30000, music_v2_5, instrumental ' + JSON.stringify(vus[0].corps));
  ok(rm.factureUsd === 0.1125 && rm.genre === 'music' && rm.secondes === 30 && Math.abs(usd(A) - (avant - 0.1125)) < 1e-9, '30 s : 0,1125 $ factures');
  t += 61000; vus.length = 0;
  const rl = await M.musique({ addr: A, prompt: 'Lo-fi piano', secondes: 10, instrumental: false, confirmeUsd: 0.0375 });
  ok(rl.ok && vus[0].corps.force_instrumental === false, 'instrumental: false part tel quel');

  console.log('\n-- 6. les bornes : rien appele, rien reserve --');
  t += 61000; vus.length = 0;
  const s0 = usd(A);
  const borne = [
    [await M.voixOff({ addr: A, texte: '', voix: 'JBFqnCBsd6RMkjVDRZzb', confirmeUsd: 0.001 }), 400, 'texte vide'],
    [await M.voixOff({ addr: A, texte: 'x'.repeat(2501), voix: 'JBFqnCBsd6RMkjVDRZzb', confirmeUsd: 0.3 }), 400, 'texte de 2 501 caracteres'],
    [await M.voixOff({ addr: A, texte: 'Hi', voix: 'CLONEDxxxxxxxxxxxxxx', confirmeUsd: 0.001 }), 400, 'une voix clonee (hors liste)'],
    [await M.voixOff({ addr: A, texte: 'Hi', voix: 'inconnue', confirmeUsd: 0.001 }), 400, 'une voix inconnue'],
    [await M.voixOff({ addr: A, texte: 'Hi', voix: 'JBFqnCBsd6RMkjVDRZzb', langue: 'xx', confirmeUsd: 0.001 }), 400, 'une langue inconnue'],
    [await M.musique({ addr: A, prompt: 'Song', secondes: 45, confirmeUsd: 0.1 }), 400, 'une duree hors liste'],
    [await M.musique({ addr: A, prompt: 'x'.repeat(601), secondes: 10, confirmeUsd: 0.0375 }), 400, 'un prompt de 601 signes'],
    [await M.musique({ addr: A, prompt: 'A track that sounds like Taylor Swift', secondes: 10, confirmeUsd: 0.0375 }), 400, 'Taylor Swift nommee'],
    [await M.musique({ addr: A, prompt: 'pop song in the style of Daft Punk', secondes: 10, confirmeUsd: 0.0375 }), 400, 'Daft Punk nomme'],
    [await M.musique({ addr: A, prompt: 'chill beat in the style of Kendrick Lamar.', secondes: 10, confirmeUsd: 0.0375 }), 400, 'un nom suivi d un point'],
    [await M.musique({ addr: A, prompt: 'a cover of Zorblax Quintet hit', secondes: 10, confirmeUsd: 0.0375 }), 400, '« cover of » + un nom propre inconnu'],
    [await M.voixOff({ addr: null, texte: 'Hi', voix: 'JBFqnCBsd6RMkjVDRZzb', confirmeUsd: 0.001 }), 401, 'sans session'],
  ];
  for (const [r, code, m] of borne) ok(r.code === code, m + ' : ' + code + ' [' + r.code + ' ' + String(r.raison).slice(0, 70) + ']');
  ok(vus.length === 0 && usd(A) === s0, 'aucune borne n appelle ElevenLabs ni ne touche au credit');
  ok(/genre, mood, tempo and instruments/.test(borne[7][0].raison) && /Nothing was charged/.test(borne[7][0].raison), 'le refus d artiste dit quoi ecrire a la place');
  ok(S.artisteNomme('Epic orchestral like Hollywood trailers') === null && S.artisteNomme('in the style of Bollywood') === null && S.artisteNomme('Queen of the night, dark piano') === null
     && S.artisteNomme('drill beat like future bass') === null && S.artisteNomme('a song by Queen') === 'queen', 'un genre ou un lieu n est pas un artiste ; « by Queen » si');
  const pauvre = await M.voixOff({ addr: P, texte: 'x'.repeat(40), voix: 'JBFqnCBsd6RMkjVDRZzb', modele: 'qualite', confirmeUsd: S.prixClient(40 / 1000 * 0.08, 1.5) });
  ok(pauvre.code === 402 && /\$0\.0048 needed, you have \$0\.00/.test(pauvre.raison) && vus.length === 0, 'credit trop bas : 402, rien appele [' + pauvre.raison + ']');

  console.log('\n-- 7. une a la fois, le debit par minute, le plafond du jour --');
  t += 61000; mode = 'lent';
  const pv = S.prixClient(2 / 1000 * 0.08, 1.5);
  const p1 = M.voixOff({ addr: B, texte: 'Hi', voix: 'JBFqnCBsd6RMkjVDRZzb', confirmeUsd: pv });
  await new Promise((s) => setTimeout(s, 60));
  const p2 = await M.voixOff({ addr: B, texte: 'Hi', voix: 'JBFqnCBsd6RMkjVDRZzb', confirmeUsd: pv });
  ok(p2.code === 429 && /one generation at a time/.test(p2.raison), 'une seconde demande pendant la premiere : 429');
  ok((await p1).ok, 'la premiere aboutit');
  mode = 'ok';
  const res4 = [];
  for (let k = 0; k < 4; k++) res4.push(await M.voixOff({ addr: B, texte: 'Hi', voix: 'JBFqnCBsd6RMkjVDRZzb', confirmeUsd: pv }));
  ok(res4.slice(0, 3).every((r) => r.ok) && res4[3].code === 429 && /wait a minute/.test(res4[3].raison), 'STUDIO_SON_PAR_MINUTE (4) : la 5e de la minute est refusee');
  /* le plafond : 0,10 $ de cout ElevenLabs par jour */
  env.STUDIO_SON_PLAFOND_JOUR_USD = '0.1';
  t = Date.UTC(2026, 9, 17, 9, 0, 0);
  const c1 = await M.musique({ addr: B, prompt: 'Calm ambient pads', secondes: 30, confirmeUsd: 0.1125 });   /* 0,075 $ chez ElevenLabs */
  const c2 = await M.musique({ addr: B, prompt: 'Calm ambient pads', secondes: 30, confirmeUsd: 0.1125 });
  ok(c1.ok && c2.code === 429 && /budget is used up/.test(c2.raison) && M.etat().jour.usd === 0.075, 'plafond du jour (0,10 $) : la 1re (0,075 $) passe, la 2e est refusee sans rien reserver');
  const cat2 = await M.catalogue();
  ok(cat2.pause === false, 'le catalogue ne ferme pas tant qu il reste du budget');
  t += 61000; mode = '500';
  const c3 = await M.musique({ addr: B, prompt: 'Calm ambient pads', secondes: 10, confirmeUsd: 0.0375 });
  ok(c3.code === 502 && M.etat().jour.usd === 0.075, 'un echec rend aussi sa part du plafond du jour');
  mode = 'ok';
  t = Date.UTC(2026, 9, 18, 0, 0, 1);
  ok(M.etat().jour.usd === 0 && (await M.musique({ addr: B, prompt: 'Calm ambient pads', secondes: 30, confirmeUsd: 0.1125 })).ok, 'un nouveau jour UTC : le compteur repart');
  env.STUDIO_SON_PLAFOND_JOUR_USD = '0';
  t += 61000;
  ok((await M.musique({ addr: B, prompt: 'Calm', secondes: 10, confirmeUsd: 0.0375 })).code === 503 && (await M.catalogue()).pause === true, 'plafond 0 : le service est en pause');
  delete env.STUDIO_SON_PLAFOND_JOUR_USD;
  env.STUDIO_MARGE = '2';
  ok((await M.catalogue()).musique.parMinuteUsd === 0.3 && (await M.musique({ addr: B, prompt: 'Calm', secondes: 10, confirmeUsd: 0.0375 })).code === 409, 'STUDIO_MARGE=2 : le prix suit (0,30 $/min), l ancien prix confirme est refuse (409)');
  delete env.STUDIO_MARGE;

  console.log('\n-- 8. sans cle : eteint, rien appele --');
  cle = ''; vus.length = 0;
  const off = await M.catalogue();
  const o1 = await M.voixOff({ addr: A, texte: 'Hi', voix: 'JBFqnCBsd6RMkjVDRZzb', confirmeUsd: 0.001 });
  const o2 = await M.musique({ addr: A, prompt: 'Calm', secondes: 10, confirmeUsd: 0.0375 });
  ok(off.actif === false && /coming soon/i.test(off.note) && off.voix.voix.length === 0, 'catalogue : actif false, « coming soon », aucune voix');
  ok(o1.code === 503 && o2.code === 503 && vus.length === 0, 'voix off et musique : 503, aucun appel');

  console.log('\n-- 9. le journal et le code : pas de clonage, aucune cle --');
  const src = fs.readFileSync(path.join(__dirname, 'studio_son.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/voices\/add|ivc|pvc|\/v1\/voice-generation|multipart|FormData/i.test(src), 'aucun endpoint de clonage ni televersement de voix dans le code');
  ok(journal.length > 0 && !JSON.stringify(journal).includes('xi-test-cle') && journal.some((x) => x.sorte === 'livre') && journal.some((x) => x.sorte === 'rendu'), 'le journal garde envois, livraisons et rendus, sans la cle');

  faux.close();
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
