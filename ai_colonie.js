'use strict';
/* ============================================================================
 * LA COLONIE : ELLE S'ORGANISE ELLE-MEME
 *
 * « Faut vraiment qu'il récolte un maximum de données et qu'il soit
 *   intelligent. S'ils ont besoin de plus d'agents ils peuvent s'auto-
 *   développer, se multiplier, ou plus de maisons, ou un nouveau service.
 *   Ils peuvent changer l'ordre s'ils pensent que les services seraient mieux
 *   dans un autre ordre. Ils ont tous les droits dans ce monde. Mais leur
 *   objectif c'est réussir à augmenter les sous. »
 *
 * Trois libertes reelles, et une frontiere.
 *
 * ---- CE QU'ILS PEUVENT VRAIMENT FAIRE ----
 *
 * 1. CHANGER L'ORDRE. Les gardes ne sont plus enchaines dans le code : leur
 *    ordre est une donnee, et il est REVU sur ce qu'on a mesure. Chaque garde
 *    connait son taux de refus et ce que ses donnees coutent en appels. Celui
 *    qui refuse beaucoup pour pas cher passe devant — et comme les lectures
 *    sont paresseuses, un refus precoce fait ECONOMISER tous les appels des
 *    gardes suivants. Ce n'est pas un reglage cosmetique : c'est le nombre de
 *    jetons qu'on arrive a analyser par tour, et il se mesure.
 *
 * 2. SE MULTIPLIER. Un agent surveille sa propre memoire. Quand une de ses
 *    cases a beaucoup d'observations mais une VARIANCE enorme — tantot +40 %,
 *    tantot -30 % — cette case ne predit rien : la coupe est au mauvais
 *    endroit. L'agent engendre alors un specialiste qui recoupe cette case
 *    avec un autre trait. Le petit vit s'il fait mieux que son parent sur la
 *    meme case, et il est retire sinon. Sans cette condition, « ils se
 *    multiplient » finit en trois cents agents qui ne savent rien.
 *
 * 3. CHOISIR LEURS SERVICES. Chaque source porte son releve : essais,
 *    reponses, echecs. Une source qui cesse de repondre sort de la rotation et
 *    elle est NOMMEE a l'ecran. Une source qui n'a jamais rien rendu d'utile
 *    sur cette chaine est nommee aussi, plutot que passee sous silence.
 *
 * ---- ET LA FRONTIERE ----
 *
 * Ils ne peuvent pas ecrire de nouveaux vetos. Les regles de securite — le
 * honeypot, le porteur qui tient tout, le portefeuille qui fait tout le
 * volume, les bornes de mise du Banquier — sont dans le code, et aucun
 * apprentissage ne les desserre. Un systeme qui peut apprendre a lever sa
 * propre garde l'apprend toujours, et exactement une fois.
 *
 * De la meme facon, sa tresorerie est du PAPIER. Aucune transaction n'est
 * signee, et ce module n'a aucun chemin vers `state.json` : un defaut ici doit
 * pouvoir couter zero centime a qui que ce soit.
 *
 * ---- CE QU'IL NE FABRIQUE JAMAIS ----
 *
 * Une position s'ouvre au prix REEL lu a l'instant et se ferme au prix REEL
 * d'une lecture plus tard. Quand un service ne repond pas, le champ reste
 * INCONNU — et l'inconnu ne rapporte jamais de points a un jeton.
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FICHIER = path.join(cfg.DATA_DIR, 'ai_colonie.json');
const TMP = FICHIER + '.tmp';
/* ---------------------------------------------------------------- reglages */
/* ==========================================================================
 * GECKOTERMINAL : LIBRE, OU AVEC UNE CLE COINGECKO
 *
 * Les memes donnees, par trois portes differentes.
 *
 *   LIBRE      api.geckoterminal.com — sans cle, ~30 appels par minute PARTAGES
 *              entre tout le monde. C'est ce qu'on utilise par defaut, et ca
 *              marche : c'est ce qui a servi jusqu'ici.
 *   DEMO       api.coingecko.com/api/v3/onchain — entete `x-cg-demo-api-key`.
 *   PRO        pro-api.coingecko.com/api/v3/onchain — entete `x-cg-pro-api-key`.
 *
 * Une cle CoinGecko ne s'utilise PAS sur api.geckoterminal.com : ce domaine ne
 * la lit pas. Il faut passer par les points d'entree `/onchain` de CoinGecko —
 * c'est le meme service et la meme forme de reponse, donc rien d'autre ne
 * change dans ce fichier.
 *
 * ---- POURQUOI ON SONDE AU LIEU DE DEMANDER ----
 *
 * Une cle Demo et une cle Pro ne se distinguent pas a l'oeil, et se tromper de
 * porte donne un 401 qu'on lirait comme « la cle est mauvaise ». On essaie donc
 * les deux, UNE fois, et on retient celle qui a repondu. Le resultat est ecrit
 * dans le journal du serveur : sans ca, une cle Pro posee dans un compte Demo
 * ferait echouer chaque lecture sans que personne comprenne pourquoi.
 *
 * ---- ET LA CLE EST UN BONUS, JAMAIS UNE DEPENDANCE ----
 *
 * Si elle est refusee, epuisee, ou si le quota tombe en pleine journee, on
 * retombe sur l'acces libre — c'est-a-dire sur le comportement d'avant. Une
 * amelioration qui, en tombant, casse ce qui marchait avant n'est pas une
 * amelioration.
 * ======================================================================== */
const GT_LIBRE = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
const CG_DEMO = 'https://api.coingecko.com/api/v3/onchain/networks/robinhood';
const CG_PRO = 'https://pro-api.coingecko.com/api/v3/onchain/networks/robinhood';
const GT = GT_LIBRE;   /* le defaut, et le repli */

let cgPorte = null;    /* null = pas encore sonde ; 'demo' | 'pro' | 'libre' */
function cleCoingecko() { return (process.env.COINGECKO_API_KEY || '').trim(); }

async function sondeCoingecko() {
  const cle = cleCoingecko();
  if (!cle) { cgPorte = 'libre'; return cgPorte; }
  for (const [porte, base, entete] of [['demo', CG_DEMO, 'x-cg-demo-api-key'],
                                       ['pro', CG_PRO, 'x-cg-pro-api-key']]) {
    try {
      const r = await fetch(base + '/new_pools?page=1',
        { headers: Object.assign({}, ENTETES, { [entete]: cle }), signal: AbortSignal.timeout(12000) });
      /* ---- UN 429 N'EST PAS UN REFUS ----
       * Il veut dire que la cle est BONNE et qu'on va trop vite. La traiter
       * comme un refus ferait declarer « cle invalide » a une cle parfaitement
       * valide, et on la changerait pour rien. On retient donc la porte : les
       * lectures y passeront, et celles qui se font refuser retomberont une par
       * une sur l'acces libre, ce qui est le comportement voulu. */
      if (r.ok || r.status === 429) {
        cgPorte = porte;
        console.log('[ai] cle CoinGecko acceptee en ' + porte.toUpperCase()
          + (r.status === 429 ? ' (mais deja au quota a la premiere lecture)' : '')
          + ' — les lectures GeckoTerminal passent par ' + base);
        return cgPorte;
      }
    } catch (e) { /* on essaie l'autre porte */ }
  }
  cgPorte = 'libre';
  console.warn('[ai] COINGECKO_API_KEY posee mais refusee en Demo comme en Pro — on continue sur '
    + 'l\'acces libre. Verifiez la cle sur coingecko.com/en/developers/dashboard.');
  return cgPorte;
}

/* Une lecture GeckoTerminal, par la meilleure porte disponible, avec repli. */
async function jsonGT(chemin) {
  if (cgPorte === null) await sondeCoingecko();
  const cle = cleCoingecko();
  if (cle && cgPorte !== 'libre') {
    const base = cgPorte === 'pro' ? CG_PRO : CG_DEMO;
    const entete = cgPorte === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';
    try {
      return await json(base + chemin, { headers: Object.assign({}, ENTETES, { [entete]: cle }) });
    } catch (e) {
      /* Quota atteint ou cle revoquee en pleine journee : on ne perd pas la
         lecture pour autant. On le NOTE, et on repasse par l'acces libre. */
      noteService('coingecko', false, String(e.message || e).slice(0, 40));
      return json(GT_LIBRE + chemin, { headers: ENTETES });
    }
  }
  return json(GT_LIBRE + chemin, { headers: ENTETES });
}
const ENTETES = { Accept: 'application/json;version=20230302' };
/* ---- DEUX NOEUDS, PARCE QU'UN SEUL COUPE ----
 * Le noeud officiel refuse apres quelques lectures a la file : quatre sur six,
 * mesure. Un second noeud public a ete cherche et trouve — dRPC sert bien la
 * chaine 4663, sans cle. Il a une limite a lui : dix mille blocs par
 * `eth_getLogs`, soit dix-sept minutes de cette chaine. Nos jetons ont une a
 * six minutes, donc il couvre le cas courant ; au-dela il n'est simplement pas
 * candidat, et on le dit plutot que de lui envoyer une demande qu'il refusera.
 *
 * L'espacement est tenu PAR NOEUD : c'est ce qui double reellement le debit,
 * et non le fait d'avoir une adresse de plus dans une liste. */
const RPC_RH = 'https://rpc.mainnet.chain.robinhood.com';
/* ---- LE SECOND NOEUD SE CHOISIT PAR L'ENVIRONNEMENT ----
 * dRPC ne sert pas la chaine 4663 : 100 % de refus, avec ou sans cle, sur
 * eth_getLogs, eth_call et eth_blockNumber. Le nœud officiel restait seul et
 * son budget s'epuisait — Warden et Whale rendaient « inconnu » sur 843
 * jetons sur 859. `RPC_SECOURS` recoit l'adresse d'un fournisseur qui sert
 * la chaine (Alchemy, QuickNode…), `RPC_SECOURS_PLAGE` la plus grande
 * fenetre de blocs qu'il accepte sur eth_getLogs. Sans rien, dRPC reste
 * l'adresse par defaut, et la colonie apprend toute seule a ne plus l'appeler. */
const RPC_SECOURS = (process.env.RPC_SECOURS || '').trim() || 'https://robinhood.drpc.org';
const RPC_SECOURS_PLAGE = Math.max(100, parseInt(process.env.RPC_SECOURS_PLAGE || '10000', 10) || 10000);
/* Le nom qu'on lui donne dans la vue et les alertes : « dRPC » quand c'est
   dRPC, sinon l'hote de l'adresse posee — sans la cle, qui est dedans. */
const SECOURS_NOM = (function () {
  if (!(process.env.RPC_SECOURS || '').trim()) return 'public dRPC node';
  try { return 'RPC_SECOURS node (' + new URL(RPC_SECOURS).hostname + ')'; }
  catch (e) { return 'RPC_SECOURS node'; }
})();
const SUJET_TRANSFERT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const MORT = '0x000000000000000000000000000000000000dead';

const DEPART = 1000;            /* la tresorerie papier de depart */
const MISE = 50;                /* ce qu'une position engage */
const TENUE_DEFAUT_MIN = 20;    /* et ce que le Closer tient, avant d'apprendre */
const AGE_MAX_MIN = 360;        /* au-dela, ce n'est plus un jeton neuf */
const SEUIL = 55;               /* la note qu'il faut atteindre pour entrer */
/* ---- COMBIEN DE POSITIONS A LA FOIS ----
 * Six, c'etait une prudence de trop : la vraie borne est celle du Banquier —
 * trente pour cent de la caisse engages au total — et a trois pour cent la
 * mise, elle en autorise dix. Six faisait donc taire le Banquier sans le dire,
 * et deux constantes qui se limitent l'une l'autre en silence finissent
 * toujours par cacher laquelle des deux decide vraiment.
 * On les accorde : dix ici, et le Banquier reste le seul juge du montant. */
const POSITIONS_MAX = 10;
const CADENCE_MS = 150000;      /* un tour toutes les deux minutes et demie */

/* Le temps de bloc, MESURE sur la chaine : 0,101 s. Un chiffre commente est un
   chiffre qu'on croit sur parole ; celui-la a ete releve. */
const BLOC_SECONDES = 0.101;
const BLOCS_HEURE = Math.round(3600 / BLOC_SECONDES);
const BLOCS_PLAFOND = 200000;   /* la plage que le noeud accepte, verifiee */

const TTL_GOPLUS = 6 * 3600e3, TTL_OHLCV = 30 * 60e3, TTL_DEX = 10 * 60e3, TTL_CHAINE = 10 * 60e3;
const TTL_TRADES = 8 * 60e3;   /* les trades vieillissent vite : c'est tout leur interet */

/* ---- CE QUE LE BANQUIER NE PEUT PAS APPRENDRE A DESSERRER ----
 * Il choisit sa methode de mise, et il en change quand ses relevés le disent.
 * Mais ces quatre bornes-la sont dans le code. Un systeme qui peut apprendre
 * a miser toute la caisse sur un coup l'apprend toujours, et exactement une
 * fois — le releve d'apres ne sert plus a personne. */
const MISE_MIN = 10;            /* en dessous, le resultat ne mesure rien */
const MISE_PART_MAX = 0.08;     /* jamais plus de 8 % de la caisse sur un jeton */
const EXPO_PART_MAX = 0.30;     /* ni plus de 30 % engages en meme temps */
const PLANCHER = 100;           /* sous ce niveau, la colonie s'arrete d'ouvrir */

/* ---- LA SURVEILLANCE ----
 * « Je vois qu'il scanne souvent le même. S'il a déjà scanné, ça sert à rien
 *   de l'analyser en boucle ; peut-être le mettre dans une case surveillance
 *   s'il a un potentiel. »
 * Exact, et ca coutait cher : les memes six jetons repassaient l'analyse
 * complete a chaque tour — trois appels reseau chacun — pendant que des
 * jetons jamais vus attendaient leur tour. Un jeton deja juge n'est repris
 * que si un signal GRATUIT (ceux du flux des pools, qu'on lit de toute facon)
 * a bouge pour de bon, ou apres un long moment. */
const SURV_MIN_MS = 40 * 60e3;  /* au plus tot, quarante minutes apres le dernier examen */
const SURV_LIQ = 1.25;          /* ou si la liquidite a pris 25 % */
const SURV_PRIX = 1.10;         /* ou si le prix a pris 10 % */
/* ---- COMBIEN DE JETONS LA COLONIE SE RAPPELLE ----
 * DEMANDE : « une memoire plus grande ». Trois cents, c'etait quarante-cinq
 * minutes de flux : la colonie voit environ quatre cents jetons a l'heure. Un
 * jeton juge il y a une heure etait donc deja oublie, et rejuge de zero —
 * elle repayait des appels pour reapprendre ce qu'elle savait, et ne pouvait
 * rien comparer d'un jour a l'autre.
 * Le cout est de la memoire vive et du disque, pas des appels : une entree
 * pese quelques dizaines d'octets, et deux mille tiennent largement. Reglable,
 * parce que le volume du flux, lui, n'est pas une constante. */
const SURV_MAX = nEnv('SURV_MAX', 2000);
/* Reconnaitre le refus « trop jeune » ailleurs sans relire la phrase : elle
   changera. Pose ici, avec les autres constantes, parce que l'oubli des vieux
   connus s'en sert et qu'il vit tout en haut du fichier. */
/* ---- LE REPORT POUR AGE, DANS LES DEUX VOCABULAIRES ----
 * Ce motif ne decore rien : c'est lui qui distingue un jeton MIS DE COTE
 * d'un jeton refuse. Il decide de trois choses — la reprise par l'age, la
 * part des refus que l'alerte annonce, et le fait qu'un jeune ne compte pas
 * comme un blocage. Ecrit en francais seul, il a cesse de reconnaitre ses
 * propres refus le jour ou le veto est passe a l'anglais : les jeunes
 * n'etaient plus repris, et l'alerte les comptait comme des refus fermes.
 * Les deux formes restent donc reconnues — un etat relu d'avant la bascule
 * porte encore l'ancienne. */
const REFUS_AGE = /^(?:too young|trop jeune)/;

const ECHANTILLON_ORDRE = 25;   /* en dessous, un taux de refus est du bruit */
const REPOS_ORDRE_TOURS = 8;    /* et on ne rechange pas d'avis toutes les deux minutes */
const VARIANCE_MIN_OBS = 14;    /* en dessous, une variance ne veut rien dire */
const ECART_TYPE_BRUIT = 26;    /* au-dela, la case ne predit rien : elle est mal coupee */
const ENFANTS_MAX = 6;          /* la colonie peut grandir, pas exploser */

/* ==========================================================================
 * LES SERVICES
 *
 * Chacun porte son cout en appels reseau. C'est ce cout qui rend l'ordre des
 * gardes mesurable : un garde qui refuse la moitie des jetons pour un seul
 * appel fait economiser tous les appels des gardes qui le suivent.
 * `cout: 0` veut dire « on l'a deja, il vient du flux des pools ».
 * ======================================================================== */
const SERVICES = {
  pools:   { nom: 'GeckoTerminal · new pools', cout: 0, quoi: 'age, liquidity, cap, buys and sells' },
  profils: { nom: 'DexScreener · recent profiles', cout: 0, quoi: 'new tokens whose profile someone filled in' },
  boosts:  { nom: 'DexScreener · boosted tokens', cout: 0, quoi: 'tokens someone paid to promote' },
  chaine:  { nom: 'Chain 4663 · official node', cout: 1, quoi: 'who holds what, by adding up transfers' },
  chaine2: { nom: 'Chain 4663 · ' + SECOURS_NOM, cout: 1,
             quoi: 'the same, as backup when the official one saturates (' + RPC_SECOURS_PLAGE.toLocaleString('en-US') + ' blocks max)' },
  chaineCle: { nom: 'Chain 4663 · our own dRPC node', cout: 1,
               quoi: 'the same, but on throughput that belongs to us instead of being shared' },
  goplus:  { nom: 'GoPlus · contract safety', cout: 1, quoi: 'honeypot, taxes, owner powers' },
  trades:  { nom: 'GeckoTerminal · trades one by one', cout: 1, quoi: 'which wallets are buying, and for how much' },
  dex:     { nom: 'DexScreener · second opinion', cout: 1, quoi: 'a second price, the other pools, the socials' },
  ohlcv:   { nom: 'GeckoTerminal · candles', cout: 1, quoi: 'the volatility actually observed' },
  goplusCle: { nom: 'GoPlus · access token', cout: 0,
               quoi: 'key and secret exchanged for a token, for a higher rate limit' },
  coingecko: { nom: 'CoinGecko · GeckoTerminal key', cout: 0,
               quoi: 'the same reads, but through our own door instead of the shared queue' },
  conseil: { nom: 'Anthropic · Claude Haiku', cout: 1,
             quoi: 'a view on borderline cases, capped at 8 points and never on a veto' },
};

/* ---- CE QUI A ETE ESSAYE ET QUI NE MARCHE PAS ----
 * Nomme, avec la raison mesuree. Une source absente sans explication laisse
 * croire qu'on n'y a pas pense ; celles-ci ont ete essayees, et le releve est
 * la. Elles restent ici pour qu'on ne les re-essaie pas tous les six mois en
 * croyant avoir trouve une idee neuve. */
const HORS_SERVICE = {
  gmgn: 'GMGN — 403 Cloudflare, on ethereum too: that is anti-bot protection, not an absence '
      + 'of chain 4663. It would take a browser, so not from the server.',
  blockscout: 'Blockscout robinhood — Cloudflare challenge on the API as on the pages.',
  honeypotis: 'honeypot.is — does not know chain 4663 (no simulation possible).',
};

/* ==========================================================================
 * LES TRAITS : LE CATALOGUE, ET CE QUE CHACUN COUTE
 *
 * Un trait, c'est une CASE — pas une valeur. Un contrat precis ne s'apprend
 * pas : il n'y en a qu'un, on ne le reverra jamais. Une tranche de liquidite,
 * une pression acheteuse, une volatilite : on les revoit cent fois, et c'est
 * la seule chose dont une moyenne veuille dire quelque chose.
 *
 * Chaque trait declare le service dont il a besoin. C'est ce qui rend les
 * lectures paresseuses possibles : on ne paie un appel que si un agent qui
 * doit encore parler en a besoin. Et un « ? » est une case a part entiere —
 * la colonie apprendra ce que valent les jetons sur lesquels on ne savait
 * rien, et c'est peut-etre la lecon la plus utile.
 * ======================================================================== */
/* Decouper une valeur continue en cases nommees. C'est l'outil de base de
   tout ce fichier : on n'apprend pas d'un nombre, on apprend d'une case. */
function tranche(v, seuils, noms) {
  for (let i = 0; i < seuils.length; i++) if (v < seuils[i]) return noms[i];
  return noms[noms.length - 1];
}
const rapport = (a, b) => (b > 0 ? a / b : (a > 0 ? 99 : 1));

const TRAITS = {
  /* --- gratuits : ils viennent du flux des pools, deja lu --- */
  age:    { besoin: null, f: (t) => t.minutes === null ? 'age ?' : t.minutes < 10 ? 'ne de <10 min'
              : t.minutes < 30 ? '10-30 min' : t.minutes < 120 ? '30 min-2 h' : '2-6 h' },
  liq:    { besoin: null, f: (t) => tranche(t.liq || 0, [1e3, 5e3, 25e3, 1e5],
              ['liq<1k', 'liq 1-5k', 'liq 5-25k', 'liq 25-100k', 'liq>100k']) },
  mc:     { besoin: null, f: (t) => tranche(t.mc || 0, [5e4, 5e5, 5e6],
              ['mc <50k', 'mc 50-500k', 'mc 0,5-5M', 'mc >5M']) },
  elan:   { besoin: null, f: (t) => tranche(t.ch_m5 || 0, [-5, 0, 5, 20],
              ['5m <-5%', '5m -5-0%', '5m 0-5%', '5m 5-20%', '5m >20%']) },
  press:  { besoin: null, f: (t) => { const h = (t.tx || {}).h1 || {};
              return tranche(rapport(h.buys || 0, h.sells || 0), [0.8, 1.05, 1.5],
                ['vendeurs devant', 'equilibre', 'acheteurs devant', 'achats massifs']); } },
  uniq:   { besoin: null, f: (t) => { const h = (t.tx || {}).h1 || {};
              return tranche((h.buyers || 0) + (h.sellers || 0), [20, 100, 500],
                ['<20 traders/h', '20-100/h', '100-500/h', '>500/h']); } },
  accel:  { besoin: null, f: (t) => { const v = t.vol || {};
              return tranche(rapport(v.h1 || 0, (v.h6 || 0) / 6), [0.6, 1.2, 3],
                ['ca retombe', 'stable', 'ca accelere', 'explosion']); } },
  /* ---- D'OU IL VIENT ----
   * Trois flux ramenent des jetons, et ils ne ramenent pas les memes. Savoir
   * lequel a paye est une lecon que la colonie ne pouvait pas apprendre tant
   * qu'elle n'avait qu'une seule source. */
  origine: { besoin: null, f: (t) => 'trouve par ' + (t.origine || 'pools') },
  /* Ce que le Conseiller a repondu devient une case comme une autre. C'est ce
     qui fait qu'il REPOND de ses avis : si « favorable » finit mal, la case le
     dit, et son influence se reduit d'elle-meme. */
  avis:    { besoin: null, f: (t) => t.conseil ? 'conseiller ' + t.conseil.avis
                                               : 'conseiller non consulte' },
  /* Ce que l'epreuve de vente a rendu. « Non testable » est une case a part
     entiere : elle vaut ce qu'elle vaut, et la colonie l'apprendra. */
  cobaye:  { besoin: null, f: (t) => !t.epreuve ? 'sortie non testee'
              : !t.epreuve.teste ? 'sortie non testable'
              : t.epreuve.passe ? 'sortie simulee OK' : 'sortie bloquee' },

  /* --- un appel a GoPlus --- */
  taxe:   { besoin: 'goplus', f: (t) => { const g = t.g || {};
              return !g.taxeSue ? 'taxe inconnue' : (g.buyTax + g.sellTax) === 0 ? 'aucune taxe'
                : (g.buyTax + g.sellTax) <= 10 ? 'taxe <=10%' : 'taxe >10%'; } },
  code:   { besoin: 'goplus', f: (t) => { const g = t.g || {};
              return !g.codeSu ? 'code inconnu' : (g.unverified ? 'code non verifie' : 'code verifie'); } },
  pouv:   { besoin: 'goplus', f: (t) => { const g = t.g || {};
              return !g.have ? 'pouvoirs ?' : (g.mintable && g.proxy) ? 'mint + proxy'
                : g.mintable ? 'emission possible' : g.proxy ? 'contrat proxy' : 'aucun pouvoir'; } },

  /* --- un appel a la chaine --- */
  top:    { besoin: 'chaine', f: (t) => { const c = t.chaine || {}, g = t.g || {};
              const v = (c.vu && c.top !== null && c.top !== undefined) ? c.top : (g.topSu ? g.top : null);
              if (c.personne) return 'personne ne garde';
              return v === null ? 'concentration inconnue' : tranche(v, [5, 15, 30, 50],
                ['top <5%', 'top 5-15%', 'top 15-30%', 'top 30-50%', 'top >50%']); } },
  det:    { besoin: 'chaine', f: (t) => { const c = t.chaine || {}, g = t.g || {};
              if (c.vu && c.porteurs !== null && c.porteurs !== undefined)
                return tranche(c.porteurs, [10, 30, 100, 500],
                  ['<10 porteurs', '10-30', '30-100', '100-500', '>500 porteurs']);
              return g.detSue ? tranche(g.holders, [100, 1e3, 1e4],
                ['<100 det', '100-1k det', '1k-10k det', '>10k det']) : 'porteurs inconnus'; } },
  brule:  { besoin: 'chaine', f: (t) => { const c = t.chaine || {};
              return (c.vu && c.brule !== null && c.brule !== undefined)
                ? tranche(c.brule, [1, 50, 90], ['rien brule', '<50% brule', '50-90% brule', '>90% brule'])
                : 'brule inconnu'; } },

  /* --- un appel aux trades : ce que personne d'autre ne dit --- */
  flux:   { besoin: 'trades', f: (t) => { const x = t.trades || {};
              return !x.vu ? 'flux inconnu' : x.n < 4 ? 'trop peu de trades'
                : tranche(x.partDuPlusGros, [25, 50, 80],
                  ['volume reparti', 'un gros portefeuille', 'un portefeuille domine', 'un seul fait tout']); } },
  achUniq: { besoin: 'trades', f: (t) => { const x = t.trades || {};
              return !x.vu ? 'acheteurs ?' : tranche(x.acheteurs, [3, 8, 20],
                ['<3 acheteurs', '3-8 acheteurs', '8-20 acheteurs', '>20 acheteurs']); } },
  taille: { besoin: 'trades', f: (t) => { const x = t.trades || {};
              return !x.vu || !x.n ? 'tailles ?' : tranche(x.moyen, [20, 100, 500],
                ['tickets <$20', 'tickets $20-100', 'tickets $100-500', 'tickets >$500']); } },

  /* --- un appel a DexScreener --- */
  pools:  { besoin: 'dex', f: (t) => { const d = t.dex || {};
              return !d.vu ? 'pools ?' : tranche(d.pools, [2, 4], ['1 pool', '2-3 pools', '>=4 pools']); } },
  accord: { besoin: 'dex', f: (t) => t.ecart === null || t.ecart === undefined ? 'une seule source'
              : tranche(t.ecart, [0.5, 2, 6], ['prix concordants', 'ecart <2%', 'ecart 2-6%', 'ecart >6%']) },
  social: { besoin: 'dex', f: (t) => { const d = t.dex || {};
              return !d.vu ? 'reseaux ?' : tranche(d.socials, [1, 3], ['aucun reseau', '1-2 reseaux', '3+ reseaux']); } },

  /* --- un appel aux chandelles --- */
  vola:   { besoin: 'ohlcv', f: (t) => t.vola === null || t.vola === undefined ? 'vola ?'
              : tranche(t.vola, [2, 5, 12], ['calme', 'vola 2-5%', 'vola 5-12%', 'vola >12%']) },
};

/* ==========================================================================
 * LES CASES QUI NE DISENT RIEN DU JETON
 *
 * DEMANDE : « fais-les devenir beaucoup plus intelligents, avec une memoire
 * plus grande ».
 *
 * En regardant la memoire reelle avant d'y toucher, la premiere lecon des
 * agents n'etait pas une lecon. Le Warden, en tete :
 *
 *     « code inconnu »  n=488  moyenne +20,0  ecart 91,8
 *     « pouvoirs ? »    n=488  moyenne +20,0  ecart 91,8
 *
 * Deux lignes, les memes chiffres a la decimale pres. Et c'est normal : ses
 * trois traits — taxe, code, pouvoirs — sortent tous du MEME appel a GoPlus.
 * Quand GoPlus se tait, et il s'est tu 3 114 fois sur 3 237, les trois
 * repondent « inconnu » ensemble. Meme chose pour le Whale : concentration,
 * porteurs et brule viennent tous de la meme lecture de chaine.
 *
 * Deux fautes en decoulaient, et elles tiraient dans le meme sens :
 *
 *   1. UN SEUL fait — « on n'a pas pu lire » — etait compte TROIS fois dans
 *      la note. Trois cases tres observees, donc tres confiantes, qui ne sont
 *      qu'une seule et meme observation.
 *
 *   2. Elles RAPPORTAIENT des points. Leur moyenne est positive parce que
 *      c'est la moyenne generale de tout ce que la colonie regarde — pas une
 *      qualite du jeton. Un jeton illisible recoltait ainsi jusqu'a la moitie
 *      de la marge d'ajustement pour la seule raison qu'on n'avait rien pu
 *      lire sur lui.
 *
 * Or la regle est ecrite en tete de ce fichier depuis le debut : « INCONNU —
 * et l'inconnu ne rapporte jamais de points a un jeton. » Le code ne la
 * tenait pas. Il la tient maintenant : les cases non lues d'un agent sont
 * repliees en UNE (la mieux observee), et sa part est bornee a zero par le
 * haut. Elle peut retirer des points ; elle ne peut plus en donner.
 *
 * On continue de les APPRENDRE. « Ce que valent les jetons sur lesquels on ne
 * savait rien » reste une chose vraie et lisible, et elle est affichee. C'est
 * de la NOTE qu'elle sort, pas de la memoire.
 *
 * La liste est ecrite en toutes lettres plutot que devinee par un motif : ces
 * mots sont ceux qu'un humain lit a l'ecran, ils changeront, et un motif qui
 * cesse de correspondre echouerait en silence — exactement le genre de panne
 * que ce fichier evite. L'essai les recoupe avec la table des traits.
 * ======================================================================== */
const CASES_NON_LUES = new Set([
  'age ?',                 /* le flux n'a pas donne l'age du pool */
  'taxe inconnue', 'code inconnu', 'pouvoirs ?',        /* GoPlus s'est tu */
  'concentration inconnue', 'porteurs inconnus', 'brule inconnu',  /* la chaine n'a pas repondu */
  'flux inconnu', 'acheteurs ?', 'tailles ?',           /* les trades n'ont pas ete lus */
  'pools ?', 'reseaux ?',                               /* DexScreener n'a pas repondu */
  'vola ?',                                             /* pas assez de chandelles */
  'conseiller non consulte',                            /* le budget d'appels etait epuise */
  'sortie non testee', 'sortie non testable',           /* l'epreuve n'a pas pu etre jouee */
]);
/* Une case croisee (« age ? × mc <50k ») n'est non lue que si TOUTES ses
   parts le sont : s'il reste une mesure vraie dedans, la case dit encore
   quelque chose du jeton, et la replier serait perdre cette mesure. */
function caseNonLue(v) {
  if (typeof v !== 'string' || !v) return false;
  const parts = v.split(' × ');
  for (const p of parts) if (!CASES_NON_LUES.has(p.trim())) return false;
  return true;
}

/* ---- UN TRAIT CROISE ----
 * C'est avec ca qu'un specialiste fait mieux que son parent. Quand « top
 * 15-30 % » rend tantot +40 %, tantot -30 %, la coupe est au mauvais endroit :
 * il n'y a pas UNE population la-dedans, il y en a deux. Les recouper par un
 * second trait les separe. */
function litTrait(spec, t) {
  if (Array.isArray(spec)) {
    const parts = spec.map((s) => (TRAITS[s] ? TRAITS[s].f(t) : '?'));
    return parts.join(' × ');
  }
  return TRAITS[spec] ? TRAITS[spec].f(t) : '?';
}
function nomTrait(spec) { return Array.isArray(spec) ? spec.join('×') : spec; }
function besoinsDuTrait(spec) {
  const l = Array.isArray(spec) ? spec : [spec];
  const out = [];
  for (const s of l) { const b = TRAITS[s] && TRAITS[s].besoin; if (b && out.indexOf(b) < 0) out.push(b); }
  return out;
}

/* ==========================================================================
 * LE ROSTER DE DEPART
 *
 * Sept agents, et la liste est une DONNEE : elle est gardee avec l'etat, elle
 * grandit, elle se reordonne. La page dessine autant de maisons qu'il y a
 * d'agents — c'est pour ca qu'aucun nombre n'est ecrit en dur nulle part.
 *
 * Les roles ne sont pas decoratifs. `garde` peut refuser, et son veto est
 * dans le code. `specialiste` ne refuse jamais : il affine un jugement. Un
 * agent engendre par la colonie est toujours un specialiste — voir la
 * frontiere, en tete de fichier.
 * ======================================================================== */
const ROSTER_DEPART = [
  { key: 'scout', nom: 'Scout', emoji: '🛰️', couleur: '#3d7bd6', role: 'source', ordre: 0,
    mission: 'Sweeps three feeds, and drops what is already empty on sight',
    traits: ['age', 'liq', 'origine'] },
  { key: 'warden', nom: 'Warden', emoji: '🛡️', couleur: '#9b6cf0', role: 'garde', ordre: 1,
    mission: 'Checks the contract: honeypot, taxes, owner powers',
    traits: ['taxe', 'code', 'pouv'] },
  { key: 'whale', nom: 'Whale-Watch', emoji: '🐋', couleur: '#e8552d', role: 'garde', ordre: 2,
    mission: 'Adds up transfers in the blocks: who holds, and how much',
    traits: ['top', 'det', 'brule'] },
  { key: 'whisper', nom: 'Whisper', emoji: '📡', couleur: '#1fb7a8', role: 'garde', ordre: 3,
    mission: 'Reads trades one by one: who is really buying, and for how much',
    traits: ['press', 'uniq', 'accel', 'flux', 'achUniq', 'taille'] },
  { key: 'oracle', nom: 'Oracle', emoji: '🔮', couleur: '#f2b21e', role: 'note', ordre: 4,
    mission: 'Scores, learns from every closed position, and decides',
    traits: ['mc', 'elan', 'vola', 'accord', 'social', 'pools'] },
  { key: 'conseiller', nom: 'Advisor', emoji: '🧠', couleur: '#b98cff', role: 'conseil', ordre: 5,
    mission: 'Gives a view on borderline cases, and answers for it like the rest',
    traits: ['avis'] },
  { key: 'cobaye', nom: 'Test Subject', emoji: '🧫', couleur: '#ff8f5a', role: 'epreuve', ordre: 5.5,
    mission: 'Just before buying: simulates the sale on chain, signing and spending nothing',
    traits: ['cobaye'] },
  { key: 'sentinelle', nom: 'Sentinel', emoji: '🔭', couleur: '#c9a227', role: 'veille', ordre: 6,
    mission: 'Watches every open position and cuts when the floor gives way',
    traits: ['derive', 'liq'] },
  { key: 'promoteur', nom: 'Extender', emoji: '⏳', couleur: '#7fb3ff', role: 'prolonge', ordre: 7,
    mission: 'Decides whether to let a rising position run, and learns from ITS choice',
    traits: ['gain', 'note', 'fois'] },
  { key: 'banquier', nom: 'Banker', emoji: '🏦', couleur: '#5ad1a0', role: 'banque', ordre: 8,
    mission: 'Sizes the stake from the current treasury, and learns which method pays',
    traits: ['methode', 'regime'] },
  { key: 'closer', nom: 'Closer', emoji: '💰', couleur: '#e83e8c', role: 'execution', ordre: 9,
    mission: 'Opens at the real price, holds the duration it learned, closes at the real price',
    traits: ['tenue'] },
  /* ---- LE VEILLEUR ----
   * « Il faudrait que les positions ouvertes soient surveillees par un autre
   *   agent, un nouveau, qui regarde le prix regulierement sur DexScreener
   *   pour voir a combien de profit on est — c'est long de voir la position
   *   bouger, ce qui interesse les gens c'est le market cap et combien on
   *   est. »
   *
   * La Sentinelle regarde deja les positions, mais pour DECIDER : elle coupe
   * quand le sol se derobe, et elle le fait au rythme du tour, toutes les
   * deux minutes et demie, entre deux lectures de jetons neufs. Ce n'est pas
   * la meme chose que REGARDER : un chiffre qui ne bouge qu'une fois par deux
   * minutes et demie donne une position immobile a l'ecran.
   *
   * Le Veilleur ne decide rien. Il relit le prix ET la capitalisation des
   * positions ouvertes, souvent, et rien d'autre. Il ne peut pas vendre, il
   * ne peut pas ouvrir : separer celui qui regarde de celui qui coupe est ce
   * qui permet de le faire tourner vite sans lui donner de pouvoir. */
  { key: 'veilleur', nom: 'Watcher', emoji: '👁️', couleur: '#4bb3fd', role: 'suivi', ordre: 10,
    mission: 'Re-reads price and cap on open positions, often, and decides nothing',
    traits: [] },
];
/* Les gardes reordonnables. Le Scout est forcement premier — il n'y a rien a
   juger avant d'avoir trouve. L'Oracle est forcement dernier parmi ceux qui
   jugent : sa note se sert de tout ce que les autres ont lu, donc le mettre
   devant ne ferait economiser aucun appel. Banquier et Closer viennent apres,
   et seulement si le jeton a passe. */
const REORDONNABLES = ['warden', 'whale', 'whisper'];

/* ------------------------------------------------------------------- l'etat */
function rosterNeuf() { return JSON.parse(JSON.stringify(ROSTER_DEPART)); }
/* ---- POURQUOI LA VERSION PASSE A 3 ----
 * « Remets aussi toutes les données à zéro, il y a eu un bug, on a un solde à
 *   500 millions de dollars. »
 *
 * Ce solde vient d'une division : le rendement se calcule en
 * (prix - prix0) / prix0, et un jeton a tres faible decimale relu depuis une
 * autre source donnait un rapport a plusieurs millions pour cent. Trente
 * dollars de mise devenaient des centaines de millions de papier. C'est
 * corrige — au-dela de bornes plausibles, plus rien n'est comptabilise — mais
 * la tresorerie enregistree, elle, reste fausse, et TOUT ce qui en descend
 * l'est aussi : la courbe, le meilleur multiple, le releve du Banquier, le
 * regime de caisse, et donc les mises a venir.
 *
 * Un etat faux ne se repare pas a la main : on ne sait pas quelles positions
 * ont ete empoisonnees ni de combien. Il se jette. Le numero de version sert
 * exactement a ca : au premier demarrage du code corrige, l'ancien etat est
 * mis de cote et la colonie repart proprement — sans que personne ait a
 * toucher au serveur.
 *
 * Ce qui est perdu est perdu : des semaines de memoire d'agents. C'est le prix
 * d'une tresorerie a laquelle on peut se fier, et l'inverse ne vaut rien. */
const VERSION_ETAT = 3;

function etatNeuf() {
  return {
    v: VERSION_ETAT, tresor: DEPART, trades: 0, gains: 0, meilleur: 0, meilleurSym: '',
    courbe: [DEPART], flux: [], positions: [], memoire: {}, compteurs: {},
    ouvertures: 0, maj: 0, dernierTour: 0, candidats: [], derniereErreur: null,
    depuis: Date.now(), tours: 0, toursDepuisOrdre: REPOS_ORDRE_TOURS,
    seuil: SEUIL, derniers: [], depuisAjustement: 0, suites: [], sortieEssais: 0,
    ombres: [], audit: {}, profils: {},
    /* le fond de rendement que toute case se compare a (voir `apprendBase`),
       et la marque que le seuil a ete pose pour des notes centrees */
    base: null, adjCentre: true,
    /* les quarante dernieres positions reglees : suivie (0) ou perdue (1) */
    suivis: [],
    /* ce que la colonie vient de faire, pour Telegram et le portefeuille */
    signaux: [],
    /* la structure, qui est une donnee et non du code */
    roster: rosterNeuf(), ordreRevu: 0, journalStructure: [],
    /* ce qu'on a deja juge, pour ne pas le rejuger en boucle */
    connus: {},
    /* le releve de chaque service */
    services: {},
    /* pourquoi elle n'achete pas : les refus par famille, sur une fenetre */
    refusFamilles: {}, refusVus: 0, toursSansAchat: 0, desserreDernier: 0,
    /* le banquier */
    banque: { methode: 'part', memoire: {}, serie: 0, pic: DEPART, arret: null },
  };
}
let E = etatNeuf();

function charge() {
  let brut = null;
  try { brut = JSON.parse(fs.readFileSync(FICHIER, 'utf8')); } catch (e) { brut = null; }
  if (!brut || typeof brut !== 'object') return;
  /* ---- UNE FORME PLUS ANCIENNE SE COMPLETE ; UN ETAT FAUX SE JETTE ----
   * Les deux ne sont pas la meme chose. Un champ qui manque parce que le code
   * a evolue se remplit — jeter la-dessus effacerait des semaines
   * d'apprentissage a chaque correction. Mais un etat dont les CHIFFRES sont
   * faux ne peut pas etre complete : il n'y a rien a garder dedans. */
  if ((brut.v || 1) < VERSION_ETAT) {
    try {
      fs.writeFileSync(FICHIER + '.v' + (brut.v || 1) + '.abandonne', JSON.stringify(brut));
    } catch (e) { /* on garde une copie si on peut, ca ne doit pas bloquer le depart */ }
    console.warn('[ai] etat en version ' + (brut.v || 1) + ' (tresorerie enregistree : '
      + Math.round(brut.tresor || 0) + ') — mis de cote, la colonie repart de $' + DEPART);
    E = etatNeuf();
    E.journalStructure = [{ t: Date.now(), quoi: 'remise', chiffres: null,
      txt: 'Everything restarted from zero: the recorded treasury ($'
         + Math.round(brut.tresor || 0) + ') came from a nonsensical re-read price, not from a '
         + 'market. A wrong figure cannot be repaired — and everything derived from it was wrong '
         + 'with it.' }];
    sauve();
    return;
  }
  const n = etatNeuf();
  /* Releve AVANT que les champs manquants soient completes : un etat d'avant
     le fond n'a pas cette marque, et c'est son absence qui declenche la mise
     au centre. La completer d'abord l'aurait posee a « deja fait ». */
  const dejaCentre = brut.adjCentre === true;
  for (const k of Object.keys(n)) if (!(k in brut)) brut[k] = n[k];
  brut.adjCentre = dejaCentre;
  if (!Array.isArray(brut.courbe) || !brut.courbe.length) brut.courbe = [DEPART];
  if (!Array.isArray(brut.flux)) brut.flux = [];
  if (!Array.isArray(brut.positions)) brut.positions = [];
  if (!brut.memoire || typeof brut.memoire !== 'object') brut.memoire = {};
  if (!brut.compteurs || typeof brut.compteurs !== 'object') brut.compteurs = {};
  if (!brut.connus || typeof brut.connus !== 'object') brut.connus = {};
  if (!brut.services || typeof brut.services !== 'object') brut.services = {};
  if (!Array.isArray(brut.journalStructure)) brut.journalStructure = [];
  if (!brut.banque || typeof brut.banque !== 'object') brut.banque = n.banque;
  if (!brut.banque.memoire || typeof brut.banque.memoire !== 'object') brut.banque.memoire = {};
  if (!(brut.banque.pic > 0)) brut.banque.pic = Math.max(DEPART, brut.tresor || DEPART);
  /* ---- LE ROSTER RELU DOIT RESTER JOUABLE ----
   * Un etat d'avant la structure mobile n'a pas de roster : on lui donne celui
   * du depart plutot que de le laisser sans agents. Et un roster relu doit
   * porter au moins les agents de base — un fichier tronque ou bricole ne doit
   * pas pouvoir faire disparaitre le Warden, c'est-a-dire le controle du
   * contrat. */
  if (!Array.isArray(brut.roster) || !brut.roster.length) brut.roster = rosterNeuf();
  for (const base of ROSTER_DEPART) {
    const vif = brut.roster.find((a) => a && a.key === base.key);
    if (!vif) { brut.roster.push(JSON.parse(JSON.stringify(base))); continue; }
    /* ---- CE QUI S'AFFICHE VIENT DU CODE, CE QUI S'APPREND VIENT DE L'ETAT ----
     * Le roster est ecrit dans le fichier d'etat de la colonie. Un agent deja
     * present y gardait son nom et sa mission d'il y a des semaines : reecrire
     * ces phrases dans le code ne changeait rien a l'ecran, parce que le
     * fichier relu les ecrasait a chaque demarrage. C'est exactement ce qui est arrive en
     * passant l'interface a l'anglais — les missions traduites ne sont jamais
     * sorties du fichier source.
     * Les quatre champs ci-dessous ne sont QUE de l'affichage : ils sont donc
     * repris du code a chaque lecture. Tout le reste — `ordre`, `traits`,
     * `vus`, `bloques` — est ce que la colonie a mesure, et n'est pas touche :
     * l'ordre des gardes et le decoupage des traits sont appris, pas ecrits. */
    vif.nom = base.nom;
    vif.emoji = base.emoji;
    vif.couleur = base.couleur;
    vif.mission = base.mission;
  }
  brut.roster = brut.roster.filter((a) => a && a.key && Array.isArray(a.traits));
  E = brut;
  regroupeAudit();
  centreLesNotes();
}

/* ---- UN ETAT D'AVANT LE FOND REPART AVEC LE SEUIL DU DEPART ----
 *
 * Le seuil en vigueur — 65 sur le serveur, apres etre monte a 70 — a ete
 * appris sur des notes gonflees d'un fond de +25 (voir `apprendBase`). Une
 * fois le fond soustrait, les memes jetons notent 25 points de moins, et un
 * seuil a 65 ne laisserait plus rien passer pendant des heures : le
 * desserrage par silence mettrait sept heures a le ramener a 45. Autant de
 * temps sans mesure, donc sans apprentissage.
 *
 * On remet donc le seuil a sa valeur de depart, UNE FOIS, et on le dit dans
 * le journal. Rien d'autre n'est touche : la memoire des cases reste — c'est
 * la soustraction qui la rend lisible, pas un effacement — et le fond est
 * amorce depuis elle, pour que la premiere note centree ne repose pas sur
 * vingt observations a venir mais sur les six cents deja faites. Amorce avec
 * une confiance modeste : c'est une estimation, et elle le sait. */
function centreLesNotes() {
  if (E.adjCentre) return;
  E.adjCentre = true;
  let n = 0, s = 0;
  for (const k of apprenants()) {
    const m = E.memoire[k] || {};
    for (const t in m) for (const v in m[t]) { const c = m[t][v]; if (c && c.n > 0) { n += c.n; s += c.s; } }
  }
  if (n >= BASE_MIN_OBS && (!E.base || !(E.base.n > 0))) {
    const moy = s / n, poids = 60;
    E.base = { n: poids, s: moy * poids, s2: moy * moy * poids, maj: Date.now() };
  }
  const avant = seuilCourant();
  if (avant !== SEUIL) {
    E.seuil = SEUIL;
    E.depuisAjustement = 0;
    journal('strategie', 'Entry threshold ' + avant + ' → ' + SEUIL + '. Scores are now centred: '
      + 'the learned adjustment used to add the same ~+25 to every token, and this threshold was '
      + 'learned against those inflated scores. Reset once, to the starting value'
      + (E.base ? ' (background return seeded at ' + (E.base.s / E.base.n).toFixed(1) + '%)' : '') + '.',
      [{ seuilAvant: avant, seuilApres: SEUIL, fond: E.base ? Math.round(E.base.s / E.base.n * 10) / 10 : null }]);
  }
}

/* ---- LES ANCIENNES CASES SE REGROUPENT, ELLES NE SE JETTENT PAS ----
 * La cle de l'audit change de forme : elle nomme desormais la REGLE et non le
 * jeton. Repartir de zero effacerait des semaines d'observations pour un
 * changement de nom — et repartirait justement sur la question qu'on essaie
 * enfin de pouvoir poser. On refond donc les anciennes cases dans les
 * nouvelles, en additionnant. C'est sans risque : ce sont les memes jetons,
 * comptes une seule fois, sous un nom qui les rassemble. */
function regroupeAudit() {
  if (!E.audit || typeof E.audit !== 'object') return;
  const neuf = {};
  let refondues = 0;
  for (const cle in E.audit) {
    const a = E.audit[cle];
    if (!a || typeof a.n !== 'number') continue;
    const i = cle.indexOf(' · ');
    const k = i < 0 ? cle : cle.slice(0, i + 3) + familleRefus(cle.slice(i + 3));
    if (k !== cle) refondues++;
    const d = neuf[k] || (neuf[k] = { n: 0, s: 0, montes: 0, effondres: 0 });
    d.n += a.n; d.s += a.s; d.montes += a.montes || 0; d.effondres += a.effondres || 0;
  }
  if (refondues) {
    console.log('[ai] audit : ' + refondues + ' case(s) regroupee(s) par regle plutot que par jeton — '
      + Object.keys(E.audit).length + ' → ' + Object.keys(neuf).length);
    E.audit = neuf;
  }
}

/* Ecriture atomique : fichier temporaire, puis rename. Une coupure au milieu
   laisse l'ancien intact. C'est la meme precaution que pour l'argent des
   joueurs — celui-ci ne porte que du papier, mais des semaines
   d'apprentissage perdues sont perdues quand meme. */
function sauve() {
  try {
    if (E.courbe.length > 2000) E.courbe = E.courbe.slice(-2000);
    if (E.flux.length > 200) E.flux = E.flux.slice(0, 200);
    if (E.journalStructure.length > 60) E.journalStructure = E.journalStructure.slice(0, 60);
    oublieLesVieuxConnus();
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(TMP, JSON.stringify(E));
    fs.renameSync(TMP, FICHIER);
  } catch (e) { /* disque plein ou volume absent : on continue sans garder */ }
}

/* La memoire des jetons deja juges ne peut pas grossir sans fin : on garde les
   plus recemment vus, et les bannis definitifs en priorite — ce sont eux qui
   font economiser le plus d'appels. */
function oublieLesVieuxConnus() {
  const cles = Object.keys(E.connus);
  if (cles.length <= SURV_MAX) return;
  cles.sort((a, b) => (E.connus[b].dernier || 0) - (E.connus[a].dernier || 0));
  const gardes = new Set(cles.slice(0, SURV_MAX));
  /* ---- CEUX QU'ON ATTEND EXPRES NE SE PERDENT PAS ----
   * La colonie voit une vingtaine de jetons par tour, toutes les deux minutes
   * et demie : quatre cents a l'heure. Un jeton mis de cote a deux minutes
   * pour etre rejuge a deux heures serait donc oublie bien avant d'y arriver,
   * et la regle d'age n'aurait jamais ramene personne — elle aurait
   * simplement arrete d'acheter. On garde donc ceux qui attendent leur age,
   * tant qu'ils sont dans la fenetre ou ils peuvent revenir. */
  const now = Date.now();
  for (const k of cles) {
    const c = E.connus[k];
    if (!c.verdict || !REFUS_AGE.test(c.verdict)) continue;
    const age = now - (c.ne || now);
    if (age <= AGE_MAX_MIN * 60000) gardes.add(k);
  }
  for (const k of cles) if (!gardes.has(k) && !E.connus[k].permanent) delete E.connus[k];
  /* et si les bannis a eux seuls debordent, on lache les plus vieux aussi */
  const reste = Object.keys(E.connus);
  if (reste.length > SURV_MAX * 2) {
    reste.sort((a, b) => (E.connus[a].dernier || 0) - (E.connus[b].dernier || 0));
    for (const k of reste.slice(0, reste.length - SURV_MAX * 2)) delete E.connus[k];
  }
}

/* ---- LE RELEVE DE CHAQUE SERVICE ----
 * Essais et reponses, par service. C'est ce qui permet de DIRE qu'une source
 * ne repond plus, au lieu de la voir echouer en silence et de croire que la
 * chaine est vide. */
/* ---- UN RELEVE QUI N'OUBLIE JAMAIS DECRIT UN PASSE, PAS UN PRESENT ----
 *
 * Ces compteurs vivent dans l'etat, donc ils survivent aux redemarrages, donc
 * ils totalisent TOUTE la vie du service. C'est ce qu'on veut d'un journal, et
 * c'est exactement ce qu'il ne faut pas pour une alerte : le noeud a cle
 * affichait « 11 696 refus sur 11 696 appels, 100 % » et envoyait verifier une
 * cle sur drpc.org, alors que le code avait deja retenu les methodes qu'il ne
 * sert pas et ne l'appelait plus. L'alerte decrivait un incident termine avec
 * les mots d'un incident en cours.
 *
 * On glisse donc la fenetre, comme pour les familles de refus : au-dela de
 * SERVICE_FENETRE essais, on divise tout par deux. Les proportions sont
 * conservees — un service qui refuse toujours reste a 100 % — mais un service
 * qui s'est remis remonte en quelques centaines d'appels au lieu de trainer sa
 * mauvaise reputation pour toujours. Le nombre affiche cesse d'etre un total
 * historique, et devient ce qu'il pretendait deja etre : ce qui se passe en ce
 * moment. */
const SERVICE_FENETRE = 600;

function noteService(nom, ok, detail) {
  const s = E.services[nom] || (E.services[nom] = { essais: 0, reussites: 0, dernier: 0, dernierEchec: null });
  s.essais++;
  if (ok) { s.reussites++; s.dernier = Date.now(); s.dernierEchec = null; }
  else s.dernierEchec = String(detail || 'echec').slice(0, 80);
  if (s.essais > SERVICE_FENETRE) {
    s.essais = Math.round(s.essais / 2);
    s.reussites = Math.min(s.essais, Math.round(s.reussites / 2));
  }
}

/* ---- ET CE QU'UN NOEUD A REFUSE DE SERVIR SE RETIENT D'UNE VIE A L'AUTRE ----
 * `sansMethode` ne vivait qu'en memoire. A chaque redeploiement la colonie
 * reapprenait les memes trois refus, en les payant : quelques lectures rendues
 * « inconnu » a chaque demarrage pour une reponse qui ne change pas. On le
 * range dans le releve du service, qui est deja persiste. */
function poseSansMethode(n, methode) {
  if (!n.sansMethode) n.sansMethode = {};
  if (n.sansMethode[methode]) return false;
  n.sansMethode[methode] = true;
  const s = E.services[n.cle] || (E.services[n.cle] = { essais: 0, reussites: 0, dernier: 0, dernierEchec: null });
  if (!s.sansMethode) s.sansMethode = {};
  s.sansMethode[methode] = true;
  /* L'adresse a laquelle ce refus a ete appris : un refus de dRPC ne vaut
     rien contre le fournisseur qui le remplace a la meme place. */
  s.sansMethodeUrl = n.url;
  return true;
}
/* Au demarrage, on remet dans chaque noeud ce que le releve avait retenu —
   sauf si l'adresse du noeud a change depuis : ce qu'un fournisseur refusait
   ne dit rien du suivant, et le nouveau repart sans casier. */
function reprendSansMethode() {
  for (const n of noeuds()) {
    const s = E.services[n.cle];
    if (!s || !s.sansMethode) continue;
    /* Un releve d'avant ce champ n'a pas d'adresse : on ne sait pas contre
       qui ses refus ont ete appris. Mesure en direct : le nœud Alchemy
       heritait des 421 refus de dRPC et n'etait jamais appele. Sans adresse,
       ou avec une autre, le casier tombe et le nœud repart a zero. */
    if (s.sansMethodeUrl !== n.url) {
      delete s.sansMethode; delete s.sansMethodeUrl;
      s.essais = 0; s.reussites = 0; s.dernierEchec = null;
      n.sansMethode = {};
      continue;
    }
    if (!n.sansMethode) n.sansMethode = {};
    for (const m of Object.keys(s.sansMethode)) n.sansMethode[m] = true;
  }
}

/* ------------------------------------------------------------- les lectures */
const nn = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
/* ---- LE LOGO D'UN JETON, OU RIEN ----
 * Les deux flux qu'on lit deja en portent un ; on ne paie donc aucun appel de
 * plus pour l'avoir. Ce qui est ecarte ici compte autant que ce qui passe :
 *   - GeckoTerminal rend « missing.png » quand il n'en a pas. C'est une
 *     chaine, pas une absence : sans ce filtre le portefeuille afficherait
 *     une image cassee et croirait montrer le jeton ;
 *   - tout ce qui n'est pas http(s) est refuse. Cette adresse part telle
 *     quelle dans un `src` : un `javascript:` venu d'une reponse de service
 *     n'a rien a faire dans la page.
 * Quand il n'y a pas de logo, on rend `null` — et l'ecran montre le monogramme
 * plutot qu'un carre vide qui se lirait comme une image qui n'a pas charge. */
const urlImage = (u) => {
  const x = String(u || '').trim();
  if (!/^https?:\/\//i.test(x)) return null;
  if (/missing\.png$/i.test(x)) return null;
  return x.slice(0, 300);
};
const CACHE = { goplus: {}, ohlcv: {}, dex: {}, chaine: {}, trades: {}, poolDe: {} };
const frais = (c, k, ttl) => { const x = c[k]; return (x && Date.now() - x.t < ttl) ? x.v : null; };
const garde = (c, k, v) => { c[k] = { t: Date.now(), v }; return v; };
const dors = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, opts) {
  const r = await fetch(url, opts || {});
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/* ---- LE NOEUD PUBLIC COUPE, ET IL FAUT LE PRENDRE AU SERIEUX ----
 * Mesure : sur six jetons a la file, QUATRE refus « Too Many Requests ». On
 * espace nos propres appels — plus efficace que de reprendre apres coup — avec
 * UNE reprise. Deux reprises sur un noeud qui refuse, c'est se faire couper
 * plus longtemps. Un echec reste un echec : il rend « inconnu ». */
/* ---- ET LE NOEUD DE LA CLE, QUAND IL Y EN A UNE ----
 * Il passe DEVANT les deux publics : c'est un debit qui nous appartient, alors
 * que les autres sont partages avec la terre entiere. Sa plage de journaux est
 * MESUREE, pas supposee : on part optimiste, et au premier refus de plage le
 * noeud retient la limite que le service annonce. Ecrire un chiffre a la main
 * ici, ce serait le croire sur parole — et se tromper en silence le jour ou il
 * change. */
function noeuds() {
  const l = [];
  const dk = (process.env.DRPC_API_KEY || '').trim();
  if (dk) {
    if (!noeuds._cle) noeuds._cle = { url: 'https://lb.drpc.org/ogrpc?network=robinhood&dkey=' + dk,
                                      cle: 'chaineCle', plageLogs: BLOCS_PLAFOND, dernier: 0 };
    l.push(noeuds._cle);
  }
  return l.concat(NOEUDS);
}

const NOEUDS = [
  { url: RPC_RH, cle: 'chaine', plageLogs: BLOCS_PLAFOND, dernier: 0 },
  { url: RPC_SECOURS, cle: 'chaine2', plageLogs: RPC_SECOURS_PLAGE, dernier: 0 },
];
/* ---- UN NOEUD QUI DIT « JE NE SERS PAS CETTE METHODE » EST CRU ----
 *
 * Releve sur la colonie apres treize heures : les deux noeuds dRPC ont rendu
 * « the method eth_getLogs does not exist/is not available » a CHACUN de leurs
 * 12 402 appels. Zero reussite, jamais. Ce n'est pas une saturation, ce n'est
 * pas un forfait : le reseau `robinhood` n'expose pas cette methode chez eux.
 *
 * Et on les rappelait a chaque lecture. Chaque somme de transferts payait donc
 * deux echecs certains avant d'arriver au seul noeud qui repond — lequel
 * saturait alors sous la charge entiere (1 801 refus sur 11 548), ce qui a
 * fait rater le budget d'appels 232 fois et laisse le Cobaye « non testable »
 * 27 fois sur 28, faute de detenteurs lus.
 *
 * On retient donc cette phrase-la comme on retenait deja la limite de plage :
 * elle vient du service, elle porte le NOM de la methode, et elle ne changera
 * pas d'ici la prochaine lecture.
 *
 * ---- ET LA SUITE : « IL GARDE LE RESTE » ETAIT FAUX ----
 *
 * Cette note disait que le noeud restait dans la liste pour tout le reste,
 * « `eth_call` et `eth_blockNumber` marchent tres bien chez lui ». Releve
 * suivant, sur la colonie : le noeud public refuse `eth_blockNumber`, le noeud
 * a cle refuse `eth_call`, et surtout — 1 153 appels a eux deux, ZERO reussite,
 * jamais, aucune methode. dRPC ne sert pas la chaine 4663. La cle n'y est pour
 * rien : la version publique echoue pareil.
 *
 * Apprendre methode par methode ne suffit alors pas. Chaque methode neuve se
 * paie une fois par noeud mort, et elle se paie cher : `unNoeud` espace ses
 * appels de 900 ms, donc chaque lecture attendait pres de deux secondes de
 * refus certains avant d'atteindre le seul noeud qui repond. C'est ce qui
 * faisait manquer le budget d'appels 261 fois par jour.
 *
 * On juge donc aussi le NOEUD, pas seulement ses methodes : beaucoup d'essais,
 * pas une reussite, il sort de la rotation. Avec un retour possible — un
 * service qui revient doit pouvoir etre retrouve — d'ou une tentative de
 * controle toutes les heures. Condamner sans appel un service qui peut
 * reapparaitre serait echanger une panne contre une autre. */
const SANS_METHODE = /the method ([\w_]+) (?:does not exist|is not available|not found)/i;
/* ---- UNE REVOCATION EST UNE REPONSE, PAS UNE PANNE ----
 * Le Cobaye demande au contrat ce qu'il ferait d'un envoi vers la piscine. Un
 * honeypot repond « execution reverted » — et c'est EXACTEMENT le
 * renseignement qu'on etait venu chercher. Le noeud, lui, a parfaitement
 * fonctionne : il a transmis la question et rapporte la reponse.
 *
 * Elle etait comptee comme un echec de lecture. Consequences mesurees sur la
 * colonie : le noeud officiel affichait 204 lectures reussies sur 462, avec
 * « execution reverted » comme dernier echec — donc chaque piege correctement
 * DETECTE degradait le taux de reussite de la chaine, et l'alerte annoncait
 * « 85 % des lectures refusees » en comptant des succes parmi elles. Le
 * chiffre servait ensuite a decider s'il fallait un autre fournisseur RPC :
 * il envoyait donc chercher une panne la ou le systeme faisait son travail.
 *
 * On note le noeud comme ayant repondu, et on releve quand meme l'erreur pour
 * que l'appelant y lise le refus du contrat. */
const EVM_REPONSE = /execution reverted|invalid opcode|out of gas|stack underflow|always failing/i;

/* Assez d'essais pour que « zero reussite » ne soit pas un coup de malchance :
   trois refus d'affilee arrivent, vingt-cinq sans une seule reussite, non. */
const NOEUD_MORT_ESSAIS = 25;
/* Et on retente quand meme, une fois par heure, pour lui laisser un retour. */
const NOEUD_RESONDE_MS = 60 * 60 * 1000;

/* Un noeud qui n'a jamais rien servi. La reponse est lue dans le releve, qui
   est persiste : la lecon survit donc au redemarrage, comme `sansMethode`. */
function noeudMort(n) {
  const s = E.services[n.cle];
  if (!s || s.reussites > 0 || s.essais < NOEUD_MORT_ESSAIS) return false;
  /* ---- ON N'ECARTE JAMAIS LE DERNIER QUI POURRAIT MARCHER ----
   * Sans cette condition, une panne passagere du noeud officiel au demarrage
   * — vingt-cinq lectures ratees d'affilee, ca arrive — le mettrait de cote
   * pour une heure, et la colonie se rabattrait sur deux noeuds qui ne
   * repondent pas davantage. On aurait echange une panne d'une minute contre
   * une heure d'aveuglement, en croyant faire une optimisation.
   * Ecarter n'a de sens que si l'on sait qu'autre chose fonctionne. */
  const unAutreMarche = Object.keys(E.services).some((k) => k !== n.cle
    && /^chaine/.test(k) && E.services[k] && E.services[k].reussites > 0);
  if (!unAutreMarche) return false;
  /* L'heure de controle : on le laisse repasser une fois, seul, pour voir. */
  if (Date.now() - (s.resonde || 0) > NOEUD_RESONDE_MS) return false;
  return true;
}

/* La plage demandee par un `eth_getLogs`, pour savoir quel noeud peut la
   servir. Une demande qu'on sait refusee n'est pas envoyee. */
/* ---- ELLE SE COMPTE COMME LE NOEUD LA COMPTE ----
 *
 * Releve sur la colonie apres soixante et une heures : le noeud a cle, 377
 * appels, 377 refus, tous avec la meme phrase — « ranges over 10000 blocks are
 * not supported on free plan ». Sa plage etait pourtant bien retenue a 10 000,
 * et la demande de secours de `lisChaine` faisait exactement 10 000.
 *
 * Exactement 10 000 blocs d'ECART — `toBlock - fromBlock`. Or de 100 a 110 il
 * y a onze blocs, pas dix : le noeud compte les deux bouts, et il refusait
 * donc chaque demande a un bloc pres. Un seul bloc de trop, 377 fois, et le
 * noeud de secours n'a jamais servi une seule lecture. La borne etait bonne,
 * c'est la regle qui la mesurait qui ne comptait pas comme lui. */
function plageDe(methode, params) {
  if (methode !== 'eth_getLogs') return 0;
  const f = params && params[0];
  if (!f || !f.fromBlock || !f.toBlock) return 0;
  const a = parseInt(f.fromBlock, 16), b = parseInt(f.toBlock, 16);
  return (isFinite(a) && isFinite(b)) ? Math.max(0, b - a + 1) : 0;
}
async function unNoeud(n, methode, params) {
  const depuis = Date.now() - n.dernier;
  if (depuis < 900) await dors(900 - depuis);
  n.dernier = Date.now();
  const r = await fetch(n.url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: methode, params: params || [] }),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  const coupe = r.status === 429 || (j && j.error && (j.error.code === 429
    || /too many|rate/i.test(String(j.error.message || ''))));
  if (coupe) { const e = new Error('coupe'); e.coupe = true; throw e; }
  /* ---- LE CORPS DIT POURQUOI, LE CODE NE DIT QUE « NON » ----
   * On testait `!r.ok` en premier, et on jetait donc « ranges over 5000 blocks
   * are not supported » pour ne garder que « rpc 400 ». La raison etait dans la
   * reponse, et on la perdait — si bien que la limite de plage annoncee par le
   * service ne pouvait jamais etre retenue, et qu'on lui renvoyait la meme
   * demande refusee a chaque tour. Le message d'abord, le code en dernier
   * recours. */
  if (j && j.error) throw new Error(String(j.error.message || 'rpc').slice(0, 80));
  if (!r.ok) throw new Error('rpc ' + r.status);
  if (!j) throw new Error('rpc illisible');
  return j.result;
}
/* On essaie les noeuds capables, dans l'ordre. Un refus pour saturation passe
   au suivant — c'est la seule facon d'avoir un second noeud qui serve a
   quelque chose. Un echec de tous reste un echec : il rend « inconnu ». */
async function rpc(methode, params) {
  const plage = plageDe(methode, params);
  const utiles = noeuds().filter((n) => plage <= n.plageLogs
    && !(n.sansMethode && n.sansMethode[methode]));
  /* Les morts sortent de la rotation — mais s'ils sont les seuls a pouvoir
     servir cette methode, on essaie quand meme : une lecture tentee et ratee
     vaut mieux qu'une lecture jamais tentee, et c'est la seule facon de voir
     qu'un service est revenu. */
  const vivants = utiles.filter((n) => !noeudMort(n));
  const capables = vivants.length ? vivants : utiles;
  if (!capables.length) throw new Error('no node serves ' + methode
    + (plage ? ' over a range of ' + plage + ' blocks' : ''));
  let derniere = null;
  for (let tour = 0; tour < 2; tour++) {
    for (const n of capables) {
      try {
        /* On note l'heure AVANT l'appel : sinon un noeud mort retente a chaque
           lecture tant qu'il echoue, et l'heure de controle ne servirait a
           rien. Une tentative par heure, qu'elle reussisse ou non. */
        const s0 = E.services[n.cle];
        if (s0 && s0.reussites === 0 && s0.essais >= NOEUD_MORT_ESSAIS) s0.resonde = Date.now();
        const r = await unNoeud(n, methode, params);
        noteService(n.cle, true);
        return r;
      } catch (e) {
        derniere = e;
        /* Le contrat a repondu non : le noeud a fait son travail. On le note
           comme tel, et on releve quand meme pour que l'appelant lise le
           refus. Sans ca, un piege detecte se lisait comme un noeud en
           panne. */
        if (EVM_REPONSE.test(String(e.message || ''))) { noteService(n.cle, true); throw e; }
        noteService(n.cle, false, e.coupe ? 'sature' : e.message);
        /* Le service annonce sa limite de plage : on la RETIENT, au lieu de lui
           renvoyer la meme demande a chaque tour. */
        /* Le noeud nomme la methode qu'il ne sert pas : on ne la lui
           redemandera plus. Le reste de ses methodes, si. */
        const sm = SANS_METHODE.exec(String(e.message || ''));
        if (sm && poseSansMethode(n, sm[1])) {
          console.log('[ai] ' + n.cle + ' : ne sert pas ' + sm[1]
            + ' — retenu, on ne le lui redemandera plus (il garde le reste)');
        }
        const m = /over (\d+) blocks/.exec(String(e.message || ''));
        if (m) {
          const max = parseInt(m[1], 10);
          if (max > 0 && max < n.plageLogs) {
            n.plageLogs = max;
            console.log('[ai] ' + n.cle + ' : plage de journaux limitee a ' + max
              + ' blocs — retenu, on ne le redemandera plus');
          }
        }
        /* ---- ET ON PASSE AU NOEUD SUIVANT, QUELLE QUE SOIT L'ERREUR ----
         * Ici on s'arretait des qu'un noeud rendait autre chose qu'une
         * saturation. L'intention etait bonne — insister sur un noeud qui
         * repond « non » ne sert a rien — mais la consequence ne l'etait pas :
         * une cle perimee sur le noeud de tete rendait un 403, et la boucle
         * s'arretait la, SANS jamais essayer les deux noeuds publics qui
         * marchaient parfaitement. Une cle expiree valait donc moins que pas de
         * cle du tout, et rien ne l'aurait montre : les lectures rendaient
         * « inconnu », comme lors d'une saturation ordinaire.
         * L'erreur d'un noeud ne dit rien des autres. On continue. */
      }
    }
    if (tour === 0) await dors(1800);
  }
  throw derniere || new Error('rpc');
}
let blocCache = { n: 0, t: 0 };
async function blocCourant() {
  if (blocCache.n && Date.now() - blocCache.t < 5000) return blocCache.n;
  const n = parseInt(await rpc('eth_blockNumber'), 16);
  blocCache = { n, t: Date.now() };
  return n;
}

/* ---- LES POOLS QUI VIENNENT DE NAITRE ----
 * Trois pages du flux des nouveaux, et RIEN d'autre. Le flux des tendances a
 * ete essaye comme point de comparaison : il occupait une place et pouvait
 * finir en position, alors que ce n'est pas ce qu'on vient chercher. */
async function lisPools() {
  const pools = new Map(), toks = new Map();
  for (const page of [1, 2, 3]) {
    let d = null;
    try { d = await jsonGT('/new_pools?include=base_token&page=' + page);
          noteService('pools', true); }
    catch (e) { noteService('pools', false, e.message); continue; }
    for (const inc of (d.included || [])) if (inc.type === 'token') toks.set(inc.id, inc.attributes);
    for (const p of (d.data || [])) {
      const a = p.attributes;
      const bt = p.relationships && p.relationships.base_token && p.relationships.base_token.data;
      const t = bt && toks.get(bt.id);
      if (!t || !t.address) continue;
      const addr = String(t.address).toLowerCase();
      const c = {
        addr, sym: (t.symbol || '?').toUpperCase().slice(0, 12), nom: (t.name || '').slice(0, 28),
        pool: a.address, origine: 'pools', logo: urlImage(t.image_url),
        prix: nn(a.base_token_price_usd),
        mc: nn(a.market_cap_usd) || nn(a.fdv_usd),
        liq: nn(a.reserve_in_usd),
        minutes: a.pool_created_at ? (Date.now() - Date.parse(a.pool_created_at)) / 60000 : null,
        cree: a.pool_created_at || null,
        tx: a.transactions || {},
        vol: { m5: nn(a.volume_usd && a.volume_usd.m5), h1: nn(a.volume_usd && a.volume_usd.h1),
               h6: nn(a.volume_usd && a.volume_usd.h6), h24: nn(a.volume_usd && a.volume_usd.h24) },
        ch_m5: nn(a.price_change_percentage && a.price_change_percentage.m5),
        ch_h1: nn(a.price_change_percentage && a.price_change_percentage.h1),
        ch_h6: nn(a.price_change_percentage && a.price_change_percentage.h6),
      };
      const prev = pools.get(addr);
      if (!prev || c.liq > prev.liq) pools.set(addr, c);
    }
    await dors(650);
  }
  return [...pools.values()];
}

/* ==========================================================================
 * GOPLUS : LA CLE ET LE SECRET
 *
 * « J'ai la GoPlus API mais il y a marqué App Key et App Secret, je sais pas
 *   laquelle copier-coller. »
 *
 * Les deux. Ce ne sont pas deux facons d'entrer, c'est une seule serrure a deux
 * pieces : la cle s'envoie en clair, le secret ne sort JAMAIS de la machine. On
 * les combine en une signature — sha1(cle + heure + secret) — qu'on echange
 * contre un jeton d'acces valable une heure. C'est ce jeton, et lui seul, qui
 * voyage ensuite sur chaque lecture.
 *
 * L'heure entre dans la signature pour qu'une signature interceptee ne serve
 * pas indefiniment. C'est aussi pourquoi une horloge serveur trop decalee fait
 * echouer l'authentification, et c'est la premiere chose a regarder si ca
 * refuse.
 *
 * ---- ET SANS CLE, TOUT MARCHE DEJA ----
 *
 * La lecture qu'on utilise repond sans authentification : c'est ce qui a servi
 * jusqu'ici. La cle ne debloque rien de nouveau, elle releve la limite de
 * debit. Donc au moindre probleme — jeton refuse, secret absent, horloge
 * decalee — on lit sans, et la colonie ne s'en apercoit pas.
 * ======================================================================== */
const GOPLUS_JETON_MS = 50 * 60e3;   /* le jeton vaut une heure ; on le renouvelle avant */
let goplusJeton = { valeur: null, jusqua: 0, essaye: false };

function goplusIdentifie() {
  return !!(process.env.GOPLUS_APP_KEY || '').trim() && !!(process.env.GOPLUS_APP_SECRET || '').trim();
}

async function goplusEntetes() {
  if (!goplusIdentifie()) return {};
  if (goplusJeton.valeur && Date.now() < goplusJeton.jusqua)
    return { Authorization: goplusJeton.valeur };
  const cle = process.env.GOPLUS_APP_KEY.trim();
  const secret = process.env.GOPLUS_APP_SECRET.trim();
  const t = Math.floor(Date.now() / 1000);
  try {
    const sign = require('crypto').createHash('sha1').update(cle + t + secret).digest('hex');
    const r = await fetch('https://api.gopluslabs.io/api/v1/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_key: cle, time: t, sign }),
      signal: AbortSignal.timeout(12000),
    });
    const j = await r.json().catch(() => null);
    const jeton = j && j.result && j.result.access_token;
    if (!r.ok || !jeton) throw new Error('code ' + ((j && j.code) || r.status));
    goplusJeton = { valeur: jeton, jusqua: Date.now() + GOPLUS_JETON_MS, essaye: true };
    noteService('goplusCle', true);
    if (!goplusJeton.dit) { goplusJeton.dit = true; console.log('[ai] GoPlus : jeton obtenu, les lectures sont authentifiees'); }
    return { Authorization: jeton };
  } catch (e) {
    /* On le NOTE et on lit sans. Une horloge decalee de plus de quelques
       minutes suffit a faire echouer la signature : c'est la premiere chose a
       verifier si ca refuse. */
    noteService('goplusCle', false, String(e.message || e).slice(0, 50));
    goplusJeton = { valeur: null, jusqua: Date.now() + 5 * 60e3, essaye: true, dit: goplusJeton.dit };
    return {};
  }
}

/* ---- « IL A REPONDU » N'EST PAS « IL SAIT » ----
 * Sur un jeton de sept minutes, GoPlus rend SEPT champs : deux taxes vides,
 * une adresse, rien d'autre. Les lire comme « pas de honeypot, aucune
 * concentration, aucune taxe, code verifie » donnait trente points de surete
 * a un jeton dont on ne savait rien — sur la classe de jetons ou le risque de
 * fuite est le plus grand. Chaque champ est tri-etat. */
async function lisGoplus(t) {
  const c = frais(CACHE.goplus, t.addr, TTL_GOPLUS);
  if (c !== null) { t.g = c; return; }
  let info = {};
  try {
    const j = await json('https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=' + t.addr,
                         { headers: await goplusEntetes() });
    info = (j.result || {})[t.addr] || {};
    noteService('goplus', true);
  } catch (e) { info = {}; noteService('goplus', false, e.message); }
  const su = (x) => x === '1';
  const hs = info.holders || [];
  let top = 0;
  for (const h of hs) {
    const p = nn(h.percent) * 100;
    if (Number(h.is_contract) === 1 || Number(h.is_locked) === 1) continue;
    if (/lock|burn|null/i.test(h.tag || '')) continue;
    if (p > top) top = p;
  }
  const lp = (info.lp_holders || []).reduce((s, h) =>
    s + ((Number(h.is_locked) === 1 || /lock|burn|null/i.test(h.tag || '')) ? nn(h.percent) * 100 : 0), 0);
  /* ---- GOPLUS SE CONTREDIT, ET C'EST LUI QUI NOUS LE DIT ----
   * Releve sur des jetons de deux minutes : il rend huit champs, dont
   * `is_in_dex: "0"` — alors qu'on vient de le TROUVER dans un pool. Cette
   * reponse-la est demontrablement fausse, ce qui apprend quelque chose sur
   * toutes les autres : ses zeros ne sont pas des observations, ce sont des
   * valeurs par defaut d'une fiche pas encore remplie.
   * Le probleme n'etait pas theorique. `is_open_source: "0"` etait lu comme
   * « code non verifie » et coutait huit points — appliques a un contrat que
   * GoPlus n'avait tout simplement pas encore regarde. On le penalisait pour
   * notre propre ignorance.
   * Quand il se contredit sur un fait qu'on connait, on considere qu'il ne
   * sait rien : c'est ce qu'il vient de prouver. */
  const seContredit = info.is_in_dex === '0' && !!t.pool;
  if (seContredit) compte('goplusSeContredit');
  t.g = garde(CACHE.goplus, t.addr, {
    have: !seContredit && (info.is_honeypot !== undefined || info.holder_count !== undefined
                           || info.is_open_source !== undefined),
    seContredit,
    honeypot: su(info.is_honeypot), cannotBuy: su(info.cannot_buy), pausable: su(info.transfer_pausable),
    ownerBal: su(info.owner_change_balance), selfd: su(info.selfdestruct),
    perslip: su(info.personal_slippage_modifiable), hpSame: su(info.honeypot_with_same_creator),
    slipMod: su(info.slippage_modifiable), cooldown: su(info.trading_cooldown), proxy: su(info.is_proxy),
    mintable: su(info.is_mintable),
    taxeSue: !seContredit && info.buy_tax !== undefined && info.buy_tax !== '',
    buyTax: Math.round(nn(info.buy_tax) * 100), sellTax: Math.round(nn(info.sell_tax) * 100),
    detSue: !seContredit && info.holder_count !== undefined, holders: parseInt(info.holder_count) || 0,
    topSu: !seContredit && hs.length > 0, top: Math.round(top * 10) / 10, lp: Math.round(lp),
    codeSu: !seContredit && info.is_open_source !== undefined,
    unverified: !seContredit && info.is_open_source === '0',
  });
}

async function lisOhlcv(pool) {
  const c = frais(CACHE.ohlcv, pool, TTL_OHLCV); if (c !== null) return c;
  try {
    /* ---- DES BOUGIES D'UNE MINUTE, PAS D'UN QUART D'HEURE ----
     * Avec `aggregate=15`, il faut une heure de vie pour obtenir les quatre
     * bougies dont une volatilite a besoin. Nos jetons en ont deux ou trois.
     * Releve : 0 sur 12 utilisables. On payait donc un appel par jeton pour un
     * trait qui ne pouvait JAMAIS etre calcule — et « vola ? » ressemblait a
     * un service en panne alors que c'etait notre demande qui etait absurde.
     * A la minute, le meme jeton devient mesurable des qu'il a quelques
     * minutes, et la fenetre de trente minutes decrit d'ailleurs mieux ce qui
     * nous interesse : la volatilite MAINTENANT. */
    const j = await jsonGT('/pools/' + pool + '/ohlcv/minute?aggregate=1&limit=30');
    const l = ((j.data || {}).attributes || {}).ohlcv_list || [];
    noteService('ohlcv', true);
    if (l.length < 4) return garde(CACHE.ohlcv, pool, { vola: null });
    /* Les bougies arrivent de la plus recente a la plus ancienne : les
       remettre dans l'ordre du temps, sinon les variations sont a l'envers. */
    const f = l.map((x) => nn(x[4])).reverse().filter((x) => x > 0);
    const r = [];
    for (let i = 1; i < f.length; i++) r.push((f[i] - f[i - 1]) / f[i - 1] * 100);
    if (!r.length) return garde(CACHE.ohlcv, pool, { vola: null });
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    const va = Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length);
    return garde(CACHE.ohlcv, pool, { vola: Math.round(va * 100) / 100 });
  } catch (e) { noteService('ohlcv', false, e.message); return garde(CACHE.ohlcv, pool, { vola: null }); }
}

/* Un SECOND avis sur le prix. Il ne dit pas qui se trompe : il dit a quel
   point le marche est mince ou rapide — ce qu'un agent doit savoir avant
   d'entrer. */
async function lisDex(addr) {
  const c = frais(CACHE.dex, addr, TTL_DEX); if (c !== null) return c;
  try {
    const j = await json('https://api.dexscreener.com/latest/dex/tokens/' + addr);
    const p = (j.pairs || []).filter((x) => String(x.chainId || '').toLowerCase() === 'robinhood');
    noteService('dex', true);
    if (!p.length) return garde(CACHE.dex, addr, { vu: false });
    p.sort((a, b) => nn(b.liquidity && b.liquidity.usd) - nn(a.liquidity && a.liquidity.usd));
    const q = p[0], i = q.info || {}, bt = q.baseToken || {};
    /* ---- IL EN DIT BEAUCOUP PLUS QU'UN PRIX ----
     * Cette reponse porte le pool, l'age, la liquidite, les compteurs d'achats
     * et les reseaux sociaux. Tant qu'on n'en lisait que le prix, retrouver un
     * jeton a partir de sa seule adresse — ce que rendent les deux flux de
     * DexScreener — demandait un appel de plus. Tout est deja la. */
    return garde(CACHE.dex, addr, {
      vu: true, prix: nn(q.priceUsd), pools: p.length,
      socials: (i.socials || []).length + (i.websites || []).length,
      /* Les liens eux-memes, pas seulement leur nombre : « affiche les reseaux
         s'il y en a ». Bornes, et on ne garde que http(s) — une reponse de
         service ne doit pas pouvoir poser un `javascript:` dans la page. */
      liens: []
        .concat((i.socials || []).map((x) => ({ type: String(x.type || 'lien').slice(0, 12),
                                                url: String(x.url || '') })))
        .concat((i.websites || []).map((x) => ({ type: 'site', url: String(x.url || '') })))
        .filter((x) => /^https?:\/\//i.test(x.url)).slice(0, 5),
      pool: q.pairAddress || null, sym: bt.symbol || '', nom: bt.name || '',
      logo: urlImage(i.imageUrl),
      liq: nn(q.liquidity && q.liquidity.usd), mc: nn(q.fdv) || nn(q.marketCap),
      cree: q.pairCreatedAt || null,
      tx: q.txns || {}, vol: { m5: nn((q.volume || {}).m5), h1: nn((q.volume || {}).h1),
                               h6: nn((q.volume || {}).h6), h24: nn((q.volume || {}).h24) },
      ch_m5: nn((q.priceChange || {}).m5), ch_h1: nn((q.priceChange || {}).h1),
      ch_h6: nn((q.priceChange || {}).h6),
    });
  } catch (e) { noteService('dex', false, e.message); return garde(CACHE.dex, addr, { vu: false }); }
}

/* ---- CE QUE LA CHAINE SAIT, ET QUE PERSONNE D'AUTRE NE SAIT ----
 * Sur un jeton de sept minutes, GoPlus n'a pas encore indexe. Les blocs, eux,
 * contiennent deja tout : qui detient quoi, en soldant les transferts. Ce
 * n'est pas une estimation, c'est une somme — et quand elle contredit un
 * service, c'est elle qui a raison. */
async function lisChaine(addr, minutes, pool) {
  const c = frais(CACHE.chaine, addr, TTL_CHAINE); if (c !== null) return c;
  try {
    const bloc = await blocCourant();
    /* ---- LA PLAGE DEMANDEE, ET CELLE QUI SUFFIT ----
     * `besoin` couvre exactement la vie du jeton ; la marge est une securite,
     * parce que la date de creation du pool peut retarder sur le deploiement
     * du contrat. Mais la marge n'est pas gratuite : elle poussait un jeton de
     * douze minutes au-dela des dix mille blocs du noeud de secours, qui
     * n'etait alors plus candidat — et quand l'officiel saturait, on ne lisait
     * plus rien du tout.
     * On essaie donc la plage avec marge, puis, si elle echoue, la plage qui
     * couvre TOUT DE MEME la vie entiere du jeton. Ce n'est pas une lecture
     * partielle : dix mille blocs valent dix-sept minutes de cette chaine, et
     * si le jeton est plus jeune que ca, tout y est. Une lecture amputee, elle,
     * donnerait de faux comptes de porteurs — pire que « inconnu ». */
    const besoin = (minutes > 0 && minutes < 300)
      ? Math.ceil(minutes * 60 / BLOC_SECONDES) : BLOCS_HEURE;
    const plages = [Math.min(BLOCS_PLAFOND, besoin + 6000)];
    if (besoin < 9000 && plages[0] > 10000) plages.push(10000);
    let logs = null, derniere = null;
    for (const large of plages) {
      try {
        /* `large` blocs, LES DEUX BOUTS COMPRIS : c'est ainsi que le noeud
           compte, et c'est ainsi que `plageDe` compte desormais. Voir la note
           au-dessus de `plageDe` : un bloc de trop a suffi a rendre le noeud
           de secours inutile 377 fois sur 377. */
        logs = await rpc('eth_getLogs', [{
          address: addr, topics: [SUJET_TRANSFERT],
          fromBlock: '0x' + Math.max(0, bloc - large + 1).toString(16), toBlock: '0x' + bloc.toString(16) }]);
        break;
      } catch (e) { derniere = e; }
    }
    if (logs === null) throw derniere || new Error('logs illisibles');
    /* ---- ZERO TRANSFERT N'EST PAS « PERSONNE NE LE GARDE » ----
     *
     * `minutes` est l'age de la PISCINE, pas du jeton : c'est
     * `pool_created_at` que rendent les flux. Un contrat peut vivre des heures
     * avant qu'on lui ouvre un marche — et la fenetre, taillee sur la piscine,
     * tombe alors entierement APRES ses transferts.
     *
     * Mesure faite a la main sur trois candidats du tour en cours :
     *
     *   CATALYSTANCH  « 3 min »   fenetre 7 783 blocs :   0 transferts
     *                             fenetre 200 000     :   4 transferts
     *   MAGATARD      « 3 min »   fenetre 7 783 blocs :   0 transferts
     *                             fenetre 200 000     :  91 transferts
     *   POOU          « 82 min »  fenetre 54 713      : 340 transferts
     *                             fenetre 200 000     : 737 transferts
     *
     * Le compte rendu, lui, restait honnete : sans montant lu, `porteurs` et
     * `top` sortent `null`, et `personne` exige d'avoir vu au moins un
     * transfert. Rien n'est donc INVENTE — mais tout revient « inconnu », et
     * l'inconnu coute des points a chaque fois. Un jeton parfaitement lisible
     * etait note comme un jeton illisible, systematiquement, parce qu'on avait
     * regarde au mauvais endroit. C'est la moitie de la phrase que l'alerte
     * repete depuis des jours : « chaque refus rend inconnu un jeton qu'on
     * aurait pu juger » — sauf qu'ici le noeud n'avait rien refuse.
     *
     * On relit donc large avant de conclure. Le cout est borne — une lecture
     * de plus, seulement quand la premiere n'a RIEN rendu — et le noeud sert
     * cette plage sans broncher : la requete porte l'adresse du jeton, donc
     * elle rend quelques dizaines de lignes, pas des milliers. */
    if (!logs.length && plages[0] < BLOCS_PLAFOND) {
      try {
        const large = await rpc('eth_getLogs', [{
          address: addr, topics: [SUJET_TRANSFERT],
          fromBlock: '0x' + Math.max(0, bloc - BLOCS_PLAFOND + 1).toString(16),
          toBlock: '0x' + bloc.toString(16) }]);
        if (large && large.length) {
          compte('fenetreElargie');
          logs = large;
        }
      } catch (e) { /* la fenetre etroite reste ce qu'on a ; elle est vide, et on le dira */ }
    }
    const solde = {}, recus = {}, contreparties = {}, envoyeurs = {}, receveurs = {};
    let brules = 0, total = 0, lus = 0;
    const lie = (a, b) => { (contreparties[a] || (contreparties[a] = new Set())).add(b); };
    const adr = (t) => ('0x' + String(t || '').slice(26)).toLowerCase();
    for (const l of (logs || [])) {
      const de = adr(l.topics[1]), vers = adr(l.topics[2]);
      /* Le montant n'est pas toujours dans `data` : certains contrats
         l'INDEXENT, et il arrive alors dans `topics[3]`. Ne lire que `data`
         rendait « zero porteur » — pas une lecture ratee, une conclusion
         FAUSSE. Trois jetons sur six mesures tombaient dedans. */
      const brut = (l.data && l.data !== '0x') ? l.data : (l.topics.length > 3 ? l.topics[3] : null);
      let v = 0;
      if (brut) { try { v = Number(BigInt(brut)); lus++; } catch (e) { v = 0; } }
      if (!isFinite(v)) v = 0;
      solde[de] = (solde[de] || 0) - v;
      solde[vers] = (solde[vers] || 0) + v;
      recus[vers] = 1;
      lie(de, vers); lie(vers, de);
      envoyeurs[de] = 1; receveurs[vers] = 1;
      if (de === ZERO) total += v;
      if (vers === ZERO || vers === MORT) brules += v;
    }
    /* ---- « REGARDE HOLDERSCAN, COMPRENDS CE QU'EST UN CONTRAT, UNE ADRESSE
     *      BURN, QUE TU ANALYSES MIEUX » ----
     *
     * Trois familles d'adresses apparaissent dans les transferts et ne sont
     * PAS des porteurs. Les compter fausse la concentration dans les deux
     * sens : soit on rejette un jeton sain parce qu'une piscine « tient 80 % »,
     * soit on accepte un jeton captif parce que le vrai gros porteur est noye.
     *
     *   1. Les adresses de destruction. Pas seulement 0x0 et 0xdead : les
     *      contrats brulent aussi vers 0x…0001 et quelques autres petites
     *      valeurs. Ce qui part la n'existe plus.
     *   2. LE CONTRAT DU JETON LUI-MEME. Ce qui lui est renvoye est
     *      generalement bloque — taxes accumulees, part reservee. Ce n'est
     *      detenu par personne.
     *   3. Les PISCINES et les routeurs. Un jeton a souvent plusieurs pools :
     *      on n'en connait qu'un a ce stade, et les autres se comptaient comme
     *      d'enormes porteurs. On ne les devine pas — on les RECONNAIT a leur
     *      forme : une piscine echange avec presque tout le monde, alors qu'un
     *      porteur echange avec une ou deux contreparties. Une adresse qui a
     *      traite avec au moins 40 % des participants, et qui a la fois recu et
     *      envoye, fait le marche ; elle ne le detient pas.
     */
    const p = String(pool || '').toLowerCase();
    const brulures = new Set([ZERO, MORT, String(addr).toLowerCase(), p]);
    for (let i = 1; i <= 9; i++) brulures.add('0x' + String(i).padStart(40, '0'));
    const participants = Object.keys(contreparties).length;
    const seuilPiscine = Math.max(4, Math.ceil(participants * 0.4));
    const infrastructure = [];
    let circ = 0, mx = 0, np = 0, gros = null;
    const detenteurs = [];
    for (const a in solde) {
      if (brulures.has(a)) continue;
      const v = solde[a];
      if (v <= 0) continue;
      const cp = contreparties[a] ? contreparties[a].size : 0;
      if (cp >= seuilPiscine && envoyeurs[a] && receveurs[a]) { infrastructure.push(a); continue; }
      circ += v; np++;
      detenteurs.push({ a, v });
      if (v > mx) { mx = v; gros = a; }
    }
    /* De vraies adresses qui detiennent vraiment : ce sont elles qui serviront
       de cobayes a l'epreuve de vente. On evite le plus gros — souvent le
       deployeur, parfois le seul a qui le contrat laisse tout faire. */
    detenteurs.sort((x, y) => y.v - x.v);
    const cobayes = detenteurs.slice(1, 4).map((x) => x.a);
    /* ---- « PERSONNE NE DETIENT » N'EST PAS « JE NE SAIS PAS » ----
     * Releve sur deux jetons reels de deux minutes : soixante et un transferts,
     * trente adresses, et TOUTES a zero net — la piscine tenait la totalite de
     * l'emission. La lecture etait parfaite ; c'est le compte rendu qui mentait,
     * parce qu'un circulant nul sortait « inconnu ». Or l'inconnu coute quatre
     * points, tandis que « trente adresses ont touche le jeton et aucune ne l'a
     * garde » devrait fermer la porte. On separe donc les deux : `montantsLus`
     * dit si on a su lire, `personne` dit ce qu'on a lu. */
    const su = lus > 0;
    return garde(CACHE.chaine, addr, {
      vu: true, montantsLus: su,
      transferts: (logs || []).length, recepteurs: Object.keys(recus).length,
      porteurs: su ? np : null,
      personne: su && np === 0 && (logs || []).length > 0,
      top: (su && circ > 0) ? Math.round(mx / circ * 1000) / 10 : null,
      plusGros: gros, cobayes,
      /* Ce qu'on a ecarte, et pourquoi : sans ca, « 12 porteurs » est un
         chiffre qu'on ne peut pas contester. */
      infra: infrastructure.length, participants,
      /* Et QUI fait le marche, pas seulement combien : quand la piscine n'a
         pas d'adresse — un identifiant Uniswap V4 —, c'est vers l'une de ces
         adresses-la que le Cobaye essaiera la sortie. Voir `cibleDeVente`. */
      infraAdresses: infrastructure.slice(0, 3),
      brule: (su && total > 0) ? Math.round(brules / total * 1000) / 10 : null,
    });
  } catch (e) { return garde(CACHE.chaine, addr, { vu: false }); }
}


/* ==========================================================================
 * LES DEUX AUTRES FLUX DE JETONS NEUFS
 *
 * « Que ce soit DexScreener ou GMGN pour l'agent Scout, qu'il y ait plusieurs
 *   sources de tokens, plus à analyser. »
 *
 * GMGN a ete essaye et il est inutilisable depuis un serveur : 403 Cloudflare,
 * y compris sur ethereum — c'est de la protection anti-robot, pas une absence
 * de la chaine 4663. Il est nomme dans `HORS_SERVICE` plutot que passe sous
 * silence, pour qu'on ne le re-essaie pas dans six mois.
 *
 * DexScreener, lui, sert DEUX flux qui marchent, et ils ne ramenent pas la
 * meme population que les nouveaux pools de GeckoTerminal :
 *
 *   - les PROFILS : des jetons dont quelqu'un a pris la peine de remplir la
 *     fiche. Releve : quinze jetons de la chaine 4663, ages de 8 a 133
 *     minutes, tous avec au moins un reseau social. C'est un signal en soi.
 *   - les POUSSES : des jetons dont quelqu'un a PAYE la mise en avant. Signal
 *     ambigu — l'argent depense n'est pas de la qualite — et c'est justement
 *     pour ca que la colonie doit l'apprendre au lieu qu'on en decide ici. Le
 *     trait `origine` est fait pour ca.
 *
 * Ces deux flux rendent des ADRESSES, pas des pools : on retrouve le pool par
 * DexScreener, qu'on interroge de toute facon.
 * ======================================================================== */
async function lisFluxDex(quoi) {
  const url = quoi === 'profils'
    ? 'https://api.dexscreener.com/token-profiles/latest/v1'
    : 'https://api.dexscreener.com/token-boosts/latest/v1';
  try {
    const d = await json(url);
    const l = Array.isArray(d) ? d : [d];
    noteService(quoi, true);
    return l.filter((x) => x && String(x.chainId || '').toLowerCase() === 'robinhood'
                        && /^0x[0-9a-f]{40}$/i.test(String(x.tokenAddress || '')))
            .map((x) => String(x.tokenAddress).toLowerCase());
  } catch (e) { noteService(quoi, false, e.message); return []; }
}

/* Une adresse seule ne suffit pas : il faut son pool, son prix, son age et sa
   liquidite pour la mettre dans le meme moule que les autres. DexScreener les
   porte tous, et c'est un seul appel. */
async function jetonDepuisDex(addr, origine) {
  const d = await lisDex(addr);
  if (!d.vu || !(d.prix > 0) || !d.pool) return null;
  return {
    addr, sym: (d.sym || '?').toUpperCase().slice(0, 12), nom: (d.nom || '').slice(0, 28),
    pool: d.pool, origine, logo: d.logo || null,
    prix: d.prix, mc: d.mc || 0, liq: d.liq || 0,
    minutes: d.cree ? (Date.now() - d.cree) / 60000 : null,
    cree: d.cree ? new Date(d.cree).toISOString() : null,
    tx: d.tx || {}, vol: d.vol || {},
    ch_m5: d.ch_m5 || 0, ch_h1: d.ch_h1 || 0, ch_h6: d.ch_h6 || 0,
    dex: d,   /* deja lu : le service ne sera pas rappele pour lui */
  };
}

/* ==========================================================================
 * LES TRADES, UN PAR UN
 *
 * C'est la source la plus riche des trois nouvelles, et la seule qui reponde a
 * une question qu'aucune autre ne pose : QUI achete. Un jeton peut afficher
 * quarante achats en une heure et n'avoir qu'un seul portefeuille derriere,
 * qui achete et revend a lui-meme pour fabriquer un graphique. Les compteurs
 * agreges — ceux du flux des pools — sont incapables de le voir : ils comptent
 * des transactions, pas des personnes.
 * ======================================================================== */
async function lisTrades(pool) {
  const c = frais(CACHE.trades, pool, TTL_TRADES); if (c !== null) return c;
  try {
    const j = await jsonGT('/pools/' + pool + '/trades?trade_volume_in_usd_greater_than=0');
    const l = (j.data || []).map((x) => x.attributes || {});
    noteService('trades', true);
    if (!l.length) return garde(CACHE.trades, pool, { vu: true, n: 0, acheteurs: 0, vendeurs: 0,
                                                      partDuPlusGros: 0, moyen: 0, volume: 0 });
    const parPortefeuille = {};
    let volume = 0, ach = 0;
    const acheteurs = new Set(), vendeurs = new Set();
    for (const a of l) {
      const v = nn(a.volume_in_usd);
      const qui = String(a.tx_from_address || '').toLowerCase();
      volume += v;
      if (qui) parPortefeuille[qui] = (parPortefeuille[qui] || 0) + v;
      if (String(a.kind) === 'buy') { ach++; if (qui) acheteurs.add(qui); }
      else if (qui) vendeurs.add(qui);
    }
    let gros = 0;
    for (const k in parPortefeuille) if (parPortefeuille[k] > gros) gros = parPortefeuille[k];
    return garde(CACHE.trades, pool, {
      vu: true, n: l.length, achats: ach, acheteurs: acheteurs.size, vendeurs: vendeurs.size,
      portefeuilles: Object.keys(parPortefeuille).length,
      volume: Math.round(volume * 100) / 100,
      moyen: l.length ? Math.round(volume / l.length * 100) / 100 : 0,
      partDuPlusGros: volume > 0 ? Math.round(gros / volume * 1000) / 10 : 0,
    });
  } catch (e) { noteService('trades', false, e.message); return garde(CACHE.trades, pool, { vu: false }); }
}

/* ==========================================================================
 * LA MEMOIRE : COMBIEN DE FOIS, COMBIEN EN MOYENNE, ET A QUEL POINT CA VARIE
 *
 * Une case retenait `{n, s}` : le nombre d'observations et leur somme. C'est
 * assez pour une moyenne, et ce n'est pas assez pour savoir si cette moyenne
 * veut dire quelque chose. « top 15-30 % rend +5 % en moyenne » peut vouloir
 * dire deux choses tres differentes : neuf resultats autour de +5 %, ou bien
 * quatre a +40 % et cinq a -25 %. Dans le premier cas la case predit ; dans le
 * second elle ne predit rien du tout, et s'y fier est pire que ne rien savoir.
 *
 * On garde donc aussi `s2`, la somme des carres. C'est de la que sort l'ecart
 * type — et c'est lui qui declenche la naissance d'un specialiste : une case
 * tres observee mais tres dispersee est une case coupee au mauvais endroit.
 * ======================================================================== */
/* ---- UNE MEMOIRE PLUS GRANDE DOIT AUSSI ETRE PLUS RECENTE ----
 *
 * DEMANDE : « une memoire plus grande ». Garder plus longtemps, seul, rend un
 * agent PLUS bete, pas moins : un marche de la semaine derniere pese alors
 * autant qu'hier, et sur ces jetons-la une semaine est une ere. La memoire
 * grandit donc dans les deux sens a la fois — on retient beaucoup plus de
 * cases (voir SURV_MAX), et chaque case s'estompe.
 *
 * L'estompage est une demi-vie : au bout de MEMOIRE_DEMIVIE_J jours, une
 * observation compte pour moitie. Rien n'est efface — c'est le POIDS qui
 * baisse, donc le compte, donc la confiance. Une lecon vieille de deux mois
 * ne disparait pas de l'ecran ; elle cesse simplement de decider seule.
 *
 * Applique paresseusement, a la lecture comme a l'ecriture, et jamais quand
 * l'ecart est infime (moins d'un millieme) : sinon deux apprentissages a la
 * suite dans la meme seconde feraient d'un compte de dix un 9,999999, et un
 * compte entier vaut mieux qu'un compte juste a l'epsilon pres.
 *
 * Zero desactive : `MEMOIRE_DEMIVIE_J=0` rend la memoire d'avant, entiere et
 * sans oubli. C'est un reglage, pas une conviction. */
const MEMOIRE_DEMIVIE_J = nEnv('MEMOIRE_DEMIVIE_J', 21);
function fane(c) {
  if (!c || !(MEMOIRE_DEMIVIE_J > 0)) return c;
  const now = Date.now();
  if (!c.maj) { c.maj = now; return c; }
  const j = (now - c.maj) / 86400000;
  if (!(j > 0)) return c;
  const f = Math.pow(0.5, j / MEMOIRE_DEMIVIE_J);
  if (!(f < 0.999)) return c;   /* rien de mesurable : on ne touche pas au compte */
  c.n *= f; c.s *= f; c.s2 *= f; c.maj = now;
  return c;
}
/* ==========================================================================
 * LES MOTS QUI SORTENT VERS L'ECRAN
 *
 * « Beaucoup d'anglophones vont regarder, il y a beaucoup trop de mots
 *   anglais et francais melanges. »
 *
 * La page est en anglais par defaut. Tout ce que ce fichier envoyait etait en
 * francais : les cases apprises, les refus, les missions. Un visiteur
 * anglophone voyait donc de l'anglais autour de donnees francaises — pire
 * que l'une ou l'autre langue seule.
 *
 * ---- POURQUOI ON NE RENOMME PAS LES CASES ----
 *
 * Un libelle de case EST une cle de memoire. `memCase(agent, trait, libelle)`
 * range des semaines d'apprentissage sous « liq 1-5k », « code inconnu »,
 * « concentration inconnue ». Renommer a la source rendrait chaque case
 * orpheline : la colonie paraitrait n'avoir jamais rien appris, et pas une
 * erreur n'apparaitrait a l'ecran pour le dire.
 *
 * On traduit donc A LA SORTIE, et seulement la. C'est sans perte parce qu'une
 * case est une ENUMERATION FIXE — pas une phrase avec des chiffres dedans.
 * Traduire « liq 1-5k » ne reecrit rien ; retraduire « trop jeune (2 min) :
 * on le reprend a 15 min » en reecrirait une, et une phrase reecrite n'est
 * plus ce que la colonie a dit. Ces phrases-la sont donc rendues en anglais A
 * LA SOURCE, la ou elles sont formees.
 *
 * ---- ET LA TABLE EST VERIFIEE, PAS SUPPOSEE ----
 *
 * Les 93 libelles ont ete recoltes en faisant passer des jetons couvrant
 * toutes les branches de la table des traits, pas recopies a la main. L'essai
 * refait cette recolte et exige que chacun ait sa traduction : un libelle
 * ajoute demain sans sa ligne ici fera echouer l'essai, pas l'ecran.
 * ======================================================================== */
const MOTS = {
  /* age */
  'age ?': 'age ?', 'ne de <10 min': 'born <10 min ago', '10-30 min': '10-30 min',
  '30 min-2 h': '30 min-2 h', '2-6 h': '2-6 h',
  /* liquidite */
  'liq<1k': 'pool <$1k', 'liq 1-5k': 'pool $1-5k', 'liq 5-25k': 'pool $5-25k',
  'liq 25-100k': 'pool $25-100k', 'liq>100k': 'pool >$100k',
  /* capitalisation */
  'mc <50k': 'cap <$50k', 'mc 50-500k': 'cap $50-500k', 'mc 0,5-5M': 'cap $0.5-5M',
  'mc >5M': 'cap >$5M',
  /* elan */
  '5m <-5%': '5m <-5%', '5m -5-0%': '5m -5-0%', '5m 0-5%': '5m 0-5%',
  '5m 5-20%': '5m 5-20%', '5m >20%': '5m >20%',
  /* pression acheteuse */
  'vendeurs devant': 'sellers ahead', 'equilibre': 'balanced',
  'acheteurs devant': 'buyers ahead', 'achats massifs': 'heavy buying',
  /* traders uniques */
  '<20 traders/h': '<20 traders/h', '20-100/h': '20-100/h', '100-500/h': '100-500/h',
  '>500/h': '>500/h',
  /* acceleration */
  'ca retombe': 'fading', 'stable': 'steady', 'ca accelere': 'accelerating',
  'explosion': 'exploding',
  /* origine */
  'trouve par pools': 'found via pools', 'trouve par profils': 'found via profiles',
  'trouve par recherche': 'found via search',
  /* conseiller */
  /* Les trois valeurs que le Conseiller peut rendre sont bornees dans le code
     (`['favorable','reserve','defavorable']`) — pas devinees ici. « prudent »
     n'existe pas : c'est ce que j'avais suppose, et c'est la donnee du serveur
     qui a dit « reserve ». Il reste dans la table au cas ou une ancienne case
     le porte encore. */
  'conseiller favorable': 'advisor: favourable', 'conseiller reserve': 'advisor: cautious',
  'conseiller prudent': 'advisor: cautious', 'conseiller defavorable': 'advisor: against',
  'conseiller non consulte': 'advisor not asked',
  /* epreuve de vente */
  'sortie non testee': 'exit not tested', 'sortie non testable': 'exit not testable',
  'sortie simulee OK': 'exit simulated OK', 'sortie bloquee': 'exit blocked',
  /* taxes */
  'taxe inconnue': 'tax unknown', 'aucune taxe': 'no tax', 'taxe <=10%': 'tax <=10%',
  'taxe >10%': 'tax >10%',
  /* code du contrat */
  'code inconnu': 'code unknown', 'code non verifie': 'code unverified',
  'code verifie': 'code verified',
  /* pouvoirs du proprietaire */
  'pouvoirs ?': 'owner powers ?', 'mint + proxy': 'mint + proxy',
  'emission possible': 'can mint', 'contrat proxy': 'proxy contract',
  'aucun pouvoir': 'no owner powers',
  /* concentration */
  'personne ne garde': 'nobody holds', 'concentration inconnue': 'concentration unknown',
  'top <5%': 'top <5%', 'top 5-15%': 'top 5-15%', 'top 15-30%': 'top 15-30%',
  'top 30-50%': 'top 30-50%', 'top >50%': 'top >50%',
  /* porteurs */
  '<10 porteurs': '<10 holders', '10-30': '10-30 holders', '30-100': '30-100 holders',
  '100-500': '100-500 holders', '>500 porteurs': '>500 holders',
  '<100 det': '<100 holders', '100-1k det': '100-1k holders', '1k-10k det': '1k-10k holders',
  '>10k det': '>10k holders', 'porteurs inconnus': 'holders unknown',
  /* part brulee */
  'rien brule': 'nothing burned', '<50% brule': '<50% burned',
  '50-90% brule': '50-90% burned', '>90% brule': '>90% burned',
  'brule inconnu': 'burn unknown',
  /* flux de trades */
  'flux inconnu': 'trades unknown', 'trop peu de trades': 'too few trades',
  'volume reparti': 'volume spread', 'un gros portefeuille': 'one large wallet',
  'un portefeuille domine': 'one wallet dominates', 'un seul fait tout': 'one wallet does it all',
  /* acheteurs uniques */
  'acheteurs ?': 'buyers ?', '<3 acheteurs': '<3 buyers', '3-8 acheteurs': '3-8 buyers',
  '8-20 acheteurs': '8-20 buyers', '>20 acheteurs': '>20 buyers',
  /* taille des tickets */
  'tailles ?': 'ticket size ?', 'tickets <$20': 'tickets <$20',
  'tickets $20-100': 'tickets $20-100', 'tickets $100-500': 'tickets $100-500',
  'tickets >$500': 'tickets >$500',
  /* pools */
  'pools ?': 'pools ?', '1 pool': '1 pool', '2-3 pools': '2-3 pools', '>=4 pools': '>=4 pools',
  /* accord entre sources */
  'une seule source': 'single source', 'prix concordants': 'prices agree',
  'ecart <2%': 'gap <2%', 'ecart 2-6%': 'gap 2-6%', 'ecart >6%': 'gap >6%',
  /* reseaux */
  'reseaux ?': 'socials ?', 'aucun reseau': 'no socials', '1-2 reseaux': '1-2 socials',
  '3+ reseaux': '3+ socials',
  /* volatilite */
  'vola ?': 'volatility ?', 'calme': 'calm', 'vola 2-5%': 'volatility 2-5%',
  'vola 5-12%': 'volatility 5-12%', 'vola >12%': 'volatility >12%',

  /* ---- ET CEUX QUI APPRENNENT DE LEUR PROPRE TRAVAIL ----
   * La Sentinelle, le Promoteur, le Banquier et le Closer n'ont pas de traits
   * de jeton : leurs cases viennent de `casSentinelle`, `casPromoteur`,
   * `casSortie`, du regime de caisse et de la duree de tenue. Elles sont donc
   * ABSENTES de la table des traits — et la recolte qui parcourt cette table
   * ne pouvait pas les voir. Elles s'affichent pourtant sur la meme page, et
   * ce sont des cles de memoire comme les autres. */
  /* la Sentinelle : ou en est le prix, et ou en est la piscine */
  'effondre': 'collapsed', 'en baisse': 'falling', 'a plat': 'flat',
  'en hausse': 'rising', 'envole': 'flying',
  'piscine ?': 'pool ?', 'piscine divisee par 2': 'pool halved',
  'piscine en baisse': 'pool shrinking', 'piscine stable': 'pool steady',
  'piscine qui grossit': 'pool growing',
  /* le Promoteur : le gain courant, et la note d'entree */
  'en perte': 'in loss', 'a peine positive': 'barely positive',
  '+10-30%': '+10-30%', '+30-80%': '+30-80%', '+80% et plus': '+80% and up',
  'note 55-60': 'score 55-60', 'note 60-70': 'score 60-70',
  'note 70-85': 'score 70-85', 'note 85+': 'score 85+',
  /* la Sentinelle, encore : a quel palier le gain a ete pris */
  'gain pris a +20-35%': 'gain taken at +20-35%', 'gain pris a +35-60%': 'gain taken at +35-60%',
  'gain pris a +60-120%': 'gain taken at +60-120%', 'gain pris a +120%': 'gain taken at +120%',
  /* le Banquier : le regime de caisse */
  'autour du depart': 'around the start', 'au-dessus': 'above it',
  'sous le depart': 'below the start', 'en creux': 'in a trough',
};

/* Une case croisee (« ne de <10 min × mc <50k ») se traduit part par part :
   c'est le specialiste qui les fabrique, et sa cle garde le meme separateur. */
function enMots(v) {
  if (typeof v !== 'string' || !v) return v;
  if (MOTS[v] !== undefined) return MOTS[v];
  /* ---- LES CASES QUI PORTENT UN NOMBRE ----
   * « 0e prolongation », « 2e prolongation » : le nombre fait partie de la
   * cle, donc il ne peut pas y avoir une ligne par valeur dans la table. Un
   * motif, et il rend le meme nombre — on ne traduit que les mots autour. */
  const pro = /^(\d+)e prolongation$/.exec(v);
  if (pro) return pro[1] === '0' ? 'never extended' : 'extended ' + pro[1] + 'x';
  if (v.indexOf(' \u00d7 ') >= 0)
    return v.split(' \u00d7 ').map((x) => (MOTS[x.trim()] !== undefined ? MOTS[x.trim()] : x.trim()))
            .join(' \u00d7 ');
  return v;
}

function memLit(a, t, v) {
  const m = E.memoire;
  const c = (m[a] && m[a][t] && m[a][t][v]) || null;
  return c ? fane(c) : null;
}
function memCase(a, t, v) {
  const m = E.memoire;
  if (!m[a]) m[a] = {};
  if (!m[a][t]) m[a][t] = {};
  if (!m[a][t][v]) m[a][t][v] = { n: 0, s: 0, s2: 0, maj: Date.now() };
  if (m[a][t][v].s2 === undefined) m[a][t][v].s2 = 0;   /* une case d'avant la variance */
  return fane(m[a][t][v]);
}
const CONFIANCE_K = 6;
const confiance = (n) => n / (n + CONFIANCE_K);
/* L'ecart type d'une case, ou `null` quand on ne peut pas encore le dire :
   une case relue d'une version anterieure n'a pas de somme des carres, et
   inventer un ecart type serait exactement la faute que ce fichier evite. */
function ecartType(c) {
  if (!c || c.n < 2 || !c.s2) return null;
  const moy = c.s / c.n;
  const va = c.s2 / c.n - moy * moy;
  return va > 0 ? Math.sqrt(va) : 0;
}

/* ==========================================================================
 * UNE CASE NE VAUT QUE PAR RAPPORT AUX AUTRES
 *
 * Releve sur la colonie apres soixante et une heures, sur les vingt candidats
 * du dernier tour : note de base de -7 a 44, et l'ajustement appris de +21 a
 * +28 — POUR TOUS. Vingt jetons differents, le meme +25. Un ajustement qui
 * vaut la meme chose pour tout le monde ne distingue plus rien : il decale
 * l'echelle, et c'est tout. Le seuil d'entree l'a suivi jusqu'a 70, s'est
 * bloque la (voir « le seuil montait et ne pouvait plus redescendre »), et la
 * colonie a passe des heures sans acheter — sur un chiffre qui ne parlait pas
 * des jetons.
 *
 * La raison est simple : chaque case retenait sa moyenne BRUTE. Or le flux
 * entier rend, a l'echeance de reference, une moyenne tres positive — quelques
 * dix-fois au milieu de beaucoup de petites pertes. Toutes les cases heritent
 * donc de ce +25 de fond, et « liq 1-5k rend +38 » ne dit pas que cette case
 * est bonne : elle est a peine au-dessus du lot. La seule chose qu'une case
 * sache dire, c'est en quoi elle differe du reste.
 *
 * On soustrait donc le fond — la moyenne de TOUT ce qu'on a observe, tenue
 * dans `E.base` et fanee comme les cases. Une case qui rend le fond pese zero ;
 * au-dessus elle monte la note, en dessous elle la baisse. Le fond n'est
 * soustrait que quand il est mesure sur assez d'observations : en dessous, on
 * ne soustrait rien, comme avant.
 *
 * Il ne s'applique qu'aux agents qui NOTENT un jeton (voir `analyse`). La
 * Sentinelle et le Promoteur apprennent des DIFFERENCES — ce qu'a rendu une
 * sortie contre ce que garder aurait donne — et un fond de rendement n'a rien
 * a faire dans une difference.
 * ======================================================================== */
const BASE_MIN_OBS = 20;
function apprendBase(r) {
  if (!E.base || typeof E.base !== 'object') E.base = { n: 0, s: 0, s2: 0, maj: Date.now() };
  const c = fane(E.base);
  const x = Math.max(-95, Math.min(300, r));
  c.n++; c.s += x; c.s2 += x * x;
}
function baseCourante() {
  const c = E.base ? fane(E.base) : null;
  if (!c || !(c.n >= BASE_MIN_OBS)) return 0;
  return c.s / c.n;
}

function ajustementAgent(agent, cases, base) {
  if (!cases) return 0;
  const fond = (typeof base === 'number' && isFinite(base)) ? base : 0;
  let somme = 0, vus = 0;
  /* La case non lue la MIEUX OBSERVEE de cet agent, et elle seule. Voir la
     table des cases non lues, plus haut : les trois traits d'un agent sortent
     souvent d'un seul appel, donc trois « inconnu » ne sont qu'un seul fait. */
  let creux = null, creuxN = 0;
  for (const k in cases) {
    const c = memLit(agent, k, cases[k]);
    if (!c || !c.n) continue;
    /* ---- UNE CASE QUI NE PREDIT RIEN NE PESE PAS ----
     * Sa moyenne peut etre flatteuse ; si les resultats sont partout, elle est
     * le fruit du hasard. On la degonfle par sa propre dispersion plutot que
     * de la laisser tirer la note. */
    const sd = ecartType(c);
    const fiable = sd === null ? 1 : Math.max(0.25, Math.min(1, ECART_TYPE_BRUIT / Math.max(1, sd)));
    const part = confiance(c.n) * fiable * Math.max(-30, Math.min(30, c.s / c.n - fond));
    if (caseNonLue(cases[k])) {
      /* Bornee a zero PAR LE HAUT : ne rien savoir peut inquieter, ne peut
         jamais rassurer. C'est la regle du haut du fichier, tenue ici. */
      if (c.n > creuxN) { creuxN = c.n; creux = Math.min(0, part); }
      continue;
    }
    somme += part;
    vus++;
  }
  if (creux !== null) { somme += creux; vus++; }
  if (!vus) return 0;
  return Math.max(-12, Math.min(12, somme * 0.45));
}
function apprendAgent(agent, cases, rendement) {
  if (!cases) return;
  const r = Math.max(-95, Math.min(300, rendement));
  for (const k in cases) { const c = memCase(agent, k, cases[k]); c.n++; c.s += r; c.s2 += r * r; }
}
function leconsDe(agent, max) {
  const m = E.memoire[agent] || {}, out = [];
  for (const t in m) for (const v in m[t]) {
    const c = fane(m[t][v]);
    if (c.n < 2) continue;
    const moy = c.s / c.n;
    const sd = ecartType(c);
    /* `nonLue` est PUBLIE, pas cache. Ces lignes-la restent affichables — « ce
       que valent les jetons qu'on n'a pas pu lire » est une vraie mesure — mais
       lues sans le mot, elles se lisent comme un jugement sur le jeton, alors
       qu'elles jugent nos propres lectures. Le mot est la difference. */
    /* Traduit ICI, a la sortie, jamais dans la cle : voir la table des mots. */
    out.push({ quoi: enMots(v), n: Math.round(c.n * 10) / 10, moyenne: Math.round(moy * 10) / 10,
               ecart: sd === null ? null : Math.round(sd * 10) / 10,
               nonLue: caseNonLue(v) || undefined,
               poids: confiance(c.n) * Math.abs(moy) });
  }
  out.sort((a, b) => b.poids - a.poids);
  return out.slice(0, max || 3);
}

/* ---- LES TRAITS D'UN JETON, PAR AGENT ----
 * Construits depuis le roster, donc valables pour les agents nes hier comme
 * pour ceux du depart. Un agent ne voit que SES traits : c'est ce qui fait
 * qu'ils apprennent tous, chacun sur ce dont il repond. */
function traitsDe(t) {
  const out = {};
  const APART = ['banque', 'execution', 'veille', 'prolonge'];
  for (const a of E.roster) {
    /* ---- CEUX QUI APPRENNENT DE LEUR PROPRE TRAVAIL ----
     * Le Banquier apprend d'une mise, le Closer d'une duree, la Sentinelle de
     * ses alertes, le Promoteur de ses prolongations. Aucun des quatre
     * n'apprend des traits du jeton — et c'est justement la demande : « chaque
     * agent doit apprendre et ameliorer son propre travail, pas attendre le
     * resultat final des trades ». */
    if (APART.indexOf(a.role) >= 0) continue;
    const c = {};
    for (const spec of a.traits) c[nomTrait(spec)] = litTrait(spec, t);
    out[a.key] = c;
  }
  return out;
}
/* Les agents qui apprennent d'une position fermee : tous ceux qui portent des
   traits de jeton. Le Banquier et le Closer apprennent, eux aussi, mais sur
   leurs propres cases — la mise et la duree. */
/* Ceux qui n'apprennent pas d'un rendement. Le Veilleur en fait partie par
   construction : il regarde et ne decide rien, donc il n'y a aucune decision
   dont il puisse tirer une lecon. L'y laisser l'aurait inscrit parmi les
   apprenants — sans effet, ses traits etant vides, mais en le presentant a
   l'ecran comme un agent qui apprend alors qu'il ne le fera jamais. */
const ROLES_A_PART = ['banque', 'execution', 'veille', 'prolonge', 'suivi'];
function apprenants() {
  return E.roster.filter((a) => ROLES_A_PART.indexOf(a.role) < 0).map((a) => a.key);
}

/* ==========================================================================
 * LE BANQUIER
 *
 * « Quand on place le bet il faudrait deux agents, un en plus gestion de
 *   bankroll. Il s'adapte à la bankroll qu'il a actuellement et s'améliore
 *   avec le temps. Il connaît toutes les techniques possibles pour gérer une
 *   bankroll. Chaque agent prend des notes et retient toutes les données pour
 *   s'améliorer seul. »
 *
 * Deux agents decident donc a l'ouverture : le Closer dit OUI, le Banquier dit
 * COMBIEN. Jusqu'ici la mise etait une constante — cinquante dollars, que la
 * caisse en contienne mille ou cent. C'est le defaut qui tue les caisses : la
 * meme mise sur une caisse qui a fondu est une part de plus en plus grande, et
 * la ruine arrive par un chemin que personne ne regarde.
 *
 * ---- LES METHODES QU'IL CONNAIT ----
 *
 * Ce sont les vraies, pas des noms. Il les essaie et il garde le releve de
 * chacune, par REGIME de caisse — parce qu'une methode qui va bien quand on
 * est au-dessus du depart n'est pas forcement celle qui ramene d'un creux.
 *
 *   fixe       la mise de depart, quoi qu'il arrive. Le temoin : sans lui, on
 *              ne saurait pas si les autres font mieux que rien.
 *   part       un pourcentage constant de la caisse. Mise a l'echelle : on ne
 *              peut jamais se ruiner, on peut seulement s'approcher de zero.
 *   kelly      la part optimale au sens de Kelly, calculee sur SON propre taux
 *              de reussite et SON propre rapport gain/perte — et divisee par
 *              quatre. Kelly plein est mathematiquement optimal et
 *              pratiquement insupportable : il suppose qu'on connait ses
 *              probabilites, et on ne les connait jamais.
 *   confiance  proportionnelle a la marge de la note au-dessus du seuil. Une
 *              note de 90 engage plus qu'une note de 56.
 *   paliers    on reduit apres une serie perdante, on remonte apres une serie
 *              gagnante. Ce n'est pas une martingale — c'est l'inverse, et
 *              c'est voulu : doubler apres une perte est la seule methode qui
 *              garantit la ruine.
 *
 * ---- ET CE QU'IL NE PEUT PAS APPRENDRE ----
 *
 * Les quatre bornes en tete de fichier. Il choisit sa methode ; il ne choisit
 * pas de miser un tiers de la caisse sur un jeton de deux minutes.
 * ======================================================================== */
const METHODES = ['fixe', 'part', 'kelly', 'confiance', 'paliers'];
const PART_BASE = 0.03;         /* 3 % de la caisse : le point de depart de « part » */

/* Le regime de la caisse. Le creux est separe du reste a dessein : c'est le
   moment ou les methodes se distinguent vraiment, et ou une mauvaise fait le
   plus de degats. */
function regime() {
  const b = E.banque;
  const creux = b.pic > 0 ? (b.pic - E.tresor) / b.pic : 0;
  if (creux >= 0.15) return 'en creux';
  if (E.tresor < DEPART * 0.9) return 'sous le depart';
  if (E.tresor > DEPART * 1.2) return 'au-dessus';
  return 'autour du depart';
}

/* Ce que la colonie a reellement obtenu : son taux de reussite et le rapport
   entre ce que gagne une gagnante et ce que perd une perdante. Sans ces deux
   chiffres, Kelly n'est qu'une formule ; avec eux, c'est une mesure. */
function statsRendement() {
  const g = E.banque.memoire.__global || null;
  if (!g || g.n < 8) return null;
  const p = g.gagnantes / g.n;
  const moyG = g.gagnantes ? g.sommeGains / g.gagnantes : 0;
  const moyP = (g.n - g.gagnantes) ? g.sommePertes / (g.n - g.gagnantes) : 0;
  if (!(moyP > 0)) return null;
  return { p, b: moyG / moyP, n: g.n };
}

function partDeLaMethode(m, score) {
  const b = E.banque;
  if (m === 'fixe') return E.tresor > 0 ? MISE / E.tresor : PART_BASE;
  if (m === 'part') return PART_BASE;
  if (m === 'confiance') {
    const marge = Math.max(0, Math.min(1, (score - SEUIL) / Math.max(1, 100 - SEUIL)));
    return PART_BASE * (0.6 + 1.4 * marge);
  }
  if (m === 'paliers') {
    /* La serie compte les positions fermees d'affilee dans le meme sens. On
       reduit quand ca va mal, on remonte quand ca va bien — et jamais
       l'inverse, qui est la martingale. */
    const s = b.serie || 0;
    const f = s <= -3 ? 0.4 : s <= -1 ? 0.7 : s >= 3 ? 1.4 : s >= 1 ? 1.15 : 1;
    return PART_BASE * f;
  }
  if (m === 'kelly') {
    const st = statsRendement();
    /* Sans releve, Kelly n'a rien pour calculer. On ne devine pas : on retombe
       sur la part de base, et on le DIT dans la raison. */
    if (!st) return PART_BASE;
    const f = (st.p * st.b - (1 - st.p)) / st.b;
    return Math.max(0, f) / 4;   /* Kelly au quart */
  }
  return PART_BASE;
}

/* La methode retenue : celle dont le releve est le meilleur DANS LE REGIME OU
   L'ON EST, a confiance egale. En dessous de quelques observations, on garde
   celle par defaut plutot que de suivre un coup de chance. */
function methodeApprise() {
  const reg = regime();
  let best = null;
  for (const m of METHODES) {
    const c = E.banque.memoire[m + '|' + reg];
    if (!c || c.n < 5) continue;
    const note = confiance(c.n) * (c.s / c.n);
    if (!best || note > best.note) best = { m, note, moy: c.s / c.n, n: c.n };
  }
  if (!best) return { methode: E.banque.methode || 'part', appris: false, regime: reg };
  return { methode: best.m, appris: true, regime: reg,
           moy: Math.round(best.moy * 10) / 10, n: best.n };
}

/* ---- COMBIEN ENGAGER ----
 * Rend la mise ET la raison, en toutes lettres. Une mise sans sa raison est un
 * chiffre qu'on ne peut pas contester ; celle-ci s'affiche sur la page avec ce
 * qui l'a bornee. */
function miseDe(score) {
  const ch = methodeApprise();
  const engage = E.positions.reduce((s, p) => s + (p.mise || 0), 0);
  const raisons = [];

  if (E.tresor < PLANCHER) return { mise: 0, methode: ch.methode, regime: ch.regime,
    raison: 'treasury below the $' + PLANCHER + ' floor: we stop opening', arret: true };

  let part = partDeLaMethode(ch.methode, score);
  if (ch.methode === 'kelly' && !statsRendement()) raisons.push('Kelly without enough record: base fraction');

  let mise = E.tresor * part;
  const plafondUn = E.tresor * MISE_PART_MAX;
  if (mise > plafondUn) { mise = plafondUn; raisons.push('capped at ' + (MISE_PART_MAX * 100) + '% of the treasury'); }
  const restant = E.tresor * EXPO_PART_MAX - engage;
  if (mise > restant) { mise = restant; raisons.push('total exposure capped at ' + (EXPO_PART_MAX * 100) + '%'); }
  if (mise < MISE_MIN) {
    if (restant < MISE_MIN) return { mise: 0, methode: ch.methode, regime: ch.regime,
      raison: 'already $' + Math.round(engage) + ' committed: no room left under the exposure cap' };
    mise = MISE_MIN; raisons.push('raised to the $' + MISE_MIN + ' minimum');
  }
  if (mise > E.tresor) { mise = E.tresor; raisons.push('capped at the treasury'); }
  mise = Math.round(mise * 100) / 100;
  return { mise, methode: ch.methode, appris: ch.appris, regime: ch.regime,
           part: Math.round(part * 10000) / 100,
           raison: raisons.length ? raisons.join(' · ') : ch.methode + ' method, « ' + enMots(ch.regime) + ' » regime' };
}

/* ---- CE QUE LE BANQUIER RETIENT D'UNE POSITION FERMEE ----
 * Le rendement en POURCENTAGE, pas en dollars : sinon la methode qui mise le
 * plus gagne toujours dans le releve, quel que soit son merite. Et il retient
 * le releve global dont Kelly a besoin. */
function banquierApprend(p, rendement) {
  const b = E.banque;
  const cle = (p.methode || 'fixe') + '|' + (p.regime || 'autour du depart');
  const c = b.memoire[cle] || (b.memoire[cle] = { n: 0, s: 0, s2: 0 });
  const r = Math.max(-95, Math.min(300, rendement));
  c.n++; c.s += r; c.s2 += r * r;

  const g = b.memoire.__global || (b.memoire.__global = { n: 0, gagnantes: 0, sommeGains: 0, sommePertes: 0 });
  g.n++;
  if (r > 0) { g.gagnantes++; g.sommeGains += r; } else g.sommePertes += Math.abs(r);

  b.serie = r > 0 ? Math.max(1, (b.serie || 0) + 1) : Math.min(-1, (b.serie || 0) - 1);
  if (E.tresor > (b.pic || 0)) b.pic = E.tresor;
  b.methode = methodeApprise().methode;
}

/* ==========================================================================
 * NOTER UN JETON QUI VIENT DE NAITRE
 *
 * La note mesure ce qui EXISTE a cet age. Et ce qui n'existe pas ne rapporte
 * rien : un champ qu'on n'a pas lu vaut « inconnu », jamais « bon ».
 * ======================================================================== */
function scoreBase(t) {
  const g = t.g || {}, ch = t.chaine || {}, x = t.tx || {}, tr = t.trades || {}, d = t.dex || {};
  const h1 = x.h1 || {};
  let s = 30;
  s += t.liq >= 1e5 ? 16 : t.liq >= 25e3 ? 13 : t.liq >= 8e3 ? 9 : t.liq >= 3e3 ? 5 : t.liq >= 1e3 ? 1 : -6;

  const top = (ch.vu && ch.top !== null && ch.top !== undefined) ? ch.top : (g.topSu ? g.top : null);
  if (top === null) s -= 4;
  else s += top < 5 ? 14 : top < 15 ? 9 : top < 30 ? 2 : top < 50 ? -10 : -26;

  const det = (ch.vu && ch.porteurs !== null && ch.porteurs !== undefined) ? ch.porteurs
            : (g.detSue ? g.holders : null);
  if (det === null) s -= 3;
  else s += det >= 120 ? 12 : det >= 50 ? 9 : det >= 20 ? 5 : det >= 8 ? 1 : -6;

  if (ch.vu && ch.brule !== null && ch.brule !== undefined)
    s += ch.brule >= 90 ? 8 : ch.brule >= 50 ? 5 : ch.brule >= 10 ? 2 : 0;

  const ach = h1.buys || 0, ven = h1.sells || 0, uniq = h1.buyers || 0;
  if (ach + ven > 0) {
    const r = ach / Math.max(1, ven);
    s += r >= 2 ? 8 : r >= 1.3 ? 5 : r >= 0.9 ? 1 : r >= 0.6 ? -3 : -8;
  } else s -= 4;
  s += uniq >= 60 ? 9 : uniq >= 25 ? 6 : uniq >= 10 ? 3 : uniq >= 3 ? 0 : -5;

  /* ---- CE QUE LES TRADES AJOUTENT, ET QUE RIEN D'AUTRE NE DIT ----
   * Des PERSONNES, pas des transactions. Quarante achats faits par un seul
   * portefeuille ne valent pas quarante achats faits par trente. Les
   * compteurs agreges sont incapables de faire la difference ; ceux-ci la
   * font, et c'est la seule facon de voir un graphique fabrique. */
  if (tr.vu && tr.n >= 4) {
    s += tr.acheteurs >= 20 ? 8 : tr.acheteurs >= 8 ? 5 : tr.acheteurs >= 3 ? 2 : -4;
    s += tr.partDuPlusGros < 25 ? 5 : tr.partDuPlusGros < 50 ? 2 : tr.partDuPlusGros < 80 ? -6 : -14;
  } else if (tr.vu) s -= 2;

  if (g.taxeSue) s += (g.buyTax + g.sellTax) === 0 ? 6 : (g.buyTax + g.sellTax) <= 10 ? 2 : -14;
  if (g.codeSu) s += g.unverified ? -8 : 5;
  if (g.have) {
    if (g.proxy) s -= 6;
    if (g.mintable) s -= 8;
    if (g.slipMod) s -= 8;
    if (g.cooldown) s -= 5;
    if (g.lp >= 50) s += 5;
  }
  /* Une fiche remplie ne rend pas un jeton bon — mais personne ne remplit la
     fiche d'un contrat qu'il compte vider dans l'heure. C'est peu, et c'est
     compte comme peu. */
  if (d.vu) s += d.socials >= 3 ? 4 : d.socials >= 1 ? 2 : 0;

  s += Math.max(-8, Math.min(10, (t.ch_m5 || 0) * 0.25));
  return s;
}

/* ==========================================================================
 * LES VETOS
 *
 * Ils sont dans le CODE, un par garde, et aucun apprentissage ne les desserre.
 * C'est la frontiere annoncee en tete de fichier : les agents choisissent leur
 * ordre, leurs traits, leurs specialistes et leurs mises — ils ne choisissent
 * pas de laisser passer un honeypot.
 * ======================================================================== */
function vetoWarden(t) {
  const g = t.g || {};
  if (!g.have) return null;   /* il n'a rien dit : on ne lui fait pas dire « rien a signaler » */
  if (g.honeypot) return 'honeypot';
  if (g.cannotBuy) return 'cannot buy';
  if (g.ownerBal) return 'the owner can rewrite balances';
  if (g.selfd) return 'self-destruct';
  if (g.perslip) return 'per-wallet tax';
  if (g.hpSame) return 'creator already made a honeypot';
  if (g.pausable) return 'transfers can be paused';
  if (g.taxeSue && g.sellTax > 10) return 'sell tax ' + g.sellTax + '%';
  if (g.taxeSue && g.buyTax > 15) return 'buy tax ' + g.buyTax + '%';
  return null;
}
function vetoWhale(t) {
  const ch = t.chaine || {}, g = t.g || {};
  if (ch.personne) return ch.recepteurs + ' addresses touched the token, none of them holds it';
  const top = (ch.vu && ch.top !== null && ch.top !== undefined) ? ch.top : (g.topSu ? g.top : null);
  if (top !== null && top >= 50) return 'one holder holds ' + top.toFixed(0) + '% of the float';
  return null;
}
/* ---- LE VETO QUE SEULS LES TRADES PERMETTENT ----
 * Un portefeuille qui fait presque tout le volume achete et revend a lui-meme
 * pour fabriquer un graphique et des compteurs. Le flux des pools voit
 * quarante transactions et trouve ca vivant ; les trades voient un seul
 * portefeuille et voient la mise en scene. */
function vetoWhisper(t) {
  const x = t.trades || {};
  if (!x.vu || x.n < 5) return null;   /* trop peu pour conclure : on ne conclut pas */
  if (x.partDuPlusGros >= 85 && x.portefeuilles <= 2)
    return 'a single wallet makes ' + x.partDuPlusGros.toFixed(0) + '% of the volume';
  if (x.acheteurs === 0 && x.achats > 0)
    return 'buys with no identifiable buyer';
  return null;
}
/* ---- « INVESTIS PAS DANS DES RUG PULL DEJA RUG. LA CHART EST A 2K MC, Y'A UN
 *      GROS VOLUME DESSUS, C'EST PAS DU TOUT NORMAL. » ----
 *
 * C'est exact, et le detail compte : un gros volume sur une capitalisation de
 * deux mille dollars n'est pas un marche actif, c'est ce qui reste APRES. Les
 * sorties se bousculent sur ce qui n'a plus de fond, et la note ne le voyait
 * pas — elle comptait meme le volume comme un signe de vie.
 *
 * Trois formes, toutes lisibles dans le flux des pools, donc GRATUITES : elles
 * ecartent le jeton avant qu'un seul appel ne soit paye pour lui.
 */
/* ==========================================================================
 * LES PLANCHERS, ET POURQUOI CEUX-LA
 *
 * Repris d'un robot qui tourne et dont le reglage est publie : capitalisation
 * minimale, piscine minimale, rapport piscine/capitalisation, et surtout des
 * BORNES DE HAUSSE — il refuse ce qui a deja fait +100 % en cinq minutes ou
 * +200 % en une heure. C'est le contraire d'un filtre a rendement : c'est un
 * refus d'acheter le sommet d'une bougie, et c'est exactement ce que l'audit
 * de notre propre colonie reprochait a ses achats (« achete ou retenu » :
 * -38,9 % de moyenne, zero monte, trois effondres).
 *
 * Ses chiffres a lui valent pour Solana et Base. Ici la chaine est plus petite,
 * et on ne recopie pas un plancher sans regarder ce qu'il laisse passer :
 * releve sur soixante pools neufs de la chaine 4663, la piscine mediane vaut
 * 4 132 $. Le plancher de ce robot — 20 000 $ — n'en garderait que sept sur
 * soixante ; a 10 000 $ il en reste douze, soit environ quatre candidats par
 * tour, de quoi continuer a trader. C'est ce chiffre-la qui est pose, et il se
 * regle sans toucher au code.
 *
 * Ce qui est refuse ici continue d'etre SUIVI comme tout le reste : l'ombre
 * est ecrite avant le refus, donc l'audit dira dans la journee si ces
 * planchers ont protege ou coute — ce qu'aucune conviction ne peut dire.
 * ======================================================================== */
function nEnv(nom, defaut) {
  const v = parseFloat(process.env[nom]);
  return isFinite(v) && v >= 0 ? v : defaut;
}
/* ---- ET L'AGE MINIMUM ----
 *
 * « Le pool doit etre age de plusieurs heures pour eviter les rug pull. »
 *
 * C'est le renversement complet de ce que faisait la colonie : elle ne
 * regardait QUE les deux premieres minutes. Un jeton de deux minutes n'a rien
 * prouve — ni que sa piscine tient, ni que le deployeur ne l'a pas videe, ni
 * que quelqu'un d'autre que lui l'a achete. A deux heures, ces trois questions
 * ont une reponse, et elle est lisible.
 *
 * Ce que ca coute est reel et il faut le dire : le flux des nouveaux pools ne
 * porte qu'une dizaine de MINUTES d'historique sur six pages. Un jeton de deux
 * heures n'y est plus. Il ne peut donc arriver que par la case surveillance,
 * qui le redemande a son adresse — c'est elle qui rend cette regle jouable,
 * et sans elle la colonie n'achetait plus rien du tout.
 *
 * Un refus « trop jeune » n'est donc pas un refus comme les autres : il ne
 * dit rien du jeton, il dit l'heure. Il donne droit a une reprise quelle que
 * soit la note, sans quoi on ecarterait a deux minutes ce qu'on voulait juger
 * a deux heures. */
/* ==========================================================================
 * LES DEUX BORNES QUE LA COLONIE A LE DROIT DE BOUGER
 *
 * « Veux-tu que la colonie puisse bouger ces deux bornes elle-meme, avec un
 *   plafond et un journal ? — Oui. »
 *
 * C'est un changement de nature, et il merite qu'on ecrive pourquoi il tient.
 *
 * ---- POURQUOI CELLES-LA, ET AUCUNE AUTRE ----
 *
 * L'age minimum et la profondeur de piscine ne protegent de RIEN en
 * eux-memes. Ils protegent de deux choses mesurables et rien d'autre : un
 * jeton trop jeune n'a pas encore de prix qu'on sache relire, et une piscine
 * trop mince mange le trade en glissement. Ce sont des reglages de METIER.
 *
 * Les controles de securite — honeypot, taxes, pouvoirs du proprietaire,
 * concentration — et les bornes de mise ne bougent pas et ne bougeront pas.
 * Un systeme qui peut apprendre a lever sa propre garde l'apprend toujours, et
 * exactement une fois.
 *
 * ---- POURQUOI CA NE DERIVE PAS VERS ZERO ----
 *
 * Parce que la boucle lit DEUX mesures opposees, pas une.
 *
 * L'audit dit ce que le refus a COUTE : ce que la regle a ecarte est-il monte
 * ? Une boucle qui n'ecouterait que lui desserrerait jusqu'a n'avoir plus de
 * regle du tout — c'est exactement le piege annonce.
 *
 * Le compteur d'abandons dit ce que le desserrage a COUTE : combien de
 * positions n'ont jamais pu etre relues jusqu'a l'echeance. C'est la mesure
 * directe du « trop jeune, trop petit », et c'est elle qui reserre. Les deux
 * tirent en sens inverse, et les butees tiennent le tout.
 *
 * ---- ET LE RESERRAGE EST AUSSI AUTOMATIQUE QUE LE DESSERRAGE ----
 *
 * Sans ca, ce ne serait pas un reglage, ce serait une descente.
 * ======================================================================== */
const BORNES = {
  /* min et max sont ECRITS ICI. L'apprentissage se deplace dedans, jamais au
     dela — et `pas` est petit expres : on veut une pente, pas un saut. */
  ageMin:     { env: 'AGE_ACHAT_MIN', defaut: 15, min: 4, max: 90, pas: 2 },
  liqParMise: { env: 'LIQ_PAR_MISE',  defaut: 25, min: 8, max: 60, pas: 3 },
};
/* La valeur en vigueur : ce que la colonie a appris, ou l'environnement tant
   qu'elle n'a rien appris. Toujours ramenee entre les butees — un etat relu
   d'une version plus permissive ne peut pas les contourner. */
function borne(k) {
  const b = BORNES[k];
  const appris = (E.bornes || {})[k];
  const v = (typeof appris === 'number' && isFinite(appris)) ? appris : nEnv(b.env, b.defaut);
  return Math.min(b.max, Math.max(b.min, v));
}
/* Le desserrage se paie en positions qu'on ne sait plus suivre : c'est la
   SEULE contrepartie mesuree, et c'est elle qui rend la boucle honnete. */
/* ---- ELLE SE MESURE SUR CE QUI VIENT DE SE PASSER, PAS SUR TOUTE LA VIE ----
 *
 * Releve sur la colonie apres soixante et une heures : 13 positions perdues de
 * vue sur 87 ouvertes, soit 14,9 % — entre le « sain » (8 %) et le « trop »
 * (20 %). La borne d'age n'a donc pas bouge une seule fois en trois jours,
 * alors que l'audit de sa regle disait la meme chose a chaque tour : « trop
 * jeune », 79 suivis, 44 % de montes, +58 % de moyenne. La regle la plus
 * chere de la colonie etait jugee coupable par l'audit et couverte par une
 * part d'abandons qui ne pouvait plus changer.
 *
 * Parce que cette part etait cumulee DEPUIS LE DEBUT. Dix des treize abandons
 * datent d'avant le Veilleur et le prix de secours — le trou qu'ils ont bouche.
 * Depuis, presque plus rien ne se perd, et la part s'en apercoit a la vitesse
 * de 1/87 par position : il faudrait des semaines pour redescendre sous 8 %
 * sans un seul nouvel abandon. Une mesure qui decrit un passe repare n'est pas
 * une mesure du present.
 *
 * On garde donc les quarante dernieres positions reglees — suivie jusqu'au
 * bout, ou perdue de vue — et c'est sur elles qu'on juge, des qu'il y en a
 * douze. En dessous, le cumul d'avant fait foi, comme avant : un etat relu
 * d'hier n'a pas encore de fenetre, et ne doit pas se retrouver sans mesure. */
const SUIVIS_FENETRE = 40;
function noteSuivi(perdue) {
  if (!Array.isArray(E.suivis)) E.suivis = [];
  E.suivis.push(perdue ? 1 : 0);
  if (E.suivis.length > SUIVIS_FENETRE) E.suivis = E.suivis.slice(-SUIVIS_FENETRE);
}
function partAbandons() {
  const s = Array.isArray(E.suivis) ? E.suivis : [];
  if (s.length >= 12) return s.reduce((a, b) => a + b, 0) / s.length;
  const ouv = E.ouvertures || 0;
  if (ouv < 12) return null;                    /* trop peu pour conclure */
  return ((E.compteurs.abandonneeSansPrix || 0) + (E.compteurs.prixAberrant || 0)) / ouv;
}
const ABANDON_TROP = nEnv('ABANDON_TROP_PART', 0.20);   /* au-dessus, on reserre */
const ABANDON_SAIN = nEnv('ABANDON_SAIN_PART', 0.08);   /* en dessous, on peut desserrer */
const AUDIT_MIN_OBS = 12;        /* en dessous, une part de montees est du bruit */
const AUDIT_COUTE = 40;          /* % de montees au-dessus duquel la regle coute */
const AUDIT_PROTEGE = 15;        /* et en dessous duquel elle protege vraiment */
const BORNES_REPOS = 24;         /* tours entre deux mouvements : on regarde l'effet */

/* La ligne d'audit d'une regle, par son libelle de famille. */
function auditDe(motif) {
  return auditDesRefus().find((x) => motif.test(x.cle)) || null;
}

function revoitLesBornes() {
  if (!nEnv('BORNES_APPRISES', 1)) return false;
  if (!E.bornes) E.bornes = {};
  E.depuisBornes = (E.depuisBornes || 0) + 1;
  if (E.depuisBornes < BORNES_REPOS) return false;

  const ab = partAbandons();
  const cas = [
    { k: 'ageMin', motif: /too young/,
      quoi: 'minimum buy age', unite: ' min' },
    { k: 'liqParMise', motif: /pool below the buy floor|nothing to sell into/,
      quoi: 'pool depth required per stake', unite: '× the stake' },
  ];
  for (const c of cas) {
    const b = BORNES[c.k], avant = borne(c.k);
    const l = auditDe(c.motif);
    let apres = avant, pourquoi = null;

    /* ---- ON RESERRE D'ABORD ----
     * Le cout du desserrage se lit sur TOUTES les positions, pas seulement
     * sur celles de cette regle : on le regarde donc avant tout le reste, et
     * il l'emporte. */
    if (ab !== null && ab > ABANDON_TROP && avant < b.max) {
      apres = Math.min(b.max, avant + b.pas);
      pourquoi = Math.round(ab * 100) + '% of opened positions could never be re-read to their '
        + 'deadline. That is what buying too young and too thin costs, and it is measured on '
        + 'every position, not just the ones this rule touches';
    } else if (l && l.n >= AUDIT_MIN_OBS && l.partMontes <= AUDIT_PROTEGE && avant < b.max) {
      apres = Math.min(b.max, avant + b.pas);
      pourquoi = 'only ' + l.partMontes + '% of the ' + l.n + ' tokens it set aside went up: '
        + 'this rule protects, and it can afford to protect more';
    /* ---- ET ON NE DESSERRE QUE SI LES DEUX SONT D'ACCORD ----
     * L'audit doit dire que la regle coute, ET les abandons doivent etre bas.
     * Un seul des deux ne suffit pas : c'est ce « et » qui empeche la
     * descente. */
    } else if (l && l.n >= AUDIT_MIN_OBS && l.partMontes >= AUDIT_COUTE
               && ab !== null && ab < ABANDON_SAIN && avant > b.min) {
      apres = Math.max(b.min, avant - b.pas);
      pourquoi = l.partMontes + '% of the ' + l.n + ' tokens it set aside went up (average '
        + l.moyenne + '%), and only ' + Math.round(ab * 100) + '% of opened positions were lost '
        + 'for want of a price: it costs more than it protects';
    }
    if (apres === avant || !pourquoi) continue;
    E.bornes[c.k] = apres;
    E.depuisBornes = 0;
    journal('bornes', c.quoi + ' ' + avant + c.unite + ' → ' + apres + c.unite + '. ' + pourquoi
      + '. Bounded to [' + b.min + ', ' + b.max + '] in the code, which no measurement moves.',
      [{ regle: l ? l.cle : c.k, montes: l ? l.partMontes + '%' : null, n: l ? l.n : null,
         abandons: ab === null ? null : Math.round(ab * 100) + '%' }]);
    return true;
  }
  return false;
}

function planchers() {
  return {
    /* ---- LE PLANCHER BAISSE, ET C'EST LA MESURE QUI LE DIT ----
     *
     * Il arretait 58 % de tous les refus — plus de la moitie a lui seul,
     * contre 7 % pour le suivant. Et jusqu'ici on ne pouvait pas savoir s'il
     * protegeait : l'audit rangeait chaque refus sous une cle qui contenait
     * la taille de SA piscine, donc chaque jeton faisait une case a un seul
     * element, et le panneau ecarte tout ce qui a moins de trois. La seule
     * regle qu'il fallait juger etait la seule invisible.
     *
     * Regroupe par regle, le releve est tombe :
     *
     *   « piscine sous le plancher »   n=9   +26,5 % de moyenne   0 effondre
     *   « piscine pour une capi... »   n=16  +82,4 % de moyenne   1 effondre
     *
     * Zero effondre sur neuf. Ce plancher n'ecarte pas des pieges, il ecarte
     * des gains. A comparer avec la borne de hausse, qui elle merite sa
     * place — « deja +x % en cinq minutes » : n=40, 14 montes mais 20
     * EFFONDRES. Celle-la protege vraiment, et on n'y touche pas.
     *
     * D'ou 5 000 et 8 000. Ce ne sont pas des chiffres ronds choisis au
     * hasard : le flux des nouveaux pools de cette chaine sert des piscines
     * de 4 000 a 6 000 $, et un plancher a 10 000 les eliminait toutes avant
     * meme de les juger. La colonie lisait, jugeait bien, et refusait tout.
     *
     * Ces bornes restent reglables par l'environnement, et elles restent
     * ECRITES ICI : un agent ne peut pas les baisser lui-meme. Un systeme qui
     * peut apprendre a baisser sa propre garde l'apprend toujours, une fois
     * exactement. C'est un humain qui bouge ce chiffre, sur une mesure. */
    /* ---- ET IL BAISSE ENCORE, PARCE QUE LA MESURE LE REDIT ----
     *
     * « Il ne trade quasiment jamais depuis hier. »
     *
     * Sur le dernier tour du serveur, les VINGT candidats ont ete arretes par
     * le Scout — pas un seul n'a atteint l'Oracle. Et les piscines qu'il
     * refusait etaient celles-ci :
     *
     *   519 · 1 586 · 3 332 · 3 977 · 4 053 · 4 112 · 4 265 · 4 384 · 4 710
     *
     * C'est le marche entier de cette chaine. Un plancher a 5 000 ne trie pas
     * dedans : il l'efface. Et l'audit, deuxieme fois de suite, dit la meme
     * chose que la premiere — « piscine sous le plancher » : 11 suivis, 4
     * montes de +20 % ou plus, ZERO effondre, +21,6 % de moyenne. Un refus
     * qui n'a jamais evite un seul effondrement n'est pas une protection.
     *
     * ---- ALORS POURQUOI GARDER UN PLANCHER ----
     *
     * Parce qu'il y a une vraie raison, et ce n'est pas « petit = dangereux ».
     * C'est le GLISSEMENT : entrer 42 $ dans une piscine de 519 $, c'est
     * bouger le prix de 8 % en achetant, et le rebouger en sortant. La perte
     * est mecanique, elle n'a rien a voir avec le jeton.
     *
     * Le plancher suit donc la MISE au lieu d'etre un chiffre choisi a la
     * main : vingt-cinq fois la plus grosse mise que le Banquier puisse poser.
     * A 1 366 $ de caisse et 8 % au maximum par jeton, ca fait 109 $ de mise
     * et 2 731 $ de plancher — ce qui laisse passer tout ce qui est au-dessus
     * de 3 000 et ecarte les 519 et les 1 586, exactement les deux ou le
     * glissement mange le trade. Et quand la caisse grandit, le plancher monte
     * tout seul : une regle qui se regle elle-meme sur la seule chose qui
     * change vraiment.
     *
     * Le plancher fixe reste, en dessous, comme garde-fou pour une caisse
     * minuscule ; les deux sont reglables par l'environnement. Un agent ne
     * peut toujours pas les bouger : c'est un humain, sur une mesure. */
    /* ---- ET DESORMAIS LA COLONIE PEUT BOUGER CE CRAN-LA ELLE-MEME ----
     * `borne()` rend ce que `revoitLesBornes` a appris, ou la valeur de
     * l'environnement tant qu'elle n'a rien appris. Les butees, elles, sont
     * ecrites en dur juste au-dessus de cette fonction : aucun apprentissage
     * ne les franchit. */
    liq: Math.max(nEnv('LIQ_ACHAT_MIN', 1200),
                  (E.tresor || 0) * MISE_PART_MAX * borne('liqParMise')),
    /* ---- ET LA CAPITALISATION CESSE DE FAIRE LE TRAVAIL DE LA PISCINE ----
     *
     * « SWOGE AI est toujours bloque. »
     *
     * Le releve du serveur, apres la baisse a 4 000, sur un tour reel. Les
     * capitalisations refusees :
     *
     *     3 789 · 3 274 · 3 285 · 3 939 · 3 301 · 3 964
     *
     * Le plancher etait a 4 000. Il coupait a TRENTE-SIX DOLLARS pres. Sur
     * une chaine dont les capitalisations se serrent entre 3 200 et 4 000,
     * ce n'est plus un filtre : c'est un tirage au sort qui elimine la moitie
     * du flux selon de quel cote d'un chiffre rond le jeton est tombe. Et
     * l'audit, troisieme fois de suite, dit la meme chose : ZERO effondre.
     *
     * ---- CE QU'UN PLANCHER DE CAPITALISATION PROTEGE VRAIMENT ----
     *
     * Il avait ete pose pour une raison precise, et elle est ecrite plus
     * haut : les positions restees ouvertes treize heures sans un prix relu
     * avaient toutes une capitalisation d'achat entre 5 759 et 15 738 $. Ce
     * n'etait donc pas un probleme de QUALITE mais de LECTURE — on ne savait
     * pas les recoter. Depuis, le Veilleur relit les positions ouvertes et le
     * prix de secours existe : ce trou-la est bouche ailleurs, par ce qui le
     * bouchait vraiment.
     *
     * Ce qui reste dangereux, c'est d'entrer dans quelque chose de trop mince
     * pour en ressortir — et ca, c'est la PISCINE qui le mesure, pas la
     * capitalisation. Le plancher de piscine suit deja la mise. Garder en
     * plus une borne de capitalisation posee a la main, c'est faire deux fois
     * le meme travail, et le faire moins bien la seconde fois.
     *
     * Il reste donc, mais comme garde-fou d'absurdite, pas comme jugement :
     * on n'achete pas un jeton qui vaut moins que dix fois notre mise — la, ce
     * qu'on achete EST le marche, et le revendre n'a pas de sens. A 1 366 $ de
     * caisse ca fait 1 093 $, et le plancher fixe de 1 500 $ tient au-dessus.
     * Les six refuses ci-dessus passent tous ; un jeton a 200 $ de
     * capitalisation, non. */
    mc: Math.max(nEnv('MC_ACHAT_MIN', 1500),
                 (E.tresor || 0) * MISE_PART_MAX * nEnv('MC_PAR_MISE', 10)),
    mcMax: nEnv('MC_ACHAT_MAX', 100000),
    /* ---- QUINZE MINUTES, ET POURQUOI PAS DEUX HEURES ----
     *
     * Deux heures etaient posees pour eviter les rug pulls. La colonie a
     * mesure le contraire pendant trente-deux heures, sur ses propres ombres :
     * les jetons ecartes pour « trop jeune » ont rendu +65 % et +124 % de
     * moyenne a l'echeance, cinq et trois montes, ZERO effondre sur neuf.
     *
     * Et la regle avait casse la protection qu'elle devait renforcer. A deux
     * heures, lire les transferts d'un jeton demande ~71 000 blocs : seul le
     * noeud officiel les sert, il sature, et le Cobaye n'a donc jamais pu
     * simuler la sortie — 33 « non testable » sur 34. L'epreuve qui detecte
     * vraiment un honeypot ne tournait plus.
     *
     * Quinze minutes plutot que vingt, et ce n'est pas un arrondi : a 0,101 s
     * par bloc, quinze minutes font 8 900 blocs. C'est SOUS les dix mille du
     * noeud de secours, qui redevient donc capable de compter les porteurs
     * quand l'officiel sature. A vingt minutes il en faudrait 11 900, et le
     * secours redeviendrait inutile.
     *
     * Ce que ce chiffre ne pretend pas : qu'un jeton de quinze minutes ne
     * ruggera pas. Il ruggera parfois. Mais la colonie vend en cinq a vingt
     * minutes, avec des paliers a +15/+40/+80 % — elle n'est pas la a la
     * troisieme heure — et c'est le Cobaye, redevenu operationnel, qui porte
     * la protection contre le piege. */
    ageMin: borne('ageMin'),
    pumpM5: nEnv('PUMP_MAX_M5', 100),
    pumpH1: nEnv('PUMP_MAX_H1', 200),
    dumpM5: nEnv('DUMP_MAX_M5', 40),
    dumpH1: nEnv('DUMP_MAX_H1', 50),
  };
}

function vetoScout(t) {
  const v = t.vol || {}, mc = t.mc || 0, liq = t.liq || 0;
  const P = planchers();
  /* ---- LE REPOS APRES UNE VENTE ---- voir `noteVendu`. */
  const cv = E.connus[t.addr];
  if (cv && cv.vendu && REACHAT_REPOS_MIN > 0) {
    const depuis = (Date.now() - cv.vendu) / 60000;
    if (depuis >= 0 && depuis < REACHAT_REPOS_MIN)
      return 'sold ' + Math.round(depuis) + ' min ago: cooling down for '
           + Math.round(REACHAT_REPOS_MIN) + ' min before buying it again';
  }
  /* ---- LA CHUTE ---- */
  if (P.dumpH1 > 0 && t.ch_h1 <= -P.dumpH1)
    return 'already down ' + Math.round(-t.ch_h1) + '% in an hour';
  if (P.dumpM5 > 0 && t.ch_m5 <= -P.dumpM5)
    return 'already down ' + Math.round(-t.ch_m5) + '% in five minutes';
  if (t.ch_h6 <= -80) return 'already down ' + Math.round(-t.ch_h6) + '% in six hours';
  /* ---- ET LA HAUSSE, QUI COUTE AUTANT ----
   * Entrer apres un +300 % de cinq minutes, c'est payer le sommet a quelqu'un
   * qui sort. Le chiffre ne dit rien du jeton ; il dit ou l'on entre. */
  if (P.pumpM5 > 0 && t.ch_m5 >= P.pumpM5)
    return 'already +' + Math.round(t.ch_m5) + '% in five minutes: we would be paying the top';
  if (P.pumpH1 > 0 && t.ch_h1 >= P.pumpH1)
    return 'already +' + Math.round(t.ch_h1) + '% in an hour: we would be paying the top';
  /* ---- LES REGLES QUI DISENT QUELQUE CHOSE DE PRECIS PASSENT D'ABORD ----
   * Un plancher explique seulement « trop petit ». « Ce n'est plus un marche,
   * c'est une sortie » explique CE QUI SE PASSE, et c'est cette phrase-la
   * qu'on veut lire dans l'audit et a l'ecran. Les deux ecartent le meme
   * jeton ; seule la premiere apprend quelque chose a qui la lit. */
  /* Le cas signale : deux mille de capitalisation, un gros volume dessus. */
  if (mc > 0 && mc < 20000 && v.h1 > mc * 2)
    return '$' + Math.round(v.h1) + ' of volume on a $' + Math.round(mc)
         + ' cap: that is not a market any more, that is an exit';
  /* Et une piscine qui ne represente presque plus rien de la capitalisation :
     il n'y a plus de quoi sortir, quel que soit le prix affiche. */
  if (mc > 50000 && liq > 0 && liq < mc * 0.01)
    return '$' + Math.round(liq) + ' pool for a $' + Math.round(mc)
         + ' cap: nothing to sell into';
  /* ---- ET ENFIN CE QU'ON NE POURRA NI SUIVRE NI VENDRE ----
   * Les positions restees ouvertes treize heures sans un seul prix relu
   * avaient toutes une capitalisation d'achat entre 5 759 $ et 15 738 $ ; les
   * deux que l'on savait coter valaient 60 877 $ et 234 892 $. */
  if (P.liq > 0 && liq > 0 && liq < P.liq)
    return '$' + Math.round(liq) + ' pool: below the buy floor ($'
         + Math.round(P.liq) + ')';
  if (P.mc > 0 && mc > 0 && mc < P.mc)
    return '$' + Math.round(mc) + ' cap: below the buy floor ($'
         + Math.round(P.mc) + ')';
  if (P.mcMax > 0 && mc > P.mcMax)
    return '$' + Math.round(mc) + ' cap: above the buy ceiling ($'
         + Math.round(P.mcMax) + '), most of the multiple is already done';
  /* ---- L'AGE, EN DERNIER ----
   * Parce que c'est le seul refus qui se PERIME : les autres portent sur ce
   * qu'est le jeton, celui-la sur l'heure qu'il est. Le mettre en dernier
   * garantit qu'un jeton ecarte pour son age l'aurait ete de toute facon si
   * quelque chose d'autre clochait — et donc que la reprise ne ramene pas un
   * jeton deja condamne. */
  if (P.ageMin > 0 && t.minutes !== null && t.minutes !== undefined && t.minutes < P.ageMin)
    /* ---- ON DIT L'ATTENTE DANS L'UNITE OU ELLE EST ----
     * La phrase divisait toujours par 60 : a quinze minutes elle affichait
     * « on attend 0.3 h ». Reste de l'epoque ou l'attente etait de deux
     * heures. Ca a fait croire — a son auteur comme a son lecteur — que la
     * colonie mettait des jetons de cote pour des heures, alors qu'elle les
     * reprend au quart d'heure.
     * Et le mot compte : ce n'est pas un refus, c'est un REPORT. Le jeton
     * revient quand il a l'age (voir la reprise par l'age, plus bas). Le dire
     * ici evite de lire l'alerte comme une perte de flux. */
    return 'too young (' + Math.round(t.minutes) + ' min): picked up again at '
         + (P.ageMin < 60 ? Math.round(P.ageMin) + ' min'
                          : Math.round(P.ageMin / 60 * 10) / 10 + ' h')
         + ', once we know whether the pool holds';
  return null;
}

/* ==========================================================================
 * LA PRESENCE DU PROJET
 *
 * « Il faudrait acheter que des cryptos avec site web, Telegram et Twitter, et
 *   DexScreener a jour. »
 *
 * C'est une regle severe, et elle l'est plus qu'elle n'en a l'air : releve sur
 * huit jetons pris dans le flux des PROFILS de DexScreener — donc parmi les
 * plus susceptibles d'avoir une presence — AUCUN ne portait les trois. La
 * plupart n'ont que Twitter, les sites sont rares, Telegram encore plus.
 *
 * Elle est donc appliquee telle que demandee, mais reglable sans toucher au
 * code (SOCIAUX_EXIGES), et surtout MESUREE : les jetons refuses ici sont
 * suivis comme les autres, et l'audit dira dans la journee ce que cette regle
 * a coute ou epargne. C'est la seule facon de trancher une question pareille.
 *
 * ---- ET « PAS ENCORE VU » N'EST PAS « ABSENT » ----
 *
 * DexScreener ne connait qu'un jeton sur douze a deux minutes : il n'a pas
 * encore indexe. Refuser ces jetons pour « aucun reseau » serait leur reprocher
 * notre propre calendrier. On les ecarte pour ce qui est vrai — « pas encore
 * verifiable » — et ils repassent en surveillance, donc ils reviendront quand
 * DexScreener les connaitra.
 * ======================================================================== */
/* ---- TROIS RESEAUX EXIGES, C'ETAIT TROP ----
 *
 * « Verifie si c'est important d'avoir Telegram, site et Twitter — peut-etre
 *   qu'on est trop severe la-dessus et qu'on loupe des opportunites. »
 *
 * Mesure, une fois l'audit regroupe par regle : « il manque : site, telegram »
 * — n=13, +28,6 % de moyenne, 6 montes, 2 effondres. On ecartait des jetons
 * qui, en majorite, montaient.
 *
 * Un jeton de quinze minutes n'a souvent qu'un compte X : le site arrive plus
 * tard, le Telegram aussi. Exiger les trois AU MOMENT DE L'ACHAT ne mesure pas
 * le serieux du projet, ca mesure son age — et l'age, une autre regle s'en
 * occupe deja.
 *
 * On garde UNE exigence : une presence publique, n'importe laquelle. Un jeton
 * qui n'a ni site, ni X, ni Telegram n'a personne derriere — la, l'absence dit
 * quelque chose. La liste reste reglable par SOCIAUX_EXIGES, et vide desactive
 * la regle. */
const SOCIAUX_DEFAUT = 'un';
function sociauxExiges() {
  const v = (process.env.SOCIAUX_EXIGES === undefined ? SOCIAUX_DEFAUT : process.env.SOCIAUX_EXIGES);
  return String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}
function vetoOracle(t) {
  const exiges = sociauxExiges();
  if (!exiges.length) return null;                 /* la regle est desactivee */
  const d = t.dex;
  if (!d || !d.vu) {
    /* On distingue « on n'a pas regarde » de « il n'y est pas » : le premier
       est une absence de notre part, et elle se corrige en revenant plus tard. */
    const sautee = t.saute && t.saute.dex;
    return sautee ? 'not indexed by DexScreener yet (' + Math.round(t.minutes || 0) + ' min)'
                  : 'absent from DexScreener';
  }
  const a = new Set();
  for (const l of (d.liens || [])) {
    const ty = String(l.type || '').toLowerCase();
    a.add(ty === 'website' ? 'site' : ty);
  }
  /* `un` : n'importe quelle presence publique suffit. C'est le reglage par
     defaut, et il se lit comme ce qu'il est — pas une liste de trois noms
     dont on aurait retire deux au hasard. */
  if (exiges.length === 1 && exiges[0] === 'un') {
    if (a.size > 0) return null;
    return 'no public presence at all: no site, no X, no Telegram';
  }
  const manque = exiges.filter((x) => !a.has(x));
  if (manque.length) return 'missing: ' + manque.join(', ');
  return null;
}
const VETOS = { scout: vetoScout, warden: vetoWarden, whale: vetoWhale, whisper: vetoWhisper,
                oracle: vetoOracle };
/* Le Cobaye n'est pas dans cette table : son epreuve demande un appel reseau,
   donc elle ne peut pas etre evaluee dans la boucle synchrone des vetos. Elle
   est jouee dans le tour, juste avant l'ouverture. */

/* Ce dont un agent a besoin pour parler : l'union des besoins de ses traits et
   celui de son veto. C'est ce nombre qui donne son COUT, et le cout est la
   moitie de la decision d'ordre. */
const BESOIN_VETO = { warden: ['goplus'], whale: ['chaine'], whisper: ['trades'] };
function besoinsDe(agent) {
  const out = [];
  const pousse = (b) => { if (b && out.indexOf(b) < 0) out.push(b); };
  for (const spec of agent.traits || []) for (const b of besoinsDuTrait(spec)) pousse(b);
  for (const b of (BESOIN_VETO[agent.key] || [])) pousse(b);
  return out;
}
function coutDe(agent, dejaLu) {
  let c = 0;
  for (const b of besoinsDe(agent)) if (!dejaLu || !dejaLu[b]) c += (SERVICES[b] ? SERVICES[b].cout : 1);
  return c;
}

/* Les gardes dans l'ordre courant : ceux qui peuvent refuser, puis l'Oracle,
   qui juge sur ce que les autres ont fait lire. */
function gardesEnOrdre() {
  /* Le Scout d'abord, toujours : son controle ne coute aucun appel, il ne peut
     donc jamais etre rentable de le mettre ailleurs qu'en tete. Ensuite les
     gardes dans l'ordre qu'ils se sont donne, puis l'Oracle qui juge sur ce que
     les autres ont fait lire. */
  const s = E.roster.filter((a) => a.role === 'source');
  const g = E.roster.filter((a) => a.role === 'garde').slice()
    .sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const o = E.roster.filter((a) => a.role === 'note');
  /* L'epreuve de vente vient en DERNIER, toujours : elle coute des appels et ne
     sert que sur un jeton qu'on s'apprete a acheter. « Avant le gros achat »,
     donc apres tous les autres controles — la mettre plus tot reviendrait a la
     payer pour des jetons que le Whale allait refuser de toute facon. */
  const e = E.roster.filter((a) => a.role === 'epreuve');
  return s.concat(g, o, e);
}

/* ---- L'ANALYSE COMPLETE ----
 * Elle suppose les donnees deja lues. Le tour, lui, ne lit que ce dont le
 * garde suivant a besoin — mais quand tout est la, le verdict doit etre le
 * meme, et c'est ce que l'essai verifie. */
function analyse(t) {
  const tr = traitsDe(t);
  let sec = null, conc = null;
  for (const a of gardesEnOrdre()) {
    const v = VETOS[a.key];
    if (!v) continue;
    const r = v(t);
    if (!r) continue;
    if (a.key === 'warden') sec = r; else conc = r;
    break;
  }
  /* L'Oracle est le dernier de la file : son veto n'est evalue ci-dessus que
     si personne n'a parle avant, ce qui est bien l'ordre voulu. */
  const base = scoreBase(t);
  const parts = {};
  let adj = 0;
  /* Le fond est soustrait ICI, pour les agents qui notent : voir la note
     au-dessus de `apprendBase`. */
  const fond = baseCourante();
  for (const k of apprenants()) {
    parts[k] = Math.round(ajustementAgent(k, tr[k], fond) * 10) / 10;
    adj += parts[k];
  }
  adj = Math.max(-30, Math.min(30, adj));
  /* L'avis du Conseiller passe par la meme porte etroite que le reste : borne
     ici, jamais la-bas, et incapable de lever un veto — `sec` et `conc` sont
     evalues avant lui et ne le regardent pas. */
  const avis = (t.conseil && isFinite(t.conseil.points))
    ? Math.max(-CONSEIL_POIDS, Math.min(CONSEIL_POIDS, t.conseil.points)) : 0;
  const score = Math.max(0, Math.min(100, Math.round(base + adj + avis)));
  return { sec, conc, traits: tr, parts, base: Math.round(base), adj: Math.round(adj),
           avis: avis, conseil: t.conseil || null, score,
           /* Sans prix relu, on ne sait pas a quoi on achete : on n'achete pas. */
           achete: !sec && !conc && score >= seuilCourant() && t.prix > 0 };
}

/* ==========================================================================
 * LA COLONIE CHANGE SA PROPRE STRUCTURE
 *
 * Trois gestes, et chacun se justifie par un chiffre qu'elle a releve
 * elle-meme. Tout ce qu'elle fait ici est ecrit dans `journalStructure`, avec
 * la mesure qui l'a decide — sinon « les agents s'auto-developpent » n'est
 * qu'une phrase, et personne ne peut verifier qu'il s'est passe quelque chose.
 * ======================================================================== */
/* ---- CE QUE LA COLONIE FAIT, ET CE QU'ELLE EN DIT ----
 *
 * DEMANDE : « verifie qu'elle se reorganise reellement et met des choses
 * concretes en place ».
 *
 * En ouvrant le journal du serveur, la reponse etait a la fois oui et non.
 * Oui : un specialiste etait ne (scout-agemc, le 2 septembre a 3 h 57) et
 * l'ordre des gardes avait ete revu. Non : on ne pouvait pas le VOIR. Les
 * huit lignes publiees etaient huit `regard` du Conseiller, sur six heures,
 * disant huit fois la meme chose :
 *
 *     « Taux de gain de 29,9 % (20/67) avec volatilite extreme… »
 *     « Taux de victoire de 29,9 % (20/67) sur positions fermees… »
 *     « Taux de win de 29,9 % (20/67) avec volatilite extreme… »
 *
 * Un modele repose la meme phrase toutes les cinquante minutes, et elle
 * chassait les actes. Le journal disait donc l'exact contraire de la verite :
 * une colonie qui commente et n'agit pas, alors qu'elle avait agi.
 *
 * Deux regles ici, et aucune ne touche a ce que la colonie FAIT :
 *
 *   1. Un `regard` qui repete le precedent ne prend pas une ligne de plus. On
 *      compare la phrase debarrassee de ses chiffres — c'est ce qui change
 *      d'une fois sur l'autre, pas le propos. La ligne existante est datee a
 *      nouveau et porte un compte. Elle reste donc VRAIE et devient plus
 *      informative : « vu 8 fois » dit quelque chose qu'une seule occurrence
 *      ne disait pas.
 *
 *   2. Les ACTES ne sont jamais chasses par les observations. La vue publie
 *      les huit dernieres lignes comme avant, mais complete avec les derniers
 *      actes s'ils n'y sont pas. Un agent qui nait est un fait de structure ;
 *      une phrase d'un modele est un avis. */
const JOURNAL_ACTES = ['ordre', 'naissance', 'retrait', 'strategie', 'remise'];
/* ---- UNE VOIX NE PREND PAS TOUT LE JOURNAL ----
 *
 * La deduplication ci-dessus attrape une phrase reposee telle quelle. Elle
 * n'attrape PAS ce que le serveur faisait vraiment : le modele reformule a
 * chaque fois — « taux de gain », « taux de victoire », « taux de win »,
 * « taux de reussite » — pour dire exactement la meme chose. Recoupees, les
 * huit lignes reelles ne se ressemblent pas assez pour etre fusionnees sans
 * inventer un seuil de ressemblance, et un seuil regle sur huit exemples est
 * un seuil regle sur rien.
 *
 * On ne mesure donc pas la ressemblance : on borne la PLACE. Le Conseiller a
 * droit a `regardMax` lignes, quoi qu'il dise ; le reste va aux actes de la
 * colonie. C'est vrai sans rien deviner, et ca tient meme le jour ou le
 * modele trouvera huit facons vraiment differentes de dire la meme chose.
 *
 * Les lignes gardees restent les plus RECENTES de chaque sorte : on ne choisit
 * pas quoi montrer, seulement combien. */
function journalPublie(n, regardMax) {
  const j = E.journalStructure || [];
  /* ---- LA BORNE NE S'APPLIQUE QUE S'IL Y A DES ACTES A PROTEGER ----
   * Premier essai : on bornait toujours, puis on completait avec les
   * observations mises de cote pour ne pas rendre un journal a moitie vide.
   * Ce complement DEFAISAIT la borne — huit observations et deux actes
   * rendaient six observations, la borne disant trois. L'essai l'a dit tout
   * de suite, et c'est bien ce qu'on lui demandait.
   *
   * La borne existe pour empecher une voix d'ECRASER les actes. Sans acte,
   * elle n'a rien a proteger : une colonie qui vient de demarrer n'a que les
   * observations du Conseiller, et les rogner ne montrerait rien de plus,
   * seulement moins. On borne donc quand il y a un acte, et pas avant —
   * quitte a publier moins de `n` lignes, ce qui est le bon resultat : cinq
   * lignes qui disent cinq choses valent mieux que huit qui en disent deux. */
  const actes = j.filter((e) => JOURNAL_ACTES.indexOf(e.quoi) >= 0).length;
  const max = actes === 0 ? Infinity : (regardMax === undefined ? 3 : regardMax);
  const out = [];
  let regards = 0;
  for (const e of j) {
    if (out.length >= n) break;
    if (e.quoi === 'regard') { if (regards >= max) continue; regards++; }
    out.push(e);
  }
  out.sort((a, b) => (b.t || 0) - (a.t || 0));
  return out;
}
function memeRegard(a, b) {
  if (!a || !b) return false;
  const nu = (x) => String(x).toLowerCase().replace(/[\d.,%()]+/g, '#')
                     .replace(/[^a-z# ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return nu(a) === nu(b);
}
function journal(quoi, txt, chiffres) {
  if (quoi === 'regard') {
    const p = E.journalStructure.find((x) => x.quoi === 'regard');
    if (p && memeRegard(p.txt, txt)) {
      p.t = Date.now(); p.txt = txt; p.fois = (p.fois || 1) + 1;
      return;
    }
  }
  E.journalStructure.unshift({ t: Date.now(), quoi, txt, chiffres: chiffres || null });
}

/* ---- 1. L'ORDRE DES GARDES ----
 * Les lectures sont paresseuses : on ne paie les donnees d'un garde que si le
 * jeton est arrive jusqu'a lui. Donc un garde qui refuse souvent, pour peu
 * d'appels, fait economiser tous ceux d'apres. C'est exactement le rapport
 * refus/cout, et il se mesure.
 *
 * Le gain n'est pas theorique : moins d'appels par jeton, c'est plus de jetons
 * analyses dans le meme tour, avec les memes services gratuits qui coupent. */
function revoitOrdre(force) {
  if (!force && (E.toursDepuisOrdre || 0) < REPOS_ORDRE_TOURS) return false;
  const gardes = E.roster.filter((a) => a.role === 'garde' && REORDONNABLES.indexOf(a.key) >= 0);
  if (gardes.length < 2) return false;
  const mesure = gardes.map((a) => {
    const vu = E.compteurs[a.key + 'Vu'] || 0;
    const bloque = E.compteurs[a.key + 'Bloque'] || 0;
    const cout = Math.max(1, coutDe(a, null));
    return { a, vu, bloque, taux: vu ? bloque / vu : 0, cout, rendement: vu ? (bloque / vu) / cout : 0 };
  });
  /* ---- UN GARDE PLACE EN DERNIER NE VOIT PRESQUE RIEN ----
   * Releve sur deux tours reels : le Warden et le Whale avaient vu vingt
   * jetons chacun, le Whisper — dernier — en avait vu DEUX. Exiger le meme
   * echantillon de tout le monde avant de bouger revenait a exiger d'un garde
   * qu'il fasse ses preuves sur une place qu'on ne lui donnera jamais : il ne
   * pouvait plus jamais monter, et l'ordre etait gele pour toujours.
   * On classe donc ceux qui ont un echantillon, et on laisse les autres
   * derriere, dans leur ordre actuel. On promeut ce qui est mesure ; on ne
   * retrograde pas sur une absence de mesure. */
  const mesures = mesure.filter((m) => m.vu >= ECHANTILLON_ORDRE);
  const jeunes = mesure.filter((m) => m.vu < ECHANTILLON_ORDRE)
                       .sort((x, y) => (x.a.ordre || 0) - (y.a.ordre || 0));
  if (mesures.length < 2) return false;
  const avant = gardes.slice().sort((x, y) => (x.ordre || 0) - (y.ordre || 0)).map((a) => a.key).join(' → ');
  mesures.sort((x, y) => y.rendement - x.rendement);
  const suite = mesures.concat(jeunes);
  let i = 1;
  for (const m of suite) m.a.ordre = i++;
  const apres = suite.map((m) => m.a.key).join(' → ');
  E.ordreRevu = Date.now();
  E.toursDepuisOrdre = 0;
  if (avant === apres) return false;
  journal('ordre', 'New guard order: ' + apres + ' (was: ' + avant + ')',
    suite.map((m) => ({ agent: m.a.key, refus: Math.round(m.taux * 100) + '%', appels: m.cout,
                        vus: m.vu })));
  return true;
}

/* ---- 2. LA NAISSANCE D'UN SPECIALISTE ----
 * Un agent regarde SA memoire. Une case tres observee mais tres dispersee ne
 * predit rien : il n'y a pas une population dedans, il y en a deux, et la
 * coupe passe au milieu. Le petit recoupe cette case avec un second trait.
 *
 * Le second trait est choisi parmi ceux dont les donnees sont DEJA payees pour
 * ce jeton. Un specialiste qui reclamerait un service de plus augmenterait le
 * cout de chaque jeton analyse — la colonie grandirait en depensant plus, ce
 * qui est le contraire du but. */
const EMOJIS_ENFANTS = ['🔎', '🧭', '🧪', '📐', '🔬', '🧩'];
function chercheCaseFloue() {
  for (const a of E.roster) {
    if (a.role === 'specialiste' || a.role === 'banque' || a.role === 'execution') continue;
    const m = E.memoire[a.key] || {};
    for (const t in m) {
      if (String(t).indexOf('×') >= 0) continue;           /* deja un croisement */
      for (const v in m[t]) {
        const c = m[t][v];
        if (c.n < VARIANCE_MIN_OBS) continue;
        const sd = ecartType(c);
        if (sd === null || sd <= ECART_TYPE_BRUIT) continue;
        return { parent: a, trait: t, valeur: v, n: c.n, sd };
      }
    }
  }
  return null;
}
function traitCompagnon(parent) {
  /* Ceux que le parent paie deja, et qu'il ne regarde pas encore. */
  const payes = besoinsDe(parent);
  const siens = new Set((parent.traits || []).map((s) => nomTrait(s)));
  const libres = [];
  for (const k in TRAITS) {
    if (siens.has(k)) continue;
    const b = TRAITS[k].besoin;
    if (b === null || payes.indexOf(b) >= 0) libres.push(k);
  }
  return libres.length ? libres[0] : null;
}
function engendre() {
  const enfants = E.roster.filter((a) => a.role === 'specialiste');
  if (enfants.length >= ENFANTS_MAX) return null;
  const flou = chercheCaseFloue();
  if (!flou) return null;
  const compagnon = traitCompagnon(flou.parent);
  if (!compagnon) return null;
  const croise = [flou.trait, compagnon];
  const key = flou.parent.key + '-' + nomTrait(croise).replace(/[^a-z0-9]/gi, '');
  if (E.roster.some((a) => a.key === key)) return null;
  const petit = {
    key, nom: flou.parent.nom.split('-')[0] + ' · ' + compagnon,
    emoji: EMOJIS_ENFANTS[enfants.length % EMOJIS_ENFANTS.length],
    couleur: flou.parent.couleur, role: 'specialiste',
    ordre: 90 + enfants.length, parent: flou.parent.key, ne: Date.now(),
    caseSource: { trait: flou.trait, sd: Math.round(flou.sd * 10) / 10 },
    /* Le libelle de la case passe par la table des mots : c'est la meme case
       que celle de la memoire, montree, donc traduite comme les autres. */
    mission: 'Splits « ' + enMots(flou.valeur) + ' » by ' + compagnon
           + ' — the ' + flou.parent.nom.split('-')[0] + '\'s own cut is too scattered there',
    traits: [croise],
  };
  E.roster.push(petit);
  journal('naissance', petit.nom + ' is born: « ' + enMots(flou.valeur) + ' » was seen ' + flou.n
    + ' times with a standard deviation of ' + Math.round(flou.sd)
    + ' points — that cell predicts nothing',
    [{ parent: flou.parent.key, trait: flou.trait, obs: flou.n, ecartType: Math.round(flou.sd) }]);
  return petit;
}

/* ---- 3. ET LE RETRAIT ----
 * Sans lui, « ils peuvent se multiplier » finit en trois cents agents dont
 * aucun ne sait rien. Un specialiste vit s'il fait MIEUX que la case de son
 * parent : moins disperse, sur assez d'observations. Sinon il part, et on
 * ecrit pourquoi. */
function elague() {
  for (const petit of E.roster.filter((a) => a.role === 'specialiste')) {
    const m = E.memoire[petit.key] || {};
    let n = 0, somme = 0, poids = 0;
    for (const t in m) for (const v in m[t]) {
      const c = m[t][v];
      n += c.n;
      const sd = ecartType(c);
      if (sd !== null && c.n >= 4) { somme += sd * c.n; poids += c.n; }
    }
    if (n < 12 || !poids) continue;              /* trop tot pour juger */
    const sien = somme / poids;
    const pere = (petit.caseSource || {}).sd || null;
    if (pere === null) continue;
    if (sien <= pere * 0.85) continue;           /* il fait mieux : il reste */
    E.roster = E.roster.filter((a) => a.key !== petit.key);
    delete E.memoire[petit.key];
    journal('retrait', petit.nom + ' is retired: standard deviation ' + Math.round(sien)
      + ' against ' + Math.round(pere) + ' for its parent\'s cell — it does not cut better',
      [{ agent: petit.key, ecartType: Math.round(sien), parent: Math.round(pere), obs: n }]);
    return petit;
  }
  return null;
}

/* ==========================================================================
 * LA SURVEILLANCE
 *
 * « Je vois qu'il scanne souvent le même. S'il a déjà scanné, ça sert à rien
 *   de l'analyser en boucle. Peut-être le mettre dans une case surveillance
 *   s'il a un potentiel. »
 *
 * Deux sorts, et ils ne se ressemblent pas.
 *
 *   BANNI : le refus portait sur le CONTRAT — honeypot, taxes, pouvoirs du
 *   proprietaire, createur deja connu. Rien de tout cela ne changera : le
 *   jeton n'est plus jamais regarde, et chaque tour economise ses appels.
 *
 *   SURVEILLE : le refus portait sur un ETAT — trop peu de porteurs, note
 *   trop basse, personne ne garde encore. Tout cela change en une heure sur un
 *   jeton de dix minutes. Il est repris quand un signal GRATUIT a bouge — le
 *   flux des pools, qu'on lit de toute facon — ou apres un long moment.
 * ======================================================================== */
/* Les deux vocabulaires, et ce n'est pas un detail de forme : ce motif seul
   separe le BANNI du surveille. Ecrit en francais apres le passage du Warden
   a l'anglais, il ne reconnaissait plus que « honeypot » — le seul mot commun
   aux deux langues. Un contrat qu'on ne peut pas acheter, un auto-destruct,
   une taxe de vente de 42 % : tous repartaient en surveillance, donc relus
   indefiniment, et repayes a chaque reprise. Un etat relu d'avant la bascule
   porte encore les anciennes phrases, elles restent donc reconnues. */
const REFUS_DEFINITIFS = new RegExp([
  'honeypot', 'cannot buy', 'rewrite balances', 'self-destruct', 'per-wallet tax',
  'creator already made', 'transfers can be paused', 'sell tax', 'buy tax',
  'achat impossible', 'proprietaire reecrit', 'auto-destruction', 'taxe par portefeuille',
  'createur deja', 'suspendables', 'taxe vente', 'taxe achat',
].join('|'));

function noteConnu(t, verdict, note) {
  const c = E.connus[t.addr] || (E.connus[t.addr] = { sym: t.sym, vu: 0, ne: Date.now() });
  c.sym = t.sym;
  c.vu++;
  c.dernier = Date.now();
  c.verdict = verdict || null;
  c.note = note === undefined ? null : note;
  c.liq = Math.round(t.liq || 0);
  c.prix = t.prix || 0;
  if (verdict && REFUS_DEFINITIFS.test(verdict)) c.permanent = true;
  if (note !== undefined && note !== null && (c.meilleure === undefined || note > c.meilleure)) c.meilleure = note;
  return c;
}
/* Faut-il payer l'analyse complete de ce jeton ? Rien de ce qui est mesure ici
   ne coute un appel : c'est tout l'interet. */
function doitExaminer(t) {
  const c = E.connus[t.addr];
  if (!c) return { oui: true, pourquoi: 'never seen' };
  if (c.permanent) return { oui: false, pourquoi: 'banned: ' + c.verdict };
  const depuis = Date.now() - (c.dernier || 0);
  /* ---- CELUI QU'ON EST ALLE RECHERCHER EXPRES ----
   * `reprises` ne ramene un jeton que s'il avait frole le seuil, qu'il a
   * maintenant l'age d'etre indexe, et qu'on ne l'a pas redemande depuis vingt
   * minutes. L'ecarter ici pour « rien n'a bouge » reviendrait a payer l'appel
   * qui le ramene puis a jeter ce qu'il rapporte — et ce qui a bouge, c'est
   * justement ce que DexScreener sait de lui, qu'on ne peut pas comparer a
   * l'ancien puisqu'il n'y en avait pas. */
  if (t.origine === 'surveillance')
    return { oui: true, pourquoi: 'picked up again at ' + Math.round((t.minutes || 0)) + ' min' };
  if (depuis >= SURV_MIN_MS) return { oui: true, pourquoi: 'looked at again after ' + Math.round(depuis / 60000) + ' min' };
  if (c.liq > 0 && t.liq >= c.liq * SURV_LIQ)
    return { oui: true, pourquoi: 'liquidity +' + Math.round((t.liq / c.liq - 1) * 100) + '%' };
  if (c.prix > 0 && t.prix >= c.prix * SURV_PRIX)
    return { oui: true, pourquoi: 'price +' + Math.round((t.prix / c.prix - 1) * 100) + '%' };
  return { oui: false, pourquoi: 'already judged ' + Math.round(depuis / 60000) + ' min ago, nothing moved' };
}
/* Ce que la page montre sous « surveillance » : ceux qu'on garde a l'oeil
   parce qu'ils ont frole le seuil, et non ceux qu'on a bannis. */
function surveilles() {
  const out = [];
  for (const addr in E.connus) {
    const c = E.connus[addr];
    if (c.permanent) continue;
    if (!(c.meilleure >= SEUIL - 20)) continue;
    out.push({ addr, sym: c.sym, vu: c.vu, note: c.note, meilleure: c.meilleure,
               dernier: c.dernier, verdict: c.verdict, liq: c.liq });
  }
  out.sort((a, b) => (b.meilleure || 0) - (a.meilleure || 0));
  return out.slice(0, 12);
}


/* ==========================================================================
 * LA SENTINELLE ET LE PROMOTEUR
 *
 * « Un agent en plus qui décide si on prolonge ou pas le trade, et un qui
 *   surveille chaque trade. C'est aussi pour ça que chaque agent doit être
 *   indépendant et apprendre et améliorer son propre travail, pas attendre le
 *   résultat final des trades. »
 *
 * Le defaut vise est reel : jusqu'ici, TOUT le monde apprenait de la meme
 * chose — le rendement final d'une position — et personne ne repondait de ce
 * qu'il faisait lui. Une position ouverte etait ensuite abandonnee a une
 * minuterie : vingt minutes, quoi qu'il arrive entre-temps.
 *
 *   LA SENTINELLE regarde les positions OUVERTES, a chaque tour. Elle coupe
 *   quand le sol se derobe — le prix qui s'effondre, la piscine qui se vide —
 *   sans attendre la fin du compte a rebours. Ses regles de coupe sont dans le
 *   code : c'est une securite, pas une preference. Ce qu'elle APPREND, c'est
 *   ce que valait chaque signal : « quand j'ai vu la piscine perdre la moitie,
 *   la position a fini a -40 % en moyenne, sur onze fois ». Elle repond de ses
 *   propres alertes, pas du resultat global.
 *
 *   LE PROMOTEUR intervient au moment ou une position arrive a terme. Si elle
 *   monte, il peut la PROLONGER d'une duree de plus. Et il apprend sur ce qui
 *   est vraiment son travail : la DIFFERENCE entre ce que la position valait
 *   au moment de sa decision et ce qu'elle a fini par rendre. Prolonger un
 *   gagnant qui redescend est une faute, meme si la position finit positive —
 *   et c'est exactement ce qu'un apprentissage sur le resultat final ne
 *   pourrait pas voir.
 * ======================================================================== */
const CHUTE_COUPE = -35;        /* le prix a perdu plus d'un tiers depuis l'entree */
const LIQ_COUPE = 0.5;          /* ou la piscine a perdu la moitie de son fond */
const PROLONGE_MAX = 3;         /* on ne prolonge pas indefiniment */

function casSentinelle(p, x) {
  const cas = {};
  const r = (x.prix - p.prix0) / p.prix0 * 100;
  cas.derive = tranche(r, [-35, -10, 10, 40],
    ['effondre', 'en baisse', 'a plat', 'en hausse', 'envole']);
  cas.liq = (p.liq0 > 0 && x.liq > 0)
    ? tranche(x.liq / p.liq0, [0.5, 0.9, 1.5], ['piscine divisee par 2', 'piscine en baisse',
                                                'piscine stable', 'piscine qui grossit'])
    : 'piscine ?';
  return cas;
}
/* La coupe est une SECURITE : elle est dans le code, elle ne s'apprend pas et
   ne se desserre pas. Un systeme qui peut apprendre a ne plus couper sur un
   effondrement l'apprendra un jour, et ce jour-la il perdra tout. */
function dangerSentinelle(p, x) {
  const r = (x.prix - p.prix0) / p.prix0 * 100;
  if (r <= CHUTE_COUPE) return 'down ' + Math.round(-r) + '% since entry';
  if (p.liq0 > 0 && x.liq > 0 && x.liq < p.liq0 * LIQ_COUPE)
    return 'the pool went from $' + Math.round(p.liq0) + ' to $' + Math.round(x.liq);
  return null;
}

/* Le Promoteur : prolonger, ou laisser fermer. Il ne prolonge que ce qui monte
   — prolonger une perdante est de l'esperance, pas une decision — et il
   consulte ce qu'il a appris de ses propres prolongations. */
function casPromoteur(p, r) {
  return {
    gain: tranche(r, [0, 10, 30, 80], ['en perte', 'a peine positive', '+10-30%', '+30-80%', '+80% et plus']),
    note: tranche(p.score || 0, [60, 70, 85], ['note 55-60', 'note 60-70', 'note 70-85', 'note 85+']),
    fois: (p.prolonge || 0) + 'e prolongation',
  };
}
function nObs(agent) {
  const m = E.memoire[agent] || {};
  let n = 0;
  for (const t in m) for (const v in m[t]) n = Math.max(n, m[t][v].n);
  return n;
}
const PROMOTEUR_ESSAIS = 6;   /* de quoi se faire une idee, pas de quoi immobiliser la caisse */

function veutProlonger(p, r) {
  if (r <= 2) return null;                              /* elle ne monte pas : on ferme */
  if ((p.prolonge || 0) >= PROLONGE_MAX) return null;   /* et pas indefiniment */
  const cas = casPromoteur(p, r);
  const gain = ajustementAgent('promoteur', cas);
  if (gain > 0.5) return cas;      /* son releve dit de garder */
  if (gain < -0.5) return null;    /* son releve dit de fermer */

  /* ---- SANS RELEVE, IL N'AFFIRME RIEN — MAIS IL DOIT BIEN APPRENDRE ----
   * Prolonger toutes les hausses « pour voir » immobilisait la caisse entiere :
   * six positions sur six gardees, plus rien qui se ferme, donc plus personne
   * qui apprend quoi que ce soit — l'inverse exact du but. Ne jamais prolonger
   * sans releve est aussi une impasse : il n'aurait jamais de releve.
   * Il essaie donc une fois sur trois, et seulement sur les fortes hausses,
   * jusqu'a s'etre fait une idee. Ensuite c'est son releve qui parle. */
  if (nObs('promoteur') >= PROMOTEUR_ESSAIS) return null;
  if (r < 25) return null;
  E.promoteurEssais = (E.promoteurEssais || 0) + 1;
  return (E.promoteurEssais % 3 === 0) ? cas : null;
}


/* ==========================================================================
 * PRENDRE UN GAIN — ET SAVOIR SI ON A EU RAISON
 *
 * Personne ne prenait de gain. Le Closer tenait sa duree, le Promoteur la
 * prolongeait, la Sentinelle ne coupait que sur un desastre. Une position qui
 * faisait +80 % au bout de six minutes attendait sagement la vingtieme, et ce
 * qu'elle rendait alors n'avait plus grand-chose a voir.
 *
 * ---- LE PROBLEME, C'EST D'APPRENDRE ----
 *
 * Vendre a +40 % et enregistrer « j'ai eu +40 % » n'apprend rien : c'est
 * circulaire. La question est « qu'aurais-je eu en gardant ? », et une fois la
 * position fermee on ne le sait plus.
 *
 * Sauf qu'on continue de lire le marche. On note donc la sortie et on REVIENT
 * voir, au moment ou la position se serait fermee. La lecon est la difference
 * entre ce qu'on a pris et ce qu'on aurait eu — mesuree sur des prix reels,
 * pas sur une simulation. Positive, la Sentinelle a bien fait ; negative, elle
 * a vendu trop tot, et elle le saura.
 *
 * C'est plus lent qu'une regle ecrite a la main. C'est la seule facon d'avoir
 * une regle qui vienne de ce qui s'est reellement passe.
 * ======================================================================== */
const GAIN_EXPLORE = 20;      /* en dessous, il n'y a rien a arbitrer */
const SUITES_MAX = 60;
const SUITE_OUBLI_MS = 4 * 3600e3;

function casSortie(r) {
  return { sortie: tranche(r, [35, 60, 120],
    ['gain pris a +20-35%', 'gain pris a +35-60%', 'gain pris a +60-120%', 'gain pris a +120%']) };
}

/* Faut-il prendre le gain maintenant ? Son propre releve decide ; sans releve
   il essaie une fois sur trois, comme le Promoteur — assez pour apprendre, pas
   assez pour vendre tout ce qui monte. */
function veutPrendre(p, r) {
  if (r < GAIN_EXPLORE) return null;
  const cas = casSortie(r);
  const avis = ajustementAgent('sentinelle', cas);
  if (avis > 0.5) return cas;
  if (avis < -0.5) return null;
  if (nObs('sentinelle') >= 8 && memLit('sentinelle', 'sortie', cas.sortie)) return null;
  E.sortieEssais = (E.sortieEssais || 0) + 1;
  return (E.sortieEssais % 3 === 0) ? cas : null;
}

/* On note ce qu'on vient de prendre, et QUAND il faudra revenir voir. */
function noteSuite(p, prix, r, cas, quand) {
  if (!Array.isArray(E.suites)) E.suites = [];
  E.suites.push({
    adr: p.adr, sym: p.sym, prix0: p.prix0, rSortie: Math.round(r * 100) / 100,
    cas, t: quand,
    /* Le moment ou la position se serait fermee si on n'avait rien fait. */
    echeance: p.t0 + (p.tenueMin || TENUE_DEFAUT_MIN) * 60000,
  });
  if (E.suites.length > SUITES_MAX) E.suites = E.suites.slice(-SUITES_MAX);
}

/* Et on revient voir. C'est ici que la lecon se forme. */
function regleLesSuites(marche) {
  if (!Array.isArray(E.suites) || !E.suites.length) return 0;
  const now = Date.now();
  let appris = 0;
  E.suites = E.suites.filter((s) => {
    if (now - s.t > SUITE_OUBLI_MS) return false;     /* on ne poursuit pas indefiniment */
    if (now < s.echeance) return true;                /* pas encore l'heure */
    const brut = marche[s.adr];
    const x = (typeof brut === 'number') ? { prix: brut } : brut;
    if (!x || !(x.prix > 0)) return true;             /* pas de prix relu : on attend */
    const rTenu = (x.prix - s.prix0) / s.prix0 * 100;
    if (!isFinite(rTenu) || rTenu > REND_MAX || rTenu < REND_MIN) return false;
    /* La valeur de la decision : ce qu'on a pris moins ce qu'on aurait eu. */
    const gain = s.rSortie - rTenu;
    apprendAgent('sentinelle', s.cas, gain);
    compte('sortiesJugees');
    E.flux.unshift({ sym: s.sym, tag: gain >= 0 ? 'buy' : 'cut',
      txt: 'sold at ' + (s.rSortie >= 0 ? '+' : '') + s.rSortie.toFixed(1) + '%, it was worth '
         + (rTenu >= 0 ? '+' : '') + rTenu.toFixed(1) + '% at the deadline · '
         + (gain >= 0 ? 'sold well' : 'sold too early') + ' by ' + Math.abs(gain).toFixed(1) + ' pts',
      cls: gain >= 0 ? 'up' : 'dn', t: now, par: 'sentinelle' });
    appris++;
    return false;
  });
  return appris;
}


/* ==========================================================================
 * LE LIVRE D'OMBRE : APPRENDRE DE CE QU'ON N'A PAS ACHETE
 *
 * « Fais-lui trader plus de jetons, qu'il en analyse plus, pour s'améliorer
 *   plus vite. »
 *
 * L'intuition est juste, mais le frein n'etait pas le nombre de positions.
 * Il etait dans ce que les agents avaient le droit de voir.
 *
 * ---- LE DEFAUT, ET IL EST STATISTIQUE ----
 *
 * Ils n'apprenaient QUE des jetons achetes. Or un jeton n'est achete que s'il
 * a passe tous les vetos et depasse le seuil : la memoire ne contenait donc
 * que des cas selectionnes par les regles qu'on voulait justement evaluer.
 * C'est un biais de selection dans sa forme la plus pure — le Warden ne
 * pouvait pas savoir si les contrats qu'il bloquait s'effondraient vraiment,
 * puisqu'il ne voyait jamais la suite. Six positions par heure, et aucune
 * information sur les quatre-vingt-quatorze autres jetons examines.
 *
 * ---- CE QU'ON CHANGE ----
 *
 * Chaque jeton ANALYSE laisse une ombre : son prix, ses traits, sa note, et la
 * raison de son refus s'il y en a une. A l'echeance, on relit son prix — le
 * flux des pools le donne gratuitement — et tous les agents d'analyse
 * apprennent de ce qu'il a fait. Achete ou non.
 *
 * C'est legitime parce qu'ils apprennent un POURCENTAGE, pas des dollars : le
 * rendement d'un jeton est le meme qu'on ait mise dessus ou pas. Rien n'est
 * simule, rien n'est suppose ; c'est un prix relu, comme les autres.
 *
 * Le gain est d'un ordre de grandeur : dix a vingt observations par tour au
 * lieu de zero a une, et sur la population ENTIERE au lieu de sa partie deja
 * approuvee.
 *
 * ---- ET LES VETOS SE FONT AUDITER ----
 *
 * C'est la consequence la plus utile. On saura si les jetons refuses pour
 * « un porteur tient 90 % » se sont vraiment effondres, et combien de ceux
 * qu'on a ecartes sont montes. Un veto qui ecarte surtout des gagnants n'est
 * pas une protection, c'est un cout — et jusqu'ici rien n'aurait pu le dire.
 *
 * Les agents qui apprennent de leurs propres DECISIONS — Banquier, Closer,
 * Sentinelle, Promoteur — restent en dehors : une position qu'on n'a pas prise
 * n'a ni mise, ni duree tenue, ni gain pris. Ils n'ont rien a apprendre d'une
 * ombre, et leur en donner melangerait ce qu'on a fait avec ce qu'on aurait pu
 * faire.
 * ======================================================================== */
/* Le dernier horizon est a deux heures : il faut donc garder une ombre assez
   longtemps pour l'atteindre, et il y en a plus a la fois. Vingt jetons par
   tour, un tour toutes les deux minutes et demie, deux heures de suivi : mille
   deux cents suffit largement, et le fichier reste petit. */
const OMBRES_MAX = 1200;
const OMBRE_OUBLI_MS = 3 * 3600e3;
const OMBRE_TENUE_MIN = 20;     /* la meme echeance qu'une position, pour comparer ce qui l'est */

function noteOmbre(t, an, refus, quiRefuse) {
  if (!Array.isArray(E.ombres)) E.ombres = [];
  if (!(t.prix > 0) || !an) return;
  if (E.ombres.some((o) => o.adr === t.addr)) return;   /* une seule ombre a la fois par jeton */
  const now = Date.now();
  E.ombres.push({
    adr: t.addr, sym: t.sym, prix0: t.prix, t: now,
    echeance: now + OMBRE_TENUE_MIN * 60000,
    traits: an.traits, score: an.score,
    refus: refus || null, quiRefuse: quiRefuse || null,
    /* DexScreener le connaissait-il a l'entree ? C'est ce qui permet, plus
       tard, de distinguer « jamais indexe » de « disparu » (voir
       `regleLesOmbres`). */
    dexVu: !!(t.dex && t.dex.vu),
    jalons: {},           /* ce qu'il valait a chaque echeance atteinte */
  });
  if (E.ombres.length > OMBRES_MAX) E.ombres = E.ombres.slice(-OMBRES_MAX);
}

/* L'audit des vetos : par raison de refus, ce que les jetons ecartes ont fait.
   Un veto qui ecarte surtout des gagnants n'est pas une protection. */
/* ---- UNE REGLE, PAS UN JETON ----
 *
 * La cle de l'audit etait « qui refuse · les quarante premiers caracteres du
 * refus ». Or un refus porte les chiffres DU JETON : « piscine de $4 231 :
 * sous le plancher d'achat ($10 000) ». Chaque jeton fabriquait donc sa propre
 * case, a un seul element, et `auditDesRefus` ecarte tout ce qui a moins de
 * trois observations. Resultat mesure sur la colonie : la regle qui arrete
 * 63 % des jetons — le plancher de liquidite — n'apparaissait PAS UNE FOIS
 * dans le panneau « ce que deviennent les refuses », alors que l'alerte
 * envoyait precisement le lire pour decider s'il fallait la bouger.
 *
 * La regle qu'on veut juger est celle qui reste quand on retire les chiffres.
 * C'est la meme normalisation que les familles de refus de l'alerte, et c'est
 * maintenant la MEME fonction : deux copies auraient fini par diverger, et
 * l'alerte aurait alors nomme une famille introuvable dans le panneau. */
/* ---- UNE REGLE, UNE LIGNE — QUELLE QUE SOIT LA LANGUE OU ELLE A ETE ECRITE ----
 *
 * Releve sur la colonie, dans le panneau des refuses :
 *
 *   62 %  scout · trop jeune (# min) : on attend # h pour        21 jetons
 *   50 %  scout · trop jeune (# min) : on le reprend a # min#…    4 jetons
 *   42 %  scout · trop jeune (# min) : on attend # h pour voir…  19 jetons
 *   60 %  scout · deja +#% en une heure : on paierait l           5 jetons
 *   50 %  scout · already +#% in an hour: we would be paying…     4 jetons
 *
 * Trois lignes pour LA MEME regle d'age, deux pour la meme regle de hausse.
 * Ce n'est pas la colonie qui a change d'avis : c'est la phrase qui a change,
 * d'abord de formulation, puis de langue. La cle etant le texte, chaque
 * reecriture a ouvert une case neuve et coupe les observations en deux.
 *
 * Et l'effet n'est pas cosmetique. Ce panneau existe pour dire si une regle
 * protege ou si elle coute ; quarante-quatre jetons repartis sur trois lignes
 * se lisent comme trois regles tiedes, quand c'est une seule regle massive.
 * Une decision prise la-dessus serait prise sur le mauvais chiffre.
 *
 * On ne garde donc plus la phrase comme identite : on garde LA REGLE. Le motif
 * reconnait les deux langues et toutes les formulations qu'on a ecrites — et
 * le libelle rendu est celui d'aujourd'hui, en anglais. Ce qui n'est reconnu
 * par aucun motif garde son texte, nombres remplaces : une regle nouvelle doit
 * apparaitre telle qu'elle, pas se faire absorber par la voisine. */
const FAMILLES = [
  [/too young|trop jeune/, 'too young: set aside until it has the age'],
  [/cooling down/, 'sold recently: cooling down before buying it again'],
  [/paying the top|on paierait le sommet|paierait l/, 'already up too far: we would be paying the top'],
  [/already down|deja tombe|deja \-/, 'already down before we even look'],
  [/above the buy ceiling|au-dessus du plafond/, 'cap above the buy ceiling'],
  [/pool: below the buy floor|piscine de \$# sous le plancher|sous le plancher d'achat/,
   'pool below the buy floor'],
  [/cap: below the buy floor|capitalisation .* sous le plancher/, 'cap below the buy floor'],
  [/nothing to sell into|piscine de \$# pour une capitalisation|rien a vendre dedans/,
   'pool too thin for the cap: nothing to sell into'],
  [/not a market any more|ce n'est plus un marche/, 'volume on nothing: that is an exit, not a market'],
  [/no public presence|aucune presence publique/, 'no public presence at all'],
  [/not indexed by DexScreener|pas encore verifiable/, 'not indexed by DexScreener yet'],
  [/absent from DexScreener|absent de DexScreener/, 'absent from DexScreener'],
  [/^missing:|^il manque/, 'missing socials'],
  [/score too low|note trop basse/, 'score too low'],
  [/exit is blocked|la sortie est bloquee/, 'the exit is blocked'],
  [/holder holds|porteur tient/, 'one holder holds too much'],
  [/nobody holds|aucune ne le garde/, 'nobody holds it'],
  [/single wallet makes|portefeuille fait/, 'one wallet makes most of the volume'],
  [/honeypot/, 'honeypot'],
  [/sell tax|buy tax|taxe vente|taxe achat/, 'tax too high'],
];
function familleRefus(r) {
  const t = String(r);
  const f = FAMILLES.find((x) => x[0].test(t));
  if (f) return f[1];
  return t.replace(/\d[\d.,]*/g, '#').replace(/\s+/g, ' ').trim().slice(0, 70);
}

function noteAudit(cle, r) {
  if (!E.audit || typeof E.audit !== 'object') E.audit = {};
  const a = E.audit[cle] || (E.audit[cle] = { n: 0, s: 0, montes: 0, effondres: 0 });
  a.n++; a.s += r;
  if (r >= 20) a.montes++;
  if (r <= -30) a.effondres++;
}

/* ---- UNE MESURE PRISE AU MAUVAIS MOMENT N'EST PAS UNE MESURE ----
 * Les prix arrivent quand le jeton repasse dans un flux, pas a la seconde
 * voulue. Sans cette borne, un jeton relu pour la premiere fois a quarante
 * minutes remplirait d'un coup les echeances de 5, 15 et 30 minutes avec son
 * rendement a quarante — et les trois courbes seraient fausses, sans que rien
 * ne le signale. Une echeance ratee reste vide. */
function jalonValable(h, age) { return age >= h && age <= h + Math.max(5, h * 0.5); }

/* ---- UNE OMBRE QUI DISPARAIT N'EST PAS UNE OMBRE SANS RESULTAT ----
 *
 * Les lecons disaient que les jetons nes depuis moins de dix minutes, dans
 * une piscine de mille a cinq mille dollars, etaient les meilleurs (+24, +32
 * de moyenne). Et la colonie enchainait les entrees qui perdaient 50 a 90 %
 * en dix minutes. Les deux etaient vrais en meme temps, parce qu'une ombre
 * dont le jeton s'effondrait ne recevait JAMAIS de note : la piscine videe
 * ne repasse dans aucun flux, la relecture ne rend rien, et « non jugee »
 * voulait dire « absente des lecons ». Ne restaient que les survivantes — et
 * les survivantes des jetons de dix minutes sont des fusees. Un biais de
 * survie, au sens propre.
 *
 * Un jeton que DexScreener CONNAISSAIT a l'entree et qui, passe l'echeance de
 * reference, ne repond plus a deux relectures de suite, est note comme
 * effondre. Un jeton que DexScreener n'a jamais indexe reste non juge : son
 * silence ne dit rien de lui. */
const OMBRE_DISPARUE = -95;         /* ce que vaut un jeton dont la piscine s'est evaporee */
const OMBRE_SILENCES = 2;           /* deux relectures muettes de suite, pas une */

function regleLesOmbres(marche) {
  if (!Array.isArray(E.ombres) || !E.ombres.length) return 0;
  const now = Date.now();
  let n = 0;
  const dernier = HORIZONS[HORIZONS.length - 1];
  E.ombres = E.ombres.filter((o) => {
    if (now - o.t > OMBRE_OUBLI_MS) return false;
    const age = (now - o.t) / 60000;
    if (!o.jalons) o.jalons = {};
    const brut = marche[o.adr];
    let x = (typeof brut === 'number') ? { prix: brut } : brut;
    if (!(x && x.prix > 0) && o.dexVu && (o.muets || 0) >= OMBRE_SILENCES
        && age >= HORIZON_REF && o.jalons[HORIZON_REF] === undefined) {
      /* Jugee au prix d'une piscine vide, a l'echeance de reference, et
         seulement a celle-la : les autres n'ont pas ete mesurees. */
      const r = OMBRE_DISPARUE;
      o.jalons[HORIZON_REF] = r;
      o.disparue = true;
      noteProfil(o.traits, HORIZON_REF, r);
      compte('jalons');
      for (const k of apprenants()) if (o.traits && o.traits[k]) apprendAgent(k, o.traits[k], r);
      apprendBase(r);
      noteAudit(o.refus ? (o.quiRefuse || 'refus') + ' · ' + familleRefus(o.refus)
                        : 'achete ou retenu', r);
      compte('ombresJugees'); compte('ombreDisparue');
      n++;
      return age <= dernier + Math.max(5, dernier * 0.5);
    }
    if (x && x.prix > 0) {
      const r = (x.prix - o.prix0) / o.prix0 * 100;
      /* Les memes bornes que pour une position : un rapport aberrant ne decrit
         rien, et une lecon tiree d'un chiffre faux se propage a tous les
         jetons qui partagent le trait. */
      if (!isFinite(r) || r > REND_MAX || r < REND_MIN) { compte('ombreAberrante'); return false; }
      for (const h of HORIZONS) {
        if (o.jalons[h] !== undefined) continue;
        if (!jalonValable(h, age)) continue;
        o.jalons[h] = Math.round(r * 10) / 10;
        noteProfil(o.traits, h, r);
        compte('jalons');
        /* L'echeance de reference est la seule qui nourrisse la memoire des
           agents et l'audit des vetos : sinon le meme jeton compterait cinq
           fois, et les cases gonfleraient sans qu'on ait vu cinq jetons. */
        if (h === HORIZON_REF) {
          for (const k of apprenants()) if (o.traits && o.traits[k]) apprendAgent(k, o.traits[k], r);
          apprendBase(r);
          noteAudit(o.refus ? (o.quiRefuse || 'refus') + ' · ' + familleRefus(o.refus)
                            : 'achete ou retenu', r);
          compte('ombresJugees');
          n++;
        }
      }
    }
    /* On la garde tant qu'une echeance reste atteignable. */
    return age <= dernier + Math.max(5, dernier * 0.5);
  });
  return n;
}

/* Ce que la page montre de l'audit : par raison, combien ont ete ecartes et ce
   qu'ils ont fait. Trie par ce qui coute le plus cher a se tromper. */
function auditDesRefus() {
  const out = [];
  for (const cle in (E.audit || {})) {
    const a = E.audit[cle];
    if (a.n < 3) continue;
    out.push({ cle, n: a.n, moyenne: Math.round(a.s / a.n * 10) / 10,
               montes: a.montes, effondres: a.effondres,
               partMontes: Math.round(a.montes / a.n * 100) });
  }
  out.sort((x, y) => y.partMontes - x.partMontes);
  return out.slice(0, 10);
}


/* ==========================================================================
 * LE PROFIL DANS LE TEMPS : QUAND CE GENRE DE JETON PAIE
 *
 * « L'essentiel, c'est qu'il récolte une masse de données pour comprendre
 *   comment trader correctement et faire de l'argent. »
 *
 * Tout etait juge a UN horizon : vingt minutes, et l'observation etait jetee.
 * On ne pouvait donc jamais repondre a la seule question qui decide du
 * resultat — QUAND vendre. Un jeton a +40 % a la vingtieme minute peut avoir
 * fait +120 % a la huitieme, ou etre en route vers +300 % a la deuxieme heure.
 * Ces trois cas donnaient exactement la meme ligne dans la memoire.
 *
 * Chaque jeton suivi est maintenant releve a CINQ echeances. Le cout est nul :
 * ces prix sont deja lus a chaque tour, on se contentait de les ignorer.
 *
 * ---- CE QUE CA REND POSSIBLE ----
 *
 * Une courbe par TRAIT. Non plus « les jetons a forte liquidite rendent +3 % »,
 * mais « ils font +12 % a cinq minutes, +8 % a quinze, et rendent tout a une
 * heure » — ce qui ne se lit pas du tout pareil, et ne se trade pas pareil.
 *
 * De la sort une duree de tenue par jeton, tiree de ses propres traits, au
 * lieu d'une constante unique pour tout le monde. C'est la premiere fois que
 * « comment trader correctement » devient une question a laquelle la colonie
 * peut repondre par une mesure.
 * ======================================================================== */
const HORIZONS = [5, 15, 30, 60, 120];        /* en minutes */
const HORIZON_REF = 30;                       /* celui qui nourrit la memoire des agents */
const PROFIL_MIN_OBS = 6;                     /* en dessous, une courbe n'est pas une courbe */

function profilCase(trait, valeur, h) {
  if (!E.profils || typeof E.profils !== 'object') E.profils = {};
  const t = E.profils[trait] || (E.profils[trait] = {});
  const v = t[valeur] || (t[valeur] = {});
  return v[h] || (v[h] = { n: 0, s: 0, s2: 0 });
}
function noteProfil(traits, h, r) {
  for (const agent in traits) {
    for (const trait in traits[agent]) {
      const c = profilCase(trait, traits[agent][trait], h);
      c.n++; c.s += r; c.s2 += r * r;
    }
  }
}

/* ---- LA COURBE D'UN TRAIT ----
 * Ce que rend, en moyenne, un jeton portant cette caracteristique, a chaque
 * echeance. Les cases trop peu observees sont ecartees : une moyenne sur deux
 * jetons n'est pas une courbe, c'est deux jetons. */
function courbeDe(trait, valeur) {
  const v = ((E.profils || {})[trait] || {})[valeur];
  if (!v) return null;
  const pts = [];
  for (const h of HORIZONS) {
    const c = v[h];
    if (!c || c.n < PROFIL_MIN_OBS) continue;
    pts.push({ h, n: c.n, moyenne: Math.round(c.s / c.n * 10) / 10, ecart: Math.round(ecartType(c) || 0) });
  }
  return pts.length ? pts : null;
}

/* ---- LA DUREE QUE CE JETON-LA MERITE ----
 * Chaque trait vote pour l'echeance ou IL rend le plus, pondere par ce qu'on
 * en sait. Sans assez d'observations, on ne repond pas : c'est la tenue
 * apprise par le Closer qui reprend la main, comme avant. */
function horizonPour(traits) {
  const votes = {};
  let poids = 0;
  for (const agent in (traits || {})) {
    for (const trait in traits[agent]) {
      const c = courbeDe(trait, traits[agent][trait]);
      if (!c) continue;
      let best = null;
      for (const p of c) if (!best || p.moyenne > best.moyenne) best = p;
      if (!best || best.moyenne <= 0) continue;   /* rien a gagner : ce trait ne vote pas */
      const w = confiance(best.n);
      votes[best.h] = (votes[best.h] || 0) + w;
      poids += w;
    }
  }
  if (poids < 1) return null;
  let gagnant = null;
  for (const h in votes) if (!gagnant || votes[h] > votes[gagnant]) gagnant = h;
  return { min: parseInt(gagnant, 10), poids: Math.round(poids * 10) / 10,
           votes: Object.keys(votes).map((h) => ({ h: parseInt(h, 10), poids: Math.round(votes[h] * 10) / 10 })) };
}

/* ==========================================================================
 * QUEL TRAIT PORTE DE L'INFORMATION
 *
 * Vingt-cinq traits sont releves sur chaque jeton, et jusqu'ici rien ne disait
 * lesquels servaient. Un trait dont toutes les valeurs rendent la meme chose
 * n'apprend rien — il dilue meme les autres, puisque son ajustement s'ajoute
 * au leur.
 *
 * Ce qu'on mesure : l'ECART entre ses valeurs, rapporte au bruit interne de
 * chacune. Si « liq<1k » rend -30 % et « liq>100k » +20 %, avec des ecarts
 * types de 15, le trait separe pour de bon. Si toutes ses valeurs rendent
 * +2 % a 40 pres, il ne separe rien.
 * ======================================================================== */
function informationDe(trait) {
  const v = (E.profils || {})[trait];
  if (!v) return null;
  const vals = [];
  for (const val in v) {
    const c = v[val][HORIZON_REF];
    if (!c || c.n < PROFIL_MIN_OBS) continue;
    vals.push({ val, n: c.n, moy: c.s / c.n, sd: ecartType(c) || 0 });
  }
  if (vals.length < 2) return null;
  const tot = vals.reduce((a, x) => a + x.n, 0);
  const moyG = vals.reduce((a, x) => a + x.moy * x.n, 0) / tot;
  /* L'ecart entre les valeurs, pondere par leurs effectifs. */
  const entre = Math.sqrt(vals.reduce((a, x) => a + x.n * (x.moy - moyG) * (x.moy - moyG), 0) / tot);
  /* Et le bruit a l'interieur de chacune. */
  const dedans = Math.sqrt(vals.reduce((a, x) => a + x.n * x.sd * x.sd, 0) / tot) || 1;
  const meilleure = vals.slice().sort((a, b) => b.moy - a.moy)[0];
  const pire = vals.slice().sort((a, b) => a.moy - b.moy)[0];
  return {
    trait, obs: tot, valeurs: vals.length,
    separation: Math.round(entre / dedans * 100) / 100,
    ecartValeurs: Math.round((meilleure.moy - pire.moy) * 10) / 10,
    meilleure: { quoi: meilleure.val, moyenne: Math.round(meilleure.moy * 10) / 10, n: meilleure.n },
    pire: { quoi: pire.val, moyenne: Math.round(pire.moy * 10) / 10, n: pire.n },
  };
}
function classementDesTraits() {
  const out = [];
  for (const trait in (E.profils || {})) {
    const i = informationDe(trait);
    if (i) out.push(i);
  }
  out.sort((a, b) => b.separation - a.separation);
  return out;
}

/* ==========================================================================
 * L'EPREUVE DE VENTE — LE COBAYE
 *
 * « Il faudrait un bot dans le village avant le gros achat. Il va acheter, il
 *   teste avec un centime un achat et une vente, pour pas se faire
 *   honeypot. »
 *
 * L'idee est la bonne, et c'est exactement ce que font les vrais robots. Mais
 * la colonie ne signe RIEN : un agent qui pretendrait depenser un centime
 * serait la fabrication que tout ce fichier refuse. Un centime qu'on n'a pas
 * depense ne prouve rien.
 *
 * On fait donc la meme chose, en mieux : on SIMULE la vente sur la chaine.
 * `eth_call` execute le contrat exactement comme une vraie transaction —
 * memes regles, meme etat, meme instant — mais sans rien signer, sans rien
 * payer, et sans rien laisser derriere. Verifie sur la chaine 4663 : le noeud
 * l'accepte et rend la reponse du contrat.
 *
 * ---- CE QU'ON SIMULE, PRECISEMENT ----
 *
 * Le premier geste d'une vente : envoyer le jeton vers la piscine. C'est la
 * que la plupart des pieges se referment — un honeypot laisse acheter, puis
 * refuse ce transfert-la, et le detenteur decouvre qu'il ne peut plus sortir.
 *
 * On le tente depuis de VRAIS detenteurs, lus dans les blocs. Le plus gros est
 * ecarte : c'est souvent le deployeur, et c'est souvent le seul a qui le
 * contrat laisse tout faire. Trois cobayes plutot qu'un, parce qu'un piege
 * peut viser une adresse en particulier.
 *
 * ---- ET CE QUE CETTE EPREUVE NE PROUVE PAS ----
 *
 * Elle simule le transfert, pas l'echange complet. Un contrat peut laisser
 * passer le transfert et faire echouer le swap plus loin — une taxe de vente
 * qui ramene la sortie a zero, un controle qui ne se declenche qu'a travers le
 * routeur. « Passe » veut donc dire « le chemin le plus courant n'est pas
 * bloque », pas « on pourra vendre ». C'est ecrit tel quel a l'ecran : une
 * epreuve de securite qu'on croit plus forte qu'elle n'est vaut moins que pas
 * d'epreuve du tout.
 *
 * ---- ELLE PASSE EN DERNIER ----
 *
 * Elle coute un a trois appels et ne sert que sur un jeton qu'on s'apprete a
 * acheter. « Avant le gros achat », donc : apres tous les autres controles.
 * ======================================================================== */
const SEL_TRANSFER = '0xa9059cbb';   /* transfer(address,uint256) */
/* Le vocabulaire d'une revocation, tel que les noeuds le rendent. Court
   expres : ce qui n'est pas la-dedans n'est pas compte contre le jeton. */
/* Le meme vocabulaire que celui qui distingue une reponse d'une panne, plus
   « revert » nu : ici on LIT la reponse, on n'a pas a etre aussi prudent que
   la ou l'on decide si un noeud est tombe. */
const EVM_REFUSE = /execution reverted|revert|invalid opcode|out of gas|stack underflow|always failing/i;

/* ---- A QUI ON ESSAIE D'ENVOYER, ET POURQUOI CE N'ETAIT PAS LA PISCINE ----
 *
 * Releve sur la colonie apres soixante et une heures : 299 epreuves jouees,
 * 251 « la sortie est bloquee », 7 passees. Quatre-vingt-quatre pour cent des
 * jetons qui avaient passe TOUS les autres gardes etaient des pieges — sur
 * une chaine ou l'audit de ces memes refuses rend -3 % de moyenne, cinq
 * montes, six effondres : le comportement d'un jeton ordinaire, pas d'un
 * honeypot, dont le prix ne fait que monter puisque personne ne peut vendre.
 *
 * La cause est dans la forme de `t.pool`. Sur cette chaine, quarante pour
 * cent des piscines sont des pools Uniswap V4, et un pool V4 n'a pas
 * d'adresse : les flux rendent son IDENTIFIANT, trente-deux octets —
 * `0x9abd26d9…6fe60519`, soixante-six caracteres. On le poussait dans le mot
 * `address` du `transfer`, ou il ne tient pas ; le decodeur du contrat refuse
 * un mot dont les douze octets hauts ne sont pas nuls — « execution reverted »
 * — et cette revocation-la etait lue comme la reponse d'un piege. Trois
 * porteurs, trois refus, a chaque fois, pour tout jeton V4 : le veto n'a
 * jamais rien dit du jeton, il disait la longueur d'une chaine de caracteres.
 *
 * Et les 7 « passees » : les pools a adresse. Les 41 « incertaines » : le
 * noeud n'avait pas repondu — et c'est donc SUR CELLES-LA, au hasard des
 * pannes, que la colonie a achete. Elle ne choisissait plus ses achats.
 *
 * ---- LA CIBLE, DANS L'ORDRE ----
 *
 *   1. la piscine, quand c'est une adresse — l'epreuve d'origine, inchangee ;
 *   2. sinon, l'adresse qui FAIT le marche dans les transferts qu'on vient de
 *      lire (voir `lisChaine` : elle echange avec presque tout le monde, dans
 *      les deux sens). Sur un pool V4, c'est le PoolManager, c'est-a-dire
 *      exactement l'endroit ou une vente enverrait le jeton ;
 *   3. sinon, le plus gros porteur : un piege qui gele tous les transferts est
 *      encore attrape, un piege qui ne bloque que la piscine ne l'est pas, et
 *      la reponse porte `via` pour qu'on sache laquelle des trois on a jouee.
 *
 * Ce que ca ne fait pas : deviner. Sans aucune cible, l'epreuve n'est pas
 * jouee, et « pas testable » ne bloque rien — comme avant. */
const ADRESSE = /^0x[0-9a-f]{40}$/i;
function cibleDeVente(t) {
  const pool = String(t.pool || '');
  if (ADRESSE.test(pool)) return { adr: pool, via: 'pool' };
  const ch = t.chaine || {};
  const infra = (ch.infraAdresses || []).filter((a) => ADRESSE.test(a));
  if (infra.length) return { adr: infra[0], via: 'market maker' };
  if (ADRESSE.test(ch.plusGros || '')) return { adr: ch.plusGros, via: 'largest holder' };
  return null;
}

async function simuleVente(t) {
  const ch = t.chaine || {};
  const cob = (ch.cobayes || []).slice(0, 3);
  if (!ch.vu || !cob.length || !t.pool)
    return { teste: false, raison: 'no known holder to try the exit with' };
  const cible = cibleDeVente(t);
  if (!cible)
    return { teste: false, raison: 'the pool is a Uniswap V4 id, not an address, and no market maker was seen in the transfers' };
  const data = SEL_TRANSFER + cible.adr.slice(2).toLowerCase().padStart(64, '0')
             + (1).toString(16).padStart(64, '0');
  let refus = 0, vus = 0, dernier = null;
  for (const qui of cob) {
    let r = null;
    try { r = await rpc('eth_call', [{ from: qui, to: t.addr, data }, 'latest']); }
    catch (e) {
      /* ---- DEUX ERREURS QUI N'ONT RIEN A VOIR ----
       * Une revocation EST la reponse du contrat : il a refuse, et c'est
       * exactement ce qu'on cherchait a savoir. Une panne du noeud ne dit
       * rien du tout.
       *
       * On listait d'abord les pannes et on comptait tout le reste comme un
       * refus. C'etait le mauvais sens : la liste des pannes possibles est
       * ouverte — delai depasse, quota, passerelle — et chacune de celles
       * qu'on n'avait pas prevues condamnait un jeton innocent, en le
       * PRESENTANT comme une trouvaille de securite. On reconnait donc
       * maintenant ce qui est reconnaissable : une revocation de la machine
       * virtuelle a un vocabulaire fixe. Tout le reste est une panne, donc
       * une absence de reponse, donc rien. */
      const m = String(e.message || '');
      if (!EVM_REFUSE.test(m)) { dernier = m; continue; }
      vus++; refus++; dernier = m.slice(0, 60);
      continue;
    }
    vus++;
    /* Un `transfer` qui rend `false` refuse sans se plaindre. */
    if (/^0x0*$/.test(String(r || ''))) { refus++; dernier = 'le transfert rend false'; }
    await dors(150);
  }
  if (!vus) return { teste: false, via: cible.via,
                     raison: 'the node did not answer (' + (dernier || '?') + ')' };
  return { teste: true, essais: vus, refus, passe: refus < vus, via: cible.via,
           raison: refus < vus ? null : (dernier || 'every transfer to the ' + cible.via + ' is refused') };
}

function vetoCobaye(t) {
  const e = t.epreuve;
  if (!e || !e.teste) return null;        /* non testable n'est pas coupable */
  if (e.passe) return null;
  return 'the exit is blocked: ' + e.refus + '/' + e.essais
       + ' holders cannot send the token to the ' + (e.via || 'pool');
}

/* --------------------------------------------------------- les positions */
const TENUES = [5, 10, 20, 40, 80, 160];
function trancheTenue(min) {
  let b = TENUES[0];
  for (const t of TENUES) if (min >= t) b = t;
  return b + ' min';
}
function tenueApprise() {
  const cases = ((E.memoire.closer || {}).tenue) || {};
  let best = null;
  for (const v in cases) {
    const c = cases[v];
    if (c.n < 3) continue;
    const note = confiance(c.n) * (c.s / c.n);
    if (!best || note > best.note) best = { v, note, moy: c.s / c.n, n: c.n };
  }
  if (!best) return { min: TENUE_DEFAUT_MIN, appris: false };
  return { min: parseInt(best.v, 10) || TENUE_DEFAUT_MIN, appris: true,
           moy: Math.round(best.moy * 10) / 10, n: best.n };
}

function compte(k, n) { E.compteurs[k] = (E.compteurs[k] || 0) + (n || 1); }

/* ---- DEUX AGENTS OUVRENT ----
 * Le Closer dit oui et tient la duree qu'il a apprise ; le Banquier dit
 * combien, et sa raison part avec la position. Elle voyagera jusqu'a la
 * fermeture : c'est elle qui permettra de savoir quelle methode a paye. */
function ouvre(t) {
  if (E.positions.length >= POSITIONS_MAX) return false;
  if (E.positions.some((p) => p.adr === t.addr)) return false;   /* une seule par jeton */
  const b = miseDe(t.an.score);
  if (!(b.mise > 0)) {
    compte('banquierRefus');
    E.banque.arret = b.raison;
    return false;
  }
  E.banque.arret = null;
  /* ---- LA DUREE VIENT DU JETON, PAS D'UNE CONSTANTE ----
   * Les courbes par trait disent quand ce GENRE de jeton rend le plus. Quand
   * elles ont assez d'observations, elles decident ; sinon la tenue apprise
   * par le Closer reprend la main, comme avant. */
  const horizon = horizonPour(t.an && t.an.traits);
  const tenue = horizon ? { min: horizon.min, appris: true, parProfil: true, poids: horizon.poids }
                        : tenueApprise();
  E.positions.push({
    sym: t.sym, adr: t.addr, pool: t.pool, prix0: t.prix, t0: Date.now(),
    /* Le delai d'abandon compte depuis la DERNIERE fois qu'on a su lire un
       prix, pas depuis l'ouverture : une position tenue trois heures et cotee
       a chaque tour n'a rien d'une position perdue de vue. A l'ouverture on
       vient justement d'en lire un — c'est `prix0`. */
    prixLu: Date.now(),
    mise: b.mise, methode: b.methode, regime: b.regime, raisonMise: b.raison,
    liq0: t.liq || 0, tenueBase: tenue.min,
    tenueRaison: tenue.parProfil
      ? 'its trait curves peak at ' + tenue.min + ' min (weight ' + tenue.poids + ')'
      : (tenue.appris ? 'duration learned by the Closer' : 'default duration'),
    mcAchat: Math.round(t.mc || 0), liens: (t.dex && t.dex.vu) ? (t.dex.liens || []) : null,
    dexVu: !!(t.dex && t.dex.vu),
    /* Le logo est GARDE avec la position, pas relu a l'affichage : elle vit
       des heures apres la lecture qui l'a donne, et le flux des pools ne sert
       que du neuf — le jeton en sort bien avant qu'elle se ferme. */
    logo: t.logo || (t.dex && t.dex.logo) || null,
    traits: t.an.traits, score: t.an.score, mc: t.mc, minutes: Math.round(t.minutes || 0),
    origine: t.origine || 'pools', tenueMin: tenue.min, traj: [],
  });
  E.ouvertures++;
  compte('closer');
  compte('banquier');
  E.flux.unshift({ sym: t.sym, pool: t.pool, tag: 'open',
                   txt: 'OPENED · $' + b.mise.toFixed(2) + ' · ' + b.methode, cls: 'n', t: Date.now() });
  signal({ k: 'achat', sym: t.sym, adr: t.addr, pool: t.pool, prix: t.prix,
           score: t.an.score, mise: b.mise, mc: t.mc || 0,
           logo: t.logo || (t.dex && t.dex.logo) || null,
           liens: (t.dex && t.dex.vu) ? (t.dex.liens || []) : null });
  return true;
}

/* ==========================================================================
 * LES SIGNAUX : CE QUE LA COLONIE VIENT DE FAIRE, DIT AILLEURS
 *
 * « Les signaux du bot d'achat et vente doivent s'afficher dans le Telegram
 *   et dans le wallet. On voit les cryptos que la colonie a tradees mais on
 *   n'est pas oblige d'acheter — on voit les signaux et on peut acheter en
 *   direct facilement. »
 *
 * Deux precautions, et elles disent ce que ce fil EST :
 *
 *   — c'est un JOURNAL, pas un conseil. La colonie joue du papier : elle
 *     n'engage pas d'argent et ne peut donc pas se tromper a la place de
 *     quelqu'un. Le mot « signal » laisse croire l'inverse, alors chaque
 *     entree porte ce qu'elle est : ce que la colonie a fait, quand, a quel
 *     prix, avec sa note. Ce que le lecteur en fait le regarde.
 *
 *   — un envoi Telegram qui echoue ne doit RIEN casser. Il est enveloppe et
 *     oublie : la colonie continue de trader si le canal tombe. L'inverse —
 *     un tour interrompu parce qu'un message n'est pas parti — serait laisser
 *     une messagerie decider de la strategie.
 * ======================================================================== */
const SIGNAUX_MAX = 120;
let tg = null;
try { tg = require('./telegram.js'); } catch (e) { tg = null; }

function signal(s) {
  if (!Array.isArray(E.signaux)) E.signaux = [];
  s.t = Date.now();
  E.signaux.unshift(s);
  if (E.signaux.length > SIGNAUX_MAX) E.signaux = E.signaux.slice(0, SIGNAUX_MAX);
  /* ---- TELEGRAM : LA MEME PASTILLE QUE DANS LE PORTEFEUILLE ----
   * Avec le logo quand on l'a, en texte quand on ne l'a pas — et `notifyPhoto`
   * retombe TOUT SEUL sur le texte si Telegram refuse l'image. C'est ce qui
   * permet de tenter la photo sans risquer le signal : une image morte ne doit
   * jamais faire disparaitre l'annonce qu'elle accompagnait.
   * Sans jamais attendre ni jeter : le canal n'est pas une dependance de la
   * colonie, et un jeton achete pendant que Telegram est en panne reste
   * achete. */
  try {
    if (tg && tg.enabled && tg.enabled()) {
      const txt = texteSignal(s);
      const p = (s.logo && tg.notifyPhoto) ? tg.notifyPhoto(s.logo, txt)
              : (tg.notify ? tg.notify(txt) : null);
      if (p && p.catch) p.catch(() => {});
    }
  } catch (e) { /* le canal n'est pas une dependance de la colonie */ }
}

/* ---- OU MENE LE SIGNAL ----
 * La page d'une PAIRE n'existe que si on connait son pool ; sans lui, un
 * « token not found » au bout d'un lien qu'on a propose soi-meme est pire
 * qu'une absence de lien. La recherche par contrat, elle, existe toujours.
 * On prend donc la paire quand on l'a, la recherche sinon. */
function lienDex(s) {
  if (s.pool && /^[0-9a-zA-Z]{20,60}$/.test(String(s.pool)))
    return 'https://dexscreener.com/robinhood/' + encodeURIComponent(s.pool);
  if (/^0x[0-9a-fA-F]{40}$/.test(String(s.adr || '')))
    return 'https://dexscreener.com/search?q=' + encodeURIComponent(s.adr);
  return null;
}

/* ---- CE QUI VIENT D'UN JETON NE PART PAS TEL QUEL EN HTML ----
 * Le message est envoye en `parse_mode: HTML`, et son symbole comme son
 * commentaire viennent de metadonnees que n'importe qui peut ecrire. Un jeton
 * nomme « A<B » suffisait a faire refuser le message entier par Telegram —
 * signal perdu, sans une ligne pour le dire — et un nom bien choisi pouvait y
 * poser sa propre balise. Depuis qu'on y met un vrai lien, c'est le lien
 * qu'il pourrait remplacer. */
function echHtml(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Le texte est ecrit ICI et pas dans la page : le meme mot doit partir dans
   Telegram et s'afficher dans le portefeuille, sinon deux lecteurs comparent
   deux phrases differentes du meme evenement. */
function texteSignal(s) {
  const d = (x) => (x > 0 ? '+' : '') + (Math.round(x * 10) / 10) + '%';
  const url = lienDex(s);
  /* Le lien porte le symbole du jeton, pas « ici » : on doit savoir ou l'on
     va avant de toucher, surtout depuis un telephone. */
  const vers = url ? '\n<a href="' + echHtml(url) + '">$' + echHtml(s.sym)
                   + ' on DexScreener \u2197</a>' : '';
  if (s.k === 'achat') {
    return '\ud83d\udfe2 SWOGE AI \u00b7 BUY (paper)\n'
      + '$' + echHtml(s.sym) + '\n'
      + 'Score ' + echHtml(s.score) + '/100 \u00b7 stake $' + Number(s.mise).toFixed(2) + '\n'
      + (s.mc ? 'Market cap $' + Math.round(s.mc).toLocaleString('en-US') + '\n' : '')
      + echHtml(s.adr) + '\n'
      + 'The colony trades paper. This is not advice.' + vers;
  }
  return '\ud83d\udd34 SWOGE AI \u00b7 SELL (paper)\n'
    + '$' + echHtml(s.sym) + ' \u00b7 ' + (isFinite(s.r) && s.r !== null ? d(s.r) : 'no result') + '\n'
    + (s.comment ? echHtml(s.comment) + '\n' : '')
    + echHtml(s.adr) + '\n'
    + 'The colony trades paper. This is not advice.' + vers;
}

/* ---- CE QU'UN PRIX ABERRANT A FAIT ----
 * « Il y a un bug, il a surement achete un honeypot, le solde est a 256
 *   millions. »
 * Ce n'etait pas un achat : c'etait une DIVISION. Le rendement se calcule en
 * (prix - prix0) / prix0. Quand un jeton minuscule voit son prix relu par une
 * autre source, avec d'autres decimales ou depuis un pool vide, le rapport
 * part a un million pour cent — et la mise de trente dollars devenait trois
 * cents millions de dollars de papier. Rien de tout ca n'est arrive sur un
 * marche : aucun pool de quatre mille dollars ne paie ca.
 *
 * Au-dela de ces bornes, on ne comptabilise RIEN. On ne borne pas le gain non
 * plus — borner, ce serait choisir un chiffre et le presenter comme un
 * resultat. On rend la mise, on ferme, et on ECRIT que le prix etait
 * inexploitable. Un resultat qu'on ne peut pas reproduire ne vaut rien, et il
 * empoisonne en plus tout ce que les agents apprennent de cette position. */
const REND_MAX = 900;    /* +900 % : un vrai dix-fois, ca existe */
const REND_MIN = -99;    /* -99 % : en dessous, c'est un pool vide, pas un cours */

/* ==========================================================================
 * SORTIR PAR MORCEAUX, ET LAISSER COURIR LE RESTE
 *
 * « Regarde comment fonctionnait ce bot pour les call, il fonctionnait bien. »
 *
 * Ce que ce robot fait et que nous ne faisions pas : il ne sort pas d'un bloc.
 * Il vend un tiers a +15 %, un tiers a +40 %, un cinquieme a +80 %, et garde
 * une part pour le cas ou ca continue. En dessous, un ARRET SUIVEUR : une fois
 * la position montee de 10 %, il ferme des qu'elle redescend de 20 points sous
 * son plus haut — et de 10 points seulement une fois passe +40 %, parce que
 * plus haut on monte, plus la redescente coute.
 *
 * Notre sortie etait tout ou rien : la Sentinelle prenait le gain entier ou
 * ne prenait rien. Sur des jetons dont un sur dix fait le resultat du mois,
 * c'est le pire des deux mondes — on coupe le seul qui payait, ou on rend
 * tout ce qu'il avait donne.
 *
 * Ce qui est comptabilise reste vrai : une vente partielle n'est pas un trade
 * ferme. Elle encaisse sa part, et le rendement dont les agents apprennent a
 * la fin est la MOYENNE PONDEREE de ce qui a ete realise — pas le dernier
 * prix, qui ne porte plus que le reliquat.
 *
 * Un arret de perte n'est PAS repris : le releve de ce robot le donne a 0 %
 * de reussite dans ses propres donnees, et il le laisse eteint par defaut.
 * La coupe de la Sentinelle, elle, reste — elle ne porte pas sur un prix mais
 * sur l'etat de la piscine.
 * ======================================================================== */
function echelle() {
  return {
    actif: process.env.SORTIE_ECHELLE !== '0',
    p1: nEnv('DCA1_PCT', 15), v1: nEnv('DCA1_VEND', 35),
    p2: nEnv('DCA2_PCT', 40), v2: nEnv('DCA2_VEND', 35),
    p3: nEnv('DCA3_PCT', 80), v3: nEnv('DCA3_VEND', 20),
    suivDepart: nEnv('SUIV_DEPART', 10),
    suivEcart: nEnv('SUIV_ECART', 20),
    suivSerre: nEnv('SUIV_SERRE', 10),
    suivSerreA: nEnv('SUIV_SERRE_A', 40),
  };
}

/* Une tranche vendue : elle encaisse sa part et laisse le reste courir. */
function vendUneTranche(p, r, part, quand, pourquoi) {
  const f = Math.min(part, p.reste === undefined ? 1 : p.reste);
  if (!(f > 0.001)) return false;
  const pnl = p.mise * f * r / 100;
  E.tresor += pnl;
  p.reste = (p.reste === undefined ? 1 : p.reste) - f;
  p.rRealise = (p.rRealise || 0) + f * r;
  p.encaisse = (p.encaisse || 0) + pnl;
  E.flux.unshift({ sym: p.sym, pool: p.pool, tag: pnl >= 0 ? 'buy' : 'cut',
    txt: Math.round(f * 100) + '% vendu a ' + (r >= 0 ? '+' : '') + r.toFixed(1) + '%'
       + '  ·  ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + '  ·  ' + pourquoi,
    cls: pnl >= 0 ? 'up' : 'dn', t: quand, par: 'sentinelle' });
  compte('tranchesVendues');
  E.courbe.push(Math.round(E.tresor * 100) / 100);
  return true;
}

/* Les paliers atteints ce tour-ci, dans l'ordre. Rend `true` s'il ne reste
   plus rien a tenir. */
function joueEchelle(p, r, quand) {
  const E2 = echelle();
  if (!E2.actif) return false;
  if (p.reste === undefined) p.reste = 1;
  if (!p.paliers) p.paliers = {};
  const niveaux = [{ k: '1', a: E2.p1, v: E2.v1 }, { k: '2', a: E2.p2, v: E2.v2 },
                   { k: '3', a: E2.p3, v: E2.v3 }];
  for (const n of niveaux) {
    if (p.paliers[n.k] || !(n.a > 0) || r < n.a) continue;
    p.paliers[n.k] = true;
    vendUneTranche(p, r, n.v / 100, quand, 'palier +' + n.a + '%');
  }
  return p.reste <= 0.001;
}

/* L'arret suiveur : il ne dit pas quand vendre, il dit quand ARRETER DE
   TENIR. C'est la difference entre rendre un gain et le garder. */
function arretSuiveur(p, r) {
  const E2 = echelle();
  if (!E2.actif) return null;
  if (p.hautR === undefined || r > p.hautR) p.hautR = r;
  if (!(p.hautR >= E2.suivDepart)) return null;      /* pas encore arme */
  const ecart = p.hautR >= E2.suivSerreA ? E2.suivSerre : E2.suivEcart;
  if (r > p.hautR - ecart) return null;
  return 'trailing stop: fallen ' + (p.hautR - r).toFixed(1)
       + ' points below its peak (+' + p.hautR.toFixed(1) + '%)';
}

function ferme(p, prix, quand, comment) {
  let r = (prix - p.prix0) / p.prix0 * 100;
  let aberrant = null;
  if (!isFinite(r) || r > REND_MAX || r < REND_MIN) {
    aberrant = (isFinite(r) ? (r > 0 ? '+' : '') + Math.round(r) + '%' : 'non calculable')
             + ' entre ' + p.prix0 + ' et ' + prix;
    r = 0;   /* la mise est rendue : on ne gagne ni ne perd sur une lecture qu'on rejette */
  }
  /* ---- CE QUI RESTE, ET CE QUI A DEJA ETE PRIS ----
   * Le dernier prix ne vaut plus que pour le reliquat. Le rendement dont tout
   * le monde apprend est la moyenne ponderee des tranches realisees : sans
   * cela, une position sortie a +80 % puis fermee a +5 % enseignerait +5 %. */
  const reste = p.reste === undefined ? 1 : p.reste;
  const pnl = p.mise * reste * r / 100;
  E.tresor += pnl;
  E.trades++;
  const rTotal = aberrant ? 0 : (p.rRealise || 0) + reste * r;
  const gainTotal = (p.encaisse || 0) + pnl;
  if (gainTotal > 0) E.gains++;
  if (!aberrant) r = rTotal;
  const mult = 1 + r / 100;
  if (mult > E.meilleur) { E.meilleur = mult; E.meilleurSym = p.sym; }
  /* ---- ET C'EST ICI QUE TOUS APPRENNENT ----
   * Sur le rendement REEL. Une lecon tiree d'un resultat invente serait pire
   * qu'aucune lecon : elle se propagerait a tous les jetons qui partagent le
   * trait. Les specialistes nes hier apprennent au meme titre que les agents
   * du depart — c'est la liste du roster qui decide, pas une liste ecrite en
   * dur quelque part. */
  /* Et personne n'apprend d'une lecture rejetee : une lecon tiree d'un chiffre
     faux se propage a tous les jetons qui partagent le trait. */
  if (!aberrant) for (const k of apprenants()) if (p.traits && p.traits[k]) apprendAgent(k, p.traits[k], r);
  /* Le fond apprend une fois par jeton, pas une fois par agent. */
  if (!aberrant) apprendBase(r);
  /* Ce qu'est devenue cette position, pour la part d'abandons : suivie
     jusqu'au bout, ou perdue de vue. Voir `partAbandons`. */
  noteSuivi(aberrant ? 1 : 0);
  /* Le Closer apprend une DUREE — depuis la trajectoire reelle de la position,
     c'est-a-dire les prix qu'on a vraiment releves pendant qu'elle etait
     ouverte. */
  const vus = {};
  if (aberrant) { E.flux.unshift({ sym: p.sym, pool: p.pool, tag: 'cut',
      txt: 'unusable price (' + aberrant + ') · stake returned, nothing counted',
      cls: 'n', t: quand, tenue: quand - p.t0 });
    compte('prixAberrant');
    E.courbe.push(Math.round(E.tresor * 100) / 100);
    /* ---- UNE FERMETURE SANS RESULTAT EST QUAND MEME UNE FERMETURE ----
     * « Dans le wallet il y a pas mal de signaux dont on ne sait pas quand
     *   ils ont ete fermes : "bought 13 hours" et rien d'autre. »
     * Ici comme dans `abandonneLesPerdues`, la position se fermait SANS signal
     * de vente : le portefeuille gardait un « bought » orphelin pour toujours,
     * et rien ne disait que la colonie avait rendu la mise. Le signal part
     * donc, avec un rendement NUL — pas zero, nul : « pas de resultat » est la
     * verite, et zero serait un chiffre invente. */
    signal({ k: 'vente', sym: p.sym, adr: p.adr, pool: p.pool, prix: prix, r: null, gain: 0,
             logo: p.logo || null,
             comment: 'Closed without a result: unusable re-read price (' + aberrant + '), stake returned' });
    noteVendu(p.adr, quand);
    return; }
  for (const pt of (p.traj || [])) {
    const cle = trancheTenue(pt.dt / 60000);
    if (vus[cle]) continue;
    vus[cle] = 1;
    apprendAgent('closer', { tenue: cle }, pt.r);
  }
  const fin = trancheTenue((quand - p.t0) / 60000);
  if (!vus[fin]) apprendAgent('closer', { tenue: fin }, r);
  /* Et le Banquier apprend sa methode, en POURCENTAGE : compter en dollars
     ferait toujours gagner celle qui mise le plus, quel que soit son merite. */
  banquierApprend(p, r);
  noteResultat(r);

  /* ---- LA SENTINELLE APPREND DE SES ALERTES ----
   * Pas du resultat global : de ce que valait CHAQUE etat qu'elle a vu. « Quand
   * j'ai vu la piscine divisee par deux, la position a fini a -40 %, onze
   * fois. » C'est ce qui justifie la coupe, ou la condamne. */
  if (p.vuPar) apprendAgent('sentinelle', p.vuPar, r);
  /* ---- ET LE PROMOTEUR DE SES PROLONGATIONS ----
   * Sur la DIFFERENCE entre ce que la position valait quand il a decide de la
   * garder et ce qu'elle a fini par rendre. Prolonger un gagnant qui redescend
   * est une faute, meme si la position finit positive — et c'est exactement ce
   * qu'un apprentissage sur le resultat final ne verrait jamais. */
  if (p.casProlonge && p.rDecision !== undefined)
    apprendAgent('promoteur', p.casProlonge, r - p.rDecision);

  const par = comment && comment.par;
  const suffixe = (par === 'sentinelle' ? '  ·  cut: ' + comment.raison
                : (p.prolonge ? '  ·  extended ' + p.prolonge + '×' : ''))
    /* Ce qui avait deja ete pris en route : sans ca, une position sortie par
       morceaux affiche le seul reliquat et se lit comme une petite affaire. */
    + (reste < 0.999 ? '  ·  ' + Math.round((1 - reste) * 100) + '% already sold on the way' : '');
  E.flux.unshift({ sym: p.sym, pool: p.pool, tag: gainTotal >= 0 ? 'buy' : 'cut',
    txt: (gainTotal >= 0 ? '+' : '') + '$' + gainTotal.toFixed(2) + '  ·  '
       + (r >= 0 ? '+' : '') + r.toFixed(1) + '%' + suffixe,
    cls: gainTotal >= 0 ? 'up' : 'dn', t: quand, tenue: quand - p.t0, par: par || 'closer' });
  if (par === 'sentinelle') compte('sentinelleCoupe');
  /* Le signal de vente porte le rendement REEL de la position entiere, pas
     celui du dernier morceau : quelqu'un qui a suivi l'achat veut savoir ce
     que l'operation a donne, pas ce que valait le reliquat. */
  signal({ k: 'vente', sym: p.sym, adr: p.adr, pool: p.pool, prix: prix,
           r: r, gain: gainTotal, logo: p.logo || null,
           comment: par === 'sentinelle' ? 'Cut: ' + comment.raison
                  : (p.prolonge ? 'Extended ' + p.prolonge + '×' : 'Duration reached') });
  noteVendu(p.adr, quand);
  E.courbe.push(Math.round(E.tresor * 100) / 100);
}

/* ---- ON NE RACHETE PAS CE QU'ON VIENT DE VENDRE, PAS TOUT DE SUITE ----
 *
 * Releve sur le fil des signaux du serveur, en une heure : QGRID achete,
 * vendu a +19,8 % a l'echeance, RACHETE trois minutes plus tard, vendu a
 * -20,7 %, rachete encore. Trois entrees sur le meme jeton en soixante
 * minutes, et le gain du premier tour rendu au second.
 *
 * Rien ne l'empechait : « une seule position par jeton » ne vaut que tant
 * qu'elle est ouverte, et un jeton qu'on vient de vendre a exactement la
 * tete de ce qu'on achete — il a bouge, il est liquide, il est connu. Mais il
 * a aussi l'age ou le Closer vient de decider de sortir, et le racheter remet
 * le compte a rebours a zero sans rajeunir le jeton.
 *
 * Le repos est un refus du Scout, donc GRATUIT et donc AUDITE : le jeton
 * laisse une ombre comme les autres, et le panneau des refuses dira dans la
 * journee si ce repos coute ou protege. Reglable par l'environnement, a zero
 * il disparait. */
const REACHAT_REPOS_MIN = nEnv('REACHAT_REPOS_MIN', 60);
function noteVendu(adr, quand) {
  if (!adr) return;
  const c = E.connus[adr] || (E.connus[adr] = { sym: '', vu: 0, ne: quand || Date.now() });
  c.vendu = quand || Date.now();
}

/* `marche` porte un prix et, quand on l'a, la liquidite. Un nombre nu est
   accepte : c'est la forme d'avant la Sentinelle, et un etat relu d'hier ne
   doit pas cesser de se regler parce que le format a change. */
/* ---- UNE POSITION QU'ON NE SAIT PAS SUIVRE N'EST PAS UNE POSITION ----
 *
 * Releve sur la colonie apres treize heures : DIX positions ouvertes, toutes
 * a « prix non lu », huit d'entre elles depuis treize heures avec un prix
 * jamais relu une seule fois. Elles ne pouvaient plus se fermer — `regle` rend
 * `true` faute de prix, donc elles attendaient un prix qui n'arriverait
 * jamais. Elles tenaient dix places sur dix, immobilisaient la mise du
 * Banquier, et n'apprenaient rien a personne.
 *
 * Passe ce delai, on les ABANDONNE : la mise est rendue, rien n'est
 * comptabilise, et personne n'apprend — exactement comme pour un prix
 * inexploitable. Inventer un resultat a zero pour cloturer proprement serait
 * pire : ce zero entrerait dans la memoire des agents comme une observation,
 * alors qu'on n'a rien observe du tout.
 *
 * Le delai suit l'intention du trade — quatre fois la duree qu'on comptait
 * tenir — avec un plancher d'une heure, parce qu'en dessous on abandonnerait
 * des jetons que DexScreener n'a simplement pas encore indexes. */
const ABANDON_PLANCHER_MIN = 60;
function abandonDelai(p) {
  return Math.max(ABANDON_PLANCHER_MIN, (p.tenueMin || TENUE_DEFAUT_MIN) * 4) * 60000;
}

/* ---- ET CETTE PASSE-LA NE DEPEND D'AUCUN PRIX ----
 * C'est tout son objet : elle traite les positions dont on n'a JAMAIS pu en
 * lire un. La mettre dans `regle`, qui boucle sur les prix du tour, la rendait
 * muette exactement dans le cas ou elle sert — un tour sans flux (« aucun
 * jeton neuf assez liquide ») s'arrete avant, et les positions perdues de vue
 * l'auraient ete un tour de plus a chaque fois. */
function abandonneLesPerdues() {
  const now = Date.now();
  let n = 0;
  E.positions = E.positions.filter((p) => {
    if (now - (p.prixLu || p.t0) <= abandonDelai(p)) return true;
    E.flux.unshift({ sym: p.sym, pool: p.pool, tag: 'cut',
      txt: 'price never re-read in ' + Math.round((now - p.t0) / 60000)
         + ' min · stake returned, nothing counted',
      cls: 'n', t: now, tenue: now - p.t0, par: 'closer' });
    compte('abandonneeSansPrix');
    noteSuivi(1);
    /* Le portefeuille doit savoir que c'est fini : voir la note dans `ferme`
       sur les fermetures sans resultat. */
    signal({ k: 'vente', sym: p.sym, adr: p.adr, pool: p.pool, prix: null, r: null, gain: 0,
             logo: p.logo || null,
             comment: 'Closed without a result: price never re-read in '
                    + Math.round((now - p.t0) / 60000) + ' min, stake returned' });
    noteVendu(p.adr, now);
    n++;
    return false;
  });
  return n;
}

function regle(marche) {
  const now = Date.now();
  let n = 0;
  E.positions = E.positions.filter((p) => {
    const brut = marche[p.adr];
    const x0 = (typeof brut === 'number') ? { prix: brut, liq: 0 } : brut;
    if (!x0 || !(x0.prix > 0)) return true;      /* pas de prix : on attend */
    const x = x0;
    p.prixLu = now;
    const dt = now - p.t0;
    const r = (x.prix - p.prix0) / p.prix0 * 100;
    if (!p.traj) p.traj = [];
    if (p.traj.length < 40) p.traj.push({ dt, r: Math.round(r * 100) / 100 });

    /* ---- LA SENTINELLE, A CHAQUE PASSAGE ----
     * Elle note ce qu'elle voit — c'est de la qu'elle apprendra — et elle coupe
     * sans attendre le compte a rebours si le sol se derobe. */
    p.vuPar = casSentinelle(p, x);
    const danger = dangerSentinelle(p, x);
    if (danger) { ferme(p, x.prix, now, { par: 'sentinelle', raison: danger }); n++; return false; }

    /* ---- L'ECHELLE DE SORTIE, PUIS L'ARRET SUIVEUR ----
     * D'abord les paliers : ils encaissent une part et laissent le reste
     * courir. Ensuite l'arret suiveur, qui ferme ce qui reste quand le plus
     * haut est rendu. L'ordre compte : un palier atteint puis rendu dans le
     * meme tour doit avoir encaisse sa part avant qu'on ferme.
     *
     * ---- MAIS JAMAIS SUR UN PRIX QU'ON REFUSE ----
     * `ferme` rejette deja les lectures impossibles et rend la mise sans rien
     * compter. L'echelle, elle, encaissait AVANT d'y arriver : un prix a
     * +99 999 999 900 % lui faisait vendre 35 % de la mise a ce taux-la, et la
     * tresorerie passait a vingt-sept milliards. Le meme garde-fou doit donc
     * s'appliquer ici, et il doit etre le MEME — un seuil recopie finirait par
     * diverger de celui de `ferme`. */
    if (!isFinite(r) || r > REND_MAX || r < REND_MIN) {
      ferme(p, x.prix, now, { par: 'closer' });
      n++; return false;
    }
    if (joueEchelle(p, r, now)) {
      ferme(p, x.prix, now, { par: 'sentinelle', raison: 'last rung reached' });
      n++; return false;
    }
    const suiv = arretSuiveur(p, r);
    if (suiv) {
      ferme(p, x.prix, now, { par: 'sentinelle', raison: suiv });
      compte('arretSuiveur');
      n++; return false;
    }

    /* ---- ET ELLE PEUT AUSSI PRENDRE UN GAIN ----
     * Sans attendre la fin du compte a rebours. Ce qu'elle prend est note, et
     * on reviendra voir a l'echeance ce que garder aurait donne : c'est de
     * cette difference-la qu'elle apprend, pas du gain lui-meme. */
    const casG = veutPrendre(p, r);
    if (casG) {
      noteSuite(p, x.prix, r, casG, now);
      ferme(p, x.prix, now, { par: 'sentinelle',
        raison: 'gain taken at +' + r.toFixed(1) + '%, before the deadline' });
      compte('gainPris');
      n++;
      return false;
    }

    if (dt < (p.tenueMin || TENUE_DEFAUT_MIN) * 60000) return true;

    /* ---- LE PROMOTEUR, AU MOMENT OU CA DEVAIT FERMER ---- */
    const cas = veutProlonger(p, r);
    if (cas) {
      p.prolonge = (p.prolonge || 0) + 1;
      p.casProlonge = cas;
      if (p.rDecision === undefined) p.rDecision = r;
      p.tenueMin = (p.tenueMin || TENUE_DEFAUT_MIN) + (p.tenueBase || TENUE_DEFAUT_MIN);
      compte('promoteurProlonge');
      E.flux.unshift({ sym: p.sym, pool: p.pool, tag: 'open',
        txt: 'EXTENDED · ' + (r >= 0 ? '+' : '') + r.toFixed(1) + '% · ' + p.prolonge + 'x',
        cls: 'n', t: now, par: 'promoteur' });
      return true;
    }
    ferme(p, x.prix, now, { par: 'closer' });
    n++;
    return false;
  });
  return n;
}


/* ==========================================================================
 * LA COLONIE CHANGE DE STRATEGIE QUAND LA SIENNE NE PAIE PAS
 *
 * « S'ils voient qu'il y a trop de positions ouvertes ou trop de trades
 *   acceptés et que c'est pas bénéfique, ils peuvent changer leur stratégie.
 *   Ils sont maîtres du monde pour réussir à faire de l'argent. »
 *
 * Le seuil d'entree etait une constante : cinquante-cinq, pour toujours. Une
 * colonie qui accepte trop et perd n'avait aucun moyen de devenir plus
 * difficile — elle pouvait seulement continuer, en apprenant trait par trait,
 * ce qui est beaucoup trop lent quand le probleme est le seuil lui-meme.
 *
 * Il se deplace donc, sur ce qui a ete mesure, et jamais sur une impression :
 * il faut une douzaine de positions fermees depuis le dernier ajustement. Les
 * bornes existent parce qu'un seuil qui derive sans fin finit soit par tout
 * accepter, soit par ne plus jamais rien acheter — et dans les deux cas on
 * n'apprend plus rien.
 * ======================================================================== */
const SEUIL_MIN = 45, SEUIL_MAX = 85;
const FENETRE = 20;             /* les vingt dernieres positions fermees */
const AVANT_AJUSTEMENT = 12;    /* jamais moins, sinon on regle sur du bruit */

function seuilCourant() {
  const s = E.seuil;
  return (typeof s === 'number' && s >= SEUIL_MIN && s <= SEUIL_MAX) ? s : SEUIL;
}
function noteResultat(r) {
  if (!Array.isArray(E.derniers)) E.derniers = [];
  E.derniers.push(Math.round(r * 10) / 10);
  if (E.derniers.length > 60) E.derniers = E.derniers.slice(-60);
  E.depuisAjustement = (E.depuisAjustement || 0) + 1;
}
/* ==========================================================================
 * LE SEUIL MONTAIT ET NE POUVAIT PLUS REDESCENDRE
 *
 * « Il ne trade quasiment jamais depuis hier. »
 *
 * Le releve du serveur, au moment de la plainte :
 *
 *   seuil d'entree 70 (depart : 55) · 0 position ouverte sur 10 places
 *   vingt dernieres fermees : moyenne +88,5 % · 8 gagnantes sur 20
 *
 * Une strategie qui rend +88,5 % de moyenne s'etait interdit d'acheter. Trois
 * defauts se combinaient, et chacun seul aurait suffi.
 *
 * ---- 1. ON JUGEAIT LE COMPTE DES GAGNANTES, PAS L'ARGENT ----
 *
 * On DURCISSAIT si « moyenne < -1 % OU moins de 35 % de gagnantes », et on
 * n'ouvrait que si « moyenne > +3 % ET plus de 55 % de gagnantes ». Or cette
 * colonie coupe vite ses pertes et laisse courir de rares tres gros gains :
 * +656 %, +495 %, +309 % au milieu de beaucoup de petites pertes. C'est la
 * forme MEME de la strategie, pas un defaut — et le taux de gagnantes la
 * declare mauvaise en permanence. On juge donc sur la moyenne, qui est
 * l'argent. Le taux reste ecrit dans le message : il informe, il ne decide
 * plus.
 *
 * ---- 2. LES DEUX MOITIES N'ETAIENT PAS SYMETRIQUES ----
 *
 * Monter demandait UNE condition sur deux ; descendre en demandait DEUX sur
 * deux. Un seuil construit comme ca monte plus souvent qu'il ne descend, quoi
 * qu'il arrive. A +88,5 % de moyenne et 40 % de gagnantes, la colonie ne
 * pouvait ni durcir ni s'ouvrir : elle restait a 70, definitivement.
 *
 * ---- 3. ET LA REVUE NE TOURNAIT MEME PLUS ----
 *
 * Elle demande douze positions fermees DEPUIS le dernier reglage. Sans achat,
 * pas de fermeture ; sans fermeture, pas de revue ; sans revue, le seuil ne
 * bouge pas. Le verrou se refermait sur lui-meme, et aucune des deux
 * corrections ci-dessus n'aurait pu s'appliquer.
 *
 * D'ou le desserrage, qui passe AVANT la porte des douze fermetures : quand
 * la colonie n'a rien achete depuis longtemps et qu'il lui reste des places,
 * le seuil baisse d'un cran. Il ne peut pas s'emballer — il s'arrete a
 * SEUIL_MIN, et le compteur ne repart qu'apres un nouveau silence aussi long.
 * Une colonie qui ne remplit aucune de ses dix places n'est pas selective,
 * elle est a l'arret ; et a l'arret elle ne recolte aucune mesure, donc elle
 * ne peut plus jamais rien apprendre qui la debloque.
 * ======================================================================== */
const SANS_ACHAT_DESSERRE = 40;   /* ~1 h 40 de silence, a 2,4 min par tour */

/* ---- EST-CE QU'ON LIT, EN CE MOMENT ? ----
 * La part des lectures de chaine qui echouent, sur les noeuds encore en
 * service. C'est le meme calcul que celui de l'alerte — il est ici pour que
 * la STRATEGIE puisse le consulter, et pas seulement l'ecran. */
function partRefus() {
  const l = Object.keys(E.services || {})
    .filter((k) => /^chaine/.test(k) && !noeudMort({ cle: k }))
    .map((k) => E.services[k]);
  const total = l.reduce((a, x) => a + (x.essais || 0), 0);
  if (total < 30) return 0;                       /* trop peu pour conclure */
  const echecs = l.reduce((a, x) => a + ((x.essais || 0) - (x.reussites || 0)), 0);
  return echecs / total;
}
/* Au-dessus, une note basse ne dit plus grand-chose du jeton. */
const REFUS_AVEUGLE = nEnv('REFUS_AVEUGLE_PART', 0.5);

function revoitStrategie() {
  const avant = seuilCourant();

  /* ---- LE VERROU, D'ABORD ---- */
  const sansAchat = E.toursSansAchat || 0;
  const depuisDesserre = sansAchat - (E.desserreDernier || 0);
  if (sansAchat >= SANS_ACHAT_DESSERRE && depuisDesserre >= SANS_ACHAT_DESSERRE
      && E.positions.length < POSITIONS_MAX && avant > SEUIL_MIN) {
    /* Zero position ouverte est un signal plus fort que « il reste des
       places » : la colonie n'est pas en train de completer un portefeuille,
       elle est totalement a l'arret. Le cran est plus large. */
    const cran = E.positions.length === 0 ? 5 : 3;
    const apres = Math.max(SEUIL_MIN, avant - cran);
    E.desserreDernier = sansAchat;
    E.seuil = apres;
    journal('strategie', 'Entry threshold ' + avant + ' → ' + apres + '. Nothing bought for '
      + sansAchat + ' turns with ' + (POSITIONS_MAX - E.positions.length) + ' slots free: '
      + 'stopped, the colony gathers no measurement, so nothing can unblock it.',
      [{ toursSansAchat: sansAchat, places: POSITIONS_MAX - E.positions.length }]);
    return true;
  }

  if ((E.depuisAjustement || 0) < AVANT_AJUSTEMENT) return false;
  const l = (E.derniers || []).slice(-FENETRE);
  if (l.length < AVANT_AJUSTEMENT) return false;
  const moy = l.reduce((a, b) => a + b, 0) / l.length;
  const gagnantes = l.filter((x) => x > 0).length;
  const taux = gagnantes / l.length;
  let apres = avant, pourquoi = null;

  /* Une seule mesure decide, dans les deux sens : ce que les positions ont
     RAPPORTE. Les deux bornes sont volontairement ecartees (-1 % et +3 %) pour
     laisser une zone morte au milieu — sans elle, le seuil oscillerait sur du
     bruit a chaque fermeture. */
  if (moy < -1) {
    /* ---- ON NE MONTE PAS LA BARRE PENDANT QU'ON EST AVEUGLE ----
     * Releve sur la colonie : 85 % des lectures de chaine refusees, GoPlus
     * muet 3 393 fois sur 3 516 — et le seuil monte de 55 a 65 en deux crans,
     * parce que les positions rendaient mal.
     *
     * Elles rendaient mal EN PARTIE pour cette raison-la. Quand les porteurs,
     * la concentration et le contrat reviennent « inconnu », la note tombe
     * sans que le jeton y soit pour quelque chose ; on achete alors les
     * mauvais, et on ferme en perte. Durcir la-dessus, c'est prendre le
     * symptome de sa propre cecite pour un jugement sur le marche — et le
     * graver : plus rien ne passe, donc plus rien ne se ferme, donc la fenetre
     * ne se renouvelle plus et le seuil reste haut.
     *
     * On ne desserre pas pour autant : ce serait acheter plus en y voyant
     * moins. On ne fait rien, et on le DIT, ce qui est la seule facon que
     * quelqu'un aille reparer la lecture plutot que le seuil. */
    const aveugle = partRefus();
    if (aveugle >= REFUS_AVEUGLE) {
      E.depuisAjustement = 0;
      journal('strategie', 'Entry threshold left at ' + avant + '. The last ' + l.length
        + ' positions return ' + moy.toFixed(1) + '% on average, which would normally tighten it '
        + '— but ' + Math.round(aveugle * 100) + '% of chain reads are being refused right now. '
        + 'Those returns are partly the mark of what we could not read, not of the tokens: '
        + 'hardening on them would make the blindness permanent.',
        [{ moyenne: moy.toFixed(1) + '%', refusChaine: Math.round(aveugle * 100) + '%' }]);
      return false;
    }
    apres = Math.min(SEUIL_MAX, avant + 5);
    pourquoi = 'the last ' + l.length + ' positions return ' + moy.toFixed(1)
             + '% on average (' + Math.round(taux * 100) + '% winners): tightening up';
  } else if (moy > 3 && E.positions.length < POSITIONS_MAX) {
    apres = Math.max(SEUIL_MIN, avant - 3);
    pourquoi = 'the last ' + l.length + ' return +' + moy.toFixed(1)
             + '% (' + Math.round(taux * 100) + '% winners) and slots are free: opening up';
  }
  E.depuisAjustement = 0;
  if (apres === avant || !pourquoi) return false;
  E.seuil = apres;
  journal('strategie', 'Entry threshold ' + avant + ' → ' + apres + '. ' + pourquoi,
    [{ fenetre: l.length, moyenne: moy.toFixed(1) + '%', gagnantes: Math.round(taux * 100) + '%',
       positions: E.positions.length }]);
  return true;
}

/* ==========================================================================
 * CE DONT LA COLONIE A BESOIN, EN TOUTES LETTRES
 *
 * « Doit aussi être intelligent et me donner des alertes s'ils ont besoin de
 *   choses supplémentaires pour être plus performants. »
 *
 * Chaque alerte est calculee sur un RELEVE, jamais sur une impression, et
 * porte le chiffre qui la justifie. Une demande sans son chiffre est une
 * demande qu'on ne peut pas refuser intelligemment.
 * ======================================================================== */
function alertes() {
  const out = [];
  const s = (k) => E.services[k] || { essais: 0, reussites: 0 };
  const dis = (gravite, quoi, pourquoi, quoiFaire) => out.push({ gravite, quoi, pourquoi, quoiFaire });

  /* ==========================================================================
   * QUEL NOEUD REFUSE, ET POURQUOI
   *
   * Cette alerte additionnait les echecs des trois noeuds et devinait ensuite
   * la cause — « si les refus persistent malgre la cle, c'est le forfait ». Or
   * un refus sur le noeud A et un refus sur le noeud B n'ont ni la meme cause
   * ni le meme remede, et un total de 36 % ne dit rien de ce qu'il faut faire.
   *
   * Un cas en particulier se cachait derriere ce total : quand le noeud a cle
   * echoue A CHAQUE FOIS, chaque lecture le paie puis retombe sur les noeuds
   * publics. Le total affiche alors un tiers de refus — exactement ce qu'on
   * verrait avec un forfait atteint — alors que la cle ne fonctionne pas du
   * tout, et que le message envoie chercher au mauvais endroit.
   *
   * On regarde donc chaque noeud separement, et on reprend la raison que le
   * service a donnee. « Your token is invalid or expired » et un refus pour
   * saturation ne se soignent pas pareil.
   * ======================================================================== */
  const noeudsVus = [
    { cle: 'chaineCle', nom: 'the keyed node (dRPC)', s: s('chaineCle') },
    { cle: 'chaine', nom: 'the official node', s: s('chaine') },
    { cle: 'chaine2', nom: 'the ' + SECOURS_NOM, s: s('chaine2') },
  ].filter((x) => x.s.essais > 0);

  /* ---- CE QUI EST ENCORE APPELE, ET CE QUI NE L'EST PLUS ----
   *
   * Un noeud sorti de la rotation garde ses chiffres tels quels : plus
   * personne ne l'appelle, donc plus rien ne s'ajoute et sa proportion reste
   * figee a 100 % pour toujours. L'alerte annoncait ainsi « les noeuds
   * refusent 81 % des lectures » alors que 77 % de ce total etait l'histoire
   * gelee de deux services deja mis de cote — et que les lectures reellement
   * tentees passaient a 83 %.
   *
   * Un chiffre exact peut mentir sur ce qu'il faut faire. On separe donc, et
   * le pourcentage annonce est celui des noeuds encore en service : c'est le
   * seul qui reponde a « est-ce que mes lectures aboutissent en ce moment ». */
  const enService = noeudsVus.filter((x) => !noeudMort({ cle: x.cle }));
  const misDeCote = noeudsVus.filter((x) => noeudMort({ cle: x.cle }));
  const compte = enService.length ? enService : noeudsVus;
  const echecs = compte.reduce((a, x) => a + (x.s.essais - x.s.reussites), 0);
  const total = compte.reduce((a, x) => a + x.s.essais, 0);
  if (total > 30 && echecs / total > 0.25) {
    const ligne = (x) => {
      const e = x.s.essais - x.s.reussites;
      return x.nom + ': ' + e + '/' + x.s.essais + ' refused'
        + (e ? ' (' + Math.round(e / x.s.essais * 100) + '%, last: ' + (x.s.dernierEchec || '?') + ')' : '');
    };
    let detail = compte.map(ligne).join(' · ');
    if (misDeCote.length) {
      detail += ' — out of rotation, no longer called: ' + misDeCote.map(ligne).join(' · ')
        + ' (frozen figures: these refusals date from before it was set aside, they no longer '
        + 'happen, and an hourly check watches for it coming back)';
    }

    const kc = s('chaineCle');
    let remede;
    if (process.env.DRPC_API_KEY && kc.essais > 5 && kc.reussites === 0) {
      /* Le cas qui se cachait derriere le total. */
      /* ---- ET CE QUE LE CODE A DEJA FAIT SE DIT ----
       * Sans cette phrase, l'alerte envoyait verifier une cle sur drpc.org
       * pour un noeud que la colonie avait deja mis de cote, methode par
       * methode. Une alerte qui ne dit pas ce qui est deja regle fait refaire
       * le travail — ou pire, fait changer une cle qui n'y est pour rien. */
      const mus = Object.keys((noeuds()[0] && noeuds()[0].sansMethode) || {});
      const pub = s('chaine2');
      /* ---- LA CLE OU LE SERVICE ? LE NOEUD PUBLIC TRANCHE ----
       * On envoyait verifier la cle sur drpc.org. Mais dRPC a AUSSI un noeud
       * public, sans cle, dans cette meme liste : s'il echoue autant, ce n'est
       * pas la cle, c'est que dRPC ne sert pas cette chaine. Le releve
       * repondait deja a la question, il suffisait de la lui poser. Envoyer
       * quelqu'un renouveler une cle innocente coute une soiree et ne repare
       * rien. */
      const memeSansCle = pub.essais >= NOEUD_MORT_ESSAIS && pub.reussites === 0;
      remede = 'THE KEYED NODE FAILS EVERY SINGLE TIME (' + kc.essais + ' calls, 0 successes, '
        + 'last refusal: « ' + (kc.dernierEchec || '?') + ' »). So this is not a quota being hit.'
        + (memeSansCle
            ? ' And the PUBLIC dRPC node fails in exactly the same way (' + pub.essais + ' calls, '
              + '0 successes, « ' + (pub.dernierEchec || '?') + ' ») — and that one uses no key at '
              + 'all. So it is not the key: dRPC does not serve chain 4663, with or without one. '
              + 'Renewing the key would change nothing. What is needed is ANOTHER RPC provider for '
              + 'this chain — or none, and then the official node stands alone, which is exactly '
              + 'what makes the call budget run out.'
            : ' The key is not accepted at all. Check on drpc.org that the key still exists and '
              + 'that the « robinhood » network is among those it covers.')
        + (mus.length
            ? ' What is already handled, with nothing to touch: the colony has learned it does '
              + 'not serve ' + mus.join(', ') + ', and no longer counts it in the rotation — so it '
              + 'costs no time on each read. An hourly check watches for it coming back.'
            : '');
    } else if (process.env.DRPC_API_KEY && kc.reussites > 0 && kc.essais - kc.reussites > kc.reussites) {
      remede = 'The key works (' + kc.reussites + ' successful reads) but refuses more often than '
        + 'it accepts: there, the quota really is being hit. The per-node readout is in the "What '
        + 'is being read" panel.';
    } else if (process.env.DRPC_API_KEY && kc.reussites > 0) {
      remede = 'The key works (' + kc.reussites + '/' + kc.essais + '). The refusals counted here '
        + 'come mostly from the public nodes, which only act as backup — that is their job, and it '
        + 'costs no lost read as long as the key answers.';
    } else if (process.env.DRPC_API_KEY) {
      remede = 'A dRPC key is set but the keyed node has not been called yet. If that persists, '
        + 'the server has not been redeployed since: a variable set after the last deployment is '
        + 'not seen by the running process.';
    } else {
      remede = 'A dedicated RPC for chain 4663 would lift the limit: dRPC serves it, and its key '
        + 'goes in DRPC_API_KEY. The two public nodes used here are free and shared.';
    }
    /* ---- ET LE SECOURS NE RATTRAPE PLUS RIEN ----
     * Depuis l'age minimum d'achat, un jeton qu'on examine a deux heures ou
     * plus demande une centaine de milliers de blocs. Le noeud de secours
     * plafonne a dix mille : il n'est meme plus candidat pour compter les
     * porteurs. Le dire change ce qu'il faut faire — ce n'est plus « le
     * secours prendra le relais », c'est « il n'y a plus de secours ». */
    const P0 = planchers();
    if (P0.ageMin > 17)
      remede += ' Worth noting: with a minimum buy age of '
        + Math.round(P0.ageMin / 60 * 10) / 10 + ' h, one block read needs about '
        + Math.round(P0.ageMin * 60 / BLOC_SECONDES / 1000) + ',000 blocks. The backup node caps '
        + 'at 10,000: it can no longer serve ANY holder count, only the block number and the '
        + 'Cobaye\'s trial. The official node is therefore the only one able to count holders, and '
        + 'when it saturates they all turn to "unknown".';
    dis('haute', 'The chain nodes are refusing ' + Math.round(echecs / total * 100) + '% of reads',
      echecs + ' refusals out of ' + total + ' calls — but not in the same place. ' + detail
      + '. Every refusal turns a token we could have judged into an "unknown", and an unknown '
      + 'never earns points: the token is set aside for a reason that has nothing to do with it.',
      remede);
  }

  const gk = s('goplusCle');
  if (goplusIdentifie() && gk.essais > 0 && gk.reussites === 0)
    dis('haute', 'The GoPlus key is set but the token is refused',
      'The signature was not accepted (' + (gk.dernierEchec || 'reason unknown') + '). Safety '
      + 'reads continue WITHOUT authentication — that is, exactly as before the key, so nothing '
      + 'is broken, but the rate limit stays everyone else\'s.',
      'Check that GOPLUS_APP_KEY and GOPLUS_APP_SECRET really are the two halves of the same '
      + 'pair, and that the server clock is right: time goes into the signature, and a few '
      + 'minutes of drift are enough to have it refused.');
  if (process.env.GOPLUS_APP_KEY && !process.env.GOPLUS_APP_SECRET)
    dis('haute', 'GOPLUS_APP_KEY is set without GOPLUS_APP_SECRET',
      'These are not two ways in: it is a two-piece lock. The key alone signs nothing, and reads '
      + 'continue unauthenticated.',
      'Set GOPLUS_APP_SECRET as well, from the same GoPlus screen.');

  if (cleCoingecko() && cgPorte === 'libre')
    dis('haute', 'The CoinGecko key is set but refused',
      'It was tried on Demo (api.coingecko.com) and on Pro (pro-api.coingecko.com): both refused '
      + 'it. Reads continue over free access — that is, exactly as before the key, so nothing is '
      + 'broken, but the key is doing nothing.',
      'Check the key at coingecko.com/en/developers/dashboard, then redeploy. A variable set '
      + 'after the last deployment is not seen by the running process.');

  if (!process.env.ANTHROPIC_API_KEY)
    dis('moyenne', 'The Advisor is off: no Anthropic key',
      'The agents judge on rules and on what they have measured. A model\'s view on borderline '
      + 'cases — the ones landing a few points from the threshold — is not available.',
      'Set ANTHROPIC_API_KEY in the Railway variables. One key is enough: the Advisor is only '
      + 'called on borderline cases, a few times per turn.');

  const budget = E.compteurs.budgetAtteint || 0;
  if (budget > 5)
    dis('basse', 'The call budget was reached ' + budget + ' times',
      'New tokens waited for the next turn for want of calls left in this one.',
      'Same cause as the first alert: more throughput on the chain, and the budget follows.');

  const ab = E.compteurs.prixAberrant || 0;
  if (ab > 0)
    dis('haute', ab + ' position(s) closed on an unusable price',
      'The re-read price implied a move impossible for that pool. Nothing was counted and nobody '
      + 'learned anything from it — but the position itself is lost from view.',
      'This is the mark of very low-decimal tokens or of drained pools. Nothing to supply: it is '
      + 'noted here so that we know it happens, and how often.');

  /* ==========================================================================
   * ELLE DIT ELLE-MEME POURQUOI ELLE N'ACHETE PAS
   *
   * « Regarde pourquoi le bot ne trade pas. »
   *
   * Il a fallu relever l'etat a la main et compter les refus un par un pour
   * repondre. La colonie avait les chiffres : elle ne savait pas les dire.
   *
   * Ce qui est nomme, c'est LA regle qui bloque — pas « rien ne passe ». Trois
   * filtres qui refusent chacun un tiers ne se corrigent pas comme un seul qui
   * refuse tout, et l'ecart entre les deux est toute la difference entre
   * « change ce reglage » et « change de strategie ».
   *
   * Chaque famille porte le REGLAGE qui la gouverne : une alerte qui dit ce
   * qui bloque sans dire quoi toucher fait chercher dans le code.
   * ======================================================================== */
  const REGLAGES = [
    /* ---- LES MOTIFS SUIVENT LES PHRASES ----
     * Ces expressions reconnaissent le TEXTE du refus pour nommer le reglage
     * qui le gouverne. Les phrases sont passees a l'anglais ; un motif reste
     * en francais ne casse rien de visible — il rend juste « aucune variable »
     * pour une regle qui en a une, et l'alerte envoie alors chercher dans le
     * code un chiffre qui est dans l'environnement. Les deux formes sont
     * gardees : l'audit contient encore des cles ecrites avant la bascule. */
    [/below the buy floor|sous le plancher d'achat/, 'LIQ_ACHAT_MIN / MC_ACHAT_MIN'],
    [/above the buy ceiling|au-dessus du plafond/, 'MC_ACHAT_MAX'],
    [/too young|trop jeune/, 'AGE_ACHAT_MIN'],
    [/paying the top|on paierait le sommet/, 'PUMP_MAX_M#/PUMP_MAX_H#'],
    [/already down|deja tombe/, 'DUMP_MAX_M#/DUMP_MAX_H#'],
    [/^missing:|il manque :/, 'SOCIAUX_EXIGES'],
    [/no public presence/, 'SOCIAUX_EXIGES'],
    [/score too low|note trop basse/, 'the entry threshold, which the colony moves itself'],
    [/not indexed by DexScreener|pas encore verifiable/, 'SOCIAUX_EXIGES (the rule waits for DexScreener)'],
    /* Les regles qui n'ont PAS de variable : le dire aussi. Une famille sans
       reglage laisserait chercher une variable qui n'existe pas — c'est pire
       que de ne rien indiquer. */
    [/not a market any more|ce n'est plus un marche/, 'no variable: Scout rule, in the code'],
    [/nothing to sell into|rien a vendre dedans/, 'no variable: Scout rule, in the code'],
    [/holder holds|porteur tient/, 'no variable: Whale rule, in the code'],
    [/nobody holds|aucune ne le garde/, 'no variable: Whale rule, in the code'],
    [/honeypot|tax|proprietaire|taxe|self-destruct|auto-destruction/, 'no variable: contract safety'],
    [/exit is blocked|la sortie est bloquee/, 'no variable: the Cobaye\'s trial'],
  ];
  const reglageDe = (k) => {
    const r = REGLAGES.find((x) => x[0].test(k));
    return r ? r[1] : 'no variable: rule written in the code';
  };
  const sansAchat = E.toursSansAchat || 0;
  const vus = E.refusVus || 0;
  /* Douze refus, pas trente : en dessous les parts sont du bruit — « 50 % »
     sur deux jetons ne designe rien — mais au-dessus la regle dominante se
     lit deja, et attendre trente laisserait la colonie muette pendant une
     heure alors qu'elle sait deja quoi dire. */
  /* ==========================================================================
   * LE CONTROLE DE CONTRAT QUI NE TOURNE PLUS
   *
   * Le Warden est l'agent qui lit le contrat : honeypot, taxes, pouvoirs du
   * proprietaire. Il commence par `if (!g.have) return null` — s'il n'a rien
   * lu, il se tait, et c'est la bonne decision : faire dire « rien a
   * signaler » a un silence serait inventer une garantie.
   *
   * Mais releve sur la colonie : 0 refus sur 3 218 jetons, parce que GoPlus
   * n'a rien rendu 3 095 fois. Un agent qui ne refuse jamais RESSEMBLE a un
   * agent permissif ; celui-ci est simplement aveugle, et la difference est
   * toute la difference. L'alerte precedente l'a d'ailleurs lu comme « criteres
   * incoherents entre agents » — le diagnostic etait faux parce que le chiffre
   * ne disait pas ce qui manquait.
   *
   * Le Cobaye devait couvrir ce trou en simulant l'achat et la vente. Il le
   * fait quand il peut : 38 blocages sur 76. Mais 37 fois il n'a pas pu
   * conclure, et un resultat incertain N'ARRETE PAS l'achat — condamner sur
   * une lecture ratee serait pire. Consequence : des jetons sont achetes avec
   * AUCUN controle de contrat qui ait reellement tourne.
   *
   * On ne change pas la regle : bloquer sur l'incertain arreterait presque
   * tout, et inventer une garantie serait pire que de ne rien dire. On rend
   * le trou VISIBLE, parce qu'un risque qu'on ne voit pas ne se decide pas.
   * ======================================================================== */
  {
    const C0 = E.compteurs || {};
    const muets = C0.goplusMuet || 0;
    const inc = C0.cobayeIncertain || 0;
    const cobVu = C0.cobayeVu || 0;
    const wardenVu = C0.wardenVu || 0;
    const wardenRefus = wardenVu - (C0.wardenOk || 0);
    if (wardenVu > 200 && wardenRefus === 0 && muets > wardenVu / 2) {
      dis('haute', 'The contract check is not running',
        'The Warden has refused NO token out of ' + wardenVu + ' seen — not because they are '
        + 'clean, but because GoPlus returned nothing ' + muets + ' times. It reads the contract: '
        + 'honeypot, taxes, owner powers. It stays quiet when it has read nothing, and that is '
        + 'right — but an agent that never refuses looks like a permissive agent, when it is '
        + 'actually blind.'
        + (cobVu ? ' The Cobaye covers that hole when it can: ' + (C0.cobayeBloque || 0)
                 + ' blocks out of ' + cobVu + ' trials. But ' + inc + ' times it could not '
                 + 'conclude, and an uncertain result does not stop a buy — condemning on a failed '
                 + 'read would be worse. Those tokens were therefore bought without any contract '
                 + 'check having actually run.' : ''),
        'GoPlus does not index tokens a few minutes old: that is structural, not a fault. Two '
        + 'real levers: set GOPLUS_APP_KEY / GOPLUS_APP_SECRET, which give better throughput and '
        + 'coverage than free access; and make the Cobaye\'s trial conclude more often, which '
        + 'needs chain reads that succeed — the same saturation as the first alert. Blocking on '
        + 'uncertainty would stop nearly every buy and add no safety at all: we would still know '
        + 'nothing about the contract.');
    }
  }

  if (sansAchat >= 20 && vus >= 12) {
    /* ---- UN REPORT N'EST PAS UN REFUS ----
     *
     * L'alerte annoncait « trop jeune : 30 % des refus » et faisait lire une
     * perte de flux. Ce n'en est pas une : le jeton est mis de cote et REPRIS
     * des qu'il a l'age — c'est ce que fait la reprise par l'age, et
     * SURV_MAX est dimensionne pour qu'il soit encore en memoire a ce
     * moment-la. Les compter avec les refus definitifs pousse a bouger le
     * reglage qui coute le moins, et a laisser celui qui bloque vraiment.
     *
     * Les deux sont donc separes, et l'age est nomme pour ce qu'il est. */
    const estReport = (k) => REFUS_AGE.test(k);
    const tous = Object.keys(E.refusFamilles || {})
      .map((k) => ({ k, n: E.refusFamilles[k] }));
    const reports = tous.filter((f) => estReport(f.k)).reduce((a, b) => a + b.n, 0);
    const fam = tous.filter((f) => !estReport(f.k)).sort((a, b) => b.n - a.n).slice(0, 3);
    const fermes = Math.max(1, vus - reports);
    const dit = fam.map((f) => '« ' + f.k + ' » : ' + Math.round(f.n / fermes * 100)
      + '% of refusals (setting: ' + reglageDe(f.k) + ')');
    const heures = Math.round(sansAchat * (CADENCE_MS / 3600000) * 10) / 10;
    dis('haute', 'Nothing bought for ' + sansAchat + ' turns (' + heures + ' h)',
      'This is not a fault: every token is read properly and judged properly.'
      + (reports ? ' Of the last ' + vus + ' examined, ' + reports + ' are only SET ASIDE until '
        + 'they reach the required age — they come back, they are not lost.' : '')
      + (dit.length ? ' What REALLY stops them, on the other ' + fermes + ' — '
        + dit.join(' · ') + '.' : ''),
      'The rules stack: a token has to clear EVERY bound at once, and on this chain very few then '
      + 'remain. If a single setting accounts for half the refusals, that is the one to move — the '
      + 'others would change almost nothing. And the "what becomes of the rejected" panel says, '
      + 'for each rule, what the tokens it set aside went on to do: that is the only way to know '
      + 'whether it protects or whether it costs.');
  }

  const perdues = E.compteurs.abandonneeSansPrix || 0;
  if (perdues > 0)
    dis(perdues > 3 ? 'haute' : 'moyenne',
      perdues + ' position(s) abandoned for want of a price',
      'Their price could never be re-read, not once, until the deadline expired. The stake was '
      + 'given back and nobody learned anything — we do not invent a zero result to close things '
      + 'tidily; that zero would enter the agents\' memory as an observation when nothing was '
      + 'observed.',
      'It is almost always a token too small to be indexed: the real remedy is upstream, in the '
      + 'liquidity floor that decides what gets bought.');

  return out;
}


/* ==========================================================================
 * LE CONSEILLER
 *
 * « Je peux rajouter l'API Claude pour avoir un cerveau amélioré de décision
 *   et réorganisation. Utilise le modèle Haiku, et avec l'API tous les agents
 *   peuvent l'utiliser pour s'améliorer. »
 *
 * ---- CE QU'IL FAIT, ET CE QU'IL NE PEUT PAS FAIRE ----
 *
 * Il donne un AVIS sur les cas limites : les jetons qui tombent a quelques
 * points du seuil, ceux ou la note ne tranche pas. C'est la que son apport est
 * reel — sur un honeypot ou sur une note de 12, il n'y a rien a arbitrer.
 *
 * Son avis vaut au plus huit points de note, dans un sens ou dans l'autre. Il
 * ne peut PAS lever un veto : un contrat piege reste refuse quoi qu'il en
 * pense. Il ne peut PAS toucher a une mise : les bornes du Banquier ne sont
 * negociables par personne. C'est la meme frontiere que pour les autres agents,
 * et elle vaut d'autant plus pour celui-la qu'on ne peut pas relire son
 * raisonnement ligne a ligne.
 *
 * ---- ET IL REPOND DE SES AVIS ----
 *
 * Son verdict devient une case de memoire comme celles des autres : « le
 * conseiller etait favorable » vaut ce que les positions ouvertes la-dessus ont
 * rendu. S'il se trompe, son influence se reduit toute seule, par le meme
 * mecanisme qui degonfle une case dispersee. On ne lui fait pas confiance parce
 * qu'il est un modele ; on lui fait confiance dans la mesure ou son releve le
 * merite.
 *
 * ---- CE QU'IL RECOIT ----
 *
 * Uniquement des chiffres DEJA LUS, et l'indication explicite de ce qui n'a pas
 * pu l'etre. Il n'a aucun moyen d'aller chercher quoi que ce soit, et on ne lui
 * demande jamais d'estimer une valeur manquante : un « inconnu » comble par un
 * modele est exactement le genre de chiffre qui a l'air d'une donnee.
 *
 * Sans cle, il est simplement eteint, et la page le DIT.
 * ======================================================================== */
const CONSEIL_MODELE = 'claude-haiku-4-5-20251001';
const CONSEIL_MAX_PAR_TOUR = 3;
const CONSEIL_MARGE = 12;        /* on ne le consulte que dans cette bande autour du seuil */
const CONSEIL_POIDS = 8;         /* et son avis pese au plus huit points */

function conseillerActif() { return !!process.env.ANTHROPIC_API_KEY; }

/* La consigne est en anglais parce que le « pourquoi » qu'elle rend est
   AFFICHE tel quel sur une page anglaise. Traduire sa reponse apres coup la
   reecrirait, et une phrase reecrite n'est plus celle qu'il a ecrite. Les
   trois valeurs d'avis, elles, restent telles quelles : ce sont des cles. */
const CONSEIL_SYSTEME =
  'You advise a colony of agents that scores VERY YOUNG tokens (a few minutes old) on Robinhood '
+ 'chain 4663. Its treasury is paper: nothing is signed.\n\n'
+ 'You are given ONLY measurements already read. When a field reads "unknown", it means the '
+ 'service did not answer: NEVER guess its value, and draw no favourable conclusion from it. '
+ 'An unknown is not a good sign.\n\n'
+ 'The dominant risk at this age is the rug pull: a drained pool, extreme concentration, volume '
+ 'manufactured by a single wallet, a token already down.\n\n'
+ 'Answer ONLY with a JSON object, no text around it:\n'
+ '{"avis":"favorable"|"reserve"|"defavorable","points":<integer from -8 to 8>,"pourquoi":"<20 words max, in English>"}\n'
+ 'Be strict: the colony sees hundreds of tokens and keeps only a few. When in doubt, "reserve" '
+ 'with 0 points.';

function fiche(t) {
  const c = t.chaine || {}, g = t.g || {}, x = t.trades || {}, d = t.dex || {}, h = (t.tx || {}).h1 || {};
  /* Les noms de champs partent tels quels dans le message : ils sont donc
     ecrits dans la langue du prompt, sinon le modele lit une fiche francaise
     sous une consigne anglaise et doit deviner la correspondance. */
  const ou = (v, s) => (v === null || v === undefined) ? 'unknown' : (s ? s(v) : v);
  return {
    symbol: t.sym, age_minutes: Math.round(t.minutes || 0),
    found_via: t.origine || 'pools',
    liquidity_usd: Math.round(t.liq || 0),
    market_cap_usd: Math.round(t.mc || 0),
    change_5min_pct: t.ch_m5, change_1h_pct: t.ch_h1,
    buys_1h: h.buys || 0, sells_1h: h.sells || 0, buyers_1h: h.buyers || 0,
    holders_read_in_blocks: c.vu ? ou(c.porteurs) : 'unknown',
    largest_holder_share_pct: c.vu ? ou(c.top) : 'unknown',
    burned_share_pct: c.vu ? ou(c.brule) : 'unknown',
    addresses_skipped_as_pool: c.vu ? (c.infra || 0) : 'unknown',
    contract_safety: g.have ? {
      buy_tax_pct: g.taxeSue ? g.buyTax : 'unknown',
      sell_tax_pct: g.taxeSue ? g.sellTax : 'unknown',
      code_verified: g.codeSu ? !g.unverified : 'unknown',
      can_mint: g.mintable, proxy_contract: g.proxy,
    } : 'unknown — the contract is too young to be indexed',
    trades_read: x.vu ? {
      count: x.n, distinct_buyers: x.acheteurs,
      largest_wallet_share_pct: x.partDuPlusGros, average_ticket_usd: x.moyen,
    } : 'unknown',
    socials: d.vu ? d.socials : 'unknown',
    pool_count: d.vu ? d.pools : 'unknown',
    colony_score: t.an ? t.an.score : null,
    score_needed_to_buy: seuilCourant(),
  };
}

async function conseille(t) {
  if (!conseillerActif()) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CONSEIL_MODELE, max_tokens: 200, system: CONSEIL_SYSTEME,
        messages: [{ role: 'user', content: JSON.stringify(fiche(t)) }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(r.status + (r.status === 401 ? ' cle refusee'
        : r.status === 429 ? ' quota' : ' ' + txt.slice(0, 40)));
    }
    const j = await r.json();
    const brut = ((j.content || []).find((b) => b.type === 'text') || {}).text || '';
    const m = brut.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('reponse illisible');
    const a = JSON.parse(m[0]);
    const avis = ['favorable', 'reserve', 'defavorable'].indexOf(a.avis) >= 0 ? a.avis : 'reserve';
    /* Son chiffre est BORNE ici, pas la-bas. Ce qui vient d'un modele passe par
       la meme porte etroite que le reste : il conseille, il ne decide pas. */
    let pts = parseInt(a.points, 10);
    if (!isFinite(pts)) pts = 0;
    pts = Math.max(-CONSEIL_POIDS, Math.min(CONSEIL_POIDS, pts));
    noteService('conseil', true);
    return { avis, points: pts, pourquoi: String(a.pourquoi || '').slice(0, 90) };
  } catch (e) {
    noteService('conseil', false, String(e.message || e).slice(0, 60));
    return null;
  }
}

/* ---- LE REGARD SUR LA COLONIE ELLE-MEME ----
 * Ce qu'il en dit est ECRIT, et rien de plus : aucune suggestion de structure
 * n'est appliquee toute seule. Reordonner les gardes ou faire naitre un agent
 * se justifie par une mesure qu'on peut refaire ; une proposition de modele ne
 * se refait pas, et on ne peut pas la relire ligne a ligne. Elle a sa place
 * dans le journal, sous les yeux de quelqu'un — pas dans les commandes. */
async function regardeLaColonie() {
  if (!conseillerActif()) return null;
  const l = (E.derniers || []).slice(-20);
  const etat = {
    tresorerie: Math.round(E.tresor), depart: DEPART, positions_fermees: E.trades,
    gagnantes: E.gains, seuil_actuel: seuilCourant(),
    vingt_derniers_rendements_pct: l,
    gardes: E.roster.filter((a) => a.role === 'garde').map((a) => ({
      agent: a.key, vus: E.compteurs[a.key + 'Vu'] || 0,
      refuses: E.compteurs[a.key + 'Bloque'] || 0, appels_necessaires: coutDe(a, null),
    })),
    methode_de_mise: methodeApprise(),
    jetons_examines: E.compteurs.scoutVu || 0,
    reexamens_evites: E.compteurs.reexamensEvites || 0,
  };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY,
                 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CONSEIL_MODELE, max_tokens: 260,
        /* ---- ET LE REGARD REPOND EN ANGLAIS ----
         * Ce texte est affiche tel quel sur une page anglaise. Le modele
         * repond dans la langue de la consigne : la consigne passe donc a
         * l'anglais, plutot que de traduire sa reponse apres coup — une
         * phrase retraduite n'est plus celle qu'il a ecrite. */
        system: 'You are watching a colony of agents that scores very young tokens. Its treasury '
              + 'is paper. You are given its readout. In ONE sentence (30 words max), say what '
              + 'looks most questionable in how it operates, quoting a figure from the readout. '
              + 'No general advice, no pleasantries. If everything looks coherent, say so. '
              + 'Answer in English.',
        messages: [{ role: 'user', content: JSON.stringify(etat) }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const txt = (((j.content || []).find((b) => b.type === 'text') || {}).text || '').trim();
    if (!txt) return null;
    noteService('conseil', true);
    journal('regard', txt.slice(0, 240), null);
    return txt;
  } catch (e) { noteService('conseil', false, String(e.message || e).slice(0, 60)); return null; }
}

/* ==========================================================================
 * OU LA COLONIE REGARDE
 *
 * Elle triait par « le plus jeune d'abord » et prenait les dix premiers. Sur
 * cette chaine, ca voulait dire dix jetons de une a deux minutes — et c'est
 * precisement l'age ou elle est le plus aveugle : mesure sur douze d'entre eux,
 * DexScreener n'en connait qu'un, les chandelles n'en mesurent aucun, les
 * trades sont trop rares pour conclure sur dix. Elle depensait donc tout son
 * budget la ou il y a le moins a lire.
 *
 * ---- ET ON NE CHOISIT PAS L'AGE A SA PLACE ----
 *
 * « Entrer plus tot » et « entrer mieux renseigne » sont un arbitrage reel : a
 * deux minutes le mouvement est devant, a trente il est peut-etre fait. Trancher
 * ici reviendrait a inscrire une opinion dans le code, alors que toute la
 * machine est construite pour qu'elle apprenne les siennes.
 *
 * On repartit donc le regard sur quatre bandes d'age, en alternant. L'age est
 * DEJA un trait du Scout : des qu'il voit des positions se fermer dans chaque
 * bande, il apprend laquelle paie — et il l'apprend de ses propres resultats,
 * pas de ce que j'aurais suppose. Ce qu'il ne pouvait pas faire tant qu'il ne
 * regardait qu'une seule bande.
 * ======================================================================== */
const BANDES = [
  { max: 5, nom: '0-5 min' },
  { max: 20, nom: '5-20 min' },
  { max: 60, nom: '20-60 min' },
  { max: AGE_MAX_MIN, nom: '1-6 h' },
];
function parBandes(l) {
  const paniers = BANDES.map(() => []);
  for (const t of l) {
    let i = BANDES.findIndex((b) => t.minutes < b.max);
    if (i < 0) i = BANDES.length - 1;
    paniers[i].push(t);
  }
  for (const p of paniers) p.sort((a, b) => a.minutes - b.minutes);
  /* En alternant : chaque bande a sa chance a chaque tour, plutot qu'une seule
     qui prend tout parce qu'elle arrive en tete du tri. */
  const out = [];
  for (let k = 0; out.length < l.length; k++) {
    let pris = false;
    for (const p of paniers) if (p[k]) { out.push(p[k]); pris = true; }
    if (!pris) break;
  }
  return out;
}

/* ------------------------------------------------------------------ le tour */
let enCours = false;
/* ---- UN PRIX SANS DATE MENT ----
 * « Nos positions ouvertes ne bougent pas : +0.0 % · +$0.00 »
 * Elles bougeaient. C'est le chiffre affiche qui ne bougeait pas, et il ne
 * disait pas pourquoi. Une position ouverte ecrivait son prix d'entree ici, et
 * quand son jeton sortait des flux — ce qui arrive toujours, ils ne servent que
 * du neuf — plus rien ne le remplacait. L'ecran affichait donc l'ecart entre le
 * prix d'entree et le prix d'entree : exactement zero, presente comme une
 * cotation du moment.
 * Un prix porte desormais sa date. Passe ce delai il n'est plus une cotation,
 * c'est un souvenir, et la page doit ecrire « prix non relu » — ce qui est
 * vrai — plutot que « +0,0 % », qui est faux. */
const AGE_PRIX_MAX = 12 * 60e3;
const dernierPrix = {};
function posePrix(adr, p) { if (p > 0) dernierPrix[adr] = { p, t: Date.now() }; }
function prixFrais(adr) {
  const x = dernierPrix[adr];
  return (x && Date.now() - x.t <= AGE_PRIX_MAX) ? x.p : null;
}

/* ---- LES LECTURES PARESSEUSES ----
 * On ne paie un service que si un agent qui doit encore parler en a besoin.
 * C'est ce qui donne un sens a l'ordre des gardes : un refus precoce fait
 * economiser tous les appels d'apres, et ces appels-la sont exactement ce qui
 * limite le nombre de jetons qu'on arrive a examiner. */
/* ---- UN APPEL QUI NE PEUT PAS REPONDRE NE SE PAIE PAS ----
 * Mesure sur douze jetons de une a deux minutes :
 *   - les chandelles : 0 sur 12 exploitables (il faut quelques minutes de vie) ;
 *   - DexScreener : connait le jeton 1 fois sur 12 (il n'a pas encore indexe) ;
 *   - les trades : assez nombreux pour conclure 2 fois sur 12.
 * Chacun de ces appels etait paye, echouait a rendre quoi que ce soit
 * d'utilisable, et le trait sortait « inconnu ». Le budget d'appels d'un tour
 * partait donc pour l'essentiel dans des questions dont on pouvait savoir a
 * l'avance qu'elles n'avaient pas de reponse.
 * On garde la question pour plus tard, et on le DIT — « pas encore lisible a
 * cet age » n'est pas « le service est en panne ». */
function peutRepondre(b, t) {
  const m = t.minutes === null || t.minutes === undefined ? 999 : t.minutes;
  if (b === 'ohlcv' && m < 6)
    return 'no candles yet: ' + Math.round(m) + ' min old';
  if (b === 'dex' && m < 10)
    return 'DexScreener has not indexed it yet at ' + Math.round(m) + ' min';
  if (b === 'trades') {
    const h = (t.tx || {}).h1 || {};
    const n = (h.buys || 0) + (h.sells || 0);
    if (n < 5) return 'only ' + n + ' trade(s) in the hour: nothing to read';
  }
  return null;
}

async function assure(t, besoins) {
  for (const b of besoins) {
    if (t.lu[b]) continue;
    const trop = peutRepondre(b, t);
    if (trop) {
      /* On marque comme « vu » pour ne pas y revenir dans le meme tour, et on
         retient la raison : le trait vaudra « inconnu », ce qui est vrai. */
      t.lu[b] = true;
      (t.saute || (t.saute = {}))[b] = trop;
      compte('appelsEconomises');
      continue;
    }
    t.lu[b] = true;
    if (b === 'goplus') { await lisGoplus(t); t.appels++; }
    else if (b === 'chaine') { t.chaine = await lisChaine(t.addr, t.minutes, t.pool); t.appels++; }
    else if (b === 'trades') { t.trades = await lisTrades(t.pool); t.appels++; }
    else if (b === 'ohlcv') { const o = await lisOhlcv(t.pool); t.vola = o.vola; t.appels++; }
    else if (b === 'dex') {
      if (!t.dex) { t.dex = await lisDex(t.addr); t.appels++; }
      t.ecart = (t.dex.vu && t.dex.prix > 0 && t.prix > 0)
        ? Math.abs(t.dex.prix - t.prix) / t.prix * 100 : null;
    }
  }
}

/* ---- LES TROIS FLUX, FONDUS EN UNE SEULE LISTE ----
 * Ils ne ramenent pas la meme population, et c'est le but. Un jeton trouve par
 * deux flux garde le premier qui l'a vu : `origine` est un trait que la
 * colonie apprend, il ne doit pas changer selon l'ordre de lecture. */
/* ==========================================================================
 * LA SURVEILLANCE RAMENE, ELLE NE SE CONTENTE PLUS DE REGARDER
 *
 * La case existait ; rien ne l'ouvrait. Un jeton refuse a deux minutes pour
 * « pas encore verifiable sur DexScreener » y entrait, s'y affichait — et ne
 * revenait JAMAIS, parce que le seul chemin vers le pipeline etait le flux des
 * nouveaux pools, ou il ne figure plus cinq minutes plus tard. La colonie
 * lisait donc toujours la meme tranche : releve sur elle apres treize heures,
 * « 0-5 min : 19 jetons · 5-20 min : 0 · 20-60 min : 1 · 1-6 h : 0 ».
 *
 * Or c'est precisement la tranche ou ses propres regles sont impossibles a
 * satisfaire. A deux minutes DexScreener n'a rien indexe, donc la regle des
 * reseaux refuse tout ; les blocs ne montrent qu'un porteur, donc le Whale
 * refuse tout. Sur le tour releve : vingt candidats, vingt refus. Et le seul
 * jeton mur du lot — 31 minutes, 599 000 $ de capitalisation, 70 000 $ de
 * piscine — arrivait par un autre flux.
 *
 * Ce que dit l'audit de la meme colonie, dans le meme temps : « achete ou
 * retenu » rend -38,9 % en moyenne, tandis que « note trop basse » rend
 * +93 % et « pas encore verifiable sur DexScreener » +51 % et +77 %. Les
 * echantillons sont petits, mais le signe est le meme dans les trois cases :
 * on achete le mauvais tiers et on ecarte le bon.
 *
 * On rouvre donc la case. Un jeton qui avait FROLE le seuil et qui a ete
 * refuse sur un ETAT est redemande a son adresse une fois qu'il a eu le temps
 * d'exister — c'est un appel a DexScreener, celui-la meme qui manquait la
 * premiere fois. Il revient alors avec son age, sa piscine et ses reseaux, et
 * repasse devant les memes gardes, qui cette fois ont de quoi juger.
 * ======================================================================== */
const REPRISE_APRES_MIN = 12;    /* laisser a l'indexation le temps d'exister */
const REPRISE_ESPACE_MIN = 20;   /* et ne pas le redemander a chaque tour */
const REPRISE_PAR_TOUR = 5;

async function reprises(dejaVu) {
  const now = Date.now(), cand = [];
  for (const addr in E.connus) {
    const c = E.connus[addr];
    if (c.permanent || dejaVu.has(addr)) continue;
    if (!c.verdict) continue;                       /* jamais refuse : rien a reprendre */
    /* Un refus « trop jeune » ne dit rien du jeton : il dit l'heure. Exiger en
       plus une note serait juger sur ce qu'on a lu a deux minutes, c'est-a-dire
       presque rien — et la regle d'age n'aurait alors ecarte que du silence. */
    const pourLAge = REFUS_AGE.test(c.verdict);
    if (!pourLAge && !(c.meilleure >= SEUIL - 20)) continue;
    const age = now - (c.ne || now);
    /* Celui qu'on attend pour son age revient quand il l'a, pas avant. */
    const attendu = pourLAge ? Math.max(REPRISE_APRES_MIN, planchers().ageMin) : REPRISE_APRES_MIN;
    if (age < attendu * 60000) continue;
    if (age > AGE_MAX_MIN * 60000) continue;        /* passe six heures, ce n'est plus du neuf */
    if (now - (c.repris || 0) < REPRISE_ESPACE_MIN * 60000) continue;
    cand.push({ addr, c });
  }
  /* Les meilleures notes d'abord : le budget est petit, il va a ceux qui
     etaient le plus pres de passer. */
  cand.sort((a, b) => (b.c.meilleure || 0) - (a.c.meilleure || 0));
  const out = [];
  for (const x of cand.slice(0, REPRISE_PAR_TOUR)) {
    x.c.repris = now;
    const t = await jetonDepuisDex(x.addr, 'surveillance');
    if (t && t.prix > 0) out.push(t);
    else compte('repriseMuette');
    await dors(250);
  }
  if (out.length) compte('reprises', out.length);
  return out;
}

/* ==========================================================================
 * ON N'APPREND PAS QUE DES SURVIVANTS
 *
 * « Tu as recolte beaucoup de donnees a present. »
 *
 * Beaucoup, oui — et presque toutes du meme cote. Releve sur la colonie apres
 * soixante et une heures : 598 ombres jugees, 1 099 en attente ; et ce que
 * les agents en ont retenu : « trouve par pools » +49,8 %, « ne de <10 min »
 * +48 %, « achats massifs » +56 %, « pool 1-5k » +38 %. Pendant le meme
 * temps, les positions REELLES : 21 gagnantes sur 77, et les vingt dernieres
 * a -3 % de mediane. Les ombres disaient que tout monte ; la caisse disait le
 * contraire. L'une des deux mesures etait fausse, et c'etait celle dont tout
 * le monde apprenait.
 *
 * Voici pourquoi. Une ombre n'est jugee que si le jeton REPASSE dans un flux
 * avec un prix a l'echeance — trente minutes, plus ou moins quinze. Or le flux
 * des nouveaux pools fait soixante pools, soit dix a vingt minutes de cette
 * chaine : a trente minutes, un jeton n'y est plus. Il n'y revient que par
 * les profils, les pousses, ou la surveillance — c'est-a-dire s'il vit encore
 * et si quelqu'un s'en occupe. Un jeton vide a la vingtieme minute ne repasse
 * nulle part : il n'est jamais juge, et sa chute n'entre dans aucune case.
 * On ne mesurait que ceux qui avaient tenu. C'est le biais du survivant, mot
 * pour mot, et il contaminait tout ce qui en decoule : le fond de +25 dans
 * chaque case (voir `apprendBase`), les courbes par trait qui votaient pour
 * tenir longtemps — puisque seuls les survivants avaient un prix a 60 et 120
 * minutes —, et l'audit des refus, ou les regles dont les refuses sont relus
 * par la surveillance paraissaient proteger, quand elles etaient seulement
 * mieux mesurees.
 *
 * ---- CE QU'ON FAIT ----
 *
 * A chaque tour, les ombres dont une echeance est OUVERTE et que les flux ne
 * cotent pas sont relues a leur adresse — la meme lecture que le prix de
 * secours des positions. Six par tour au plus, l'echeance de reference
 * d'abord, puis celles qui vont expirer. Le cache est vide avant : un prix
 * d'il y a dix minutes n'est pas le prix a l'echeance. Un jeton que
 * DexScreener ne connait pas reste non juge, et il est compte comme tel — on
 * ne fabrique toujours pas de resultat ; on va simplement chercher ceux qui
 * existent au lieu d'attendre qu'ils passent.
 *
 * Seules les echeances a partir de la reference sont relues : a cinq et
 * quinze minutes, le jeton est encore dans le flux, et le relire serait payer
 * un appel pour un prix qu'on a.
 * ======================================================================== */
const OMBRES_SECOURS_PAR_TOUR = 6;
async function secoursOmbres(marche) {
  if (!Array.isArray(E.ombres) || !E.ombres.length) return 0;
  const now = Date.now();
  const dues = [];
  for (const o of E.ombres) {
    const deja = marche[o.adr];
    if (deja && deja.prix > 0) continue;
    const age = (now - o.t) / 60000;
    for (const h of HORIZONS) {
      if (h < HORIZON_REF) continue;
      if (o.jalons && o.jalons[h] !== undefined) continue;
      if (!jalonValable(h, age)) continue;
      dues.push({ o, ref: h === HORIZON_REF ? 0 : 1, reste: h + Math.max(5, h * 0.5) - age });
      break;
    }
  }
  if (!dues.length) return 0;
  dues.sort((a, b) => a.ref - b.ref || a.reste - b.reste);
  let n = 0;
  for (const d of dues.slice(0, OMBRES_SECOURS_PAR_TOUR)) {
    delete CACHE.dex[d.o.adr];
    const x = await lisDex(d.o.adr);
    if (x && x.vu && x.prix > 0) {
      marche[d.o.adr] = { prix: x.prix, liq: x.liq || 0 };
      posePrix(d.o.adr, x.prix);
      d.o.muets = 0;
      n++;
    } else {
      compte('ombreMuette');
      /* Un silence de plus, sur CETTE ombre : c'est `regleLesOmbres` qui en
         tire quelque chose, et seulement si le jeton avait ete vu. */
      d.o.muets = (d.o.muets || 0) + 1;
    }
    await dors(250);
  }
  if (n) compte('ombresDeSecours', n);
  return n;
}

async function rassemble() {
  const parAdresse = new Map();
  for (const t of await lisPools()) if (!parAdresse.has(t.addr)) parAdresse.set(t.addr, t);

  for (const flux of ['profils', 'boosts']) {
    const adrs = await lisFluxDex(flux);
    let pris = 0;
    for (const a of adrs) {
      if (parAdresse.has(a)) continue;
      if (pris >= 6) break;                        /* un flux ne monopolise pas le budget */
      const c = E.connus[a];
      if (c && c.permanent) continue;              /* deja banni : pas meme un appel */
      const t = await jetonDepuisDex(a, flux);
      pris++;
      if (t && t.prix > 0) parAdresse.set(a, t);
      await dors(250);
    }
    await dors(400);
  }
  /* Et ceux qu'on avait mis de cote, maintenant qu'ils ont eu le temps
     d'exister. C'est la seule source qui serve autre chose que du tout neuf. */
  for (const t of await reprises(parAdresse)) if (!parAdresse.has(t.addr)) parAdresse.set(t.addr, t);
  return [...parAdresse.values()];
}

async function tour() {
  if (enCours) return;
  enCours = true;
  try {
    E.tours = (E.tours || 0) + 1;
    E.toursDepuisOrdre = (E.toursDepuisOrdre || 0) + 1;
    /* Avant tout le reste, et sans lire quoi que ce soit : les positions dont
       le prix n'a jamais pu etre relu liberent leur place. */
    abandonneLesPerdues();
    /* ---- RIEN DE VIEUX N'ENTRE ----
     * Le but est d'analyser du NEUF. Un seul jeton etabli dans le pipeline
     * suffit a fausser ce que les agents apprennent. */
    const liste = parBandes((await rassemble())
      .filter((t) => t.liq >= 500 && t.prix > 0)
      .filter((t) => t.minutes !== null && t.minutes <= AGE_MAX_MIN));
    if (!liste.length) throw new Error('no new token liquid enough');

    /* Les prix d'abord : une position due se ferme au prix qu'on vient de
       lire, pas au suivant. */
    const prix = {};
    for (const t of liste) { prix[t.addr] = { prix: t.prix, liq: t.liq }; posePrix(t.addr, t.prix); }

    /* ---- UNE POSITION DONT LE JETON A QUITTE LE FLUX ----
     * Les flux ne servent que du NEUF. Une position tenue quarante minutes voit
     * donc son jeton en sortir avant d'etre reglee, et il n'y avait alors plus
     * aucun prix pour elle : elle restait ouverte pour toujours, affichant
     * « prix non relu », et occupait une des six places. Six positions coincees,
     * et la colonie cesse d'acheter — sans erreur nulle part, avec un ecran qui
     * a l'air normal.
     * On va donc chercher leur prix a l'adresse, directement. C'est un appel
     * chacune, plafonne, et seulement pour celles que les flux n'ont pas
     * couvertes. Un prix relu reste un prix relu : rien n'est extrapole depuis
     * l'ancien, ce qui serait fabriquer le resultat qu'on mesure. */
    let secours = 0;
    for (const p of E.positions) {
      /* ---- LE GARDE-FOU QUI AVAIT CESSE DE GARDER ----
       * Cette ligne testait `prix[p.adr] > 0` quand la carte portait des
       * nombres. Elle porte maintenant des objets, et `{...} > 0` vaut
       * toujours faux : le secours ne se declenchait donc plus « quand il
       * manque un prix », il ECRASAIT les prix fraichement lus par une valeur
       * en cache. Quatre positions — le plafond, exactement — se reglaient a
       * +0,0 % sur un prix vieux de dix minutes, et rien ne le signalait :
       * elles fermaient, la tresorerie ne bougeait pas, tout avait l'air
       * normal. On teste le prix, pas la boite qui le contient. */
      const deja = prix[p.adr];
      if ((deja && deja.prix > 0) || secours >= 4) continue;
      secours++;
      const d = await lisDex(p.adr);
      if (d.vu && d.prix > 0) {
        prix[p.adr] = { prix: d.prix, liq: d.liq || 0 }; posePrix(p.adr, d.prix);
        /* Le secours compte comme une lecture : c'en est une. Sans ca, une
           position que SEUL le secours sait coter serait abandonnee alors
           qu'on la suit tres bien. */
        p.prixLu = Date.now();
      }
      await dors(250);
    }
    if (secours) compte('prixDeSecours', secours);
    /* Et les ombres arrivees a echeance que les flux ne cotent plus : sans
       ca, on n'apprend que des survivants. Voir `secoursOmbres`. */
    await secoursOmbres(prix);

    /* On revient voir ce qu'on a vendu tot : c'est la que la lecon se forme. */
    regleLesSuites(prix);
    regleLesOmbres(prix);
    const fermees = regle(prix);

    /* ---- CE QU'ON NE REPAIE PAS ----
     * Les bannis sortent sans un appel. Les deja-juges dont rien n'a bouge
     * aussi. Le budget d'appels va aux jetons qu'on n'a jamais vus — ce qui,
     * a budget constant, en fait examiner davantage. */
    const aVoir = [], ecartes = [];
    for (const t of liste) {
      const d = doitExaminer(t);
      if (d.oui) aVoir.push(t); else ecartes.push({ sym: t.sym, pourquoi: d.pourquoi });
      /* Vingt au lieu de dix : depuis que les appels qui ne peuvent pas
         repondre ne sont plus payes, un jeton jeune et calme coute UN appel au
         lieu de quatre. Le meme budget en couvre donc deux fois plus — et
         chacun laisse une ombre dont tout le monde apprend. */
      if (aVoir.length >= 20) break;
    }
    compte('reexamensEvites', ecartes.length);

    /* ---- LE PIPELINE, GARDE PAR GARDE ----
     * Chaque garde ne fait lire que ce dont il a besoin, et un refus arrete
     * tout de suite : les services des gardes suivants ne sont pas appeles. */
    const gardes = gardesEnOrdre();
    const examines = [];
    let ouvertes = 0, appelsTotal = 0, conseils = 0;
    for (const t of aVoir) {
      if (appelsTotal >= 26) { compte('budgetAtteint'); break; }   /* le budget du tour, tenu */
      t.lu = { pools: true }; t.appels = 0;
      if (t.dex) t.lu.dex = true;           /* les flux DexScreener l'ont deja paye */
      let refus = null, quiRefuse = null;

      for (const a of gardes) {
        /* ---- L'EPREUVE N'EST PAS UN VETO SYNCHRONE ----
         * Le Cobaye figure dans l'ordre — c'est la que la page doit le
         * dessiner, et c'est la qu'il travaille — mais son epreuve demande un
         * appel reseau et se joue plus bas, une fois la note rendue. Le
         * laisser traverser cette boucle lui aurait compte un « vu » et un
         * « ok » pour CHAQUE jeton arrive jusqu'ici, y compris ceux dont la
         * sortie n'a jamais ete testee — et la colonie se reorganise sur ces
         * chiffres-la. */
        if (a.role === 'epreuve') continue;
        await assure(t, besoinsDe(a));
        compte(a.key + 'Vu');
        const veto = VETOS[a.key];
        const r = veto ? veto(t) : null;
        if (r) { refus = r; quiRefuse = a.key; compte(a.key + 'Bloque'); break; }
        compte(a.key + 'Ok');
      }
      appelsTotal += t.appels;
      compte('scoutVu');
      if (t.lu.goplus && !(t.g && t.g.have)) compte('goplusMuet');

      let an = null;
      if (!refus) {
        an = analyse(t);
        t.an = an;
        /* ---- ON NE LE CONSULTE QUE LA OU IL SERT ----
         * Sur un honeypot ou sur une note de douze, il n'y a rien a arbitrer :
         * l'appel serait paye pour confirmer une evidence. La bande autour du
         * seuil est exactement l'endroit ou la note ne tranche pas. */
        const sl = seuilCourant();
        if (conseillerActif() && conseils < CONSEIL_MAX_PAR_TOUR
            && an.score >= sl - CONSEIL_MARGE && an.score <= sl + CONSEIL_MARGE) {
          conseils++;
          t.conseil = await conseille(t);
          if (t.conseil) { an = analyse(t); t.an = an; compte('conseilRendu'); }
        }
        if (!an.achete) { refus = 'score too low'; quiRefuse = 'oracle'; compte('oracleBloque'); }
        else {
          /* ---- L'EPREUVE DE VENTE, JUSTE AVANT L'ACHAT ----
           * Le jeton a tout passe : c'est maintenant, et seulement maintenant,
           * que la simulation vaut ses appels. */
          compte('cobayeVu');
          t.epreuve = await simuleVente(t);
          t.appels += (t.epreuve.essais || 0);
          const bloque = vetoCobaye(t);
          if (bloque) { refus = bloque; quiRefuse = 'cobaye'; compte('cobayeBloque'); }
          else if (t.epreuve.teste) compte('cobayeOk');
          else compte('cobayeIncertain');
          /* On recalcule : le resultat de l'epreuve est un trait, et il doit
             entrer dans ce que les agents retiendront de ce jeton. */
          an = analyse(t); t.an = an;
        }
      } else {
        /* Refuse avant la note : on la calcule quand meme pour la
           surveillance, sur ce qu'on a lu — elle dira si ca valait la peine
           d'y revenir. Rien n'est invente : les champs non lus restent
           inconnus, et l'inconnu ne rapporte pas de points. */
        an = analyse(t);
        t.an = an;
      }
      noteConnu(t, refus, an.score);
      /* Achete ou refuse, il laisse une ombre : c'est de la que viendra le
         gros de l'apprentissage, et l'audit des vetos avec. */
      noteOmbre(t, an, refus, quiRefuse);
      examines.push({ t, refus, quiRefuse, an });
      if (!refus && ouvre(t)) ouvertes++;
      await dors(200);
    }

    /* ---- ET LA COLONIE SE REORGANISE ----
     * Apres avoir mesure, pas avant. */
    revoitOrdre(false);
    revoitStrategie();
    /* Apres la strategie, pas avant : le seuil et les bornes repondent a deux
       questions differentes — « quelle note exiger » et « quels jetons meritent
       d'etre notes » — et les bouger dans le meme tour ferait deux causes pour
       un seul effet. `revoitLesBornes` a son propre repos de 24 tours, ce qui
       les separe dans le temps. */
    revoitLesBornes();
    if (conseillerActif() && (E.tours % 20) === 0) await regardeLaColonie();
    engendre();
    elague();

    E.candidats = examines.map((x) => ({
      sym: x.t.sym, addr: x.t.addr, pool: x.t.pool, minutes: Math.round(x.t.minutes),
      liq: Math.round(x.t.liq), mc: Math.round(x.t.mc), prix: x.t.prix,
      ch_m5: x.t.ch_m5, origine: x.t.origine || 'pools', appels: x.t.appels,
      score: x.an ? x.an.score : null, base: x.an ? x.an.base : null, adj: x.an ? x.an.adj : null,
      refus: x.refus, quiRefuse: x.quiRefuse,
      avis: x.an ? x.an.avis : 0, conseil: x.an ? x.an.conseil : null,
      porteurs: x.t.chaine && x.t.chaine.vu ? x.t.chaine.porteurs : null,
      top: x.t.chaine && x.t.chaine.vu ? x.t.chaine.top : null,
      chaineVue: !!(x.t.chaine && x.t.chaine.vu),
      montantsLus: !!(x.t.chaine && x.t.chaine.montantsLus),
      infra: x.t.chaine && x.t.chaine.vu ? (x.t.chaine.infra || 0) : null,
      participants: x.t.chaine && x.t.chaine.vu ? (x.t.chaine.participants || 0) : null,
      personne: !!(x.t.chaine && x.t.chaine.personne),
      transferts: x.t.chaine && x.t.chaine.vu ? x.t.chaine.transferts : null,
      goplusSait: !!(x.t.g && x.t.g.have),
      goplusSeContredit: !!(x.t.g && x.t.g.seContredit),
      dexVu: !!(x.t.dex && x.t.dex.vu),
      liens: (x.t.dex && x.t.dex.vu) ? (x.t.dex.liens || []) : null,
      saute: x.t.saute || null,
      epreuve: x.t.epreuve || null,
      acheteurs: x.t.trades && x.t.trades.vu ? x.t.trades.acheteurs : null,
      partDuPlusGros: x.t.trades && x.t.trades.vu ? x.t.trades.partDuPlusGros : null,
      tradesVus: !!(x.t.trades && x.t.trades.vu),
    }));
    /* ---- POURQUOI ELLE N'ACHETE PAS ----
     *
     * « Regarde pourquoi le bot ne trade pas. »
     *
     * Il fallait relever l'etat a la main et compter les refus un par un pour
     * repondre. C'est exactement ce que la colonie devrait savoir dire d'elle-
     * meme : elle a les chiffres, et une machine qui s'arrete sans dire
     * laquelle de ses regles l'arrete est une machine qu'on croit cassee.
     *
     * On compte donc les refus par FAMILLE — la phrase sans ses nombres, pour
     * que « piscine de $4548 » et « piscine de $6202 » comptent ensemble — sur
     * une fenetre glissante. Quand rien ne s'ouvre pendant longtemps, l'alerte
     * nomme les trois regles qui bloquent le plus, avec leur part et le
     * reglage qui les gouverne.
     *
     * Ce qui compte ici, c'est de nommer LA regle, pas de dire « rien ne
     * passe » : trois filtres qui refusent chacun un tiers ne se corrigent pas
     * comme un seul qui refuse tout. */
    for (const x of examines) {
      if (!x.refus) continue;
      const fam = familleRefus(x.refus);
      E.refusFamilles[fam] = (E.refusFamilles[fam] || 0) + 1;
    }
    E.refusVus = (E.refusVus || 0) + examines.length;
    /* La fenetre : au-dela on oublie, sinon l'alerte parlerait d'un reglage
       change il y a deux jours. */
    if (E.refusVus > 400) {
      for (const k in E.refusFamilles) {
        E.refusFamilles[k] = Math.floor(E.refusFamilles[k] / 2);
        if (!E.refusFamilles[k]) delete E.refusFamilles[k];
      }
      E.refusVus = Math.floor(E.refusVus / 2);
    }
    E.toursSansAchat = ouvertes ? 0 : (E.toursSansAchat || 0) + 1;

    E.evites = ecartes.slice(0, 10);
    E.bandes = BANDES.map((b, i) => ({
      nom: b.nom,
      vus: examines.filter((x) => {
        let k = BANDES.findIndex((z) => x.t.minutes < z.max);
        if (k < 0) k = BANDES.length - 1;
        return k === i;
      }).length,
    }));
    E.maj = Date.now();
    E.dernierTour = Date.now();
    E.derniereErreur = null;
    sauve();
  } catch (e) {
    /* On DIT que la lecture a echoue. Rien n'est fabrique pour combler : sans
       prix, il n'y a ni ouverture ni reglement, et l'ecran doit le montrer
       plutot que d'afficher un etat qui aurait l'air normal. */
    E.derniereErreur = String((e && e.message) || e).slice(0, 160);
    E.dernierTour = Date.now();
    sauve();
  }
  enCours = false;
}

/* ------------------------------------------------------------------- la vue */
/* Ce que tout le monde lit, et c'est le MEME pour tout le monde. Elle porte
   desormais la STRUCTURE — le roster, l'ordre, ce qui est ne et ce qui a ete
   retire — parce que sans ca « les agents s'auto-developpent » resterait une
   phrase que personne ne peut verifier. */
function vue() {
  const agents = {};
  for (const a of E.roster) agents[a.key] = { obs: nObs(a.key), lecons: leconsDe(a.key, 3) };
  const b = methodeApprise();
  const engage = E.positions.reduce((s, p) => s + (p.mise || 0), 0);
  return {
    t: Date.now(),
    depuis: E.depuis, tours: E.tours || 0,
    maj: E.maj, dernierTour: E.dernierTour, erreur: E.derniereErreur,
    cadence: CADENCE_MS, veilleMs: VEILLE_MS,
    /* Le fil des signaux, borne : le portefeuille n'en montre qu'une
       poignee, et l'envoyer en entier a chaque lecture serait payer un
       historique que personne ne deroule. */
    signaux: (E.signaux || []).slice(0, 40),
    tresor: Math.round(E.tresor * 100) / 100, depart: DEPART,
    trades: E.trades, gains: E.gains,
    meilleur: Math.round(E.meilleur * 100) / 100, meilleurSym: E.meilleurSym,
    ouvertures: E.ouvertures,
    courbe: E.courbe.slice(-120),
    flux: E.flux.slice(0, 12),
    positions: E.positions.map((p) => {
      const x = prixFrais(p.adr);
      const r = (x > 0) ? (x - p.prix0) / p.prix0 * 100 : null;
      return { sym: p.sym, adr: p.adr, pool: p.pool, minutes: p.minutes, score: p.score,
               mcAchat: p.mcAchat === undefined ? (p.mc || null) : p.mcAchat,
               tenueRaison: p.tenueRaison || null,
               liens: p.liens || null, prolonge: p.prolonge || 0, dexVu: !!p.dexVu,
               logo: p.logo || null,
               ouverteDepuis: Date.now() - p.t0, tenueMin: p.tenueMin,
               mise: p.mise, methode: p.methode, regime: enMots(p.regime), raisonMise: p.raisonMise,
               origine: p.origine || 'pools',
               latent: r === null ? null : Math.round(r * 10) / 10,
               /* Le latent ne porte plus que sur ce qui reste tenu : afficher
                  la mise entiere apres deux paliers vendus serait annoncer un
                  risque qu'on ne court plus. */
               gainLatent: r === null ? null
                 : Math.round(p.mise * (p.reste === undefined ? 1 : p.reste) * r) / 100,
               reste: p.reste === undefined ? 1 : Math.round(p.reste * 100) / 100,
               encaisse: Math.round((p.encaisse || 0) * 100) / 100,
               paliers: p.paliers ? Object.keys(p.paliers).length : 0,
               hautR: p.hautR === undefined ? null : Math.round(p.hautR * 10) / 10,
               /* ---- CE QUE LE VEILLEUR A LU ----
                * La capitalisation du MOMENT, a cote de celle de l'achat : ce
                * sont les deux qu'on veut voir ensemble, et c'est leur ecart
                * qui dit quelque chose. Et l'heure de la lecture, parce qu'un
                * chiffre sans son heure ne dit pas s'il est encore vrai. */
               mcMaintenant: p.mcVeille === undefined ? null : Math.round(p.mcVeille),
               veilleT: p.veilleT || 0,
               prixVu: dernierPrix[p.adr] ? dernierPrix[p.adr].t : 0 };
    }),
    candidats: E.candidats,
    evites: E.evites || [],
    bandes: E.bandes || [],
    suites: (E.suites || []).map((s) => ({ sym: s.sym, rSortie: s.rSortie, echeance: s.echeance })),
    ombres: { enAttente: (E.ombres || []).length, jugees: E.compteurs.ombresJugees || 0,
              relues: E.compteurs.ombresDeSecours || 0, muettes: E.compteurs.ombreMuette || 0,
              disparues: E.compteurs.ombreDisparue || 0 },
    /* Le fond que toute case se compare a : sans lui a l'ecran, un
       ajustement de zero se lirait comme « rien appris ». */
    base: E.base && E.base.n > 0
      ? { n: Math.round(E.base.n * 10) / 10, moyenne: Math.round(E.base.s / E.base.n * 10) / 10,
          actif: baseCourante() !== 0 }
      : null,
    audit: auditDesRefus(),
    traits: classementDesTraits().slice(0, 12),
    horizons: HORIZONS, horizonRef: HORIZON_REF,
    jalons: E.compteurs.jalons || 0,
    surveillance: surveilles(),
    connus: Object.keys(E.connus).length,
    bannis: Object.keys(E.connus).filter((k) => E.connus[k].permanent).length,
    compteurs: E.compteurs,
    /* ---- LA STRUCTURE, TELLE QU'ELLE EST MAINTENANT ---- */
    roster: E.roster.map((a) => ({
      key: a.key, nom: a.nom, emoji: a.emoji, couleur: a.couleur, role: a.role,
      mission: a.mission, ordre: a.ordre || 0, parent: a.parent || null, ne: a.ne || 0,
      traits: (a.traits || []).map(nomTrait),
      cout: coutDe(a, null),
      vus: E.compteurs[a.key + 'Vu'] || 0, bloques: E.compteurs[a.key + 'Bloque'] || 0,
    })),
    ordreRevu: E.ordreRevu || 0,
    /* Huit lignes, dont trois d'observation au plus : sans cette borne, une
       colonie qui a engendre un agent et revu son ordre affichait huit
       reformulations d'un modele et rien de ce qu'elle avait fait. */
    journalStructure: journalPublie(8, 3),
    agents,
    /* ---- LE BANQUIER ---- */
    banque: {
      /* Le regime est une case de memoire, comme celles des agents : il sort
         par la table des mots et reste ecrit en francais dans l'etat. */
      methode: b.methode, appris: !!b.appris, regime: enMots(b.regime),
      serie: E.banque.serie || 0, pic: Math.round((E.banque.pic || DEPART) * 100) / 100,
      engage: Math.round(engage * 100) / 100,
      partMax: MISE_PART_MAX, expoMax: EXPO_PART_MAX, plancher: PLANCHER, miseMin: MISE_MIN,
      arret: E.banque.arret || null,
      prochaine: E.tresor >= PLANCHER ? miseDe(SEUIL + 15) : null,
      releve: METHODES.map((m) => {
        const l = [];
        for (const cle in E.banque.memoire) {
          if (cle.indexOf(m + '|') !== 0) continue;
          const c = E.banque.memoire[cle];
          l.push({ regime: enMots(cle.split('|')[1]), n: c.n, moyenne: Math.round(c.s / c.n * 10) / 10 });
        }
        return { methode: m, par: l };
      }).filter((x) => x.par.length),
    },
    tenue: tenueApprise(),
    /* ---- LES SERVICES, ET CEUX QUI NE MARCHENT PAS ---- */
    services: Object.keys(SERVICES).map((k) => {
      const s = E.services[k] || { essais: 0, reussites: 0, dernier: 0, dernierEchec: null };
      return { cle: k, nom: SERVICES[k].nom, quoi: SERVICES[k].quoi, cout: SERVICES[k].cout,
               essais: s.essais, reussites: s.reussites, dernier: s.dernier,
               dernierEchec: s.dernierEchec };
    }),
    /* ---- CE QUE LA COLONIE S'EST REGLE A ELLE-MEME ----
       Avec les butees ecrites dans le code, a cote : une borne apprise qu'on
       montre sans son plafond se lit comme une borne sans plafond. */
    bornes: Object.keys(BORNES).map((k) => ({
      cle: k, valeur: borne(k), min: BORNES[k].min, max: BORNES[k].max,
      appris: typeof (E.bornes || {})[k] === 'number',
    })),
    abandons: partAbandons(),
    horsService: HORS_SERVICE,
    coingecko: { cle: !!cleCoingecko(), porte: cgPorte || 'not probed yet' },
    rpcCle: { pose: !!(process.env.DRPC_API_KEY || '').trim(),
              plage: noeuds._cle ? noeuds._cle.plageLogs : null },
    goplus: { identifie: goplusIdentifie(), jeton: !!goplusJeton.valeur,
              moitie: !!process.env.GOPLUS_APP_KEY !== !!process.env.GOPLUS_APP_SECRET },
    conseiller: { actif: conseillerActif(), modele: CONSEIL_MODELE,
                  poids: CONSEIL_POIDS, parTour: CONSEIL_MAX_PAR_TOUR,
                  rendus: E.compteurs.conseilRendu || 0 },
    seuil: seuilCourant(), seuilDepart: SEUIL, ageMax: AGE_MAX_MIN,
    sociauxExiges: sociauxExiges(),
    /* Les reglages qui decident ce qu'on achete et comment on en sort. Une
       borne qu'on ne voit pas ne peut pas etre discutee. */
    planchers: planchers(),
    echelle: echelle(),
    derniers: (E.derniers || []).slice(-20),
    alertes: alertes(),
  };
}

/* Une remise a zero volontaire, pour le jour ou il en faudra une autre. Elle
   garde une copie de ce qu'elle jette : effacer sans copie est irreversible, et
   une remise a zero se demande rarement deux fois de suite par hasard. */
function remiseAZero(pourquoi) {
  try {
    fs.writeFileSync(FICHIER + '.' + Date.now() + '.abandonne', JSON.stringify(E));
  } catch (e) { /* pas de copie possible : on continue quand meme */ }
  const avant = E.tresor;
  E = etatNeuf();
  E.journalStructure = [{ t: Date.now(), quoi: 'remise', chiffres: null,
    txt: 'Reset requested' + (pourquoi ? ': ' + String(pourquoi).slice(0, 120) : '')
       + '. Tresorerie avant : $' + Math.round(avant) + '.' }];
  for (const k of Object.keys(dernierPrix)) delete dernierPrix[k];
  for (const c of Object.keys(CACHE)) for (const k of Object.keys(CACHE[c])) delete CACHE[c][k];
  sauve();
  return true;
}

let minuteur = null;
/* ==========================================================================
 * LE VEILLEUR : REGARDER SOUVENT, NE RIEN DECIDER
 *
 * Il relit les positions ouvertes sur DexScreener a sa propre cadence, plus
 * rapide que le tour. Trois precautions, et chacune a sa raison :
 *
 *   — il ne touche a RIEN d'autre que `prixVeille`, `mcVeille` et l'heure.
 *     Ni ouverture, ni vente, ni apprentissage. Le jour ou un bug le fait
 *     tourner deux fois trop vite, le pire qu'il puisse faire est de lire.
 *
 *   — il ecrit dans `dernierPrix`, la meme reserve que le tour : la
 *     Sentinelle et l'echelle de sortie profitent donc d'un prix plus frais
 *     sans qu'on ait touche a leur code.
 *
 *   — il passe par `lisDex`, qui a son propre cache : demander plus souvent
 *     que le cache ne rendrait pas un chiffre plus frais, seulement des
 *     appels perdus. Sa cadence est donc calee SUR ce cache, pas dessous.
 * ======================================================================== */
const VEILLE_MS = nEnv('VEILLE_MS', 45000);

async function veille() {
  const ouvertes = (E.positions || []).filter((p) => p && p.adr);
  if (!ouvertes.length) return 0;
  let n = 0, coupes = 0;
  for (const p of ouvertes) {
    try {
      const d = await lisDex(p.adr);
      if (!d || !d.vu || !(d.prix > 0)) continue;
      /* La reserve commune : ce que le reste de la colonie lit deja. */
      dernierPrix[p.adr] = { p: d.prix, t: Date.now() };
      p.prixVeille = d.prix;
      /* La capitalisation du MOMENT. Celle de l'achat reste a cote, sous
         `mcAchat` : c'est la comparaison des deux qui dit quelque chose, et
         ecraser l'une par l'autre effacerait le point de depart. */
      if (d.mc > 0) p.mcVeille = d.mc;
      p.veilleT = Date.now();
      n++;
      /* ---- LA SEULE DECISION QU'IL PRENNE : LA COUPE DE SECURITE ----
       * Le Veilleur ne juge rien et ne vend pas sur ce qu'il apprend — mais
       * la coupe de la Sentinelle n'est pas une decision apprise, c'est un
       * garde-fou ecrit dans le code. Entre deux tours, deux minutes et demie
       * passent ; sur cette chaine, une piscine se vide en une. Les positions
       * fermaient a -54, -62, -72, -82, -92 % parce que la premiere lecture
       * apres la chute etait celle du tour suivant. Le Veilleur, lui, lit
       * toutes les quarante-cinq secondes : c'est a lui de tirer le frein. */
      const danger = dangerSentinelle(p, { prix: d.prix, liq: d.liq || 0 });
      if (danger) {
        p.vuPar = casSentinelle(p, { prix: d.prix, liq: d.liq || 0 });
        ferme(p, d.prix, Date.now(), { par: 'sentinelle', raison: danger + ' — caught by the 45 s watch' });
        E.positions = (E.positions || []).filter((q) => q !== p);
        compte('veilleCoupe');
        coupes++;
      }
    } catch (e) { /* une lecture ratee ne change rien : l'ancienne valeur tient */ }
    await dors(120);
  }
  if (n || coupes) { compte('veilles'); sauve(); }
  return n;
}
let veilleur = null;

function demarre() {
  charge();
  /* Ce que les noeuds ont deja refuse de servir : on le remet en place AVANT
     le premier tour, sinon le tour du demarrage repaie les memes refus. */
  reprendSansMethode();
  if (minuteur) return;
  /* Un premier tour tout de suite, puis la cadence. Au demarrage du serveur,
     les positions en cours se reglent au prix du moment — le temps ecoule est
     du temps reel, meme si personne ne regardait. */
  tour();
  minuteur = setInterval(tour, CADENCE_MS);
  if (minuteur.unref) minuteur.unref();
  /* Le Veilleur tourne a part. Le mettre dans le tour l'aurait cale sur la
     cadence du tour, ce qui est exactement le probleme qu'il repare. */
  veilleur = setInterval(() => { veille().catch(() => {}); }, VEILLE_MS);
  if (veilleur.unref) veilleur.unref();
}
function arrete() {
  if (minuteur) { clearInterval(minuteur); minuteur = null; }
  if (veilleur) { clearInterval(veilleur); veilleur = null; }
}

module.exports = {
  demarre, arrete, vue, tour, charge, sauve, reprendSansMethode, veille,
  _signal: signal, _texteSignal: texteSignal, _ferme: ferme,
  _poseTg: (x) => { tg = x; },
  _noteAudit: noteAudit, _auditDesRefus: auditDesRefus,
  _familleRefus: familleRefus, _regroupeAudit: regroupeAudit, _noeudMort: noeudMort,
  _journal: journal, _journalPublie: journalPublie, _memeRegard: memeRegard,
  /* exposes pour l'essai : ce sont eux qui portent les regles */
  scoreBase, analyse, traitsDe, tenueApprise, leconsDe, apprendAgent, ajustementAgent, ecartType,
  apprendBase, baseCourante, BASE_MIN_OBS, centreLesNotes,
  secoursOmbres, OMBRES_SECOURS_PAR_TOUR, noteSuivi, SUIVIS_FENETRE, cibleDeVente,
  noteVendu, REACHAT_REPOS_MIN,
  caseNonLue, CASES_NON_LUES, TRAITS, MEMOIRE_DEMIVIE_J, SURV_MAX, fane,
  enMots, MOTS,
  regle, ouvre, ferme, etatNeuf, litTrait, besoinsDe, coutDe, gardesEnOrdre,
  miseDe, methodeApprise, banquierApprend, regime, statsRendement,
  revoitOrdre, engendre, elague, doitExaminer, noteConnu, surveilles,
  revoitStrategie, seuilCourant, partRefus, REFUS_AVEUGLE,
  revoitLesBornes, borne, BORNES, partAbandons, noteResultat, alertes, remiseAZero, nObs, parBandes, BANDES,
  casSentinelle, dangerSentinelle, veutProlonger, casPromoteur, prixFrais, posePrix,
  veutPrendre, casSortie, noteSuite, regleLesSuites, GAIN_EXPLORE,
  noteOmbre, regleLesOmbres, auditDesRefus, OMBRE_TENUE_MIN, OMBRE_DISPARUE, OMBRE_SILENCES,
  noteProfil, courbeDe, horizonPour, informationDe, classementDesTraits,
  vetoOracle, vetoScout, vetoWarden, vetoWhale, vetoWhisper, VETOS,
  REFUS_AGE, REFUS_DEFINITIFS,
  sociauxExiges, SOCIAUX_DEFAUT, simuleVente, vetoCobaye,
  planchers, echelle, joueEchelle, arretSuiveur, vendUneTranche, reprises,
  abandonDelai, abandonneLesPerdues,
  HORIZONS, HORIZON_REF, PROFIL_MIN_OBS, jalonValable,
  lisTrades, lisFluxDex, jetonDepuisDex, rassemble,
  sondeCoingecko, jsonGT, cleCoingecko, goplusEntetes, goplusIdentifie, noeuds, peutRepondre,
  _jeton: () => goplusJeton, _posejeton: (j) => { goplusJeton = j; },
  _porte: () => cgPorte, _poseporte: (p) => { cgPorte = p; },
  FICHIER, SEUIL, AGE_MAX_MIN, MISE, DEPART, METHODES, SERVICES, HORS_SERVICE,
  MISE_MIN, MISE_PART_MAX, EXPO_PART_MAX, PLANCHER, ENFANTS_MAX,
  ECART_TYPE_BRUIT, VARIANCE_MIN_OBS, ROSTER_DEPART, REORDONNABLES,
  VERSION_ETAT, SEUIL_MIN, SEUIL_MAX, REND_MAX, REND_MIN, CHUTE_COUPE, AGE_PRIX_MAX,
  SANS_ACHAT_DESSERRE,
  _etat: () => E, _pose: (x) => { E = x; }, _cache: CACHE, _prix: dernierPrix, _rpc: rpc,
};
