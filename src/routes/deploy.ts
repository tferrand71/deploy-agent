import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/db.js";
import { decrypt } from "../lib/crypto.js";
import { cloneOrPull } from "../lib/git.js";
import { buildAndRun } from "../lib/docker.js";

const deployRoute: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>("/projects/:id/deploy", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
    handler: async (req, reply) => {
      const { id } = req.params;

      const project = await prisma.project.findUnique({
        where: { id },
        include: { secrets: true },
      });
      if (!project) return reply.status(404).send({ error: "Projet introuvable" });

      if (project.status === "BUILDING") {
        return reply.status(409).send({ error: "Un déploiement est déjà en cours" });
      }

      await prisma.project.update({
        where: { id },
        data: { status: "BUILDING" },
      });

      // Répondre immédiatement — le build se fait en arrière-plan
      reply.status(202).send({ message: "Déploiement démarré" });

      try {
        const commit = await cloneOrPull(id, project.repoUrl, project.branch);

        const envVars: Record<string, string> = {};
        for (const secret of project.secrets) {
          envVars[secret.key] = decrypt(secret.encryptedValue);
        }

        await buildAndRun(id, project.subdomain, envVars, {
          info: (msg) => app.log.info(`[${project.name}] ${msg}`),
          warn: (msg) => app.log.warn(`[${project.name}] ${msg}`),
        });

        await prisma.project.update({
          where: { id },
          data: { status: "RUNNING", lastCommit: commit },
        });
      } catch (err) {
        app.log.error(err, `Déploiement échoué pour le projet ${id}`);
        await prisma.project.update({
          where: { id },
          data: { status: "FAILED" },
        });
      }
    },
  });
};

export default deployRoute;
