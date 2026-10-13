'use strict';
/* ============================================================================
 * LES POSES OpenAI (outils/planches/poses.js) : LE PLAFOND AVANT L'APPEL
 *
 * Contre un faux OpenAI local (OPENAI_BASE_URL), jamais le vrai :
 *   1. l'appel part en multipart sur /v1/images/edits avec le modele 2.5,
 *      2048x1024, fond transparent, png, DEUX image[] (la toile du mannequin
 *      et l'ancienne planche), sans input_fidelity ; la ligne « envoye » est
 *      ecrite AVANT, la ligne finale porte le cout lu dans usage ;
 *   2. un appel qui DEPASSERAIT le plafond de 2,50 $ est refuse SANS partir
 *      (le faux serveur ne recoit rien) — reserves en vol comprises ;
 *   3. usage absent, ou cout au-dela de la reserve, ou plus de 12 000 jetons
 *      par image d'entree au premier appel : ARRET, et plus rien ne part ;
 *   4. un journal perdu alors que des poses existent : refus ;
 *   5. la cle n'apparait ni dans le journal, ni dans une reponse, ni dans une erreur ;
 *   6. la connexion coupee APRES qu'OpenAI a recu l'appel (ou un 5xx) : la reserve
 *      reste comptee (cout inconnu = cout plein) et ARRET — seul un 4xx vaut 0 $ ;
 *   7. la ligne de commande garde UN journal, quel que soit --dossier : un dossier
 *      neuf ne remet pas la depense a zero ; un plafond passe ne peut que baisser.
 * ==========================================================================*/
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const CLE = 'sk-essai-local-0123456789abcdef';
process.env.OPENAI_API_KEY = CLE;

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

