'use strict';
/* ============================================================================
 * LE JOURNAL BRUT : CE QU ON POURRA DEMANDER PLUS TARD
 *
 * La colonie garde des compteurs, et un compteur ne repond qu a la question
 * qu on avait prevue. Ce journal garde la LIGNE BRUTE — ce qui a ete mesure
 * au moment de la decision — et, plus tard, ce que la situation a donne. Le
 * rapprochement des deux est la seule chose qui reponde a « comment gagne-t-on
 * sur la duree ».
 *
 * Ce qui est mesure ici :
 *   - une ligne par marche et par tour, avec ses mesures et sa decision ;
 *   - une ligne de resultat par echeance atteinte, reliee a la premiere ;
 *   - la TAILLE reelle d une ligne, parce qu un journal qui remplit le volume
 *     est un journal qu on eteindra ;
 *   - la retention : les vieux fichiers partent, les recents restent ;
 *   - et qu un journal qui tombe n arrete JAMAIS la colonie.
 * ==========================================================================*/
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b || JSON.stringify(a) === JSON.stringify(b), m + ' (' + JSON.stringify(a) + ')');

/* Un volume a nous : on n ecrit pas dans celui de la colonie. */
const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'perpj-'));
process.env.DATA_DIR = BAC;
process.env.PERP_JOURNAL = '1';
process.env.PERP_JOURNAL_JOURS = '7';
const J = require('./perp_journal');

const mesuresFausses = (o) => Object.assign({
  sym: 'BTCUSDT', prix: 81214.4, ecartEma: 0.42, fond: -1.2, vol15: 0.18, vol4: 0.31,
  couloir: 0.72, var1h: 0.3, var4h: -0.8, var24: 2.1, financement: 0.0001,
  interet: 41230.5, varInteret: 1.4, base: 0.012, carnet: -0.21, volume: 2875000000,
}, o || {});

console.log('-- une ligne par marche et par tour --');
{
  const t = Date.parse('2026-09-19T12:00:00Z');
  const id = J.idObs(t, 'BTCUSDT', 412);
  eq(id, '20260919-412-BTC', 'l identifiant porte le jour, le tour et le marche : lisible a l oeil');
  const l = J.noteObservation({ id, t, x: mesuresFausses(),
    sides: [{ sens: 1, score: 73, refus: null, qui: null },
            { sens: -1, score: 41, refus: 'score below the bar', qui: 'tendance' }],
    prise: 1 });
  ok(!!l, 'la ligne est ecrite');
  eq(l.s, 'BTCUSDT', 'elle porte son marche');
  eq(l.sc, [73, 41], 'les deux sens ont leur note');
  eq(l.rf, [null, 'score below the bar'], 'et leur refus, ou son absence');
  eq(l.pr, 1, 'et ce qui a ete pris');
  /* ---- CE QUI N EXISTE QUE SUR UN PERPETUEL ----
   * Financement, interet ouvert, prime sur l index : c est ce qu on vient
   * chercher, et c est justement ce qu un journal de prix ne garde pas. */
  ok(l.f === 0.0001 && l.oi === 41230.5 && l.ba === 0.012,
     'financement, interet ouvert et prime sur l index sont gardes');
  ok(l.doi === 1.4, 'ainsi que la VARIATION de l interet ouvert, qui n a pas de sens sur une photo seule');
  ok(l.cb === -0.21 && l.vo === 2875000000, 'le carnet et le volume aussi');
}

console.log('\n-- et une ligne par echeance atteinte, reliee a la premiere --');
{
  const t = Date.parse('2026-09-19T16:00:00Z');
  const r = J.noteResultat({ id: '20260919-412-BTC', t, sym: 'BTCUSDT', sens: 1, horizon: 240,
                             rendement: 1.83, brut: 2.06, financement: -0.23, cle: 'pris' });
  ok(!!r, 'le resultat est ecrit');
  eq(r.i, '20260919-412-BTC', 'sous l identifiant de l observation : c est le fil qui relie les deux');
  eq(r.h, 240, 'avec son echeance');
  ok(r.b === 2.06 && r.fc === -0.23,
     'et le mouvement du prix SEPARE du financement — sans ca, on ne saura jamais lequel des deux a coute');
}

