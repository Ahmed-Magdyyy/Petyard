import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { requestIdMiddleware } from "../../src/shared/middlewares/requestIdMiddleware.js";
import { productBatchBodyParser } from "../../src/domains/product/productBatch.middleware.js";
import { bunnyStreamWebhookBody, BUNNY_STREAM_WEBHOOK_PATH } from "../../src/domains/videos/provider/bunnyStreamWebhook.middleware.js";

test("request IDs survive body parser errors while webhook bytes and normal JSON remain intact", async (t) => {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(BUNNY_STREAM_WEBHOOK_PATH, bunnyStreamWebhookBody);
  app.use("/api/v1/products/batch", productBatchBodyParser);
  app.use(express.urlencoded({ extended: false, limit: "5mb" }));
  app.use(express.json({ limit: "5mb" }));
  app.post(BUNNY_STREAM_WEBHOOK_PATH, (req, res) => res.json({ raw: req.bunnyStreamRawBody.toString() }));
  app.post("/api/v1/products/batch", (req, res) => res.json(req.body));
  app.post("/normal", (req, res) => res.json(req.body));
  app.use((error, req, res, _next) => res.status(error.statusCode || error.status || 500).json({ requestId: req.requestId }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const checkId = async (response, status) => {
    assert.equal(response.status, status);
    const id = response.headers.get("x-request-id");
    assert.match(id, /^[0-9a-f-]{36}$/i);
    assert.equal((await response.json()).requestId ?? id, id);
  };
  const jsonHeaders = { "content-type": "application/json" };

  await checkId(await fetch(`${base}/normal`, { method: "POST", headers: jsonHeaders, body: "{" }), 400);
  await checkId(await fetch(`${base}/normal`, { method: "POST", headers: jsonHeaders, body: " ".repeat(5 * 1024 * 1024 + 1) }), 413);
  await checkId(await fetch(`${base}/api/v1/products/batch`, { method: "POST", headers: jsonHeaders, body: "{" }), 400);
  await checkId(await fetch(`${base}/api/v1/products/batch`, { method: "POST", headers: jsonHeaders, body: " ".repeat(2049) }), 413);

  const normal = await fetch(`${base}/normal`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ value: "kept" }) });
  assert.deepEqual(await normal.json(), { value: "kept" });
  assert.match(normal.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);

  const webhookBytes = '{"event":"ready"}';
  const webhook = await fetch(`${base}${BUNNY_STREAM_WEBHOOK_PATH}`, { method: "POST", headers: jsonHeaders, body: webhookBytes });
  assert.deepEqual(await webhook.json(), { raw: webhookBytes });
  assert.match(webhook.headers.get("x-request-id"), /^[0-9a-f-]{36}$/i);
});
