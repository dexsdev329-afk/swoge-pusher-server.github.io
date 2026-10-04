# Build with Docker so Railway does NOT use Railpack (which tries to mount
# runtime env vars as build secrets and fails). Env vars are injected at run time.
FROM node:18-alpine
WORKDIR /app

# ffmpeg : la derniere image d'une video, pour enchainer les scenes (derniere_image.js).
# « La seule facon de faire une suite, c'est la derniere seconde de l'image » (27/09).
# tor : le daemon pour la VEILLE .onion DEFENSIVE (tor.js). Il tourne ICI, car tor.js
# vit dans le serveur principal et parle a 127.0.0.1:9050. Le lecteur reste garde par
# l'attestation (aucune case ne debloque autre chose qu'une lecture). 04/10.
RUN apk add --no-cache ffmpeg tor

# install deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# app source
COPY . .

# server reads PORT/VAULT_ADDRESS/SIGNER_PRIVATE_KEY from the environment at runtime.
# Le daemon Tor demarre en arriere-plan (SOCKS sur 9050) pour la veille .onion ; s'il
# echoue, il ne fait PAS tomber le serveur (|| true, en tache de fond) — le lecteur
# .onion rend alors une erreur propre. TOR_SOCKS pointe le lecteur sur ce daemon ;
# le mettre a vide dans l'environnement Railway desactive la veille .onion.
ENV TOR_SOCKS=127.0.0.1:9050
CMD ["sh","-c","mkdir -p /tmp/tor-data && (tor --SocksPort 9050 --DataDirectory /tmp/tor-data --Log 'warn stderr' >/tmp/tor.log 2>&1 || true) & node server.js"]
