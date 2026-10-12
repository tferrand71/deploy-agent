import type { FastifyPluginAsync } from "fastify";
import Dockerode from "dockerode";
import { simpleGit } from "simple-git";
import { composeUpBuild } from "../lib/compose.js";

const dockerHost = process.env.DOCKER_HOST;
const docker = dockerHost
    ? new Dockerode({
      host: dockerHost.replace(/^tcp:\/\//, "").split(":")[0],
      port: Number(dockerHost.split(":").pop()),
    })
    : new Dockerode({
      socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    });

// Racine autorisée pour un redéploiement : défense en profondeur même si le
// chemin vient des labels Docker (jamais d'un dossier saisi à la main).
const ALLOWED_ROOT = process.env.APPS_DIR ?? "/opt/apps";

type RedeployState = {
  status: "running" | "success" | "error";
  message?: string;
  startedAt: string;
  finishedAt?: string;
};

// En mémoire : pas besoin de persister ça en base, ça redémarre à vide avec
// l'agent, ce qui est très bien (un redéploiement en cours ne survit pas à
// un restart de toute façon).
const redeployState = new Map<string, RedeployState>();

const redeployRoute: FastifyPluginAsync = async (app) => {
  // Redéploie n'importe quel conteneur lancé via "docker compose" (portfolio,
  // dashboard, site-julien, etc.) : git pull + docker compose up -d --build
  // dans son dossier d'origine, retrouvé via les labels que compose pose lui-
  // même sur le conteneur — pas de liste de noms à whitelister à la main.
  app.post<{ Params: { id: string } }>(
      "/system/containers/:id/redeploy",
      async (req, reply) => {
        const { id } = req.params;

        const current = redeployState.get(id);
        if (current?.status === "running") {
          return reply
              .status(409)
              .send({ error: "Un redéploiement est déjà en cours pour ce conteneur" });
        }

        let workingDir: string;
        let configFiles: string[];
        try {
          const info = await docker.getContainer(id).inspect();
          const labels = info.Config.Labels ?? {};
          workingDir = labels["com.docker.compose.project.working_dir"];
          const configFilesRaw = labels["com.docker.compose.project.config_files"];

          if (!workingDir || !configFilesRaw) {
            return reply.status(422).send({
              error:
                  "Ce conteneur n'a pas été créé avec docker compose (labels manquants) : impossible de le redéployer automatiquement",
            });
          }
          configFiles = configFilesRaw.split(",");
        } catch {
          return reply.status(404).send({ error: "Conteneur introuvable" });
        }

        if (!workingDir.startsWith(ALLOWED_ROOT)) {
          return reply
              .status(403)
              .send({ error: `Dossier hors de ${ALLOWED_ROOT}, refusé` });
        }

        redeployState.set(id, {
          status: "running",
          startedAt: new Date().toISOString(),
        });

        // Répondre immédiatement — le pull + build se fait en arrière-plan
        reply.status(202).send({ message: "Redéploiement démarré" });

        try {
          await simpleGit(workingDir).pull();
          const logs = await composeUpBuild(workingDir, configFiles);
          redeployState.set(id, {
            status: "success",
            startedAt: redeployState.get(id)!.startedAt,
            finishedAt: new Date().toISOString(),
            message: logs.slice(-4000),
          });
        } catch (err) {
          app.log.error(err, `Redéploiement échoué pour ${id}`);
          redeployState.set(id, {
            status: "error",
            startedAt: redeployState.get(id)!.startedAt,
            finishedAt: new Date().toISOString(),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
  );

  // Suivi du dernier redéploiement déclenché pour ce conteneur (statut +
  // logs tronqués), pour que le dashboard puisse l'afficher après coup.
  app.get<{ Params: { id: string } }>(
      "/system/containers/:id/redeploy",
      async (req, reply) => {
        const state = redeployState.get(req.params.id);
        if (!state) {
          return reply
              .status(404)
              .send({ error: "Aucun redéploiement enregistré pour ce conteneur" });
        }
        return state;
      }
  );
};

export default redeployRoute;
