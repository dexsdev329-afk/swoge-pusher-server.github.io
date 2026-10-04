'use strict';
/* ==========================================================================
 * TOR / .onion — VEILLE DARK-WEB DEFENSIVE, EN LECTURE SEULE
 * ==========================================================================
 *
 * Demande du proprietaire (04/10) : « mettre un navigateur avec acces au .onion
 * pourrait etre interessant » — pour la veille. Le seul usage que ce fichier
 * sert : verifier NOTRE PROPRE exposition (nos adresses de contrat, notre
 * domaine, des identifiants a nous) sur des pages .onion publiques.
 *
 * LA LIGNE, identique a l'OSINT et au bug bounty :
 *   - LECTURE SEULE : un GET, borne en taille et en temps. Aucune ecriture,
 *     aucun formulaire, aucun identifiant, aucune transaction. Ce fichier n'en
 *     contient pas le code. Ce n'est PAS une passerelle vers un marche.
 *   - AUTORISATION : interroger un .onion passe par la meme garde que le bug
 *     bounty (bugbounty.autorisation) — l'utilisateur coche la case qui ATTESTE
 *     qu'il a le droit et qu'il est responsable. Journalise comme le reste.
 *   - DESACTIVE PAR DEFAUT : sans un demon Tor (TOR_SOCKS, ex. 127.0.0.1:9050),
 *     le module DIT ce qui manque et ne fait rien — comme x_post sans ses cles.
 *
 * Pour l'activer en production : poser Tor dans le conteneur du navigateur
 * (Dockerfile.navigateur) et regler TOR_SOCKS. Tant que ce n'est pas fait, les
 * essais passent (socket injectable) mais rien ne sort de la machine.
 * ======================================================================== */

const net = require('net');
const bugbounty = require('./bugbounty');

const TAILLE_MAX = 512 * 1024;   /* 512 Ko par page, comme l'OSINT */
const DELAI_MS = 20000;

function proxy() {
  const v = (process.env.TOR_SOCKS || '').trim();
  const m = v.match(/^(?:socks5h?:\/\/)?([^:]+):(\d+)$/);
  return m ? { hote: m[1], port: Number(m[2]) } : null;
}
function disponible() { return !!proxy(); }

/* Un hote .onion valide : v3 = 56 base32 + .onion ; on tolere aussi le v2
   (16) pour ne pas refuser une vieille adresse, mais rien de plus. */
function estOnion(hote) { return /^[a-z2-7]{16}\.onion$/.test(hote) || /^[a-z2-7]{56}\.onion$/.test(hote); }

/* Le handshake SOCKS5 (sans authentification) puis CONNECT vers hote:port.
   `deps.connect` est injectable pour les essais (aucun reseau reel). */
function connecteViaSocks(hote, port, deps) {
  const p = proxy();
  return new Promise((resolve, reject) => {
    const s = (deps && deps.connect) ? deps.connect(p.port, p.hote) : net.connect(p.port, p.hote);
    let etape = 0; const bouts = [];
    const fin = (e, v) => { s.removeAllListeners('data'); if (e) { try { s.destroy(); } catch (x) {} reject(e); } else resolve(v); };
    s.on('error', (e) => fin(e));
    s.on('connect', () => s.write(Buffer.from([0x05, 0x01, 0x00])));   /* version 5, 1 methode, « no auth » */
    s.on('data', (d) => {
      bouts.push(d); const buf = Buffer.concat(bouts);
      if (etape === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fin(new Error('SOCKS5: proxy refused (no-auth)'));
        bouts.length = 0; etape = 1;
        const h = Buffer.from(hote, 'ascii');
        const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
        return s.write(req);
      }
      if (etape === 1) {
        if (buf.length < 10) return;                 /* reponse CONNECT : 10 octets au moins (adresse IPv4) */
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fin(new Error('SOCKS5: CONNECT failed (code ' + buf[1] + ')'));
        bouts.length = 0; etape = 2;
        return fin(null, s);
      }
    });
  });
}

