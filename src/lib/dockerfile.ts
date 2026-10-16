import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectStack } from "./stack.js";
import { renderDockerfile } from "./templates.js";

export interface PreparedDockerfile {
  /** Chemin relatif à la racine du contexte de build */
  dockerfile: string;
  generated: boolean;
  kind?: string;
}

// Dossier généré par deploy-agent dans le clone : jamais committé, jamais
// en conflit avec un "git pull" (un Dockerfile du projet reste prioritaire).
const GENERATED_DIR = ".deploy-agent";

const IGNORE_CONTENT = `node_modules
.next
.git
.env
.env.*
.deploy-agent
`;

/**
 * Ignore les fichiers sensibles et lourds pour le contexte de build, si le
 * projet n'en a pas déjà un. Sans ça, un "COPY . ." embarquerait .env.
 */
function ensureDockerignore(context: string): void {
  const target = join(context, ".dockerignore");
  if (existsSync(target)) return;
  writeFileSync(target, IGNORE_CONTENT);
}

/** Garde les fichiers générés hors de "git status" du clone */
function excludeFromGit(context: string): void {
  const exclude = join(context, ".git", "info", "exclude");
  if (!existsSync(exclude)) return;
  const current = readFileSync(exclude, "utf-8");
  if (current.includes(`${GENERATED_DIR}/`)) return;
  appendFileSync(exclude, `\n${GENERATED_DIR}/\n.dockerignore\n`);
}

/**
 * Détermine le Dockerfile à utiliser pour un repo cloné :
 *  1. le Dockerfile du projet, s'il existe (toujours prioritaire) ;
 *  2. sinon un Dockerfile généré à partir d'un template selon la stack ;
 *  3. sinon une erreur explicite demandant d'ajouter un Dockerfile.
 *
 * Refuse les gestionnaires de paquets autres que npm pour les projets Node :
 * les templates n'installent qu'avec "npm ci" et package-lock.json.
 */
export function prepareDockerfile(context: string): PreparedDockerfile {
  if (existsSync(join(context, "Dockerfile"))) {
    return { dockerfile: "Dockerfile", generated: false };
  }

  const stack = detectStack(context);
  if (!stack) {
    throw new Error(
        "Aucun Dockerfile dans le repo et stack non reconnue : ajoute un Dockerfile à la racine du projet"
    );
  }

  if (stack.kind !== "php" && stack.kind !== "static") {
    const hasOtherLock =
        existsSync(join(context, "pnpm-lock.yaml")) || existsSync(join(context, "yarn.lock"));
    if (hasOtherLock || !existsSync(join(context, "package-lock.json"))) {
      throw new Error(
          "Gestionnaire de paquets non supporté pour la génération automatique : npm avec package-lock.json requis, ou ajoute ton propre Dockerfile"
      );
    }
  }

  const dir = join(context, GENERATED_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Dockerfile"), renderDockerfile(stack));

  ensureDockerignore(context);
  excludeFromGit(context);

  return {
    dockerfile: `${GENERATED_DIR}/Dockerfile`,
    generated: true,
    kind: stack.kind,
  };
}
