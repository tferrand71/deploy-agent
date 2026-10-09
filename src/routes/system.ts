import type { FastifyPluginAsync } from "fastify";
import { readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Dockerode from "dockerode";

const execAsync = promisify(exec);

const PROC = process.env.HOST_PROC ?? "/host-proc";

const dockerHost = process.env.DOCKER_HOST;
const docker = dockerHost
  ? new Dockerode({
      host: dockerHost.replace(/^tcp:\/\//, "").split(":")[0],
      port: Number(dockerHost.split(":").pop()),
    })
  : new Dockerode({
      socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    });

interface CpuSnapshot {
  total: number;
  idle: number;
}

async function readCpuSnapshot(): Promise<CpuSnapshot> {
  const raw = await readFile(`${PROC}/stat`, "utf8");
  const line = raw.split("\n").find((l) => l.startsWith("cpu "))!;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;
  const totalIdle = idle + iowait;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { total, idle: totalIdle };
}

function parseMeminfoKb(raw: string, key: string): number {
  const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
  return match ? parseInt(match[1], 10) : 0;
}

const systemRoute: FastifyPluginAsync = async (app) => {
  app.get("/system/host", async (_req, reply) => {
    try {
      const [snap1] = await Promise.all([readCpuSnapshot()]);
      await new Promise((r) => setTimeout(r, 200));
      const snap2 = await readCpuSnapshot();

      const totalDiff = snap2.total - snap1.total;
      const idleDiff = snap2.idle - snap1.idle;
      const cpuPercent =
        totalDiff > 0
          ? Math.round(((totalDiff - idleDiff) / totalDiff) * 1000) / 10
          : 0;

      const memRaw = await readFile(`${PROC}/meminfo`, "utf8");
      const memTotalKb = parseMeminfoKb(memRaw, "MemTotal");
      const memAvailableKb = parseMeminfoKb(memRaw, "MemAvailable");
      const memUsedKb = memTotalKb - memAvailableKb;

      const { stdout: dfOut } = await execAsync("df -k /");
      const dfLine = dfOut.trim().split("\n")[1];
      const dfParts = dfLine.trim().split(/\s+/);
      const diskTotalKb = parseInt(dfParts[1], 10);
      const diskUsedKb = parseInt(dfParts[2], 10);
      const diskAvailableKb = parseInt(dfParts[3], 10);

      return {
        cpu: { percent: cpuPercent },
        memory: {
          totalKb: memTotalKb,
          usedKb: memUsedKb,
          availableKb: memAvailableKb,
          percent: Math.round((memUsedKb / memTotalKb) * 1000) / 10,
        },
        disk: {
          totalKb: diskTotalKb,
          usedKb: diskUsedKb,
          availableKb: diskAvailableKb,
          percent: Math.round((diskUsedKb / diskTotalKb) * 1000) / 10,
        },
      };
    } catch (err) {
      app.log.error(err, "system/host error");
      reply.status(500).send({ error: "Impossible de lire les stats système" });
    }
  });

  app.get("/system/containers", async (_req, reply) => {
    try {
      const containers = await docker.listContainers();

      const stats = await Promise.all(
        containers.map(async (info) => {
          try {
            const c = docker.getContainer(info.Id);
            const s = (await c.stats({ stream: false })) as Dockerode.ContainerStats;

            const cpuDelta =
              s.cpu_stats.cpu_usage.total_usage -
              s.precpu_stats.cpu_usage.total_usage;
            const systemDelta =
              (s.cpu_stats.system_cpu_usage ?? 0) -
              (s.precpu_stats.system_cpu_usage ?? 0);
            const numCpus =
              s.cpu_stats.online_cpus ??
              s.cpu_stats.cpu_usage.percpu_usage?.length ??
              1;
            const cpuPercent =
              systemDelta > 0
                ? Math.round((cpuDelta / systemDelta) * numCpus * 1000 * 100) /
                  1000
                : 0;

            const memUsed = s.memory_stats.usage ?? 0;
            const memLimit = s.memory_stats.limit ?? 0;

            return {
              id: info.Id.slice(0, 12),
              name: (info.Names[0] ?? "").replace(/^\//, ""),
              image: info.Image,
              status: info.Status,
              cpu: { percent: cpuPercent },
              memory: {
                usedBytes: memUsed,
                limitBytes: memLimit,
                percent:
                  memLimit > 0
                    ? Math.round((memUsed / memLimit) * 1000) / 10
                    : 0,
              },
            };
          } catch {
            return {
              id: info.Id.slice(0, 12),
              name: (info.Names[0] ?? "").replace(/^\//, ""),
              image: info.Image,
              status: info.Status,
              cpu: { percent: 0 },
              memory: { usedBytes: 0, limitBytes: 0, percent: 0 },
            };
          }
        })
      );

      return stats;
    } catch (err) {
      app.log.error(err, "system/containers error");
      reply
        .status(500)
        .send({ error: "Impossible de lire les stats conteneurs" });
    }
  });
};

export default systemRoute;
