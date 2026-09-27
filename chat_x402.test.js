'use strict';
/* chat_completion (chat_x402.js) : le devis borne le cout, le modele est brut,
   la sortie est au format OpenAI, un echec n'est pas regle. */
const X = require('./chat_x402');
const Chat = require('./studio_chat');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

(async () => {
  console.log('-- le devis --');
  {
    const q = { model: 'sonnet-5', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'x'.repeat(1000) }], max_tokens: 500 };
    const m = Chat.modele('sonnet-5');
    const pire = (Math.ceil(1009 / 2) + 2 * 8) * m.entree / 1e6 + 500 * m.sortie / 1e6;   /* 1 009 caracteres ASCII */
    ok(X.prixUsd(q) === Math.ceil(pire * 1.1 * 1e6) / 1e6, 'le devis = (entree a 1 jeton / 2 caracteres + enveloppe) + max_tokens, au tarif du modele, x 1,1 : ' + X.prixUsd(q) + ' $');
    process.env.X402_CHAT_MARGE = '1.3';
    ok(X.prixUsd(q) === Math.ceil(pire * 1.3 * 1e6) / 1e6, 'X402_CHAT_MARGE=1.3 : la marge suit le reglage');
    process.env.X402_CHAT_MARGE = '0.5';
    ok(X.marge() === 1.1, 'une marge sous 1 (vendre a perte) est ignoree : 1,1');
    delete process.env.X402_CHAT_MARGE;
    ok(X.prixUsd({ model: 'opus-5-5', messages: q.messages, max_tokens: 500 }) > X.prixUsd(q), 'Opus coute plus que Sonnet pour la meme demande');
    ok(X.prixUsd({}) > 0 && X.prixUsd({}) === X.prixUsd({ messages: [{ role: 'user', content: 'x' }] }), 'une demande vide (sonde d annuaire) : le devis d une ligne a ' + X.DEFAUT);
  }
  console.log('\n-- les refus (avant tout paiement) --');
  for (const [q, motif] of [[{ messages: [] }, 'messages vides'], [{ model: 'gpt-2', messages: [{ role: 'user', content: 'hi' }] }, 'modele inconnu'],
    [{ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] }, 'dernier message de l assistant'],
    [{ messages: [{ role: 'tool', content: 'x' }] }, 'role inconnu'], [{ messages: [{ role: 'user', content: 'x'.repeat(24001) }] }, '24 001 caracteres'],
    [{ messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999 }, 'max_tokens au-dela du modele'], [{ messages: [{ role: 'user', content: 'hi' }], max_tokens: 1.5 }, 'max_tokens non entier'],
    [{ messages: Array(51).fill({ role: 'user', content: 'a' }) }, '51 messages'], [{ messages: [{ role: 'user', content: [{ type: 'image' }] }] }, 'contenu non texte']]) {
    ok(!!X.lis(q).erreur, 'refuse : ' + motif + ' — ' + X.lis(q).erreur);
  }
  console.log('\n-- un appel --');
  {
    const vus = [];
    const C = X.cree({ actif: (f) => f !== 'xai', fournisseur: async (p) => { vus.push(p);
      return { texte: 'Hello there.', usage: { input_tokens: 21, output_tokens: 4 }, stop: 'end_turn', servi: 'claude-haiku-4-5' }; } });
    const r = await C.appelle({ messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'Hi' }, { role: 'user', content: 'again' }], max_tokens: 64 });
    ok(r.ok && vus[0].systeme === 'You are terse.' && vus[0].m.maxTokens === 64 && vus[0].messages.length === 1 && vus[0].messages[0].content === 'Hi\n\nagain',
       'le modele BRUT : le message systeme de l appelant, max_tokens transmis, deux messages user de suite fusionnes');
    const o = r.resultat;
    ok(o.object === 'chat.completion' && o.choices[0].message.content === 'Hello there.' && o.choices[0].finish_reason === 'stop' && o.usage.prompt_tokens === 21 && o.usage.completion_tokens === 4 && o.model === 'haiku-4-5',
       'la sortie au format OpenAI : choices, finish_reason, usage');
    const devis = X.prixUsd({ messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'Hi' }, { role: 'user', content: 'again' }], max_tokens: 64 });
    ok(r.coutUsd < devis, 'le cout reel (' + r.coutUsd.toFixed(6) + ' $) reste sous le devis paye (' + devis + ' $)');
    const g = await C.appelle({ model: 'grok-4-3', messages: [{ role: 'user', content: 'hi' }] });
    ok(!g.ok && g.code === 503 && /nothing was charged/.test(g.raison), 'un fournisseur sans cle : 503, rien regle');
  }
  {
    const C = X.cree({ fournisseur: async () => { throw new Error('upstream 500'); } });
    const r = await C.appelle({ messages: [{ role: 'user', content: 'hi' }] });
    ok(!r.ok && r.code === 502 && /nothing was charged/.test(r.raison) && C.MESURE.echecs === 1, 'le fournisseur tombe : 502, rien regle, compte');
    const V = X.cree({ fournisseur: async () => ({ texte: '', usage: { input_tokens: 10, output_tokens: 64 }, stop: 'max_tokens' }) });
    const v = await V.appelle({ model: 'sonnet-5', messages: [{ role: 'user', content: 'think hard' }], max_tokens: 64 });
    ok(!v.ok && /max_tokens reached, reasoning included/.test(v.raison) && v.coutUsd > 0, 'tout le budget passe en raisonnement, aucun texte : rien regle, et la raison dit de monter max_tokens');
  }
  console.log('\n-- le pire cas couvre --');
  {
    /* Le trou trouve par cet essai le 27/09 : compte a 1 jeton pour 2 caracteres, un texte
       chinois (~1-1,5 jeton par ideogramme) coutait plus que le devis. Hors ASCII, on compte
       les OCTETS UTF-8 : un jeton BPE en couvre au moins un, c'est une borne dure. */
    const m = Chat.modele('opus-5-5');
    const cjk = { model: 'opus-5-5', messages: [{ role: 'user', content: '漢'.repeat(8000) }], max_tokens: 16 };
    const d = X.lis(cjk);
    const coutMax = (8000 * 3 + 8) * m.entree / 1e6 + 16 * m.sortie / 1e6;       /* la borne dure : 1 jeton par octet */
    ok(d.jetons === 24000 && X.prixUsd(cjk) >= coutMax, '8 000 ideogrammes (24 000 octets) : comptes 24 000 jetons — le devis (' + X.prixUsd(cjk) + ' $) couvre meme 1 jeton par octet');
    const en = X.lis({ messages: [{ role: 'user', content: 'hello world '.repeat(100) }] });
    ok(en.jetons === 600 && en.car === 1200, 'un texte anglais : 1 200 caracteres comptes 600 jetons (la realite : ~300)');
    const mix = X.lis({ messages: [{ role: 'user', content: 'café ' }] });
    ok(mix.jetons === Math.ceil(4 / 2 + 2), 'un texte melange : « caf » et l espace a 1/2, « é » a ses 2 octets');
  }
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
