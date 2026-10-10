import assert from "node:assert/strict";
import test from "node:test";
import { createBunnyStreamAdapter } from "../../../../src/domains/videos/provider/bunnyStreamAdapter.js";
import { createVideoAssetObserver } from "../../../../src/domains/videos/provider/videoAsset.service.js";
import { createVideoProviderRuntime } from "../../../../src/domains/videos/provider/videoProviderRuntime.js";
import { recordVideoProviderOperation, claimVideoProviderOperationById, completeVideoProviderOperation,
  failVideoProviderOperation, listDueVideoProviderOperationIds }
  from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";

const assetId = "507f1f77bcf86cd799439011";
const uploadUrl = "https://video.bunnycdn.com/tusupload/upload-a";
const managementUrl = "https://video.bunnycdn.com/library/754739/videos/video-a";
const fixedNow = Date.parse("2026-10-08T09:00:00Z");

async function fixture({ assetChanges = {}, type = "abandoned_upload_cleanup" } = {}) {
  const control = { now: fixedNow, requests: [], tusStatus: 204, deleteStatus: 204,
    present: false, getStatus: null, accepted: [], tusError: null, deleteError: null,
    tusProtocol: "1.0.0", afterTus: null, acceptanceError: null, persistenceError: null };
  const db = replacementDatabase({ assets: [{ _id: assetId, ownerType: "product_video",
    ownerId: "507f1f77bcf86cd799439012", libraryId: "754739", providerGuid: "video-a",
    technicalState: "deleting", deletionRequestedAt: new Date(fixedNow - 1000),
    tusUploadUrl: uploadUrl, tusResourceExpiresAt: Math.floor(fixedNow / 1000) - 60,
    ...assetChanges }] });
  const updateAsset = db.assets.findOneAndUpdate.bind(db.assets);
  db.assets.findOneAndUpdate = (...args) => {
    if (control.persistenceError) throw control.persistenceError;
    return updateAsset(...args);
  };
  const provider = createBunnyStreamAdapter({ libraryId: "754739", apiKey: "fake-key",
    requestTimeoutMs: 1000, now: () => control.now,
    http: async (url, options) => {
      control.requests.push(`${options.method} ${url}`);
      if (url === uploadUrl && options.method === "DELETE") {
        if (control.tusError) throw control.tusError;
        await control.afterTus?.();
        return new Response(null, { status: control.tusStatus,
          headers: control.tusProtocol ? { "Tus-Resumable": control.tusProtocol } : {} });
      }
      assert.equal(url, managementUrl);
      if (options.method === "DELETE") {
        if (control.deleteError) throw control.deleteError;
        return new Response(null, { status: control.deleteStatus });
      }
      assert.equal(options.method, "GET");
      const status = control.getStatus ?? (control.present ? 200 : 404);
      return new Response(status === 200 ? JSON.stringify({ guid: "video-a", status: 0 }) : null, { status });
    },
  });
  const operation = await recordVideoProviderOperation({ type, assetId,
    libraryId: "754739", providerGuid: "video-a", dedupeKey: `cleanup:${assetId}`,
    now: new Date(control.now), model: db.operations });
  const runtime = () => createVideoProviderRuntime({ provider,
    assets: createVideoAssetObserver({ model: db.assets, now: () => control.now,
      onDeleted: asset => {
        if (control.acceptanceError) throw control.acceptanceError;
        control.accepted.push(String(asset._id));
      } }),
    operations: {
      claimById: input => claimVideoProviderOperationById({ ...input, model: db.operations }),
      complete: input => completeVideoProviderOperation({ ...input, now: new Date(control.now), model: db.operations }),
      fail: input => failVideoProviderOperation({ ...input, now: new Date(control.now), random: () => 0, model: db.operations }),
    }, now: () => control.now,
  });
  const dueIds = () => listDueVideoProviderOperationIds({ now: new Date(control.now + 60_000), model: db.operations });
  return { control, operationId: String(operation._id), runtime, dueIds };
}

test("cleanup terminates the persisted TUS resource before video deletion and GET absence confirmation", async () => {
  const { control, operationId, runtime, dueIds } = await fixture();
  assert.deepEqual(await runtime().process(operationId), { status: "completed" });
  assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`, `DELETE ${managementUrl}`, `GET ${managementUrl}`]);
  assert.deepEqual(control.accepted, [assetId]);
  assert.deepEqual(await dueIds(), []);
});

test("accepted deletion removes local media but survives restart until Bunny confirms absence", async () => {
  const { control, operationId, runtime, dueIds } = await fixture();
  control.present = true;
  assert.deepEqual(await runtime().process(operationId), { status: "retryable" });
  assert.deepEqual(control.accepted, [assetId]);
  assert.deepEqual(await dueIds(), [operationId]);

  control.now += 60_000;
  control.present = false;
  assert.deepEqual(await runtime().process(operationId), { status: "completed" });
  assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`, `DELETE ${managementUrl}`,
    `GET ${managementUrl}`, `GET ${managementUrl}`]);
  assert.deepEqual(await dueIds(), []);
});

