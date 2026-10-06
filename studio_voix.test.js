'use strict';
/*
 * SWOLEMIND — LE VOCAL DU CHAT (studio_voix.js), mis a l'essai.
 *
 * Intention :
 *   1. transcris() frappe /v1/audio/transcriptions en multipart, avec le modele
 *      et la cle, et demande verbose_json ; il rend le texte ET la duree reelle.
 *   2. repond() facture la duree RENDUE par le fournisseur (jamais celle, peut-etre
 *      mensongere, annoncee par le client), bornee au minimum facturable, majoree
 *      comme le chat, et JAMAIS au-dela de la reserve.
 *   3. fail-closed : pas de cle -> 503 sans reserve ; un clip trop long -> 413 ;
 *      un fournisseur en panne -> 502, rien de debite.
 */
const http = require('http');
const net = require('net');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const libre = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });

process.env.STUDIO_DEX = '0'; process.env.SWOGE_PRIX_USD = '0.00002801'; process.env.STUDIO_MARGE = '1.5';
process.env.VOIX_FOURNISSEUR = 'groq';
delete process.env.VOIX_PRIX_HEURE;

const studio = require('./studio');
const V = require('./studio_voix');

/* Un faux solde qui capte la reserve et le reglement (comme l'essai du chat). */
function solde() {
  const s = { r: [] };
  s.o = { reserve: (a, w) => { s.resa = BigInt(String(w)); return true; },
          regle: (a, rw, fw) => { s.r.push({ rw: BigInt(String(rw)), fw: BigInt(String(fw)) }); return '0'; } };
  return s;
}
const cours = 0.00002801;
const usd = (w) => Number(w) / 1e18 * cours;
const b64 = Buffer.from('fake-audio-bytes').toString('base64');

(async () => {
  console.log('-- 1. transcris() : multipart vers /v1/audio/transcriptions, modele + cle, verbose_json --');
  let vu = null;
  const faux = http.createServer((q, r) => {
    let b = []; q.on('data', (c) => b.push(c)); q.on('end', () => {
      vu = { url: q.url, auth: q.headers.authorization, ct: q.headers['content-type'] || '', corps: Buffer.concat(b).toString('latin1') };
      if (/panne/.test(vu.corps)) { r.writeHead(429, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ error: { message: 'rate limited' } })); }
      r.writeHead(200, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ text: '  hello SWOGE  ', duration: 42 }));
    });
  });
  const port = await libre(); await new Promise((r) => faux.listen(port, r));
  process.env.VOIX_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.VOIX_API_KEY = 'gsk-test';

  {
    const res = await V.transcris({ audio: Buffer.from('abc'), mime: 'audio/webm', nom: 'clip' });
    ok(vu.url === '/v1/audio/transcriptions', 'frappe /v1/audio/transcriptions [' + vu.url + ']');
    ok(vu.auth === 'Bearer gsk-test', 'avec la cle, en Bearer');
    ok(/^multipart\/form-data/.test(vu.ct), 'en multipart/form-data');
    ok(/name="model"/.test(vu.corps) && /whisper-large-v3-turbo/.test(vu.corps), 'le champ model porte le modele Groq par defaut');
    ok(/name="file"/.test(vu.corps) && /name="response_format"/.test(vu.corps) && /verbose_json/.test(vu.corps), 'le fichier et response_format=verbose_json (pour la duree)');
    ok(res.texte === 'hello SWOGE' && res.secondes === 42, 'rend le texte (sans espaces) et la duree reelle');
  }

  console.log('\n-- 2. repond() : facture la duree RENDUE, bornee au minimum, jamais plus que la reserve --');
  {
    const s = solde();
    /* Le client annonce 3 s ; le fournisseur en rend 42 : c'est 42 qui facture. */
    const r = await V.repond({ addr: '0xv1', audio: b64, mime: 'audio/webm', secondesEstimees: 3 },
      { cours: async () => cours, solde: s.o, fournit: async () => ({ texte: 'hello SWOGE', secondes: 42 }) });
    const coutReel = 42 / 3600 * 0.04;           /* Groq turbo, 42 s */
    ok(r.ok && r.texte === 'hello SWOGE' && r.secondes === 42, 'rend le texte et la duree');
    ok(usd(s.r[0].fw) >= coutReel * 1.5 - 1e-9, 'facture ≥ cout reel (42 s) × 1,5 : jamais sous le cout [' + usd(s.r[0].fw).toFixed(6) + ']');
    ok(s.r[0].fw <= s.r[0].rw, 'la facture ne depasse jamais la reserve');
    ok(Math.abs(r.factureUsd - Math.max(0.001, coutReel * 1.5)) < 1e-6, 'la facture = cout(42 s)×1,5, ou le plancher 0,001 $');
  }

  console.log('\n-- 3. minimum facturable : un clip de 2 s est facture comme 10 s (Groq) --');
  {
    const s = solde();
    const r = await V.repond({ addr: '0xv2', audio: b64, mime: 'audio/webm' },
      { cours: async () => cours, solde: s.o, fournit: async () => ({ texte: 'hi', secondes: 2 }) });
    const cout10 = 10 / 3600 * 0.04;             /* minimum facturable Groq = 10 s */
    ok(r.ok && Math.abs(V.coutUsd(2) - cout10) < 1e-12, 'coutUsd(2 s) = coutUsd(10 s) : le minimum facturable s applique');
    ok(usd(s.r[0].fw) >= cout10 * 1.5 - 1e-9, 'facture ≥ 10 s × tarif × 1,5');
  }

  console.log('\n-- 4. fail-closed --');
  {
    const s = solde();
    const r413 = await V.repond({ addr: '0xv3', audio: Buffer.alloc(V.OCTETS_MAX + 1).toString('base64'), mime: 'audio/webm' },
      { cours: async () => cours, solde: s.o, fournit: async () => ({ texte: 'x', secondes: 1 }) });
    ok(r413.code === 413 && s.r.length === 0, 'un clip trop lourd : 413, aucune reserve, aucun appel');

    const s2 = solde();
    const r502 = await V.repond({ addr: '0xv4', audio: b64, mime: 'audio/webm' },
      { cours: async () => cours, solde: s2.o, fournit: async () => { throw new Error('rpc down'); } });
    ok(r502.code === 502 && s2.r.length === 1 && s2.r[0].fw === 0n, 'fournisseur en panne : 502, la reserve est rendue (facture 0)');

    delete process.env.VOIX_API_KEY; delete process.env.GROQ_API_KEY;
    const s3 = solde();
    const r503 = await V.repond({ addr: '0xv5', audio: b64, mime: 'audio/webm' },
      { cours: async () => cours, solde: s3.o, fournit: async () => ({ texte: 'x', secondes: 1 }) });
    ok(r503.code === 503 && !V.actif() && s3.r.length === 0, 'pas de cle : 503, inactif, aucune reserve');
    process.env.VOIX_API_KEY = 'gsk-test';
  }

  console.log('\n-- 5. etat() : ce que la page lit (actif, prix indicatif, duree max) --');
  {
    const e = V.etat(cours);
    ok(e.actif === true && e.dureeMaxS === 120 && e.prixTypiqueUsd > 0 && e.prixTypiqueSwoge > 0, 'etat : actif, 120 s max, un prix indicatif en $ et en $SWOGE');
    delete process.env.VOIX_API_KEY;
    ok(V.etat(cours).actif === false, 'sans cle : etat.actif = false (la page garde le micro navigateur)');
    process.env.VOIX_API_KEY = 'gsk-test';
  }

  faux.close();
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
