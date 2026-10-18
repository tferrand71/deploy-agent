import { simpleGit } from "simple-git";
import { join } from "node:path";
import { existsSync } from "node:fs";

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

export async function cloneOrPull(
  projectId: string,
  repoUrl: string,
  branch: string,
  token?: string
): Promise<string> {
  const dest = repoPath(projectId);
  const config = gitConfig(token);
  const git = simpleGit({ config });

  if (existsSync(dest)) {
    // L'URL et la branche peuvent avoir changé depuis le dernier déploiement :
    // on met à jour le remote et on récupère explicitement la branche demandée
    // (un clone --depth 1 ne suit que l'ancienne branche par défaut).
    const local = simpleGit({ baseDir: dest, config });
    await local.remote(["set-url", "origin", repoUrl]);
    await local.fetch([
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    await local.reset(["--hard", `origin/${branch}`]);
  } else {
    await git.clone(repoUrl, dest, ["--branch", branch, "--depth", "1"]);
  }

  const log = await simpleGit(dest).log({ maxCount: 1 });
  return log.latest?.hash ?? "unknown";
}
