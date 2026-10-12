'use strict';
/*
 * LES ANNONCES DU MONDE, VERIFIEES SUR LE VRAI SERVEUR.
 *
 * ---- pourquoi ce fichier existe (12/10/2026) ----
 *
 * Une ligne complete est l'annonce la plus forte du canal, et la plus rare :
 * trois dans toute la vie de l'edition. Aucun essai ne la completait a
 * travers le serveur, et elle etait cassee de trois facons a la fois :
 *
 *   1. `notifyCoffre` lisait `base0`, retire du fichier : ReferenceError. Le
 *      gagnant du premier prix — 5 000 000 $SWOGE deja credites — recevait
 *      « server error » (shopOpen, freeChestOpen, marketBuy) ou perdait toute
 *      la reponse de sa journee parfaite (« base0 is not defined ») ;
 *   2. la phrase promettait « 50M, then 30M, then 10M » quand la course paie
 *      5 000 000, 3 000 000 et 1 000 000 (boutique.PRIX_LIGNE) ;
 *   3. une ligne fermee au MARCHE partait avec un second message, « pulled X
 *      from a undefined · #undefined of undefined ».
 *
 * Et les portes de donjon s'annoncaient toutes comme la Forge (« Optimus »,
 * « The Foundry Brute », une relique) avec « 1 minutes » pour une porte de
 * 40 secondes, et un « Get in » qu'aucun lecteur du canal ne pouvait tenir.
 *
 * ---- ce que ce fichier tient ----
 *
 * A. Les QUATRE chemins qui completent une ligne — shopOpen, marketBuy,
 *    freeChestOpen, perfectDay — repondent normalement au joueur, et le canal
 *    recoit UNE annonce de ligne, au bon montant, sans « undefined ».
 * B. Les prix restants sont dits depuis PRIX_LIGNE, rang par rang.
 * C. Les quatre portes ont quatre legendes distinctes, tirees des tables du
 *    monde ; seule la Forge nomme Optimus ; la duree est dite en secondes.
 * D. Aucune annonce n'a jete : rien dans le journal sous [annonce] ni [ws].
 * E. Et le filet tient quand une annonce JETTE : D ne prouve qu'aucune ne jette
 *    aujourd'hui. On fait jeter le canal une fois pendant une ligne complete,
 *    puis pendant une porte : le gagnant recoit sa reponse, le monde continue,
 *    et l'echec s'ecrit sous [annonce], une fois.
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');

process.env.DATA_DIR = fs.mkdtempSync('/tmp/annonces-monde-');
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.GAME_IMAGE_BASE = 'https://swoleeswoge.dog/media';

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ok   ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` [${a} vs ${b}]`); n++; console.log('  ok   ' + m); };

/* Le canal est un carnet : on veut savoir CE QUI SERAIT PARTI. */
const TG = [];
/* `JETTE` : quand il est pose, la PROCHAINE photo dont la legende lui repond
   jette au lieu de partir — une faute de redaction, vue du serveur (bloc E). */
let JETTE = null;
const tgPath = require.resolve('./telegram');
require.cache[tgPath] = { id: tgPath, filename: tgPath, loaded: true, exports: {
  notify(t) { TG.push({ route: 'sendMessage', image: null, texte: String(t) }); },
  notifyPhoto(i, t) {
    if (JETTE && JETTE.test(String(t))) { JETTE = null; throw new Error('legende cassee (essai)'); }
    TG.push({ route: 'sendPhoto', image: i || null, texte: String(t) });
  },
  sendDocument() {}, chatEstPublic() { return true; }, enabled() { return true; } } };

/* Une annonce qui jette s'ecrit sous [annonce] ; un message qui tombe dans le
   filet general, sous [ws]. Les deux doivent rester vides ici. */
