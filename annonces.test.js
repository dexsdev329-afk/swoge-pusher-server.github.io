'use strict';
/* annonces.js : un outil nouveau → un post (tweet + image haussiere) dans Telegram,
   une fois, groupe par deploiement, espace de 3 h, sans promesse de prix ni partenariat. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./annonces');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

(async () => {
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'annonces-'));
  let horloge = Date.UTC(2026, 8, 28, 20, 0);
  let OUTILS = [{ nom: 'scan_token', description: 'Read a token', prixUsd: 0.02 }, { nom: 'roast_token', description: 'Roast a token' },
    { nom: 'find_esim_plans', description: 'Lists travel data eSIM plans' }, { nom: 'propose_esim_purchase', description: 'Shows the user one eSIM offer' }];
  const posts = [], klings = [], claudes = [];
  let reponseClaude = { tweet: '🚀 Your SWOGE AI agent now finds travel eSIMs and gets you online abroad in one tap. 📶 #SWOGE', scene: 'SWOGE surfs a wave of green charts holding a glowing phone.' };
  let klingOk = true;
  const kling = { actif: () => true, image: async (o) => { klings.push(o); return klingOk ? { ok: true, url: 'https://cdn.kling.example/img' + klings.length + '.png' } : { ok: false, raison: 'quota' }; } };
  const claude = () => ({ messages: { create: async (q) => { claudes.push(q); return { content: [{ type: 'text', text: JSON.stringify(reponseClaude) }] }; } } });
  const mk = () => A.cree({ outils: () => OUTILS, kling, claude, telegram: { notifyPhoto: (u, l) => posts.push({ u, l }) }, dossier: dos, site: 'https://swoleeswoge.dog', maintenant: () => horloge });

  console.log('\n-- le premier passage : ce qui existe est connu, sauf les outils du 28/09 jamais annonces --');
  let N = mk();
  ok((await N.tour()) === null && posts.length === 0, 'rien ne part tout de suite (on groupe 10 min)');
  const e0 = N.etat();
  ok(Object.keys(e0.attente).sort().join(',') === 'find_esim_plans,propose_esim_purchase' && e0.connus === 2, 'scan_token et roast_token : connus, pas annonces ; l eSIM : en file');
  horloge += A.GROUPE_MS;
  const r1 = await N.tour();
  ok(r1 && r1.ok && posts.length === 1 && r1.outils.length === 2, 'apres 10 min : UN post pour les deux outils du meme deploiement');
  ok(/Your SWOGE AI agent now finds travel eSIMs/.test(posts[0].l) && posts[0].l.includes('👉 ' + A.LIEN), 'le tweet de Claude, avec le lien de la page');
  ok(/<a href="https:\/\/twitter\.com\/intent\/tweet\?text=[^"]+">𝕏 Post this on X<\/a>$/.test(posts[0].l) && decodeURIComponent(posts[0].l.match(/text=([^"]+)/)[1]) === r1.tweet,
     'un lien « Post this on X » qui ouvre X avec le meme texte');
  ok(posts[0].u === 'https://cdn.kling.example/img1.png' && /very muscular/.test(klings[0].prompt) && /SWOGE surfs a wave/.test(klings[0].prompt) && /Bullish/.test(klings[0].prompt)
     && /no text/.test(klings[0].prompt) && klings[0].image === 'https://swoleeswoge.dog/img/site/swoge_reference.jpg' && klings[0].format === '16:9',
     'l image Kling : le personnage officiel, la scene de Claude, l ambiance haussiere, sans texte, format 16:9');
  ok(/find_esim_plans: Lists travel data eSIM plans/.test(claudes[0].messages[0].content) && /no "100x"/.test(claudes[0].messages[0].content), 'Claude ne lit que les descriptions, avec les interdits');

  console.log('\n-- une fois, espace, meme apres un redemarrage --');
  N = mk();
  horloge += 60e3;
  ok((await N.tour()) === null && posts.length === 1, 'redemarre : rien n est reposte');
  OUTILS = OUTILS.concat([{ nom: 'smart_money', description: 'Wallets that bought before the colony looked' }]);
  await N.tour();
  horloge += A.GROUPE_MS;
  ok((await N.tour()) === null && posts.length === 1, 'un nouvel outil 10 min plus tard : attend les 3 h depuis le dernier post');
  horloge = Date.UTC(2026, 8, 28, 20, 10) + A.ESPACE_MS;
  reponseClaude = { tweet: 'SWOGE smart money tracker is live, this token will 100x guaranteed 🚀', scene: 'SWOGE counts gold.' };
  const r2 = await N.tour();
  ok(r2.ok && posts.length === 2 && !/100x|guaranteed/.test(posts[1].l) && /New in SwogeAgentic: smart money/.test(posts[1].l), 'une promesse de gain : refusee, le gabarit sobre part a la place');

  console.log('\n-- les regles du texte --');
  ok(A.valideTweet('Big news: SWOGE × PayAI partnership is here!') === null && A.valideTweet('Our partner PayAI lists us now for everyone') === null, 'ni « × », ni partenariat');
  ok(A.valideTweet('SWOGE to the moon with the new agent tools today') === null && A.valideTweet('Buy now, the price will pump for sure after this') === null, 'ni lune, ni prix');
  ok(A.valideTweet('x'.repeat(260)) === null, 'trop long une fois le lien ajoute : refuse');
  ok(A.valideTweet('Your agent now pays other AI agents over x402, 24/7, in one step') !== null, '« x402 » n est pas un « 100x » : accepte');
  const v = A.valideTweet('Try https://evil.example now: your agent hires other AI agents!');
  ok(v && !/evil\.example/.test(v) && v.endsWith(A.LIEN), 'un lien ecrit par le modele est retire ; seul le lien de la page reste');
  ok(A.legende('<b>x</b> & y').startsWith('&lt;b&gt;x&lt;/b&gt; &amp; y'), 'le tweet est echappe dans la legende HTML de Telegram');

  console.log('\n-- les pannes --');
  OUTILS = OUTILS.concat([{ nom: 'nouveau_a', description: 'A' }]);
  horloge += A.ESPACE_MS; await N.tour(); horloge += A.GROUPE_MS;
  klingOk = false;
  reponseClaude = { tweet: 'Your agent can now do A for you, fast and simple 💪', scene: 'x' };
  const r3 = await N.tour();
  ok(r3.ok && posts[2].u === 'https://swoleeswoge.dog/img/site/swoge_reference.jpg' && N.etat().posts[0].imageRaison === 'quota', 'Kling en panne : l image officielle part, la raison est notee');
  OUTILS = OUTILS.concat([{ nom: 'nouveau_b', description: 'B' }]);
  horloge += A.ESPACE_MS; await N.tour();
  OUTILS = OUTILS.filter((o) => o.nom !== 'nouveau_b');
  horloge += A.GROUPE_MS;
  ok((await N.tour()) === null && posts.length === 3, 'un outil retire avant son annonce : plus annonce');
  process.env.ANNONCES = '0';
  OUTILS = OUTILS.concat([{ nom: 'nouveau_c', description: 'C' }]);
  horloge += A.ESPACE_MS; await N.tour(); horloge += A.GROUPE_MS;
  ok((await N.tour()) === null && posts.length === 3, 'ANNONCES=0 : rien ne part');
  delete process.env.ANNONCES;
  const M = A.cree({ outils: () => OUTILS, kling: { actif: () => false }, claude: () => null, telegram: { notifyPhoto: (u, l) => posts.push({ u, l }) }, dossier: dos, site: 'https://swoleeswoge.dog', maintenant: () => horloge });
  const r4 = await M.tour({ maintenant: true });
  ok(r4.ok && /New in SwogeAgentic: nouveau c/.test(posts[3].l), 'sans Claude ni Kling : le gabarit et l image officielle ; « maintenant » passe outre l attente');

  fs.rmSync(dos, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
