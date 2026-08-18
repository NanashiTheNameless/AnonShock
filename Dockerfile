# syntax=docker/dockerfile:1

FROM node:26-alpine AS deps
WORKDIR /app
RUN npm install --global corepack@latest && corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

FROM node:26-alpine AS build
WORKDIR /app
RUN npm install --global corepack@latest && corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY package.json yarn.lock .yarnrc.yml tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# Vendors the ALTCHA widget, compiles, and copies the .sql migrations.
RUN yarn build

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 10001 -S anonshock && adduser -u 10001 -S anonshock -G anonshock

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# public comes from the build stage so it carries the vendored widget.
COPY --from=build /app/public ./public
COPY package.json ./
# The license requires the terms to travel with every copy.
COPY LICENSE.md ./

# Host control is `docker compose exec app anonshock ...`, so the CLI lives in
# the runtime image. It is not reachable over HTTP.
RUN printf '#!/bin/sh\nexec node /app/dist/cli/anonshock.js "$@"\n' > /usr/local/bin/anonshock \
 && chmod +x /usr/local/bin/anonshock \
 && mkdir -p /data /run/anonshock \
 && chown anonshock:anonshock /data /run/anonshock

USER 10001:10001
EXPOSE 8080
ENV DB_PATH=/data/anonshock.db
CMD ["node", "dist/server.js"]
