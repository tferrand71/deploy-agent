import { createHash, randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { docker } from "../docker.js";
import { isBot, isPageview, parseLine, parseUserAgent, referrerHost } from "./parse.js";

/**
 * Lit le journal d'accès de Traefik (logs Docker du conteneur) et range
 * chaque requête dans AnalyticsHit. Aucun script dans les sites, aucun cookie.
 *
 * Vie privée : l'IP n'est jamais stockée. Le visiteur est une empreinte
 * sha256(sel du jour + IP + navigateur + site), et le sel est détruit le
 * surlendemain : impossible ensuite de relier deux jours ou de retrouver l'IP.
 */

const SOURCE = process.env.ANALYTICS_SOURCE_CONTAINER ?? "traefik";
const INTERVAL_MS = 60_000;
const RETENTION_ALL_DAYS = 90; // requêtes techniques (assets, erreurs, robots)
const RETENTION_PAGEVIEWS_DAYS = 395; // pages vues : 13 mois (recommandation CNIL)

/* ── Horodatage Docker (RFC3339Nano) → entier comparable ─────── */

function tsKey(ts: string): bigint {
  const m = ts.match(/^(.+?)(?:\.(\d+))?Z$/);
  if (!m) return 0n;
  const seconds = BigInt(Math.floor(Date.parse(`${m[1]}Z`) / 1000));
  const nanos = BigInt((m[2] ?? "").padEnd(9, "0").slice(0, 9) || "0");
  return seconds * 1_000_000_000n + nanos;
}

/** Logs Docker non-TTY : trames [flux, 0, 0, 0, taille (4 octets)] + contenu. */
function demux(buf: Buffer): string {
  if (buf.length < 8 || (buf[0] !== 1 && buf[0] !== 2) || buf[1] !== 0) return buf.toString("utf8");
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString("utf8");
}

/* ── Sels quotidiens ─────────────────────────────────────────── */

const salts = new Map<string, string>();

async function saltFor(day: string): Promise<string> {
  const cached = salts.get(day);
  if (cached) return cached;
  const key = `salt:${day}`;
  const row = await prisma.analyticsState.upsert({
    where: { key },
    create: { key, value: randomBytes(32).toString("hex") },
    update: {},
  });
  salts.set(day, row.value);
  return row.value;
}

async function purgeOldSalts(): Promise<void> {
  const keep = new Set([0, 1].map((d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)));
  const rows = await prisma.analyticsState.findMany({ where: { key: { startsWith: "salt:" } } });
  const stale = rows.filter((r) => !keep.has(r.key.slice(5))).map((r) => r.key);
  if (stale.length) await prisma.analyticsState.deleteMany({ where: { key: { in: stale } } });
  for (const day of salts.keys()) if (!keep.has(day)) salts.delete(day);
}

/* ── Routeur Traefik → domaine (pour l'ancien format sans Host) ── */

async function routerHosts(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const containers = await docker.listContainers({ all: true });
  for (const c of containers) {
    for (const [label, value] of Object.entries(c.Labels ?? {})) {
      const m = label.match(/^traefik\.http\.routers\.([^.]+)\.rule$/);
      const host = value.match(/Host\(`([^`]+)`\)/)?.[1];
      if (m && host) map.set(m[1], host);
    }
  }
  return map;
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/* ── Boucle d'ingestion ──────────────────────────────────────── */

let running = false;
let lastPurge = 0;
export let lastIngestAt: Date | null = null;

export async function ingestOnce(log: FastifyBaseLogger): Promise<number> {
  const cursorRow = await prisma.analyticsState.findUnique({ where: { key: "cursor" } });
  const cursor = cursorRow ? tsKey(cursorRow.value) : 0n;
  const since = Number(cursor / 1_000_000_000n);

  const raw = (await docker
    .getContainer(SOURCE)
    .logs({ stdout: true, stderr: true, timestamps: true, since, follow: false })) as unknown as Buffer;

  const hosts = await routerHosts();
  const rows: Prisma.AnalyticsHitCreateManyInput[] = [];
  let lastTs: string | null = null;

  for (const line of demux(raw).split("\n")) {
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    const ts = line.slice(0, sp);
    if (tsKey(ts) <= cursor) continue;
    lastTs = ts;

    const hit = parseLine(line.slice(sp + 1));
    if (!hit || !hit.router) continue; // requêtes sans site (scans de l'IP nue)
    // Routeur d'un conteneur disparu : on garde son nom plutôt que perdre la ligne
    // Variantes de redirection (harmonie-www, harmonie-apex…) : même site que le routeur principal
    const rawHost =
        hit.host ?? hosts.get(hit.router) ?? hosts.get(hit.router.replace(/-(www|apex|http)$/, "")) ?? hit.router;

    const host = normalizeHost(rawHost);
    const date = new Date(Number(tsKey(ts) / 1_000_000n));
    const salt = await saltFor(date.toISOString().slice(0, 10));
    const visitor = createHash("sha256")
      .update(`${salt}|${hit.ip}|${hit.userAgent ?? ""}|${host}`)
      .digest("hex")
      .slice(0, 16);
    const bot = isBot(hit);
    const ua = parseUserAgent(hit.userAgent);

    rows.push({
      ts: date,
      host,
      path: hit.path.slice(0, 300),
      method: hit.method.slice(0, 10),
      status: hit.status,
      durationMs: hit.durationMs,
      bytes: hit.bytes,
      visitor,
      referrer: referrerHost(hit.referer, host),
      ...ua,
      bot,
      pageview: isPageview(hit, bot),
    });
  }

  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.analyticsHit.createMany({ data: rows.slice(i, i + 1000) });
  }
  if (lastTs) {
    await prisma.analyticsState.upsert({
      where: { key: "cursor" },
      create: { key: "cursor", value: lastTs },
      update: { value: lastTs },
    });
  }

  if (Date.now() - lastPurge > 3_600_000) {
    lastPurge = Date.now();
    const day = 86_400_000;
    await prisma.analyticsHit.deleteMany({
      where: { pageview: false, ts: { lt: new Date(Date.now() - RETENTION_ALL_DAYS * day) } },
    });
    await prisma.analyticsHit.deleteMany({
      where: { ts: { lt: new Date(Date.now() - RETENTION_PAGEVIEWS_DAYS * day) } },
    });
    await purgeOldSalts();
  }

  lastIngestAt = new Date();
  if (rows.length) log.info({ hits: rows.length }, "analytics : requêtes importées");
  return rows.length;
}

export function startAnalyticsIngest(log: FastifyBaseLogger): void {
  if (process.env.ANALYTICS_DISABLED === "1") return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await ingestOnce(log);
    } catch (err) {
      log.warn({ err }, "analytics : lecture du journal Traefik impossible");
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 5_000);
  setInterval(tick, INTERVAL_MS);
}
