'use strict';
/* ==========================================================================
 * TELECHARGER UNE VIDEO DE FOURNISSEUR, SANS SE LAISSER EMMENER AILLEURS
 *
 * Revue du 13/10/2026 (planches.js, derniere_image.js) : la liste blanche des
 * hotes ne verifiait que la PREMIERE adresse. fetch suit les redirections par
 * defaut : une reponse 302 d'un hote permis menait a n'importe quel hote, en
 * http compris (montage : un service interne lu et range sur le volume, puis
 * servi au proprietaire). Et le corps etait lu EN ENTIER en memoire avant le
 * controle des 80 Mo.
 *
 * Ici : redirect 'manual', au plus 3 sauts suivis a la main, chaque adresse
 * revérifiee (https, hote de la liste) ; un content-length au-dela du maximum
 * est refuse sans lire ; le corps est lu en flux avec un compteur qui abandonne
 * au maximum. Rend un Buffer, ou leve une erreur courte (jamais la cle : il
 * n'y en a pas dans ces adresses de CDN).
 * ======================================================================== */

const SAUTS = 3;

/**
 * telechargeSur(url, { fetch, hoteOk, httpPermis, max, delaiMs })
 *   fetch(u, opts) : celui du module appelant (les essais le remplacent) ;
 *   hoteOk(hostname) : la liste blanche ; max : octets au plus.
 */
async function telechargeSur(url, o) {
  const chercher = o.fetch || ((u, opts) => fetch(u, opts));
  const max = o.max;
  let u;
  try { u = new URL(String(url || '')); } catch (e) { throw new Error('no video URL'); }
  for (let saut = 0; ; saut++) {
    if ((u.protocol !== 'https:' && !(o.httpPermis && u.protocol === 'http:')) || !o.hoteOk(u.hostname)) throw new Error('refused host ' + u.hostname);
    const r = await chercher(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(o.delaiMs || 120000) });
    const st = Number(r && r.status);
    if (st >= 300 && st < 400) {
      const loc = r.headers && typeof r.headers.get === 'function' ? r.headers.get('location') : null;
      if (!loc) throw new Error('redirect without location');
      if (saut + 1 > SAUTS) throw new Error('too many redirects');
      try { u = new URL(loc, u); } catch (e) { throw new Error('bad redirect'); }
      continue;
    }
    if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : '?'));
    const annonce = r.headers && typeof r.headers.get === 'function' ? Number(r.headers.get('content-length')) : NaN;
    if (Number.isFinite(annonce) && annonce > max) throw new Error('size ' + annonce);
    /* en flux, avec un compteur : on abandonne des que le maximum est depasse */
    if (r.body && typeof r.body.getReader === 'function') {
      const lecteur = r.body.getReader(), morceaux = [];
      let n = 0;
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done) break;
        n += value.length;
        if (n > max) { try { await lecteur.cancel(); } catch (e) { /* rien */ } throw new Error('size > ' + max); }
        morceaux.push(Buffer.from(value.buffer, value.byteOffset, value.length));
      }
      return Buffer.concat(morceaux, n);
    }
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > max) throw new Error('size ' + b.length);
    return b;
  }
}

module.exports = { telechargeSur, SAUTS };
