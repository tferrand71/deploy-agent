import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/db.js";

const projectsRoute: FastifyPluginAsync = async (app) => {
  app.get("/projects", async () => {
    return prisma.project.findMany({
      select: {
        id: true,
        name: true,
        repoUrl: true,
        branch: true,
        subdomain: true,
        lastCommit: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        // secrets intentionnellement exclus
      },
      orderBy: { createdAt: "desc" },
    });
  });

  app.post<{
    Body: { name: string; repoUrl: string; branch?: string; subdomain: string };
  }>("/projects", {
    schema: {
      body: {
        type: "object",
        required: ["name", "repoUrl", "subdomain"],
        properties: {
          name: { type: "string", minLength: 1 },
          repoUrl: { type: "string", minLength: 1 },
          branch: { type: "string", default: "main" },
          subdomain: { type: "string", minLength: 1 },
        },
      },
    },
    handler: async (req, reply) => {
      const { name, repoUrl, branch = "main", subdomain } = req.body;
      const project = await prisma.project.create({
        data: { name, repoUrl, branch, subdomain },
      });
      reply.status(201).send(project);
    },
  });

  // Mise à jour partielle : seuls les champs envoyés sont modifiés.
  // Le sous-domaine et le repo ne s'appliquent qu'au prochain déploiement
  // (le conteneur en cours garde ses anciens labels Traefik jusqu'à là).
  app.patch<{
    Params: { id: string };
    Body: { name?: string; repoUrl?: string; branch?: string; subdomain?: string };
  }>("/projects/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 1 },
          repoUrl: { type: "string", minLength: 1 },
          branch: { type: "string", minLength: 1 },
          subdomain: { type: "string", pattern: "^[a-z0-9-]+$" },
        },
      },
    },
    handler: async (req, reply) => {
      const { id } = req.params;

      const project = await prisma.project.findUnique({ where: { id } });
      if (!project) return reply.status(404).send({ error: "Projet introuvable" });

      if (project.status === "BUILDING") {
        return reply
            .status(409)
            .send({ error: "Un déploiement est en cours : modifie le projet une fois terminé" });
      }

      return prisma.project.update({ where: { id }, data: req.body });
    },
  });
};

export default projectsRoute;
