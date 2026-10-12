import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Lance "docker compose -f <fichiers> up -d --build" dans le dossier donné.
 * Le CLI "docker compose" lit le Dockerfile/compose.yml sur le disque local
 * (ici, le volume /opt/apps monté dans deploy-agent), construit le contexte
 * de build lui-même, puis parle au démon Docker via DOCKER_HOST (le même
 * socket-proxy que dockerode) — même mécanisme que buildAndRun, juste via
 * le CLI au lieu de l'API directe, car compose gère multi-services/volumes.
 */
export async function composeUpBuild(
    workingDir: string,
    configFiles: string[]
): Promise<string> {
  const fileArgs = configFiles.flatMap((f) => ["-f", f]);
  const args = [...fileArgs, "up", "-d", "--build"];

  const { stdout, stderr } = await execFileAsync("docker", ["compose", ...args], {
    cwd: workingDir,
    env: process.env,
    maxBuffer: 1024 * 1024 * 20,
  });

  return `${stdout}\n${stderr}`.trim();
}
