import assert from "node:assert/strict";
import test from "node:test";

import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";

function pendingDeleteOperation(type = "delete") {
  const operation = {
    _id: "507f1f77bcf86cd799439011",
    type,
    assetId: "507f191e810c19729de860ea",
    libraryId: "754739",
    providerGuid: "video-guid",
    status: "pending",
  };
  const operations = {
    async claimById({ operationId }) {
      if (operationId !== operation._id || operation.status !== "pending") return null;
      operation.status = "processing";
      return { ...operation, leaseToken: "lease-1" };
    },
    async complete({ operationId, leaseToken }) {
      if (operationId !== operation._id || leaseToken !== "lease-1") return null;
      operation.status = "completed";
      return { ...operation };
    },
    async fail() {
      operation.status = "retryable";
      return { ...operation };
    },
  };
  return { operation, operations };
}

test("accepted provider deletion completes the durable operation", async () => {
  const { operation, operations } = pendingDeleteOperation();
  const asset = { technicalState: "deleting" };
  const runtime = createVideoProviderRuntime({
    provider: { async deleteVideo() { return { accepted: true, status: 204 }; },
      async getVideo() { throw { status: 404 }; } },
    operations,
    assets: {
      async getDeletionTarget() { return {}; },
      async markDeleteAccepted() {
        asset.technicalState = "deleted";
      },
    },
  });

  const result = await runtime.process(operation._id);

  assert.deepEqual(
    { result, operationStatus: operation.status, assetState: asset.technicalState },
    {
      result: { status: "completed" },
      operationStatus: "completed",
      assetState: "deleted",
    },
  );
});

test("an uncertain delete completes only after Bunny confirms the video is absent", async () => {
  const { operation, operations } = pendingDeleteOperation();
  const asset = { technicalState: "deleting" };
  const runtime = createVideoProviderRuntime({
    provider: {
      async deleteVideo() {
        throw { code: "BUNNY_STREAM_TIMEOUT" };
      },
      async getVideo() {
        throw { status: 404 };
      },
    },
    operations,
    assets: {
      async getDeletionTarget() { return {}; },
      async markDeleteAccepted() {
        asset.technicalState = "deleted";
      },
    },
  });

  const result = await runtime.process(operation._id);

  assert.deepEqual(
    { result, operationStatus: operation.status, assetState: asset.technicalState },
    {
      result: { status: "completed" },
      operationStatus: "completed",
      assetState: "deleted",
    },
  );
});

test("a stale cleanup operation cannot delete an asset without current deletion intent", async () => {
  const { operation, operations } = pendingDeleteOperation();
  let providerCalls = 0;
  const runtime = createVideoProviderRuntime({
    provider: {
      async deleteVideo() { providerCalls += 1; return { accepted: true, status: 204 }; },
    },
    operations,
    assets: {
      async getDeletionTarget() { return null; },
      async markDeleteAccepted() { throw new Error("unexpected asset deletion"); },
    },
  });

  const result = await runtime.process(operation._id);

  assert.deepEqual(
    { result, operationStatus: operation.status, providerCalls },
    { result: { status: "retryable" }, operationStatus: "retryable", providerCalls: 0 },
  );
});

test("a Redis outage leaves a durable operation for the sweeper to enqueue later", async () => {
  const operationId = "507f1f77bcf86cd799439011";
  const operation = { _id: operationId, status: "pending" };
  let redisAvailable = false;
  const queued = [];
  const runtime = createVideoProviderRuntime({
    provider: {},
    assets: {},
    operations: {
      async record() { return operation; },
      async listDueIds() { return operation.status === "pending" ? [operationId] : []; },
      async recordEnqueueFailure() {},
    },
    enqueue: async (id) => {
      if (!redisAvailable) throw new Error("Redis unavailable");
      queued.push(id);
    },
  });

  const scheduled = await runtime.schedule({
    type: "reconcile",
    libraryId: "754739",
    providerGuid: "video-guid",
    dedupeKey: "reconcile:video-guid:1",
  });
  redisAvailable = true;
  const sweep = await runtime.sweep();

  assert.deepEqual(
    { scheduled, sweep, persisted: operation.status, queued },
    {
      scheduled: { operationId, queued: false },
      sweep: { attempted: 1, queued: 1, failed: 0 },
      persisted: "pending",
      queued: [operationId],
    },
  );
});

