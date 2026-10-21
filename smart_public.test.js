'use strict';
/*
 * Les alertes smart money OUVERTES AUX JOUEURS (smart_public.js, 16/10/2026).
 *
 * Noeud, DexScreener, Telegram et horloge simules ; la base est celle du
 * detecteur (sql.js, en memoire). L'intention :
 *  1. les interrupteurs : actif seulement avec SMART_MONEY=1 ; SMART_PUBLIC=0
 *     et le mode observe n'envoient rien au public ;
 *  2. le texte public est construit par GABARIT, en anglais, finit par « Not
 *     financial advice. », et ne porte que les champs listes : rien d'un champ
 *     inconnu, aucune donnee privee, une chaine venue de la chaine nettoyee ;
 *  3. le canal : plafond par heure (au-dela : la page seulement, compte), et le
 *     delai (rien de visible, ni sur la page ni sur le canal, avant l'heure) ;
 *  4. la MESURE : prix a l'alerte, puis +5/+15/+30/+60/+120 min au fil des
 *     cycles, meilleur et pire releves ; au plus un appel DexScreener par
 *     cycle ; un palier rate reste manquant ; la reference tardive est refusee ;
 *  5. le bilan par categorie REFUSE de conclure sous 40 mesures a +30 min ; une
 *     alerte rouge n'entre pas dans sa categorie ;
 *  6. la route du VRAI serveur : CORS, no-store, `depuis` valide, debit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { if (c) n++; else { rates++; console.log('  RATE ' + m); } };
const egal = (a, b, m) => ok(a === b || String(a) === String(b), `${m} (lu ${a}, attendu ${b})`);
async function muet(fn) {
  const lignes = []; const l = console.log; const w = console.warn; console.log = (...a) => lignes.push(a.join(' ')); console.warn = () => {};
  try { return [await fn(), lignes]; } finally { console.log = l; console.warn = w; }
}
process.env.PORT = String(8870 + (process.pid % 50));
process.env.RPC_URL = '';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-public-'));
process.env.SMART_MONEY = '';
for (const k of ['TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_BACKUP_CHAT_ID', 'TG_BACKUP_ID', 'SMART_RPC_URL', 'ANTHROPIC_API_KEY']) delete process.env[k];

const P = require('./smart_public');
const SB = require('./smart_base');
const SRC = require('./smart_sources');
const SS = require('./smart_signaux');
const M = require('./smart_money');

const A = (s) => '0x' + s.repeat(40 / s.length).slice(0, 40);
const J1 = A('a1'), J2 = A('a2'), J3 = A('a3'), DEV = '0x58ea497c16422a344a50785f6f23ca92082e2e03', SNIPER = '0x7632bd8e72767ed67a724c564c42ceea98e81180';
const FR = /[éèêàùçâîôû]|\b(le|les|des|une|est|pour|avec|sans|jeton|aucun|achat|vente|dev connu|courbe|lancement|Pas un conseil)\b/i;

/** Un banc : base en memoire, horloge, DexScreener et Telegram simules. */
async function banc(env, o) {
  o = o || {};
  const B = await SB.ouvre(null);
  const T = { now: Date.UTC(2026, 9, 16, 12, 0, 0) };
  const prix = new Map();          // jeton -> prix USD (DexScreener simule)
  const courbe = new Map();        // jeton -> prix USD (courbe suivie simulee)
  const ds = [], chats = [], autres = [];
  const prendre = async (url) => {
    const u = String(url);
    if (!u.startsWith(SRC.DS + '/tokens/v1/robinhood/')) { autres.push(u); throw new Error('requete inattendue ' + u); }
    const l = u.split('/').pop().split(',');
    ds.push({ t: T.now, n: l.length });
    const corps = l.filter((j) => prix.has(j)).map((j) => ({ chainId: 'robinhood', pairAddress: A('77'), dexId: 'uniswap', labels: ['v4'], baseToken: { address: j, symbol: 'X' }, quoteToken: { address: A('ee'), symbol: 'WETH' },
      priceUsd: String(prix.get(j)), liquidity: { usd: 10000 }, fdv: prix.get(j) * 1e9 }));
    return { ok: true, status: 200, text: async () => JSON.stringify(corps) };
  };
  const tg = { notifyChat: async (c, t) => { chats.push({ c, t, at: T.now }); return o.tgRefuse ? false : true; } };
  const I = P.cree({ base: () => B, horloge: () => T.now, prendre, env: Object.assign({ SMART_MONEY: '1' }, env || {}), explorer: 'https://robinhoodchain.blockscout.com', tg,
    prixCourbe: (j) => (courbe.has(j) ? { prix: courbe.get(j), liq: null, gradue: false } : null), mesure: o.mesure || null });
  /* avance de `min` minutes, un tic par minute (le cycle des lancements) */
  const avance = async (min, sansTic) => { for (let k = 0; k < min; k++) { T.now += 60e3; if (!sansTic) await I.tic(); } };
  return { B, T, prix, courbe, ds, chats, autres, I, avance };
}
/** Une alerte de lancement type, champs comme smart_lancements les passe. */
const PUB = (o) => Object.assign({ categorie: 'dev', verdict: 'vert', titre: { cle: 'lancement', val: { cle: 'dev_connu', val: 'CrawlScan' } }, symbole: 'JUDGEBOT', ageMin: 0.5,
  courbe: { eth: 0.0234, seuilEth: 4.2, gradue: false }, capUsd: null, capSource: 'curve', qui: [{ adresse: DEV, role: 'deployer', eth: 0.028 }],
  promo: { profil: null, pubs: [], boosts: 0, boostsRecents: 0, montantRecent: 0, pousse: false }, risque: { cle: 'rechute' }, plan: { cle: 'vert' }, prixUsd: null }, o || {});

