import { simpleGit } from "simple-git";
import { join } from "node:path";
import { existsSync } from "node:fs";

const REPOS_DIR = process.env.REPOS_DIR ?? "/tmp/deploy-agent/repos";

export function repoPath(projectId: string): string {
  return join(REPOS_DIR, projectId);
}

export async function cloneOrPull(
  projectId: string,
  repoUrl: string,
  branch: string
): Promise<string> {
  const dest = repoPath(projectId);
  const git = simpleGit();

  if (existsSync(dest)) {
    // L'URL et la branche peuvent avoir changé depuis le dernier déploiement :
    // on met à jour le remote et on récupère explicitement la branche demandée
    // (un clone --depth 1 ne suit que l'ancienne branche par défaut).
    const local = simpleGit(dest);
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
