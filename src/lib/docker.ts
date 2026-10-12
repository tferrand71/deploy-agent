import Dockerode from "dockerode";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "./git.js";

// Socket-proxy scopé : CONTAINERS, IMAGES, NETWORKS, POST uniquement.
// DOCKER_HOST (ex: tcp://socket-proxy-deploy:2375) est prioritaire ; sinon,
// on retombe sur un vrai socket Unix local via DOCKER_SOCKET.
const dockerHost = process.env.DOCKER_HOST;

const docker = dockerHost
    ? new Dockerode({
      host: dockerHost.replace(/^tcp:\/\//, "").split(":")[0],
      port: Number(dockerHost.split(":").pop()),
    })
    : new Dockerode({
      socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    });

function toEnvArray(envVars: Record<string, string>): string[] {
  return Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
}

/**
 * Le projet a-t-il une base PostgreSQL (Prisma) ? Détecté automatiquement
 * par la présence de prisma/schema.prisma dans le repo cloné — aucun champ
 * à ajouter en base pour ça.
 */
function needsDatabase(context: string): boolean {
  return existsSync(join(context, "prisma", "schema.prisma"));
}

/**
 * Port exposé par le Dockerfile du projet, lu depuis sa dernière ligne
 * EXPOSE (les lignes commentées, ex. "# EXPOSE 80", sont ignorées).
 * Retourne null si rien n'est trouvé : on laisse alors Traefik faire sa
 * propre détection automatique (comportement précédent, inchangé).
 */
function detectExposedPort(context: string): string | null {
  try {
    const dockerfile = readFileSync(join(context, "Dockerfile"), "utf-8");
    const matches = [...dockerfile.matchAll(/^EXPOSE\s+(\d+)/gm)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1][1];
  } catch {
    return null;
  }
}

/**
 * Lance "prisma migrate deploy" dans un conteneur jetable construit depuis
 * l'image déjà buildée du projet (même Env, réseau "db" uniquement, pas de
 * Traefik). Ne passe jamais par "docker exec" : uniquement create/start/
 * wait/logs/remove, déjà couverts par le scope CONTAINERS+POST du
 * socket-proxy — aucune permission supplémentaire à activer.
 *
 * Nécessite que le Dockerfile du projet copie node_modules/prisma (le CLI,
 * pas seulement @prisma/client) dans l'image finale.
 */
async function runPrismaMigrations(
    tag: string,
    projectId: string,
    envVars: Record<string, string>
): Promise<void> {
  const migrateContainerName = `project-${projectId}-migrate`;

  try {
    await docker.getContainer(migrateContainerName).remove({ force: true });
  } catch {
    // Pas de conteneur de migration précédent, normal
  }

  const container = await docker.createContainer({
    name: migrateContainerName,
    Image: tag,
    Entrypoint: ["node"],
    Cmd: ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    Env: toEnvArray(envVars),
    HostConfig: {
      NetworkMode: "db",
    },
  });

  await container.start();
  const result = await container.wait();
  const logsBuffer = await container.logs({ stdout: true, stderr: true });
  await container.remove().catch(() => {});

  if (result.StatusCode !== 0) {
    throw new Error(
        `Migration Prisma échouée (code ${result.StatusCode}) :\n${logsBuffer.toString("utf-8")}`
    );
  }
}

export async function buildAndRun(
    projectId: string,
    subdomain: string,
    envVars: Record<string, string>
): Promise<void> {
  const context = repoPath(projectId);
  const tag = `deploy-agent/${projectId}:latest`;
  const hasDatabase = needsDatabase(context);
  const exposedPort = detectExposedPort(context);

  // Build depuis le Dockerfile présent dans le repo cloné
  const buildStream = await docker.buildImage(
      { context, src: ["."] },
      { t: tag }
  );

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(buildStream, (err) =>
        err ? reject(err) : resolve()
    );
  });

  // Migrations Prisma, avant de (re)lancer le conteneur applicatif
  if (hasDatabase) {
    await runPrismaMigrations(tag, projectId, envVars);
  }

  // Arrêt + suppression du conteneur précédent s'il existe
  const containerName = `project-${projectId}`;
  try {
    const old = docker.getContainer(containerName);
    await old.stop();
    await old.remove();
  } catch {
    // Pas de conteneur précédent, c'est normal
  }

  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${projectId}.rule`]: `Host(\`${subdomain}\`)`,
    [`traefik.http.routers.${projectId}.entrypoints`]: "websecure",
    [`traefik.http.routers.${projectId}.tls.certresolver`]: "letsencrypt",
  };
  if (exposedPort) {
    labels[`traefik.http.services.${projectId}.loadbalancer.server.port`] = exposedPort;
  }

  const container = await docker.createContainer({
    name: containerName,
    Image: tag,
    Env: toEnvArray(envVars),
    HostConfig: {
      NetworkMode: "proxy",
      RestartPolicy: { Name: "unless-stopped" },
    },
    Labels: labels,
  });

  await container.start();

  // Si l'app a besoin de PostgreSQL, l'attacher aussi au réseau "db"
  if (hasDatabase) {
    await docker.getNetwork("db").connect({ Container: containerName });
  }
}

export async function getContainerStatus(
    projectId: string
): Promise<"running" | "stopped" | "absent"> {
  try {
    const info = await docker
        .getContainer(`project-${projectId}`)
        .inspect();
    return info.State.Running ? "running" : "stopped";
  } catch {
    return "absent";
  }
}
