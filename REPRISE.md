# Reprise — ce qu'il faut savoir pour continuer

Ce fichier est là pour qu'une nouvelle session comprenne l'état des choses en
une lecture, sans avoir à fouiller l'historique.

---

## 1. LE POINT BLOQUANT : le push

**Quatre commits sont écrits en local et n'ont jamais pu partir.** Le jeton
GitHub de la session précédente est passé en lecture seule en cours de route :

```
curl -H "Authorization: Bearer $GITHUB_TOKEN" \
     https://api.github.com/repos/dexsdev329-afk/SWOGE.github.io
→ "permissions": { "push": false }
```

Les deux premiers push de cette session-là étaient pourtant bien passés. Ce
n'est pas un problème de branche, de conflit ni de proxy : GitHub renvoie 403
sur `git-receive-pack`, avec un `X-Github-Request-Id`.

**Première chose à faire dans la nouvelle session :**

```bash
cd /home/user/swoge-pusher-server.github.io && git log --oneline origin/claude/plinko-push-s9bvu3..HEAD
cd /home/user/SWOGE.github.io && git log --oneline origin/claude/plinko-push-s9bvu3..HEAD
```

S'il reste des commits, les pousser sur `claude/plinko-push-s9bvu3` puis
fusionner dans `main` (consigne permanente du propriétaire : **on pousse sur
`main` quand c'est fini**).

Si le dépôt a été recloné à neuf, les commits locaux n'existent plus : tout ce
qui est décrit ci-dessous est alors À REFAIRE. Vérifier d'abord si le travail
est déjà sur `main` (chercher `morpion.js`, `dames.js`, `parrainage.test.js`).

---

## 2. Les deux dépôts

| Dépôt | Chemin local | Rôle |
|---|---|---|
| `swoge-pusher-server.github.io` | `/home/user/swoge-pusher-server.github.io` | serveur Node : argent, règles, WebSocket |
| `SWOGE.github.io` | `/home/user/SWOGE.github.io` | le site : 14 pages de jeu + `stakebubble.js` |

Branche de travail des deux : **`claude/plinko-push-s9bvu3`**.

---

## 3. Ce qui a été fait dans les commits en attente

### Serveur — `e9c4f6a` puis `e7daa6a`

* **Parrainage** (`game.js`, `config.js`, `server.js`, `parrainage.test.js`) :
  le parrain touche **10 % du REVENU réel** du filleul — ni un pourcentage des
  dépôts, ni du volume. C'est ce choix qui rend le système étanche sans aucune
  règle anti-triche : pour se verser 10 % de ses propres pertes, il faut
  d'abord en perdre 100. En 1v1 on ne compte qu'1 % de la mise (deux comptes
  complices ne peuvent pas fabriquer de revenu). Une « ligne d'eau »
  (`revPaye`) fait qu'un filleul qui gagne ne met jamais personne en dette.
* **Classement du mois** (`classementMois`) : **tous les joueurs de
  l'application**, classés au VOLUME MISÉ du mois — pas au gain, qui n'est que
  de la chance. Remise à zéro automatique au changement de mois. Le demandeur
  reçoit toujours son propre rang, même hors du top 50. **Aucun rapport avec le
  parrainage** — c'est une confusion à ne pas refaire.
* **Statistiques du profil** (`stats`) : 8 chiffres, tous recalculés depuis ce
  qui était déjà compté. Volontairement PAS de « taux de victoire » : au Plinko
  on « gagne » 60 % des manches en étant globalement perdant.
* **Le nom qui ne tenait pas** : chaque page envoie `name` à la connexion (les
  6 premiers caractères de l'adresse) et le serveur l'écrasait par-dessus le
  nom choisi. Corrigé par `p.nomChoisi` + reprise des états d'avant.
* **Le journal ouvrait un descripteur par ligne** (`fs.appendFile`) → `EMFILE`
  en rafale, et chaque ligne refusée était une ligne d'historique perdue. Une
  seule écriture en vol par joueur désormais, et `journal.draine()` à l'arrêt.
* **Morpion et dames** : `morpion.js`, `dames.js`, et la plomberie 1v1 du
  Connect 4 rendue GÉNÉRIQUE (`duelCreer`, `duelRejoindre`, `duelJouer`…). Les
  anciens noms `p4*` restent en façade. Un seul chemin d'argent pour les trois.
* **Trou d'argent bouché** : les tables en cours n'étaient pas sauvegardées
  avec l'état, mais **les mises l'étaient**. Un redémarrage en pleine partie
  faisait disparaître la table AVEC l'argent. Les tables ouvertes sont
  maintenant notées (`duels` dans `serialize()`) et **remboursées à la
  relecture**.

### Site — `5c980f4` puis `930969c`

* `stakebubble.js` : médaille/photo dans la barre du haut sur les 12 pages,
  onglet **Invite**, onglet **Ranking**, bloc de statistiques, pastille des
  virements reçus pendant une absence, notification d'envoi en anglais des
  deux côtés, surveillance du solde (voir §6).
* `morpion.html` et `dames.html` (générés, voir §5), `media/jeu-mp.jpg`,
  `media/jeu-dm.jpg`, deux cartes ajoutées à « Head to head » dans
  `games.html`.

---

## 4. Comment vérifier (à faire avant tout changement)

```bash
# le serveur de test (DEV_FAUCET permet de se créditer 1000 $SWOGE)
lsof -ti:8099 | xargs -r kill
(nohup env PORT=8099 DEV_FAUCET=1 TRANSFER_MIN=1 \
   sh -c 'cd /home/user/swoge-pusher-server.github.io && exec node server.js' \
   > /tmp/srv.log 2>&1 &)

# le site en statique
(cd /home/user/SWOGE.github.io && nohup python3 -m http.server 8788 &)

# les suites du serveur (toutes doivent être vertes)
cd /home/user/swoge-pusher-server.github.io
for t in *.test.js; do node $t 2>&1 | tail -1; done
```

Tests navigateur (Playwright), dans
`/tmp/claude-0/.../scratchpad/c4/` — **ils disparaissent avec la session** :

| Fichier | Ce qu'il prouve |
|---|---|
| `duels.js` | morpion + dames à deux navigateurs, du vestibule au pot |
| `invite.js` | parrainage, classement, statistiques, pastille |
| `envoi.js` | virement entre amis + solde qui se rattrape seul |
| `amis.js` | demandes d'amis, pastille +1, acceptation |
| `catalogue.js` | solde/profil sur `games.html` |
| `deux.js` | débordement de la barre sur 11 pages × 3 largeurs |

⚠️ **Chromium n'a pas d'accès réseau sortant** dans ce bac à sable : chaque
test route `ethers` et `three.js` depuis le disque. Ne pas chercher à
télécharger quoi que ce soit depuis la page.

⚠️ Les commandes enchaînées `pkill … ; node …` se font tuer (code 144) :
lancer les serveurs avec `(nohup env … &)` **seul sur sa ligne**.

---

## 5. Les fichiers qu'il ne faut JAMAIS éditer à la main

Ils sont **fabriqués** par des scripts, à partir d'une page source. Les
modifier à la main les fait diverger au prochain rendu.

| Fichier | Fabriqué par | À partir de |
|---|---|---|
| `connect4.html` | `scratchpad/c4/assemble.py` | `plinko.html` |
| `morpion.html`, `dames.html` | `scratchpad/c4/duels.py` | `connect4.html` |
| `games.html` (rubriques) | `scratchpad/c4/rubriques.py` | lui-même (une seule fois) |
| cartes des duels dans `games.html` | `scratchpad/c4/duels_catalogue.py` | lui-même |

Ces scripts vivent dans le bac à sable et **disparaissent avec la session** :
s'il faut retoucher `morpion.html` ou `dames.html`, la bonne façon est de
réécrire `duels.py` (il découpe sur des REPÈRES, jamais sur des numéros de
ligne, et s'arrête bruyamment si un repère a bougé).

---

## 6. Deux décisions à ne pas défaire

* **Le navigateur ne connaît aucune règle des dames.** Le serveur envoie les
  coups légaux avec l'état (`legaux`), la page allume ce qu'on lui donne. C'est
  ce qui rend impossible de jouer un coup illégal depuis un client modifié.
* **La surveillance du solde** dans `stakebubble.js` (`veilleSolde`) : toutes
  les 20 s la page redemande son solde, et **ferme la socket** après une minute
  de silence pour forcer la reconnexion. C'était la cause du « parfois il faut
  recharger la page » : la socket mourait sans le dire et plus rien n'arrivait.
  Attention au nom — il existait déjà une fonction `veille()` (mise en page)
  dans le même fichier, et la collision avait rendu la surveillance inerte.

---

## 7. Ce qui reste à faire

1. **Pousser les 4 commits** (§1).
2. **Vignettes du morpion et des dames** : celles en place sont dessinées au
   code, correctes mais plates. Le propriétaire génère les images ; les invites
   lui ont été données.
3. **Images de l'UI Connect 4** (`ui13`, `ui07`) : à réintégrer quand il les
   renvoie.
4. Signalés et jamais traités : la carte de série de 7 jours manque sur
   `swoge_pusher.html`, `swoge_pusher_live.html` et `swoge_smash.html` ; la
   plaque « HOW TO BUY » est rouge alors que les autres sont bleues ; un 404
   sur `swoge-nav.js` ; deux fonds « mur de coffres » non placés.
5. Éventuellement : un classement « all time » à côté de celui du mois.

---

## 8. La façon de travailler attendue

* Le propriétaire écrit en français, l'interface est en anglais.
* **Mesurer avant de changer**, et prouver qu'un test échoue sur l'ancien
  comportement avant de le déclarer correctif.
* Les commentaires du code expliquent POURQUOI, pas quoi — et citent le vrai
  incident quand il y en a eu un.
* **Le solde des joueurs ne doit jamais se perdre.** C'est la consigne qui
  prime sur tout le reste.
