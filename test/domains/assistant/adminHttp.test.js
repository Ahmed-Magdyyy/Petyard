import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createAssistantRouter } from "../../../src/domains/assistant/assistant.routes.js";
import { assistantBody, assistantAwareApiLimit } from "../../../src/domains/assistant/assistant.body.js";
import rateLimit from "express-rate-limit";
import { AssistantError } from "../../../src/domains/assistant/shared/assistant.errors.js";
import { AssistantAccount, AssistantRun, AssistantAdminMessage } from "../../../src/domains/assistant/shared/assistant.models.js";
import { UserModel } from "../../../src/domains/user/user.model.js";
import { testConfig } from "./fixtures/foundationPolicy.js";
import { egyptTimezoneReplacer } from "../../../src/shared/utils/egyptTimezone.js";

const actor = new mongoose.Types.ObjectId();
function stateFor(t) {
  const old = process.env.JWT_ACCESS_SECRET; process.env.JWT_ACCESS_SECRET = "synthetic-admin-http-secret";
  t.after(() => { if (old === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = old; });
  const state = { user: { _id: actor, role: "superAdmin", active: true, phoneVerified: true, account_status: "confirmed" },
    config: testConfig(), blocked: false };
  const query = (read) => ({ select() { return this; }, maxTimeMS() { return this; }, lean: async () => read(),
    then(resolve, reject) { return Promise.resolve().then(read).then(resolve, reject); } });
  t.mock.method(UserModel, "findById", () => query(() => state.user));
  t.mock.method(AssistantAccount, "findOne", () => query(() => ({ blocked: state.blocked })));
  t.mock.method(AssistantRun, "findOne", () => query(() => null));
  t.mock.method(AssistantAdminMessage, "find", () => ({ ...query(() => []), sort() { return this; }, limit() { return this; } }));
  state.headers = { Authorization: `Bearer ${jwt.sign({ userId: String(actor) }, process.env.JWT_ACCESS_SECRET)}`, "Content-Type": "application/json" };
  return state;
}
async function appFor(t, state, businessApplication) {
  const app = express(); app.set("json replacer", egyptTimezoneReplacer); app.use("/api/v1/assistant", ...assistantBody);
  app.use("/api/v1/assistant", createAssistantRouter({ getConfig: () => state.config, businessApplication }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}/api/v1/assistant`;
}

test("private HTTP metadata uses actual bearer/phone/analytics authority, with no-store on success and errors", async (t) => {
  const state = stateFor(t); const base = await appFor(t, state);
  const url = `${base}/admin/business/metadata`;
  const anonymous = await fetch(url); assert.equal(anonymous.status, 401); assert.equal(anonymous.headers.get("cache-control"), "no-store");
  for (const change of [{ role: "user" }, { role: "moderator", enabledControls: ["analytics"] }, { role: "admin", enabledControls: ["products"] },
    { role: "superAdmin", phoneVerified: false }]) {
    state.user = { _id: actor, active: true, phoneVerified: true, account_status: "confirmed", ...change };
    assert.equal((await fetch(url, { headers: state.headers })).status, 403);
  }
  state.user = { _id: actor, role: "admin", enabledControls: ["analytics"], active: true, phoneVerified: true, account_status: "confirmed" };
  const response = await fetch(url, { headers: state.headers });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json(); assert.equal(body.data.available, true); assert.equal(body.data.capabilities.bundleActions, false);
  assert.match(body.data.limits.resetsAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
  assert.doesNotMatch(JSON.stringify(body), /provider|model|price|spent|reserved|signature/);
  // Existing superAdmin AI controls are not granted by ordinary analytics authority.
  assert.equal((await fetch(`${base}/admin/usage?month=2026-09`, { headers: state.headers })).status, 403);
});

test("business metadata reports independent gate/missing cap/restricted states while retained history remains available", async (t) => {
  const state = stateFor(t); const base = await appFor(t, state); const url = `${base}/admin/business`;
  for (const config of [{ ...state.config, adminEnabled: false }, { ...state.config, adminReportMaxBytes: null }]) {
    state.config = config;
    const response = await fetch(`${url}/metadata`, { headers: state.headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).data.state, "unavailable");
    assert.equal((await fetch(`${url}/messages`, { headers: state.headers })).status, 200);
  }
  state.config = testConfig(); state.blocked = true;
  assert.equal((await (await fetch(`${url}/metadata`, { headers: state.headers })).json()).data.state, "restricted");
  assert.equal((await fetch(`${url}/messages`, { headers: state.headers })).status, 403);
  state.config = { ...state.config, blockedHistoryAllowed: true };
  assert.equal((await fetch(`${url}/messages`, { headers: state.headers })).status, 200);
  state.config = { enabled: false };
  assert.equal((await fetch(`${url}/metadata`, { headers: state.headers })).status, 503);
});

test("all five HTTP operations bind owner/body/key/query/run ID and preserve 202/200 retry envelopes", async (t) => {
  const state = stateFor(t); const seen = []; let duplicate = false;
  const application = {
    async getBusinessMetadata(owner) { seen.push(["metadata", String(owner)]); return { available: true }; },
    async getBusinessChat(owner) { seen.push(["chat", String(owner)]); return { id: "private-chat", contextVersion: 0, activeRunId: null }; },
    async getBusinessHistory(owner, query) { seen.push(["history", String(owner), { ...query }]); return { messages: [], nextBefore: null, order: "newest_first" }; },
    async submitBusinessMessage(owner, body, key) { seen.push(["submit", String(owner), body, key]); return { duplicate, run: { id: "private-run", status: "queued" } }; },
    async getBusinessRun(owner, id) { seen.push(["run", String(owner), id]); return { run: { id, status: "completed" }, message: null, reports: [] }; },
  };
  const base = `${await appFor(t, state, application)}/admin/business`;
  for (const path of ["metadata", "chat", "messages?before=20&limit=10", "runs/111111111111111111111111"]) {
    const response = await fetch(`${base}/${path}`, { headers: state.headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const request = { method: "POST", headers: { ...state.headers, "Idempotency-Key": "same-request-key" }, body: JSON.stringify({ text: "قارن سبتمبر بأغسطس" }) };
  const first = await fetch(`${base}/messages`, request); assert.equal(first.status, 202); assert.equal((await first.json()).data.duplicate, false);
  duplicate = true;
  const second = await fetch(`${base}/messages`, request); assert.equal(second.status, 200); assert.equal((await second.json()).data.duplicate, true);
  assert.ok(seen.every((row) => row[1] === String(actor)));
  assert.deepEqual(seen[2][2], { before: "20", limit: "10" }); assert.equal(seen[3][2], "111111111111111111111111");
  assert.deepEqual(seen[4].slice(2), [{ text: "قارن سبتمبر بأغسطس" }, "same-request-key"]);
});

test("actual business services reject forged fields, wrong-purpose runs, invalid pages, disabled admission and expose safe errors", async (t) => {
  const state = stateFor(t); const base = `${await appFor(t, state)}/admin/business`;
  for (const body of [{ text: "hello", owner: String(actor) }, { text: "hello", tool: "create_bundle" }, { text: "hello", subjectId: null }]) {
    const response = await fetch(`${base}/messages`, { method: "POST", headers: { ...state.headers, "Idempotency-Key": "valid-key" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal((await fetch(`${base}/messages?actor=someone`, { headers: state.headers })).status, 400);
  assert.equal((await fetch(`${base}/runs/not-id`, { headers: state.headers })).status, 400);
  assert.equal((await fetch(`${base}/runs/${actor}`, { headers: state.headers })).status, 404);
  state.config = { enabled: false };
  assert.equal((await fetch(`${base}/messages`, { method: "POST", headers: state.headers, body: "{}" })).status, 503);
});

test("business JSON parser, payload bounds and unexpected errors remain private and do not change customer envelopes", async (t) => {
  const state = stateFor(t); const base = await appFor(t, state, { async getBusinessChat() { throw new Error("private database key and provider"); } });
  const malformed = await fetch(`${base}/admin/business/messages`, { method: "POST", headers: state.headers, body: "{" });
  assert.equal(malformed.status, 400); assert.equal(malformed.headers.get("cache-control"), "no-store");
  assert.equal((await malformed.json()).error.code, "invalid_request");
  const large = await fetch(`${base}/admin/business/messages`, { method: "POST", headers: state.headers, body: JSON.stringify({ text: "x".repeat(26000) }) });
  assert.equal(large.status, 413); assert.equal(large.headers.get("cache-control"), "no-store");
  const error = await fetch(`${base}/admin/business/chat`, { headers: state.headers });
  const body = await error.json(); assert.equal(error.status, 503); assert.deepEqual(body.fallback, { analytics: true });
  assert.doesNotMatch(JSON.stringify(body), /database|provider|private|stack/);
  const customer = await fetch(`${base}/messages`, { method: "POST", headers: state.headers, body: "{" });
  assert.equal(customer.status, 503); assert.deepEqual((await customer.json()).fallback, { shopping: true, booking: true });
});

test("business known errors preserve retry times and contextual wording", async (t) => {
  const state = stateFor(t); const nextDay = new Date(Date.now() + 60000);
  let error = new AssistantError("daily_message_limit", 429, nextDay);
  const base = `${await appFor(t, state, { async getBusinessChat() { throw error; } })}/admin/business/chat`;
  const limited = await fetch(base, { headers: state.headers });
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await limited.json()).error.retryAt, egyptTimezoneReplacer("retryAt", nextDay.toISOString()));
  error = new AssistantError("context_changed", 409);
  const changed = await (await fetch(base, { headers: state.headers })).json();
  assert.match(changed.error.message, /business context/); assert.doesNotMatch(changed.error.message, /pet|memory/);
});

test("the pre-router API limiter gives business requests private 429 responses while other paths retain their legacy envelope", async (t) => {
  const app = express(); app.set("json replacer", egyptTimezoneReplacer);
  app.use("/api/", rateLimit({ windowMs: 60000, max: 1, handler: assistantAwareApiLimit, standardHeaders: true, legacyHeaders: false,
    message: { status: "error", message: "Too many requests, please try again later." } }));
  app.get("*", (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/v1/assistant/admin/business/metadata`)).status, 200);
  const limited = await fetch(`${base}/api/v1/assistant/admin/BUSINESS/metadata`);
  const body = await limited.json(); assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("cache-control"), "no-store"); assert.equal(body.error.code, "request_rate_limit");
  assert.match(body.error.retryAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/); assert.deepEqual(body.fallback, { analytics: true });
  const old = await fetch(`${base}/api/v1/products`);
  assert.equal(old.status, 429); assert.deepEqual(await old.json(), { status: "error", message: "Too many requests, please try again later." });
});

