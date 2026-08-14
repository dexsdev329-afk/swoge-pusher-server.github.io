'use strict';
/*
 * Les photos de profil DANS la sauvegarde.
 *
 * ---- ce qui manquait ----
 *
 * L'archive qui part sur Telegram etait `state.json`, et rien d'autre. Or les
 * images televersees ne sont pas dans `state.json` : elles vivent a cote, un
 * fichier par joueur, pour ne pas etre reecrites toutes les dix secondes avec
 * les soldes. La consequence ne se voyait qu'au pire moment — une restauration
 * sur un volume neuf : chaque joueur retrouvait ses jetons, son niveau, ses
 * amis, ses filleuls... et un portrait casse, parce que sa fiche disait « il en
 * a une » et que l'adresse qui la sert repondait 404.
 *
 * ---- ce que ce fichier verifie ----
 *
 * Le chemin ENTIER et de bout en bout, par les vraies portes HTTP : un joueur
 * televerse → l'archive part → un serveur NEUF, volume vide, la relit → et
 * l'image revient, octet pour octet, servie a la meme adresse.
 *
 * Le journal du joueur — ses depots, ses retraits, chacune de ses manches —
 * manquait pour la meme raison et suit le meme chemin : il est verifie ici
 * aussi, y compris la regle qui le protege, « on n ecrase jamais un journal
 * qui existe ».
 *
 * Les deux controles qui comptent autant que le reste :
 *   • une image que l'archive porte mais qui n'est pas une image est REFUSEE.
 *     Un fichier de sauvegarde est un fichier comme un autre : il a pu etre
 *     modifie entre l'envoi et le retour, et ce qui en sort s'affiche chez les
 *     autres joueurs ;
 *   • le drapeau de la fiche et l'image servie disent la MEME chose. C'est
 *     exactement la ou l'ancien code mentait.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { ethers } = require('ethers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

const CLE = 'cle-de-test';
/* Deux ports a nous. Deriver du pid evite qu'un serveur oublie par une
   execution precedente reponde a la place du notre — et fasse passer ou
   echouer le test pour une raison qui n'a rien a voir. */
const PA = 8900 + (process.pid % 40) * 2;
const PB = PA + 1;
/* Un vrai PNG de 1x1 : les octets d'en-tete comptent, c'est sur eux que porte
   le controle des deux cotes. */
const PNG64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG64, 'base64');

function lance(port, bac) {
  const env = Object.assign({}, process.env, {
    PORT: String(port), DATA_DIR: bac, ADMIN_KEY: CLE, RPC_URL: '', DEV_FAUCET: '1',
  });
  const p = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  nes.push({ p });
  let traces = '';
  p.stdout.on('data', (d) => { traces += d; });
  p.stderr.on('data', (d) => { traces += d; });
  return new Promise((res, rej) => {
    const fin = Date.now() + 20000;
    const t = setInterval(async () => {
      if (Date.now() > fin) { clearInterval(t); return rej(new Error('le serveur n a pas demarre :\n' + traces)); }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.status === 200 || r.status === 503) { clearInterval(t); res({ p, bac, traces: () => traces }); }
      } catch (e) {}
    }, 120);
  });
}
const nes = [];
const arrete = (s) => { try { s.p.kill('SIGKILL'); } catch (e) {} };

/* Un joueur qui se connecte, se credite (donc a le droit de televerser) et
   pose sa photo — par le vrai message, pas en ecrivant dans le dossier. */
