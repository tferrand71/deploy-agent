import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/db.js";
import { encrypt } from "../lib/crypto.js";

const secretsRoute: FastifyPluginAsync = async (app) => {
  app.post<{
    Params: { id: string };
    Body: { key: string; value: string };
  }>("/projects/:id/secrets", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      body: {
        type: "object",
        required: ["key", "value"],
        properties: {
          key: { type: "string", minLength: 1 },
          value: { type: "string" },
        },
      },
    },
    handler: async (req, reply) => {
      const { id } = req.params;
      const { key, value } = req.body;

      const project = await prisma.project.findUnique({ where: { id } });
      if (!project) return reply.status(404).send({ error: "Projet introuvable" });

      await prisma.projectSecret.upsert({
        where: { projectId_key: { projectId: id, key } },
        create: { projectId: id, key, encryptedValue: encrypt(value) },
        update: { encryptedValue: encrypt(value) },
      });

      reply.status(204).send();
    },
  });
};

export default secretsRoute;