test("a fresh runtime recovers a persisted obligation after its producer stops", async () => {
  const persisted = { _id: "507f1f77bcf86cd799439011", status: "pending" };
  const operations = {
    async record() { return persisted; },
    async listDueIds() { return persisted.status === "pending" ? [persisted._id] : []; },
  };
  const original = createVideoProviderRuntime({
    provider: {}, assets: {}, operations,
    enqueue: async () => { throw new Error("Redis unavailable"); },
  });
  assert.deepEqual(await original.schedule({ type: "reconcile" }), {
    operationId: persisted._id, queued: false,
  });

  const recovered = [];
  const restarted = createVideoProviderRuntime({
    provider: {}, assets: {}, operations,
    enqueue: async (operationId) => { recovered.push(operationId); },
  });
  assert.deepEqual(await restarted.sweep(), { attempted: 1, queued: 1, failed: 0 });
  assert.deepEqual(recovered, [persisted._id]);
});

test("a failed enqueue audit cannot discard an already persisted obligation", async () => {
  const operationId = "507f1f77bcf86cd799439011";
  const persisted = { _id: operationId, status: "pending" };
  const runtime = createVideoProviderRuntime({
    provider: {},
    assets: {},
    operations: {
      async record() { return persisted; },
      async recordEnqueueFailure() { throw new Error("audit write interrupted"); },
    },
    enqueue: async () => { throw new Error("Redis unavailable"); },
  });

  const result = await runtime.schedule({ type: "reconcile" });

  assert.deepEqual(
    { result, persisted: persisted.status },
    { result: { operationId, queued: false }, persisted: "pending" },
  );
});

test("the asset sweep creates reconciliation work after a missed webhook", async () => {
  const asset = {
    _id: "507f191e810c19729de860ea",
    libraryId: "754739",
    providerGuid: "video-guid",
    technicalState: "processing",
  };
  const recorded = [];
  const queued = [];
  const runtime = createVideoProviderRuntime({
    provider: {},
    assets: { async listStuck() { return [asset]; } },
    operations: {
      async record(specification) {
        recorded.push(specification);
        return { _id: "507f1f77bcf86cd799439011" };
      },
    },
    enqueue: async (id) => { queued.push(id); },
    now: () => Date.parse("2026-09-23T00:10:00Z"),
  });

  const summary = await runtime.reconcileStuckAssets();

  assert.deepEqual(
    {
      summary,
      type: recorded[0]?.type,
      assetId: recorded[0]?.assetId,
      queued,
    },
    {
      summary: { found: 1, queued: 1 },
      type: "reconcile",
      assetId: asset._id,
      queued: ["507f1f77bcf86cd799439011"],
    },
  );
});

test("reconciliation uses Bunny state to advance a Video Asset", async () => {
  const operationId = "507f1f77bcf86cd799439011";
  const operation = {
    _id: operationId,
    type: "reconcile",
    assetId: "507f191e810c19729de860ea",
    providerGuid: "video-guid",
    libraryId: "754739",
    leaseToken: "lease-1",
  };
  const asset = { technicalState: "processing" };
  let completed = false;
  const runtime = createVideoProviderRuntime({
    provider: {
      async getVideo() {
        return {
          guid: "video-guid",
          status: 4,
          length: 64,
          width: 1080,
          height: 1920,
          availableResolutions: "360p,720p,1080p",
        };
      },
    },
    operations: {
      async claimById() { return operation; },
      async complete() { completed = true; return operation; },
      async fail() { throw new Error("should not retry a ready asset"); },
    },
    assets: {
      async applySnapshot({ snapshot }) {
        if (snapshot.status === 4) asset.technicalState = "ready";
      },
    },
  });

  const result = await runtime.process(operationId);

  assert.deepEqual(
    { result, assetState: asset.technicalState, completed },
    { result: { status: "completed" }, assetState: "ready", completed: true },
  );
});