async function joueurAvecPhoto(port) {
  const w = ethers.Wallet.createRandom();
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  const recu = [];
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (d) => { try { recu.push(JSON.parse(d)); } catch (e) {} });
  let hello = null;
  for (let i = 0; i < 60 && !hello; i++) { await dors(100); hello = recu.find((m) => m.type === 'hello'); }
  if (!hello) throw new Error('pas de hello du serveur');
  const msg = `SWOGE Pusher login\nnonce: ${hello.loginNonce}`;
  ws.send(JSON.stringify({ type: 'login', message: msg, signature: await w.signMessage(msg) }));
  await dors(300);
  ws.send(JSON.stringify({ type: 'devCredit' }));
  await dors(300);
  ws.send(JSON.stringify({ type: 'avatarUpload', data: 'data:image/png;base64,' + PNG64 }));
  await dors(400);
  /* Une manche jouee : c'est elle qui ecrit une ligne dans le journal, et le
     journal est l'autre moitie de ce qui manquait a l'archive. */
  ws.send(JSON.stringify({ type: 'plinkoDrop', bet: '10', risk: 'medium', rows: 12 }));
  await dors(600);
  const err = recu.filter((m) => m.type === 'error').map((m) => m.error).join(' | ');
  return { ws, addr: w.address.toLowerCase(), recu, err };
}

