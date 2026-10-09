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
};

export default projectsRoute;
