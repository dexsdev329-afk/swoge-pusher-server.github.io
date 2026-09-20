'use strict';
/* ============================================================================
 * LE SCAN PUBLIC — IL MESURE, IL NE CONCLUT PAS
 *
 * Personne ne cherche un casino. Tout le monde, avant d acheter, cherche la
 * meme chose : « celui-la, c est un piege ? ». C est la seule porte du site
 * par ou peut entrer quelqu un qui n a jamais entendu parler de SWOGE, donc
 * elle est PUBLIQUE : pas de cle, pas de portefeuille, pas de compte.
 *
 * Une porte publique sur un serveur qui fait tourner de l argent reel demande
 * trois garanties, et ce sont elles qu on met a l essai :
 *
 *   1. ELLE NE REND QUE CE QU ON A MESURE. Jamais un avis, jamais un mot
 *      comme « sur » ou « rug ». Des cases, et ce qu elles ont rendu.
 *   2. ELLE SE TAIT SOUS LE MINIMUM. Un chiffre sur six lectures se lirait
 *      avec la meme autorite qu un chiffre sur six cents : il ne sort pas.
 *      Et chaque chiffre part AVEC son effectif — sans lui il ment.
 *   3. ELLE NE PEUT PAS FAIRE SAIGNER LE SERVEUR. Debit borne, et rien
 *      d autre qu une adresse en entree.
 * ==========================================================================*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };
const eq = (a, b, m) => ok(a === b, m + ' [' + JSON.stringify(a) + ']');

const BAC = fs.mkdtempSync(path.join(os.tmpdir(), 'scanpub-'));
process.env.DATA_DIR = BAC;
process.env.RPC_URL = ''; process.env.ADMIN_KEY = 'k';
process.env.AI_COLONIE = '0'; process.env.PERP_COLONIES = '0'; process.env.PERP_JOURNAL = '0';
process.env.ODDS_API_KEY = ''; process.env.MONITEUR_URL = '';
process.env.SCAN_PAR_MIN = '3';          /* assez bas pour le mettre a l essai */

const tg = require.resolve('./telegram');
require.cache[tg] = { id: tg, filename: tg, loaded: true, exports: {
  notify() {}, notifyPhoto() {}, sendDocument() {}, chatEstPublic() { return true; }, enabled() { return false; } } };

