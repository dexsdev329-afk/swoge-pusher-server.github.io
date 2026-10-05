'use strict';
/* ==================================================================
 * LE SQUELETTE INERTE DE 8c — l'executeur reel refuse tant qu'on ne lui a pas
 * tout donne (drapeau + cle dediee + jeton d'essai + envoyeur cable).
 * ==================================================================
 *
 * Intention : prouver que le seul module qui POURRAIT depenser de la vraie crypto
 * reste INERTE par defaut, et qu'il ne signe/n'envoie RIEN tant que les quatre
 * verrous ne sont pas alignes. Le chemin vert (tout pose, envoyeur injecte) existe
 * pour prouver que la structure marche QUAND le proprietaire aura tout provisionne —
 * mais ici l'envoyeur est un FAUX, aucune chaine n'est touchee.
 * ================================================================== */

const ex = require('./executeur_reel');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* Un jeton d'essai et un pool valides (adresses 0x). */
const JETON = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const AUTRE = '0x3333333333333333333333333333333333333333';
const approuveBuyback = () => ({ token: JETON, action: 'buyback', montantUsd: 5, pool: POOL, impactMaxPct: 1 });

/* Un devis reel simule : bon pool, impact sous le plafond. */
const devisOk = async (a) => ({ ok: true, pool: a.pool, impactPct: 0.5, sortie: 123 });
/* Un envoyeur reel FACTICE : il NE touche aucune chaine ; il note juste qu'il a ete appele. */
function fauxEnvoyeur() {
  const appels = [];
  const envoie = async (a, extra) => { appels.push({ a, extra }); return { ok: true, txHash: '0xdeadbeef' }; };
  return { envoie, appels };
}

