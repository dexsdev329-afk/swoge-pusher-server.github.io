'use strict';
/*
 * L'acces au tableau de bord.
 *
 * ---- ce qui est verifie, et pourquoi ----
 *
 * Ce test lance un VRAI serveur et frappe a ses portes. Rien d'autre ne
 * prouverait ce qu'on veut prouver : une regle d'acces se verifie de
 * l'exterieur, comme un inconnu la rencontrerait.
 *
 * Le controle central est celui-ci : SANS CLE CONFIGUREE, TOUT EST FERME.
 * C'etait l'inverse — une cle absente ouvrait tout, et l'oubli d'une variable
 * d'environnement (la faute la plus banale d'un deploiement) publiait le solde
 * de chaque joueur et laissait n'importe qui appeler /repare ou /burn. Un
 * oubli ne doit jamais elargir un acces.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

/* Les portes privees. Chacune donne acces a quelque chose de different — les
   soldes, l'argent, les comptes — et chacune doit etre fermee separement :
   il suffit d'une seule oubliee. */
const PRIVEES = ['/admin', '/players', '/stats',
                 '/audit?addr=0x' + 'a'.repeat(40),
                 '/repare?addr=0x' + 'a'.repeat(40),
                 '/burn?amount=1&tx=0x' + 'b'.repeat(64),
                 '/avatar-remove?addr=0x' + 'a'.repeat(40),
                 /* La liste des paris nomme CHAQUE joueur et montre ce qu il
                    a mise. Ouverte, elle dirait a n importe qui qui parie
                    quoi et combien — et sur un site ou l on peut suivre une
                    adresse, ca suffit a cibler quelqu un. */
                 '/paris/liste',
                 '/paris/aregler',
                 '/paris/import',
                 /* Le robinet. Ouvert, il ne fuit pas des informations : il
                    fabrique des jetons que personne n'a deposes. C'est la
                    porte a laisser fermee avant toutes les autres. */
                 '/credit?joueur=x&montant=1',
                 '/credit/etat',
                 '/usage',
                 /* Les memes chiffres que /usage, en donnees. Une porte de
                    plus, donc une porte de plus a fermer : c'est exactement
                    le genre d'ajout qui laisse un trou quand on l'oublie. */
                 '/usage.json',
                 '/adminlog',
                 '/reglages',
                 '/taps',
                 '/player?addr=0x' + 'a'.repeat(40)];

function lance(port, cle) {
  const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-acces-'));
  /* ---- LE TEST NE DOIT TOUCHER AUCUN RESEAU ----
   *
   * `lance` heritait de tout l'environnement, RPC_URL compris : chaque serveur
   * lance essayait donc de joindre la vraie chaine. Selon l'endroit d'ou le
   * test tourne, cet appel repond, echoue vite, ou N'EN FINIT PAS — et le test
   * reste alors suspendu sans rien dire. Un test qui depend d'Internet n'est
   * pas un test, c'est un tirage au sort.
   *
   * On pointe donc la chaine sur un port ferme de la machine : le refus est
   * immediat, et ce test-ci ne parle que d'acces, jamais de chaine. */
  const env = Object.assign({}, process.env, {
    PORT: String(port), DATA_DIR: bac,
    RPC_URL: 'http://127.0.0.1:1', VAULT_ADDRESS: '', SWOGE_TOKEN: '',
    TG_BOT_TOKEN: '', TG_CHAT_ID: '', ODDS_API_KEY: '', MONITEUR_URL: '',
  });
  if (cle) env.ADMIN_KEY = cle; else delete env.ADMIN_KEY;
  const p = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let traces = '';
  p.stdout.on('data', (d) => { traces += d; });
  p.stderr.on('data', (d) => { traces += d; });
  return new Promise((res) => {
    const t = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) { clearInterval(t); res({ p, bac, traces: () => traces }); }
      } catch (e) {}
    }, 120);
  });
}
const arrete = (s) => { try { s.p.kill('SIGKILL'); } catch (e) {} fs.rmSync(s.bac, { recursive: true, force: true }); };
/* `suivre:false` pour voir la REDIRECTION elle-meme : `fetch` la suit par
   defaut, et le pont /admin?key= rendrait alors 200 ou 401 selon ce qui se
   trouve au bout — on ne verifierait plus qu il redirige. */