console.log('\n-- on relit ce qu on a ecrit --');
{
  const v = J.relit('2026-09-19', '2026-09-19');
  eq(v.obs.length, 1, 'une observation relue');
  eq(v.res.length, 1, 'un resultat relu');
  eq(v.cassees, 0, 'aucune ligne illisible');
  /* Le rapprochement : c est POUR CA que le journal existe. */
  const par = {};
  for (const o of v.obs) par[o.i] = o;
  const joint = v.res.filter((r) => par[r.i]).map((r) => ({ f: par[r.i].f, r: r.r }));
  eq(joint.length, 1, 'et la jointure rend ce qu on veut : la mesure du moment, et ce qu elle a donne');
  ok(joint[0].f === 0.0001 && joint[0].r === 1.83,
     'un financement de 0,01 % a donne +1,83 % a quatre heures — c est la ligne qu on veut par milliers');
}

console.log('\n-- une ligne tronquee ne se lit pas comme une observation --');
{
  /* Un redemarrage au milieu d un `appendFile` laisse une ligne coupee. Elle
     doit etre COMPTEE, jamais devinee. */
  fs.appendFileSync(path.join(J.dossier(), '2026-09-19.ndjson'), '{"k":"o","i":"casse"\n');
  const v = J.relit('2026-09-19', '2026-09-19');
  eq(v.cassees, 1, 'la ligne coupee est comptee');
  eq(v.obs.length, 1, 'et elle n entre pas dans les observations');
}

console.log('\n-- la taille, calculee et non esperee --');
{
  /* Cinq marches, 288 tours par jour : 1 440 lignes. Si une ligne pesait un
     kilo-octet, le journal ferait un demi-giga par an, et on l eteindrait. */
  const t = Date.parse('2026-09-20T00:00:00Z');
  let octets = 0;
  for (let i = 0; i < 100; i++) {
    const l = J.noteObservation({ id: J.idObs(t, 'ETHUSDT', i), t, x: mesuresFausses({ sym: 'ETHUSDT', prix: 3021.55 + i }),
      sides: [{ sens: 1, score: 50 + i % 30, refus: i % 3 ? 'funding too expensive' : null, qui: 'financement' },
              { sens: -1, score: 40, refus: 'score below the bar', qui: 'tendance' }], prise: null });
    octets += JSON.stringify(l).length + 1;
  }
  const parLigne = Math.round(octets / 100);
  ok(parLigne < 400, 'une ligne pese ' + parLigne + ' octets');
  const parJour = parLigne * 5 * 288;
  ok(parJour < 700000, 'soit ' + Math.round(parJour / 1024) + ' Ko par jour pour cinq marches');
  console.log('       ' + Math.round(parJour * 180 / 1048576) + ' Mo pour les 180 jours gardes par defaut');
}

console.log('\n-- les vieux jours partent, les recents restent --');
{
  const vieux = path.join(J.dossier(), '2020-01-01.ndjson');
  fs.writeFileSync(vieux, '{"k":"o"}\n');
  J.purge(Date.parse('2026-09-21T00:00:00Z'));
  ok(!fs.existsSync(vieux), 'un fichier plus vieux que la retention est efface');
  ok(fs.existsSync(path.join(J.dossier(), '2026-09-20.ndjson')), 'et les recents restent');
  const e = J.etat();
  ok(e.jours >= 2 && e.octets > 0, 'l etat dit ce que le journal porte : ' + e.jours + ' jours, ' + e.octets + ' octets');
  eq(e.garde, 7, 'et combien de jours il garde');
}

console.log('\n-- un journal qui tombe n arrete PAS la colonie --');
{
  /* Il observe, il ne commande pas. Un disque plein ne doit pas empecher une
     position de se fermer. */
  const j2 = path.join(__dirname, 'perp_journal.js');
  const src = fs.readFileSync(j2, 'utf8');
  ok(/catch[\s\S]{0,120}console\.error/.test(src), 'chaque ecriture est sous garde');
  const avant = process.env.DATA_DIR;
  /* Un FICHIER pris pour un dossier : `mkdir` echoue franchement (ENOTDIR).
     `/proc/...` semblait plus parlant et faisait carrement BLOQUER `mkdir`
     sur ce noyau — un essai qui ne rend jamais la main n est pas un essai. */
  process.env.DATA_DIR = '/dev/null/pas-un-dossier';
  let boum = null;
  try { J.noteObservation({ id: 'x', t: Date.now(), x: mesuresFausses(), sides: [] }); }
  catch (e) { boum = e; }
  process.env.DATA_DIR = avant;
  ok(!boum, 'un chemin impossible ne leve pas : la colonie continue');
}

