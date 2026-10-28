import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import jwt from "jsonwebtoken";
import { readFile } from "node:fs/promises";
import { Script, runInNewContext } from "node:vm";
import { createEmbeddingReviewService, embeddingReviewDto } from "../../../src/domains/assistant/admin/assistant.embedding-review.js";
import { createEmbeddingExecutor } from "../../../src/domains/assistant/references/assistant.embedding-executor.js";
import { AssistantEmbeddingBatch } from "../../../src/domains/assistant/references/assistant.embedding-batch.model.js";
import { embeddingBillingSnapshot } from "../../../src/domains/assistant/references/assistant.embedding-billing.js";
import { embeddingProfile } from "../../../src/domains/assistant/providers/openaiEmbeddings.js";
import { AssistantAccount, AssistantBudget } from "../../../src/domains/assistant/shared/assistant.models.js";
import { periods } from "../../../src/domains/assistant/shared/assistant.config.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { egyptTimezoneReplacer } from "../../../src/shared/utils/egyptTimezone.js";
import { matchesQuery } from "./fixtures/matchesQuery.js";
import { testPolicy } from "./fixtures/foundationPolicy.js";

const oid = () => String(new mongoose.Types.ObjectId());
const price = { version: "fictional-embedding-price", model: embeddingProfile.model, dimensions: embeddingProfile.dimensions,
  inputMicroUsdPerMillion: 20000, validFrom: "2000-01-01T00:00:00Z", validUntil: "2100-01-01T00:00:00Z" };
