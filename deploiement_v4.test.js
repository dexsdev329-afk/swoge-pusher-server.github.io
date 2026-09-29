'use strict';
/* deploiement_v4.js : le portefeuille dedie deploie le launchpad V4 une fois, RELIT ses
   parametres sur la chaine, lance un jeton de test, lit GoPlus — et rien d'autre. Une
   transaction partie n'est jamais renvoyee apres un redemarrage ; des parametres faux
   arretent tout ; la cle ne sort jamais. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('./deploiement_v4');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

const A = JSON.parse(fs.readFileSync(path.join(__dirname, 'swogefun_v4.json'), 'utf8'));
const FRAIS = BigInt(A.constructeur.creationFeeWei);
const LP = '0x' + 'a'.repeat(40), JETON = '0x' + 'b'.repeat(40), POOL = '0x' + 'c'.repeat(40);

function monde(o) {
  o = o || {};
  const w = { eth: 0n, swoge: 0n, jet: 0n, envoyees: [], recus: {}, faux: !!o.faux, nRouteur: 0 };
  w.chaine = () => ({
    adresse: '0x' + 'd'.repeat(40),
    soldeEth: async () => w.eth, soldeSwoge: async () => w.swoge,
    deploieLaunchpad: async (args) => { w.envoyees.push(['deploie', args]); return { hash: '0xdep' }; },
    recu: async (h) => w.recus[h] || null,
    parametres: async () => ({ positionManager: w.faux ? A.constructeur.swoge : A.constructeur.positionManager, swoge: A.constructeur.swoge, treasury: A.constructeur.treasury, creationFee: A.constructeur.creationFeeWei }),
    autoriseFrais: async (lp, m) => { w.envoyees.push(['autorise', lp, m]); return { hash: '0xapp' }; },
    lanceTest: async (lp, p) => { w.envoyees.push(['lance', lp, p]); return { hash: '0xlan' }; },
    soldeJeton: async (j) => { w.envoyees.push(['lecture', j]); return w.jet; },
    autoriseRouteur: async (j, m) => { w.envoyees.push(['routeur', j, m]); return { hash: '0xra' + (++w.nRouteur) }; },
    devis: async (a, b, m) => (b === JETON ? 98457n * 10n ** 18n : 490n * 10n ** 18n),
    echange: async (a, b, m, min) => { w.envoyees.push(['echange', a, b, m, min]); return { hash: b === JETON ? '0xach' : '0xven' }; },
    lancementDe: (r) => (r.logs && r.logs.length ? { token: JETON, pool: POOL } : null),
  });
  return w;
}

(async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'dep4-'));
  const w = monde();
  const goplus = { external_call: '0', owner_address: '0x0000000000000000000000000000000000000000', is_open_source: '1', secret: 'x' };
  const mk = () => D.cree({ dossier, artefact: A, chaine: w.chaine, lis: async () => ({ result: { [JETON]: goplus } }), maintenant: () => Date.now() });

  console.log('-- 1. sans fonds, rien ne part --');
  let d = mk(); d.charge();
  await d.tour();
  ok(w.envoyees.length === 0 && d.etat().step === 'attente_fonds', 'aucune transaction sans ETH');
  ok(d.etat().needs.eth === 0.002 && d.etat().needs.swogeForTestLaunch === 10000 && d.etat().deployer === '0x' + 'd'.repeat(40), 'la page dit l adresse a financer et ce qu il faut : 0,002 ETH et 10 000 $SWOGE');

  console.log('\n-- 2. le deploiement, et un redemarrage au milieu --');
  w.eth = D.ETH_MIN_WEI;
  await d.tour();
  const dep = w.envoyees.filter((x) => x[0] === 'deploie');
  ok(dep.length === 1 && dep[0][1][0] === A.constructeur.positionManager && dep[0][1][1] === A.constructeur.swoge && dep[0][1][2] === A.constructeur.treasury && dep[0][1][3] === FRAIS,
     'le launchpad part avec les quatre parametres decides, dans le bon ordre');
  ok(d._etat().etape === 'deploiement' && JSON.parse(fs.readFileSync(path.join(dossier, 'deploiement_v4.json'), 'utf8')).txDeploiement === '0xdep', 'le hash est ECRIT avant d attendre la confirmation');
  d = mk(); d.charge();                                   /* redemarrage : la transaction n'est pas minee */
  await d.tour(); await d.tour();
  ok(w.envoyees.filter((x) => x[0] === 'deploie').length === 1, 'apres un redemarrage, la MEME transaction est attendue — jamais une seconde');
  w.recus['0xdep'] = { status: 1, contractAddress: LP };
  await d.tour();
  ok(d.etat().step === 'deploye' && d.etat().launchpad === LP && d.etat().parametersReadBack.treasury === A.constructeur.treasury, 'mine : les parametres sont RELUS sur la chaine et justes');

  console.log('\n-- 3. le jeton de test --');
  await d.tour();
  ok(!w.envoyees.some((x) => x[0] === 'autorise'), 'sans les 10 000 $SWOGE du frais : on attend');
  w.swoge = FRAIS;
  await d.tour();
  ok(w.envoyees.some((x) => x[0] === 'autorise' && x[1] === LP && x[2] === FRAIS), 'l autorisation porte sur le frais exact, pour le launchpad deploye');
  w.recus['0xapp'] = { status: 1 };
  await d.tour();
  const l = w.envoyees.find((x) => x[0] === 'lance');
  ok(l && l[1] === LP && l[2].symbol === 'SWV4TEST' && /^0x[0-9a-f]{64}$/.test(l[2].salt), 'le jeton de test part, avec un sel aleatoire');
  w.recus['0xlan'] = { status: 1, logs: [{}] };
  w.swoge = 0n;                                           /* le frais est parti (le faux nœud ne debite pas seul) */
  await d.tour();
  const e = d.etat();
  ok(e.step === 'jeton_test' && e.testToken === JETON && e.testPool === POOL, 'le jeton de test et son pool sont enregistres');
  ok(e.goplus && e.goplus.external_call === '0' && !('secret' in e.goplus) && e.goplusReadAt, 'GoPlus est relu, seulement les champs utiles');
  ok(w.envoyees.length === 3, 'jusqu au jeton de test : trois transactions, jamais davantage');

  console.log('\n-- 3c. l achat de listage : 1 000 $SWOGE achetes, la moitie revendue (confirme par le proprietaire le 29/09) --');
  const tx = () => w.envoyees.filter((x) => x[0] !== 'lecture');
  w.swoge = 999n * 10n ** 18n;
  await d.tour();
  ok(tx().length === 3 && d.etat().step === 'jeton_test', 'sous 1 000 $SWOGE : aucun achat, on attend');
  w.swoge = 20000n * 10n ** 18n;
  await d.tour();
  const ar = tx()[3];
  ok(ar && ar[0] === 'routeur' && ar[1] === A.constructeur.swoge && ar[2] === 1000n * 10n ** 18n && d.etat().step === 'appro_achat', 'd abord l autorisation du routeur : 1 000 $SWOGE exactement, pas un de plus');
  d = mk(); d.charge();                                   /* redemarrage : l'autorisation n'est pas minee */
  await d.tour(); await d.tour();
  ok(tx().filter((x) => x[0] === 'routeur').length === 1, 'apres un redemarrage, la MEME autorisation est attendue — jamais une seconde');
  w.recus['0xra1'] = { status: 1 };
  await d.tour();
  const ach = tx().find((x) => x[0] === 'echange' && x[2] === JETON);
  ok(ach && ach[1] === A.constructeur.swoge && ach[3] === 1000n * 10n ** 18n && ach[4] === 98457n * 10n ** 18n * 9500n / 10000n,
     'l achat : $SWOGE -> jeton de test, 1 000, minimum 95 % du devis du quoter');
  ok(ach.length === 5, 'l echange ne recoit AUCUN destinataire : il est fixe dans chaineEthers (le portefeuille lui-meme)');
  w.jet = 98000n * 10n ** 18n;
  w.recus['0xach'] = { status: 1 };
  await d.tour();
  const av = tx()[5];
  ok(av && av[0] === 'routeur' && av[1] === JETON && av[2] === 49000n * 10n ** 18n, 'puis l autorisation de revendre la MOITIE des jetons recus');
  w.recus['0xra2'] = { status: 1 };
  await d.tour();
  const ven = tx().find((x) => x[0] === 'echange' && x[2] === A.constructeur.swoge);
  ok(ven && ven[1] === JETON && ven[3] === 49000n * 10n ** 18n && ven[4] === 490n * 10n ** 18n * 9500n / 10000n, 'la revente : jeton de test -> $SWOGE, la moitie, minimum 95 % du devis');
  w.recus['0xven'] = { status: 1 };
  goplus.is_in_dex = '1';
  const avantGp = d.etat().goplusReadAt;
  await d.tour();
  const e2 = d.etat();
  ok(e2.step === 'liste' && /\/tx\/0xach$/.test(e2.links.buyTx) && /\/tx\/0xven$/.test(e2.links.sellTx), 'fini : etape « liste », les deux echanges ont leur lien');
  await d.tour(); await d.tour();
  ok(tx().length === 7, 'en tout : sept transactions, et plus rien ensuite');
  ok(tx().every((x) => x[0] !== 'echange' || [A.constructeur.swoge, JETON].includes(x[1]) && [A.constructeur.swoge, JETON].includes(x[2])), 'seuls $SWOGE et le jeton de test sont echanges');
  const d6 = D.cree({ dossier, artefact: A, chaine: w.chaine, lis: async () => ({ result: { [JETON]: goplus } }), maintenant: () => Date.now() + 31 * 60e3 });
  d6.charge(); await d6.tour();
  ok(d6.etat().goplus.is_in_dex === '1' && d6.etat().goplusReadAt !== avantGp, 'GoPlus est encore relu toutes les 30 min apres le listage');

  console.log('\n-- 3b. le seuil suit le cout estime par le nœud (29/09 : 0,0005 ETH envoyes, 0,000111 estime) --');
  {
    const dossier4 = fs.mkdtempSync(path.join(os.tmpdir(), 'dep4-'));
    const w4 = monde(); const base = w4.chaine;
    let cout = 111120110190000n;                       /* 5 314 209 gaz x 0,02091 gwei, mesure du 29/09 */
    w4.chaine = () => Object.assign(base(), { coutDeploiement: async () => cout });
    const d4 = D.cree({ dossier: dossier4, artefact: A, chaine: w4.chaine });
    w4.eth = 150000000000000n;                         /* 0,00015 ETH : moins que 1,5 x le cout */
    await d4.tour();
    ok(w4.envoyees.length === 0 && d4.etat().needs.estimated && Math.abs(d4.etat().needs.eth - 0.00016668) < 1e-7, 'sous 1,5 x le cout estime : on attend, et la page dit le vrai besoin (0,000167 ETH)');
    w4.eth = 500000000000000n;                         /* 0,0005 ETH : l'envoi du proprietaire */
    await d4.tour();
    ok(w4.envoyees.length === 1 && w4.envoyees[0][0] === 'deploie', '0,0005 ETH couvrent le deploiement : il part, sans attendre les 0,002 d avant');
    const d5 = D.cree({ dossier: fs.mkdtempSync(path.join(os.tmpdir(), 'dep4-')), artefact: A, chaine: () => Object.assign(monde().chaine(), { soldeEth: async () => 500000000000000n, coutDeploiement: async () => { throw new Error('rpc'); } }) });
    await d5.tour();
    ok(d5._etat().etape === 'attente_fonds', 'si l estimation echoue, on retombe sur le seuil prudent (0,002 ETH) : pas de depart a l aveugle');
    fs.rmSync(dossier4, { recursive: true, force: true });
  }

  console.log('\n-- 4. des parametres faux arretent tout --');
  {
    const dossier2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dep4-'));
    const w2 = monde({ faux: true }); w2.eth = D.ETH_MIN_WEI; w2.swoge = FRAIS;
    const d2 = D.cree({ dossier: dossier2, artefact: A, chaine: w2.chaine });
    await d2.tour(); w2.recus['0xdep'] = { status: 1, contractAddress: LP }; await d2.tour(); await d2.tour();
    ok(d2.etat().step === 'erreur' && /WRONG PARAMETERS/.test(d2.etat().error) && !w2.envoyees.some((x) => x[0] !== 'deploie'),
       'le piege deja vecu (deux adresses inversees) : erreur, et AUCUN lancement sur ce contrat');
    fs.rmSync(dossier2, { recursive: true, force: true });
  }

  console.log('\n-- 4b. le jumeau WETH : cinq parametres, WETH relu, pas d achat de listage, attend le V4 --');
  {
    const AW = JSON.parse(fs.readFileSync(path.join(__dirname, 'swogefun_v4weth.json'), 'utf8'));
    const PW = AW.constructeur;
    ok(AW.contrat === 'SwogeFunV4Weth' && PW.weth === '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' && PW.swoge === A.constructeur.swoge && PW.creationFeeWei === A.constructeur.creationFeeWei,
       'l artefact du jumeau : WETH9 relu le 29/09, meme frais de 10 000 $SWOGE que le V4');
    const dW = fs.mkdtempSync(path.join(os.tmpdir(), 'dep4w-'));
    const ww = monde(); const base = ww.chaine;
    let pretV4 = false, wethLu = PW.weth;
    ww.chaine = () => Object.assign(base(), { parametres: async () => ({ positionManager: PW.positionManager, swoge: PW.swoge, weth: wethLu, treasury: PW.treasury, creationFee: PW.creationFeeWei }) });
    const mkW = () => D.cree({ dossier: dW, artefact: AW, chaine: ww.chaine, nom: 'v4weth', pret: () => pretV4, lis: async () => ({ result: {} }) });
    let dw = mkW(); dw.charge();
    ww.eth = D.ETH_MIN_WEI; ww.swoge = FRAIS;
    await dw.tour();
    ok(ww.envoyees.length === 0, 'tant que le V4 n a pas fini d envoyer, le jumeau n envoie RIEN (un seul signataire a la fois)');
    pretV4 = true;
    await dw.tour();
    const dp = ww.envoyees.find((x) => x[0] === 'deploie');
    ok(dp && dp[1].length === 5 && dp[1][0] === PW.positionManager && dp[1][1] === PW.swoge && dp[1][2] === PW.weth && dp[1][3] === PW.treasury && dp[1][4] === FRAIS,
       'le jumeau part avec CINQ parametres, dans l ordre du contrat (WETH en troisieme)');
    ok(fs.existsSync(path.join(dW, 'deploiement_v4weth.json')) && !fs.existsSync(path.join(dW, 'deploiement_v4.json')), 'son etat vit dans son propre fichier : le V4 n est jamais ecrase');
    ww.recus['0xdep'] = { status: 1, contractAddress: LP };
    await dw.tour();
    ok(dw.etat().launchpad === LP && !dw.etat().error && dw.etat().pair === 'WETH' && dw.etat().parametersReadBack.weth === PW.weth,
       'deploye : le WETH est RELU sur la chaine et juste (le frais etant la, l autorisation suit dans le meme tour)');
    ww.recus['0xapp'] = { status: 1 }; await dw.tour();
    const lw = ww.envoyees.find((x) => x[0] === 'lance');
    ok(lw && lw[2].symbol === 'SWV4WTEST' && /WETH/.test(lw[2].name), 'son jeton de test porte son propre nom (SWV4WTEST)');
    ww.recus['0xlan'] = { status: 1, logs: [{}] }; ww.swoge = 20000n * 10n ** 18n;
    await dw.tour(); await dw.tour();
    ok(dw.etat().step === 'jeton_test' && !ww.envoyees.some((x) => x[0] === 'routeur' || x[0] === 'echange'), 'aucun achat de listage pour le jumeau, meme avec 20 000 $SWOGE : il faudrait envelopper de l ETH, non confirme');
    /* un WETH faux a la relecture arrete tout */
    const dW2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dep4w-'));
    const w2 = monde(); const b2 = w2.chaine; w2.eth = D.ETH_MIN_WEI; w2.swoge = FRAIS;
    w2.chaine = () => Object.assign(b2(), { parametres: async () => ({ positionManager: PW.positionManager, swoge: PW.swoge, weth: PW.swoge, treasury: PW.treasury, creationFee: PW.creationFeeWei }) });
    const d2w = D.cree({ dossier: dW2, artefact: AW, chaine: w2.chaine, nom: 'v4weth' });
    await d2w.tour(); w2.recus['0xdep'] = { status: 1, contractAddress: LP }; await d2w.tour(); await d2w.tour();
    ok(d2w.etat().step === 'erreur' && /WRONG PARAMETERS/.test(d2w.etat().error) && !w2.envoyees.some((x) => x[0] !== 'deploie'), 'un WETH faux a la relecture : erreur, et AUCUN lancement');
    fs.rmSync(dW, { recursive: true, force: true }); fs.rmSync(dW2, { recursive: true, force: true });
  }

  console.log('\n-- 5. la cle --');
  {
    const dossier3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dep4-'));
    const d3 = D.cree({ dossier: dossier3, artefact: A, chaine: (cle) => ({ adresse: new (require('ethers').Wallet)(cle).address }) });
    const v = d3.etat(), f = path.join(dossier3, 'deployeur_v4.json');
    const cle = JSON.parse(fs.readFileSync(f, 'utf8')).cle;
    ok(/^0x[0-9a-f]{64}$/.test(cle) && (fs.statSync(f).mode & 0o777) === 0o600, 'la cle est creee une fois, en 0600, dans DATA_DIR');
    ok(/^0x[0-9a-fA-F]{40}$/.test(v.deployer) && !JSON.stringify(v).includes(cle.slice(2)), 'la vue publique donne l ADRESSE, jamais la cle');
    fs.rmSync(dossier3, { recursive: true, force: true });
  }
  const src = fs.readFileSync(path.join(__dirname, 'deploiement_v4.js'), 'utf8');
  ok(!/\.transfer\(|value:\s/.test(src) && (src.match(/sendTransaction\(/g) || []).length === 1
     && /const tx = deploiement\(args\); return w\.sendTransaction\(Object\.assign\(tx, await frais\(tx\)\)\)/.test(src)
     && /const deploiement = \(args\) => new ethers\.ContractFactory\(/.test(src), 'le code ne contient aucun transfert d ETH ni de jeton : deployer, autoriser, lancer le test, l echanger pour soi-meme, rien d autre');
  ok((src.match(/await frais\(/g) || []).length === 6 && /gasPrice: px\.mul\(12\)\.div\(10\)/.test(src) && !/maxPriorityFeePerGas/.test(src),
     'chaque envoi (et le cout annonce) porte un prix du gaz pose a la main : jamais le pourboire fige de 1,5 gwei d ethers (29/09 : 70 fois le prix, premier depart refuse)');
  ok((src.match(/recipient:/g) || []).length === 1 && /recipient: w\.address, amountIn/.test(src) && /echange: async \(entree, sortie, montant, minimum\)/.test(src),
     'un seul destinataire d echange dans tout le fichier : le portefeuille lui-meme');
  ok(A.constructeur.positionManager.toLowerCase() !== A.constructeur.swoge.toLowerCase() && require('ethers').utils.getAddress(A.constructeur.treasury) === A.constructeur.treasury,
     'l artefact porte des adresses distinctes et a somme EIP-55 valide');

  fs.rmSync(dossier, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  ' + rates + ' RATE(S)' : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
