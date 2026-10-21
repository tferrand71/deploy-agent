import { simpleGit } from "simple-git";
import { join, resolve, sep } from "node:path";
import { rm } from "node:fs/promises";

const REPOS_DIR = process.env.REPOS_DIR ?? "/tmp/deploy-agent/repos";

export function repoPath(projectId: string): string {
  return join(REPOS_DIR, projectId);
}

/**
 * Jeton d'accès pour un dépôt privé : passé en en-tête HTTP à chaque commande,
 * jamais écrit dans l'URL du remote ni dans .git/config.
 */
function gitConfig(token?: string): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return [`http.extraHeader=Authorization: Basic ${basic}`];
}

/** Supprime le clone local d'un projet (refuse tout chemin hors de REPOS_DIR). */
export async function removeRepo(projectId: string): Promise<void> {
  const dest = resolve(repoPath(projectId));
  if (!dest.startsWith(resolve(REPOS_DIR) + sep)) {
    throw new Error(`Chemin de dépôt invalide : ${projectId}`);
  }
  await rm(dest, { recursive: true, force: true });
}

export async function cloneOrPull(
  projectId: string,
  repoUrl: string,
  branch: string,
  token?: string
): Promise<string> {
  const dest = repoPath(projectId);
  const config = gitConfig(token);
  const git = simpleGit({ config });

  // Clone frais à chaque déploiement : un clone existant peut être corrompu
  // (objets git manquants), ce qui faisait planter le processus pendant un fetch.
  // Un clone --depth 1 est rapide, et l'URL/la branche sont toujours à jour.
  await removeRepo(projectId);
  await git.clone(repoUrl, dest, ["--branch", branch, "--depth", "1"]);

  const log = await simpleGit(dest).log({ maxCount: 1 });
  return log.latest?.hash ?? "unknown";
}
