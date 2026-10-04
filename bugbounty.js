'use strict';
/* ==========================================================================
 * SWOGE BUG BOUNTY — la veille, la recon et le PRE-AUDIT, fusionnes a l'OSINT
 * ==========================================================================
 *
 * Demande du proprietaire (04/10) : un logiciel IA de bug bounty, fusionne
 * avec l'OSINT ; et « rajoute des [cibles] pas autorisees, mais l'utilisateur
 * doit cocher une case pour dire qu'il est au courant ».
 *
 * LA LIGNE QUI TIENT TOUT — et pourquoi une case ne suffit pas a elle seule :
 *
 *   Une case ne rend PAS un test legal. Elle ATTESTE que l'utilisateur a le
 *   droit : une cible qu'il POSSEDE, ou pour laquelle il a une autorisation
 *   ECRITE. On enregistre donc une ATTESTATION D'AUTORISATION (horodatee,
 *   journalisee), pas un simple « je suis au courant ». Et quoi qu'elle dise,
 *   l'outil reste en LECTURE SEULE : OSINT public, lecture de contrat on-chain,
 *   analyse statique d'une source fournie. JAMAIS d'intrusion active, d'attaque
 *   d'identifiants, de deni de service, ni d'exploitation. Aucune case ne
 *   debloque ca — ce fichier n'en contient pas le code.
 *
 * Deux facons d'etre autorise :
 *   1. PROGRAMME : la cible est dans le scope d'un programme de bug bounty
 *      connu (HackerOne, Immunefi, Arc…). On verifie l'appartenance au scope.
 *   2. ATTESTATION : l'utilisateur coche la case d'autorisation. On exige le
 *      texte exact, on journalise (qui, quand, quelle cible), et on previent
 *      que l'attestation ne cree aucun droit et que la responsabilite est a lui.
 *
 * La recon s'appuie sur osint.js (qui respecte deja robots.txt, s'annonce sous
 * UA, traite un 403 comme un refus, et n'interroge aucune base fuitee). Le
 * pre-audit lit une SOURCE fournie et cherche, avec precision avant rappel,
 * quatre classes de failles (recherche du 04/10 : 77,5 % des primes Immunefi
 * sont sur le smart contract ; viser peu de trouvailles sures, chacune a
 * verifier par un humain — jamais un verdict).
 * ======================================================================== */

const fs = require('fs');
const path = require('path');

/* Le texte EXACT de la case. Il atteste une AUTORISATION, pas une prise de
   connaissance. Le changer invaliderait les attestations deja signees : c'est
   voulu. */
const ATTESTATION_TEXTE =
  'I confirm I am authorized to assess this target: I own it, or I have written permission. '
  + 'I understand this attestation does not grant permission, that only non-intrusive reconnaissance and '
  + 'code review are performed, and that I am solely responsible for having the right to run it.';

/* Au-dessus de ce montant de prime critique, un programme est « fort » et
   remonte en tete de la veille. Reglable. */
const PRIME_FORTE = Number(process.env.BB_PRIME_FORTE || 50000);

/* --------------------------------------------------------------- le scope */

/* Une cible EVM : 0x + 40 hexa. Une cible Solana : base58 32-44. Sinon, un
   domaine (on normalise en minuscules, sans schema ni chemin). */
function typeCible(c) {
  c = String(c || '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(c)) return { type: 'evm', v: c.toLowerCase() };
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(c) && c.split('.').every((o) => Number(o) <= 255)) return { type: 'ip', v: c };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c) && !/^0x/.test(c)) return { type: 'svm', v: c };
  const d = c.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { type: 'domaine', v: d };
  return { type: 'inconnu', v: c };
}

/* Une entree de scope couvre-t-elle la cible ? Domaine exact, sous-domaine via
   `*.exemple.com` ou `exemple.com` (qui couvre ses sous-domaines), ou adresse
   exacte (insensible a la casse pour l'EVM). */
