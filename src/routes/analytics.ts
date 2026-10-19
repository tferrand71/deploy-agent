import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { lastIngestAt } from "../lib/analytics/ingest.js";

const RANGES = {
  "24h": { interval: "24 hours", bucket: "hour", ms: 86_400_000 },
  "7d": { interval: "7 days", bucket: "day", ms: 7 * 86_400_000 },
  "30d": { interval: "30 days", bucket: "day", ms: 30 * 86_400_000 },
  "90d": { interval: "90 days", bucket: "day", ms: 90 * 86_400_000 },
} as const;

type RangeKey = keyof typeof RANGES;

// Heure de Paris pour les regroupements par heure / jour
const LOCAL_TS = Prisma.sql`(("ts" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris')`;

const num = (v: unknown) => Number(v ?? 0);

const analyticsRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { range?: string; host?: string } }>("/analytics", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          range: { type: "string", enum: Object.keys(RANGES) },
          host: { type: "string", pattern: "^[a-z0-9.-]+$", maxLength: 253 },
        },
      },
    },
    handler: async (req) => {
      const rangeKey = (req.query.range ?? "7d") as RangeKey;
      const { interval, bucket, ms } = RANGES[rangeKey];
      const host = req.query.host ?? null;

      const to = new Date();
      const from = new Date(to.getTime() - ms);
      const prevFrom = new Date(from.getTime() - ms);

      const inRange = Prisma.sql`"ts" >= ${from} AND "ts" < ${to}`;
      const onHost = host ? Prisma.sql`AND "host" = ${host}` : Prisma.empty;
      const human = Prisma.sql`AND "bot" = false`;
      const pv = Prisma.sql`AND "pageview" = true`;

      const [
        totalsRows,
        prevRows,
        perfRows,
        statusRows,
        series,
        topPages,
        referrers,
        browsers,
        os,
        devices,
        sites,
        errors,
      ] = await Promise.all([
        prisma.$queryRaw<{ pageviews: bigint; visitors: bigint }[]>`
          SELECT count(*) AS pageviews, count(DISTINCT "visitor") AS visitors
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${pv}`,
        prisma.$queryRaw<{ pageviews: bigint; visitors: bigint }[]>`
          SELECT count(*) AS pageviews, count(DISTINCT "visitor") AS visitors
          FROM "AnalyticsHit" WHERE "ts" >= ${prevFrom} AND "ts" < ${from} ${onHost} ${pv}`,
        prisma.$queryRaw<{ requests: bigint; bots: bigint; avg: number | null; p95: number | null; bytes: bigint | null }[]>`
          SELECT count(*) FILTER (WHERE NOT "bot") AS requests,
                 count(*) FILTER (WHERE "bot") AS bots,
                 avg("durationMs") FILTER (WHERE NOT "bot") AS avg,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") FILTER (WHERE NOT "bot") AS p95,
                 sum("bytes") AS bytes
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost}`,
        prisma.$queryRaw<{ class: number; n: bigint }[]>`
          SELECT ("status" / 100) AS class, count(*) AS n
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${human}
          GROUP BY 1 ORDER BY 1`,
        prisma.$queryRaw<{ t: string; pageviews: bigint; visitors: bigint; requests: bigint }[]>`
          WITH buckets AS (
            SELECT generate_series(
              date_trunc(${bucket}, (now() AT TIME ZONE 'Europe/Paris') - ${interval}::interval) + ${"1 " + bucket}::interval,
              date_trunc(${bucket}, now() AT TIME ZONE 'Europe/Paris'),
              ${"1 " + bucket}::interval
            ) AS t
          ),
          hits AS (
            SELECT date_trunc(${bucket}, ${LOCAL_TS}) AS t,
                   count(*) FILTER (WHERE "pageview") AS pageviews,
                   count(DISTINCT "visitor") FILTER (WHERE "pageview") AS visitors,
                   count(*) AS requests
            FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${human}
            GROUP BY 1
          )
          SELECT to_char(b.t, 'YYYY-MM-DD"T"HH24:MI') AS t,
                 coalesce(h.pageviews, 0) AS pageviews,
                 coalesce(h.visitors, 0) AS visitors,
                 coalesce(h.requests, 0) AS requests
          FROM buckets b LEFT JOIN hits h ON h.t = b.t ORDER BY b.t`,
        prisma.$queryRaw<{ host: string; path: string; pageviews: bigint; visitors: bigint }[]>`
          SELECT "host", "path", count(*) AS pageviews, count(DISTINCT "visitor") AS visitors
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${pv}
          GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
        prisma.$queryRaw<{ name: string; visitors: bigint }[]>`
          SELECT coalesce("referrer", 'Accès direct') AS name, count(DISTINCT "visitor") AS visitors
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${pv}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        prisma.$queryRaw<{ name: string; visitors: bigint }[]>`
          SELECT coalesce("browser", 'Inconnu') AS name, count(DISTINCT "visitor") AS visitors
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${pv}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
        prisma.$queryRaw<{ name: string; visitors: bigint }[]>`
          SELECT coalesce("os", 'Inconnu') AS name, count(DISTINCT "visitor") AS visitors
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${pv}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
        prisma.$queryRaw<{ name: string; visitors: bigint }[]>`
          SELECT coalesce("device", 'Inconnu') AS name, count(DISTINCT "visitor") AS visitors
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${pv}
          GROUP BY 1 ORDER BY 2 DESC`,
        // Toujours tous les sites : sert de sélecteur et de comparatif
        prisma.$queryRaw<{ host: string; pageviews: bigint; visitors: bigint; requests: bigint; errors: bigint; avg: number | null }[]>`
          SELECT "host",
                 count(*) FILTER (WHERE "pageview") AS pageviews,
                 count(DISTINCT "visitor") FILTER (WHERE "pageview") AS visitors,
                 count(*) AS requests,
                 count(*) FILTER (WHERE "status" >= 500) AS errors,
                 avg("durationMs") AS avg
          FROM "AnalyticsHit" WHERE ${inRange} ${human}
          GROUP BY 1 ORDER BY 2 DESC, 4 DESC`,
        prisma.$queryRaw<{ host: string; path: string; status: number; n: bigint; last: Date }[]>`
          SELECT "host", "path", "status", count(*) AS n, max("ts") AS last
          FROM "AnalyticsHit" WHERE ${inRange} ${onHost} ${human} AND "status" >= 400
          GROUP BY 1, 2, 3 ORDER BY ("status" >= 500) DESC, 4 DESC LIMIT 8`,
      ]);

      const totals = totalsRows[0];
      const prev = prevRows[0];
      const perf = perfRows[0];
      const statuses = Object.fromEntries(statusRows.map((r) => [`${r.class}xx`, num(r.n)]));
      const humanRequests = num(perf?.requests);

      return {
        range: rangeKey,
        bucket,
        host,
        from,
        to,
        lastIngestAt,
        totals: {
          pageviews: num(totals?.pageviews),
          visitors: num(totals?.visitors),
          requests: humanRequests,
          bots: num(perf?.bots),
          bytes: num(perf?.bytes),
          avgMs: perf?.avg === null || perf?.avg === undefined ? null : Math.round(Number(perf.avg)),
          p95Ms: perf?.p95 === null || perf?.p95 === undefined ? null : Math.round(Number(perf.p95)),
          errorRate: humanRequests ? ((statuses["5xx"] ?? 0) / humanRequests) * 100 : 0,
        },
        previous: { pageviews: num(prev?.pageviews), visitors: num(prev?.visitors) },
        statuses,
        series: series.map((r) => ({
          t: r.t,
          pageviews: num(r.pageviews),
          visitors: num(r.visitors),
          requests: num(r.requests),
        })),
        topPages: topPages.map((r) => ({ host: r.host, path: r.path, pageviews: num(r.pageviews), visitors: num(r.visitors) })),
        referrers: referrers.map((r) => ({ name: r.name, visitors: num(r.visitors) })),
        browsers: browsers.map((r) => ({ name: r.name, visitors: num(r.visitors) })),
        os: os.map((r) => ({ name: r.name, visitors: num(r.visitors) })),
        devices: devices.map((r) => ({ name: r.name, visitors: num(r.visitors) })),
        sites: sites.map((r) => ({
          host: r.host,
          pageviews: num(r.pageviews),
          visitors: num(r.visitors),
          requests: num(r.requests),
          errors: num(r.errors),
          avgMs: r.avg === null ? null : Math.round(Number(r.avg)),
        })),
        errors: errors.map((r) => ({ host: r.host, path: r.path, status: r.status, count: num(r.n), last: r.last })),
      };
    },
  });
};

export default analyticsRoute;
