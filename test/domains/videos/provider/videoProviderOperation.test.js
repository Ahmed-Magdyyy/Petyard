import assert from "node:assert/strict";
import test from "node:test";
import {
  recordVideoProviderOperation,
  claimVideoProviderOperationById,
  completeVideoProviderOperation,
  failVideoProviderOperation,
  listDueVideoProviderOperationIds,
  retryVideoProviderOperationNow,
  recordVideoProviderEnqueueFailure,
} from "../../../../src/domains/videos/provider/videoProviderOperation.service.js";

const START = new Date("2026-09-23T00:00:00.000Z");
const GUID = "11111111-1111-4111-8111-111111111111";

function matches(operation, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    if (key === "$or") return condition.some((branch) => matches(operation, branch));
    const value = operation[key];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("$in" in condition && !condition.$in.includes(value)) return false;
      if ("$lte" in condition && !(value <= condition.$lte)) return false;
      if ("$gt" in condition && !(value > condition.$gt)) return false;
      return true;
    }
    return String(value) === String(condition);
  });
}

function fakeOperations() {
  const rows = new Map();
  const clone = (value) => value == null ? null : structuredClone(value);
  const model = {
    async findOneAndUpdate(filter, update, options = {}) {
      let operation = [...rows.values()].find((row) => matches(row, filter));
      if (!operation && options.upsert) {
        operation = { _id: `operation-${rows.size + 1}`, ...update.$setOnInsert };
        rows.set(operation._id, operation);
      } else if (operation) {
        const proposedKey = update.$set?.activeTargetKey;
        if (proposedKey && [...rows.values()].some(
          (other) => other._id !== operation._id && other.activeTargetKey === proposedKey,
        )) {
          const error = new Error("duplicate active target");
          error.code = 11000;
          throw error;
        }
        Object.assign(operation, update.$set);
        for (const key of Object.keys(update.$unset ?? {})) delete operation[key];
      }
      return clone(operation);
    },
    async findOne(filter) {
      return clone([...rows.values()].find((row) => matches(row, filter)));
    },
    async findById(id) {
      return clone(rows.get(id));
    },
    find(filter) {
      let found = [...rows.values()].filter((row) => matches(row, filter));
      const query = {
        sort() { found.sort((a, b) => a.nextAttemptAt - b.nextAttemptAt); return query; },
        limit(count) { found = found.slice(0, count); return query; },
        select() { return query; },
        async lean() { return clone(found); },
      };
      return query;
    },
  };
  return { model, rows };
}

async function record(model, dedupeKey = "webhook:event-1", providerGuid = GUID) {
  return recordVideoProviderOperation({
    type: "reconcile",
    assetId: "asset-1",
    libraryId: "754739",
    providerGuid,
    dedupeKey,
    now: START,
    model,
  });
}

test("recording the same provider obligation returns one durable operation", async () => {
  const { model, rows } = fakeOperations();
  const first = await record(model);
  const second = await record(model);
  assert.equal(first._id, second._id);
  assert.equal(rows.size, 1);
  assert.equal(first.status, "pending");
});

test("a dedupe key cannot be reused for another provider target", async () => {
  const { model } = fakeOperations();
  await record(model);
  await assert.rejects(
    record(model, "webhook:event-1", "22222222-2222-4222-8222-222222222222"),
    { message: "VIDEO_PROVIDER_OPERATION_DEDUPE_CONFLICT" },
  );
});

test("one GUID has one active claim and a stale lease cannot complete it", async () => {
  const { model } = fakeOperations();
  const first = await record(model);
  const second = await record(model, "webhook:event-2");
  const lease = await claimVideoProviderOperationById({ operationId: first._id, now: START, model });
  assert.equal(lease.status, "running");
  assert.equal(await claimVideoProviderOperationById({ operationId: first._id, now: START, model }), null);
  assert.equal(await claimVideoProviderOperationById({ operationId: second._id, now: START, model }), null);
  assert.equal(await completeVideoProviderOperation({ operationId: first._id, leaseToken: "stale", now: START, model }), null);
  const done = await completeVideoProviderOperation({ operationId: first._id, leaseToken: lease.leaseToken, now: START, model });
  assert.equal(done.status, "completed");
  assert.equal(done.purgeAt.toISOString(), "2026-12-22T00:00:00.000Z");
  assert.equal(done.activeTargetKey, undefined);
  assert.equal((await claimVideoProviderOperationById({ operationId: second._id, now: START, model })).status, "running");
});

