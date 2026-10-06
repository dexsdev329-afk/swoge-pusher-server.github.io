'use strict';
/*
 * LE VERROU BIOMÉTRIQUE (wallet_passkey.js) — on verifie NOTRE orchestration :
 *   1. un defi est pose, a usage UNIQUE, et expire ;
 *   2. l'inscription rend la carte de cle a stocker, publicKey en base64url ;
 *   3. le deverrouillage passe la cle stockee a la verification, decodee ;
 *   4. sans defi, sans cle, ou si la bibliotheque dit « non verifie » : ca jette.
 * La crypto WebAuthn elle-meme est couverte en amont par @simplewebauthn ; ici
 * on l'injecte (faux) pour juger ce qu'on a ecrit. Un dernier essai confirme
 * que la vraie bibliotheque ESM se charge bien (import dynamique, Node 18+).
 */
const P = require('./wallet_passkey');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const ADR = '0x' + 'a'.repeat(40);
const RP = 'swoleeswoge.dog', ORIG = 'https://swoleeswoge.dog';

(async () => {
  /* Un faux @simplewebauthn qui capte ce qu'on lui passe et rend du prevu. */
  let vu = {};
  const faux = {
    generateRegistrationOptions: async (o) => { vu.reg = o; return { challenge: 'defiR', rp: { id: o.rpID }, exclude: o.excludeCredentials }; },
    verifyRegistrationResponse: async (o) => { vu.verifReg = o; return { verified: true, registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3, 250]), counter: 0, transports: ['internal'] } } }; },
    generateAuthenticationOptions: async (o) => { vu.auth = o; return { challenge: 'defiA', allow: o.allowCredentials }; },
    verifyAuthenticationResponse: async (o) => { vu.verifAuth = o; return { verified: true, authenticationInfo: { newCounter: 7 } }; },
  };
  P._setLib(faux);

  console.log('-- 1. inscription : defi pose, options formees, cle rendue en base64url --');
  {
    const o = await P.optionsInscription({ addr: ADR, rpId: RP, nom: 'me', existantes: [{ id: 'old', transports: ['internal'] }] });
    ok(o.challenge === 'defiR' && vu.reg.rpID === RP && vu.reg.authenticatorSelection.userVerification === 'required', 'options : rpID et userVerification=required (la biometrie est exigee)');
    ok(vu.reg.authenticatorSelection.authenticatorAttachment === 'platform' && vu.reg.attestationType === 'none', 'platform (Face ID), attestation none (on ne trace pas l appareil)');
    ok(JSON.stringify(vu.reg.excludeCredentials) === JSON.stringify([{ id: 'old', transports: ['internal'] }]), 'les cles deja posees sont exclues (pas de doublon)');

    const cle = await P.verifieInscription({ addr: ADR, reponse: { foo: 1 }, rpId: RP, origin: ORIG });
    ok(vu.verifReg.expectedChallenge === 'defiR' && vu.verifReg.expectedRPID === RP && vu.verifReg.expectedOrigin === ORIG && vu.verifReg.requireUserVerification === true, 'la verification recoit le defi pose, le bon RP/origin, et exige la biometrie');
    ok(cle.id === 'cred-1' && cle.publicKey === Buffer.from([1, 2, 3, 250]).toString('base64url') && cle.counter === 0, 'la carte a stocker : id, publicKey en base64url, compteur');
    ok(Buffer.from(cle.publicKey, 'base64url').equals(Buffer.from([1, 2, 3, 250])), 'la publicKey se redecode a l identique (round-trip)');
  }

  console.log('\n-- 2. le defi est a USAGE UNIQUE, et il expire --');
  {
    P.poseDefi(ADR, 'x1');
    ok(P.prendDefi(ADR) === 'x1' && P.prendDefi(ADR) === null, 'un defi pris une fois ne se reprend pas (anti-rejeu)');
    P._defis.set(ADR.toLowerCase(), { defi: 'vieux', exp: Date.now() - 1 });
    ok(P.prendDefi(ADR) === null, 'un defi expire ne vaut rien');
  }

  console.log('\n-- 3. deverrouillage : la cle stockee est passee, decodee --');
  {
    const existantes = [{ id: 'cred-1', transports: ['internal'] }];
    const o = await P.optionsAuth({ addr: ADR, rpId: RP, existantes });
    ok(o.challenge === 'defiA' && JSON.stringify(vu.auth.allowCredentials) === JSON.stringify(existantes) && vu.auth.userVerification === 'required', 'options d auth : seules les cles de cette adresse, biometrie exigee');
    const credit = { id: 'cred-1', publicKey: Buffer.from([9, 9, 9]).toString('base64url'), counter: 3, transports: ['internal'] };
    const r = await P.verifieAuth({ addr: ADR, reponse: { bar: 1 }, rpId: RP, origin: ORIG, credit });
    ok(vu.verifAuth.expectedChallenge === 'defiA' && vu.verifAuth.credential.id === 'cred-1' && Buffer.from(vu.verifAuth.credential.publicKey).equals(Buffer.from([9, 9, 9])) && vu.verifAuth.credential.counter === 3, 'la verification recoit la cle stockee, publicKey redecodee, compteur');
    ok(r.newCounter === 7, 'le nouveau compteur anti-rejeu est rendu (a persister)');
  }

  console.log('\n-- 4. fail-closed --');
  {
    let j1 = false; try { await P.verifieInscription({ addr: ADR, reponse: {}, rpId: RP, origin: ORIG }); } catch (e) { j1 = /challenge/.test(e.message); }
    ok(j1, 'inscription sans defi en cours : rejet (pas de verification a l aveugle)');
    let j2 = false; try { await P.verifieAuth({ addr: ADR, reponse: {}, rpId: RP, origin: ORIG, credit: null }); } catch (e) { j2 = /challenge|credential/.test(e.message); }
    ok(j2, 'deverrouillage sans defi : rejet');
    P.poseDefi(ADR, 'd'); let j3 = false; try { await P.verifieAuth({ addr: ADR, reponse: {}, rpId: RP, origin: ORIG, credit: null }); } catch (e) { j3 = /credential/.test(e.message); }
    ok(j3, 'deverrouillage sans cle connue : rejet');
    const fauxNon = Object.assign({}, faux, { verifyAuthenticationResponse: async () => ({ verified: false }) });
    P._setLib(fauxNon); P.poseDefi(ADR, 'd2');
    let j4 = false; try { await P.verifieAuth({ addr: ADR, reponse: {}, rpId: RP, origin: ORIG, credit: { id: 'c', publicKey: Buffer.from([1]).toString('base64url'), counter: 0 } }); } catch (e) { j4 = /not verified/.test(e.message); }
    ok(j4, 'la bibliotheque dit « non verifie » : rejet');
    P._setLib(faux);
  }

  console.log('\n-- 5. la VRAIE bibliotheque ESM se charge (import dynamique, Node 18+) --');
  {
    P._setLib(null);
    const L = await import('@simplewebauthn/server');
    ok(typeof L.generateRegistrationOptions === 'function' && typeof L.verifyAuthenticationResponse === 'function', '@simplewebauthn/server est la, avec ses fonctions');
    P._setLib(faux);
  }

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
