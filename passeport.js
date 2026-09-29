'use strict';
/* ==================================================================
 * L'AGENT PASSPORT — L'IDENTITE VERIFIABLE D'UNE CLE swg_ (29/09/2026)
 * ==================================================================
 *
 * Etape 3 de l'analyse « Agent OS » (ChatGPT/Grok), retenue par le proprietaire.
 * Un agent qui paie ou se fait payer doit pouvoir dire QUI il est, pour QUI il
 * agit, ce qu'il a le DROIT de faire, et ce qu'il a DEJA fait — et un autre agent
 * doit pouvoir le verifier sans nous croire sur parole.
 *
 * Le passeport d'une cle n'invente rien : il lit agentic_cles (proprietaire, payeur,
 * plafond, permissions, appels comptes depuis le 29/09) et la chaine d'audit de la
 * passerelle (passerelle.js). Il est SIGNE en Ed25519 par une cle DEDIEE, qui ne
 * detient aucun fonds et ne signe rien d'autre (DATA_DIR/passeport_ed25519.pem,
 * creee au premier usage) ; la cle publique est publiee
 * (/.well-known/swoge-passport.json) : n'importe qui verifie la signature du JSON
 * canonique (cles triees), avec openssl, Node ou WebCrypto.
 *
 * Prive par defaut : seuls le proprietaire (sa session) et la cle elle-meme le
 * lisent. Public seulement si le proprietaire le publie — le portefeuille du
 * proprietaire devient alors visible, et la page le dit avant.
 * Un passeport est un INSTANTANE : il porte sa date et expire 24 h apres.
 * ================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DUREE_MS = 24 * 3600e3;

/** Le JSON canonique : cles triees a tous les niveaux, sans espaces. C'est ce qui est signe. */
function canonique(v) {
  if (Array.isArray(v)) return '[' + v.map(canonique).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonique(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * deps : { dossier, cles (agentic_cles), audit?(addr, id) → { lignes, chaine }, api, site, maintenant? }
 */
function cree(deps) {
  const maintenant = deps.maintenant || Date.now;
  const fichier = path.join(deps.dossier, 'passeport_ed25519.pem');
  let K = null;
  /* La cle privee : lue, sinon creee une fois (0600). Elle ne sort jamais d'ici. */
  function cles() {
    if (K) return K;
    let priv;
    try { priv = crypto.createPrivateKey(fs.readFileSync(fichier, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const g = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(deps.dossier, { recursive: true });
      fs.writeFileSync(fichier, g.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      priv = g.privateKey;
    }
    const pub = crypto.createPublicKey(priv);
    const der = pub.export({ type: 'spki', format: 'der' });
    K = { priv, pub, keyId: crypto.createHash('sha256').update(der).digest('hex').slice(0, 16), pem: pub.export({ type: 'spki', format: 'pem' }), jwk: pub.export({ format: 'jwk' }) };
    return K;
  }

  /** Ce qui est publie : la cle publique et comment verifier. */
  function clePublique() {
    const k = cles();
    return { issuer: 'SWOGE', alg: 'Ed25519', keyId: k.keyId, publicKeyPem: k.pem, publicKeyJwk: k.jwk,
      howToVerify: 'The signature covers the canonical JSON of `passport` (object keys sorted at every level, no whitespace), as UTF-8. '
        + 'Verify it with this Ed25519 public key, e.g. in Node: crypto.verify(null, Buffer.from(canonical), publicKeyPem, Buffer.from(signature.value, "base64url")). '
        + 'Or POST the whole signed passport to ' + deps.api + '/agentic/passport/verify. A passport is a snapshot: check issuedAt and expiresAt.' };
  }

  /** Le passeport NON signe d'une cle, par son identifiant ; null si la cle n'existe pas. */
  function passeport(id) {
    const x = deps.cles.parId(id);
    if (!x) return null;
    const c = x.c, t = maintenant();
    const jour = new Date(t).toISOString().slice(0, 10);
    const credit = c.payeur === 'credit';
    const aud = deps.audit ? deps.audit(c.addr, x.id) : { lignes: [], chaine: { ok: true, lignes: 0 } };
    const lignes = aud.lignes || [];
    const tete = lignes[0] || null;                       /* audit() rend les plus recentes d'abord */
    const compte = (st) => lignes.filter((l) => l.statut === st).length;
    return {
      type: 'swoge.agent-passport', version: 1,
      agent: { id: x.id, name: c.nom, createdAt: new Date(c.cree).toISOString(), active: !c.revoquee, keyPrefix: c.debut },
      owner: { wallet: c.addr, proof: 'this API key was created by a session signed by this wallet on SWOGE; only that session can change or revoke it' },
      wallet: { paysFrom: credit ? 'dollar credit' : '$SWOGE',
        dailyCap: credit ? { usd: c.plafondUsd } : { swoge: c.plafondSwoge },
        spentToday: c.jour === jour ? (credit ? { usd: c.depenseUsd || 0 } : { swoge: c.depenseSwoge || 0 }) : (credit ? { usd: 0 } : { swoge: 0 }) },
      permissions: { readTools: true, buysSellsOrSigns: false, manageKeys: false,
        payOtherServices: c.paie && c.paie.actif ? { enabled: true, maxPerCallUsd: c.paie.maxAppelUsd, allowedSites: c.paie.hotes || [] } : { enabled: false } },
      history: {
        since: c.comptesDepuis ? new Date(c.comptesDepuis).toISOString() : null,
        toolCalls: c.appels || 0, billedUsd: c.usdTotal || 0,
        lastUsedAt: c.derniere ? new Date(c.derniere).toISOString() : null,
        gateway: { paid: compte('paye'), free: compte('gratuit'), refused: compte('refuse'), lost: compte('perte'),
          auditLines: lignes.length, head: tete ? { seq: tete.seq, h: tete.h } : null, chainIntact: !!(aud.chaine && aud.chaine.ok) },
      },
      public: !!c.passeportPublic,
      issuer: { name: 'SWOGE', url: deps.api, keyId: cles().keyId },
      issuedAt: new Date(t).toISOString(), expiresAt: new Date(t + DUREE_MS).toISOString(),
      links: { view: deps.site + '/agent_passport.html?id=' + x.id, verify: deps.api + '/agentic/passport/verify', publicKey: deps.api + '/.well-known/swoge-passport.json' },
    };
  }

  /** Le passeport signe : { passport, signature: { alg, keyId, value } }. */
  function signe(p) {
    const k = cles();
    return { passport: p, signature: { alg: 'Ed25519', keyId: k.keyId, value: crypto.sign(null, Buffer.from(canonique(p), 'utf8'), k.priv).toString('base64url') } };
  }

  /** Verifie un passeport signe : { ok, raison?, expire? }. N'importe qui peut le faire avec la cle publique ; ceci est la commodite. */
  function verifie(env) {
    try {
      if (!env || typeof env !== 'object' || !env.passport || !env.signature) return { ok: false, raison: 'send the whole signed passport: { passport, signature }' };
      const k = cles();
      if (env.signature.alg !== 'Ed25519' || env.signature.keyId !== k.keyId) return { ok: false, raison: 'not signed with the current SWOGE passport key (' + k.keyId + ')' };
      const bon = crypto.verify(null, Buffer.from(canonique(env.passport), 'utf8'), k.pub, Buffer.from(String(env.signature.value || ''), 'base64url'));
      if (!bon) return { ok: false, raison: 'the signature does not match: this passport was changed after SWOGE signed it' };
      const exp = Date.parse(env.passport.expiresAt);
      return { ok: true, expired: !(exp > maintenant()), agent: env.passport.agent && env.passport.agent.id, issuedAt: env.passport.issuedAt };
    } catch (e) { return { ok: false, raison: 'unreadable passport' }; }
  }

  return { passeport, signe, verifie, clePublique, canonique };
}

module.exports = { cree, canonique, DUREE_MS };
