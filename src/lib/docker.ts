import Dockerode from "dockerode";
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

export async function buildAndRun(
    projectId: string,
    subdomain: string,
    envVars: Record<string, string>
): Promise<void> {
  const context = repoPath(projectId);
  const tag = `deploy-agent/${projectId}:latest`;

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

  // Arrêt + suppression du conteneur précédent s'il existe
  const containerName = `project-${projectId}`;
  try {
    const old = docker.getContainer(containerName);
    await old.stop();
    await old.remove();
  } catch {
    // Pas de conteneur précédent, c'est normal
  }

  const container = await docker.createContainer({
    name: containerName,
    Image: tag,
    Env: Object.entries(envVars).map(([k, v]) => `${k}=${v}`),
    HostConfig: {
      NetworkMode: "proxy",
      RestartPolicy: { Name: "unless-stopped" },
    },
    Labels: {
      "traefik.enable": "true",
      [`traefik.http.routers.${projectId}.rule`]: `Host(\`${subdomain}\`)`,
      [`traefik.http.routers.${projectId}.entrypoints`]: "websecure",
      [`traefik.http.routers.${projectId}.tls.certresolver`]: "letsencrypt",
    },
  });

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