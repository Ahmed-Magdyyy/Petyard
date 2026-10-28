import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { testConfig, reviewOnlyPolicy } from "./fixtures/foundationPolicy.js";

const ACTOR = "111111111111111111111111", OWNER = "222222222222222222222222", SNAPSHOT = "333333333333333333333333";
async function fixture(t) {
  const previous = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "synthetic-admin-validator-secret";
  t.after(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  const state = { user: { _id: ACTOR, role: "superAdmin", active: true, phoneVerified: true },
    config: testConfig({ reviewPolicy: reviewOnlyPolicy }), calls: [] };
  t.mock.method(UserModel, "findById", async () => state.user);
  const operation = (name) => async (...args) => { state.calls.push({ name, args });
    return name === "submitBusinessMessage" ? { duplicate: false, run: { id: SNAPSHOT } } : { accepted: true }; };
  const application = Object.fromEntries(["getUsageReport", "getReviewCandidates", "dismissReviewCandidate", "reviewHistory",
    "reviewObservations", "restrictAccount", "reconcileRun"].map((name) => [name, operation(name)]));
  const businessApplication = Object.fromEntries(["getBusinessHistory", "submitBusinessMessage", "getBusinessRun"].map((name) => [name, operation(name)]));
  const app = express(); app.use(express.json({ strict: false }));
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => state.config, application, businessApplication }));
  const server = await new Promise((resolve, reject) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); listener.once("error", reject); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  const url = `http://127.0.0.1:${server.address().port}/api/v1/assistant/admin`;
  state.headers = { Authorization: `Bearer ${jwt.sign({ userId: ACTOR }, process.env.JWT_ACCESS_SECRET)}`,
    "Content-Type": "application/json", "Idempotency-Key": "business-message-1" };
  state.request = async (method, route, body, headers = state.headers) => {
    const response = await fetch(url + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, body: await response.json() };
  };
  state.invalid = async (method, route, body, headers) => {
    const count = state.calls.length, result = await state.request(method, route, body, headers);
    assert.equal(result.status, 400, JSON.stringify({ method, route, body, result })); assert.equal(result.body.error.code, "invalid_request");
    assert.equal(state.calls.length, count); assert.doesNotMatch(JSON.stringify(result.body), /private-value|Validation error|stack/);
  };
  return state;
}

test("all seven superAdmin input operations forward valid raw values and authenticated actor", async (t) => {
  const s = await fixture(t);
  const cases = [
    ["GET", "/usage?month=2026-01", undefined, "getUsageReport"],
    ["GET", `/review-candidates?after=${OWNER}&limit=1e1`, undefined, "getReviewCandidates"],
    ["POST", `/accounts/${OWNER}/review-dismissals`, { reviewSnapshotId: SNAPSHOT, reason: "  Human review  " }, "dismissReviewCandidate"],
    ["GET", `/accounts/${OWNER}/messages?before=100.0&limit=2`, undefined, "reviewHistory"],
    ["GET", `/accounts/${OWNER}/observations?before=${SNAPSHOT}&limit=2`, undefined, "reviewObservations"],
    ["PUT", `/accounts/${OWNER}/access`, { blocked: true, reason: "  Human review  " }, "restrictAccount"],
    ["POST", `/runs/${SNAPSHOT}/reconcile`, { resolution: "charge_reserved", reason: "  Reviewed  " }, "reconcileRun"],
  ];
  for (const [method, route, body, name] of cases) {
    const response = await s.request(method, route, body); assert.equal(response.status, 200);
    const call = s.calls.at(-1); assert.equal(call.name, name);
    if (name !== "getUsageReport") assert.equal(call.args[0], ACTOR);
    if (body !== undefined) assert.deepEqual(call.args[2], body);
  }
  assert.deepEqual(s.calls[1].args[1], { after: OWNER, limit: "1e1" });
  assert.equal(s.calls[2].args[1], OWNER);
});

test("admin validators reject malformed report periods, cursors, duplicate query values and extra fields", async (t) => {
  const s = await fixture(t);
  for (const route of ["/usage?month=bad", "/usage?month=9999-01", "/usage?month=2026-01&month=2026-02", "/usage?owner=private-value",
    "/review-candidates?after=bad", "/review-candidates?limit=101", "/review-candidates?limit=2&limit=3", "/review-candidates?threshold=1",
    `/accounts/bad/messages`, `/accounts/${OWNER}/messages?before=bad`, `/accounts/${OWNER}/messages?limit=0`,
    `/accounts/${OWNER}/observations?before=100`, `/accounts/${OWNER}/observations?owner=private-value`]) await s.invalid("GET", route);
});

