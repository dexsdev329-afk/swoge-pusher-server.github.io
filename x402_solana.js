/* ==========================================================================
 * PAYER UN APPEL x402 EN USDC SUR SOLANA, SANS BIBLIOTHEQUE
 *
 * Demande du proprietaire, 27 septembre 2026 : payer aussi sur Solana depuis
 * la page de test (Phantom, Solflare, Backpack), pour que les fiches du
 * catalogue PayAI portent Solana. Ce fichier construit la transaction EXACTE
 * du client de reference x402 (@x402/svm, exact/client/scheme.ts, relu le
 * 27/09) :
 *   1. ComputeBudget SetComputeUnitLimit (20 000, DEFAULT_COMPUTE_UNIT_LIMIT)
 *   2. ComputeBudget SetComputeUnitPrice (1 microlamport, DEFAULT_…_PRICE)
 *   3. spl-token TransferChecked : compte USDC du payeur → compte USDC de
 *      payTo, montant du 402, 6 decimales, signe par le payeur
 *   4. Memo : 16 octets aleatoires en hexadecimal (l'unicite du paiement)
 * en transaction versionnee v0, feePayer = extra.feePayer du 402 (le
 * facilitateur paie les frais et signe en dernier). Le portefeuille signe par
 * le Wallet Standard (« solana:signTransaction », octets en entree et en
 * sortie) : la page ne voit jamais de cle.
 * Les comptes associes (ATA) : meme derivation que solana_ata.js du serveur,
 * verifiee contre @solana/web3.js 1.99.0 (x402_solana.test.js).
 * ======================================================================== */
