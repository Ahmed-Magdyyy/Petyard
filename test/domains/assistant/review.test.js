import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { AssistantAccount, AssistantMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { getHistory, reviewHistory, reviewObservations } from "../../../src/domains/assistant/customer/assistant.service.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { testConfig } from "./fixtures/foundationPolicy.js";

const config = testConfig();
const actor = new mongoose.Types.ObjectId();
const owner = String(new mongoose.Types.ObjectId());

test("review rejects disabled access, malformed target/actor and query overrides before any data read", async (t) => {
  t.mock.method(AssistantMessage, "find", () => { throw new Error("must not query messages"); });
  t.mock.method(UserModel, "exists", () => { throw new Error("must not query users"); });
  await assert.rejects(reviewHistory(actor, owner, {}, { enabled: false }), { code: "assistant_disabled" });
  await assert.rejects(reviewHistory(actor, "invalid", {}, config), { code: "invalid_identifier" });
  await assert.rejects(reviewHistory(null, owner, {}, config), { code: "invalid_identifier" });
  for (const query of [{ userId: owner }, { model: "private" }, { before: "no" }, { limit: 101 }]) {
    await assert.rejects(reviewHistory(actor, owner, query, config));
  }
});

test("observations reject invalid inputs and overrides before any database access", async (t) => {
  t.mock.method(UserModel, "exists", () => { throw new Error("must not query users"); });
  await assert.rejects(reviewObservations(actor, owner, {}, { enabled: false }), { code: "assistant_disabled" });
  await assert.rejects(reviewObservations(null, owner, {}, config), { code: "invalid_identifier" });
  await assert.rejects(reviewObservations(actor, "invalid", {}, config), { code: "invalid_identifier" });
  for (const query of [{ before: "1" }, { before: [owner] }, { limit: 101 }, { limit: 0 }, { limit: "NaN" },
    { actor: owner }, { type: "manual_ai_block" }, { verified: true }]) {
    await assert.rejects(reviewObservations(actor, owner, query, config));
  }
});

test("shared customer history paging preserves ownership, expiry filtering, private DTOs and blocked-history policy", async (t) => {
  let blocked = false; let filter; let selectedSession; let reads = 0;
  t.mock.method(AssistantAccount, "findOne", () => ({ async lean() { return { blocked }; } }));
  const record = (sequence) => ({ _id: `message-${sequence}`, run: "run", role: "user", text: "owned text", sequence,
    createdAt: new Date(), expiresAt: new Date("2100-01-01"), providerRequestId: "private-provider-id", config: { key: "private-key" } });
  t.mock.method(AssistantMessage, "find", (query) => {
    reads += 1; filter = query;
    return { sort(value) { assert.deepEqual(value, { sequence: -1 }); return this; },
      limit(value) { assert.equal(value, 3); return this; }, session(value) { selectedSession = value; return this; },
      async lean() { return [record(3), record(2), record(1)]; } };
  });
  const result = await getHistory(owner, { limit: 2, before: 4 }, config);
  assert.equal(filter.owner, owner); assert.equal(filter.sequence.$lt, 4); assert.ok(filter.expiresAt.$gt instanceof Date);
  assert.equal(selectedSession, null); assert.equal(result.nextBefore, 2);
  assert.deepEqual(result.messages.map((message) => message.sequence), [3, 2]);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-id|private-key/);
  blocked = true;
  await assert.rejects(getHistory(owner, {}, config), { code: "ai_restricted" });
  assert.equal(reads, 1);
});

for (const [endpoint, method] of [["messages", "reviewHistory"], ["observations", "reviewObservations"]]) {
  test(`actual ${endpoint} review HTTP requires verified superAdmin, derives the actor and safely handles failure`, async (t) => {
    const oldSecret = process.env.JWT_ACCESS_SECRET;
    process.env.JWT_ACCESS_SECRET = "review-local-test-secret";
    t.after(() => { if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = oldSecret; });
    const user = { _id: actor, role: "user", active: true, phoneVerified: true };
    t.mock.method(UserModel, "findById", async () => user);
    const calls = []; let failAudit = false;
    const app = express();
    app.use("/assistant", createAssistantRouter({ getConfig: () => config, application: {
      async [method](receivedActor, receivedOwner, query) {
        calls.push({ actor: String(receivedActor), owner: receivedOwner, query });
        if (failAudit) throw new Error("private customer transcript OpenAI provider audit failure");
        return { userId: receivedOwner, messages: [], nextBefore: null, order: "newest_first" };
      },
    } }));
    const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    const url = `http://127.0.0.1:${server.address().port}/assistant/admin/accounts/${owner}/${endpoint}?limit=2`;
    const headers = { Authorization: `Bearer ${jwt.sign({ userId: String(actor) }, process.env.JWT_ACCESS_SECRET)}` };
    assert.equal((await fetch(url)).status, 401);
    for (const role of ["user", "admin", "moderator"]) {
      user.role = role; assert.equal((await fetch(url, { headers })).status, 403);
    }
    user.role = "superAdmin"; user.phoneVerified = false;
    assert.equal((await fetch(url, { headers })).status, 403); assert.equal(calls.length, 0);
    user.phoneVerified = true;
    const response = await fetch(url, { headers }); assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).data.userId, owner);
    assert.deepEqual(calls[0], { actor: String(actor), owner, query: { limit: "2" } });
    user.role = "admin"; assert.equal((await fetch(url, { headers })).status, 403);
    user.role = "superAdmin"; failAudit = true;
    const failed = await fetch(url, { headers }); assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(JSON.stringify(await failed.json()), /transcript|OpenAI|provider|audit failure|stack/);
  });
}