console.log('\n-- et il ne DECIDE rien --');
{
  const moteur = fs.readFileSync(path.join(__dirname, 'ai_perp.js'), 'utf8');
  /* Meme frontiere que `OBS_VIEUX_PAR_TOUR` : on rend mesurable avant de
     faire acheter. Le journal est appele pour ECRIRE, jamais pour lire une
     decision. */
  const appels = moteur.match(/journal\.\w+/g) || [];
  ok(appels.length > 0, 'le moteur ecrit dans le journal : ' + [...new Set(appels)].join(', '));
  /* ---- CE QUE CET ESSAI VEUT VRAIMENT DIRE ----
   * Il interdisait toute lecture. Son intention n a jamais ete « aucune
   * lecture » mais « le moteur ne demande pas au journal quoi faire » — et
   * `etat()` ne rend que la taille et les dates des fichiers, de quoi ecrire
   * une ligne sur la page. Ce qui compte est plus precis, et desormais
   * verifie : le CONTENU du journal (`relit`) n est jamais lu, et `etat()`
   * n est appele QUE depuis la vue, jamais depuis un tour ou une note. */
  ok(!/journal\.relit/.test(moteur), 'le contenu du journal n est jamais relu par le moteur');
  const hors = appels.filter((a) => !/note|idObs|etat/.test(a));
  ok(hors.length === 0, 'aucun autre appel que les ecritures, l identifiant et l etat : ' + hors.join(', '));
  /* `etat()` est-il confine a la vue ? On decoupe la fonction et on regarde. */
  const d0 = moteur.indexOf('function vue()');
  const d1 = moteur.indexOf('// ------', d0);
  const dansLaVue = moteur.slice(d0, d1);
  const total = (moteur.match(/journal\.etat\(/g) || []).length;
  const dedans = (dansLaVue.match(/journal\.etat\(/g) || []).length;
  ok(total > 0 && total === dedans,
     'l etat du journal n est lu que par la vue (' + dedans + '/' + total + '), jamais par une decision');
}

console.log('\n-- le detail de la note, agent par agent, et ce qu il coute --');
{
  /* Le rapport du 26/09 : aucun P/L par agent n existait, le carnet ne
     gardait que le score. La ligne porte desormais la contribution de chaque
     agent, par sens, dans un ordre FIXE. */
  const t = Date.parse('2026-09-21T00:00:00Z');
  const dit = [{ agent: 'tendance', points: 8, v: 8.44 }, { agent: 'financement', points: -10, v: -10 },
               { agent: 'couloir', points: 3, v: 3.21 }, { agent: 'journee', points: 1, v: 1.07 }];
  const l = J.noteObservation({ id: J.idObs(t, 'BTCUSDT', 1), t, x: mesuresFausses(),
    sides: [{ sens: 1, score: 53, refus: 'score below the bar', qui: 'score', an: { dit } },
            { sens: -1, score: 47, refus: 'score below the bar', qui: 'score', an: { dit: dit.map((d) => Object.assign({}, d, { v: -d.v })) } }],
    prise: null });
  eq(J.DT_ORDRE, ['tendance', 'financement', 'couloir', 'carnet', 'journee', 'memoire'], 'l ordre des colonnes est fixe et ecrit');
  eq(l.dt[0], [8.4, -10, 3.2, 0, 1.1, 0], 'chaque sens porte ses six contributions, a une decimale');
  eq(l.dt[1][0], -8.4, 'et l autre sens les siennes');
  const sans = J.noteObservation({ id: J.idObs(t, 'BTCUSDT', 1), t, x: mesuresFausses(),
    sides: [{ sens: 1, score: 53, refus: 'score below the bar', qui: 'score' },
            { sens: -1, score: 47, refus: 'score below the bar', qui: 'score' }], prise: null });
  ok(sans.dt === undefined, 'sans detail fourni, pas de colonne vide : la ligne reste celle d avant');
  /* ---- LA TAILLE, REMESUREE AVEC LE DETAIL ----
   * Le budget d origine tient toujours pour une ligne sans detail (essai
   * plus haut). Avec : on mesure ce que `dt` ajoute, et le total doit rester
   * loin du kilo-octet qui ferait eteindre le journal (180 jours < 200 Mo,
   * a verifier contre le volume Railway — decision 14 du rapport). */
  const brut = JSON.stringify(sans).length, plein = JSON.stringify(l).length;
  const ajout = plein - brut;
  ok(ajout < 110, 'le detail ajoute ' + ajout + ' octets par ligne');
  ok(plein < 520 && plein * 5 * 288 * 180 < 200 * 1048576,
     'une ligne complete pese ' + plein + ' octets, soit ' + Math.round(plein * 5 * 288 * 180 / 1048576) + ' Mo pour 180 jours');
}

console.log('\n-- le resultat porte son rendement en σ --');
{
  const l = J.noteResultat({ id: 'z', t: Date.now(), sym: 'BTCUSDT', sens: 1, horizon: 240, rendement: 0.9, brut: 0.91, financement: -0.01, cle: 'pris', z: 1.2345 });
  eq(l.z, 1.235, 'le rendement en unites de σ du marche part avec la ligne');
}

(async () => {
  console.log('\n-- la route : un jour par requete, en flux, debit borne --');
  const http = require('http');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    J.sert(req, res, u.searchParams.get('jour'), req.headers['x-ip'] || '1.1.1.1');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const lit = async (q, ip) => {
    const r = await fetch('http://127.0.0.1:' + port + '/ai/perp/journal' + q, { headers: { 'x-ip': ip || '2.2.2.2' } });
    const corps = await r.text();
    return { code: r.status, corps, type: r.headers.get('content-type'), cache: r.headers.get('cache-control'),
             cors: r.headers.get('access-control-allow-origin'), taille: r.headers.get('content-length') };
  };
  /* Un jour ecrit a la main, passe : il ne change plus. */
  const jour = '2026-09-22';
  const t = Date.parse(jour + 'T12:00:00Z');
  for (let i = 0; i < 50; i++) J.noteObservation({ id: J.idObs(t, 'BTCUSDT', i), t, x: mesuresFausses(), sides: [], prise: null });
  const attendu = fs.readFileSync(path.join(J.dossier(), jour + '.ndjson'), 'utf8');

  const r = await lit('?jour=' + jour, '3.3.3.3');
  eq(r.code, 200, 'un jour present se lit');
  ok(r.corps === attendu, 'octet pour octet : ' + r.corps.length + ' octets, ' + r.corps.split('\n').filter(Boolean).length + ' lignes');
  ok(/application\/x-ndjson/.test(r.type), 'en NDJSON, une ligne par observation : ' + r.type);
  eq(r.taille, String(Buffer.byteLength(attendu)), 'la taille est annoncee avant le flux');
  ok(/max-age=3600/.test(r.cache || ''), 'un jour passe se garde : ' + r.cache);
  eq(r.cors, '*', 'lisible depuis le site');
  const src = fs.readFileSync(path.join(__dirname, 'perp_journal.js'), 'utf8');
  const sert = src.slice(src.indexOf('function sert('));
  ok(/createReadStream/.test(sert) && !/readFileSync/.test(sert), 'servi en FLUX depuis le fichier, jamais charge en memoire');

  for (const mauvais of ['../../etc/passwd', '2026-9-22', '2026-09-22/../x', 'x', '2026-13-45']) {
    const m = await lit('?jour=' + encodeURIComponent(mauvais), '4.4.4.4');
    ok(m.code === 400, '« ' + mauvais + ' » est refuse avant le disque [' + m.code + ']');
  }
  const libre = await lit('?jour=' + jour, '4.4.4.4');
  eq(libre.code, 200, 'cinq fautes de forme ne coutent pas de place dans le debit');
  eq((await lit('?jour=2020-01-01', '5.5.5.5')).code, 404, 'un jour absent : 404, sans rien inventer');
  const liste = JSON.parse((await lit('', '6.6.6.6')).corps);
  ok(Array.isArray(liste.jours) && liste.jours.includes(jour) && liste.unJourParRequete === true,
     'sans jour, la liste des jours presents : ' + liste.jours.join(', '));

  /* Le debit : JOURNAL_PAR_MIN par minute et par adresse. */
  const codes = [];
  for (let i = 0; i < J.JOURNAL_PAR_MIN + 2; i++) codes.push((await lit('?jour=' + jour, '7.7.7.7')).code);
  eq(codes.filter((c) => c === 200).length, J.JOURNAL_PAR_MIN, J.JOURNAL_PAR_MIN + ' jours par minute et par adresse');
  ok(codes.slice(-2).every((c) => c === 429), 'au-dela : 429, et une autre adresse n est pas punie pour elle');
  eq((await lit('?jour=' + jour, '8.8.8.8')).code, 200, 'une autre adresse passe');
  await new Promise((res) => setTimeout(res, 50));
  eq(J._fluxOuverts(), 0, 'chaque flux ferme libere sa place : ' + J._fluxOuverts() + ' ouvert(s)');
  /* Aujourd hui s ecrit PENDANT le flux : le corps doit faire exactement
     content-length, sinon le surplus part sur la connexion gardee ouverte et
     se lit comme une fausse reponse suivante. Socket brut, keep-alive, et un
     ajout au fichier juste apres l en-tete (ce que fait la boucle perp). */
  {
    const net = require('net');
    const auj = new Date().toISOString().slice(0, 10);
    const fAuj = path.join(J.dossier(), auj + '.ndjson');
    const avantAuj = fs.existsSync(fAuj) ? fs.readFileSync(fAuj) : null;
    fs.writeFileSync(fAuj, 'x'.repeat(2000000) + '\n');
    const srv2 = http.createServer((req, res) => {
      const wh = res.writeHead.bind(res);
      res.writeHead = (...a) => { const rr = wh(...a); fs.appendFileSync(fAuj, 'y'.repeat(11000) + '\n'); return rr; };
      J.sert(req, res, new URL(req.url, 'http://x').searchParams.get('jour'), req.headers['x-ip']);
    });
    await new Promise((r2) => srv2.listen(0, '127.0.0.1', r2));
    const brut = (jourQ, ip) => new Promise((fin) => {
      const s = net.connect(srv2.address().port, '127.0.0.1');
      let buf = Buffer.alloc(0), calme = null;
      const clos = () => { clearTimeout(calme); s.destroy(); const i = buf.indexOf('\r\n\r\n');
        const tete = buf.slice(0, i).toString(); const m = /content-length: (\d+)/i.exec(tete);
        fin({ cl: m ? Number(m[1]) : null, corps: buf.length - i - 4, code: Number((/^HTTP\/1\.1 (\d+)/.exec(tete) || [])[1]) }); };
      s.on('data', (d) => { buf = Buffer.concat([buf, d]); clearTimeout(calme); calme = setTimeout(clos, 400); });
      s.write('GET /ai/perp/journal?jour=' + jourQ + ' HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\nx-ip: ' + ip + '\r\n\r\n');
      setTimeout(clos, 5000);
    });
    const b = await brut(auj, '9.9.9.1');
    ok(b.code === 200 && b.cl === 2000001 && b.corps === b.cl,
       'un fichier qui grossit pendant le flux : corps = content-length exactement [' + b.corps + ' / ' + b.cl + ']');
    /* Un fichier vide : 200, longueur 0, aucun flux ouvert. */
    const vide = '2026-09-21';
    fs.writeFileSync(path.join(J.dossier(), vide + '.ndjson'), '');
    const v = await brut(vide, '9.9.9.2');
    ok(v.code === 200 && v.cl === 0 && v.corps === 0, 'un jour vide : 200, content-length 0, corps 0 [' + v.corps + ']');
    await new Promise((res2) => setTimeout(res2, 50));
    eq(J._fluxOuverts(), 0, 'aucun flux reste ouvert apres ces deux lectures');
    srv2.close();
    fs.unlinkSync(path.join(J.dossier(), vide + '.ndjson'));
    if (avantAuj) fs.writeFileSync(fAuj, avantAuj); else fs.unlinkSync(fAuj);
  }
  srv.close();

  console.log('\n-- le serveur branche la route AVANT la vue generique --');
  {
    const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const a = server.indexOf("path === '/ai/perp/journal'"), b = server.indexOf("path.startsWith('/ai/perp/')");
    ok(a > 0 && a < b, 'le chemin /ai/perp/journal est teste avant /ai/perp/… qui rendrait la vue');
    ok(/\.sert\(req, res, jour, qui\(req\)\)/.test(server), 'et il passe l adresse de la requete au debit');
  }

  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) { /* un bac temporaire */ }
  console.log(rates ? `\nperp_journal.test.js : RATES : ${rates}/${n}` : `\nperp_journal.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('  RATE ' + (e.stack || e)); console.log(`perp_journal.test.js : RATES : ${rates + 1}/${n + 1}`); process.exit(1); });
