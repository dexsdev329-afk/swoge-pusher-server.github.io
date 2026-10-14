'use strict';
/*
 * Le detecteur smart money de bout en bout (smart_money.js, 13/10/2026).
 *
 * Aucune requete reelle : un faux noeud (essais/smart_money/faux_noeud.js, aux
 * regles du vrai) sert un MONDE FIGE (essais/smart_money/monde.js) ou chaque
 * wallet a un role connu d'avance ; GeckoTerminal, DexScreener et le registre
 * des actions sont simules ; Telegram est un espion a deux bouches (privee et
 * publique). L'intention :
 *  1. SMART_MONEY vide = rien : 0 minuterie, 0 requete, 0 fichier, et ni viem
 *     ni sql.js charges ;
 *  2. une PASSE complete retrouve les roles : jetons retenus et exclus,
 *     createurs (deployeur, fabrique, migration), 50 premiers, gains, les
 *     marques (groupe, relais, finance), smart / initie / pas assez, taux de
 *     base, liens, recette ; la vue est du JSON pur ; lecture seule ;
 *  3. la VEILLE : 2 smart dans l'heure sur un nouveau jeton -> UNE alerte ;
 *     un createur connu lance -> UNE alerte ; tout part par notifyPrive, rien
 *     sur le canal public, rien en double ; un smart seul -> rien ;
 *  4. le redemarrage reprend la base ; 5. un budget epuise reprend sur le
 *     cache ; 6. le rapport quotidien part une fois ; 7. les sources (regles du
 *     13/10) ; 8. les routes sur le VRAI serveur.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { if (c) n++; else { rates++; console.log('  RATE ' + m); } };
const egal = (a, b, m) => ok(a === b || String(a) === String(b), `${m} (lu ${a}, attendu ${b})`);
const viemCharge = () => Object.keys(require.cache).some((k) => /node_modules[\\/]viem[\\/]/.test(k));
const sqlCharge = () => Object.keys(require.cache).some((k) => /node_modules[\\/]sql\.js[\\/]/.test(k));
async function muet(fn) {
  const lignes = []; const l = console.log; console.log = (...a) => lignes.push(a.join(' '));
  try { return [await fn(), lignes]; } finally { console.log = l; }
}

/* AVANT tout require de config.js (que smart_money charge) : le vrai serveur de
   la section 8 lit ces variables une fois. Sans elles, il ecrirait dans ./data. */