test("admin mutation validators require exact bodies, booleans, reviewed identities and reasons", async (t) => {
  const s = await fixture(t);
  for (const body of [null, [], {}, { blocked: "true", reason: "x" }, { blocked: true, reason: " " },
    { blocked: true, reason: "x".repeat(501) }, { blocked: true, reason: "x\u0000y" }, { blocked: true, reason: "x", actor: "private-value" }]) {
    await s.invalid("PUT", `/accounts/${OWNER}/access`, body);
  }
  for (const body of [{ reviewSnapshotId: "bad", reason: "x" }, { reviewSnapshotId: SNAPSHOT, reason: " " },
    { reviewSnapshotId: SNAPSHOT, reason: "x", owner: OWNER }]) await s.invalid("POST", `/accounts/${OWNER}/review-dismissals`, body);
  for (const body of [{ resolution: "refund", reason: "x" }, { resolution: "charge_reserved", reason: " " },
    { resolution: "charge_reserved", reason: "x", amount: 1 }]) await s.invalid("POST", `/runs/${SNAPSHOT}/reconcile`, body);
  await s.invalid("POST", "/runs/bad/reconcile", { resolution: "charge_reserved", reason: "x" });
});

test("superAdmin role and phone checks still precede malformed admin input", async (t) => {
  const s = await fixture(t);
  for (const role of ["user", "moderator", "admin"]) {
    s.user.role = role;
    const response = await s.request("PUT", "/accounts/bad/access", {}); assert.equal(response.status, 403);
  }
  s.user.role = "superAdmin"; s.user.phoneVerified = false;
  assert.equal((await s.request("GET", "/usage?month=bad")).status, 403);
  assert.equal((await s.request("POST", "/runs/bad/reconcile", {}, { "Content-Type": "application/json" })).status, 401);
  assert.equal(s.calls.length, 0);
});

test("disabled configuration and missing review policy are handled before route input checks", async (t) => {
  const s = await fixture(t); s.config = { enabled: false };
  for (const [method, route, body] of [["GET", "/usage?month=bad"], ["PUT", "/accounts/bad/access", {}],
    ["GET", "/business/messages?limit=bad"], ["POST", "/business/messages", {}], ["GET", "/business/runs/bad"]]) {
    const response = await s.request(method, route, body); assert.equal(response.status, 503); assert.equal(response.body.error.code, "assistant_disabled");
  }
  s.config = testConfig();
  for (const [method, route, body] of [["GET", "/review-candidates?after=bad"], ["POST", `/accounts/${OWNER}/review-dismissals`, {}]]) {
    const response = await s.request(method, route, body); assert.equal(response.status, 503); assert.equal(response.body.error.code, "review_policy_required");
  }
  assert.equal(s.calls.length, 0);
});

test("business validators preserve text-only requests, scalar history queries and run identity without coercion", async (t) => {
  const s = await fixture(t), body = { text: "  قارن شهرين  " };
  assert.equal((await s.request("POST", "/business/messages", body)).status, 202);
  assert.deepEqual(s.calls[0].args.slice(0, 3), [ACTOR, body, "business-message-1"]);
  assert.equal((await s.request("GET", "/business/messages?before=100.0&limit=1e1")).status, 200);
  assert.deepEqual(s.calls[1].args[1], { before: "100.0", limit: "1e1" });
  assert.equal((await s.request("GET", `/business/runs/${SNAPSHOT}`)).status, 200);
  assert.equal(s.calls[2].args[1], SNAPSHOT);
});

test("business validators reject forged scope, invalid text/key/pages and preserve private analytics fallback", async (t) => {
  const s = await fixture(t);
  for (const body of [null, [], {}, { text: " " }, { text: "a\u0000b" }, { text: "x".repeat(s.config.maxMessageChars + 1) },
    { text: "x", subjectId: null }, { text: "x", actor: "private-value" }, { text: "x", warehouseId: OWNER }, { text: "x", tool: "create_bundle" }]) {
    await s.invalid("POST", "/business/messages", body);
  }
  const headers = { ...s.headers }; delete headers["Idempotency-Key"];
  await s.invalid("POST", "/business/messages", { text: "x" }, headers);
  for (const route of ["/business/messages?limit=1&limit=2", "/business/messages?limit=101", "/business/messages?actor=private-value", "/business/runs/bad"]) {
    await s.invalid("GET", route);
  }
  const rejected = await s.request("POST", "/business/messages", { text: "x", owner: OWNER });
  assert.deepEqual(rejected.body.fallback, { analytics: true });
});
