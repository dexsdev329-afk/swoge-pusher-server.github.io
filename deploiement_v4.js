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
 *   3. lancer UN jeton de test, pour lire ce que GoPlus en dit ;
 *   4. (ajoute le 29/09, confirme par le proprietaire : « oui, fais l'achat auto de 1 000
 *      $SWOGE ») ACHETER ce jeton de test pour 1 000 $SWOGE puis en REVENDRE la moitie, par le
 *      routeur Uniswap, pour SON PROPRE compte. Mesure du 29/09 : 3 min apres le lancement,
 *      GoPlus disait « is_in_dex 0 », taxes vides, et DexScreener « pairs: null » — sans un
 *      echange, aucun scanner ne calcule taxe ni honeypot. Le destinataire de chaque echange est
 *      fixe dans chaineEthers (le portefeuille lui-meme), jamais un parametre ; les deux seuls
 *      jetons echanges sont $SWOGE et le jeton de test.
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
   a envoye ~1 $ (0,0005 ETH), qui suffit. Mesure du nœud le 29/09 depuis le portefeuille de
   deploiement : 2 091 266 gaz a 0,02097 gwei ; au prix ou il part (gaz x1,2, prix x1,2, voir
   frais() plus bas) 0,000063 ETH ; le jeton de test ~5,85 M gaz, ~0,00018 ETH. On deploie donc des que le solde couvre
   MARGE_GAZ fois le cout ESTIME a l'instant par le nœud ; ETH_MIN_WEI ne sert plus que si
   l'estimation echoue (on ne part pas a l'aveugle en dessous). */
const ETH_MIN_WEI = 2n * 10n ** 15n;
const MARGE_GAZ = 1.5;
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=';
const RELECTURE_SCANNERS_MS = 30 * 60e3;
/* L'achat de listage : 1 000 $SWOGE (sur les 20 000 restants apres le frais), la moitie des jetons
   recus revendue. Devis du quoter le 29/09 : 1 000 $SWOGE -> 98 457 SWV4TEST, 162 014 gaz. Minimum
   accepte : 95 % du devis (le pool n'a personne d'autre que nous, l'ecart ne vient que du bloc). */
const ACHAT_SWOGE_WEI = 1000n * 10n ** 18n;
const GLISSEMENT_BPS = 500n;
/* Le listage du JUMEAU WETH (29/09, confirme par le proprietaire : « oui », a « achat de listage en
   ETH ») : 0,0005 ETH enveloppe en WETH par deposit() sur le WETH9 relu, achete, moitie revendue.
   Meme mesure qui l'a decide que pour le V4 : sans echange, DexScreener « pas de paire » et GoPlus
   « is_in_dex 0 » (relu a 20:05 UTC pour SWV4WTEST). On ne part que s'il reste MARGE_ETH_LISTAGE
   au-dessus, pour les cinq transactions (~0,00001 ETH de gaz mesure pour les quatre du V4). */
const ACHAT_ETH_WEI = 5n * 10n ** 14n;
const MARGE_ETH_LISTAGE = 2n * 10n ** 14n;
const lisible = (wei) => (Number(wei) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 6 });
const CHAMPS_GOPLUS = ['external_call', 'owner_address', 'creator_address', 'is_open_source', 'hidden_owner', 'can_take_back_ownership',
  'is_mintable', 'is_proxy', 'is_honeypot', 'buy_tax', 'sell_tax', 'transfer_pausable', 'is_blacklisted', 'is_in_dex', 'holder_count'];

/* LE JUMEAU WETH (29/09, demande du proprietaire : « l'utilisateur a le choix entre pool $SWOGE ou
   WETH normal »). Le meme module deploie SwogeFunV4Weth (swogefun_v4weth.json) par le MEME
   portefeuille dedie, avec son propre fichier d'etat ; l'artefact porte `constructeur.weth` et c'est
   lui qui decide des quatre parametres (positionManager, weth, tresor, frais). Son frais de
   lancement est en ETH (`fraisEnEth`, precise par le proprietaire a 19:23 UTC) : le jeton de test
   part en payant EXACTEMENT ce frais au contrat qu'on vient de deployer et de relire — le seul
   envoi de valeur de ce fichier —, sans autorisation $SWOGE. Pas d'achat de listage pour ce jumeau : il faudrait envelopper
   de l'ETH (un envoi de valeur), et seul l'achat en $SWOGE du V4 a ete confirme. `pret()` le retient
   tant que le V4 n'a pas fini d'envoyer : deux instances ne signent jamais en meme temps (nonce). */

