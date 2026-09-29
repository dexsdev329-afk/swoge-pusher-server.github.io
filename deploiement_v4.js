'use strict';
/* ==========================================================================
 * LE DEPLOIEMENT DU LAUNCHPAD V4, DEPUIS LE SERVEUR (29/09/2026)
 * ==========================================================================
 *
 * Demande du proprietaire : « tu peux tout faire tout seul ; si tu as besoin,
 * je recharge de l'ETH RH ». Les cles vivent sur Railway et n'en sortent pas :
 * ce module genere donc SON portefeuille, dedie (DATA_DIR/deployeur_v4.json,
 * 0600, jamais rendu par aucune route — comme la cle du passeport), et publie
 * seulement son ADRESSE. Le proprietaire y envoie un peu d'ETH et 10 000 $SWOGE.
 *
 * Ce portefeuille ne sait faire que TROIS choses, dans cet ordre, une fois :
 *   1. deployer SwogeFunV4 (bytecode fige dans swogefun_v4.json, compile avec
 *      les reglages de production), puis RELIRE ses quatre parametres sur la
 *      chaine — le piege deja vecu : deux adresses inversees, un contrat qui
 *      « a l'air sain » et dont chaque lancement revert pour toujours ;
 *   2. autoriser le launchpad a prelever le frais de lancement (10 000 $SWOGE,
 *      brules par le contrat) ;
 *   3. lancer UN jeton de test, pour lire ce que GoPlus en dit.
 * Aucune autre transaction n'existe dans ce fichier : pas de transfert d'ETH ni
 * de $SWOGE vers qui que ce soit. Il ne touche ni aux fonds des joueurs
 * (MIROIR_CLE), ni au portefeuille de gaz x402, ni a aucune autre cle.
 *
 * Chaque transaction est ECRITE sur le disque (son hash) AVANT d'attendre sa
 * confirmation : un redemarrage au milieu reprend la meme transaction au lieu
 * d'en envoyer une seconde.
 * ======================================================================== */

const fs = require('fs');
const path = require('path');

/* Le seuil de depart n'est plus FIXE (29/09) : 0,002 ETH etait prudent de x10 et le proprietaire
   a envoye ~1 $ (0,0005 ETH), qui suffit. Mesure du nœud le 29/09 : deploiement 5 314 209 gaz
   (part donnees comprise) a 0,02091 gwei = 0,000111 ETH. On deploie donc des que le solde couvre
   MARGE_GAZ fois le cout ESTIME a l'instant par le nœud ; ETH_MIN_WEI ne sert plus que si
   l'estimation echoue (on ne part pas a l'aveugle en dessous). */
const ETH_MIN_WEI = 2n * 10n ** 15n;
const MARGE_GAZ = 1.5;
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=';
const RELECTURE_SCANNERS_MS = 30 * 60e3;
const CHAMPS_GOPLUS = ['external_call', 'owner_address', 'creator_address', 'is_open_source', 'hidden_owner', 'can_take_back_ownership',
  'is_mintable', 'is_proxy', 'is_honeypot', 'buy_tax', 'sell_tax', 'transfer_pausable', 'is_blacklisted', 'is_in_dex', 'holder_count'];

