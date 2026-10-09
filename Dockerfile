# syntax=docker/dockerfile:1

FROM node:22-alpine AS base

# ---- Dépendances ----
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- Build ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="postgresql://user:password@localhost:5432/db"
RUN npx prisma generate
RUN npm run build

# ---- Exécution ----
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 agent

# Runtime Prisma
COPY --from=builder --chown=agent:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=agent:nodejs /app/prisma ./prisma
COPY --from=builder --chown=agent:nodejs /app/package.json ./package.json

# Code compilé
COPY --from=builder --chown=agent:nodejs /app/dist ./dist

COPY --chown=agent:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER agent

EXPOSE 3001
ENV PORT=3001

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
