import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Authentification de l'API par jeton secret (en-tête `Authorization: Bearer <jeton>`).
 *
 * Pourquoi : l'API pilote Docker (déployer, écraser des secrets, supprimer un projet) et elle est
 * joignable depuis tous les conteneurs du VPS qui partagent un réseau avec elle. Sans jeton, un seul
 * site compromis suffisait à tout contrôler. Les appelants légitimes (le dashboard, deploy-cron)
 * reçoivent le jeton par leur variable d'environnement AGENT_API_TOKEN.
 */

/** Longueur minimale : 32 caractères hexadécimaux = 128 bits, `openssl rand -hex 32` en donne 64. */
const MIN_TOKEN_LENGTH = 32;

/** Seules routes ouvertes sans jeton : la sonde de santé, qui ne renvoie aucune donnée. */
const PUBLIC_PATHS = new Set(["/health"]);

/**
 * Lit le jeton attendu. Lève une erreur s'il manque ou s'il est trop court : le service refuse alors
 * de démarrer plutôt que de s'ouvrir à tous par oubli (échec « fermé »).
 */
export function loadAgentToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.AGENT_API_TOKEN;
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `AGENT_API_TOKEN manquante ou trop courte (${MIN_TOKEN_LENGTH} caractères minimum). Génère-la avec : openssl rand -hex 32`
    );
  }
  return token;
}

/** Empreinte de longueur fixe : permet une comparaison en temps constant quelle que soit la longueur reçue. */
const digest = (value: string) => createHash("sha256").update(value).digest();

/** Hook Fastify `onRequest` qui rejette (401) toute requête sans le bon jeton. */
export function createAuthHook(token: string) {
  const expected = digest(token);

  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    const path = req.url.split("?")[0];
    if (PUBLIC_PATHS.has(path)) return;

    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (match && timingSafeEqual(digest(match[1]), expected)) return;

    return reply.status(401).header("WWW-Authenticate", "Bearer").send({ error: "Non autorisé" });
  };
}
