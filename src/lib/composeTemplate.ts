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
  volumes: VolumeMount[];
};

export type VolumeMount = { name: string; target: string; readOnly: boolean };

type RawService = {
  build?: string | { context?: string; dockerfile?: string; args?: unknown };
  environment?: unknown;
  networks?: unknown;
  labels?: unknown;
  restart?: string;
  volumes?: unknown;
};

type RawCompose = {
  services?: Record<string, RawService>;
  networks?: Record<string, { name?: string } | null>;
  volumes?: Record<string, unknown>;
};

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Volumes nommés uniquement (déclarés dans `volumes:` à la racine du compose).
 * Les montages de dossiers de l'hôte sont refusés : un repo ne doit pas pouvoir monter / ou le socket Docker.
 */
function parseVolumes(raw: unknown, declared: Record<string, unknown>, file: string): VolumeMount[] {
  if (!raw) return [];
  if (!Array.isArray(raw)) throw new Error(`${file} : "volumes" du service doit être une liste`);

  return raw.map((entry) => {
    let source: string | undefined;
    let target: string | undefined;
    let readOnly = false;

    if (typeof entry === "string") {
      const [s, t, mode] = entry.split(":");
      source = s;
      target = t;
      readOnly = mode === "ro";
    } else if (entry && typeof entry === "object") {
      const e = entry as { type?: string; source?: string; target?: string; read_only?: boolean };
      if (e.type && e.type !== "volume") throw new Error(`${file} : seuls les volumes nommés sont autorisés`);
      source = e.source;
      target = e.target;
      readOnly = !!e.read_only;
    }

    if (!source || !target) throw new Error(`${file} : volume mal formé`);
    if (!VOLUME_NAME.test(source)) {
      throw new Error(`${file} : "${source}" refusé, seuls les volumes nommés sont autorisés (pas de dossier de l'hôte)`);
    }
    if (!(source in declared)) throw new Error(`${file} : volume "${source}" non déclaré dans "volumes:"`);
    if (!target.startsWith("/") || target.includes("..")) throw new Error(`${file} : cible de volume invalide "${target}"`);

    return { name: source, target, readOnly };
  });
}

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
    volumes: parseVolumes(svc.volumes, doc?.volumes ?? {}, file),
  };

  return { template, missing: [...missing] };
}