test("a delayed provider observation cannot regress a ready Video Asset", async () => {
  const operationId = "507f1f77bcf86cd799439011";
  const asset = {
    _id: "507f191e810c19729de860ea",
    libraryId: "754739",
    providerGuid: "video-guid",
    technicalState: "ready",
  };
  const model = {
    async findOneAndUpdate(filter, update) {
      if (!filter.technicalState.$in.includes(asset.technicalState)) return null;
      Object.assign(asset, update.$set);
      return { ...asset };
    },
  };
  const operation = {
    _id: operationId,
    type: "reconcile",
    assetId: asset._id,
    libraryId: asset.libraryId,
    providerGuid: asset.providerGuid,
    leaseToken: "lease-1",
  };
  const runtime = createVideoProviderRuntime({
    provider: { async getVideo() { return { guid: "video-guid", status: 2 }; } },
    operations: {
      async claimById() { return operation; },
      async complete() { return operation; },
      async fail() { throw new Error("unexpected retry"); },
    },
    assets: createVideoAssetObserver({ model }),
  });

  const result = await runtime.process(operationId);

  assert.deepEqual(
    { result, assetState: asset.technicalState },
    { result: { status: "completed" }, assetState: "ready" },
  );
});

test("a playable Bunny video becomes ready only with verified media metadata", async () => {
  const operationId = "507f1f77bcf86cd799439011";
  const asset = {
    _id: "507f191e810c19729de860ea",
    libraryId: "754739",
    providerGuid: "video-guid",
    technicalState: "processing",
  };
  const model = {
    async findOneAndUpdate(filter, update) {
      if (!filter.technicalState.$in.includes(asset.technicalState)) return null;
      Object.assign(asset, update.$set);
      return { ...asset };
    },
  };
  const operation = {
    _id: operationId,
    type: "reconcile",
    assetId: asset._id,
    libraryId: asset.libraryId,
    providerGuid: asset.providerGuid,
    leaseToken: "lease-1",
  };
  const runtime = createVideoProviderRuntime({
    provider: {
      async getVideo() {
        return {
          guid: "video-guid",
          status: 4,
          length: 64,
          width: 1080,
          height: 1920,
          availableResolutions: "360p,720p",
        };
      },
    },
    operations: {
      async claimById() { return operation; },
      async complete() { return operation; },
      async fail() { throw new Error("unexpected retry"); },
    },
    assets: createVideoAssetObserver({ model }),
  });

  const result = await runtime.process(operationId);

  assert.deepEqual(
    {
      result,
      state: asset.technicalState,
      duration: asset.durationSeconds,
      dimensions: [asset.width, asset.height],
      resolutions: asset.availableResolutions,
    },
    {
      result: { status: "completed" },
      state: "ready",
      duration: 64,
      dimensions: [1080, 1920],
      resolutions: ["360p", "720p"],
    },
  );
});

test("Bunny processing failure leaves a Video Asset unavailable", async () => {
  const asset = {
    _id: "507f191e810c19729de860ea",
    libraryId: "754739",
    providerGuid: "video-guid",
    technicalState: "processing",
  };
  const model = {
    async findOneAndUpdate(filter, update) {
      if (!filter.technicalState.$in.includes(asset.technicalState)) return null;
      Object.assign(asset, update.$set);
      return { ...asset };
    },
  };
  const operation = {
    _id: "507f1f77bcf86cd799439011",
    type: "reconcile",
    assetId: asset._id,
    libraryId: asset.libraryId,
    providerGuid: asset.providerGuid,
    leaseToken: "lease-1",
  };
  const runtime = createVideoProviderRuntime({
    provider: { async getVideo() { return { guid: "video-guid", status: 5 }; } },
    operations: {
      async claimById() { return operation; },
      async complete() { return operation; },
      async fail() { throw new Error("unexpected retry"); },
    },
    assets: createVideoAssetObserver({ model }),
  });

  await runtime.process(operation._id);

  assert.deepEqual(
    { state: asset.technicalState, failure: asset.safeFailureCode },
    { state: "failed", failure: "BUNNY_TRANSCODE_FAILED" },
  );
});