/**
 * deps : { dossier, artefact, chaine?(portefeuille) → operations, lis?(url) → json, maintenant?, alea? }
 * `chaine` recoit la cle privee et rend les SEULES operations permises (voir chaineEthers).
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const A = deps.artefact;
  const FCLE = path.join(deps.dossier, 'deployeur_v4.json');
  const FETAT = path.join(deps.dossier, 'deploiement_v4.json');
  const lis = deps.lis || ((u) => fetch(u, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()));
  let E = { etape: 'attente_fonds', historique: [] };
  let C = null;       /* les operations de chaine, construites une fois */
  let soldes = { eth: null, swoge: null, lu: null };

  function charge() { try { E = Object.assign(E, JSON.parse(fs.readFileSync(FETAT, 'utf8'))); } catch (e) { /* premier demarrage */ } }
  function ecrit() { fs.mkdirSync(deps.dossier, { recursive: true }); fs.writeFileSync(FETAT + '.tmp', JSON.stringify(E, null, 1)); fs.renameSync(FETAT + '.tmp', FETAT); }
  function note(t) { E.historique = (E.historique || []).concat([{ t: new Date(maintenant()).toISOString(), quoi: t }]).slice(-40); }

  /* La cle : lue, sinon creee une fois (0600). Elle ne sort jamais d'ici. */
  function cle() {
    try { return JSON.parse(fs.readFileSync(FCLE, 'utf8')).cle; }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const w = require('ethers').Wallet.createRandom();
      fs.mkdirSync(deps.dossier, { recursive: true });
      fs.writeFileSync(FCLE, JSON.stringify({ cle: w.privateKey, cree: new Date(maintenant()).toISOString() }), { mode: 0o600 });
      return w.privateKey;
    }
  }
  function chaine() { if (!C) C = (deps.chaine || chaineEthers)(cle(), A); return C; }

  const P = A.constructeur;
  const FRAIS = BigInt(P.creationFeeWei);

  async function tour() {
    const c = chaine();
    soldes = { eth: await c.soldeEth(), swoge: await c.soldeSwoge(), lu: new Date(maintenant()).toISOString() };

    /* 1. le deploiement, repris s'il etait parti. Le seuil : le cout estime a l'instant, x1,5. */
    let seuil = ETH_MIN_WEI;
    if (E.etape === 'attente_fonds' && c.coutDeploiement) {
      try { seuil = BigInt(Math.ceil(Number(await c.coutDeploiement([P.positionManager, P.swoge, P.treasury, FRAIS])) * MARGE_GAZ)); } catch (e) { seuil = ETH_MIN_WEI; }
      E.seuilDeploiementWei = String(seuil);
    }
    if (E.etape === 'attente_fonds' && soldes.eth >= seuil) {
      const tx = await c.deploieLaunchpad([P.positionManager, P.swoge, P.treasury, FRAIS]);
      E.etape = 'deploiement'; E.txDeploiement = tx.hash; note('launchpad deployment sent ' + tx.hash); ecrit();
    }
    if (E.etape === 'deploiement') {
      const r = await c.recu(E.txDeploiement);
      if (!r) return;                                   /* pas encore mine : on revient au tour suivant */
      if (r.status !== 1 || !r.contractAddress) { E.etape = 'erreur'; E.erreur = 'deployment reverted'; note(E.erreur); ecrit(); return; }
      E.launchpad = r.contractAddress;
      /* LA RELECTURE : ce qui est sur la chaine, pas ce qu'on croit avoir envoye. */
      const lu = await c.parametres(E.launchpad);
      const bons = lu.positionManager.toLowerCase() === P.positionManager.toLowerCase() && lu.swoge.toLowerCase() === P.swoge.toLowerCase()
        && lu.treasury.toLowerCase() === P.treasury.toLowerCase() && BigInt(lu.creationFee) === FRAIS;
      E.parametresLus = { positionManager: lu.positionManager, swoge: lu.swoge, treasury: lu.treasury, creationFeeWei: String(lu.creationFee) };
      if (!bons) { E.etape = 'erreur'; E.erreur = 'WRONG PARAMETERS read back on chain — this launchpad must never be used'; note(E.erreur); ecrit(); return; }
      E.etape = 'deploye'; note('launchpad deployed at ' + E.launchpad + ', parameters read back and correct'); ecrit();
    }

    /* 2 et 3. le jeton de test */
    if (E.etape === 'deploye' && soldes.swoge >= FRAIS) {
      const tx = await c.autoriseFrais(E.launchpad, FRAIS);
      E.etape = 'autorisation'; E.txAutorisation = tx.hash; note('fee approval sent ' + tx.hash); ecrit();
    }
    if (E.etape === 'autorisation') {
      const r = await c.recu(E.txAutorisation);
      if (!r) return;
      if (r.status !== 1) { E.etape = 'erreur'; E.erreur = 'approval reverted'; note(E.erreur); ecrit(); return; }
      const sel = '0x' + require('crypto').randomBytes(32).toString('hex');
      const tx = await c.lanceTest(E.launchpad, { name: 'SWOGE V4 Scanner Test', symbol: 'SWV4TEST', salt: sel, telegram: '', twitter: '', website: 'https://swoleeswoge.dog', logo: '' });
      E.etape = 'lancement'; E.txLancement = tx.hash; note('test launch sent ' + tx.hash); ecrit();
    }
    if (E.etape === 'lancement') {
      const r = await c.recu(E.txLancement);
      if (!r) return;
      if (r.status !== 1) { E.etape = 'erreur'; E.erreur = 'test launch reverted'; note(E.erreur); ecrit(); return; }
      const l = c.lancementDe(r);
      if (!l) { E.etape = 'erreur'; E.erreur = 'no LaunchedInstant event in the receipt'; note(E.erreur); ecrit(); return; }
      E.jetonTest = l.token; E.poolTest = l.pool; E.etape = 'jeton_test'; note('test token ' + l.token + ', pool ' + l.pool); ecrit();
    }

    /* 4. ce que dit GoPlus, relu toutes les 30 min (il indexe avec du retard) */
    if (E.etape === 'jeton_test' && (!E.goplusLu || maintenant() - Date.parse(E.goplusLu) >= RELECTURE_SCANNERS_MS)) {
      try {
        const j = await lis(GOPLUS + E.jetonTest.toLowerCase());
        const i = (j && j.result && j.result[E.jetonTest.toLowerCase()]) || null;
        E.goplus = i ? Object.fromEntries(CHAMPS_GOPLUS.map((k) => [k, i[k] === undefined ? null : i[k]])) : null;
        E.goplusLu = new Date(maintenant()).toISOString(); ecrit();
      } catch (e) { /* GoPlus muet : on relira */ }
    }
  }

  function etat() {
    let adresse = null;
    try { adresse = chaine().adresse; } catch (e) { adresse = null; }
    const x = 'https://robinhoodchain.blockscout.com/';
    return { ok: true, step: E.etape, deployer: adresse,
      needs: { ethWei: E.seuilDeploiementWei || String(ETH_MIN_WEI), eth: Number(E.seuilDeploiementWei || ETH_MIN_WEI) / 1e18, estimated: !!E.seuilDeploiementWei, swogeForTestLaunch: Number(FRAIS / 10n ** 18n) },
      balances: soldes.lu ? { eth: soldes.eth == null ? null : Number(soldes.eth) / 1e18, swoge: soldes.swoge == null ? null : Number(soldes.swoge / 10n ** 14n) / 1e4, readAt: soldes.lu } : null,
      launchpad: E.launchpad || null, parametersReadBack: E.parametresLus || null, testToken: E.jetonTest || null, testPool: E.poolTest || null,
      goplus: E.goplus || null, goplusReadAt: E.goplusLu || null, error: E.erreur || null,
      links: { deployer: adresse ? x + 'address/' + adresse : null, launchpad: E.launchpad ? x + 'address/' + E.launchpad : null, testToken: E.jetonTest ? x + 'token/' + E.jetonTest : null,
        deployTx: E.txDeploiement ? x + 'tx/' + E.txDeploiement : null, launchTx: E.txLancement ? x + 'tx/' + E.txLancement : null },
      compiler: A.compilateur, sourceSha256: A.sourceSha256, history: E.historique || [] };
  }

  let minuterie = null, enCours = false;
  function demarre(delaiMs) {
    charge();
    if (minuterie) return;
    const lance = () => { if (enCours) return; enCours = true; tour().catch((e) => { note('error: ' + String(e && e.message || e).slice(0, 200)); try { ecrit(); } catch (x) {} }).then(() => { enCours = false; }); };
    const d = setTimeout(() => { lance(); minuterie = setInterval(lance, 60e3); if (minuterie.unref) minuterie.unref(); }, delaiMs == null ? 120e3 : delaiMs);
    if (d.unref) d.unref();
    minuterie = d;
  }

  return { tour, etat, charge, demarre, _etat: () => E, ETH_MIN_WEI };
}