process.env.PORT = String(8930 + (process.pid % 60));
process.env.RPC_URL = '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-serveur-'));
process.env.SMART_MONEY = '';
for (const k of ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_BACKUP_CHAT_ID', 'TG_BACKUP_ID', 'SMART_RPC_URL']) delete process.env[k];

(async () => {
  const M = require('./smart_money');
  // ================================================== 1. eteint = rien
  console.log('-- 1. SMART_MONEY vide : rien --');
  {
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-vide-'));
    let appels = 0;
    const espion = async () => { appels++; throw new Error('aucune requete attendue'); };
    const si = global.setInterval, st = global.setTimeout;
    let minuteries = 0;
    global.setInterval = (...a) => { minuteries++; return si(...a); };
    global.setTimeout = (...a) => { minuteries++; return st(...a); };
    let p, lignes;
    try { [p, lignes] = await muet(async () => M.planifie({ env: { SMART_MONEY: '' }, prendre: espion, dossier, tg: { notifyPrive() { appels++; } } })); }
    finally { global.setInterval = si; global.setTimeout = st; }
    ok(p.actif === false, 'eteint : module inerte');
    ok(lignes.some((l) => /\[smart\] ETEINT \(SMART_MONEY vide\) : aucune minuterie, aucune requete, aucun fichier/.test(l)), 'la ligne de demarrage le dit');
    egal(minuteries, 0, 'aucune minuterie');
    egal((await p.passe()).fait, 'off', 'passe : rien');
    egal((await p.veille()).fait, 'off', 'veille : rien');
    egal(appels, 0, '0 requete, 0 message');
    egal(fs.readdirSync(dossier).length, 0, 'aucun fichier');
    ok(!viemCharge() && !sqlCharge(), 'ni viem ni sql.js ne sont meme charges');
    egal(JSON.stringify(p.instance.vue()), JSON.stringify({ actif: false, pret: false, mode: 'off' }), 'la vue dit « off »');
    egal(p.instance.jeton('0x' + '1'.repeat(40)), null, 'aucun detail');
    const [q, l2] = await muet(async () => M.planifie({ env: { SMART_MONEY: 'oui' }, prendre: espion, dossier, minuteries: false }));
    ok(q.actif === false && l2.some((l) => /inconnu/.test(l)), 'valeur inconnue : inerte, et dit pourquoi');
    egal(M.config({}).mode, 'off', 'config : rien = off');
    egal(M.config({ SMART_MONEY: 'observe' }).mode, 'observe', 'config : observe');
    egal(M.config({ SMART_MONEY: '1' }).mode, 'envoi', 'config : 1 = envoi au proprietaire');
    egal(M.config({ SMART_MONEY: '1', SMART_MONEY_HEURE: '25:61' }).heure, '09:00', 'heure illisible : 09:00');
    ok(!/https?:/.test(M.cree({ env: { SMART_MONEY: '1', SMART_RPC_URL: 'https://secret.example/cle' } }).ligneDemarrage()), 'l\'URL du noeud n\'est jamais journalisee');
    fs.rmSync(dossier, { recursive: true, force: true });
  }

  const K = require('./smart_calcul');
  const R = require('./smart_rpc');
  const SRC = require('./smart_sources');
  const { fauxNoeud } = require('./essais/smart_money/faux_noeud');
  const MONDE = require('./essais/smart_money/monde');
  const A = MONDE.ADR;

  /** Un monde + ses faux services + une horloge. */
  function banc(o) {
    const w = MONDE.cree();
    const etat = { pointe: MONDE.POINTE, contrats: {} };
    const sym = { [A.J1]: 'ONE', [A.J2]: 'TWO', [A.J3]: 'THREE', [A.J4]: 'FOUR', [A.J6]: 'SIX', [A.J3V]: 'OLD3' };
    const F = fauxNoeud({
      logs: () => w.logs, pointe: () => etat.pointe, recus: w.recus, txs: w.txs, horodatage: MONDE.horodatage,
      contrat: (t, fn, a) => {
        if (etat.contrats[t + ':' + fn] !== undefined) return etat.contrats[t + ':' + fn];
        if (fn === 'balanceOf') { const s = MONDE.soldes(w.logs.filter((l) => parseInt(l.blockNumber, 16) <= etat.pointe)); return s.get(t + a[0]) || 0n; }
        if (fn === 'totalSupply') return 10n ** 27n;
        if (fn === 'decimals') return 18;
        if (fn === 'symbol') return sym[t] || 'X';
        if (fn === 'name') return (sym[t] || 'X') + ' token';
        return null;
      },
    });
    const S = MONDE.sources(o);
    const T = { now: MONDE.horodatage(MONDE.POINTE) * 1000 };
    const http = { gt: 0, ds: 0, autres: [] };
    const reponse = (j, status) => ({ status: status || (j == null ? 404 : 200), ok: j != null, headers: { get: () => null }, text: async () => (j == null ? 'not found' : JSON.stringify(j)) });
    const prendre = async (url, init) => {
      const u = String(url);
      if (u.startsWith(R.URL_DEFAUT)) return F.prendre(u, init);
      if (u.startsWith(SRC.GT)) { http.gt++; ok(init && init.headers && init.headers.accept === SRC.ACCEPT_GT, 'GeckoTerminal : en-tete de version documente'); return reponse(S.reponses.gt(u)); }
      if (u.startsWith(SRC.DS)) { http.ds++; return reponse(S.reponses.ds(u)); }
      http.autres.push(u); throw new Error('requete inattendue : ' + u);
    };
    const prives = [], publics = [];
    const tg = { notifyPrive: async (t) => { prives.push(t); return true; }, notify: async (t) => { publics.push(t); return true; } };
    return { w, etat, F, S, T, http, prendre, prives, publics, tg, horloge: () => T.now, dors: async (ms) => { T.now += ms; } };
  }
  const instance = (b, dossier, env, extra) => M.cree(Object.assign({ env: Object.assign({ SMART_MONEY: 'observe', SMART_MONEY_HEURE: '23:59' }, env || {}), prendre: b.prendre, horloge: b.horloge, dors: b.dors,
    dossier, tg: b.tg, actions: b.S.actions, explorer: 'https://robinhoodchain.blockscout.com' }, extra || {}));

  // ================================================== 2. une passe complete
  console.log('-- 2. une passe complete sur le monde fige --');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-passe-'));
  const b = banc();
  const I = instance(b, dossier);
  const [bilan] = await muet(() => I.passe());
  egal(bilan.statut, 'ok', 'la passe finit : ' + (bilan.erreur || ''));
  egal(bilan.retenus, 3, '3 jetons retenus (J1 et J2 a la capitalisation actuelle, J3 au pic)');
  egal(bilan.lus, 3, '3 jetons lus sur la chaine');
  ok(b.http.gt <= SRC.GT_BUDGET_PASSE, `GeckoTerminal : ${b.http.gt} appels <= ${SRC.GT_BUDGET_PASSE}`);
  const B = I.base();
  const jet = (a) => B.un('SELECT * FROM jetons WHERE adresse = ?', [a]);
  ok(!jet(A.STOCK) && !jet(K.ADR.WETH) && !jet(K.ADR.USDG), 'exclus : action tokenisee, WETH, USDG');
  ok(!jet(A.COPIE), 'exclue : la copie d\'adresse (meme symbole, memes caracteres 3-5 et 4 derniers, moins active)');
  ok(!jet(A.EXT), 'exclu : l\'actif venu d\'ailleurs (capitalisation > 10 x fdv)');
  const j1 = jet(A.J1), j2 = jet(A.J2), j3 = jet(A.J3);
  egal(j1.statut + j2.statut + j3.statut, 'lululu', 'les trois sont « lu »');
  egal(j1.createur + ':' + j1.role_createur, A.C1 + ':deployeur', 'J1 : deploye par C1 (contractAddress du recu, 1re trace du jeton)');
  egal(j2.createur + ':' + j2.role_createur + ':' + j2.via, A.C1 + ':lanceur:' + A.FAB, 'J2 : lance par C1 via la fabrique');
  egal(j3.createur + ':' + j3.role_createur + ':' + j3.ancien, A.OP + ':migration:' + A.J3V, 'J3 : migration envoyee par OP, ancien jeton J3V');
  const d3 = JSON.parse(j3.details);
  egal(d3.ancien.createur + ':' + d3.ancien.role, A.C3 + ':lanceur', 'J3 : l\'ancien jeton a ete lance par C3');
  egal(j1.lancement_bloc, MONDE.LANCE.J1, 'J1 : lancement = Initialize du PoolManager');
  egal(j1.lancement_t, MONDE.horodatage(MONDE.LANCE.J1), 'J1 : heure du lancement lue dans l\'en-tete');
  egal(JSON.parse(j1.details).finHeure, MONDE.LANCE.J1 + 36009, 'J1 : dernier bloc de la 1re heure LU (0,1 s par bloc, seconde entiere)');
  const r1 = JSON.parse(j1.recette);
  ok(r1.achatPuisBrule === true, 'J1 recette : C1 a achete puis brule');
  ok(r1.profilSous3h === true, 'J1 recette : profil DexScreener paye 1 h apres');
  egal(r1.robots1reMinute, 2, 'J1 recette : 2 acheteurs dans la 1re minute');
  ok(j3.pic_usd >= 1e6 && /totalSupply read on chain/.test(j3.pic_source), 'J3 : pic = cloture x totalSupply LU (jamais la meche)');
  ok(Math.abs(j3.pic_usd - 1.6e6) < 1, 'J3 : pic 1,6 M$ (cloture), pas 9 M$ (meche)');
  egal(JSON.parse(j1.liquidite).retirePct, 0, 'J1 : liquidite v4 lue (ModifyLiquidity), rien retire');
  const ach = (j, q) => B.un('SELECT * FROM acheteurs WHERE jeton = ? AND wallet = ?', [j, q]);
  egal(B.tous('SELECT * FROM acheteurs WHERE jeton = ?', [A.J1]).length, 14, 'J1 : 14 acheteurs distincts >= 0,01 ETH (le createur et le passant a 0,001 exclus ; LOIN a ~53 h compris)');
  ok(!ach(A.J1, A.C1), 'le createur n\'est jamais dans les premiers acheteurs');
  egal(ach(A.J1, A.TARD).tot, 0, 'TARD (apres la 1re heure) : dans les premiers, mais pas « tot »');
  egal(ach(A.J1, A.S1).issue, 'gagnant', 'S1 sur J1 : gagnant');
  egal(BigInt(ach(A.J1, A.S1).sorti), MONDE.E * 99n / 100n, 'S1 sur J1 : sorti = ce que le WALLET recoit, Swap de 1 ETH moins 1 % retenu par le crochet (revue C1 : lu dans le recu)');
  egal(BigInt(ach(A.J1, A.S1).gain), MONDE.E * 49n / 100n, 'S1 sur J1 : +0,49 ETH exactement (0,99 - 0,5 + solde 0)');
  egal(BigInt(ach(A.J1, A.S1).frais), MONDE.E / 100n, 'S1 sur J1 : les frais lus sont gardes (0,01 ETH)');
  ok(b.F.etat.requetes.some((q) => q.method === 'eth_getTransactionReceipt'), 'lecture « tout » : les recus des echanges des 50 sont lus (les frais n\'y sont que la)');
  egal(ach(A.J1, A.L1).issue, 'perdant', 'L1 qui tient au prix bas : perdant');
  ok(BigInt(ach(A.J1, A.L1).solde) > 0n && BigInt(ach(A.J1, A.L1).gain) > -MONDE.E, 'L1 : le solde au dernier prix compte dans la perte');
  egal(ach(A.J3, A.S3).issue, 'perdant', 'S3 sur J3 : perdant');
  const types = (j, q) => JSON.parse(ach(j, q).marques).map((m) => m.type).join(',');
  egal(types(A.J1, A.G1) + '|' + types(A.J1, A.G2) + '|' + types(A.J1, A.G3), 'groupe|groupe|groupe', 'G1-G3 : achat groupe (meme bloc, meme mise)');
  egal(types(A.J2, A.R1), 'relais', 'R1 : relais (100 % renvoye en 100 blocs)');
  egal(types(A.J1, A.F1), 'finance', 'F1 : finance en WETH par C1 avant son achat');
  egal(types(A.J1, A.S1), '', 'S1 : aucune marque');
  const wal = (q) => B.un('SELECT * FROM wallets WHERE adresse = ?', [q]);
  egal(wal(A.S1).smart + ':' + wal(A.S2).smart, '1:1', 'S1, S2 : smart (tot et gagnants sur 3 jetons, aucune marque)');
  egal(wal(A.S3).smart, 0, 'S3 : 2 gagnants sur 3 -> pas smart');
  egal(wal(A.G1).gagnants, 3, 'G1 est gagnant sur 3 jetons...');
  egal(wal(A.G1).smart + ':' + wal(A.G1).initie, '0:1', '...mais marque : initie, JAMAIS smart');
  egal(wal(A.R1).smart + ':' + wal(A.F1).smart, '0:0', 'R1 et F1 : jamais smart');
  egal(wal(A.S1).verdict, 'pas_assez', 'S1 : 3 projets, aucun verdict sur le z sous 10');
  ok(j1.base_n > 0 && j1.base_gagnants != null, `taux de base de J1 : ${j1.base_gagnants}/${j1.base_n}`);
  const C1 = B.un('SELECT * FROM createurs WHERE adresse = ?', [A.C1]);
  egal(C1.lancements, 2, 'C1 : 2 jetons lus');
  egal(C1.reussites, 2, 'C1 : 2 au-dessus de 1 M$ (Not verified : prix exterieur)');
  egal(B.un('SELECT role FROM createurs WHERE adresse = ?', [A.OP]).role, 'migration', 'OP : operateur de migration, pas createur');
  ok(B.un("SELECT * FROM liens WHERE type = 'meme_createur' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))", [A.J1, A.J2, A.J2, A.J1]), 'lien : J1 et J2 ont le meme createur');
  ok(B.un("SELECT * FROM liens WHERE type = 'migration'"), 'lien : ancien jeton -> nouveau');
  const v = I.vue();
  ok(v.actif && v.pret && v.compteurs.smart === 2 && v.compteurs.lus === 3, 'vue : actif, 3 lus, 2 smart');
  ok(v.wallets[0].smart && v.wallets[1].smart, 'vue : les smart d\'abord');
  ok(v.passe && v.passe.statut === 'ok' && v.passe.appels > 0, 'vue : etat de la derniere passe (appels, statut)');
  let jsonOk = true; try { JSON.stringify(v); JSON.stringify(I.jeton(A.J1)); JSON.stringify(I.wallet(A.G1)); JSON.stringify(I.createur(A.C1)); } catch (e) { jsonOk = false; }
  ok(jsonOk, 'vue et details : du JSON pur (aucun BigInt)');
  const dj = I.jeton(A.J1);
  ok(dj.acheteurs.length === 14 && typeof dj.acheteurs[0].entre_wei === 'string', 'detail d\'un jeton : 14 acheteurs, montants en chaines');
  egal(I.wallet(A.G1).participations.length, 3, 'detail d\'un wallet : ses 3 jetons');
  egal(I.jeton('0x' + '9'.repeat(40)), null, 'jeton inconnu : null');
  ok(b.F.etat.requetes.every((q) => R.METHODES.has(q.method)), 'LECTURE SEULE : chaque requete au noeud est une methode de lecture');
  egal(b.prives.length + b.publics.length, 0, 'observe : aucun message');
  ok(fs.existsSync(path.join(dossier, 'smart_money', 'base.sqlite')) && fs.readdirSync(path.join(dossier, 'smart_money', 'brut')).length > 0, 'base et cache brut ecrits sur le volume');
  ok(fs.readdirSync(path.join(dossier, 'smart_money', 'sources')).length > 0, 'chaque reponse des sources est gardee');

  // ================================================== 3. la veille
  console.log('-- 3. la veille : alertes au proprietaire seul --');
  {
    /* 5 minutes plus tard : C1 deploie J4 puis initialise sa piscine ; S1 puis S2
       l'achetent dans l'heure ; U lance J6 par une fabrique, S1 seul l'achete ;
       S2 rachete J1 (pas nouveau) */
    const P0 = MONDE.POINTE, w = b.w, E = MONDE.E;
    const h4 = w.nouvelleTx(P0 + 100, A.C1, null, { contractAddress: A.J4 });
    w.transfer(h4, P0 + 100, A.J4, K.ADR.ETH_NATIF, A.C1, 10n ** 27n);
    const hp4 = w.nouvelleTx(P0 + 200, A.C1, MONDE.PM);
    w.init(hp4, P0 + 200, MONDE.POOL.J4, A.J4);
    const hp6 = w.nouvelleTx(P0 + 300, A.U, A.FAB);
    w.transfer(hp6, P0 + 300, A.J6, K.ADR.ETH_NATIF, MONDE.PM, 10n ** 27n);
    w.init(hp6, P0 + 300, MONDE.POOL.J6, A.J6);
    w.achat('J4', A.S1, P0 + 400, E / 10n);
    w.achat('J6', A.S1, P0 + 600, E / 10n);
    w.achat('J1', A.S2, P0 + 700, E / 10n);
    w.achat('J4', A.S2, P0 + 1500, E / 10n);
    b.etat.pointe = P0 + 3000;
    b.T.now = MONDE.horodatage(P0 + 3000) * 1000;
    const I2 = instance(b, dossier, { SMART_MONEY: '1' });
    const [r] = await muet(() => I2.veille());
    ok(!r.erreur, 'la veille passe : ' + (r.erreur || ''));
    egal(r.creations, 2, '2 naissances de piscines ETH lues (J4, J6)');
    egal(b.prives.length, 2, '2 alertes au proprietaire : createur connu (J4) et 2 smart (J4)');
    egal(b.publics.length, 0, 'RIEN sur le canal public');
    const tc = b.prives.find((t) => /Known creator/.test(t)) || '';
    ok(/deployed FOUR \(block 12,000,100/.test(tc), 'createur connu : « deployed », avec son bloc (la 1re trace de J4, retrouvee)');
    ok(/<b>Verified<\/b>/.test(tc) && /<b>Not verified<\/b>/.test(tc), 'createur connu : deux sections');
    const ts = b.prives.find((t) => /Smart wallets on/.test(t)) || '';
    ok(ts.includes(K.court(A.S1)) && ts.includes(K.court(A.S2)), 'smart : les deux wallets nommes');
    ok(/dexscreener\.com\/robinhood\//.test(ts) && /nothing is bought/.test(ts), 'smart : lien DexScreener, et « nothing is bought »');
    ok(/no verdict under 10 known outcomes/.test(ts), 'smart : le score dit qu\'il n\'y a pas de verdict sous 10 issues connues');
    ok(/<b>Smart wallets on [^<]* \(owner’s rule, no verdict yet\)<\/b>/.test(ts), 'smart sans verdict : le TITRE le dit (revue C8)');
    ok(!b.prives.some((t) => /SIX/.test(t) && /Smart wallets/.test(t)), 'J6 : un seul smart -> aucune alerte');
    ok(!b.prives.some((t) => t.includes(A.U.slice(0, 6))), 'J6 : createur inconnu -> aucune alerte');
    egal(I2.base().tous("SELECT * FROM alertes WHERE envoye = 1").length, 2, 'les 2 alertes sont gardees, envoyees');
    b.etat.pointe = P0 + 6000; b.T.now = MONDE.horodatage(P0 + 6000) * 1000;
    await muet(() => I2.veille());
    egal(b.prives.length, 2, 'la veille suivante ne repete rien');
    ok(b.F.etat.requetes.every((q) => R.METHODES.has(q.method)), 'LECTURE SEULE pendant la veille');
    I2.sauve();
  }

  // ================================================== 4. redemarrage
  console.log('-- 4. redemarrage --');
  {
    const I3 = instance(b, dossier, { SMART_MONEY: '1' });
    await I3.allume();
    const v3 = I3.vue();
    ok(v3.pret && v3.compteurs.smart === 2 && v3.compteurs.lus === 3, 'la base rouverte sert le dernier etat');
    const finMax = Math.max(...I3.base().tous('SELECT fin FROM passes').map((x) => x.fin));
    egal(v3.t, finMax, '« Updated » = l\'heure de la DERNIERE LECTURE, pas celle du redemarrage (revue P4)');
    ok(v3.veille && v3.veille.statut === 'ok', 'et l\'etat de la derniere veille');
    const avant = b.prives.length;
    await muet(() => I3.veille());
    egal(b.prives.length, avant, 'apres redemarrage : aucune alerte rejouee');
  }

  // ================================================== 5. budget epuise
  console.log('-- 5. budget epuise : la passe s\'arrete, la suivante reprend sur le cache --');
  {
    const d5 = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-budget-'));
    const b5 = banc();
    const Rp = R.cree({ prendre: b5.prendre, horloge: b5.horloge, dors: b5.dors, dossier: path.join(d5, 'smart_money'), budgetAppels: 25 });
    const I5 = instance(b5, d5, {}, { rpc: Rp });
    const [r1] = await muet(() => I5.passe());
    egal(r1.statut, 'budget', 'budget de 25 appels : la passe s\'arrete, et le dit');
    ok(I5.base().tous("SELECT * FROM jetons WHERE statut = 'a_lire'").length >= 1, 'au moins un jeton reste « a lire »');
    let tours = 0, r2 = r1;
    while (r2.statut === 'budget' && tours < 20) { [r2] = await muet(() => I5.passe()); tours++; }
    egal(r2.statut, 'ok', `les passes suivantes finissent (${tours} passes de 25 appels)`);
    egal(I5.base().tous("SELECT * FROM jetons WHERE statut = 'lu'").length, 3, 'et lisent les 3 jetons');
    egal(I5.base().un('SELECT smart FROM wallets WHERE adresse = ?', [A.S1]).smart, 1, 'avec le meme resultat (S1 smart)');
    fs.rmSync(d5, { recursive: true, force: true });
  }

  // ================================================== 5 bis. lecture par acheteur
  console.log('-- 5 bis. vie trop longue : lecture par acheteur, memes resultats --');
  {
    const d6 = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-acheteur-'));
    const b6 = banc();
    const I7 = instance(b6, d6, {}, { lignesToutMax: 5 });
    const [r] = await muet(() => I7.passe());
    egal(r.statut, 'ok', 'la passe finit : ' + (r.erreur || ''));
    const B7 = I7.base();
    egal(B7.tous("SELECT * FROM jetons WHERE mode = 'acheteur'").length, 3, 'les 3 jetons lus « par acheteur »');
    ok(b6.F.etat.requetes.some((q) => q.method === 'eth_getTransactionReceipt'), 'par les recus des transactions des 50');
    egal(B7.tous('SELECT adresse FROM wallets WHERE smart = 1 ORDER BY adresse').map((x) => x.adresse).join(), [A.S1, A.S2].sort().join(), 'les memes smart : S1, S2');
    const m = (j, q) => JSON.parse(B7.un('SELECT marques FROM acheteurs WHERE jeton = ? AND wallet = ?', [j, q]).marques).map((x) => x.type).join();
    egal(m(A.J1, A.G1) + '|' + m(A.J2, A.R1) + '|' + m(A.J1, A.F1), 'groupe|relais|finance', 'les memes marques');
    egal(BigInt(B7.un('SELECT gain FROM acheteurs WHERE jeton = ? AND wallet = ?', [A.J1, A.S1]).gain), MONDE.E * 49n / 100n, 'le meme gain au wei pres (frais du crochet compris)');
    ok(B7.un('SELECT * FROM acheteurs WHERE jeton = ? AND wallet = ?', [A.J1, A.LOIN]), 'LOIN (~53 h apres le lancement) est parmi les premiers : la recherche ne s\'arrete plus a 24 h (revue C5)');
    const l1 = B7.un('SELECT * FROM acheteurs WHERE jeton = ? AND wallet = ?', [A.J1, A.L1]);
    egal(l1.gain, B.un('SELECT gain FROM acheteurs WHERE jeton = ? AND wallet = ?', [A.J1, A.L1]).gain, 'L1 : meme perte (prix lu par le dernier Swap de la piscine)');
    fs.rmSync(d6, { recursive: true, force: true });
  }

  // ================================================== 5 ter. la veille tourne pendant une passe
  console.log('-- 5 ter. la veille ne s\'arrete pas pendant une passe --');
  {
    const d8 = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-concurrent-'));
    const b8 = banc();
    const I8 = instance(b8, d8);
    const [[rp, rv]] = await muet(async () => { const p1 = I8.passe(); const v = I8.veille(); return [await p1, await v]; });
    ok(rv.fait !== 'deja' && !rv.erreur, 'une veille lancee pendant la passe s\'execute (' + JSON.stringify(rv).slice(0, 80) + ')');
    egal(rp.statut, 'ok', 'et la passe finit');
    const B8 = I8.base();
    ok(B8.un("SELECT appels FROM passes WHERE genre = 'veille'").appels <= 60 && B8.un("SELECT appels FROM passes WHERE genre = 'passe'").appels > 0, 'chacune avec son propre budget (veille <= 60 appels)');
    fs.rmSync(d8, { recursive: true, force: true });
  }

  // ================================================== 6. rapport quotidien
  console.log('-- 6. rapport quotidien : une fois par jour, au proprietaire --');
  {
    const I6 = instance(b, dossier, { SMART_MONEY: '1', SMART_MONEY_HEURE: '00:00' });
    const avant = b.prives.length;
    await muet(() => I6.veille());
    const rap = b.prives.slice(avant).find((t) => /daily report/.test(t));
    ok(rap, 'le rapport part a l\'heure');
    ok(rap && rap.includes(K.court(A.S1)) && rap.includes(K.court(A.S2)), 'top smart : S1 et S2');
    ok(rap && /same-block buy group/.test(rap) && /3 wallets in block 10,001,200 on .*, 3 among its first 50/.test(rap), 'les groupes d\'achat dans le meme bloc, avec leur bloc et leur taille (le MOTIF, sous Verified)');
    ok(rap && /Not verified[^]*insider pattern/.test(rap) && !/Verified<\/b> \(read on chain\):[^]*insider group/.test(rap), '« initie » est une deduction : sous Not verified (revue INI-08)');
    ok(rap && /<b>Verified<\/b>/.test(rap) && /<b>Not verified<\/b>/.test(rap), 'Verified / Not verified');
    ok(rap && /nothing is ever bought/.test(rap), 'alertes seulement');
    const n1 = b.prives.length;
    await muet(() => I6.veille());
    egal(b.prives.length, n1, 'pas deux fois le meme jour');
    egal(b.publics.length, 0, 'toujours rien sur le canal public');
  }

  // ================================================== 7. les sources
  console.log('-- 7. les sources (regles du 13/10) --');
  {
    const S = MONDE.sources();
    const p = SRC.piscinesGt(S.reponses.gt('https://api.geckoterminal.com/api/v2/networks/robinhood/pools?sort=h24_volume_usd_desc&include=base_token,quote_token,dex&page=1'));
    egal(p.length, 7, 'GeckoTerminal : 7 piscines lues');
    egal(p[0].actifs24, 400, 'acheteurs + vendeurs sur 24 h');
    egal(p[0].base.symbole, 'ONE', 'symbole tire de « included »');
    const inv = MONDE.sources({ ohlcvInverse: true }).reponses.gt('https://x/ohlcv/day?limit=1000&currency=usd&token=' + A.J3);
    egal(SRC.picJour(inv, A.J3), null, 'OHLCV dont meta.base n\'est pas le jeton : rejete (4 series sur 35 inversees le 13/10)');
    const bon = SRC.picJour(S.reponses.gt('https://x/ohlcv/day?limit=1000&currency=usd&token=' + A.J3), A.J3);
    egal(bon.pic.prix, 1.6e-3, 'pic = meilleure CLOTURE');
    egal(bon.meche.prix, 9e-3, 'la meche est gardee a cote, jamais comme pic');
    egal(SRC.profilPaye({ orders: [{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 5 }], boosts: [] }), 5, 'orders/v1 : forme reelle { orders }');
    egal(SRC.profilPaye([{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 7 }]), 7, 'orders/v1 : forme de la doc (tableau)');
    egal(SRC.profilPaye({ orders: [{ type: 'tokenProfile', status: 'rejected', paymentTimestamp: 7 }] }), null, 'un profil refuse ne compte pas');
    const x = { socle: new Set([K.ADR.WETH]), actions: new Map([[A.STOCK, {}]]), externes: new Set() };
    egal(SRC.exclu(K.ADR.WETH, x), 'base asset', 'WETH exclu');
    egal(SRC.exclu(A.STOCK, x), 'tokenized stock', 'action exclue');
    const base = { quote: { adresse: K.ADR.WETH }, fdv: 2e6, actifs24: 50, volume24: 1e5 };
    ok(SRC.jugeActuel(base, x).garde, '2 M$, 50 acheteurs ou vendeurs : garde');
    ok(!SRC.jugeActuel(Object.assign({}, base, { actifs24: 49 }), x).garde, '49 acheteurs ou vendeurs : refuse');
    ok(!SRC.jugeActuel(Object.assign({}, base, { volume24: 50 * 100001 }), x).garde, 'plus de 100 k$ de volume par acteur : refuse');
    ok(SRC.jugeActuel(Object.assign({}, base, { mcap: 2.1e7 }), x).externe, 'capitalisation > 10 x fdv : actif venu d\'ailleurs');
    ok(!SRC.jugeActuel(Object.assign({}, base, { quote: { adresse: '0x' + '3'.repeat(40) } }), x).garde, 'cotation dans un jeton inconnu (SUSD) : refuse');
    egal([...SRC.copies([{ adresse: A.J1, symbole: 'ONE', actifs24: 400 }, { adresse: A.COPIE, symbole: 'ONE', actifs24: 10 }])].join(), A.COPIE, 'copie : la moins active des deux');
    /* GeckoTerminal : 60 s d'ecart, 90 s de recul, abandon au 2e refus de la passe */
    const T = { now: 0, attentes: [] };
    let k = 0;
    const cli = SRC.cree({ prendre: async () => { k++; return { status: k <= 2 ? 429 : 200, text: async () => (k <= 2 ? '{}' : JSON.stringify({ data: [] })) }; }, horloge: () => T.now, dors: async (ms) => { T.attentes.push(ms); T.now += ms; } });
    const r1 = await cli.nouvelles(1);
    egal(r1, null, '429 puis 429 : rien');
    egal(T.attentes.join(','), '90000', 'un recul de 90 s entre les deux');
    egal(await cli.nouvelles(2), null, 'apres le 2e refus, GeckoTerminal est abandonne pour la passe');
    egal(k, 2, 'aucun appel de plus');
    cli.nouvellePasse();
    ok(Array.isArray(await cli.nouvelles(3)), 'passe suivante : on reessaie');
    ok(T.attentes.includes(60000) || T.attentes.some((a) => a >= 60000), '60 s entre deux appels GeckoTerminal');
    const cli2 = SRC.cree({ prendre: async () => ({ status: 404, text: async () => 'nope' }), horloge: () => 0, dors: async () => {} });
    egal(await cli2.pairesDs(A.J1), null, 'DexScreener 404 : rien...');
    egal(cli2.etat.ds.refus, 0, '...et ce n\'est pas un refus');
  }

  // ================================================== 7 bis. revue du 13/10
  console.log('-- 7 bis. revue du 13/10 : naissance v2 hors fenetre, jeton sous 1 M$, URL secrete, veille ratee, lanceur automatique --');
  {
    const d9 = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-revue-'));
    const b9 = banc();
    const I9 = instance(b9, d9);
    await muet(() => I9.passe());
    const B9 = I9.base();
    /* INI-02 : un jeton v2 dont la paire est nee au bloc 10 100 000, alors que
       l'heure de la source (DexScreener) la place vers 10 742 000 : le 1er journal
       de la paire est HORS de la fenetre de +/- 400 000 blocs ; un 2e echange, au
       bloc 10 650 000, y est (c'est lui que l'ancien code prenait : astro, 16 h trop tard) */
    const w = b9.w, E = MONDE.E, J7 = '0x' + 'a7'.repeat(20), P7 = '0x' + 'b7'.repeat(20), C7 = '0x' + 'c7'.repeat(20), VRAI = 10100000;
    const { journal, pad } = require('./essais/smart_money/faux_noeud');
    let ix = 900000;
    const h0 = w.nouvelleTx(10090000, C7, null, { contractAddress: J7 });
    w.transfer(h0, 10090000, J7, K.ADR.ETH_NATIF, C7, 10n ** 27n);
    const hl = w.nouvelleTx(10095000, C7, J7); w.transfer(hl, 10095000, J7, C7, P7, 10n ** 26n);   // la reserve de la paire (journal du JETON, pas de la paire)
    const achat7 = (bloc, qui, eth) => {
      const h = w.nouvelleTx(bloc, qui, A.ROUTEUR);
      w.ajoute(h, journal(P7, [K.TOPIC.SWAP_V2, pad(A.ROUTEUR), pad(qui)], [eth, 0n, 0n, eth * 1000n], bloc, h, ix++));
      w.ajoute(h, journal(J7, [K.TOPIC.TRANSFER, pad(P7), pad(qui)], [eth * 1000n], bloc, h, ix++));
    };
    achat7(VRAI, A.S1, E / 10n);
    achat7(10650000, A.S2, E / 10n);
    b9.etat.contrats[P7 + ':token0'] = K.ADR.WETH; b9.etat.contrats[P7 + ':token1'] = J7;
    const ds0 = b9.S.reponses.ds;
    b9.S.reponses.ds = (u) => (u.includes(J7) && /token-pairs/.test(u) ? [{ chainId: 'robinhood', dexId: 'uniswap', pairAddress: P7, labels: ['v2'], baseToken: { address: J7, symbol: 'SEVEN' }, quoteToken: { address: K.ADR.WETH, symbol: 'WETH' },
      priceUsd: '0.002', fdv: 2e6, pairCreatedAt: MONDE.horodatage(10700000) * 1000 }] : ds0(u));
    B9.pose('jetons', { adresse: J7, symbole: 'SEVEN', statut: 'a_lire', pic_usd: 2e6, vu_t: 1 });
    const [bj7] = await muet(() => I9.passe());
    ok(bj7.statut === 'ok', 'la passe finit : ' + (bj7.erreur || ''));
    const j7 = B9.un('SELECT * FROM jetons WHERE adresse = ?', [J7]);
    egal(j7.statut + ':' + j7.lancement_bloc, 'lu:' + VRAI, 'v2 : la naissance est le 1er journal de la paire DEPUIS LE BLOC 0, meme hors de la fenetre de l\'estimation (revue INI-02)');
    egal(B9.un('SELECT wallet FROM acheteurs WHERE jeton = ? AND rang = 1', [J7]).wallet, A.S1, 'et le 1er acheteur est celui du vrai lancement');
    /* DexScreener ne rend plus la paire (HM le 14/10) : la piscine deja lue sert */
    b9.S.reponses.ds = (u) => (u.includes(J7) && /token-pairs/.test(u) ? [] : ds0(u));
    B9.ecris("UPDATE jetons SET statut = 'a_lire' WHERE adresse = ?", [J7]);
    const [bj8] = await muet(() => I9.passe());
    egal(bj8.statut + ':' + B9.un('SELECT statut FROM jetons WHERE adresse = ?', [J7]).statut, 'ok:lu', 'paire absente de DexScreener a la relecture : la piscine deja lue sert (plus de « no ETH pool found »)');
    /* C4 : un jeton sous 1 M$ (pic et valeur actuelle) ne compte ni en projet ni en reussite */
    const avant = B9.un('SELECT projets, smart FROM wallets WHERE adresse = ?', [A.S1]);
    B9.ecris('UPDATE jetons SET cap_usd = 960000, pic_usd = NULL WHERE adresse = ?', [A.J2]);
    I9.recalcule();
    const apres = B9.un('SELECT projets, smart FROM wallets WHERE adresse = ?', [A.S1]);
    egal(avant.projets + '>' + apres.projets, '4>3', 'J2 a 0,96 M$ : S1 perd un projet (J1, J2, J3, SEVEN -> J1, J3, SEVEN) (revue C4 : HM a 588 k$ et TROLL a 956 k$ comptaient)');
    egal(avant.smart + '>' + apres.smart, '1>0', 'et n\'est plus « smart » : gagnant sur J1 et J3 seulement parmi les jetons de plus de 1 M$');
    egal(B9.un('SELECT reussites FROM createurs WHERE adresse = ?', [A.C1]).reussites, 1, 'C1 : 1 reussite (J1), plus J2');
    B9.ecris('UPDATE jetons SET cap_usd = 434000000, pic_usd = NULL WHERE adresse = ?', [A.J2]);
    I9.recalcule();
    egal(B9.un('SELECT reussites FROM createurs WHERE adresse = ?', [A.C1]).reussites, 2, 'pic non lu mais valeur actuelle de 434 M$ : reussite (revue C4 : NOVAAI comptait 0/1)');
    /* INI-06 : l'operateur de migration n'est pas un « createur » dans les liens */
    ok(!B9.tous("SELECT * FROM liens WHERE type = 'meme_createur'").some((l) => l.detail === A.OP), 'aucun lien « meme createur » vers l\'operateur de migration');
    /* INI-07 : 8 lancements de C1 (createur connu) dans une veille -> 0 alerte par jeton, un resume */
    const P0 = MONDE.POINTE;
    for (let k = 0; k < 8; k++) {
      const jk = '0x' + 'd' + String(k).padStart(39, '0'), pk = '0x' + 'e' + String(k).padStart(63, '0');
      const hk = w.nouvelleTx(P0 + 100 + k, A.C1, A.FAB);
      w.transfer(hk, P0 + 100 + k, jk, K.ADR.ETH_NATIF, MONDE.PM, 10n ** 27n);
      w.init(hk, P0 + 100 + k, pk, jk);
    }
    b9.etat.pointe = P0 + 3000; b9.T.now = MONDE.horodatage(P0 + 3000) * 1000;
    const I9b = instance(b9, d9, { SMART_MONEY: '1', SMART_MONEY_HEURE: '00:00' });
    const nPrives = b9.prives.length;
    const [rv] = await muet(() => I9b.veille());
    egal(rv.creations, 8, '8 naissances lues');
    ok(!b9.prives.slice(nPrives).some((t) => /Known creator launched/.test(t)), `${K.LANCEUR_AUTO}+ lancements en 24 h : AUCUNE alerte jeton par jeton (revue INI-07)`);
    ok(b9.prives.slice(nPrives).some((t) => /daily report/.test(t) && /1 automated launcher \(8\+ launches in 24 h, 8 launches\): no alert per token/.test(t)), 'le rapport en fait un resume');
    ok(I9b.vue().nouveaux.some((n) => n.auto === 8), 'la vue marque le lanceur automatique');
    /* P4 : une veille RATEE refait l'instantane ; veille_ok garde la derniere reussie */
    const okAvant = I9b.vue().veille_ok;
    const I9c = instance(b9, d9, {}, { rpcVeille: { nouvellePasse() {}, etat: { passe: {} }, pointe: async () => { throw Object.assign(new Error('noeud : timeout'), { abandon: true }); } } });
    await I9c.allume();
    await muet(() => I9c.veille());
    const vv = I9c.vue();
    egal(vv.veille.statut, 'abandon', 'la vue montre la veille ratee (avant : « Last watch: complete » pendant la panne)');
    egal(vv.veille_ok && vv.veille_ok.id, okAvant && okAvant.id, 'et la derniere veille REUSSIE a part (la page juge le perime dessus)');
    fs.rmSync(d9, { recursive: true, force: true });
  }
  // ================================================== 7 ter. lot du 14/10 : piscines hors ETH
  console.log('-- 7 ter. lot du 14/10 : piscines hors ETH (CPU, SI, FROGE), conversion lue sur la chaine --');
  {
    const d11 = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-cote-'));
    const b11 = banc();
    const I11 = instance(b11, d11);
    await muet(() => I11.passe());
    const B11 = I11.base();
    const w = b11.w, E = MONDE.E;
    const { journal, pad } = require('./essais/smart_money/faux_noeud');
    let ix = 950000;
    /* Q : une action tokenisee (cote de la piscine de lancement, comme INTC pour
       CPU) ; JX < Q (currency0 = JX) ; PQU : sa piscine de reference Q/USDG (v4) ;
       REF : la piscine v3 WETH/USDG de reference. Cours ronds : 1 Q brut = 100
       USDG bruts ; 1 USDG brut = 2^28 wei. */
    const Q = '0x3b' + '3b'.repeat(19), JX = '0x3a' + '3a'.repeat(19), JF = '0x39' + '39'.repeat(19), JZ = '0x38' + '38'.repeat(19), QZ = '0x3c' + '3c'.repeat(19);
    const PX = '0x' + '3d'.repeat(32), PE = '0x' + '3e'.repeat(32), PF = '0x' + '3f'.repeat(32), PQU = '0x' + '4d'.repeat(32), PZ = '0x' + '4e'.repeat(32);
    const REF = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca', C7 = '0x' + 'c8'.repeat(20);
    const CONV = 100n * (1n << 28n);
    const SQ_X = (1n << 96n) / 1000n;                       // ~1e6 JX par Q (prix 1e-6 Q par JX)
    const initX = (h, bloc, pool, c0, c1) => w.ajoute(h, journal(MONDE.PM, [K.TOPIC.INIT_V4, pool, pad(c0), pad(c1)], [10000n, 200n, 0n, 1n << 96n, 0n], bloc, h, ix++));
    const swapX = (h, bloc, pool, u0, u1, sq) => w.ajoute(h, journal(MONDE.PM, [K.TOPIC.SWAP_V4, pool, pad(A.ROUTEUR)], [u0, u1, sq, 10n ** 20n, 0n, 10000n], bloc, h, ix++));
    /* JX : lance contre Q au bloc 10 200 000 ; une petite piscine ETH nait plus tard (11 500 000), comme celle de CPU le 30/09 */
    const hx = w.nouvelleTx(10200000, C7, A.FAB);
    w.transfer(hx, 10200000, JX, K.ADR.ETH_NATIF, MONDE.PM, 10n ** 27n);
    initX(hx, 10200000, PX, JX, Q);
    const achatX = (qui, bloc, q) => { const h = w.nouvelleTx(bloc, qui, A.ROUTEUR); swapX(h, bloc, PX, q * 10n ** 6n, -q, SQ_X); w.transfer(h, bloc, JX, MONDE.PM, qui, q * 10n ** 6n); return h; };
    const venteX = (qui, bloc, jet, q) => { const h = w.nouvelleTx(bloc, qui, A.ROUTEUR); swapX(h, bloc, PX, -jet, q, SQ_X); w.transfer(h, bloc, JX, qui, MONDE.PM, jet); return h; };
    achatX(A.S1, 10200100, 10n ** 6n); achatX(A.L1, 10200200, 2n * 10n ** 6n); achatX(A.L2, 10200300, 10n ** 6n);
    venteX(A.S1, 10260000, 10n ** 12n, 3n * 10n ** 6n);
    const he = w.nouvelleTx(11500000, C7, MONDE.PM); initX(he, 11500000, PE, K.ADR.ETH_NATIF, JX);
    const hp = w.nouvelleTx(11500100, A.L4, A.ROUTEUR); swapX(hp, 11500100, PE, -(E / 50n), 10n ** 6n, 1n << 96n); w.transfer(hp, 11500100, JX, MONDE.PM, A.L4, 10n ** 6n);
    /* les references, lues sur la chaine : Q/USDG (v4, Q < USDG : currency0 = Q) et WETH/USDG (v3, token0 = WETH) */
    const hr = w.nouvelleTx(11900000, A.L3, A.ROUTEUR); swapX(hr, 11900000, PQU, 5n, -500n, 10n * (1n << 96n));
    const hr3 = w.nouvelleTx(11900500, A.L3, A.ROUTEUR); w.ajoute(hr3, journal(REF, [K.TOPIC.SWAP_V3, pad(A.ROUTEUR), pad(A.L3)], [-(E / 100n), 10n ** 16n / (1n << 28n), 1n << 82n, 10n ** 20n, 0n], 11900500, hr3, ix++));
    b11.etat.contrats[REF + ':token0'] = K.ADR.WETH; b11.etat.contrats[REF + ':token1'] = K.ADR.USDG;
    /* FROGE : AUCUNE paire sur DexScreener ; la piscine nait dans la tx de creation du jeton (rampe) */
    const hf = w.nouvelleTx(10300000, C7, A.FAB);
    w.transfer(hf, 10300000, JF, K.ADR.ETH_NATIF, MONDE.PM, 10n ** 27n);
    initX(hf, 10300000, PF, JF, Q);
    const hfa = w.nouvelleTx(10300050, A.S2, A.ROUTEUR); swapX(hfa, 10300050, PF, 10n ** 9n, -(10n ** 6n), SQ_X); w.transfer(hfa, 10300050, JF, MONDE.PM, A.S2, 10n ** 9n);
    /* JZ : sa seule piscine est cotee dans un jeton QZ sans piscine de reference */
    const hz = w.nouvelleTx(10400000, C7, A.FAB); w.transfer(hz, 10400000, JZ, K.ADR.ETH_NATIF, MONDE.PM, 10n ** 27n); initX(hz, 10400000, PZ, JZ, QZ);
    const paireDs = (base, quote, pool, version, liq, bloc, symB, symQ) => ({ chainId: 'robinhood', dexId: 'uniswap', pairAddress: pool, labels: ['v' + version], baseToken: { address: base, symbol: symB }, quoteToken: { address: quote, symbol: symQ },
      priceUsd: '0.004', fdv: 4e6, liquidity: { usd: liq, quote: 1 }, pairCreatedAt: MONDE.horodatage(bloc) * 1000 });
    const ds0 = b11.S.reponses.ds;
    const vusDs = [];
    b11.S.reponses.ds = (u) => {
      const m = /token-pairs\/v1\/robinhood\/(0x[0-9a-f]+)/.exec(u);
      if (m) vusDs.push(m[1]);
      if (m && m[1] === JX) return [paireDs(JX, Q, PX, 4, 114900, 10200000, 'CPU', 'INTC'), paireDs(JX, K.ADR.ETH_NATIF, PE, 4, 68, 11500000, 'CPU', 'ETH')];
      if (m && m[1] === Q) return [paireDs(Q, K.ADR.USDG, PQU, 4, 139000, 9000000, 'INTC', 'USDG'), paireDs(Q, A.J1, '0x' + '4f'.repeat(32), 4, 900, 9000000, 'INTC', 'ONE')];
      if (m && (m[1] === JF || m[1] === QZ)) return [];
      if (m && m[1] === JZ) return [paireDs(JZ, QZ, PZ, 4, 5000, 10400000, 'ZED', 'QZ')];
      return ds0(u);
    };
    for (const [j, s] of [[JX, 'CPU'], [JF, 'FROGE'], [JZ, 'ZED']]) B11.pose('jetons', { adresse: j, symbole: s, statut: 'a_lire', pic_usd: 3.88e6, vu_t: 1 });
    const [bx] = await muet(() => I11.passe());
    ok(bx.statut === 'ok', 'la passe finit : ' + (bx.erreur || ''));
    const jx = B11.un('SELECT * FROM jetons WHERE adresse = ?', [JX]);
    egal(jx.statut + ':' + jx.lancement_bloc + ':' + jx.piscine, 'lu:10200000:' + PX, 'CPU : lu sur sa VRAIE piscine de lancement (contre l\'action, bloc 10 200 000), pas sur la petite piscine ETH nee plus tard');
    egal(B11.un('SELECT wallet FROM acheteurs WHERE jeton = ? AND rang = 1', [JX]).wallet, A.S1, 'ses premiers acheteurs sont ceux du vrai lancement (avant : 0 premier acheteur)');
    const ax = B11.un('SELECT * FROM acheteurs WHERE jeton = ? AND wallet = ?', [JX, A.S1]);
    egal(BigInt(ax.entre), 10n ** 6n * CONV, 'ETH entre = la cote payee x la conversion lue (Q -> USDG -> ETH)');
    egal(BigInt(ax.sorti), 3n * 10n ** 6n * CONV, 'ETH sorti, meme conversion');
    egal(ax.issue, 'gagnant', 'paye 1, recu 3 (en Q) : gagnant');
    const dx = JSON.parse(jx.details);
    ok(dx.prix && dx.prix.verifie === true && dx.prix.cote === Q, 'la source du prix est dite : lue sur la chaine (Verified), cote Q');
    egal(dx.prix.chemin.map((e) => e.pool).join(','), PQU + ',' + REF, 'chemin de conversion : Q/USDG puis USDG/WETH, deux piscines lues sur la chaine');
    ok(dx.prix.chemin.every((e) => e.bloc > 0 && /^0x[0-9a-f]{64}$/.test(e.tx)), 'chaque etape a son bloc et sa tx (Verified)');
    ok(/DexScreener/.test(dx.prix.choix || ''), 'le CHOIX de la reference (liquidite DexScreener) est dit Not verified');
    const vx = jx.prix_num != null ? K.valeur(10n ** 6n, { num: BigInt(jx.prix_num), den: BigInt(jx.prix_den) }) : null;
    ok(vx != null && vx <= CONV && vx * 1000n >= CONV * 999n, `prix du jeton en wei : 1e6 JX ~ 1 Q ~ 1 Q x conversion (lu ${vx}, attendu ~${CONV})`);
    const jf = B11.un('SELECT * FROM jetons WHERE adresse = ?', [JF]);
    egal(jf.statut + ':' + jf.lancement_bloc + ':' + jf.piscine, 'lu:10300000:' + PF, 'FROGE : aucune paire DexScreener, la piscine nee dans la tx de creation du jeton est lue');
    const jz = B11.un('SELECT * FROM jetons WHERE adresse = ?', [JZ]);
    ok(jz.statut === 'erreur' && /no on-chain reference price/.test(jz.erreur) && jz.erreur.includes(QZ), 'une cote sans piscine de reference : illisible, et la raison nomme la cote : ' + jz.erreur);
    ok(b11.F.etat.requetes.every((q) => R.METHODES.has(q.method)), 'LECTURE SEULE');
    egal(vusDs.filter((x) => x === Q).length, 1, 'la reference de Q est cherchee UNE fois par passe (memoire)');
    fs.rmSync(d11, { recursive: true, force: true });
  }
  // ================================================== 7 quater. lot du 14/10 : decouverte historique
  console.log('-- 7 quater. lot du 14/10 : decouverte historique bornee (astro), fdv actuelle comptee (NOVAAI) --');
  {
    const d12 = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-histo-'));
    const b12 = banc();
    const w = b12.w;
    const { journal, pad } = require('./essais/smart_money/faux_noeud');
    let ix = 970000;
    /* trois jetons nes il y a longtemps, absents des pages GeckoTerminal (24 h) :
       AST (comme astro : 21,8 k$ aujourd'hui, 12,9 k$ de liquidite, pic au-dessus
       de 1 M$), NOV (comme NOVAAI : 434 M$ aujourd'hui), POU (poussiere : 40 $) */
    const AST = '0x0a' + '0a'.repeat(19), NOV = '0x0b' + '0b'.repeat(19), POU = '0x0c' + '0c'.repeat(19);
    const PAST = '0x' + '5a'.repeat(20), PNOV = '0x' + '5b'.repeat(20), PPOU = '0x' + '5d'.repeat(32);
    const nait2 = (bloc, jeton, paire) => { const h = w.nouvelleTx(bloc, A.C3, M.FABRIQUES_V2[0]); w.ajoute(h, journal(M.FABRIQUES_V2[0], [K.TOPIC.PAIR_V2, pad(jeton < K.ADR.WETH ? jeton : K.ADR.WETH), pad(jeton < K.ADR.WETH ? K.ADR.WETH : jeton)], [BigInt(paire), 1n], bloc, h, ix++)); };
    nait2(9000000, AST, PAST); nait2(8000000, NOV, PNOV);
    const h4 = w.nouvelleTx(9500000, A.C3, MONDE.PM); w.ajoute(h4, journal(MONDE.PM, [K.TOPIC.INIT_V4, PPOU, pad(K.ADR.ETH_NATIF), pad(POU)], [10000n, 200n, 0n, 1n << 96n, 0n], 9500000, h4, ix++));
    const pDs = (j, pool, fdv, liq, prix) => ({ chainId: 'robinhood', dexId: 'uniswap', pairAddress: pool, labels: ['v2'], baseToken: { address: j, symbol: 'X' }, quoteToken: { address: K.ADR.WETH, symbol: 'WETH' },
      priceUsd: String(prix), fdv, marketCap: fdv, liquidity: { usd: liq, quote: 1 }, pairCreatedAt: 1 });
    const lots = [];
    const ds0 = b12.S.reponses.ds, gt0 = b12.S.reponses.gt;
    b12.S.reponses.ds = (u) => {
      const m = /tokens\/v1\/robinhood\/([0-9a-fx,]+)/.exec(u);
      if (m) { const l = m[1].split(','); lots.push(l.length); return [l.includes(AST) && pDs(AST, PAST, 21800, 12944, 0.0000218), l.includes(NOV) && pDs(NOV, PNOV, 434e6, 2e6, 0.434), l.includes(POU) && pDs(POU, PPOU, 900, 40, 0.0000009)].filter(Boolean); }
      return ds0(u);
    };
    const ohlcv = [];
    b12.S.reponses.gt = (u) => {
      const m = /pools\/(0x[0-9a-f]+)\/ohlcv\/day\?.*token=(0x[0-9a-f]+)/.exec(u);
      if (m && m[2] === AST) { ohlcv.push(m[2]); return { data: { attributes: { ohlcv_list: [[MONDE.T0, 1, 2e-2, 1, 1.36e-2, 1], [MONDE.T0 - 86400, 1, 1e-3, 1, 1e-3, 1]] } }, meta: { base: { address: AST } } }; }
      if (m) ohlcv.push(m[2]);
      return gt0(u);
    };
    const I12 = instance(b12, d12);
    /* bornee : UNE fenetre de HISTO_FENETRE blocs par passe, vers le bloc 0 ; les
       naissances (8 000 000 a 9 500 000) sont atteintes en quelques passes */
    const bas = [];
    let bh = null, passes = 0;
    const gtParPasse = [];
    for (; passes < 8; passes++) {
      const g0 = b12.http.gt;
      [bh] = await muet(() => I12.passe());
      gtParPasse.push(b12.http.gt - g0);
      ok(bh.statut === 'ok', 'la passe finit : ' + (bh.erreur || ''));
      bas.push(I12.base().meta('histo_bas'));
      if (bas[bas.length - 1] <= 8000000) break;
    }
    const B12 = I12.base();
    ok(bas.length >= 2 && bas.every((x, i) => (i ? bas[i - 1] : MONDE.POINTE - 1000 + 1) - x <= M.HISTO_FENETRE && (i === 0 || x < bas[i - 1])), `chaque passe descend d'au plus une fenetre (${bas.join(' -> ')})`);
    const ja = B12.un('SELECT * FROM jetons WHERE adresse = ?', [AST]);
    ok(ja && ja.pic_usd >= 1e6, 'AST (21,8 k$ aujourd\'hui, absent des pages de 24 h) est RETROUVE par la decouverte historique, pic ' + (ja && ja.pic_usd));
    ok(ja && Math.abs(ja.cap_usd - 21800) < 1, 'et sa fdv actuelle est gardee a cote (Not verified)');
    const jn = B12.un('SELECT * FROM jetons WHERE adresse = ?', [NOV]);
    ok(jn && jn.cap_usd >= 4e8 && /dexscreener/i.test(jn.cap_source || ''), 'NOV (434 M$ aujourd\'hui) : retenu par sa fdv actuelle, sans attendre un pic');
    ok(!B12.un('SELECT * FROM jetons WHERE adresse = ?', [POU]), 'POU (40 $ de liquidite, fdv 900 $) : ecarte');
    ok(!ohlcv.includes(POU) && !ohlcv.includes(NOV), 'aucun appel OHLCV pour la poussiere ni pour un jeton deja au-dessus de 1 M$');
    ok(lots.length >= 1 && lots.every((n) => n <= 30), 'DexScreener tokens/v1 par lots de 30 au plus');
    const hs = B12.tous('SELECT * FROM historique');
    ok(hs.some((h) => h.adresse === POU && h.statut === 'ecarte' && /liquidity/.test(h.raison || '')), 'la poussiere est ecartee, avec sa raison');
    ok(Math.max(...gtParPasse) <= SRC.GT_BUDGET_PASSE + SRC.GT_BUDGET_HISTO, `GeckoTerminal : au plus ${Math.max(...gtParPasse)} appels par passe <= ${SRC.GT_BUDGET_PASSE} (passe) + ${SRC.GT_BUDGET_HISTO} (historique) : son propre budget, le meme espacement`);
    const v = I12.vue();
    ok(v.historique && v.historique.bas != null && v.historique.vus >= 3, 'la vue dit ou en est la decouverte historique (bloc atteint, jetons vus)');
    /* la decouverte des 24 h : un jeton retenu au pic garde aussi sa fdv actuelle */
    const j3 = B12.un('SELECT * FROM jetons WHERE adresse = ?', [A.J3]);
    ok(j3.cap_usd != null && j3.pic_usd != null, 'J3 (retenu au pic) garde aussi sa fdv actuelle (avant : cap_usd vide)');
    fs.rmSync(d12, { recursive: true, force: true });
  }
  {
    /* N5 : un SMART_RPC_URL a cle, un noeud muet : la vue publique ne contient jamais l'URL */
    const d10 = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-secret-'));
    const b10 = banc();
    const SECRET = 'https://noeud-prive.example/v2/CLE-SECRETE-123';
    const muetNoeud = (u, i) => (String(u).startsWith(SECRET) ? new Promise((x, ko) => { i.signal.addEventListener('abort', () => ko(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) : b10.prendre(u, i));
    const I10 = M.cree({ env: { SMART_MONEY: 'observe', SMART_RPC_URL: SECRET }, prendre: muetNoeud, horloge: b10.horloge, dors: b10.dors, dossier: d10, tg: b10.tg, actions: b10.S.actions, rpcOptions: { delaiMs: 30, reculs: [1, 1] } });
    const [rb] = await muet(() => I10.passe());
    egal(rb.statut, 'abandon', 'noeud muet : la passe est abandonnee');
    const tout = JSON.stringify(I10.vue()) + JSON.stringify(I10.journal());
    ok(!/CLE-SECRETE|noeud-prive/.test(tout), 'la vue publique et le journal ne contiennent JAMAIS l\'URL du noeud (revue N5)');
    ok(/timeout/.test(rb.erreur || ''), 'la cause est dite par un libelle court : ' + rb.erreur);
    fs.rmSync(d10, { recursive: true, force: true });
  }

  fs.rmSync(dossier, { recursive: true, force: true });

  // ================================================== 8. les routes, vrai serveur
  console.log('-- 8. les routes sur le VRAI serveur (SMART_MONEY vide) --');
  {
    const [, lignes] = await muet(async () => { require('./server.js'); await new Promise((r) => setTimeout(r, 2500)); });
    ok(lignes.some((l) => /\[smart\] ETEINT/.test(l)), 'le serveur branche le module, eteint, et le dit');
    const base = 'http://127.0.0.1:' + process.env.PORT;
    const get = async (u) => { const r = await fetch(base + u); return { status: r.status, j: await r.json().catch(() => null), h: r.headers }; };
    let r = await get('/ai/smart');
    egal(r.status, 200, '/ai/smart : 200');
    egal(r.j && r.j.actif, false, '/ai/smart : { actif: false }');
    egal(r.h.get('access-control-allow-origin'), '*', 'public (CORS), comme la colonie');
    r = await get('/ai/smart/jeton?a=0x123');
    egal(r.status, 400, 'adresse invalide : 400');
    r = await get('/ai/smart/wallet?a=' + A.S1);
    egal(r.status, 404, 'eteint : 404');
    ok(r.j && /off or not ready/.test(r.j.erreur), 'et dit pourquoi');
    r = await get('/ai/smart/nimporte');
    egal(r.status, 404, 'chemin inconnu : 404');
    let dernier = 200;
    for (let i = 0; i < 30; i++) dernier = (await get('/ai/smart')).status;
    egal(dernier, 429, '30 lectures par minute et par IP, puis 429');
  }

  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* rien */ }
  if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
  console.log(`smart_money.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
