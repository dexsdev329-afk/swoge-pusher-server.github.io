'use strict';
/*
 * L'analyste du brief DANS le detecteur smart money (smart_money.js, 15/10/2026).
 *
 * Un faux noeud (essais/smart_money/faux_noeud.js) sert un lancement fait comme
 * celui sonde le 15/10 sur la chaine (0x2abd55…, tx 0x7c2b85c9…) : le dev
 * envoie la tx a un lanceur, le jeton est frappe, la piscine v4 initialisee, la
 * liquidite ajoutee par un gestionnaire de positions qui frappe un NFT vers un
 * CONTRAT (le verrou), et le dev achete un peu dans la meme tx. Quinze minutes
 * plus tard, Sniper 1 achete par un routeur.
 *
 * L'intention :
 *  1. l'achat de Sniper 1 declenche le verdict ; ACHETER part au proprietaire
 *     SEUL (notifyPrive), au format du brief, une fois ; la colonie recoit le
 *     verdict en signal ; rien sur le canal public ; lecture seule ;
 *  2. un NFT de liquidite tenu par un WALLET : EVITER, rien ne part ;
 *  3. sans les faits de la colonie (capitalisation, taxe inconnues) : jamais
 *     ACHETER — SURVEILLER ;
 *  4. un airdrop (recu sans echange) et un bot seul : aucun verdict ;
 *  5. SMART_MONEY=observe : le verdict est garde, rien n'est envoye (ni au
 *     public) ;
 *  6. (16/10) le PUBLIC : en mode 1, le verdict part aussi au flux public et au
 *     canal, en anglais, par gabarit ; le texte que le MODELE a redige pour le
 *     proprietaire n'y entre jamais, ni la cle ; SMART_PUBLIC=0 : rien.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { if (c) { n++; console.log('  ok   ' + m); } else { rates++; console.log('  RATE ' + m); } };
const egal = (a, b, m) => ok(a === b || String(a) === String(b), `${m} (lu ${a}, attendu ${b})`);
async function muet(fn) {
  const lignes = []; const l = console.log; console.log = (...a) => lignes.push(a.join(' '));
  try { return [await fn(), lignes]; } finally { console.log = l; }
}
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-analyste-'));
delete process.env.ANTHROPIC_API_KEY;

const M = require('./smart_money');
const K = require('./smart_calcul');
const R = require('./smart_rpc');
const SRC = require('./smart_sources');
const { fauxNoeud, journal, pad } = require('./essais/smart_money/faux_noeud');
const MONDE = require('./essais/smart_money/monde');

const A = (s) => '0x' + s.repeat(40 / s.length).slice(0, 40);
const SNIPER = '0x7632bd8e72767ed67a724c564c42ceea98e81180';
const BOT = '0x2fd1887e5d99014cb0b8884f06560ed20d65003d';
const JN = A('d1'), DEV = A('de'), LANCEUR = A('1a'), POSM = A('e3'), VERROU = A('6c'), WALLET_LP = A('6d');
const POOL_N = '0x' + 'd2'.repeat(32);
const Q = 1n << 96n, E = 10n ** 18n, OFFRE = 10n ** 27n;
const MODIFY = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
const P0 = MONDE.POINTE;
const LANCE = P0 + 100, ACHAT_SNIPER = P0 + 9100, POINTE2 = P0 + 10300;   // 15 min apres le lancement ; 2 min plus tard, la veille

function scene(o) {
  o = o || {};
  const w = MONDE.cree();
  let idx = 900000;
  const ajoute = (h, l) => { w.logs.push(l); w.recus[h].logs.push(l); };
  const tr = (h, b, jeton, de, vers, v) => ajoute(h, journal(jeton, [K.TOPIC.TRANSFER, pad(de), pad(vers)], [v], b, h, idx++));
  const swap = (h, b, u0, u1, sq) => ajoute(h, journal(MONDE.PM, [K.TOPIC.SWAP_V4, POOL_N, pad(A('77'))], [u0, u1, sq, 10n ** 20n, 0n, 10000n], b, h, idx++));
  /* le lancement, comme celui sonde le 15/10 */
  const hl = w.nouvelleTx(LANCE, DEV, LANCEUR);
  tr(hl, LANCE, JN, K.ADR.ETH_NATIF, LANCEUR, OFFRE);
  w.init(hl, LANCE, POOL_N, JN);
  ajoute(hl, journal(MONDE.PM, [MODIFY, POOL_N, pad(POSM)], [0n, 0n, 10n ** 24n, 0n], LANCE, hl, idx++));
  ajoute(hl, { address: POSM, topics: [K.TOPIC.TRANSFER, pad(K.ADR.ETH_NATIF), pad(o.lpWallet ? WALLET_LP : VERROU), pad('0x14e')], data: '0x', blockNumber: '0x' + LANCE.toString(16), transactionHash: hl, logIndex: '0x' + (idx++).toString(16) });
  tr(hl, LANCE, JN, LANCEUR, MONDE.PM, OFFRE);
  swap(hl, LANCE, -(E / 16n), 10n ** 24n, Q);
  tr(hl, LANCE, JN, MONDE.PM, DEV, 10n ** 24n);                 // le petit achat du dev : 0,0625 ETH, 0,1 % de l'offre
  /* l'achat du wallet de la liste, par un routeur */
  const qui = o.acheteur || SNIPER;
  if (!o.sansAchat) {
    const ha = w.nouvelleTx(ACHAT_SNIPER, qui, A('77'));
    swap(ha, ACHAT_SNIPER, -(E / 20n), 10n ** 24n, (Q * 4n) / 5n);    // le prix a fait ×1,56 depuis le lancement
    tr(ha, ACHAT_SNIPER, JN, MONDE.PM, A('77'), 10n ** 24n);
    tr(ha, ACHAT_SNIPER, JN, A('77'), qui, 10n ** 24n);
  }
  /* un airdrop de spam vers Sniper 1 : un jeton recu, aucun echange */
  if (o.airdrop) {
    const hd = w.nouvelleTx(ACHAT_SNIPER, A('5a'), JN);
    for (let i = 0; i < 5; i++) tr(hd, ACHAT_SNIPER, JN, A('5a'), i === 0 ? SNIPER : A('5' + i), 1000n);
  }
  const etat = { pointe: P0 + 3000 };
  const F = fauxNoeud({
    logs: () => w.logs, pointe: () => etat.pointe, recus: w.recus, txs: w.txs, horodatage: MONDE.horodatage,
    contrat: (t, fn, a) => {
      if (fn === 'balanceOf') { const s = MONDE.soldes(w.logs.filter((l) => parseInt(l.blockNumber, 16) <= etat.pointe)); return s.get(t + a[0]) || 0n; }
      if (fn === 'totalSupply') return OFFRE;
      if (fn === 'decimals') return 18;
      if (fn === 'symbol') return t === JN ? 'NEWT' : 'X';
      if (fn === 'name') return 'x';
      return null;
    },
    /* le code des adresses : le verrou est un contrat, le reste des wallets */
    surRequete: (q) => (q.method === 'eth_getCode' ? { jsonrpc: '2.0', id: q.id, result: String(q.params[0]).toLowerCase() === VERROU ? '0x6080604052' : '0x' } : null),
  });
  const S = MONDE.sources();
  const T = { now: MONDE.horodatage(etat.pointe) * 1000 };
  const reponse = (j) => ({ status: j == null ? 404 : 200, ok: j != null, headers: { get: () => null }, text: async () => (j == null ? 'not found' : JSON.stringify(j)) });
  const autres = [];
  const prendre = async (url, init) => {
    const u = String(url);
    if (u.startsWith(R.URL_DEFAUT)) return F.prendre(u, init);
    if (u.startsWith(SRC.GT)) return reponse(S.reponses.gt(u));
    if (u.startsWith(SRC.DS)) return reponse(S.reponses.ds(u));
    /* un modele simule (section 6) : sa reponse porte une marque qu'aucun texte public ne doit porter */
    if (o.modele && u.startsWith('https://api.anthropic.com/')) return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: o.modele }] }) };
    autres.push(u); throw new Error('requete inattendue : ' + u);
  };
  const prives = [], publics = [], colonie = [], faitsDemandes = [], chats = [];
  const tg = { notifyPrive: async (t) => { prives.push(t); return true; }, notify: async (t) => { publics.push(t); return true; }, notifyChat: async (c, t) => { chats.push({ c, t }); return true; } };
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-analyste-'));
  const faits = o.sansColonie ? undefined : async (a) => { faitsDemandes.push(a); return { mc: 20000, liq: 8000, taxe: { achat: 0, vente: 0 }, ch_h6: 40, sym: 'NEWT' }; };
  const I = M.cree({ env: Object.assign({ SMART_MONEY: o.mode || '1', SMART_MONEY_HEURE: '23:59' }, o.env || {}), prendre, horloge: () => T.now, dors: async (ms) => { T.now += ms; },
    dossier, tg, actions: S.actions, explorer: 'https://robinhoodchain.blockscout.com', faits, surVerdict: (v) => colonie.push(v) });
  return {
    I, F, prives, publics, colonie, faitsDemandes, autres, chats,
    async deuxVeilles() {
      await muet(() => I.veille());                                     // la naissance
      etat.pointe = POINTE2; T.now = MONDE.horodatage(POINTE2) * 1000;
      const [r] = await muet(() => I.veille());                         // l'achat
      return r;
    },
  };
}