test("an expired lease can be reclaimed and its former token loses fencing", async () => {
  const { model } = fakeOperations();
  const operation = await record(model);
  const oldLease = await claimVideoProviderOperationById({ operationId: operation._id, now: START, leaseMs: 1000, model });
  const later = new Date(START.getTime() + 1000);
  const newLease = await claimVideoProviderOperationById({ operationId: operation._id, now: later, model });
  assert.notEqual(newLease.leaseToken, oldLease.leaseToken);
  assert.equal(await completeVideoProviderOperation({ operationId: operation._id, leaseToken: oldLease.leaseToken, now: later, model }), null);
  assert.equal((await completeVideoProviderOperation({ operationId: operation._id, leaseToken: newLease.leaseToken, now: later, model })).status, "completed");
});

test("failures back off and the tenth failure continues daily with attention required", async () => {
  const { model } = fakeOperations();
  const operation = await record(model);
  let now = START;
  for (let count = 1; count <= 10; count += 1) {
    const lease = await claimVideoProviderOperationById({ operationId: operation._id, now, model });
    const failed = await failVideoProviderOperation({
      operationId: operation._id, leaseToken: lease.leaseToken,
      errorCode: "BUNNY_TIMEOUT", now, random: () => 0.5, model,
    });
    assert.equal(failed.failedAttempts, count);
    assert.equal(failed.status, count < 10 ? "pending" : "needs_attention");
    if (count === 1) assert.equal(failed.nextAttemptAt.getTime() - now.getTime(), 60_000);
    if (count === 10) assert.equal(failed.nextAttemptAt.getTime() - now.getTime(), 24 * 60 * 60 * 1000);
    now = failed.nextAttemptAt;
  }
  assert.deepEqual(await listDueVideoProviderOperationIds({ now, model }), [operation._id]);
});

test("due scan includes expired leases and admin retry makes attention work due now", async () => {
  const { model, rows } = fakeOperations();
  const expired = await record(model);
  const pending = await record(model, "webhook:event-2", "22222222-2222-4222-8222-222222222222");
  const lease = await claimVideoProviderOperationById({ operationId: expired._id, now: START, leaseMs: 1000, model });
  const later = new Date(START.getTime() + 1000);
  assert.deepEqual(await listDueVideoProviderOperationIds({ now: later, model }), [expired._id, pending._id]);
  assert.equal(await failVideoProviderOperation({ operationId: expired._id, leaseToken: lease.leaseToken, now: later, model }), null);
  Object.assign(rows.get(expired._id), {
    status: "needs_attention",
    nextAttemptAt: new Date("2026-09-24T00:00:00.000Z"),
    activeTargetKey: undefined,
  });
  const retried = await retryVideoProviderOperationNow({ operationId: expired._id, now: later, model });
  assert.equal(retried.status, "pending");
  assert.equal(retried.nextAttemptAt.toISOString(), later.toISOString());
});

test("enqueue and provider failures retain only safe codes in separate fields", async () => {
  const { model } = fakeOperations();
  const operation = await record(model);
  const enqueued = await recordVideoProviderEnqueueFailure({
    operationId: operation._id, errorCode: "redis://private:secret@example", now: START, model,
  });
  assert.equal(enqueued.lastEnqueueErrorCode, "PROVIDER_ERROR");
  const lease = await claimVideoProviderOperationById({ operationId: operation._id, now: START, model });
  const failed = await failVideoProviderOperation({
    operationId: operation._id, leaseToken: lease.leaseToken,
    errorCode: "response body secret", now: START, random: () => 0.5, model,
  });
  assert.equal(failed.lastErrorCode, "PROVIDER_ERROR");
  assert.equal(failed.lastEnqueueErrorCode, "PROVIDER_ERROR");
});

test("image-only cleanup shares leases and deduplication without a fake Stream identity", async () => {
  const { model } = fakeOperations();
  const coverId = "507f1f77bcf86cd799439011";
  const spec = { type: "cover_cleanup", coverId, dedupeKey: "cover-cleanup:one", now: START, model };
  const first = await recordVideoProviderOperation(spec);
  assert.equal((await recordVideoProviderOperation(spec))._id, first._id);
  const second = await recordVideoProviderOperation({ ...spec, dedupeKey: "cover-cleanup:two" });
  const claimed = await claimVideoProviderOperationById({ operationId: first._id, now: START, model });
  assert.equal(claimed.activeTargetKey, `cover:${coverId}`);
  assert.equal(claimed.providerGuid, undefined);
  assert.equal(await claimVideoProviderOperationById({ operationId: second._id, now: START, model }), null);
  await assert.rejects(recordVideoProviderOperation({ ...spec, coverId: "507f1f77bcf86cd799439012" }), /DEDUPE_CONFLICT/);
  for (const mixed of [{ providerGuid: GUID }, { libraryId: "754739" }, { assetId: "asset-1" }]) {
    await assert.rejects(recordVideoProviderOperation({ ...spec, ...mixed }), TypeError);
  }
  await assert.rejects(recordVideoProviderOperation({ ...spec, type: "delete", assetId: "asset-1", libraryId: "754739", providerGuid: GUID }), TypeError);
});
