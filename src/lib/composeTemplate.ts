import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const COMPOSE_FILES = ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"];

export type ServiceTemplate = {
  serviceName: string;
  buildContext: string;
  dockerfile?: string;
  buildArgs: Record<string, string>;
  environment: Record<string, string>;
  networks: string[];
  labels: Record<string, string>;
  restart: string;
};

type RawService = {
  build?: string | { context?: string; dockerfile?: string; args?: unknown };
  environment?: unknown;
  networks?: unknown;
  labels?: unknown;
  restart?: string;
};

type RawCompose = {
  services?: Record<string, RawService>;
  networks?: Record<string, { name?: string } | null>;
};

// Interpolation façon docker compose : $$, ${VAR}, ${VAR:-défaut}, ${VAR-défaut}, $VAR
export function interpolate(value: string, vars: Record<string, string>, missing: Set<string>): string {
  return value.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced: string | undefined, colon: string | undefined, def: string | undefined, bare: string | undefined) => {
      if (match === "$$") return "$";
      const name = braced ?? bare!;
      const v = vars[name];
      if (def !== undefined) {
        if (v === undefined || (colon === ":" && v === "")) return def;
        return v;
      }
      if (v === undefined) {
        missing.add(name);
        return "";
      }
      return v;
    }
  );
}

function toRecord(raw: unknown): Record<string, string | null> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, string | null> = {};
    for (const entry of raw) {
      const s = String(entry);
      const i = s.indexOf("=");
      if (i === -1) out[s] = null;
      else out[s.slice(0, i)] = s.slice(i + 1);
    }
    return out;
  }
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = v === null || v === undefined ? null : String(v);
  }
  return out;
}

function resolveRecord(
  raw: unknown,
  vars: Record<string, string>,
  missing: Set<string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(toRecord(raw))) {
    // `- VAR` sans valeur : compose reprend la variable de l'environnement
    if (v === null) {
      if (vars[k] !== undefined) out[k] = vars[k];
      else missing.add(k);
    } else {
      out[k] = interpolate(v, vars, missing);
    }
  }
  return out;
}

export async function loadComposeTemplate(
  repoDir: string,
  vars: Record<string, string>
): Promise<{ template: ServiceTemplate; missing: string[] } | null> {
  const file = COMPOSE_FILES.map((f) => join(repoDir, f)).find((p) => existsSync(p));
  if (!file) return null;

  const doc = parse(await readFile(file, "utf8")) as RawCompose | null;
  const services = Object.entries(doc?.services ?? {});
  const entry = services.find(([, s]) => s.build !== undefined);
  if (!entry) throw new Error(`${file} : aucun service avec une section "build"`);
  if (services.filter(([, s]) => s.build !== undefined).length > 1) {
    throw new Error(`${file} : un seul service avec "build" est supporté`);
  }

  const [serviceName, svc] = entry;
  const missing = new Set<string>();

  const build = typeof svc.build === "string" ? { context: svc.build } : svc.build ?? {};

  // Le nom réel d'un réseau externe peut différer de sa clé (networks.<clé>.name)
  const topNetworks = doc?.networks ?? {};
  const networkKeys = Array.isArray(svc.networks)
    ? svc.networks.map(String)
    : Object.keys((svc.networks as Record<string, unknown>) ?? {});
  const networks = networkKeys.map((key) => {
    const name = topNetworks[key]?.name;
    return name ? interpolate(name, vars, missing) : key;
  });

  const template: ServiceTemplate = {
    serviceName,
    buildContext: interpolate(build.context ?? ".", vars, missing),
    dockerfile: build.dockerfile ? interpolate(build.dockerfile, vars, missing) : undefined,
    buildArgs: resolveRecord(build.args, vars, missing),
    environment: resolveRecord(svc.environment, vars, missing),
    networks,
    labels: resolveRecord(svc.labels, vars, missing),
    restart: svc.restart ?? "unless-stopped",
  };

  return { template, missing: [...missing] };
}
