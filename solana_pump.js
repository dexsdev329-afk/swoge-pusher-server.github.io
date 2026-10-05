'use strict';
/* ==================================================================
 * LANCER UN TOKEN SUR SOLANA — via Pump.fun (API locale PumpPortal)
 * ==================================================================
 *
 * Demande du proprietaire (05/10/2026) : « une option pour lancer des tokens sur
 * Solana aussi ». Choix : Pump.fun, l'API LOCALE de PumpPortal — NON CUSTODIALE.
 * Le createur signe avec SON portefeuille Solana (Phantom) ; on ne detient aucune
 * cle. Ce module ne fait que PREPARER (comme lancement_v4 : l'agent prepare, le
 * portefeuille signe) :
 *
 *   1. metadataIpfs(...) : telementverse l'image + les infos sur pump.fun/api/ipfs
 *      (multipart) → une metadataUri.
 *   2. offreCreation(...) : demande a pumpportal.fun/api/trade-local la transaction
 *      « create » (serialisee), que la PAGE signera avec la cle du mint (generee
 *      cote navigateur) + le portefeuille du createur, puis enverra a un noeud Solana.
 *
 * On ne touche AUCUNE cle : le mint est genere dans le navigateur, le portefeuille
 * signe dans le navigateur. Ici on ne fait que relayer deux appels (et eviter le
 * CORS cote page). `fetch` est injectable : aucun essai ne sort de la machine.
 *
 * API verifiee a la source (pumpportal.fun/creation, 05/10) :
 *   POST https://pump.fun/api/ipfs          (multipart: file,name,symbol,description,twitter,telegram,website,showName) → { metadataUri }
 *   POST https://pumpportal.fun/api/trade-local  JSON { publicKey, action:'create', tokenMetadata:{name,symbol,uri}, mint, denominatedInSol:'true', amount, slippage, priorityFee, pool:'pump' } → octets d'une VersionedTransaction
 * ================================================================== */

const IPFS = 'https://pump.fun/api/ipfs';
const TRADE_LOCAL = 'https://pumpportal.fun/api/trade-local';

/* Une adresse Solana : base58, 32-44 caracteres (pas 0, O, I, l). */
const estPubkeySol = (a) => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const txt = (s, n) => String(s == null ? '' : s).slice(0, n || 200);

/** Telementverse l'image + les infos vers pump.fun IPFS. Rend { ok, metadataUri } ou { ok:false, raison }.
 *  o : { name, symbol, description?, twitter?, telegram?, website?, image: Buffer, imageType? } */
async function metadataIpfs(o, deps) {
  o = o || {}; deps = deps || {};
  const f = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, raison: 'no fetch available' };
  if (!o.name || !o.symbol) return { ok: false, raison: 'name and symbol are required' };
  if (!o.image || !o.image.length) return { ok: false, raison: 'an image is required for a Pump.fun token' };
  const FD = deps.FormData || (typeof FormData === 'function' ? FormData : null);
  const BlobC = deps.Blob || (typeof Blob === 'function' ? Blob : null);
  if (!FD || !BlobC) return { ok: false, raison: 'FormData/Blob not available (Node 18+ required)' };
  const fd = new FD();
  fd.append('file', new BlobC([o.image], { type: o.imageType || 'image/png' }), 'image.png');
  fd.append('name', txt(o.name, 32));
  fd.append('symbol', txt(o.symbol, 10));
  fd.append('description', txt(o.description, 500));
  fd.append('twitter', txt(o.twitter, 200));
  fd.append('telegram', txt(o.telegram, 200));
  fd.append('website', txt(o.website, 200));
  fd.append('showName', 'true');
  let r; try { r = await f(IPFS, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) }); }
  catch (e) { return { ok: false, raison: 'could not reach pump.fun IPFS' }; }
  const j = await r.json().catch(() => ({}));
  const uri = j.metadataUri || (j.metadata && j.metadata.uri) || null;
  if (!r.ok || !uri) return { ok: false, raison: 'pump.fun IPFS did not return a metadata URI (HTTP ' + r.status + ')' };
  return { ok: true, metadataUri: uri };
}

/** Demande la transaction « create » serialisee. Rend { ok, txBase64 } ou { ok:false, raison }.
 *  o : { publicKey, mint, name, symbol, uri, devBuySol?, slippage?, priorityFee? } */
async function offreCreation(o, deps) {
  o = o || {}; deps = deps || {};
  const f = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, raison: 'no fetch available' };
  if (!estPubkeySol(o.publicKey)) return { ok: false, raison: 'a valid Solana wallet address is required' };
  if (!estPubkeySol(o.mint)) return { ok: false, raison: 'a valid mint address is required' };
  if (!o.name || !o.symbol || !o.uri) return { ok: false, raison: 'name, symbol and metadata uri are required' };
  const devBuy = Number(o.devBuySol);
  const corps = {
    publicKey: o.publicKey, action: 'create',
    tokenMetadata: { name: txt(o.name, 32), symbol: txt(o.symbol, 10), uri: String(o.uri) },
    mint: o.mint, denominatedInSol: 'true',
    amount: devBuy > 0 ? devBuy : 0,                 /* achat initial du createur, en SOL (0 = aucun) */
    slippage: Number(o.slippage) > 0 ? Number(o.slippage) : 10,
    priorityFee: Number(o.priorityFee) >= 0 ? Number(o.priorityFee) : 0.00001,
    pool: 'pump',
  };
  let r; try { r = await f(TRADE_LOCAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corps), signal: AbortSignal.timeout(30000) }); }
  catch (e) { return { ok: false, raison: 'could not reach PumpPortal' }; }
  if (!r.ok) { const t = await r.text().catch(() => ''); return { ok: false, raison: 'PumpPortal HTTP ' + r.status + (t ? ' — ' + t.slice(0, 140) : '') }; }
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(new Uint8Array(ab));
  if (!buf.length) return { ok: false, raison: 'PumpPortal returned an empty transaction' };
  return { ok: true, txBase64: buf.toString('base64') };
}

module.exports = { metadataIpfs, offreCreation, estPubkeySol, IPFS, TRADE_LOCAL };
