import type { Stack } from "./stack.js";

/**
 * Templates de Dockerfile. Ce sont des fonctions : le code remplit les trous
 * (version Node, Prisma, standalone, composer) à partir de la stack détectée.
 * Aucun modèle, aucune génération libre : même stack = même Dockerfile.
 */

// Le post-install de @prisma/client lance "prisma generate" pendant "npm ci" :
// il faut donc le schéma (et prisma.config.* s'il existe) dès l'étape deps.
const depsCopy = (s: Stack) =>
  s.hasPrisma
    ? "COPY package.json package-lock.json prisma* ./"
    : "COPY package.json package-lock.json ./";

const PRISMA_BUILD_ENV =`# Prisma génère son client sans se connecter : une URL factice suffit au build
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"`;

// Le CLI Prisma doit être présent dans l'image finale : deploy-agent lance
// "prisma migrate deploy" depuis node_modules/prisma avant chaque démarrage.
const PRISMA_RUNTIME_COPY = (owner: string) => `COPY --from=builder --chown=${owner} /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=${owner} /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=${owner} /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=${owner} /app/prisma ./prisma`;

function nextjsStandalone(s: Stack): string {
  const prisma = s.hasPrisma;
  return `# Template nextjs-standalone (généré par deploy-agent)
FROM node:${s.nodeVersion}-alpine AS deps
WORKDIR /app
${depsCopy(s)}
${s.hasPrisma ? PRISMA_BUILD_ENV + "\n" : ""}RUN npm ci

FROM node:${s.nodeVersion}-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${prisma ? PRISMA_BUILD_ENV + "\nRUN npx prisma generate\n" : ""}RUN mkdir -p public
RUN npm run build

FROM node:${s.nodeVersion}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 app

COPY --from=builder --chown=app:nodejs /app/public ./public
COPY --from=builder --chown=app:nodejs /app/.next/standalone ./
COPY --from=builder --chown=app:nodejs /app/.next/static ./.next/static
${prisma ? PRISMA_RUNTIME_COPY("app:nodejs") + "\n" : ""}
USER app
EXPOSE 3000
CMD ["node", "server.js"]
`;
}

function nextjsFull(s: Stack): string {
  const prisma = s.hasPrisma;
  return `# Template nextjs (généré par deploy-agent, sans sortie standalone)
FROM node:${s.nodeVersion}-alpine AS deps
WORKDIR /app
${depsCopy(s)}
${s.hasPrisma ? PRISMA_BUILD_ENV + "\n" : ""}RUN npm ci

FROM node:${s.nodeVersion}-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${prisma ? PRISMA_BUILD_ENV + "\nRUN npx prisma generate\n" : ""}RUN npm run build

FROM node:${s.nodeVersion}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 app

COPY --from=builder --chown=app:nodejs /app/package.json ./
COPY --from=builder --chown=app:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=app:nodejs /app/.next ./.next
COPY --from=builder --chown=app:nodejs /app/public ./public
${prisma ? PRISMA_RUNTIME_COPY("app:nodejs") + "\n" : ""}
USER app
EXPOSE 3000
CMD ["npm", "start"]
`;
}

function nodeGeneric(s: Stack): string {
  const prisma = s.hasPrisma;
  const build = s.hasBuildScript ? "RUN npm run build\n" : "";
  return `# Template node (généré par deploy-agent)
FROM node:${s.nodeVersion}-alpine AS deps
WORKDIR /app
${depsCopy(s)}
${s.hasPrisma ? PRISMA_BUILD_ENV + "\n" : ""}RUN npm ci

FROM node:${s.nodeVersion}-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
${prisma ? PRISMA_BUILD_ENV + "\nRUN npx prisma generate\n" : ""}${build}
FROM node:${s.nodeVersion}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 app

COPY --from=builder --chown=app:nodejs /app/package.json ./
COPY --from=builder --chown=app:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=app:nodejs /app ./
${prisma ? PRISMA_RUNTIME_COPY("app:nodejs") + "\n" : ""}
USER app
EXPOSE 3000
CMD ["npm", "start"]
`;
}

function php(s: Stack): string {
  const composer = s.hasComposer
    ? `COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY composer.json composer.lock* ./
RUN composer install --no-dev --optimize-autoloader --no-interaction
`
    : "";
  return `# Template php (généré par deploy-agent) : PHP + Apache
FROM php:8.3-apache
WORKDIR /var/www/html
${composer}COPY . ./
RUN chown -R www-data:www-data /var/www/html
EXPOSE 80
`;
}

function staticSite(): string {
  return `# Template static (généré par deploy-agent) : nginx pour fichiers statiques
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
`;
}

export function renderDockerfile(stack: Stack): string {
  switch (stack.kind) {
    case "nextjs":
      return stack.nextStandalone ? nextjsStandalone(stack) : nextjsFull(stack);
    case "node":
      return nodeGeneric(stack);
    case "php":
      return php(stack);
    case "static":
      return staticSite();
  }
}
