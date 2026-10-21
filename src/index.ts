import Fastify from "fastify";
import projectsRoute from "./routes/projects.js";
import secretsRoute from "./routes/secrets.js";
import deployRoute from "./routes/deploy.js";
import systemRoute from "./routes/system.js";
import redeployRoute from "./routes/redeploy.js";
import analyticsRoute from "./routes/analytics.js";
import { startAnalyticsIngest } from "./lib/analytics/ingest.js";
import { prisma } from "./lib/db.js";

const app = Fastify({ logger: true });

app.register(projectsRoute);
app.register(secretsRoute);
app.register(deployRoute);
app.register(systemRoute);
app.register(redeployRoute);
app.register(analyticsRoute);

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 3001);

/**
 * Un déploiement interrompu (arrêt du processus pendant le build) laisse le projet
 * en BUILDING, et plus aucun nouveau déploiement n'est alors accepté. Au démarrage,
 * aucun build ne peut être en cours : on repasse ces projets à FAILED.
 */
async function recoverStaleDeploys() {
  const stale = await prisma.project.updateMany({
    where: { status: "BUILDING" },
    data: { status: "FAILED" },
  });
  if (stale.count) app.log.warn(`${stale.count} déploiement(s) resté(s) en BUILDING remis à FAILED au démarrage`);
}

app.listen({ port, host: "0.0.0.0" }, async (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  try {
    await recoverStaleDeploys();
  } catch (e) {
    app.log.error(e, "Remise à zéro des déploiements bloqués impossible");
  }
  startAnalyticsIngest(app.log);
});