/* ---- les SEULES operations de chaine du portefeuille dedie (ethers v5) ---- */
function chaineEthers(clePrivee, A) {
  const { ethers } = require('ethers');
  const cfg = require('./config');
  const prov = new ethers.providers.StaticJsonRpcProvider(cfg.RPC_URL, cfg.CHAIN_ID);
  const w = new ethers.Wallet(clePrivee, prov);
  const LP = new ethers.utils.Interface(A.launchpad.abi);
  const ERC = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)']);
  const swoge = new ethers.Contract(A.constructeur.swoge, ERC, w);
  return {
    adresse: w.address,
    soldeEth: async () => (await prov.getBalance(w.address)).toBigInt(),
    soldeSwoge: async () => (await swoge.balanceOf(w.address)).toBigInt(),
    deploieLaunchpad: async (args) => w.sendTransaction(new ethers.ContractFactory(A.launchpad.abi, A.launchpad.bytecode).getDeployTransaction(...args)),
    /* Le cout du deploiement, estime par le nœud (gaz x prix du moment), en wei. */
    coutDeploiement: async (args) => { const tx = new ethers.ContractFactory(A.launchpad.abi, A.launchpad.bytecode).getDeployTransaction(...args); tx.from = w.address;
      const [g, px] = await Promise.all([prov.estimateGas(tx), prov.getGasPrice()]); return g.mul(px).toBigInt(); },
    recu: async (hash) => { const r = await prov.getTransactionReceipt(hash); return r && r.blockNumber ? r : null; },
    parametres: async (adr) => { const c = new ethers.Contract(adr, LP, prov);
      return { positionManager: await c.positionManager(), swoge: await c.swoge(), treasury: await c.swogeTreasury(), creationFee: (await c.creationFee()).toString() }; },
    autoriseFrais: async (launchpad, montant) => swoge.approve(launchpad, montant),
    lanceTest: async (launchpad, p) => new ethers.Contract(launchpad, LP, w).createToken(p),
    lancementDe: (recu) => {
      for (const l of recu.logs || []) { try { const e = LP.parseLog(l); if (e.name === 'LaunchedInstant') return { token: e.args.token, pool: e.args.pool }; } catch (e) { /* un autre journal */ } }
      return null;
    },
  };
}

module.exports = { cree, chaineEthers, ETH_MIN_WEI };
