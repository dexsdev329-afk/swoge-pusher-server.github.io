# SWOGE — serveur

Node 18+, JavaScript nu (pas de TypeScript, pas de framework). `ethers` v5.
Déployé sur Railway depuis `main`. Le site est dans l'autre dépôt
(`SWOGE.github.io`), servi par GitHub Pages depuis `main`.

## Approche

- Lire les fichiers avant d'écrire. Ne pas relire ce qui n'a pas changé.
- Raisonnement complet, sortie concise. Pas d'ouverture flatteuse ni de
  conclusion décorative.
- Ne jamais deviner une API, une version, un drapeau, un SHA de commit ou un
  nom de paquet. Vérifier en lisant le code ou la documentation avant
  d'affirmer.
- `ai_colonie.js` et `server.js` font plusieurs milliers de lignes : lire la
  section utile (`grep -n` puis `sed -n`), pas le fichier entier.

## La règle qui prime sur toutes les autres : mesurer avant de changer

Ce dépôt fait tourner de l'argent réel. Chaque règle de décision de la colonie
porte, en commentaire, **la mesure qui l'a décidée** — une date, un nombre
d'observations, un chiffre. C'est la convention centrale du projet.

- Ne pas changer un seuil parce qu'il « semble » trop strict. Ouvrir l'audit
  (`/ai/colonie`, champ `audit`), lire la ligne de la règle, et comparer sa part
  de montées à la référence `achete ou retenu` — ce qu'on achète réellement.
- Une règle sans ligne d'audit n'est pas jugeable : la rendre mesurable
  d'abord (voir `OBS_VIEUX_PAR_TOUR`, qui a rendu le plafond d'âge jugeable
  sans jamais rien lui faire acheter).
- Écrire la mesure dans le commentaire, avec sa date et son échantillon. Un
  commentaire qui dit « ajusté » au lieu de « 1 056 observations, 35 % de
  montées contre 35 % pour ce qu'on achète » ne vaut rien six mois plus tard.
- Les commentaires sont en français, le texte montré aux joueurs en anglais.

## Les essais

Quatre suites, lancées à la main. **Aucun commit sans code de sortie vert.**

```bash
node ai_colonie_serveur.test.js     # ~20 min, la plus grosse — la lancer SEULE
node miroir.test.js
node /home/user/SWOGE.github.io/ai_colonie.test.js    # Playwright, voir NODE_PATH ci-dessous
node /home/user/SWOGE.github.io/cache_marqueur.test.js
```

La suite de page a besoin de Playwright :
`NODE_PATH=<scratchpad>/pw/node_modules:/home/user/swoge-pusher-server.github.io/node_modules`

Isoler un seul scénario de la suite colonie (elle est longue) :

```bash
sed -E "/^  await ([a-zA-Z]+)\(\);$/{/await NOM_DU_SCENARIO\(\);/!d}" \
  ai_colonie_serveur.test.js > ./_iso.test.js && node ./_iso.test.js
```

Un échec s'écrit `RATE` et la dernière ligne donne `RATES : n/total`.

- **Ne jamais affaiblir un essai pour le faire passer.** Un essai qui clignote
  a une cause : la chercher. Exemple vécu : un `break` sur le budget d'appels
  coupait aussi les refus gratuits, d'où quinze jetons qui en devenaient cinq
  d'une exécution à l'autre.
- Quand un essai existant contredit un changement voulu, réécrire l'essai sur
  son **intention** (souvent écrite dans sa propre phrase), pas le supprimer.

## Publier

```bash
git push -u origin claude/<branche>
git push origin HEAD:main          # autorisé par le propriétaire
```

Le site et le serveur servent `main`. Un travail resté sur la branche ne tourne
nulle part.

**Si un script versionné ou une page auto-versionnée du site a changé**, le
marqueur de cache doit être recalculé, sinon les navigateurs continuent de
servir l'ancien fichier — le travail est poussé, correct, et invisible.
`cache_marqueur.test.js` échoue et **donne la valeur à écrire**, dans la page
ET dans `version.json`.

Message de commit : ce qui a été mesuré et pourquoi, pas ce qui a été édité.
Aucun identifiant de modèle nulle part dans le dépôt.

## Sécurité — non négociable

- La clé privée d'un portefeuille généré est montrée **une seule fois**, jamais
  dans `localStorage`.
- `MIROIR_CLE` ne vit que dans l'environnement de l'hôte, jamais dans le dépôt
  ni dans une réponse.
- Un geste du miroir ou de la colonie n'agit **que sur `ws.addr`** — l'adresse
  de la session — jamais sur une adresse venue du message.
- `AI_OWNER` est revérifié côté serveur à chaque geste. La page ne fait que
  montrer ou cacher des boutons.
- `MIROIR_EXECUTE=1` signe de vraies transactions avec l'argent des joueurs.
- Ne jamais `pkill -f` : tuer par PID explicite.

## Où sont les choses

| fichier | quoi |
|---|---|
| `ai_colonie.js` | la colonie : agents, traits, ombres, audit, bornes apprises, papier |
| `miroir.js` | l'exécution réelle : routes v2/v3/v4, ponts, devis, ordres |
| `server.js` | HTTP + WebSocket, jeux, admin ; câble la colonie et le miroir |
| `paris*.js`, `cotes*.js`, `scores_espn.js` | SwogeBet |
| `EXPLOITATION.md` | **chaque réglage, avec la mesure qui l'a fixé** — à tenir à jour |