function couvre(entree, cible) {
  const e = String(entree || '').trim();
  const t = typeCible(cible);
  if (t.type === 'evm') return e.toLowerCase() === t.v;
  if (t.type === 'ip') return e.trim() === t.v;
  if (t.type === 'svm') return e === t.v;
  if (t.type === 'domaine') {
    const base = e.replace(/^\*\./, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    return t.v === base || t.v.endsWith('.' + base);
  }
  return false;
}

function dansScope(cible, scope) {
  return Array.isArray(scope) && scope.some((e) => couvre(e, cible));
}

/* --------------------------------------------------- la garde d'autorisation */

/**
 * autorisation({ cible, programme?, attestation? }) :
 *   - programme : { nom, plateforme, scope:[...] } → verifie le scope.
 *   - attestation : { autorise:true, texte, qui?, quand? } → exige le texte exact.
 * Rend { ok, mode:'program'|'attested'|null, raison, journal? }.
 * JAMAIS d'action ici : on repond seulement « as-tu le droit ».
 */
function autorisation(o) {
  o = o || {};
  const t = typeCible(o.cible);
  if (t.type === 'inconnu') return { ok: false, mode: null, raison: 'target is not a domain, an EVM address or a Solana address' };

  if (o.programme && Array.isArray(o.programme.scope)) {
    if (dansScope(o.cible, o.programme.scope)) {
      return { ok: true, mode: 'program', raison: 'in scope of ' + (o.programme.nom || 'a program') };
    }
    return { ok: false, mode: null, raison: 'target is NOT in the program scope' };
  }

  if (o.attestation && o.attestation.autorise === true) {
    if (String(o.attestation.texte || '').trim() !== ATTESTATION_TEXTE) {
      return { ok: false, mode: null, raison: 'the authorization attestation text does not match — tick the exact box' };
    }
    const journal = { cible: t.v, type: t.type, qui: String(o.attestation.qui || 'unknown').slice(0, 120),
                      quand: o.attestation.quand || new Date().toISOString(), texte: ATTESTATION_TEXTE };
    return { ok: true, mode: 'attested', raison: 'user attested authorization (logged)', journal,
             avertissement: 'This attestation does not grant permission. Only non-intrusive recon and code review run. You are responsible.' };
  }

  return { ok: false, mode: null,
           raison: 'no authorization: target must be in a bug-bounty program scope, OR you must tick the authorization box' };
}

/* Journalise une attestation (hors depot, dans DATA_DIR). Best-effort : un
   disque plein n'empeche pas de refuser, mais on NE PROCEDE PAS si on voulait
   journaliser et qu'on ne peut pas (la trace fait partie de la garde). */
function journaliseAttestation(journal, dossier) {
  const dir = dossier || path.join(process.env.DATA_DIR || '.', 'bugbounty');
  const f = path.join(dir, 'attestations.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(f, JSON.stringify(journal) + '\n');
  return f;
}

/* ------------------------------------------------------------- la veille */

/* Classe une liste de programmes (donnee, lue ailleurs sous UA/robots) :
   marque « fort » au-dessus de PRIME_FORTE, « nouveau » si vu pour la premiere
   fois, et trie primes fortes et nouveautes en tete. On ne FETCHE rien ici :
   on classe ce qu'on nous passe, pour que ce soit testable et sans reseau. */
function classeProgrammes(programmes, connus) {
  const vus = new Set(connus || []);
  const out = (programmes || []).map((p) => {
    const critique = Number(p.primeCritique || p.primeMax || 0);
    return {
      nom: p.nom, plateforme: p.plateforme || null, scope: p.scope || [],
      primeCritique: critique || null,
      fort: critique >= PRIME_FORTE,
      nouveau: !!(p.nom && !vus.has(p.nom)),
      url: p.url || null, maj: p.maj || null,
    };
  });
  out.sort((a, b) => (b.nouveau - a.nouveau) || (b.fort - a.fort) || ((b.primeCritique || 0) - (a.primeCritique || 0)));
  return out;
}

/* ------------------------------------------------------------- la recon */

/* La recon n'agit QUE si l'autorisation est accordee. Elle delegue a osint.js
   (lecture seule). `deps.osint` est injectable pour les essais. */
async function recon(o, deps) {
  const a = autorisation(o);
  if (!a.ok) return { ok: false, raison: a.raison };
  const osint = (deps && deps.osint) || require('./osint');
  const t = typeCible(o.cible);
  let releve;
  if (t.type === 'domaine') releve = await osint.osint(t.v);
  else if (t.type === 'evm' || t.type === 'svm') releve = await osint.adresse(t.v);
  else return { ok: false, raison: 'nothing to recon for this target type' };
  return { ok: true, mode: a.mode, cible: t.v, avertissement: a.avertissement || null, releve };
}

/* ------------------------------------------- reconnaitre le TYPE d'appareil */

/* Demande du proprietaire (04/10) : « quand on cherche par IP, reconnaitre le
 * type — telephone, PC, routeur, site web… ». On le DEDUIT des donnees PASSIVES
 * (ports ouverts, CPE, hostnames, tags d'InternetDB) : aucune sonde. C'est une
 * ESTIMATION, dite telle — un NAT domestique cache souvent le vrai appareil.
 *
 * Chaque type marque des points selon des indices ; on rend le plus probable,
 * les autres, et les preuves. Deterministe, testable, sans reseau. */
const INDICES = [
  { type: 'website / web server', ports: [80, 443, 8080, 8443, 8000], cpe: /nginx|apache|openresty|litespeed|iis|caddy|cloudflare|tomcat|haproxy/i, host: /(^|\.)www\.|web|cdn/i, tag: /web/i },
  { type: 'router / gateway', ports: [7547, 161, 1900, 2000], cpe: /mikrotik|routeros|ubiquiti|edgeos|fritz|avm|tp-link|tplink|netgear|dd-wrt|openwrt|zyxel|draytek|huawei.*(hg|router)/i, host: /gateway|router|gw[-.]|\bbbox\b|livebox|freebox/i, tag: /router/i },
  { type: 'mail server', ports: [25, 465, 587, 110, 143, 993, 995], cpe: /postfix|exim|dovecot|exchange|zimbra/i, host: /(^|\.)mail\.|smtp|mx\d?\./i, tag: /mail/i },
  { type: 'name server (DNS)', ports: [53], cpe: /bind|powerdns|unbound|dnsmasq/i, host: /(^|\.)ns\d?\.|dns/i, tag: /dns/i },
  { type: 'remote access / PC / server', ports: [22, 3389, 5900, 23], cpe: /openssh|windows|ubuntu|debian|centos|realvnc|xrdp/i, host: /vps|srv|server|host/i, tag: /ssh|rdp|vnc/i },
  { type: 'database', ports: [3306, 5432, 1433, 27017, 6379, 9200, 5984, 11211, 9300], cpe: /mysql|mariadb|postgres|mssql|mongodb|redis|elasticsearch|memcached/i, host: /db[-.]|database/i, tag: /database|elastic/i },
  { type: 'camera / IoT device', ports: [554, 8554, 37777, 1935], cpe: /hikvision|dahua|axis|reolink|webcam|camera|gocoax/i, host: /cam\d?\.|ipcam|dvr|nvr/i, tag: /webcam|iot|ics|scada/i },
  { type: 'phone / mobile endpoint', ports: [], cpe: /android|ios|iphone/i, host: /mobile|cellular|lte|gprs|3g|4g|5g|\bwireless\b|\bgsm\b/i, tag: /mobile/i },
];

function classeAppareil(expo) {
  const ports = (expo && expo.ports || []).map(Number);
  const cpes = (expo && expo.cpes || []).join(' ');
  const hosts = (expo && expo.hostnames || []).join(' ');
  const tags = (expo && expo.tags || []).join(' ');
  const scores = INDICES.map((ind) => {
    const preuves = [];
    const pp = ind.ports.filter((p) => ports.includes(p));
    if (pp.length) preuves.push('port ' + pp.join(', '));
    if (ind.cpe.test(cpes)) preuves.push('software fingerprint');
    if (ind.host.test(hosts)) preuves.push('hostname');
    if (ind.tag.test(tags)) preuves.push('tag');
    const score = pp.length * 2 + (ind.cpe.test(cpes) ? 3 : 0) + (ind.host.test(hosts) ? 2 : 0) + (ind.tag.test(tags) ? 2 : 0);
    return { type: ind.type, score, preuves };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  if (!scores.length) {
    /* Aucun service notable : souvent un appareil grand public derriere un NAT. */
    const guess = ports.length === 0
      ? 'consumer endpoint behind NAT (phone, PC or home device — not directly exposed)'
      : 'unknown device (open ports with no recognised fingerprint)';
    return { type: guess, confidence: 'low', evidence: ports.length ? ['ports ' + ports.join(', ')] : ['no open ports in passive data'], all: [] };
  }
  const top = scores[0];
  const confiance = top.score >= 5 ? 'high' : top.score >= 3 ? 'medium' : 'low';
  return { type: top.type, confidence: confiance, evidence: top.preuves,
    all: scores.map((s) => ({ type: s.type, score: s.score })),
    note: 'Best guess from passive data (ports, software, hostnames). A NAT or proxy can hide the real device.' };
}

/* ------------------------------------------------ l'exposition passive d'une IP */

/* Shodan InternetDB (confirme le 04/10, recherche Maltego/recon passive) :
 *   GET https://internetdb.shodan.io/<ip>  — SANS cle, et surtout PASSIF : c'est
 *   Shodan qui a scanne, pas nous. Aucun paquet ne part vers la cible ; on LIT
 *   ce qui est deja collecte (ports ouverts, CVE connues, CPE, hostnames). C'est
 *   l'equivalent SUR d'un « scan de ports » — sans scanner. deps.fetch injectable. */
async function expositionIp(ip, deps) {
  const t = typeCible(ip);
  if (t.type !== 'ip') return { ok: false, raison: 'not an IPv4 address' };
  const f = (deps && deps.fetch) || fetch;
  let r, j;
  try { r = await f('https://internetdb.shodan.io/' + t.v, { signal: AbortSignal.timeout(12000) }); }
  catch (e) { return { ok: false, raison: 'InternetDB unreachable: ' + String((e && e.message) || e).slice(0, 80) }; }
  if (r.status === 404) { const vide = { ok: true, ip: t.v, ports: [], vulns: [], cpes: [], hostnames: [], tags: [], note: 'InternetDB knows nothing about this IP (no collected exposure).' }; vide.device = classeAppareil(vide); return vide; }
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j) return { ok: false, raison: 'InternetDB HTTP ' + (r && r.status) };
  const expo = { ok: true, ip: t.v, ports: j.ports || [], vulns: j.vulns || [], cpes: j.cpes || [], hostnames: j.hostnames || [], tags: j.tags || [],
    source: 'Shodan InternetDB (already-collected, no packet sent to the target)' };
  expo.device = classeAppareil(expo);   /* le type d'appareil, deduit du passif */
  return expo;
}

/* --------------------------------- d'autres sources PASSIVES, gratuites (04/10) */

/* Sous-domaines via la transparence des certificats — CertSpotter (SSLMate),
 * keyless pour l'eval. Redondance de crt.sh (deja dans osint.js), plus stable.
 * PASSIF : on lit des logs publics, aucun paquet vers la cible. */
async function sousDomaines(domaine, deps) {
  const d = String(domaine || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { ok: false, raison: 'not a domain' };
  const f = (deps && deps.fetch) || fetch;
  let r, j;
  try { r = await f('https://api.certspotter.com/v1/issuances?domain=' + encodeURIComponent(d) + '&include_subdomains=true&expand=dns_names', { signal: AbortSignal.timeout(12000) }); }
  catch (e) { return { ok: false, raison: 'CertSpotter unreachable' }; }
  if (r.status === 429) return { ok: false, raison: 'CertSpotter rate-limited — try again in a minute' };
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !Array.isArray(j)) return { ok: false, raison: 'CertSpotter HTTP ' + (r && r.status) };
  const vus = new Set();
  for (const it of j) for (const n of (it.dns_names || [])) { const h = String(n).toLowerCase().replace(/^\*\./, ''); if (h.endsWith(d)) vus.add(h); }
  return { ok: true, domaine: d, sousDomaines: [...vus].sort(), n: vus.size, source: 'CertSpotter certificate transparency (passive)' };
}

/* Scans PUBLICS deja faits par urlscan.io — SEARCH seulement (lecture). Le
 * submit (qui charge l'URL en vrai) est ACTIF : on ne l'appelle jamais. */
async function scansConnus(domaine, deps) {
  const d = String(domaine || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { ok: false, raison: 'not a domain' };
  const f = (deps && deps.fetch) || fetch;
  let r, j;
  try { r = await f('https://urlscan.io/api/v1/search/?q=domain:' + encodeURIComponent(d) + '&size=20', { signal: AbortSignal.timeout(12000) }); }
  catch (e) { return { ok: false, raison: 'urlscan unreachable' }; }
  if (r.status === 429) return { ok: false, raison: 'urlscan rate-limited' };
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j || !Array.isArray(j.results)) return { ok: false, raison: 'urlscan HTTP ' + (r && r.status) };
  const scans = j.results.slice(0, 20).map((x) => ({ url: x.page && x.page.url, ip: x.page && x.page.ip, pays: x.page && x.page.country,
    serveur: x.page && x.page.server, quand: x.task && x.task.time, apercu: x.result }));
  return { ok: true, domaine: d, n: scans.length, scans, source: 'urlscan.io public scans (search only, no submit)' };
}

/* Vulnerabilites d'une DEPENDANCE — OSV.dev, keyless. Donnee de reference
 * publique (comme NVD), aucune cible contactee. Utile pour auditer les paquets
 * d'un projet (npm, PyPI, Go, crates, Maven…). */
async function vulnsPaquet(o, deps) {
  o = o || {};
  const eco = String(o.ecosystem || '').trim(), nom = String(o.name || '').trim(), ver = String(o.version || '').trim();
  if (!eco || !nom) return { ok: false, raison: 'need {ecosystem, name, version?}' };
  const f = (deps && deps.fetch) || fetch;
  const corps = { package: { name: nom, ecosystem: eco } };
  if (ver) corps.version = ver;
  let r, j;
  try { r = await f('https://api.osv.dev/v1/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps), signal: AbortSignal.timeout(12000) }); }
  catch (e) { return { ok: false, raison: 'OSV unreachable' }; }
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j) return { ok: false, raison: 'OSV HTTP ' + (r && r.status) };
  const vulns = (j.vulns || []).map((v) => ({ id: v.id, resume: v.summary || (v.details || '').slice(0, 140),
    gravite: (v.severity && v.severity[0] && v.severity[0].score) || null, alias: v.aliases || [] }));
  return { ok: true, ecosystem: eco, name: nom, version: ver || null, n: vulns.length, vulns, source: 'OSV.dev (public vulnerability database)' };
}

/* --------------------------------------------------- le pre-audit de contrat */

/* Analyse STATIQUE d'une source Solidity fournie. Precision avant rappel :
   on ne signale que des motifs peu ambigus, chacun a VERIFIER par un humain —
   jamais un verdict. Quatre classes (recherche du 04/10). Deterministe,
   testable, sans reseau ni cle. */
const SENSIBLE = /\b(selfdestruct|delegatecall|transfer|transferFrom|send|call\s*\{|_mint|mint|withdraw|setOwner|transferOwnership|upgradeTo)\b/;
const GARDE = /(onlyOwner|onlyAdmin|onlyRole|require\s*\(\s*msg\.sender|_checkOwner|_checkRole|hasRole|authorized|nonReentrant)/;

function lignes(src) { return String(src || '').split(/\r?\n/); }

/* Decoupe grossierement les corps de fonctions : assez pour juger « cette
   fonction fait X sans garde », pas un vrai parseur Solidity (dit tel). */
function fonctions(src) {
  const txt = String(src || '');
  const out = [];
  const re = /function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)([^;{]*)\{/g;
  let m;
  while ((m = re.exec(txt))) {
    // trouver la fin du corps par comptage d'accolades
    let i = re.lastIndex - 1, prof = 0, fin = txt.length;
    for (; i < txt.length; i++) { if (txt[i] === '{') prof++; else if (txt[i] === '}') { prof--; if (prof === 0) { fin = i; break; } } }
    const entete = m[0];
    const corps = txt.slice(re.lastIndex, fin);
    const ligne = txt.slice(0, m.index).split('\n').length;
    out.push({ nom: m[1], entete, corps, ligne, visible: /\b(public|external)\b/.test(m[3] + m[2]) || /\b(public|external)\b/.test(entete) });
  }
  return out;
}

function preAudit(src) {
  const trouvailles = [];
  const add = (classe, gravite, ligne, pourquoi, extrait, confiance) =>
    trouvailles.push({ classe, gravite, ligne, pourquoi, extrait: String(extrait || '').trim().slice(0, 160), confiance });

  const fns = fonctions(src);
  for (const f of fns) {
    const sensible = SENSIBLE.test(f.corps) || SENSIBLE.test(f.entete);
    const garde = GARDE.test(f.corps) || GARDE.test(f.entete);
    /* 1. Controle d'acces : fonction visible qui fait un geste sensible SANS
       aucune garde. La classe la plus frequente (72 % des findings AC de C4). */
    if (f.visible && sensible && !garde) {
      add('access-control', 'high', f.ligne,
        'Public/external function performs a sensitive action (transfer / mint / ownership / selfdestruct / delegatecall / upgrade) with no visible access-control guard (modifier or require(msg.sender…)). Verify it is meant to be callable by anyone.',
        f.entete, 'medium');
    }
    /* 2. Reentrance : un appel externe qui envoie de la valeur AVANT une
       ecriture d'etat, sans nonReentrant. */
    const idxAppel = f.corps.search(/\.call\s*\{[^}]*value|\.transfer\s*\(|\.send\s*\(/);
    const idxEtat = f.corps.search(/\b[A-Za-z0-9_]+\s*\[[^\]]+\]\s*(=|-=|\+=)/);
    if (idxAppel >= 0 && idxEtat > idxAppel && !/nonReentrant/.test(f.entete + f.corps)) {
      const l = f.ligne + f.corps.slice(0, idxAppel).split('\n').length - 1;
      add('reentrancy', 'high', l,
        'An external value-bearing call happens BEFORE a state update in the same function, with no nonReentrant guard — classic reentrancy shape (checks-effects-interactions violated). Verify the state is written before the call.',
        f.corps.slice(idxAppel, idxAppel + 80), 'medium');
    }
  }
  /* 3. Precision / arrondi : division AVANT multiplication (a / b * c) perd de
     la precision. Motif a fort signal, peu de faux positifs. */
  lignes(src).forEach((ln, i) => {
    const code = ln.split('//')[0];   /* hors commentaire de fin de ligne */
    if (/\/\s*[A-Za-z0-9_().]+\s*\*/.test(code)) {
      add('rounding', 'medium', i + 1,
        'Division appears before multiplication (a / b * c): integer math loses precision here. Prefer multiply-before-divide, or a fixed-point library.',
        ln, 'medium');
    }
  });
  /* 4. Oracle / prix au comptant : prix lu d'un pool au comptant
     (getReserves / balanceOf(address(this)) / latestAnswer sans verif) =
     manipulable par flash loan. On signale l'usage, a verifier. */
  lignes(src).forEach((ln, i) => {
    const code = ln.split('//')[0];
    if (/getReserves\s*\(|\.latestAnswer\s*\(|balanceOf\s*\(\s*address\s*\(\s*this/.test(code)) {
      add('oracle', 'medium', i + 1,
        'Spot price / reserve read used directly (getReserves / balanceOf(this) / latestAnswer). If used as a price, it is flash-loan manipulable — verify a TWAP or Chainlink staleness/round checks back it.',
        ln, 'low');
    }
  });

  /* Precision avant rappel : on ordonne par gravite puis confiance, et on DIT
     que c'est une assistance, pas un verdict. */
  const ordreG = { high: 0, medium: 1, low: 2 }, ordreC = { high: 0, medium: 1, low: 2 };
  trouvailles.sort((a, b) => (ordreG[a.gravite] - ordreG[b.gravite]) || (ordreC[a.confiance] - ordreC[b.confiance]) || (a.ligne - b.ligne));
  return {
    trouvailles,
    classes: [...new Set(trouvailles.map((t) => t.classe))],
    note: 'Static assist, not a verdict. Each finding is a lead to verify by hand with a proof of concept. '
      + 'Out of scope by design and NOT checked here: stolen keys, insiders, governance, novel economic logic — those are not code-level.',
    horsScope: ['private-keys', 'insider', 'governance', 'economic-logic'],
  };
}

module.exports = {
  ATTESTATION_TEXTE, PRIME_FORTE,
  typeCible, couvre, dansScope, autorisation, journaliseAttestation,
  classeProgrammes, recon, preAudit, fonctions, expositionIp, classeAppareil,
  sousDomaines, scansConnus, vulnsPaquet,
};