test("business HTTP converts nested report/run timestamps to Cairo and preserves date-like literal text", async t => {
  const state = stateFor(t), utc = "2026-07-15T10:00:00.000Z", cairo = "2026-07-15T13:00:00.000";
  const base = await appFor(t,state,{ async getBusinessRun() { return {
    run: { createdAt: utc, updatedAt: utc }, message: { text: utc, createdAt: utc, expiresAt: utc },
    reports: [{ generatedAt: utc, data: { generatedAt: utc, periods: { current: { start: utc, endExclusive: utc,
      observedThroughExclusive: utc } }, results: [{ name_en: utc }] } }],
  }; } });
  const response = await fetch(`${base}/admin/business/runs/111111111111111111111111`, { headers: state.headers });
  assert.equal(response.status,200); const value=(await response.json()).data;
  assert.equal(value.run.createdAt,cairo); assert.equal(value.run.updatedAt,cairo);
  assert.equal(value.message.createdAt,cairo); assert.equal(value.message.expiresAt,cairo); assert.equal(value.message.text,utc);
  assert.equal(value.reports[0].generatedAt,cairo); assert.equal(value.reports[0].data.generatedAt,cairo);
  assert.deepEqual(value.reports[0].data.periods.current,{start:cairo,endExclusive:cairo,observedThroughExclusive:cairo});
  assert.equal(value.reports[0].data.results[0].name_en,utc);
});
