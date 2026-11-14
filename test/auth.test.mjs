// Tests de l'authentification de l'API (node --test). Utilise le code compilé : `npm test` lance le build avant.
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createAuthHook, loadAgentToken } from "../dist/lib/auth.js";

const TOKEN = "a".repeat(64);

/** Petite appli avec le même hook que index.ts : une route ouverte, deux protégées. */
async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", createAuthHook(TOKEN));
  app.get("/health", async () => ({ ok: true }));
  app.get("/projects", async () => [{ name: "secret" }]);
  app.post("/projects/:id/deploy", async () => ({ started: true }));
  app.delete("/projects/:id", async () => ({ deleted: true }));
  await app.ready();
  return app;
}

test("/health reste ouverte sans jeton", async () => {
  const app = await buildApp();
  assert.equal((await app.inject("/health")).statusCode, 200);
});

test("sans en-tête Authorization : 401 sur toutes les routes protégées", async () => {
  const app = await buildApp();
  for (const [method, url] of [["GET", "/projects"], ["POST", "/projects/x/deploy"], ["DELETE", "/projects/x"]]) {
    const res = await app.inject({ method, url });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
    assert.equal(res.headers["www-authenticate"], "Bearer");
    assert.deepEqual(res.json(), { error: "Non autorisé" });
  }
});

test("mauvais jeton, jeton tronqué ou trop long : 401", async () => {
  const app = await buildApp();
  for (const bad of ["b".repeat(64), TOKEN.slice(0, -1), TOKEN + "x", "", " "]) {
    const res = await app.inject({ url: "/projects", headers: { authorization: `Bearer ${bad}` } });
    assert.equal(res.statusCode, 401, `jeton « ${bad.slice(0, 8)}… »`);
  }
});

test("schéma d'authentification autre que Bearer : 401", async () => {
  const app = await buildApp();
  for (const header of [`Basic ${TOKEN}`, TOKEN, `bearer ${TOKEN}`]) {
    assert.equal((await app.inject({ url: "/projects", headers: { authorization: header } })).statusCode, 401, header.slice(0, 12));
  }
});

test("bon jeton : la requête passe, y compris avec des paramètres d'URL", async () => {
  const app = await buildApp();
  const headers = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await app.inject({ url: "/projects", headers })).statusCode, 200);
  assert.equal((await app.inject({ url: "/projects?filtre=1", headers })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/projects/x/deploy", headers })).statusCode, 200);
});

test("un chemin qui ressemble à /health n'est pas ouvert", async () => {
  const app = await buildApp();
  for (const url of ["/health/../projects", "/healthz", "//projects"]) {
    const res = await app.inject({ url });
    assert.notEqual(res.statusCode, 200, url);
  }
});

test("loadAgentToken refuse un jeton absent ou trop court (échec fermé)", () => {
  assert.throws(() => loadAgentToken({}), /AGENT_API_TOKEN/);
  assert.throws(() => loadAgentToken({ AGENT_API_TOKEN: "court" }), /trop courte/);
  assert.equal(loadAgentToken({ AGENT_API_TOKEN: TOKEN }), TOKEN);
});
