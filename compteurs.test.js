'use strict';
/*
 * LES COMPTEURS DURABLES (compteurs.js) — ce qui doit tenir pour qu'un chiffre
 * de revenu soit croyable six mois plus tard :
 *   1. un compteur survit a l'instance : un redemarrage relit le jour en cours,
 *      et un demandeur deja vu n'est pas recompte ;
 *   2. un fichier par jour UTC : minuit tourne la page, l'ancien jour est ecrit ;
 *   3. les demandeurs distincts sont bornes par jour ET par evenement : au-dela
 *      on compte encore, et le nombre est marque approximatif ; un flot d'IP
 *      sans cle (X-Forwarded-For falsifiable) n'efface pas les payeurs ;
 *   4. nos propres adresses (maison) sont comptees a part, une IP jamais ;
 *   5. SIGTERM vide ce qui attend — seul, le signal tue encore le processus ;
 *      avec un autre ecouteur (server.js), c'est lui qui sort ;
 *   6. l'IP n'est JAMAIS ecrite, ni l'adresse d'un payeur : des empreintes ;
 *   7. ecriture differee, fichier illisible mis de cote, 400 jours gardes ;
 *   8. le resume public ne porte ni empreinte ni sous-compte.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const C = require('./compteurs');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + a + ' vs ' + b + ']');
const attends = (ms) => new Promise((r) => setTimeout(r, ms));

delete process.env.COMPTEURS_SEL;   /* le sel tire au premier demarrage (section 6) */
const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'compteurs-'));
const IP = '203.0.113.77';
const NOUS = '0x' + 'aa'.repeat(20), EUX = '0x' + 'bb'.repeat(20), AUTRE = '0x' + 'cc'.repeat(20);
const tout = (dossier) => fs.readdirSync(dossier).map((f) => fs.readFileSync(path.join(dossier, f), 'utf8')).join('\n');

