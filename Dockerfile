# Small image: plain Node plus the Chromium that Debian ships. No big downloads during the build.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=128 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./

USER node
CMD ["node", "server.js"]
