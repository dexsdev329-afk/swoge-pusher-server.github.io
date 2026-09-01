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
const GT = 'https://api.geckoterminal.com/api/v2/networks/robinhood';
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
const RPC_SECOURS = 'https://robinhood.drpc.org';
const SUJET_TRANSFERT = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const MORT = '0x000000000000000000000000000000000000dead';

const DEPART = 1000;            /* la tresorerie papier de depart */
const MISE = 50;                /* ce qu'une position engage */
const TENUE_DEFAUT_MIN = 20;    /* et ce que le Closer tient, avant d'apprendre */
const AGE_MAX_MIN = 360;        /* au-dela, ce n'est plus un jeton neuf */
const SEUIL = 55;               /* la note qu'il faut atteindre pour entrer */
const POSITIONS_MAX = 6;        /* jamais plus a la fois : au-dela on ne mesure plus rien */
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
const SURV_MAX = 300;           /* on ne garde pas la memoire de la terre entiere */

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
  pools:   { nom: 'GeckoTerminal · nouveaux pools', cout: 0, quoi: 'age, liquidite, capitalisation, achats et ventes' },
  profils: { nom: 'DexScreener · profils recents', cout: 0, quoi: 'des jetons neufs dont quelqu\'un a rempli la fiche' },
  boosts:  { nom: 'DexScreener · jetons pousses', cout: 0, quoi: 'des jetons dont quelqu\'un a paye la mise en avant' },
  chaine:  { nom: 'Chaine 4663 · noeud officiel', cout: 1, quoi: 'qui detient quoi, en soldant les transferts' },
  chaine2: { nom: 'Chaine 4663 · noeud dRPC', cout: 1, quoi: 'le meme, en secours quand l\'officiel sature (10 000 blocs max)' },
  goplus:  { nom: 'GoPlus · securite du contrat', cout: 1, quoi: 'honeypot, taxes, pouvoirs du proprietaire' },
  trades:  { nom: 'GeckoTerminal · les trades un par un', cout: 1, quoi: 'quels portefeuilles achetent, et pour combien' },
  dex:     { nom: 'DexScreener · second avis', cout: 1, quoi: 'un deuxieme prix, les autres pools, les reseaux sociaux' },
  ohlcv:   { nom: 'GeckoTerminal · chandelles', cout: 1, quoi: 'la volatilite reellement observee' },
  conseil: { nom: 'Anthropic · Claude Haiku', cout: 1,
             quoi: 'un avis sur les cas limites, borne a 8 points et jamais sur un veto' },
};

/* ---- CE QUI A ETE ESSAYE ET QUI NE MARCHE PAS ----
 * Nomme, avec la raison mesuree. Une source absente sans explication laisse
 * croire qu'on n'y a pas pense ; celles-ci ont ete essayees, et le releve est
 * la. Elles restent ici pour qu'on ne les re-essaie pas tous les six mois en
 * croyant avoir trouve une idee neuve. */