(async () => {
  console.log('-- 1. un compteur survit a l instance --');
  {
    const d = path.join(racine, 'a');
    let t = Date.UTC(2026, 8, 26, 12, 0, 0);
    const A = C.cree({ dossier: d, maintenant: () => t, signaux: false, delaiMs: 60000, sel: 'essai' });
    A.note('devis', { outil: 'scan_token', canal: 'rest', qui: A.ip(IP) });
    A.note('paye_cle', { outil: 'scan_token', canal: 'mcp', qui: EUX, usd: 0.01 });
    ok(!fs.existsSync(path.join(d, '2026-09-26.json')), 'ecriture differee : rien sur le disque tout de suite');
    A.ferme();
    ok(fs.existsSync(path.join(d, '2026-09-26.json')), 'fermer vide ce qui attend');
    const B = C.cree({ dossier: d, maintenant: () => t, signaux: false, delaiMs: 60000, sel: 'essai' });
    B.note('paye_cle', { outil: 'scan_token', canal: 'rest', qui: EUX, usd: 0.01 });
    B.note('paye_cle', { outil: 'colony_activity', canal: 'rest', qui: AUTRE, usd: 0.005 });
    const v = B.vue(1).jours[0];
    eq(v.evenements.paye_cle.n, 3, 'la nouvelle instance repart des 1 + 2 paiements');
    eq(v.evenements.paye_cle.usd, 0.025, 'et des montants (0,01 + 0,01 + 0,005 $)');
    eq(v.evenements.paye_cle.distincts, 2, 'le meme payeur, avant et apres le redemarrage, compte UNE fois');
    eq(v.outils.scan_token.paye_cle.n, 2, 'par outil : scan_token paye 2 fois');
    eq(JSON.stringify(v.evenements.paye_cle.canaux), JSON.stringify({ mcp: 1, rest: 2 }), 'par canal');
    eq(v.evenements.devis.n, 1, 'le devis d avant le redemarrage est la');
    ok(B.note('inconnu', { outil: 'x' }) === false && !B.vue(1).jours[0].evenements.inconnu, 'un evenement inconnu est refuse, sans rien lever');
    B.ferme();
  }

  console.log('\n-- 2. un fichier par jour UTC --');
  {
    const d = path.join(racine, 'b');
    let t = Date.UTC(2026, 8, 26, 23, 59, 58);
    const K = C.cree({ dossier: d, maintenant: () => t, signaux: false, delaiMs: 60000, sel: 'essai' });
    K.note('demande402', { outil: 'scan_token', canal: 'rest', qui: K.ip(IP) });
    t += 5000;   /* 00:00:03 le 27 */
    K.note('demande402', { outil: 'scan_token', canal: 'rest', qui: K.ip(IP) });
    K.note('paye_x402', { outil: 'scan_token', canal: 'rest', qui: EUX, usd: 0.02 });
    ok(fs.existsSync(path.join(d, '2026-09-26.json')), 'minuit : la veille est ecrite en tournant la page');
    const v = K.vue(2);
    eq(v.jours.map((j) => j.jour).join(','), '2026-09-27,2026-09-26', 'deux jours, du plus recent au plus ancien');
    eq(v.jours[0].evenements.demande402.n + '/' + v.jours[1].evenements.demande402.n, '1/1', 'chaque jour son compte');
    eq(v.total.evenements.demande402.n, 2, 'le total de la periode additionne les jours');
    eq(v.total.evenements.demande402.distinctsMaxJour, 1, 'les distincts ne s additionnent pas d un jour a l autre');
    K.ferme();
    const lu = JSON.parse(fs.readFileSync(path.join(d, '2026-09-27.json'), 'utf8'));
    eq(lu.jour, '2026-09-27', 'le fichier du jour porte son jour');
  }

  console.log('\n-- 3. les distincts sont bornes --');
  {
    const d = path.join(racine, 'c');
    const K = C.cree({ dossier: d, signaux: false, delaiMs: 60000, sel: 'essai', distinctsMax: 5 });
    for (let i = 0; i < 8; i++) K.note('devis', { outil: 'scan_token', canal: 'rest', qui: K.ip('198.51.100.' + i) });
    const e = K.vue(1).jours[0].evenements.devis;
    ok(e.n === 8 && e.distincts === 5 && e.distinctsApprox === true, 'au-dela de la borne : 8 comptes, 5 distincts gardes, marque approximatif');
    K.ferme();
    const lu = JSON.parse(tout(d).split('\n').find((l) => l.startsWith('{')));
    eq(lu.evenements.devis.distincts.debordes, 3, 'le disque dit combien ont deborde');
  }

  console.log('\n-- 3 bis. un flot d IP ne vide pas le compte des payeurs --');
  {
    /* Releve du 26 septembre 2026 : 10 050 appels sans cle a X-Forwarded-For
       tournant, puis un vrai paiement → paye_x402 {distincts: 0, approx}. La
       borne de production (DISTINCTS_MAX), pas une borne d'essai. */
    const d = path.join(racine, 'c2');
    let t = Date.UTC(2026, 8, 26, 12, 0, 0);
    const K = C.cree({ dossier: d, maintenant: () => t, signaux: false, delaiMs: 60000, sel: 'essai' });
    const flot = C.DISTINCTS_MAX + 50;
    for (let i = 0; i < flot; i++) K.note('refus_sans_cle', { outil: 'ask_agent', canal: 'rest', qui: K.ip('10.' + (i >> 16) + '.' + ((i >> 8) & 255) + '.' + (i & 255)) });
    K.note('paye_x402', { outil: 'scan_token', canal: 'rest', qui: EUX, usd: 0.02 });
    let e = K.vue(1).jours[0].evenements;
    ok(e.refus_sans_cle.n === flot && e.refus_sans_cle.distincts === C.DISTINCTS_MAX && e.refus_sans_cle.distinctsApprox === true,
       'le flot : ' + flot + ' refus comptes, ' + C.DISTINCTS_MAX + ' distincts gardes, marque approximatif [' + e.refus_sans_cle.distincts + ']');
    ok(e.paye_x402.distincts === 1 && e.paye_x402.distinctsApprox === false, 'puis UN payeur verifie compte 1 distinct, exact [' + e.paye_x402.distincts + ', approx ' + e.paye_x402.distinctsApprox + ']');
    eq(K.publique(1).parJour[0].evenements.paye_x402.distincts, 1, 'et le resume public le dit');
    K.ferme();
    const K2 = C.cree({ dossier: d, maintenant: () => t, signaux: false, delaiMs: 60000, sel: 'essai' });
    K2.note('paye_x402', { outil: 'scan_token', canal: 'rest', qui: AUTRE, usd: 0.02 });
    K2.note('paye_x402', { outil: 'scan_token', canal: 'rest', qui: EUX, usd: 0.02 });
    e = K2.vue(1).jours[0].evenements;
    ok(e.paye_x402.distincts === 2 && e.paye_x402.distinctsApprox === false && e.refus_sans_cle.distincts === C.DISTINCTS_MAX,
       'apres un redemarrage sur le meme dossier : un payeur neuf compte encore, l ancien une seule fois [' + e.paye_x402.distincts + ']');
    K2.ferme();
  }

  console.log('\n-- 4. la maison a part --');
  {
    const d = path.join(racine, 'd');
    const K = C.cree({ dossier: d, signaux: false, delaiMs: 60000, sel: 'essai', maison: () => new Set([NOUS]) });
    K.note('paye_x402', { outil: 'scan_token', canal: 'rest', qui: NOUS.toUpperCase().replace('0X', '0x'), usd: 0.02, coutUsd: 0.007 });
    K.note('paye_x402', { outil: 'scan_token', canal: 'rest', qui: 'x402:' + NOUS, usd: 0.02 });
    K.note('paye_x402', { outil: 'scan_token', canal: 'rest', qui: EUX, usd: 0.03, coutUsd: 0.006 });
    K.note('devis', { outil: 'scan_token', canal: 'rest', qui: K.ip(IP) });
    const e = K.vue(1).jours[0].evenements;
    ok(e.paye_x402.maison.n === 2 && e.paye_x402.maison.usd === 0.04 && e.paye_x402.exterieur.n === 1 && e.paye_x402.exterieur.usd === 0.03,
       'nos adresses (casse ou prefixe x402: indifferents) comptent a la maison, les autres dehors');
    ok(e.paye_x402.coutN === 2 && e.paye_x402.coutUsd === 0.013 && e.paye_x402.usdAvecCout === 0.05, 'le cout ne se somme que sur les observations ou il est connu (2 sur 3)');
    eq(e.devis.exterieur.n, 1, 'une IP ne se reconnait pas : toujours dehors');
    K.ferme();
  }

  console.log('\n-- 5. SIGTERM vide ce qui attend --');
  {
    const lance = (d, avecAutre) => new Promise((res) => {
      const code = "const C = require(" + JSON.stringify(path.join(__dirname, 'compteurs')) + ");"
        + "const K = C.cree({ dossier: " + JSON.stringify(d) + ", delaiMs: 600000, sel: 'essai' });"
        + (avecAutre ? "process.on('SIGTERM', () => setTimeout(() => process.exit(7), 50));" : '')
        + "K.note('paye_cle', { outil: 'scan_token', canal: 'rest', qui: '" + EUX + "', usd: 0.01 });"
        + "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50); setTimeout(() => {}, 5000);";
      const p = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
      p.on('exit', (c, sig) => res({ c, sig }));
    });
    const d1 = path.join(racine, 'e1'), d2 = path.join(racine, 'e2');
    const seul = await lance(d1, false);
    const f1 = fs.existsSync(d1) ? fs.readdirSync(d1).find((f) => /\.json$/.test(f)) : null;
    ok(seul.sig === 'SIGTERM' && f1 && JSON.parse(fs.readFileSync(path.join(d1, f1), 'utf8')).evenements.paye_cle.n === 1,
       'seul ecouteur : le compte est ecrit, puis le signal tue le processus comme avant [' + seul.sig + ']');
    const avec = await lance(d2, true);
    const f2 = fs.existsSync(d2) ? fs.readdirSync(d2).find((f) => /\.json$/.test(f)) : null;
    ok(avec.c === 7 && f2 && JSON.parse(fs.readFileSync(path.join(d2, f2), 'utf8')).evenements.paye_cle.n === 1,
       'avec l arret du serveur : le compte est ecrit d abord, c est l autre ecouteur qui sort [code ' + avec.c + ']');
  }

  console.log('\n-- 6. ni IP ni adresse sur le disque --');
  {
    const d = path.join(racine, 'f');
    const K = C.cree({ dossier: d, signaux: false, delaiMs: 0 });
    K.note('refus_sans_cle', { outil: 'scan_token', canal: 'mcp', qui: K.ip(IP) });
    K.note('demande402', { outil: 'scan_token', canal: 'rest', qui: IP });   /* meme une IP passee brute par erreur */
    K.note('paye_x402', { outil: 'scan_token', canal: 'rest', qui: EUX, usd: 0.02 });
    const disque = tout(d);
    ok(!disque.includes(IP) && !disque.includes('203.0.113'), 'l IP de l essai n apparait dans AUCUN fichier du dossier (grep ' + IP + ')');
    ok(!disque.toLowerCase().includes(EUX.slice(2)), 'l adresse du payeur non plus : seulement des empreintes');
    ok(fs.existsSync(path.join(d, 'sel')) && (fs.statSync(path.join(d, 'sel')).mode & 0o077) === 0, 'le sel est tire au premier demarrage et garde, lisible du seul proprietaire');
    const K2 = C.cree({ dossier: d, signaux: false, delaiMs: 0 });
    eq(K2.ip(IP), K.ip(IP), 'le meme sel au redemarrage : une IP garde son empreinte (distincts coherents)');
    ok(/^ip:[0-9a-f]{16}$/.test(K.ip(IP)) && C.cree({ dossier: path.join(racine, 'f2'), signaux: false, sel: 'autre' }).ip(IP) !== K.ip(IP), 'empreinte tronquee a 16 caracteres, et salee (un autre sel, une autre empreinte)');
    K.ferme(); K2.ferme();
  }

  console.log('\n-- 7. ecriture differee, fichier illisible, 400 jours --');
  {
    const d = path.join(racine, 'g');
    fs.mkdirSync(d, { recursive: true });
    const t = Date.UTC(2026, 8, 26, 12, 0, 0);
    fs.writeFileSync(path.join(d, '2025-08-01.json'), '{}');       /* 421 jours avant */
    fs.writeFileSync(path.join(d, '2025-09-01.json'), '{}');       /* 390 jours avant */
    fs.writeFileSync(path.join(d, '2026-09-26.json'), '{pas du json');
    const K = C.cree({ dossier: d, maintenant: () => t, signaux: false, delaiMs: 80, sel: 'essai' });
    K.note('echec', { outil: 'scan_token', canal: 'rest', sorte: 'outil' });
    ok(!fs.existsSync(path.join(d, '2025-08-01.json')) && fs.existsSync(path.join(d, '2025-09-01.json')), 'au-dela de 400 jours : efface ; en deca : garde');
    ok(fs.readdirSync(d).some((f) => /^2026-09-26\.json\.illisible\./.test(f)), 'un fichier illisible est mis de cote, jamais ecrase');
    ok(!fs.existsSync(path.join(d, '2026-09-26.json')), 'rien d ecrit avant le delai');
    await attends(300);
    ok(fs.existsSync(path.join(d, '2026-09-26.json')) && JSON.parse(fs.readFileSync(path.join(d, '2026-09-26.json'), 'utf8')).evenements.echec.n === 1, 'ecrit apres le delai (ici 80 ms ; 5 s en production)');
    eq(C.DELAI_MS, 5000, 'le delai de production : 5 s au plus entre un compte et le disque');
    K.ferme();
  }

  console.log('\n-- 8. le resume public --');
  {
    const d = path.join(racine, 'h');
    const K = C.cree({ dossier: d, signaux: false, delaiMs: 0, sel: 'essai', maison: () => new Set([NOUS]) });
    K.note('echec', { outil: 'scan_token', canal: 'rest', qui: K.ip(IP), sorte: 'paiement_refuse:invalid_payload' });
    K.note('image_facturee', { outil: 'generate_image', canal: 'studio', qui: NOUS, usd: 0.3, coutUsd: 0.2, sorte: 'grok/qualite' });
    const p = K.publique(30);
    const texte = JSON.stringify(p);
    const empreintes = JSON.parse(tout(d).split('\n').find((l) => l.startsWith('{'))).evenements.echec.distincts.h;
    ok(empreintes.length === 1 && !texte.includes(empreintes[0]) && !texte.includes(IP) && !texte.toLowerCase().includes(NOUS.slice(2)), 'aucune empreinte, aucune IP, aucune adresse dans le resume public');
    ok(!/sortes|paiement_refuse/.test(texte), 'ni les sous-comptes');
    ok(p.parJour[0].evenements.echec.n === 1 && p.total.image_facturee.coutUsd === 0.2 && p.total.image_facturee.usdAvecCout === 0.3 && p.outils.generate_image.image_facturee.maison.n === 1,
       'mais les nombres : par jour, sur la periode, par outil, cout contre facture');
    ok(/do not add them up/.test(p.note), 'et la regle de lecture (les facturations recoupent les paiements)');
    K.ferme();
  }

  fs.rmSync(racine, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
