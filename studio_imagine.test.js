'use strict';
/* ============================================================================
 * LE BOUTON MAGIQUE (studio_imagine.js)
 * La requete porte les images de reference, ce qui est pose et le brouillon ;
 * la reponse est une scene nue ; un joueur est borne par jour, et un echec ne
 * consomme pas sa journee ; sans client, rien ne part.
 * ==========================================================================*/
const I = require('./studio_imagine');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

(async () => {
  const vus = [];
  let repond = () => ({ content: [{ type: 'text', text: '"SWOGE bursts into the gym and says \\"Let\'s go!\\""' }], usage: { input_tokens: 5000, output_tokens: 120 } });
  const client = { messages: { create: async (o) => { vus.push(o); return repond(o); } } };
  process.env.IMAGINE_PAR_JOUR = '2';
  const im = I.cree({ client });
  const prod = { mode: 'serie', titre: 'Gym Wars', format: '9:16', style: 'anime',
                 personnages: [{ nom: 'SWOGE', description: 'the swole shiba' }, { nom: 'Rex', description: 'a grey cat, the rival' }] };
  const r = await im.imagine({ addr: '0xa', prod, texte: 'rex challenges swoge', images: ['data:image/jpeg;base64,AAAA', 'data:image/png;base64,BBBB', 'pas une image'] });
  const c = vus[0].messages[0].content;
  ok(vus[0].model === 'claude-haiku-4-5' && c.filter((x) => x.type === 'image').length === 2 && c[0].source.media_type === 'image/jpeg', 'Haiku regarde les images de reference (2 valides sur 3)');
  const txt = c[c.length - 1].text;
  ok(/Gym Wars/.test(txt) && /SWOGE \(picture 1\) — the swole shiba/.test(txt) && /Rex \(picture 2\)/.test(txt) && /Visual style: anime/.test(txt) && /Player's draft: rex challenges swoge/.test(txt),
     'et lit ce qui est pose : titre, personnages avec leur image, style, brouillon du joueur');
  ok(r.ok && r.texte.startsWith('SWOGE bursts') && !/^"/.test(r.texte), 'la scene revient nue, sans guillemets autour');
  ok(Math.abs(r.coutUsd - 0.0056) < 1e-9 && im.MESURE.coutUsd === r.coutUsd, 'son cout est compte : 5 000 × 1 $ + 120 × 5 $ par million = 0,0056 $');
  process.env.IMAGINE_PAR_JOUR = '10';
  await im.imagine({ addr: '0xc', prod, texte: '', histoire: ['SWOGE sits at the poker table', 'SWOGE goes all-in'] });
  const h = vus[vus.length - 1].messages[0].content.slice(-1)[0].text;
  ok(/Story so far/.test(h) && /Scene 2: SWOGE goes all-in/.test(h) && /Write the next scene/.test(h) && /write the NEXT scene/.test(vus[vus.length - 1].system),
     'avec des scenes deja tournees, le bouton ecrit la SUITE (histoire envoyee)');
  ok(/name the characters/.test(I.SYSTEME) && /camera move/.test(I.SYSTEME), 'et il nomme les personnages, avec un mouvement de camera');
  process.env.IMAGINE_PAR_JOUR = '2';
  const pub = im.decrit({ mode: 'pub', titre: 'Shaker', produit: { nom: 'Swole Shaker', slogan: 'Get swole.', presentateur: 'swoge', presentateurNom: 'SWOGE' } });
  ok(/Product: Swole Shaker \(picture 1\)/.test(pub) && /Presenter: SWOGE \(picture 2\)/.test(pub), 'une pub decrit son produit et son presentateur');

  repond = () => { throw new Error('overloaded'); };
  const ko = await im.imagine({ addr: '0xa', prod, texte: '' });
  ok(!ko.ok && ko.code === 502 && !/overloaded/.test(ko.raison), 'une panne rend une phrase pour le joueur, pas l erreur brute');
  repond = () => ({ content: [{ type: 'text', text: 'Rex flexes.' }], usage: {} });
  ok((await im.imagine({ addr: '0xa', prod })).ok, 'et elle ne consomme pas la journee (2e idee acceptee)');
  const trop = await im.imagine({ addr: '0xa', prod });
  ok(!trop.ok && trop.code === 429, 'au-dela de IMAGINE_PAR_JOUR, refuse (429) sans appel : ' + trop.raison);
  ok((await im.imagine({ addr: '0xb', prod })).ok, 'un autre portefeuille a sa propre journee');
  const sans = I.cree({});
  ok((await sans.imagine({ addr: '0xa', prod })).code === 503, 'sans cle Anthropic : 503, rien ne part');
  delete process.env.IMAGINE_PAR_JOUR;
  console.log('\nVERIFICATIONS : ' + n + (rates ? '  —  RATES : ' + rates + '/' + n : '  —  tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error('ESSAI CASSE :', e); process.exit(1); });
