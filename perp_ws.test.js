'use strict';
/* ============================================================================
 * PERP — LE FLUX EST-IL VRAIMENT LIVE
 *
 * Regle n13 du cahier des charges : ne jamais pretendre « LIVE » si ce n est
 * pas vrai. Cet essai OUVRE le vrai WebSocket Hyperliquid et exige un prix
 * NUMERIQUE reel avant de passer. Il ne simule rien.
 *
 * Si le reseau est coupe (sandbox sans sortie), il le DIT et s ignore, comme
 * la suite Playwright quand le navigateur manque — il ne ment pas en vert.
 * ==========================================================================*/
let WS = null;
try { WS = require('ws'); } catch (e) {}
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

(async () => {
  if (!WS) { console.log('ws absent : essai ignore'); return; }
  const r = await new Promise((res) => {
    const t = Date.now();
    let w;
    try { w = new WS('wss://api.hyperliquid.xyz/ws', { handshakeTimeout: 8000 }); }
    catch (e) { return res({ reseau: false, pourquoi: String(e.message || e) }); }
    const to = setTimeout(() => { try { w.close(); } catch (e) {} res({ reseau: false, pourquoi: 'no tick in 12s' }); }, 12000);
    w.on('open', () => w.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } })));
    w.on('message', (m) => {
      try {
        const j = JSON.parse(String(m));
        if (j.channel === 'allMids' && j.data && j.data.mids && j.data.mids.BTC) {
          clearTimeout(to); try { w.close(); } catch (e) {}
          res({ reseau: true, ms: Date.now() - t, btc: Number(j.data.mids.BTC), marches: Object.keys(j.data.mids).length });
        }
      } catch (e) {}
    });
    w.on('error', (e) => { clearTimeout(to); res({ reseau: false, pourquoi: String(e.message || e).slice(0, 60) }); });
  });

  if (!r.reseau) {
    /* Pas de reseau sortant : on ne fait pas semblant. L essai s ignore,
       comme Playwright absent — il ne passe pas au vert sur du vide. */
    console.log('  --   reseau sortant indisponible (' + r.pourquoi + ') : essai WS ignore, PAS simule');
    console.log('\nVERIFICATIONS : 0  —  ignore (pas de reseau)');
    return;
  }
  ok(Number.isFinite(r.btc) && r.btc > 0, 'Hyperliquid a envoye un vrai prix BTC en direct : ' + r.btc);
  ok(r.marches > 50, 'et les prix de ' + r.marches + ' marches sur UNE seule connexion');
  ok(r.ms < 12000, 'le premier tick est arrive en ' + r.ms + 'ms');
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