const HORS_SERVICE = {
  gmgn: 'GMGN — 403 Cloudflare, y compris sur ethereum : c\'est une protection anti-robot, '
      + 'pas une absence de la chaine 4663. Il faudrait un navigateur, donc non depuis le serveur.',
  blockscout: 'Blockscout robinhood — challenge Cloudflare sur l\'API comme sur les pages.',
  honeypotis: 'honeypot.is — ne connait pas la chaine 4663 (aucune simulation possible).',
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
    mission: 'Ratisse trois flux, et ecarte tout de suite ce qui est deja vide',
    traits: ['age', 'liq', 'origine'] },
  { key: 'warden', nom: 'Warden', emoji: '🛡️', couleur: '#9b6cf0', role: 'garde', ordre: 1,
    mission: 'Controle le contrat : honeypot, taxes, pouvoirs du proprietaire',
    traits: ['taxe', 'code', 'pouv'] },
  { key: 'whale', nom: 'Whale-Watch', emoji: '🐋', couleur: '#e8552d', role: 'garde', ordre: 2,
    mission: 'Solde les transferts dans les blocs : qui detient, et combien',
    traits: ['top', 'det', 'brule'] },
  { key: 'whisper', nom: 'Whisper', emoji: '📡', couleur: '#1fb7a8', role: 'garde', ordre: 3,
    mission: 'Lit les trades un par un : qui achete vraiment, et pour combien',
    traits: ['press', 'uniq', 'accel', 'flux', 'achUniq', 'taille'] },
  { key: 'oracle', nom: 'Oracle', emoji: '🔮', couleur: '#f2b21e', role: 'note', ordre: 4,
    mission: 'Note, apprend de chaque position fermee, et tranche',
    traits: ['mc', 'elan', 'vola', 'accord', 'social', 'pools'] },
  { key: 'conseiller', nom: 'Conseiller', emoji: '🧠', couleur: '#b98cff', role: 'conseil', ordre: 5,
    mission: 'Donne un avis sur les cas limites, et repond de ses avis comme les autres',
    traits: ['avis'] },
  { key: 'sentinelle', nom: 'Sentinelle', emoji: '🔭', couleur: '#c9a227', role: 'veille', ordre: 6,
    mission: 'Surveille chaque position ouverte et coupe quand le sol se derobe',
    traits: ['derive', 'liq'] },
  { key: 'promoteur', nom: 'Promoteur', emoji: '⏳', couleur: '#7fb3ff', role: 'prolonge', ordre: 7,
    mission: 'Decide de prolonger une position qui monte, et apprend de SA decision',
    traits: ['gain', 'note', 'fois'] },
  { key: 'banquier', nom: 'Banquier', emoji: '🏦', couleur: '#5ad1a0', role: 'banque', ordre: 8,
    mission: 'Choisit la mise selon la caisse du moment, et apprend quelle methode paie',
    traits: ['methode', 'regime'] },
  { key: 'closer', nom: 'Closer', emoji: '💰', couleur: '#e83e8c', role: 'execution', ordre: 9,
    mission: 'Ouvre au prix reel, tient la duree qu\'il a apprise, ferme au prix reel',
    traits: ['tenue'] },
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
    seuil: SEUIL, derniers: [], depuisAjustement: 0,
    /* la structure, qui est une donnee et non du code */
    roster: rosterNeuf(), ordreRevu: 0, journalStructure: [],
    /* ce qu'on a deja juge, pour ne pas le rejuger en boucle */
    connus: {},
    /* le releve de chaque service */
    services: {},
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
      txt: 'Tout est reparti de zero : la tresorerie enregistree ($'
         + Math.round(brut.tresor || 0) + ') venait d\'un prix relu aberrant, pas d\'un marche. '
         + 'Un chiffre faux ne se repare pas — et tout ce qui en descendait etait faux avec lui.' }];
    sauve();
    return;
  }
  const n = etatNeuf();
  for (const k of Object.keys(n)) if (!(k in brut)) brut[k] = n[k];
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
    if (!brut.roster.some((a) => a && a.key === base.key)) brut.roster.push(JSON.parse(JSON.stringify(base)));
  }
  brut.roster = brut.roster.filter((a) => a && a.key && Array.isArray(a.traits));
  E = brut;
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
function noteService(nom, ok, detail) {
  const s = E.services[nom] || (E.services[nom] = { essais: 0, reussites: 0, dernier: 0, dernierEchec: null });
  s.essais++;
  if (ok) { s.reussites++; s.dernier = Date.now(); s.dernierEchec = null; }
  else s.dernierEchec = String(detail || 'echec').slice(0, 80);
}

/* ------------------------------------------------------------- les lectures */
const nn = (v) => { const x = parseFloat(v); return isNaN(x) ? 0 : x; };
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
const NOEUDS = [
  { url: RPC_RH, cle: 'chaine', plageLogs: BLOCS_PLAFOND, dernier: 0 },
  { url: RPC_SECOURS, cle: 'chaine2', plageLogs: 10000, dernier: 0 },
];
/* La plage demandee par un `eth_getLogs`, pour savoir quel noeud peut la
   servir. Une demande qu'on sait refusee n'est pas envoyee. */
function plageDe(methode, params) {
  if (methode !== 'eth_getLogs') return 0;
  const f = params && params[0];
  if (!f || !f.fromBlock || !f.toBlock) return 0;
  const a = parseInt(f.fromBlock, 16), b = parseInt(f.toBlock, 16);
  return (isFinite(a) && isFinite(b)) ? Math.max(0, b - a) : 0;
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
  if (!r.ok) throw new Error('rpc ' + r.status);
  if (!j) throw new Error('rpc illisible');
  if (j.error) throw new Error(String(j.error.message || 'rpc').slice(0, 60));
  return j.result;
}
/* On essaie les noeuds capables, dans l'ordre. Un refus pour saturation passe
   au suivant — c'est la seule facon d'avoir un second noeud qui serve a
   quelque chose. Un echec de tous reste un echec : il rend « inconnu ». */
