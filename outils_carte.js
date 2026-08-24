'use strict';
/*
 * TIRER UNE CARTE DE JOUEUR DANS UN FICHIER.
 *
 * ---- POURQUOI CET OUTIL EXISTE ----
 *
 * Quelqu'un dessine quelque chose de bien et l'on veut s'en servir : en faire
 * un vrai lieu, la retoucher, la garder au chaud avant une bascule de format.
 * La route `/admin/cartes` sait deja tout dire — mais la lire a la main, la
 * recoller et la mettre en forme est le genre de geste qu'on fait mal une fois
 * sur trois, et toujours celle qui compte.
 *
 * ---- ET POURQUOI IL NE SAIT QUE LIRE ----
 *
 * `/admin/cartes` refuse tout ce qui n'est pas un GET, et c'est voulu : ce
 * sont les dessins de joueurs. Un outil qui saurait aussi ECRIRE serait une
 * porte ouverte sur le travail de quelqu'un d'autre, ouverte pour la commodite
 * de celui qui administre. Le jour ou l'on voudra reposer une carte modifiee,
 * ce sera par un chemin ecrit expres, qui dira a qui elle appartient.
 *
 *   node outils_carte.js liste
 *   node outils_carte.js tire 3 > carte3.json
 *
 * L'adresse et la cle se lisent dans l'environnement :
 *   SWOGE_ADMIN   par defaut http://127.0.0.1:8080
 *   ADMIN_KEY     la meme que celle du serveur
 */
const https = require('https');
const http = require('http');

const BASE = process.env.SWOGE_ADMIN || 'http://127.0.0.1:8080';
const CLE = process.env.ADMIN_KEY || '';

function demande(chemin) {
  return new Promise((res, rej) => {
    const u = new URL(BASE + chemin);
    const mod = u.protocol === 'https:' ? https : http;
    const q = mod.request(u, { headers: { 'x-admin-key': CLE } }, (r) => {
      let d = '';
      r.on('data', (m) => { d += m; });
      r.on('end', () => {
        if (r.statusCode !== 200) return rej(new Error(`${r.statusCode} — ${d.slice(0, 200)}`));
        try { res(JSON.parse(d)); } catch (e) { rej(new Error('reponse illisible')); }
      });
    });
    q.on('error', rej);
    q.end();
  });
}

async function principal() {
  const [quoi, arg] = process.argv.slice(2);
  if (!CLE) {
    console.error('ADMIN_KEY absente : posez la meme que celle du serveur.');
    process.exit(2);
  }
  if (quoi === 'liste') {
    const j = await demande('/admin/cartes');
    for (const k of j.cartes || []) {
      console.error(`${String(k.id).padStart(4)}  ${k.mode === 'iso' ? '2.5D' : '2D  '}`
        + `  ${String(k.cote).padStart(2)}x${k.cote}  ${String(k.cases).padStart(5)} cases`
        + `  ${(k.nomAuteur || k.addr || '?').slice(0, 18).padEnd(18)}  ${k.nom}`);
    }
    console.error(`\n${(j.cartes || []).length} cartes.`);
    return;
  }
  if (quoi === 'tire' && arg) {
    const j = await demande('/admin/cartes?id=' + encodeURIComponent(arg));
    if (!j.ok) { console.error(j.error || 'refus'); process.exit(1); }
    /* La carte sur la SORTIE, les commentaires sur l'erreur : c'est ce qui
       permet de rediriger vers un fichier sans avoir a nettoyer apres. */
    const k = j.carte;
    console.error(`carte ${k.id} « ${k.nom} » — ${k.mode || 'plat'}, ${k.cote}x${k.cote},`
      + ` ${k.cases.length} cases, depart ${k.depart ? k.depart.c + ',' + k.depart.l : 'absent'}`);
    console.log(JSON.stringify(k, null, 1));
    return;
  }
  console.error('usage : node outils_carte.js liste | tire <id>');
  process.exit(2);
}

principal().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
