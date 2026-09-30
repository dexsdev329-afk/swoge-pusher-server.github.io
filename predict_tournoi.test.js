'use strict';
/* predict_tournoi.js : le tournoi des strategies sur les vrais rounds PancakeSwap (30/09/2026).
   Ce que l essai tient : aucune strategie ne lit ce qu elle n aurait pas su avant le lock
   (l issue de e − 1, les pools de e) ; le gain est celui des pools finaux, mise diluee ; la regle
   des 500 ; seuls les rounds du DIRECT jugent ; l etat se relit du journal et garde son depart. */
const fs = require('fs'), os = require('os'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'predict-tournoi-'));
const T = require('./predict_tournoi');
const J = require('./predict_pancake_journal');
let n = 0, rates = 0;
const ok = (c, m) => { n++; if (c) console.log('  ok   ' + m); else { rates++; console.log('  RATE ' + m); } };

/* Des rounds synthetiques coherents : le prix de close de e est le prix de lock de e + 1. */
let graine = 11; const alea = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
function rounds(nb, gagnant) {
  const px = [60000000000]; for (let i = 1; i <= nb + 1; i++) px.push(Math.round(px[i - 1] * (1 + (alea() - 0.5) * 0.004)));
  const L = [];
  for (let i = 0; i < nb; i++) {
    let lp = px[i], cp = px[i + 1];
    if (gagnant) { cp = gagnant === 'BULL' ? lp + 1000 : lp - 1000; }
    const bull = 0.5 + alea() * 2, bear = 0.5 + alea() * 2;
    L.push({ ep: 1000 + i, lock: 1790000000 + 300 * i, lp: String(lp), cp: String(cp), tot: bull + bear, bull, bear, oc: true });
  }
  return L;
}

console.log('-- 1. les strategies --');
ok(T.STRATEGIES.length === 299 && new Set(T.STRATEGIES.map((s) => s.id)).size === 299, '299 strategies, identifiants uniques (296 + 3 temoins)');
ok(T.STRATEGIES.filter((s) => s.temoin).map((s) => s.id).join() === 'bull,bear,piece', 'trois temoins sans signal : toujours BULL, toujours BEAR, pile ou face');
ok(Math.abs(T.barre(344) - 3.62) < 0.02, 'la barre : 3,62 pour 299 + 45 regles deja essayees sur ces rounds');

console.log('\n-- 2. rien du futur : ni l issue de e − 1, ni les pools de e --');
{
  const L = rounds(400);
  let lectures = 0, fuites = 0;
  for (let i = 20; i < 400; i += 7) {
    const e = L[i].ep, passe = L.slice(0, i).reverse();
    for (const s of T.STRATEGIES) {
      const a = T.camp(s.config, e, passe, L[i].lock);
      /* le close de e − 1 (son issue) n est pas connu a la decision ; les pools de e ne sont meme pas passes */
      const b = T.camp(s.config, e, passe.map((l, k) => (k === 0 ? Object.assign({}, l, { cp: String(Number(l.cp) * 2) }) : l)), L[i].lock);
      lectures++; if (a !== b) fuites++;
    }
  }
  ok(fuites === 0, lectures + ' decisions : changer l issue du round e − 1 (encore ouvert a la decision) ne change aucune decision');
  const e = L[50].ep, passe = L.slice(0, 50).reverse();
  const serie = T.STRATEGIES.find((s) => s.id === 'serie:1:suit');
  const attendu = J.gagnantDe(L[48]);
  ok(T.camp(serie.config, e, passe, L[50].lock) === attendu, 'une serie de 1 lit l issue de e − 2 (' + attendu + '), le dernier round ferme');
}

console.log('\n-- 3. le gain : les pools finaux, notre mise diluee, 3 %, le gaz reel --');
{
  const l = { ep: 5, lock: 1, lp: '100', cp: '101', tot: 3, bull: 1, bear: 2, oc: true };
  const x = J.rendement('BULL', l, 0.03, 0.002);
  ok(Math.abs(x.r - ((3.002 * 0.97) / 1.002 - 1 - 0.00002 / 0.002)) < 1e-12, 'BULL gagne a 1 contre 2 : cote (3,002 × 0,97)/1,002, moins le gaz');
  ok(J.rendement('BULL', Object.assign({}, l, { cp: '100' }), 0.03, 0.002).g === false, 'egalite lock = close : perdu (le contrat donne tout au tresor)');
}