test("rejected TUS termination cannot authorize video deletion or local removal", async () => {
  for (const status of [400, 401, 403, 409, 429, 500]) {
    const { control, operationId, runtime, dueIds } = await fixture();
    control.tusStatus = status;
    assert.deepEqual(await runtime().process(operationId), { status: "retryable" }, String(status));
    assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`]);
    assert.deepEqual(control.accepted, []);
    assert.deepEqual(await dueIds(), [operationId]);
  }
});

test("an absent TUS session does not mean the management video is absent", async () => {
  const { control, operationId, runtime } = await fixture();
  control.tusStatus = 404;
  control.present = true;
  assert.deepEqual(await runtime().process(operationId), { status: "retryable" });
  assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`, `DELETE ${managementUrl}`, `GET ${managementUrl}`]);
  assert.deepEqual(control.accepted, [assetId]);
});

test("uncertain TUS termination remains due even if management currently reports absence", async () => {
  const { control, operationId, runtime, dueIds } = await fixture();
  control.tusError = Object.assign(new Error("timeout"), { name: "AbortError" });
  assert.deepEqual(await runtime().process(operationId), { status: "retryable" });
  assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`]);
  assert.deepEqual(control.accepted, []);
  assert.deepEqual(await dueIds(), [operationId]);
  control.now += 60_000;
  control.tusError = null;
  assert.deepEqual(await runtime().process(operationId), { status: "completed" });
});

test("management DELETE 404 alone cannot remove local media while GET still returns the video", async () => {
  const { control, operationId, runtime, dueIds } = await fixture();
  control.deleteStatus = 404;
  control.present = true;
  assert.deepEqual(await runtime().process(operationId), { status: "retryable" });
  assert.deepEqual(control.accepted, []);
  assert.deepEqual(await dueIds(), [operationId]);
});

test("verification errors keep an accepted deletion durable without repeating destructive requests", async () => {
  for (const status of [401, 403, 429, 500]) {
    const { control, operationId, runtime, dueIds } = await fixture();
    control.getStatus = status;
    assert.deepEqual(await runtime().process(operationId), { status: "retryable" });
    assert.deepEqual(control.accepted, [assetId]);
    assert.deepEqual(await dueIds(), [operationId]);
    control.now += 60_000;
    control.getStatus = 404;
    assert.deepEqual(await runtime().process(operationId), { status: "completed" });
    assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`, `DELETE ${managementUrl}`,
      `GET ${managementUrl}`, `GET ${managementUrl}`]);
  }
});

test("stale, wrong-library and wrong-GUID deletion targets cause no provider requests", async () => {
  for (const assetChanges of [{ deletionRequestedAt: undefined }, { libraryId: "999" }, { providerGuid: "other-video" }]) {
    const { control, operationId, runtime, dueIds } = await fixture({ assetChanges });
    assert.deepEqual(await runtime().process(operationId), { status: "retryable" });
    assert.deepEqual(control.requests, []);
    assert.deepEqual(control.accepted, []);
    assert.deepEqual(await dueIds(), [operationId]);
  }
});

test("absence verification remains read-only even when a trusted TUS URL is recorded", async () => {
  const { control, operationId, runtime } = await fixture({ type: "verify_deletion" });
  assert.deepEqual(await runtime().process(operationId), { status: "completed" });
  assert.deepEqual(control.requests, [`GET ${managementUrl}`]);
});

test("malformed TUS success cannot authorize management deletion or local removal", async () => {
  for (const tusProtocol of [null, "0.2.2"]) {
    const { control, operationId, runtime, dueIds } = await fixture();
    control.tusProtocol = tusProtocol;
    assert.deepEqual(await runtime().process(operationId), { status: "retryable" });
    assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`]);
    assert.deepEqual(control.accepted, []);
    assert.deepEqual(await dueIds(), [operationId]);
  }
});

test("uncertain management deletion is settled only by GET absence after established TUS termination", async () => {
  for (const present of [true, false]) {
    const { control, operationId, runtime, dueIds } = await fixture();
    control.present = present;
    control.deleteError = Object.assign(new Error("timeout"), { name: "AbortError" });
    assert.deepEqual(await runtime().process(operationId), { status: present ? "retryable" : "completed" });
    assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`, `DELETE ${managementUrl}`, `GET ${managementUrl}`]);
    assert.deepEqual(control.accepted, present ? [] : [assetId]);
    assert.deepEqual(await dueIds(), present ? [operationId] : []);
  }
});

test("acceptance persistence or callback failure leaves cleanup recoverable after lease expiry", async () => {
  for (const fault of ["persistenceError", "acceptanceError"]) {
    const { control, operationId, runtime, dueIds } = await fixture();
    control[fault] = new Error("database unavailable");
    await assert.rejects(runtime().process(operationId), /database unavailable/);
    control.now += 300_001;
    assert.deepEqual(await dueIds(), [operationId]);
    control[fault] = null;
    assert.deepEqual(await runtime().process(operationId), { status: "completed" });
    assert.deepEqual(await dueIds(), []);
    if (fault === "acceptanceError") {
      assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`, `DELETE ${managementUrl}`, `GET ${managementUrl}`]);
    }
  }
});

test("expired cleanup lease cannot close the obligation and restart verifies persisted acceptance", async () => {
  const { control, operationId, runtime, dueIds } = await fixture();
  control.afterTus = () => { control.now += 300_001; };
  assert.deepEqual(await runtime().process(operationId), { status: "stale" });
  assert.deepEqual(await dueIds(), [operationId]);
  assert.deepEqual(await runtime().process(operationId), { status: "completed" });
  assert.deepEqual(control.requests, [`DELETE ${uploadUrl}`, `DELETE ${managementUrl}`,
    `GET ${managementUrl}`, `GET ${managementUrl}`]);
});
