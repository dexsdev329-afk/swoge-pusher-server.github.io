'use strict';
/* ============================================================================
 * KLING ET JEV (kling.js, jev.js) — LES APPELS TELS QUE LA DOCUMENTATION LES DECRIT
 *
 * Kling : sans cle, rien ne part ; une entree refusee (texte vide ou trop long,
 * combinaison absente de la grille) ne part pas ; le chemin porte le modele
 * (nouveau standard), l'image part en base64 sans prefixe, le son n'est pas
 * reglable sur 3.0 Turbo ; l'estimation suit la grille officielle ; un refus du
 * fournisseur est rendu en texte, jamais la cle ; le suivi lit outputs[].video.
 * Jev : la requete (jev-latest, state, questions, cle en en-tete), les
 * probabilites rendues, le cout compte sur usage.input_tokens ; un echec rend
 * un motif, jamais une exception ni la cle.
 * ==========================================================================*/
const K = require('./kling');
const J = require('./jev');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const rep = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j });

(async () => {
  console.log('-- 1. Kling : ce qui ne part pas --');
  {
    let appels = 0;
    const sans = K.cree({ cle: () => '', fetch: async () => { appels++; return rep(200, {}); } });
    const r = await sans.lance({ prompt: 'a doge lifts' });
    ok(!r.ok && r.code === 503 && appels === 0, 'sans KLING_API_KEY : 503, rien n est envoye');
    const k = K.cree({ cle: () => 'cle-secrete-kling', fetch: async () => { appels++; return rep(200, { code: 0, data: { id: 'T1' } }); } });
    ok((await k.lance({ prompt: '   ' })).code === 400 && appels === 0, 'un texte vide est refuse avant tout envoi');
    ok((await k.lance({ prompt: 'x'.repeat(2501) })).code === 400, 'plus de 2 500 caracteres : refuse');
    ok((await k.lance({ prompt: 'a', modele: 'kling-2.6', duree: 7 })).code === 400, 'kling-2.6 ne fait que 5 ou 10 s');
    ok((await k.lance({ prompt: 'a', modele: 'kling-2.6', resolution: '720p', audio: 'native', duree: 5 })).code === 400, 'kling-2.6 n a pas de son natif en 720p (grille officielle)');
    ok((await k.lance({ prompt: 'a', image: 'data:text/plain;base64,QQ==' })).code === 400 && appels === 0, 'une image qui n en est pas une ne part pas');
  }

  console.log('\n-- 2. Kling : la requete et le suivi --');
  {
    const vus = [];
    const k = K.cree({ cle: () => 'cle-secrete-kling', fetch: async (u, o) => {
      vus.push({ u, o });
      if (/\/tasks\?/.test(u)) return rep(200, { code: 0, data: [{ id: 'T9', status: 'succeeded', outputs: [{ type: 'video', url: 'https://cdn.kling.example/v.mp4', duration: '5' }] }] });
      return rep(200, { code: 0, data: { id: 'T9', status: 'submitted' } });
    } });
    const r = await k.lance({ prompt: 'SWOGE lifts a barbell', image: 'data:image/png;base64,iVBORw0KGgo=', duree: 10, resolution: '1080p' });
    const b = JSON.parse(vus[0].o.body);
    ok(r.ok && r.id === 'T9' && vus[0].u === 'https://api-singapore.klingai.com/image-to-video/kling-2.6', 'avec une image : POST /image-to-video/kling-2.6 sur le domaine officiel');
    ok(vus[0].o.headers.authorization === 'Bearer cle-secrete-kling', 'la cle en en-tete Authorization, et nulle part ailleurs');
    ok(b.contents[0].type === 'prompt' && b.contents[1].type === 'first_frame' && b.contents[1].url === 'iVBORw0KGgo=', 'l image part en base64, sans le prefixe data:');
    ok(b.settings.duration === 10 && b.settings.resolution === '1080p' && b.settings.audio === 'off' && /^[0-9a-f]{24}$/.test(b.options.external_task_id), 'reglages et identifiant externe');
    ok(r.estimationUsd === 0.7, 'estimation d apres la grille : 10 s × 0,07 $ (1080p sans son) = ' + r.estimationUsd);
    const t = await k.lance({ prompt: 'a doge', modele: 'kling-3.0-turbo', duree: 6, audio: 'off' });
    const bt = JSON.parse(vus[1].o.body);
    ok(t.ok && vus[1].u.endsWith('/text-to-video/kling-3.0-turbo') && !('audio' in bt.settings) && t.audio === 'native' && t.estimationUsd === 0.672,
       '3.0 Turbo : texte seul, son toujours natif (pas de reglage envoye), 6 s × 0,112 $ = ' + t.estimationUsd);
    const e = await k.etat('T9');
    ok(e.ok && e.statut === 'succeeded' && e.url === 'https://cdn.kling.example/v.mp4' && e.duree === 5 && /task_ids=T9$/.test(vus[2].u), 'le suivi lit /tasks?task_ids= et la video rendue');
    ok((await k.etat('../x')).code === 400, 'un identifiant qui n en est pas un n est pas envoye');
    const refus = K.cree({ cle: () => 'cle-secrete-kling', fetch: async () => rep(200, { code: 1102, message: 'Account balance not enough' }) });
    const rr = await refus.lance({ prompt: 'a doge' });
    ok(!rr.ok && /balance not enough/.test(rr.raison) && !JSON.stringify(rr).includes('cle-secrete'), 'un refus du fournisseur est rendu en texte, sans la cle');
    ok(K.prixUsd('kling-2.6', '720p', 'off', 5) === 0.21, 'le moins cher : 5 s en 720p sans son, 0,21 $');
  }

  console.log('\n-- 3. Jev --');
  {
    let vu = null;
    const j = J.cree({ cle: () => 'cle-secrete-jev', fetch: async (u, o) => { vu = { u, o }; return rep(200, { model: 'jev-1.13.0',
      answers: { hausse: { type: 'noul', noul: 0.31, confidence: 0.8 } }, usage: { input_tokens: 1000, output_tokens: 3 } }); } });
    const r = await j.demande({ chain: 'Solana' }, { hausse: { type: 'noul', instructions: 'Will it rise?' } });
    const b = JSON.parse(vu.o.body);
    ok(vu.u === 'https://api.typesafe.ai/v1/systemone' && vu.o.headers.authorization === 'Bearer cle-secrete-jev' && b.model === 'jev-latest' && b.state.chain === 'Solana' && b.questions.hausse.type === 'noul',
       'la requete de la documentation : /v1/systemone, jev-latest, state, questions');
    ok(r.ok && r.answers.hausse.noul === 0.31 && Math.abs(r.coutUsd - 0.000042) < 1e-12 && j.MESURE.jetonsEntree === 1000, 'la probabilite rendue, et le cout sur les jetons d entree (1 000 × 0,042 $/M)');
    const ko = J.cree({ cle: () => 'cle-secrete-jev', fetch: async () => rep(401, { error: { message: 'invalid api key' } }) });
    const rk = await ko.demande('x', {});
    ok(!rk.ok && rk.raison === 'invalid api key' && ko.MESURE.echecs === 1 && !JSON.stringify(rk).includes('cle-secrete'), 'un refus rend son motif, jamais la cle');
    const casse = J.cree({ cle: () => 'k', fetch: async () => { throw Object.assign(new Error('boom'), { name: 'TimeoutError' }); } });
    ok((await casse.demande('x', {})).raison === 'TimeoutError', 'une panne rend un motif, pas une exception');
    let appels = 0;
    const sans = J.cree({ cle: () => '', fetch: async () => { appels++; return rep(200, {}); } });
    ok(!(await sans.demande('x', {})).ok && appels === 0, 'sans TYPESAFE_API_KEY : rien ne part');
  }

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