(async () => {
  const recus = [];
  let reponse = () => ({ data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }],
    usage: { input_tokens: 9000, output_tokens: 3000, input_tokens_details: { text_tokens: 300, image_tokens: 8700 } } });
  const faux = http.createServer((q, r) => {
    const b = []; q.on('data', (c) => b.push(c)); q.on('end', () => {
      recus.push({ url: q.url, auth: q.headers.authorization, type: q.headers['content-type'], corps: Buffer.concat(b).toString('latin1') });
      const x = reponse();
      r.writeHead(x.statut || 200, { 'content-type': 'application/json' }); r.end(JSON.stringify(x.corps || x));
    });
  });
  await new Promise((res) => faux.listen(0, res));
  const base = 'http://127.0.0.1:' + faux.address().port;
  const P = require('./outils/planches/poses');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-poses-'));
  const E = P.cree({ dossier, base });
  const lignes = () => fs.readFileSync(E.JOURNAL, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  console.log('-- 1. un appel, et son cout reel --');
  ok(E.reserve(2) === P.reserveDepart(2) && Math.abs(P.reserveDepart(1) - 0.255) < 0.001 && Math.abs(P.reserveDepart(2) - 0.308) < 0.001, 'reserves de depart du plan : 0,255 $ (n=1), 0,308 $ (n=2)');
  const r1 = await E.appelle({ nom: 'pirate', n: 2, toile: PNG, ancienne: PNG });
  const q = recus[0];
  ok(r1.ok && recus.length === 1 && q.url === '/v1/images/edits' && /multipart\/form-data/.test(q.type), 'un POST multipart sur /v1/images/edits');
  ok(/name="model"\r\n\r\ngpt-image-2\.5-sunburst/.test(q.corps) && /name="size"\r\n\r\n2048x1024/.test(q.corps) && /name="background"\r\n\r\ntransparent/.test(q.corps)
     && /name="output_format"\r\n\r\npng/.test(q.corps) && /name="n"\r\n\r\n2/.test(q.corps), 'modele 2.5-sunburst, 2048x1024, transparent, png, n = 2');
  ok((q.corps.match(/name="image\[\]"/g) || []).length === 2 && !/input_fidelity/.test(q.corps), 'deux image[] (toile + ancienne planche), pas d input_fidelity');
  ok(q.auth === 'Bearer ' + CLE, 'la cle part dans l en-tete, vers OpenAI seulement');
  const L1 = lignes();
  const attendu = 8700 * 8e-6 + 300 * 5e-6 + 3000 * 30e-6;
  ok(L1.length === 2 && L1[0].statut === 'envoye' && L1[0].reserve === P.reserveDepart(2) && L1[1].statut === 'fini' && Math.abs(L1[1].coutUsd - attendu) < 1e-6,
     'journal : « envoye » (reserve) AVANT, puis le cout lu dans usage (' + L1[1].coutUsd + ' $)');
  ok(r1.fichiers.length === 2 && r1.fichiers.every((f) => fs.existsSync(f)) && !r1.arret, 'les 2 variantes sont rangees, pas d arret (8 700 jetons pour 2 images : sous 12 000 par image)');
  ok(Math.abs(E.reserve(2) - 1.5 * attendu) < 1e-4, 'la reserve devient 1,5 x le cout mesure (' + E.reserve(2) + ' $)');

  console.log('\n-- 2. le plafond, AVANT l appel --');
  /* un appel parti puis un redemarrage : sa reserve reste comptee */
  fs.appendFileSync(E.JOURNAL, JSON.stringify({ id: 'enVol', statut: 'envoye', n: 2, reserve: 2.2 }) + '\n');
  const avant = recus.length, dep = E.etat().depense;
  const r2 = await E.appelle({ nom: 'pirate', n: 2, toile: PNG, ancienne: PNG });
  ok(!r2.ok && /cap/.test(r2.raison) && recus.length === avant, 'depense ' + dep + ' $ (dont 2,2 $ en vol) + reserve > 2,50 $ : refuse, RIEN n est parti');
  ok(lignes().length === L1.length + 1, 'et rien n est journalise pour un refus');
  /* la ligne finale de l'appel en vol arrive : sa reserve est remplacee par son cout reel */
  fs.appendFileSync(E.JOURNAL, JSON.stringify({ id: 'enVol', statut: 'fini', n: 2, coutUsd: 0.05 }) + '\n');
  ok(E.peut(2).ok === true && Math.abs(E.etat().depense - (L1[1].coutUsd + 0.05)) < 1e-6, 'son cout reel arrive (0,05 $) : la reserve est rendue, l appel redevient permis');

  console.log('\n-- 3. les arrets --');
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-poses-'));
  const E2 = P.cree({ dossier: d2, base });
  reponse = () => ({ data: [{ b64_json: PNG.toString('base64') }] });                 /* pas d'usage */
  const r3 = await E2.appelle({ nom: 'pirate', n: 1, toile: PNG, ancienne: PNG });
  const l3 = fs.readFileSync(E2.JOURNAL, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  ok(r3.arret && /usage missing/.test(r3.arret) && l3.coutUsd === P.reserveDepart(1) && fs.existsSync(E2.ARRET), 'usage absent : le cout retenu est la reserve, et ARRET');
  const avant3 = recus.length;
  const r4 = await E2.appelle({ nom: 'pirate', n: 1, toile: PNG, ancienne: PNG });
  ok(!r4.ok && /ARRET/.test(r4.raison) && recus.length === avant3, 'apres ARRET, plus aucun appel ne part');

  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-poses-'));
  const E3 = P.cree({ dossier: d3, base });
  reponse = () => ({ data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 30000, output_tokens: 2000, input_tokens_details: { text_tokens: 200, image_tokens: 29800 } } });
  const r5 = await E3.appelle({ nom: 'pirate', n: 1, toile: PNG, ancienne: PNG });
  ok(r5.arret && /calibration/.test(r5.arret) && fs.existsSync(E3.ARRET), 'calibrage : 29 800 jetons pour 2 images d entree (> 12 000 par image) : ARRET et rapport');

  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-poses-'));
  const E4 = P.cree({ dossier: d4, base });
  reponse = () => ({ data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 9000, output_tokens: 9000, input_tokens_details: { text_tokens: 300, image_tokens: 8700 } } });
  const r6 = await E4.appelle({ nom: 'pirate', n: 1, toile: PNG, ancienne: PNG });
  ok(r6.arret && /> reserve/.test(r6.arret) && fs.existsSync(E4.ARRET), 'un cout au-dela de sa reserve (' + r6.coutUsd + ' $ > ' + P.reserveDepart(1) + ' $) : ARRET');

  console.log('\n-- 4. journal perdu --');
  fs.unlinkSync(E.JOURNAL);
  const avant4 = recus.length;
  const r7 = await E.appelle({ nom: 'pirate', n: 1, toile: PNG, ancienne: PNG });
  ok(!r7.ok && /journal missing/.test(r7.raison) && recus.length === avant4, 'des poses existent mais plus de journal : refus, rien ne part');

  console.log('\n-- 5. la cle --');
  const d5 = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-poses-'));
  const E5 = P.cree({ dossier: d5, base });
  reponse = () => ({ statut: 401, corps: { error: { message: 'Incorrect API key provided: ' + CLE } } });
  const r8 = await E5.appelle({ nom: 'pirate', n: 1, toile: PNG, ancienne: PNG });
  const tout = [d2, d3, d4, d5].map((d) => { try { return fs.readFileSync(path.join(d, 'journal_openai.jsonl'), 'utf8'); } catch (e) { return ''; } }).join('') + JSON.stringify([r1, r2, r3, r4, r5, r6, r7, r8]);
  ok(!r8.ok && /\[key\]/.test(r8.raison) && !tout.includes(CLE) && !tout.includes('sk-essai'), 'une erreur qui recopie la cle : effacee ; la cle n est dans AUCUN journal ni reponse');
  const l8 = fs.readFileSync(path.join(d5, 'journal_openai.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  ok(l8.statut === 'erreur' && l8.coutUsd === 0, 'un refus HTTP sans image est journalise a 0 $');

  console.log('\n-- 6. coupure apres reception, et 5xx --');
  let recusCoupe = 0;
  const coupe = http.createServer((q2) => { q2.on('data', () => {}); q2.on('end', () => { recusCoupe++; q2.socket.destroy(); }); });
  await new Promise((res) => coupe.listen(0, '127.0.0.1', res));
  const d6 = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-poses-'));
  const E6 = P.cree({ dossier: d6, base: 'http://127.0.0.1:' + coupe.address().port });
  const r9 = await E6.appelle({ nom: 'pirate', n: 2, toile: PNG, ancienne: PNG });
  const l9 = fs.readFileSync(E6.JOURNAL, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  ok(recusCoupe === 1 && !r9.ok && l9.statut === 'inconnu' && l9.coutUsd === P.reserveDepart(2) && E6.etat().depense === P.reserveDepart(2),
     'OpenAI a recu l appel puis la connexion tombe : statut inconnu, la reserve (' + l9.coutUsd + ' $) reste comptee [' + l9.statut + ' ' + l9.coutUsd + ']');
  ok(fs.existsSync(E6.ARRET) && !E6.peut(1).ok, 'et ARRET : plus aucun appel tant qu un humain n a pas relu la facturation');
  const d7 = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-poses-'));
  const E7 = P.cree({ dossier: d7, base });
  reponse = () => ({ statut: 502, corps: { error: { message: 'bad gateway' } } });
  const r10 = await E7.appelle({ nom: 'pirate', n: 1, toile: PNG, ancienne: PNG });
  ok(!r10.ok && E7.etat().depense === P.reserveDepart(1) && fs.existsSync(E7.ARRET), 'un 502 : la reserve reste comptee, ARRET');
  coupe.close();

  console.log('\n-- 7. un seul journal pour la ligne de commande --');
  const maison = fs.mkdtempSync(path.join(os.tmpdir(), 'planches-maison-'));
  const homeAvant = process.env.HOME; process.env.HOME = maison;
  const A = P.creeCommande({ dossier: path.join(maison, 'A'), base }), B = P.creeCommande({ dossier: path.join(maison, 'B'), base });
  fs.mkdirSync(path.dirname(A.JOURNAL), { recursive: true });
  fs.appendFileSync(A.JOURNAL, JSON.stringify({ id: 'x', statut: 'fini', n: 2, coutUsd: 2.45 }) + '\n');
  const pb = B.peut(1);
  ok(A.JOURNAL === B.JOURNAL && A.JOURNAL.startsWith(maison) && !pb.ok && /cap/.test(pb.raison), 'deux --dossier differents : le meme journal, 2,45 $ deja depenses vus des deux cotes, appel refuse');
  process.env.HOME = homeAvant;
  ok(P.cree({ dossier: d7, base, plafond: 1000 }).PLAFOND === 2.5, 'un plafond passe a 1 000 $ reste a 2,50 $ (il ne peut que baisser)');

  faux.close();
  for (const d of [dossier, d2, d3, d4, d5, d6, d7, maison]) fs.rmSync(d, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
