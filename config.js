'use strict';
// Central config. Everything overridable via environment variables so the same
// code runs locally (defaults) and on Railway (env vars).
// env() trims whitespace/newlines — pasting a key/address with a trailing
// line break into Railway is a classic footgun, so we scrub it here.
var env = function (name, def) { var v = process.env[name]; return (v === undefined ? def : String(v).trim()); };

/* ================== LA TABLE DES SALLES A ECRAN ==================
 *
 * Le Nexus a trois salles qui projettent : le cinema, la salle manga et la
 * salle series. Chacune tient sa propre galerie de seances, et c'est
 * exactement la meme mecanique a chaque fois — meme nettoyage d'adresse, meme
 * plafond, meme journal, meme panneau.
 *
 * ---- LE DEFAUT QU'ON EVITE ----
 *
 * Recopier cette mecanique une fois par salle aurait pose trois verites. Le
 * jour ou l'on durcit le filtre des adresses, on le durcit dans la salle qu'on
 * a sous les yeux et l'on oublie les deux autres : il suffit alors de poser la
 * seance dans la salle la moins surveillee. Une regle de securite qui a
 * plusieurs chemins n'en a aucun.
 *
 * Cette table est donc la SEULE declaration. L'etat, les routes, le fil et les
 * panneaux du tableau de bord en DECOULENT. Ajouter une quatrieme salle est
 * une ligne ici, et rien d'autre — ni dans server.js, ni dans admin.js.
 *
 * ---- POURQUOI LA CLE EST BORNEE ----
 *
 * Elle sert d'identifiant HTML dans le panneau et de cle d'etat dans la
 * sauvegarde. Une cle portant un guillemet casserait la page, une cle portant
 * un point casserait la relecture, et aucune des deux ne se verrait avant que
 * le proprietaire ouvre l'onglet.
 *
 * ---- POURQUOI LE NOM PERD QUATRE CARACTERES ----
 *
 * Le tableau de bord entier est construit dans un GABARIT DE CHAINE, et la
 * table y descend telle quelle. Un accent grave ferme le gabarit ; un
 * antislash est mange avant que le navigateur voie le texte ; un chevron
 * refermerait le bloc de script depuis l'interieur d'une chaine. Chacun a de
 * quoi tuer les mille cinq cents lignes du panneau d'un seul caractere, sans
 * que rien ne le dise — c'est deja arrive deux fois.
 */
