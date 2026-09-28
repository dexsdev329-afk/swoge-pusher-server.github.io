'use strict';
/* passerelle.js : un agent paie un service x402 avec SA cle, dans les limites de son proprietaire ;
   une Idempotency-Key ne paie qu'une fois ; chaque appel laisse une ligne d'audit chainee. */
const fs = require('fs'), os = require('os'), path = require('path');
const P = require('./passerelle');
const Cles = require('./agentic_cles');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (!c) rates++; console.log((c ? '  ok   ' : '  RATE ') + m); };

(async () => {
  const dos = fs.mkdtempSync(path.join(os.tmpdir(), 'passerelle-'));
  const K = Cles.cree({ fichier: path.join(dos, 'cles.json') });
  const PROPRIO = '0xabc0000000000000000000000000000000000001';
  const c1 = K.nouvelle(PROPRIO, 'bot', 1000);                      /* 1 000 $SWOGE par jour */
  const cle = K.resout(c1.cle);
  /* Une fausse embauche : elle suit le contrat d'embauche.js (reserve, puis regle au prix si 200). */
  const vus = { appels: [], factures: [] };
  let prix = 0.01, reponse = 200;
  const embauche = { pour: (qui, factu) => ({ embauche: async (a) => {
    vus.appels.push({ qui, a });
    if (prix > a.maxUsd) return { ok: false, raison: 'price ' + prix + ' $ above the ' + a.maxUsd + ' $ per-call cap - nothing was charged' };
    const fu = prix * 1.1;
    const res = await factu.reserve(fu);
    if (!res.ok) return { ok: false, raison: res.raison };
    if (reponse !== 200) { await factu.regle(res.jeton, 0); return { ok: false, raison: 'the service answered HTTP 500 after payment - you were not charged' }; }
    await factu.regle(res.jeton, fu);
    return { ok: true, type: 'json', resultat: '{"price":119.5}', recu: { url: a.url, usd: prix, factureUsd: fu, reseau: 'solana:x', tx: '5Tx' } };
  } }) };
  const factuPour = (addr) => ({ reserve: async (usd) => { vus.factures.push(['reserve', addr, usd]); return { ok: true, jeton: usd }; }, regle: async (j, usd) => { vus.factures.push(['regle', addr, usd]); } });
  const mk = () => P.cree({ embauche: () => embauche, cles: K, factuPour, cours: async () => 0.0001, dossier: dos });
  const G = mk();
  const URL1 = 'https://x402factory.ai/solana/coinprice';

  console.log('\n-- la permission : eteinte par defaut --');
  const r0 = await G.paie(cle, { url: URL1 }, 'idem-0001');
  ok(r0.code === 403 && /payments are off for this key/.test(r0.corps.raison) && !vus.appels.length, 'une cle neuve ne paie rien : la permission est a activer par le proprietaire');
  ok(!K.fixePaiement('0xautre', cle.id, { actif: true, maxAppelUsd: 0.05 }).ok, 'seul le proprietaire de la cle fixe sa politique');
  ok(K.fixePaiement(PROPRIO, cle.id, { actif: true, maxAppelUsd: 0.5 }).code === 400, 'plafond par appel au-dessus de 0,10 $ (celui de l embauche) : refuse');
  ok(K.fixePaiement(PROPRIO, cle.id, { actif: true, maxAppelUsd: 0.05, hotes: ['x402factory.ai'] }).ok && K.liste(PROPRIO)[0].paiements.hotes.join() === 'x402factory.ai', 'activee : 0,05 $ par appel, un seul site autorise');

  console.log('\n-- payer --');
  ok((await G.paie(cle, { url: URL1 }, 'court')).code === 400, 'sans Idempotency-Key valable : refuse avant tout');
  const r1 = await G.paie(cle, { url: URL1, query: { symbol: 'SOL' } }, 'idem-0002');
  ok(r1.code === 200 && r1.corps.ok && r1.corps.recu.tx === '5Tx' && r1.corps.resultat === '{"price":119.5}', 'paye : la reponse du service et le recu');
  ok(vus.appels[0].qui === cle.addr && vus.appels[0].a.maxUsd === 0.05, 'au nom du proprietaire de la cle, avec SON plafond par appel');
  ok(K.liste(PROPRIO)[0].depenseAujourdhui === 110, 'le plafond du jour de la cle compte la depense : 0,011 $ au cours 0,0001 = 110 $SWOGE');
  const r2 = await G.paie(cle, { url: URL1, query: { symbol: 'SOL' } }, 'idem-0002');
  ok(r2.code === 200 && r2.corps.rejoue && vus.appels.length === 1, 'la meme Idempotency-Key : la meme reponse, aucun second paiement');
  ok((await mk().paie(cle, { url: URL1 }, 'idem-0002')).corps.rejoue && vus.appels.length === 1, 'et apres un redemarrage aussi');
  ok((await G.paie(cle, { url: 'https://autre.example/api' }, 'idem-0003')).code === 403 && vus.appels.length === 1, 'un site hors de la liste : refuse, rien appele');
  ok((await G.paie(cle, { url: 'http://x402factory.ai/x' }, 'idem-0004')).code === 400, 'http en clair : refuse');
  const r5 = await G.paie(cle, { url: URL1, max_usd: 0.005 }, 'idem-0005');
  ok(r5.code === 402 && /per-call cap/.test(r5.corps.raison) && vus.appels[vus.appels.length - 1].a.maxUsd === 0.005, 'max_usd de l agent, plus bas que la politique : c est lui qui compte');
  reponse = 500;
  const r6 = await G.paie(cle, { url: URL1 }, 'idem-0006');
  ok(r6.code === 402 && /not charged/.test(r6.corps.raison) && vus.factures[vus.factures.length - 1][2] === 0, 'le service echoue apres paiement : rien facture au proprietaire');
  reponse = 200;
  K.fixePaiement(PROPRIO, cle.id, { actif: true, maxAppelUsd: 0.1 });
  prix = 0.09;
  const cap = await G.paie(cle, { url: URL1 }, 'idem-0007');
  ok(cap.code === 402 && /daily spending cap/.test(cap.corps.raison), 'le plafond du jour de la cle ($SWOGE) : refuse avant de payer');

  console.log('\n-- l audit chaine --');
  const au = G.audit(PROPRIO);
  ok(au.lignes.length === 7 && au.chaine.ok && au.lignes.map((l) => l.statut).includes('paye'), 'chaque tentative, payee ou refusee, a sa ligne (les rejeux non : ils rendent l original) ; la chaine est intacte (' + au.lignes.length + ' lignes)');
  const l1 = au.lignes.find((l) => l.statut === 'paye');
  ok(!JSON.stringify(au).includes('119.5') && !JSON.stringify(au).includes('SOL"') && /^[0-9a-f]{64}$/.test(l1.requete) && /^[0-9a-f]{64}$/.test(l1.reponse), 'la requete et la reponse ne sont gardees qu en empreintes');
  ok(r1.corps.audit.h === l1.h, 'la reponse de l agent porte l empreinte de SA ligne d audit');
  const brut = fs.readFileSync(path.join(dos, 'passerelle_audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  brut[2].usd = 0.0001;
  const v = P.verifie(brut);
  ok(!v.ok && v.casseA === brut[2].seq, 'une ligne modifiee sur le disque : la chaine le dit, et a quelle ligne');
  ok(mk().audit(PROPRIO).chaine.ok && mk().audit(PROPRIO).lignes.length === 7, 'relue apres redemarrage : les memes lignes, chaine intacte');
  ok(G.audit('0xpersonne').lignes.length === 0, 'un autre proprietaire ne voit rien');

  console.log('\n-- le serveur --');
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const bp = srv.slice(srv.indexOf("if (path === '/agentic/pay') {"), srv.indexOf("if (path === '/agentic/audit') {"));
  ok(/if \(!cle\) return json\(401/.test(bp) && /passerelle\(\)\.paie\(cle, q, req\.headers\['idempotency-key'\]\)/.test(bp) && !/session/.test(bp.replace(/\/\*[\s\S]*?\*\//g, '')),
     '/agentic/pay : avec la CLE seulement (jamais une session), et son Idempotency-Key');
  const ip = srv.indexOf('/paiements$/.test(path)'), avant = srv.lastIndexOf("if (!session) return json(401", ip);
  ok(ip > 0 && avant > 0 && avant > srv.lastIndexOf("if (path === '/agentic/recus')", ip) && /agenticCles\.fixePaiement\(session,/.test(srv.slice(ip, ip + 400)),
     'la permission de payer : la SESSION du proprietaire seulement, apres le refus des cles');
  ok(/'access-control-allow-headers': 'content-type, authorization, x-api-key, payment-signature, idempotency-key'/.test(srv), 'un navigateur peut envoyer l Idempotency-Key');

  fs.rmSync(dos, { recursive: true, force: true });
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
