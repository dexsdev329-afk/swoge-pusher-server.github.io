'use strict';
/* TOR / .onion — veille dark-web DEFENSIVE, lecture seule.
 *
 * Sans demon Tor, rien ne sort : on teste avec un faux socket (injecte) qui
 * REJOUE le handshake SOCKS5 et une reponse HTTP. Ce qu'on verifie :
 *   - desactive sans TOR_SOCKS ;
 *   - la meme garde que le bug bounty (refus sans attestation, ok avec le texte exact) ;
 *   - un hote qui n'est pas .onion est refuse ;
 *   - le handshake SOCKS5 est correct et le corps est lu ;
 *   - lecture seule : la requete ecrite est un GET (jamais POST/PUT).
 *
 * Intention : rien ne part sans Tor ET sans autorisation ; jamais d'ecriture.
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-'));
delete process.env.TOR_SOCKS;

const bb = require('./bugbounty');
const tor = require('./tor');

let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

const ONION = 'abcdefghij234567abcdefghij234567abcdefghij234567abcdefgh.onion'; // 56 base32
const ATT = { autorise: true, texte: bb.ATTESTATION_TEXTE, qui: 'enzo' };

/* Un faux socket qui parle SOCKS5 : il repond au greeting, puis au CONNECT,
   puis sert une reponse HTTP. Il NOTE tout ce qu'on lui ecrit. */
function fauxSocket() {
  const s = new EventEmitter();
  s.ecrit = [];
  s.destroyed = false;
  s.write = (buf) => {
    s.ecrit.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (b.length >= 3 && b[0] === 0x05 && b[2] === 0x00 && b.length <= 4) {        /* greeting */
      setImmediate(() => s.emit('data', Buffer.from([0x05, 0x00])));
    } else if (b[0] === 0x05 && b[1] === 0x01 && b[3] === 0x03) {                   /* CONNECT */
      setImmediate(() => s.emit('data', Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
    } else if (/^GET /.test(b.toString('ascii', 0, 4))) {                          /* la requete HTTP */
      setImmediate(() => { s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<title>hidden</title>no swoge here')); s.emit('end'); });
    }
    return true;
  };
  s.destroy = () => { s.destroyed = true; };
  setImmediate(() => s.emit('connect'));
  return s;
}

(async () => {
  console.log('-- 1. desactive sans TOR_SOCKS --');
  ok(!tor.disponible(), 'sans TOR_SOCKS : Tor n est pas disponible');
  let r = await tor.litOnion('http://' + ONION + '/', { attestation: ATT });
  ok(!r.ok && /Tor is not configured/.test(r.raison), 'et litOnion refuse en le disant, sans rien tenter');

  process.env.TOR_SOCKS = '127.0.0.1:9050';
  ok(tor.disponible() && tor.proxy().port === 9050, 'avec TOR_SOCKS : disponible, proxy lu');

  console.log('\n-- 2. la garde d autorisation (comme le bug bounty) --');
  let sockets = 0;
  const deps = { connect: () => { sockets++; return fauxSocket(); } };
  r = await tor.litOnion('http://' + ONION + '/', {}, deps);
  ok(!r.ok && /tick the authorization box/.test(r.raison) && sockets === 0, 'sans attestation : refus, et AUCUN socket ouvert');
  r = await tor.litOnion('http://' + ONION + '/', { attestation: { autorise: true, texte: 'je sais' } }, deps);
  ok(!r.ok && /does not match/.test(r.raison) && sockets === 0, 'attestation au mauvais texte : refus, aucun socket');

  console.log('\n-- 3. un hote qui n est pas .onion est refuse --');
  r = await tor.litOnion('http://example.com/', { attestation: ATT }, deps);
  ok(!r.ok && /not a \.onion/.test(r.raison) && sockets === 0, 'un domaine clair n est pas accepte par le lecteur .onion');
  r = await tor.litOnion('https://' + ONION + '/', { attestation: ATT }, deps);
  ok(!r.ok && /only http/.test(r.raison), 'https .onion : dit non (TLS a envelopper, pas encore)');

  console.log('\n-- 4. handshake SOCKS5 + lecture, en GET seulement --');
  r = await tor.litOnion('http://' + ONION + '/forum?q=swoge', { attestation: ATT }, deps);
  ok(r.ok && r.statut === 200 && /hidden/.test(r.corps), 'la page est lue a travers le proxy (statut 200, corps rendu)');

  console.log('\n-- 5. lecture seule : la requete est un GET --');
  let vueGet = false, vueEcriture = false;
  const deps2 = { connect: () => { const s = fauxSocket(); const w = s.write; s.write = (b) => { const t = Buffer.isBuffer(b) ? b.toString('ascii', 0, 5) : String(b).slice(0, 5); if (/^GET /.test(t)) vueGet = true; if (/^(POST|PUT|DELE)/.test(t)) vueEcriture = true; return w(b); }; return s; } };
  r = await tor.litOnion('http://' + ONION + '/', { attestation: ATT }, deps2);
  ok(vueGet && !vueEcriture, 'la seule requete applicative est un GET — aucune ecriture n est emise');

  console.log('\n-- 6. l attestation est journalisee --');
  const f = path.join(process.env.DATA_DIR, 'bugbounty', 'attestations.jsonl');
  ok(fs.existsSync(f) && /tor/.test(fs.readFileSync(f, 'utf8')) && /enzo/.test(fs.readFileSync(f, 'utf8')), 'chaque lecture .onion attestee est journalisee (via tor)');

  console.log('\n' + (rates ? 'RATES : ' + rates + '/' + n : 'VERIFICATIONS : ' + n + ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('RATE ' + (e && e.stack || e)); process.exit(1); });