const JOURNAL = [];
const ce0 = console.error;
console.error = (...a) => {
  const l = a.map((x) => (x && x.stack) || String(x)).join(' ');
  if (/^\[(annonce|ws)\]/.test(l)) JOURNAL.push(l);
  ce0.apply(console, a);
};

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const ethers = require('ethers');
  const WebSocket = require('ws');
  const { Game } = require('./game');
  let moteur = null; const _p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return _p0.call(this, a); };

  /* ---- LES PORTES, PAR LA VRAIE BOUCLE ----
   * Abattre chacun des quatre gardiens demanderait quatre combats ; ce n'est
   * pas ce qu'on mesure ici (donjon_serveur.test.js le fait pour la Forge).
   * On ouvre la porte par `_ouvrePortail` du vrai monde, AVEC l'evenement du
   * pas : c'est ensuite la boucle du serveur qui la diffuse et l'annonce. */
  const { Realm } = require('./realm');
  const aOuvrir = [];
  const pas0 = Realm.prototype.pas;
  Realm.prototype.pas = function (dt) {
    const ev = pas0.call(this, dt);
    if (aOuvrir.length && ev && ev.portails) {
      const M = require('./monde');
      const cle = aOuvrir.shift();
      const D = M.DONJONS[cle];
      this._ouvrePortail({ espece: D.ouvreur, x: 600, y: 600, dir: 'down' }, null, ev);
    }
    return ev;
  };

  require('./server');
  const B = require('./boutique');
  const M = require('./monde');
  await new Promise((r) => setTimeout(r, 1200));

  const ouvre = () => new Promise((res, rej) => {
    const s = new WebSocket('ws://127.0.0.1:' + port);
    s.recus = [];
    s.on('message', (d) => { try { s.recus.push(JSON.parse(d)); } catch (e) {} });
    s.on('open', () => res(s)); s.on('error', rej);
  });
  const attend = (s, type, ms) => new Promise((res, rej) => {
    const t0 = Date.now();
    (function tour() {
      const m = s.recus.filter((x) => x.type === type).pop();
      if (m) return res(m);
      if (Date.now() - t0 > (ms || 5000)) return rej(new Error('pas de ' + type + ' — erreurs recues : '
        + (s.recus.filter((x) => x.type === 'error').map((x) => x.error).join(', ') || 'aucune')));
      setTimeout(tour, 25);
    })();
  });
  const dort = (ms) => new Promise((r) => setTimeout(r, ms));
  const connecte = async () => {
    const w = ethers.Wallet.createRandom();
    const s = await ouvre();
    const h = await attend(s, 'hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend(s, 'auth');
    s.addr = w.address.toLowerCase();
    return s;
  };

  /* La course est celle de la saison 1 ; un collectionneur possede deja tout
     le catalogue de cette saison, SAUF ce qu'on lui retire. Le prochain objet
     de la saison qu'il recoit complete donc sa famille, quel que soit le
     tirage — c'est ce qui rend l'essai deterministe sans toucher au hasard. */
  const S1 = B.ITEMS.filter((o) => (B.famille(o.famille) || {}).saison === 1);
  ok(S1.length >= 5, `${S1.length} objets dans la saison de la course`);
  const collectionneur = (addr, sauf) => {
    const p = moteur._p(addr);
    p.objets = p.objets || {};
    for (const o of S1) if (o.id !== sauf) p.objets[o.id] = 1;
    p.hasDeposited = true;
    p.balance = ethers.utils.parseUnits('100000000', 18);
    return p;
  };
  const sans = (t) => !/undefined|NaN|\bnull\b/.test(t);
  const photosDepuis = (k) => TG.slice(k).filter((x) => x.route === 'sendPhoto');
  const lignes = (l) => l.filter((x) => /COMPLETE LINE/.test(x.texte));
  const pasDErreur = (s, m) => eq(s.recus.filter((x) => x.type === 'error').length, 0, m);

  /* ================== A. LES QUATRE CHEMINS ================== */
  console.log('-- A. une ligne complete, par chacun des quatre chemins --');

  // A1. shopOpen
  {
    const s = await connecte();
    moteur.boutiqueLignes = [];
    collectionneur(s.addr);
    const k = TG.length; s.recus.length = 0;
    s.send(JSON.stringify({ type: 'shopOpen', chest: 'bois' }));
    const r = await attend(s, 'shop');
    await dort(150);
    pasDErreur(s, 'shopOpen : aucune « server error » pour le gagnant');
    ok(r.gagne && r.gagne.ligne && r.gagne.ligne.rang === 1,
       `shopOpen : la reponse porte la ligne gagnee (rang ${r.gagne && r.gagne.ligne && r.gagne.ligne.rang})`);
    const ph = photosDepuis(k), li = lignes(ph);
    eq(li.length, 1, 'shopOpen : une annonce de ligne, une seule');
    eq(ph.filter((x) => /5\.00M/.test(x.texte)).length, 1, 'shopOpen : une photo dit 5.00M');
    ok(/Prize: <b>5\.00M \$SWOGE<\/b>/.test(li[0].texte), 'shopOpen : le prix lu dans PRIX_LIGNE');
    ok(/2 prizes left — the next line wins 3\.00M, then 1\.00M \$SWOGE/.test(li[0].texte),
       'shopOpen : les deux prix restants, dans l ordre, depuis PRIX_LIGNE');
    eq(ph.length, 2, 'shopOpen : la ligne ET le tirage du coffre (deux photos)');
    ok(ph.some((x) => /#\d+ of \d+/.test(x.texte)), 'shopOpen : le tirage garde son numero d emission');
    ok(ph.every((x) => sans(x.texte)), 'shopOpen : rien d indefini dans le canal');
    s.close();
  }

  // A2. marketBuy
  {
    const vendeur = await connecte(), acheteur = await connecte();
    moteur.boutiqueLignes = [];
    const X = S1[S1.length - 1];
    const pv = moteur._p(vendeur.addr);
    pv.objets = { [X.id]: 1 }; pv.hasDeposited = true;
    pv.balance = ethers.utils.parseUnits('1000', 18);
    collectionneur(acheteur.addr, X.id);
    vendeur.send(JSON.stringify({ type: 'marketSell', item: X.id, price: 1000 }));
    const mv = await attend(vendeur, 'market');
    ok(mv.fait && Number.isFinite(mv.fait.id), `l annonce est en vitrine (#${mv.fait && mv.fait.id})`);
    const k = TG.length; acheteur.recus.length = 0;
    acheteur.send(JSON.stringify({ type: 'marketBuy', id: mv.fait.id }));
    const r = await attend(acheteur, 'market');
    await dort(150);
    pasDErreur(acheteur, 'marketBuy : aucune « server error » pour l acheteur');
    ok(!r.error && r.fait && r.fait.ligne && r.fait.ligne.rang === 1,
       `marketBuy : la reponse porte la ligne gagnee${r.error ? ' — ' + r.error : ''}`);
    const ph = photosDepuis(k);
    eq(lignes(ph).length, 1, 'marketBuy : une annonce de ligne');
    eq(ph.length, 1, 'marketBuy : et RIEN d autre — un achat n est pas un tirage');
    eq(ph.filter((x) => /5\.00M/.test(x.texte)).length, 1, 'marketBuy : une photo dit 5.00M');
    ok(ph.every((x) => sans(x.texte) && !/#undefined/.test(x.texte)),
       'marketBuy : ni « #undefined of undefined » ni « from a undefined »');
    vendeur.close(); acheteur.close();
  }

  // A3. freeChestOpen
  {
    const s = await connecte();
    moteur.boutiqueLignes = [];
    collectionneur(s.addr);
    const k = TG.length; s.recus.length = 0;
    s.send(JSON.stringify({ type: 'freeChestOpen' }));
    const r = await attend(s, 'shop');
    await dort(150);
    pasDErreur(s, 'freeChestOpen : aucune « server error »');
    ok(r.gagne && r.gagne.ligne && r.gagne.ligne.rang === 1, 'freeChestOpen : la reponse porte la ligne gagnee');
    ok(!!r.offert, 'freeChestOpen : et l etat du coffre du jour');
    const ph = photosDepuis(k);
    eq(lignes(ph).length, 1, 'freeChestOpen : une annonce de ligne');
    eq(ph.filter((x) => /5\.00M/.test(x.texte)).length, 1, 'freeChestOpen : une photo dit 5.00M');
    ok(ph.every((x) => sans(x.texte)), 'freeChestOpen : rien d indefini');
    s.close();
  }

  // A4. perfectDay
  {
    const s = await connecte();
    moteur.boutiqueLignes = [];
    const p = collectionneur(s.addr);
    for (const q of moteur.quetesDuJour(s.addr)) p.questClaimed[q.id] = true;
    ok(moteur.parfaitEtat(s.addr).pret, 'la journee parfaite est prete (toutes les quetes reclamees)');
    const k = TG.length; s.recus.length = 0;
    s.send(JSON.stringify({ type: 'perfectDay' }));
    const r = await attend(s, 'perfectDay');
    await dort(150);
    pasDErreur(s, 'perfectDay : aucune erreur — la reponse n est plus perdue');
    ok(r.gagne && r.gagne.ligne && r.gagne.ligne.rang === 1, 'perfectDay : la reponse porte le coffre et la ligne');
    ok(Number.isFinite(r.xp) && !!r.parfait, 'perfectDay : avec l XP et l etat de la journee');
    const ph = photosDepuis(k);
    eq(lignes(ph).length, 1, 'perfectDay : une annonce de ligne');
    eq(ph.filter((x) => /5\.00M/.test(x.texte)).length, 1, 'perfectDay : une photo dit 5.00M');
    ok(ph.every((x) => sans(x.texte)), 'perfectDay : rien d indefini');
    s.close();
  }

  /* ================== B. LES RANGS SUIVANTS ================== */
  console.log('\n-- B. les prix qui restent, rang par rang --');
  {
    const k = TG.length;
    for (let rang = 2; rang <= B.PRIX_LIGNE.length; rang++) {
      const s = await connecte();
      collectionneur(s.addr);
      s.send(JSON.stringify({ type: 'shopOpen', chest: 'bois' }));
      const r = await attend(s, 'shop');
      ok(r.gagne && r.gagne.ligne && r.gagne.ligne.rang === rang, `rang ${rang} gagne par un autre joueur`);
      s.close();
    }
    await dort(150);
    const li = lignes(photosDepuis(k));
    eq(li.length, B.PRIX_LIGNE.length - 1, `${li.length} annonces de ligne pour les rangs suivants`);
    const fmt = (x) => (x / 1e6).toFixed(2) + 'M';
    ok(/SECOND COMPLETE LINE/.test(li[0].texte) && li[0].texte.includes('Prize: <b>' + fmt(B.PRIX_LIGNE[1])),
       `la deuxieme dit ${fmt(B.PRIX_LIGNE[1])}`);
    ok(/1 prize left — the next line wins 1\.00M \$SWOGE/.test(li[0].texte), 'et le seul prix restant');
    const der = li[li.length - 1];
    ok(der.texte.includes('Prize: <b>' + fmt(B.PRIX_LIGNE[B.PRIX_LIGNE.length - 1])),
       `la derniere dit ${fmt(B.PRIX_LIGNE[B.PRIX_LIGNE.length - 1])}`);
    ok(/All 3 prizes are gone/.test(der.texte), 'et que la course est finie');
  }

  /* ================== C. LES QUATRE PORTES ================== */
  console.log('\n-- C. quatre portes, quatre legendes --');
  {
    const cles = Object.keys(M.DONJONS);
    const k = TG.length;
    for (const c of cles) { aOuvrir.push(c); await dort(400); }
    await dort(400);
    const ph = photosDepuis(k).filter((x) => /PORTAL/.test(x.texte));
    eq(ph.length, cles.length, `${ph.length} annonces de porte pour ${cles.length} donjons`);
    eq(new Set(ph.map((x) => x.texte)).size, cles.length, 'quatre legendes distinctes');
    const nomDe = (e) => M.MONSTRES[e].nom;
    for (const c of cles) {
      const D = M.DONJONS[c];
      const a = ph.find((x) => (x.image || '').includes('/portail_' + c + '.jpg?v='));
      ok(!!a, `${c} : l image est portail_${c}.jpg, avec son numero de tirage`);
      ok(a.texte.toUpperCase().includes(D.nom.replace(/^the\s+/i, '').toUpperCase()), `${c} : nomme « ${D.nom} »`);
      ok(a.texte.includes(nomDe(D.ouvreur)), `${c} : nomme son gardien, ${nomDe(D.ouvreur)}`);
      ok(a.texte.includes(nomDe(D.boss)), `${c} : nomme son boss, ${nomDe(D.boss)}`);
      const R = B.rarete(M.BUTIN_GARANTI[D.boss]);
      ok(a.texte.includes('<b>' + R.nom + '</b>'), `${c} : dit la rarete de ce qui tombe (${R.nom})`);
      /* Le Warden de l'Arene attend au CENTRE (bossAu) : la legende disait
         « at the bottom » pour les quatre. Et la piece sort d'un lot fini —
         « always » promettait un sac que le lot vide ne donne pas. */
      const ou = D.bossAu === 'centre' ? 'at the centre' : 'at the bottom';
      ok(a.texte.includes(nomDe(D.boss) + ' waits ' + ou), `${c} : son boss attend ${ou}`);
      ok(!/\balways\b/i.test(a.texte) && /while copies last/.test(a.texte),
         `${c} : ne promet pas « always », dit la limite du lot`);
      for (const autre of cles.filter((x) => x !== c)) {
        const Do = M.DONJONS[autre];
        ok(!a.texte.includes(nomDe(Do.boss)) && !a.texte.includes(nomDe(Do.ouvreur)),
           `${c} : ne cite ni le boss ni le gardien de ${autre}`);
      }
      ok(a.texte.includes(`${M.PORTAIL.duree} seconds`), `${c} : « ${M.PORTAIL.duree} seconds »`);
      ok(!/minutes|Get in/.test(a.texte), `${c} : ni « minutes » ni « Get in »`);
      ok(sans(a.texte), `${c} : rien d indefini`);
    }
    eq(ph.filter((x) => /Optimus/.test(x.texte)).length, 1, 'une seule legende nomme Optimus');
    ok(/FORGE/.test(ph.find((x) => /Optimus/.test(x.texte)).texte), 'et c est celle de la Forge');
  }

  /* ================== D. LE CANAL ENTIER, ET LE JOURNAL ================== */
  console.log('\n-- D. sur tout ce qui est parti --');
  eq(TG.filter((x) => /\b50M\b|30M|10M/.test(x.texte)).length, 0, 'aucun « 50M / 30M / 10M » dans le canal');
  eq(TG.filter((x) => !sans(x.texte)).length, 0, `aucun « undefined » sur ${TG.length} messages`);
  eq(JOURNAL.length, 0, 'aucune annonce n a jete, aucun message n est tombe dans le filet'
     + (JOURNAL.length ? ' — ' + JOURNAL[0].split('\n')[0] : ''));

  /* ================== E. LE FILET, QUAND UNE ANNONCE JETTE ================== */
  console.log('\n-- E. une annonce qui jette ne coupe rien --');
  {
    const j0 = JOURNAL.length;
    /* E1. Une ligne complete dont l'annonce jette. */
    moteur.boutiqueLignes = [];
    const s = await connecte();
    collectionneur(s.addr);
    JETTE = /COMPLETE LINE/;
    const k = TG.length; s.recus.length = 0;
    s.send(JSON.stringify({ type: 'shopOpen', chest: 'bois' }));
    const r = await attend(s, 'shop');
    await dort(150);
    eq(JETTE, null, 'l annonce de ligne a bien jete (le faux canal a servi)');
    pasDErreur(s, 'le gagnant ne recoit pas « server error »');
    ok(r.gagne && r.gagne.ligne && r.gagne.ligne.rang === 1,
       `et sa reponse porte la ligne gagnee (rang ${r.gagne && r.gagne.ligne && r.gagne.ligne.rang})`);
    const ph = photosDepuis(k);
    eq(lignes(ph).length, 0, 'la ligne n est pas partie');
    ok(ph.some((x) => /#\d+ of \d+/.test(x.texte)), 'mais le tirage du coffre, si : une annonce n emporte pas l autre');
    const jl = JOURNAL.slice(j0);
    eq(jl.filter((l) => /^\[annonce\] ligne/.test(l)).length, 1, 'l echec s ecrit une fois, sous [annonce] ligne');
    eq(jl.filter((l) => /^\[ws\]/.test(l)).length, 0, 'et rien ne tombe dans le filet general');
    s.close();

    /* E2. Une porte dont l'annonce jette : la boucle du monde continue — la
       porte suivante s'annonce. */
    const j1 = JOURNAL.length, k2 = TG.length;
    JETTE = /PORTAL/;
    aOuvrir.push('cave'); await dort(400);
    eq(JETTE, null, 'l annonce de la premiere porte a jete');
    aOuvrir.push('forge'); await dort(600);
    const portes = photosDepuis(k2).filter((x) => /PORTAL/.test(x.texte));
    eq(portes.length, 1, 'la porte suivante s annonce : la boucle du monde n a pas ete coupee');
    ok(/FORGE/.test(portes[0] && portes[0].texte), 'et c est bien la seconde (la Forge)');
    const jp = JOURNAL.slice(j1);
    eq(jp.filter((l) => /^\[annonce\] portail/.test(l)).length, 1, 'l echec de la porte s ecrit une fois, sous [annonce] portail');
    eq(jp.filter((l) => /^\[ws\]/.test(l)).length, 0, 'et rien sous [ws]');
  }

  console.log(`\nannonces_monde.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC :', e.message); process.exit(1); });
