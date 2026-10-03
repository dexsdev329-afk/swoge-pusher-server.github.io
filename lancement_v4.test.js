'use strict';
/* lancement_v4.js : l'agent PREPARE un lancement, le joueur le signe avec son portefeuille. Le
   serveur ne signe rien ; il refuse les copies d'actions, les symboles reserves, « SWOGE », les
   liens douteux, et ne propose qu'un launchpad dont les parametres ont ete relus sur la chaine. */
const L = require('./lancement_v4');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const SW = '0x6532C42aF1241cbbC14F00D2B7D531Aa61469392', ETHLP = '0xEfD0fd35c3d308713226E9366A96701B9F040c9e';
const SWOGE = '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817';
const pads = { swoge: { adresse: SW, fraisWei: '10000000000000000000000', swoge: SWOGE }, eth: { adresse: ETHLP, fraisWei: '100000000000000' } };
/* la liste officielle simulee : NVDA et « NVIDIA » sont des actions tokenisees */
const identite = async (a, s, nom) => (s === 'NVDA' || /^nvidia$/i.test(nom || '') ? { imposteur: true, symbole: 'NVDA' } : null);

(async () => {
  const t0 = 1_800_000_000_000;
  const P = L.cree({ launchpads: () => pads, identite, maintenant: () => t0 });

  console.log('-- 1. une offre correcte, sur chaque pool --');
  let r = await P.propose({ name: 'Moon Dog', symbol: '$mdog', pool: 'swoge', website: 'https://moondog.xyz', twitter: '@moondog', telegram: 'moondogchat' });
  ok(r.ok && r.offre.symbol === 'MDOG' && r.offre.launchpad === SW && r.offre.feeToken === 'SWOGE' && r.offre.fee === 10000 && r.offre.feeGoesTo === 'burned' && r.offre.swoge === SWOGE,
     'pool $SWOGE : le launchpad relu, 10 000 $SWOGE brules, l adresse du $SWOGE pour l autorisation');
  ok(r.offre.twitter === 'https://x.com/moondog' && r.offre.telegram === 'https://t.me/moondogchat' && r.offre.website === 'https://moondog.xyz/', 'un @pseudo devient son lien x.com / t.me');
  ok(/^0x[0-9a-f]{64}$/.test(r.offre.salt) && r.offre.chainId === 4663 && r.offre.expire === t0 + 15 * 60e3, 'un sel CREATE2 aleatoire, Robinhood Chain, 15 minutes de validite');
  const r2 = await P.propose({ name: 'Moon Dog', symbol: 'MDOG', pool: 'ETH' });
  ok(r2.ok && r2.offre.launchpad === ETHLP && r2.offre.feeToken === 'ETH' && r2.offre.fee === 0.0001 && r2.offre.feeWei === '100000000000000' && r2.offre.feeGoesTo === 'treasury' && r2.offre.swoge === null,
     'pool ETH : 0,0001 ETH exactement, au tresor');
  ok(r2.offre.salt !== r.offre.salt, 'deux offres, deux sels');

  console.log('\n-- 2. ce qui est refuse --');
  const refuse = async (e, re, m) => { const x = await P.propose(e); ok(!x.ok && re.test(x.raison), m + ' — « ' + (x.raison || '(accepte !)') + ' »'); };
  await refuse({ name: 'X', symbol: 'XX' }, /choose the pool/, 'sans pool : on demande de choisir');
  await refuse({ name: 'Nvidia', symbol: 'NVDX', pool: 'swoge' }, /copies the official Robinhood stock token NVDA/, 'le NOM d une action tokenisee');
  await refuse({ name: 'Green chips', symbol: 'NVDA', pool: 'eth' }, /copies the official Robinhood stock token NVDA/, 'le SYMBOLE d une action tokenisee');
  await refuse({ name: 'Bitcoin 2', symbol: 'BTC', pool: 'eth' }, /major asset/, 'le symbole d un grand actif');
  await refuse({ name: 'Baby Swoge', symbol: 'BSW', pool: 'eth' }, /reserved for official SWOGE/, '« SWOGE » dans le nom');
  await refuse({ name: 'Other', symbol: 'SWOGE2', pool: 'eth' }, /reserved for official SWOGE/, '« SWOGE » dans le symbole');
  await refuse({ name: 'Ok', symbol: 'A', pool: 'eth' }, /2 to 10 letters/, 'un symbole d une lettre');
  await refuse({ name: 'Ok', symbol: 'TOO-LONG!', pool: 'eth' }, /2 to 10 letters/, 'un symbole avec des signes');
  await refuse({ name: 'visit https://scam.io', symbol: 'SCAM', pool: 'eth' }, /cannot contain a link/, 'un lien cache dans le nom');
  await refuse({ name: 'Ok', symbol: 'OKK', pool: 'eth', website: 'http://plain.io' }, /website link must be an https/, 'un site en http');
  await refuse({ name: 'Ok', symbol: 'OKK', pool: 'eth', website: 'javascript:alert(1)' }, /website link must be an https/, 'un lien javascript:');

  console.log('\n-- 3. la liste officielle ou le launchpad indisponibles : on refuse, on ne devine pas --');
  const P2 = L.cree({ launchpads: () => pads, identite: async () => { throw new Error('rpc'); } });
  const x = await P2.propose({ name: 'Fine', symbol: 'FINE', pool: 'eth' });
  ok(!x.ok && /official stock token list could not be read/.test(x.raison), 'liste des actions illisible : refus (pas de lancement a l aveugle)');
  const P3 = L.cree({ launchpads: () => ({ swoge: pads.swoge, eth: null }), identite });
  const y = await P3.propose({ name: 'Fine', symbol: 'FINE', pool: 'eth' });
  ok(!y.ok && /ETH pool launchpad is not available/.test(y.raison), 'launchpad ETH pas relu : aucune offre sur une adresse devinee');
  const P4 = L.cree({ launchpads: () => ({ swoge: { adresse: 'pas une adresse', fraisWei: '1' } }), identite });
  ok(!(await P4.propose({ name: 'Fine', symbol: 'FINE', pool: 'swoge' })).ok, 'adresse de launchpad malformee : refus');

  ok(P.MESURE.offres === 2 && P.MESURE.copies === 2 && P.MESURE.refusees === 11, 'les compteurs : 2 offres, 2 copies refusees, 11 refus');

  console.log('\n-- 4. dans l agent : offert au joueur seulement, la carte passe au champ « lancement » --');
  const A = require('./studio_agent');
  ok(A.definitions(A.actifsDe({ joueur: true, lancements: P })).some((d) => d.name === 'propose_token_launch')
     && !A.definitions(A.actifsDe({ lancements: P })).some((d) => d.name === 'propose_token_launch'),
     'propose_token_launch est offert a la page du joueur, jamais a l API (ask_agent)');
  ok(/Proposing launches nothing: the user signs with their own wallet/.test(A.systemeDe({ joueur: true, lancements: P })) && !/propose_token_launch/.test(A.systemeDe({})),
     'la consigne dit que proposer ne lance rien, et n apparait que si l outil est offert');
  const O = A.outils({ joueur: true, lancements: P });
  const bon = await O.propose_token_launch({ name: 'Moon Dog', symbol: 'MDOG', pool: 'eth' });
  ok(bon.lancement && bon.lancement.launchpad === ETHLP && /Nothing is launched yet/.test(bon.texte) && /Do not say it is launched/.test(bon.texte),
     'l outil rend la carte (champ lancement) et dit a l agent que rien n est lance');
  const mauvais = await O.propose_token_launch({ name: 'Nvidia', symbol: 'NVDA', pool: 'eth' });
  ok(mauvais.erreur && /copies the official Robinhood stock token/.test(mauvais.erreur) && !mauvais.lancement, 'une copie : une erreur pour l agent, AUCUNE carte');
  const src = require('fs').readFileSync(require('path').join(__dirname, 'studio_agent.js'), 'utf8');
  ok(/achat: r\.achat \|\| null, lancement: r\.lancement \|\| null,/.test(src), 'la boucle transmet la carte a la page avec le resultat de l outil');

  console.log('\n-- 5. la page du launchpad (03/10) : la route /launchpad/v4/offre --');
  /* « Je vois pas le bouton pour choisir un pool WETH ou $SWOGE. » La page passe par le MEME propose :
     memes refus que l'agent. La route ne signe rien, ne lit aucune session, et ne transmet que les
     six champs connus (jamais l'objet recu tel quel : un « launchpad » ou un « feeWei » glisse dans
     la requete ne doit pas atteindre l'offre). */
  const srv = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8');
  const i = srv.indexOf("if (path === '/launchpad/v4/offre')"), bloc = i < 0 ? '' : srv.slice(i, srv.indexOf('\n  }\n', i));
  ok(i > 0, 'la route existe');
  ok(/req\.method !== 'POST'/.test(bloc) && /!offreDebit\(req\)\) return json\(429/.test(bloc), 'POST seulement, 20 par minute et par IP (offreDebit)');
  ok(/corps\(req, 4096\)/.test(bloc), 'corps borne a 4 Ko');
  ok(/lancementV4\.propose\(\{ pool: q\.pool, name: q\.name, symbol: q\.symbol, website: q\.website, twitter: q\.twitter, telegram: q\.telegram \}\)/.test(bloc),
     'seuls les six champs connus passent a propose');
  ok(!/signer|Wallet|privateKey|MIROIR_CLE|sessionDe|ws\.addr/.test(bloc), 'aucune signature, aucune cle, aucune session dans la route');
  const triche = await P.propose({ pool: 'eth', name: 'Moon Dog', symbol: 'MDOG', launchpad: '0x' + '9'.repeat(40), feeWei: '1' });
  ok(triche.ok && triche.offre.launchpad === ETHLP && triche.offre.feeWei !== '1', 'meme passe tel quel, propose ignore un launchpad ou un frais venus de la requete');

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  ' + rates + ' RATE(S)' : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
