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
    await simpleGit(dest).fetch("origin").then(() =>
      simpleGit(dest).reset(["--hard", `origin/${branch}`])
    );
  } else {
    await git.clone(repoUrl, dest, ["--branch", branch, "--depth", "1"]);
  }

  const log = await simpleGit(dest).log({ maxCount: 1 });
  return log.latest?.hash ?? "unknown";
}
