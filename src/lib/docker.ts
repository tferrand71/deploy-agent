import Dockerode from "dockerode";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { repoPath } from "./git.js";
import { prepareDockerfile } from "./dockerfile.js";
import { loadComposeTemplate } from "./composeTemplate.js";

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

const PROXY_NETWORK = "proxy";
const DB_NETWORK = "db";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

function toEnvArray(envVars: Record<string, string>): string[] {
  return Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
}

/**
 * Le projet utilise-t-il le PostgreSQL partagé ? Schéma Prisma avec provider "postgresql"
 * (un projet SQLite/libsql distant comme Turso n'a pas besoin du réseau db).
 */
function needsDatabase(context: string): boolean {
  try {
    const schema = readFileSync(join(context, "prisma", "schema.prisma"), "utf-8");
    return /provider\s*=\s*"postgresql"/.test(schema);
  } catch {
    return false;
  }
}

/** Migrations à appliquer seulement si le repo en versionne (prisma/migrations). */
function hasPrismaMigrations(context: string): boolean {
  return existsSync(join(context, "prisma", "migrations"));
}

/**
 * Port exposé par le Dockerfile du projet, lu depuis sa dernière ligne
 * EXPOSE. Retourne null si rien n'est trouvé : Traefik détecte alors seul.
 */
function detectExposedPort(dockerfilePath: string): string | null {
  try {
    const dockerfile = readFileSync(dockerfilePath, "utf-8");
    const matches = [...dockerfile.matchAll(/^EXPOSE\s+(\d+)/gm)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1][1];
  } catch {
    return null;
  }
}

async function runBuild(
    context: string,
    tag: string,
    dockerfile: string,
    buildargs: Record<string, string>
): Promise<void> {
  const stream = await docker.buildImage(
      { context, src: ["."] },
      { t: tag, dockerfile, buildargs }
  );

  // Les erreurs de build (RUN qui échoue…) arrivent dans le flux, pas dans `err`
  await new Promise<void>((ok, fail) => {
    docker.modem.followProgress(
        stream,
        (err, events: Array<{ stream?: string; error?: string; errorDetail?: { message?: string } }> = []) => {
          if (err) return fail(err);
          const failed = events.find((e) => e.error || e.errorDetail);
          if (!failed) return ok();
          const tail = events
              .map((e) => e.stream ?? "")
              .join("")
              .split("\n")
              .slice(-40)
              .join("\n");
          fail(new Error(`Build Docker échoué : ${failed.error ?? failed.errorDetail?.message}\n${tail}`));
        }
    );
  });
}

async function assertNetworksExist(networks: string[]): Promise<void> {
  for (const name of networks) {
    try {
      await docker.getNetwork(name).inspect();
    } catch {
      throw new Error(`Réseau Docker "${name}" introuvable`);
    }
  }
}

/**
 * Lance "prisma migrate deploy" dans un conteneur jetable construit depuis
 * l'image déjà buildée du projet (même Env, réseau "db" uniquement, pas de
 * Traefik). Uniquement create/start/wait/logs/remove : couvert par le scope
 * CONTAINERS+POST du socket-proxy.
 *
 * Nécessite que l'image finale contienne node_modules/prisma (le CLI).
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
      NetworkMode: DB_NETWORK,
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

/**
 * Configuration du déploiement, par ordre de priorité :
 *  - compose.yml du repo (template) : réseaux, labels, env, build args, restart ;
 *  - sinon détection automatique : réseau proxy (+ db si Prisma), labels Traefik par défaut.
 * Le Dockerfile vient du compose (build.dockerfile), sinon du repo, sinon d'un template généré.
 */
export async function buildAndRun(
    projectId: string,
    subdomain: string,
    secrets: Record<string, string>,
    log: Logger
): Promise<void> {
  const repoDir = repoPath(projectId);
  const tag = `deploy-agent/${projectId}:latest`;

  const loaded = await loadComposeTemplate(repoDir, { DOMAIN: subdomain, ...secrets });
  const compose = loaded?.template;
  if (compose) {
    log.info(`compose.yml : service "${compose.serviceName}", réseaux [${compose.networks.join(", ")}]`);
    if (loaded.missing.length) {
      log.warn(`Variables absentes des secrets, remplacées par "" : ${loaded.missing.join(", ")}`);
    }
  }

  const context = resolve(repoDir, compose?.buildContext ?? ".");
  if (context !== repoDir && !context.startsWith(repoDir + sep)) {
    throw new Error(`build.context sort du dépôt : ${compose?.buildContext}`);
  }

  const dockerfile = compose?.dockerfile ?? prepareDockerfile(context).dockerfile;
  const hasDatabase = needsDatabase(context);

  const networks = compose?.networks.length
      ? compose.networks
      : hasDatabase ? [PROXY_NETWORK, DB_NETWORK] : [PROXY_NETWORK];
  await assertNetworksExist(networks);

  // NEXT_PUBLIC_* sont figées dans le bundle JS au build : toujours passées en build args
  const buildArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (k.startsWith("NEXT_PUBLIC_")) buildArgs[k] = v;
  }
  Object.assign(buildArgs, compose?.buildArgs);

  await runBuild(context, tag, dockerfile, buildArgs);

  const env = { ...secrets, ...compose?.environment };

  // Migrations Prisma avant de (re)lancer le conteneur applicatif
  if (hasDatabase && hasPrismaMigrations(context)) {
    await runPrismaMigrations(tag, projectId, env);
  }

  let labels: Record<string, string>;
  if (compose && Object.keys(compose.labels).length) {
    labels = { ...compose.labels };
  } else {
    labels = {
      "traefik.enable": "true",
      [`traefik.http.routers.${projectId}.rule`]: `Host(\`${subdomain}\`)`,
      [`traefik.http.routers.${projectId}.entrypoints`]: "websecure",
      [`traefik.http.routers.${projectId}.tls.certresolver`]: "letsencrypt",
    };
    const exposedPort = detectExposedPort(join(context, dockerfile));
    if (exposedPort) {
      labels[`traefik.http.services.${projectId}.loadbalancer.server.port`] = exposedPort;
    }
  }
  // Sur plusieurs réseaux, Traefik doit savoir lequel utiliser, sinon il peut viser le réseau db
  if (networks.length > 1 && !labels["traefik.docker.network"]) {
    labels["traefik.docker.network"] = networks[0];
  }

  const containerName = `project-${projectId}`;
  try {
    await docker.getContainer(containerName).remove({ force: true });
  } catch {
    // Pas de conteneur précédent
  }

  const restart = compose?.restart ?? "unless-stopped";
  const container = await docker.createContainer({
    name: containerName,
    Image: tag,
    Env: toEnvArray(env),
    Labels: labels,
    HostConfig: {
      NetworkMode: networks[0],
      RestartPolicy: { Name: restart === "no" ? "" : restart },
      // Volume préfixé par le projet : deux projets ne partagent jamais un volume par erreur
      Mounts: (compose?.volumes ?? []).map((v) => ({
        Type: "volume" as const,
        Source: `${projectId}_${v.name}`,
        Target: v.target,
        ReadOnly: v.readOnly,
      })),
    },
  });

  // Réseaux secondaires branchés avant le démarrage : l'app peut joindre la db dès le boot
  for (const network of networks.slice(1)) {
    await docker.getNetwork(network).connect({ Container: container.id });
  }

  await container.start();
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
