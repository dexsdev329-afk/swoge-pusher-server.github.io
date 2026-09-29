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
  const w = { eth: 0n, swoge: 0n, envoyees: [], recus: {}, faux: !!o.faux };
  w.chaine = () => ({
    adresse: '0x' + 'd'.repeat(40),
    soldeEth: async () => w.eth, soldeSwoge: async () => w.swoge,
    deploieLaunchpad: async (args) => { w.envoyees.push(['deploie', args]); return { hash: '0xdep' }; },
    recu: async (h) => w.recus[h] || null,
    parametres: async () => ({ positionManager: w.faux ? A.constructeur.swoge : A.constructeur.positionManager, swoge: A.constructeur.swoge, treasury: A.constructeur.treasury, creationFee: A.constructeur.creationFeeWei }),
    autoriseFrais: async (lp, m) => { w.envoyees.push(['autorise', lp, m]); return { hash: '0xapp' }; },
    lanceTest: async (lp, p) => { w.envoyees.push(['lance', lp, p]); return { hash: '0xlan' }; },
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
  await d.tour();
  const e = d.etat();
  ok(e.step === 'jeton_test' && e.testToken === JETON && e.testPool === POOL, 'le jeton de test et son pool sont enregistres');
  ok(e.goplus && e.goplus.external_call === '0' && !('secret' in e.goplus) && e.goplusReadAt, 'GoPlus est relu, seulement les champs utiles');
  ok(w.envoyees.length === 3, 'en tout : trois transactions, jamais davantage');

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
     && /const deploiement = \(args\) => new ethers\.ContractFactory\(/.test(src), 'le code ne contient aucun transfert d ETH ni de jeton : deployer, autoriser le frais, lancer le test, rien d autre');
  ok((src.match(/await frais\(/g) || []).length === 4 && /gasPrice: px\.mul\(12\)\.div\(10\)/.test(src) && !/maxPriorityFeePerGas/.test(src),
     'les trois envois (et le cout annonce) portent un prix du gaz pose a la main : jamais le pourboire fige de 1,5 gwei d ethers (29/09 : 70 fois le prix, premier depart refuse)');
  ok(A.constructeur.positionManager.toLowerCase() !== A.constructeur.swoge.toLowerCase() && require('ethers').utils.getAddress(A.constructeur.treasury) === A.constructeur.treasury,
     'l artefact porte des adresses distinctes et a somme EIP-55 valide');

  fs.rmSync(dossier, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  ' + rates + ' RATE(S)' : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
