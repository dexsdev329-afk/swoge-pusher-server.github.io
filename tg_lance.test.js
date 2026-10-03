'use strict';
/* LANCER UN JETON DEPUIS TELEGRAM (03/10/2026) : /launch rend un lien a signer, avec les
   memes refus que l'agent et la page ; le jeton n'est annonce dans le chat qu'apres relecture
   du recu sur la chaine. Le vrai lancement_v4, un faux Telegram, une fausse chaine. */
const fs = require('fs'), os = require('os'), path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tglance-'));
process.env.DATA_DIR = DIR;
process.env.TG_BOT_TOKEN = 'bot-factice';
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const L = require('./lancement_v4');
const T = require('./tg_lance');
const LP = { swoge: { adresse: '0x' + 'a1'.repeat(20), fraisWei: '10000000000000000000000' }, eth: { adresse: '0x' + 'e7'.repeat(20), fraisWei: '100000000000000' } };
const JETON = '0x' + '1f'.repeat(20), POOL = '0x' + '2e'.repeat(20);

(async () => {
  console.log('-- la commande --');
  const lc = T.lisCommande;
  ok(JSON.stringify(lc('/launch Moon Dog MDOG eth')) === JSON.stringify({ name: 'Moon Dog', symbol: 'MDOG', pool: 'eth' }), '« /launch Moon Dog MDOG eth » : nom, symbole, pool ETH');
  ok(lc('/launch Moon Dog $MDOG').pool === 'swoge' && lc('/launch Moon Dog $MDOG').symbol === 'MDOG', 'sans pool : $SWOGE, et le $ du symbole tombe');
  ok(lc('/launch@SwogeBot Paw PAW weth').pool === 'eth', 'la forme /launch@SwogeBot, et « weth » vaut eth');
  ok(lc('/launch').erreur === 'usage' && lc('/launch PAW').erreur === 'usage', 'il faut un nom ET un symbole');
  ok(lc('salut') === null && lc('/launchpad') === null && lc('/id') === null, 'tout le reste n est pas la commande');

  const envois = [];
  let recu = null, jeton = { name: 'Moon Dog', symbol: 'MDOG' }, t = Date.now();
  const lis = {
    recu: async () => recu,
    lancementDe: (r, launchpad) => (r.logs || []).filter((l) => l.address === launchpad).map(() => ({ token: JETON, pool: POOL }))[0] || null,
    jeton: async () => jeton,
  };
  const P = L.cree({ launchpads: () => LP, identite: async (a, s) => (s === 'NVDA' ? { imposteur: true, symbole: 'NVDA' } : null) });
  const B = T.cree({ propose: P.propose, site: 'https://swoleeswoge.dog/', dossier: DIR, lis, envoie: async (c, x) => envois.push({ c, x }), maintenant: () => t });
  const msg = (text, chat) => ({ chat: chat || { id: -1001, type: 'supergroup' }, text });

  console.log('\n-- l offre : un lien a signer, jamais une signature --');
  const rep = await B.commande(msg('/launch Moon Dog MDOG eth'));
  const lien = (rep.match(/https:\/\/\S+/) || [])[0] || '';
  const u = new URL(lien);
  ok(u.origin + u.pathname === 'https://swoleeswoge.dog/launchpad.html' && u.searchParams.get('pool') === 'eth' && u.searchParams.get('name') === 'Moon Dog' && u.searchParams.get('symbol') === 'MDOG',
     'le lien ouvre launchpad.html, pool, nom et symbole remplis : ' + lien.slice(0, 90));
  const id = u.searchParams.get('tg');
  ok(/^[0-9a-f]{16}$/.test(id), 'et porte l identifiant de l offre (16 hex), pas le chat');
  ok(/0\.0001 ETH/.test(rep) && /own wallet/.test(rep) && /never holds keys/.test(rep), 'la reponse dit le frais, et que le joueur signe lui-meme');
  ok(!/0x[0-9a-fA-F]{64}/.test(rep) && !/private key|seed/i.test(rep), 'aucune cle, aucune phrase de recuperation demandee');
  ok(/50% of the trading fees/.test(rep) && /locked forever/.test(rep), 'et ce que le createur gagne');

  console.log('\n-- les refus : ceux de l agent et de la page --');
  ok(/^Not launched: .*copies the official Robinhood stock token NVDA/.test(await B.commande(msg('/launch Nvidia NVDA', { id: 7, type: 'private' }))), 'une copie d action tokenisee : refusee, la raison dite');
  ok(/reserved for official SWOGE/.test(await B.commande(msg('/launch Swoge Two SWOGE2', { id: 7, type: 'private' }))), 'un nom « SWOGE » : refuse');
  ok(/major asset/.test(await B.commande(msg('/launch Bitcoin BTC', { id: 8, type: 'private' }))), 'un grand ticker : refuse');
  ok(/^Launch a token/.test(await B.commande(msg('/launch', { id: 9, type: 'private' }))), '/launch seul : le mode d emploi');
  await B.commande(msg('/launch Aa AAA', { id: 10, type: 'private' })); await B.commande(msg('/launch Bb BBB', { id: 10, type: 'private' })); await B.commande(msg('/launch Cc CCC', { id: 10, type: 'private' }));
  ok(/Too many/.test(await B.commande(msg('/launch Dd DDD', { id: 10, type: 'private' }))), 'trois offres par minute et par chat, pas une de plus');
  ok(B.MESURE.offres === 4 && B.MESURE.refus === 3, 'compteurs : 4 offres, 3 refus [' + JSON.stringify(B.MESURE) + ']');

  console.log('\n-- l annonce : seulement ce que la chaine confirme --');
  const TX = '0x' + 'ab'.repeat(32);
  ok(!(await B.annonce({ tg: 'nawak', tx: TX })).ok && !(await B.annonce({ tg: id, tx: '0x12' })).ok, 'identifiant ou hash mal formes : refuses');
  ok(/not confirmed/.test((await B.annonce({ tg: id, tx: TX })).raison), 'recu absent : on attend, rien n est annonce');
  recu = { logs: [{ address: LP.swoge.adresse.toLowerCase() }] };
  ok(/expected launchpad/.test((await B.annonce({ tg: id, tx: TX })).raison), 'un lancement sur l AUTRE launchpad ne vaut pas : refuse');
  recu = { logs: [{ address: LP.eth.adresse.toLowerCase() }] };
  jeton = { name: 'Moon Dog', symbol: 'MOON' };
  ok(/does not match/.test((await B.annonce({ tg: id, tx: TX })).raison), 'un autre symbole que celui demande : refuse');
  ok(envois.length === 0, 'aucun message parti tant que la chaine ne confirme pas');
  jeton = { name: 'Moon Dog', symbol: 'MDOG' };
  const a = await B.annonce({ tg: id, tx: TX });
  ok(a.ok && a.token === JETON, 'le bon launchpad, le bon jeton : annonce');
  ok(envois.length === 1 && envois[0].c === -1001, 'dans le chat d ou venait la commande');
  ok(envois[0].x.includes('CA: ' + JETON) && envois[0].x.includes('dexscreener.com/robinhood/' + POOL) && envois[0].x.includes('gopluslabs.io/token-security/4663/' + JETON),
     'le kit : adresse, graphique, controle GoPlus');
  ok(!(await B.annonce({ tg: id, tx: TX })).ok && envois.length === 1, 'une seule fois : la meme annonce rejouee ne reposte rien');

  console.log('\n-- l offre survit a un redemarrage, puis expire --');
  const rep2 = await B.commande(msg('/launch Paw Coin PAWC', { id: 55, type: 'private' }));
  const id2 = new URL(rep2.match(/https:\/\/\S+/)[0]).searchParams.get('tg');
  const B2 = T.cree({ propose: P.propose, site: 'https://swoleeswoge.dog', dossier: DIR, lis, envoie: async (c, x) => envois.push({ c, x }), maintenant: () => t });
  jeton = { name: 'Paw Coin', symbol: 'PAWC' }; recu = { logs: [{ address: LP.swoge.adresse.toLowerCase() }] };
  t += T.ATTENTE_MS + 1000;
  ok(/no pending/.test((await B2.annonce({ tg: id2, tx: TX })).raison), 'relue apres redemarrage, mais passee deux heures : plus rien a annoncer');

  console.log('\n-- dans la boucle du bot : en groupe aussi, un message rate ne bloque rien --');
  const C = require('./tg_commandes');
  const appels = [];
  const maj = [{ update_id: 30, message: { chat: { id: -500, type: 'supergroup' }, text: '/launch Moon Pup MPUP' } },
               { update_id: 31, message: { chat: { id: -500, type: 'supergroup' }, text: '/id' } }];
  const faux = async (url, o) => { appels.push({ u: String(url), corps: o && o.body ? JSON.parse(o.body) : null });
    if (/getUpdates/.test(url)) return { ok: true, json: async () => ({ ok: true, result: maj }) };
    return { ok: true, json: async () => ({ ok: true }) }; };
  t = Date.now();
  const r = await C.tour({ prendre: faux, lanceur: B });
  const env = appels.filter((x) => /sendMessage/.test(x.u));
  ok(r.repondus === 1 && env.length === 1 && env[0].corps.chat_id === -500 && /launchpad\.html\?pool=swoge/.test(env[0].corps.text), '/launch dans un groupe : le lien y est poste ; /id y reste muet');
  ok(!env[0].corps.parse_mode, 'texte brut : un nom de jeton ne peut pas injecter de mise en forme');
  const casse = { commande: async () => { throw new Error('panne'); } };
  const r2 = await C.tour({ prendre: async (url) => (/getUpdates/.test(url) ? { ok: true, json: async () => ({ ok: true, result: [{ update_id: 40, message: { chat: { id: 1, type: 'private' }, text: '/launch A AA' } }] }) } : { ok: true, json: async () => ({ ok: true }) }), lanceur: casse });
  ok(r2.etat === 'lu' && JSON.parse(fs.readFileSync(path.join(DIR, 'tg_commandes.json'), 'utf8')).decalage === 41, 'un lanceur en panne : le decalage avance quand meme (pas de reponse rejouee en boucle)');

  console.log('\n-- la route : relue sur la chaine, bornee --');
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const i = src.indexOf("if (path === '/launchpad/v4/lance')"), bloc = src.slice(i, src.indexOf('\n  }\n', i));
  ok(i > 0 && /offreDebit\(req\)/.test(bloc) && /corps\(req, 1024\)/.test(bloc) && /tgLance\.annonce\(\{ tg: q\.tg, tx: q\.tx \}\)/.test(bloc), 'POST /launchpad/v4/lance : debit borne, corps de 1 Ko, deux champs seulement');
  ok(!/signer|Wallet\(|privateKey|MIROIR_CLE/.test(bloc) && /x\.status === 1/.test(src) && /String\(l\.address\)\.toLowerCase\(\) !== launchpad/.test(src),
     'aucune signature ; seul un recu REUSSI compte, et seul le journal emis par le launchpad de l offre');
  ok(/tgCommandes\.planifie\(\{ lanceur: tgLance \}\)/.test(src), 'le bot est arme avec le lanceur au demarrage');

  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('\nVERIFICATIONS : ' + n + (rates ? ' — ' + rates + ' RATE(S)' : ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('  RATE ' + (e.stack || e)); process.exit(1); });