test("Bunny management status 6 fails an unfinished Video Asset without regressing terminal assets", async () => {
  for (const technicalState of ["awaiting_upload", "processing", "ready", "failed", "deleting", "deleted"]) {
    const asset = {
      _id: "507f191e810c19729de860ea", libraryId: "754739",
      providerGuid: "video-guid", technicalState,
    };
    const operation = {
      _id: "507f1f77bcf86cd799439011", type: "reconcile", assetId: asset._id,
      libraryId: asset.libraryId, providerGuid: asset.providerGuid, leaseToken: "lease-1",
    };
    const runtime = createVideoProviderRuntime({
      provider: { async getVideo() { return { guid: "video-guid", status: 6 }; } },
      operations: {
        async claimById() { return operation; },
        async complete() { return operation; },
        async fail() { assert.fail("a terminal management snapshot must not retry"); },
      },
      assets: createVideoAssetObserver({ model: {
        async findOneAndUpdate(filter, update) {
          if (!filter.technicalState.$in.includes(asset.technicalState)) return null;
          Object.assign(asset, update.$set);
          return { ...asset };
        },
      } }),
    });

    assert.deepEqual(await runtime.process(operation._id), { status: "completed" });
    assert.deepEqual({ state: asset.technicalState, failure: asset.safeFailureCode },
      ["awaiting_upload", "processing"].includes(technicalState)
        ? { state: "failed", failure: "BUNNY_TRANSCODE_FAILED" }
        : { state: technicalState, failure: undefined }, technicalState);
  }
});

test("a video exceeding the ninety-second limit cannot become ready", async () => {
  const asset = {
    _id: "507f191e810c19729de860ea",
    libraryId: "754739",
    providerGuid: "video-guid",
    technicalState: "processing",
  };
  const model = {
    async findOneAndUpdate(filter, update) {
      if (!filter.technicalState.$in.includes(asset.technicalState)) return null;
      Object.assign(asset, update.$set);
      return { ...asset };
    },
  };
  const operation = {
    _id: "507f1f77bcf86cd799439011",
    type: "reconcile",
    assetId: asset._id,
    libraryId: asset.libraryId,
    providerGuid: asset.providerGuid,
    leaseToken: "lease-1",
  };
  const runtime = createVideoProviderRuntime({
    provider: {
      async getVideo() {
        return {
          guid: "video-guid", status: 4, length: 91,
          width: 1080, height: 1920, availableResolutions: "720p",
        };
      },
    },
    operations: {
      async claimById() { return operation; },
      async complete() { return operation; },
      async fail() { throw new Error("unexpected retry"); },
    },
    assets: createVideoAssetObserver({ model }),
  });

  await runtime.process(operation._id);

  assert.deepEqual(
    { state: asset.technicalState, failure: asset.safeFailureCode },
    { state: "failed", failure: "VIDEO_DURATION_EXCEEDED" },
  );
});

test("a persisted deletion intent lets the worker accept Bunny deletion", async () => {
  const { operation, operations } = pendingDeleteOperation();
  const asset = {
    _id: operation.assetId,
    libraryId: operation.libraryId,
    providerGuid: operation.providerGuid,
    technicalState: "deleting",
    deletionRequestedAt: new Date("2026-09-23T00:00:00Z"),
  };
  const model = {
    async findOne(filter) {
      if (
        filter._id === asset._id &&
        filter.libraryId === asset.libraryId &&
        filter.providerGuid === asset.providerGuid &&
        filter.deletionRequestedAt?.$exists &&
        asset.deletionRequestedAt
      ) return asset;
      return null;
    },
    async findOneAndUpdate(filter, update) {
      if (filter._id !== asset._id || !asset.deletionRequestedAt) return null;
      Object.assign(asset, update.$set);
      return { ...asset };
    },
  };
  const runtime = createVideoProviderRuntime({
    provider: { async deleteVideo() { return { accepted: true, status: 204 }; },
      async getVideo() { throw { status: 404 }; } },
    operations,
    assets: createVideoAssetObserver({ model }),
  });

  const result = await runtime.process(operation._id);

  assert.deepEqual(
    { result, assetState: asset.technicalState, operationStatus: operation.status },
    { result: { status: "completed" }, assetState: "deleted", operationStatus: "completed" },
  );
});

