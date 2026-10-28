import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { assistantBody, assistantAwareApiLimit } from "../../../src/domains/assistant/assistant.body.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { egyptTimezoneReplacer } from "../../../src/shared/utils/egyptTimezone.js";
import { referenceMemory, referenceTestConfig, referenceActor } from "./fixtures/referenceMemory.js";
import { createReferenceService } from "../../../src/domains/assistant/references/assistant.reference-service.js";

async function appFor(t) {
  const memory = referenceMemory(), actor = referenceActor();
  const oldSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "fictional-reference-test-key";
  t.after(() => { if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = oldSecret; });
  const state = { ...memory, config: referenceTestConfig(), user: { ...actor, active: true, account_status: "confirmed" } };
  t.mock.method(UserModel, "findById", async () => state.user);
  const app = express(); app.set("json replacer", egyptTimezoneReplacer); app.use("/api/v1/assistant", ...assistantBody);
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => ({ enabled: false }),
    getReferenceConfig: () => state.config, referenceApplication: memory.application }));
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  state.url = `http://127.0.0.1:${server.address().port}/api/v1/assistant/admin/references`;
  state.headers = { Authorization: `Bearer ${jwt.sign({ userId: String(actor._id) }, process.env.JWT_ACCESS_SECRET)}` };
  return state;
}
function form(extra = {}) {
  const body = new FormData(); body.set("title", "Fictional reference"); body.set("species", '["cat"]');
  body.set("file", new Blob(["# Cats\nFictional reference text"], { type: "text/markdown" }), "care.md");
  for (const [key, value] of Object.entries(extra)) body.set(key, value);
  return body;
}

test("actual bearer/phone/role boundary rejects guests and non-SuperAdmins before upload side effects", async t => {
  const state = await appFor(t);
  for (const headers of [{}, { "x-guest-id": "fictional-guest" }]) {
    const response = await fetch(state.url, { method: "POST", body: form(), headers });
    assert.equal(response.status, 401); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const user of [{ role: "guest" }, { role: "user" }, { role: "moderator" }, { role: "admin" },
    { role: "superAdmin", phoneVerified: false }]) {
    state.user = { ...state.user, phoneVerified: true, ...user };
    const response = await fetch(state.url, { method: "POST", body: form(), headers: state.headers });
    assert.equal(response.status, 403);
  }
  assert.equal(state.state.puts, 0); assert.equal(state.state.rows.length, 0);
});

test("metadata and upload/list/detail/retry/disable routes expose safe IDs/status/actions", async t => {
  const state = await appFor(t);
  const dateLikeTitle = "2026-10-24T12:00:00.000Z";
  const metadata = await fetch(state.url + "/metadata", { headers: state.headers });
  assert.equal(metadata.status, 200); assert.equal((await metadata.json()).data.activationAvailable, true);
  const upload = await fetch(state.url, { method: "POST", headers: state.headers, body: form({ title: dateLikeTitle }) });
  assert.equal(upload.status, 202); const first = (await upload.json()).data;
  const duplicate = await fetch(state.url, { method: "POST", headers: state.headers, body: form() });
  assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).data.reference.id, first.reference.id);
  const list = await fetch(state.url + "?limit=1", { headers: state.headers });
  assert.equal((await list.json()).data.references[0].id, first.reference.id);
  const queue = state.worker(); queue.start(state.config); await queue.idle();
  const details = await fetch(state.url + "/" + first.reference.id, { headers: state.headers });
  const reference = (await details.json()).data;
  assert.equal(reference.stage, "awaiting_index"); assert.equal(reference.actions.canActivate, false);
  assert.equal(reference.passageCount, 1);
  assert.equal(reference.storedPassageCount, 0); assert.equal(reference.indexingBlocked, false); assert.equal(reference.nextAttemptAt, null);
  assert.equal(reference.searchVerifiedAt, null);
  assert.match(reference.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.match(reference.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.equal(reference.title, dateLikeTitle);
  assert.doesNotMatch(JSON.stringify(reference), /accessKey|extractionKey|extractionHash|lease|synthetic-key|sha256/);
  const retry = await fetch(`${state.url}/${reference.id}/retries`, { method: "POST",
    headers: { ...state.headers, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: reference.version }) });
  assert.equal(retry.status, 409);
  const disabled = await fetch(`${state.url}/${reference.id}/disabling`, { method: "POST",
    headers: { ...state.headers, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion: reference.version }) });
  assert.equal(disabled.status, 200); assert.equal((await disabled.json()).data.status, "disabled");
  assert.equal(disabled.headers.get("cache-control"), "no-store");
});

test("reviewable status exposes only the verification time and preserves versioned disable without activation", async t => {
  const state = await appFor(t);
  const upload = await fetch(state.url, { method: "POST", headers: state.headers, body: form() });
  const first = (await upload.json()).data.reference;
  Object.assign(state.state.rows[0], { status: "needs_review", stage: "awaiting_approval", version: first.version + 1,
    searchVerification: { manifestHash: "a".repeat(64), indexId: "private-index-identity", indexName: "private-index-name",
      indexVersion: 3, passageCount: 1, verifiedAt: new Date("2026-10-25T12:00:00Z") } });
  const response = await fetch(`${state.url}/${first.id}`, { headers: state.headers });
  const reference = (await response.json()).data;
  assert.equal(reference.status, "needs_review"); assert.equal(reference.stage, "awaiting_approval");
  assert.equal(reference.searchVerifiedAt, "2026-10-25T15:00:00.000"); assert.equal(reference.actions.canActivate, false);
  assert.doesNotMatch(JSON.stringify(reference), /manifestHash|indexVersion|private-index|searchVerification/);
  for (const [expectedVersion, status] of [[first.version, 409], [reference.version, 200]]) {
    const disabled = await fetch(`${state.url}/${first.id}/disabling`, { method: "POST",
      headers: { ...state.headers, "Content-Type": "application/json" }, body: JSON.stringify({ expectedVersion }) });
    assert.equal(disabled.status, status);
  }
});