async function rpc(methode, params) {
  const plage = plageDe(methode, params);
  const capables = NOEUDS.filter((n) => plage <= n.plageLogs);
  if (!capables.length) throw new Error('aucun noeud ne sert une plage de ' + plage + ' blocs');
  let derniere = null;
  for (let tour = 0; tour < 2; tour++) {
    for (const n of capables) {
      try {
        const r = await unNoeud(n, methode, params);
        noteService(n.cle, true);
        return r;
      } catch (e) {
        derniere = e;
        noteService(n.cle, false, e.coupe ? 'sature' : e.message);
        if (!e.coupe) break;          /* une vraie erreur ne se resout pas en reessayant */
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
    try { d = await json(GT + '/new_pools?include=base_token&page=' + page, { headers: ENTETES });
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
        pool: a.address, origine: 'pools',
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
    const j = await json('https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=' + t.addr);
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
  t.g = garde(CACHE.goplus, t.addr, {
    have: info.is_honeypot !== undefined || info.holder_count !== undefined || info.is_open_source !== undefined,
    honeypot: su(info.is_honeypot), cannotBuy: su(info.cannot_buy), pausable: su(info.transfer_pausable),
    ownerBal: su(info.owner_change_balance), selfd: su(info.selfdestruct),
    perslip: su(info.personal_slippage_modifiable), hpSame: su(info.honeypot_with_same_creator),
    slipMod: su(info.slippage_modifiable), cooldown: su(info.trading_cooldown), proxy: su(info.is_proxy),
    mintable: su(info.is_mintable),
    taxeSue: info.buy_tax !== undefined && info.buy_tax !== '',
    buyTax: Math.round(nn(info.buy_tax) * 100), sellTax: Math.round(nn(info.sell_tax) * 100),
    detSue: info.holder_count !== undefined, holders: parseInt(info.holder_count) || 0,
    topSu: hs.length > 0, top: Math.round(top * 10) / 10, lp: Math.round(lp),
    codeSu: info.is_open_source !== undefined, unverified: info.is_open_source === '0',
  });
}

async function lisOhlcv(pool) {
  const c = frais(CACHE.ohlcv, pool, TTL_OHLCV); if (c !== null) return c;
  try {
    const j = await json(GT + '/pools/' + pool + '/ohlcv/minute?aggregate=15&limit=24', { headers: ENTETES });
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
        logs = await rpc('eth_getLogs', [{
          address: addr, topics: [SUJET_TRANSFERT],
          fromBlock: '0x' + Math.max(0, bloc - large).toString(16), toBlock: '0x' + bloc.toString(16) }]);
        break;
      } catch (e) { derniere = e; }
    }
    if (logs === null) throw derniere || new Error('logs illisibles');
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
    for (const a in solde) {
      if (brulures.has(a)) continue;
      const v = solde[a];
      if (v <= 0) continue;
      const cp = contreparties[a] ? contreparties[a].size : 0;
      if (cp >= seuilPiscine && envoyeurs[a] && receveurs[a]) { infrastructure.push(a); continue; }
      circ += v; np++;
      if (v > mx) { mx = v; gros = a; }
    }
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
      plusGros: gros,
      /* Ce qu'on a ecarte, et pourquoi : sans ca, « 12 porteurs » est un
         chiffre qu'on ne peut pas contester. */
      infra: infrastructure.length, participants,
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
    pool: d.pool, origine,
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
    const j = await json(GT + '/pools/' + pool + '/trades?trade_volume_in_usd_greater_than=0',
                         { headers: ENTETES });
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
function memLit(a, t, v) { const m = E.memoire; return (m[a] && m[a][t] && m[a][t][v]) || null; }
function memCase(a, t, v) {
  const m = E.memoire;
  if (!m[a]) m[a] = {};
  if (!m[a][t]) m[a][t] = {};
  if (!m[a][t][v]) m[a][t][v] = { n: 0, s: 0, s2: 0 };
  if (m[a][t][v].s2 === undefined) m[a][t][v].s2 = 0;   /* une case d'avant la variance */
  return m[a][t][v];
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

function ajustementAgent(agent, cases) {
  if (!cases) return 0;
  let somme = 0, vus = 0;
  for (const k in cases) {
    const c = memLit(agent, k, cases[k]);
    if (!c || !c.n) continue;
    /* ---- UNE CASE QUI NE PREDIT RIEN NE PESE PAS ----
     * Sa moyenne peut etre flatteuse ; si les resultats sont partout, elle est
     * le fruit du hasard. On la degonfle par sa propre dispersion plutot que
     * de la laisser tirer la note. */
    const sd = ecartType(c);
    const fiable = sd === null ? 1 : Math.max(0.25, Math.min(1, ECART_TYPE_BRUIT / Math.max(1, sd)));
    somme += confiance(c.n) * fiable * Math.max(-30, Math.min(30, c.s / c.n));
    vus++;
  }
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
    const c = m[t][v];
    if (c.n < 2) continue;
    const moy = c.s / c.n;
    const sd = ecartType(c);
    out.push({ quoi: v, n: c.n, moyenne: Math.round(moy * 10) / 10,
               ecart: sd === null ? null : Math.round(sd * 10) / 10,
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
const ROLES_A_PART = ['banque', 'execution', 'veille', 'prolonge'];
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
    raison: 'caisse sous le plancher de $' + PLANCHER + ' : on arrete d\'ouvrir', arret: true };

  let part = partDeLaMethode(ch.methode, score);
  if (ch.methode === 'kelly' && !statsRendement()) raisons.push('Kelly sans releve suffisant : part de base');

  let mise = E.tresor * part;
  const plafondUn = E.tresor * MISE_PART_MAX;
  if (mise > plafondUn) { mise = plafondUn; raisons.push('borne a ' + (MISE_PART_MAX * 100) + ' % de la caisse'); }
  const restant = E.tresor * EXPO_PART_MAX - engage;
  if (mise > restant) { mise = restant; raisons.push('exposition totale bornee a ' + (EXPO_PART_MAX * 100) + ' %'); }
  if (mise < MISE_MIN) {
    if (restant < MISE_MIN) return { mise: 0, methode: ch.methode, regime: ch.regime,
      raison: 'deja ' + Math.round(engage) + '$ engages : plus de place sous la borne d\'exposition' };
    mise = MISE_MIN; raisons.push('remontee au minimum de $' + MISE_MIN);
  }
  if (mise > E.tresor) { mise = E.tresor; raisons.push('bornee a la caisse'); }
  mise = Math.round(mise * 100) / 100;
  return { mise, methode: ch.methode, appris: ch.appris, regime: ch.regime,
           part: Math.round(part * 10000) / 100,
           raison: raisons.length ? raisons.join(' · ') : 'methode ' + ch.methode + ' en regime « ' + ch.regime + ' »' };
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
  if (g.cannotBuy) return 'achat impossible';
  if (g.ownerBal) return 'le proprietaire reecrit les soldes';
  if (g.selfd) return 'auto-destruction';
  if (g.perslip) return 'taxe par portefeuille';
  if (g.hpSame) return 'createur deja honeypot';
  if (g.pausable) return 'transferts suspendables';
  if (g.taxeSue && g.sellTax > 10) return 'taxe vente ' + g.sellTax + '%';
  if (g.taxeSue && g.buyTax > 15) return 'taxe achat ' + g.buyTax + '%';
  return null;
}
function vetoWhale(t) {
  const ch = t.chaine || {}, g = t.g || {};
  if (ch.personne) return ch.recepteurs + ' adresses ont touche le jeton, aucune ne le garde';
  const top = (ch.vu && ch.top !== null && ch.top !== undefined) ? ch.top : (g.topSu ? g.top : null);
  if (top !== null && top >= 50) return 'un porteur tient ' + top.toFixed(0) + '% du circulant';
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
    return 'un seul portefeuille fait ' + x.partDuPlusGros.toFixed(0) + '% du volume';
  if (x.acheteurs === 0 && x.achats > 0)
    return 'des achats sans acheteur identifiable';
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
function vetoScout(t) {
  const v = t.vol || {}, mc = t.mc || 0, liq = t.liq || 0;
  if (t.ch_h1 <= -60) return 'deja tombe de ' + Math.round(-t.ch_h1) + '% en une heure';
  if (t.ch_h6 <= -80) return 'deja tombe de ' + Math.round(-t.ch_h6) + '% en six heures';
  /* Le cas signale : deux mille de capitalisation, un gros volume dessus. */
  if (mc > 0 && mc < 20000 && v.h1 > mc * 2)
    return 'volume de $' + Math.round(v.h1) + ' sur une capitalisation de $' + Math.round(mc)
         + ' : ce n\'est plus un marche, c\'est une sortie';
  /* Et une piscine qui ne represente presque plus rien de la capitalisation :
     il n'y a plus de quoi sortir, quel que soit le prix affiche. */
  if (mc > 50000 && liq > 0 && liq < mc * 0.01)
    return 'piscine de $' + Math.round(liq) + ' pour une capitalisation de $' + Math.round(mc)
         + ' : rien a vendre dedans';
  return null;
}
const VETOS = { scout: vetoScout, warden: vetoWarden, whale: vetoWhale, whisper: vetoWhisper };

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
  return s.concat(g, o);
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
  const base = scoreBase(t);
  const parts = {};
  let adj = 0;
  for (const k of apprenants()) {
    parts[k] = Math.round(ajustementAgent(k, tr[k]) * 10) / 10;
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
function journal(quoi, txt, chiffres) {
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
  journal('ordre', 'Nouvel ordre des gardes : ' + apres + ' (avant : ' + avant + ')',
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
    mission: 'Recoupe « ' + flou.valeur +' » par ' + compagnon
           + ' : la coupe du ' + flou.parent.nom.split('-')[0] + ' y est trop dispersee',
    traits: [croise],
  };
  E.roster.push(petit);
  journal('naissance', petit.nom + ' nait : « ' + flou.valeur + ' » est vue ' + flou.n
    + ' fois avec un ecart type de ' + Math.round(flou.sd) + ' points — cette case ne predit rien',
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
    journal('retrait', petit.nom + ' est retire : ecart type ' + Math.round(sien)
      + ' contre ' + Math.round(pere) + ' pour la case de son parent — il ne coupe pas mieux',
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
const REFUS_DEFINITIFS = /honeypot|achat impossible|proprietaire reecrit|auto-destruction|taxe par portefeuille|createur deja|suspendables|taxe vente|taxe achat/;

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
  if (!c) return { oui: true, pourquoi: 'jamais vu' };
  if (c.permanent) return { oui: false, pourquoi: 'banni : ' + c.verdict };
  const depuis = Date.now() - (c.dernier || 0);
  if (depuis >= SURV_MIN_MS) return { oui: true, pourquoi: 'revu apres ' + Math.round(depuis / 60000) + ' min' };
  if (c.liq > 0 && t.liq >= c.liq * SURV_LIQ)
    return { oui: true, pourquoi: 'liquidite +' + Math.round((t.liq / c.liq - 1) * 100) + '%' };
  if (c.prix > 0 && t.prix >= c.prix * SURV_PRIX)
    return { oui: true, pourquoi: 'prix +' + Math.round((t.prix / c.prix - 1) * 100) + '%' };
  return { oui: false, pourquoi: 'deja juge il y a ' + Math.round(depuis / 60000) + ' min, rien n\'a bouge' };
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
  if (r <= CHUTE_COUPE) return 'chute de ' + Math.round(-r) + '% depuis l\'entree';
  if (p.liq0 > 0 && x.liq > 0 && x.liq < p.liq0 * LIQ_COUPE)
    return 'la piscine est passee de $' + Math.round(p.liq0) + ' a $' + Math.round(x.liq);
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
  const tenue = tenueApprise();
  E.positions.push({
    sym: t.sym, adr: t.addr, pool: t.pool, prix0: t.prix, t0: Date.now(),
    mise: b.mise, methode: b.methode, regime: b.regime, raisonMise: b.raison,
    liq0: t.liq || 0, tenueBase: tenue.min,
    mcAchat: Math.round(t.mc || 0), liens: (t.dex && t.dex.vu) ? (t.dex.liens || []) : null,
    traits: t.an.traits, score: t.an.score, mc: t.mc, minutes: Math.round(t.minutes || 0),
    origine: t.origine || 'pools', tenueMin: tenue.min, traj: [],
  });
  E.ouvertures++;
  compte('closer');
  compte('banquier');
  E.flux.unshift({ sym: t.sym, pool: t.pool, tag: 'open',
                   txt: 'OUVERT · $' + b.mise.toFixed(2) + ' · ' + b.methode, cls: 'n', t: Date.now() });
  return true;
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

function ferme(p, prix, quand, comment) {
  let r = (prix - p.prix0) / p.prix0 * 100;
  let aberrant = null;
  if (!isFinite(r) || r > REND_MAX || r < REND_MIN) {
    aberrant = (isFinite(r) ? (r > 0 ? '+' : '') + Math.round(r) + '%' : 'non calculable')
             + ' entre ' + p.prix0 + ' et ' + prix;
    r = 0;   /* la mise est rendue : on ne gagne ni ne perd sur une lecture qu'on rejette */
  }
  const pnl = p.mise * r / 100;
  E.tresor += pnl;
  E.trades++;
  if (pnl > 0) E.gains++;
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
  /* Le Closer apprend une DUREE — depuis la trajectoire reelle de la position,
     c'est-a-dire les prix qu'on a vraiment releves pendant qu'elle etait
     ouverte. */
  const vus = {};
  if (aberrant) { E.flux.unshift({ sym: p.sym, pool: p.pool, tag: 'cut',
      txt: 'prix inexploitable (' + aberrant + ') · mise rendue, rien compte',
      cls: 'n', t: quand, tenue: quand - p.t0 });
    compte('prixAberrant');
    E.courbe.push(Math.round(E.tresor * 100) / 100);
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
  const suffixe = par === 'sentinelle' ? '  ·  coupe : ' + comment.raison
                : (p.prolonge ? '  ·  prolongee ' + p.prolonge + '×' : '');
  E.flux.unshift({ sym: p.sym, pool: p.pool, tag: pnl >= 0 ? 'buy' : 'cut',
    txt: (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2) + '  ·  ' + (r >= 0 ? '+' : '') + r.toFixed(1) + '%'
       + suffixe,
    cls: pnl >= 0 ? 'up' : 'dn', t: quand, tenue: quand - p.t0, par: par || 'closer' });
  if (par === 'sentinelle') compte('sentinelleCoupe');
  E.courbe.push(Math.round(E.tresor * 100) / 100);
}

/* `marche` porte un prix et, quand on l'a, la liquidite. Un nombre nu est
   accepte : c'est la forme d'avant la Sentinelle, et un etat relu d'hier ne
   doit pas cesser de se regler parce que le format a change. */
function regle(marche) {
  const now = Date.now();
  let n = 0;
  E.positions = E.positions.filter((p) => {
    const brut = marche[p.adr];
    if (brut === undefined || brut === null) return true;
    const x = (typeof brut === 'number') ? { prix: brut, liq: 0 } : brut;
    if (!(x.prix > 0)) return true;               /* pas de prix : on attend */
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
        txt: 'PROLONGEE · ' + (r >= 0 ? '+' : '') + r.toFixed(1) + '% · ' + p.prolonge + 'e fois',
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
function revoitStrategie() {
  if ((E.depuisAjustement || 0) < AVANT_AJUSTEMENT) return false;
  const l = (E.derniers || []).slice(-FENETRE);
  if (l.length < AVANT_AJUSTEMENT) return false;
  const moy = l.reduce((a, b) => a + b, 0) / l.length;
  const gagnantes = l.filter((x) => x > 0).length;
  const taux = gagnantes / l.length;
  const avant = seuilCourant();
  let apres = avant, pourquoi = null;

  if (moy < -1 || taux < 0.35) {
    /* On accepte trop, et ca ne paie pas : on devient plus difficile. */
    apres = Math.min(SEUIL_MAX, avant + 5);
    pourquoi = 'les ' + l.length + ' dernieres positions rendent ' + moy.toFixed(1)
             + ' % en moyenne (' + Math.round(taux * 100) + ' % de gagnantes) : on se fait plus difficile';
  } else if (moy > 3 && taux > 0.55 && E.positions.length < POSITIONS_MAX) {
    /* Ca paie, et on n'a meme pas de quoi remplir les places : on s'ouvre un
       peu. Sans cette moitie-la, le seuil ne pourrait que monter, et la colonie
       finirait par ne plus jamais rien acheter. */
    apres = Math.max(SEUIL_MIN, avant - 3);
    pourquoi = 'les ' + l.length + ' dernieres rendent +' + moy.toFixed(1)
             + ' % (' + Math.round(taux * 100) + ' % de gagnantes) et il reste des places : on s\'ouvre';
  }
  E.depuisAjustement = 0;
  if (apres === avant || !pourquoi) return false;
  E.seuil = apres;
  journal('strategie', 'Seuil d\'entree ' + avant + ' → ' + apres + '. ' + pourquoi,
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

  const n1 = s('chaine'), n2 = s('chaine2');
  const echecs = (n1.essais - n1.reussites) + (n2.essais - n2.reussites);
  const total = n1.essais + n2.essais;
  if (total > 30 && echecs / total > 0.25)
    dis('haute', 'Les noeuds de la chaine refusent ' + Math.round(echecs / total * 100) + ' % des lectures',
      echecs + ' refus sur ' + total + ' appels. Chaque refus rend « inconnu » un jeton qu\'on aurait '
      + 'pu juger, et l\'inconnu ne rapporte jamais de points : le jeton est ecarte pour une raison '
      + 'qui n\'a rien a voir avec lui.',
      'Un acces RPC dedie a la chaine 4663 (une cle chez un fournisseur qui la sert) leverait la '
      + 'limite. Les deux noeuds publics utilises ici sont gratuits et se font couper.');

  const g = s('goplus');
  const muets = E.compteurs.goplusMuet || 0, vus = E.compteurs.scoutVu || E.compteurs.wardenVu || 0;
  if (vus > 40 && muets / vus > 0.6)
    dis('moyenne', 'GoPlus ne sait rien de ' + Math.round(muets / vus * 100) + ' % des jetons examines',
      'A deux minutes, un contrat n\'est pas encore indexe : ' + muets + ' jetons sur ' + vus
      + ' n\'ont aucune donnee de securite. Le controle du contrat ne peut alors rien affirmer, '
      + 'et il ne l\'affirme pas.',
      'Une seconde source de securite qui indexe plus vite. Aucune gratuite trouvee pour la chaine '
      + '4663 a ce jour — honeypot.is ne la connait pas, Blockscout est derriere Cloudflare.');

  if (!process.env.ANTHROPIC_API_KEY)
    dis('moyenne', 'Le Conseiller est eteint : aucune cle Anthropic',
      'Les agents jugent sur des regles et sur ce qu\'ils ont mesure. Un avis de modele sur les '
      + 'cas limites — ceux qui tombent a quelques points du seuil — n\'est pas disponible.',
      'Poser ANTHROPIC_API_KEY dans les variables Railway. Une seule cle suffit : le Conseiller '
      + 'n\'est appele que sur les cas limites, quelques fois par tour.');

  const budget = E.compteurs.budgetAtteint || 0;
  if (budget > 5)
    dis('basse', 'Le budget d\'appels a ete atteint ' + budget + ' fois',
      'Des jetons neufs ont attendu le tour suivant faute d\'appels disponibles dans le tour.',
      'C\'est la meme cause que la premiere alerte : plus de debit sur la chaine, et le budget suit.');

  const ab = E.compteurs.prixAberrant || 0;
  if (ab > 0)
    dis('haute', ab + ' position(s) fermees sur un prix inexploitable',
      'Le prix relu impliquait un mouvement impossible pour la piscine concernee. Rien n\'a ete '
      + 'comptabilise et personne n\'en a rien appris — mais la position, elle, est perdue de vue.',
      'C\'est le signe de jetons a tres faible decimale ou de piscines videes. Rien a fournir : '
      + 'c\'est note ici pour qu\'on sache que ca arrive, et combien de fois.');

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

const CONSEIL_SYSTEME =
  'Tu conseilles une colonie d\'agents qui evalue des jetons TRES JEUNES (quelques minutes) '
+ 'sur la chaine Robinhood 4663. Sa tresorerie est du papier : rien n\'est signe.\n\n'
+ 'On te donne UNIQUEMENT des mesures deja lues. Quand un champ vaut "inconnu", cela veut dire '
+ 'que le service n\'a pas repondu : ne devine JAMAIS sa valeur, et n\'en tire aucune conclusion '
+ 'favorable. Un inconnu n\'est pas un bon signe.\n\n'
+ 'Le risque dominant a cet age est le rug pull : une piscine videe, une concentration extreme, '
+ 'du volume fabrique par un seul portefeuille, un jeton deja tombe.\n\n'
+ 'Reponds UNIQUEMENT par un objet JSON, sans texte autour :\n'
+ '{"avis":"favorable"|"reserve"|"defavorable","points":<entier de -8 a 8>,"pourquoi":"<20 mots max>"}\n'
+ 'Sois severe : la colonie voit des centaines de jetons et n\'en garde que quelques-uns. '
+ 'En cas de doute, "reserve" avec 0 point.';

function fiche(t) {
  const c = t.chaine || {}, g = t.g || {}, x = t.trades || {}, d = t.dex || {}, h = (t.tx || {}).h1 || {};
  const ou = (v, s) => (v === null || v === undefined) ? 'inconnu' : (s ? s(v) : v);
  return {
    symbole: t.sym, age_minutes: Math.round(t.minutes || 0),
    trouve_par: t.origine || 'pools',
    liquidite_usd: Math.round(t.liq || 0),
    capitalisation_usd: Math.round(t.mc || 0),
    variation_5min_pct: t.ch_m5, variation_1h_pct: t.ch_h1,
    achats_1h: h.buys || 0, ventes_1h: h.sells || 0, acheteurs_1h: h.buyers || 0,
    porteurs_lus_dans_les_blocs: c.vu ? ou(c.porteurs) : 'inconnu',
    part_du_plus_gros_porteur_pct: c.vu ? ou(c.top) : 'inconnu',
    part_brulee_pct: c.vu ? ou(c.brule) : 'inconnu',
    adresses_ecartees_comme_piscine: c.vu ? (c.infra || 0) : 'inconnu',
    securite_du_contrat: g.have ? {
      taxe_achat_pct: g.taxeSue ? g.buyTax : 'inconnu',
      taxe_vente_pct: g.taxeSue ? g.sellTax : 'inconnu',
      code_verifie: g.codeSu ? !g.unverified : 'inconnu',
      emission_possible: g.mintable, contrat_proxy: g.proxy,
    } : 'inconnu — le contrat est trop jeune pour etre indexe',
    trades_lus: x.vu ? {
      nombre: x.n, acheteurs_distincts: x.acheteurs,
      part_du_plus_gros_portefeuille_pct: x.partDuPlusGros, ticket_moyen_usd: x.moyen,
    } : 'inconnu',
    reseaux_sociaux: d.vu ? d.socials : 'inconnu',
    nombre_de_pools: d.vu ? d.pools : 'inconnu',
    note_de_la_colonie: t.an ? t.an.score : null,
    seuil_pour_acheter: seuilCourant(),
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
        system: 'Tu observes une colonie d\'agents qui evalue des jetons tres jeunes. Sa tresorerie '
              + 'est du papier. On te donne son releve. Dis en UNE phrase (30 mots max) ce qui te '
              + 'parait le plus discutable dans sa facon de faire, en citant un chiffre du releve. '
              + 'Pas de conseil general, pas de politesse. Si tout semble coherent, dis-le.',
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
async function assure(t, besoins) {
  for (const b of besoins) {
    if (t.lu[b]) continue;
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
  return [...parAdresse.values()];
}

async function tour() {
  if (enCours) return;
  enCours = true;
  try {
    E.tours = (E.tours || 0) + 1;
    E.toursDepuisOrdre = (E.toursDepuisOrdre || 0) + 1;
    /* ---- RIEN DE VIEUX N'ENTRE ----
     * Le but est d'analyser du NEUF. Un seul jeton etabli dans le pipeline
     * suffit a fausser ce que les agents apprennent. */
    const liste = (await rassemble())
      .filter((t) => t.liq >= 500 && t.prix > 0)
      .filter((t) => t.minutes !== null && t.minutes <= AGE_MAX_MIN)
      .sort((a, b) => a.minutes - b.minutes);
    if (!liste.length) throw new Error('aucun jeton neuf assez liquide');

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
      if (d.vu && d.prix > 0) { prix[p.adr] = { prix: d.prix, liq: d.liq || 0 }; posePrix(p.adr, d.prix); }
      await dors(250);
    }
    if (secours) compte('prixDeSecours', secours);

    const fermees = regle(prix);

    /* ---- CE QU'ON NE REPAIE PAS ----
     * Les bannis sortent sans un appel. Les deja-juges dont rien n'a bouge
     * aussi. Le budget d'appels va aux jetons qu'on n'a jamais vus — ce qui,
     * a budget constant, en fait examiner davantage. */
    const aVoir = [], ecartes = [];
    for (const t of liste) {
      const d = doitExaminer(t);
      if (d.oui) aVoir.push(t); else ecartes.push({ sym: t.sym, pourquoi: d.pourquoi });
      if (aVoir.length >= 10) break;
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
        if (!an.achete) { refus = 'note trop basse'; quiRefuse = 'oracle'; compte('oracleBloque'); }
      } else {
        /* Refuse avant la note : on la calcule quand meme pour la
           surveillance, sur ce qu'on a lu — elle dira si ca valait la peine
           d'y revenir. Rien n'est invente : les champs non lus restent
           inconnus, et l'inconnu ne rapporte pas de points. */
        an = analyse(t);
        t.an = an;
      }
      noteConnu(t, refus, an.score);
      examines.push({ t, refus, quiRefuse, an });
      if (!refus && ouvre(t)) ouvertes++;
      await dors(200);
    }

    /* ---- ET LA COLONIE SE REORGANISE ----
     * Apres avoir mesure, pas avant. */
    revoitOrdre(false);
    revoitStrategie();
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
      acheteurs: x.t.trades && x.t.trades.vu ? x.t.trades.acheteurs : null,
      partDuPlusGros: x.t.trades && x.t.trades.vu ? x.t.trades.partDuPlusGros : null,
      tradesVus: !!(x.t.trades && x.t.trades.vu),
    }));
    E.evites = ecartes.slice(0, 10);
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
    cadence: CADENCE_MS,
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
               liens: p.liens || null, prolonge: p.prolonge || 0,
               ouverteDepuis: Date.now() - p.t0, tenueMin: p.tenueMin,
               mise: p.mise, methode: p.methode, regime: p.regime, raisonMise: p.raisonMise,
               origine: p.origine || 'pools',
               latent: r === null ? null : Math.round(r * 10) / 10,
               gainLatent: r === null ? null : Math.round(p.mise * r) / 100,
               prixVu: dernierPrix[p.adr] ? dernierPrix[p.adr].t : 0 };
    }),
    candidats: E.candidats,
    evites: E.evites || [],
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
    journalStructure: (E.journalStructure || []).slice(0, 8),
    agents,
    /* ---- LE BANQUIER ---- */
    banque: {
      methode: b.methode, appris: !!b.appris, regime: b.regime,
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
          l.push({ regime: cle.split('|')[1], n: c.n, moyenne: Math.round(c.s / c.n * 10) / 10 });
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
    horsService: HORS_SERVICE,
    conseiller: { actif: conseillerActif(), modele: CONSEIL_MODELE,
                  poids: CONSEIL_POIDS, parTour: CONSEIL_MAX_PAR_TOUR,
                  rendus: E.compteurs.conseilRendu || 0 },
    seuil: seuilCourant(), seuilDepart: SEUIL, ageMax: AGE_MAX_MIN,
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
    txt: 'Remise a zero demandee' + (pourquoi ? ' : ' + String(pourquoi).slice(0, 120) : '')
       + '. Tresorerie avant : $' + Math.round(avant) + '.' }];
  for (const k of Object.keys(dernierPrix)) delete dernierPrix[k];
  for (const c of Object.keys(CACHE)) for (const k of Object.keys(CACHE[c])) delete CACHE[c][k];
  sauve();
  return true;
}

let minuteur = null;
function demarre() {
  charge();
  if (minuteur) return;
  /* Un premier tour tout de suite, puis la cadence. Au demarrage du serveur,
     les positions en cours se reglent au prix du moment — le temps ecoule est
     du temps reel, meme si personne ne regardait. */
  tour();
  minuteur = setInterval(tour, CADENCE_MS);
  if (minuteur.unref) minuteur.unref();
}
function arrete() { if (minuteur) { clearInterval(minuteur); minuteur = null; } }

module.exports = {
  demarre, arrete, vue, tour, charge, sauve,
  /* exposes pour l'essai : ce sont eux qui portent les regles */
  scoreBase, analyse, traitsDe, tenueApprise, leconsDe, apprendAgent, ajustementAgent, ecartType,
  regle, ouvre, ferme, etatNeuf, litTrait, besoinsDe, coutDe, gardesEnOrdre,
  miseDe, methodeApprise, banquierApprend, regime, statsRendement,
  revoitOrdre, engendre, elague, doitExaminer, noteConnu, surveilles,
  revoitStrategie, seuilCourant, noteResultat, alertes, remiseAZero, nObs,
  casSentinelle, dangerSentinelle, veutProlonger, casPromoteur, prixFrais, posePrix,
  lisTrades, lisFluxDex, jetonDepuisDex, rassemble,
  FICHIER, SEUIL, AGE_MAX_MIN, MISE, DEPART, METHODES, SERVICES, HORS_SERVICE,
  MISE_MIN, MISE_PART_MAX, EXPO_PART_MAX, PLANCHER, ENFANTS_MAX,
  ECART_TYPE_BRUIT, VARIANCE_MIN_OBS, ROSTER_DEPART, REORDONNABLES,
  VERSION_ETAT, SEUIL_MIN, SEUIL_MAX, REND_MAX, REND_MIN, CHUTE_COUPE, AGE_PRIX_MAX,
  _etat: () => E, _pose: (x) => { E = x; }, _cache: CACHE, _prix: dernierPrix, _rpc: rpc,
};
