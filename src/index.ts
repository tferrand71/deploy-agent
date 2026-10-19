import Fastify from "fastify";
import projectsRoute from "./routes/projects.js";
import secretsRoute from "./routes/secrets.js";
import deployRoute from "./routes/deploy.js";
import systemRoute from "./routes/system.js";
import redeployRoute from "./routes/redeploy.js";
import analyticsRoute from "./routes/analytics.js";
import { startAnalyticsIngest } from "./lib/analytics/ingest.js";

const app = Fastify({ logger: true });

app.register(projectsRoute);
app.register(secretsRoute);
app.register(deployRoute);
app.register(systemRoute);
app.register(redeployRoute);
app.register(analyticsRoute);

app.get("/health", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  startAnalyticsIngest(app.log);
});
