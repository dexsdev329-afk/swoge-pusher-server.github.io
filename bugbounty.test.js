'use strict';
/* BUG BOUNTY + OSINT — ce qui se verifie sans reseau.
 *
 * Le coeur sensible : la GARDE D'AUTORISATION. Trois chemins — dans le scope
 * d'un programme, attestation cochee (texte exact, journalisee), ou REFUS. Une
 * case ne debloque que de la recon en LECTURE SEULE ; l'outil ne contient
 * aucune action intrusive, et la recon ne s'execute pas sans autorisation.
 *
 * Puis le pre-audit statique : precision avant rappel, quatre classes, jamais
 * un verdict.
 *
 * Intention (a tenir si un changement contredit l'essai) : jamais de recon
 * sans autorisation ; l'attestation exige le texte exact et est journalisee ;
 * le pre-audit ne conclut pas a la place d'un humain.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const bb = require('./bugbounty');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

console.log('-- 1. le type de cible --');
ok(bb.typeCible('0x1111111111111111111111111111111111111111').type === 'evm', 'une adresse EVM est reconnue');
ok(bb.typeCible('7G9LhhhNvhVLxCTdEqZCf7mj8iXweLgQnmJjghskWMZG').type === 'svm', 'une adresse Solana est reconnue');
ok(bb.typeCible('https://sub.Example.com/path').v === 'sub.example.com', 'un domaine est normalise (sans schema ni chemin, minuscules)');
ok(bb.typeCible('pas une cible').type === 'inconnu', 'le reste est inconnu');

console.log('\n-- 2. le scope --');
ok(bb.couvre('*.example.com', 'api.example.com') && bb.couvre('example.com', 'api.example.com'), 'un wildcard et un domaine de base couvrent un sous-domaine');
ok(!bb.couvre('example.com', 'notexample.com'), 'mais pas un domaine qui finit pareil sans etre un sous-domaine');
ok(bb.couvre('0xAbC0000000000000000000000000000000000001', '0xabc0000000000000000000000000000000000001'), 'une adresse EVM, insensible a la casse');

console.log('\n-- 3. LA GARDE D AUTORISATION --');
let a = bb.autorisation({ cible: 'api.example.com', programme: { nom: 'ACME', scope: ['*.example.com'] } });
ok(a.ok && a.mode === 'program', 'dans le scope d un programme : autorise (mode program)');
a = bb.autorisation({ cible: 'evil.com', programme: { nom: 'ACME', scope: ['*.example.com'] } });
ok(!a.ok && /NOT in the program scope/.test(a.raison), 'hors scope du programme : REFUS');
a = bb.autorisation({ cible: 'mine.com' });
ok(!a.ok && /tick the authorization box/.test(a.raison), 'ni programme ni attestation : REFUS, et on dit qu il faut cocher');
a = bb.autorisation({ cible: 'mine.com', attestation: { autorise: true, texte: 'je suis au courant' } });
ok(!a.ok && /attestation text does not match/.test(a.raison), 'une case au mauvais texte (« je suis au courant ») NE suffit pas : il faut le texte d AUTORISATION exact');
a = bb.autorisation({ cible: 'mine.com', attestation: { autorise: true, texte: bb.ATTESTATION_TEXTE, qui: 'enzo' } });
ok(a.ok && a.mode === 'attested' && a.journal && a.journal.cible === 'mine.com' && /does not grant permission/.test(a.avertissement),
   'attestation au texte exact : autorise (mode attested), journal pret, et l avertissement dit que ca ne cree aucun droit');
ok(/authorized to assess/.test(bb.ATTESTATION_TEXTE) && /written permission/.test(bb.ATTESTATION_TEXTE) && !/aware/.test(bb.ATTESTATION_TEXTE.replace('understand','')),
   'le texte de la case ATTESTE une autorisation (possession ou permission ecrite), pas un simple « au courant »');

console.log('\n-- 4. la journalisation de l attestation --');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
const f = bb.journaliseAttestation(a.journal, dir);
const lu = fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
ok(lu.length === 1 && lu[0].cible === 'mine.com' && lu[0].qui === 'enzo' && lu[0].texte === bb.ATTESTATION_TEXTE, 'l attestation est ecrite (cible, qui, texte) hors depot');

console.log('\n-- 5. la recon ne s execute QUE si autorisee --');
let appele = false;
const fauxOsint = { osint: async () => { appele = true; return { domaine: 'x' }; }, adresse: async () => { appele = true; return { adresse: 'x' }; } };
(async () => {
  let r = await bb.recon({ cible: 'mine.com' }, { osint: fauxOsint });
  ok(!r.ok && !appele, 'sans autorisation : la recon REFUSE et n appelle jamais l OSINT');
  r = await bb.recon({ cible: 'api.example.com', programme: { nom: 'ACME', scope: ['*.example.com'] } }, { osint: fauxOsint });
  ok(r.ok && appele && r.mode === 'program', 'dans le scope : la recon s execute (lecture seule, via osint.js)');
  appele = false;
  r = await bb.recon({ cible: '0x1111111111111111111111111111111111111111', attestation: { autorise: true, texte: bb.ATTESTATION_TEXTE } }, { osint: fauxOsint });
  ok(r.ok && appele && r.mode === 'attested', 'attestation cochee : la recon d une adresse passe par osint.adresse');

  console.log('\n-- 6. la veille classe les programmes --');
  const progs = [
    { nom: 'Petit', primeCritique: 5000, scope: ['petit.com'] },
    { nom: 'Gros', primeCritique: 200000, scope: ['gros.com'] },
    { nom: 'Nouveau', primeCritique: 1000, scope: ['neuf.com'] },
  ];
  const cl = bb.classeProgrammes(progs, ['Petit', 'Gros']);
  ok(cl[0].nom === 'Nouveau' && cl[0].nouveau, 'un programme jamais vu remonte en tete (nouveau)');
  ok(cl.find((p) => p.nom === 'Gros').fort && !cl.find((p) => p.nom === 'Petit').fort, 'une prime critique >= seuil est « forte »');

  console.log('\n-- 7. le pre-audit statique (precision avant rappel) --');
  const src = `
    contract T {
      address owner; mapping(address=>uint) balances;
      function setOwner(address a) public { owner = a; }                 // AC: public + sensible, sans garde
      function safeSet(address a) public onlyOwner { owner = a; }        // garde -> pas signale
      function withdraw() external {
        (bool ok,) = msg.sender.call{value: balances[msg.sender]}("");   // appel AVANT
        balances[msg.sender] = 0;                                        // ecriture APRES -> reentrance
      }
      function price() public view returns (uint) { return token.balanceOf(address(this)); } // oracle spot
      function share(uint a) public pure returns (uint) { return a / 100 * 3; }               // arrondi
    }`;
  const au = bb.preAudit(src);
  const classes = au.classes;
  ok(classes.includes('access-control'), 'controle d acces : setOwner public sans garde est signale');
  ok(!au.trouvailles.some((t) => t.extrait.includes('safeSet')), 'une fonction gardee (onlyOwner) n est PAS signalee — precision');
  ok(classes.includes('reentrancy'), 'reentrance : appel externe avant ecriture d etat est signale');
  ok(classes.includes('rounding'), 'arrondi : a / 100 * 3 est signale');
  ok(classes.includes('oracle'), 'oracle : balanceOf(address(this)) comme prix est signale');
  ok(/not a verdict/.test(au.note) && au.horsScope.includes('private-keys'), 'le pre-audit DIT que ce n est pas un verdict, et exclut le hors-code (cles, insiders, gouvernance)');

  console.log('\n-- 8. l exposition PASSIVE (Shodan InternetDB) --');
  ok(bb.typeCible('8.8.8.8').type === 'ip' && bb.typeCible('999.1.1.1').type !== 'ip', 'une IPv4 valide est reconnue, une invalide non');
  const fauxIDB = (rep) => async (u) => { fauxIDB.u = String(u); return rep; };
  let e = await bb.expositionIp('8.8.8.8', { fetch: fauxIDB({ ok: true, status: 200, json: async () => ({ ports: [80, 443], vulns: ['CVE-2021-1234'], cpes: ['cpe:/a:x'], hostnames: ['dns.google'] }) }) });
  ok(e.ok && e.ports.join() === '80,443' && e.vulns[0] === 'CVE-2021-1234' && /no packet sent/.test(e.source), 'une IP connue : ports et CVE DEJA collectes (aucun paquet envoye a la cible)');
  ok(/internetdb\.shodan\.io\/8\.8\.8\.8/.test(fauxIDB.u), 'l appel vise bien InternetDB (lecture seule)');
  e = await bb.expositionIp('10.0.0.1', { fetch: fauxIDB({ status: 404, ok: false, json: async () => ({}) }) });
  ok(e.ok && e.ports.length === 0 && /knows nothing/.test(e.note), 'une IP inconnue d InternetDB : vide, et on le dit (pas une erreur)');
  e = await bb.expositionIp('pas-une-ip', {});
  ok(!e.ok && /not an IPv4/.test(e.raison), 'ce qui n est pas une IPv4 est refuse sans reseau');

  console.log('\n-- 9. le TYPE d appareil, deduit du passif --');
  ok(bb.classeAppareil({ ports: [80, 443], cpes: ['cpe:/a:nginx:nginx'], hostnames: ['www.site.com'] }).type === 'website / web server', 'ports 80/443 + nginx + www → site web');
  ok(bb.classeAppareil({ ports: [7547, 53], hostnames: ['gateway.isp.net'], tags: ['router'] }).type === 'router / gateway', 'port 7547 + tag router + hostname gateway → routeur');
  ok(bb.classeAppareil({ ports: [25, 587, 993], hostnames: ['mail.site.com'] }).type === 'mail server', 'ports mail + mx hostname → serveur mail');
  ok(bb.classeAppareil({ ports: [22], cpes: ['cpe:/o:canonical:ubuntu_linux'] }).type === 'remote access / PC / server', 'SSH + Ubuntu → PC/serveur');
  const cam = bb.classeAppareil({ ports: [554], cpes: ['cpe:/a:hikvision:webcam'], tags: ['webcam'] });
  ok(cam.type === 'camera / IoT device' && cam.confidence === 'high' && cam.evidence.length >= 2, 'RTSP + hikvision + tag webcam → camera/IoT, confiance haute, preuves listees');
  const nat = bb.classeAppareil({ ports: [], cpes: [], hostnames: [] });
  ok(/behind NAT/.test(nat.type) && nat.confidence === 'low', 'aucun port public → appareil grand public derriere NAT (telephone/PC), confiance basse');
  ok((bb.expositionIpDevice = (await bb.expositionIp('8.8.8.8', { fetch: fauxIDB({ ok: true, status: 200, json: async () => ({ ports: [443], cpes: ['nginx'], hostnames: ['dns.google'] }) }) })).device) && bb.expositionIpDevice.type,
     'expositionIp rend desormais un champ device avec le type estime');

  console.log('\n-- 10. d autres sources passives (CertSpotter, urlscan, OSV) --');
  const rep = (o) => async () => ({ ok: true, status: 200, json: async () => o });
  let s = await bb.sousDomaines('example.com', { fetch: rep([{ dns_names: ['a.example.com', '*.example.com', 'autre.net'] }]) });
  ok(s.ok && s.sousDomaines.includes('a.example.com') && !s.sousDomaines.includes('autre.net'), 'CertSpotter : sous-domaines du domaine seulement (wildcard deplie, hors-domaine ecarte)');
  s = await bb.sousDomaines('pas un domaine', {});
  ok(!s.ok, 'un non-domaine est refuse sans reseau');
  let sc = await bb.scansConnus('example.com', { fetch: rep({ results: [{ page: { url: 'https://example.com/a', ip: '1.2.3.4', server: 'nginx' }, task: { time: 't' } }] }) });
  ok(sc.ok && sc.scans[0].url === 'https://example.com/a' && /search only/.test(sc.source), 'urlscan : scans publics deja faits (search only, jamais submit)');
  let v = await bb.vulnsPaquet({ ecosystem: 'npm', name: 'lodash', version: '4.17.0' }, { fetch: rep({ vulns: [{ id: 'GHSA-xxxx', summary: 'proto pollution', aliases: ['CVE-2020-8203'] }] }) });
  ok(v.ok && v.vulns[0].id === 'GHSA-xxxx' && v.vulns[0].alias[0] === 'CVE-2020-8203', 'OSV : vulnerabilites d une dependance (npm lodash), avec alias CVE');
  v = await bb.vulnsPaquet({ name: 'x' }, {});
  ok(!v.ok && /ecosystem/.test(v.raison), 'OSV sans ecosystem : refuse proprement, sans reseau');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})();
