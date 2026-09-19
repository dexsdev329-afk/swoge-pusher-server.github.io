'use strict';
/* ============================================================================
 * UN GESTE N AGIT QUE SUR L ADRESSE DE LA SESSION
 *
 * ---- LA REGLE, ET POURQUOI ELLE EST ECRITE AVANT LE CODE ----
 *
 * `CLAUDE.md`, section securite, en toutes lettres :
 *
 *   « Un geste du miroir ou de la colonie n agit QUE sur `ws.addr` —
 *     l adresse de la session — jamais sur une adresse venue du message. »
 *   « `AI_OWNER` est reverifie cote serveur a chaque geste. La page ne fait
 *     que montrer ou cacher des boutons. »
 *
 * C est la regle qui separe un site ou l on joue de l argent d un site ou
 * l on prend celui des autres. Une socket est ouverte par n importe qui ;
 * l adresse qu elle porte est la seule chose prouvee (signature a la
 * connexion). Tout le reste du message est une AFFIRMATION de l inconnu qui
 * l envoie.
 *
 * ---- POURQUOI CET ESSAI EXISTE ALORS QUE LE CODE EST JUSTE ----
 *
 * Releve du 19 septembre 2026. Les neuf gestes du miroir et les deux de la
 * colonie ont ete relus un par un : TOUS passent `ws.addr`, et
 * `colonieTiens` / `colonieFerme` reverifient `AI_OWNER`. Il n y avait rien a
 * corriger.
 *
 * Mais RIEN ne gardait cette justesse. Douze endroits de `server.js` lisent
 * une adresse venue du message — toutes legitimes aujourd hui (le
 * DESTINATAIRE d un transfert, la CIBLE qu on rejoint, le JETON qu on vend) —
 * et deux fichiers d essai seulement touchaient a l invariant. La prochaine
 * poignee de gestes sera ecrite par quelqu un qui n aura pas relu la section
 * securite, et un `m.address` mis a la place d un `ws.addr` ne casse aucun
 * essai : il rend juste le site pillable.
 *
 * Cet essai fige la regle. Il frappe un VRAI serveur, avec DEUX comptes, et
 * essaie de faire ce qu un attaquant essaierait.
 * ==========================================================================*/
const assert = require('assert');
const ethers = require('ethers');
const WebSocket = require('ws');
const net = require('net');
const fs = require('fs');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');

const BAC = fs.mkdtempSync('/tmp/secuws-');
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
/* Le proprietaire de la colonie : une adresse fixe, connue de l essai, et qui
   n est celle d AUCUN des deux joueurs. C est elle qui rend la reverification
   d `AI_OWNER` mesurable. */
const PROPRIO = ethers.Wallet.createRandom();
process.env.AI_OWNER = PROPRIO.address;
/* ---- UNE PHRASE DE CHIFFREMENT, POUR CET ESSAI SEULEMENT ----
 * Sans `MIROIR_CLE`, le miroir refuse de creer le moindre portefeuille — et
 * c est tres bien : « ecrire des cles en clair en attendant est exactement le
 * geste qu on regrette ». Mais sans portefeuille, la verification qui compte
 * le plus ici — B peut-il obtenir la cle privee de A ? — passerait a vide, en
 * disant « ok » parce qu il n y a rien a voler.
 *
 * On en pose donc une, tiree au hasard a chaque execution, qui ne vit que
 * dans l environnement de ce processus et dont le volume est efface a la fin.
 * Elle n est PAS ecrite dans le depot : c est la regle, et elle vaut aussi
 * pour un essai. */
