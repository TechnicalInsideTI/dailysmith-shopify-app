# better-sqlite3 is a native module. It ships prebuilt binaries for the
# common platforms, but not for every Node ABI and architecture, so the
# dependencies are installed in a stage that can compile it and only the
# result is copied into the slim runtime image.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/dailysmith.sqlite
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY bin ./bin
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
