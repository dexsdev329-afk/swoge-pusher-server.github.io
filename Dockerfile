# Build with Docker so Railway does NOT use Railpack (which tries to mount
# runtime env vars as build secrets and fails). Env vars are injected at run time.
FROM node:18-alpine
WORKDIR /app

# install deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# app source
COPY . .

# server reads PORT/VAULT_ADDRESS/SIGNER_PRIVATE_KEY from the environment at runtime
CMD ["node", "server.js"]