(async () => {
  console.log('-- inerte par defaut : ni drapeau, ni cle --');
  {
    const e = ex.cree({ execute: false, cle: '', jetonsTest: [JETON] });
    ok(e.actif() === false, 'actif() est faux sans drapeau ni cle');
    ok(/real execution disabled/.test(e.raisonInerte() || ''), 'la raison nomme le drapeau manquant');
    const env = fauxEnvoyeur();
    const r = await e.execute(approuveBuyback(), { devis: devisOk, envoie: env.envoie });
    ok(r.execute === false, 'execute refuse (inerte)');
    ok(env.appels.length === 0, 'l envoyeur reel n a JAMAIS ete appele');
  }

  console.log('\n-- drapeau sans cle : toujours inerte --');
  {
    const e = ex.cree({ execute: true, cle: '', jetonsTest: [JETON] });
    ok(e.actif() === false, 'actif() est faux : le drapeau seul ne suffit pas');
    ok(/no dedicated signing key/.test(e.raisonInerte() || ''), 'la raison nomme la cle dediee manquante');
    const env = fauxEnvoyeur();
    const r = await e.execute(approuveBuyback(), { devis: devisOk, envoie: env.envoie });
    ok(r.execute === false && env.appels.length === 0, 'refuse sans cle, l envoyeur jamais appele');
  }

  console.log('\n-- cle sans drapeau : toujours inerte --');
  {
    const e = ex.cree({ execute: false, cle: '0xPRIVATEKEY', jetonsTest: [JETON] });
    ok(e.actif() === false, 'actif() est faux : la cle seule ne suffit pas');
    const env = fauxEnvoyeur();
    const r = await e.execute(approuveBuyback(), { devis: devisOk, envoie: env.envoie });
    ok(r.execute === false && env.appels.length === 0, 'refuse sans drapeau, l envoyeur jamais appele');
  }

  console.log('\n-- drapeau + cle, mais action != buyback : refuse (rachat-et-brule seulement) --');
  {
    const e = ex.cree({ execute: true, cle: '0xPRIVATEKEY', jetonsTest: [JETON] });
    ok(e.actif() === true, 'actif() est vrai : drapeau + cle poses');
    const env = fauxEnvoyeur();
    for (const action of ['sell', 'airdrop', 'swap', 'transfer']) {
      const r = await e.execute({ token: JETON, action, montantUsd: 5, pool: POOL, impactMaxPct: 1 }, { devis: devisOk, envoie: env.envoie });
      ok(r.execute === false && /buy-back-and-burn only/.test(r.raison), 'action « ' + action + " » refusee en reel");
    }
    ok(env.appels.length === 0, 'aucune action non-buyback n atteint l envoyeur');
  }

  console.log('\n-- drapeau + cle + buyback, mais jeton HORS liste d essai : refuse --');
  {
    const e = ex.cree({ execute: true, cle: '0xPRIVATEKEY', jetonsTest: [JETON] });
    const env = fauxEnvoyeur();
    const r = await e.execute({ token: AUTRE, action: 'buyback', montantUsd: 5, pool: POOL, impactMaxPct: 1 }, { devis: devisOk, envoie: env.envoie });
    ok(r.execute === false && /test allowlist/.test(r.raison), 'un jeton non nomme est refuse');
    ok(env.appels.length === 0, 'un jeton hors liste n atteint pas l envoyeur');
  }

  console.log('\n-- liste d essai VIDE : rien ne passe, meme drapeau + cle --');
  {
    const e = ex.cree({ execute: true, cle: '0xPRIVATEKEY', jetonsTest: [] });
    ok(e.jetonsTest.size === 0, 'la liste d essai est vide (fail-closed : nommer le jeton d abord)');
    const env = fauxEnvoyeur();
    const r = await e.execute(approuveBuyback(), { devis: devisOk, envoie: env.envoie });
    ok(r.execute === false && env.appels.length === 0, 'aucun jeton ne passe sans liste, l envoyeur jamais appele');
  }

  console.log('\n-- tout aligne MAIS envoyeur non cable : refuse (en attente du feu vert) --');
  {
    const e = ex.cree({ execute: true, cle: '0xPRIVATEKEY', jetonsTest: [JETON] });
    const r = await e.execute(approuveBuyback(), { devis: devisOk });   /* pas de deps.envoie */
    ok(r.execute === false && /no real on-chain sender wired/.test(r.raison), 'sans envoyeur reel cable, on refuse');
  }

  console.log('\n-- garde-fous du signer repris : pool qui ne correspond pas / impact trop fort --');
  {
    const e = ex.cree({ execute: true, cle: '0xPRIVATEKEY', jetonsTest: [JETON] });
    const env = fauxEnvoyeur();
    const devisAutrePool = async () => ({ ok: true, pool: AUTRE, impactPct: 0.5, sortie: 1 });
    const r1 = await e.execute(approuveBuyback(), { devis: devisAutrePool, envoie: env.envoie });
    ok(r1.execute === false && /pool mismatch/.test(r1.raison), 'un devis qui vise un autre pool est refuse');
    const devisGrosImpact = async (a) => ({ ok: true, pool: a.pool, impactPct: 9, sortie: 1 });
    const r2 = await e.execute(approuveBuyback(), { devis: devisGrosImpact, envoie: env.envoie });
    ok(r2.execute === false && /impact exceeds the approved ceiling/.test(r2.raison), 'un impact live au-dela du plafond est refuse');
    const devisEchoue = async () => { throw new Error('rpc down'); };
    const r3 = await e.execute(approuveBuyback(), { devis: devisEchoue, envoie: env.envoie });
    ok(r3.execute === false && /simulation failed/.test(r3.raison), 'un devis qui echoue => pas d envoi');
    ok(env.appels.length === 0, 'aucun de ces refus n atteint l envoyeur');
  }

  console.log('\n-- le CHEMIN VERT : tout pose + envoyeur injecte => la structure marche (aucune vraie chaine) --');
  {
    const e = ex.cree({ execute: true, cle: '0xPRIVATEKEY', jetonsTest: [JETON] });
    const env = fauxEnvoyeur();
    const r = await e.execute(approuveBuyback(), { devis: devisOk, envoie: env.envoie });
    ok(r.execute === true && r.mode === 'real', 'execute reussit quand tout est provisionne');
    ok(env.appels.length === 1, 'l envoyeur est appele EXACTEMENT une fois');
    ok(bas(env.appels[0].a.token) === bas(JETON) && bas(env.appels[0].a.pool) === bas(POOL) && env.appels[0].a.action === 'buyback',
       'l envoyeur recoit le jeton, le pool et l action buyback approuves (jamais une adresse d un message)');
    ok(r.recu && r.recu.txHash === '0xdeadbeef' && r.recu.action === 'buyback', 'le recu porte le hash de transaction et l action buyback');
  }

  console.log('\n-- isolation de la cle : le module ne lit JAMAIS MIROIR_CLE, et ne renvoie jamais la cle --');
  {
    const AV_MC = process.env.MIROIR_CLE, AV_AC = process.env.AGENT_CLE, AV_FL = process.env.AGENT_TRADER_EXECUTE, AV_TK = process.env.AGENT_TRADER_TOKEN_TEST;
    process.env.MIROIR_CLE = '0xMIROIR_la_bourse_des_joueurs';   /* presente, mais ne doit RIEN activer ici */
    delete process.env.AGENT_CLE; delete process.env.AGENT_TRADER_EXECUTE; delete process.env.AGENT_TRADER_TOKEN_TEST;
    const e = ex.cree({});   /* defauts d environnement : AGENT_CLE absente => inerte, meme si MIROIR_CLE est posee */
    ok(e.actif() === false, 'MIROIR_CLE posee ne rend PAS l executeur actif (cle isolee)');
    const vu = JSON.stringify(e);
    ok(!/MIROIR|PRIVATEKEY|0xMIROIR/.test(vu), 'l objet rendu ne contient aucune cle (ni AGENT_CLE ni MIROIR_CLE)');
    /* on restitue l environnement */
    if (AV_MC === undefined) delete process.env.MIROIR_CLE; else process.env.MIROIR_CLE = AV_MC;
    if (AV_AC === undefined) delete process.env.AGENT_CLE; else process.env.AGENT_CLE = AV_AC;
    if (AV_FL === undefined) delete process.env.AGENT_TRADER_EXECUTE; else process.env.AGENT_TRADER_EXECUTE = AV_FL;
    if (AV_TK === undefined) delete process.env.AGENT_TRADER_TOKEN_TEST; else process.env.AGENT_TRADER_TOKEN_TEST = AV_TK;
  }

  console.log('\n-- construction par defaut (environnement nu) : inerte --');
  {
    const AV_AC = process.env.AGENT_CLE, AV_FL = process.env.AGENT_TRADER_EXECUTE;
    delete process.env.AGENT_CLE; delete process.env.AGENT_TRADER_EXECUTE;
    const e = ex.cree();
    ok(e.actif() === false, 'sans aucune variable, l executeur est inerte');
    if (AV_AC === undefined) delete process.env.AGENT_CLE; else process.env.AGENT_CLE = AV_AC;
    if (AV_FL === undefined) delete process.env.AGENT_TRADER_EXECUTE; else process.env.AGENT_TRADER_EXECUTE = AV_FL;
  }

  console.log('\n-- listeJetons : n accepte que des adresses 0x, en minuscules, dedupliquees --');
  {
    const l = ex.listeJetons('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA, pas-une-adresse, 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    ok(l.size === 1 && l.has('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), 'doublon (casse) fusionne, non-adresse ignoree');
  }

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})();

function bas(a) { return String(a).toLowerCase(); }
