import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { createVideoProviderAdminRouter } from "../../../../src/domains/videos/provider/videoProviderAdmin.routes.js";
import { UserModel } from "../../../../src/domains/user/user.model.js";
import { globalError } from "../../../../src/shared/middlewares/errorMiddleware.js";
import { createVideoProviderAdminService } from "../../../../src/domains/videos/provider/videoProviderAdmin.service.js";
import { createVideoProviderOperationRepository } from "../../../../src/domains/videos/provider/videoProviderOperation.repository.js";
import { replacementDatabase } from "../productVideos/fixtures/replacementDatabase.js";
import { roles } from "../../../../src/shared/constants/enums.js";

const NOW = new Date("2026-10-02T10:00:00Z");
const actor = { id: "507f1f77bcf86cd799439099", role: roles.SUPER_ADMIN };
const id = "507f1f77bcf86cd799439011";
function operation(changes = {}) {
  return { _id: id, type: "delete", status: "needs_attention", failedAttempts: 10,
    nextAttemptAt: new Date("2026-10-03T10:00:00Z"), createdAt: NOW, updatedAt: NOW,
    lastErrorCode: "PROVIDER_UNAVAILABLE", lastErrorAt: NOW,
    leaseExpiresAt: new Date("2026-10-02T10:05:00Z"),
    assetId: "507f1f77bcf86cd799439022", libraryId: "754739", providerGuid: "private-guid",
    dedupeKey: "private-marker", leaseToken: "private-lease", activeTargetKey: "private-target",
    unexpectedSecret: "private-secret", ...changes };
}
function fixture({ operations = [operation()], model, enqueue } = {}) {
  const db = replacementDatabase({ operations });
  const queued = [];
  const service = createVideoProviderAdminService({
    repository: createVideoProviderOperationRepository({ model: model ?? db.operations }),
    enqueue: enqueue ?? (async operationId => { queued.push(operationId); }), now: () => NOW });
  return { service, queued };
}