(function (racine) {
  "use strict";
  var ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var PROG = {
    jeton: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    ata: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    budget: "ComputeBudget111111111111111111111111111111",
    memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
  };
  var LIMITE_CU = 20000, PRIX_CU = 1, DECIMALES_USDC = 6;

  function b58enc(o) {
    var z = 0; while (z < o.length && o[z] === 0) z++;
    var n = 0n; for (var i = 0; i < o.length; i++) n = (n << 8n) | BigInt(o[i]);
    var s = ""; while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
    return "1".repeat(z) + s;
  }
  function b58dec(s) {
    s = String(s || "");
    var n = 0n, z = 0;
    while (z < s.length && s[z] === "1") z++;
    for (var i = 0; i < s.length; i++) { var k = ALPHA.indexOf(s[i]); if (k < 0) throw new Error("not base58"); n = n * 58n + BigInt(k); }
    var o = []; while (n > 0n) { o.unshift(Number(n & 255n)); n >>= 8n; }
    while (z-- > 0) o.unshift(0);
    return new Uint8Array(o);
  }
  function cle(adr) { var o = b58dec(adr); if (o.length !== 32) throw new Error("not a Solana address: " + adr); return o; }

  /* ed25519 : un point valide ? (RFC 8032 §5.1.3, comme PublicKey.isOnCurve) */
  var P = (1n << 255n) - 19n;
  function puiss(b, e) { var r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; }
  var D = ((-121665n * puiss(121666n, P - 2n)) % P + P) % P, RM1 = puiss(2n, (P - 1n) / 4n);
  function surLaCourbe(o) {
    var y = 0n; for (var i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? o[i] & 0x7f : o[i]);
    if (y >= P) return false;
    var y2 = y * y % P, u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;
    var v3 = v * v % P * v % P, v7 = v3 * v3 % P * v % P;
    var x = u * v3 % P * puiss(u * v7 % P, (P - 5n) / 8n) % P, vx2 = v * x % P * x % P;
    if (vx2 === u) { /* bon */ } else if (vx2 === (P - u) % P) x = x * RM1 % P; else return false;
    return !(x === 0n && (o[31] >> 7) === 1);
  }
  function concat(l) { var n = 0, i; for (i = 0; i < l.length; i++) n += l[i].length; var r = new Uint8Array(n), k = 0; for (i = 0; i < l.length; i++) { r.set(l[i], k); k += l[i].length; } return r; }
  function sha256(o) { return racine.crypto.subtle.digest("SHA-256", o).then(function (h) { return new Uint8Array(h); }); }

  /** Le compte USDC associe (programme jeton classique) de `proprietaire`. */
  function ata(proprietaire, mint) {
    var graines = concat([cle(proprietaire), cle(PROG.jeton), cle(mint)]);
    var fin = concat([cle(PROG.ata), new TextEncoder().encode("ProgramDerivedAddress")]);
    function essai(b) {
      if (b < 0) return Promise.reject(new Error("no program address"));
      return sha256(concat([graines, new Uint8Array([b]), fin])).then(function (h) { return surLaCourbe(h) ? essai(b - 1) : b58enc(h); });
    }
    return essai(255);
  }

  function cu16(n) { var o = []; for (;;) { var b = n & 0x7f; n >>= 7; if (!n) { o.push(b); return o; } o.push(b | 0x80); } }
  function le(n, octets) { var o = new Uint8Array(octets), v = BigInt(n); for (var i = 0; i < octets; i++) { o[i] = Number(v & 255n); v >>= 8n; } return o; }
  function hexAleatoire(n) { var a = new Uint8Array(n); racine.crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }

  /**
   * La transaction non signee (octets du format de fil : 2 signatures vides +
   * message v0) pour l'offre Solana `acc` du 402. { payeur, blockhash, memo? }.
   */
  function construit(acc, o) {
    var fee = acc && acc.extra && acc.extra.feePayer;
    if (!fee) return Promise.reject(new Error("the payment request has no feePayer"));
    if (!/^[0-9]+$/.test(String(acc.amount))) return Promise.reject(new Error("bad amount"));
    return Promise.all([ata(o.payeur, acc.asset), ata(acc.payTo, acc.asset)]).then(function (l) {
      var source = l[0], dest = l[1];
      /* Les comptes, dans l'ordre du format : signataires modifiables (le
         feePayer d'abord), signataires en lecture, modifiables, lecture seule ;
         a l'interieur, l'ordre d'apparition — celui de compileToV0Message,
         pour des octets identiques a ceux de web3.js. */
      /* Payeur = payTo (le proprietaire qui se paie, 27/09) : un seul compte
         USDC, liste UNE fois — un compte en double rend la transaction
         invalide (« invalid_exact_svm_transaction_simulation_failed »). */
      var modifiables = source === dest ? [source] : [source, dest];
      /* sansMemo : 3 instructions. Phantom ajoute jusqu'a 3 instructions
         Lighthouse ; un facilitateur plafonne a 6 (avant x402 #2097) refuse
         alors 4 + 3 = 7 (« smart_wallet_program_not_allowed », 27/09). Le mémo
         n'est verifie que si le 402 porte extra.memo. */
      var sansMemo = !!o.sansMemo && !(acc.extra && acc.extra.memo);
      var lecture = sansMemo ? [PROG.budget, PROG.jeton, acc.asset] : [PROG.budget, PROG.jeton, acc.asset, PROG.memo];
      var comptes = [fee, o.payeur].concat(modifiables, lecture);
      var ix = function (a) { return comptes.indexOf(a); };
      var memo = new TextEncoder().encode(o.memo || (acc.extra && acc.extra.memo) || hexAleatoire(16));
      var instr = [
        { p: ix(PROG.budget), a: [], d: concat([new Uint8Array([2]), le(LIMITE_CU, 4)]) },
        { p: ix(PROG.budget), a: [], d: concat([new Uint8Array([3]), le(PRIX_CU, 8)]) },
        { p: ix(PROG.jeton), a: [ix(source), ix(acc.asset), ix(dest), ix(o.payeur)], d: concat([new Uint8Array([12]), le(acc.amount, 8), new Uint8Array([DECIMALES_USDC])]) },
        { p: ix(PROG.memo), a: [], d: memo }
      ];
      if (sansMemo) instr.pop();
      var parties = [new Uint8Array([0x80, 2, 1, lecture.length]), new Uint8Array(cu16(comptes.length))];
      comptes.forEach(function (c) { parties.push(cle(c)); });
      parties.push(cle(o.blockhash));
      parties.push(new Uint8Array(cu16(instr.length)));
      instr.forEach(function (i) {
        parties.push(new Uint8Array([i.p].concat(cu16(i.a.length)).concat(i.a).concat(cu16(i.d.length))));
        parties.push(i.d);
      });
      parties.push(new Uint8Array([0]));                      /* aucune table d'adresses */
      var message = concat(parties);
      return { octets: concat([new Uint8Array([2]), new Uint8Array(128), message]), message: message, source: source, dest: dest };
    });
  }

  /* Ce que le portefeuille a RENDU (il peut ajouter des instructions) : le
     nombre et le programme de chaque instruction, pour le dire au joueur. */
  var NOMS = { ComputeBudget111111111111111111111111111111: "ComputeBudget", TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "Token",
    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022", MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo", L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse" };
  function lit(o) {
    var k = 0;
    function u16() { var n = 0, d = 0, b; do { b = o[k++]; n |= (b & 0x7f) << d; d += 7; } while (b & 0x80); return n; }
    var nSig = u16(); k += 64 * nSig;
    var v0 = (o[k] & 0x80) !== 0; if (v0) k++;
    k += 3;
    var nCles = u16(), cles = [];
    for (var i = 0; i < nCles; i++) { cles.push(b58enc(o.slice(k, k + 32))); k += 32; }
    k += 32;
    var nIx = u16(), progs = [];
    for (var j = 0; j < nIx; j++) {
      var p = o[k++]; var na = u16(); k += na; var nd = u16(); k += nd;
      progs.push(p < cles.length ? (NOMS[cles[p]] || cles[p].slice(0, 6) + "…") : "table");
    }
    var tables = v0 ? u16() : 0;
    return { signatures: nSig, version: v0 ? 0 : "legacy", programmes: progs, tables: tables };
  }

  function b64(o) { var s = ""; for (var i = 0; i < o.length; i++) s += String.fromCharCode(o[i]); return racine.btoa(s); }

  var api = { b58enc: b58enc, b58dec: b58dec, surLaCourbe: surLaCourbe, ata: ata, construit: construit, lit: lit, b64: b64, PROG: PROG, LIMITE_CU: LIMITE_CU, PRIX_CU: PRIX_CU };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else racine.SwogeSolana = api;
})(typeof window !== "undefined" ? window : globalThis);
