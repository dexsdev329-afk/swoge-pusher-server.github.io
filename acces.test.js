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
                 '/usage'];

function lance(port, cle) {
  const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'swoge-acces-'));
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: bac });
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
const code = async (port, chemin, entetes) => (await fetch(`http://127.0.0.1:${port}${chemin}`, { headers: entetes || {} })).status;

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
    eq(await code(8792, '/stats?key=' + CLE), 200, 'la bonne cle ouvre');
    eq(await code(8792, '/stats', { 'x-admin-key': CLE }), 200,
       'et l en-tete marche aussi — une cle dans l adresse finit dans les journaux');
    eq(await code(8792, '/admin?key=' + CLE), 200, 'le tableau de bord s ouvre');
    eq(await code(8792, '/usage?key=' + CLE), 200, 'et le tableau de ce qui est joue');

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
    let refus = 0;
    for (let i = 0; i < 12; i++) if (await code(8793, '/stats?key=faux' + i) === 401) refus++;
    ok(refus >= 10, `les premiers essais sont refuses un par un (${refus})`);
    const apres = await code(8793, '/stats?key=une-autre-cle');
    eq(apres, 401, 'et passe dix essais rates, MEME LA BONNE CLE est refusee un moment');
    ok(/bloque apres/.test(s.traces()), 'le blocage est trace, pour qu on sache qu on a ete visite');

    /* DERRIERE UN PROXY, toutes les requetes portent la meme adresse : compter
       dessus bloquerait le proprietaire des qu'un inconnu essaie. On compte
       donc par adresse TRANSMISE — sinon ce garde-fou se retourne contre
       celui qu'il protege. */
    const propre = await code(8793, '/stats?key=une-autre-cle', { 'x-forwarded-for': '203.0.113.7' });
    eq(propre, 200, 'un visiteur d une AUTRE adresse n est pas puni pour les essais du premier');
    arrete(s);
  }

  console.log(`acces.test.js : ${n} verifications OK`);
  process.exit(0);
})().catch((e) => { console.error('ECHEC', e); process.exit(1); });