async function withHttp(service, work) {
  const previousKey = process.env.JWT_ACCESS_SECRET;
  const previousRead = UserModel.collection.findOne;
  process.env.JWT_ACCESS_SECRET = "synthetic-provider-admin-test-key";
  // Fake only the external Mongo driver read: protect, JWT verification,
  // account checks and role middleware still execute normally.
  const users = Object.values(roles).map((role, index) => ({ _id: String(index + 1).padStart(24, "0"),
    role, active: true, phoneVerified: true, enabledControls: [] }));
  UserModel.collection.findOne = async filter => users.find(user => user._id === String(filter._id)) ?? null;
  const tokens = Object.fromEntries(users.map(user => [user.role,
    jwt.sign({ userId: user._id }, process.env.JWT_ACCESS_SECRET, { expiresIn: "5m" })]));
  const app = express();
  app.use(express.json());
  app.use("/api/v1/videos/admin/provider-operations", createVideoProviderAdminRouter({ getService: () => service }));
  app.use(globalError);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try { await work(`http://127.0.0.1:${server.address().port}/api/v1/videos/admin/provider-operations`, tokens); }
  finally {
    await new Promise(resolve => server.close(resolve));
    UserModel.collection.findOne = previousRead;
    if (previousKey === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previousKey;
  }
}

test("super admins can monitor filtered provider work without exposing private operation fields", async () => {
  const { service } = fixture({ operations: [operation(), operation({ _id: "507f1f77bcf86cd799439012" }),
    operation({ _id: "507f1f77bcf86cd799439013", status: "completed" })] });
  const result = await service.list({ actor, query: { status: "needs_attention", type: "delete", limit: "1" } });
  assert.equal(result.totalResults, 2);
  assert.equal(result.totalPages, 2);
  assert.equal(result.page, 1);
  assert.equal(result.results, 1);
  assert.equal(result.data[0].id, "507f1f77bcf86cd799439012");
  assert.equal(result.data[0].failedAttempts, 10);
  assert.equal(result.data[0].lastErrorCode, "PROVIDER_UNAVAILABLE");
  assert.equal(result.data[0].leaseExpiresAt.toISOString(), "2026-10-02T10:05:00.000Z");
  assert.deepEqual(Object.keys(result.data[0]).sort(), ["id", "type", "status", "failedAttempts",
    "createdAt", "updatedAt", "nextAttemptAt", "leaseExpiresAt", "completedAt", "lastErrorAt",
    "lastEnqueueErrorAt", "lastErrorCode", "lastEnqueueErrorCode"].sort());
  assert.equal(JSON.stringify(result).includes("private-"), false);
  const second = await service.list({ actor, query: { status: "needs_attention", type: "delete", limit: 1, page: 2 } });
  assert.equal(second.data[0].id, id);
});

test("immediate retry remains due after Redis failure and preserves provider failure history", async () => {
  const { service } = fixture({ enqueue: async () => { throw new Error("private-redis-password"); } });
  const retried = await service.retry({ actor, operationId: id });
  assert.equal(retried.queued, false);
  assert.equal(retried.operation.id, id);
  assert.equal(retried.operation.status, "pending");
  assert.equal(retried.operation.failedAttempts, 10);
  assert.equal(retried.operation.nextAttemptAt.toISOString(), "2026-10-02T10:00:00.000Z");
  assert.equal(retried.operation.lastErrorCode, "PROVIDER_UNAVAILABLE");
  const pending = await service.list({ actor, query: { status: "pending" } });
  assert.equal(pending.data[0].id, id);
  assert.equal(pending.data[0].lastEnqueueErrorCode, "QUEUE_ERROR");
  assert.equal(JSON.stringify(pending).includes("private-"), false);
});

test("the protected HTTP endpoints require a real authenticated super admin and return safe monitoring and retry responses", async () => {
  const { service, queued } = fixture();
  await withHttp(service, async (base, tokens) => {
    const request = (path = "", token, body) => fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const token of [undefined, "invalid-token"]) {
      assert.equal((await request("", token)).status, 401);
      assert.equal((await request(`/${id}/retry`, token, {})).status, 401);
    }
    for (const role of [roles.ADMIN, roles.MODERATOR, roles.USER]) {
      assert.equal((await request("", tokens[role])).status, 403);
      assert.equal((await request(`/${id}/retry`, tokens[role], {})).status, 403);
    }
    const listed = await request("?status=needs_attention", tokens[roles.SUPER_ADMIN]);
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "private, no-store");
    assert.equal((await listed.json()).data.data[0].id, id);
    const retried = await request(`/${id}/retry`, tokens[roles.SUPER_ADMIN], {});
    assert.equal(retried.status, 202);
    assert.equal(retried.headers.get("cache-control"), "private, no-store");
    const result = await retried.json();
    assert.equal(result.data.operation.status, "pending");
    assert.equal(result.data.queued, true);
    assert.equal(JSON.stringify(result).includes("private-"), false);
    assert.deepEqual(queued, [id]);
  });
});

test("direct service callers cannot bypass super-admin authority or input validation", async () => {
  const { service } = fixture({ model: {
    find() { assert.fail("invalid requests must not read MongoDB"); },
    countDocuments() { assert.fail("invalid requests must not read MongoDB"); },
    findOneAndUpdate() { assert.fail("invalid requests must not change MongoDB"); },
  } });
  for (const other of [undefined, { role: roles.SUPER_ADMIN }, { ...actor, role: roles.ADMIN },
    { ...actor, role: roles.MODERATOR }, { ...actor, role: roles.USER }]) {
    await assert.rejects(service.list({ actor: other }), error => error.statusCode === 403);
    await assert.rejects(service.retry({ actor: other, operationId: id }), error => error.statusCode === 403);
  }
  for (const query of [null, [], { secret: true }, { page: 0 }, { page: 1.5 }, { limit: 101 },
    { limit: false }, { limit: ["1"] }, { page: {} }, { status: "unknown" },
    { status: ["pending"] }, { type: "unknown" }, { type: { $ne: "delete" } }]) {
    await assert.rejects(service.list({ actor, query }), error => error.statusCode === 422);
  }
  for (const [operationId, input] of [["invalid", {}], [null, {}], [id, []], [id, null],
    [id, { status: "completed" }], [id, { failedAttempts: 0 }]]) {
    await assert.rejects(service.retry({ actor, operationId, input }), error => error.statusCode === 422);
  }
});

