'use strict';
/* roast_token (roast.js) : le roast ne dit que des faits, le texte du modele est
   nettoye et borne, un modele muet donne un gabarit vrai, la carte et la page
   de partage se redessinent depuis le roast garde. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./roast');
const V = require('./verdict_jeton');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const ADR = '0x' + 'ab'.repeat(20);
/* La fiche au format de studio_jeton (celle que verdict_jeton juge) : Robinhood, piscine mince. */
const fiche = { marche: { chaine: 'robinhood', sym: 'LOBSTER', nom: 'Lobster', prixUsd: 0.0000084, liqUsd: 8803, mcUsd: 8253, var24h: -12.4, ageJours: 1.4, url: 'https://dexscreener.com/robinhood/0xp' },
  securite: { couverte: true, connu: true, honeypot: false, taxeAchat: 0, taxeVente: 0, codeOuvert: true } };

(async () => {
  console.log('-- les faits, et rien qu eux --');
  const v = V.juge(fiche);
  const f = R.faits(ADR, fiche, v);
  ok(f.symbol === 'LOBSTER' && f.liquidityUsd === 8803 && f.change24hPct === -12.4 && f.verdict === v.verdict && Array.isArray(f.flags),
     'les faits donnes au modele : symbole, piscine, cap, 24 h, verdict et drapeaux (' + f.flags.length + ')');
  const g = R.gabarit(ADR, f);
  ok(/\$LOBSTER/.test(g) && /\$8\.8k/.test(g) && !/scam|rug|honeypot/i.test(g), 'le gabarit d une piscine mince cite ses vrais chiffres, sans « scam » : « ' + g + ' »');
  const rouge = R.gabarit(ADR, Object.assign({}, f, { flags: ['red: flagged as a honeypot'] }));
  ok(/1 red flag: flagged as a honeypot/.test(rouge), 'un drapeau rouge : le gabarit dit ce que le drapeau dit, pas plus');
  ok(/No pool/.test(R.gabarit(ADR, { symbol: null, liquidityUsd: null, marketCapUsd: null, flags: [] })), 'aucune piscine : il le dit');
  ok(/never invent numbers/.test(R.SYSTEME) && /unless a flag in the JSON says exactly that/.test(R.SYSTEME) && /no buy or sell advice/.test(R.SYSTEME),
     'la consigne du modele : les faits seuls, pas de « scam » sans drapeau, aucun conseil');

  console.log('\n-- le texte du modele, nettoye et borne --');
  const sale = R.nettoie('"LOBSTER is weak 💪 see https://evil.example and ask @someone #rekt — lol. ' + 'Gym time. '.repeat(40) + '"');
  ok(sale.length <= R.ROAST_MAX && !/https?:|@someone|💪|#/.test(sale) && /rekt - lol/.test(sale), 'liens, @mentions, emojis et # retires, tiret ramene, ' + sale.length + ' caracteres au plus ' + R.ROAST_MAX);
  ok(R.nettoie('ok') === null && R.nettoie('') === null, 'une reponse vide ou trop courte ne sert pas');

  console.log('\n-- l outil : modele, puis modele muet --');
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'roast-'));
  let vu = null;
  const T = R.cree({ fiche: async () => fiche, juge: V.juge, api: 'https://api.example', site: 'https://site.example', dossier: dos,
    redige: async (q) => { vu = q; return { texte: 'LOBSTER runs on $8.8k of liquidity. My protein tub is deeper than this pool.', coutUsd: 0.0011 }; } });
  const r = await T.roast(ADR.toUpperCase().replace('0X', '0x'));
  ok(JSON.parse(vu.texte).symbol === 'LOBSTER' && vu.systeme === R.SYSTEME, 'le modele recoit les faits en JSON et la consigne');
  const d = r.donnees;
  ok(d.writer === 'SWOGE AI (Claude Haiku)' && /protein tub/.test(d.roast) && d.token.address === ADR && d.verdict === v.verdict, 'le roast du modele, l adresse en minuscules, le verdict des memes faits');
  ok(/^https:\/\/api\.example\/roast\/[0-9a-f]{12}\.png$/.test(d.links.card) && /^https:\/\/api\.example\/rt\/[0-9a-f]{12}$/.test(d.links.share) && r.texte.includes(d.links.share) && /never a buy or sell signal/.test(r.texte),
     'la carte et la page de partage, en donnees et dans le texte, avec la mention « jamais un signal »');
  const id = d.links.share.split('/rt/')[1];
  ok(T.lit(id) && T.lit(id).roast === d.roast && T.lit('../etc') === null && T.lit('zz') === null, 'le roast est garde, relu par son id ; un id qui n en est pas un ne lit rien');
  const png = T.carte(id);
  ok(Buffer.isBuffer(png) && png.readUInt32BE(0) === 0x89504e47 && png.readUInt32BE(16) === R.L && png.readUInt32BE(20) === R.H, 'la carte est un PNG ' + R.L + '×' + R.H + ' (' + png.length + ' octets)');
  const tx = R.textes(T.lit(id));
  ok(tx[0] === 'SWOGE ROASTS' && tx[1] === '$LOBSTER' && tx.some((x) => /entertainment, not financial advice/.test(x)) && tx.some((x) => /Verdict:/.test(x)),
     'la carte ecrit le titre, le symbole, le verdict et « entertainment, not financial advice »');
  ok(T.MESURE.parModele === 1 && Math.abs(T.MESURE.coutUsd - 0.0011) < 1e-9, 'le cout du modele est compte');
  const T2 = R.cree({ fiche: async () => fiche, juge: V.juge, api: 'https://api.example', dossier: dos, redige: async () => { throw new Error('upstream 500'); } });
  const r2 = await T2.roast(ADR);
  ok(r2.donnees.writer === 'template' && /\$LOBSTER/.test(r2.donnees.roast) && T2.MESURE.echecsModele === 1, 'le modele tombe : un gabarit tire des memes faits, et l echec compte');
  ok(T2.lit(id) && T2.lit(id).roast === d.roast, 'relu depuis son fichier par une nouvelle instance (redemarrage)');
  ok((await T.roast('0x1234')).erreur && !(await T.roast('pas une adresse')).donnees, 'une adresse invalide : refusee avant tout appel');
  const lignes = R.lignes('x '.repeat(300), 36, 784);
  ok(lignes.every((l) => require('./carte_png').largeur(l, 36, false) <= 784), 'chaque ligne tient dans la largeur de la carte');
  fs.rmSync(dos, { recursive: true, force: true });

  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