(async () => {
  const bacA = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-photoA-'));
  const bacB = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-photoB-'));
  const A = await lance(PA, bacA);

  const j = await joueurAvecPhoto(PA);
  ok(!/upload/.test(j.err), 'le joueur a pu televerser sa photo' + (j.err ? ' — ' + j.err : ''));

  // ---------------------------------------------- elle est bien servie ici
  {
    const r = await fetch(`http://127.0.0.1:${PA}/avatar/${j.addr}`);
    eq(r.status, 200, 'le serveur d origine sert bien l image');
    const b = Buffer.from(await r.arrayBuffer());
    ok(b.equals(PNG), 'et c est exactement celle qui a ete envoyee');
  }

  // ------------------------------------ L ARCHIVE, elle, doit la contenir
  let archive;
  {
    const r = await fetch(`http://127.0.0.1:${PA}/export?key=${CLE}`);
    eq(r.status, 200, 'l export repond');
    archive = Buffer.from(await r.arrayBuffer());
    const clair = zlib.gunzipSync(archive).toString('utf8');
    /* C'EST L ASSERTION QUI ECHOUE SUR L ANCIEN CODE : l'archive ne portait
       que les soldes. */
    ok(clair.includes(PNG64),
       'l archive porte l image du joueur — sans ca, une restauration rend un portrait casse');
    const o = JSON.parse(clair);
    ok(o.avatars && o.avatars[j.addr], 'rangee sous son adresse, pas melangee aux fiches');
    ok(Array.isArray(o.players) && o.players.length >= 1, 'et les fiches sont toujours la');
    eq(r.headers.get('x-swoge-photos'), '1', 'l en-tete annonce combien d images partent');
    /* L'HISTORIQUE, l'autre moitie. Sans lui, le joueur retrouve son argent
       devant un profil sans passe. */
    ok(o.journal && o.journal[j.addr], 'l archive porte aussi le journal du joueur');
    ok(/"t":/.test(o.journal[j.addr]), 'avec de vrais evenements dedans');
    /* Et l'image n'est TOUJOURS pas dans le fichier d'etat lui-meme : c'est la
       decision d'origine — on l'ajoute a l'archive, pas aux ecritures de
       toutes les dix secondes. L'export vient d'ecrire le fichier, on peut
       donc le lire. */
    const surDisque = fs.readFileSync(path.join(bacA, 'state.json'), 'utf8');
    ok(!surDisque.includes(PNG64.slice(0, 40)),
       'l image ne dort pas dans state.json — elle est a cote, comme avant');
  }

  // ================== UN SERVEUR NEUF, VOLUME VIDE : le jour du sinistre
  const B = await lance(PB, bacB);
  {
    const avant = await fetch(`http://127.0.0.1:${PB}/avatar/${j.addr}`);
    eq(avant.status, 404, 'le serveur neuf n a evidemment rien');

    const r = await fetch(`http://127.0.0.1:${PB}/import?key=${CLE}&confirm=REPLACE-ALL`,
                          { method: 'POST', body: archive });
    const rep = await r.json();
    eq(r.status, 200, 'la restauration passe');
    ok(rep.remplace, 'et remplace bien l etat');
    ok(rep.photos && rep.photos.poses === 1, 'elle repose une image', JSON.stringify(rep.photos));

    ok(rep.journaux && rep.journaux.poses === 1, 'et repose un journal',
       JSON.stringify(rep.journaux));

    const apres = await fetch(`http://127.0.0.1:${PB}/avatar/${j.addr}`);
    eq(apres.status, 200, 'et l image est de nouveau servie, sur la machine neuve');
    const b = Buffer.from(await apres.arrayBuffer());
    ok(b.equals(PNG), 'octet pour octet, la meme');

    /* Le point qui rendait le defaut invisible : la fiche disait « photo »
       pendant que l'adresse repondait 404. Les deux doivent s'accorder. */
    const pj = await (await fetch(`http://127.0.0.1:${PB}/api/j/${j.addr}`)).json().catch(() => null);
    if (pj && pj.profil) {
      eq(!!pj.profil.photo, true, 'la fiche restauree dit qu il y a une photo');
      ok(apres.status === 200, 'et il y en a une — le drapeau et l image disent la meme chose');
    }
  }

  // ---------------- on n ecrase JAMAIS un journal qui existe deja
  /* Une restauration lancee sur un serveur qui tourne ne doit pas effacer
     l'histoire d'aujourd'hui avec celle d'hier — ni la dupliquer en ajoutant
     a la suite. */
  {
    const chemin = path.join(bacB, 'journal', j.addr + '.jsonl');
    const avant = fs.readFileSync(chemin, 'utf8');
    ok(avant.length > 0, 'le journal restaure est bien sur le disque du serveur neuf');
    fs.appendFileSync(chemin, JSON.stringify({ t: Date.now(), k: 'apres-restauration' }) + '\n');
    const augmente = fs.readFileSync(chemin, 'utf8');

    const r = await fetch(`http://127.0.0.1:${PB}/import?key=${CLE}&confirm=REPLACE-ALL`,
                          { method: 'POST', body: archive });
    const rep = await r.json();
    eq(rep.journaux.poses, 0, 'la deuxieme restauration ne repose aucun journal');
    eq(rep.journaux.gardes, 1, 'elle garde celui qui existait, intact');
    eq(fs.readFileSync(chemin, 'utf8'), augmente,
       'et le fichier n a pas bouge d un octet — ni ecrase, ni double');
  }

  // -------------------------- une archive trafiquee ne pose pas n importe quoi
  {
    const clair = JSON.parse(zlib.gunzipSync(archive).toString('utf8'));
    const menteur = '0x' + 'cd'.repeat(20);
    /* Le meme en-tete annonce, des octets qui n'en sont pas : c'est
       exactement la forme d'un fichier retouche. */
    clair.avatars[menteur] = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
    const truque = zlib.gzipSync(Buffer.from(JSON.stringify(clair)));
    const r = await fetch(`http://127.0.0.1:${PB}/import?key=${CLE}&confirm=REPLACE-ALL`,
                          { method: 'POST', body: truque });
    const rep = await r.json();
    eq(r.status, 200, 'la restauration se fait quand meme — un solde ne se perd pas pour une image');
    eq(rep.photos.refusees, 1, 'mais l image trafiquee est refusee');
    eq(rep.photos.poses, 1, 'et la vraie, elle, est bien reposee');
    eq((await fetch(`http://127.0.0.1:${PB}/avatar/${menteur}`)).status, 404,
       'rien n est servi pour celle qui a ete refusee');
  }

  try { j.ws.close(); } catch (e) {}
  arrete(A); arrete(B);
  fs.rmSync(bacA, { recursive: true, force: true });
  fs.rmSync(bacB, { recursive: true, force: true });
  console.log(`photos_sauvegarde.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => {
  /* On tue toujours les deux serveurs : un test qui echoue et laisse un
     processus derriere lui fait echouer le SUIVANT pour une autre raison, et
     on cherche le defaut au mauvais endroit. */
  for (const s of nes) { try { s.p.kill('SIGKILL'); } catch (x) {} }
  console.error(e); process.exit(1);
});