test("missing, pending, running and completed operations cannot be forced through immediate retry", async () => {
  for (const status of ["pending", "running", "completed"]) {
    const { service, queued } = fixture({ operations: [operation({ status })] });
    await assert.rejects(service.retry({ actor, operationId: id }),
      error => error.statusCode === 409 && error.errors[0].code === "VIDEO_OPERATION_STATE_CONFLICT");
    assert.equal((await service.list({ actor })).data[0].status, status);
    assert.deepEqual(queued, []);
  }
  const { service, queued } = fixture({ operations: [] });
  await assert.rejects(service.retry({ actor, operationId: id }),
    error => error.statusCode === 404 && error.errors[0].code === "VIDEO_OPERATION_NOT_FOUND");
  assert.deepEqual(queued, []);
});

test("concurrent immediate retries allow one transition and enqueue only the winning operation", async () => {
  const { service, queued } = fixture();
  const results = await Promise.allSettled([service.retry({ actor, operationId: id }),
    service.retry({ actor, operationId: id.toUpperCase() })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.statusCode, 409);
  assert.deepEqual(queued, [id]);
  assert.equal((await service.list({ actor })).data[0].failedAttempts, 10);
});

test("database failures stay sanitized and cannot enqueue uncommitted retries", async () => {
  const { service, queued } = fixture({ model: {
    countDocuments() { throw new Error("private-mongo-connection-string"); },
    findOneAndUpdate() { throw new Error("private-mongo-connection-string"); },
  } });
  for (const request of [() => service.list({ actor }), () => service.retry({ actor, operationId: id })]) {
    await assert.rejects(request(), error => error.statusCode === 503 &&
      error.errors[0].code === "VIDEO_OPERATION_UNAVAILABLE" && !error.message.includes("private-"));
  }
  assert.deepEqual(queued, []);
});

test("empty monitoring and malformed stored error codes retain the safe response contract", async () => {
  const empty = await fixture({ operations: [] }).service.list({ actor });
  assert.deepEqual(empty, { totalResults: 0, totalPages: 1, page: 1, results: 0, data: [] });
  const { service } = fixture({ operations: [operation({ type: "cover_cleanup", lastErrorCode: "private-key value",
    lastEnqueueErrorCode: "http://private-redis", nextAttemptAt: undefined })] });
  const result = await service.list({ actor, query: { type: "cover_cleanup" } });
  assert.equal(result.data[0].lastErrorCode, "PROVIDER_ERROR");
  assert.equal(result.data[0].lastEnqueueErrorCode, "PROVIDER_ERROR");
  assert.equal(result.data[0].nextAttemptAt, null);
  assert.equal(JSON.stringify(result).includes("private-"), false);
});

test("HTTP validates filters and retry fields, and acknowledges a durable retry when Redis is unavailable", async () => {
  const { service } = fixture({ enqueue: async () => { throw new Error("private-redis-password"); } });
  await withHttp(service, async (base, tokens) => {
    const headers = { "content-type": "application/json", authorization: `Bearer ${tokens[roles.SUPER_ADMIN]}` };
    for (const query of ["?status=unknown", "?type=unknown", "?limit=101", "?page=0", "?extra=1", "?status=pending&status=completed"]) {
      assert.equal((await fetch(base + query, { headers })).status, 422);
    }
    const retry = (target, body) => fetch(`${base}/${target}/retry`, {
      method: "POST", headers, body: JSON.stringify(body) });
    assert.equal((await retry("invalid", {})).status, 422);
    assert.equal((await retry(id, { force: true })).status, 422);
    assert.equal((await retry(id, [])).status, 422);
    const response = await retry(id, {});
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.data.queued, false);
    assert.equal(result.data.operation.status, "pending");
    assert.equal(JSON.stringify(result).includes("private-"), false);
    assert.equal((await retry(id, {})).status, 409);
    assert.equal((await retry("507f1f77bcf86cd799439088", {})).status, 404);
    const due = await fetch(base + "?status=pending", { headers });
    assert.equal((await due.json()).data.data[0].id, id);
  });
});