console.log('\n-- 4. la regle des 500 --');
{
  const perd = { id: 'x', nom: 'toujours BEAR', config: { famille: 'bear' } };
  const gagne = { id: 'y', nom: 'toujours BULL', config: { famille: 'bull' } };
  const temoin = { id: 'z', nom: 'temoin BEAR', config: { famille: 'bear' }, temoin: true };
  const L = rounds(1600, 'BULL');
  const S = T.joue(L, null, [perd, gagne, temoin]);
  ok(S.get('x').retiree && S.get('x').retiree.n === 500 && S.get('x').c.n === 500, 'en perte a 500 paris : retiree a 500, plus aucun pari ensuite');
  ok(!S.get('y').retiree && S.get('y').palier === 2000 && S.get('y').c.n === 1600, 'en gain : rejugee a 1 000, 1 500, prochain palier 2 000');
  ok(!S.get('z').retiree && S.get('z').c.n === 1600, 'un temoin n est jamais retire, meme toujours perdant');
}

console.log('\n-- 5. seuls les rounds du direct jugent --');
{
  const gagne = { id: 'y', nom: 'toujours BULL', config: { famille: 'bull' } };
  const L = rounds(1400, 'BULL');
  const S = T.joue(L, 1000 + 1000, [gagne]);
  const V = T.vue(S, 2000, L.length, [gagne]);
  ok(V.survivors[0].history.n === 1400 && V.survivors[0].live.n === 400, '1 400 paris en tout, dont 400 en direct (a partir du round fixe au depart)');
  ok(V.survivors[0].proven === false && V.proven === 0, 'gagnante partout, mais 400 < 500 en direct : pas encore prouvee');
  const L2 = rounds(1600, 'BULL');
  const V2 = T.vue(T.joue(L2, 2000, [gagne]), 2000, L2.length, [gagne]);
  ok(V2.survivors[0].live.n === 600 && V2.proven === 1 && V2.survivors[0].proven, '600 en direct, t au-dessus de la barre, deux moities en gain : prouvee');
  ok(/LIVE rounds/.test(V2.rule) && V2.tested === 46 && V2.liveSinceEpoch === 2000, 'la vue dit la regle, le nombre essaye (1 + 45 avant), et depuis quel round on juge');
}

console.log('\n-- 5 bis. un t sur 2 paris ne passe pas devant un t sur 600 --');
{
  const rare = { id: 'r', nom: 'rare', config: { famille: 'elan', k: 1, x: 0.5, sens: 'suit' } };
  const frequente = { id: 'f', nom: 'frequente', config: { famille: 'bull' } };
  const L = rounds(700, 'BULL'); L[300].lp = '1'; L[301].lp = '1000000000000';   /* un seul enorme saut */
  const V = T.vue(T.joue(L, null, [rare, frequente]), null, L.length, [rare, frequente]);
  ok(V.survivors[0].id === 'f' && V.survivors[1].id === 'r' && V.survivors[1].history.n < 5, 'la strategie a 600+ paris d abord, celle a ' + V.survivors[1].history.n + ' pari(s) ensuite, quel que soit son t');
}

console.log('\n-- 6. relu du journal, depart fixe une fois --');
(async () => {
  const L = rounds(700);
  fs.writeFileSync(J.fichierRounds(), L.map((l) => JSON.stringify(l)).join('\n') + '\n' + JSON.stringify(L[5]) + '\n');
  await T.recalcule(1790300000000);
  const v = T.etat();
  ok(v.roundsRead === 700 && v.liveSinceEpoch === 1700 && v.running + v.retired === 296, '700 rounds relus (un doublon ignore), le direct commence au round suivant (1 700), 296 strategies jugees');
  const garde = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'predict_tournoi.json'), 'utf8'));
  ok(garde.depuisEp === 1700, 'le depart est garde sur le disque');
  fs.appendFileSync(J.fichierRounds(), JSON.stringify(Object.assign({}, L[0], { ep: 1700, lock: L[0].lock + 300 * 700 })) + '\n');
  T._reset(); T.tic(1790400000000);
  await new Promise((r) => setTimeout(r, 300));
  ok(T.etat().liveSinceEpoch === 1700 && T.etat().roundsRead === 701, 'un redemarrage relit le depart : le round 1 700 compte en direct, rien de deplace');
  ok(!JSON.stringify(T.etat()).includes('NaN'), 'aucun NaN dans la vue');
  console.log('\nVERIFICATIONS : ' + n + (rates ? ' — ' + rates + ' RATE(S)' : ' — tout passe'));
  process.exit(rates ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