test("deletion verification completes when Bunny reports the resource absent", async () => {
  const { operation, operations } = pendingDeleteOperation("verify_deletion");
  const asset = { technicalState: "deleting" };
  const runtime = createVideoProviderRuntime({
    provider: {
      async getVideo() { throw { status: 404 }; },
      async deleteVideo() { throw new Error("verification must not issue a second delete"); },
    },
    operations,
    assets: {
      async getDeletionTarget() { return {}; },
      async markDeleteAccepted() { asset.technicalState = "deleted"; },
    },
  });

  const result = await runtime.process(operation._id);

  assert.deepEqual(
    { result, operationStatus: operation.status, assetState: asset.technicalState },
    { result: { status: "completed" }, operationStatus: "completed", assetState: "deleted" },
  );
});

test("abandoned-upload cleanup uses the same authorized idempotent deletion path", async () => {
  const { operation, operations } = pendingDeleteOperation("abandoned_upload_cleanup");
  let deleteCalls = 0;
  let marked = false;
  const runtime = createVideoProviderRuntime({
    provider: { async deleteVideo() { deleteCalls += 1; return { accepted: true, status: 204 }; },
      async getVideo() { throw { status: 404 }; } },
    operations,
    assets: {
      async getDeletionTarget() { return {}; },
      async markDeleteAccepted() { marked = true; },
    },
  });

  assert.deepEqual(await runtime.process(operation._id), { status: "completed" });
  assert.equal(deleteCalls, 1);
  assert.equal(marked, true);
});

test("deletion verification retries if Bunny still has the resource", async () => {
  const { operation, operations } = pendingDeleteOperation("verify_deletion");
  let failureCode;
  const runtime = createVideoProviderRuntime({
    provider: { async getVideo() { return { guid: operation.providerGuid }; } },
    operations: {
      ...operations,
      async fail({ errorCode }) { failureCode = errorCode; return operations.fail(); },
    },
    assets: {
      async getDeletionTarget() { return {}; },
      async markDeleteAccepted() { throw new Error("resource still exists"); },
    },
  });

  assert.deepEqual(await runtime.process(operation._id), { status: "retryable" });
  assert.equal(failureCode, "VIDEO_PROVIDER_STILL_PRESENT");
});

for (const outcome of [404, 400, 401, 403, 429, 500]) {
  test(`Bunny delete ${outcome} follows the accepted deletion matrix`, async () => {
    const { operation, operations } = pendingDeleteOperation();
    let removed = false;
    let failureCode;
    const runtime = createVideoProviderRuntime({
      provider: { async deleteVideo() { throw { status: outcome }; },
        async getVideo() { throw { status: 404 }; } },
      operations: {
        ...operations,
        async fail({ errorCode }) { failureCode = errorCode; return operations.fail(); },
      },
      assets: {
      async getDeletionTarget() { return {}; },
        async markDeleteAccepted() { removed = true; },
      },
    });

    const result = await runtime.process(operation._id);
    assert.deepEqual(result, { status: outcome === 404 ? "completed" : "retryable" });
    assert.equal(removed, outcome === 404);
    if (outcome !== 404) assert.equal(typeof failureCode, "string");
  });
}

test("an uncertain deletion preserves local media when Bunny GET confirms it exists", async () => {
  const { operation, operations } = pendingDeleteOperation();
  let removed = false;
  const runtime = createVideoProviderRuntime({
    provider: {
      async deleteVideo() { throw { code: "BUNNY_STREAM_TIMEOUT" }; },
      async getVideo() { return { guid: operation.providerGuid }; },
    },
    operations,
    assets: {
      async getDeletionTarget() { return {}; },
      async markDeleteAccepted() { removed = true; },
    },
  });

  assert.deepEqual(await runtime.process(operation._id), { status: "retryable" });
  assert.equal(removed, false);
});

test("stuck-asset observer selects only aged awaiting or processing assets", async () => {
  const calls = [];
  const assets = createVideoAssetObserver({
    model: {
      find(filter) {
        calls.push(filter);
        return {
          sort() { return this; },
          limit() { return this; },
          lean: async () => [{ _id: "asset-1" }],
        };
      },
    },
  });
  const before = new Date("2026-09-23T00:05:00Z");

  assert.deepEqual(await assets.listStuck({ before, limit: 10 }), [{ _id: "asset-1" }]);
  assert.deepEqual(calls[0], {
    technicalState: { $in: ["awaiting_upload", "processing"] },
    updatedAt: { $lte: before },
  });
});
