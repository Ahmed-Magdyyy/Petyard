import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { AssistantEvent } from "../../../src/domains/assistant/shared/assistant.models.js";
import { getReviewCandidates } from "../../../src/domains/assistant/review/assistant.review-candidates.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { testConfig, reviewOnlyPolicy } from "./fixtures/foundationPolicy.js";

const config = testConfig({ reviewPolicy: reviewOnlyPolicy });
const actor = new mongoose.Types.ObjectId();

test("review-only policy is explicit, validated, versioned and cannot enable automatic restrictions", () => {
  assert.equal(testConfig().reviewPolicy, undefined, "Existing policies remain compatible without review detection");
  assert.deepEqual(config.reviewPolicy, reviewOnlyPolicy);
  for (const reviewPolicy of [null, [], "auto-ban", {}, { ...reviewOnlyPolicy, version: "" },
    { ...reviewOnlyPolicy, offTopicThreshold: 1 }, { ...reviewOnlyPolicy, directedAbuseThreshold: "3" },
    { ...reviewOnlyPolicy, directedAbuseThreshold: 10001 }, { ...reviewOnlyPolicy, windowSeconds: 86401 },
    { ...reviewOnlyPolicy, windowSeconds: 59 }, { ...reviewOnlyPolicy, block: true }]) {
    assert.throws(() => testConfig({ reviewPolicy }), { code: "assistant_configuration_required" });
  }
  assert.throws(() => testConfig({ reviewPolicy: reviewOnlyPolicy, automaticRestrictions: true }), { code: "assistant_configuration_required" });
  assert.notEqual(config.signature, testConfig({ reviewPolicy: { ...reviewOnlyPolicy, version: "review-only-v2" } }).signature);
});

test("candidate inputs fail before reading data when disabled, unconfigured or malformed", async (t) => {
  t.mock.method(AssistantEvent, "aggregate", () => { throw new Error("must not read data"); });
  await assert.rejects(getReviewCandidates(actor, {}, { enabled: false }), { code: "assistant_disabled" });
  await assert.rejects(getReviewCandidates(actor, {}, testConfig()), { code: "review_policy_required" });
  await assert.rejects(getReviewCandidates(null, {}, config), { code: "invalid_identifier" });
  for (const query of [{ after: "1" }, { after: [String(actor)] }, { limit: 101 }, { limit: "NaN" },
    { owner: String(actor) }, { threshold: 1 }, { windowSeconds: 1 }, { before: String(actor) }]) {
    await assert.rejects(getReviewCandidates(actor, query, config));
  }
});

test("actual candidate HTTP enforces current verified superAdmin, derives actor and sanitizes failures", async (t) => {
  const previousSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "candidate-local-test-secret";
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previousSecret; });
  const user = { _id: actor, role: "user", active: true, phoneVerified: true };
  t.mock.method(UserModel, "findById", async () => user);
  const calls = []; let fail = false;
  const app = express();
  app.use("/assistant", createAssistantRouter({ getConfig: () => config, application: {
    async getReviewCandidates(receivedActor, query) {
      calls.push({ actor: String(receivedActor), query });
      if (fail) throw new Error("private candidate transcript provider prompt audit failure");
      return { candidates: [], nextAfter: null };
    },
  } }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/assistant/admin/review-candidates?limit=2`;
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
  assert.deepEqual((await response.json()).data, { candidates: [], nextAfter: null });
  assert.deepEqual(calls[0], { actor: String(actor), query: { limit: "2" } });
  user.role = "admin"; assert.equal((await fetch(url, { headers })).status, 403);
  user.role = "superAdmin"; fail = true;
  const failed = await fetch(url, { headers }); assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify(await failed.json()), /private|transcript|provider|prompt|audit failure|stack/);
});
