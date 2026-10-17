import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type StackKind = "nextjs" | "node" | "php" | "static";

export interface Stack {
  kind: StackKind;
  /** Version majeure de Node, toujours dans SUPPORTED_NODE */
  nodeVersion: string;
  hasPrisma: boolean;
  /** prisma.config.ts (ou .js/.mjs) présent à la racine (Prisma 7+) */
  hasPrismaConfig: boolean;
  /** next.config contient "standalone" (sortie autonome) */
  nextStandalone: boolean;
  hasBuildScript: boolean;
  hasStartScript: boolean;
  hasComposer: boolean;
}

/** Versions de Node acceptées dans le FROM : évite toute injection dans le template */
export const SUPPORTED_NODE = ["18", "20", "22", "24"] as const;
const DEFAULT_NODE = "22";

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Version de Node, par ordre de priorité : fichier .nvmrc, puis
 * engines.node de package.json, puis DEFAULT_NODE. Toujours validée contre
 * SUPPORTED_NODE : une valeur inconnue retombe sur la version par défaut.
 */
function detectNodeVersion(context: string, pkg: any): string {
  const nvmrc = readText(join(context, ".nvmrc"));
  const candidates = [nvmrc, pkg?.engines?.node].filter(Boolean) as string[];

  for (const raw of candidates) {
    const match = raw.match(/(\d{2})/);
    if (match && (SUPPORTED_NODE as readonly string[]).includes(match[1])) {
      return match[1];
    }
  }
  return DEFAULT_NODE;
}

function hasNextStandalone(context: string): boolean {
  for (const name of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
    const text = readText(join(context, name));
    if (text !== null) return /output\s*:\s*['"]standalone['"]/.test(text);
  }
  return false;
}

/**
 * Détecte la stack d'un repo cloné, uniquement à partir de ses fichiers.
 * Retourne null si rien ne correspond : le déploiement doit alors demander
 * un Dockerfile au projet.
 */
export function detectStack(context: string): Stack | null {
  const pkg = readJson(join(context, "package.json"));
  const hasPrisma = existsSync(join(context, "prisma", "schema.prisma"));
  const hasPrismaConfig = ["prisma.config.ts", "prisma.config.js", "prisma.config.mjs"].some((f) =>
    existsSync(join(context, f))
  );
  const hasComposer = existsSync(join(context, "composer.json"));

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const common = {
      nodeVersion: detectNodeVersion(context, pkg),
      hasPrisma,
      hasPrismaConfig,
      hasBuildScript: Boolean(pkg.scripts?.build),
      hasStartScript: Boolean(pkg.scripts?.start),
      hasComposer,
    };

    if (deps.next) {
      return { kind: "nextjs", nextStandalone: hasNextStandalone(context), ...common };
    }
    return { kind: "node", nextStandalone: false, ...common };
  }

  const files = readdirSync(context);
  if (hasComposer || files.some((f) => f.endsWith(".php"))) {
    return {
      kind: "php",
      nodeVersion: DEFAULT_NODE,
      hasPrisma: false,
      hasPrismaConfig: false,
      nextStandalone: false,
      hasBuildScript: false,
      hasStartScript: false,
      hasComposer,
    };
  }

  if (existsSync(join(context, "index.html"))) {
    return {
      kind: "static",
      nodeVersion: DEFAULT_NODE,
      hasPrisma: false,
      hasPrismaConfig: false,
      nextStandalone: false,
      hasBuildScript: false,
      hasStartScript: false,
      hasComposer: false,
    };
  }

  return null;
}