test("activation HTTP uses strict version validation and SuperAdmin auth, returns provenance and safely refuses coverage failure", async t => {
  const state = await appFor(t);
  const upload = await fetch(state.url, { method: "POST", headers: state.headers, body: form() });
  const first = (await upload.json()).data.reference;
  const worker = state.worker(); worker.start(state.config); await worker.idle();
  const row = state.state.rows[0]; row.version++;
  Object.assign(row, { status: "needs_review", stage: "awaiting_approval", storedPassageCount: row.passageCount,
    searchVerification: { model: "text-embedding-3-large", dimensions: 1536, manifestHash: row.passageHash, indexId: "fictional-index", indexName: "petyard_reference_vector_v1",
      indexVersion: 1, passageCount: row.passageCount, verifiedAt: new Date(state.state.time) } });
  let coverageCalls = 0, failCoverage = false;
  const application = createReferenceService({ ...state.dependencies, verifyCoverage: async () => {
    coverageCalls++; if (failCoverage) throw new Error("private fixture details"); return row.searchVerification;
  } });
  t.mock.method(state.application, "activate", (...args) => application.activate(...args));
  const send = (body, headers = state.headers) => fetch(`${state.url}/${first.id}/activation`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const body = { expectedVersion: row.version };
  assert.equal((await send(body, {})).status, 401);
  state.user.role = "admin"; assert.equal((await send(body)).status, 403); state.user.role = "superAdmin";
  for (const invalid of [{}, { expectedVersion: String(row.version) }, { ...body, approve: true }]) assert.equal((await send(invalid)).status, 400);
  assert.equal(coverageCalls, 0);
  failCoverage = true; const failed = await send(body);
  assert.equal(failed.status, 503); const failure = await failed.json();
  assert.equal(failure.error.code, "reference_activation_check_failed"); assert.doesNotMatch(JSON.stringify(failure), /private fixture/);
  assert.equal(row.status, "needs_review"); failCoverage = false;
  const response = await send(body); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const reference = (await response.json()).data;
  assert.equal(reference.status, "ready"); assert.equal(reference.activatedBy, String(state.user._id));
  assert.equal(reference.activatedAt, egyptTimezoneReplacer("activatedAt", state.state.time.toISOString()));
  assert.equal(reference.version, body.expectedVersion + 1); assert.equal(reference.actions.canActivate, false);
  assert.doesNotMatch(JSON.stringify(reference), /manifestHash|indexVersion|fictional-index/);
  assert.equal((await send(body)).status, 409); assert.equal(coverageCalls, 2);
});

test("disabled feature, unknown metadata/query fields, extra files and oversized bytes fail safely", async t => {
  const state = await appFor(t);
  state.config = { enabled: false };
  assert.equal((await fetch(state.url, { method: "POST", headers: state.headers, body: form() })).status, 503);
  state.config = referenceTestConfig();
  for (const body of [form({ status: "ready" }), form({ species: "not-json" })]) {
    assert.equal((await fetch(state.url, { method: "POST", headers: state.headers, body })).status, 400);
  }
  const extra = form(); extra.append("secondFile", new Blob(["test"]), "second.txt");
  assert.equal((await fetch(state.url, { method: "POST", headers: state.headers, body: extra })).status, 400);
  assert.equal((await fetch(state.url + "?storageKey=private", { method: "POST", headers: state.headers, body: form() })).status, 400);
  state.config.limits.maxFileBytes = 8;
  const tooLarge = await fetch(state.url, { method: "POST", headers: state.headers, body: form() });
  assert.equal(tooLarge.status, 413); assert.equal((await tooLarge.json()).error.code, "reference_file_too_large");
  assert.equal(state.state.puts, 0);
});

test("malformed JSON and multipart bodies keep private errors without parser details", async t => {
  const state = await appFor(t), id = "111111111111111111111111";
  const response = await fetch(`${state.url}/${id}/disabling`, { method: "POST",
    headers: { ...state.headers, "Content-Type": "application/json" }, body: "{" });
  assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).error.code, "invalid_request");
  const broken = await fetch(state.url, { method: "POST", headers: { ...state.headers, "Content-Type": "multipart/form-data; boundary=missing" }, body: "unfinished" });
  assert.equal(broken.status, 400); assert.doesNotMatch(await broken.text(), /stack|Busboy|Unexpected|synthetic/);
});

test("reference rate-limit responses are private and do not change other API fallback", () => {
  const res = { headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(value) { this.code = value; return this; },
    json(value) { this.value = value; return this; }, send(value) { this.value = value; return this; } };
  assistantAwareApiLimit({ originalUrl: "/api/v1/assistant/admin/references" }, res, () => {}, { statusCode: 429, message: "old message" });
  assert.equal(res.code, 429); assert.equal(res.headers["Cache-Control"], "no-store"); assert.equal(res.value.error.code, "request_rate_limit");
  assert.equal(res.value.error.retryable, true);
  assistantAwareApiLimit({ originalUrl: "/api/v1/cart" }, res, () => {}, { statusCode: 429, message: "old message" });
  assert.equal(res.value, "old message");
});
