'use strict';
/*
 * L'ALERTE DE SOLDE BAS — CE QU'ELLE DIT, A QUI, ET COMBIEN DE FOIS.
 *
 * Demande du proprietaire, 09/10/2026 : « des notifs Telegram quand une de nos
 * API n'a plus beaucoup de jetons ». L'essai tient cinq promesses :
 *  1. rien n'est devine : une erreur declenche seulement si elle porte ce que
 *     la documentation du fournisseur ecrit pour un credit epuise ou une cle
 *     refusee — un 429 de DEBIT ne dit rien ;
 *  2. The Odds API et Venice : un niveau calcule sur le solde LU (pourcentage
 *     du forfait, rythme mesure), et le retour a la normale se dit ;
 *  3. ni spam ni silence : une alerte par fournisseur et par niveau par 24 h,
 *     l'aggravation part tout de suite, plafond horaire, etat sur le volume
 *     (un redeploiement ne repete rien) ;
 *  4. JAMAIS dans le canal public : notifyPrive vise TG_BACKUP_CHAT_ID seul,
 *     verifie non public, sans repli ;
 *  5. les branchements : studio_compat garde statut et code, paris_import
 *     previent d'une releve de prix refusee, et tant que server.js n'a pas
 *     configure le module, rien ne part.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'solde-'));
process.env.DATA_DIR = BAC;
process.env.TG_BOT_TOKEN = 'jeton-de-banc';
process.env.TG_CHAT_ID = '-100111';            // le canal PUBLIC
process.env.TG_BACKUP_CHAT_ID = '424242';      // le proprietaire, en prive
process.env.ODDS_API_KEY = 'cle-de-banc';
process.env.ODDS_API_TOTAL = '500';
delete process.env.ALERTE_SOLDE_ODDS_PCT;
delete process.env.ALERTE_SOLDE_VENICE_USD;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (${a} vs ${b})`); n++; };
const section = (t) => console.log('\n-- ' + t + ' --');

const AS = require('./alerte_solde');
const J = 86400000;

(async () => {
  section('1. rien n est devine : le classement suit la documentation');
  const c = (f, i) => AS.classe(f, i);
  eq(c('anthropic', { status: 400, message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing' }), 'vide', 'Anthropic : « credit balance is too low »');
  eq(c('anthropic', { status: 429, code: 'enforced_spend_limit_reached', message: 'You have reached your API usage limits' }), 'vide', 'Anthropic : plafond du palier (enforced_spend_limit_reached)');
  eq(c('anthropic', { status: 400, message: 'You have reached your specified API usage limits.' }), 'vide', 'Anthropic : plafond pose soi-meme');
  eq(c('anthropic', { status: 429, message: 'This request would exceed the rate limit for your organization' }), null, 'Anthropic : un 429 de DEBIT ne declenche rien');
  eq(c('anthropic', { status: 529, message: 'Overloaded' }), null, 'Anthropic : surcharge, rien');
  eq(c('anthropic', { status: 401, message: 'invalid x-api-key' }), 'cle', 'Anthropic : 401 = cle refusee');
  eq(c('openai', { status: 429, code: 'credit_balance_exhausted', message: 'Your organization has no prepaid credits remaining' }), 'vide', 'OpenAI : credit_balance_exhausted');
  eq(c('openai', { status: 429, type: 'insufficient_quota', message: 'You exceeded your current quota' }), 'vide', 'OpenAI : type insufficient_quota');
  eq(c('openai', { status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached for gpt on tokens per min (TPM)' }), null, 'OpenAI : 429 de debit, rien');
  eq(c('openai', { status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached. Visit https://platform.openai.com/account/billing to add a payment method.' }), null,
     'OpenAI : 429 de debit avec « billing » dans un lien d aide : rien (un mot isole ne suffit plus)');
  eq(c('openai', { status: 429, message: 'You exceeded your current quota, please check your plan and billing details.' }), 'vide', 'OpenAI : « exceeded your current quota » sans code : vide');
  eq(c('openrouter', { status: 429, message: 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day' }), null,
     'OpenRouter : 429 des modeles gratuits (« Add 10 credits ») : rien');
  eq(c('xai', { status: 400, message: 'Invalid request: balance parameter must be positive' }), null, 'xAI : un 400 qui contient « balance » sans phrase de credit : rien');
  eq(c('openrouter', { status: 402, message: 'Your account or API key has insufficient credits' }), 'vide', 'OpenRouter : 402');
  eq(c('deepseek', { status: 402, message: 'Insufficient Balance' }), 'vide', 'DeepSeek : 402');
  eq(c('mistral', { status: 402 }), 'vide', 'Mistral : 402');
  eq(c('venice', { status: 402, message: 'INSUFFICIENT_BALANCE' }), 'vide', 'Venice : 402');
  eq(c('xai', { status: 403, message: 'Your team has run out of prepaid credits' }), 'vide', 'xAI : statut non documente, message de credit');
  eq(c('xai', { status: 429, message: 'Too many requests' }), null, 'xAI : 429 sans mot de credit, rien');
  eq(c('perplexity', { status: 401 }), 'cle', 'Perplexity : 401 (cle ou credit, indistinguables)');
  eq(c('kling', { status: 429, code: 1102, message: 'Resource pack exhausted' }), 'vide', 'Kling : code 1102');
  eq(c('kling', { status: 429, code: 1303 }), null, 'Kling : 1303 (concurrence) n est pas un credit');
  eq(c('inconnu', { status: 402 }), 'vide', 'un fournisseur sans regle propre : 402 suffit (le message, lui, n existera pas : FOURNISSEURS le refuse)');

  /* les formes d'erreur reelles */
  const sdk = Object.assign(new Error('400 {"type":"error"...}'), { status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } });
  const li = AS.lisErreur(sdk);
  ok(li.status === 400 && li.type === 'invalid_request_error' && /credit balance/.test(li.message), 'erreur du SDK Anthropic lue : statut, type, message du corps');
  const sdk2 = Object.assign(new Error('429'), { status: 429, error: { error: { type: 'rate_limit_error', message: 'x', details: { error_code: 'enforced_spend_limit_reached' } } } });
  eq(AS.lisErreur(sdk2).code, 'enforced_spend_limit_reached', 'error.details.error_code du SDK lu');
  const compat = Object.assign(new Error('openai 429 — no prepaid credits'), { statut: 429, code: 'credit_balance_exhausted', type: 'insufficient_quota' });
  ok(AS.lisErreur(compat).status === 429 && AS.lisErreur(compat).code === 'credit_balance_exhausted', 'erreur de studio_compat lue (statut, code)');

  section('2. The Odds API et Venice : un niveau sur le solde LU');
  const t0 = Date.UTC(2026, 9, 9, 12);
  let r = AS.niveauOdds({ reste: 19000, utilise: 1000 }, [], t0);
  eq(r.niveau, 'ok', '19 000 sur 20 000, sans rythme mesure : ok');
  ok(/19\s?000 crédits restants sur 20\s?000 \(95 %\)/.test(r.texte), 'le texte dit le reste et le forfait (utilise + reste, lus dans les en-tetes) : ' + r.texte);
  eq(AS.niveauOdds({ reste: 3900, utilise: 16100 }, [], t0).niveau, 'bas', 'sous 20 % : bas');
  eq(AS.niveauOdds({ reste: 900, utilise: 19100 }, [], t0).niveau, 'vide', 'sous 5 % : vide');
  eq(AS.niveauOdds({ reste: 0, utilise: 20000 }, [], t0).niveau, 'vide', 'zero : vide');
  /* le rythme : 1 200 par jour, 22,5 jours jusqu'au 1er novembre = 27 000 > 15 000 restants */
  const ech = [{ t: t0 - J, utilise: 3800 }, { t: t0, utilise: 5000 }];
  r = AS.niveauOdds({ reste: 15000, utilise: 5000 }, ech, t0);
  eq(r.niveau, 'bas', 'a 75 % du forfait mais au rythme mesure (1 200/jour), le solde n atteint pas le 1er : bas');
  ok(/≈ 1\s?200 par jour/.test(r.texte) && /épuisés vers le 22\/10/.test(r.texte), 'le texte dit le rythme et la date d epuisement : ' + r.texte);
  r = AS.niveauOdds({ reste: 15000, utilise: 5000 }, [{ t: t0 - J, utilise: 4800 }, { t: t0, utilise: 5000 }], t0);
  eq(r.niveau, 'ok', 'a 200/jour, il tient jusqu au 1er : ok');
  eq(AS.niveauOdds({ reste: 15000, utilise: 5000 }, [{ t: t0 - 3600000, utilise: 4000 }, { t: t0, utilise: 5000 }], t0).parJour, null,
     'moins de six heures d echantillons : pas de rythme (une rafale de demarrage n est pas une tendance)');
  eq(AS.niveauOdds({ reste: 'x' }, [], t0), null, 'compteur illisible : rien');
  process.env.ALERTE_SOLDE_ODDS_PCT = '50';
  eq(AS.niveauOdds({ reste: 9000, utilise: 11000 }, [], t0).niveau, 'bas', 'ALERTE_SOLDE_ODDS_PCT=50 : sous 50 % c est bas');
  delete process.env.ALERTE_SOLDE_ODDS_PCT;
  eq(AS.niveauVenice('12.40').niveau, 'ok', 'Venice 12,40 $ : ok');
  eq(AS.niveauVenice('3.10').niveau, 'bas', 'Venice 3,10 $ : bas (sous 5 $)');
  eq(AS.niveauVenice('0.20').niveau, 'vide', 'Venice 0,20 $ : vide');
  eq(AS.niveauVenice(null), null, 'Venice sans en-tete : rien');

  section('3. ni spam ni silence');
  const flush = () => new Promise((r) => setImmediate(r));
  let horloge = t0;
  const recus = [];
  const D1 = fs.mkdtempSync(path.join(os.tmpdir(), 'solde-etat-'));
  const nouveau = () => AS.cree({ notifyPrive: (txt) => { recus.push(txt); return Promise.resolve(true); }, dossier: D1, maintenant: () => horloge });
  let A = nouveau();
  const err = Object.assign(new Error('openai 429'), { statut: 429, code: 'credit_balance_exhausted', message: 'Your organization has no prepaid credits remaining' });
  ok(A.erreur('openai', err), 'premier credit epuise OpenAI : une alerte');
  ok(/🛑 <b>OpenAI<\/b> — crédit épuisé/.test(recus[0]) && /credit_balance_exhausted/.test(recus[0]) && /Effet : /.test(recus[0]), 'le message nomme le fournisseur, le code et l effet : ' + recus[0].split('\n')[0]);
  horloge += 3600000;
  ok(!A.erreur('openai', err), 'une heure plus tard, meme panne : rien (une par 24 h)');
  ok(!A.erreur('openai', Object.assign(new Error('x'), { statut: 429, message: 'Rate limit reached' })), 'un 429 de debit : rien');
  A = nouveau();
  horloge += 3600000;
  ok(!A.erreur('openai', err), 'apres un REDEMARRAGE (nouvelle instance, meme volume) : toujours rien');
  horloge += J;
  ok(A.erreur('openai', err), '24 h plus tard, si ca dure : un rappel');
  eq(recus.length, 2, 'deux messages en tout pour OpenAI');
  /* un succes raccourcit le silence a une heure */
  horloge += 10 * 60000;
  ok(A.succes('openai'), 'un appel reussi apres l alerte : le silence est raccourci');
  ok(!A.erreur('openai', err), 'une panne juste apres : pas encore (une heure au moins)');
  horloge += 3600000;
  ok(A.erreur('openai', err), 'une heure apres le succes, la nouvelle panne se redit (au lieu d attendre le lendemain)');
  ok(!A.succes('deepseek'), 'un succes chez un fournisseur sans alerte : rien a ecrire');
  /* aggravation, et un moins grave apres un plus grave : rien */
  ok(A.odds({ reste: 3900, utilise: 16100 }).parti, 'Odds a 19 % : alerte « bas »');
  ok(/⚠️ <b>The Odds API<\/b> — crédit bas/.test(recus[recus.length - 1]) && /dash\.the-odds-api\.com/.test(recus[recus.length - 1]), 'le message dit ou recharger (adresse de la doc)');
  horloge += 3600000;
  ok(!A.odds({ reste: 3800, utilise: 16200 }).parti, 'toujours bas une heure plus tard : rien');
  ok(A.odds({ reste: 900, utilise: 19100 }).parti, 'passe a vide : alerte tout de suite (aggravation)');
  horloge += 3600000;
  ok(!A.oddsEvenement('refus', 'prix soccer_epl'), 'une releve refusee (« bas ») apres un « vide » du jour : rien de neuf');
  ok(!A.odds({ reste: 3000, utilise: 19100 }).parti, 'recharge partielle (15 %) : encore bas, rien');
  /* la marge pour sortir : 21 % ne suffit pas, 30 % oui */
  ok(!A.odds({ reste: 4300, utilise: 15700 }).parti && A.etat().fournisseurs.odds.mesure === 'bas', 'a 21,5 % (juste au-dessus du seuil) : toujours « bas », pas de ✅ (marge de 5 points)');
  horloge += 3600000;
  ok(A.odds({ reste: 20000, utilise: 0 }).parti, 'nouveau forfait : « revenu a la normale »');
  ok(/✅ <b>The Odds API<\/b> — revenu à la normale/.test(recus[recus.length - 1]), 'le retour se dit');
  ok(!A.odds({ reste: 19990, utilise: 10 }).parti, 'et ne se repete pas');
  horloge += 3600000;
  ok(A.odds({ reste: 500, utilise: 19500 }).parti, 'retombe a vide dans la meme journee APRES un retour annonce : alerte tout de suite');
  /* un EVENEMENT ne touche pas au niveau mesure : la cle refusee ne « revient » pas */
  const D6 = fs.mkdtempSync(path.join(os.tmpdir(), 'solde-cle-'));
  const recus6b = [];
  let h6 = t0;
  const K = AS.cree({ notifyPrive: (txt) => { recus6b.push(txt); return Promise.resolve(true); }, dossier: D6, maintenant: () => h6 });
  K.odds({ reste: 19000, utilise: 1000 });
  ok(K.oddsEvenement('cle', '401 sur /sports/soccer_epl/odds'), 'cle The Odds API refusee : alerte');
  for (let k = 0; k < 12; k++) { h6 += 30 * 60000; K.odds({ reste: 19000, utilise: 1000 }); K.oddsEvenement('cle', '401'); }
  eq(recus6b.length, 1, 'six heures de 401 et de compteur fige : UN message, aucun faux « revenu a la normale »');
  eq(A.signale('openai', 'ok', ''), false, 'signale(ok) ne fait rien : seul un solde mesure a un « retour »');
  /* l'envoi rate est annule : ni 24 h de silence, ni message « armees » perdu */
  const D8 = fs.mkdtempSync(path.join(os.tmpdir(), 'solde-rate-'));
  let telegramOk = false;
  const recus8 = [];
  const R = AS.cree({ notifyPrive: (txt) => { recus8.push(txt); return Promise.resolve(telegramOk); }, dossier: D8, maintenant: () => horloge });
  ok(R.erreur('deepseek', Object.assign(new Error('402'), { statut: 402, message: 'Insufficient Balance' })), 'DeepSeek a sec : tentative');
  ok(R.bonjour('armé'), 'message « armees » : tentative');
  await flush();
  eq(R.MESURE.rates, 2, 'Telegram a refuse les deux');
  horloge += 60000;
  telegramOk = true;
  ok(R.erreur('deepseek', Object.assign(new Error('402'), { statut: 402, message: 'Insufficient Balance' })), 'une minute plus tard, Telegram repond : l alerte part (le refus n a pas consomme 24 h)');
  ok(R.bonjour('armé'), 'et le message « armees » aussi');
  await flush();
  eq(R.MESURE.envoyees, 2, 'deux messages vraiment partis');
  ok(!R.bonjour('armé'), 'puis plus jamais');
  /* le message unique « alertes armees » */
  const recus7 = [];
  const D7 = fs.mkdtempSync(path.join(os.tmpdir(), 'solde-bonjour-'));
  ok(AS.cree({ notifyPrive: (txt) => { recus7.push(txt); return Promise.resolve(true); }, dossier: D7, maintenant: () => horloge }).bonjour('armé'), 'premier demarrage : le message « alertes armees » part');
  await flush();
  ok(!AS.cree({ notifyPrive: (txt) => { recus7.push(txt); return Promise.resolve(true); }, dossier: D7, maintenant: () => horloge }).bonjour('armé'), 'et plus jamais ensuite (redemarrages compris)');
  eq(recus7.length, 1, 'un seul');
  /* plafond horaire */
  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'solde-cap-'));
  const recus2 = [];
  const B = AS.cree({ notifyPrive: (txt) => { recus2.push(txt); return Promise.resolve(true); }, dossier: D2, maintenant: () => horloge });
  const tous = ['anthropic', 'openai', 'xai', 'openrouter', 'deepseek', 'mistral', 'venice', 'kling', 'cdp', 'payai', 'perplexity', 'odds'];
  for (const f of tous) B.signale(f, 'vide', 'essai');
  eq(recus2.length, AS.MAX_HEURE, `douze fournisseurs a sec dans la meme heure : ${AS.MAX_HEURE} messages au plus`);
  eq(B.MESURE.tues, tous.length - AS.MAX_HEURE, 'le surplus est compte');
  ok(!B.signale('inconnu', 'vide', 'x') && !B.signale('odds', 'pire', 'x'), 'fournisseur ou niveau inconnu : rien');
  /* les echantillons de rythme vivent sur le volume */
  const D3 = fs.mkdtempSync(path.join(os.tmpdir(), 'solde-ech-'));
  let h3 = t0;
  const C3 = () => AS.cree({ notifyPrive: () => Promise.resolve(true), dossier: D3, maintenant: () => h3 });
  let C = C3();
  C.odds({ reste: 19000, utilise: 1000 });
  h3 += 10 * 60000; C.odds({ reste: 18990, utilise: 1010 });
  eq(JSON.parse(fs.readFileSync(path.join(D3, 'alerte_solde.json'), 'utf8')).odds.length, 1, 'un echantillon par 25 min au plus');
  h3 += J - 10 * 60000; C = C3(); r = C.odds({ reste: 17800, utilise: 2200 });   // un jour pile apres le premier echantillon
  eq(Math.round(r.parJour), 1200, 'le rythme survit au redemarrage (echantillons sur le volume) : 1 200/jour');
  h3 += 3600000; C.odds({ reste: 20000, utilise: 0 });
  eq(JSON.parse(fs.readFileSync(path.join(D3, 'alerte_solde.json'), 'utf8')).odds.length, 1, 'le compteur recule (cle changee, remise a zero) : les echantillons repartent de zero');
  h3 += 3600000; C.odds({ reste: 70000, utilise: 30000 });
  eq(JSON.parse(fs.readFileSync(path.join(D3, 'alerte_solde.json'), 'utf8')).odds.length, 1, 'un autre forfait plus utilise (le total change) : les echantillons repartent aussi — pas de faux rythme');
  /* une cle recopiee par un fournisseur est masquee ; une cle refusee n'ecrit pas le message */
  eq(AS.masque('Incorrect API key provided: sk-proj-AB12cdEF34***wxYZ. You can find'), 'Incorrect API key provided: «clé masquée». You can find', 'un morceau de cle dans le message est masque');
  ok(!/0123456789abcdef0123456789abcdef/.test(AS.masque('apiKey=0123456789abcdef0123456789abcdef&regions=eu')), 'apiKey= et un hexadecimal de 32 signes sont masques');
  const recus9 = [];
  const M = AS.cree({ notifyPrive: (txt) => { recus9.push(txt); return Promise.resolve(true); }, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'solde-cle2-')), maintenant: () => horloge });
  M.erreur('openai', Object.assign(new Error('Incorrect API key provided: sk-proj-AB12cdEF34xx'), { statut: 401 }));
  ok(recus9.length === 1 && /HTTP 401/.test(recus9[0]) && !/sk-proj|Incorrect/.test(recus9[0]), 'cle refusee : statut seulement, rien du message du fournisseur');
  /* un credit vide garde le message du fournisseur (il dit quoi faire) : la cle qu'il recopie est masquee dans l'ALERTE, pas seulement par masque() */
  M.erreur('openrouter', Object.assign(new Error('Insufficient credits for key sk-or-v1-9f8e7d6c5b4a. Add more at openrouter.ai/settings/credits'), { statut: 402 }));
  ok(recus9.length === 2 && /Insufficient credits/.test(recus9[1]) && /«clé masquée»/.test(recus9[1]) && !/9f8e7d6c5b4a/.test(recus9[1]), 'credit vide : le message part, la cle recopiee y est masquee : ' + (recus9[1] || '').split('\n')[1]);
  /* la regle des 24 h porte sur la GRAVITE, pas sur le meme niveau : un « bas » apres un « vide » du jour ne part pas, meme si aucun « bas » n'a jamais ete envoye */
  const G = AS.cree({ notifyPrive: () => Promise.resolve(true), dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'solde-grav-')), maintenant: () => horloge });
  ok(G.oddsEvenement('vide', 'OUT_OF_USAGE_CREDITS sur /sports/soccer_epl/odds'), 'The Odds API a sec (OUT_OF_USAGE_CREDITS) : alerte « vide »');
  ok(!G.oddsEvenement('refus', 'prix soccer_epl — 0 restants'), 'puis une releve refusee (« bas ») : rien, le « vide » du jour l a deja dit');

  section('4. jamais dans le canal public');
  const cfg = require('./config');
  const tg = require('./telegram');
  const envois = [];
  const fetchVrai = global.fetch;
  let getChats = 0;
  const chats = { '424242': { ok: true, result: { id: 424242, type: 'private' } },
                  '424243': { ok: true, result: { id: 424243, type: 'private', username: 'proprio' } },
                  '777': { ok: true, result: { id: 777, type: 'supergroup', username: 'swogechat' } },
                  '888': { ok: true, result: { id: 888, type: 'group' } },
                  '889': { ok: true, result: { id: 889, type: 'supergroup' } },
                  /* le canal des annonces SANS @nom : seul « egal a TG_CHAT_ID » l'arrete */
                  '-100111': { ok: true, result: { id: -100111, type: 'supergroup' } } };
  let trouble = 0;
  global.fetch = async (u, o) => {
    const url = String(u);
    if (/\/getChat\?/.test(url)) {
      getChats++;
      const id = decodeURIComponent(url.split('chat_id=')[1]);
      if (id === '555' && trouble-- > 0) return { json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests' }) };
      if (id === '555') return { json: async () => ({ ok: true, result: { id: 555, type: 'private' } }) };
      return { json: async () => chats[id] || { ok: false, error_code: 400, description: 'chat not found' } };
    }
    if (/\/sendMessage$/.test(url)) { envois.push(JSON.parse(o.body)); return { json: async () => ({ ok: true }) }; }
    throw new Error('appel inattendu ' + url);
  };
  try {
    ok(await tg.notifyPrive('<b>essai</b>'), 'conversation privee du proprietaire : envoye');
    eq(envois.length, 1, 'un message');
    eq(String(envois[0].chat_id), '424242', 'vers TG_BACKUP_CHAT_ID, jamais TG_CHAT_ID');
    cfg.TG_BACKUP_CHAT_ID = '424243';
    ok(await tg.notifyPrive('x'), 'un proprietaire qui a un @nom : sa conversation privee reste privee, envoye');
    ok(!(await tg.chatEstPublic('424243')), 'et la sauvegarde l accepte aussi (le @nom d une personne n ouvre pas son chat)');
    ok(await tg.chatEstPublic('777'), 'un supergroupe a @nom reste public pour la sauvegarde');
    cfg.TG_BACKUP_CHAT_ID = '777';
    ok(!(await tg.notifyPrive('x')), 'un canal qui porte un @nom (joignable par tous) : rien');
    cfg.TG_BACKUP_CHAT_ID = '888';
    ok(!(await tg.notifyPrive('x')), 'un groupe SANS @nom : rien non plus (pas une conversation privee)');
    cfg.TG_BACKUP_CHAT_ID = '889';
    ok(!(await tg.notifyPrive('x')), 'un supergroupe sans @nom : rien');
    cfg.TG_BACKUP_CHAT_ID = cfg.TG_CHAT_ID;
    const getChatsAvant = getChats;
    ok(!(await tg.notifyPrive('x')), 'TG_BACKUP_CHAT_ID egal au canal public : rien');
    eq(getChats, getChatsAvant, 'refuse avant meme de demander a Telegram : le canal public ne depend pas d une reponse de getChat');
    cfg.TG_BACKUP_CHAT_ID = '';
    ok(!(await tg.notifyPrive('x')), 'sans canal prive : rien, et surtout pas de repli sur le canal public');
    eq(tg.journal().derniers[0].code, 'config', 'refuse parce qu il MANQUE un canal prive (code « config »), pas parce que le repli serait public');
    cfg.TG_BACKUP_CHAT_ID = '999';
    ok(!(await tg.notifyPrive('x')), 'un chat que Telegram ne connait pas : rien (dans le doute, on s abstient)');
    eq(envois.length, 2, 'aucun autre message n est parti');
    /* un getChat passager (429) n'est pas garde */
    cfg.TG_BACKUP_CHAT_ID = '555';
    trouble = 1;
    ok(!(await tg.notifyPrive('x')), 'getChat en 429 : rien ce coup-ci');
    ok(await tg.notifyPrive('x'), 'la fois suivante, Telegram repond : envoye (le 429 n a pas ete garde comme « public »)');
    const j = tg.journal().derniers.filter((x) => x.route === 'prive');
    ok(j.length >= 9 && j.some((x) => x.code === 'public') && j.some((x) => x.code === 'config'), 'chaque refus est au carnet du bot (route « prive », /tg/journal)');
  } finally { global.fetch = fetchVrai; cfg.TG_BACKUP_CHAT_ID = '424242'; }
  ok(getChats > 0, 'getChat interroge');

  section('5. les branchements');
  AS.reinitialise();
  eq(AS.erreur('openai', err), false, 'tant que server.js n a pas configure le module : rien ne part (essais, ligne de commande)');
  const recus5 = [];
  AS.configure({ notifyPrive: (txt) => { recus5.push(txt); return Promise.resolve(true); }, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'solde-br-')) });
  /* studio_compat garde statut et code : OpenAI a sec */
  process.env.OPENAI_API_KEY = 'cle-de-banc';
  const compatMod = require('./studio_compat');
  global.fetch = async () => ({ ok: false, status: 429, body: null, headers: { get: () => null },
    json: async () => ({ error: { message: 'Your organization has no prepaid credits remaining', type: 'insufficient_quota', code: 'credit_balance_exhausted' } }) });
  let leve = null;
  try { await compatMod.repond({ m: { id: 'gpt', api: 'gpt-x', fournisseur: 'openai', maxTokens: 10 }, messages: [{ role: 'user', content: 'hi' }] }); }
  catch (e) { leve = e; } finally { global.fetch = fetchVrai; }
  ok(leve && leve.statut === 429 && leve.code === 'credit_balance_exhausted' && leve.type === 'insufficient_quota', 'studio_compat leve une erreur qui garde statut, code et type');
  ok(AS.erreur('openai', leve) && /credit_balance_exhausted/.test(recus5[recus5.length - 1]), 'et l alerte la classe « credit epuise »');
  /* Venice : l'en-tete de solde lu sur chaque reponse */
  process.env.VENICE_API_KEY = 'cle-de-banc';
  global.fetch = async () => ({ ok: false, status: 500, body: null, headers: { get: (h) => (h === 'x-venice-balance-usd' ? '1.75' : null) }, json: async () => ({}) });
  try { await compatMod.repond({ m: { id: 'v', api: 'venice-x', fournisseur: 'venice', maxTokens: 10 }, messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { /* attendu */ }
  finally { global.fetch = fetchVrai; }
  ok(/<b>Venice<\/b> — crédit bas/.test(recus5[recus5.length - 1]) && /1\.75 \$/.test(recus5[recus5.length - 1]), 'Venice a 1,75 $ (en-tete x-venice-balance-usd) : alerte « bas »');
  /* paris_import : une releve de PRIX refusee par le garde-fou */
  const imp = require('./paris_import');
  const jour = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(BAC, 'odds_quota.json'), JSON.stringify({ reste: 10, utilise: 490, depenseDuJour: 10, jour, vu: null }));
  const avant = recus5.length;
  let refus = null;
  try { imp.autorise(1, 'prix soccer_epl', 17); } catch (e) { refus = e; }
  ok(refus && /REFUSE/.test(refus.message), 'le garde-fou refuse la releve (part du jour atteinte, priorite impossible)');
  ok(recus5.length === avant + 1 && /The Odds API<\/b> — crédit bas/.test(recus5[recus5.length - 1]) && /relève de PRIX a été refusée/.test(recus5[recus5.length - 1]),
     'et le proprietaire est prevenu : une releve de PRIX refusee');
  const recus6 = [];
  AS.configure({ notifyPrive: (txt) => { recus6.push(txt); return Promise.resolve(true); }, dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'solde-etal-')) });
  let refus2 = null;
  try { imp.autorise(1, 'odds basketball_nba', undefined); } catch (e) { refus2 = e; }
  ok(refus2 && /REFUSE/.test(refus2.message) && recus6.length === 0, 'un etalonnage refuse (non prioritaire) n est pas une alerte');
  AS.reinitialise();

  console.log(`\nalerte_solde.test.js : ${n} verifications OK`);
})().catch((e) => { console.error(e); process.exit(1); });