(async () => {
  // ================================================== 1. ACHETER
  console.log('-- 1. Sniper 1 achete 15 min apres le lancement : ACHETER --');
  {
    const s = scene();
    const r = await s.deuxVeilles();
    ok(!r.erreur, 'les deux veilles passent : ' + (r.erreur || ''));
    ok(r.analyste && r.analyste.evalues === 1, 'un jeton juge par l\'analyste');
    egal(JSON.stringify(r.analyste.verdicts), JSON.stringify({ ACHETER: 1 }), 'verdict : ACHETER');
    egal(s.prives.length, 1, 'une alerte au proprietaire');
    egal(s.publics.length, 0, 'RIEN sur le canal public');
    const t = s.prives[0] || '';
    ok(t.startsWith('<b>🟢 ACHETER — NEWT</b>'), 'le format du brief : emoji, verdict, symbole lu sur la chaine');
    ok(/Âge et capitalisation : 17 min · 20 k\$/.test(t), 'age (17 min, lu sur la chaine) et capitalisation (la colonie)');
    ok(/Sniper 1 \(0x7632…1180\) il y a 2 min/.test(t), 'quel wallet de la liste, et quand');
    ok(/stop −30 %/.test(t) && /Pas un conseil financier\.$/.test(t), 'le plan, et « Pas un conseil financier. »');
    egal(s.colonie.length, 1, 'la colonie recoit le verdict');
    const c = s.colonie[0] || {};
    ok(c.verdict === 'ACHETER' && c.jeton === JN && c.wallets.length === 1 && c.wallets[0].role === 'SNIPER_1', 'en codes : verdict, jeton, wallet et role');
    const cond = Object.fromEntries((c.conditions || []).map((x) => [x.cle, x]));
    egal(cond.lp_pas_wallet && cond.lp_pas_wallet.valeur, 'contrat', 'la liquidite : NFT de position frappe vers un CONTRAT (lu dans la tx de lancement)');
    egal(cond.dev_moins_25 && cond.dev_moins_25.valeur, 0.1, 'la part du dev : 0,1 % de l\'offre (balanceOf / totalSupply)');
    egal(cond.pas_deja_x3 && cond.pas_deja_x3.valeur, 1.56, 'le multiple depuis le lancement : ×1,56 (sqrtP du lancement contre celui de l\'achat)');
    egal(cond.pas_bundle && cond.pas_bundle.valeur.premiereMinute, 0, 'la premiere minute : aucun acheteur hors le dev');
    egal(cond.dev_ne_vend_pas && cond.dev_ne_vend_pas.valeur, false, 'le dev ne vend pas');
    egal(s.faitsDemandes.join(), JN, 'les faits de marche sont demandes a la colonie (ses lecteurs), une fois');
    ok(s.F.etat.requetes.every((q) => R.METHODES.has(q.method)), 'LECTURE SEULE : aucune methode hors de la liste fermee');
    egal(s.autres.length, 0, 'aucune requete hors du noeud et des sources (pas de modele sans cle)');
    const v = s.I.vue();
    ok(v.analyste && v.analyste.derniers.length === 1 && v.analyste.derniers[0].verdict === 'ACHETER' && !JSON.stringify(v.analyste).match(/Pas un conseil/), 'la vue publique : le verdict en code, aucun texte du proprietaire');
    egal(s.I.base().tous("SELECT * FROM alertes WHERE genre = 'analyste' AND envoye = 1").length, 1, 'l\'alerte est gardee, envoyee');
    await muet(() => s.I.veille());
    egal(s.prives.length, 1, 'la veille suivante ne repete rien');
  }
  // ================================================== 2. liquidite tenue par un wallet
  console.log('-- 2. le NFT de liquidite va a un WALLET : EVITER --');
  {
    const s = scene({ lpWallet: true });
    const r = await s.deuxVeilles();
    egal(JSON.stringify(r.analyste && r.analyste.verdicts), JSON.stringify({ EVITER: 1 }), 'verdict : EVITER');
    egal(s.prives.length, 0, 'EVITER ne part pas au proprietaire');
    egal(s.colonie.length, 0, 'ni a la colonie');
  }
  // ================================================== 3. sans les faits de la colonie
  console.log('-- 3. capitalisation et taxe inconnues : jamais ACHETER --');
  {
    const s = scene({ sansColonie: true });
    const r = await s.deuxVeilles();
    egal(JSON.stringify(r.analyste && r.analyste.verdicts), JSON.stringify({ SURVEILLER: 1 }), 'verdict : SURVEILLER (fail closed)');
    ok((s.prives[0] || '').startsWith('<b>🟡 SURVEILLER'), 'SURVEILLER part au proprietaire');
    ok(s.colonie.length === 1 && s.colonie[0].verdict === 'SURVEILLER' && s.colonie[0].inconnues.includes('pas_taxe') && s.colonie[0].inconnues.includes('cap_sous_35k'), 'la colonie le recoit, avec les inconnues nommees');
  }
  // ================================================== 4. airdrop, bot seul
  console.log('-- 4. un airdrop et un bot seul : aucun verdict --');
  {
    const s = scene({ sansAchat: true, airdrop: true });
    const r = await s.deuxVeilles();
    ok(!r.analyste, 'airdrop de spam vers Sniper 1 (recu, aucun echange) : ignore, aucun verdict');
    egal(s.I.base().tous('SELECT * FROM achats_smart').filter((a) => a.wallet === SNIPER).length, 0, 'et aucun « achat » enregistre');
    const s2 = scene({ acheteur: BOT });
    const r2 = await s2.deuxVeilles();
    ok(!r2.analyste, 'un bot rapide seul : son achat ne declenche rien');
    egal(s2.I.base().tous('SELECT * FROM achats_smart').filter((a) => a.wallet === BOT).length, 1, 'mais son achat est lu (il compte pour « seulement des bots »)');
  }
  // ================================================== 5. observe
  console.log('-- 5. SMART_MONEY=observe : garde, n\'envoie rien --');
  {
    const s = scene({ mode: 'observe' });
    await s.deuxVeilles();
    egal(s.prives.length, 0, 'rien envoye');
    egal(s.I.base().tous("SELECT * FROM alertes WHERE genre = 'analyste' AND envoye = 0").length, 1, 'le verdict est garde (envoye = 0)');
    egal(s.colonie.length, 1, 'la colonie le recoit quand meme (elle l\'observe)');
    egal(s.I.base().tous('SELECT * FROM publiques').length + s.chats.length, 0, 'observe : rien au public, ni flux ni canal');
    egal(s.I.alertesPubliques(0).actif, false, 'et la route publique dit « off »');
  }
  // ================================================== 6. le public
  console.log('-- 6. le public : la fiche anglaise, jamais le texte du modele --');
  {
    const MARQUE = 'MODELE-NOTE-INTERNE-7731';
    const modele = '🟢 ACHETER — NEWT\nNote du modele ' + MARQUE + ', a ne jamais publier.\nPas un conseil financier.';
    const s = scene({ modele, env: { ANTHROPIC_API_KEY: 'sk-ant-CLE-SECRETE', SMART_PUBLIC_TG_CHAT: '-1001234567890' } });
    await s.deuxVeilles();
    ok((s.prives[0] || '').includes(MARQUE), 'le proprietaire recoit le texte redige par le modele (inchange)');
    const v = s.I.alertesPubliques(0);
    const a = v.alertes[0] || {};
    egal(v.alertes.length, 1, 'une alerte dans le flux public');
    ok(a.categorie === 'analyste' && a.verdict === 'vert' && a.fiche && a.fiche.titre === 'Analyst: entry setup met' && a.fiche.symbole === 'NEWT', 'categorie analyste, 🟢, titre anglais, symbole lu sur la chaine');
    ok(a.fiche && a.fiche.qui.length === 1 && a.fiche.qui[0].nom === 'Sniper 1' && a.fiche.qui[0].adresse === SNIPER && /2 min ago/.test(a.fiche.qui[0].detail || ''), 'qui : « Sniper 1 », son adresse entiere, il y a 2 min');
    ok(a.fiche && a.fiche.plan.entree === 'small fixed stake (~$100)' && a.fiche.plan.stop === '-30%', 'le plan du brief, en anglais');
    egal(s.chats.length, 1, 'le canal public recoit le meme texte');
    const tout = JSON.stringify(v) + (s.chats[0] || {}).t;
    ok(!tout.includes(MARQUE) && !/CLE-SECRETE|sk-ant/.test(tout), 'ni le texte du modele, ni la cle, ni dans la route ni dans le canal');
    ok(!/[éèêàùç]|Pas un conseil|ACHETER|SURVEILLER/.test(tout), 'aucun mot francais public');
    ok(/Not financial advice\.$/.test((s.chats[0] || {}).t || '') && /Not financial advice\.$/.test(a.texte || ''), 'le canal et le flux finissent par « Not financial advice. »');
    egal(s.publics.length, 0, 'le canal des annonces de gains (notify) n\'est jamais touche');
    const s0 = scene({ modele, env: { ANTHROPIC_API_KEY: 'sk-ant-CLE-SECRETE', SMART_PUBLIC: '0', SMART_PUBLIC_TG_CHAT: '-1001234567890' } });
    await s0.deuxVeilles();
    ok(s0.prives.length === 1 && s0.I.base().tous('SELECT * FROM publiques').length === 0 && s0.chats.length === 0, 'SMART_PUBLIC=0 : le proprietaire seul, rien au public');
  }
  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + (n + rates) : 'tout passe : ' + n + ' verifications'));
  process.exitCode = rates ? 1 : 0;
})().catch((e) => { console.log('EXCEPTION : ' + (e && e.stack || e)); process.exitCode = 1; });
