import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { dismissReviewCandidate } from "../../../src/domains/assistant/review/assistant.review-dismissals.js";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { testConfig, reviewOnlyPolicy } from "./fixtures/foundationPolicy.js";

const config = testConfig({ reviewPolicy: reviewOnlyPolicy });
const actor = new mongoose.Types.ObjectId();
const owner = String(new mongoose.Types.ObjectId());
const body = { reviewSnapshotId: String(new mongoose.Types.ObjectId()), reason: "Reviewed context" };

test("dismissal rejects disabled/missing policy, invalid IDs, reasons and authority overrides before reads", async (t) => {
  t.mock.method(UserModel, "exists", () => { throw new Error("must not read data"); });
  await assert.rejects(dismissReviewCandidate(actor, owner, body, { enabled: false }), { code: "assistant_disabled" });
  await assert.rejects(dismissReviewCandidate(actor, owner, body, testConfig()), { code: "review_policy_required" });
  await assert.rejects(dismissReviewCandidate(null, owner, body, config), { code: "invalid_identifier" });
  await assert.rejects(dismissReviewCandidate(actor, "invalid", body, config), { code: "invalid_identifier" });
  for (const input of [null, {}, { ...body, reviewSnapshotId: "invalid" }, { ...body, reason: " " },
    { ...body, reason: "x".repeat(501) }, { ...body, actor: owner }, { ...body, dismissedBefore: "2100-01-01" },
    { ...body, blocked: false }, { ...body, decision: "restore" }]) {
    await assert.rejects(dismissReviewCandidate(actor, owner, input, config));
  }
});

test("actual dismissal HTTP derives actor and target, enforces current role/phone and sanitizes failures", async (t) => {
  const previousSecret = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "dismissal-local-test-secret";
  t.after(() => { if (previousSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previousSecret; });
  const user = { _id: actor, role: "user", active: true, phoneVerified: true };
  t.mock.method(UserModel, "findById", async () => user);
  const calls = []; let fail = false;
  const app = express(); app.use(express.json());
  app.use("/assistant", createAssistantRouter({ getConfig: () => config, application: {
    async dismissReviewCandidate(receivedActor, receivedOwner, receivedBody) {
      calls.push({ actor: String(receivedActor), owner: receivedOwner, body: receivedBody });
      if (fail) throw new Error("private dismissal audit provider error");
      return { userId: receivedOwner, advanced: true };
    },
  } }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/assistant/admin/accounts/${owner}/review-dismissals`;
  const auth = `Bearer ${jwt.sign({ userId: String(actor) }, process.env.JWT_ACCESS_SECRET)}`;
  const request = (authenticated = true) => fetch(url, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: auth } : {}) } });
  assert.equal((await request(false)).status, 401);
  for (const role of ["user", "admin", "moderator"]) {
    user.role = role; assert.equal((await request()).status, 403);
  }
  user.role = "superAdmin"; user.phoneVerified = false;
  assert.equal((await request()).status, 403); assert.equal(calls.length, 0);
  user.phoneVerified = true;
  const response = await request(); assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).data.userId, owner);
  assert.deepEqual(calls[0], { actor: String(actor), owner, body });
  user.role = "admin"; assert.equal((await request()).status, 403);
  user.role = "superAdmin"; fail = true;
  const failed = await request(); assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(JSON.stringify(await failed.json()), /private|audit|provider|stack/);
});