var SALLES_DEFAUT = 'cinema:Cinema - SWOGE FLIX|manga:Salle manga|series:Salle series';
function lisSalles(brut) {
  var v = String(brut || '').split('|').map(function (bloc) {
    var i = bloc.indexOf(':');
    if (i < 0) return null;
    var cle = bloc.slice(0, i).trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    var nom = bloc.slice(i + 1).trim().replace(/[`\\<>]/g, '').slice(0, 60);
    if (!cle || !nom) return null;
    return { cle: cle, nom: nom };
  });
  /* Une cle en double donnerait DEUX panneaux ecrivant dans la meme galerie :
     celui du bas semblerait effacer le travail de celui du haut, et le
     proprietaire chercherait la panne dans le serveur. On garde le premier. */
  return v.filter(function (s, i) {
    if (!s) return false;
    for (var j = 0; j < i; j++) if (v[j] && v[j].cle === s.cle) return false;
    return true;
  });
}
function sallesEcran(brut) {
  var v = lisSalles(brut);
  /* Une variable d'environnement mal ecrite ferait DISPARAITRE toutes les
     salles — le hall garderait ses ecrans et le panneau n'aurait plus rien
     pour les remplir. On retombe donc sur la table d'origine plutot que sur
     rien du tout. */
  return v.length ? v : lisSalles(SALLES_DEFAUT);
}

module.exports = {
  PORT: parseInt(env('PORT', '8080'), 10),

  // Where the persistent game state (balances etc.) is written. On Railway,
  // mount a VOLUME at this path so it survives redeploys/restarts.
  DATA_DIR: env('DATA_DIR', './data'),
  SAVE_MS: parseInt(env('SAVE_MS', '10000'), 10),

  // Password for the private /admin dashboard + /stats (?key=…). Empty = open
  // (fine for local dev; ALWAYS set it in production).
  ADMIN_KEY: env('ADMIN_KEY', ''),

  // ---- Chain ----
  RPC_URL: env('RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: parseInt(env('CHAIN_ID', '4663'), 10),
  SWOGE_TOKEN: env('SWOGE_TOKEN', '0x8a166Fb41Cd659a0a43396272FF73973Ce29F817'),
  VAULT_ADDRESS: env('VAULT_ADDRESS', ''), // set after deploying SwogePusherVault
  // One-time recovery: on the FIRST run (no saved state), scan Deposit events
  // from this block instead of the chain tip, so deposits made before
  // persistence existed are re-credited. Set it once to the Vault's deploy
  // block, then leave it — seenTx dedupes and the contract caps withdrawals.
  SCAN_FROM_BLOCK: parseInt(env('SCAN_FROM_BLOCK', '0'), 10),
  // Backend signer key = the `signer` set in the Vault. Authorizes withdrawals.
  // NEVER commit a real key. Set SIGNER_PRIVATE_KEY on Railway.
  SIGNER_PRIVATE_KEY: env('SIGNER_PRIVATE_KEY', ''),
  DEPOSIT_POLL_MS: parseInt(env('DEPOSIT_POLL_MS', '6000'), 10),

  // ---- Economy ----
  DECIMALS: 18,
  DROP_COST: env('DROP_COST', '1'),         // $SWOGE per coin dropped
  /* Le minimum de retrait. Le coffre a le sien, en dur dans le contrat : ce
     nombre-ci ne peut qu'etre PLUS HAUT, jamais plus bas — un serveur plus
     souple que la chaine signerait des bons que la chaine refuserait. */
  MIN_WITHDRAW: env('MIN_WITHDRAW', '10000'),
  /* ---- le frais de retrait ----
   *
   * Il ne rembourse rien : le joueur paie lui-meme le gaz en presentant son
   * bon au coffre, un retrait ne coute donc rien a la maison. C'est de la
   * marge, et il faut l'assumer comme telle — d'ou la regle qui suit.
   *
   * IL EST BRULE. C'est tout le raisonnement : un pour cent qui part dans la
   * poche de la maison est une taxe, et se raconte comme telle. Le meme un
   * pour cent retire de la circulation est une REDUCTION D'OFFRE, dont
   * profitent tous les porteurs — celui qui retire compris. Pour un memecoin,
   * ce n'est plus un prelevement, c'est un argument.
   *
   * Techniquement le montant reste dans le coffre — il n'est verse a
   * personne — et le tableau de bord le compte a part : c'est le chiffre a
   * bruler. La promesse ne vaut que si le brulage a lieu ; ne pas le faire
   * reviendrait a prendre l'argent tout en disant le contraire.
   */
  WITHDRAW_FEE_BPS: parseInt(env('WITHDRAW_FEE_BPS', '100'), 10),   // 100 = 1 %
  /* L'adresse ou l'on brule. Rien ne peut en ressortir : personne n'a la cle,
     et c'est ce qui fait la difference entre « brule » et « mis de cote ». */
  BURN_ADDRESS: env('BURN_ADDRESS', '0x000000000000000000000000000000000000dEaD'),

  /* ---- la preuve d'equite ----
   *
   * Chaque manche est tiree par HMAC(graine du serveur, graine du joueur:numero).
   * Le joueur recoit d'avance l'EMPREINTE de la graine du serveur : elle
   * l'engage, puisqu'on ne peut plus changer la graine sans changer
   * l'empreinte.
   *
   * Mais une empreinte qu'on n'ouvre JAMAIS ne prouve rien. Tant que la graine
   * n'est pas revelee, le joueur ne peut recalculer aucune manche — il n'a
   * qu'une promesse. La graine tourne donc regulierement, et la PRECEDENTE est
   * publiee : chacun peut alors verifier que son empreinte correspond, et
   * refaire le calcul de chaque manche jouee sous elle.
   *
   * Pourquoi pas plus souvent : chaque rotation coupe la verification en
   * tranches et multiplie les graines a garder. Pourquoi pas plus rarement :
   * plus la periode est longue, plus le joueur attend avant de pouvoir
   * verifier ce qu'il a joue. Une semaine est le compromis d'usage.
   */
  FAIRNESS_ROTATE_HOURS: parseFloat(env('FAIRNESS_ROTATE_HOURS', '168')),
  FAIRNESS_GARDE: parseInt(env('FAIRNESS_GARDE', '104'), 10),   // deux ans de graines
  // L'adresse publique du serveur, pour que l'annonce de rotation porte un
  // lien cliquable vers les graines.
  PUBLIC_URL: env('PUBLIC_URL', 'https://web-production-220a3.up.railway.app'),

  /* ---- la sauvegarde hors machine ----
   *
   * state.json et son .bak vivent sur LE MEME volume. Cela protege d'une
   * ecriture ratee, de rien d'autre : si le volume disparait — demonte par
   * erreur au redeploiement, service supprime, incident chez l'hebergeur —
   * tous les soldes partent avec, et il n'y a rien pour reconstruire.
   *
   * Une archive quotidienne part donc sur un canal Telegram PRIVE. Elle
   * contient les adresses et les soldes de tous les joueurs : elle n'a rien a
   * faire dans le canal public des annonces. D'ou une variable separee — sans
   * elle on n'envoie rien du tout, plutot que de risquer une fuite qui ne se
   * rattrape pas.
   */
  TG_BACKUP_CHAT_ID: env('TG_BACKUP_CHAT_ID', ''),
  BACKUP_HEURES: parseFloat(env('BACKUP_HEURES', '24')),
  VOUCHER_TTL_SEC: parseInt(env('VOUCHER_TTL_SEC', '3600'), 10),

  // ---- Progressive jackpot ----
  // A slice of each drop (RAKE_PCT % of DROP_COST, taken from the house edge)
  // grows a shared pot. Every drop has a 1-in-ODDS provably-fair chance to win
  // the whole pot, which then resets to SEED. Average pot at win ≈ SEED +
  // rake×ODDS (defaults ≈ 100k, up to 1M+ on a long dry streak).
  JACKPOT_SEED: env('JACKPOT_SEED', '10000'),
  JACKPOT_RAKE_PCT: parseFloat(env('JACKPOT_RAKE_PCT', '3')),   // % of each drop → pot
  JACKPOT_ODDS: parseInt(env('JACKPOT_ODDS', '3000000'), 10),   // 1-in-N per drop
  LEADERBOARD_SIZE: parseInt(env('LEADERBOARD_SIZE', '10'), 10),

  /* ---- les cent niveaux ----
   *
   * L'experience, c'est le VOLUME MISE — et rien d'autre. Trois raisons :
   *
   *  1. il est deja compte, sur chaque fiche, depuis le premier jour. Le jour
   *     du deploiement, chacun a deja son vrai niveau, gagne pour de bon. Pas
   *     de « ca commence aujourd'hui », qui aurait puni les anciens ;
   *  2. il ne se triche pas : chaque point coute l'avantage de la maison.
   *     Farmer un niveau, c'est payer le casino ;
   *  3. il ne depend pas de la chance. Un classement au gain monte et descend
   *     sans qu'on ait rien change a sa facon de jouer.
   *
   * volume cumule pour le niveau n = 50 x n^4
   *   niveau  10 :         500 000
   *   niveau  34 :      66 816 800
   *   niveau  50 :     312 500 000
   *   niveau 100 :   5 000 000 000  — cinq fois l'offre totale en volume
   *                                   cumule, par un seul joueur.
   *
   * ---- pourquoi la puissance et non la base ----
   *
   * La courbe a ete durcie d'un facteur DIX au sommet : un joueur atteignait
   * le niveau 34 pour 11,5 millions de volume, ce qui rendait le haut de
   * l'echelle atteignable trop vite.
   *
   * Deux facons de multiplier par dix. Multiplier la BASE (50 -> 500) durcit
   * tout uniformement, y compris les dix premiers niveaux — ceux qui servent a
   * accrocher un joueur qui vient d'arriver. Monter la PUISSANCE (3,5 -> 4)
   * donne exactement le meme sommet, 5 milliards, mais laisse le debut
   * accessible : le niveau 10 passe de 158 000 a 500 000 et non a 1,58 million.
   * La difficulte monte donc progressivement, ce qui est la forme qu'on veut.
   *
   * Le niveau ne redescend JAMAIS — pas meme quand cette courbe change. Voir
   * NIVEAU_ACQUIS ci-dessous : sans lui, durcir la courbe retrograderait tout
   * le monde, ce qui est exactement la punition que le systeme evite.
   */
  NIVEAU_BASE: parseFloat(env('NIVEAU_BASE', '50')),
  NIVEAU_PUISSANCE: parseFloat(env('NIVEAU_PUISSANCE', '4')),
  NIVEAU_MAX: parseInt(env('NIVEAU_MAX', '100'), 10),
  /* Un niveau atteint est ACQUIS. Le joueur garde le plus haut niveau qu'il
     ait jamais eu, et progresse ensuite sur la courbe en vigueur.
     Mettre a 0 pour recalculer tout le monde sur la courbe courante — ce qui
     RETROGRADE les joueurs existants. A n'utiliser qu'en connaissance de
     cause, et jamais sans le dire aux joueurs. */
  NIVEAU_ACQUIS: env('NIVEAU_ACQUIS', '1') !== '0',
  /* La puissance en vigueur AVANT le durcissement. Elle ne sert qu'une fois,
     a la premiere lecture d'une fiche qui n'a pas encore de niveau acquis :
     elle permet de retrouver le niveau que le joueur avait vraiment atteint.
     Sans elle, la migration figerait tout le monde a son niveau NOUVEAU, donc
     retrograde — le contraire du but. */
  NIVEAU_PUISSANCE_AVANT: parseFloat(env('NIVEAU_PUISSANCE_AVANT', '3.5')),

  /* =====================================================================
   * L'XP — UNE MONNAIE DE PROGRESSION, SEPAREE DU VOLUME MISE
   * =====================================================================
   *
   * Le niveau etait une fonction PURE du volume mise. Une seule consequence,
   * mais elle decidait de tout : la seule facon de progresser etait de
   * depenser plus. Un joueur qui revient tous les jours, finit ses quetes et
   * complete une collection restait au niveau du premier jour.
   *
   * Sur un site ou l'on joue de l'argent reel, ce n'est pas seulement un
   * defaut de conception : une barre de progression visible qui n'avance
   * qu'en misant davantage est un mecanisme d'incitation a la mise. La
   * separer de la depense est la correction, et elle passe avant l'habillage.
   *
   * ---- POURQUOI LE VOLUME NE DISPARAIT PAS ----
   *
   * Il reste UNE source, plus la seule. Le supprimer retrograderait tous les
   * joueurs existants d'un coup — exactement ce que NIVEAU_ACQUIS existe pour
   * empecher. Il est converti en XP par une courbe qui rend, pour un joueur
   * qui n'aurait QUE du volume, EXACTEMENT le niveau qu'il avait avant. La
   * bascule ne donne ni ne reprend un seul niveau ; tout ce qui s'ajoute est
   * du gain.
   *
   * ---- POURQUOI LE FACTEUR DE CONVERSION SE CALCULE ----
   *
   * On veut  (xp/XP_BASE)^(1/XP_PUISSANCE) = (v/NIVEAU_BASE)^(1/NIVEAU_PUISSANCE)
   * donc     xp = XP_BASE * (v/NIVEAU_BASE)^(XP_PUISSANCE/NIVEAU_PUISSANCE).
   *
   * Ecrit en dur, ce facteur serait juste aujourd'hui et faux au premier
   * reglage de courbe — et il serait faux EN SILENCE, en deplacant le niveau
   * de tout le monde. Il est donc derive des quatre autres nombres, et il
   * reste juste quoi qu'on leur fasse.
   *
   * ---- OU EST LA FACILITE ----
   *
   * Pas dans un cadeau ponctuel, mais dans le RYTHME. Passer du niveau 20 au
   * 21 demandait 900 000 de mise supplementaire. Il demande maintenant
   * 4 100 XP, soit huit jours d'un joueur qui se connecte et fait ses quetes
   * — sans miser un jeton de plus. C'est la difference qui compte : elle
   * transforme une depense en presence.
   *
   * Pour offrir en plus un coup de pouce ponctuel a tout le monde, monter
   * XP_VOLUME_BONUS au-dessus de 1 : a 1,35 chacun gagne environ 16 % de
   * niveau du jour au lendemain. Laisse a 1 par defaut — un niveau qui saute
   * sans raison visible vaut moins que le meme niveau gagne.
   */
  XP_BASE: parseFloat(env('XP_BASE', '100')),
  XP_PUISSANCE: parseFloat(env('XP_PUISSANCE', '2')),
  XP_VOLUME_BONUS: parseFloat(env('XP_VOLUME_BONUS', '1')),

  /* Ce que rapporte chaque geste. Les valeurs sont calees sur un principe :
     une journee de joueur assidu SANS MISER doit valoir environ 500 XP, soit
     un niveau tous les quatre jours vers le niveau 10 et tous les huit vers
     le niveau 20. Assez pour se voir bouger, assez lent pour que le nombre
     garde un sens. */
  XP_CONNEXION: parseInt(env('XP_CONNEXION', '50'), 10),      // la serie du jour
  XP_QUETE: parseInt(env('XP_QUETE', '120'), 10),             // une quete reclamee
  XP_PARRAIN: parseInt(env('XP_PARRAIN', '500'), 10),         // un filleul valide
  /* Un objet de collection JAMAIS POSSEDE. Le doublon ne rapporte rien : sinon
     le plus gros acheteur de coffres monte le plus vite, et on est revenu au
     probleme qu'on repare. */
  XP_OBJET: { commun: 25, rare: 60, epique: 150, legendaire: 400, mythique: 1200 },
  XP_FAMILLE: parseInt(env('XP_FAMILLE', '2000'), 10),        // les cinq rangs d'une famille

  /* ---- le prix du classement ----
   *
   * Une part du REVENU du mois, partagee entre les dix premiers au volume.
   * Une part du revenu et non un montant fixe : ainsi le prix ne peut jamais
   * couter plus que ce que le mois a rapporte — il s'auto-finance par
   * construction, et un mois creux ne se paie pas au prix d'un mois plein.
   *
   * La repartition decroit vite. Un partage plat ne fait courir personne ;
   * un premier prix qui vaut le tiers de la cagnotte, si.
   */
  PRIX_CLASSEMENT_BPS: parseInt(env('PRIX_CLASSEMENT_BPS', '100'), 10),   // 1 % du revenu
  PRIX_PARTS: env('PRIX_PARTS', '30,20,13,10,8,6,5,4,2.5,1.5')
    .split(',').map(function (x) { return parseFloat(x.trim()) || 0; }),

  /* ---- LE PRIX DU MONDE, CHAQUE SEMAINE ----
   *
   * Vingt mille pieces d'or, partagees entre les dix premiers personnages
   * VIVANTS a l'XP, selon la meme repartition que le classement du mois — un
   * partage plat ne fait courir personne.
   *
   * EN OR, et pas en $SWOGE. Le prix du mois redistribue du volume DEJA mise :
   * de l'argent qui est entre. Recompenser de l'XP en jetons serait de
   * l'argent CREE contre du temps passe, et ca se farme avec un client sans
   * ecran, vingt-quatre heures sur vingt-quatre — le combat etant arbitre par
   * le serveur, les fermes n'auraient meme pas besoin de tricher. L'or ne
   * s'echange contre rien d'autre que du rang, donc le farmer ne rapporte
   * rien qu'a celui qui veut le rang.
   */
  PRIX_MONDE_GOLD: parseInt(env('PRIX_MONDE_GOLD', '20000'), 10),

  // ---- Daily quests ----
  // Anti-Sybil: total rewards (50) < house edge on the wagering required to
  // finish them (~300 drops → ~60 edge), AND claiming needs a real deposit.
  // So farming with throwaway wallets costs more than it pays.
  /* ---- LES TROIS QUETES FIXES SONT PARTIES ----
   *
   * Elles ne changeaient jamais, et l'une d'elles avait pour cible ZERO :
   * finie a l'instant ou elle apparaissait. Les deux autres portaient des
   * libelles de Coin Pusher — « Drop 100 coins », « Win 3 prizes » — alors
   * que leurs compteurs etaient alimentes par QUATORZE jeux : un joueur de
   * blackjack croyait qu'elles ne le concernaient pas et ignorait une
   * recompense qu'il gagnait deja.
   *
   * Elles sont remplacees par QUETES_POOL ci-dessous, dont les libelles
   * disent ce que les compteurs mesurent vraiment. On ne les garde pas « au
   * cas ou » : une configuration que plus personne ne lit finit par etre
   * modifiee par quelqu'un qui croit qu'elle sert encore.
   */
  /* ---- LE VERROU DU DEPOT TOMBE ----
   *
   * Il etait pose a 1 : les quetes etaient fermees tant qu'on n'avait pas
   * depose. Le mecanisme concu pour faire revenir les gens etait donc eteint
   * pour ceux qui ne sont pas encore clients — l'outil de retention reserve
   * aux joueurs deja retenus.
   *
   * La raison invoquee etait l'anti-Sybil. Elle ne tient pas : finir toutes
   * les quetes demande environ 6 000 $SWOGE mises, sur lesquels l'avantage le
   * plus faible du catalogue (blackjack, 2,6 %) represente ~156 d'esperance de
   * perte, contre ~70 distribues. La marge est de 2,2x SANS ce verrou. C'etait
   * un second verrou sur une porte deja fermee, et il coutait exactement la
   * population qu'on cherche a garder.
   */
  QUEST_REQUIRE_DEPOSIT: env('QUEST_REQUIRE_DEPOSIT', '0') === '1',

  /* =====================================================================
   * LES QUETES DU JOUR — cinq par jour, quatre paliers
   * =====================================================================
   *
   * ---- ce qui n'allait pas ----
   *
   * Trois quetes fixes qui ne changeaient JAMAIS, plus trois missions qui
   * changeaient de jeu mais jamais d'objectif : la meme phrase seize fois,
   * « misez 2 000 sur X ». Il n'y avait qu'un seul verbe dans tout le
   * systeme, et la variete percue vient du verbe, pas du complement.
   *
   * Et « Daily bonus » avait pour cible ZERO : elle etait finie a l'instant
   * ou elle apparaissait. Elle enseignait que le panneau de quetes est un
   * bouton a presser, ce qui est precisement l'habitude qu'on veut eviter.
   *
   * ---- LA MONNAIE ----
   *
   * L'XP porte la progression, les jetons restent symboliques. Le total en
   * jetons est volontairement inchange (~70/jour) : la marge anti-farming en
   * depend, et la multiplier par dix rendrait la quete rentable a elle seule.
   * L'XP, elle, ne se compare a aucune mise et ne peut rien casser.
   *
   * Chaque quete garde un petit gain en jetons : les panneaux des dix-huit
   * pages affichent « CLAIM +N $SWOGE », et une quete a zero y afficherait
   * « +0 ».
   *
   * ---- CE QUI N'EST PAS ICI, ET POURQUOI ----
   *
   * Pas de quete dont l'objectif serait un MONTANT PERDU, une suite de mises
   * croissantes, ou un retour apres une perte. Ces trois-la existent dans le
   * secteur ; aucune n'entrera ici.
   *
   * Pas non plus de quete « regarde tel panneau » : recompenser l'ouverture
   * d'un ecran gonfle le compte sans rien faire jouer.
   *
   * `cond` dit quand une quete peut etre PROPOSEE. Une quete impossible sur
   * le papier est pire qu'une quete absente : elle apprend a ne pas lire la
   * liste.
   */
  /* ---- LE GAIN EN JETONS SUIT LE VOLUME EXIGE, PAS L'HABITUDE ----
   *
   * L'ancien systeme payait 66 pour 6 000 a miser : l'avantage de la maison le
   * plus faible du catalogue (blackjack, 2,6 %) rendait ~156, soit une marge
   * de 2,4x. La refonte passe a cinq quetes et n'exige plus que ~2 000 —
   * l'esperance tombe a 52. Garder 70 aurait rendu la quete RENTABLE a elle
   * seule, c'est-a-dire payer quelqu'un pour ne rien risquer.
   *
   * Le total descend donc a 30, ce qui restaure une marge de 1,7x. Ce n'est
   * pas un appauvrissement : l'XP passe de 120 a 950 par jour, et la journee
   * parfaite rend un coffre — 4 000 de valeur affichee, qui ne sort pas de la
   * tresorerie mais de l'edition plafonnee.
   *
   * Trouve par le test, pas a la lecture : j'avais divise le volume exige par
   * trois et laisse le gain intact.
   */
  QUETE_GAIN: { easy: 2, jeu: 8, normal: 6, hard: 8, elite: 6 },
  QUETE_XP:   { easy: 60, jeu: 120, normal: 120, hard: 250, elite: 400 },
  /* ---- L'XP POUR TOUS, LES JETONS APRES LE PREMIER DEPOT ----
   *
   * Le verrou global est tombe : fermer les quetes aux non-deposants eteignait
   * la retention pour ceux qu'on cherche justement a garder. Mais la marge
   * anti-farming, elle, vient du VOLUME MISE — et un debutant a 100 jetons
   * voit sa cible tomber a 300, donc une esperance de 8 contre 30 distribues.
   *
   * On coupe donc en deux ce qui etait ferme d'un bloc : la PROGRESSION (XP,
   * serie, coffre du jour, journee parfaite) est ouverte a tout le monde, les
   * JETONS attendent le premier depot. Une adresse jetable ne rapporte alors
   * que de l'XP, qui ne se retire pas et ne se vend pas — le farm n'a plus
   * d'objet.
   */
  QUETE_JETONS_APRES_DEPOT: env('QUETE_JETONS_APRES_DEPOT', '1') === '1',
  /* La cible d'une quete de volume suit le SOLDE. Une cible fixe a 2 000 est
     vingt fois le credit d'essai d'un debutant et un cinquieme de mise
     maximum pour un joueur installe — elle ne peut pas servir les deux. */
  QUETE_CIBLE_MAX: parseFloat(env('QUETE_CIBLE_MAX', '2000')),
  QUETE_CIBLE_MULT: parseFloat(env('QUETE_CIBLE_MULT', '3')),
  QUETE_CIBLE_MIN: parseFloat(env('QUETE_CIBLE_MIN', '200')),
  /* Un Easy, deux Normal, un Hard, un Elite. */
  /* Un Easy, le jeu du jour, un Normal, un Hard, un Elite. */
  QUETE_COMPO: (env('QUETE_COMPO', 'easy,jeu,normal,hard,elite')).split(','),
  /* La journee parfaite paie un coffre de bois. LE PLAFOND N'EST PAS
     DECORATIF : la saison 1 compte 9 600 pieces, et un coffre par joueur et
     par jour la brule en dix-neuf jours a cinq cents joueurs. */
  PARFAIT_XP: parseInt(env('PARFAIT_XP', '300'), 10),
  /* ---- UN SEUL PLAFOND POUR TOUS LES COFFRES GRATUITS ----
   *
   * Le coffre du jour et celui de la journee parfaite sortent de la MEME
   * edition plafonnee. Un plafond sur l'un et pas sur l'autre ne protege rien :
   * il suffit de prendre l'autre. Et le vrai danger n'est pas le joueur
   * regulier, c'est la ferme d'adresses — un compteur global est la seule
   * borne qui tienne quel que soit le nombre de comptes.
   *
   * Il borne les DEUX sources ensemble. Au-dela, l'XP part quand meme :
   * refuser apres coup une recompense annoncee serait pire que la reduire.
   */
  COFFRES_GRATUITS_JOUR: parseInt(env('COFFRES_GRATUITS_JOUR', '80'), 10),

  QUETES_POOL: [
    // ---- EASY : une action, n'importe quel jeu. Elles font cocher la
    //      premiere case, et c'est ce qui donne envie de lire les autres.
    { id: 'e_tour',  palier: 'easy', metric: 'drops', cible: 1,  label: 'Play 1 round' },
    { id: 'e_gagne', palier: 'easy', metric: 'wins',  cible: 1,  label: 'Win 1 round' },
    { id: 'e_dix',   palier: 'easy', metric: 'drops', cible: 10, label: 'Place 10 bets' },
    { id: 'e_serie', palier: 'easy', metric: 'serie', cible: 1,  label: 'Claim your daily streak' },

    // ---- NORMAL : du volume, sur un jeu NOMME. C'est la distribution
    //      gratuite vers tout le catalogue, et c'est ce qui marche deja.
    /* Le palier `jeu` a SON creneau, tous les jours. C'est la mecanique qui
       marche deja — elle envoie tout le catalogue sous les yeux de tout le
       monde sans une ligne de contenu neuf — et la garder a part evite d'avoir
       deux « misez sur X » le meme jour, ce qui se lit comme une seule quete
       comptee deux fois. */
    { id: 'n_jeu',   palier: 'jeu', metric: 'mise', jeuDuJour: true, label: 'Wager {cible} $SWOGE on {jeu}' },
    { id: 'n_trois', palier: 'normal', metric: 'jeux', cible: 3, label: 'Play 3 different games' },
    { id: 'n_paris', palier: 'normal', metric: 'paris', cible: 1, label: 'Place 1 sports bet' },
    { id: 'n_duel',  palier: 'normal', metric: 'duel',  cible: 1, label: 'Finish 1 duel' },
    { id: 'n_total', palier: 'normal', metric: 'total', label: 'Wager {cible} $SWOGE across any games',
      volume: true },

    // ---- HARD : un RESULTAT, pas seulement du volume.
    { id: 'h_cinq',  palier: 'hard', metric: 'wins', cible: 5, label: 'Win 5 rounds today' },
    { id: 'h_cinqj', palier: 'hard', metric: 'jeux', cible: 5, label: 'Play 5 different games' },
    { id: 'h_vingt', palier: 'hard', metric: 'drops', cible: 40, label: 'Place 40 bets' },
    { id: 'h_parisg', palier: 'hard', metric: 'parisGagnes', cible: 1, label: 'Win a sports bet' },

    // ---- ELITE : la collection. Le seul verbe qui n'est pas « miser ».
    { id: 'x_coffre', palier: 'elite', metric: 'coffres', cible: 1, label: 'Open a chest' },
    { id: 'x_neuf',   palier: 'elite', metric: 'neufs',   cible: 1, label: 'Find an item you never owned',
      cond: 'aDesObjets' },
    { id: 'x_rare',   palier: 'elite', metric: 'rarete',  cible: 2, label: 'Pull a Rare item or better',
      cond: 'aDesObjets' },
    { id: 'x_dix',    palier: 'elite', metric: 'sortes',  cible: 10, label: 'Own 10 different items',
      cond: 'aDesObjets' },
    { id: 'x_famille', palier: 'elite', metric: 'pleines', cible: 1, label: 'Complete a full family',
      cond: 'aDesObjets' },
    { id: 'x_parrain', palier: 'elite', metric: 'filleul', cible: 1, label: 'One of your invitees plays today',
      cond: 'aDesFilleuls' },
  ],

  /* ---- Les missions du jour, jeu par jeu ----
   *
   * Les quetes globales se remplissaient toutes seules : un joueur de Plinko
   * finissait « lachez 300 pieces » sans jamais avoir ouvert autre chose. Une
   * mission NOMME un jeu, et le jeu change chaque jour — c'est de la
   * distribution gratuite vers tout le catalogue, sans une ligne de contenu
   * nouveau. Elles remplacent la quete « 300 pieces », elles ne s'ajoutent
   * pas : ce qui est distribue chaque jour reste du meme ordre.
   *
   * Le compteur est la MISE du jour sur ce jeu, pas le nombre de manches. Un
   * nombre de manches se remplirait a la mise minimum, et la recompense
   * passerait alors devant l'avantage de la maison — c'est-a-dire qu'on
   * paierait quelqu'un pour ne rien risquer. Sur MISSION_MISE misees,
   * l'avantage le plus faible du catalogue (le blackjack, 2,6 %) rend deja
   * plusieurs fois MISSION_GAIN.
   *
   * La rotation est calculee, pas tiree : tout le monde voit les memes jeux le
   * meme jour, et le pas (MISSIONS_PAR_JOUR) etant premier avec la longueur du
   * catalogue, chaque jeu revient a intervalle regulier.
   */
  MISSION_CATALOGUE: [
    ['plinko', 'Plinko',         'plinko.html'],
    ['mines',  'Mines',          'swoge_casino.html?game=mines'],
    ['crash',  'Crash',          'crash.html'],
    ['bj',     'Blackjack',      'swoge_blackjack.html'],
    ['hilo',   'Hi-Lo',          'swoge_casino.html?game=hilo'],
    ['spin',   'SWOGE Spin',     'swoge_spin.html'],
    ['smash',  'SWOGE Smash',    'swoge_smash.html'],
    ['holdem', "Casino Hold'em", 'swoge_casino.html?game=holdem'],
    ['three',  'Three Card',     'swoge_casino.html?game=three'],
    ['pusher', 'Coin Pusher',    'swoge_pusher_live.html'],
    ['poker',  'Poker',          'swoge_poker.html'],
    ['p4',     'Connect 4',      'connect4.html'],
    ['mp',     'Tic-Tac-Toe',    'morpion.html'],
    ['dm',     'Checkers',       'dames.html'],
    ['mf',     'Ghost Tic-Tac-Toe', 'morpion_fantome.html'],
    ['dc',     'Last Number',       'dernier_chiffre.html'],
  ],
  /* UN JEU N'ENTRE PAS DANS CE CATALOGUE AVANT D'AVOIR SA PAGE.
     La mission du jour envoie le joueur sur l'adresse ci-dessus. Un moteur
     livre sans page y mettrait un lien mort — et pas n'importe lequel : celui
     qu'on met sous le nez de tout le monde le meme jour, avec une recompense
     au bout. Les trois derniers ont attendu leur page pour entrer ici. */
  /* ---- Ce qu'on peut se dire a la table ----
   *
   * Une liste FERMEE, et rien d'autre. Le texte libre demanderait une equipe
   * de moderation que le projet n'a pas, et il suffit d'un seul message pour
   * qu'une table devienne un endroit ou l'on ne revient pas. Ici c'est un
   * IDENTIFIANT qui traverse le reseau, jamais une phrase : le serveur n'a
   * donc rien a filtrer, et il n'existe aucune facon d'ecrire quoi que ce
   * soit qui ne figure pas ci-dessous.
   *
   * Le choix des phrases n'est pas neutre : aucune ne doit pouvoir servir a
   * narguer. « A toi de jouer » renseigne, « depeche-toi » harcele — la
   * premiere est ici, la seconde n'y sera jamais.
   */
  PHRASES: [
    ['hi',      '👋', 'Hi!'],
    ['gl',      '🤝', 'Good luck'],
    ['nice',    '🔥', 'Nice move'],
    ['wow',     '😮', 'Wow'],
    ['close',   '😬', 'That was close'],
    ['think',   '🤔', 'Thinking...'],
    ['turn',    '⏳', 'Your turn'],
    ['oops',    '😅', 'Oops'],
    ['lucky',   '🍀', 'Lucky!'],
    ['ty',      '🙏', 'Thanks'],
    ['gg',      '👏', 'Good game'],
    ['rematch', '⚔️', 'Rematch?'],
  ],
  /* Meme toute faite, une phrase repetee vingt fois harcele. On espace, et on
     plafonne : passe le plafond, la table redevient silencieuse pour celui qui
     l'a atteint, sans rien changer a la partie. */
  PHRASE_PAUSE_MS: parseInt(env('PHRASE_PAUSE_MS', '3000'), 10),
  PHRASE_MAX: parseInt(env('PHRASE_MAX', '15'), 10),

  /* ---- LA PAROLE DES JOUEURS, DANS LE MONDE ----
   *
   * Ici le joueur ECRIT. Ce n'est plus un identifiant choisi dans une liste
   * fermee comme aux tables de duel : c'est une chaine libre qui va s'afficher
   * au-dessus de sa tete SUR L'ECRAN DE TOUT LE MONDE. Les trois nombres qui
   * suivent sont donc la seule chose entre un clavier et trente-neuf ecrans.
   *
   * DIT_MAX : une bulle se dessine sur UNE ligne, au-dessus d'un personnage
   * qui mesure quelques dizaines de pixels. Au-dela de cent vingt signes elle
   * couvre la moitie de la carte, et couvrir la carte des autres est un geste
   * hostile qui ne demande aucun outil.
   *
   * DIT_PAUSE_MS : deux secondes entre deux phrases. La bulle vit trente
   * secondes ; sans espacement, quinze bulles se remplaceraient avant que la
   * premiere ait fini d'etre lue, et personne ne lirait rien.
   *
   * DIT_RAFALE / DIT_FENETRE_MS : l'espacement seul laisse parler sans fin,
   * une phrase toutes les deux secondes, indefiniment. Le plafond glissant
   * borne la RAFALE — cinq phrases par quinze secondes — ce qui laisse une
   * conversation normale passer et arrete le robot qui recite.
   */
  DIT_MAX: parseInt(env('DIT_MAX', '120'), 10),
  DIT_PAUSE_MS: parseInt(env('DIT_PAUSE_MS', '2000'), 10),
  DIT_RAFALE: parseInt(env('DIT_RAFALE', '5'), 10),
  DIT_FENETRE_MS: parseInt(env('DIT_FENETRE_MS', '15000'), 10),

  /* ---- COMBIEN DE SEANCES A L'AFFICHE, PAR SALLE ----
   * Les galeries partent dans le `hello` de CHAQUE connexion et dans chaque
   * diffusion : une liste sans plafond serait un message qui grossit a chaque
   * enregistrement, paye par tous les joueurs a chaque ouverture de page.
   * Douze tiennent dans une galerie qu'on parcourt du regard ; au-dela on ne
   * choisit plus, on cherche.
   * IL S'APPLIQUE PAR SALLE et non au total : un plafond commun aurait laisse
   * une salle bien remplie fermer la porte aux autres, et le proprietaire
   * aurait lu « la galerie est pleine » devant une galerie vide. */
  CINEMA_MAX: parseInt(env('CINEMA_MAX', '12'), 10),

  /* ---- LES CARTES DESSINEES PAR LES JOUEURS ----
   *
   * Ce sont des ecrits d'inconnus gardes sur notre disque : les plafonds ne
   * sont donc pas du confort, ils sont ce qui empeche une personne d'emporter
   * le serveur avec un seul envoi. Trois bornes, chacune contre une facon
   * differente de deborder :
   *
   *   CARTE_COTE   la carte est un carre d'au plus tant de cases de cote. Il
   *                borne ce qu'on DESSINE, et donc ce qu'on transmet.
   *   CARTE_CASES  le nombre de cases REELLEMENT posees. Le cote seul ne
   *                suffit pas : une grille de 128 sur 128 fait seize mille
   *                trois cent quatre-vingt-quatre cases, et rien n'oblige a
   *                les remplir. C'est ce compte-la qui decide du poids.
   *   CARTES_PAR_COMPTE  combien de cartes un compte peut garder. Sans lui,
   *                un seul compte remplit le disque en boucle.
   *
   * ---- ET LES CHIFFRES SONT DICTES PAR LA TRAME, PAS CHOISIS ----
   *
   * La socket refuse toute trame de plus de 256 kilo-octets — c'est une
   * protection globale, posee bien avant ces cartes, et qui agit AVANT toute
   * validation. Des plafonds plus larges qu'elle seraient un mensonge : la
   * carte serait acceptee par le reglement et rejetee par le tuyau, sans que
   * personne ne comprenne pourquoi son travail ne s'enregistre pas.
   * ---- ET IL FAUT COMPTER LE PIRE QUE LE REGLEMENT AUTORISE ----
   *
   * Premiere tentative : cote 64, cinq mille cases, calcules sur des cles
   * REALISTES (« grass », « boxe »), soit 186 ko. L'essai a refuse — parce que
   * le reglement, lui, autorise des cles de vingt-quatre caracteres, et la
   * pire carte permise pesait 375 ko. Un plafond doit tenir pour ce qu'il
   * PERMET, pas pour ce qu'on imagine qu'on enverra.
   * Le calcul refait sur le pire cas, avec vingt pour cent de marge :
   *   cle 20 -> 70 octets par case -> cote 54
   *   cle 24 -> 78 octets par case -> cote 51
   *   cle 32 -> 94 octets par case -> cote 47
   * La plus longue cle REELLE du catalogue fait vingt (`pet_shiba_legendaire`),
   * d'ou vingt-quatre : de la marge pour les noms a venir, sans plus.
   * Un carre de 48 fait 2304 cases, soit plus de TROIS FOIS la surface du
   * Nexus, qui en compte 644. Le jour ou l'on voudra plus grand, ce ne sera pas
   * en relevant ce chiffre : il faudra un format compact — des indices dans une
   * palette au lieu de noms repetes — et ce changement-la se fait exprès, pas
   * en le decouvrant.
   * Le plafond de cases est au-dessus de 48x48 : il borne l'ENVELOPPE recue,
   * avant qu'on ecarte les doublons, et rien n'empeche un envoi de repeter la
   * meme case. */
  CARTE_COTE: parseInt(env('CARTE_COTE', '48'), 10),
  CARTE_CASES: parseInt(env('CARTE_CASES', '2600'), 10),
  CARTES_PAR_COMPTE: parseInt(env('CARTES_PAR_COMPTE', '24'), 10),
  /* Le nom que le joueur donne a sa carte. Compte en points de code, comme
     tout ce qui vient d'un clavier ici. */
  CARTE_NOM_MAX: parseInt(env('CARTE_NOM_MAX', '48'), 10),
  /* ---- L'IMAGE QUI VOYAGE AVEC LA CARTE ----
   * La galerie ne montrait que du texte. La page dessine donc sa carte en
   * cent vingt-huit pixels et joint l'image a l'enregistrement.
   *
   * Vingt-quatre kilo-octets, et ce chiffre se prend sur le MEME budget que
   * les cases, pas a cote : la pire carte que le reglement permet pese deja
   * cent quatre-vingt-deux kilo-octets (2600 cases de soixante-dix octets),
   * et la trame en refuse plus de deux cent cinquante-six. Il reste donc
   * environ soixante-dix kilo-octets ; on en prend vingt-quatre, ce qui laisse
   * de la marge pour le nom, le mode et l'enveloppe.
   * Le jour ou l'on voudra une image plus grande, ce n'est pas ce chiffre
   * qu'il faudra relever seul — c'est le format des cases qu'il faudra rendre
   * compact, sans quoi la carte serait acceptee par le reglement et rejetee
   * par le tuyau. */
  CARTE_VIGNETTE_MAX: parseInt(env('CARTE_VIGNETTE_MAX', '24000'), 10),

  /* ---- LES OBJETS SONT UNE LISTE, PAS UN CHAMP DE CASE ----
   *
   * Une case portait UN objet. C'etait assez pour poser une maison sur un
   * sol, et pas pour en poser deux au meme endroit — ni pour dire lequel
   * passe devant l'autre. Les objets sont donc une liste a part, chacun avec
   * sa case, son emprise, son quart de tour et sa COUCHE.
   *
   * Mille huit cents, et le chiffre se calcule. La trame refuse plus de deux
   * cent cinquante-six kilo-octets ; l'image en prend vingt-quatre, les sols
   * d'une carte pleine cent huit (2304 fois quarante-sept octets), il reste
   * environ cent vingt-trois kilo-octets, et un objet en pese soixante-six au
   * pire de ce que le reglement permet. Le jour ou l'on voudra plus, ce n'est
   * pas ce chiffre qu'il faudra relever seul : c'est le format qu'il faudra
   * rendre compact. */
  CARTE_OBJETS: parseInt(env('CARTE_OBJETS', '1800'), 10),
  /* Combien de couches. Huit : assez pour un sol, un chemin, un batiment, un
     toit et de quoi respirer entre les deux, et assez peu pour qu'on les
     choisisse d'un coup d'oeil au lieu de les chercher. */
  CARTE_COUCHES: parseInt(env('CARTE_COUCHES', '8'), 10),
  /* ---- COMBIEN DE CARTES LA GALERIE MONTRE ----
   * Elle les montrait TOUTES, celles de tout le monde. C'etait sans
   * consequence tant qu'il y en avait trois ; a cent comptes de vingt-quatre
   * cartes, cela fait deux mille quatre cents fiches dans un seul message —
   * et depuis que chaque fiche porte son image, c'est aussi douze megaoctets.
   * On envoie donc les plus RECENTES, plus toutes celles du demandeur : sa
   * propre galerie ne doit jamais dependre de l'activite des autres, sans
   * quoi le jour ou le jeu marche, on ne retrouve plus son travail. */
  CARTES_VITRINE: parseInt(env('CARTES_VITRINE', '60'), 10),
  /* ---- L'EMPRISE D'UN ELEMENT, EN CASES ----
   * Une parcelle isometrique occupe plusieurs cases : c'est ce qui decide de
   * ce qu'elle BLOQUE quand on marchera dedans. Le nombre est ecrit dans la
   * carte au moment ou l'on pose, et non deduit ici — le serveur ne connait
   * pas le catalogue, et lui en donner une copie serait la premiere chose a
   * se perimer.
   *
   * Soixante-quatre, et borne EN PLUS par le DOUBLE du cote de la carte.
   *
   * Huit au depart, puis trente-deux, et le proprietaire a de nouveau touche
   * le plafond. A chaque fois le chiffre etait choisi et non deduit, donc a
   * chaque fois il etait arbitraire. Le double du cote, lui, dit quelque
   * chose : un element peut couvrir la carte entiere ET DEBORDER — c'est ce
   * qu'on veut d'un fond, qui doit sortir du cadre pour ne pas montrer ses
   * bords — sans pouvoir s'etendre indefiniment.
   *
   * Et le vrai danger n'etait pas la taille. Voir `planDeCarte` : un bloc
   * assez gros pour couvrir le point d'arrivee y ferait NAITRE le visiteur
   * dans la pierre. C'est la que ca se corrige, pas ici. */
  CARTE_EMPRISE_MAX: parseInt(env('CARTE_EMPRISE_MAX', '64'), 10),

  /* ---- ET LE PLANCHER, PARCE QU'UNE EMPRISE N'EST PLUS UN NOMBRE ENTIER ----
   * Elle se comptait en cases pleines : d'une case on passait a deux, soit du
   * simple au double. Sur une parcelle de quatre cases, le cran suivant en
   * ajoutait vingt-cinq pour cent d'un coup, et il n'y avait rien entre les
   * deux. Elle se compte donc au CENTIEME de case — un peu plus d'un pixel de
   * monde, ce qui est plus fin que ce que l'oeil distingue a l'ecran.
   *
   * Un quart de case au minimum : trente-deux unites de monde, soit un tonneau
   * vu de loin. En dessous, l'element est un point que l'on ne peut plus ni
   * viser ni reprendre — et l'on aurait pose sur sa carte quelque chose qu'on
   * ne peut plus retirer autrement qu'en le cherchant dans la liste. */
  CARTE_EMPRISE_MIN: Number(env('CARTE_EMPRISE_MIN', '0.25')),

  /* ---- LES SALLES A ECRAN ----
   * La table est lue et commentee tout en haut de ce fichier. Elle est ICI,
   * a cote du plafond, parce que le plafond s'applique PAR SALLE : douze
   * seances dans le cinema, douze dans la salle manga, douze dans la salle
   * series. Un plafond commun aurait laisse une salle bien remplie fermer la
   * porte aux deux autres, ce que personne n'aurait compris en la voyant
   * vide. */
  SALLES_ECRAN: sallesEcran(env('SALLES_ECRAN', SALLES_DEFAUT)),

  /* ---- La surveillance ----
   * MONITEUR_URL : l'adresse a laquelle le serveur fait signe qu'il est
   * vivant. C'est le SILENCE qui alerte — la seule facon d'etre prevenu quand
   * le processus est mort, puisqu'un processus mort n'envoie rien. Gratuit
   * chez healthchecks.io, Better Stack ou Cronitor ; voir EXPLOITATION.md. */
  MONITEUR_URL: env('MONITEUR_URL', ''),
  MONITEUR_SEC: parseInt(env('MONITEUR_SEC', '60'), 10),

  /* ---- Arriver depuis une autre chaine ----
   *
   * Relay convertit du SOL, du BTC ou de l'USDT en ETH sur Robinhood Chain et
   * le livre directement au joueur. Sans cle, on ne peut que L'ENVOYER chez
   * eux, avec un lien prerempli. Avec la cle, on peut lui donner une ADRESSE
   * DE DEPOT ici meme : il envoie depuis son portefeuille OU depuis son compte
   * d'echange, sans rien connecter, et l'ETH arrive chez lui.
   *
   * La cle ne doit JAMAIS descendre dans la page : swogebuy.js est public. Le
   * serveur appelle Relay a la place du navigateur et ne lui rend que
   * l'adresse. C'est toute la raison d'etre de la route /relay/depot.
   *
   * Deux noms acceptes, parce que la variable est posee a la main chez
   * l'hebergeur et qu'un serveur muet a cause d'un tiret bas ne dit pas
   * pourquoi. */
  RELAY_API_KEY: env('RELAY_API_KEY', '') || env('RELAY_KEY', ''),
  RELAY_API: env('RELAY_API', 'https://api.relay.link'),

  MISSIONS_PAR_JOUR: parseInt(env('MISSIONS_PAR_JOUR', '3'), 10),
  MISSION_MISE: parseFloat(env('MISSION_MISE', '2000')),   // a miser sur le jeu du jour
  MISSION_GAIN: parseFloat(env('MISSION_GAIN', '12')),     // ce qu'elle rapporte

  /* ---- Le credit d'essai d'un arrivant ----
   *
   * IL DOIT VALOIR PLUSIEURS MANCHES DE CASINO. Il valait 1 : moins que
   * CASINO_MIN_BET. Mines, Hi-Lo, Hold'em et Three Card etaient donc
   * cliquables et refusaient la mise, sur la premiere minute du produit —
   * le seul moment ou personne ne se plaint, parce que celui qui ne peut rien
   * jouer s'en va sans le dire. Les deux nombres vivent a quatre cents lignes
   * d'ecart ; c'est bienvenue.test.js qui les compare desormais, et qui ouvre
   * une vraie partie avec le credit seul pour le prouver.
   *
   * CE QUI AUTORISE A LE DONNER SANS DEPOT, c'est qu'il ne peut pas SORTIR :
   * le retrait demande MIN_WITHDRAW (cent fois le credit), le virement vers un
   * complice demande un depot ET TRANSFER_MIN, et les quetes demandent un
   * depot. Un compte jetable peut jouer le credit, et rien d'autre. Les trois
   * portes sont verrouillees par le test : le jour ou l'une s'ouvre, il tombe.
   *
   * Le montant, lui, ne coute presque rien a la maison — cent jetons valent
   * une fraction de centime au prix de la reserve. Ce qu'il achete, c'est une
   * vraie premiere partie.
   *
   * ATTENTION : si WELCOME_BONUS est pose en variable d'environnement chez
   * l'hebergeur, c'est ELLE qui gagne et ce defaut revient sans prevenir.
   *
   * Une fois qu'il a MISE au moins une fois, le joueur peut reclamer
   * WELCOME_CLAIM en plus, une seule fois.
   */
  /* ---- LA PRIME D'ENTRAINEMENT ----
   *
   * Battre un bot rapporte. Le mode entrainement ne coute rien a jouer, donc
   * la prime est le seul $SWOGE qui en sorte — et c'est aussi, pour la meme
   * raison, le seul endroit du serveur ou de l'argent est cree sans qu'une
   * mise ait ete posee. Il fallait donc un plafond, et lequel n'est pas
   * indifferent.
   *
   * UNE PRIME PAR JEU ET PAR JOUR, pas N primes par jour. La difference est
   * tout : les six bots ne sont pas egalement durs. Le morpion est parfait et
   * ne peut PAS etre battu ; le Puissance 4 gagne 100 parties sur 100 contre
   * un joueur attentif. Mais le Dernier Chiffre est un jeu de hasard cache —
   * le bot y joue l'equilibre, ce qui le rend inexploitable mais pas
   * invincible : un joueur en gagne environ une sur quatre, et une partie
   * tient en un seul message. Un plafond global de six primes se remplirait
   * donc en une minute, au meme jeu, par un script.
   *
   * Par jeu, il faut battre six adversaires differents — dont un qu'on ne peut
   * qu'egaler. C'est le plafond qui recompense ce qu'on voulait recompenser. */
  ENTRAINEMENT_PRIME: parseFloat(env('ENTRAINEMENT_PRIME', '10')),
  ENTRAINEMENT_PRIMES_JOUR: parseInt(env('ENTRAINEMENT_PRIMES_JOUR', '1'), 10),

  WELCOME_BONUS: parseFloat(env('WELCOME_BONUS', '100')),   // credit d'essai, a la premiere connexion
  WELCOME_CLAIM: parseFloat(env('WELCOME_CLAIM', '5')),   // extra reward, unlocked after wagering

  // ---- 7-day consecutive login streak ----
  // One claim per UTC day; a skipped day resets the streak to day 1. Reward
  // escalates J1→J7, then wraps back to J1. Comma-separated wei-free amounts.
  STREAK_REWARDS: env('STREAK_REWARDS', '1,2,3,5,7,10,15')
    .split(',').map(function (x) { return parseFloat(x.trim()) || 0; }),

  // ---- Rewarded video ads (Adsgram) ----
  // Adsgram calls REWARD_URL (server-to-server) when a user finishes a video.
  // We credit AD_REWARD $SWOGE, capped at AD_DAILY_CAP/day with a cooldown so a
  // single user can't spam. ADSGRAM_KEY guards the endpoint (must be non-empty
  // in production, else the endpoint is disabled).
  AD_REWARD: parseFloat(env('AD_REWARD', '10')),               // $SWOGE per finished video
  AD_DAILY_CAP: parseInt(env('AD_DAILY_CAP', '5'), 10),        // max rewarded videos / day / player
  AD_COOLDOWN_SEC: parseInt(env('AD_COOLDOWN_SEC', '30'), 10), // min seconds between two rewards
  ADSGRAM_KEY: env('ADSGRAM_KEY', ''),                         // shared secret in the Reward URL
  ADSGRAM_BLOCK_ID: env('ADSGRAM_BLOCK_ID', '41851'),          // Adsgram UnitID (sent to the client)

  // ---- Staking (yield on staked $SWOGE, claimable anytime) ----
  // Paid FROM the vault — fund it (ownerDeposit) or it drains. 100% APR is a
  // BIG liability (you owe double after a year), so keep the vault funded.
  STAKE_APR_BPS: parseInt(env('STAKE_APR_BPS', '10000'), 10),        // 10000 = 100% APR
  STAKE_LOCK_DAYS: parseInt(env('STAKE_LOCK_DAYS', '365'), 10),      // duree d echeance, sans effet tant que la penalite vaut 0

  /* ---- LA SORTIE EST LIBRE ----
   *
   * Zero. Le staking se quitte a tout moment, et tout revient : le capital en
   * entier, plus le rendement couru jusqu'a la seconde ou l'on part.
   *
   * Ce qui a ete retire : la moitie du capital encore bloque partait a la
   * maison. Une part sur deux, ce n'est pas une friction, c'est une perte
   * seche — et elle frappait exactement celui qui en avait besoin, celui qui
   * doit reprendre son argent avant terme. Un joueur qui l'apprend le jour ou
   * il veut sortir ne revient pas, et il le raconte.
   *
   * Ce qu'on ne perd pas en l'enlevant : le rendement est PROPORTIONNEL au
   * temps passe. Entrer et ressortir dans la seconde ne rapporte rien du
   * tout ; il n'y a donc rien a fermer contre ca, et il n'y en a jamais eu.
   *
   * Le VRAI garde-fou reste le coffre : a 100 % l'an, ce qui est promis doit
   * y etre. C'est le plafond de staking qui s'en charge, pas le verrou.
   *
   * Remettre une valeur > 0 reactive le verrou ET la penalite d'un coup : le
   * blocage est defini par la penalite, pas par la date (voir _verrouille
   * dans game.js). Les positions deja prises suivent sans migration.
   */
  STAKE_EARLY_PENALTY_BPS: parseInt(env('STAKE_EARLY_PENALTY_BPS', '0'), 10),

  /* ---- LE PLAFOND DE STAKING ----
   *
   * A 100 % l'an, chaque jeton depose engage la maison a en rendre DEUX au
   * bout d'un an. Sans plafond, cette dette n'a aucune borne : il suffit qu'un
   * gros porteur arrive avec cinquante millions pour que le coffre doive
   * cinquante millions de plus l'annee suivante, et personne ne s'en apercoit
   * le jour ou ca arrive — on s'en apercoit douze mois plus tard.
   *
   * Le plafond met une borne CONNUE D'AVANCE a cette dette. Vingt pour cent de
   * l'offre = 200 millions au maximum en staking, donc 200 millions de
   * rendement maximum sur l'annee. C'est un chiffre qu'on peut regarder en
   * face et budgeter.
   *
   * Il ne bloque personne definitivement : quand un joueur sort ou qu'un
   * verrou arrive a terme, la place se libere et le suivant entre. C'est
   * exactement ce que fait une salle pleine.
   */
  TOKEN_SUPPLY: parseFloat(env('TOKEN_SUPPLY', '1000000000')),       // l offre totale, verifiee sur la chaine
  STAKE_CAP_BPS: parseInt(env('STAKE_CAP_BPS', '2000'), 10),         // 2000 = 20 % de l offre, tous joueurs confondus
  /*
   * ---- et le plafond PAR PORTEFEUILLE ----
   *
   * Un plafond global de 20 % laisse un seul porteur le prendre en entier. Le
   * rendement est une subvention : elle est payee par la maison, donc par les
   * manches jouees par tout le monde. Qu'un portefeuille l'absorbe seul
   * revient a faire payer la salle pour une personne, et ce n'est pas le but.
   *
   * La mesure du jour ou ce plafond est ecrit : sur quatre portefeuilles qui
   * stakent, UN SEUL en tenait 92,6 %. Le probleme n'est pas theorique.
   *
   * Exprime en part de la SALLE, pas de l'offre : si le plafond global bouge,
   * celui-ci suit, et le rapport « combien de portefeuilles au minimum pour
   * remplir » reste celui qu'on a choisi. A 100 points de base, il en faut au
   * moins cent.
   *
   * Ce plafond ne retire RIEN a personne. Une position deja ouverte reste
   * ouverte, meme au-dessus : on ne casse pas un engagement pris sous une
   * autre regle. Il empeche seulement d'en AJOUTER.
   */
  STAKE_CAP_JOUEUR_BPS: parseInt(env('STAKE_CAP_JOUEUR_BPS', '100'), 10),  // 100 = 1 % de la salle

  // ---- Telegram notifications (deposits / big wins / stakes) ----
  // Accepts either TG_* or the TELEGRAM_* names your other bots already use.
  TG_BOT_TOKEN: env('TG_BOT_TOKEN', '') || env('TELEGRAM_BOT_TOKEN', ''),   // BotFather token
  TG_CHAT_ID: env('TG_CHAT_ID', '') || env('TELEGRAM_CHAT_ID', ''),         // channel/group id (e.g. -100123…) or @channel
  EXPLORER: env('EXPLORER', 'https://robinhoodchain.blockscout.com'),
  NOTIFY_DEPOSIT_MIN: parseFloat(env('NOTIFY_DEPOSIT_MIN', '0')),  // notify deposits ≥ this
  DEPOSIT_IMAGE: env('DEPOSIT_IMAGE', 'https://i.ibb.co/jkCkzPpM/Chat-GPT-Image-5-ao-t-2026-15-41-22.png'), // image shown on deposit notifs ('' = none)
  STAKE_IMAGE: env('STAKE_IMAGE', 'https://i.ibb.co/4gKk59sQ/Chat-GPT-Image-5-ao-t-2026-15-53-47.png'),     // image shown on stake notifs ('' = none)
  NOTIFY_WIN_MIN: parseInt(env('NOTIFY_WIN_MIN', '500'), 10),      // notify single-coin wins ≥ this
  /* Ou vivent les vignettes des jeux, pour les annonces de gain. Telegram va
     CHERCHER l'image lui-meme : l'adresse doit donc etre publique, et c'est
     le site qui les sert — les memes que sur la page des jeux, extraites une
     fois dans media/. Vider la variable rend les annonces en texte seul. */
  GAME_IMAGE_BASE: env('GAME_IMAGE_BASE', 'https://swoleeswoge.dog/media'),
  /* Un nouveau joueur dans le canal. C'est la notification la plus utile de
     toutes pour un canal qui veut voir la communaute grandir, et la seule qui
     n'existait pas. */
  NOTIFY_NEW_PLAYER: env('NOTIFY_NEW_PLAYER', '1') === '1',
  NEW_PLAYER_IMAGE: env('NEW_PLAYER_IMAGE', ''),
  NOTIFY_STAKE_MIN: parseFloat(env('NOTIFY_STAKE_MIN', '100')),    // notify stakes ≥ this

  /* ---- l'annonce d'un pari sportif ----
   * Les autres annonces racontent un GAIN, apres coup. Celle-ci raconte un
   * ENGAGEMENT : un pari reste ouvert jusqu'au coup de sifflet, c'est la seule
   * du canal qu'on peut suivre en direct.
   * Le seuil est a ZERO : tout pari est annonce, comme demande. Si le canal
   * devient bruyant, c'est la seule valeur a bouger — la mettre a 1000
   * n'annoncerait que les paris qui valent le coup d'oeil. */
  NOTIFY_BET_MIN: parseFloat(env('NOTIFY_BET_MIN', '0')),

  // ---- Provably-fair prize table (weighted tiers) ----
  // [value, weight] out of PRIZE_TOTAL (10,000,000). A weighted table (instead
  // of a flat array) lets us express very rare big lots cleanly AND keep the
  // exact same provably-fair HMAC selection.
  //
  // Design: ~47.5% of coins show a WIN (lots of small ones = good feel), a
  // ladder up to a 1-in-10M "gros lot". Average value ≈ 1.043 $SWOGE/drop.
  // Real RTP = avg × collection-rate(≈0.77 on this table) ≈ 80%.
  /* ---- Pourquoi si peu de pieces a 1 ----
   *
   * Elles faisaient 29 % des lachers, et 2 jetons 12 % de plus : quatre
   * lachers sur dix rendaient une piece qu'on ne remarque pas. A l'ecran ca
   * tombe sans arret et ca ne veut rien dire — « on voit que des petits
   * tomber, on a l'impression que c'est infini ».
   *
   * La MOYENNE ne bouge pas : 1,043 par lacher, au chiffre pres, donc
   * l'economie du jeu est exactement la meme. Ce qui change, c'est la forme.
   * Les pieces a 1 passent de 29 % a 8 %, celles a 10 sont presque trois fois
   * plus frequentes, celles a 25 deux fois. En echange il tombe plus souvent
   * une piece sans valeur — elle pousse quand meme la pile, elle ne paie pas.
   *
   * C'est un choix assume : moins souvent, plus gros. Un jeu ou l'on gagne
   * tout le temps trois fois rien ne se souvient de rien. */
  /* ---- DEUXIEME PASSE : encore moins de petit, encore plus de gros ----
   *
   * La passe precedente avait deja fait tomber les pieces a 1 de 29 % a 8 %.
   * Ca ne suffisait pas : une piece sur six rendait encore 1 ou 2 jetons,
   * c'est-a-dire rien qu'on remarque, et il fallait en moyenne neuf cents
   * lachers pour voir tomber une piece a 50.
   *
   * LA MOYENNE NE BOUGE PAS — 1,0430 par lacher, au dix-millieme. C'est la
   * contrainte, et elle n'est pas negociable : la changer reviendrait a
   * deplacer le retour du jeu en croyant ne toucher qu'a la sensation.
   *
   * A moyenne fixe il n'y a qu'un seul arbitrage, et il faut le dire : moins
   * de petites pieces veut dire PLUS de pieces qui ne paient pas. Elles
   * poussent la pile quand meme — mais elles ne paient pas, et elles passent
   * de trois lachers sur quatre a presque neuf sur dix. C'est le prix de
   * « moins souvent, plus gros », et il se paie la.
   *
   *                        avant     apres
   *   piece a 1 ou 2      16,00 %    3,90 %   quatre fois moins
   *   gain >= 10         1 / 29     1 / 23
   *   gain >= 25         1 / 141    1 / 79
   *   gain >= 50         1 / 909    1 / 368   deux fois et demie plus souvent
   *   gain >= 100        1 / 2857   1 / 1395
   *   ne paie pas        74,95 %   87,68 %   <- le prix
   */
  PRIZES: [
    [0,      8767830],  // 87.68%  la piece pousse, elle ne paie pas
    [1,       150000],  // 1.50%   (etait 8 %, et 29 % avant)
    [2,       240000],  // 2.40%   (etait 8 %)
    [5,       415000],  // 4.15%   (etait 5,6 %)
    [10,      300000],  // 3.00%   (etait 2,74 %)
    [25,      100000],  // 1.00%   (etait 0,60 %)
    [50,       20000],  // 0.20%   (etait 0,075 %)  ~1 sur 500
    [100,       5500],  // 0.055%  (etait 0,026 %)  ~1 sur 1 818
    [250,       1300],  // ~1 sur 7 692
    [500,        300],  // ~1 sur 33 333
    [1000,        60],  // ~1 sur 166 667
    [5000,         8],  // ~1 sur 1 250 000
    [50000,        2],  // ~1 sur 5 000 000  <- le gros lot, deux fois plus proche
  ],
  PRIZE_TOTAL: 10000000,

  /* ---- SWOGE Smash — equitable et verifiable, retour = 92 % ----
   *
   * Il etait a 50 %. C'est deux fois plus dur que le blackjack de la maison
   * d'a cote, et un joueur qui compare — ils comparent — n'en conclut pas que
   * ce jeu-la est dur : il en conclut que la maison n'est pas honnete, et
   * cette impression contamine les treize autres jeux. Le gain de tresorerie
   * ne payait pas ce prix-la.
   *
   * Ce qui a change n'est pas seulement le total. La forme comptait autant :
   * 85,76 % des tours ne rendaient RIEN, et un cinquieme du retour venait des
   * deux tirages les plus rares. On perdait donc presque toujours, en
   * attendant un evenement qu'on ne voyait jamais. Desormais quatre tours sur
   * dix rendent au moins la mise, et le 250x reste la pour la vitrine.
   *
   * Une mise coute SPIN_COST et rapporte (multiplicateur x mise).
   * [multiplicateur, poids] sur SPIN_TOTAL : Σ(poids·mult)/SPIN_TOTAL EST le
   * retour. Ici Σ = 9 200 000 / 10 000 000 = 0,92 exactement.
   */
  SPIN_COST: env('SPIN_COST', '1'),
  SPIN_PRIZES: [
    [0,    6066000],  // 60.66%  smash → rien
    [1,    2600000],  // 26.00%  la mise revient
    [2,     900000],  //  9.00%
    [5,     260000],  //  2.60%
    [10,    150000],  //  1.50%
    [50,     20000],  //  0.20%
    [250,     4000],  //  0.04%  eclat de jackpot
  ],
  SPIN_TOTAL: 10000000,

  // Mise variable au Smash : payout = multiplicateur x mise (max 250x).
  // Exposition maximale = SMASH_MAX_BET x 250.
  SMASH_MIN_BET: parseInt(env('SMASH_MIN_BET', '1'), 10),
  SMASH_MAX_BET: parseInt(env('SMASH_MAX_BET', '1000'), 10),

  // ---- SWOGE Blackjack ----
  BJ_MAX_BET: parseInt(env('BJ_MAX_BET', '100000'), 10),  // max $SWOGE per hand
  BJ_MIN_BET: parseInt(env('BJ_MIN_BET', '1'), 10),

  /* ---- Les paris annexes ----
   *
   * LE PLAFOND SEPARE, D'ABORD. Le 21+3 paie cent fois. Sans plafond propre,
   * une mise annexe au maximum de la table engagerait cent fois le maximum de
   * la table sur UNE carte — la banque peut perdre en une donne ce qu'elle
   * gagne en un mois. Le plafond est choisi pour que l'exposition annexe
   * maximale (1000 x 100 = 100 000) ne depasse pas celle d'une main principale
   * au maximum (100 000 x 2,5 = 250 000). On ne compte pas sur BJ_MAX_BET pour
   * borner l'annexe : ce sont deux risques de nature differente.
   *
   * L'ASSURANCE N'EST PAS PLAFONNEE ICI. Elle ne se pose pas avant la donne :
   * elle se propose quand le croupier montre un As, et la regle du jeu la borne
   * deja a la MOITIE de la main. Elle paie 2:1, donc son exposition suit la
   * main principale — lui appliquer le plafond annexe reviendrait a interdire
   * l'assurance des qu'on mise plus de 2000, ce qui n'a aucun sens.
   *
   * LES TABLES DE GAIN sont en « X pour 1 » : le joueur recoit X fois sa mise
   * EN PLUS de sa mise (donc X+1 rendus). Avantage maison MESURE par
   * bj_annexes.test.js sur ce moteur — et il faut lire ce chiffre-la, pas celui
   * d'un casino : notre sabot est INFINI, chaque carte est tiree independamment
   * des autres. Une paire parfaite y sort une fois sur 52 au lieu d'une fois
   * sur 62 dans un sabot de six jeux, et c'est tout ce qui separe les deux
   * mondes ici.
   *
   *   Perfect Pairs 6/12/25 ... RETOUR 101,9 % — LA MAISON PERD 1,9 %
   *   21+3 5/10/30/40/100 .... retour  99,2 %
   *   Assurance 2:1 .......... retour  92,3 %
   *
   * PERFECT PAIRS EST DONC FAVORABLE AU JOUEUR sur un sabot infini, et c'est le
   * seul palier « parfaite » qui le rend tel. La table demandee est posee telle
   * quelle ; le jour ou on veut la maison gagnante, UNE valeur suffit :
   * parfaite 22 rend 96,2 %, parfaite 23 rend 98,1 %. Le test mesure le retour
   * et l'affiche a chaque execution — il ne se degradera pas en silence.
   */
  BJ_SIDE_MAX_BET: parseInt(env('BJ_SIDE_MAX_BET', '1000'), 10),
  BJ_PP_PAY:  { parfaite: 25, couleur: 12, mixte: 6 },
  BJ_213_PAY: { brelanServi: 100, quinteFlush: 40, brelan: 30, quinte: 10, couleur: 5 },
  BJ_INS_PAY: 2,

  // ---- SWOGE Casino (jeux contre la banque) ----
  // Ici la MAISON joue son argent : contrairement au poker ou l'on prend une
  // commission sans risque, une session courte peut couter cher malgre les
  // 2,4 % d'avantage. Le plafond est donc volontairement bas.
  // Commission de la maison sur le GAIN NET (jamais sur les mises rendues :
  // une egalite rend exactement la mise). 1350 bps = 13,5 % du gain, ce qui
  // amene le retour joueur a 92 % — 8 % pour la maison. C'est deja bien
  // au-dessus des 2-3 % d'un vrai casino, mais assez bas pour qu'un joueur
  // reste. Reperes mesures : 0 -> 97,6 % · 1350 -> 92 % · 2000 -> 89 %
  // · 4200 -> 80 %. Une seule valeur a changer.
  CASINO_WIN_FEE_BPS: parseInt(env('CASINO_WIN_FEE_BPS', '1350'), 10),
  // ---- Hi-Lo ----
  // Avantage de la maison PAR PAS, applique sur le multiplicateur. Sur un jeu a
  // chaine c'est le seul reglage qui donne le meme taux de retour au joueur
  // prudent et au casse-cou. Reperes mesures sur 400 000 parties :
  //   300 bps -> 96,7 % a un pas, 89,9 % a trois, 84,0 % a cinq
  //     0 bps -> 99,7 % (le jeu est alors equitable, la maison ne gagne rien)
  HILO_EDGE_BPS: parseInt(env('HILO_EDGE_BPS', '300'), 10),

  // ---- Mines ----
  // Avantage de la maison preleve UNE SEULE FOIS, sur le multiplicateur final.
  // Volontairement different du Hi-Lo : la, chaque pas est un pari qu'on decide
  // de prendre en connaissant sa cote ; ici on s'engage sur une grille, et
  // prelever a chaque case donnerait 0,97^20 = 54 % de retour a qui va au bout,
  // sans que rien ne l'annonce au moment de miser. Preleve une fois, le taux
  // vaut (1 - avantage) qu'on ouvre une case ou vingt, avec une bombe ou
  // vingt-quatre. Reperes mesures : 300 bps -> 97 % · 0 bps -> 100 %.
  MINES_EDGE_BPS: parseInt(env('MINES_EDGE_BPS', '300'), 10),
  // Nombre de bombes par defaut sur la grille de 25 cases.
  MINES_DEFAUT: parseInt(env('MINES_DEFAUT', '3'), 10),
  // Les paliers proposes. La liste est ENVOYEE au navigateur avec le bareme
  // correspondant : changer les paliers ici suffit, aucune page a regenerer.
  MINES_CHOIX: (env('MINES_CHOIX', '1,3,5,10,24').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x >= 1 && x <= 24)),

  // ---- Boulier ----
  // Le prix d'UNE grille. Il est FIXE, et c'est la seule facon de rendre la
  // cagnotte honnete : si la mise variait, un plein a 10 SWOGE emporterait le
  // meme pot qu'un plein a 1000, alors qu'il l'aurait alimente dix fois moins.
  // Toutes les autres tables du casino laissent choisir la mise ; celle-ci ne
  // le peut pas. On joue plusieurs grilles au lieu de miser plus gros.
  // 100 SWOGE : le prix d'un jeton, accessible, et 190 402 grilles a 5 % font
  // les 952 012 SWOGE d'un cycle de cagnotte.
  BOULIER_PRIX: parseInt(env('BOULIER_PRIX', '100'), 10),
  // Nombre de grilles jouables sur un meme tirage. Elles partagent les 30
  // boules — c'est un vrai boulier, il ne tourne qu'une fois par manche.
  //
  // 50 et non 10. A 10 grilles la mise plafonnait a 1 000 SWOGE quand le
  // blackjack en accepte 10 000 : le seul jeu a cagnotte du casino etait
  // aussi celui ou l'on pouvait le moins engager, et un joueur qui vise le
  // plein a 1 sur 190 402 veut multiplier ses chances, c'est tout l'objet
  // d'acheter plusieurs grilles. A 50 la manche coute 5 000 SWOGE, dans
  // l'ordre de grandeur des autres tables.
  // Rien ne change pour la maison : chaque grille garde son prix, son
  // esperance et sa part de cagnotte. Dix fois plus de grilles, c'est dix
  // fois la meme chose, pas un pari different.
  BOULIER_GRILLES_MAX: parseInt(env('BOULIER_GRILLES_MAX', '50'), 10),
  // Ce que la maison met dans le pot le jour de l'ouverture. Ce n'est PAS un
  // reamorcage recurrent : apres le premier plein le pot se finance seul (le
  // gagnant emporte 80 %, 20 % restent). Ce million est un cadeau unique, il
  // ne pese sur la marge que la premiere fois.
  BOULIER_CAGNOTTE_AMORCE: env('BOULIER_CAGNOTTE_AMORCE', '1000000'),
  // Les trois phases de la salle. Dix secondes pour s'inscrire : assez pour
  // choisir un nombre de grilles et appuyer, trop court pour aller faire
  // autre chose — c'est ce qui garde tout le monde devant la cage.
  // Le tirage dure ce que dure l'animation du navigateur (30 boules a
  // 300 ms, plus une seconde de mise en route) : plus court, la salle
  // rouvrirait les mises pendant que les boules tombent encore.
  BOULIER_ATTENTE_MS: parseInt(env('BOULIER_ATTENTE_MS', '10000'), 10),
  BOULIER_TIRAGE_MS: parseInt(env('BOULIER_TIRAGE_MS', '10500'), 10),
  BOULIER_APRES_MS: parseInt(env('BOULIER_APRES_MS', '5000'), 10),
  // La graine de la chaine d'engagement. Posee, elle survit aux
  // redeploiements : l'empreinte annoncee reste verifiable. Absente, une
  // chaine neuve est tiree au demarrage — et l'engagement change.
  BOULIER_GRAINE: env('BOULIER_GRAINE', ''),

  // ---- Plinko ----
  // Avantage de la maison preleve sur le multiplicateur, comme au Mines : une
  // bille est un coup unique, il n'y a pas de chaine sur laquelle prelever.
  // Les tables sont ENGENDREES a partir de cette valeur (voir plinko.js), pas
  // recopiees : changer le chiffre suffit, tout se remet a l'echelle.
  // Reperes mesures : 300 bps -> 96,8 a 97,0 % selon la table · 0 -> ~100 %.
  PLINKO_EDGE_BPS: parseInt(env('PLINKO_EDGE_BPS', '300'), 10),
  PLINKO_RANGEES: parseInt(env('PLINKO_RANGEES', '12'), 10),   // plateau par defaut
  PLINKO_RISQUE: env('PLINKO_RISQUE', 'medium'),

  // ---- Crash ----
  // L'avantage n'est PAS preleve sur les gains : c'est la probabilite que la
  // manche crashe a 1.00x. Consequence a connaitre avant de toucher au chiffre :
  // le retour est le meme quelle que soit la cible visee (voir crash.js), donc
  // 300 bps = 97,00 % exactement, a 1.01x comme a 10 000x.
  CRASH_EDGE_BPS: parseInt(env('CRASH_EDGE_BPS', '300'), 10),
  // Plafond du multiplicateur. La maison doit pouvoir payer ce qu'elle affiche :
  // 10 000x sur la mise maximale, c'est le vrai risque a couvrir.
  CRASH_PLAFOND: parseFloat(env('CRASH_PLAFOND', '10000')),
  // Vitesse de la courbe, par milliseconde : multi(t) = e^(vitesse x t).
  // Reperes : 10 s -> 1,82x · 30 s -> 6,05x · 60 s -> 36,6x.
  CRASH_VITESSE: parseFloat(env('CRASH_VITESSE', '0.00006')),
  CRASH_ATTENTE_MS: parseInt(env('CRASH_ATTENTE_MS', '7000'), 10),  // fenetre de mises
  CRASH_APRES_MS: parseInt(env('CRASH_APRES_MS', '4000'), 10),      // temps d'arret apres le crash
  /* Le sel est PUBLIC et doit etre fixe une fois pour toutes : il prouve que la
     chaine n'a pas ete tiree mille fois pour garder la pire. Publiez-le (un hash
     de bloc a venir fait un excellent sel). Le changer invalide la verification
     de tout l'historique deja joue. */
  CRASH_SEL: env('CRASH_SEL', 'swoge-crash-v1'),
  /* Longueur de la chaine, en manches. A ~15 s la manche, 50 000 tiennent une
     semaine et demie. Quand elle est epuisee, le serveur en tire une nouvelle et
     publie un nouvel engagement. */
  CRASH_CHAINE: parseInt(env('CRASH_CHAINE', '50000'), 10),
  /* La graine de la chaine. Laissee vide, elle est tiree au hasard au premier
     demarrage puis conservee dans l'etat — la chaine survit aux redeploiements.
     Ne JAMAIS la publier avant que la chaine soit epuisee : elle donne toutes
     les manches a venir. */
  CRASH_GRAINE: env('CRASH_GRAINE', ''),

  // ---- Connect 4, un contre un ----
  // La commission est prise sur LE POT ENTIER (les deux mises), pas sur le seul
  // benefice : c'est ce qui est annonce au joueur, et 5 % du pot vaut le double
  // de 5 % du gain.
  P4_RAKE_BPS: parseInt(env('P4_RAKE_BPS', '500'), 10),        // 500 = 5 %
  P4_MIN: parseInt(env('P4_MIN', '10'), 10),
  P4_MAX: parseInt(env('P4_MAX', '10000000'), 10),
  // Les paliers proposes a la creation. Le joueur peut saisir n'importe quel
  // montant entre le minimum et le maximum ; ceux-ci ne sont que des raccourcis.
  P4_MISES: (env('P4_MISES', '10,100,1000,10000,100000,1000000,10000000').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0)),
  /* Delai par coup. Sans lui, un joueur qui ferme son onglet gelerait la mise
     de l'autre pour toujours — l'argent est bloque tant que la partie n'est pas
     finie. Passe ce delai, celui qui devait jouer perd. */
  P4_COUP_MS: parseInt(env('P4_COUP_MS', '45000'), 10),
  /* Duree de vie d'une table qui n'a jamais trouve d'adversaire. Au-dela, la
     mise est rendue a celui qui l'a posee. */
  P4_ATTENTE_MS: parseInt(env('P4_ATTENTE_MS', '600000'), 10),
  /* Duree de vie d'une demande de revanche. Bien plus courte : elle s'adresse
     a quelqu'un qui vient de finir la partie et qui est encore la, et elle
     immobilise la mise du demandeur en attendant la reponse. */
  P4_REVANCHE_MS: parseInt(env('P4_REVANCHE_MS', '90000'), 10),
  // Commission aussi sur les parties nulles ? Non par defaut : personne n'a
  // gagne, il n'y a rien a partager.
  P4_RAKE_SUR_NUL: env('P4_RAKE_SUR_NUL', '0') === '1',

  /* ---- Morpion, un contre un ----
   * Le morpion est NUL a jeu parfait : deux joueurs attentifs font partie
   * nulle a tous les coups. La commission sur la nulle reste donc a zero —
   * faire payer une egalite que les deux peuvent forcer, et le jeu ne se
   * joue pas deux fois. La pendule est courte : on voit le coup en une
   * seconde, et quarante-cinq secondes devant trois cases sont une eternite.
   */
  MP_RAKE_BPS: parseInt(env('MP_RAKE_BPS', '500'), 10),
  MP_MIN: parseInt(env('MP_MIN', '10'), 10),
  MP_MAX: parseInt(env('MP_MAX', '10000000'), 10),
  MP_MISES: (env('MP_MISES', '10,100,1000,10000,100000,1000000,10000000').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0)),
  MP_COUP_MS: parseInt(env('MP_COUP_MS', '20000'), 10),
  MP_ATTENTE_MS: parseInt(env('MP_ATTENTE_MS', '600000'), 10),
  MP_REVANCHE_MS: parseInt(env('MP_REVANCHE_MS', '90000'), 10),
  MP_RAKE_SUR_NUL: env('MP_RAKE_SUR_NUL', '0') === '1',

  /* ---- Dames, un contre un ----
   * Une partie de dames dure plus longtemps qu'un Connect 4 et demande plus
   * de reflexion par coup : la pendule est donc plus large. Le reste est
   * identique — meme commission, meme chemin d'argent.
   */
  DM_RAKE_BPS: parseInt(env('DM_RAKE_BPS', '500'), 10),
  DM_MIN: parseInt(env('DM_MIN', '10'), 10),
  DM_MAX: parseInt(env('DM_MAX', '10000000'), 10),
  DM_MISES: (env('DM_MISES', '10,100,1000,10000,100000,1000000,10000000').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0)),
  DM_COUP_MS: parseInt(env('DM_COUP_MS', '60000'), 10),
  DM_ATTENTE_MS: parseInt(env('DM_ATTENTE_MS', '600000'), 10),
  DM_REVANCHE_MS: parseInt(env('DM_REVANCHE_MS', '90000'), 10),
  DM_RAKE_SUR_NUL: env('DM_RAKE_SUR_NUL', '0') === '1',

  /* ---- Morpion Fantome ----
   *
   * Trois pions chacun ; le quatrieme efface le plus ancien des siens. La
   * grille ne se remplit donc jamais, et le jeu n'a pas la nulle systematique
   * qui tue le morpion ordinaire des que les deux joueurs savent jouer.
   *
   * La pendule est celle du morpion, pas celle des dames : on voit le coup en
   * une seconde, et attendre une minute devant trois cases est insupportable.
   * Elle est un peu plus large quand meme — il faut aussi regarder quel pion
   * va disparaitre, ce qui est une question de plus a chaque coup.
   *
   * RAKE_SUR_NUL a zero, comme partout ailleurs en 1v1 : la seule nulle
   * possible ici est le plafond de coups, et faire payer deux joueurs parce
   * qu'ils ont tourne en rond transformerait la patience en piege.
   */
  MF_RAKE_BPS: parseInt(env('MF_RAKE_BPS', '500'), 10),
  MF_MIN: parseInt(env('MF_MIN', '10'), 10),
  MF_MAX: parseInt(env('MF_MAX', '10000000'), 10),
  MF_MISES: (env('MF_MISES', '10,100,1000,10000,100000,1000000,10000000').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0)),
  MF_COUP_MS: parseInt(env('MF_COUP_MS', '30000'), 10),
  MF_ATTENTE_MS: parseInt(env('MF_ATTENTE_MS', '600000'), 10),
  MF_REVANCHE_MS: parseInt(env('MF_REVANCHE_MS', '90000'), 10),
  MF_RAKE_SUR_NUL: env('MF_RAKE_SUR_NUL', '0') === '1',

  /* ---- Le Dernier Chiffre ----
   *
   * Chacun cache un nombre de 1 a 100 ; le plus proche du tirage SANS LE
   * DEPASSER remporte le pot.
   *
   * La regle d'origine — « le plus proche gagne » — a ete mesuree avant
   * d'etre ecrite : sur une cible uniforme, la meilleure reponse converge
   * vers le milieu, les deux joueurs y arrivent, et la partie devient un pile
   * ou face avec une commission dessus. « Sans depasser » fait basculer la
   * meilleure reponse : sous 55 on monte juste au-dessus de l'adversaire,
   * au-dessus on joue tres petit et on le laisse se griller. Aucun choix ne
   * bat tous les autres, donc c'est un jeu.
   *
   * La pendule est large pour un jeu a un seul coup : il n'y a rien a jouer
   * vite, et l'attente ne coute rien puisque les deux choisissent en meme
   * temps. Vingt secondes suffiraient techniquement ; quarante-cinq laissent
   * le temps de reflechir a la position, ce qui EST le jeu.
   *
   * RAKE_SUR_NUL a zero : la nulle arrive quand les deux ont depasse, donc
   * sur un tirage bas que personne n'a choisi. Faire payer le hasard aux deux
   * joueurs serait leur faire porter ce qu'ils ne controlent pas.
   */
  DC_RAKE_BPS: parseInt(env('DC_RAKE_BPS', '500'), 10),
  DC_MIN: parseInt(env('DC_MIN', '10'), 10),
  DC_MAX: parseInt(env('DC_MAX', '10000000'), 10),
  DC_MISES: (env('DC_MISES', '10,100,1000,10000,100000,1000000,10000000').split(',')
    .map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0)),
  DC_COUP_MS: parseInt(env('DC_COUP_MS', '45000'), 10),
  DC_ATTENTE_MS: parseInt(env('DC_ATTENTE_MS', '600000'), 10),
  DC_REVANCHE_MS: parseInt(env('DC_REVANCHE_MS', '90000'), 10),
  DC_RAKE_SUR_NUL: env('DC_RAKE_SUR_NUL', '0') === '1',

  /* ---- LES PARIS SPORTIFS ----
   *
   * Les cotes sont RECOPIEES chez un bookmaker, telles quelles. Ce n'est pas
   * de la paresse : leur somme inverse depasse 1, et ce surplus est la marge
   * du bookmaker — donc la notre. Mesuree sur le premier lot recopie :
   * 9,9 %, soit trois fois l'avantage du casino. Un lot dont la marge serait
   * nulle ou negative est refuse au chargement, parce que ca voudrait dire
   * qu'une cote a ete recopiee de travers.
   *
   * CE QUI REND CE SYSTEME DIFFERENT DE TOUT LE RESTE : la mise part
   * aujourd'hui et le resultat tombe dans trois jours. Entre les deux, la
   * maison porte un engagement qui n'existe nulle part ailleurs ici.
   *
   * D'ou le plafond d'ENGAGEMENT, qui n'est pas un plafond de mise : c'est
   * ce que la maison peut devoir sur UN match, toutes issues confondues, en
   * prenant la pire. Sans lui, quinze joueurs au plafond sur la meme issue a
   * 7,50 engagent onze millions et demi sur un seul resultat. L'avantage est
   * reel a la longue — mais « a la longue » ne paie pas un coffre vide
   * samedi soir.
   */
  PARI_MIN: parseInt(env('PARI_MIN', '100'), 10),
  /* ---- LA MISE MAXIMALE, ET CE QU'ELLE HEURTE ----
   * Elle monte a un million sur demande du proprietaire. Deux bornes plus
   * hautes qu'elle continuent de s'appliquer, et il faut savoir lesquelles
   * mordent, parce qu'aucune des deux ne se voit dans ce chiffre-ci :
   *
   *   • GAIN_MAX, cinq millions. Une mise au plafond ne peut donc pas etre
   *     posee au-dessus de la cote 5,00 — le bulletin serait refuse pour
   *     depassement de gain. Le gros parieur est de fait limite aux favoris.
   *
   *   • ENGAGEMENT_MAX, deux millions PAR RENCONTRE. Une seule mise au
   *     plafond a 2,00 remplit donc la rencontre entiere : la suivante, sur
   *     un score qui gagnerait en meme temps, sera refusee. Une affiche se
   *     ferme desormais en UN pari.
   *
   * Ces deux bornes n'ont pas ete relevees, parce qu'elles ne mesurent pas la
   * meme chose : la mise est ce qu'un joueur risque, l'engagement est ce que
   * la MAISON doit sortir. Multiplier la premiere par dix ne multiplie pas la
   * capacite de payer de la seconde. */
  PARI_MAX: parseInt(env('PARI_MAX', '1000000'), 10),
  PARI_ENGAGEMENT_MAX: parseFloat(env('PARI_ENGAGEMENT_MAX', '2000000')),

  /* ---- LE COMBINE ----
   *
   * Plusieurs selections sur un seul bulletin : les cotes se MULTIPLIENT et
   * toutes doivent passer. Une seule fausse et le pari entier tombe.
   *
   * C'est bon pour les deux cotes, et il faut le dire honnetement : le joueur
   * atteint des rapports impossibles en simple, et la maison voit ses marges
   * se multiplier aussi. A 7,7 % la selection, un combine de cinq porte 45 %
   * de marge. Ce n'est pas un piege — c'est le prix du rapport, et il est
   * affiche.
   *
   * MAIS L'ENGAGEMENT EXPLOSE AVEC LE RAPPORT. Cinq selections a 2,00 font
   * trente-deux fois la mise : au plafond, plusieurs millions dus sur UN
   * pari. Deux bornes de plus que pour un simple :
   *   • JAMBES_MAX limite la longueur, donc la cote atteignable ;
   *   • GAIN_MAX plafonne ce qu'un seul bulletin peut rapporter, quelle que
   *     soit la combinaison. C'est la borne qui compte vraiment : elle tient
   *     meme si quelqu'un trouve une suite d'outsiders a laquelle on n'avait
   *     pas pense.
   */
  PARI_JAMBES_MAX: parseInt(env('PARI_JAMBES_MAX', '8'), 10),
  PARI_GAIN_MAX: parseFloat(env('PARI_GAIN_MAX', '5000000')),

  /* ---- virements entre joueurs ----
     Le depot prealable n'est pas une formalite : sans lui, ouvrir dix
     portefeuilles jetables, ramasser dix bonus de bienvenue et tout rassembler
     sur un onzieme ne couterait rien. */
  /* La photo de profil televersee s'affiche chez les AUTRES joueurs. On la
     reserve donc a ceux qui ont depose au moins une fois : ca donne un compte
     a qui parler si l'image pose probleme, et ca decourage le jetable. */
  AVATAR_REQUIRE_DEPOSIT: env('AVATAR_REQUIRE_DEPOSIT', '1') === '1',
  /* =====================================================================
   * LES COMPTES DE LA MAISON
   * =====================================================================
   *
   * Des adresses qui appartiennent au projet : reserve d'ecosysteme, comptes
   * d'essai. Elles jouent comme n'importe qui — c'est meme leur raison d'etre,
   * on ne teste pas une salle sans y jouer — mais leurs jetons ne sont PAS une
   * dette envers un joueur : ils sont deja a la maison.
   *
   * ---- CE QU'ILS NE FONT PAS : sortir du « du » ----
   *
   * Ma premiere version les en sortait, ce qui faisait monter le surplus
   * retirable d'autant. C'etait juste A UNE CONDITION : que ces comptes ne
   * puissent plus retirer. Ils le peuvent — c'est la decision du
   * proprietaire — donc leurs jetons restent une creance comme une autre.
   *
   * Les sortir aurait annonce quatre-vingt-un millions de surplus qui peuvent
   * partir a tout moment : le proprietaire retire le surplus, le compte
   * retire ses jetons, et le coffre est court de la meme somme. On ne s'en
   * apercoit qu'au moment ou un vrai joueur ne peut plus retirer.
   *
   * UN CHIFFRE DE SOLVABILITE SE CALCULE AU PIRE. Jamais au mieux.
   *
   * ---- ce qu'ils font : deux nombres au lieu d'un ----
   *
   * L'administration affiche « Held by house accounts : X », a cote du
   * surplus, avec le total « si vous les considerez comme acquis ». Le
   * proprietaire lit sa vraie position sans que le chiffre d'alarme devienne
   * faux. Deux nombres, jamais un seul qui melange les deux.
   *
   * ---- et le rendement qu'elle se verse a elle-meme ----
   *
   * Un compte maison qui met au staking se paie avec l'argent de la maison :
   * ca tourne en rond. Compte comme un cout quotidien, ce rendement faisait
   * afficher un drain quatre-vingts fois trop gros et une autonomie de
   * quelques jours alors que RIEN ne quitte le coffre. Le drain ne porte donc
   * que sur le staking des joueurs.
   */
  COMPTES_MAISON: (env('COMPTES_MAISON', '') || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x)),

  TRANSFER_MIN: parseFloat(env('TRANSFER_MIN', '10000')),

  /* =====================================================================
   * LE MARCHE — vendre un objet a un autre joueur
   * =====================================================================
   *
   * ---- pourquoi il existe ----
   *
   * L'edition est fermee : 9 600 pieces, dix mythiques de chaque dessin. Une
   * rarete fermee sans moyen d'echanger n'est qu'un tirage — celui a qui il
   * manque un legendaire pour finir sa famille n'a aucun recours, et celui qui
   * en a deux n'a rien a en faire. Le marche est ce qui transforme les deux
   * en une transaction.
   *
   * ---- pourquoi le prix n'est PAS fixe par nous ----
   *
   * On ne cote rien. Le vendeur pose son prix, l'acheteur paie ou passe.
   * Publier un bareme reviendrait a dire ce que vaut un objet, et ce n'est ni
   * notre role ni quelque chose que nous pourrions tenir.
   *
   * ---- LE MARCHE NE FABRIQUE RIEN ----
   *
   * Il DEPLACE. Le registre d'emission ne bouge jamais d'un marche : une piece
   * vendue est la meme piece, chez quelqu'un d'autre. C'est la propriete la
   * plus importante du fichier et elle est testee — un marche qui pourrait
   * dupliquer detruirait l'edition sans que personne le voie avant longtemps.
   *
   * ---- ni XP, ni progression ----
   *
   * Acheter un objet ne rapporte AUCUNE XP. Sinon deux comptes complices se
   * revendent le meme objet en boucle : chaque aller-retour le rend « jamais
   * possede » et paierait sa prime. L'XP recompense le jeu ; le marche
   * recompense l'argent. Les deux ne se melangent pas.
   */
  /* =====================================================================
   * LE RACHAT IMMEDIAT — la maison reprend l'objet, tout de suite
   * =====================================================================
   *
   * La vitrine demande un acheteur. Celui qui veut se debarrasser d'un commun
   * maintenant n'a pas envie d'attendre trois jours qu'on veuille bien le lui
   * prendre. La maison le reprend donc a un prix FIXE, connu d'avance, et
   * nettement plus bas que ce qu'un joueur en donnerait.
   *
   * ---- le prix est DERIVE de la rarete, pas ecrit ----
   *
   * poids = 1000 / plafond, le meme bareme que le classement des
   * collectionneurs : le commun vaut 1, le mythique vaut 100. Ecrire cinq
   * nombres a la main les rendrait faux au premier changement de plafond, et
   * faux EN SILENCE. Ici ils suivent.
   *
   *   Common 500 · Rare 1 250 · Epic 3 330 · Legendary 12 500 · Mythic 50 000
   *
   * ---- LE SEUL DANGER, ET IL EST CHIFFRE ----
   *
   * Si un coffre rapportait au rachat plus qu'il ne coute, on aurait une
   * machine a jetons : acheter, revendre, recommencer. Mesure sur les trois
   * coffres de la saison 1 :
   *
   *   Wooden  4 000 -> 764 de rachat espere   19,1 %
   *   Golden 40 000 -> 1 616                   4,0 %
   *   Mythic 400 000 -> 4 649                  1,2 %
   *
   * Le test refait ce calcul a chaque execution, sur TOUS les coffres de
   * TOUTES les saisons. Une base de 1 000 tiendrait aussi (38 % au pire), mais
   * a ce niveau plus personne ne passerait par la vitrine : le rachat doit
   * rester une sortie de secours, pas le prix du marche.
   *
   * ---- CE QUE LE RACHAT FAIT A L'EDITION ----
   *
   * L'objet RETOURNE AU STOCK : le registre d'emission redescend, et quelqu'un
   * pourra le retirer d'un coffre a nouveau. Le plafond cesse donc de dire
   * « dix seront tirees en tout » pour dire « dix existent a la fois ».
   *
   * Ce n'est PAS un detail de formulation : c'est la promesse affichee sous la
   * planche. Elle doit changer avec ce reglage — voir RACHAT_RECYCLE.
   */
  RACHAT_BASE: parseFloat(env('RACHAT_BASE', '500')),
  /* A 1 : l'objet rachete retourne au stock et pourra ressortir d'un coffre.
     A 0 : il est detruit — le plafond redevient « X seront tirees en tout »,
     et l'offre ne fait que diminuer. Les deux se defendent ; ce qui ne se
     defend pas, c'est d'annoncer l'un et de faire l'autre. */
  RACHAT_RECYCLE: env('RACHAT_RECYCLE', '1') !== '0',
  /*
   * ---- LE VERROU DU RACHAT : DU VOLUME JOUE, PAS UN DEPOT ----
   *
   * Le rachat paie des jetons contre un objet. Sans condition, il ouvre la
   * seule vraie ferme du site — pas le marche, pas les quetes : LE COFFRE
   * GRATUIT. Une adresse jetable le prend chaque jour et le revend. A
   * l'esperance du coffre de bois, cela fait 764 jetons par adresse et par
   * jour, sans qu'un jeton soit jamais entre. Mille adresses, et c'est trois
   * quarts de million par jour d'emission pure.
   *
   * Pourquoi le VOLUME et pas le depot :
   *
   *   un depot se retire. Deposer, debloquer, retirer, recommencer sur
   *   l'adresse suivante — la porte s'ouvre avec de l'argent qu'on recupere,
   *   donc elle ne coute rien. Le volume, lui, EST DEPENSE : le jouer, c'est
   *   avoir laisse l'avantage de la maison sur la table. On ne peut pas le
   *   reprendre, et c'est exactement ce qu'on demande a une porte anti-ferme.
   *
   * Le credit de bienvenue ne permet pas d'y arriver : il faudrait le
   * multiplier par cent contre un avantage maison, ce qui ne se produit pas.
   */
  RACHAT_VOLUME_MIN: parseFloat(env('RACHAT_VOLUME_MIN', '100000')),
  MARCHE_FRAIS_BPS: parseInt(env('MARCHE_FRAIS_BPS', '500'), 10),   // 5 % au vendeur
  MARCHE_PRIX_MIN: parseFloat(env('MARCHE_PRIX_MIN', '100')),
  MARCHE_PRIX_MAX: parseFloat(env('MARCHE_PRIX_MAX', '50000000')),
  /* Combien d'annonces un joueur peut tenir en meme temps. Sans borne, on
     peut mettre toute sa collection en vitrine et rendre la liste illisible
     pour tous les autres. */
  MARCHE_ANNONCES_MAX: parseInt(env('MARCHE_ANNONCES_MAX', '20'), 10),
  /* Le marche demande un depot, comme le virement : c'est le meme geste —
     faire passer de la valeur d'un compte a un autre — et la meme raison. */
  MARCHE_REQUIERT_DEPOT: env('MARCHE_REQUIERT_DEPOT', '1') === '1',
  /* ---- LE FOND DE LA MAISON EST FERME ----
   *
   * La boutique ne fabrique plus de potions : tout ce qui s'y vend a ete
   * trouve puis mis en vente par un joueur. File vide, rayon vide — « OUT OF
   * STOCK », et c'est aux joueurs de le remplir.
   *
   * C'est un choix de jeu, et il a un prix qu'il vaut mieux connaitre :
   * personne ne peut acheter de potion de soin tant que personne n'en vend, et
   * ici la mort detruit un equipement paye en argent reel. Poser
   * POTIONS_FOND_MAISON=1 rouvre le robinet sans toucher a une ligne du
   * marche — la maison se remet alors DERRIERE la file, jamais devant.
   *
   * Les fioles de STAT n'ont jamais eu de fond, et n'en auront pas : leur prix
   * tient entierement au fait qu'aucune n'existe hors de celles qu'un joueur
   * est alle chercher. */
  POTIONS_FOND_MAISON: env('POTIONS_FOND_MAISON', '0') === '1',
  /* ---- LE PRIX D'UN NOM ----
   *
   * Un nom public est UNIQUE sur toute la plateforme : le prendre, c'est le
   * retirer a tous les autres, pour toujours. Gratuit, cette rarete se fait
   * ramasser par le premier qui passe — cent comptes jetables prennent cent
   * bons noms en une soiree, et plus personne ne peut s'appeler comme il veut.
   *
   * Mille jetons, BRULES. Pas encaisses : bruler evite qu'un prix sur
   * l'identite ressemble a un peage, et lie la rareté des noms a la rareté du
   * jeton. C'est le sink le plus honnete du catalogue — le joueur paie pour
   * quelque chose qu'il voulait, et on ne lui promet rien en retour.
   *
   * Ce qui reste GRATUIT, et doit le rester :
   *   • le nom par defaut (les six premiers caracteres de l'adresse) ;
   *   • reposer EXACTEMENT le nom qu'on possede deja — sinon un joueur paierait
   *     pour changer sa photo, ce qu'il ne comprendrait pas ;
   *   • les noms deja choisis avant l'entree en vigueur du prix.
   */
  NAME_PRICE: parseFloat(env('NAME_PRICE', '1000')),
  TRANSFER_REQUIRE_DEPOSIT: env('TRANSFER_REQUIRE_DEPOSIT', '1') === '1',

  /* ---- le parrainage ----
   *
   * Le parrain touche une part du REVENU que son filleul rapporte a la
   * maison. Ni un pourcentage des depots, ni un pourcentage du volume : le
   * revenu reel. C'est ce qui rend le systeme etanche sans aucun garde-fou —
   * pour se verser dix pour cent de ses propres pertes, il faut d'abord en
   * perdre cent.
   *
   * Le revenu d'une manche vaut :
   *   • contre la banque : la mise moins ce qui a ete rendu. Signe : une
   *     manche gagnee par le filleul compte NEGATIVEMENT ;
   *   • en un-contre-un (Connect 4, dames, morpion, poker) : une fraction de
   *     la mise. Ce que la maison prend vraiment y est plus gros, mais deux
   *     comptes complices peuvent fabriquer du volume a volonte — on n'en
   *     compte donc qu'une petite part, et la complicite reste perdante.
   */
  REFERRAL_BPS: parseInt(env('REFERRAL_BPS', '1000'), 10),        // 10 % du revenu — le palier de depart
  /* ---- LA PART MONTE PAR PALIER DE NIVEAU ----
   *
   * Un point par palier, de 10 % a Bronze jusqu'a 20 % a SWOLE. Deux points
   * d'un coup sur le dernier : le palier qui demande cinq cents millions de
   * volume ne peut pas valoir la meme marche que les autres.
   *
   * C'est le SEUL avantage chiffre du systeme de niveaux, et le seul qu'on
   * puisse accorder sans risque : ce n'est pas un montant, c'est une PART DU
   * REVENU REEL du filleul. Doubler la part ne peut donc jamais couter plus
   * que ce que le filleul a rapporte — au pire la maison garde 80 % au lieu
   * de 90 % de quelque chose qu'elle a deja encaisse. Un bonus fixe, lui,
   * aurait pu couter plus que ce qu'il rapporte.
   *
   *   Bronze 10 · Silver 11 · Gold 12 · Platinum 13 · Diamond 14
   *   Master 15 · Champion 16 · Legend 17 · Mythic 18 · SWOLE 20
   */
  REFERRAL_PALIER_BPS: String(env('REFERRAL_PALIER_BPS',
    '1000,1100,1200,1300,1400,1500,1600,1700,1800,2000'))
    .split(',').map((x) => parseInt(x, 10)).filter((x) => x > 0),
  /* Le DELAI avant qu'un gain de parrainage soit encaissable.
   *
   * Sans lui, une part est versee des la manche perdue par le filleul — et si
   * le filleul reprend tout le lendemain, la maison a paye sur un revenu
   * qu'elle n'a plus. Avec le delai, le gain reste en attente pendant sept
   * jours et REDESCEND si le filleul se refait dans l'intervalle. Ce qui est
   * mur, en revanche, ne se reprend jamais.
   *
   * Sept jours parce que c'est l'ordre de grandeur d'une serie : au-dela, ce
   * qui reste est du revenu que la maison a vraiment garde. */
  /* ---- LA PRIME DU RECRUTEUR DE RECRUTEURS ----
   *
   * Le probleme : on voudrait que les gens amenent des gens QUI AMENENT DES
   * GENS. La facon evidente est un deuxieme etage — le parrain touche un
   * pourcentage sur les filleuls de ses filleuls. On ne le fait pas, et pour
   * une raison qui n'est pas de gout : un etage de plus, c'est une part de
   * revenu qui remonte a quelqu'un qui n'a amene personne DIRECTEMENT, et
   * c'est exactement la forme qu'on ne veut pas avoir a defendre.
   *
   * Ici, la recompense reste sur le lien DIRECT : le parrain touche toujours
   * un pourcentage du revenu de SON filleul, et de personne d'autre. Ce qui
   * change, c'est le pourcentage — il monte quand ce filleul-la se met a
   * amener du monde a son tour.
   *
   * Meme effet sur le comportement (« amene quelqu'un qui amene »), un seul
   * etage a tenir, et pas un centime qui vienne d'ailleurs que du revenu
   * qu'on encaisse vraiment.
   *
   * L'index est le nombre de filleuls de ce filleul QUI ONT DEJA RAPPORTE.
   * Pas le nombre d'inscrits : sinon la prime se gagnerait en creant des
   * comptes vides, et l'on aurait paye pour du recrutement au lieu de payer
   * pour du revenu. C'est la meme regle que partout ailleurs dans ce
   * systeme — ce qui compte, c'est ce que la maison a encaisse.
   *
   *   0 recrue : +0 · 1 : +2 · 2 : +4 · 3 : +6 · 4 : +8 · 5 et plus : +10
   */
  REFERRAL_RECRUTEUR_BPS: String(env('REFERRAL_RECRUTEUR_BPS', '0,200,400,600,800,1000'))
    .split(',').map((x) => parseInt(x, 10)).filter((x) => x >= 0),
  /* Le PLAFOND, tout compris. Vingt pour cent de palier plus dix de prime font
   * trente : a trois pour cent d'avantage maison, c'est 0,9 % du volume mise
   * qui repart en parrainage. Le plafond n'est pas la pour ce cas-la, il est
   * la pour le jour ou quelqu'un montera une des deux tables sans regarder
   * l'autre — une part qui approcherait cent pour cent ferait payer a la
   * maison tout ce qu'elle gagne, et le systeme ne le refuserait nulle part
   * ailleurs. */
  REFERRAL_PART_MAX_BPS: parseInt(env('REFERRAL_PART_MAX_BPS', '3000'), 10),
  REFERRAL_HOLD_DAYS: parseFloat(env('REFERRAL_HOLD_DAYS', '7')),
  REFERRAL_PVP_BPS: parseInt(env('REFERRAL_PVP_BPS', '100'), 10), // 1 % de la mise en 1v1
  /* Ce que touche le FILLEUL en arrivant par un lien. Personne ne partage un
   * lien qui ne donne rien a l'ami.
   *
   * ---- pourquoi deux verrous, et pas un cadeau tout simple ----
   *
   * Un cadeau verse au premier depot, quel qu'en soit le montant, se recolte
   * a la chaine : cent portefeuilles jetables, un jeton depose avec chacun,
   * cent cadeaux. Le depot est reel mais derisoire, et l'operation est
   * rentable. Deux verrous, donc :
   *
   *  1. un depot MINIMUM. Il faut engager vingt fois le cadeau pour l'avoir,
   *     et cet argent-la est reellement immobilise sur la chaine ;
   *  2. une MISE A ATTEINDRE avant que le cadeau puisse ressortir. C'est le
   *     seul verrou qui coute vraiment quelque chose au recolteur : pour
   *     retirer, il doit d'abord jouer, et jouer coute l'avantage de la
   *     maison. Sans lui, le premier verrou ne fait que deplacer le prix
   *     d'entree.
   */
  REFERRAL_WELCOME: env('REFERRAL_WELCOME', '500'),
  REFERRAL_WELCOME_MIN: parseFloat(env('REFERRAL_WELCOME_MIN', '10000')),
  /* La sortie de secours, en multiples du cadeau. Le verrou principal n'est
     PAS un volume a miser — il se contournerait par le jeu le moins cher :
     miser au blackjack, dont l'avantage maison est d'un demi pour cent, ne
     coute presque rien. Le verrou principal est que LA MAISON AIT GAGNE le
     montant du cadeau sur ce joueur.
     Ce volume-ci ne sert qu'au joueur honnete et chanceux, qui gagne et ne
     debloquerait jamais : a deux cents fois le cadeau mise, le compte est
     largement rentable meme au jeu le moins cher. */
  REFERRAL_WELCOME_ROLLOVER: parseFloat(env('REFERRAL_WELCOME_ROLLOVER', '200')),

  /* ---- LE ROBINET DE L EXPLOITANT ----
   *
   * Crediter un joueur depuis le panneau, sans passer par la chaine : un
   * dedommagement, un lot de concours, une erreur a rattraper. C'est
   * commode, et c'est exactement pour ca que ca demande une borne.
   *
   * Ces jetons-la ne viennent d'AUCUN depot. Ils augmentent ce que la maison
   * doit sans rien ajouter au coffre : cent envois d'un million, et le
   * surplus affiche par /stats passe sous zero — c'est-a-dire que tout le
   * monde ne peut plus etre paye. La borne n'est donc pas une precaution
   * d'usage, c'est la seule chose qui separe « un geste commercial » de
   * « le coffre est vide ».
   *
   * Une ENVELOPPE GLISSANTE, pas un compteur par envoi : ce qui compte est
   * ce qui est sorti sur les douze dernieres heures, quel que soit le nombre
   * de joueurs servis. Un plafond par envoi seul se contourne en dix clics.
   * L'enveloppe se libere au fur et a mesure que les envois vieillissent —
   * le panneau montre les deux : la jauge, et quand le prochain jeton
   * revient. */
  CREDIT_ADMIN_MAX: parseFloat(env('CREDIT_ADMIN_MAX', '500000')),
  CREDIT_ADMIN_FENETRE_H: parseFloat(env('CREDIT_ADMIN_FENETRE_H', '12')),

  // ---- Sessions ----
  // Duree pendant laquelle une signature vaut connexion. Passe ce delai, le
  // joueur resigne une fois. Trente jours est le compromis habituel : assez
  // long pour qu'on ne le remarque pas, assez court pour qu'un jeton vole
  // finisse par mourir.
  SESSION_TTL_SEC: parseInt(env('SESSION_TTL_SEC', String(30 * 86400)), 10),
  // Secret qui signe les jetons. Laisse vide, il est engendre au premier
  // demarrage et conserve avec l'etat — les sessions survivent donc aux
  // redeploiements. Le changer deconnecte TOUT LE MONDE d'un coup : c'est le
  // bouton d'urgence si un jeton fuite.
  SESSION_SECRET: env('SESSION_SECRET', ''),

  CASINO_MIN_BET: parseInt(env('CASINO_MIN_BET', '10'), 10),
  // Plafond volontairement bas : ici c'est l'argent de la maison qui est en
  // jeu, et au Hold'em suivre engage 3x l'Ante, soit 30 000 sur une main.
  CASINO_MAX_BET: parseInt(env('CASINO_MAX_BET', '10000'), 10),

  // ---- SWOGE Poker (Texas Hold'em, 6 max, pas de bot) ----
  // Une table ne distribue jamais tant qu'un deuxieme joueur reel n'est pas
  // assis. Une minute par decision, exclusion apres 5 mains sans action.
  POKER_ACTION_MS: parseInt(env('POKER_ACTION_MS', '60000'), 10),
  POKER_IDLE_HANDS: parseInt(env('POKER_IDLE_HANDS', '5'), 10),
  POKER_BETWEEN_HANDS_MS: parseInt(env('POKER_BETWEEN_HANDS_MS', '6000'), 10),
  POKER_RAKE_BPS: parseInt(env('POKER_RAKE_BPS', '500'), 10),   // 5 %, seulement si le flop est vu
  // La cave par defaut vaut 20 a 200 grosses blindes : c'est ce qui rend le
  // poker jouable. Une cave enorme sur de petites blindes ne sert a rien —
  // a 10 M sur du 250/500 on serait a 20 000 blindes de profondeur, et plus
  // aucune mise ne peserait vraiment sur la main. L'echelle monte donc avec les blindes.
  POKER_TABLES: [
    { id: 'micro', name: 'Doge Micro', smallBlind: 5,      bigBlind: 10,
      minBuyIn: 200,       maxBuyIn: 2000 },
    { id: 'low',   name: 'Wolf Low',   smallBlind: 250,    bigBlind: 500,
      minBuyIn: 10000,     maxBuyIn: 100000 },
    { id: 'high',  name: 'Bull High',  smallBlind: 12500,  bigBlind: 25000,
      minBuyIn: 500000,    maxBuyIn: 10000000 },
  ],

  // ---- SWOGE Spin (Volcano slot) ----
  // Allowed bets; each spin costs `bet` $SWOGE, payout = base × bet (RTP ~70%).
  VOLCANO_BETS: [10, 20, 50, 100, 500, 1000, 10000, 100000],
  VOLCANO_BONUS_COST_MULT: 33,   // "Buy Bonus" costs bet × this (tuned so the bought feature is ~70% RTP, matching the base game, after the fuller-board rebalance)

  // ---- Physics / table (server units) ----
  TABLE: {
    width: 11,         // X extent of the shelf
    depth: 13,         // Z extent — SHORTER so coins actually reach the front
    frontEdgeZ: 4.5,   // coins pushed beyond this Z fall off the front = WIN
    pusherTravel: 7.5, // long stroke: retracts fully to the back wall, pushes near the front
    pusherSpeed: 1.7,  // faster, stronger stroke (user: too slow / not pushing hard enough)
    coinRadius: 0.7,
    coinThickness: 0.35,
    dropY: 6,
    stepHz: 60,       // physics steps per second
    maxCoins: 220,    // hard cap — keeps the server sim fast = smoother playback
  },
  BROADCAST_HZ: parseInt(env('BROADCAST_HZ', '30'), 10), // 30 snapshots/sec = smoother
};