(async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const q = s.address().port; s.close(() => r(q)); }); });
  process.env.PORT = String(port);
  const A = require('./ai_colonie');
  require('./server');
  await new Promise((r) => setTimeout(r, 900));
  const lit = async (u) => { const r = await fetch('http://127.0.0.1:' + port + u); return { code: r.status, j: await r.json().catch(() => null), cache: r.headers.get('cache-control') }; };

  console.log('-- ce qui n est pas une adresse n entre pas, et ne coute pas une place --');
  {
    for (const mauvais of ['', 'pasuneadresse', '0x123', '0x' + 'z'.repeat(40),
                           '../../etc/passwd', '0x' + 'a'.repeat(41)]) {
      const r = await lit('/scan?adr=' + encodeURIComponent(mauvais));
      ok(r.code === 400 && r.j && r.j.erreur,
         '« ' + (mauvais || '(vide)').slice(0, 20) + ' » est refuse : ' + (r.j && r.j.erreur));
    }
    /* Le message dit QUOI FAIRE. « invalid input » n a jamais aide personne. */
    const r = await lit('/scan?adr=x');
    ok(/0x/.test(r.j.erreur), 'et le refus dit ce qu on attend : « ' + r.j.erreur + ' »');
    /* ---- ET IL NE CONSOMME PAS LE QUOTA ----
     * Une adresse mal formee ne touche aucun service. La compter reviendrait
     * a bloquer quelqu un pour deux fautes de frappe, avant qu il ait rien
     * demande. Sept refus de forme, puis une vraie demande : elle doit
     * passer, alors que la limite est a trois. */
    for (let i = 0; i < 7; i++) await lit('/scan?adr=nawak' + i);
    const apres = await lit('/scan/0x' + 'b'.repeat(40));
    ok(apres.code !== 429, 'sept adresses mal formees ne bloquent pas la suivante [' + apres.code + ']');
  }

  console.log('\n-- une adresse bien formee mais inconnue ne s invente pas --');
  {
    const r = await lit('/scan/0x' + 'b'.repeat(40));
    eq(r.code, 400, 'une adresse qui n est sur aucune piscine est refusee');
    ok(/not found/i.test(r.j.erreur || ''), 'et elle le DIT : « ' + r.j.erreur + ' »');
  }

  console.log('\n-- la porte est publique, et elle est etroite --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const bloc = src.slice(src.indexOf("path === '/scan'"), src.indexOf("path === '/scan'") + 1400);
    ok(!/authed|ADMIN_KEY|cle/.test(bloc), 'aucune cle demandee : sinon elle ne sert a rien');
    ok(/access-control-allow-origin/.test(bloc), 'et elle est lisible depuis le site');
    ok(/scanDebit\(req\)/.test(bloc), 'le debit est borne avant tout travail');
    ok(/429/.test(bloc), 'et le refus de debit se dit avec le bon code');
    /* Rien d autre qu une adresse : une route publique qui accepte des
       options accepte un jour celle qu on n avait pas prevue. */
    const params = bloc.match(/searchParams\.get\('([^']+)'\)|get\('([^']+)'\)/g) || [];
    ok(params.length <= 1, 'un seul parametre en entree : ' + params.join(', '));
  }

  console.log('\n-- le debit tient --');
  {
    /* SCAN_PAR_MIN vaut 3 : le quatrieme doit etre refuse, et refuse AVANT
       d avoir interroge le moindre service. */
    let codes = [];
    for (let i = 0; i < 5; i++) codes.push((await lit('/scan/0x' + 'c'.repeat(40))).code);
    ok(codes.filter((c) => c === 429).length >= 1,
       'passe la limite, la route repond 429 : ' + codes.join(','));
    const r = await lit('/scan/0x' + 'c'.repeat(40));
    ok(r.j && /wait/i.test(r.j.erreur || ''), 'et elle dit quoi faire : « ' + (r.j && r.j.erreur) + ' »');
  }

  console.log('\n-- ce que le scan REND, et ce qu il ne rend jamais --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
    const d0 = src.indexOf('async function scanJeton');
    const bloc = src.slice(d0, src.indexOf('\nfunction ', d0 + 10));
    /* ---- LE MINIMUM D OBSERVATIONS ----
     * C est la seule chose qui separe une mesure d une impression. */
    ok(/caseApprise\(/.test(bloc), 'chaque case passe par la memoire');
    const ca = src.slice(src.indexOf('function caseApprise'), src.indexOf('function caseApprise') + 400);
    ok(/c\.n < PROFIL_MIN_OBS/.test(ca) && /return null/.test(ca),
       'et une case sous le minimum rend `null` : elle ne sort pas du tout');
    ok(/if \(!m\) continue;/.test(bloc), 'donc elle n apparait pas dans la reponse');
    /* ---- L EFFECTIF PART AVEC LE CHIFFRE ----
     * Un « -43,7 % » sans son n se lit pareil qu il porte sur six lectures ou
     * sur six cents. */
    ok(/n: m\.n, moyenne: m\.moyenne/.test(bloc), 'chaque case part avec son effectif');
    ok(/mesureSur/.test(bloc) && /observations:/.test(bloc),
       'et la reponse dit sur combien d observations TOUT repose');
    /* ---- AUCUN VERDICT ----
     * Le scan ne dit pas quoi faire. Le lecteur conclut. */
    ok(!/(rug|scam|safe|danger|buy|sell)['"]/i.test(bloc.replace(/\*[^\n]*/g, '')),
       'aucun mot de verdict dans ce que la route rend');
    /* ---- ET AUCUNE CLE ---- */
    ok(!/API_KEY|SECRET|privateKey|\bsign\(/i.test(bloc), 'ni cle ni signature : c est une lecture');
  }

  console.log('\n-- les caches sont ceux du tour, pas des appels en plus --');
  {
    const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
    const d0 = src.indexOf('async function scanJeton');
    const bloc = src.slice(d0, src.indexOf('\nfunction ', d0 + 10));
    ok(/lisDex\(addr\)/.test(bloc), 'le prix et l age viennent de `lisDex`, qui a son cache');
    ok(/assure\(t, \['goplus', 'octets'\]\)/.test(bloc),
       'le contrat passe par `assure`, exactement comme dans le tour');
    ok(!/fetch\(|json\(/.test(bloc), 'et le scan n appelle aucun service en direct : que des lecteurs caches');
  }

  console.log('\n-- un service muet n arrete pas le scan --');
  {
    /* GoPlus ou le catalogue peuvent ne pas repondre. Le scan doit rendre ce
       qu il a, pas une erreur : une page vide vaut moins qu une page
       partielle qui dit ce qui manque. */
    const src = fs.readFileSync(path.join(__dirname, 'ai_colonie.js'), 'utf8');
    const d0 = src.indexOf('async function scanJeton');
    const bloc = src.slice(d0, src.indexOf('\nfunction ', d0 + 10));
    const gardes = (bloc.match(/catch \(e\)/g) || []).length;
    ok(gardes >= 2, gardes + ' lectures sous garde : un service muet ne fait pas tomber la page');
  }

  try { fs.rmSync(BAC, { recursive: true, force: true }); } catch (e) {}
  console.log(rates ? `\nscan_public.test.js : RATES : ${rates}/${n}` : `\nscan_public.test.js : ${n} verifications OK`);
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('  RATE ' + (e.stack || e)); process.exit(1); });
