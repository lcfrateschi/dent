# syntax=docker/dockerfile:1
#
# Multi-stage. Alvos:
#   deps  → node_modules completo (usado por dev e por migrate/seed)
#   dev   → Next em modo dev com hot reload  (docker compose up)
#   build → next build
#   prod  → runtime enxuto, standalone      (docker compose --profile prod up)
#
# Node 22: o host de desenvolvimento pode ter Node 18 (EOL), mas o container
# não precisa herdar essa limitação.

ARG NODE_VERSION=22-alpine

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# `npm ci` a partir do lockfile: build reproduzível.
COPY package.json package-lock.json ./
RUN npm ci

# ── dev ──────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS dev
WORKDIR /app
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ── build ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── prod ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS prod
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Não roda como root. Dado de saúde não se serve com privilégio desnecessário.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]

# ── migrate ──────────────────────────────────────────────────────────────────
# Serviço one-shot: aplica migrations e roda o seed, depois termina.
FROM node:${NODE_VERSION} AS migrate
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts tsconfig.json ./
COPY drizzle ./drizzle
COPY lib ./lib
COPY docker/migrate.sh /usr/local/bin/migrate.sh
RUN chmod +x /usr/local/bin/migrate.sh
CMD ["/usr/local/bin/migrate.sh"]
