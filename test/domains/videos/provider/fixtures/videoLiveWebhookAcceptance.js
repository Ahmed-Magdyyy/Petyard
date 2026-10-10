import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import { BUNNY_STREAM_WEBHOOK_PATH, bunnyStreamWebhookBody } from "../../../../../src/domains/videos/provider/bunnyStreamWebhook.middleware.js";
import { createBunnyStreamWebhookRouter } from "../../../../../src/domains/videos/provider/bunnyStreamWebhook.routes.js";
import { createBunnyStreamWebhookRepository } from "../../../../../src/domains/videos/provider/bunnyStreamWebhook.repository.js";
import { createBunnyStreamWebhookService } from "../../../../../src/domains/videos/provider/bunnyStreamWebhook.service.js";
import { createVideoAssetObserver } from "../../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { claimVideoProviderOperationById, completeVideoProviderOperation, failVideoProviderOperation,
  listDueVideoProviderOperationIds } from "../../../../../src/domains/videos/provider/videoProviderOperation.service.js";

// Local signed replay with real persistence/provider reconciliation; no provider webhook setting is changed.
export async function verifyVideoLiveWebhook({ models, provider, recordOperation, stream, guid, assetId, snapshot }) {
  const service = createBunnyStreamWebhookService({ libraryId: stream.libraryId, signingKey: stream.readOnlyApiKey,
    repository: createBunnyStreamWebhookRepository({ assets: models.assets, recordOperation }),
    enqueue: async () => { throw new Error("Isolated enqueue loss"); } });
  const app = express();
  app.use(BUNNY_STREAM_WEBHOOK_PATH, bunnyStreamWebhookBody);
  app.use(express.json());
  app.use("/api/v1/integrations/bunny-stream", createBunnyStreamWebhookRouter({ getService: async () => service }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ failed: true }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}${BUNNY_STREAM_WEBHOOK_PATH}`;
    const body = Buffer.from(JSON.stringify({ VideoLibraryId: Number(stream.libraryId), VideoGuid: guid, Status: snapshot.status }));
    const headers = { "Content-Type": "application/json", "x-bunnystream-signature-version": "v1",
      "x-bunnystream-signature-algorithm": "hmac-sha256",
      "x-bunnystream-signature": createHmac("sha256", stream.readOnlyApiKey).update(body).digest("hex") };
    const query = { assetId, providerGuid: guid, dedupeKey: /^bunny-webhook:/ };
    const unsigned = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    assert.equal(unsigned.status, 401); await unsigned.body?.cancel();
    assert.equal(await models.operations.countDocuments(query), 0);
    for (let replay = 0; replay < 2; replay++) {
      const response = await fetch(url, { method: "POST", headers, body });
      assert.equal(response.status, 202); assert.deepEqual(await response.json(), { received: true });
    }
    assert.equal(await models.operations.countDocuments(query), 1);
    const operation = await models.operations.findOne(query);
    assert.equal(operation.status, "pending");
    // A hint cannot claim readiness: the worker must independently GET the current provider state.
    assert.equal((await models.assets.findById(assetId)).technicalState, "awaiting_upload");
    const redispatched = [];
    const runtime = createVideoProviderRuntime({ provider, assets: createVideoAssetObserver({ model: models.assets }),
      enqueue: async id => redispatched.push(String(id)), operations: {
        listDueIds: input => listDueVideoProviderOperationIds({ ...input, model: models.operations }),
        claimById: input => claimVideoProviderOperationById({ ...input, model: models.operations }),
        complete: input => completeVideoProviderOperation({ ...input, model: models.operations }),
        fail: input => failVideoProviderOperation({ ...input, model: models.operations }),
      } });
    await runtime.sweep(); assert.ok(redispatched.includes(String(operation._id)));
    assert.equal((await runtime.process(String(operation._id))).status, "completed");
    assert.equal((await models.operations.findById(operation._id)).status, "completed");
    assert.equal((await models.assets.findById(assetId)).technicalState, "ready");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