const code = async (port, chemin, entetes, suivre) => (await fetch(
  `http://127.0.0.1:${port}${chemin}`,
  { headers: entetes || {}, redirect: suivre === false ? 'manual' : 'follow' })).status;

(async () => {
  // ============================ sans cle configuree : TOUT est ferme
  {
    const s = await lance(8791, null);
    for (const porte of PRIVEES) {
      const c = await code(8791, porte);
      eq(c, 503, `sans ADMIN_KEY, ${porte.split('?')[0]} est ferme (503)`);
    }
    /* Et une cle inventee n'ouvre rien non plus : il n'y a pas de cle a
       deviner, la porte n'existe simplement pas. */
    eq(await code(8791, '/stats?key=nimporte'), 503, 'et aucune cle inventee ne l ouvre');
    eq(await code(8791, '/health'), 200, 'la sonde de sante, elle, reste publique');
    ok(/ADMIN_KEY absente/.test(s.traces()),
       'le serveur le dit au demarrage plutot que de le laisser decouvrir');
    arrete(s);
  }

  // ============================ avec une cle : elle seule ouvre
  {
    const CLE = 'cle-de-test-9f3a';
    const s = await lance(8792, CLE);
    /* LA BONNE CLE D'ABORD. Les refus qui suivent nourrissent le compteur
       d'essais rates, et passe le plafond le serveur bloque l'adresse — c'est
       voulu. Verifier l'ouverture APRES une serie de refus ne testerait donc
       plus la cle mais le blocage, et le test cassait des qu'on ajoutait une
       porte a la liste. */
    /* ---- LA CLE NE VOYAGE PLUS DANS L'ADRESSE ----
     *
     * `?key=` ouvrait toutes les portes. Une cle dans une adresse se retrouve
     * dans l'historique du navigateur, dans les journaux de l'hebergeur, dans
     * ceux de chaque intermediaire, et dans l'en-tete `Referer` envoye a
     * chaque ressource externe de la page.
     *
     * Ce test dit maintenant la propriete dans les DEUX SENS : l'en-tete
     * ouvre, l'adresse n'ouvre plus. Ecrit dans un seul sens, il aurait
     * approuve un serveur ou la cle serait revenue dans l'adresse. */
    eq(await code(8792, '/stats', { 'x-admin-key': CLE }), 200,
       'l en-tete ouvre — il ne va ni dans l historique ni dans les journaux');
    eq(await code(8792, '/stats?key=' + CLE), 401,
       'la MEME cle dans l adresse n ouvre plus /stats');
    eq(await code(8792, '/usage?key=' + CLE), 401,
       'ni /usage');
    eq(await code(8792, '/players?key=' + CLE), 401,
       'ni la liste des joueurs');
    eq(await code(8792, '/usage', { 'x-admin-key': CLE }), 200,
       'mais l en-tete, oui');

    /* ---- LE PONT, ET RIEN QUE LE PONT ----
     *
     * `?key=` survit sur /admin seulement, et il ne SERT que a poser le cookie
     * avant de rediriger vers une adresse propre : la cle quitte la barre
     * d'adresse a la premiere seconde. Sans ce pont, le marque-page existant
     * cesserait de fonctionner sans dire pourquoi — et le reflexe serait de
     * remettre la cle partout. */
    eq(await code(8792, '/admin?key=' + CLE, {}, false), 302,
       'le marque-page avec ?key= redirige (il pose le cookie et nettoie l adresse)');

    /* Sans rien, /admin rend la PAGE DE CONNEXION — un formulaire, pas un
       ecran blanc marque 401. Le code reste 401 : c'est vrai, et c'est ce que
       lit un moniteur. */
    {
      const r = await fetch('http://127.0.0.1:8792/admin');
      const t = await r.text();
      eq(r.status, 401, 'sans session, /admin repond 401');
      ok(/admin\/login/.test(t), 'et rend un formulaire qui poste la cle dans un corps');
      /* La page PARLE de `?key=` — elle explique le pont pour le marque-page,
         et c'est utile. Ce qu'elle ne doit pas faire, c'est en FABRIQUER un :
         pas de lien, pas de formulaire, pas de redirection qui remette la cle
         dans une adresse. L'assertion porte donc sur les mecanismes, pas sur
         le mot. */
      ok(!/href=["'][^"']*key=/.test(t), 'aucun lien ne remet la cle dans une adresse');
      ok(!/action=["'][^"']*key=/.test(t), 'aucun formulaire ne l envoie en GET');
      ok(!/location\.(href|replace)[^;]*key=/.test(t), 'aucune redirection ne la rajoute');
      ok(/method:"POST"|method: *"POST"/.test(t), 'la cle part en POST, dans un corps');
    }

    /* ---- LES GESTES QUI DEPLACENT DE L'ARGENT NE SONT PLUS DES GET ----
     *
     * `/credit`, `/repare` et `/burn` etaient des GET. Une adresse collee dans
     * un onglet, prechargee par le navigateur ou laissee dans un historique
     * suffisait a crediter un joueur. */
    for (const porte of ['/credit?joueur=x&montant=999999',
                         '/repare?addr=0x' + 'a'.repeat(40),
                         '/burn?amount=1&tx=0x' + 'b'.repeat(64),
                         '/avatar-remove?addr=0x' + 'a'.repeat(40)]) {
      const r = await fetch('http://127.0.0.1:8792' + porte, { headers: { 'x-admin-key': CLE } });
      eq(r.status, 405, `${porte.split('?')[0]} en GET, meme avec la cle : refuse`);
    }

    for (const porte of PRIVEES) {
      eq(await code(8792, porte), 401, `sans la cle, ${porte.split('?')[0]} refuse (401)`);
    }
    eq(await code(8792, '/stats?key=' + CLE + 'x'), 401, 'une cle presque juste : refusee');
    eq(await code(8792, '/stats?key=' + CLE.slice(0, -1)), 401, 'une cle tronquee : refusee');

    /* Ce qui est derriere la porte ne doit jamais fuir par une autre. */
    const r = await fetch('http://127.0.0.1:8792/');
    const t = await r.text();
    ok(!/balance|owedToPlayers|address/.test(t),
       'la racine publique ne laisse filtrer aucun solde ni aucune adresse');
    arrete(s);
  }

  // ============================ on ne peut pas essayer indefiniment
  /* Une cle de dix caracteres se devine en quelques heures a mille essais par
     seconde. A dix essais par dix minutes, il faut des siecles. */
  {
    const s = await lance(8793, 'une-autre-cle');
    /* Les essais passent par l'EN-TETE, puisque c'est desormais le seul canal
       qu'une cle emprunte. Le compteur, lui, n'a pas change de role : il
       ralentit celui qui devine. */
    let refus = 0;
    for (let i = 0; i < 12; i++) {
      if (await code(8793, '/stats', { 'x-admin-key': 'faux' + i }) === 401) refus++;
    }
    ok(refus >= 10, `les premiers essais sont refuses un par un (${refus})`);
    const apres = await code(8793, '/stats', { 'x-admin-key': 'une-autre-cle' });
    eq(apres, 401, 'et passe dix essais rates, MEME LA BONNE CLE est refusee un moment');
    ok(/bloque apres/.test(s.traces()), 'le blocage est trace, pour qu on sache qu on a ete visite');

    /* DERRIERE UN PROXY, toutes les requetes portent la meme adresse : compter
       dessus bloquerait le proprietaire des qu'un inconnu essaie. On compte
       donc par adresse TRANSMISE — sinon ce garde-fou se retourne contre
       celui qu'il protege. */
    const propre = await code(8793, '/stats',
      { 'x-admin-key': 'une-autre-cle', 'x-forwarded-for': '203.0.113.7' });
    eq(propre, 200, 'un visiteur d une AUTRE adresse n est pas puni pour les essais du premier');
    arrete(s);
  }

  console.log(`acces.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC', e); process.exit(1); });