const body = { resolution: "charge_reserved", reason: "  Reviewed the unconfirmed provider request.  " };
const usage = { inputTokens: 100, totalTokens: 100, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
const vector = () => Array.from({ length: 1536 }, (_, index) => index ? 0 : 0.5);

function fixture(t) {
  const time = new Date("2026-10-25T12:00:00Z"), shared = testPolicy(), owner = oid(), actor = oid();
  const snapshot = embeddingBillingSnapshot(shared, price, ["Fictional excerpt"], time), period = periods(snapshot.config, time);
  const reservation = { amount: snapshot.reservationMicroUsd, budgetIds: [`global:${period.month}`, `user:${owner}:${period.day}`],
    month: period.month, day: period.day, priceVersion: price.version, reservedAt: time };
  const initial = { _id: oid(), key: "a".repeat(64), kind: "reference", reference: oid(), owner, sourceHash: "b".repeat(64),
    manifestHash: "c".repeat(64), batchHash: snapshot.batchHash, start: 0, passageIds: ["d".repeat(64)], model: embeddingProfile.model,
    dimensions: 1536, status: "uncertain", accounting: "reserved", config: snapshot.config, reservation,
    createdAt: time, dispatchDeadline: new Date(time.getTime() + 31000), failureCode: "timeout", providerRequestId: "fictional-request-id" };
  const state = { time, rows: [structuredClone(initial)], updates: [], ledger: new Map(reservation.budgetIds.map(id => [id,
    { _id: id, spent: 7, reserved: reservation.amount, frozen: false }])), user: {
      _id: actor, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" }, account: { blocked: true, activeRun: "do-not-unlock" }, calls: 0 };
  const document = data => Object.assign(structuredClone(data), { async save(options) {
    assert.ok(options.session); if (state.failSave) throw new Error("Fictional receipt save failure");
    const copy = { ...this }; delete copy.save;
    if (copy.reconciliation) copy.reconciliation = { ...copy.reconciliation, actor: String(copy.reconciliation.actor) };
    await new AssistantEmbeddingBatch(copy).validate(); state.rows[state.rows.findIndex(row => row._id === copy._id)] = structuredClone(copy);
  } });
  const query = read => {
    let count = Infinity, sorting;
    const result = { session() { return this; }, maxTimeMS() { return this; }, select() { return this; },
      sort(value) { sorting = value; return this; }, limit(value) { count = value; return this; },
      async lean() { const data = read(); return Array.isArray(data) ? data.sort((a, b) => String(a._id).localeCompare(String(b._id)) * (sorting?._id ?? 1)).slice(0, count) : data; },
      then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } };
    return result;
  };
  const batches = {
    findById: id => query(() => { const row = state.rows.find(row => row._id === String(id)); return row ? document(row) : null; }),
    findOne: filter => query(() => { const row = state.rows.find(row => matchesQuery(row, filter)); return row ? document(row) : null; }),
    find: filter => query(() => state.rows.filter(row => matchesQuery(row, { ...filter,
      ...(filter._id ? { _id: { $lt: String(filter._id.$lt) } } : {}) }))),
    async create([data]) {
      const row = { ...data, _id: oid(), owner: String(data.owner), reference: String(data.reference), createdAt: new Date(state.time) };
      await new AssistantEmbeddingBatch(row).validate(); assert.equal(state.rows.some(saved => saved.key === row.key), false);
      state.rows.push(structuredClone(row)); return [document(row)];
    },
  };
  t.mock.method(UserModel, "findById", id => query(() => String(id) === actor ? state.user : null));
  t.mock.method(AssistantAccount, "findOne", () => query(() => state.account));
  t.mock.method(AssistantAccount, "updateOne", () => { throw new Error("Embedding review must not unlock or change chat access"); });
  t.mock.method(AssistantBudget, "findOneAndUpdate", async (filter, update) => {
    if (!state.ledger.has(filter._id)) state.ledger.set(filter._id, { _id: filter._id, spent: 0, reserved: 0, frozen: false, ...update.$setOnInsert });
    return state.ledger.get(filter._id);
  });
  t.mock.method(AssistantBudget, "updateOne", async (filter, update, options) => {
    assert.ok(options.session);
    if (!state.ledger.has(filter._id) && options.upsert) state.ledger.set(filter._id, { _id: filter._id, spent: 0, reserved: 0, frozen: false, ...update.$setOnInsert });
    const row = state.ledger.get(filter._id);
    if (!row || filter.reserved?.$gte !== undefined && row.reserved < filter.reserved.$gte ||
        filter.frozen !== undefined && row.frozen !== filter.frozen ||
        filter.$expr && row.spent + row.reserved + filter.$expr.$lte[0].$add[2] > filter.$expr.$lte[1]) return { modifiedCount: 0 };
    state.updates.push({ id: row._id, update }); Object.assign(row, update.$set);
    for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] += value;
    return { modifiedCount: 1 };
  });
  let tail = Promise.resolve();
  const atomic = callback => {
    const task = tail.then(async () => {
      const before = structuredClone({ rows: state.rows, ledger: state.ledger, updates: state.updates });
      try { await state.beforeTransaction?.(); return await callback({ fictional: true }); }
      catch (error) { Object.assign(state, before); throw error; }
    }); tail = task.catch(() => {}); return task;
  };
  const service = createEmbeddingReviewService({ batches, ensureStore: async () => {}, atomic, now: () => new Date(state.time) });
  return { state, batches, atomic, service, shared, actor, owner, initial,
    close: (changes = {}) => service.reconcile(actor, initial._id, { ...body, ...changes }) };
}

test("manual review reuses the actual ledger, charges each saved budget once and retains the human audit", async t => {
  const f = fixture(t), amount = f.initial.reservation.amount;
  const outcome = await f.close(); assert.equal(outcome.duplicate, false); assert.equal(outcome.batch.accounting, "charged_reservation");
  assert.equal(outcome.batch.status, "failed"); assert.equal(outcome.batch.chargedMicroUsd, amount); assert.equal(outcome.batch.canReconcile, false);
  assert.equal(outcome.batch.reconciliation.actorId, f.actor); assert.equal(outcome.batch.reconciliation.reason, body.reason.trim());
  for (const row of f.state.ledger.values()) { assert.equal(row.reserved, 0); assert.equal(row.spent, 7 + amount); }
  const again = await f.close({ reason: "A later retry must preserve the first reason" });
  assert.equal(again.duplicate, true); assert.deepEqual(again.batch.reconciliation, outcome.batch.reconciliation); assert.equal(f.state.updates.length, 2);
  assert.equal(f.state.account.activeRun, "do-not-unlock");
});

test("historical Small receipts retain their saved price and can still be reconciled once after the Large switch", async t => {
  const f = fixture(t), row = f.state.rows[0]; row.model = "text-embedding-3-small";
  const savedConfig = structuredClone(row.config), amount = row.reservation.amount;
  assert.equal(embeddingReviewDto(row, f.state.time).canReconcile, true);
  const result = await f.close(); assert.equal(result.batch.model, "text-embedding-3-small");
  assert.equal(result.batch.chargedMicroUsd, amount); assert.deepEqual(f.state.rows[0].config, savedConfig);
  assert.equal((await f.close()).duplicate, true); assert.equal(f.state.updates.length, 2);
});

test("concurrent manual retries have one accounting winner in the serialized transaction fixture", async t => {
  const f = fixture(t), results = await Promise.all([f.close(), f.close(), f.close()]);
  assert.equal(results.filter(row => !row.duplicate).length, 1); assert.equal(f.state.updates.length, 2);
});

test("receipt persistence failure rolls back both budget updates and allows safe recovery", async t => {
  const f = fixture(t), before = structuredClone(f.state.ledger); f.state.failSave = true;
  await assert.rejects(f.close(), /Fictional receipt save failure/); assert.deepEqual(f.state.ledger, before);
  assert.equal(f.state.rows[0].accounting, "reserved"); assert.equal(f.state.rows[0].reconciliation, undefined);
  f.state.failSave = false; assert.equal((await f.close()).duplicate, false); assert.equal(f.state.updates.length, 2);
});

test("active/completed receipts and malformed saved financial identities cannot be closed", async t => {
  const f = fixture(t), original = structuredClone(f.state.rows[0]);
  for (const change of [{ status: "dispatching" }, { status: "completed", accounting: "settled" }]) {
    f.state.rows[0] = { ...structuredClone(original), ...change }; await assert.rejects(f.close(), { code: "embedding_not_reconcilable" });
  }
  for (const mutate of [row => row.reservation.amount = -1, row => row.reservation.amount++,
    row => row.reservation.budgetIds[1] = `user:${oid()}:${row.reservation.day}`, row => row.reservation.month = "wrong",
    row => row.reservation.reservedAt = null]) {
    f.state.rows[0] = structuredClone(original); mutate(f.state.rows[0]);
    assert.equal(embeddingReviewDto(f.state.rows[0], f.state.time).canReconcile, false);
    await assert.rejects(f.close(), { code: "embedding_accounting_unavailable" });
  }
  assert.equal(f.state.updates.length, 0);
});

test("legacy dispatch timing uses the maximum adapter timeout and refuses missing timing", async t => {
  const f = fixture(t), row = f.state.rows[0]; row.status = "dispatching"; delete row.dispatchDeadline;
  assert.equal((await f.service.get(f.actor, row._id)).canReconcile, false);
  f.state.time = new Date(f.state.time.getTime() + 60001); assert.equal((await f.close()).batch.accounting, "charged_reservation");
  const invalid = { ...structuredClone(f.initial), status: "dispatching" }; delete invalid.dispatchDeadline; invalid.reservation.reservedAt = null;
  f.state.rows[0] = invalid; assert.equal(embeddingReviewDto(invalid, f.state.time).canReconcile, false);
  await assert.rejects(f.close(), { code: "embedding_not_reconcilable" });
});

test("customer question receipts close under the same rule without exposing question text or altering their run", async t => {
  const f = fixture(t), row = f.state.rows[0]; Object.assign(row, { kind: "customer_query", run: oid(),
    queryContextHash: "e".repeat(64), vectorsExpireAt: new Date(f.state.time.getTime() + 86400000) });
  for (const key of ["reference", "sourceHash", "manifestHash", "start", "passageIds"]) delete row[key];
  const closed = await f.close(); assert.equal(closed.batch.kind, "customer_query"); assert.equal(closed.batch.runId, row.run);
  assert.equal(closed.batch.referenceId, null); assert.equal(f.state.account.activeRun, "do-not-unlock");
  assert.doesNotMatch(JSON.stringify(closed), /queryContextHash|vectorsExpireAt|batchHash|inputTokens/);
});

test("service authority is checked freshly inside the financial transaction while AI restrictions do not block review", async t => {
  const f = fixture(t); f.state.beforeTransaction = () => { f.state.user.role = "admin"; };
  await assert.rejects(f.close(), { code: "access_denied" }); assert.equal(f.state.updates.length, 0);
  f.state.beforeTransaction = null; f.state.user.role = "superAdmin"; f.state.user.phoneVerified = false;
  await assert.rejects(f.service.list(f.actor, {}), { code: "access_denied" });
  f.state.user.phoneVerified = true; assert.equal((await f.close()).duplicate, false);
});

test("queue cursor and detail DTO expose only review data, without text, vectors, keys or saved configuration", async t => {
  const f = fixture(t), initial = f.state.rows[0];
  f.state.rows.push({ ...structuredClone(initial), _id: oid(), key: "e".repeat(64), status: "dispatching", vectors: [vector()] });
  f.state.rows.push({ ...structuredClone(initial), _id: oid(), key: "f".repeat(64), status: "completed", accounting: "settled" });
  const first = await f.service.list(f.actor, { limit: "1" }); assert.equal(first.batches.length, 1); assert.ok(first.nextBefore);
  const second = await f.service.list(f.actor, { before: first.nextBefore, limit: "1" }); assert.equal(second.batches.length, 1); assert.equal(second.nextBefore, null);
  assert.notEqual(first.batches[0].id, second.batches[0].id);
  assert.doesNotMatch(JSON.stringify(first), /vectors|budgetIds|batchHash|sourceHash|manifestHash|openingExposure|contextWindowTokens|passageIds|"key"/);
  await assert.rejects(f.service.get(f.actor, oid()), { code: "embedding_batch_not_found" });
  await assert.rejects(f.service.list(f.actor, { limit: ["1"] }), { code: "invalid_request" });
});

async function inFlight(f) {
  f.state.rows = []; f.state.ledger.clear();
  let started, release;
  const began = new Promise(resolve => { started = resolve; }), pending = new Promise(resolve => { release = resolve; });
  const execute = createEmbeddingExecutor({ batches: f.batches, atomic: f.atomic, now: () => new Date(f.state.time) });
  const identity = Object.fromEntries(["kind", "reference", "owner", "sourceHash", "manifestHash", "start", "passageIds"].map(key => [key, f.initial[key]]));
  const args = { key: f.initial.key, identity, input: ["Fictional excerpt"], shared: f.shared, price, timeoutMs: 1000,
    authorize: async () => {}, adapter: { ...embeddingProfile, async embed() { f.state.calls++; started(); await pending; return { vectors: [vector()], usage }; } } };
  const execution = execute(args); const observed = execution.then(value => ({ value }), error => ({ error }));
  await began;
  return { observed, release, replay: () => execute(args), row: f.state.rows[0] };
}

test("manual closure wins over a late actual executor completion without a second charge or HTTP replay", async t => {
  const f = fixture(t), pending = await inFlight(f), deadline = pending.row.dispatchDeadline;
  assert.equal(deadline.getTime(), f.state.time.getTime() + 31000); f.state.time = new Date(deadline.getTime() + 1);
  const closed = await f.service.reconcile(f.actor, pending.row._id, body); assert.equal(closed.duplicate, false);
  pending.release(); const late = await pending.observed; assert.equal(late.error.code, "embedding_batch_changed");
  const replay = await pending.replay(); assert.equal(replay.accounting, "charged_reservation"); assert.equal(replay.vectors, undefined);
  assert.equal(f.state.calls, 1); for (const row of f.state.ledger.values()) if (row._id !== "control") {
    assert.equal(row.reserved, 0); assert.equal(row.spent, closed.batch.reservedMicroUsd);
  }
});

test("actual executor completion wins first and manual closure cannot charge again", async t => {
  const f = fixture(t), pending = await inFlight(f); pending.release(); const finished = await pending.observed;
  assert.equal(finished.value.accounting, "settled"); await assert.rejects(f.service.reconcile(f.actor, pending.row._id, body), { code: "embedding_not_reconcilable" });
  assert.equal(f.state.calls, 1); for (const row of f.state.ledger.values()) if (row._id !== "control") {
    assert.equal(row.reserved, 0); assert.equal(row.spent, finished.value.chargedMicroUsd);
    assert.ok(row.spent < pending.row.reservation.amount);
  }
});

async function httpFixture(t) {
  const f = fixture(t), before = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "fictional-embedding-review-secret";
  t.after(() => { if (before === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = before; });
  const app = express(); app.set("json replacer", egyptTimezoneReplacer); app.use(express.json({ strict: false }));
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => { throw new Error("Chat configuration must not be read"); }, embeddingReviewApplication: f.service }));
  const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant/admin/embedding-batches`;
  const headers = { Authorization: `Bearer ${jwt.sign({ userId: f.actor }, process.env.JWT_ACCESS_SECRET)}`, "Content-Type": "application/json" };
  return { ...f, headers, async request(method, path = "", payload, auth = headers) {
    const response = await fetch(url + path, { method, headers: auth, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    assert.equal(response.headers.get("cache-control"), "no-store"); return { status: response.status, body: await response.json() };
  } };
}

test("real HTTP bearer, phone and role checks protect all review routes even without chat configuration", async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request("GET", "", undefined, {})).status, 401);
  for (const role of ["guest", "user", "moderator", "admin"]) {
    f.state.user.role = role; assert.equal((await f.request("POST", "/bad/reconcile", {})).status, 403);
  }
  f.state.user.role = "superAdmin"; f.state.user.phoneVerified = false;
  assert.equal((await f.request("GET")).status, 403); f.state.user.phoneVerified = true;
  const list = await f.request("GET"); assert.equal(list.status, 200); assert.equal(list.body.data.batches[0].id, f.initial._id);
  const detail = await f.request("GET", `/${f.initial._id}`); assert.equal(detail.status, 200);
  assert.equal(detail.body.data.createdAt, egyptTimezoneReplacer("createdAt", f.initial.createdAt.toISOString()));
  const dateLikeReason = "2026-10-25T12:00:00.000Z";
  const closed = await f.request("POST", `/${f.initial._id}/reconcile`, { ...body, reason: dateLikeReason });
  assert.equal(closed.body.data.duplicate, false); assert.equal(closed.body.data.batch.reconciliation.reason, dateLikeReason);
  assert.equal(closed.body.data.batch.reconciliation.at, egyptTimezoneReplacer("at", f.state.time.toISOString()));
  assert.equal((await f.request("POST", `/${f.initial._id}/reconcile`, body)).body.data.duplicate, true);
  assert.equal((await f.request("GET")).body.data.batches.length, 0);
});

test("HTTP express-validator rejects injected fields, malformed identifiers, repeated queries and invalid resolution", async t => {
  const f = await httpFixture(t), path = `/${f.initial._id}/reconcile`;
  for (const [method, route, payload] of [
    ["GET", "?before=bad"], ["GET", "?limit=2&limit=3"], ["GET", "?limit=101"], ["GET", "?owner=private-value"],
    ["GET", "/bad"], ["GET", `/${f.initial._id}?amount=1`], ["POST", "/bad/reconcile", body],
    ["POST", path, null], ["POST", path, []], ["POST", path, {}], ["POST", path, { ...body, resolution: "release" }],
    ["POST", path, { ...body, amount: 0 }], ["POST", path, { ...body, actor: f.actor }],
    ["POST", path, { ...body, reason: " " }], ["POST", path, { ...body, reason: "x".repeat(501) }],
    ["POST", path, { ...body, reason: "x\u0000y" }], ["POST", path + "?amount=1", body],
  ]) {
    const result = await f.request(method, route, payload); assert.equal(result.status, 400, JSON.stringify({ method, route, result }));
    assert.doesNotMatch(JSON.stringify(result.body), /private-value|stack|Fictional/);
  }
  assert.equal(f.state.updates.length, 0);
});

test("HTTP failures preserve the unknown reservation and hide database details", async t => {
  const f = await httpFixture(t); f.state.failSave = true;
  const failed = await f.request("POST", `/${f.initial._id}/reconcile`, body); assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.body), /Fictional|save failure|stack|reservation|budgetIds/);
  const detail = await f.request("GET", `/${f.initial._id}`); assert.equal(detail.body.data.accounting, "reserved");
  assert.equal(detail.body.data.reconciliation, null); assert.equal(f.state.updates.length, 0);
  assert.equal((await f.request("GET", `/${oid()}`)).status, 404);
});

test("Postman review requests parse, skip by default and require a reviewed receipt plus one-use confirmation", async () => {
  const collection = JSON.parse(await readFile(new URL("./fixtures/contracts/AssistantEmbeddingReview.postman_collection.json", import.meta.url), "utf8"));
  assert.deepEqual(collection.item.map(item => item.request.method), ["GET", "GET", "POST"]);
  for (const event of [...collection.event, ...collection.item.flatMap(item => item.event)]) new Script(event.script.exec.join("\n"));
  const variables = new Map(collection.variable.map(item => [item.key, item.value])), saved = new Map(variables); let skipped = false;
  const pm = { variables: { get: key => variables.get(key), set: (key, value) => variables.set(key, value) },
    collectionVariables: { get: key => saved.get(key), set: (key, value) => saved.set(key, value) }, execution: { skipRequest() { skipped = true; } } };
  runInNewContext(collection.event[0].script.exec.join("\n"), { pm }); assert.equal(skipped, true);
  const script = collection.item[2].event[0].script.exec.join("\n");
  variables.set("reviewBatchId", "a".repeat(24)); variables.set("reviewReason", 'A "quoted" reason\nمراجعة');
  variables.set("confirmEmbeddingReview", "true"); saved.set("lastReviewedBatchId", "a".repeat(24)); saved.set("lastReviewCanReconcile", "true");
  skipped = false; runInNewContext(script, { pm }); assert.equal(skipped, true, "An environment override must not authorize closure");
  saved.set("confirmEmbeddingReview", "true"); skipped = false; runInNewContext(script, { pm }); assert.equal(skipped, false);
  assert.equal(saved.get("confirmEmbeddingReview"), "false");
  const payload = JSON.parse(collection.item[2].request.body.raw.replace("{{reviewReasonJson}}", variables.get("reviewReasonJson")));
  assert.deepEqual(payload, { resolution: "charge_reserved", reason: variables.get("reviewReason") });
});