process.env.MIROIR_CLE = 'essai-' + require('crypto').randomBytes(24).toString('hex');

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  /* `config.js` lit l environnement au CHARGEMENT : le charger avant d avoir
     choisi le port faisait demarrer le serveur sur 8080, et l essai frappait
     une porte fermee. Il vient donc ici, pas en tete de fichier. */
  const cfg = require('./config');

  /* Le moteur, attrape au passage : la seule facon de lire les soldes sans
     passer par une porte qu on est justement en train de mettre a l essai. */
  const { Game } = require('./game');
  let moteur = null;
  const p0 = Game.prototype._p;
  Game.prototype._p = function (a) { moteur = this; return p0.call(this, a); };

  require('./server');
  await new Promise((r) => setTimeout(r, 900));

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
      if (Date.now() - t0 > (ms || 5000)) return rej(new Error('pas de ' + type));
      setTimeout(tour, 25);
    })();
  });
  const connecte = async (w) => {
    const s = await ouvre();
    const h = await attend(s, 'hello');
    const msg = 'SWOGE Pusher login\nnonce: ' + h.loginNonce;
    s.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
    await attend(s, 'auth');
    s.recus.length = 0;
    return s;
  };
  /* Envoie, laisse le serveur repondre, et rend TOUT ce qu il a dit. */
  const dit = async (s, m, ms) => { s.recus.length = 0; s.send(JSON.stringify(m)); await new Promise((r) => setTimeout(r, ms || 350)); return s.recus; };
  const aRecu = (l, t) => l.filter((x) => x.type === t).pop() || null;

  const A = ethers.Wallet.createRandom();       /* la victime */
  const B = ethers.Wallet.createRandom();       /* l attaquant */
  const sA = await connecte(A), sB = await connecte(B);
  const adrA = A.address.toLowerCase(), adrB = B.address.toLowerCase();

  /* De quoi avoir quelque chose a voler. */
  for (let i = 0; i < 3; i++) { await dit(sA, { type: 'devCredit' }, 120); }
  const soldeA0 = moteur.balanceStr(adrA);
  ok(Number(soldeA0) > 0, 'le compte A porte ' + soldeA0 + ' $SWOGE — il y a quelque chose a prendre');

  console.log('\n-- le miroir : chaque geste porte sur LA session, jamais sur une adresse du message --');
  {
    /* ---- LA CLE PRIVEE ----
     * C est le pire des cas : un portefeuille genere cote serveur, dont la
     * cle ne part que sur deux messages. Si B peut la demander en nommant A,
     * tout le reste est decoratif. */
    await dit(sA, { type: 'miroirCree' }, 900);
    const cleA = aRecu(sA.recus, 'miroirCle');
    ok(cleA && cleA.adresse, 'A cree son miroir et recoit sa cle une fois');
    const volA = cleA && cleA.adresse;

    for (const champ of ['addr', 'address', 'adr', 'joueur', 'player', 'from', 'owner']) {
      const l = await dit(sB, Object.assign({ type: 'miroirCle' }, { [champ]: adrA }), 300);
      const k = aRecu(l, 'miroirCle');
      ok(!k || !k.cle || k.adresse !== volA,
         'B nommant A dans `' + champ + '` n obtient pas la cle de A');
    }
    const l2 = await dit(sB, { type: 'miroirCree', addr: adrA, address: adrA, adr: adrA }, 900);
    const k2 = aRecu(l2, 'miroirCle');
    ok(!k2 || k2.adresse !== volA, 'ni en demandant une creation au nom de A');

    /* ---- LA SORTIE ----
     * `miroirStop` balaie le portefeuille vers une destination. Si elle
     * venait du message, n importe qui nommerait la sienne. */
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const bloc = src.slice(src.indexOf("m.type === 'miroirStop'"), src.indexOf("m.type === 'miroirStop'") + 700);
    ok(/miroir\.arrete\(ws\.addr,\s*ws\.addr\)/.test(bloc),
       'la destination du balayage est `ws.addr`, ecrite deux fois, pas un champ du message');
  }

  console.log('\n-- la colonie : AI_OWNER est REVERIFIE, pas seulement affiche --');
  {
    for (const geste of ['colonieTiens', 'colonieFerme']) {
      const l = await dit(sB, { type: geste, adr: '0x' + 'c'.repeat(40), minutes: 30 }, 400);
      const e = aRecu(l, 'error');
      ok(e && /AI_OWNER|owner/i.test(e.error || ''),
         'B, qui n est pas le proprietaire, est refuse sur `' + geste + '` : « ' + (e && e.error) + ' »');
      ok(!aRecu(l, 'colonieAction'), 'et aucun geste n est passe');
    }
    /* Et le proprietaire, lui, franchit la porte : une porte qui refuse tout
       le monde n est pas un controle d acces, c est une panne. */
    const sP = await connecte(PROPRIO);
    const l = await dit(sP, { type: 'colonieFerme', adr: '0x' + 'd'.repeat(40) }, 500);
    const e = aRecu(l, 'error');
    ok(!e || !/AI_OWNER|only the colony owner/i.test(e.error || ''),
       'le proprietaire, lui, passe la porte (refus suivant : « ' + (e ? e.error : 'aucun') + ' »)');
    sP.close();
  }

  console.log('\n-- l argent : un transfert debite CELUI QUI PARLE --');
  {
    /* ---- UNE TENTATIVE QUI DOIT POUVOIR REUSSIR ----
     * Premiere ecriture de cet essai : B tentait d envoyer « 1 » depuis le
     * compte de A. Le solde ne bougeait pas, l essai disait « ok », et il ne
     * prouvait RIEN — le transfert etait refuse pour le MONTANT (le minimum
     * est de 10 000 $SWOGE), jamais pour l adresse. Verifie en cassant la
     * regle expres : l essai passait quand meme au vert sur un serveur ou
     * n importe qui pouvait vider le compte du voisin.
     *
     * Une tentative doit donc etre viable de bout en bout : assez de solde,
     * assez de montant, le depot fait. Ce qui l arrete alors est la SEULE
     * chose qu on veut mesurer. */
    const ethersLib = require('ethers');
    const assez = ethersLib.ethers.utils.parseUnits(String(cfg.TRANSFER_MIN * 3), cfg.DECIMALS);
    const pA = moteur._p(adrA);
    pA.balance = assez; pA.hasDeposited = true; pA.bonusBloque = ethersLib.ethers.BigNumber.from(0);
    const pB = moteur._p(adrB);
    pB.hasDeposited = true; pB.bonusBloque = ethersLib.ethers.BigNumber.from(0);
    const MONTANT = String(cfg.TRANSFER_MIN);

    /* Le garde-fou de l essai lui-meme : la tentative DOIT aboutir quand
       c est A qui la fait. Sinon on mesure encore un refus de montant. */
    const avantVrai = moteur.balanceStr(adrB);
    await dit(sA, { type: 'transfer', address: adrB, amount: MONTANT }, 400);
    ok(moteur.balanceStr(adrB) !== avantVrai,
       'A peut bien envoyer ' + MONTANT + ' a B : la tentative est viable, donc le refus qui suit portera sur l ADRESSE');

    const avantA = moteur.balanceStr(adrA), avantB = moteur.balanceStr(adrB);
    /* B tente de faire partir l argent de A. Toutes les facons de nommer A
       qu un attaquant essaierait. */
    for (const champ of ['from', 'addr', 'joueur', 'player', 'owner', 'sender']) {
      await dit(sB, Object.assign({ type: 'transfer', address: adrB, amount: MONTANT }, { [champ]: adrA }), 250);
    }
    eq(moteur.balanceStr(adrA), avantA, 'le solde de A n a pas bouge');
    eq(moteur.balanceStr(adrB), avantB, 'et celui de B non plus : il ne peut pas se payer avec le compte d un autre');

    /* ---- LE ROBINET ----
     * `devCredit` fabrique des jetons que personne n a deposes. Il doit
     * crediter LA session, et rien d autre. */
    const avant = moteur.balanceStr(adrA);
    await dit(sB, { type: 'devCredit', addr: adrA, address: adrA, joueur: adrA }, 300);
    eq(moteur.balanceStr(adrA), avant, 'le robinet ne credite pas une adresse nommee dans le message');
  }

  console.log('\n-- une socket qui n a pas signe n est personne --');
  {
    const muet = await ouvre();
    await attend(muet, 'hello');
    muet.recus.length = 0;
    const avantA = moteur.balanceStr(adrA);
    for (const m of [{ type: 'devCredit' }, { type: 'miroirCle' }, { type: 'miroirCree' },
                     { type: 'transfer', address: adrB, amount: '1' },
                     { type: 'colonieFerme', adr: '0x' + 'e'.repeat(40) },
                     { type: 'betWithdraw', amount: '1' }]) {
      await dit(muet, m, 150);
    }
    eq(moteur.balanceStr(adrA), avantA, 'rien n a bouge sur le compte de A');
    ok(!muet.recus.some((x) => x.type === 'miroirCle' && x.cle), 'aucune cle privee n a ete servie a une socket anonyme');
    muet.close();
  }

  /* ==========================================================================
   * LA VERIFICATION QUI GENERALISE
   *
   * Les blocs ci-dessus attrapent les gestes d aujourd hui. Celui-ci attrape
   * CEUX DE DEMAIN : on relit `server.js` et on exige que tout appel a un
   * module d argent — le miroir, la colonie — prenne `ws.addr` en PREMIER
   * argument. Un jour quelqu un ecrira `miroir.quelqueChose(m.addr, …)` ;
   * aucun essai de comportement ne le verra, celui-ci si.
   * ======================================================================== */
  console.log('\n-- et ce qui n est pas encore ecrit --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const fautifs = [];
    for (const m of src.matchAll(/\b(miroir|aiColonie)\.([a-zA-Z]+)\(([^),]*)/g)) {
      const prem = m[3].trim();
      if (!prem) continue;                                   /* sans argument */
      /* Legitimes : l adresse de la session, une constante, un calcul local.
         Fautif : un champ du message pris comme SUJET du geste. */
      if (/^m\.|^d\.|^msg\./.test(prem)) fautifs.push(m[1] + '.' + m[2] + '(' + prem);
    }
    ok(fautifs.length === 0,
       fautifs.length ? 'un geste prend une adresse du message en premier argument : ' + fautifs.join(', ')
                      : 'aucun geste du miroir ou de la colonie ne prend un champ du message comme sujet');

    /* Le sujet est bien `ws.addr` et pas autre chose : on compte, pour que la
       verification ci-dessus ne puisse pas passer sur un fichier vide. */
    const bons = [...src.matchAll(/\b(miroir|aiColonie)\.[a-zA-Z]+\(ws\.addr/g)].length;
    ok(bons >= 6, bons + ' gestes prennent explicitement `ws.addr` comme sujet');

    /* ---- ET LA CLE DU MIROIR NE VIT PAS DANS LE DEPOT ---- */
    ok(!/MIROIR_CLE\s*=\s*['"][^'"]{8,}/.test(src), 'aucune valeur de MIROIR_CLE ecrite dans le code');
  }

  sA.close(); sB.close();
  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) {}
  console.log(rates ? `\nsecurite_ws.test.js : RATES : ${rates}/${n}` : `\nsecurite_ws.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('  RATE ' + (e.stack || e)); process.exit(1); });