/**
 * litOnion(url, o, deps) — LIT une page .onion, si autorise et si Tor est la.
 *   url : http://<hote>.onion[/...]  (http uniquement dans cette version ;
 *         une page https .onion demanderait d'envelopper TLS — a venir).
 *   o   : { programme?, attestation? } — la meme garde que le bug bounty.
 *   deps.connect : socket injectable (essais).
 * Rend { ok, statut?, type?, corps? } | { ok:false, raison }.
 */
async function litOnion(url, o, deps) {
  let u; try { u = new URL(String(url)); } catch (e) { return { ok: false, raison: 'not a URL' }; }
  if (u.protocol !== 'http:') return { ok: false, raison: 'only http:// .onion is supported here (https would need TLS wrapping)' };
  if (!estOnion(u.hostname)) return { ok: false, raison: 'not a .onion address' };

  /* La garde D'ABORD : on refuse le non-autorise avant tout, meme avant de
     regarder si Tor est configure. On traite le .onion comme une cible. */
  const a = bugbounty.autorisation({ cible: u.hostname, programme: (o && o.programme), attestation: (o && o.attestation) });
  if (!a.ok) return { ok: false, raison: a.raison, attestationTexte: bugbounty.ATTESTATION_TEXTE };
  /* Puis seulement : Tor doit etre la (sinon rien ne sort). */
  if (!disponible()) return { ok: false, raison: 'Tor is not configured — set TOR_SOCKS (e.g. 127.0.0.1:9050) and run a Tor daemon' };
  if (a.mode === 'attested' && a.journal) { try { bugbounty.journaliseAttestation(Object.assign({ via: 'tor' }, a.journal)); } catch (e) { return { ok: false, raison: 'could not log the attestation; nothing fetched' }; } }

  const port = u.port ? Number(u.port) : 80;
  let s;
  try { s = await connecteViaSocks(u.hostname, port, deps); }
  catch (e) { return { ok: false, raison: String((e && e.message) || e).slice(0, 120) }; }

  return await new Promise((resolve) => {
    let recu = Buffer.alloc(0); let fini = false;
    const minuteur = setTimeout(() => done({ ok: false, raison: 'timeout' }), DELAI_MS);
    function done(v) { if (fini) return; fini = true; clearTimeout(minuteur); try { s.destroy(); } catch (e) {} resolve(v); }
    s.on('data', (d) => {
      recu = Buffer.concat([recu, d]);
      if (recu.length > TAILLE_MAX) { recu = recu.slice(0, TAILLE_MAX); done(parse(recu)); }
    });
    s.on('end', () => done(parse(recu)));
    s.on('error', (e) => done({ ok: false, raison: String((e && e.message) || e).slice(0, 120) }));
    /* GET, en lecture seule, en se presentant honnetement. */
    const chemin = (u.pathname || '/') + (u.search || '');
    s.write('GET ' + chemin + ' HTTP/1.1\r\nHost: ' + u.hostname + '\r\nUser-Agent: SwogeOnionWatch/1 (defensive, read-only)\r\nAccept: text/html\r\nConnection: close\r\n\r\n');
  });
}

function parse(buf) {
  const txt = buf.toString('utf8');
  const sep = txt.indexOf('\r\n\r\n');
  const tete = sep >= 0 ? txt.slice(0, sep) : txt;
  const corps = sep >= 0 ? txt.slice(sep + 4) : '';
  const l1 = tete.split('\r\n')[0] || '';
  const statut = Number((l1.match(/\s(\d{3})\s/) || [])[1] || 0) || null;
  const ct = (tete.match(/content-type:\s*([^\r\n]+)/i) || [])[1] || null;
  return { ok: true, statut, type: ct, corps: corps.slice(0, TAILLE_MAX) };
}

module.exports = { disponible, estOnion, proxy, connecteViaSocks, litOnion, TAILLE_MAX, DELAI_MS };