/**
 * deps : { dossier, artefact, chaine?(portefeuille) → operations, lis?(url) → json, maintenant?, alea?,
 *          nom? ('v4' | 'v4weth' : le fichier d'etat), pret?() → bool }
 * `chaine` recoit la cle privee et rend les SEULES operations permises (voir chaineEthers).
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const A = deps.artefact;
  const FCLE = path.join(deps.dossier, 'deployeur_v4.json');
  const NOM = deps.nom || 'v4';
  const FETAT = path.join(deps.dossier, 'deploiement_' + NOM + '.json');
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
  const JUMEAU_WETH = !!P.weth;
  /* Les parametres du constructeur, dans l'ordre du contrat : le jumeau en a cinq (WETH en troisieme). */
  const FRAIS_ETH = !!P.fraisEnEth;
  const ARGS = JUMEAU_WETH ? [P.positionManager, P.weth, P.treasury, FRAIS] : [P.positionManager, P.swoge, P.treasury, FRAIS];
  const TEST = JUMEAU_WETH ? { name: 'SWOGE V4 WETH Scanner Test', symbol: 'SWV4WTEST' } : { name: 'SWOGE V4 Scanner Test', symbol: 'SWV4TEST' };

  async function tour() {
    const c = chaine();
    nouvelleGeneration();
    if (deps.pret && !deps.pret()) return;              /* le V4 n'a pas fini : on n'envoie rien */
    soldes = { eth: await c.soldeEth(), swoge: await c.soldeSwoge(), lu: new Date(maintenant()).toISOString() };

    /* 1. le deploiement, repris s'il etait parti. Le seuil : le cout estime a l'instant, x1,5. */
    let seuil = ETH_MIN_WEI;
    if (E.etape === 'attente_fonds' && c.coutDeploiement) {
      try { seuil = BigInt(Math.ceil(Number(await c.coutDeploiement(ARGS)) * MARGE_GAZ)); } catch (e) { seuil = ETH_MIN_WEI; }
      E.seuilDeploiementWei = String(seuil);
    }
    if (E.etape === 'attente_fonds' && soldes.eth >= seuil) {
      const tx = await c.deploieLaunchpad(ARGS);
      E.etape = 'deploiement'; E.txDeploiement = tx.hash; E.sourceDeploye = A.sourceSha256; note('launchpad deployment sent ' + tx.hash); ecrit();
    }
    if (E.etape === 'deploiement') {
      const r = await c.recu(E.txDeploiement);
      if (!r) return;                                   /* pas encore mine : on revient au tour suivant */
      if (r.status !== 1 || !r.contractAddress) { E.etape = 'erreur'; E.erreur = 'deployment reverted'; note(E.erreur); ecrit(); return; }
      E.launchpad = r.contractAddress;
      /* LA RELECTURE : ce qui est sur la chaine, pas ce qu'on croit avoir envoye. */
      const lu = await c.parametres(E.launchpad);
      const bons = lu.positionManager.toLowerCase() === P.positionManager.toLowerCase()
        && (JUMEAU_WETH ? lu.swoge === undefined : String(lu.swoge || '').toLowerCase() === P.swoge.toLowerCase())
        && lu.treasury.toLowerCase() === P.treasury.toLowerCase() && BigInt(lu.creationFee) === FRAIS
        && (!JUMEAU_WETH || String(lu.weth || '').toLowerCase() === P.weth.toLowerCase());
      E.parametresLus = { positionManager: lu.positionManager, ...(JUMEAU_WETH ? { weth: lu.weth } : { swoge: lu.swoge }), treasury: lu.treasury, creationFeeWei: String(lu.creationFee) };
      if (!bons) { E.etape = 'erreur'; E.erreur = 'WRONG PARAMETERS read back on chain — this launchpad must never be used'; note(E.erreur); ecrit(); return; }
      E.etape = 'deploye'; note('launchpad deployed at ' + E.launchpad + ', parameters read back and correct'); ecrit();
    }

    /* 2 et 3. le jeton de test */
    /* le jumeau paie son frais en ETH, dans l'appel meme : ni autorisation, ni $SWOGE */
    if (FRAIS_ETH && E.etape === 'deploye' && soldes.eth > FRAIS) {
      const sel = '0x' + require('crypto').randomBytes(32).toString('hex');
      const tx = await c.lanceTest(E.launchpad, { name: TEST.name, symbol: TEST.symbol, salt: sel, telegram: '', twitter: '', website: 'https://swoleeswoge.dog', logo: '' }, FRAIS);
      E.etape = 'lancement'; E.txLancement = tx.hash; note('test launch sent, paying the ' + String(Number(FRAIS) / 1e18) + ' ETH fee ' + tx.hash); ecrit();
    }
    if (!FRAIS_ETH && E.etape === 'deploye' && soldes.swoge >= FRAIS) {
      const tx = await c.autoriseFrais(E.launchpad, FRAIS);
      E.etape = 'autorisation'; E.txAutorisation = tx.hash; note('fee approval sent ' + tx.hash); ecrit();
    }
    if (E.etape === 'autorisation') {
      const r = await c.recu(E.txAutorisation);
      if (!r) return;
      if (r.status !== 1) { E.etape = 'erreur'; E.erreur = 'approval reverted'; note(E.erreur); ecrit(); return; }
      const sel = '0x' + require('crypto').randomBytes(32).toString('hex');
      const tx = await c.lanceTest(E.launchpad, { name: TEST.name, symbol: TEST.symbol, salt: sel, telegram: '', twitter: '', website: 'https://swoleeswoge.dog', logo: '' });
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

    /* 4. l'achat puis la revente de listage, chacun attendu avant le suivant */
    /* l'actif de cotation : $SWOGE pour le V4, WETH pour le jumeau */
    const S = JUMEAU_WETH ? P.weth : P.swoge, J = E.jetonTest, SYM = JUMEAU_WETH ? 'WETH' : 'SWOGE';
    const ACHAT = JUMEAU_WETH ? ACHAT_ETH_WEI : ACHAT_SWOGE_WEI;
    if (!JUMEAU_WETH && E.etape === 'jeton_test' && !E.txAchat && soldes.swoge >= ACHAT_SWOGE_WEI) {
      const tx = await c.autoriseRouteur(S, ACHAT_SWOGE_WEI);
      E.etape = 'appro_achat'; E.txApproAchat = tx.hash; note('router approval for the listing buy sent ' + tx.hash); ecrit();
    }
    /* le jumeau enveloppe d'abord son ETH en WETH : le seul autre envoi de valeur du fichier */
    if (JUMEAU_WETH && E.etape === 'jeton_test' && !E.txEnveloppe && soldes.eth >= ACHAT_ETH_WEI + MARGE_ETH_LISTAGE) {
      const tx = await c.envelopper(ACHAT_ETH_WEI);
      E.etape = 'enveloppe'; E.txEnveloppe = tx.hash; note('wrapping ' + lisible(ACHAT_ETH_WEI) + ' ETH into WETH for the listing buy ' + tx.hash); ecrit();
    }
    if (E.etape === 'enveloppe') {
      const r = await c.recu(E.txEnveloppe);
      if (!r) return;
      if (r.status !== 1) { E.etape = 'erreur'; E.erreur = 'WETH wrap reverted'; note(E.erreur); ecrit(); return; }
      const tx = await c.autoriseRouteur(S, ACHAT);
      E.etape = 'appro_achat'; E.txApproAchat = tx.hash; note('router approval for the listing buy sent ' + tx.hash); ecrit();
    }
    if (E.etape === 'appro_achat') {
      const r = await c.recu(E.txApproAchat);
      if (!r) return;
      if (r.status !== 1) { E.etape = 'erreur'; E.erreur = 'buy approval reverted'; note(E.erreur); ecrit(); return; }
      const d = await c.devis(S, J, ACHAT);
      const tx = await c.echange(S, J, ACHAT, d * (10000n - GLISSEMENT_BPS) / 10000n);
      E.etape = 'achat'; E.txAchat = tx.hash; note('listing buy sent: ' + lisible(ACHAT) + ' ' + SYM + ' for ~' + lisible(d) + ' ' + tx.hash); ecrit();
    }
    if (E.etape === 'achat') {
      const r = await c.recu(E.txAchat);
      if (!r) return;
      if (r.status !== 1) { E.etape = 'erreur'; E.erreur = 'listing buy reverted'; note(E.erreur); ecrit(); return; }
      const bal = await c.soldeJeton(J);
      E.venteWei = String(bal / 2n);
      const tx = await c.autoriseRouteur(J, bal / 2n);
      E.etape = 'appro_vente'; E.txApproVente = tx.hash; note('bought ' + lisible(bal) + ' test tokens; sell approval sent ' + tx.hash); ecrit();
    }
    if (E.etape === 'appro_vente') {
      const r = await c.recu(E.txApproVente);
      if (!r) return;
      if (r.status !== 1) { E.etape = 'erreur'; E.erreur = 'sell approval reverted'; note(E.erreur); ecrit(); return; }
      const m = BigInt(E.venteWei);
      const d = await c.devis(J, S, m);
      const tx = await c.echange(J, S, m, d * (10000n - GLISSEMENT_BPS) / 10000n);
      E.etape = 'vente'; E.txVente = tx.hash; note('listing sell sent: half the tokens for ~' + lisible(d) + ' ' + SYM + ' ' + tx.hash); ecrit();
    }
    if (E.etape === 'vente') {
      const r = await c.recu(E.txVente);
      if (!r) return;
      if (r.status !== 1) { E.etape = 'erreur'; E.erreur = 'listing sell reverted'; note(E.erreur); ecrit(); return; }
      E.etape = 'liste'; note('listing trades done: bought and sold on Uniswap, the scanners can now measure taxes'); ecrit();
    }

    /* 5. ce que dit GoPlus, relu toutes les 30 min (il indexe avec du retard) */
    if ((E.etape === 'jeton_test' || E.etape === 'liste') && (!E.goplusLu || maintenant() - Date.parse(E.goplusLu) >= RELECTURE_SCANNERS_MS)) {
      try {
        const j = await lis(GOPLUS + E.jetonTest.toLowerCase());
        const i = (j && j.result && j.result[E.jetonTest.toLowerCase()]) || null;
        E.goplus = i ? Object.fromEntries(CHAMPS_GOPLUS.map((k) => [k, i[k] === undefined ? null : i[k]])) : null;
        E.goplusLu = new Date(maintenant()).toISOString(); ecrit();
      } catch (e) { /* GoPlus muet : on relira */ }
    }
  }

  /* LE SOURCE DEPLOYE, PAS CELUI DU DEPOT (30/09/2026) ----
   * Le correctif « hidden owner » a change le source et l artefact, mais un
   * launchpad deja deploye garde son code : la vue affichait l empreinte du
   * NOUVEAU source a cote de l ANCIEN contrat. Les deux launchpads en service
   * ont ete deployes le 29/09 depuis les artefacts de main de ce jour-la
   * (empreintes relues dans l historique git) ; les suivants l enregistrent. */
  const SOURCE_29_09 = { v4: 'd12954fe62b19a0f7d4d51eb15bedd20777e1934beaaf64fdeb9a8ae08628df8', v4weth: 'eb3756832bd01b429832a7c115be3fb3eb48f5752190e578363c11d4946b7f2e' };
  function sourceDeploye() { return E.sourceDeploye || (E.txDeploiement ? SOURCE_29_09[NOM] || null : null); }

  /* ---- LE REDEPLOIEMENT (30/09/2026, le proprietaire : « refais les deux ») ----
   * Les jetons de test du 29/09 sont notes « hidden_owner: 1 » par GoPlus : leur owner() etait
   * une constante (`pure`). Le source corrige (variable en stockage, OwnershipTransferred a la
   * creation) passe les bancs sur fork (contrats/banc_fork_v4*.js, 35 et 45 verifications, dont
   * les deux qui refusent l ancien jeton), et son bytecode recompile est celui des artefacts.
   * Sur les anciens launchpads : deux jetons en tout, nos deux jetons de test (relu sur la chaine).
   *
   * Un nouveau source ne redeploie RIEN de lui-meme : il faut que son empreinte EXACTE soit
   * inscrite ici — chaque redeploiement brule 10 000 $SWOGE (jeton de test du V4) et du gaz. On
   * ne repart que d un etat final (aucune transaction en vol) ; l ancien launchpad reste dans
   * `anciens` : il n est plus propose, mais ses jetons y gardent leurs frais (collectFees). */
  const REDEPLOIEMENT_AUTORISE = {
    v4: '4bb7c51fd5070c404489980350ea3334fc4b004ccf1a556097e80615a8291097',
    v4weth: '23ca3253fa1b74726b92afce01b8376d04ac5be77b35ae31b3ab198f98ff424d',
  };
  function nouvelleGeneration() {
    const dep = sourceDeploye();
    if (!E.txDeploiement || !dep || dep === A.sourceSha256 || REDEPLOIEMENT_AUTORISE[NOM] !== A.sourceSha256) return false;
    if (!['liste', 'erreur'].includes(E.etape)) return false;
    const ancien = { sourceSha256: dep, launchpad: E.launchpad || null, testToken: E.jetonTest || null, testPool: E.poolTest || null,
      deployTx: E.txDeploiement, step: E.etape, goplus: E.goplus || null, retiredAt: new Date(maintenant()).toISOString() };
    E = { etape: 'attente_fonds', historique: E.historique || [], anciens: (E.anciens || []).concat([ancien]) };
    note('source ' + A.sourceSha256.slice(0, 8) + ' authorised: redeploying; previous launchpad ' + ancien.launchpad + ' retired (kept for its tokens\' fees)');
    ecrit();
    return true;
  }

  function etat() {
    let adresse = null;
    try { adresse = chaine().adresse; } catch (e) { adresse = null; }
    const x = 'https://robinhoodchain.blockscout.com/';
    return { ok: true, contract: A.contrat, pair: JUMEAU_WETH ? 'WETH' : 'SWOGE', step: E.etape, deployer: adresse,
      needs: { ethWei: E.seuilDeploiementWei || String(ETH_MIN_WEI), eth: Number(E.seuilDeploiementWei || ETH_MIN_WEI) / 1e18, estimated: !!E.seuilDeploiementWei,
        ...(FRAIS_ETH ? { ethFeeForTestLaunch: Number(FRAIS) / 1e18 } : { swogeForTestLaunch: Number(FRAIS / 10n ** 18n) }) },
      balances: soldes.lu ? { eth: soldes.eth == null ? null : Number(soldes.eth) / 1e18,
        /* le jumeau ne lit pas le $SWOGE : null (sans objet), jamais un 0 qui ferait croire le portefeuille vide */
        swoge: JUMEAU_WETH || soldes.swoge == null ? null : Number(soldes.swoge / 10n ** 14n) / 1e4, readAt: soldes.lu } : null,
      launchpad: E.launchpad || null, parametersReadBack: E.parametresLus || null, testToken: E.jetonTest || null, testPool: E.poolTest || null,
      goplus: E.goplus || null, goplusReadAt: E.goplusLu || null, error: E.erreur || null,
      links: { deployer: adresse ? x + 'address/' + adresse : null, launchpad: E.launchpad ? x + 'address/' + E.launchpad : null, testToken: E.jetonTest ? x + 'token/' + E.jetonTest : null,
        deployTx: E.txDeploiement ? x + 'tx/' + E.txDeploiement : null, launchTx: E.txLancement ? x + 'tx/' + E.txLancement : null,
        buyTx: E.txAchat ? x + 'tx/' + E.txAchat : null, sellTx: E.txVente ? x + 'tx/' + E.txVente : null },
      compiler: A.compilateur, sourceSha256: A.sourceSha256, deployedSourceSha256: sourceDeploye(),
      deployedIsCurrent: sourceDeploye() == null ? null : sourceDeploye() === A.sourceSha256,
      ...(sourceDeploye() && sourceDeploye() !== A.sourceSha256 ? { outdated: 'The deployed launchpad was compiled from an older source: tokens it creates keep that code. A new deployment is needed to use the current source.' } : {}),
      previous: E.anciens || [], history: E.historique || [] };
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
  /* Le jumeau WETH n'a pas de $SWOGE dans son artefact (frais en ETH) : pas de contrat $SWOGE, solde 0.
     Le 29/09 a 19:42 UTC, le construire quand meme faisait tomber CHAQUE tour sur « invalid contract
     address » avant tout envoi — et la page ne donnait plus l'adresse du deployeur. */
  const swoge = A.constructeur.swoge ? new ethers.Contract(A.constructeur.swoge, ERC, w) : null;
  /* Le prix du gaz, TOUJOURS pose a la main (29/09). Sans lui, ethers v5 met une transaction
     EIP-1559 avec un pourboire fige a 1,5 gwei ; le nœud Robinhood en voulait 0,021 (base
     0,02089) : 70 fois trop. Le premier depart en production a echoue ainsi — le nœud verifie
     solde >= gaz x maxFeePerGas (2 091 266 x 1,54 gwei = 0,0032 ETH) contre 0,0005 envoyes,
     et repond « out of gas ». Meme convention que caisse.js, miroir.js et x402.js : prix du
     nœud x1,2, transaction classique ; gaz estime x1,2. */
  const frais = async (tx) => {
    const [g, px] = await Promise.all([w.estimateGas(tx), prov.getGasPrice()]);
    return { gasLimit: g.mul(12).div(10), gasPrice: px.mul(12).div(10) };
  };
  /* Uniswap v3 sur Robinhood Chain : les adresses que launchpad.html emploie en production. */
  const ROUTEUR = '0xcaf681a66d020601342297493863e78c959e5cb2', QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
  const routeur = new ethers.Contract(ROUTEUR, ['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)'], w);
  const quoter = new ethers.Contract(QUOTER, ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'], prov);
  const deploiement = (args) => new ethers.ContractFactory(A.launchpad.abi, A.launchpad.bytecode).getDeployTransaction(...args);
  return {
    adresse: w.address,
    soldeEth: async () => (await prov.getBalance(w.address)).toBigInt(),
    soldeSwoge: async () => (swoge ? (await swoge.balanceOf(w.address)).toBigInt() : 0n),
    deploieLaunchpad: async (args) => { const tx = deploiement(args); return w.sendTransaction(Object.assign(tx, await frais(tx))); },
    /* Le cout du deploiement, au prix EXACT ou il partira (gaz x1,2 au prix du nœud x1,2), en wei. */
    coutDeploiement: async (args) => { const f = await frais(deploiement(args)); return f.gasLimit.mul(f.gasPrice).toBigInt(); },
    recu: async (hash) => { const r = await prov.getTransactionReceipt(hash); return r && r.blockNumber ? r : null; },
    parametres: async (adr) => { const c = new ethers.Contract(adr, LP, prov);
      return { positionManager: await c.positionManager(), ...(LP.functions['swoge()'] ? { swoge: await c.swoge() } : {}), ...(LP.functions['weth()'] ? { weth: await c.weth() } : {}),
        treasury: await c.swogeTreasury(), creationFee: (await c.creationFee()).toString() }; },
    autoriseFrais: async (launchpad, montant) => swoge.approve(launchpad, montant, await frais(await swoge.populateTransaction.approve(launchpad, montant))),
    /* `fraisEth` : seulement pour le jumeau, le frais EXACT lu dans l'artefact ; le contrat refuse tout autre montant. */
    lanceTest: async (launchpad, p, fraisEth) => { const c = new ethers.Contract(launchpad, LP, w); const v = fraisEth ? { value: ethers.BigNumber.from(String(fraisEth)) } : {};
      return c.createToken(p, Object.assign(await frais(await c.populateTransaction.createToken(p, v)), v)); },
    /* deposit() sur le WETH9 de l'artefact, relu sur la chaine au deploiement du jumeau ; rien d'autre ne recoit de l'ETH ici */
    envelopper: async (montant) => { const W9 = new ethers.Contract(A.constructeur.weth, ['function deposit() payable'], w); const v = { value: ethers.BigNumber.from(String(montant)) };
      return W9.deposit(Object.assign(await frais(await W9.populateTransaction.deposit(v)), v)); },
    soldeJeton: async (adr) => (await new ethers.Contract(adr, ERC, prov).balanceOf(w.address)).toBigInt(),
    autoriseRouteur: async (jeton, montant) => { const t = new ethers.Contract(jeton, ERC, w); return t.approve(ROUTEUR, montant, await frais(await t.populateTransaction.approve(ROUTEUR, montant))); },
    devis: async (entree, sortie, montant) => (await quoter.callStatic.quoteExactInputSingle({ tokenIn: entree, tokenOut: sortie, amountIn: montant, fee: 10000, sqrtPriceLimitX96: 0 })).amountOut.toBigInt(),
    /* recipient : le portefeuille LUI-MEME, fixe ici — l'appelant ne peut pas le changer. */
    echange: async (entree, sortie, montant, minimum) => { const p = { tokenIn: entree, tokenOut: sortie, fee: 10000, recipient: w.address, amountIn: montant, amountOutMinimum: minimum, sqrtPriceLimitX96: 0 };
      return routeur.exactInputSingle(p, await frais(await routeur.populateTransaction.exactInputSingle(p))); },
    lancementDe: (recu) => {
      for (const l of recu.logs || []) { try { const e = LP.parseLog(l); if (e.name === 'LaunchedInstant') return { token: e.args.token, pool: e.args.pool }; } catch (e) { /* un autre journal */ } }
      return null;
    },
  };
}

module.exports = { cree, chaineEthers, ETH_MIN_WEI };