(async () => {
  // ================================================== 1. les interrupteurs
  console.log('-- 1. interrupteurs --');
  {
    const c0 = P.config({ SMART_MONEY: '1' });
    ok(c0.actif && c0.maxH === 12 && c0.delaiS === 0 && c0.tgChat === null && c0.tgLien === null, 'SMART_MONEY=1 : public actif par defaut, 12 par heure, delai 0, aucun canal');
    ok(!P.config({ SMART_MONEY: '1', SMART_PUBLIC: '0' }).actif, 'SMART_PUBLIC=0 : tout le public eteint');
    ok(P.config({ SMART_MONEY: '1', SMART_PUBLIC: '1' }).actif, 'SMART_PUBLIC=1 : actif');
    ok(!P.config({ SMART_MONEY: 'observe' }).actif && P.config({ SMART_MONEY: 'observe' }).raison === 'observe mode', 'observe : rien au public, et dit pourquoi');
    ok(!P.config({}).actif, 'detecteur eteint : rien');
    egal(P.config({ SMART_MONEY: '1', SMART_PUBLIC_MAX_H: 'abc' }).maxH, 12, 'plafond illisible : 12');
    egal(P.config({ SMART_MONEY: '1', SMART_PUBLIC_DELAI_S: '-5' }).delaiS, 0, 'delai illisible : 0');
    egal(P.config({ SMART_MONEY: '1', SMART_PUBLIC_DELAI_S: '999999' }).delaiS, 86400, 'delai borne a 24 h');
    egal(P.config({ SMART_MONEY: '1', SMART_PUBLIC_TG_LIEN: 'https://t.me/swoge_alerts' }).tgLien, 'https://t.me/swoge_alerts', 'lien t.me accepte');
    ok(['javascript:alert(1)', 'https://evil.example/t.me/x', 'http://t.me/x', 'https://t.me/"><img>'].every((l) => P.config({ SMART_MONEY: '1', SMART_PUBLIC_TG_LIEN: l }).tgLien === null), 'tout autre lien : refuse (jamais un lien vers ailleurs)');
    for (const env of [{ SMART_PUBLIC: '0' }, { SMART_MONEY: 'observe' }]) {
      const b = await banc(env);
      b.prix.set(J1, 1);
      const r = await b.I.publie('lancement', 'lancement:' + J1, J1, PUB());
      await b.avance(10);
      ok(r === null && b.B.tous('SELECT * FROM publiques').length === 0 && b.chats.length === 0 && b.ds.length === 0, JSON.stringify(env) + ' : aucune ligne, aucun message, aucun appel');
      ok(b.I.vue(0).actif === false && b.I.vue(0).alertes.length === 0, JSON.stringify(env) + ' : la route dit « off »');
    }
  }

  // ================================================== 2. le gabarit
  console.log('-- 2. le texte public : gabarit anglais, champs listes --');
  {
    const f = P.construitFiche(J1, PUB({ texte: 'TEXTE PRIVE secret', note: 'SMART_RPC_URL=https://noeud-prive.example/CLE', cle: 'sk-ant-xyz', modele: 'MODELE-NOTE' }), { explorer: 'https://robinhoodchain.blockscout.com', maintenant: Date.now() });
    const t = P.textes(f);
    ok(t.html.startsWith('🟢 <b>Known dev launch (Known dev #1) — $JUDGEBOT</b>') && !/CrawlScan/.test(t.html), 'titre : verdict, gabarit, symbole ; le dev connu sous un nom NEUTRE (16/10)');
    ok(t.html.includes('<code>' + J1 + '</code>') && t.html.includes('Known dev #1 (dev buy 0.028 ETH)') && !t.html.includes(DEV), 'adresse ENTIERE du jeton ; qui : nom neutre, AUCUNE adresse de dev (decision du proprietaire, 16/10)');
    ok(/• Age and state: 30 s old · curve 0\.023 \/ 4\.20 ETH \(1%\)/.test(t.html), 'age et etat de la courbe');
    ok(/• DexScreener promo: no paid profile · no ads · no boosts/.test(t.html) && /• Main risk: Most launches fall 60-90% after their first peak\./.test(t.html), 'promo et risque principal');
    ok(/• Plan: entry small fixed stake; stop 30% trailing stop; target sell 75% at 2x, keep 25% for a rare 10x/.test(t.html), 'plan : entree, stop, objectif');
    ok(t.html.includes('<a href="https://dexscreener.com/robinhood/' + J1 + '">DexScreener</a> · <a href="https://robinhoodchain.blockscout.com/token/' + J1 + '">Explorer</a>'), 'liens DexScreener et explorateur');
    ok(t.html.endsWith('\nNot financial advice.') && t.brut.endsWith('\nNot financial advice.'), 'finit par « Not financial advice. » (Telegram et page)');
    const tout = JSON.stringify(f) + t.html + t.brut;
    ok(!/TEXTE PRIVE|noeud-prive|SMART_RPC_URL|sk-ant|MODELE-NOTE|secret/.test(tout), 'un champ hors liste n\'apparait JAMAIS (texte prive, URL du noeud, cle, texte du modele)');
    /* le texte VU (valeurs et messages) ; les noms de champs de l'API restent ceux du depot */
    const valeurs = []; (function v(x) { if (x && typeof x === 'object') Object.values(x).forEach(v); else if (typeof x === 'string') valeurs.push(x); })(f);
    ok(!FR.test(valeurs.join('\n') + t.html + t.brut), 'aucun mot francais dans ce que le joueur lit');
    const liens = (t.html.match(/href="[^"]+"/g) || []).map((x) => x.slice(6, -1));
    ok(liens.every((h) => /^https:\/\/(dexscreener\.com\/robinhood\/0x[0-9a-f]{40}|robinhoodchain\.blockscout\.com\/token\/0x[0-9a-f]{40}|swoleeswoge\.dog\/swoge_smart_money\.html)$/.test(h)), 'liens : DexScreener, explorateur, la page des resultats ; rien d\'autre');
    /* une chaine venue de la chaine : un symbole piege, un explorateur douteux */
    const g = P.construitFiche(J1, PUB({ symbole: '<img src=x onerror=alert(1)>JOIN t.me/scam', verdict: 'n importe', categorie: 'xx' }), { explorer: 'javascript:alert(1)' });
    const tg = P.textes(g);
    ok(!/[<>"]/.test(g.symbole || '') && (g.symbole || '').length <= 16 && !/<img/.test(tg.html), 'symbole piege : nettoye, court, jamais du HTML (' + g.symbole + ')');
    ok(g.verdict === 'jaune' && g.categorie === 'pons' && g.liens.explorer.startsWith('https://robinhoodchain.blockscout.com/'), 'verdict, categorie et explorateur hors liste : valeurs sures');
    /* chaque cle de risque et de titre des appelants a sa phrase anglaise */
    const cles = ['dev_vend', 'relais', 'plateforme_petit', 'achat_dev_minuscule', 'exemptions', 'logo_sniper', 'pas_de_x', 'taxe', 'copieur_ignition', 'inconnues', 'rebond', 'sans_marche', 'pas_jeton', 'retraits', 'drapeaux', 'smart_regle', 'sept_sur_dix'];
    const defaut = P.risque({ cle: 'rechute' });
    ok(cles.every((c) => { const x = P.risque({ cle: c, val: 2 }); return x && x !== defaut && !FR.test(x); }), 'chaque cle de risque des alertes a sa phrase anglaise');
    const ana = Object.keys(SS.conditions({}).acheter.concat(SS.conditions({}).eviter).reduce((o2, c) => { o2[c.cle] = 1; return o2; }, {}));
    ok(ana.every((c) => !/7 trades/.test(P.risque({ cle: 'analyste', val: c })) && !/fact:/.test(P.risque({ cle: 'analyste_inconnu', val: c })) || c === 'pas_airdrop'), 'chaque regle de l\'analyste a sa phrase anglaise (danger et inconnue)');
    const titres = [['lancement', { cle: 'dev_2eth', val: 2.5 }], ['lancement', { cle: 'plateforme', val: { nom: 'FOMOPAD', eth: 1.2 } }], ['lancement', { cle: 'relais' }], ['t2', { acheteurs: 22, eth: 1.6 }], ['sortie'], ['ignition_usine'], ['ignition_contrat', true],
      ['copie', { nom: 'Sniper 1', courbe: true }], ['rebond', { chute: 62, rebond: 25 }], ['analyste', 'SURVEILLER'], ['createur'], ['smart', { n: 2, min: 12 }]];
    ok(titres.every(([c, v]) => { const x = P.titre({ cle: c, val: v }); return x && x !== 'Smart money alert' && !FR.test(x); }), 'chaque titre a son gabarit anglais : ' + titres.map(([c, v]) => P.titre({ cle: c, val: v })).join(' | '));
    { /* 16/10 : noms NEUTRES et stables, jamais le nom de la liste du proprietaire */
      const n1 = P.nomPublic(SNIPER, 'buyer'), n2 = P.nomPublic('0x1ad70bc7ac98539dada8f97360d353687f6c29d6'), n3 = P.nomPublic('0x381d02f5578a1d5872d095006fcc2dfeacb7b60c');
      ok([n1, n2, n3].every((n) => /^Smart wallet [A-Z]+$/.test(n)) && new Set([n1, n2, n3]).size === 3 && P.nomPublic(SNIPER, 'buyer') === n1 && P.nomPublic(A('99'), 'deployer') === 'Deployer'
        && ![n1, n2, n3].some((n) => /Sniper|Tracked|0x/.test(n)), 'noms courts neutres, distincts et stables (' + [n1, n2, n3].join(', ') + '), jamais le nom de la liste ; un inconnu reste « Deployer »'); }
  }

  // ================================================== 3. canal : plafond horaire et delai
  console.log('-- 3. canal : plafond par heure, delai --');
  {
    const b = await banc({ SMART_PUBLIC_TG_CHAT: '-100555', SMART_PUBLIC_MAX_H: '2' });
    for (const j of [J1, J2, J3]) { b.prix.set(j, 1); await b.I.publie('lancement', 'lancement:' + j, j, PUB()); }
    egal(b.chats.length, 2, 'plafond de 2 par heure : 2 messages au canal');
    ok(b.chats.every((c) => c.c === '-100555' && /Not financial advice\.$/.test(c.t)), 'vers SMART_PUBLIC_TG_CHAT, le texte anglais');
    const v = b.I.vue(0);
    egal(v.alertes.length, 3, 'mais les 3 alertes sont dans le flux de la page');
    egal(v.compteurs.canal_plafond, 1, 'et l\'alerte au-dela du plafond est COMPTEE');
    egal(b.B.un('SELECT tg FROM publiques WHERE jeton = ?', [J3]).tg, 'plafond', 'sa ligne dit « plafond »');
    egal(await b.I.publie('lancement', 'lancement:' + J1, J1, PUB()), null, 'meme cle : rien de plus (une fois par alerte)');
    await b.avance(61);
    const J4 = A('a4'); b.prix.set(J4, 1);
    await b.I.publie('lancement', 'lancement:' + J4, J4, PUB());
    egal(b.chats.length, 3, 'une heure plus tard, le canal reprend');

    const d = await banc({ SMART_PUBLIC_TG_CHAT: '-100555', SMART_PUBLIC_DELAI_S: '300' });
    d.prix.set(J1, 2);
    await d.I.publie('lancement', 'lancement:' + J1, J1, PUB());
    ok(d.chats.length === 0 && d.I.vue(0).alertes.length === 0, 'delai de 300 s : rien sur le canal ni sur la page tout de suite');
    egal(d.B.un('SELECT ref_prix FROM publiques').ref_prix, 2, 'mais le prix est lu A L\'ALERTE (la mesure part de l\'heure du detecteur)');
    await d.avance(4);
    ok(d.chats.length === 0 && d.I.vue(0).alertes.length === 0, 'a 4 min : toujours rien');
    await d.avance(1);
    ok(d.chats.length === 1 && d.I.vue(0).alertes.length === 1, 'a 5 min : publiee, sur la page et le canal');
    egal(d.B.un('SELECT tg FROM publiques').tg, 'envoye', 'la ligne passe de « attente » a « envoye »');
    const sansCanal = await banc({});
    sansCanal.prix.set(J1, 1);
    await sansCanal.I.publie('lancement', 'lancement:' + J1, J1, PUB());
    ok(sansCanal.chats.length === 0 && sansCanal.I.vue(0).alertes.length === 1 && sansCanal.B.un('SELECT tg FROM publiques').tg === 'sans_canal', 'SMART_PUBLIC_TG_CHAT vide : la page seulement');
  }

  // ================================================== 4. la mesure
  console.log('-- 4. la mesure : +5 ... +120 min, meilleur, pire, budget --');
  {
    const b = await banc({});
    /* J1 suit une trajectoire DexScreener ; J2 est sur sa courbe (aucun appel) */
    const traj = (min) => (min < 10 ? 1 + min * 0.1 : min < 40 ? 2 - (min - 10) * 0.02 : min < 70 ? 1.4 : min < 125 ? 0.5 : 0.8);
    b.prix.set(J1, traj(0)); b.courbe.set(J2, 0.001);
    await b.I.publie('lancement', 'lancement:' + J1, J1, PUB({ categorie: 'pons' }));
    await b.I.publie('lancement', 'lancement:' + J2, J2, PUB({ prixUsd: 0.001 }));
    egal(b.ds.length, 1, 'J1 : la reference vient de DexScreener (1 appel) ; J2 : du prix de la courbe passe par l\'appelant (0 appel)');
    let maxParTic = 0;
    for (let k = 1; k <= 160; k++) {
      b.T.now += 60e3; b.prix.set(J1, traj(k)); b.courbe.set(J2, 0.001 * (k < 30 ? 1 : 3));
      const avant = b.ds.length;
      /* le serveur est « arrete » de la minute 15 a la minute 21 : le palier +15 (15-20 min) est rate */
      if (k >= 15 && k <= 21) continue;
      await b.I.tic();
      maxParTic = Math.max(maxParTic, b.ds.length - avant);
    }
    ok(maxParTic <= 1, 'au plus UN appel DexScreener par cycle (' + maxParTic + ')');
    ok(b.ds.length <= 1 + P.PRIX_HTTP_H * 3 && b.ds.length <= 40, 'releves bornes : ' + b.ds.length + ' appels en 160 min (un releve toutes les 5 min, plus les paliers)');
    const v = b.I.vue(0);
    const m1 = v.alertes.find((a) => a.fiche.jeton === J1).mesure, m2 = v.alertes.find((a) => a.fiche.jeton === J2).mesure;
    ok(m1.ref && m1.ref.prix === 1 && m1.ref.source === 'dex' && m1.ref.retard_s === 0, 'reference J1 : 1 $ a l\'alerte (DexScreener)');
    ok(m1.paliers[5] && m1.paliers[5].pct === 50 && m1.paliers[5].min === 5, '+5 min : +50 % (lu a 5 min)');
    ok(m1.paliers[15] && m1.paliers[15].manque === true, '+15 min : serveur arrete pendant toute sa fenetre -> MANQUANT, jamais interpole');
    ok(m1.paliers[30] && m1.paliers[30].pct === 60 && m1.paliers[30].min === 30, '+30 min : +60 %');
    ok(m1.paliers[60] && m1.paliers[60].pct === 40 && m1.paliers[120] && m1.paliers[120].pct === -50, '+60 min : +40 % ; +120 min : -50 %');
    ok(m1.meilleur_pct === 100 && m1.pire_pct === -50, 'meilleur releve +100 % (a 10 min), pire -50 %');
    ok(m1.fini && m2.fini, 'apres 150 min : la mesure est close');
    ok(m2.ref && m2.ref.source === 'curve' && m2.paliers[60].pct === 200 && m2.paliers[60].source === 'curve', 'J2 : mesure sur la COURBE suivie (+200 % a +60), sans DexScreener');
    /* la reference tardive : DexScreener ne connait pas le jeton a l'alerte */
    const r = await banc({});
    await r.I.publie('lancement', 'lancement:' + J1, J1, PUB());
    await r.avance(2);
    egal(r.B.un('SELECT ref_prix FROM publiques').ref_prix, null, 'pas de prix : pas de reference inventee');
    r.prix.set(J1, 3);
    await r.avance(1);
    const l1 = r.I.vue(0).alertes[0].mesure;
    ok(l1.ref && l1.ref.prix === 3 && l1.ref.retard_s === 180, 'prix lu 3 min apres : reference acceptee, son retard est dit (180 s)');
    const r2 = await banc({});
    await r2.I.publie('lancement', 'lancement:' + J1, J1, PUB());
    await r2.avance(4);
    r2.prix.set(J1, 3);
    await r2.avance(30);
    ok(r2.I.vue(0).alertes[0].mesure.ref === null, 'plus de 3 min apres : aucune reference, l\'alerte n\'entre pas au bilan');
    /* le budget horaire : 90 appels au plus */
    const h = await banc({});
    for (let k = 0; k < 200; k++) { const j = '0x' + (k + 1).toString(16).padStart(40, '0'); h.prix.set(j, 1); await h.I.publie('copie', 'copie:' + j, j, PUB({ categorie: 'copie' })); }
    ok(h.ds.length <= P.PRIX_HTTP_H, '200 alertes en une heure : ' + h.ds.length + ' appels DexScreener au plus (' + P.PRIX_HTTP_H + ' par heure)');
    ok(h.I.vue(0).compteurs && h.B.meta('public_compteurs').http_refusees >= 1, 'au-dela, l\'appel n\'est pas fait, et c\'est compte');
  }

  // ================================================== 5. le bilan
  console.log('-- 5. le bilan : refuse de conclure sous 40 --');
  {
    const ligne = (k, cat, verdict, pct30) => ({ id: k, t: 1000, categorie: cat, verdict, ref_prix: 1, ref_t: 1000, ref_source: 'dex', haut: 1 + Math.max(0, pct30) / 100 + 0.1, bas: 0.5, obs_n: 5, fini: 1,
      mesures: JSON.stringify({ 30: { p: 1 + pct30 / 100, m: 30, s: 'dex' } }) });
    const l39 = []; for (let k = 0; k < 39; k++) l39.push(ligne(k, 'pons', 'vert', k % 3 === 0 ? 20 : -10));
    const b39 = P.bilan(l39).pons;
    ok(b39.n === 39 && b39.n30 === 39 && b39.assez === false && b39.part_montee30 === null && b39.mediane30 === null && b39.meilleur_pct === null, '39 mesures a +30 : AUCUNE conclusion (ni part, ni mediane, ni meilleur)');
    const l40 = l39.concat([ligne(39, 'pons', 'jaune', 20)]);
    const b40 = P.bilan(l40).pons;
    ok(b40.assez && b40.part_montee30 === 35 && b40.mediane30 === -10 && b40.meilleur_pct === 30, '40 : part montee 35 % (14 / 40), mediane -10 %, meilleur releve +30 %');
    const avecRouge = l40.concat([ligne(40, 'pons', 'rouge', 300), ligne(41, 'dev', 'rouge', -80)]);
    const br = P.bilan(avecRouge);
    ok(br.pons.n === 40 && br.rouge.n === 2 && br.rouge.assez === false && br.tout.n === 40, 'une alerte ROUGE (eviter, sortir) a sa ligne, hors de sa categorie');
    ok(P.CATEGORIES.every((c) => br[c] && br[c].libelle && !FR.test(br[c].libelle)), 'chaque categorie a son libelle anglais (dev, pons, ignition, copie, rebond, analyste, smart)');
  }

  // ================================================== 6. la route
  console.log('-- 6. la route --');
  {
    egal(P.litDepuis(undefined), 0, 'depuis absent : 0');
    egal(P.litDepuis('12'), 12, 'depuis=12');
    ok(['-1', 'abc', '1.5', '1e3', '9999999999999'].every((x) => P.litDepuis(x) === null), 'depuis invalide : refuse (400)');
    const b = await banc({ SMART_PUBLIC_TG_LIEN: 'https://t.me/swoge_alerts' });
    for (const j of [J1, J2]) { b.prix.set(j, 1); await b.I.publie('lancement', 'lancement:' + j, j, PUB()); }
    const v0 = b.I.vue(0);
    ok(v0.actif && v0.alertes.length === 2 && v0.alertes[0].id > v0.alertes[1].id && v0.dernier_id === v0.alertes[0].id, 'depuis=0 : les dernieres alertes, la plus recente d\'abord');
    ok(v0.tg && v0.tg.lien === 'https://t.me/swoge_alerts' && v0.seuil === 40 && v0.palier_bilan === 30 && v0.paliers.join() === '5,15,30,60,120', 'le lien du canal, le seuil, les paliers');
    b.prix.set(J3, 1); await b.I.publie('lancement', 'lancement:' + J3, J3, PUB());
    await b.avance(6);
    const v1 = b.I.vue(v0.dernier_id);
    ok(v1.alertes.length === 1 && v1.alertes[0].fiche.jeton === J3, 'depuis=<id> : seulement la nouvelle');
    ok(v1.vivantes.length === 2 && v1.vivantes.every((x) => x.paliers[5] && x.paliers[5].pct === 0), 'et la mesure de celles deja recues (+5 rempli)');
    const cles = Object.keys(v1.alertes[0]).sort().join();
    egal(cles, 'categorie,fiche,id,mesure,t,texte,verdict', 'une alerte de la route : ses champs, rien d\'autre');
    const tout = JSON.stringify(v1);
    ok(!/https?:\/\/(?!dexscreener\.com|robinhoodchain\.blockscout\.com|swoleeswoge\.dog|t\.me)/.test(tout), 'aucune URL autre que DexScreener, l\'explorateur, la page, le canal');

    /* le VRAI serveur : SMART_MONEY vide */
    const [, lignes] = await muet(async () => { require('./server.js'); await new Promise((r) => setTimeout(r, 2500)); });
    ok(lignes.some((l) => /\[smart\] ETEINT/.test(l)), 'le vrai serveur demarre (smart money eteint)');
    const base = 'http://127.0.0.1:' + process.env.PORT;
    const get = async (u) => { const r = await fetch(base + u); return { status: r.status, j: await r.json().catch(() => null), h: r.headers }; };
    let r = await get('/ai/smart/alertes');
    egal(r.status, 200, '/ai/smart/alertes : 200');
    ok(r.j && r.j.actif === false && Array.isArray(r.j.alertes) && r.j.alertes.length === 0, 'eteint : { actif: false }, aucune alerte');
    egal(r.h.get('access-control-allow-origin'), '*', 'CORS identique au reste de /ai/smart');
    egal(r.h.get('cache-control'), 'no-store', 'no-store');
    r = await get('/ai/smart/alertes?depuis=abc');
    egal(r.status, 400, 'depuis invalide : 400');
    r = await get('/ai/smart/alertes?depuis=7');
    egal(r.status, 200, 'depuis=7 : 200');
    let dernier = 200;
    for (let i = 0; i < 30; i++) dernier = (await get('/ai/smart/alertes')).status;
    egal(dernier, 429, 'meme debit par IP que /ai/smart : 30 par minute, puis 429');
  }

  // ================================================== 7. smart_money : la ligne de demarrage et le branchement
  console.log('-- 7. smart_money : demarrage --');
  {
    const l1 = M.cree({ env: { SMART_MONEY: '1', SMART_PUBLIC_TG_CHAT: '-100', SMART_PUBLIC_MAX_H: '5' } }).ligneDemarrage();
    ok(/PUBLIC \(SMART_PUBLIC\) : flux \/ai\/smart\/alertes, canal SMART_PUBLIC_TG_CHAT, 5 par heure au plus, delai 0 s/.test(l1) && !/-100/.test(l1), 'SMART_MONEY=1 : la ligne dit le public, sans le chat');
    ok(/public ETEINT \(SMART_PUBLIC=0\)/.test(M.cree({ env: { SMART_MONEY: '1', SMART_PUBLIC: '0' } }).ligneDemarrage()), 'SMART_PUBLIC=0 : la ligne le dit');
    ok(/ni au proprietaire ni au public/.test(M.cree({ env: { SMART_MONEY: 'observe' } }).ligneDemarrage()), 'observe : la ligne le dit');
    egal(M.cree({ env: { SMART_MONEY: '1' } }).alertesPubliques(0).raison, 'not ready', 'base pas encore ouverte : la route dit « not ready »');
  }

  // ================================================== 8. le vert se gagne ; la reference differee (21/10/2026)
  console.log('-- 8. le vert se gagne par la mesure ; IGNITION mesure depuis son premier prix --');
  {
    const M0 = (n, part, refPart) => ({ n, partMontes: part, min: 100, horizon: 30, ref: { n: 500, partMontes: refPart }, refMin: 12 });
    /* le releve du 21/10 : « smart launch: pons », 343 obs, 14 % contre 27 % */
    let j = P.jugeParMesure('vert', M0(343, 14, 27));
    ok(j.verdict === 'jaune' && j.mesure.retrograde && /343 past green alerts.*14% were up 30 min later, vs 27%.*shown yellow/.test(j.mesure.texte), 'pons 343 obs, 14 % contre 27 % : le vert part en jaune, la mesure est dite');
    ok(!FR.test(j.mesure.texte), 'en anglais');
    j = P.jugeParMesure('vert', M0(150, 27, 27));
    egal(j.verdict, 'jaune', 'a egalite avec ce que la colonie achete : jaune (il faut BATTRE la reference)');
    j = P.jugeParMesure('vert', M0(150, 35, 27));
    ok(j.verdict === 'vert' && !j.mesure.retrograde && !/yellow/.test(j.mesure.texte), 'au-dessus de la reference : vert, avec sa mesure (reversible)');
    ok(P.jugeParMesure('vert', M0(99, 5, 27)).mesure === null && P.jugeParMesure('vert', M0(99, 5, 27)).verdict === 'vert', 'sous 100 observations : rien ne change, rien n est dit');
    ok(P.jugeParMesure('vert', Object.assign(M0(300, 5, 27), { ref: { n: 5, partMontes: 30 } })).mesure === null, 'reference sous 12 observations : rien ne change');
    ok(P.jugeParMesure('jaune', M0(300, 5, 27)).mesure === null && P.jugeParMesure('rouge', M0(300, 5, 27)).verdict === 'rouge', 'jaune et rouge : jamais touches (la mesure ne promeut rien)');
    /* publie : la mesure de SA source, demandee pour un vert seulement */
    const demandes = [];
    const b = await banc({}, { mesure: (src) => { demandes.push(src); return M0(343, 14, 27); } });
    b.prix.set(J1, 1); b.prix.set(J2, 1);
    const r = await b.I.publie('lancement', 'lancement:' + J1, J1, PUB({ categorie: 'pons' }));
    ok(r.fiche.verdict === 'jaune' && r.fiche.mesure && r.fiche.mesure.n === 343, 'publie : un vert pons mesure sous la reference sort jaune');
    ok(/^🟡/.test(r.texte.brut) && /• Track record: 343 past green alerts/.test(r.texte.brut) && /Not financial advice\.$/.test(r.texte.brut), 'le texte (canal et page) le dit, en jaune, avant « Not financial advice. »');
    await b.I.publie('lancement', 'lancement:' + J2, J2, PUB({ categorie: 'pons', verdict: 'jaune' }));
    egal(demandes.join(','), 'lancement', 'la mesure demandee a la source de la categorie (pons -> lancement), pour le vert seulement');
    egal(b.I.vue(0).compteurs.retrogradees, 1, 'compte : 1 retrogradee');
    const sans = await banc({});
    b.prix.set(J3, 1); sans.prix.set(J3, 1);
    egal((await sans.I.publie('lancement', 'lancement:' + J3, J3, PUB({ categorie: 'pons' }))).fiche.verdict, 'vert', 'sans fournisseur de mesure : rien ne change');
    egal(P.SOURCE_DE_CAT.pons + P.SOURCE_DE_CAT.ignition + P.SOURCE_DE_CAT.copie, 'lancementignitioncopie', 'categories -> sources v2 de la colonie');
    const C = require('./ai_colonie');
    for (const [cat, src] of Object.entries(P.SOURCE_DE_CAT)) ok(C.SMART_LIGNES_V2[src] && C.mesureSourceSmart(src).cle === C.SMART_LIGNES_V2[src], cat + ' -> ' + src + ' : une ligne de la colonie (« ' + C.SMART_LIGNES_V2[src] + ' »)');
    const ms = C.mesureSourceSmart('lancement');
    ok(ms.min === C.SMART_ACHAT_MIN_OBS && ms.horizon === 30 && 'ref' in ms, 'la vraie colonie : seuil SMART_ACHAT_MIN_OBS, horizon 30 min, reference « achete ou retenu »');
    ok(C.mesureSourceSmart('inconnue') === null, 'une source sans ligne : null');
    /* la reference differee : aucun prix a l'alerte, un premier prix 40 min apres */
    const d = await banc({});
    await d.I.publie('ignition', 'ignition:contrat:' + J1, J1, PUB({ categorie: 'ignition', verdict: 'jaune', refDifferee: true }));
    await d.avance(40);
    let m = d.I.vue(0).alertes[0].mesure;
    ok(m.ref === null && m.ref_differee === true && !m.fini && Object.values(m.paliers).every((x) => x === null), 'differee, sans marche a 40 min : aucun palier rate, rien ne court');
    ok(d.ds.length <= 9, 'sans prix : relue toutes les 5 min au plus (' + d.ds.length + ' appels en 40 min)');
    d.prix.set(J1, 2);
    await d.avance(5);
    m = d.I.vue(0).alertes[0].mesure;
    ok(m.ref && m.ref.prix === 2 && m.ref.differee === true && m.ref.retard_s >= 40 * 60, 'premier prix lu : il devient la reference, son retard est dit (' + (m.ref && m.ref.retard_s) + ' s)');
    d.prix.set(J1, 3);
    await d.avance(35);
    m = d.I.vue(0).alertes[0].mesure;
    ok(m.paliers[30] && m.paliers[30].pct === 50 && m.paliers[30].min >= 30 && m.paliers[30].min < 38, '+30 min DEPUIS le premier prix : +50 % (' + JSON.stringify(m.paliers[30]) + ')');
    await d.avance(130);
    ok(d.I.vue(0).alertes[0].mesure.fini, 'close 150 min apres son premier prix');
    egal(d.I.vue(0).bilan.ignition.mesurees, 1, 'elle entre au bilan de sa categorie');
    const e = await banc({});
    await e.I.publie('ignition', 'ignition:contrat:' + J2, J2, PUB({ categorie: 'ignition', verdict: 'jaune', refDifferee: true }));
    await e.avance(6 * 60 + 2, false);
    m = e.I.vue(0).alertes[0].mesure;
    ok(m.fini && m.ref === null, 'aucun prix en 6 h : close, sans mesure');
    const f = await banc({});
    await f.I.publie('lancement', 'lancement:' + J3, J3, PUB());
    await f.avance(10); f.prix.set(J3, 3); await f.avance(40);
    ok(f.I.vue(0).alertes[0].mesure.ref === null, 'une alerte NON differee garde sa regle : pas de reference apres 3 min');
  }

  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch (e) { /* rien */ }
  if (rates) { console.log(`RATES : ${rates}/${n + rates}`); process.exit(1); }
  console.log(`smart_public.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('EXCEPTION', e); process.exit(1); });
